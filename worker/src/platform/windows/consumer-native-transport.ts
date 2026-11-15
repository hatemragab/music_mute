import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { parseStrictJson } from "./consumer-strict-json.js";
import {
  assertConsumerAbsolutePath,
  CONSUMER_NATIVE_ERROR_CODES,
  CONSUMER_NATIVE_MAX_FRAME,
  CONSUMER_NATIVE_VERSION,
  ConsumerNativeError,
  object,
  type ConsumerNativeErrorCode,
} from "./consumer-native-policy.js";
import {
  parseConsumerNativeEvent,
  type ConsumerNativeEvent,
} from "./consumer-native-events.js";

/** Optional development observations only. They never authenticate a helper or
 * alter the control protocol, cleanup, child lifetime or package authority. */
export const STORE_BOOTSTRAP_DIAGNOSTIC_PHASES = Object.freeze([
  "entry-context",
  "entry-self",
  "session-window",
  "session-register",
  "session-network",
  "transport-eof",
  "store-boot",
  "store-startup",
  "store-dispatch",
  "authority",
  "job-create",
  "job-limits",
  "pipe-create",
  "pipe-flags",
  "attribute-list",
  "child-create",
  "child-assign",
  "child-attest",
  "child-check",
  "child-resume",
  "shutdown-input",
  "shutdown-unassigned",
  "shutdown-root",
  "shutdown-kill",
  "shutdown-accounting",
  "shutdown-census",
  "shutdown-confirm",
  "shutdown-timeout",
  "complete",
] as const);
export interface StoreBootstrapDiagnostic {
  readonly phase: (typeof STORE_BOOTSTRAP_DIAGNOSTIC_PHASES)[number];
  readonly code: number;
  readonly win32: number;
  readonly wait: number;
  readonly exit: number;
  readonly active: number;
  readonly assigned: number;
  readonly listed: number;
}
/** Exact ASCII wire grammar; arbitrary stderr, extra fields and numeric aliases
 * are discarded. uint32 max denotes an unobserved native measurement. */
export function parseStoreBootstrapDiagnosticLine(
  bytes: Uint8Array,
): Readonly<StoreBootstrapDiagnostic> | undefined {
  if (bytes.byteLength < 1 || bytes.byteLength > 256) return undefined;
  const text = Buffer.from(bytes).toString("latin1");
  const match =
    /^MMDEV1 phase=([a-z-]+) code=(0|[1-9][0-9]{0,9}) win32=(0|[1-9][0-9]{0,9}) wait=(0|[1-9][0-9]{0,9}) exit=(0|[1-9][0-9]{0,9}) active=(0|[1-9][0-9]{0,9}) assigned=(0|[1-9][0-9]{0,9}) listed=(0|[1-9][0-9]{0,9})\n$/u.exec(
      text,
    );
  if (
    !match ||
    match[0].length !== text.length ||
    !STORE_BOOTSTRAP_DIAGNOSTIC_PHASES.includes(
      match[1] as StoreBootstrapDiagnostic["phase"],
    )
  )
    return undefined;
  const numbers = match.slice(2).map(Number);
  if (
    numbers.some((value) => !Number.isInteger(value) || value > 0xffffffff) ||
    numbers[0]! > 11
  )
    return undefined;
  return Object.freeze({
    phase: match[1] as StoreBootstrapDiagnostic["phase"],
    code: numbers[0]!,
    win32: numbers[1]!,
    wait: numbers[2]!,
    exit: numbers[3]!,
    active: numbers[4]!,
    assigned: numbers[5]!,
    listed: numbers[6]!,
  });
}

export type ConsumerNativeOperation =
  | "store_boot"
  | "store_private_boot"
  | "store_role_owner"
  | "store_role_launch"
  | "store_role_stop"
  | "store_role_inspect"
  | "store_role_peer"
  | "store_worker_discover"
  | "store_worker_code_open"
  | "store_worker_code_check"
  | "store_worker_code_benchmark"
  | "store_worker_code_cleanup_check"
  | "store_worker_code_close"
  | "store_worker_session_activate"
  | "store_session_open"
  | "store_session_presence"
  | "store_fixture_file_open"
  | "store_model_file_open"
  | "store_model_publish"
  | "store_model_recover"
  | "store_qualification_start"
  | "store_qualification_read"
  | "store_qualification_stop"
  | "store_cpu_operation_open"
  | "store_cpu_operation_recover"
  | "store_cpu_operation_bind_data"
  | "store_cpu_operation_inspect"
  | "store_cpu_operation_retire"
  | "store_cpu_prepare_request"
  | "store_cpu_prepare_ready"
  | "store_cpu_prepare_start"
  | "store_cpu_prepare_result"
  | "store_cpu_workspace_marker_retire"
  | "store_cpu_operation_cleanup_inspect"
  | "store_cpu_workspace_marker_acknowledge"
  | "store_cpu_workspace_marker_release"
  | "store_share_start"
  | "store_share_inspect"
  | "store_share_cancel"
  | "store_share_cleanup_acknowledge"
  | "store_share_cleanup_completed"
  | "store_session_command"
  | "store_session_close"
  | "store_session_publish"
  | "store_session_retire_children"
  | "store_legacy_worker_conflict"
  | "store_control_request"
  | "store_control_accept"
  | "store_control_reply"
  | "store_control_ack"
  | "store_control_peer"
  | "store_child_start"
  | "store_tool_start"
  | "store_tool_read"
  | "store_tool_stop"
  | "store_child_read"
  | "store_child_write"
  | "store_child_stop"
  | "store_prepare_request"
  | "store_prepare_result"
  | "store_fleet_workspace_open"
  | "store_fleet_workspace_recover"
  | "store_fleet_workspace_inspect"
  | "store_fleet_workspace_retire"
  | "store_transfer_start"
  | "store_transfer_read"
  | "store_transfer_write"
  | "store_transfer_stop"
  | "store_transfer_inspect"
  | "store_benchmark_request"
  | "store_benchmark_start"
  | "store_benchmark_read"
  | "store_benchmark_stop"
  | "store_benchmark_result"
  | "store_gpu_bind"
  | "store_gpu_acquire"
  | "store_gpu_release"
  | "store_gpu_inspect"
  | "store_inference_idle"
  | "store_retained_engine_register"
  | "store_retained_engine_begin"
  | "store_retained_engine_complete"
  | "store_retained_engine_idle"
  | "store_retained_engine_forget"
  | "store_browser_registration"
  | "store_browser_attach"
  | "store_account_owner_bind"
  | "store_account_ticket_publish"
  | "store_account_ticket_read"
  | "store_account_ticket_claim"
  | "store_account_ticket_remove"
  | "store_account_peer_verify"
  | "store_account_same_gui"
  | "store_account_launch"
  | "store_account_pipe_accept"
  | "store_account_pipe_connect"
  | "store_account_pipe_reply"
  | "store_account_pipe_close"
  | "store_startup"
  | "store_package_lock"
  | "store_package_release"
  | "private_file_open"
  | "private_file_info"
  | "private_file_read"
  | "private_file_write"
  | "private_file_truncate"
  | "private_file_sync"
  | "private_file_close"
  | "cache_delete_begin"
  | "share_workspace_discard"
  | "diagnostic_report_remove"
  | "personal_cleanup_recover"
  | "storage_partial_discard"
  | "library_artifact_discard"
  | "library_tree_discard"
  | "library_tree_cleanup_ack"
  | "library_tree_cleanup_list"
  | "library_local_move"
  | "library_artifact_publish"
  | "library_artifact_publication_inspect"
  | "storage_workspace_marker_retire"
  | "storage_cleanup_ack"
  | "storage_cleanup_recover"
  | "cache_delete_commit"
  | "cache_delete_release"
  | "cache_delete_recover"
  | "runtime_repair_backup_remove"
  | "created_export_discard"
  | "created_export_destination_validate"
  | "created_export_discard_inspect"
  | "created_export_discard_ack"
  | "chrome_extensions_open"
  | "worker_login_peer_verify"
  | "worker_login_idle"
  | "startup_retain"
  | "share_start"
  | "share_inspect"
  | "share_cancel"
  | "share_cleanup_acknowledge"
  | "share_cleanup_completed"
  | "identity"
  | "boot_identity"
  | "process_identity"
  | "wait_process_exit"
  | "account_authority_launch"
  | "account_peer_verify"
  | "browser_owner_proof_peers"
  | "personal_owner_proof_peers"
  | "ensure_private_directory"
  | "validate_path"
  | "vault_put"
  | "vault_get"
  | "vault_delete"
  | "vault_recover"
  | "launch_owned"
  | "stop_owned"
  | "pipe_exchange"
  | "pipe_connect"
  | "pipe_accept"
  | "pipe_reply"
  | "pipe_close"
  | "acquire_mutex"
  | "release_mutex"
  | "singleton_inspect"
  | "singleton_assert_publication"
  | "is_owned_process"
  | "owned_tree_exited"
  | "same_parent_process"
  | "claim_session_ticket"
  | "claim_browser_account_ticket"
  | "startup_inspect"
  | "startup_register"
  | "startup_remove"
  | "legacy_worker_conflict"
  | "launch_session_agent"
  | "launcher_verify"
  | "browser_register"
  | "browser_inspect"
  | "browser_unregister"
  | "installer_verify"
  | "installer_launch"
  | "installer_launch_inspect"
  | "installer_launch_recover"
  | "installer_maintenance_peer_verify"
  | "installer_monitor_remove_completed"
  | "protocol_register"
  | "protocol_unregister"
  | "release_remove_unused"
  | "gpu_inventory"
  | "acquire_gpu_guard"
  | "bind_role_job"
  | "inference_idle"
  | "retained_engine_register"
  | "retained_engine_begin"
  | "retained_engine_complete"
  | "retained_engine_idle"
  | "retained_engine_forget"
  | "release_gpu_guard";

export interface ConsumerNativeTransport {
  readonly storeBootstrapDiagnostics?: readonly Readonly<StoreBootstrapDiagnostic>[];
  request(
    operation: ConsumerNativeOperation,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
  onEvent?(listener: (event: ConsumerNativeEvent) => void): () => void;
  onClosed?(listener: () => void): () => void;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: ConsumerNativeError): void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Exported to test protocol behavior with isolated code fixtures on any host. */
export class ConsumerNativeChildTransport implements ConsumerNativeTransport {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private stderrBytes = 0;
  private readonly stderrLine: number[] = [];
  private stderrDiscarding = false;
  private readonly bootstrapObservations: Readonly<StoreBootstrapDiagnostic>[] =
    [];
  private readonly exit: Promise<void>;
  private eventSequence = 0;
  private readonly eventListeners = new Set<
    (event: ConsumerNativeEvent) => void
  >();
  private readonly closedListeners = new Set<() => void>();
  private readonly events: ConsumerNativeEvent[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exit = new Promise((resolve) => {
      child.once("close", () => {
        this.failAll("HELPER_UNAVAILABLE");
        resolve();
      });
    });
    child.once("error", () => this.abort("HELPER_UNAVAILABLE"));
    child.stdin.on("error", () => this.abort("HELPER_UNAVAILABLE"));
    child.stdout.on("data", (bytes: Buffer) => this.receive(bytes));
    // Drain bounded stderr without forwarding potentially sensitive native text.
    child.stderr.on("data", (bytes: Buffer) => {
      this.stderrBytes += bytes.byteLength;
      if (this.stderrBytes > 32_768) {
        this.abort("FRAME_TOO_LARGE");
        return;
      }
      for (const byte of bytes) {
        if (byte === 10) {
          if (!this.stderrDiscarding && this.bootstrapObservations.length < 4) {
            const observation = parseStoreBootstrapDiagnosticLine(
              Buffer.from([...this.stderrLine, 10]),
            );
            if (observation) this.bootstrapObservations.push(observation);
          }
          this.stderrLine.length = 0;
          this.stderrDiscarding = false;
        } else if (!this.stderrDiscarding) {
          if (this.stderrLine.length < 255) this.stderrLine.push(byte);
          else {
            this.stderrLine.length = 0;
            this.stderrDiscarding = true;
          }
        }
      }
    });
  }
  get storeBootstrapDiagnostics(): readonly Readonly<StoreBootstrapDiagnostic>[] {
    return Object.freeze(
      this.bootstrapObservations.map((value) => Object.freeze({ ...value })),
    );
  }
  /** Actual PID returned by the held OS child handle, never a JSON claim. */
  get spawnedProcessId(): number | undefined {
    return this.child.pid;
  }

  request(
    operation: ConsumerNativeOperation,
    args: Record<string, unknown>,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new ConsumerNativeError("HELPER_UNAVAILABLE"));
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 35_000 ||
      this.pending.size >= 16
    )
      return Promise.reject(new ConsumerNativeError("BAD_REQUEST"));
    const id = ++this.sequence;
    const frame = Buffer.from(
      `${JSON.stringify({ version: CONSUMER_NATIVE_VERSION, id, operation, args })}\n`,
      "utf8",
    );
    if (frame.byteLength > CONSUMER_NATIVE_MAX_FRAME)
      return Promise.reject(new ConsumerNativeError("FRAME_TOO_LARGE"));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.abort("TIMEOUT"), timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(frame, (error) => {
        frame.fill(0);
        if (error) this.abort("HELPER_UNAVAILABLE");
      });
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.failAll("HELPER_UNAVAILABLE");
      this.child.stdin.end();
    }
    const timeout = setTimeout(() => this.child.kill(), 1_000);
    try {
      await this.exit;
    } finally {
      clearTimeout(timeout);
    }
  }
  onEvent(listener: (event: ConsumerNativeEvent) => void): () => void {
    if (this.eventListeners.size >= 32)
      throw new ConsumerNativeError("BAD_REQUEST");
    this.eventListeners.add(listener);
    for (const event of this.events) listener(structuredClone(event));
    return () => {
      this.eventListeners.delete(listener);
    };
  }
  onClosed(listener: () => void): () => void {
    if (this.closedListeners.size >= 32)
      throw new ConsumerNativeError("BAD_REQUEST");
    this.closedListeners.add(listener);
    if (this.closed) listener();
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  private receive(bytes: Buffer): void {
    if (this.closed) return;
    // Process complete lines before bounding the remaining partial frame; a
    // single OS chunk may legitimately contain multiple bounded responses.
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) !== -1) {
      if (index === 0 || index > CONSUMER_NATIVE_MAX_FRAME) {
        this.abort("FRAME_TOO_LARGE");
        return;
      }
      const line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const wire = object(
          parseStrictJson(
            new TextDecoder("utf-8", { fatal: true }).decode(line),
            CONSUMER_NATIVE_MAX_FRAME,
          ),
        );
        if (
          wire.version === CONSUMER_NATIVE_VERSION &&
          Object.hasOwn(wire, "event")
        ) {
          if (Object.keys(wire).sort().join() !== "event,version")
            throw new ConsumerNativeError("PROTOCOL_MISMATCH");
          const event = parseConsumerNativeEvent(wire.event);
          if (event.sequence !== this.eventSequence + 1)
            throw new ConsumerNativeError("PROTOCOL_MISMATCH");
          this.eventSequence = event.sequence;
          this.events.push(event);
          if (this.events.length > 16) this.events.shift();
          for (const listener of this.eventListeners) {
            try {
              listener(structuredClone(event));
            } catch {
              this.eventListeners.delete(listener);
            }
          }
          continue;
        }
        if (
          wire.version !== CONSUMER_NATIVE_VERSION ||
          !Number.isSafeInteger(wire.id) ||
          typeof wire.ok !== "boolean"
        )
          throw new ConsumerNativeError("PROTOCOL_MISMATCH");
        const item = this.pending.get(wire.id as number);
        if (!item) throw new ConsumerNativeError("PROTOCOL_MISMATCH");
        if (wire.ok) {
          if (!Object.hasOwn(wire, "result")) {
            throw new ConsumerNativeError("PROTOCOL_MISMATCH");
          }
          this.pending.delete(wire.id as number);
          clearTimeout(item.timeout);
          item.resolve(wire.result);
        } else {
          const error = object(wire.error);
          if (
            !CONSUMER_NATIVE_ERROR_CODES.includes(
              error.code as ConsumerNativeErrorCode,
            )
          ) {
            throw new ConsumerNativeError("PROTOCOL_MISMATCH");
          }
          this.pending.delete(wire.id as number);
          clearTimeout(item.timeout);
          item.reject(
            new ConsumerNativeError(error.code as ConsumerNativeErrorCode),
          );
        }
      } catch {
        this.abort("PROTOCOL_MISMATCH");
        return;
      } finally {
        line.fill(0);
      }
    }
    if (this.buffer.byteLength > CONSUMER_NATIVE_MAX_FRAME)
      this.abort("FRAME_TOO_LARGE");
  }

  private abort(code: ConsumerNativeErrorCode): void {
    this.failAll(code);
    this.child.kill();
  }
  private failAll(code: ConsumerNativeErrorCode): void {
    const wasClosed = this.closed;
    this.closed = true;
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0);
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new ConsumerNativeError(code));
    }
    this.pending.clear();
    if (!wasClosed)
      for (const listener of this.closedListeners) {
        try {
          listener();
        } catch {
          this.closedListeners.delete(listener);
        }
      }
  }
}

/** The digest must come from an already verified signed consumer inventory. */
export async function createConsumerNativeTransport(
  helperPath: string,
  expectedSha256: string,
): Promise<ConsumerNativeTransport> {
  return createNativeTransport(helperPath, expectedSha256, false);
}

/** This candidate launch grants no authority. The fixed --store-stdio mode
 * must authenticate its actual OS package and held parent before any operation.
 * Deployment hardlinks are accepted only after that native proof; copied or
 * unsigned helpers cannot proceed through the Store boot receiving boundary. */
export async function createStoreConsumerNativeTransport(
  helperPath: string,
  expectedSha256: string,
): Promise<ConsumerNativeChildTransport> {
  return createNativeTransport(helperPath, expectedSha256, true);
}

async function createNativeTransport(
  helperPath: string,
  expectedSha256: string,
  storeCandidate: boolean,
): Promise<ConsumerNativeChildTransport> {
  if (process.platform !== "win32")
    throw new ConsumerNativeError("UNSUPPORTED_HOST");
  assertConsumerAbsolutePath(helperPath);
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  try {
    const info = await lstat(helperPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (!storeCandidate && info.nlink !== 1) ||
      info.nlink < 1 ||
      info.size < 1 ||
      info.size > 16 * 1024 * 1024
    )
      throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
    const bytes = await readFile(helperPath);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
      throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  } catch {
    throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "USERPROFILE",
    "APPDATA",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(helperPath, storeCandidate ? ["--store-stdio"] : [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // No console host may remain beside the fixed helper in a role Job. Node
    // uses DETACHED_PROCESS without BREAKAWAY_FROM_JOB; keep the pipe referenced
    // so EOF, the native parent watcher and the inherited role Job own lifetime.
    detached: true,
    shell: false,
    env,
  });
  return new ConsumerNativeChildTransport(child);
}
