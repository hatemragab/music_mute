import {
  STORE_BOOTSTRAP_DIAGNOSTIC_PHASES,
  type ConsumerNativeTransport,
  type StoreBootstrapDiagnostic,
} from "../../../../worker/src/platform/windows/consumer-native-transport.js";
import { PACKAGE_AUTHORITY_PROFILE } from "../../shared/package-build-profile.js";

const PHASES = Object.freeze([
  "entry",
  "desktop-identity",
  "resource-trust",
  "entry-mode",
  "runtime",
  "resource-seal",
  "helper-pin",
  "issuer-open",
  "helper-spawn",
  "native-boot",
  "issuer-confirm",
  "sealed-resources",
  "private-data",
  "account-mutex",
  "account-bind",
  "account-owner",
  "desktop-ready",
  "window-create",
] as const);
type Phase = (typeof PHASES)[number];
interface Observation {
  readonly phase: Phase;
  readonly native: readonly Readonly<StoreBootstrapDiagnostic>[];
}
const observations = new WeakMap<Error, Observation>();
const displayedClosedFailures = new WeakSet<Error>();
const NUMBERS = [
  "code",
  "win32",
  "wait",
  "exit",
  "active",
  "assigned",
  "listed",
] as const;
let desktopPhase: Phase = "entry";
export function markDesktopBootstrapPhase(phase: Phase): void {
  if (PHASES.includes(phase)) desktopPhase = phase;
}
function copyNative(
  value: unknown,
): readonly Readonly<StoreBootstrapDiagnostic>[] {
  if (!Array.isArray(value)) return [];
  const result: Readonly<StoreBootstrapDiagnostic>[] = [];
  for (const candidate of value.slice(0, 4)) {
    if (!candidate || typeof candidate !== "object") continue;
    const fields = Object.getOwnPropertyDescriptors(candidate);
    const phase = fields.phase;
    if (
      !phase ||
      !("value" in phase) ||
      !STORE_BOOTSTRAP_DIAGNOSTIC_PHASES.includes(phase.value)
    )
      continue;
    if (
      NUMBERS.some((name) => {
        const field = fields[name];
        return (
          !field ||
          !("value" in field) ||
          !Number.isInteger(field.value) ||
          field.value < 0 ||
          field.value > (name === "code" ? 11 : 0xffffffff)
        );
      })
    )
      continue;
    result.push(
      Object.freeze({
        phase: phase.value,
        code: fields.code!.value,
        win32: fields.win32!.value,
        wait: fields.wait!.value,
        exit: fields.exit!.value,
        active: fields.active!.value,
        assigned: fields.assigned!.value,
        listed: fields.listed!.value,
      }),
    );
  }
  return Object.freeze(result);
}

/** Observational state only. No result or formatted text grants package, child,
 * cleanup or readiness authority. Production errors retain their generic code. */
export class StoreGuiBootstrapDiagnostics {
  #phase: Phase = "runtime";
  #transport: ConsumerNativeTransport | undefined;
  phase(phase: Phase): void {
    if (PHASES.includes(phase)) this.#phase = phase;
  }
  transport(transport: ConsumerNativeTransport): void {
    this.#transport ??= transport;
  }
  failure(): Error {
    const error = new Error("STORE_AUTHORITY_DENIED");
    if (PACKAGE_AUTHORITY_PROFILE === "local-test-v1") {
      let native: readonly Readonly<StoreBootstrapDiagnostic>[] = [];
      try {
        native = copyNative(this.#transport?.storeBootstrapDiagnostics);
      } catch {
        // Unavailable observations cannot replace the original startup failure.
      }
      observations.set(error, Object.freeze({ phase: this.#phase, native }));
    }
    return error;
  }
  /** Join only the authority's existing retirement. Stderr can arrive after
   * its synchronous onClosed notification, so copy observations after drain. */
  async closedFailure(closing: Promise<unknown>): Promise<Error | undefined> {
    if (PACKAGE_AUTHORITY_PROFILE !== "local-test-v1") return undefined;
    try {
      await closing;
    } catch {
      // Retirement failure remains owned by the original cleanup path.
    }
    return this.failure();
  }
}

/** Independent display only: never starts retirement or changes its result. */
export async function displayDevelopmentClosedFailure(
  read: () => Promise<Error | undefined>,
  display: (text: string) => void,
): Promise<void> {
  if (PACKAGE_AUTHORITY_PROFILE !== "local-test-v1") return;
  try {
    const error = await read();
    if (
      !error ||
      !observations.has(error) ||
      displayedClosedFailures.has(error)
    )
      return;
    const text = developmentBootstrapFailureText(error);
    if (!text) return;
    displayedClosedFailures.add(error);
    display(text);
  } catch {
    // Diagnostics must not affect authority loss, app.quit or cleanup retries.
  }
}

/** Never display arbitrary exception messages, stack traces, stderr or paths. */
export function developmentBootstrapFailureText(
  error: unknown,
): string | undefined {
  if (PACKAGE_AUTHORITY_PROFILE !== "local-test-v1") return undefined;
  const observed = error instanceof Error ? observations.get(error) : undefined;
  const phase = observed?.phase ?? desktopPhase;
  const native = observed?.native ?? [];
  return [
    "Development bootstrap diagnostic (observations only)",
    `TS phase: ${phase}`,
    ...native.map(
      (row) =>
        `Native phase=${row.phase} code=${row.code} win32=${row.win32} wait=${row.wait} exit=${row.exit} active=${row.active} assigned=${row.assigned} listed=${row.listed}`,
    ),
  ].join("\n");
}
