import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import type { CloudScratchAdmission } from "../cloud/workspace.js";
import type { WindowsDiagnosticIdentity } from "../../shared/diagnostics-contracts.js";
import { WindowsDiagnosticJournal } from "./journal.js";
import { WindowsDiagnosticDoctorRunner } from "./doctor.js";
import {
  WindowsDiagnosticsController,
  type DiagnosticsOsPort,
} from "./controller.js";
/** Personal diagnostics remain current-user/local. No backend, telemetry SDK or worker credentials are read. */
export function createWindowsDiagnostics(options: {
  host: HostContext;
  identity: WindowsDiagnosticIdentity;
  operations: Pick<WindowsPreparationOperations, "snapshotMediaTools">;
  storage: CloudScratchAdmission;
  os: DiagnosticsOsPort;
}) {
  const journal = new WindowsDiagnosticJournal(options.host, options.identity),
    doctor = new WindowsDiagnosticDoctorRunner(
      options.host,
      options.operations,
      options.storage,
    ),
    controller = new WindowsDiagnosticsController(journal, doctor, options.os);
  return {
    journal,
    doctor,
    controller,
    record: (input: unknown, verifiedModelSha256?: string) =>
      journal.record(input, verifiedModelSha256),
    activity: () => {
      const disk = journal.activity(),
        operation = controller.activity(),
        native = doctor.activity();
      return {
        pending: disk.pending + operation.pending + native.pending,
        retained: native.retained,
        idle: disk.idle && operation.idle && native.idle,
      };
    },
    subscribeActivity: (listener: () => void) => {
      const unlisten = [
        journal.subscribeActivity(listener),
        controller.subscribeActivity(listener),
        doctor.subscribeActivity(listener),
      ];
      return () => {
        for (const stop of unlisten) stop();
      };
    },
    async close() {
      await controller.dispose();
      await doctor.recover();
      await journal.close();
    },
  };
}
