export interface NativeLogicalValueDigestInput {
  readonly domain: string;
  readonly value: unknown;
}

export interface NativeLogicalValueVerificationInput extends NativeLogicalValueDigestInput {
  readonly expected_digest: string;
}

export interface NativeLogicalDigestResult {
  readonly digest: string;
  readonly byte_length: number;
}

export interface NativeLogicalVerificationResult {
  readonly valid: boolean;
  readonly actual_digest: string;
  readonly byte_length: number;
}

/** Composition-owned native port. The engine never loads platform artifacts
 * itself and never retains values beyond the synchronous batch call. */
export interface NativeLogicalDigestPort {
  logicalValueDigestBatch(records: readonly NativeLogicalValueDigestInput[]): readonly NativeLogicalDigestResult[];
  verifyLogicalValueBatch(records: readonly NativeLogicalValueVerificationInput[]): readonly NativeLogicalVerificationResult[];
}

let activePort: NativeLogicalDigestPort | undefined;

/** Selects one already validated native binding for publication. Passing
 * `undefined` restores the TypeScript oracle path used by non-native tests and
 * development builds. A selected port is never treated as an optional
 * optimization: errors and malformed results propagate fail-closed. */
export function configureNativeLogicalDigestPort(port: NativeLogicalDigestPort | undefined): void {
  activePort = port;
}

function digestText(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

function validByteLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function digestNativeLogicalValueBatch(
  records: readonly NativeLogicalValueDigestInput[],
): readonly NativeLogicalDigestResult[] | undefined {
  const port = activePort;
  if (port === undefined || records.length === 0) return undefined;
  const results = port.logicalValueDigestBatch(records);
  if (results.length !== records.length) {
    throw new Error(`Native logical digest batch returned ${results.length} results for ${records.length} records.`);
  }
  for (const result of results) {
    if (!digestText(result.digest) || !validByteLength(result.byte_length)) {
      throw new Error("Native logical digest batch returned a malformed result.");
    }
  }
  return results;
}

export function verifyNativeLogicalValueBatch(
  records: readonly NativeLogicalValueVerificationInput[],
): readonly NativeLogicalVerificationResult[] | undefined {
  const port = activePort;
  if (port === undefined || records.length === 0) return undefined;
  const results = port.verifyLogicalValueBatch(records);
  if (results.length !== records.length) {
    throw new Error(`Native logical digest verification returned ${results.length} results for ${records.length} records.`);
  }
  for (const result of results) {
    if (typeof result.valid !== "boolean" || !digestText(result.actual_digest) || !validByteLength(result.byte_length)) {
      throw new Error("Native logical digest verification returned a malformed result.");
    }
  }
  return results;
}
