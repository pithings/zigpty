/// Unix NAPI exports for zigpty (Linux + macOS).
/// Bridges Node-API ↔ pure Zig PTY library for fork, open, resize, process.
const std = @import("std");
const napi = @import("napi.zig");
const lib = @import("lib.zig");
const pty = @import("pty.zig");

const alloc = pty.alloc;

const PtyEvent = union(enum) {
    data: []u8,
    exit: lib.ExitInfo,
};

const ExitContext = struct {
    tsfn: napi.napi_threadsafe_function,
    pid: lib.Pid,
    fd: lib.Fd,
    read_thread: std.Thread,
};

fn eventCallJs(
    env: napi.napi_env,
    js_callback: napi.napi_value,
    _: ?*anyopaque,
    raw_data: ?*anyopaque,
) callconv(.c) void {
    const event: *PtyEvent = @ptrCast(@alignCast(raw_data orelse return));
    defer alloc.destroy(event);

    const value = switch (event.*) {
        .data => |data| value: {
            defer alloc.free(data);
            var buffer: napi.napi_value = undefined;
            if (napi.napi_create_buffer_copy(env, data.len, data.ptr, null, &buffer) != .ok) return;
            break :value buffer;
        },
        .exit => |exit_info| pty.createExitInfo(env, exit_info) orelse return,
    };

    var undefined_value: napi.napi_value = undefined;
    if (napi.napi_get_undefined(env, &undefined_value) != .ok) return;

    var args = [_]napi.napi_value{value};
    _ = napi.napi_call_function(env, undefined_value, js_callback, 1, &args, null);
}

fn readThread(ctx: *ExitContext) void {
    while (true) {
        var buffer: [4096]u8 = undefined;
        const bytes_read = std.posix.read(ctx.fd, &buffer) catch break;
        if (bytes_read == 0) break;

        const data = alloc.dupe(u8, buffer[0..bytes_read]) catch break;
        const event = alloc.create(PtyEvent) catch {
            alloc.free(data);
            break;
        };
        event.* = .{ .data = data };

        if (napi.napi_call_threadsafe_function(ctx.tsfn, @ptrCast(event), .blocking) != .ok) {
            alloc.free(data);
            alloc.destroy(event);
            break;
        }
    }
}

/// Background thread that waits for process exit.
fn exitMonitorThread(ctx: *ExitContext) void {
    defer {
        _ = napi.napi_release_threadsafe_function(ctx.tsfn, .release);
        alloc.destroy(ctx);
    }

    const info = lib.waitForExit(ctx.pid);
    ctx.read_thread.join();

    const event = alloc.create(PtyEvent) catch return;
    event.* = .{ .exit = info };

    if (napi.napi_call_threadsafe_function(
        ctx.tsfn,
        @ptrCast(event),
        .blocking,
    ) != .ok) {
        alloc.destroy(event);
    }
}

/// fork(file, args, env, cwd, cols, rows, uid, gid, useUtf8, onEvent) → { fd, pid, pty }
pub fn fork(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return forkImpl(env, info) catch return pty.returnUndef(env);
}

fn forkImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var exit_monitor_started = false;
    var child_pid: ?lib.Pid = null;
    errdefer if (child_pid) |pid| {
        std.posix.kill(pid, .KILL) catch {};
        if (!exit_monitor_started) _ = lib.waitForExit(pid);
    };

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
        .tsfn = tsfn,
        .pid = result.pid,
        .fd = result.fd,
        .read_thread = undefined,
    };

    ctx.read_thread = std.Thread.spawn(.{}, readThread, .{ctx}) catch {
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn read thread");
        return error.NapiFailed;
    };

    _ = std.Thread.spawn(.{}, exitMonitorThread, .{ctx}) catch {
        std.posix.kill(result.pid, .KILL) catch {};
        ctx.read_thread.join();
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn exit monitor thread");
        return error.NapiFailed;
    };
    exit_monitor_started = true;

    var js_result: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &js_result));

    try napi.setProp(env, js_result, "fd", try napi.createI32(env, @intCast(result.fd)));
    try napi.setProp(env, js_result, "pid", try napi.createI32(env, result.pid));

    const name = result.ptyName();
    if (name.len > 0) {
        try napi.setProp(env, js_result, "pty", try napi.createString(env, name));
    }

    std.posix.kill(result.pid, .CONT) catch {
        _ = napi.napi_throw_error(env, null, "failed to resume child process");
        return error.NapiFailed;
    };

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
