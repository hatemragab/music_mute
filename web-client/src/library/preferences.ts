import { useCallback, useState } from "react";

export interface LibraryPreferences {
  favorites: string[];
  hidden: string[];
}

export type LibraryPreference = keyof LibraryPreferences;

const storageKey = (uid: string) => `musicmute.web.library.${uid}`;

export function readLibraryPreferences(uid: string): LibraryPreferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(storageKey(uid)) || "null",
    ) as Partial<LibraryPreferences> | null;
    return {
      favorites: Array.isArray(value?.favorites)
        ? value.favorites.filter((id): id is string => typeof id === "string")
        : [],
      hidden: Array.isArray(value?.hidden)
        ? value.hidden.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { favorites: [], hidden: [] };
  }
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
  localStorage.setItem(storageKey(uid), JSON.stringify(next));
  return next;
}

export function useLibraryPreferences(uid: string) {
  const [preferences, setPreferences] = useState(() =>
    readLibraryPreferences(uid),
  );
  const toggle = useCallback(
    (key: LibraryPreference, id: string) =>
      setPreferences((current) =>
        toggleLibraryPreference(uid, current, key, id),
      ),
    [uid],
  );
  return { preferences, toggle };
}
