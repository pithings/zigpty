/// Unix NAPI exports for zigpty (Linux + macOS).
/// Bridges Node-API ↔ pure Zig PTY library for fork, open, resize, process.
const std = @import("std");
const napi = @import("napi.zig");
const lib = @import("lib.zig");
const pty = @import("pty.zig");

const alloc = pty.alloc;
const max_paused_bytes = 64 * 1024;

const ExitEvent = struct {
    info: lib.ExitInfo,
    fd: lib.Fd,
    ctx: *ExitContext,
};

const DataEvent = struct {
    data: []u8,
    ctx: *ExitContext,
};

const PtyEvent = union(enum) {
    data: DataEvent,
    exit: ExitEvent,
};

const ExitContext = struct {
    env: napi.napi_env,
    tsfn: napi.napi_threadsafe_function,
    pid: lib.Pid,
    fd: lib.Fd,
    read_thread: std.Thread,
    mutex: std.c.pthread_mutex_t = std.c.PTHREAD_MUTEX_INITIALIZER,
    condition: std.c.pthread_cond_t = std.c.PTHREAD_COND_INITIALIZER,
    paused: bool = false,
    draining: bool = false,
    closing: bool = false,
    env_closing: bool = false,
    finished: bool = false,
    monitor_finished: bool = false,
    cleanup_hook_registered: bool = false,
    tsfn_released: bool = false,
    paused_data: ?[]u8 = null,
    paused_len: usize = 0,
    references: std.atomic.Value(u8) = std.atomic.Value(u8).init(1),
};

fn retainContext(ctx: *ExitContext) void {
    _ = ctx.references.fetchAdd(1, .monotonic);
}

fn releaseContext(ctx: *ExitContext) void {
    if (ctx.references.fetchSub(1, .acq_rel) != 1) return;
    if (ctx.paused_data) |data| alloc.free(data);
    _ = std.c.pthread_cond_destroy(&ctx.condition);
    _ = std.c.pthread_mutex_destroy(&ctx.mutex);
    alloc.destroy(ctx);
}

fn contextFinalizer(
    _: napi.napi_env,
    data: ?*anyopaque,
    _: ?*anyopaque,
) callconv(.c) void {
    const ctx: *ExitContext = @ptrCast(@alignCast(data orelse return));
    releaseContext(ctx);
}

fn lockContext(ctx: *ExitContext) void {
    std.debug.assert(std.c.pthread_mutex_lock(&ctx.mutex) == .SUCCESS);
}

fn unlockContext(ctx: *ExitContext) void {
    std.debug.assert(std.c.pthread_mutex_unlock(&ctx.mutex) == .SUCCESS);
}

fn releaseTsfn(ctx: *ExitContext, mode: napi.napi_threadsafe_function_release_mode) void {
    lockContext(ctx);
    if (ctx.tsfn_released) {
        unlockContext(ctx);
        return;
    }
    ctx.tsfn_released = true;
    unlockContext(ctx);
    _ = napi.napi_release_threadsafe_function(ctx.tsfn, mode);
}

fn finishMonitor(ctx: *ExitContext) void {
    releaseTsfn(ctx, .release);
    lockContext(ctx);
    ctx.monitor_finished = true;
    _ = std.c.pthread_cond_broadcast(&ctx.condition);
    unlockContext(ctx);
    releaseContext(ctx);
}

fn removeCleanupHook(ctx: *ExitContext) void {
    lockContext(ctx);
    if (!ctx.cleanup_hook_registered or ctx.env_closing) {
        unlockContext(ctx);
        return;
    }
    ctx.cleanup_hook_registered = false;
    unlockContext(ctx);

    std.debug.assert(napi.napi_remove_env_cleanup_hook(
        ctx.env,
        environmentCleanup,
        @ptrCast(ctx),
    ) == .ok);
    releaseContext(ctx);
}

fn environmentCleanup(raw_ctx: ?*anyopaque) callconv(.c) void {
    const ctx: *ExitContext = @ptrCast(@alignCast(raw_ctx orelse return));

    lockContext(ctx);
    if (!ctx.cleanup_hook_registered) {
        unlockContext(ctx);
        return;
    }
    ctx.cleanup_hook_registered = false;
    ctx.env_closing = true;
    ctx.closing = true;
    ctx.paused = false;
    _ = std.c.pthread_cond_broadcast(&ctx.condition);
    unlockContext(ctx);

    releaseTsfn(ctx, .abort);
    std.posix.kill(ctx.pid, .HUP) catch {};
    std.posix.kill(ctx.pid, .KILL) catch {};

    lockContext(ctx);
    while (!ctx.monitor_finished) {
        std.debug.assert(std.c.pthread_cond_wait(&ctx.condition, &ctx.mutex) == .SUCCESS);
    }
    unlockContext(ctx);
    releaseContext(ctx);
}

fn destroyEvent(event: *PtyEvent) void {
    switch (event.*) {
        .data => |data_event| {
            alloc.free(data_event.data);
            releaseContext(data_event.ctx);
        },
        .exit => |exit_event| {
            _ = std.c.close(exit_event.fd);
            releaseContext(exit_event.ctx);
        },
    }
    alloc.destroy(event);
}

fn eventCallJs(
    maybe_env: ?napi.napi_env,
    maybe_js_callback: ?napi.napi_value,
    _: ?*anyopaque,
    raw_data: ?*anyopaque,
) callconv(.c) void {
    const event: *PtyEvent = @ptrCast(@alignCast(raw_data orelse return));
    defer destroyEvent(event);
    const env = maybe_env orelse return;
    const js_callback = maybe_js_callback orelse return;

    const value = switch (event.*) {
        .data => |data_event| value: {
            lockContext(data_event.ctx);
            const closing = data_event.ctx.closing;
            unlockContext(data_event.ctx);
            if (closing) return;

            var buffer: napi.napi_value = undefined;
            if (napi.napi_create_buffer_copy(
                env,
                data_event.data.len,
                data_event.data.ptr,
                null,
                &buffer,
            ) != .ok) return;
            break :value buffer;
        },
        .exit => |exit_event| value: {
            removeCleanupHook(exit_event.ctx);
            break :value pty.createExitInfo(env, exit_event.info) orelse return;
        },
    };

    var undefined_value: napi.napi_value = undefined;
    if (napi.napi_get_undefined(env, &undefined_value) != .ok) return;

    var args = [_]napi.napi_value{value};
    _ = napi.napi_call_function(env, undefined_value, js_callback, 1, &args, null);
}

fn queueData(ctx: *ExitContext, data: []u8) bool {
    const event = alloc.create(PtyEvent) catch {
        alloc.free(data);
        return false;
    };
    retainContext(ctx);
    event.* = .{ .data = .{ .data = data, .ctx = ctx } };

    if (napi.napi_call_threadsafe_function(ctx.tsfn, @ptrCast(event), .blocking) == .ok) {
        return true;
    }
    destroyEvent(event);
    return false;
}

fn queueDataCopy(ctx: *ExitContext, data: []const u8) bool {
    return queueData(ctx, alloc.dupe(u8, data) catch return false);
}

fn flushPausedData(ctx: *ExitContext) bool {
    lockContext(ctx);
    if (ctx.closing or ctx.paused_len == 0) {
        if (ctx.closing) ctx.paused_len = 0;
        unlockContext(ctx);
        return true;
    }
    const data = alloc.dupe(u8, ctx.paused_data.?[0..ctx.paused_len]) catch {
        unlockContext(ctx);
        return false;
    };
    ctx.paused_len = 0;
    unlockContext(ctx);
    return queueData(ctx, data);
}

fn readThread(ctx: *ExitContext) void {
    defer _ = flushPausedData(ctx);

    while (true) {
        lockContext(ctx);
        const paused_capacity = if (ctx.paused_data) |data| data.len else 0;
        while (ctx.paused and ctx.paused_len >= paused_capacity and !ctx.draining and !ctx.closing) {
            std.debug.assert(std.c.pthread_cond_wait(&ctx.condition, &ctx.mutex) == .SUCCESS);
        }
        const closing = ctx.closing;
        const should_flush = !ctx.paused and ctx.paused_len > 0;
        const read_size = if (ctx.paused)
            @min(4096, paused_capacity - ctx.paused_len)
        else
            4096;
        unlockContext(ctx);
        if (closing) break;
        if (should_flush) {
            if (!flushPausedData(ctx)) break;
            continue;
        }

        var buffer: [4096]u8 = undefined;
        const bytes_read = std.posix.read(ctx.fd, buffer[0..read_size]) catch break;
        if (bytes_read == 0) break;

        lockContext(ctx);
        if (ctx.closing) {
            unlockContext(ctx);
            break;
        }
        if (ctx.paused and !ctx.draining) {
            @memcpy(ctx.paused_data.?[ctx.paused_len..][0..bytes_read], buffer[0..bytes_read]);
            ctx.paused_len += bytes_read;
            unlockContext(ctx);
            continue;
        }
        const should_flush_before_data = ctx.paused_len > 0;
        unlockContext(ctx);

        if (should_flush_before_data and !flushPausedData(ctx)) break;
        if (!queueDataCopy(ctx, buffer[0..bytes_read])) break;
    }
}

fn setPaused(ctx: *ExitContext, paused: bool) void {
    lockContext(ctx);
    defer unlockContext(ctx);
    if (ctx.draining or ctx.closing or ctx.finished) return;
    if (paused and ctx.paused_data == null) {
        ctx.paused_data = alloc.alloc(u8, max_paused_bytes) catch null;
    }
    ctx.paused = paused;
    if (!paused) _ = std.c.pthread_cond_broadcast(&ctx.condition);
}

fn closeContext(ctx: *ExitContext) void {
    lockContext(ctx);
    if (ctx.closing or ctx.finished) {
        unlockContext(ctx);
        return;
    }
    ctx.closing = true;
    ctx.paused = false;
    _ = std.c.pthread_cond_broadcast(&ctx.condition);
    unlockContext(ctx);

    std.posix.kill(ctx.pid, .HUP) catch {};
    std.posix.kill(ctx.pid, .KILL) catch {};
}

/// Background thread that waits for process exit.
fn exitMonitorThread(ctx: *ExitContext) void {
    defer finishMonitor(ctx);

    const info = lib.waitForExit(ctx.pid);
    lockContext(ctx);
    ctx.draining = true;
    ctx.paused = false;
    _ = std.c.pthread_cond_broadcast(&ctx.condition);
    unlockContext(ctx);
    ctx.read_thread.join();

    lockContext(ctx);
    ctx.finished = true;
    if (ctx.paused_data) |data| {
        alloc.free(data);
        ctx.paused_data = null;
        ctx.paused_len = 0;
    }
    const env_closing = ctx.env_closing;
    unlockContext(ctx);

    if (env_closing) {
        _ = std.c.close(ctx.fd);
        return;
    }

    const event = alloc.create(PtyEvent) catch {
        _ = std.c.close(ctx.fd);
        return;
    };
    retainContext(ctx);
    event.* = .{ .exit = .{ .info = info, .fd = ctx.fd, .ctx = ctx } };

    if (napi.napi_call_threadsafe_function(
        ctx.tsfn,
        @ptrCast(event),
        .blocking,
    ) != .ok) {
        destroyEvent(event);
    }
}

/// fork(file, args, env, cwd, cols, rows, uid, gid, useUtf8, onEvent) → { fd, pid, pty }
pub fn fork(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return forkImpl(env, info) catch return pty.returnUndef(env);
}

pub fn pause(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    setPausedImpl(env, info, true) catch {};
    return pty.returnUndef(env);
}

pub fn resumeOutput(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    setPausedImpl(env, info, false) catch {};
    return pty.returnUndef(env);
}

pub fn close(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    const ctx = getContext(env, info) catch return pty.returnUndef(env);
    closeContext(ctx);
    return pty.returnUndef(env);
}

fn setPausedImpl(env: napi.napi_env, info: napi.napi_callback_info, paused: bool) !void {
    setPaused(try getContext(env, info), paused);
}

fn getContext(env: napi.napi_env, info: napi.napi_callback_info) !*ExitContext {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    return @ptrCast(@alignCast(ctx_ptr orelse return error.NapiFailed));
}

fn forkImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var exit_monitor_started = false;
    var child_pid: ?lib.Pid = null;
    var result_fd: ?lib.Fd = null;
    errdefer {
        if (child_pid) |pid| {
            std.posix.kill(pid, .KILL) catch {};
            if (!exit_monitor_started) _ = lib.waitForExit(pid);
        }
        if (!exit_monitor_started) {
            if (result_fd) |fd| _ = std.c.close(fd);
        }
    }

    var argc: usize = 10;
    var argv: [10]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    if (argc < 10) {
        _ = napi.napi_throw_error(env, null, "fork requires 10 arguments");
        return error.NapiFailed;
    }

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    const file = try pty.getStringAlloc(env, argv[0], a);

    var args_len: u32 = 0;
    try napi.check(env, napi.napi_get_array_length(env, argv[1], &args_len));
    var exec_argv = try a.alloc(?[*:0]const u8, args_len + 2);
    exec_argv[0] = file.ptr;
    for (0..args_len) |i| {
        var elem: napi.napi_value = undefined;
        try napi.check(env, napi.napi_get_element(env, argv[1], @intCast(i), &elem));
        const s = try pty.getStringAlloc(env, elem, a);
        exec_argv[i + 1] = s.ptr;
    }
    exec_argv[args_len + 1] = null;

    var env_len: u32 = 0;
    try napi.check(env, napi.napi_get_array_length(env, argv[2], &env_len));
    var exec_envp = try a.alloc(?[*:0]const u8, env_len + 1);
    for (0..env_len) |i| {
        var elem: napi.napi_value = undefined;
        try napi.check(env, napi.napi_get_element(env, argv[2], @intCast(i), &elem));
        const s = try pty.getStringAlloc(env, elem, a);
        exec_envp[i] = s.ptr;
    }
    exec_envp[env_len] = null;

    const cwd = try pty.getStringAlloc(env, argv[3], a);

    var cols_i32: i32 = 0;
    var rows_i32: i32 = 0;
    try napi.check(env, napi.napi_get_value_int32(env, argv[4], &cols_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[5], &rows_i32));

    var uid_i32: i32 = -1;
    var gid_i32: i32 = -1;
    try napi.check(env, napi.napi_get_value_int32(env, argv[6], &uid_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[7], &gid_i32));

    var use_utf8: bool = true;
    try napi.check(env, napi.napi_get_value_bool(env, argv[8], &use_utf8));

    const result = lib.forkPtySuspended(.{
        .file = file.ptr,
        .argv = @ptrCast(exec_argv.ptr),
        .envp = @ptrCast(exec_envp.ptr),
        .cwd = cwd.ptr,
        .cols = pty.clampU16(cols_i32),
        .rows = pty.clampU16(rows_i32),
        .uid = if (uid_i32 >= 0) @intCast(uid_i32) else null,
        .gid = if (gid_i32 >= 0) @intCast(gid_i32) else null,
        .use_utf8 = use_utf8,
    }) catch {
        _ = napi.napi_throw_error(env, null, "forkpty failed");
        return error.NapiFailed;
    };
    child_pid = result.pid;
    result_fd = result.fd;

    var resource_name: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_string_utf8(env, "zigpty_event", 12, &resource_name));

    var tsfn: napi.napi_threadsafe_function = undefined;
    try napi.check(env, napi.napi_create_threadsafe_function(
        env,
        argv[9],
        null,
        resource_name,
        64,
        1,
        null,
        null,
        null,
        eventCallJs,
        &tsfn,
    ));

    const ctx = alloc.create(ExitContext) catch {
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        _ = napi.napi_throw_error(env, null, "failed to allocate exit context");
        return error.NapiFailed;
    };
    ctx.* = .{
        .env = env,
        .tsfn = tsfn,
        .pid = result.pid,
        .fd = result.fd,
        .read_thread = undefined,
    };

    ctx.read_thread = std.Thread.spawn(.{}, readThread, .{ctx}) catch {
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        releaseContext(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn read thread");
        return error.NapiFailed;
    };

    const exit_thread = std.Thread.spawn(.{}, exitMonitorThread, .{ctx}) catch {
        closeContext(ctx);
        ctx.read_thread.join();
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        releaseContext(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn exit monitor thread");
        return error.NapiFailed;
    };
    exit_monitor_started = true;
    exit_thread.detach();

    retainContext(ctx);
    const cleanup_status = napi.napi_add_env_cleanup_hook(env, environmentCleanup, @ptrCast(ctx));
    if (cleanup_status != .ok) {
        releaseContext(ctx);
        try napi.check(env, cleanup_status);
    }
    lockContext(ctx);
    ctx.cleanup_hook_registered = true;
    unlockContext(ctx);
    var cleanup_hook_transferred = false;
    errdefer if (!cleanup_hook_transferred) removeCleanupHook(ctx);

    var js_result: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &js_result));

    try napi.setProp(env, js_result, "fd", try napi.createI32(env, @intCast(result.fd)));
    try napi.setProp(env, js_result, "pid", try napi.createI32(env, result.pid));

    var handle: napi.napi_value = undefined;
    retainContext(ctx);
    const handle_status = napi.napi_create_external(env, @ptrCast(ctx), contextFinalizer, null, &handle);
    if (handle_status != .ok) {
        releaseContext(ctx);
        try napi.check(env, handle_status);
    }
    try napi.setProp(env, js_result, "handle", handle);

    const name = result.ptyName();
    if (name.len > 0) {
        try napi.setProp(env, js_result, "pty", try napi.createString(env, name));
    }

    std.posix.kill(result.pid, .CONT) catch {
        _ = napi.napi_throw_error(env, null, "failed to resume child process");
        return error.NapiFailed;
    };

    cleanup_hook_transferred = true;
    return js_result;
}

/// open(cols, rows) → { master, slave, pty }
pub fn open(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return openImpl(env, info) catch return pty.returnUndef(env);
}

fn openImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var argc: usize = 2;
    var argv: [2]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var cols_i32: i32 = 80;
    var rows_i32: i32 = 24;
    if (argc >= 1) try napi.check(env, napi.napi_get_value_int32(env, argv[0], &cols_i32));
    if (argc >= 2) try napi.check(env, napi.napi_get_value_int32(env, argv[1], &rows_i32));

    const result = lib.openPty(
        pty.clampU16(cols_i32),
        pty.clampU16(rows_i32),
    ) catch {
        _ = napi.napi_throw_error(env, null, "openpty failed");
        return error.NapiFailed;
    };

    var js_result: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &js_result));
    try napi.setProp(env, js_result, "master", try napi.createI32(env, @intCast(result.master)));
    try napi.setProp(env, js_result, "slave", try napi.createI32(env, @intCast(result.slave)));

    const name = result.ptyName();
    if (name.len > 0) {
        try napi.setProp(env, js_result, "pty", try napi.createString(env, name));
    }

    return js_result;
}

/// resize(fd, cols, rows, xPixel, yPixel)
pub fn resize(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    resizeImpl(env, info) catch {};
    return pty.returnUndef(env);
}

fn resizeImpl(env: napi.napi_env, info: napi.napi_callback_info) !void {
    var argc: usize = 5;
    var argv: [5]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var fd_i32: i32 = 0;
    var cols_i32: i32 = 0;
    var rows_i32: i32 = 0;
    var xpixel_i32: i32 = 0;
    var ypixel_i32: i32 = 0;
    try napi.check(env, napi.napi_get_value_int32(env, argv[0], &fd_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[1], &cols_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[2], &rows_i32));
    if (argc >= 4) _ = napi.napi_get_value_int32(env, argv[3], &xpixel_i32);
    if (argc >= 5) _ = napi.napi_get_value_int32(env, argv[4], &ypixel_i32);

    if (fd_i32 < 0) {
        _ = napi.napi_throw_error(env, null, "invalid fd");
        return error.NapiFailed;
    }

    lib.resize(
        @intCast(fd_i32),
        pty.clampU16(cols_i32),
        pty.clampU16(rows_i32),
        pty.clampU16(xpixel_i32),
        pty.clampU16(ypixel_i32),
    ) catch {
        _ = napi.napi_throw_error(env, null, "ioctl TIOCSWINSZ failed");
        return error.NapiFailed;
    };
}

/// process(fd) → string (foreground process name)
pub fn getProcess(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return getProcessImpl(env, info) catch return pty.returnUndef(env);
}

fn getProcessImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var fd_i32: i32 = 0;
    try napi.check(env, napi.napi_get_value_int32(env, argv[0], &fd_i32));

    if (fd_i32 < 0) return pty.returnUndef(env);

    var buf: [4096]u8 = undefined;
    const name = lib.getProcessName(@intCast(fd_i32), &buf) orelse {
        return pty.returnUndef(env);
    };

    return try napi.createString(env, name);
}

/// stats(pid) → { pid, cwd, rssBytes, cpuUser, cpuSys, count, children } | undefined
pub fn stats(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return statsImpl(env, info) catch return pty.returnUndef(env);
}

fn statsImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var pid_i32: i32 = 0;
    try napi.check(env, napi.napi_get_value_int32(env, argv[0], &pid_i32));

    if (pid_i32 <= 0) return pty.returnUndef(env);

    var cwd_buf: [4096]u8 = undefined;
    var s = lib.getStats(@intCast(pid_i32), alloc, &cwd_buf) orelse return pty.returnUndef(env);
    defer s.deinit(alloc);

    return try pty.buildStatsObject(env, s);
}
