import type {
  ConsumerUpdateController,
  ConsumerUpdateReview,
} from "./controller.js";
import type { ConsumerUpdateLifecycle } from "./desktop-lifecycle.js";
import type {
  ConsumerUpdateView,
  ConsumerUpdateSource,
} from "../../shared/update-contracts.js";
import { StoreFleetAdvancedUpdates } from "./store-advanced.js";

export type AdvancedConsumerUpdates = Pick<
  ConsumerUpdateController,
  "check" | "install" | "recover"
>;
export interface FleetAdvancedUpdates {
  check(
    signal: AbortSignal,
    source?: ConsumerUpdateSource,
  ): Promise<ConsumerUpdateView>;
  install(
    signal: AbortSignal,
    source?: ConsumerUpdateSource,
    review?: ConsumerUpdateReview,
  ): Promise<ConsumerUpdateView>;
  recover(signal: AbortSignal): Promise<ConsumerUpdateView>;
}

/** Reuse the desktop updater lane without retiring its caller during Advanced's
 * durable journal/finally work. Settlement must be scheduled outside the IPC
 * command lane, after executeCommand has settled. */
export function createFleetAdvancedUpdateDispatch(options: {
  lifecycle: ConsumerUpdateLifecycle;
  resolveUpdates(
    signal: AbortSignal,
  ): Promise<AdvancedConsumerUpdates | StoreFleetAdvancedUpdates | null>;
}) {
  const commands = new Set<Promise<unknown>>();
  let pending = false,
    updating = false,
    settlement: Promise<void> | undefined;
  const dispatch = (
    action: keyof AdvancedConsumerUpdates,
    signal: AbortSignal,
    source: ConsumerUpdateSource = "app",
    review?: ConsumerUpdateReview,
  ): Promise<ConsumerUpdateView> => {
    if (pending) return Promise.reject(new Error("UPDATE_BUSY"));
    return options.lifecycle.execute(async () => {
      pending = true;
      updating = true;
      try {
        signal.throwIfAborted();
        const updates = await options.resolveUpdates(signal);
        signal.throwIfAborted();
        if (!updates) throw new Error("UPDATE_UNAVAILABLE");
        if (updates instanceof StoreFleetAdvancedUpdates) {
          if (action === "check")
            return await StoreFleetAdvancedUpdates.prototype.check.call(
              updates,
              signal,
              source,
            );
          if (action === "install")
            return await StoreFleetAdvancedUpdates.prototype.install.call(
              updates,
              signal,
              source,
              review,
            );
          return await StoreFleetAdvancedUpdates.prototype.recover.call(
            updates,
            signal,
          );
        }
        if (action === "check")
          return await updates.check(signal, false, source);
        if (action === "install")
          return await updates.install(signal, source, review);
        return await updates.recover(signal);
      } finally {
        updating = false;
      }
    });
  };
  return {
    updates: {
      check: (
        signal = new AbortController().signal,
        source: ConsumerUpdateSource = "app",
      ) => dispatch("check", signal, source),
      install: (
        signal = new AbortController().signal,
        source: ConsumerUpdateSource = "app",
        review?: ConsumerUpdateReview,
      ) => dispatch("install", signal, source, review),
      recover: (signal = new AbortController().signal) =>
        dispatch("recover", signal),
    },
    executeCommand<T>(work: () => Promise<T>): Promise<T> {
      const command = Promise.resolve().then(work);
      commands.add(command);
      const finished = () => commands.delete(command);
      void command.then(finished, finished);
      return command;
    },
    needsSettlement(): boolean {
      return pending;
    },
    commandActive(): boolean {
      return commands.size > 0;
    },
    updateCommandActive(): boolean {
      return updating && commands.size > 0;
    },
    settle(work: () => Promise<void>): Promise<void> {
      if (settlement) return settlement;
      const task = Promise.resolve()
        .then(async () => {
          // The updater method can finish before Advanced writes its final
          // journal and clears active. Closing the factory then would self-wait.
          while (commands.size) await Promise.allSettled(commands);
          if (!pending) return;
          await options.lifecycle.settle(work);
          pending = false;
        })
        .finally(() => {
          if (settlement === task) settlement = undefined;
        });
      settlement = task;
      return task;
    },
  };
}
