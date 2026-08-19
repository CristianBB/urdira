export class EngineError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "EngineError";
  }
}

/** An {@link EngineError} that carries structured detail fields (candidate ids, pointers, etc.) alongside the registered error code, for callers that want to report *why* a selector/guard failed rather than just fail silently. */
export class EngineErrorWithDetails extends EngineError {
  constructor(code: string, message: string, readonly details: Readonly<Record<string, unknown>>) {
    super(code, message);
    this.name = "EngineErrorWithDetails";
  }
}
