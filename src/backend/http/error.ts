export class BackendError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}
