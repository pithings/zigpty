/// NAPI wrapper for zigpty PTY operations.
/// Shared helpers + platform dispatch to pty_napi_unix.zig / pty_napi_win.zig.
const std = @import("std");
const builtin = @import("builtin");
const napi = @import("napi.zig");
const lib = @import("lib.zig");

pub const is_windows = builtin.os.tag == .windows;
pub const alloc = if (is_windows) std.heap.page_allocator else std.heap.c_allocator;

// --- Platform-specific NAPI modules ---

const unix_napi = if (!is_windows) @import("pty_unix.zig") else struct {};
const win_napi = if (is_windows) @import("win/napi.zig") else struct {};

// Unix re-exports
pub const fork = if (!is_windows) unix_napi.fork else void;
pub const open = if (!is_windows) unix_napi.open else void;
pub const resize = if (!is_windows) unix_napi.resize else void;
pub const getProcess = if (!is_windows) unix_napi.getProcess else void;
pub const stats = if (!is_windows) unix_napi.stats else void;
// Windows re-exports
pub const winSpawn = if (is_windows) win_napi.spawn else void;
pub const winWrite = if (is_windows) win_napi.write else void;
pub const winResize = if (is_windows) win_napi.resize else void;
pub const winKill = if (is_windows) win_napi.kill else void;
pub const winClose = if (is_windows) win_napi.close else void;
pub const winStats = if (is_windows) win_napi.stats else void;

// --- Shared helpers (used by both platform modules) ---

/// Called on the JS thread when the background thread reports process exit.
pub fn exitCallJs(
    env: napi.napi_env,
    js_callback: napi.napi_value,
    _: ?*anyopaque,
    raw_data: ?*anyopaque,
) callconv(.c) void {
    const data: *lib.ExitInfo = @ptrCast(@alignCast(raw_data orelse return));
    defer alloc.destroy(data);

    var obj: napi.napi_value = undefined;
    if (napi.napi_create_object(env, &obj) != .ok) return;

    var exit_val: napi.napi_value = undefined;
    if (napi.napi_create_int32(env, data.exit_code, &exit_val) != .ok) return;
    if (napi.napi_set_named_property(env, obj, "exitCode", exit_val) != .ok) return;

    var sig_val: napi.napi_value = undefined;
    if (napi.napi_create_int32(env, data.signal_code, &sig_val) != .ok) return;
    if (napi.napi_set_named_property(env, obj, "signal", sig_val) != .ok) return;

    var undefined_val: napi.napi_value = undefined;
    if (napi.napi_get_undefined(env, &undefined_val) != .ok) return;

    var args = [_]napi.napi_value{obj};
    _ = napi.napi_call_function(env, undefined_val, js_callback, 1, &args, null);
}

pub fn getStringAlloc(env: napi.napi_env, val: napi.napi_value, a: std.mem.Allocator) ![:0]const u8 {
    var len: usize = 0;
    try napi.check(env, napi.napi_get_value_string_utf8(env, val, null, 0, &len));
    const buf = try a.allocSentinel(u8, len, 0);
    var actual: usize = 0;
    try napi.check(env, napi.napi_get_value_string_utf8(env, val, buf.ptr, len + 1, &actual));
    return buf;
}

/// Safely convert an i32 (from JS NAPI) to u16, clamping to [0, 65535].
pub fn clampU16(val: i32) u16 {
    if (val <= 0) return 0;
    if (val > std.math.maxInt(u16)) return std.math.maxInt(u16);
    return @intCast(val);
}

pub fn returnUndef(env: napi.napi_env) napi.napi_value {
    var undef: napi.napi_value = undefined;
    _ = napi.napi_get_undefined(env, &undef);
    return undef;
}

/// Build a JS object from a `lib.Stats` struct.
pub fn buildStatsObject(env: napi.napi_env, s: lib.Stats) !napi.napi_value {
    var obj: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_object(env, &obj));

    var pid_val: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_int64(env, @intCast(s.pid), &pid_val));
    try napi.setProp(env, obj, "pid", pid_val);

    if (s.cwd) |cwd| {
        try napi.setProp(env, obj, "cwd", try napi.createString(env, cwd));
    } else {
        var null_val: napi.napi_value = undefined;
        try napi.check(env, napi.napi_get_null(env, &null_val));
        try napi.setProp(env, obj, "cwd", null_val);
    }

    var rss_val: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_int64(env, @intCast(s.rss_bytes), &rss_val));
    try napi.setProp(env, obj, "rssBytes", rss_val);

    var cpu_user_val: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_int64(env, @intCast(s.cpu_user_us), &cpu_user_val));
    try napi.setProp(env, obj, "cpuUser", cpu_user_val);

    var cpu_sys_val: napi.napi_value = undefined;
    try napi.check(env, napi.napi_create_int64(env, @intCast(s.cpu_sys_us), &cpu_sys_val));
    try napi.setProp(env, obj, "cpuSys", cpu_sys_val);

    return obj;
}
