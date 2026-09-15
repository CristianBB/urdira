import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";

export function isProcessInventoryProbe(command) {
  return typeof command === "string" && /^ps\s+-axo\s+pid=,ppid=,pgid=,user=,command=/u.test(command.trim());
}

export function parseProcessTable(output) {
  return String(output ?? "").split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u)).filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), user: match[4], command: match[5] }));
}

export function processTable() {
  const listing = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,user=,command="], { encoding: "utf8" });
  if (listing.status !== 0) return [];
  return parseProcessTable(listing.stdout);
}

export function effectiveProcessOwner(table, currentPid = process.pid, fallback = userInfo().username) {
  return table.find((entry) => entry.pid === currentPid)?.user ?? fallback;
}

export function inspectProcessInventory(roots, table = processTable(), { currentPid = process.pid, fallbackUser = userInfo().username } = {}) {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const owner = effectiveProcessOwner(table, currentPid, fallbackUser);
  const parentChain = (pid) => {
    const seen = new Set();
    let current = byPid.get(pid);
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (current.pid === currentPid) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  return table.filter((entry) => entry.pid !== currentPid && !isProcessInventoryProbe(entry.command) && (roots.some((path) => entry.command.includes(path)) || parentChain(entry.pid))).map((entry) => {
    const parent_chain_verified = parentChain(entry.pid);
    const owner_verified = entry.user === owner;
    return { ...entry, owner_verified, parent_chain_verified, owned_by_cell: owner_verified && parent_chain_verified };
  });
}

export function verifiedOwnedProcesses(entries) {
  return entries.filter((entry) => entry.owner_verified && entry.parent_chain_verified);
}
