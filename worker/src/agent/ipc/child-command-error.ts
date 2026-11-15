/** Shared error identity for real child IPC clients. This leaf has no process
 * launcher, executable selection or inherited environment behavior. */
export class ChildCommandError extends Error {
  constructor(
    readonly code: string,
    readonly summary?: string,
  ) {
    super(
      summary
        ? `Worker child command failed: ${code} (${summary})`
        : `Worker child command failed: ${code}`,
    );
    this.name = "ChildCommandError";
  }
}
