export class LocalSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalSetupError";
  }
}
