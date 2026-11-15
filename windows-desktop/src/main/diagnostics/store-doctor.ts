import type { HostContext } from "../host-context.js";
import { StoreMediaTools } from "../prepare/store-media-tools.js";
import type { CloudScratchAdmission } from "../cloud/workspace.js";
import type { WindowsDiagnosticIdentity } from "../../shared/diagnostics-contracts.js";
import { WindowsDiagnosticDoctorRunner } from "./doctor.js";
import { WindowsDiagnosticJournal } from "./journal.js";
import {
  WindowsDiagnosticsController,
  type DiagnosticsOsPort,
} from "./controller.js";

/** The common offline Doctor checks fixed tools. Store code verification is
 * provided by the living OS package owner, never a legacy archive receipt. */
export class StoreDiagnosticDoctorRunner {
  #host: HostContext;
  #tools: StoreMediaTools;
  #runner: WindowsDiagnosticDoctorRunner;
  constructor(
    host: HostContext,
    tools: StoreMediaTools,
    storage: CloudScratchAdmission,
  ) {
    StoreMediaTools.prototype.assertHost.call(tools, host);
    this.#host = host;
    this.#tools = tools;
    this.#runner = new WindowsDiagnosticDoctorRunner(host, tools, storage);
  }
  activity() {
    return this.#runner.activity();
  }
  subscribeActivity(listener: () => void) {
    return this.#runner.subscribeActivity(listener);
  }
  async run(full: boolean, signal: AbortSignal) {
    StoreMediaTools.prototype.assertHost.call(this.#tools, this.#host);
    const report = await this.#runner.run(full, signal);
    StoreMediaTools.prototype.assertHost.call(this.#tools, this.#host);
    return {
      ...report,
      checks: report.checks.map((check) =>
        check.name === "signed-runtime" && check.status === "passed"
          ? { ...check, code: "STORE_PACKAGE_INVENTORY_VERIFIED" }
          : check,
      ),
    };
  }
  recover() {
    return this.#runner.recover();
  }
}

export function createStoreDiagnostics(options: {
  host: HostContext;
  identity: WindowsDiagnosticIdentity;
  operations: StoreMediaTools;
  storage: CloudScratchAdmission;
  os: DiagnosticsOsPort;
}) {
  const journal = new WindowsDiagnosticJournal(options.host, options.identity),
    doctor = new StoreDiagnosticDoctorRunner(
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
      const stops = [
        journal.subscribeActivity(listener),
        controller.subscribeActivity(listener),
        doctor.subscribeActivity(listener),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    async close() {
      await controller.dispose();
      await doctor.recover();
      await journal.close();
    },
  };
}
