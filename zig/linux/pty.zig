/// Linux-specific PTY helpers.
const std = @import("std");
const posix = std.posix;
const linux = std.os.linux;

extern fn execvpe(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) c_int;
extern fn ptsname_r(fd: c_int, buf: [*]u8, buflen: usize) c_int;
extern fn tcgetpgrp(fd: c_int) c_int;

pub fn execChild(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8, envp: [*:null]const ?[*:0]const u8) void {
    _ = execvpe(file, argv, envp);
}

pub fn getPtyName(fd: c_int, buf: *[256]u8) usize {
    if (ptsname_r(fd, buf, buf.len) == 0) {
        return std.mem.len(@as([*:0]const u8, @ptrCast(buf)));
    }
    return 0;
}

/// Get the foreground process name via /proc/{pgrp}/cmdline.
pub fn getProcessName(fd: posix.fd_t, buf: []u8) ?[]const u8 {
    const pgrp = tcgetpgrp(@intCast(fd));
    if (pgrp < 0) return null;

    var path_buf: [64]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "/proc/{d}/cmdline", .{pgrp}) catch return null;

    const file_handle = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file_handle.close();

    const bytes_read = file_handle.read(buf) catch return null;
    if (bytes_read == 0) return null;

    const cmd = std.mem.sliceTo(buf[0..bytes_read], 0);
    return if (std.mem.lastIndexOfScalar(u8, cmd, '/')) |p| cmd[p + 1 ..] else cmd;
}

pub fn resetSignalHandlers() void {
    var sa = std.mem.zeroes(linux.Sigaction);
    sa.handler = .{ .handler = linux.SIG.DFL };
    var i: u8 = 1;
    while (i < linux.NSIG) : (i += 1) {
        if (i == linux.SIG.KILL or i == linux.SIG.STOP) continue;
        _ = linux.sigaction(i, &sa, null);
    }
}

pub fn closeExcessFds() void {
    // Try close_range syscall directly (Linux 5.9+, avoids libc dependency)
    const rc = linux.syscall3(.close_range, 3, std.math.maxInt(c_uint), 0);
    if (linux.E.init(rc) == .SUCCESS) return;

    // Fallback: iterate /proc/self/fd
    var dir = std.fs.openDirAbsolute("/proc/self/fd", .{ .iterate = true }) catch return;
    defer dir.close();

    var iter = dir.iterate();
    while (iter.next() catch null) |entry| {
        const fd_num = std.fmt.parseInt(posix.fd_t, entry.name, 10) catch continue;
        if (fd_num > 2 and fd_num != dir.fd) {
            posix.close(fd_num);
        }
    }
}
