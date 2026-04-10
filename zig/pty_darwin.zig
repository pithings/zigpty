/// macOS-specific PTY helpers.
const std = @import("std");
const posix = std.posix;
const lib = @import("lib.zig");

extern fn execvp(file: [*:0]const u8, argv: [*:null]const ?[*:0]const u8) c_int;
extern fn tcgetpgrp(fd: c_int) c_int;
extern fn sysctl(name: [*]c_int, namelen: c_uint, oldp: ?*anyopaque, oldlenp: ?*usize, newp: ?*const anyopaque, newlen: usize) c_int;
extern fn proc_pidinfo(pid: c_int, flavor: c_int, arg: u64, buffer: *anyopaque, buffersize: c_int) c_int;

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

// proc_pidinfo flavors
const PROC_PIDTASKINFO = 4;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_TASKINFO_SIZE = 96;
const PROC_VNODEPATHINFO_SIZE = 2352;
// Offset of vnode_info_path.vip_path within proc_vnodepathinfo (start of pvi_cdir.vip_path).
// Layout: vinfo_stat(136) + vi_type(4) + vi_pad(4) + fsid_t(8) = 152
const VIP_PATH_OFFSET = 152;
const MAXPATHLEN = 1024;

/// Get stats for the PTY's foreground process group.
pub fn getStats(fd: posix.fd_t, cwd_buf: []u8) ?lib.Stats {
    const pgrp = tcgetpgrp(@intCast(fd));
    if (pgrp < 0) return null;

    var stats = lib.Stats{
        .pid = pgrp,
        .cwd = null,
        .rss_bytes = 0,
        .cpu_user_us = 0,
        .cpu_sys_us = 0,
    };

    // PROC_PIDTASKINFO → virtual_size, resident_size, total_user (ns), total_system (ns)
    var task_buf: [PROC_TASKINFO_SIZE]u8 align(8) = undefined;
    const ti_rc = proc_pidinfo(pgrp, PROC_PIDTASKINFO, 0, &task_buf, PROC_TASKINFO_SIZE);
    if (ti_rc == PROC_TASKINFO_SIZE) {
        stats.rss_bytes = std.mem.readInt(u64, task_buf[8..16], .little);
        const total_user_ns = std.mem.readInt(u64, task_buf[16..24], .little);
        const total_sys_ns = std.mem.readInt(u64, task_buf[24..32], .little);
        stats.cpu_user_us = total_user_ns / 1000;
        stats.cpu_sys_us = total_sys_ns / 1000;
    }

    // PROC_PIDVNODEPATHINFO → cwd path at offset VIP_PATH_OFFSET (MAXPATHLEN bytes, null-terminated)
    var vpi_buf: [PROC_VNODEPATHINFO_SIZE]u8 align(8) = undefined;
    const vpi_rc = proc_pidinfo(pgrp, PROC_PIDVNODEPATHINFO, 0, &vpi_buf, PROC_VNODEPATHINFO_SIZE);
    if (vpi_rc >= VIP_PATH_OFFSET + 1) {
        const path_slice = vpi_buf[VIP_PATH_OFFSET..][0..MAXPATHLEN];
        const len = std.mem.indexOfScalar(u8, path_slice, 0) orelse MAXPATHLEN;
        if (len > 0 and len <= cwd_buf.len) {
            @memcpy(cwd_buf[0..len], path_slice[0..len]);
            stats.cwd = cwd_buf[0..len];
        }
    }

    return stats;
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
