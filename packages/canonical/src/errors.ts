export type CanonicalEncodingPhase = "decode" | "normalize" | "schema_validation" | "recipe_validation" | "hash" | "verify";

export interface CanonicalEncodingErrorDetails {
  readonly [key: string]: unknown;
}

export class CanonicalEncodingError extends Error {
  readonly code: string;
  readonly phase: CanonicalEncodingPhase;
  readonly details: CanonicalEncodingErrorDetails;

  constructor(code: string, phase: CanonicalEncodingPhase, details: CanonicalEncodingErrorDetails = {}, message = code) {
    super(message);
    this.name = "CanonicalEncodingError";
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

export function fail(
  code: string,
  phase: CanonicalEncodingPhase,
  details: CanonicalEncodingErrorDetails,
  message = code,
): never {
  throw new CanonicalEncodingError(code, phase, details, message);
}
