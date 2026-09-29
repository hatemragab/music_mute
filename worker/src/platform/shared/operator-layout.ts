/** Files consumed by platform-independent operator commands. */
export interface OperatorLayout {
  workRoot: string;
  logRoot: string;
  runtimeStatusPath: string;
  stdoutPath: string;
  stderrPath: string;
}
