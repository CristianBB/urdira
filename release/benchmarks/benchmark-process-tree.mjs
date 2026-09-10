import { spawnSync } from "node:child_process";

export function sampleProcessTree(rootPid) {
  const ps = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,pcpu="], { encoding: "utf8" });
  if (ps.status !== 0) return null;
  const rows = (ps.stdout ?? "").split("\n").flatMap((line) => {
    const [pid, ppid, rss, cpu] = line.trim().split(/\s+/u).map(Number);
    return [pid, ppid, rss, cpu].every(Number.isFinite) ? [{ pid, ppid, rss, cpu }] : [];
  });
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
    }
  }
  const tree = rows.filter((row) => included.has(row.pid));
  return {
    rss_kib: tree.reduce((sum, row) => sum + row.rss, 0),
    cpu_percent: tree.reduce((sum, row) => sum + row.cpu, 0),
    process_count: tree.length,
  };
}
