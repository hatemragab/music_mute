import { useCallback, useSyncExternalStore } from "react";

export interface LibraryPreferences {
  favorites: string[];
  hidden: string[];
  playCounts: Record<string, number>;
}

export type LibraryPreference = "favorites" | "hidden";

const storageKey = (uid: string) => `musicmute.web.library.${uid}`;
const changedEvent = "musicmute-library-preferences";
const snapshots = new Map<
  string,
  { raw: string | null; value: LibraryPreferences }
>();

export function readLibraryPreferences(uid: string): LibraryPreferences {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(uid));
  } catch {
    raw = snapshots.get(uid)?.raw ?? null;
  }
  const cached = snapshots.get(uid);
  if (cached && cached.raw === raw) return cached.value;
  let preferences: LibraryPreferences;
  try {
    const value = JSON.parse(
      raw || "null",
    ) as Partial<LibraryPreferences> | null;
    preferences = {
      favorites: Array.isArray(value?.favorites)
        ? value.favorites.filter((id): id is string => typeof id === "string")
        : [],
      hidden: Array.isArray(value?.hidden)
        ? value.hidden.filter((id): id is string => typeof id === "string")
        : [],
      playCounts: Object.fromEntries(
        value?.playCounts &&
          typeof value.playCounts === "object" &&
          !Array.isArray(value.playCounts)
          ? Object.entries(value.playCounts).filter(
              ([, count]) => Number.isSafeInteger(count) && count > 0,
            )
          : [],
      ),
    };
  } catch {
    preferences = { favorites: [], hidden: [], playCounts: {} };
  }
  snapshots.set(uid, { raw, value: preferences });
  return preferences;
}

function saveLibraryPreferences(uid: string, value: LibraryPreferences) {
  let raw = snapshots.get(uid)?.raw ?? null;
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(storageKey(uid), serialized);
    raw = serialized;
  } catch {
    // Keep this session usable if browser storage is unavailable or full.
  }
  snapshots.set(uid, { raw, value });
  window.dispatchEvent(new CustomEvent(changedEvent, { detail: uid }));
}

export function playCount(preferences: LibraryPreferences, id: string): number {
  return Object.hasOwn(preferences.playCounts, id)
    ? preferences.playCounts[id]!
    : 0;
}

export function recordLibraryPlay(uid: string, id: string): LibraryPreferences {
  const current = readLibraryPreferences(uid);
  const next = {
    ...current,
    playCounts: {
      ...current.playCounts,
      [id]: Math.min(Number.MAX_SAFE_INTEGER, playCount(current, id) + 1),
    },
  };
  saveLibraryPreferences(uid, next);
  return next;
}

export function toggleLibraryPreference(
  uid: string,
  preferences: LibraryPreferences,
  key: LibraryPreference,
  id: string,
): LibraryPreferences {
  const next = {
    ...preferences,
    [key]: preferences[key].includes(id)
      ? preferences[key].filter((value) => value !== id)
      : [...preferences[key], id],
  };
  saveLibraryPreferences(uid, next);
  return next;
}

export function useLibraryPreferences(uid: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const onChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === uid) notify();
      };
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey(uid) || event.key === null) notify();
      };
      window.addEventListener(changedEvent, onChange);
      window.addEventListener("storage", onStorage);
      return () => {
        window.removeEventListener(changedEvent, onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    [uid],
  );
  const preferences = useSyncExternalStore(
    subscribe,
    useCallback(() => readLibraryPreferences(uid), [uid]),
  );
  const toggle = useCallback(
    (key: LibraryPreference, id: string) =>
      toggleLibraryPreference(uid, readLibraryPreferences(uid), key, id),
    [uid],
  );
  return { preferences, toggle };
}
