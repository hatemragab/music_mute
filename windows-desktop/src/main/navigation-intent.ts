import { SECTIONS, type Section } from "../shared/contracts.js";
import type { SectionStore } from "./section-store.js";

export interface NavigationIntentToken {
  readonly section: Section;
}

/** Explicit presentation intent is independent of unrelated snapshot updates. */
export class NavigationIntentCoordinator {
  private intent: NavigationIntentToken | undefined;
  private restoration: object | undefined;

  record(section: Section): NavigationIntentToken {
    if (!SECTIONS.includes(section)) throw new Error("INVALID_REQUEST");
    this.intent = Object.freeze({ section });
    return this.intent;
  }

  current(token: NavigationIntentToken): boolean {
    return this.intent === token;
  }

  hasIntent(): boolean {
    return this.intent !== undefined;
  }

  async restore(
    store: Pick<SectionStore, "read" | "write">,
    publish: (section: Section) => void,
  ): Promise<void> {
    const restoration = {};
    this.restoration = restoration;
    try {
      if (!this.intent) {
        const saved = await store.read();
        if (this.restoration !== restoration) return;
        if (!this.intent) {
          publish(saved);
          // Publishing may synchronously admit a newer explicit navigation.
          if (!this.intent) return;
        }
      }
      while (this.restoration === restoration && this.intent) {
        const token = this.intent;
        await store.write(token.section);
        if (this.restoration !== restoration) return;
        if (!this.current(token)) continue;
        publish(token.section);
        if (this.current(token)) return;
      }
    } finally {
      if (this.restoration === restoration) this.restoration = undefined;
    }
  }
}
