import { Link } from "react-router";
import { Download, Music2, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, useI18n } from "../i18n";
import { downloadJobArtifact } from "../jobs/artifacts";
import { useJobs } from "../jobs/JobsUI";
import { trackTitle } from "../player/playback";
import { usePlayer } from "../player/PlayerProvider";
import { useLibraryPreferences } from "./preferences";

export function LibraryPage() {
  const { api, user } = useSignedIn();
  const { t, date } = useI18n();
  const player = usePlayer();
  const query = useJobs("ready");
  const { preferences, toggle } = useLibraryPreferences(user.uid);
  const [actionError, setActionError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "title">("newest");
  const [filter, setFilter] = useState<"all" | "favorites" | "removed">("all");
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
            (filter !== "favorites" ||
              preferences.favorites.includes(job.id)) &&
            (filter === "removed"
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
    [all, search, sort, filter, preferences],
  );
  async function download(jobId: string) {
    setActionError("");
    try {
      await downloadJobArtifact(api, jobId, "output");
    } catch (error) {
      setActionError(friendlyError(error, t));
    }
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
      <div className="filter-row" role="group" aria-label={t("library")}>
        {(["all", "favorites", "removed"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "selected" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {t(
              value === "all"
                ? "filterAll"
                : value === "favorites"
                  ? "showFavorites"
                  : "removed",
            )}
          </button>
        ))}
      </div>
      {query.isPending && <p>{t("loading")}</p>}
      {query.isError && (
        <p role="alert" className="notice">
          {t("requestFailed")}
        </p>
      )}
      {actionError && (
        <p role="alert" className="notice">
          {actionError}
        </p>
      )}
      {!query.isPending && shown.length === 0 && (
        <div className="empty-state">{t("noLibrary")}</div>
      )}
      <div className="library-list">
        {shown.map((job) => (
          <article key={job.id} className="library-item">
            <div className="library-cover" aria-hidden="true">
              <Music2 />
            </div>
            <div className="library-meta">
              <h2>
                <Link to={`/jobs/${job.id}`} dir="auto">
                  {trackTitle(job, t("untitledTrack"))}
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
                <Star
                  aria-hidden="true"
                  fill={
                    preferences.favorites.includes(job.id)
                      ? "currentColor"
                      : "none"
                  }
                />
              </button>
              <button
                type="button"
                onClick={() => void player.play(job, shown)}
              >
                {t("play")}
              </button>
              <button
                type="button"
                aria-label={`${t("download")} ${t("outputTrack")}`}
                onClick={() => void download(job.id)}
              >
                <Download aria-hidden="true" />
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
