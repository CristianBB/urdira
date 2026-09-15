import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const COUNTER_FIELDS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const counterProjection = (usage) => Object.fromEntries(COUNTER_FIELDS.map((field) => [field, finite(usage?.[field])]));
const completeCounters = (usage) => COUNTER_FIELDS.every((field) => finite(usage?.[field]) !== null);
const sameCounters = (left, right) => completeCounters(left) && completeCounters(right)
  && COUNTER_FIELDS.every((field) => finite(left[field]) === finite(right[field]));
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))];

/**
 * Bind Codex transcript turn usage to the retained host session's explicit
 * cumulative counters. This deliberately compares labeled host fields; it
 * never infers semantics from monotonic values or the CLI version alone.
 */
export function deriveHostTokenEvidence({ transcriptPath, transcriptEvents, hostSessionPaths = [] } = {}) {
  const errors = [];
  const transcriptBytes = transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath) : null;
  let events = transcriptEvents;
  if (!events && transcriptBytes !== null) {
    events = [];
    for (const [index, line] of transcriptBytes.toString("utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try { events.push({ ...JSON.parse(line), __line: index + 1 }); }
      catch { errors.push(`transcript malformed JSON at line ${index + 1}`); }
    }
  }
  const transcriptThreadIds = unique((events ?? []).flatMap((event) => [event?.thread_id, event?.thread?.id]));
  const transcriptSessionIds = unique((events ?? []).flatMap((event) => [event?.session_id, event?.session?.id]));
  const transcriptTurns = (events ?? []).flatMap((event, index) => event?.type === "turn.completed" && event.usage && typeof event.usage === "object"
    ? [{ usage: event.usage, line: event.__line ?? index + 1, root_turn_id: event.root_turn_id ?? event.turn_id ?? null }]
    : []);
  const sessionInputs = hostSessionPaths.map((entry) => typeof entry === "string" ? { path: entry } : entry).filter((entry) => entry?.path);
  const hostSessions = [];
  const records = [];
  const tokenEvents = [];
  const contextTurns = [];
  const seenResponseIds = new Map();
  const seenTokenEvents = new Set();
  let duplicateTokenUsageRecords = 0;
  for (const input of sessionInputs) {
    if (!existsSync(input.path)) { errors.push(`host session missing: ${input.path}`); continue; }
    const bytes = readFileSync(input.path);
    const lines = bytes.toString("utf8").split("\n");
    const cliVersions = [];
    const sessionIds = [];
    let malformedLines = 0;
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { malformedLines++; continue; }
      const payload = event?.payload ?? {};
      if (event?.type === "session_meta" && typeof payload.cli_version === "string") cliVersions.push(payload.cli_version);
      if (event?.type === "session_meta" && payload.session_id) sessionIds.push(payload.session_id);
      if (event?.type === "turn_context" && payload.root_turn_id) contextTurns.push({ root_turn_id: payload.root_turn_id, line: index + 1, path: input.path });
      if (event?.type === "token_usage_record") {
        if (payload.root_turn_id === undefined || payload.root_turn_id === null) errors.push("token_usage_record is missing root_turn_id");
        const rootTurnId = payload.root_turn_id ?? null;
        const responseId = payload.response_id ?? `${rootTurnId}:${JSON.stringify(payload.usage ?? {})}`;
        const prior = seenResponseIds.get(responseId);
        if (prior) {
          duplicateTokenUsageRecords++;
          if (JSON.stringify(prior.payload) !== JSON.stringify(payload)) errors.push(`conflicting duplicate token_usage_record: ${responseId}`);
          continue;
        }
        seenResponseIds.set(responseId, { payload, line: index + 1, path: input.path });
        records.push({
          root_turn_id: rootTurnId,
          thread_id: payload.thread_id ?? null,
          session_id: payload.session_id ?? null,
          turn_token_usage: payload.turn_token_usage,
          thread_token_usage: payload.thread_token_usage,
          line: index + 1,
          path: input.path,
        });
      }
      if (event?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
        const total = payload.info.total_token_usage;
        const last = payload.info.last_token_usage;
        const key = JSON.stringify([counterProjection(total), counterProjection(last)]);
        if (!seenTokenEvents.has(key)) {
          seenTokenEvents.add(key);
          tokenEvents.push({ total, last, line: index + 1, path: input.path });
        }
      }
    }
    hostSessions.push({
      path: input.path,
      sha256: digest(bytes),
      provided_sha256: input.sha256 ?? null,
      provided_sha256_match: input.sha256 === undefined ? null : input.sha256 === digest(bytes),
      line_count: lines.length - (lines.at(-1) === "" ? 1 : 0),
      cli_versions: unique(cliVersions),
      session_ids: unique(sessionIds),
      malformed_lines: malformedLines,
    });
  }
  if (hostSessions.some((session) => session.provided_sha256_match === false)) errors.push("host session hash does not match association evidence");
  const evaluate = (candidateRecords, candidateContexts) => {
    const rootIds = unique(candidateRecords.map((record) => record.root_turn_id));
    const contextRootIds = unique(candidateContexts.map((turn) => turn.root_turn_id));
    const contextOrderMatches = contextRootIds.length === 0 || JSON.stringify(contextRootIds) === JSON.stringify(rootIds);
    const finalRecords = rootIds.map((rootTurnId) => candidateRecords.filter((record) => record.root_turn_id === rootTurnId).at(-1));
    const perTurn = transcriptTurns.length === finalRecords.length && finalRecords.every((record, index) => sameCounters(transcriptTurns[index]?.usage, record?.turn_token_usage));
    const cumulative = transcriptTurns.length === finalRecords.length && finalRecords.every((record, index) => sameCounters(transcriptTurns[index]?.usage, record?.thread_token_usage));
    const sources = [perTurn ? "turn_token_usage" : null, cumulative ? "thread_token_usage" : null].filter(Boolean);
    return { candidateRecords, rootIds, contextRootIds, contextOrderMatches, finalRecords, perTurn, cumulative, sources };
  };
  const completeCandidateMatches = hostSessions.map((session) => {
    const candidateRecords = records.filter((record) => record.path === session.path);
    const candidateContexts = contextTurns.filter((turn) => turn.path === session.path);
    return { session, ...evaluate(candidateRecords, candidateContexts) };
  }).filter((candidate) => candidate.rootIds.length === transcriptTurns.length && candidate.contextOrderMatches && candidate.sources.length === 1);
  // Repeated references to the same retained bytes are an explicit duplicate,
  // while distinct complete sessions are ambiguous evidence and must fail
  // closed. The hash/root/source key makes the allowed dedupe auditable.
  const completeCandidateKeys = new Set();
  const completeCandidates = completeCandidateMatches.filter((candidate) => {
    const key = JSON.stringify([candidate.session.sha256, candidate.rootIds, candidate.sources]);
    if (completeCandidateKeys.has(key)) return false;
    completeCandidateKeys.add(key);
    return true;
  });
  if (completeCandidates.length > 1) errors.push("multiple complete host sessions match the transcript");
  const selectedCandidate = completeCandidates.length === 1
    ? completeCandidates[0]
    : { ...evaluate(records, contextTurns), session: null };
  const { rootIds: rootTurnIds, contextOrderMatches, finalRecords: finalByRoot, perTurn: perTurnMatch, cumulative: cumulativeMatch, sources: matchingSources } = selectedCandidate;
  const ignoredHostSessions = completeCandidates.length === 1
    ? hostSessions.filter((session) => session.path !== selectedCandidate.session.path).map((session) => ({ path: session.path, reason: "incomplete_or_nonmatching_session" }))
    : [];
  if (!contextOrderMatches) errors.push("turn_context root order does not match token usage record root order");
  if (transcriptTurns.length !== rootTurnIds.length) errors.push(`transcript turn count ${transcriptTurns.length} does not match host root turn count ${rootTurnIds.length}`);
  const transcriptRootTurnIds = transcriptTurns.map((turn) => turn.root_turn_id).filter(Boolean);
  if (transcriptRootTurnIds.length === transcriptTurns.length && JSON.stringify(transcriptRootTurnIds) !== JSON.stringify(rootTurnIds)) errors.push("transcript root turn order does not match host root turn order");
  const selectedRecords = selectedCandidate.candidateRecords ?? records;
  const selectedSessionPaths = selectedCandidate.session === null ? null : new Set([selectedCandidate.session.path]);
  const hostThreadIds = unique(selectedRecords.map((record) => record.thread_id));
  const hostSessionIds = unique(selectedRecords.map((record) => record.session_id).concat(hostSessions.filter((session) => selectedSessionPaths === null || selectedSessionPaths.has(session.path)).flatMap((session) => session.session_ids ?? [])));
  if (transcriptThreadIds.length > 0 && JSON.stringify(transcriptThreadIds) !== JSON.stringify(hostThreadIds)) errors.push("transcript thread identity does not match host session");
  if (transcriptSessionIds.length > 0 && JSON.stringify(transcriptSessionIds) !== JSON.stringify(hostSessionIds)) errors.push("transcript session identity does not match host session");
  if (matchingSources.length !== 1) errors.push(matchingSources.length === 0 ? "transcript usage matches neither labeled host counter" : "transcript usage matches both labeled host counters");
  const status = sessionInputs.length === 0 || hostSessions.length === 0
    ? "missing_host"
    : errors.length > 0 || matchingSources.length !== 1
      ? "mismatch"
      : "matched";
  const source = {
    kind: "codex_host_session",
    host_sessions: hostSessions,
    cli_versions: unique(hostSessions.flatMap((session) => session.cli_versions)),
    turn_context_refs: contextTurns.filter(({ path }) => selectedCandidate.session === null || path === selectedCandidate.session.path).map(({ root_turn_id, line, path }) => ({ root_turn_id, line, path })),
    record_refs: finalByRoot.map((record, index) => ({ root_turn_id: rootTurnIds[index], line: record?.line ?? null, path: record?.path ?? null })),
    token_count_refs: tokenEvents.filter(({ path }) => selectedCandidate.session === null || path === selectedCandidate.session.path).map(({ line, path }) => ({ line, path })),
    token_usage_record_count: finalByRoot.filter(Boolean).length,
    token_count_event_count: tokenEvents.filter(({ path }) => selectedCandidate.session === null || path === selectedCandidate.session.path).length,
    duplicate_token_usage_records: duplicateTokenUsageRecords,
    ignored_host_sessions: ignoredHostSessions,
  };
  return {
    status,
    counter_mode: status === "matched" ? (perTurnMatch ? "per_turn" : "cumulative") : null,
    root_turn_ids: rootTurnIds,
    transcript_turn_refs: transcriptTurns.map(({ line, root_turn_id }) => ({ line, root_turn_id })),
    transcript_sha256: transcriptBytes === null ? null : digest(transcriptBytes),
    match: {
      source: status === "matched" ? matchingSources[0] : null,
      version_only: false,
      transcript_turn_count: transcriptTurns.length,
      host_root_turn_count: rootTurnIds.length,
      per_turn: perTurnMatch,
      cumulative: cumulativeMatch,
    },
    source,
    errors,
  };
}
