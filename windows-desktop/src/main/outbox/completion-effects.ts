export interface CompletionEffects {
  /** Captured real first-play continuation; it owns its window/owner fences. */
  playback(): Promise<void>;
  /** Stage only with deferUntilPlayback=true. Actual voice-playing proof owns release. */
  publication(): Promise<void>;
  publicationFailed?(code: string): void;
}
/** Optional publication cannot serialize first playback. The caller retains the
 * returned promise so neither effect can outlive its real Host/shutdown barrier. */
export async function runCompletionEffects(
  effects: CompletionEffects,
): Promise<void> {
  const begin = (work: () => Promise<void>): Promise<void> => {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const playing = begin(effects.playback),
    staging = begin(effects.publication);
  const [playback, publication] = await Promise.allSettled([playing, staging]);
  if (publication.status === "rejected") {
    try {
      // Shape is not provenance: an uppercase token-looking Error.message is
      // still arbitrary private material. Only this fixed public code escapes.
      effects.publicationFailed?.("COMMUNITY_PUBLICATION_FAILED");
    } catch {
      /* Presentation cannot change playback/account capture authority. */
    }
  }
  if (playback.status === "rejected") throw playback.reason;
}
