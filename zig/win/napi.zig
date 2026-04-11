/// Windows NAPI exports for zigpty (ConPTY).
/// Bridges Node-API ↔ pure Zig ConPTY library for spawn, write, resize, kill, close.
const std = @import("std");
const napi = @import("../napi.zig");
const lib = @import("../lib.zig");
const pty = @import("../pty.zig");

const alloc = pty.alloc;
const win = lib.win;

/// ConPTY context stored as napi_external.
pub const WinConPtyContext = struct {
    spawn_result: win.SpawnResult,
    exit_tsfn: napi.napi_threadsafe_function,
    data_tsfn: napi.napi_threadsafe_function,
    read_thread: ?std.Thread = null,
    exit_thread: ?std.Thread = null,
    /// Set when ClosePseudoConsole has been called (must only happen once)
    hpc_closed: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
};

/// Data chunk sent from read thread to JS.
const DataChunk = struct {
    ptr: [*]u8,
    len: usize,
};

/// Called on the JS thread when the read thread has data.
fn dataCallJs(
    env: napi.napi_env,
    js_callback: napi.napi_value,
    _: ?*anyopaque,
    raw_data: ?*anyopaque,
) callconv(.c) void {
    const chunk: *DataChunk = @ptrCast(@alignCast(raw_data orelse return));
    defer {
        alloc.free(chunk.ptr[0..chunk.len]);
        alloc.destroy(chunk);
    }

    // Create a Node.js Buffer from the data
    var js_buf: napi.napi_value = undefined;
    if (napi.napi_create_buffer_copy(env, chunk.len, chunk.ptr, null, &js_buf) != .ok) return;

    var undefined_val: napi.napi_value = undefined;
    if (napi.napi_get_undefined(env, &undefined_val) != .ok) return;

    var args = [_]napi.napi_value{js_buf};
    _ = napi.napi_call_function(env, undefined_val, js_callback, 1, &args, null);
}

/// Background thread that reads ConPTY output.
fn winReadThread(ctx: *WinConPtyContext) void {
    while (true) {
        var buf: [4096]u8 = undefined;
        const n = win.readOutput(ctx.spawn_result.conout, &buf);
        if (n == 0) break; // EOF

        // Copy data for JS callback
        const data = alloc.alloc(u8, n) catch break;
        @memcpy(data, buf[0..n]);

        const chunk = alloc.create(DataChunk) catch {
            alloc.free(data);
            break;
        };
        chunk.* = .{ .ptr = data.ptr, .len = n };

        if (napi.napi_call_threadsafe_function(
            ctx.data_tsfn,
            @ptrCast(chunk),
            .nonblocking,
        ) != .ok) {
            alloc.free(data);
            alloc.destroy(chunk);
            break;
        }
    }

    _ = napi.napi_release_threadsafe_function(ctx.data_tsfn, .release);
}

/// Background thread that waits for process exit (Windows).
fn winExitMonitorThread(ctx: *WinConPtyContext) void {
    const info = win.waitForExit(ctx.spawn_result.process);

    // Close the input pipe — no more input after process exit.
    // Then close the pseudo console to flush remaining output to the pipe.
    // ClosePseudoConsole will block until the output pipe is drained by the
    // read thread, so the read thread MUST be running concurrently.
    win.closeConin(&ctx.spawn_result);
    if (!ctx.hpc_closed.swap(true, .acq_rel)) {
        win.closePseudoConsole(ctx.spawn_result.hpc);
    }

    // Wait for the read thread to finish draining remaining output
    if (ctx.read_thread) |rt| rt.join();

    // Clean up remaining handles
    win.closePty(&ctx.spawn_result);

    // Fire exit callback AFTER all data has been delivered
    const exit_data = alloc.create(lib.ExitInfo) catch return;
    exit_data.* = info;

    _ = napi.napi_call_threadsafe_function(
        ctx.exit_tsfn,
        @ptrCast(exit_data),
        .blocking,
    );
    _ = napi.napi_release_threadsafe_function(ctx.exit_tsfn, .release);

    // Free the context — all handles are closed and tsfns released
    alloc.destroy(ctx);
}

/// spawn(file, args, env, cwd, cols, rows, onData, onExit) → { pid, handle }
pub fn spawn(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return spawnImpl(env, info) catch return pty.returnUndef(env);
}

fn spawnImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var argc: usize = 8;
    var argv: [8]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    if (argc < 8) {
        _ = napi.napi_throw_error(env, null, "spawn requires 8 arguments");
        return error.NapiFailed;
    }

    var arena = std.heap.ArenaAllocator.init(alloc);
    defer arena.deinit();
    const a = arena.allocator();

    // file (string)
    const file = try pty.getStringAlloc(env, argv[0], a);

    // args (string array)
    var args_len: u32 = 0;
    try napi.check(env, napi.napi_get_array_length(env, argv[1], &args_len));
    var args_strs = try a.alloc([]const u8, args_len);
    for (0..args_len) |i| {
        var elem: napi.napi_value = undefined;
        try napi.check(env, napi.napi_get_element(env, argv[1], @intCast(i), &elem));
        args_strs[i] = try pty.getStringAlloc(env, elem, a);
    }

    // env pairs (string array) → Windows env block
    var env_len: u32 = 0;
    try napi.check(env, napi.napi_get_array_length(env, argv[2], &env_len));
    var env_strs = try a.alloc([]const u8, env_len);
    for (0..env_len) |i| {
        var elem: napi.napi_value = undefined;
        try napi.check(env, napi.napi_get_element(env, argv[2], @intCast(i), &elem));
        env_strs[i] = try pty.getStringAlloc(env, elem, a);
    }
    const env_block = win.buildEnvBlock(a, env_strs) catch {
        _ = napi.napi_throw_error(env, null, "failed to build env block");
        return error.NapiFailed;
    };

    // cwd (string → UTF-16)
    const cwd_str = try pty.getStringAlloc(env, argv[3], a);
    const cwd_w = win.utf8ToUtf16Alloc(a, cwd_str) catch {
        _ = napi.napi_throw_error(env, null, "invalid cwd");
        return error.NapiFailed;
    };

    // cols, rows
    var cols_i32: i32 = 80;
    var rows_i32: i32 = 24;
    try napi.check(env, napi.napi_get_value_int32(env, argv[4], &cols_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[5], &rows_i32));

    // Build command line
    const cmd_line = win.buildCmdLine(a, file, args_strs) catch {
        _ = napi.napi_throw_error(env, null, "failed to build command line");
        return error.NapiFailed;
    };

    const cols = pty.clampU16(cols_i32);
    const rows = pty.clampU16(rows_i32);

    // Phase 1: Create ConPTY (pipes + pseudo console, no process yet)
    var setup = win.createConPty(cols, rows) catch {
        _ = napi.napi_throw_error(env, null, "ConPTY creation failed");
        return error.NapiFailed;
    };

    // Create context with pipe handles (process handle set after spawn)
    const ctx = alloc.create(WinConPtyContext) catch {
        setup.deinit();
        _ = napi.napi_throw_error(env, null, "failed to allocate context");
        return error.NapiFailed;
    };
    ctx.* = .{
        .spawn_result = .{
            .conin = setup.conin,
            .conout = setup.conout,
            .hpc = setup.hpc,
            .process = win.INVALID_HANDLE,
            .pid = 0,
        },
        .exit_tsfn = undefined,
        .data_tsfn = undefined,
    };

    // Create data threadsafe function
    var res_name_data: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_string_utf8(env, "zigpty_data", 11, &res_name_data));
    try napi.check(env, napi.napi_create_threadsafe_function(
        env,
        argv[6], // onData callback
        null,
        res_name_data,
        0,
        1,
        null,
        null,
        null,
        dataCallJs,
        &ctx.data_tsfn,
    ));
    _ = napi.napi_unref_threadsafe_function(env, ctx.data_tsfn);

    // Start read thread BEFORE spawning the process.
    // This ensures the reader is actively draining the ConPTY output pipe
    // before the process produces any output — prevents data loss for
    // fast-exiting processes (e.g. cmd.exe /c echo hello).
    ctx.read_thread = std.Thread.spawn(.{}, winReadThread, .{ctx}) catch {
        _ = napi.napi_release_threadsafe_function(ctx.data_tsfn, .abort);
        win.closeHandle(setup.conin);
        win.closeHandle(setup.conout);
        win.closePseudoConsole(setup.hpc);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn read thread");
        return error.NapiFailed;
    };

    // Phase 2: Spawn process inside the ConPTY
    const proc = win.startProcess(setup.hpc, cmd_line, @ptrCast(env_block.ptr), cwd_w) catch {
        // Close conout to unblock the read thread (ReadFile → EOF)
        win.closeHandle(setup.conout);
        ctx.spawn_result.conout = win.INVALID_HANDLE;
        if (ctx.read_thread) |rt| rt.join();
        // data_tsfn already released by read thread via winReadThread defer
        win.closeHandle(setup.conin);
        win.closePseudoConsole(setup.hpc);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "ConPTY process spawn failed");
        return error.NapiFailed;
    };
    ctx.spawn_result.process = proc.process;
    ctx.spawn_result.pid = proc.pid;

    // Create exit threadsafe function
    var res_name_exit: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_string_utf8(env, "zigpty_exit", 11, &res_name_exit));
    try napi.check(env, napi.napi_create_threadsafe_function(
        env,
        argv[7], // onExit callback
        null,
        res_name_exit,
        0,
        1,
        null,
        null,
        null,
        pty.exitCallJs,
        &ctx.exit_tsfn,
    ));
    _ = napi.napi_unref_threadsafe_function(env, ctx.exit_tsfn);

    // Spawn exit monitor thread
    ctx.exit_thread = std.Thread.spawn(.{}, winExitMonitorThread, .{ctx}) catch {
        _ = napi.napi_release_threadsafe_function(ctx.exit_tsfn, .abort);
        // Kill process and let read thread drain + release data_tsfn
        win.killProcess(ctx.spawn_result.process, 1);
        win.closeConin(&ctx.spawn_result);
        win.closePseudoConsole(ctx.spawn_result.hpc);
        if (ctx.read_thread) |rt| rt.join();
        win.closePty(&ctx.spawn_result);
        alloc.destroy(ctx);
        _ = napi.napi_throw_error(env, null, "failed to spawn exit thread");
        return error.NapiFailed;
    };

    // Return { pid, handle }
    var js_result: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &js_result));

    try napi.setProp(env, js_result, "pid", try napi.createI32(env, @intCast(proc.pid)));

    // Wrap context as napi_external
    var handle_val: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_external(env, @ptrCast(ctx), null, null, &handle_val));
    try napi.setProp(env, js_result, "handle", handle_val);

    return js_result;
}

/// write(handle, data) — write string to ConPTY input
pub fn write(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    writeImpl(env, info) catch {};
    return pty.returnUndef(env);
}

fn writeImpl(env: napi.napi_env, info: napi.napi_callback_info) !void {
    var argc: usize = 2;
    var argv: [2]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    const ctx: *WinConPtyContext = @ptrCast(@alignCast(ctx_ptr orelse return));

    // Get string data
    var len: usize = 0;
    try napi.check(env, napi.napi_get_value_string_utf8(env, argv[1], null, 0, &len));
    var buf = try alloc.alloc(u8, len + 1);
    defer alloc.free(buf);
    var actual: usize = 0;
    try napi.check(env, napi.napi_get_value_string_utf8(env, argv[1], buf.ptr, len + 1, &actual));

    win.writeInput(ctx.spawn_result.conin, buf[0..actual]) catch {
        _ = napi.napi_throw_error(env, null, "write failed");
        return error.NapiFailed;
    };
}

/// resize(handle, cols, rows)
pub fn resize(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    resizeImpl(env, info) catch {};
    return pty.returnUndef(env);
}

fn resizeImpl(env: napi.napi_env, info: napi.napi_callback_info) !void {
    var argc: usize = 3;
    var argv: [3]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    const ctx: *WinConPtyContext = @ptrCast(@alignCast(ctx_ptr orelse return));

    var cols_i32: i32 = 0;
    var rows_i32: i32 = 0;
    try napi.check(env, napi.napi_get_value_int32(env, argv[1], &cols_i32));
    try napi.check(env, napi.napi_get_value_int32(env, argv[2], &rows_i32));

    win.resizeConsole(
        ctx.spawn_result.hpc,
        pty.clampU16(cols_i32),
        pty.clampU16(rows_i32),
    ) catch {
        _ = napi.napi_throw_error(env, null, "resize failed");
        return error.NapiFailed;
    };
}

/// kill(handle)
pub fn kill(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    killImpl(env, info) catch {};
    return pty.returnUndef(env);
}

fn killImpl(env: napi.napi_env, info: napi.napi_callback_info) !void {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    const ctx: *WinConPtyContext = @ptrCast(@alignCast(ctx_ptr orelse return));

    win.killProcess(ctx.spawn_result.process, 1);
}

/// stats(handle) → { pid, cwd, rssBytes, cpuUser, cpuSys } | undefined
pub fn stats(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    return statsImpl(env, info) catch return pty.returnUndef(env);
}

fn statsImpl(env: napi.napi_env, info: napi.napi_callback_info) !napi.napi_value {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    const ctx: *WinConPtyContext = @ptrCast(@alignCast(ctx_ptr orelse return pty.returnUndef(env)));

    if (ctx.spawn_result.process == win.INVALID_HANDLE) return pty.returnUndef(env);

    var cwd_buf: [4]u8 = undefined; // unused on Windows
    const s = win.getStats(ctx.spawn_result.process, ctx.spawn_result.pid, &cwd_buf) orelse return pty.returnUndef(env);

    return try pty.buildStatsObject(env, s);
}

/// close(handle) — cleanup ConPTY resources
pub fn close(env: napi.napi_env, info: napi.napi_callback_info) callconv(.c) napi.napi_value {
    closeImpl(env, info) catch {};
    return pty.returnUndef(env);
}

fn closeImpl(env: napi.napi_env, info: napi.napi_callback_info) !void {
    var argc: usize = 1;
    var argv: [1]napi.napi_value = undefined;
    try napi.check(env, napi.napi_get_cb_info(env, info, &argc, &argv, null, null));

    var ctx_ptr: ?*anyopaque = null;
    try napi.check(env, napi.napi_get_value_external(env, argv[0], &ctx_ptr));
    const ctx: *WinConPtyContext = @ptrCast(@alignCast(ctx_ptr orelse return));

    // Kill the process. Don't call ClosePseudoConsole from the JS thread —
    // it blocks until the output pipe is drained, but draining requires the
    // read thread to call the tsfn callback on the JS thread, causing deadlock.
    // The exit monitor thread handles ClosePseudoConsole after process exit.
    win.killProcess(ctx.spawn_result.process, 1);
}
