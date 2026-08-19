import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";
import { canonicalBytes, digestBytes } from "@urdira/canonical";
import { afterEach, describe, expect, it } from "vitest";
import type {
  JsonValue,
  SourceProviderRequestEnvelope,
  SourceProviderResponseEnvelope,
} from "@urdira/contracts";
import {
  DirectorySourceProvider,
  GitReferenceSourceProvider,
  GitWorktreeSourceProvider,
  ISOMORPHIC_GIT_OBJECT_PORT,
  NODE_DIRECTORY_FILE_SYSTEM,
  type DirectoryFileSystem,
  type GitObjectPort,
  type ProviderObservation,
} from "../packages/engine/src/index.js";

const temporaryRoots: string[] = [];
const instant = "2026-08-09T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "urdira-provider-"));
  temporaryRoots.push(root);
  return root;
}

function request(
  call: string,
  payload: JsonValue,
  overrides: Partial<SourceProviderRequestEnvelope> = {},
): SourceProviderRequestEnvelope {
  const envelope: SourceProviderRequestEnvelope = {
    protocol_version: "1",
    request_id: `request:${call}`,
    request_digest: "",
    call,
    workspace_id: "workspace:one",
    source_provider_binding_id: "binding:one",
    component_id: "core:directory_source_provider",
    component_version: "1",
    deadline_at: "2026-08-09T12:01:00.000Z",
    cancellation_id: "cancellation:one",
    resource_budget: JSON.stringify({
      max_duration_ms: 60_000,
      max_response_bytes: 1_000_000,
      max_observations: 1_000,
      max_watch_events: 1_000,
    }),
    payload,
    ...overrides,
  };
  if (overrides.request_digest !== undefined) return envelope;
  return {
    ...envelope,
    request_digest: digestBytes(canonicalBytes({
      protocol_version: envelope.protocol_version,
      call: envelope.call,
      workspace_id: envelope.workspace_id,
      source_provider_binding_id: envelope.source_provider_binding_id,
      component_id: envelope.component_id,
      component_version: envelope.component_version,
      resource_budget: envelope.resource_budget,
      payload: envelope.payload,
    })),
  };
}

function worktreeRequest(call: string, payload: JsonValue, overrides: Partial<SourceProviderRequestEnvelope> = {}): SourceProviderRequestEnvelope {
  return request(call, payload, { component_id: "core:git_worktree_source_provider", ...overrides });
}

function referenceRequest(call: string, payload: JsonValue, overrides: Partial<SourceProviderRequestEnvelope> = {}): SourceProviderRequestEnvelope {
  return request(call, payload, { component_id: "core:git_reference_source_provider", ...overrides });
}

function responsePayload<T>(response: SourceProviderResponseEnvelope): T {
  expect(response.outcome).toBe("success");
  expect(response.error).toBeUndefined();
  return response.payload as T;
}

function decoded<T>(value: string): T {
  return JSON.parse(value) as T;
}

function methodNames(provider: object): string[] {
  const names = new Set<string>();
  let prototype = Object.getPrototypeOf(provider) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== "constructor" && typeof (provider as Record<string, unknown>)[name] === "function") names.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return [...names].sort();
}

async function fileState(root: string): Promise<Readonly<Record<string, string>>> {
  const state: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    const absolute = relative ? join(root, relative) : root;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else state[child] = Buffer.from(await readFile(join(root, child))).toString("base64");
    }
  };
  await visit("");
  return state;
}

function readPayload(observation: ProviderObservation): JsonValue {
  return {
    artifact_id: observation.artifact_id,
    normalized_uri: observation.normalized_uri,
    observed_content_hash: observation.observed_content_hash,
    observed_metadata_digest: observation.observed_metadata_digest,
    provider_version_token: observation.provider_version_token,
  };
}

const completeScope = [{
  scope_type: "workspace",
  source_provider_binding_id: "binding:one",
  source_provider: "core:directory_source_provider",
  normalized_scope_key: "",
}];
const boundProvider = { workspace_id: "workspace:one", source_provider_binding_id: "binding:one" } as const;

describe("Phase 7 five-call source providers", () => {
  it("exposes exactly the five protocol calls", async () => {
    const root = await temporaryDirectory();
    const providers = [
      new DirectorySourceProvider({ ...boundProvider, root, now: () => instant }),
      new GitWorktreeSourceProvider({ ...boundProvider, root, now: () => instant }),
      new GitReferenceSourceProvider({ ...boundProvider, git_dir: join(root, ".git"), ref: "refs/heads/main", now: () => instant }),
    ];

    for (const provider of providers) {
      expect(methodNames(provider)).toEqual(["describe", "enumerate", "read", "reconcile", "watch"]);
    }
  });

  it("rejects a mismatched request digest for every call before provider IO", async () => {
    const root = await temporaryDirectory();
    let ioCalls = 0;
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      file_system: {
        read_directory: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.read_directory(...arguments_); },
        read_file: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.read_file(...arguments_); },
        lstat: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.lstat(...arguments_); },
        stat: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.stat(...arguments_); },
        real_path: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.real_path(...arguments_); },
      },
    });
    const cases = [
      ["describe", { binding_configuration_digest: "sha256:configuration" }],
      ["enumerate", { coverage_scopes: completeScope }],
      ["read", { artifact_id: "artifact:missing", normalized_uri: "missing.ts", observed_content_hash: "sha256:missing", observed_metadata_digest: "sha256:missing", provider_version_token: "missing" }],
      ["watch", { after_watermark: "", coverage_scopes: completeScope, max_wait_ms: 0 }],
      ["reconcile", { coverage_scopes: completeScope }],
    ] as const;

    for (const [call, payload] of cases) {
      const envelope = request(call, payload, { request_digest: `sha256:${"0".repeat(64)}` });
      const response = await provider[call](envelope);
      expect(response.outcome).toBe("failed");
      expect(decoded<{ error_code: string }>(response.error!).error_code).toBe("core:source_provider_request_invalid");
      expect(response).toMatchObject({
        protocol_version: envelope.protocol_version,
        request_id: envelope.request_id,
        request_digest: envelope.request_digest,
        call: envelope.call,
        workspace_id: envelope.workspace_id,
        source_provider_binding_id: envelope.source_provider_binding_id,
        component_id: envelope.component_id,
        component_version: envelope.component_version,
      });
    }
    expect(ioCalls).toBe(0);
  });

  it("rejects unexpected protocol and binding coordinates before provider IO", async () => {
    const root = await temporaryDirectory();
    let ioCalls = 0;
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      file_system: {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_directory: async (...arguments_) => { ioCalls += 1; return NODE_DIRECTORY_FILE_SYSTEM.read_directory(...arguments_); },
      },
    });
    const mismatches: ReadonlyArray<Partial<SourceProviderRequestEnvelope>> = [
      { protocol_version: "2" },
      { workspace_id: "workspace:other" },
      { source_provider_binding_id: "binding:other" },
      { component_id: "core:git_worktree_source_provider" },
      { component_version: "2" },
    ];
    for (const mismatch of mismatches) {
      const response = await provider.describe(request("describe", { binding_configuration_digest: "sha256:configuration" }, mismatch));
      expect(response.outcome).toBe("failed");
      expect(decoded<{ error_code: string }>(response.error!).error_code).toBe("core:source_provider_request_invalid");
    }
    expect(ioCalls).toBe(0);
  });

  it("derives artifact identity from workspace and normalized URI across provider bindings", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    await git.commit({ fs, dir: root, message: "identity", author: { name: "Test", email: "test@example.invalid" } });

    const cases = [
      {
        component: "core:directory_source_provider",
        provider: "core:directory_source_provider",
        create: (workspace_id: string, source_provider_binding_id: string) => new DirectorySourceProvider({ workspace_id, source_provider_binding_id, root, now: () => instant }),
      },
      {
        component: "core:git_worktree_source_provider",
        provider: "core:git_worktree_source_provider",
        create: (workspace_id: string, source_provider_binding_id: string) => new GitWorktreeSourceProvider({ workspace_id, source_provider_binding_id, root, now: () => instant }),
      },
      {
        component: "core:git_reference_source_provider",
        provider: "core:git_reference_source_provider",
        create: (workspace_id: string, source_provider_binding_id: string) => new GitReferenceSourceProvider({ workspace_id, source_provider_binding_id, git_dir: join(root, ".git"), ref: "refs/heads/main", now: () => instant }),
      },
    ] as const;
    const artifactId = async (item: typeof cases[number], workspaceId: string, bindingId: string): Promise<string> => {
      const scope = [{ ...completeScope[0]!, source_provider_binding_id: bindingId, source_provider: item.provider }];
      const envelope = request("enumerate", { coverage_scopes: scope }, {
        workspace_id: workspaceId,
        source_provider_binding_id: bindingId,
        component_id: item.component,
      });
      const result = responsePayload<{ observation_batch: string }>(await item.create(workspaceId, bindingId).enumerate(envelope));
      return decoded<{ observations: ProviderObservation[] }>(result.observation_batch).observations[0]!.artifact_id;
    };

    const identities: Array<{ first: string; rebound: string; otherWorkspace: string }> = [];
    for (const item of cases) {
      const first = await artifactId(item, "workspace:one", "binding:first");
      const rebound = await artifactId(item, "workspace:one", "binding:second");
      const otherWorkspace = await artifactId(item, "workspace:other", "binding:first");
      identities.push({ first, rebound, otherWorkspace });
    }
    expect({
      stableAcrossBindings: identities.map(({ first, rebound }) => rebound === first),
      distinctAcrossWorkspaces: identities.map(({ first, otherWorkspace }) => otherWorkspace !== first),
    }).toEqual({ stableAcrossBindings: [true, true, true], distinctAcrossWorkspaces: [true, true, true] });
  });

  it("enumerates only eligible files and reads the exact stable observed occurrence", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "src", "alpha.ts"), "export const alpha = 1;\n");
    await writeFile(join(root, "src", "ignored.log"), "ignored\n");
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      inclusion_rules: { include: [], exclude: ["**/*.log"], allow_external_root: false },
    });

    const first = await provider.enumerate(request("enumerate", { coverage_scopes: completeScope }));
    const result = responsePayload<{ observation_batch: string; watermark: string; capture_start_fingerprint: string; capture_end_fingerprint: string }>(first);
    const batch = decoded<{ batch: { coverage_completeness: string; deletion_authority: string; observation_count: number }; observations: ProviderObservation[] }>(result.observation_batch);

    expect(batch.batch).toMatchObject({ coverage_completeness: "complete", deletion_authority: "authoritative", observation_count: 1, observation_mode: "scan" });
    expect(batch.observations.every((observation) => observation.observation_mode === "scan")).toBe(true);
    expect(batch.observations.map((observation) => observation.normalized_uri)).toEqual(["src/alpha.ts"]);
    expect(result.capture_start_fingerprint).toBe(result.capture_end_fingerprint);

    const observation = batch.observations[0]!;
    const read = await provider.read(request("read", {
      artifact_id: observation.artifact_id,
      normalized_uri: observation.normalized_uri,
      observed_content_hash: observation.observed_content_hash,
      observed_metadata_digest: observation.observed_metadata_digest,
      provider_version_token: observation.provider_version_token,
    }));
    const readResult = responsePayload<{ content_bytes: string; content_hash: string; byte_length: number; metadata_digest: string }>(read);
    expect(Buffer.from(readResult.content_bytes, "base64").toString("utf8")).toBe("export const alpha = 1;\n");
    expect(readResult).toMatchObject({
      content_hash: observation.observed_content_hash,
      metadata_digest: observation.observed_metadata_digest,
      byte_length: 24,
    });
  });

  it("rejects direct reads of mandatory and configured exclusions even with matching observation coordinates", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "secret\n");
    await writeFile(join(root, "excluded.txt"), "excluded\n");
    const baseline = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant });
    const capture = responsePayload<{ observation_batch: string }>(await baseline.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    const observation = decoded<{ observations: ProviderObservation[] }>(capture.observation_batch).observations.find((item) => item.normalized_uri === "excluded.txt")!;
    const restricted = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      inclusion_rules: { include: [], exclude: ["excluded.txt"], allow_external_root: false },
    });

    const excluded = await restricted.read(request("read", readPayload(observation)));
    const mandatory = await restricted.read(request("read", { ...readPayload(observation) as Record<string, JsonValue>, normalized_uri: ".git/HEAD" }));

    expect([excluded.outcome, mandatory.outcome]).toEqual(["failed", "failed"]);
    expect([excluded.payload, mandatory.payload]).toEqual([undefined, undefined]);
  });

  it("requires both external-root permission and an approved root, and detects symlink retargeting during read", async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const firstTarget = join(external, "first.ts");
    const secondTarget = join(external, "second.ts");
    const link = join(root, "linked.ts");
    await writeFile(firstTarget, "first\n");
    await writeFile(secondTarget, "second\n");
    await symlink(firstTarget, link);
    const denied = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      inclusion_rules: { include: [], exclude: [], allow_external_root: false, follow_symlinks: true, allowed_external_roots: [external] },
    });
    const deniedCapture = responsePayload<{ observation_batch: string }>(await denied.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    expect(decoded<{ observations: ProviderObservation[] }>(deniedCapture.observation_batch).observations).toHaveLength(0);

    const allowedRules = { include: [] as string[], exclude: [] as string[], allow_external_root: true, follow_symlinks: true, allowed_external_roots: [external] };
    const allowed = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant, inclusion_rules: allowedRules });
    const allowedCapture = responsePayload<{ observation_batch: string }>(await allowed.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    const observation = decoded<{ observations: ProviderObservation[] }>(allowedCapture.observation_batch).observations[0]!;
    let retargeted = false;
    const racing = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      inclusion_rules: allowedRules,
      file_system: {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_file: async (candidate) => {
          const bytes = await NODE_DIRECTORY_FILE_SYSTEM.read_file(candidate);
          if (!retargeted) {
            retargeted = true;
            await unlink(link);
            await symlink(secondTarget, link);
          }
          return bytes;
        },
      },
    });

    const raced = await racing.read(request("read", readPayload(observation)));
    expect(raced.outcome).toBe("source_changed");
  });

  it("safely excludes a dangling symlink without resolving it when symlink following is disabled", async () => {
    const root = await temporaryDirectory();
    await symlink(join(root, "missing-target.ts"), join(root, "dangling.ts"));
    const provider = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant });

    const response = await provider.enumerate(request("enumerate", { coverage_scopes: completeScope }));
    const result = responsePayload<{ observation_batch: string }>(response);
    const batch = decoded<{ batch: { deletion_authority: string }; observations: ProviderObservation[] }>(result.observation_batch);

    expect(batch.observations).toEqual([]);
    expect(batch.batch.deletion_authority).toBe("authoritative");
  });

  it("returns closed outcomes for deadline, cancellation, and observation budget exhaustion", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    const provider = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant, is_cancelled: (identity) => identity === "cancelled" });

    const deadline = await provider.describe(request("describe", { binding_configuration_digest: "sha256:configuration" }, { deadline_at: instant }));
    const cancelled = await provider.describe(request("describe", { binding_configuration_digest: "sha256:configuration" }, { cancellation_id: "cancelled" }));
    const exhausted = await provider.enumerate(request("enumerate", { coverage_scopes: completeScope }, {
      resource_budget: JSON.stringify({ max_duration_ms: 60_000, max_response_bytes: 1_000_000, max_observations: 0, max_watch_events: 1_000 }),
    }));

    expect([deadline.outcome, cancelled.outcome, exhausted.outcome]).toEqual(["deadline_exceeded", "cancelled", "resource_exhausted"]);
    expect([deadline, cancelled, exhausted].every((response) => response.payload === undefined && response.error !== undefined)).toBe(true);
  });

  it("checks a read observation token before and after reading bytes", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "alpha.ts");
    await writeFile(path, "before\n");
    const baseline = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant });
    const enumeration = responsePayload<{ observation_batch: string }>(await baseline.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    const observation = decoded<{ observations: ProviderObservation[] }>(enumeration.observation_batch).observations[0]!;
    let changed = false;
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      file_system: {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_file: async (candidate) => {
          const bytes = await readFile(candidate);
          if (!changed) {
            changed = true;
            await writeFile(candidate, "after-after\n");
          }
          return bytes;
        },
      },
    });

    const result = await provider.read(request("read", {
      artifact_id: observation.artifact_id,
      normalized_uri: observation.normalized_uri,
      observed_content_hash: observation.observed_content_hash,
      observed_metadata_digest: observation.observed_metadata_digest,
      provider_version_token: observation.provider_version_token,
    }));

    expect(result.outcome).toBe("source_changed");
    expect(result.payload).toBeUndefined();
  });

  it("never grants deletion authority to partial coverage and produces deterministic watermarks", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "alpha.ts"), "alpha\n");
    await writeFile(join(root, "root.ts"), "root\n");
    const provider = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant });
    const partialScope = [{ ...completeScope[0]!, normalized_scope_key: "src" }];

    const partial = responsePayload<{ observation_batch: string }>(await provider.enumerate(request("enumerate", { coverage_scopes: partialScope })));
    const first = responsePayload<{ watermark: string }>(await provider.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    const second = responsePayload<{ watermark: string }>(await provider.enumerate(request("enumerate", { coverage_scopes: completeScope })));
    const partialBatch = decoded<{ batch: { coverage_completeness: string; deletion_authority: string } }>(partial.observation_batch);

    expect(partialBatch.batch).toMatchObject({ coverage_completeness: "partial", deletion_authority: "none" });
    expect(second.watermark).toBe(first.watermark);
  });

  it("reports an unstable reconciliation without absence authority", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "alpha.ts");
    await writeFile(path, "alpha\n");
    let reads = 0;
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      file_system: {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_file: async (candidate) => {
          const bytes = await NODE_DIRECTORY_FILE_SYSTEM.read_file(candidate);
          reads += 1;
          if (reads === 1) await writeFile(path, "changed during capture\n");
          return bytes;
        },
      },
    });

    const result = responsePayload<{ stable: boolean; observation_batch: string; capture_start_fingerprint: string; capture_end_fingerprint: string }>(
      await provider.reconcile(request("reconcile", { coverage_scopes: completeScope })),
    );
    const batch = decoded<{ batch: { coverage_completeness: string; deletion_authority: string; observation_mode: string }; observations: ProviderObservation[] }>(result.observation_batch);
    expect(result.stable).toBe(false);
    expect(result.capture_end_fingerprint).not.toBe(result.capture_start_fingerprint);
    expect(batch.batch).toMatchObject({ coverage_completeness: "partial", deletion_authority: "none", observation_mode: "reconciliation" });
    expect(batch.observations.every((observation) => observation.observation_mode === "reconciliation")).toBe(true);
  });

  it("detects a directory membership change between complete inventories", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    await writeFile(join(root, "late.ts"), "late\n");
    let rootReads = 0;
    const provider = new DirectorySourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      file_system: {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_directory: async (candidate) => {
          const entries = await NODE_DIRECTORY_FILE_SYSTEM.read_directory(candidate);
          if (++rootReads === 1) return entries.filter((entry) => entry.name !== "late.ts");
          return entries;
        },
      },
    });

    const result = responsePayload<{ stable: boolean; observation_batch: string }>(await provider.reconcile(request("reconcile", { coverage_scopes: completeScope })));
    const batch = decoded<{ batch: { deletion_authority: string }; observations: ProviderObservation[] }>(result.observation_batch);
    expect(result.stable).toBe(false);
    expect(batch.batch.deletion_authority).toBe("none");
    expect(batch.observations.map((item) => item.normalized_uri)).toContain("late.ts");
  });

  it("returns unavailable Git worktree outcomes for a non-Git root", async () => {
    const root = await temporaryDirectory();
    const provider = new GitWorktreeSourceProvider({ ...boundProvider, root, now: () => instant });

    const result = await provider.describe(worktreeRequest("describe", { binding_configuration_digest: "sha256:configuration" }));

    expect(result.outcome).toBe("unavailable");
    expect(result.error).toBeDefined();
  });

  it("captures detached worktree metadata and administrative changes without altering physical files", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    const commit = await git.commit({ fs, dir: root, message: "initial", author: { name: "Test", email: "test@example.invalid" } });
    await writeFile(join(root, ".git", "HEAD"), `${commit}\n`);
    await writeFile(join(root, "alpha.ts"), "dirty\n");
    const provider = new GitWorktreeSourceProvider({ ...boundProvider, root, now: () => instant });
    const before = await readFile(join(root, "alpha.ts"), "utf8");

    const described = responsePayload<{ features: string; source_state_fingerprint: string }>(
      await provider.describe(worktreeRequest("describe", { binding_configuration_digest: "sha256:configuration" })),
    );
    const featureBundle = decoded<{ read_only: boolean; vcs_state: { head_revision: string; ref_kind: string; detached: boolean; dirty: string }; administrative_state_fingerprint: string }>(described.features);

    expect(featureBundle.read_only).toBe(false);
    expect(featureBundle.vcs_state).toMatchObject({ head_revision: commit, ref_kind: "detached", detached: true, dirty: "dirty" });
    expect(featureBundle.administrative_state_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(described.source_state_fingerprint).not.toBe(featureBundle.administrative_state_fingerprint);
    expect(await readFile(join(root, "alpha.ts"), "utf8")).toBe(before);
  });

  it("describes mutable directories and Windows case preservation without advertising an absent watch port", async () => {
    const root = await temporaryDirectory();
    const provider = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant });
    const described = responsePayload<{ features: string }>(await provider.describe(request("describe", { binding_configuration_digest: "sha256:configuration" })));
    expect(decoded<{ supports_watch: boolean; read_only: boolean }>(described.features)).toMatchObject({ supports_watch: false, read_only: false });

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      const windows = responsePayload<{ features: string }>(await provider.describe(request("describe", { binding_configuration_digest: "sha256:configuration" })));
      expect(decoded<{ case_behavior: string }>(windows.features).case_behavior).toBe("insensitive_preserving");
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("brackets Git administration and rejects an excluded-file dirty transition during physical capture", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    await git.commit({ fs, dir: root, message: "initial", author: { name: "Test", email: "test@example.invalid" } });
    let samples = 0;
    const port: GitObjectPort = {
      ...ISOMORPHIC_GIT_OBJECT_PORT,
      status_matrix: async (...arguments_) => {
        const rows = await ISOMORPHIC_GIT_OBJECT_PORT.status_matrix(...arguments_);
        if (++samples === 1) await writeFile(join(root, "excluded.log"), "administrative change\n");
        return rows;
      },
    };
    const provider = new GitWorktreeSourceProvider({
      ...boundProvider,
      root,
      now: () => instant,
      git_objects: port,
      inclusion_rules: { include: [], exclude: ["**/*.log"], allow_external_root: false },
    });
    const worktreeScope = [{ ...completeScope[0]!, source_provider: "core:git_worktree_source_provider" }];

    const result = await provider.enumerate(worktreeRequest("enumerate", { coverage_scopes: worktreeScope }));
    expect(result.outcome).toBe("source_changed");
    expect(samples).toBeGreaterThanOrEqual(2);
  });

  it("pins a Git ref until reconcile explicitly refreshes it and reads blobs without checkout", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "alpha.ts"), "one\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    const firstCommit = await git.commit({ fs, dir: root, message: "one", author: { name: "Test", email: "test@example.invalid" } });
    const provider = new GitReferenceSourceProvider({ ...boundProvider, git_dir: join(root, ".git"), ref: "refs/heads/main", now: () => instant });
    const referenceScope = [{ ...completeScope[0]!, source_provider: "core:git_reference_source_provider" }];
    const description = responsePayload<{ features: string }>(await provider.describe(referenceRequest("describe", { binding_configuration_digest: "sha256:configuration" })));
    expect(decoded<{ supports_virtual_artifacts: boolean; read_only: boolean }>(description.features)).toMatchObject({ supports_virtual_artifacts: true, read_only: true });
    const first = responsePayload<{ observation_batch: string; capture_start_fingerprint: string }>(
      await provider.enumerate(referenceRequest("enumerate", { coverage_scopes: referenceScope })),
    );
    const firstBatch = decoded<{ batch: { observation_mode: string }; observations: ProviderObservation[] }>(first.observation_batch);
    expect(firstBatch.batch.observation_mode).toBe("scan");
    expect(firstBatch.observations.every((observation) => observation.observation_mode === "scan")).toBe(true);
    const firstObservation = firstBatch.observations[0]!;

    await writeFile(join(root, "alpha.ts"), "two\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    const secondCommit = await git.commit({ fs, dir: root, message: "two", author: { name: "Test", email: "test@example.invalid" } });
    const stillPinned = responsePayload<{ capture_start_fingerprint: string }>(
      await provider.enumerate(referenceRequest("enumerate", { coverage_scopes: referenceScope })),
    );
    expect(stillPinned.capture_start_fingerprint).toBe(first.capture_start_fingerprint);

    const read = responsePayload<{ content_bytes: string }>(await provider.read(referenceRequest("read", {
      artifact_id: firstObservation.artifact_id,
      normalized_uri: firstObservation.normalized_uri,
      observed_content_hash: firstObservation.observed_content_hash,
      observed_metadata_digest: firstObservation.observed_metadata_digest,
      provider_version_token: firstObservation.provider_version_token,
    })));
    expect(Buffer.from(read.content_bytes, "base64").toString("utf8")).toBe("one\n");
    expect(await readFile(join(root, "alpha.ts"), "utf8")).toBe("two\n");

    const refreshed = responsePayload<{ capture_start_fingerprint: string; observation_batch: string }>(
      await provider.reconcile(referenceRequest("reconcile", { coverage_scopes: referenceScope })),
    );
    expect(refreshed.capture_start_fingerprint).toContain(secondCommit);
    expect(refreshed.capture_start_fingerprint).not.toContain(firstCommit);
    const refreshedBatch = decoded<{ batch: { observation_mode: string }; observations: ProviderObservation[] }>(refreshed.observation_batch);
    expect(refreshedBatch.batch.observation_mode).toBe("reconciliation");
    expect(refreshedBatch.observations.every((observation) => observation.observation_mode === "reconciliation")).toBe(true);
  });

  it("rejects excluded and oversized Git-reference blobs on direct read", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "excluded.ts"), "excluded\n");
    await writeFile(join(root, "large.dat"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await git.add({ fs, dir: root, filepath: "excluded.ts" });
    await git.add({ fs, dir: root, filepath: "large.dat" });
    const commit = await git.commit({ fs, dir: root, message: "objects", author: { name: "Test", email: "test@example.invalid" } });
    const tree = await git.readTree({ fs, gitdir: join(root, ".git"), oid: commit });
    const excludedEntry = tree.tree.find((entry) => entry.path === "excluded.ts")!;
    const largeEntry = tree.tree.find((entry) => entry.path === "large.dat")!;
    const provider = new GitReferenceSourceProvider({
      ...boundProvider,
      git_dir: join(root, ".git"),
      ref: "refs/heads/main",
      now: () => instant,
      inclusion_rules: { include: [], exclude: ["excluded.ts"], allow_external_root: false },
    });
    const forged = (uri: string, oid: string, mode: string, bytes: Uint8Array): JsonValue => ({
      artifact_id: `artifact:${uri}`,
      normalized_uri: uri,
      observed_content_hash: digestBytes(bytes),
      observed_metadata_digest: digestBytes(canonicalBytes({ commit, mode, oid, uri })),
      provider_version_token: `${commit}:${oid}:${mode}`,
    });

    const excluded = await provider.read(referenceRequest("read", forged("excluded.ts", excludedEntry.oid, excludedEntry.mode, Buffer.from("excluded\n"))));
    const large = await provider.read(referenceRequest("read", forged("large.dat", largeEntry.oid, largeEntry.mode, Buffer.alloc(10 * 1024 * 1024 + 1))));
    expect([excluded.outcome, large.outcome]).toEqual(["failed", "failed"]);
  });

  it("keeps source, refs, index, and hooks byte-identical across all provider calls", async () => {
    const root = await temporaryDirectory();
    await git.init({ fs, dir: root, defaultBranch: "main" });
    await writeFile(join(root, "alpha.ts"), "alpha\n");
    await git.add({ fs, dir: root, filepath: "alpha.ts" });
    await git.commit({ fs, dir: root, message: "initial", author: { name: "Test", email: "test@example.invalid" } });
    const hookMarker = join(root, "hook-ran");
    const hook = join(root, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch '${hookMarker}'\nexit 99\n`);
    await chmod(hook, 0o755);
    const before = await fileState(root);
    const worktree = new GitWorktreeSourceProvider({ ...boundProvider, root, now: () => instant });
    const worktreeScope = [{ ...completeScope[0]!, source_provider: "core:git_worktree_source_provider" }];
    await worktree.describe(worktreeRequest("describe", { binding_configuration_digest: "sha256:configuration" }));
    const worktreeCapture = responsePayload<{ observation_batch: string }>(await worktree.enumerate(worktreeRequest("enumerate", { coverage_scopes: worktreeScope })));
    const worktreeObservation = decoded<{ observations: ProviderObservation[] }>(worktreeCapture.observation_batch).observations[0]!;
    await worktree.read(worktreeRequest("read", readPayload(worktreeObservation)));
    await worktree.watch(worktreeRequest("watch", { after_watermark: "", coverage_scopes: worktreeScope, max_wait_ms: 0 }));
    await worktree.reconcile(worktreeRequest("reconcile", { coverage_scopes: worktreeScope }));
    const reference = new GitReferenceSourceProvider({ ...boundProvider, git_dir: join(root, ".git"), ref: "refs/heads/main", now: () => instant });
    const referenceScope = [{ ...completeScope[0]!, source_provider: "core:git_reference_source_provider" }];
    await reference.describe(referenceRequest("describe", { binding_configuration_digest: "sha256:configuration" }));
    const referenceCapture = responsePayload<{ observation_batch: string }>(await reference.enumerate(referenceRequest("enumerate", { coverage_scopes: referenceScope })));
    const referenceObservation = decoded<{ observations: ProviderObservation[] }>(referenceCapture.observation_batch).observations[0]!;
    await reference.read(referenceRequest("read", readPayload(referenceObservation)));
    await reference.watch(referenceRequest("watch", { after_watermark: "", coverage_scopes: referenceScope, max_wait_ms: 0 }));
    await reference.reconcile(referenceRequest("reconcile", { coverage_scopes: referenceScope }));

    expect(await fileState(root)).toEqual(before);
    await expect(lstat(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lstat(join(root, ".git", "hooks", "post-checkout"))).toBeDefined();
  });

  it("produces a byte-identical stable enumeration regardless of io_concurrency, even with scrambled directory-entry completion order", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "src", "nested"));
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(root, `top-${String(index).padStart(2, "0")}.ts`), `export const top${index} = ${index};\n`);
    }
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(root, "src", `mid-${String(index).padStart(2, "0")}.ts`), `export const mid${index} = ${index};\n`);
    }
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, "src", "nested", `leaf-${String(index).padStart(2, "0")}.ts`), `export const leaf${index} = ${index};\n`);
    }

    // A scrambling `read_file` hook: reorders completion by delaying files
    // in reverse-length order (later-numbered/deeper files return sooner),
    // so a parallel walk's actual completion order provably differs from
    // both directory-listing order and any single fixed order -- the
    // interesting case for "does concurrency leak into the output" is
    // exactly when completion order is scrambled, not when it happens to
    // match.
    function scramblingFileSystem(): DirectoryFileSystem {
      return {
        ...NODE_DIRECTORY_FILE_SYSTEM,
        read_file: async (path: string) => {
          const delayMs = (Buffer.from(path).reduce((sum, byte) => sum + byte, 0) % 10);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          return NODE_DIRECTORY_FILE_SYSTEM.read_file(path);
        },
      };
    }

    async function captureWith(ioConcurrency: number): Promise<{ readonly observation_batch: string; readonly watermark: string; readonly capture_start_fingerprint: string; readonly capture_end_fingerprint: string }> {
      const provider = new DirectorySourceProvider({ ...boundProvider, root, now: () => instant, io_concurrency: ioConcurrency, file_system: scramblingFileSystem() });
      const response = await provider.enumerate(request("enumerate", { coverage_scopes: completeScope }));
      return responsePayload(response);
    }

    const sequential = await captureWith(1);
    const parallel = await captureWith(16);
    const highlyParallel = await captureWith(64);

    // Fingerprints and watermark are content-derived (sorted-by-uri,
    // deduplicated), so they must agree regardless of `io_concurrency`.
    expect(parallel.capture_start_fingerprint).toBe(sequential.capture_start_fingerprint);
    expect(parallel.capture_end_fingerprint).toBe(sequential.capture_end_fingerprint);
    expect(parallel.watermark).toBe(sequential.watermark);
    expect(highlyParallel.capture_start_fingerprint).toBe(sequential.capture_start_fingerprint);
    expect(highlyParallel.watermark).toBe(sequential.watermark);

    // The full encoded observation batch (including per-file `token_after`/
    // `content_hash`, and the batch's own digest) must be byte-for-byte
    // identical: nothing about which directory entry happened to finish
    // first may leak into the payload.
    expect(parallel.observation_batch).toBe(sequential.observation_batch);
    expect(highlyParallel.observation_batch).toBe(sequential.observation_batch);

    const observations = decoded<{ observations: ProviderObservation[] }>(sequential.observation_batch).observations;
    expect(observations.length).toBe(44);
    expect(observations.map((observation) => observation.normalized_uri)).toEqual([...observations.map((observation) => observation.normalized_uri)].sort());
  });
});
