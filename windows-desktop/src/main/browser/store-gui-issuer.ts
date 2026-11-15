import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { arch, pid as guiPid, platform } from "node:process";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";

export const STORE_GUI_ISSUER_TIMEOUT_MS = 30_000;
export const STORE_GUI_ISSUER_MAX_FRAME = 2_048;
const AUTHORITY = Symbol("live-store-gui-bootstrap-issuer");
const NONCE = /^[a-f0-9]{64}$/u;
const DENIED = "STORE_GUI_ISSUER_DENIED";
interface Claim {
  readonly version: 1;
  readonly nonce: string;
  readonly pid: number;
  readonly creation_time: string;
}
function denied(): never {
  throw new Error(DENIED);
}
function validPid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 2_147_483_647
  );
}
function validBirth(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d{1,19}$/u.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn
  );
}
/** Receiving grammar only. Parsed JSON cannot create an issuer or a claim. */
export function parseStoreGuiIssuerFrame(
  bytes: Uint8Array,
  expectedNonce: string,
  expectedPid: number,
): Claim {
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 2 ||
      bytes.length > STORE_GUI_ISSUER_MAX_FRAME ||
      !NONCE.test(expectedNonce) ||
      !validPid(expectedPid)
    )
      denied();
    const frame = Buffer.from(bytes);
    if (frame.indexOf(10) !== frame.length - 1 || frame.includes(13)) denied();
    const value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        frame.subarray(0, -1),
      ),
      STORE_GUI_ISSUER_MAX_FRAME,
      16,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) denied();
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) => !["version", "nonce", "pid", "creation_time"].includes(key),
      ) ||
      row.version !== 1 ||
      typeof row.nonce !== "string" ||
      !NONCE.test(row.nonce) ||
      !timingSafeEqual(
        Buffer.from(row.nonce, "ascii"),
        Buffer.from(expectedNonce, "ascii"),
      ) ||
      !validPid(row.pid) ||
      row.pid !== expectedPid ||
      !validBirth(row.creation_time)
    )
      denied();
    return Object.freeze({
      version: 1,
      nonce: row.nonce,
      pid: row.pid,
      creation_time: row.creation_time,
    });
  } catch {
    return denied();
  }
}

/** One-use GUI-owned endpoint. No caller supplies its path, nonce or transport.
 * The native peer separately verifies actual server PID, protected GUI code,
 * logon and package generation before sending its own held PID/birth. */
export class StoreGuiBootstrapIssuer {
  #nonce = randomBytes(32).toString("hex");
  #server: Server;
  #socket: Socket | undefined;
  #connections = new Set<Socket>();
  #expectedPid: number | undefined;
  #buffer = Buffer.alloc(0);
  #received = false;
  #ackWritten = false;
  #claimValue: Claim | undefined;
  #claim: Promise<Claim>;
  #resolveClaim!: (claim: Claim) => void;
  #rejectClaim!: (error: Error) => void;
  #failure: Error | undefined;
  #confirmStarted = false;
  #confirmed = false;
  #closed = false;
  #cleanup: Promise<void> | undefined;
  #timer: NodeJS.Timeout;

  private constructor(token: symbol) {
    if (token !== AUTHORITY) denied();
    this.#claim = new Promise((resolve, reject) => {
      this.#resolveClaim = resolve;
      this.#rejectClaim = reject;
    });
    // A caller may close before it awaits confirmation; cancellation still
    // rejects any future confirmation without an unhandled rejection.
    void this.#claim.catch(() => undefined);
    this.#server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#accept(socket),
    );
    this.#server.on("error", () => this.#fail());
    this.#timer = setTimeout(() => this.#fail(), STORE_GUI_ISSUER_TIMEOUT_MS);
    this.#timer.unref();
    Object.freeze(this);
  }

  static async open(): Promise<StoreGuiBootstrapIssuer> {
    if (
      arguments.length !== 0 ||
      platform !== "win32" ||
      arch !== "x64" ||
      !validPid(guiPid)
    )
      throw new Error("STORE_GUI_ISSUER_UNSUPPORTED_HOST");
    const issuer = new StoreGuiBootstrapIssuer(AUTHORITY);
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = () => reject(new Error(DENIED));
        issuer.#server.once("error", failed);
        issuer.#server.listen(
          `\\\\.\\pipe\\MusicMuteStoreGuiBootstrap-${guiPid}-${issuer.#nonce}`,
          () => {
            issuer.#server.removeListener("error", failed);
            if (issuer.#failure || issuer.#closed) reject(new Error(DENIED));
            else resolve();
          },
        );
      });
      return issuer;
    } catch {
      await issuer.close();
      return denied();
    }
  }

  /** Bind the real transport child once, before sending store_boot. */
  bindSpawnedProcess(childPid: number): string {
    if (
      arguments.length !== 1 ||
      !validPid(childPid) ||
      childPid === guiPid ||
      this.#expectedPid !== undefined ||
      this.#failure ||
      this.#closed
    ) {
      this.#fail();
      return denied();
    }
    this.#expectedPid = childPid;
    return this.#nonce;
  }

  /** Only a matching later parsed native boot identity consumes the claim. */
  async confirmBootHelper(
    childPid: number,
    creationTime: string,
  ): Promise<void> {
    if (
      arguments.length !== 2 ||
      !validPid(childPid) ||
      !validBirth(creationTime) ||
      this.#expectedPid !== childPid ||
      this.#confirmStarted ||
      this.#failure ||
      this.#closed
    ) {
      this.#fail();
      await this.#retire();
      return denied();
    }
    this.#confirmStarted = true;
    try {
      const claim = await this.#claim;
      if (
        this.#failure ||
        this.#closed ||
        claim.pid !== childPid ||
        claim.creation_time !== creationTime
      )
        denied();
      this.#confirmed = true;
      await this.#retire();
    } catch {
      this.#fail();
      await this.#retire();
      return denied();
    }
  }

  close(): Promise<void> {
    if (!this.#confirmed) this.#fail();
    return this.#retire();
  }

  #accept(socket: Socket) {
    // Even a connection rejected before enrollment can report a late OS error.
    socket.on("error", () => this.#fail());
    if (
      this.#failure ||
      this.#closed ||
      this.#socket ||
      this.#expectedPid === undefined
    ) {
      socket.destroy();
      this.#fail();
      return;
    }
    this.#socket = socket;
    this.#connections.add(socket);
    socket.on("end", () => {
      if (!this.#ackWritten) this.#fail();
    });
    socket.on("close", (hadError) => {
      this.#connections.delete(socket);
      if (this.#failure || this.#closed) return;
      if (hadError || !this.#ackWritten || !this.#claimValue) this.#fail();
      else this.#resolveClaim(this.#claimValue);
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.#failure || this.#closed) return;
      if (
        this.#received ||
        this.#buffer.length + chunk.length > STORE_GUI_ISSUER_MAX_FRAME
      ) {
        this.#fail();
        return;
      }
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      if (this.#buffer.indexOf(10) < 0) return;
      try {
        const claim = parseStoreGuiIssuerFrame(
          this.#buffer,
          this.#nonce,
          this.#expectedPid!,
        );
        this.#received = true;
        this.#claimValue = claim;
        this.#buffer.fill(0);
        this.#buffer = Buffer.alloc(0);
        const ack =
          JSON.stringify({
            version: 1,
            accepted: true,
            nonce: claim.nonce,
            pid: claim.pid,
            creation_time: claim.creation_time,
          }) + "\n";
        socket.write(ack, (error) => {
          if (error || this.#failure || this.#closed) {
            this.#fail();
            return;
          }
          this.#ackWritten = true;
          // Complete ACK then actual EOF: the native client validates both
          // before closing its transient handle and returning store_boot.
          socket.end(() => socket.destroy());
        });
      } catch {
        this.#fail();
      }
    });
  }

  #fail() {
    if (this.#closed) return;
    this.#failure ??= new Error(DENIED);
    this.#rejectClaim(this.#failure);
    void this.#retire();
  }

  #retire(): Promise<void> {
    if (this.#cleanup) return this.#cleanup;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    this.#nonce = "";
    this.#cleanup = new Promise<void>((resolve) =>
      this.#server.close(() => resolve()),
    );
    return this.#cleanup;
  }
}
