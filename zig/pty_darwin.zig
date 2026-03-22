/// macOS-specific PTY helpers.
const std = @import("std");
const posix = std.posix;

extern fn execvp(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) c_int;
extern fn tcgetpgrp(fd: c_int) c_int;
extern fn sysctl(name: [*]c_int, namelen: c_uint, oldp: ?*anyopaque, oldlenp: ?*usize, newp: ?*const anyopaque, newlen: usize) c_int;

/// On macOS there is no execvpe — set environ pointer then execvp.
pub fn execChild(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) void {
    // environ is char**, we cast our const env pointer to match
    const environ: *[*:null]const ?[*:0]const u8 = @extern(*[*:null]const ?[*:0]const u8, .{ .name = "environ" });
    environ.* = envp;
    _ = execvp(file, argv);
}

/// Get PTY name — on macOS, ptsname_r is not available.
/// We return 0 (no name) and let the caller handle it.
pub fn getPtyName(_: c_int, _: *[256]u8) usize {
    return 0;
}

/// Get the foreground process name via sysctl KERN_PROC.
pub fn getProcessName(fd: posix.fd_t, buf: []u8) ?[]const u8 {
    const pgrp = tcgetpgrp(@intCast(fd));
    if (pgrp < 0) return null;

    // sysctl kern.proc.pid.<pgrp>
    const CTL_KERN = 1;
    const KERN_PROC = 14;
    const KERN_PROC_PID = 1;
    var mib = [4]c_int{ CTL_KERN, KERN_PROC, KERN_PROC_PID, pgrp };

    // kinfo_proc is large (~648 bytes on arm64 macOS)
    var info_buf: [720]u8 align(8) = undefined;
    var size: usize = info_buf.len;

    if (sysctl(&mib, 4, &info_buf, &size, null, 0) != 0) return null;
    if (size == 0) return null;

    // p_comm is at offset 243 in kinfo_proc.kp_proc on macOS (both arm64 and x86_64).
    const P_COMM_OFFSET = 243;
    const MAXCOMLEN = 16;
    if (size < P_COMM_OFFSET + MAXCOMLEN) return null;

    // Bounded scan — p_comm is at most MAXCOMLEN bytes, avoid reading past buffer
    const comm = info_buf[P_COMM_OFFSET..][0..MAXCOMLEN];
    const len = std.mem.indexOfScalar(u8, comm, 0) orelse MAXCOMLEN;
    if (len == 0 or len > buf.len) return null;

    @memcpy(buf[0..len], comm[0..len]);
    return buf[0..len];
}

pub fn resetSignalHandlers() void {
    var sa = std.mem.zeroes(std.c.Sigaction);
    sa.handler = .{ .handler = std.c.SIG.DFL };
    var i: u6 = 1;
    while (i < std.c.NSIG) : (i += 1) {
        if (i == posix.SIG.KILL or i == posix.SIG.STOP) continue;
        _ = std.c.sigaction(i, &sa, null);
    }
}

pub fn closeExcessFds() void {
    // macOS has no close_range or /proc/self/fd.
    // Close FDs 3..256 (reasonable upper bound).
    var fd: c_int = 3;
    while (fd < 256) : (fd += 1) {
        _ = std.c.close(fd);
    }
}
