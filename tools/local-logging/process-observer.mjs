import { randomUUID } from "node:crypto";
/** Observe owned startup/fatal output without persisting arbitrary error strings. */
export function processObserver({
  endpoint,
  key,
  enabled = true,
  transport = fetch,
}) {
  const instanceId = randomUUID(),
    queue = [],
    stats = { sent: 0, dropped: 0, failed: 0, pending: 0 };
  let draining;
  async function drain() {
    while (queue.length) {
      const body = queue.shift();
      try {
        const response = await transport(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-musicmute-log-key": key,
          },
          body,
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) stats.sent++;
        else stats.failed++;
        await response.body?.cancel();
      } catch {
        stats.failed++;
      } finally {
        stats.pending--;
      }
    }
  }
  function pump() {
    if (!draining)
      draining = drain().finally(() => {
        draining = undefined;
        if (queue.length) pump();
      });
  }
  function emit(stream, line) {
    if (
      !enabled ||
      !line ||
      /^\[[\w-]+\] (?:debug|info|warn|error) /.test(line)
    )
      return;
    const level = /\b(?:error|fatal|panic|failed)\b/i.test(line)
      ? "error"
      : /\bwarn(?:ing)?\b/i.test(line)
        ? "warn"
        : "info";
    if (queue.length >= 64) {
      const index =
        level !== "info"
          ? queue.findIndex((entry) => JSON.parse(entry).level === "info")
          : -1;
      stats.dropped++;
      if (index < 0) return;
      queue.splice(index, 1);
      stats.pending--;
    }
    queue.push(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        instanceId,
        level,
        name: "process.output",
        category: "process",
        summary: "Owned process output observed",
        data: {
          stream,
          bytes: Buffer.byteLength(line),
          omitted: "unstructured_process_text",
        },
        operation: "process.output",
      }),
    );
    stats.pending++;
    pump();
  }
  return {
    emit,
    stats,
    async close() {
      while (draining) await draining;
    },
  };
}
