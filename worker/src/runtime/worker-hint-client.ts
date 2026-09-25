import { Buffer } from "node:buffer";

const HINT_TYPES = new Set([
  "work_available",
  "policy_changed",
  "command_available",
]);

interface HintTicketSource {
  hintTicket(
    signal?: AbortSignal,
  ): Promise<{ socketUrl: string; ticket: string; expiresAt: string }>;
}

export class WorkerHintClient {
  private readonly stopping = new AbortController();
  private socket: WebSocket | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly source: HintTicketSource,
    private readonly onHint: () => void,
  ) {}

  start(signal?: AbortSignal): void {
    if (this.loop) return;
    signal?.addEventListener("abort", () => this.stopping.abort(), {
      once: true,
    });
    this.loop = this.run().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    closeSocket(this.socket, 1000, "worker stopping");
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    let delayMs = 1_000;
    while (!this.stopping.signal.aborted) {
      try {
        const ticket = await this.source.hintTicket(this.stopping.signal);
        await this.listen(ticket.socketUrl, ticket.ticket);
        delayMs = 1_000;
      } catch {
        if (this.stopping.signal.aborted) break;
      }
      await abortableDelay(delayMs, this.stopping.signal);
      delayMs = Math.min(30_000, Math.round(delayMs * 1.8));
    }
  }

  private listen(socketUrl: string, ticket: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = new WebSocket(socketUrl, [
        "musicmute.worker-hint.v1",
        `ticket.${ticket}`,
      ]);
      this.socket = socket;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(handshakeTimeout);
        if (this.socket === socket) this.socket = null;
        resolve();
      };
      const handshakeTimeout = setTimeout(() => {
        finish();
        closeSocket(socket, 1000, "handshake timeout");
      }, 10_000);
      socket.addEventListener("open", () => {
        if (finished) closeSocket(socket, 1000, "handshake timeout");
      });
      socket.addEventListener("close", finish, { once: true });
      socket.addEventListener("error", finish, { once: true });
      socket.addEventListener("message", (event) => {
        if (
          typeof event.data !== "string" ||
          Buffer.byteLength(event.data, "utf8") > 1_024
        ) {
          closeSocket(socket, 1008, "invalid hint");
          return;
        }
        try {
          const hint = JSON.parse(event.data) as Record<string, unknown>;
          if (
            Object.keys(hint).length !== 3 ||
            !HINT_TYPES.has(String(hint.type)) ||
            !Number.isSafeInteger(hint.revision) ||
            typeof hint.sentAt !== "string" ||
            !Number.isFinite(Date.parse(hint.sentAt))
          ) {
            closeSocket(socket, 1008, "invalid hint");
            return;
          }
          this.onHint();
        } catch {
          closeSocket(socket, 1008, "invalid hint");
        }
      });
      if (this.stopping.signal.aborted)
        closeSocket(socket, 1000, "worker stopping");
    });
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
    // A native WebSocket cannot close while its handshake is still pending.
  }
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
