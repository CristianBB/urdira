import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveHostTokenEvidence } from "../release/benchmarks/benchmark-token-evidence.mjs";

const counters = (input_tokens: number, output_tokens: number, reasoning_output_tokens: number, cached_input_tokens = 0) => ({
  input_tokens,
  cached_input_tokens,
  output_tokens,
  reasoning_output_tokens,
  total_tokens: input_tokens + output_tokens + reasoning_output_tokens,
});

type CounterUsage = ReturnType<typeof counters>;
type TranscriptEvent = { type: string; thread_id?: string; usage?: CounterUsage };
type HostEvent =
  | { type: "session_meta"; payload: { cli_version: string; session_id: string } }
  | { type: "turn_context"; payload: { turn_id: string; root_turn_id: string } }
  | { type: "token_usage_record"; payload: { thread_id: string; session_id: string; turn_id: string; root_turn_id?: string; response_id: string; usage: CounterUsage; turn_token_usage: CounterUsage; thread_token_usage: CounterUsage } }
  | { type: "event_msg"; payload: { type: "token_count"; info: { total_token_usage: CounterUsage; last_token_usage: CounterUsage } } };
type TokenEvidence = {
  status: string;
  counter_mode: string | null;
  root_turn_ids: string[];
  match: { source: string | null; version_only: boolean };
  errors: string[];
  source: {
    host_sessions: Array<{ path: string }>;
    token_usage_record_count: number;
    token_count_event_count: number;
    duplicate_token_usage_records: number;
    ignored_host_sessions: Array<{ path: string; reason: string }>;
    record_refs: Array<{ line: number }>;
  };
};
const evidenceOf = (value: unknown) => value as TokenEvidence;

const makeFixture = async ({ cumulativeTranscript = false, duplicateFirstRecord = false, hostCliVersion = "0.154.0-alpha.6.2", mismatch = false, transcriptThreadId = "thread-1", omitRootTurnId = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "urdira-token-evidence-"));
  const transcriptPath = join(root, "transcript.jsonl");
  const hostPath = join(root, "host.jsonl");
  const perTurn = [counters(10, 2, 1, 4), counters(20, 3, 1, 8), counters(30, 4, 2, 12)];
  const cumulative = perTurn.map((_, index) => counters(
    perTurn.slice(0, index + 1).reduce((sum, usage) => sum + usage.input_tokens, 0),
    perTurn.slice(0, index + 1).reduce((sum, usage) => sum + usage.output_tokens, 0),
    perTurn.slice(0, index + 1).reduce((sum, usage) => sum + usage.reasoning_output_tokens, 0),
    perTurn.slice(0, index + 1).reduce((sum, usage) => sum + usage.cached_input_tokens, 0),
  ));
  const roots = ["root-1", "root-2", "root-3"];
  const transcriptUsages = cumulativeTranscript ? cumulative : perTurn;
  const transcript: TranscriptEvent[] = [
    { type: "thread.started", thread_id: transcriptThreadId },
    ...transcriptUsages.flatMap((usage) => [{ type: "turn.started" }, { type: "turn.completed", usage }]),
  ];
  const host: HostEvent[] = [{ type: "session_meta", payload: { cli_version: hostCliVersion, session_id: "session-1" } }];
  roots.forEach((rootTurnId, index) => {
    const thread = cumulative[index]!;
    const turn = perTurn[index]!;
    host.push({ type: "turn_context", payload: { turn_id: rootTurnId, root_turn_id: rootTurnId } });
    const record: HostEvent = {
      type: "token_usage_record",
      payload: {
        thread_id: "thread-1",
        session_id: "session-1",
        turn_id: rootTurnId,
        ...(omitRootTurnId ? {} : { root_turn_id: rootTurnId }),
        response_id: `response-${index}`,
        usage: turn,
        turn_token_usage: turn,
        thread_token_usage: thread,
      },
    };
    host.push(record);
    if (duplicateFirstRecord && index === 0) host.push(structuredClone(record));
    host.push({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: thread, last_token_usage: turn } } });
  });
  if (mismatch) {
    const last = transcript.at(-1);
    if (last === undefined) throw new Error("fixture transcript unexpectedly empty");
    last.usage = counters(999, 3, 2, 1);
  }
  await writeFile(transcriptPath, `${transcript.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await writeFile(hostPath, `${host.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return { transcriptPath, hostPath, hostSessionPaths: [hostPath], transcript, host };
};

describe("benchmark host token evidence", () => {
  it("matches per-turn transcript usage against ordered host root turns", async () => {
    const fixture = await makeFixture({ hostCliVersion: "0.153.4" });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBe("per_turn");
    expect(evidence.match.source).toBe("turn_token_usage");
    expect(evidence.root_turn_ids).toEqual(["root-1", "root-2", "root-3"]);
    expect(evidence.source.token_usage_record_count).toBe(3);
    expect(evidence.source.token_count_event_count).toBe(3);
  });

  it("matches cumulative transcript usage against host thread totals", async () => {
    const fixture = await makeFixture({ cumulativeTranscript: true });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBe("cumulative");
    expect(evidence.match.source).toBe("thread_token_usage");
  });

  it("returns null mode when host evidence is absent", async () => {
    const fixture = await makeFixture();
    const evidence = evidenceOf(await deriveHostTokenEvidence({ transcriptPath: fixture.transcriptPath, hostSessionPaths: [] }));
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.status).toBe("missing_host");
  });

  it("rejects a transcript and host mismatch", async () => {
    const fixture = await makeFixture({ mismatch: true });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.status).toBe("mismatch");
  });

  it("does not authorize semantics from cli version alone", async () => {
    const fixture = await makeFixture({ hostCliVersion: "0.153.4", mismatch: true });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.match.version_only).toBe(false);
  });

  it("binds transcript thread identity when it is present", async () => {
    const fixture = await makeFixture({ transcriptThreadId: "other-thread" });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.status).toBe("mismatch");
    expect(evidence.errors).toContain("transcript thread identity does not match host session");
  });

  it("rejects host usage records without an explicit root turn id", async () => {
    const fixture = await makeFixture({ omitRootTurnId: true });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.status).toBe("mismatch");
    expect(evidence.errors).toContain("token_usage_record is missing root_turn_id");
  });

  it("deduplicates repeated response records without changing counts", async () => {
    const fixture = await makeFixture({ duplicateFirstRecord: true });
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.counter_mode).toBe("per_turn");
    expect(evidence.source.token_usage_record_count).toBe(3);
    expect(evidence.source.duplicate_token_usage_records).toBe(1);
  });

  it("selects the complete matching host session when a retained directory has an unrelated fragment", async () => {
    const fixture = await makeFixture();
    const fragmentPath = join(await mkdtemp(join(tmpdir(), "urdira-token-evidence-fragment-")), "fragment.jsonl");
    await writeFile(fragmentPath, `${fixture.host.slice(0, 2).map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const evidence = evidenceOf(await deriveHostTokenEvidence({ transcriptPath: fixture.transcriptPath, hostSessionPaths: [fixture.hostPath, fragmentPath] }));
    expect(evidence.counter_mode).toBe("per_turn");
    expect(evidence.source.host_sessions).toHaveLength(2);
    expect(evidence.source.ignored_host_sessions).toEqual(expect.arrayContaining([expect.objectContaining({ path: fragmentPath, reason: "incomplete_or_nonmatching_session" })]));
  });

  it("fails closed when two complete host sessions match the same transcript", async () => {
    const fixture = await makeFixture();
    const secondRoot = await mkdtemp(join(tmpdir(), "urdira-token-evidence-second-session-"));
    const secondPath = join(secondRoot, "host.jsonl");
    const second = fixture.host.map((event) => event.type === "token_usage_record"
      ? { ...event, payload: { ...event.payload, session_id: "session-2", response_id: `${event.payload.response_id}-second` } }
      : event.type === "session_meta"
        ? { ...event, payload: { ...event.payload, session_id: "session-2" } }
        : event);
    await writeFile(secondPath, `${second.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const evidence = evidenceOf(await deriveHostTokenEvidence({ transcriptPath: fixture.transcriptPath, hostSessionPaths: [fixture.hostPath, secondPath] }));
    expect(evidence.status).toBe("mismatch");
    expect(evidence.counter_mode).toBeNull();
    expect(evidence.errors).toContain("multiple complete host sessions match the transcript");
  });

  it("retains source hashes and line references without source contents", async () => {
    const fixture = await makeFixture();
    const evidence = evidenceOf(await deriveHostTokenEvidence(fixture));
    expect(evidence.source.host_sessions[0]).toMatchObject({ path: fixture.hostPath, sha256: createHash("sha256").update(await (await import("node:fs/promises")).readFile(fixture.hostPath)).digest("hex") });
    expect(evidence.source.record_refs.every((ref: { line: number }) => Number.isInteger(ref.line))).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("response-");
  });
});
