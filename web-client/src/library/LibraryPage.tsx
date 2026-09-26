import { Link } from "react-router";
import { useMemo, useState } from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { useI18n } from "../i18n";
import { useJobs } from "../jobs/JobsUI";
import { usePlayer } from "../player/PlayerProvider";

interface Preferences {
  favorites: string[];
  hidden: string[];
}
function readPreferences(uid: string): Preferences {
  try {
    const value = JSON.parse(
      localStorage.getItem(`musicmute.web.library.${uid}`) || "null",
    ) as Preferences | null;
    return {
      favorites: Array.isArray(value?.favorites) ? value.favorites : [],
      hidden: Array.isArray(value?.hidden) ? value.hidden : [],
    };
  } catch {
    return { favorites: [], hidden: [] };
  }
}

export function LibraryPage() {
  const { user } = useSignedIn();
  const { t, date } = useI18n();
  const player = usePlayer();
  const query = useJobs();
  const [preferences, setPreferences] = useState(() =>
    readPreferences(user.uid),
  );
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "title">("newest");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const all = useMemo(
    () =>
      query.data?.pages
        .flatMap((page) => page.items)
        .filter((job) => job.status === "ready") ?? [],
    [query.data],
  );
  const shown = useMemo(
    () =>
      all
        .filter((job) => {
          const name = job.displayName || job.sourceTitle || "";
          return (
            name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
            (!favoritesOnly || preferences.favorites.includes(job.id)) &&
            (showHidden
              ? preferences.hidden.includes(job.id)
              : !preferences.hidden.includes(job.id))
          );
        })
        .sort((left, right) =>
          sort === "title"
            ? (left.displayName || left.sourceTitle || "").localeCompare(
                right.displayName || right.sourceTitle || "",
              )
            : Date.parse(right.createdAt) - Date.parse(left.createdAt),
        ),
    [all, search, sort, favoritesOnly, showHidden, preferences],
  );
  function toggle(key: keyof Preferences, id: string) {
    const next = {
      ...preferences,
      [key]: preferences[key].includes(id)
        ? preferences[key].filter((value) => value !== id)
        : [...preferences[key], id],
    };
    setPreferences(next);
    localStorage.setItem(
      `musicmute.web.library.${user.uid}`,
      JSON.stringify(next),
    );
  }
  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("brand")}</p>
          <h1>{t("library")}</h1>
        </div>
      </header>
      <div className="library-tools">
        <label className="search-field">
          <span className="sr-only">{t("search")}</span>
          <input
            type="search"
            placeholder={t("search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">{t("titleSort")}</span>
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as "newest" | "title")
            }
          >
            <option value="newest">{t("newest")}</option>
            <option value="title">{t("titleSort")}</option>
          </select>
        </label>
      </div>
      <div className="filter-row">
        <label className="check">
          <input
            type="checkbox"
            checked={favoritesOnly}
            onChange={(event) => setFavoritesOnly(event.target.checked)}
          />
          {t("showFavorites")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          {t("showHidden")}
        </label>
      </div>
      {query.isPending && <p>{t("loading")}</p>}
      {query.isError && (
        <p role="alert" className="notice">
          {t("requestFailed")}
        </p>
      )}
      {!query.isPending && shown.length === 0 && (
        <div className="empty-state">{t("noLibrary")}</div>
      )}
      <div className="library-list">
        {shown.map((job) => (
          <article key={job.id} className="library-item">
            <div className="library-cover" aria-hidden="true">
              ♫
            </div>
            <div className="library-meta">
              <h2>
                <Link to={`/jobs/${job.id}`} dir="auto">
                  {job.displayName || job.sourceTitle || job.id}
                </Link>
              </h2>
              <small>{date(job.createdAt)}</small>
            </div>
            <div className="library-actions">
              <button
                type="button"
                aria-label={t(
                  preferences.favorites.includes(job.id)
                    ? "unfavorite"
                    : "favorite",
                )}
                aria-pressed={preferences.favorites.includes(job.id)}
                onClick={() => toggle("favorites", job.id)}
              >
                ★
              </button>
              <button
                type="button"
                onClick={() => void player.play(job, shown)}
              >
                {t("play")}
              </button>
              <button type="button" onClick={() => toggle("hidden", job.id)}>
                {t(preferences.hidden.includes(job.id) ? "restore" : "hide")}
              </button>
            </div>
          </article>
        ))}
      </div>
      {query.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("loadMore")}
        </button>
      )}
    </div>
  );
}
