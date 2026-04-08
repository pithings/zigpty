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

/// Raw exit — bypasses libc's exit() and its atexit handlers.
/// After fork, atexit handlers from the parent (Node.js/V8) should not run.
pub fn rawExit(status: u8) noreturn {
    // _exit (not exit) is the POSIX-correct way to terminate a forked child
    std.c._exit(@intCast(status));
}

pub fn resetSignalHandlers() void {
    var sa = std.mem.zeroes(std.c.Sigaction);
    sa.handler = .{ .handler = std.c.SIG.DFL };
    var i: u8 = 1;
    while (i < std.c.NSIG) : (i += 1) {
        if (i == posix.SIG.KILL or i == posix.SIG.STOP) continue;
        _ = std.c.sigaction(i, &sa, null);
    }
}

pub fn closeExcessFds() void {
    // Enumerate /dev/fd to close only open FDs, avoids ~1M close() syscalls via sysconf.
    // TODO: Apple has deprecated getdirentries — zig std.c.getdirentries maps to
    // __getdirentries64 which still works, but may need a fallback if Apple removes it.
    const dir_fd = std.c.open("/dev/fd", .{
        .ACCMODE = .RDONLY,
        .DIRECTORY = true,
        .CLOEXEC = true,
    });
    if (dir_fd < 0) {
        // Last resort: brute-force close FDs 3..255
        var fd: c_int = 3;
        while (fd < 256) : (fd += 1) {
            _ = std.c.close(fd);
        }
        return;
    }
    defer _ = std.c.close(dir_fd);

    var base: i64 = 0;
    var buf: [1024]u8 align(@alignOf(std.c.dirent)) = undefined;
    while (true) {
        const nread = std.c.getdirentries(dir_fd, &buf, buf.len, &base);
        if (nread <= 0) break;

        var offset: usize = 0;
        const end: usize = @intCast(nread);
        while (offset < end) {
            const d: *align(1) const std.c.dirent = @ptrCast(buf[offset..]);
            const reclen: usize = d.reclen;
            if (reclen == 0 or offset + reclen > end) break;
            offset += reclen;

            const fd_num = std.fmt.parseInt(c_int, d.name[0..d.namlen], 10) catch continue;
            if (fd_num > 2 and fd_num != dir_fd) {
                _ = std.c.close(fd_num);
            }
        }
    }
}
