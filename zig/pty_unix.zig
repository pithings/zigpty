/// Unix NAPI exports for zigpty (Linux + macOS).
/// Bridges Node-API ↔ pure Zig PTY library for fork, open, resize, process.
const std = @import("std");
const napi = @import("napi.zig");
const lib = @import("lib.zig");
const pty = @import("pty.zig");

const alloc = pty.alloc;

const ExitContext = struct {
    tsfn: napi.napi_threadsafe_function,
    pid: lib.Pid,
};

/// Background thread that waits for process exit.
fn exitMonitorThread(ctx_ptr: *ExitContext) void {
    defer {
        _ = napi.napi_release_threadsafe_function(ctx_ptr.tsfn, .release);
        alloc.destroy(ctx_ptr);
    }

    const info = lib.waitForExit(ctx_ptr.pid);

    const exit_data = alloc.create(lib.ExitInfo) catch return;
    exit_data.* = info;

    _ = napi.napi_call_threadsafe_function(
        ctx_ptr.tsfn,
        @ptrCast(exit_data),
        .blocking,
    );
}

/// fork(file, args, env, cwd, cols, rows, uid, gid, useUtf8, onExit) → { fd, pid, pty }
pub fn fork(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return forkImpl(env, info) catch return pty.returnUndef(env);
}

fn forkImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
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

    const result = lib.forkPty(.{
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

    var resource_name: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_string_utf8(env, "zigpty_exit", 11, &resource_name));

    var tsfn: napi.napi_threadsafe_function = undefined;
    try napi.check(env, napi.napi_create_threadsafe_function(
        env,
        argv[9],
        null,
        resource_name,
        0,
        1,
        null,
        null,
        null,
        pty.exitCallJs,
        &tsfn,
    ));

    const ctx = alloc.create(ExitContext) catch {
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        _ = napi.napi_throw_error(env, null, "failed to allocate exit context");
        return error.NapiFailed;
    };
    ctx.* = .{ .tsfn = tsfn, .pid = result.pid };

    _ = std.Thread.spawn(.{}, exitMonitorThread, .{ctx}) catch {
        _ = napi.napi_release_threadsafe_function(tsfn, .abort);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn exit monitor thread");
        return error.NapiFailed;
    };

    var js_result: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &js_result));

    try napi.setProp(env, js_result, "fd", try napi.createI32(env, @intCast(result.fd)));
    try napi.setProp(env, js_result, "pid", try napi.createI32(env, result.pid));

    const name = result.ptyName();
    if (name.len > 0) {
        try napi.setProp(env, js_result, "pty", try napi.createString(env, name));
    }

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
