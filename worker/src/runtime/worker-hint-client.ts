import { Buffer } from "node:buffer";

const HINT_TYPES = new Set([
  "work_available",
  "policy_changed",
  "command_available",
]);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 60_000;
const MIN_RETRY_MS = 1_000;
const MIN_JITTERED_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

interface HintTicketSource {
  hintTicket(
    signal?: AbortSignal,
  ): Promise<{ socketUrl: string; ticket: string; expiresAt: string }>;
}

interface WorkerHintClientOptions {
  socket?: (url: string, protocols: string[]) => WebSocket;
  now?: () => number;
  random?: () => number;
}

export class WorkerHintClient {
  private readonly stopping = new AbortController();
  private socket: WebSocket | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly source: HintTicketSource,
    private readonly onHint: () => void,
    private readonly options: WorkerHintClientOptions = {},
  ) {}

  start(signal?: AbortSignal): void {
    if (this.loop) return;
    if (signal?.aborted) this.stopping.abort();
    const stop = () => this.stopping.abort();
    signal?.addEventListener("abort", stop, { once: true });
    this.loop = this.run()
      .catch(() => undefined)
      .finally(() => signal?.removeEventListener("abort", stop));
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    closeSocket(this.socket, 1000, "worker stopping");
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    let delayMs = MIN_RETRY_MS;
    while (!this.stopping.signal.aborted) {
      let stable = false;
      try {
        const ticket = await this.source.hintTicket(this.stopping.signal);
        if (this.stopping.signal.aborted) break;
        const connectedMs = await this.listen(ticket.socketUrl, ticket.ticket);
        stable = connectedMs >= STABLE_CONNECTION_MS;
        if (stable) delayMs = MIN_RETRY_MS;
      } catch {
        if (this.stopping.signal.aborted) break;
      }
      await abortableDelay(this.retryDelay(delayMs), this.stopping.signal);
      if (!stable) delayMs = Math.min(MAX_RETRY_MS, Math.round(delayMs * 1.8));
    }
  }

  private listen(socketUrl: string, ticket: string): Promise<number> {
    return new Promise((resolve) => {
      const socket = (
        this.options.socket ??
        ((url, protocols) => new WebSocket(url, protocols))
      )(socketUrl, ["musicmute.worker-hint.v1", `ticket.${ticket}`]);
      this.socket = socket;
      let finished = false;
      let openedAt: number | null = null;
      const stop = () => {
        closeSocket(socket, 1000, "worker stopping");
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(handshakeTimeout);
        this.stopping.signal.removeEventListener("abort", stop);
        if (this.socket === socket) this.socket = null;
        resolve(
          openedAt === null
            ? 0
            : Math.max(0, (this.options.now ?? Date.now)() - openedAt),
        );
      };
      const handshakeTimeout = setTimeout(() => {
        closeSocket(socket, 1000, "handshake timeout");
      }, HANDSHAKE_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (finished) {
          closeSocket(socket, 1000, "handshake timeout");
          return;
        }
        clearTimeout(handshakeTimeout);
        openedAt = (this.options.now ?? Date.now)();
      });
      socket.addEventListener("close", finish, { once: true });
      socket.addEventListener(
        "error",
        () => closeSocket(socket, 4000, "socket error"),
        { once: true },
      );
      socket.addEventListener("message", (event) => {
        if (finished || this.stopping.signal.aborted) return;
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data, "utf8") > 1_024
        ) {
          closeSocket(socket, 4000, "invalid hint");
          return;
        }
        let hint: Record<string, unknown>;
        try {
          hint = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          closeSocket(socket, 4000, "invalid hint");
          return;
        }
        if (
          hint === null ||
          typeof hint !== "object" ||
          Array.isArray(hint) ||
          Object.keys(hint).length !== 3 ||
          typeof hint.type !== "string" ||
          !HINT_TYPES.has(hint.type) ||
          !Number.isSafeInteger(hint.revision) ||
          typeof hint.sentAt !== "string" ||
          !Number.isFinite(Date.parse(hint.sentAt))
        ) {
          closeSocket(socket, 4000, "invalid hint");
          return;
        }
        try {
          this.onHint();
        } catch {
          // Hints are opportunistic; a local wake listener cannot own the transport.
        }
      });
      this.stopping.signal.addEventListener("abort", stop, { once: true });
      if (this.stopping.signal.aborted) stop();
    });
  }

  private retryDelay(delayMs: number): number {
    const random = (this.options.random ?? Math.random)();
    return Math.min(
      MAX_RETRY_MS,
      Math.max(
        MIN_JITTERED_RETRY_MS,
        Math.round(delayMs * (0.8 + random * 0.4)),
      ),
    );
  }
}

function closeSocket(
  socket: WebSocket | null,
  code: number,
  reason: string,
): void {
  if (socket === null || socket.readyState >= WebSocket.CLOSING) return;
  try {
    socket.close(code, reason);
  } catch {
    // Closing is best effort; only the close event permits a replacement.
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
