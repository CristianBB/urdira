import { access, readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("current-state documentation", () => {
  it("keeps the public version and runtime requirements synchronized", async () => {
    const packageManifest = JSON.parse(await read("package.json")) as {
      readonly version: string;
      readonly engines: { readonly node: string };
    };
    const readme = await read("README.md");
    expect(readme).toContain(`Urdira ${packageManifest.version} requires Node.js \`${packageManifest.engines.node}\``);
  });

  it("documents the implemented v3 system instead of superseded migration behavior", async () => {
    const paths = [
      "docs/README.md",
      "docs/product-foundation.md",
      "docs/release.md",
      "docs/decisions/19-agent-search-integration.md",
      "docs/decisions/20-source-first-readiness.md",
      "docs/decisions/21-native-pipeline-relational-storage.md",
      "docs/decisions/22-v3-optimization.md",
      "docs/decisions/23-index-pack.md",
      "docs/protocol/public-query-contract.md",
      "CHANGELOG.md",
    ];
    const text = (await Promise.all(paths.map(read))).join("\n");
    expect(text).not.toMatch(/The next milestone is implementation planning/u);
    expect(text).not.toMatch(/Urdira v2 release qualification/u);
    expect(text).not.toMatch(/rerun for the v2 implementation/u);
    expect(text).not.toMatch(/Historical stored data remains readable through its versioned persistence format/u);
    expect(text).not.toMatch(/migrate --to-data-format 3/u);
    expect(text).not.toMatch(/fanout-16 Merkle radix root/u);
  });

  it("provides versioned Mermaid maps for indexing and every public operation path", async () => {
    const guide = await read("docs/architecture.md");
    expect(guide.match(/```mermaid/gu)).toHaveLength(7);
    expect(guide).toContain("runProgressiveWorkspaceScan");
    expect(guide).toContain("runFullWorkspaceScan");
    expect(guide).toContain("MaterializationDigestOffload");
    expect(guide).toContain("attemptIndexPackImport");
    expect(guide).toContain("QueryEngine.execute");
    expect(guide).toContain("CanonicalRecordQueryDataPort");
    expect(guide).toContain("urdira_index_status");
    expect(guide).toContain("urdira_query");
    expect(guide).toContain("urdira_context");
    expect(guide).toContain("urdira_analyze_change");
    expect(guide).toContain("urdira_build_context");
    expect(await read("docs/README.md")).toContain("[current architecture](architecture.md)");
  });

  it("indexes every implemented decision and points readers at the current benchmark report", async () => {
    const foundation = await read("docs/product-foundation.md");
    const readme = await read("README.md");
    const release = await read("docs/release.md");
    expect(foundation).toContain("[Index pack](decisions/23-index-pack.md)");
    expect(readme).toContain("expanded-typescript-agent-benchmark-results-2026-08-24.md");
    expect(release).toContain("expanded-typescript-agent-benchmark-results-2026-08-24.md");
  });

  it("publishes only current architecture decisions, without rejected drafts or implementation diaries", async () => {
    const decisionNames = (await readdir("docs/decisions")).filter((name) => name.endsWith(".md")).sort();
    expect(decisionNames).not.toContain("18-semantic-model-pack.md");
    expect(decisionNames).toContain("18-semantic-model-provisioning.md");
    await expect(access("docs/decisions/18-semantic-model-pack.md")).rejects.toThrow();

    const decisions = (await Promise.all(decisionNames.map((name) => read(`docs/decisions/${name}`)))).join("\n");
    expect(decisions).not.toMatch(/Status:\s*\*\*Rejected/u);
    expect(decisions).not.toMatch(/^## (?:Proposed decision|Open questions|Fix:|Historical fix:)/mu);
    expect(decisions).not.toMatch(/retained as the rejected draft/u);
    expect(decisions).not.toMatch(/supersedes the [^\n]+ story below/u);

    const foundation = await read("docs/product-foundation.md");
    expect(foundation).not.toContain("Historical rejected or superseded outcomes");
    expect(foundation).not.toContain("18-semantic-model-pack.md");
    expect(foundation).not.toContain("Rejected; outcome recorded");
    expect(foundation).toContain("[Semantic model provisioning](decisions/18-semantic-model-provisioning.md)");
  });
});
