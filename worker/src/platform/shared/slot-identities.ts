/** Inactive slots retain backend identity but never authorize processing. */
export function configuredSlotIdentities(document: Record<string, unknown>) {
  return [
    ...slotRecords(document.slots),
    ...slotRecords(document.inactiveSlots ?? []),
  ];
}

export function retainSlotIdentities(
  document: Record<string, unknown>,
  slots: Record<string, unknown>[],
) {
  const activeIds = new Set(slots.map((slot) => slot.workerId));
  return {
    ...document,
    slots,
    inactiveSlots: configuredSlotIdentities(document).filter(
      (slot) => !activeIds.has(slot.workerId),
    ),
  };
}

function slotRecords(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some(
      (slot) => !slot || typeof slot !== "object" || Array.isArray(slot),
    )
  )
    throw new TypeError("Configured slot identities are invalid");
  return value as Record<string, unknown>[];
}
