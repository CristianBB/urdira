import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

export type IndexingProcessKind = "daemon" | "typescript_checker" | "rust_syntax_worker";

export interface ProcessRssRecord {
  readonly pid: number;
  readonly parent_pid: number;
  readonly rss_bytes: number;
}

export interface ProcessTableRssSnapshot {
  readonly sampled_at_ms: number;
  readonly source: "procfs" | "ps" | "powershell_cim" | "test" | "unsupported";
  readonly complete: boolean;
  readonly processes: readonly ProcessRssRecord[];
  readonly failure?: string;
}

export interface ProcessTableRssSampler {
  readonly sample: (options?: { readonly fresh?: boolean }) => Promise<ProcessTableRssSnapshot>;
}

export interface IndexingProcessComponent {
  readonly component_id: string;
  readonly kind: IndexingProcessKind;
  readonly pid: number;
}

export interface ProcessComponentRssTelemetry extends IndexingProcessComponent {
  readonly present: boolean;
  readonly process_count: number;
  readonly rss_bytes: number;
}

export interface ProcessTreeRssTelemetry {
  readonly sampled_at_ms: number;
  readonly source: ProcessTableRssSnapshot["source"];
  readonly complete: boolean;
  readonly process_tree_rss_bytes: number;
  /** Highest complete observed tree RSS since construction or the last
   * explicit reset. Reservations are excluded from this measured peak. */
  readonly peak_process_tree_rss_bytes: number;
  readonly process_count: number;
  readonly reserved_rss_bytes: number;
  readonly requested_rss_bytes: number;
  readonly projected_rss_bytes: number;
  readonly ceiling_rss_bytes: number;
  readonly headroom_rss_bytes: number;
  readonly components: readonly ProcessComponentRssTelemetry[];
  readonly missing_component_ids: readonly string[];
  readonly failure?: string;
}

export interface ProcessTreeRssAdmissionRequest {
  readonly reservation_id: string;
  readonly estimated_additional_rss_bytes: number;
  readonly fresh_sample?: boolean;
}

export interface ProcessTreeRssReservation {
  readonly reservation_id: string;
  readonly reserved_rss_bytes: number;
  readonly release: () => void;
}

export interface ProcessTreeRssAdmissionDecision {
  readonly admitted: boolean;
  readonly reason: "admitted" | "sample_incomplete" | "ceiling_exceeded" | "reservation_conflict";
  readonly telemetry: ProcessTreeRssTelemetry;
  readonly reservation?: ProcessTreeRssReservation;
}

/** Narrow port consumed by indexing pools. The daemon scheduler and public
 * contracts intentionally do not know about process identifiers. */
export interface IndexingResourceAccountingPort {
  readonly admit: (request: ProcessTreeRssAdmissionRequest) => Promise<ProcessTreeRssAdmissionDecision>;
  readonly sampleTelemetry: (options?: { readonly fresh?: boolean }) => Promise<ProcessTreeRssTelemetry>;
}

export interface HostProcessTableRssSamplerOptions {
  readonly platform?: NodeJS.Platform;
  readonly min_interval_ms?: number;
  readonly now?: () => number;
  readonly list_proc_pids?: () => Promise<readonly number[]>;
  readonly read_text_file?: (path: string) => Promise<string>;
  readonly run_command?: (file: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly pid?: number }>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function command(file: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly pid?: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve({ stdout, ...(child.pid === undefined ? {} : { pid: child.pid }) });
    });
  });
}

function parsePositiveProcessNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeProcessNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseLinuxStatus(text: string): ProcessRssRecord | undefined {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const pid = parsePositiveProcessNumber(fields.get("Pid")?.split(/\s+/u)[0]);
  const parentPid = parseNonNegativeProcessNumber(fields.get("PPid")?.split(/\s+/u)[0]);
  const rssKib = parseNonNegativeProcessNumber(fields.get("VmRSS")?.match(/^\d+/u)?.[0]);
  if (pid === undefined || parentPid === undefined || rssKib === undefined) return undefined;
  return { pid, parent_pid: parentPid, rss_bytes: rssKib * 1024 };
}

function parsePosixPs(stdout: string): readonly ProcessRssRecord[] {
  const records: ProcessRssRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 3) continue;
    const pid = parsePositiveProcessNumber(fields[0]);
    const parentPid = parseNonNegativeProcessNumber(fields[1]);
    const rssKib = parseNonNegativeProcessNumber(fields[2]);
    if (pid !== undefined && parentPid !== undefined && rssKib !== undefined) records.push({ pid, parent_pid: parentPid, rss_bytes: rssKib * 1024 });
  }
  return records;
}

function parseWindowsCim(stdout: string): readonly ProcessRssRecord[] {
  const parsed: unknown = JSON.parse(stdout);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const records: ProcessRssRecord[] = [];
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const pid = parsePositiveProcessNumber(record["ProcessId"]);
    const parentPid = parseNonNegativeProcessNumber(record["ParentProcessId"]);
    const rssBytes = parseNonNegativeProcessNumber(record["WorkingSetSize"]);
    if (pid !== undefined && parentPid !== undefined && rssBytes !== undefined) records.push({ pid, parent_pid: parentPid, rss_bytes: rssBytes });
  }
  return records;
}

async function defaultProcPids(): Promise<readonly number[]> {
  return (await readdir("/proc"))
    .filter((name) => /^\d+$/u.test(name))
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function isDisappearedProcess(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");
}

/** Creates a cached process-table sampler. Linux stays entirely on procfs.
 * macOS and Windows have no Node process-table API, so their direct commands
 * are sampled outside the indexing hot loop and cached for the configured
 * interval; no command is ever passed through a shell. */
export function createHostProcessTableRssSampler(options: HostProcessTableRssSamplerOptions = {}): ProcessTableRssSampler {
  const platform = options.platform ?? process.platform;
  const minIntervalMs = options.min_interval_ms ?? 1_000;
  nonNegativeInteger(minIntervalMs, "Process RSS sample interval");
  const now = options.now ?? Date.now;
  const listProcPids = options.list_proc_pids ?? defaultProcPids;
  const readTextFile = options.read_text_file ?? ((path: string) => readFile(path, "utf8"));
  const runCommand = options.run_command ?? command;
  let cached: ProcessTableRssSnapshot | undefined;
  let inFlight: Promise<ProcessTableRssSnapshot> | undefined;

  const collect = async (): Promise<ProcessTableRssSnapshot> => {
    const sampledAt = now();
    if (platform === "linux") {
      try {
        const pids = await listProcPids();
        const processes: ProcessRssRecord[] = [];
        const failures: string[] = [];
        await Promise.all(pids.map(async (pid) => {
          try {
            const record = parseLinuxStatus(await readTextFile(`/proc/${pid}/status`));
            if (record === undefined) failures.push(String(pid));
            else processes.push(record);
          } catch (error) {
            if (!isDisappearedProcess(error)) failures.push(String(pid));
          }
        }));
        processes.sort((left, right) => left.pid - right.pid);
        return {
          sampled_at_ms: sampledAt,
          source: "procfs",
          complete: failures.length === 0 && processes.length > 0,
          processes,
          ...(failures.length === 0 && processes.length > 0 ? {} : { failure: `Unreadable procfs process records: ${failures.join(",") || "none"}.` }),
        };
      } catch (error) {
        return { sampled_at_ms: sampledAt, source: "procfs", complete: false, processes: [], failure: errorMessage(error) };
      }
    }
    if (platform === "darwin") {
      try {
        const result = await runCommand("ps", ["-axo", "pid=,ppid=,rss="]);
        const processes = parsePosixPs(result.stdout).filter((record) => record.pid !== result.pid);
        return { sampled_at_ms: sampledAt, source: "ps", complete: processes.length > 0, processes, ...(processes.length > 0 ? {} : { failure: "ps returned no process RSS records." }) };
      } catch (error) {
        return { sampled_at_ms: sampledAt, source: "ps", complete: false, processes: [], failure: errorMessage(error) };
      }
    }
    if (platform === "win32") {
      try {
        const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
        const result = await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
        const processes = parseWindowsCim(result.stdout).filter((record) => record.pid !== result.pid);
        return { sampled_at_ms: sampledAt, source: "powershell_cim", complete: processes.length > 0, processes, ...(processes.length > 0 ? {} : { failure: "CIM returned no process RSS records." }) };
      } catch (error) {
        return { sampled_at_ms: sampledAt, source: "powershell_cim", complete: false, processes: [], failure: errorMessage(error) };
      }
    }
    return { sampled_at_ms: sampledAt, source: "unsupported", complete: false, processes: [], failure: `Process-tree RSS sampling is unsupported on ${platform}.` };
  };

  return {
    async sample(sampleOptions = {}): Promise<ProcessTableRssSnapshot> {
      if (!sampleOptions.fresh && cached !== undefined && now() - cached.sampled_at_ms < minIntervalMs) return cached;
      if (inFlight !== undefined) return inFlight;
      inFlight = collect().then((value) => { cached = value; return value; }).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}

export interface WholeProcessTreeRssControllerOptions {
  readonly root_pid: number;
  readonly ceiling_rss_bytes: number;
  readonly sampler: ProcessTableRssSampler;
}

/** Owns process-tree RSS reservations for indexing. Registration is explicit
 * so unrelated host processes are never charged to a workspace, while every
 * registered supervised child remains mandatory for complete admission. */
export class WholeProcessTreeRssController implements IndexingResourceAccountingPort {
  private readonly rootPid: number;
  private readonly ceilingRssBytes: number;
  private readonly sampler: ProcessTableRssSampler;
  private readonly components = new Map<string, IndexingProcessComponent>();
  private readonly reservations = new Map<string, number>();
  private lockTail = Promise.resolve();
  private peakProcessTreeRssBytes = 0;

  constructor(options: WholeProcessTreeRssControllerOptions) {
    this.rootPid = positiveInteger(options.root_pid, "Process-tree root PID");
    this.ceilingRssBytes = positiveInteger(options.ceiling_rss_bytes, "Process-tree RSS ceiling");
    this.sampler = options.sampler;
  }

  registerComponent(component: IndexingProcessComponent): () => void {
    if (component.component_id.length === 0 || component.component_id === "daemon") throw new Error("Indexing process component ID is invalid.");
    if (component.kind === "daemon") throw new Error("The daemon component is owned by the process-tree controller.");
    positiveInteger(component.pid, "Indexing component PID");
    if (this.components.has(component.component_id)) throw new Error(`Indexing process component ${component.component_id} is already registered.`);
    this.components.set(component.component_id, component);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.components.get(component.component_id) === component) this.components.delete(component.component_id);
    };
  }

  async sampleTelemetry(options: { readonly fresh?: boolean } = {}): Promise<ProcessTreeRssTelemetry> {
    return this.telemetry(await this.sampler.sample(options), 0);
  }

  resetPeakTelemetry(): void {
    this.peakProcessTreeRssBytes = 0;
  }

  async admit(request: ProcessTreeRssAdmissionRequest): Promise<ProcessTreeRssAdmissionDecision> {
    if (request.reservation_id.length === 0) throw new Error("Process-tree RSS reservation ID is required.");
    nonNegativeInteger(request.estimated_additional_rss_bytes, "Estimated additional RSS");
    return this.withLock(async () => {
      const conflict = this.reservations.has(request.reservation_id);
      const telemetry = this.telemetry(await this.sampler.sample(request.fresh_sample === undefined ? {} : { fresh: request.fresh_sample }), request.estimated_additional_rss_bytes);
      if (conflict) return { admitted: false, reason: "reservation_conflict", telemetry };
      if (!telemetry.complete) return { admitted: false, reason: "sample_incomplete", telemetry };
      if (telemetry.projected_rss_bytes > this.ceilingRssBytes) return { admitted: false, reason: "ceiling_exceeded", telemetry };
      this.reservations.set(request.reservation_id, request.estimated_additional_rss_bytes);
      let reserved = true;
      const reservation: ProcessTreeRssReservation = {
        reservation_id: request.reservation_id,
        reserved_rss_bytes: request.estimated_additional_rss_bytes,
        release: () => {
          if (!reserved) return;
          reserved = false;
          this.reservations.delete(request.reservation_id);
        },
      };
      return { admitted: true, reason: "admitted", telemetry, reservation };
    });
  }

  private telemetry(snapshot: ProcessTableRssSnapshot, requestedRssBytes: number): ProcessTreeRssTelemetry {
    const byPid = new Map(snapshot.processes.map((record) => [record.pid, record]));
    const children = new Map<number, number[]>();
    for (const record of snapshot.processes) {
      const values = children.get(record.parent_pid) ?? [];
      values.push(record.pid);
      children.set(record.parent_pid, values);
    }
    const descendants = (rootPid: number): Set<number> => {
      if (!byPid.has(rootPid)) return new Set();
      const found = new Set<number>();
      const pending = [rootPid];
      while (pending.length > 0) {
        const pid = pending.pop()!;
        if (found.has(pid)) continue;
        found.add(pid);
        for (const childPid of children.get(pid) ?? []) pending.push(childPid);
      }
      return found;
    };
    const roots: readonly IndexingProcessComponent[] = [
      { component_id: "daemon", kind: "daemon", pid: this.rootPid },
      ...this.components.values(),
    ];
    const allPids = new Set<number>();
    const missingComponentIds: string[] = [];
    const componentTelemetry = roots.map((root): ProcessComponentRssTelemetry => {
      const pids = descendants(root.pid);
      if (pids.size === 0) missingComponentIds.push(root.component_id);
      for (const pid of pids) allPids.add(pid);
      return {
        ...root,
        present: pids.size > 0,
        process_count: pids.size,
        rss_bytes: [...pids].reduce((total, pid) => total + (byPid.get(pid)?.rss_bytes ?? 0), 0),
      };
    });
    const processTreeRssBytes = [...allPids].reduce((total, pid) => total + (byPid.get(pid)?.rss_bytes ?? 0), 0);
    const reservedRssBytes = [...this.reservations.values()].reduce((total, value) => total + value, 0);
    const projectedRssBytes = processTreeRssBytes + reservedRssBytes + requestedRssBytes;
    const complete = snapshot.complete && missingComponentIds.length === 0;
    if (complete) this.peakProcessTreeRssBytes = Math.max(this.peakProcessTreeRssBytes, processTreeRssBytes);
    const missingFailure = missingComponentIds.length > 0 ? `Registered process components are missing from the sample: ${missingComponentIds.join(", ")}.` : undefined;
    return {
      sampled_at_ms: snapshot.sampled_at_ms,
      source: snapshot.source,
      complete,
      process_tree_rss_bytes: processTreeRssBytes,
      peak_process_tree_rss_bytes: this.peakProcessTreeRssBytes,
      process_count: allPids.size,
      reserved_rss_bytes: reservedRssBytes,
      requested_rss_bytes: requestedRssBytes,
      projected_rss_bytes: projectedRssBytes,
      ceiling_rss_bytes: this.ceilingRssBytes,
      headroom_rss_bytes: Math.max(0, this.ceilingRssBytes - projectedRssBytes),
      components: componentTelemetry,
      missing_component_ids: missingComponentIds,
      ...((snapshot.failure ?? missingFailure) === undefined ? {} : { failure: [snapshot.failure, missingFailure].filter(Boolean).join(" ") }),
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}
