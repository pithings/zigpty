/// zigpty native addon — NAPI module entry point.
const builtin = @import("builtin");
const napi = @import("napi.zig");
const pty = @import("pty.zig");

/// Module initialization function called by Node.js.
fn init(env: napi.napi_env, exports: napi.napi_value) callconv(.c) napi.napi_value {
    if (builtin.os.tag == .windows) {
        // Windows ConPTY exports
        registerFn(env, exports, "spawn", pty.winSpawn);
        registerFn(env, exports, "write", pty.winWrite);
        registerFn(env, exports, "resize", pty.winResize);
        registerFn(env, exports, "kill", pty.winKill);
        registerFn(env, exports, "close", pty.winClose);
        registerFn(env, exports, "stats", pty.winStats);
    } else {
        // Unix PTY exports
        registerFn(env, exports, "fork", pty.fork);
        registerFn(env, exports, "open", pty.open);
        registerFn(env, exports, "resize", pty.resize);
        registerFn(env, exports, "process", pty.getProcess);
        registerFn(env, exports, "stats", pty.stats);
    }
    return exports;
}

fn registerFn(env: napi.napi_env, exports: napi.napi_value, name: [*:0]const u8, cb: napi.napi_callback) void {
    var func: napi.napi_value = undefined;
    if (napi.napi_create_function(env, name, napi.NAPI_AUTO_LENGTH, cb, null, &func) != .ok) return;
    _ = napi.napi_set_named_property(env, exports, name, func);
}

// --- Module registration via exported symbol ---
// Node.js looks for napi_register_module_v1 symbol in the .node shared library.

export fn napi_register_module_v1(env: napi.napi_env, exports: napi.napi_value) napi.napi_value {
    return init(env, exports);
}
