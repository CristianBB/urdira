export const NATIVE_TARGETS: Readonly<Record<string, string>>;
export function hostNativeTarget(platform?: string, architecture?: string): string | undefined;
export function nativeArtifactNames(target: string): { readonly addon: string; readonly worker: string; readonly indexing_core_worker: string; readonly launcher: string; readonly node: string };
export function inspectNativeArtifacts(root: string, target: string): Promise<{ readonly target: string; readonly rust_target: string; readonly paths: Readonly<Record<string, string>>; readonly digests: Readonly<Record<string, string>>; readonly errors: readonly string[] }>;
export function stageNativeArtifacts(input: { artifactRoot: string; stageRoot: string; target: string }): Promise<Record<string, unknown>>;
