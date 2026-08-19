export class StorageError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean | undefined>>;

  constructor(code: string, message: string, details: Readonly<Record<string, string | number | boolean | undefined>> = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.details = details;
  }
}
