import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_TARGETS, hostNativeTarget, inspectNativeArtifacts, nativeArtifactNames, stageNativeArtifacts } from "../scripts/native-release.mjs";

describe("Rust release artifact closure", () => {
  it("maps the five supported Urdira targets to exact Rust targets", () => {
    expect(NATIVE_TARGETS).toEqual({
      "darwin-arm64": "aarch64-apple-darwin",
      "darwin-x64": "x86_64-apple-darwin",
      "linux-arm64-gnu": "aarch64-unknown-linux-gnu",
      "linux-x64-gnu": "x86_64-unknown-linux-gnu",
      "win32-x64": "x86_64-pc-windows-msvc",
    });
    expect(hostNativeTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostNativeTarget("win32", "arm64")).toBeUndefined();
  });

  it("fails closed when a target closure is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-native-missing-"));
    expect((await inspectNativeArtifacts(root, "linux-x64-gnu")).errors).toHaveLength(4);
  });

  it("stages exactly one target closure and writes its binding manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "urdira-native-artifacts-"));
    const stage = join(root, "stage");
    const source = join(root, "source");
    await mkdir(source);
    for (const name of Object.values(nativeArtifactNames("darwin-arm64"))) await writeFile(join(source, name), `fixture:${name}`);
    const manifest = await stageNativeArtifacts({ artifactRoot: source, stageRoot: stage, target: "darwin-arm64" });
    // S-I bumped NATIVE_API_VERSION 17 -> 18 (resident contiguous vector
    // buffer + single-call native exact top-K); this must track
    // scripts/native-release.mjs's own stageNativeArtifacts.
    expect(manifest).toMatchObject({ target: "darwin-arm64", rust_target: "aarch64-apple-darwin", binding_api: 18, node_api: 10, worker_protocol: "urdira.ipc.v2", build_id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
    expect((await inspectNativeArtifacts(source, "darwin-arm64")).errors).toEqual([]);
  });
});
