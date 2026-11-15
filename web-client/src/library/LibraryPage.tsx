import { Link } from "react-router";
import { Download, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, useI18n } from "../i18n";
import { downloadJobArtifact } from "../jobs/artifacts";
import { useJobs } from "../jobs/JobsUI";
import { trackTitle } from "../player/playback";
import { usePlayer } from "../player/PlayerProvider";
import { useLibraryPreferences } from "./preferences";
import { queryLibrary, type LibraryFilter, type LibrarySort } from "./query";
import { LibraryArtwork } from "./LibraryArtwork";

export function LibraryPage() {
  const { api, user } = useSignedIn();
  const { t, date } = useI18n();
  const player = usePlayer();
  const query = useJobs("ready");
  const { preferences, toggle } = useLibraryPreferences(user.uid);
  const [actionError, setActionError] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("newest");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [starredOnly, setStarredOnly] = useState(false);
  const all = useMemo(
    () =>
      query.data?.pages
        .flatMap((page) => page.items)
        .filter((job) => job.status === "ready") ?? [],
    [query.data],
  );
  const shown = useMemo(
    () => queryLibrary(all, preferences, { search, sort, filter, starredOnly }),
    [all, search, sort, filter, starredOnly, preferences],
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
          <span className="sr-only">{t("sortTracks")}</span>
          <select
            value={filter === "mostPlayed" ? "mostPlayed" : sort}
            disabled={filter === "mostPlayed"}
            onChange={(event) => setSort(event.target.value as LibrarySort)}
          >
            <option value="newest">{t("newest")}</option>
            <option value="title">{t("titleSort")}</option>
            <option value="mostPlayed">{t("mostPlayed")}</option>
          </select>
        </label>
      </div>
      <div className="filter-row" role="group" aria-label={t("library")}>
        {(["all", "mostPlayed", "removed"] as const).map((value) => (
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
                : value === "mostPlayed"
                  ? "mostPlayed"
                  : "removed",
            )}
          </button>
        ))}
        <label className="check library-star-filter">
          <input
            type="checkbox"
            checked={starredOnly}
            onChange={(event) => setStarredOnly(event.target.checked)}
          />
          <Star
            aria-hidden="true"
            fill={starredOnly ? "currentColor" : "none"}
          />
          <span>{t("showFavorites")}</span>
        </label>
      </div>
      {query.hasNextPage &&
        (filter === "mostPlayed" || sort === "mostPlayed") && (
          <small>{t("mostPlayedLoadMore")}</small>
        )}
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
        <div className="empty-state">
          {t(
            search.trim() || starredOnly || filter === "removed"
              ? "noMatchingTracks"
              : filter === "mostPlayed"
                ? "noMostPlayed"
                : "noLibrary",
          )}
        </div>
      )}
      <div className="library-list">
        {shown.map((job) => (
          <article key={job.id} className="library-item">
            <LibraryArtwork url={job.thumbnailUrl} trackId={job.id} />
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
