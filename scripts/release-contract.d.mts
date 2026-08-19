export const SUPPORTED_TARGETS: readonly string[];
export const PRODUCTION_PACKAGE_NAMES: readonly string[];
export const FORBIDDEN_PRODUCTION_PATTERNS: readonly RegExp[];
export const RELEASE_GATES: readonly string[];
export function readReleaseConfig(configPath?: string): Promise<Record<string, unknown>>;
export function validateReleaseConfig(config: Record<string, unknown>): string[];
export function buildReleaseMetadata(input: { gitCommit: string; lockfileDigest: string; generatedAt?: string }): Record<string, unknown>;
export function sha256(bytes: Uint8Array | string): string;
