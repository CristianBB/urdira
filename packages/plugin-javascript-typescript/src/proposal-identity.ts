import { createHash } from "node:crypto";

function updateLengthFramedUtf8(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function boundedIdentity(prefix: string, domain: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(`${domain}\0`, "utf8");
  for (const value of values) updateLengthFramedUtf8(hash, value);
  return `${prefix}${hash.digest("hex")}`;
}

/** Bounded identity shared by the TypeScript conformance path and Rust. */
export function javascriptTypescriptProposalRecordKey(identityKey: string): string {
  return boundedIdentity("jsts:record:sha256:", "urdira:jsts-proposal-record:v1", [identityKey]);
}

/** Bounded identity shared by the TypeScript conformance path and Rust. */
export function javascriptTypescriptProposedDependencyId(relationId: string, artifactVersionId: string): string {
  return boundedIdentity("jsts:dependency:sha256:", "urdira:jsts-proposed-dependency:v1", [relationId, artifactVersionId]);
}
