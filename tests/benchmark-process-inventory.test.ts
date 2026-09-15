import { describe, expect, it } from "vitest";

import { inspectProcessInventory, isProcessInventoryProbe, verifiedOwnedProcesses } from "../release/benchmarks/benchmark-process-inventory.mjs";

describe("benchmark process inventory", () => {
  it("uses one deterministic ownership and ancestry policy for runner and readiness", () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10, user: "root", command: "node supervisor" },
      { pid: 11, ppid: 10, pgid: 10, user: "root", command: "node /cell/worker" },
      { pid: 12, ppid: 1, pgid: 12, user: "root", command: "node /cell/orphan" },
      { pid: 13, ppid: 10, pgid: 10, user: "other", command: "node /cell/foreign" },
      { pid: 14, ppid: 10, pgid: 10, user: "root", command: "ps -axo pid=,ppid=,pgid=,user=,command=" },
    ];
    const entries = inspectProcessInventory(["/cell"], table, { currentPid: 10, fallbackUser: "Cristian" });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 11, owner_verified: true, parent_chain_verified: true, owned_by_cell: true }),
      expect.objectContaining({ pid: 12, owner_verified: true, parent_chain_verified: false, owned_by_cell: false }),
      expect.objectContaining({ pid: 13, owner_verified: false, parent_chain_verified: true, owned_by_cell: false }),
    ]));
    expect(entries.some((entry) => entry.pid === 14)).toBe(false);
    expect(verifiedOwnedProcesses(entries).map((entry) => entry.pid)).toEqual([11]);
    expect(isProcessInventoryProbe("ps -axo pid=,ppid=,pgid=,user=,command=")).toBe(true);
  });
});
