/// Windows ConPTY implementation.
/// Uses CreatePseudoConsole + CreateProcessW for pseudo-terminal support on Windows.
const std = @import("std");
const windows = std.os.windows;

pub const HANDLE = windows.HANDLE;
pub const INVALID_HANDLE: HANDLE = windows.INVALID_HANDLE_VALUE;
pub const DWORD = windows.DWORD;
pub const BOOL = windows.BOOL;
pub const WORD = windows.WORD;

// --- Types ---

pub const Fd = HANDLE;
pub const Pid = DWORD;

pub const ExitInfo = @import("lib.zig").ExitInfo;

pub const COORD = extern struct {
    x: i16,
    y: i16,
};

pub const HPCON = *opaque {};

pub const SpawnResult = struct {
    conin: HANDLE, // write end of input pipe (parent writes here)
    conout: HANDLE, // read end of output pipe (parent reads here)
    process: HANDLE,
    pid: DWORD,
    hpc: HPCON,
};

/// Intermediate state after creating ConPTY but before spawning a process.
/// Allows starting a read thread on conout before the process produces output.
pub const ConPtySetup = struct {
    conin: HANDLE,
    conout: HANDLE,
    hpc: HPCON,

    /// Clean up all handles (call on error before startProcess).
    pub fn deinit(self: *ConPtySetup) void {
        closeHandle(self.conin);
        closeHandle(self.conout);
        ClosePseudoConsole(self.hpc);
        self.conin = INVALID_HANDLE;
        self.conout = INVALID_HANDLE;
    }
};

pub const ConPtyError = error{
    CreatePipeFailed,
    CreatePseudoConsoleFailed,
    AttrListInitFailed,
    AttrListUpdateFailed,
    CreateProcessFailed,
    ResizeFailed,
    WriteFailed,
    ReadFailed,
};

// --- Windows API extern declarations ---

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESTDHANDLES = 0x00000100;
const INFINITE = 0xFFFFFFFF;

const SECURITY_ATTRIBUTES = extern struct {
    nLength: DWORD,
    lpSecurityDescriptor: ?*anyopaque,
    bInheritHandle: BOOL,
};

const STARTUPINFOW = extern struct {
    cb: DWORD,
    lpReserved: ?[*:0]u16,
    lpDesktop: ?[*:0]u16,
    lpTitle: ?[*:0]u16,
    dwX: DWORD,
    dwY: DWORD,
    dwXSize: DWORD,
    dwYSize: DWORD,
    dwXCountChars: DWORD,
    dwYCountChars: DWORD,
    dwFillAttribute: DWORD,
    dwFlags: DWORD,
    wShowWindow: WORD,
    cbReserved2: WORD,
    lpReserved2: ?*u8,
    hStdInput: ?HANDLE,
    hStdOutput: ?HANDLE,
    hStdError: ?HANDLE,
};

const STARTUPINFOEXW = extern struct {
    StartupInfo: STARTUPINFOW,
    lpAttributeList: ?LPPROC_THREAD_ATTRIBUTE_LIST,
};

const PROCESS_INFORMATION = extern struct {
    hProcess: HANDLE,
    hThread: HANDLE,
    dwProcessId: DWORD,
    dwThreadId: DWORD,
};

const LPPROC_THREAD_ATTRIBUTE_LIST = *opaque {};

extern "kernel32" fn CreatePipe(
    hReadPipe: *HANDLE,
    hWritePipe: *HANDLE,
    lpPipeAttributes: ?*const SECURITY_ATTRIBUTES,
    nSize: DWORD,
) callconv(.c) BOOL;

extern "kernel32" fn CreatePseudoConsole(
    size: COORD,
    hInput: HANDLE,
    hOutput: HANDLE,
    dwFlags: DWORD,
    phPC: *HPCON,
) callconv(.c) windows.HRESULT;

extern "kernel32" fn ResizePseudoConsole(
    hPC: HPCON,
    size: COORD,
) callconv(.c) windows.HRESULT;

extern "kernel32" fn ClosePseudoConsole(hPC: HPCON) callconv(.c) void;

extern "kernel32" fn InitializeProcThreadAttributeList(
    lpAttributeList: ?LPPROC_THREAD_ATTRIBUTE_LIST,
    dwAttributeCount: DWORD,
    dwFlags: DWORD,
    lpSize: *usize,
) callconv(.c) BOOL;

extern "kernel32" fn UpdateProcThreadAttribute(
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
    dwFlags: DWORD,
    attribute: usize,
    lpValue: *anyopaque,
    cbSize: usize,
    lpPreviousValue: ?*anyopaque,
    lpReturnSize: ?*usize,
) callconv(.c) BOOL;

extern "kernel32" fn DeleteProcThreadAttributeList(
    lpAttributeList: LPPROC_THREAD_ATTRIBUTE_LIST,
) callconv(.c) void;

extern "kernel32" fn CreateProcessW(
    lpApplicationName: ?[*:0]const u16,
    lpCommandLine: ?[*:0]u16,
    lpProcessAttributes: ?*SECURITY_ATTRIBUTES,
    lpThreadAttributes: ?*SECURITY_ATTRIBUTES,
    bInheritHandles: BOOL,
    dwCreationFlags: DWORD,
    lpEnvironment: ?*anyopaque,
    lpCurrentDirectory: ?[*:0]const u16,
    lpStartupInfo: *STARTUPINFOW,
    lpProcessInformation: *PROCESS_INFORMATION,
) callconv(.c) BOOL;

extern "kernel32" fn WaitForSingleObject(
    hHandle: HANDLE,
    dwMilliseconds: DWORD,
) callconv(.c) DWORD;

extern "kernel32" fn GetExitCodeProcess(
    hProcess: HANDLE,
    lpExitCode: *DWORD,
) callconv(.c) BOOL;

extern "kernel32" fn TerminateProcess(
    hProcess: HANDLE,
    uExitCode: u32,
) callconv(.c) BOOL;

extern "kernel32" fn ReadFile(
    hFile: HANDLE,
    lpBuffer: [*]u8,
    nNumberOfBytesToRead: DWORD,
    lpNumberOfBytesRead: ?*DWORD,
    lpOverlapped: ?*anyopaque,
) callconv(.c) BOOL;

extern "kernel32" fn WriteFile(
    hFile: HANDLE,
    lpBuffer: [*]const u8,
    nNumberOfBytesToWrite: DWORD,
    lpNumberOfBytesWritten: ?*DWORD,
    lpOverlapped: ?*anyopaque,
) callconv(.c) BOOL;

extern "kernel32" fn GetLastError() callconv(.c) DWORD;
extern "kernel32" fn CloseHandle(hObject: HANDLE) callconv(.c) BOOL;

const FILETIME = extern struct {
    dwLowDateTime: DWORD,
    dwHighDateTime: DWORD,
};

const PROCESS_MEMORY_COUNTERS = extern struct {
    cb: DWORD,
    PageFaultCount: DWORD,
    PeakWorkingSetSize: usize,
    WorkingSetSize: usize,
    QuotaPeakPagedPoolUsage: usize,
    QuotaPagedPoolUsage: usize,
    QuotaPeakNonPagedPoolUsage: usize,
    QuotaNonPagedPoolUsage: usize,
    PagefileUsage: usize,
    PeakPagefileUsage: usize,
};

extern "kernel32" fn GetProcessTimes(
    hProcess: HANDLE,
    lpCreationTime: *FILETIME,
    lpExitTime: *FILETIME,
    lpKernelTime: *FILETIME,
    lpUserTime: *FILETIME,
) callconv(.c) BOOL;

// K32GetProcessMemoryInfo is in kernel32.dll since Windows 7, avoids linking psapi.
extern "kernel32" fn K32GetProcessMemoryInfo(
    hProcess: HANDLE,
    ppsmemCounters: *PROCESS_MEMORY_COUNTERS,
    cb: DWORD,
) callconv(.c) BOOL;

fn filetimeToMicros(ft: FILETIME) u64 {
    // FILETIME is in 100-nanosecond intervals — divide by 10 for microseconds.
    const combined: u64 = (@as(u64, ft.dwHighDateTime) << 32) | @as(u64, ft.dwLowDateTime);
    return combined / 10;
}

const lib = @import("lib.zig");

/// Get stats for the spawned shell process (no foreground tracking on Windows).
/// cwd is always null on Windows — reading another process's cwd requires
/// NtQueryInformationProcess + remote PEB read, which is fragile across
/// elevation boundaries.
pub fn getStats(process: HANDLE, pid: u32) ?lib.Stats {
    var stats = lib.Stats{
        .pid = pid,
        .cwd = null,
        .rss_bytes = 0,
        .cpu_user_us = 0,
        .cpu_sys_us = 0,
    };
    var any_field: bool = false;

    var pmc = std.mem.zeroes(PROCESS_MEMORY_COUNTERS);
    pmc.cb = @sizeOf(PROCESS_MEMORY_COUNTERS);
    if (K32GetProcessMemoryInfo(process, &pmc, @sizeOf(PROCESS_MEMORY_COUNTERS)) != 0) {
        stats.rss_bytes = pmc.WorkingSetSize;
        any_field = true;
    }

    var creation: FILETIME = undefined;
    var exit: FILETIME = undefined;
    var kernel: FILETIME = undefined;
    var user: FILETIME = undefined;
    if (GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0) {
        stats.cpu_user_us = filetimeToMicros(user);
        stats.cpu_sys_us = filetimeToMicros(kernel);
        any_field = true;
    }

    return if (any_field) stats else null;
}

// --- Public API ---

/// Phase 1: Create ConPTY pipes and pseudo console (no process yet).
/// Start a read thread on setup.conout before calling startProcess to ensure
/// no output is lost for fast-exiting processes.
pub fn createConPty(cols: u16, rows: u16) ConPtyError!ConPtySetup {
    // Create input pipe (parent writes → ConPTY reads)
    var pipe_in_read: HANDLE = INVALID_HANDLE;
    var pipe_in_write: HANDLE = INVALID_HANDLE;
    if (CreatePipe(&pipe_in_read, &pipe_in_write, null, 0) == 0) {
        return ConPtyError.CreatePipeFailed;
    }

    // Create output pipe (ConPTY writes → parent reads)
    var pipe_out_read: HANDLE = INVALID_HANDLE;
    var pipe_out_write: HANDLE = INVALID_HANDLE;
    if (CreatePipe(&pipe_out_read, &pipe_out_write, null, 0) == 0) {
        closeHandle(pipe_in_read);
        closeHandle(pipe_in_write);
        return ConPtyError.CreatePipeFailed;
    }

    // Create pseudo console
    const size = COORD{ .x = @intCast(cols), .y = @intCast(rows) };
    var hpc: HPCON = undefined;
    const hr = CreatePseudoConsole(size, pipe_in_read, pipe_out_write, 0, &hpc);
    if (hr < 0) {
        closeHandle(pipe_in_read);
        closeHandle(pipe_in_write);
        closeHandle(pipe_out_read);
        closeHandle(pipe_out_write);
        return ConPtyError.CreatePseudoConsoleFailed;
    }

    // CreatePseudoConsole duplicates these handles internally — safe to close
    closeHandle(pipe_in_read);
    closeHandle(pipe_out_write);

    return ConPtySetup{
        .conin = pipe_in_write,
        .conout = pipe_out_read,
        .hpc = hpc,
    };
}

/// Phase 2: Spawn a process inside an existing ConPTY.
/// Call after createConPty and after starting the output read thread.
pub fn startProcess(
    hpc: HPCON,
    cmd_line: [*:0]u16,
    env_block: ?*anyopaque,
    cwd: ?[*:0]const u16,
) ConPtyError!struct { process: HANDLE, pid: DWORD } {
    // Initialize proc thread attribute list
    var attr_size: usize = 0;
    _ = InitializeProcThreadAttributeList(null, 1, 0, &attr_size);

    const attr_buf = std.heap.page_allocator.alignedAlloc(u8, .fromByteUnits(@alignOf(usize)), attr_size) catch {
        return ConPtyError.AttrListInitFailed;
    };
    const attr_list: LPPROC_THREAD_ATTRIBUTE_LIST = @ptrCast(attr_buf.ptr);
    defer std.heap.page_allocator.free(attr_buf);

    if (InitializeProcThreadAttributeList(attr_list, 1, 0, &attr_size) == 0) {
        return ConPtyError.AttrListInitFailed;
    }
    defer DeleteProcThreadAttributeList(attr_list);

    if (UpdateProcThreadAttribute(
        attr_list,
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
        @ptrCast(hpc),
        @sizeOf(HPCON),
        null,
        null,
    ) == 0) {
        return ConPtyError.AttrListUpdateFailed;
    }

    // Create process with null std handles so the process uses the pseudo
    // console instead of inheriting the parent's real console handles.
    // Without STARTF_USESTDHANDLES, output goes to the real console.
    var si = std.mem.zeroes(STARTUPINFOEXW);
    si.StartupInfo.cb = @sizeOf(STARTUPINFOEXW);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.lpAttributeList = attr_list;

    var pi = std.mem.zeroes(PROCESS_INFORMATION);

    // Cast away const for CreateProcessW (it may modify the command line in-place)
    const cmd_buf: [*:0]u16 = @constCast(cmd_line);
    if (CreateProcessW(
        null,
        cmd_buf,
        null,
        null,
        0, // don't inherit handles
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
        env_block,
        cwd,
        @ptrCast(&si),
        &pi,
    ) == 0) {
        return ConPtyError.CreateProcessFailed;
    }

    // Don't need thread handle
    closeHandle(pi.hThread);

    return .{ .process = pi.hProcess, .pid = pi.dwProcessId };
}

/// Convenience: create ConPTY + spawn process in one call (for Zig API users).
pub fn spawnConPty(
    cmd_line: [*:0]u16,
    env_block: ?*anyopaque,
    cwd: ?[*:0]const u16,
    cols: u16,
    rows: u16,
) ConPtyError!SpawnResult {
    var setup = try createConPty(cols, rows);

    const proc = startProcess(setup.hpc, cmd_line, env_block, cwd) catch |e| {
        setup.deinit();
        return e;
    };

    return SpawnResult{
        .conin = setup.conin,
        .conout = setup.conout,
        .process = proc.process,
        .pid = proc.pid,
        .hpc = setup.hpc,
    };
}

/// Read from the ConPTY output pipe (blocking).
/// Returns bytes read, or 0 on EOF/error.
pub fn readOutput(conout: HANDLE, buf: []u8) usize {
    var bytes_read: DWORD = 0;
    if (ReadFile(conout, buf.ptr, @intCast(buf.len), &bytes_read, null) == 0) {
        return 0; // EOF or error (pipe broken)
    }
    return bytes_read;
}

/// Write to the ConPTY input pipe.
pub fn writeInput(conin: HANDLE, data: []const u8) ConPtyError!void {
    var offset: usize = 0;
    while (offset < data.len) {
        var written: DWORD = 0;
        if (WriteFile(
            conin,
            data[offset..].ptr,
            @intCast(data.len - offset),
            &written,
            null,
        ) == 0) {
            return ConPtyError.WriteFailed;
        }
        offset += written;
    }
}

/// Resize the pseudo console.
pub fn resizeConsole(hpc: HPCON, cols: u16, rows: u16) ConPtyError!void {
    const size = COORD{ .x = @intCast(cols), .y = @intCast(rows) };
    const hr = ResizePseudoConsole(hpc, size);
    if (hr < 0) return ConPtyError.ResizeFailed;
}

/// Wait for process exit (blocking). Call from background thread.
pub fn waitForExit(process: HANDLE) ExitInfo {
    _ = WaitForSingleObject(process, INFINITE);
    var exit_code: DWORD = 0;
    if (GetExitCodeProcess(process, &exit_code) == 0) {
        return .{ .exit_code = -1, .signal_code = 0 };
    }
    return .{ .exit_code = @bitCast(exit_code), .signal_code = 0 };
}

/// Kill the process.
pub fn killProcess(process: HANDLE, exit_code: u32) void {
    _ = TerminateProcess(process, exit_code);
}

/// Close the input pipe (parent write end). Call after process exits.
pub fn closeConin(result: *SpawnResult) void {
    if (result.conin != INVALID_HANDLE) {
        closeHandle(result.conin);
        result.conin = INVALID_HANDLE;
    }
}

/// Close the pseudo console. This flushes any remaining output to the pipe
/// and then closes it, causing ReadFile to return EOF. Must be called while
/// the read thread is still running (draining the pipe) to avoid deadlock.
pub fn closePseudoConsole(hpc: HPCON) void {
    ClosePseudoConsole(hpc);
}

/// Close all ConPTY handles. Must be called after read thread has finished.
pub fn closePty(result: *SpawnResult) void {
    closeHandle(result.conin);
    closeHandle(result.conout);
    closeHandle(result.process);
    result.conin = INVALID_HANDLE;
    result.conout = INVALID_HANDLE;
    result.process = INVALID_HANDLE;
}

// --- Helpers ---

pub fn closeHandle(h: HANDLE) void {
    _ = CloseHandle(h);
}

// --- UTF-8 to UTF-16 conversion helpers ---

/// Convert a UTF-8 string to a null-terminated UTF-16 string.
/// Caller must free with c_allocator.
pub fn utf8ToUtf16Alloc(alloc: std.mem.Allocator, utf8: []const u8) ![:0]u16 {
    return std.unicode.utf8ToUtf16LeAllocZ(alloc, utf8) catch return error.InvalidUtf8;
}

/// Build a Windows environment block (null-delimited, double-null-terminated UTF-16)
/// from an array of "KEY=VALUE" UTF-8 strings.
pub fn buildEnvBlock(a: std.mem.Allocator, env_pairs: []const []const u8) ![]u16 {
    var buf = std.ArrayListUnmanaged(u16){};
    for (env_pairs) |pair| {
        const wide = try std.unicode.utf8ToUtf16LeAllocZ(a, pair);
        defer a.free(wide);
        try buf.appendSlice(a, wide);
        try buf.append(a, 0); // null terminator after each pair
    }
    try buf.append(a, 0); // double-null terminator
    return buf.toOwnedSlice(a);
}

/// Build a Windows command line string from file and args.
/// Handles quoting per Windows rules.
pub fn buildCmdLine(a: std.mem.Allocator, file: []const u8, args: []const []const u8) ![:0]u16 {
    var buf = std.ArrayListUnmanaged(u8){};
    defer buf.deinit(a);

    // Quote the executable
    try appendQuoted(&buf, a, file);
    for (args) |arg| {
        try buf.append(a, ' ');
        try appendQuoted(&buf, a, arg);
    }

    return std.unicode.utf8ToUtf16LeAllocZ(a, buf.items) catch return error.InvalidUtf8;
}

fn appendQuoted(buf: *std.ArrayListUnmanaged(u8), a: std.mem.Allocator, arg: []const u8) !void {
    // Check if quoting is needed
    var needs_quote = arg.len == 0;
    for (arg) |c| {
        if (c == ' ' or c == '\t' or c == '"' or c == '\\') {
            needs_quote = true;
            break;
        }
    }

    if (!needs_quote) {
        try buf.appendSlice(a, arg);
        return;
    }

    try buf.append(a, '"');
    var i: usize = 0;
    while (i < arg.len) {
        // Count backslashes
        var num_backslashes: usize = 0;
        while (i < arg.len and arg[i] == '\\') {
            num_backslashes += 1;
            i += 1;
        }

        if (i == arg.len) {
            // Trailing backslashes: double them
            for (0..num_backslashes * 2) |_| try buf.append(a, '\\');
        } else if (arg[i] == '"') {
            // Backslashes before quote: double them + escape quote
            for (0..num_backslashes * 2 + 1) |_| try buf.append(a, '\\');
            try buf.append(a, '"');
            i += 1;
        } else {
            // Backslashes not before quote: keep as-is
            for (0..num_backslashes) |_| try buf.append(a, '\\');
            try buf.append(a, arg[i]);
            i += 1;
        }
    }
    try buf.append(a, '"');
}
