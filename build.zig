const std = @import("std");

const cross_targets: []const std.Target.Query = &.{
    .{ .cpu_arch = .x86_64, .os_tag = .linux, .abi = .gnu },
    .{ .cpu_arch = .x86_64, .os_tag = .linux, .abi = .musl },
    .{ .cpu_arch = .aarch64, .os_tag = .linux, .abi = .gnu },
    .{ .cpu_arch = .aarch64, .os_tag = .linux, .abi = .musl },
    .{ .cpu_arch = .x86_64, .os_tag = .macos },
    .{ .cpu_arch = .aarch64, .os_tag = .macos },
    .{ .cpu_arch = .x86_64, .os_tag = .windows },
    .{ .cpu_arch = .aarch64, .os_tag = .windows },
};

pub fn build(b: *std.Build) void {
    b.install_path = "prebuilds";

    const optimize: std.builtin.OptimizeMode = b.option(std.builtin.OptimizeMode, "optimize", "Optimization mode") orelse .ReleaseSmall;
    const target_query = b.standardTargetOptionsQueryOnly(.{});

    // --- Zig package module (pure library, no NAPI) ---
    _ = b.addModule("zigpty", .{
        .root_source_file = b.path("zig/lib.zig"),
        .target = b.resolveTargetQuery(target_query),
        .optimize = optimize,
        .link_libc = true,
    });

    // --- Zig tests ---
    const test_mod = b.createModule(.{
        .root_source_file = b.path("zig/lib.zig"),
        .target = b.resolveTargetQuery(target_query),
        .optimize = optimize,
        .link_libc = true,
    });
    if (b.resolveTargetQuery(target_query).result.os.tag == .linux) {
        test_mod.linkSystemLibrary("util", .{});
    }
    const lib_tests = b.addTest(.{ .root_module = test_mod });
    const run_tests = b.addRunArtifact(lib_tests);
    const test_step = b.step("test", "Run Zig unit tests");
    test_step.dependOn(&run_tests.step);

    // --- NAPI shared library builds ---
    const clean = &b.addRemoveDirTree(.{ .cwd_relative = "prebuilds" }).step;

    if (target_query.isNative()) {
        addTarget(b, clean, b.resolveTargetQuery(target_query), optimize);
        for (cross_targets) |ct| {
            addTarget(b, clean, b.resolveTargetQuery(ct), optimize);
        }
    } else {
        addTarget(b, clean, b.resolveTargetQuery(target_query), optimize);
    }
}

fn addTarget(b: *std.Build, clean: *std.Build.Step, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) void {
    const is_windows = target.result.os.tag == .windows;

    const mod = b.createModule(.{
        .root_source_file = b.path("zig/root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = !is_windows,
    });

    // Link libutil for forkpty/openpty (glibc needs it, musl has it in libc)
    if (target.result.os.tag == .linux and target.result.abi != .musl and target.result.abi != .musleabi) {
        mod.linkSystemLibrary("util", .{});
    }

    // On Windows, generate NAPI import lib from .def file via dlltool
    if (is_windows) {
        const machine: []const u8 = switch (target.result.cpu.arch) {
            .x86_64 => "i386:x86-64",
            .aarch64 => "arm64",
            else => unreachable,
        };
        const dlltool = b.addSystemCommand(&.{
            "zig", "dlltool",
            "-d",  b.pathFromRoot("zig/win/node_api.def"),
            "-m",  machine,
            "-D",  "node.exe",
        });
        const import_lib = dlltool.addPrefixedOutputFileArg("-l", "node_api.lib");
        mod.addObjectFile(import_lib);
    }

    const lib = b.addLibrary(.{
        .name = "zigpty",
        .root_module = mod,
        .linkage = .dynamic,
    });

    // Allow undefined symbols (resolved by Node.js at runtime)
    lib.linker_allow_shlib_undefined = true;

    // Build platform-specific output name: zigpty.<os>-<arch>[-musl].node
    const os_name: []const u8 = switch (target.result.os.tag) {
        .linux => "linux",
        .macos => "darwin",
        .windows => "win32",
        else => @tagName(target.result.os.tag),
    };
    const arch_name: []const u8 = switch (target.result.cpu.arch) {
        .x86_64 => "x64",
        .aarch64 => "arm64",
        else => @tagName(target.result.cpu.arch),
    };
    const abi_suffix: []const u8 = switch (target.result.abi) {
        .musl, .musleabi => "-musl",
        else => "",
    };
    const dest_name = b.fmt("zigpty.{s}-{s}{s}.node", .{ os_name, arch_name, abi_suffix });

    const install = b.addInstallArtifact(lib, .{
        .dest_dir = .{ .override = .{ .custom = "" } },
        .dest_sub_path = dest_name,
    });
    install.step.dependOn(clean);
    b.getInstallStep().dependOn(&install.step);
}
