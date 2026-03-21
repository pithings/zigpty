/// Minimal Zig bindings for Node-API (N-API).
/// Pure extern declarations — no C headers needed.

// Opaque handle types
pub const napi_env = *opaque {};
pub const napi_value = *opaque {};
pub const napi_ref = *opaque {};
pub const napi_callback_info = *opaque {};
pub const napi_threadsafe_function = *opaque {};

pub const napi_status = enum(c_int) {
    ok = 0,
    invalid_arg,
    object_expected,
    string_expected,
    name_expected,
    function_expected,
    number_expected,
    boolean_expected,
    array_expected,
    generic_failure,
    pending_exception,
    cancelled,
    escape_called_twice,
    handle_scope_mismatch,
    callback_scope_mismatch,
    queue_full,
    closing,
    bigint_expected,
    date_expected,
    arraybuffer_expected,
    detachable_arraybuffer_expected,
    would_deadlock,
    no_external_buffers_allowed,
    cannot_run_js,
};

pub const napi_callback = *const fn (napi_env, napi_callback_info) callconv(.c) napi_value;
pub const napi_finalize = ?*const fn (napi_env, ?*anyopaque, ?*anyopaque) callconv(.c) void;
pub const napi_threadsafe_function_call_js = ?*const fn (napi_env, napi_value, ?*anyopaque, ?*anyopaque) callconv(.c) void;

pub const napi_threadsafe_function_release_mode = enum(c_int) {
    release = 0,
    abort = 1,
};

pub const napi_threadsafe_function_call_mode = enum(c_int) {
    nonblocking = 0,
    blocking = 1,
};

// --- Module registration ---

pub extern fn napi_module_register(mod: *NapiModule) void;

pub const NapiModule = extern struct {
    nm_version: c_int,
    nm_flags: c_uint,
    nm_filename: [*:0]const u8,
    nm_register_func: napi_callback,
    nm_modname: [*:0]const u8,
    nm_priv: ?*anyopaque,
    reserved: [4]?*anyopaque,
};

// --- Object creation ---

pub extern fn napi_create_object(env: napi_env, result: *napi_value) napi_status;
pub extern fn napi_set_named_property(env: napi_env, object: napi_value, name: [*:0]const u8, value: napi_value) napi_status;
pub extern fn napi_get_named_property(env: napi_env, object: napi_value, name: [*:0]const u8, result: *napi_value) napi_status;

// --- Value creation ---

pub extern fn napi_create_int32(env: napi_env, value: i32, result: *napi_value) napi_status;
pub extern fn napi_create_uint32(env: napi_env, value: u32, result: *napi_value) napi_status;
pub extern fn napi_create_int64(env: napi_env, value: i64, result: *napi_value) napi_status;
pub extern fn napi_create_double(env: napi_env, value: f64, result: *napi_value) napi_status;
pub extern fn napi_create_string_utf8(env: napi_env, str: [*]const u8, length: usize, result: *napi_value) napi_status;
pub extern fn napi_get_undefined(env: napi_env, result: *napi_value) napi_status;
pub extern fn napi_get_null(env: napi_env, result: *napi_value) napi_status;
pub extern fn napi_get_boolean(env: napi_env, value: bool, result: *napi_value) napi_status;

// --- Value extraction ---

pub extern fn napi_get_value_int32(env: napi_env, value: napi_value, result: *i32) napi_status;
pub extern fn napi_get_value_uint32(env: napi_env, value: napi_value, result: *u32) napi_status;
pub extern fn napi_get_value_int64(env: napi_env, value: napi_value, result: *i64) napi_status;
pub extern fn napi_get_value_double(env: napi_env, value: napi_value, result: *f64) napi_status;
pub extern fn napi_get_value_bool(env: napi_env, value: napi_value, result: *bool) napi_status;
pub extern fn napi_get_value_string_utf8(env: napi_env, value: napi_value, buf: ?[*]u8, bufsize: usize, result: *usize) napi_status;

// --- Callback args ---

pub extern fn napi_get_cb_info(
    env: napi_env,
    cbinfo: napi_callback_info,
    argc: *usize,
    argv: ?[*]napi_value,
    this_arg: ?*napi_value,
    data: ?*?*anyopaque,
) napi_status;

// --- Function creation ---

pub extern fn napi_create_function(
    env: napi_env,
    utf8name: ?[*:0]const u8,
    length: usize,
    cb: napi_callback,
    data: ?*anyopaque,
    result: *napi_value,
) napi_status;

// --- Error handling ---

pub extern fn napi_throw_error(env: napi_env, code: ?[*:0]const u8, msg: [*:0]const u8) napi_status;
pub extern fn napi_throw_type_error(env: napi_env, code: ?[*:0]const u8, msg: [*:0]const u8) napi_status;

// --- Array ---

pub extern fn napi_create_array(env: napi_env, result: *napi_value) napi_status;
pub extern fn napi_create_array_with_length(env: napi_env, length: usize, result: *napi_value) napi_status;
pub extern fn napi_get_array_length(env: napi_env, value: napi_value, result: *u32) napi_status;
pub extern fn napi_set_element(env: napi_env, object: napi_value, index: u32, value: napi_value) napi_status;
pub extern fn napi_get_element(env: napi_env, object: napi_value, index: u32, result: *napi_value) napi_status;

// --- ThreadSafeFunction (NAPI v4+) ---

pub extern fn napi_create_threadsafe_function(
    env: napi_env,
    func: ?napi_value,
    async_resource: ?napi_value,
    async_resource_name: napi_value,
    max_queue_size: usize,
    initial_thread_count: usize,
    thread_finalize_data: ?*anyopaque,
    thread_finalize_cb: napi_finalize,
    context: ?*anyopaque,
    call_js_cb: napi_threadsafe_function_call_js,
    result: *napi_threadsafe_function,
) napi_status;

pub extern fn napi_call_threadsafe_function(
    func: napi_threadsafe_function,
    data: ?*anyopaque,
    is_blocking: napi_threadsafe_function_call_mode,
) napi_status;

pub extern fn napi_release_threadsafe_function(
    func: napi_threadsafe_function,
    mode: napi_threadsafe_function_release_mode,
) napi_status;

pub extern fn napi_unref_threadsafe_function(env: napi_env, func: napi_threadsafe_function) napi_status;

// --- External values ---

pub extern fn napi_create_external(
    env: napi_env,
    data: ?*anyopaque,
    finalize_cb: napi_finalize,
    finalize_hint: ?*anyopaque,
    result: *napi_value,
) napi_status;

pub extern fn napi_get_value_external(env: napi_env, value: napi_value, result: *?*anyopaque) napi_status;

// --- Buffer ---

pub extern fn napi_get_buffer_info(env: napi_env, value: napi_value, data: *?[*]u8, length: *usize) napi_status;
pub extern fn napi_create_buffer_copy(env: napi_env, length: usize, data: [*]const u8, result_data: ?*?*anyopaque, result: *napi_value) napi_status;

// --- Call function ---

pub extern fn napi_call_function(
    env: napi_env,
    recv: napi_value,
    func: napi_value,
    argc: usize,
    argv: ?[*]const napi_value,
    result: ?*napi_value,
) napi_status;

// --- Helpers ---

pub const NAPI_AUTO_LENGTH: usize = @as(usize, @bitCast(@as(isize, -1)));

/// Check a napi_status, throw JS error on failure.
pub inline fn check(env: napi_env, status: napi_status) !void {
    if (status != .ok) {
        _ = napi_throw_error(env, null, statusMsg(status));
        return error.NapiFailed;
    }
}

fn statusMsg(status: napi_status) [*:0]const u8 {
    return switch (status) {
        .ok => "ok",
        .invalid_arg => "invalid argument",
        .object_expected => "object expected",
        .string_expected => "string expected",
        .function_expected => "function expected",
        .number_expected => "number expected",
        .boolean_expected => "boolean expected",
        .generic_failure => "generic failure",
        .pending_exception => "pending exception",
        .queue_full => "queue full",
        .closing => "closing",
        .cancelled => "cancelled",
        else => "napi error",
    };
}

/// Create a JS string from a Zig slice.
pub inline fn createString(env: napi_env, str: []const u8) !napi_value {
    var result: napi_value = undefined;
    try check(env, napi_create_string_utf8(env, str.ptr, str.len, &result));
    return result;
}

/// Create a JS number from an i32.
pub inline fn createI32(env: napi_env, val: i32) !napi_value {
    var result: napi_value = undefined;
    try check(env, napi_create_int32(env, val, &result));
    return result;
}

/// Set a named property on a JS object.
pub inline fn setProp(env: napi_env, obj: napi_value, name: [*:0]const u8, val: napi_value) !void {
    try check(env, napi_set_named_property(env, obj, name, val));
}

/// Get string argument from callback args. Caller owns returned memory.
pub inline fn getStringArg(env: napi_env, val: napi_value, buf: []u8) ![]const u8 {
    var len: usize = 0;
    try check(env, napi_get_value_string_utf8(env, val, buf.ptr, buf.len, &len));
    return buf[0..len];
}
