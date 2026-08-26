import { describe, expect, it } from "vitest";
import {
  WorkspaceRegistry,
  type RegisteredWorkspace,
  type WorkspaceRegistration,
  type WorkspaceRegistryState,
} from "../packages/engine/src/index.js";

function registration(root: string, binding: string, vcsIdentity?: string): WorkspaceRegistration {
  return {
    display_root: root,
    provider: {
      source_provider_binding_id: `binding:${binding}`,
      source_provider: "core:directory_source_provider",
      source_provider_version: "1",
      provider_role: "primary",
      binding_identity: `filesystem:${binding}`,
      configuration_digest: "sha256:configuration",
    },
    description: {
      provider_kind: "core:directory_source_provider",
      immutable_binding_identity: `filesystem:${binding}`,
      features: "source-provider-features:v1",
      source_state_fingerprint: `fingerprint:${binding}`,
    },
    ...(vcsIdentity === undefined ? {} : {
      vcs_state: JSON.stringify({
        provider: "git",
        common_repository_id: vcsIdentity,
        head_revision: "0123456789abcdef",
        ref_kind: "branch",
        ref_name: "refs/heads/main",
        detached: false,
        dirty: "clean",
        captured_at: "2026-08-25T00:00:00.000Z",
      }),
    }),
  };
}

function legacyWorkspace(): RegisteredWorkspace {
  return {
    workspace_id: "workspace:legacy-id",
    canonical_root: "/projects/urdira",
    display_root: ".",
    provider: {
      source_provider_binding_id: "binding:legacy",
      source_provider: "core:directory_source_provider",
      source_provider_version: "1",
      provider_role: "primary",
      binding_identity: "filesystem:legacy",
      configuration_digest: "sha256:configuration",
    },
    source_state_fingerprint: "fingerprint:legacy",
    status: "registering",
    registered_at: "2026-08-25T00:00:00.000Z",
  };
}

describe("project-aware workspace identity", () => {
  it("prefixes new random workspace identities and normalizes their display metadata", () => {
    const registry = new WorkspaceRegistry({ canonicalize_root: (root) => `/projects/${root.replace(/^\.\/?/u, "") || "urdira"}` });
    const workspace = registry.register(registration("./urdira", "urdira"));

    expect(workspace.workspace_id).toMatch(/^workspace:urdira:[0-9a-f-]{36}$/u);
    expect(workspace).toMatchObject({ project_name: "urdira", display_root: "/projects/urdira" });
    expect(workspace.codebase_id).toMatch(/^codebase:/u);
  });

  it("migrates legacy registry metadata without changing the workspace identity", () => {
    let saved: WorkspaceRegistryState | undefined;
    const legacy: WorkspaceRegistryState = { workspaces: [legacyWorkspace()], codebases: [] };
    const registry = new WorkspaceRegistry({
      create_id: (kind, projectSlug) => `${kind}:${projectSlug ?? "generated"}`,
      persistence: { load: () => legacy, save: (state) => { saved = structuredClone(state); } },
    });
    const workspace = registry.get("workspace:legacy-id");

    expect(workspace).toMatchObject({
      workspace_id: "workspace:legacy-id",
      project_name: "urdira",
      display_root: "/projects/urdira",
    });
    expect(workspace?.codebase_id).toBeDefined();
    expect(saved?.schema_version).toBe(2);
  });

  it("groups exact Git worktrees automatically and allows a user-defined project name", () => {
    let id = 0;
    const registry = new WorkspaceRegistry({
      create_id: (kind, slug) => `${kind}:${slug ?? "id"}:${++id}`,
      canonicalize_root: (root) => root,
    });
    const first = registry.register(registration("/worktrees/urdira-main", "main", "repo:urdira"));
    const second = registry.register(registration("/worktrees/urdira-feature", "feature", "repo:urdira"));

    expect(second.codebase_id).toBe(first.codebase_id);
    const renamed = registry.renameCodebase(first.codebase_id!, "Urdira parallel work");
    expect(renamed.display_name).toBe("Urdira parallel work");
    const standalone = registry.assignCodebase(second.workspace_id);
    expect(standalone.codebase_id).not.toBe(first.codebase_id);
  });

  it("resolves an explicit nested cwd to the most specific containing workspace", () => {
    let id = 0;
    const registry = new WorkspaceRegistry({
      create_id: (kind, slug) => `${kind}:${slug ?? "id"}:${++id}`,
      canonicalize_root: (root) => root.replace(/\/$/u, ""),
    });
    const outer = registry.register(registration("/projects/urdira", "outer"));
    const inner = registry.register(registration("/projects/urdira/examples/demo", "inner"));

    expect(registry.findByCanonicalRoot("/projects/urdira/packages/web")?.workspace_id).toBe(outer.workspace_id);
    expect(registry.findByCanonicalRoot("/projects/urdira/examples/demo/src")?.workspace_id).toBe(inner.workspace_id);
  });
});
