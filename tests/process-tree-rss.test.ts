import { describe, expect, it, vi } from "vitest";
import {
  WholeProcessTreeRssController,
  createHostProcessTableRssSampler,
  type ProcessTableRssSnapshot,
} from "../apps/urdira/src/process-tree-rss.js";

function snapshot(
  processes: ProcessTableRssSnapshot["processes"],
  complete = true,
): ProcessTableRssSnapshot {
  return {
    sampled_at_ms: 1_000,
    source: "test",
    complete,
    processes,
    ...(complete ? {} : { failure: "synthetic incomplete process table" }),
  };
}

describe("WholeProcessTreeRssController", () => {
  it("accounts the daemon, TypeScript checker, and Rust worker exactly once", async () => {
    const controller = new WholeProcessTreeRssController({
      root_pid: 10,
      ceiling_rss_bytes: 1_000,
      sampler: {
        sample: async () => snapshot([
          { pid: 10, parent_pid: 1, rss_bytes: 100 },
          { pid: 20, parent_pid: 10, rss_bytes: 200 },
          { pid: 30, parent_pid: 20, rss_bytes: 300 },
          { pid: 40, parent_pid: 10, rss_bytes: 50 },
          { pid: 99, parent_pid: 1, rss_bytes: 900 },
        ]),
      },
    });
    controller.registerComponent({ component_id: "checker:a", kind: "typescript_checker", pid: 20 });
    controller.registerComponent({ component_id: "syntax:a", kind: "rust_syntax_worker", pid: 30 });

    const telemetry = await controller.sampleTelemetry();
    expect(telemetry.complete).toBe(true);
    expect(telemetry.process_tree_rss_bytes).toBe(650);
    expect(telemetry.peak_process_tree_rss_bytes).toBe(650);
    expect(telemetry.process_count).toBe(4);
    expect(telemetry.components).toEqual([
      { component_id: "daemon", kind: "daemon", pid: 10, present: true, process_count: 4, rss_bytes: 650 },
      { component_id: "checker:a", kind: "typescript_checker", pid: 20, present: true, process_count: 2, rss_bytes: 500 },
      { component_id: "syntax:a", kind: "rust_syntax_worker", pid: 30, present: true, process_count: 1, rss_bytes: 300 },
    ]);
  });

  it("fails admission conservatively when a registered child cannot be sampled", async () => {
    const controller = new WholeProcessTreeRssController({
      root_pid: 10,
      ceiling_rss_bytes: 10_000,
      sampler: { sample: async () => snapshot([{ pid: 10, parent_pid: 1, rss_bytes: 100 }]) },
    });
    controller.registerComponent({ component_id: "checker:a", kind: "typescript_checker", pid: 20 });

    const decision = await controller.admit({ reservation_id: "scan:a", estimated_additional_rss_bytes: 100 });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("sample_incomplete");
    expect(decision.telemetry.complete).toBe(false);
    expect(decision.telemetry.missing_component_ids).toEqual(["checker:a"]);
  });

  it("serializes reservations so concurrent admissions cannot overcommit the ceiling", async () => {
    const controller = new WholeProcessTreeRssController({
      root_pid: 10,
      ceiling_rss_bytes: 1_000,
      sampler: { sample: async () => snapshot([{ pid: 10, parent_pid: 1, rss_bytes: 600 }]) },
    });

    const [first, second] = await Promise.all([
      controller.admit({ reservation_id: "scan:a", estimated_additional_rss_bytes: 300 }),
      controller.admit({ reservation_id: "scan:b", estimated_additional_rss_bytes: 300 }),
    ]);
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("ceiling_exceeded");
    expect(second.telemetry.projected_rss_bytes).toBe(1_200);
    first.reservation?.release();
    const retry = await controller.admit({ reservation_id: "scan:b", estimated_additional_rss_bytes: 300 });
    expect(retry.admitted).toBe(true);
    retry.reservation?.release();
  });
});

describe("createHostProcessTableRssSampler", () => {
  it("reads Linux process status from procfs without invoking a command", async () => {
    const runCommand = vi.fn();
    const files = new Map([
      ["/proc/10/status", "Name:\turdira\nPid:\t10\nPPid:\t1\nVmRSS:\t100 kB\n"],
      ["/proc/20/status", "Name:\tnode\nPid:\t20\nPPid:\t10\nVmRSS:\t200 kB\n"],
    ]);
    const sampler = createHostProcessTableRssSampler({
      platform: "linux",
      now: () => 1_000,
      list_proc_pids: async () => [10, 20],
      read_text_file: async (path) => files.get(path)!,
      run_command: runCommand,
    });

    await expect(sampler.sample()).resolves.toMatchObject({
      complete: true,
      source: "procfs",
      processes: [
        { pid: 10, parent_pid: 1, rss_bytes: 102_400 },
        { pid: 20, parent_pid: 10, rss_bytes: 204_800 },
      ],
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("uses direct cached host commands on macOS and Windows", async () => {
    let now = 1_000;
    const darwinCommand = vi.fn(async () => ({ stdout: " 10 1 100\n 20 10 200\n" }));
    const darwin = createHostProcessTableRssSampler({ platform: "darwin", now: () => now, min_interval_ms: 1_000, run_command: darwinCommand });
    expect((await darwin.sample()).processes[1]).toEqual({ pid: 20, parent_pid: 10, rss_bytes: 204_800 });
    now = 1_500;
    await darwin.sample();
    expect(darwinCommand).toHaveBeenCalledTimes(1);
    now = 2_100;
    await darwin.sample({ fresh: true });
    expect(darwinCommand).toHaveBeenCalledTimes(2);

    const windowsCommand = vi.fn(async (_file: string, _args: readonly string[]) => ({ stdout: JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: "100" },
      { ProcessId: 20, ParentProcessId: 10, WorkingSetSize: "200" },
    ]) }));
    const windows = createHostProcessTableRssSampler({ platform: "win32", run_command: windowsCommand });
    expect(await windows.sample()).toMatchObject({
      complete: true,
      source: "powershell_cim",
      processes: [
        { pid: 10, parent_pid: 1, rss_bytes: 100 },
        { pid: 20, parent_pid: 10, rss_bytes: 200 },
      ],
    });
    expect(windowsCommand.mock.calls[0]?.[0]).toBe("powershell.exe");
  });

  it("returns an incomplete snapshot instead of guessing after a host sampling failure", async () => {
    const sampler = createHostProcessTableRssSampler({
      platform: "darwin",
      run_command: async () => { throw new Error("ps unavailable"); },
    });
    await expect(sampler.sample()).resolves.toMatchObject({ complete: false, source: "ps", processes: [] });
  });
});
