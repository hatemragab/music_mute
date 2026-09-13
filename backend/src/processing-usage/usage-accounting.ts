export interface UsageEntry {
  state: string;
  audioSeconds: number;
  expiresAt: Date | null;
}
export function summarizeUsage(
  entries: UsageEntry[],
  allowance: number,
  now: Date,
) {
  let reservedAudioSeconds = 0;
  let usedAudioSeconds = 0;
  const replenishments = new Map<string, number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.audioSeconds) || entry.audioSeconds < 0)
      throw new Error('Invalid accounting entry');
    if (
      entry.state === 'reserved' ||
      (entry.state === 'pending' && (!entry.expiresAt || entry.expiresAt > now))
    )
      reservedAudioSeconds += entry.audioSeconds;
    if (
      ['used', 'pending'].includes(entry.state) &&
      entry.expiresAt &&
      entry.expiresAt > now
    ) {
      if (entry.state === 'used') usedAudioSeconds += entry.audioSeconds;
      const at = entry.expiresAt.toISOString();
      replenishments.set(
        at,
        (replenishments.get(at) ?? 0) + entry.audioSeconds,
      );
    }
  }
  return {
    reservedAudioSeconds,
    usedAudioSeconds,
    remainingAudioSeconds: Math.max(
      0,
      allowance - reservedAudioSeconds - usedAudioSeconds,
    ),
    replenishments: [...replenishments]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 100)
      .map(([at, audioSeconds]) => ({ at, audioSeconds })),
  };
}

export function cancellationDebit(
  duration: number,
  execution: number | null,
  ratio: number | null,
): number | null {
  if (
    execution === null ||
    ratio === null ||
    !Number.isFinite(execution) ||
    execution < 0 ||
    !Number.isFinite(ratio) ||
    ratio <= 0
  )
    return null;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('Invalid measured duration');
  return Math.min(
    Math.ceil(duration),
    Math.max(1, Math.ceil(execution / ratio)),
  );
}
