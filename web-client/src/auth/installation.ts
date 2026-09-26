const PREFIX = "musicmute.web.installation.";

export function installationIdFor(uid: string): string {
  if (!uid) throw new Error("A signed-in account is required.");
  const key = `${PREFIX}${uid}`;
  const existing = localStorage.getItem(key);
  if (
    existing &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      existing,
    )
  )
    return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}
