import { t, setLanguage, useLanguage } from "./i18n.js";
import { useEffect, useState, useRef } from "react";
import { AccountPanel, GoogleMark } from "./account-view.js";
import { PreparePanel } from "./prepare-view.js";
import { SetupAssistancePanel } from "./setup-assistance-view.js";
import { PersonalPanel } from "./personal-view.js";
import { PlayerPanel } from "./player-view.js";
import { PreparingPlayerPanel } from "./preparing-player-view.js";
import { CloudPanel, ProcessingChoice } from "./cloud-view.js";
import { UsagePanel } from "./usage-view.js";
import { LibraryPanel } from "./library-view.js";
import { PreferencesPanel } from "./preferences-view.js";
import { ConsumerUpdatePanel } from "./update-view.js";
import { DiagnosticsPanel } from "./diagnostics-view.js";
import { StoragePanel } from "./storage-view.js";
import { OutboxPanel } from "./outbox-view.js";
import { WorkerPanel } from "./worker-view.js";
import { shortcut } from "./shortcuts.js";
import { TEXT_SCALES } from "../shared/preferences-contracts.js";
import {
  SECTIONS,
  type DesktopBridge,
  type DesktopSnapshot,
  type DesktopReply,
  type Section,
} from "../shared/contracts.js";
declare global {
  interface Window {
    musicmute: DesktopBridge;
  }
}
const labels: Record<Section, string> = {
  home: "Home",
  library: "Library",
  account: "Account",
  setup: "Prepare",
  worker: "Worker",
  diagnostics: "Diagnostics",
  settings: "Settings",
};
export function DesktopApp() {
  const language = useLanguage();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [error, setError] = useState<string>();
  const [commandBusy, setBusy] = useState(false);
  const admittedActions = useRef(0);
  const latestSnapshot = useRef<DesktopSnapshot | undefined>(undefined);
  latestSnapshot.current = snapshot;
  const shuttingDown =
    snapshot?.shutdown !== undefined && snapshot.shutdown.phase !== "complete";
  const busy = commandBusy || snapshot?.maintenance === true || shuttingDown;
  const nativeLinkImportVisible =
    snapshot?.usage?.policy?.linkImportVisible === true;
  const heading = useRef<HTMLHeadingElement>(null),
    previousSection = useRef<Section | undefined>(undefined);
  useEffect(() => {
    const section = snapshot?.section;
    if (
      section &&
      previousSection.current &&
      section !== previousSection.current &&
      !document.querySelector("dialog[open]")
    )
      heading.current?.focus();
    previousSection.current = section;
  }, [snapshot?.section]);
  useEffect(() => {
    let active = true;
    void window.musicmute
      .getSnapshot()
      .then((reply) => {
        if (active) {
          if (reply.ok)
            setSnapshot((previous) =>
              !previous || reply.snapshot.sequence >= previous.sequence
                ? reply.snapshot
                : previous,
            );
          else setError("MusicMute could not complete this action. Try again.");
        }
      })
      .catch(() => {
        if (active) setError("Unable to connect to MusicMute.");
      });
    const close = window.musicmute.onSnapshot((next) =>
      setSnapshot((previous) =>
        !previous || next.sequence >= previous.sequence ? next : previous,
      ),
    );
    return () => {
      active = false;
      close();
    };
  }, []);
  const run = async (operation: () => Promise<DesktopReply>) => {
    admittedActions.current++;
    setBusy(true);
    setError(undefined);
    try {
      const reply = await operation();
      if (reply.ok)
        setSnapshot((previous) =>
          !previous || reply.snapshot.sequence >= previous.sequence
            ? reply.snapshot
            : previous,
        );
      else
        setError(
          reply.errorCode === "INVALID_REQUEST"
            ? "Choose a supported file or action."
            : "MusicMute could not complete this action. Try again.",
        );
    } catch {
      setError("MusicMute could not complete this action. Try again.");
    } finally {
      admittedActions.current--;
      setBusy(admittedActions.current > 0);
    }
  };
  const navigate = (section: Section) =>
    run(() => window.musicmute.navigate(section));
  const servicesFailed = snapshot?.initialization === "failed";
  const sectionUnavailable =
    servicesFailed &&
    ((snapshot.section === "library" && !snapshot.library) ||
      (snapshot.section === "settings" && !snapshot.preferences) ||
      (snapshot.section === "account" &&
        !snapshot.accountDetails &&
        !snapshot.accountUnavailable) ||
      (snapshot.section === "worker" && !snapshot.fleet && !snapshot.session) ||
      (snapshot.section === "diagnostics" &&
        !snapshot.diagnostics &&
        !snapshot.diagnosticsUnavailable));
  const playback: Parameters<typeof PlayerPanel>[0]["execute"] = async (
    command,
  ) => {
    try {
      const reply = await window.musicmute.playback(command);
      if (reply.ok)
        setSnapshot((previous) =>
          !previous || reply.snapshot.sequence >= previous.sequence
            ? reply.snapshot
            : previous,
        );
      else if (command.type !== "MEDIA_EVENT")
        setError("Playback could not complete this action.");
    } catch {
      if (command.type !== "MEDIA_EVENT")
        setError("Playback could not complete this action.");
    }
  };
  useEffect(() => {
    const preferences = snapshot?.preferences?.value;
    if (!preferences) return;
    const root = document.documentElement,
      system = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      root.dataset.theme =
        preferences.appearance === "system"
          ? system?.matches
            ? "dark"
            : "light"
          : preferences.appearance;
      root.dataset.accent = preferences.accent;
      root.style.fontSize = `${16 * TEXT_SCALES[preferences.textSize]}px`;
    };
    apply();
    system?.addEventListener("change", apply);
    return () => system?.removeEventListener("change", apply);
  }, [
    snapshot?.preferences?.value.appearance,
    snapshot?.preferences?.value.accent,
    snapshot?.preferences?.value.textSize,
  ]);
  useEffect(
    () =>
      setLanguage(
        snapshot?.preferences?.resolvedLanguage ??
          (navigator.language.toLowerCase().startsWith("ar") ? "ar" : "en"),
      ),
    [snapshot?.preferences?.resolvedLanguage],
  );
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  }, [language]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (admittedActions.current > 0 || document.querySelector("dialog[open]"))
        return;
      const current = latestSnapshot.current;
      if (current?.shutdown && current.shutdown.phase !== "complete") return;
      const target = event.target instanceof Element ? event.target : undefined;
      const action = shortcut(
        event,
        !!target?.closest(
          'input,textarea,select,[contenteditable="true"],[role="textbox"]',
        ),
        !!target?.closest("button"),
        current?.preferences?.value.textSize,
      );
      if (current?.maintenance && action?.action !== "navigate") return;
      if (!action) return;
      event.preventDefault();
      const view = current?.playback;
      if (action.action === "navigate") void navigate(action.section);
      else if (action.action === "readiness")
        void run(() => window.musicmute.prepare("check"));
      else if (action.action === "volume" && view)
        void playback({
          type: "VOLUME",
          level: Math.max(0, Math.min(1, view.volume + action.delta)),
        });
      else if (action.action === "choose")
        void run(() => window.musicmute.selectInput());
      else if (action.action === "text")
        void run(() =>
          window.musicmute.preferences({
            type: "SET",
            patch: { textSize: action.size },
          }),
        );
      else if (action.action === "star" && view?.trackId)
        void run(() =>
          window.musicmute.library({ type: "STAR", trackId: view.trackId! }),
        );
      else if (action.action === "toggle" && view?.trackId)
        void playback({ type: view.requestedPlaying ? "PAUSE" : "PLAY" });
      else if (action.action === "mute") void playback({ type: "MUTE" });
      else if (action.action === "next") void playback({ type: "NEXT" });
      else if (action.action === "stop") void playback({ type: "STOP" });
      else if (action.action === "source" && view?.trackId)
        void playback({
          type: "SOURCE",
          variant: view.variant === "voice" ? "original" : "voice",
        });
      else if (action.action === "seek" && view?.trackId)
        void playback({
          type: "SEEK",
          seconds: Math.max(
            0,
            Math.min(view.duration, view.position + action.delta),
          ),
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="app-shell">
      <aside>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ≋
          </span>
          <div>
            <strong>{"" + t("MusicMute") + ""}</strong>
            <small>{"" + t("Keep the voice") + ""}</small>
          </div>
        </div>
        <nav aria-label={t("Main navigation")}>
          {SECTIONS.map((section) => (
            <button
              key={section}
              aria-current={snapshot?.section === section ? "page" : undefined}
              disabled={commandBusy || shuttingDown}
              onClick={() => void navigate(section)}
            >
              {t(labels[section])}
            </button>
          ))}
        </nav>
        <p className="sidebar-note">
          {"" + t("Local processing on your PC") + ""}
        </p>
        <button
          disabled={
            commandBusy ||
            shuttingDown ||
            snapshot?.personalQuitAvailable === false ||
            (snapshot?.personalQuitAvailable === undefined &&
              snapshot?.maintenance === true)
          }
          onClick={() => void run(() => window.musicmute.quitPersonal())}
        >
          {"" + t("Quit personal app") + ""}
        </button>
      </aside>
      <main
        aria-busy={
          (!snapshot && !error) || snapshot?.shutdown?.phase === "closing"
        }
      >
        <header>
          <p className="eyebrow">{"" + t("MUSICMUTE LOCAL") + ""}</p>
          <h1 ref={heading} tabIndex={-1}>
            {snapshot ? t(labels[snapshot.section]) : t("Opening MusicMute")}
          </h1>
        </header>
        {error && (
          <p role="alert" className="error">
            {t(error)}
          </p>
        )}
        {!snapshot && !error && (
          <p role="status">{"" + t("Connecting…") + ""}</p>
        )}
        {snapshot?.shutdown?.phase === "closing" && (
          <p role="status">{t("Closing MusicMute safely…")}</p>
        )}
        {snapshot?.shutdown?.phase === "pending" && (
          <section aria-label={t("Closing MusicMute")}>
            <p role="alert" className="error">
              {t("MusicMute could not confirm cleanup. Retry closing.")}
            </p>
            <button
              disabled={commandBusy}
              onClick={() => void run(() => window.musicmute.quitPersonal())}
            >
              {t("Retry closing")}
            </button>
          </section>
        )}
        {servicesFailed && (
          <p role="alert" className="error">
            {t(
              snapshot.setup.state === "unsupported"
                ? snapshot.setup.message
                : "MusicMute could not open its local services. Close and reopen the personal app to retry.",
            )}
          </p>
        )}
        {sectionUnavailable && (
          <p role="status">
            {t("This section is unavailable until local services reopen.")}
          </p>
        )}
        {!shuttingDown &&
          snapshot?.preparationRecovery?.state === "required" && (
            <section
              className="processing-panel"
              aria-label={t("Preparation recovery")}
            >
              <p role="alert">
                {t(
                  "Preparation needs recovery. Retry Prepare when local work has stopped.",
                )}
              </p>
              <button
                disabled={
                  commandBusy || !snapshot.preparationRecovery.retryAvailable
                }
                onClick={() =>
                  void run(() => window.musicmute.prepare("start"))
                }
              >
                {t("Retry Prepare")}
              </button>
            </section>
          )}
        {snapshot?.fleetRecovery && snapshot.fleetRecovery.state !== "idle" && (
          <section
            className="processing-panel"
            aria-label={t("Worker recovery")}
          >
            <p
              role={
                snapshot.fleetRecovery.state === "recovering"
                  ? "status"
                  : "alert"
              }
            >
              {snapshot.fleetRecovery.state === "recovering"
                ? t("Restoring worker readiness…")
                : snapshot.fleetRecovery.state === "invalid"
                  ? t("Worker recovery state could not be verified.")
                  : t("Worker recovery needs attention.")}
            </p>
            {snapshot.fleetRecovery.retryAvailable && (
              <button
                disabled={commandBusy}
                onClick={() =>
                  void run(() => window.musicmute.prepare("start"))
                }
              >
                {t("Retry worker recovery")}
              </button>
            )}
          </section>
        )}
        {snapshot?.section === "home" && (
          <section
            className="hero"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (event.dataTransfer.files.length === 1 && file)
                void run(() => window.musicmute.dropInput(file));
              else setError("Drop one audio or video file.");
            }}
          >
            <p className="eyebrow">{"" + t("YOUR AUDIO. YOUR PC.") + ""}</p>
            <h2>
              {"" + t("Remove the music.") + ""}
              <br />
              {"" + t("Keep what matters.") + ""}
            </h2>
            <p>
              {"" +
                t(
                  "Prepare your PC once, then process files locally with your GPU.",
                ) +
                ""}
            </p>
            <ProcessingChoice
              {...(snapshot.cloud ? { view: snapshot.cloud } : {})}
              busy={busy}
              execute={(command) => run(() => window.musicmute.cloud(command))}
            />
            <UsagePanel {...(snapshot.usage ? { view: snapshot.usage } : {})} />
            {snapshot.cloudHandoff && nativeLinkImportVisible && (
              <section
                className="cloud-confirmation"
                aria-label={t("Video from Chrome")}
              >
                <h3>{t("Video from Chrome")}</h3>
                <p>
                  <bdi>{`https://www.youtube.com/watch?v=${snapshot.cloudHandoff.videoId}`}</bdi>
                </p>
                <p>
                  {t(
                    "Review this video with your current account. Cloud processing starts only after you confirm the submission.",
                  )}
                </p>
                <button
                  disabled={busy || snapshot.cloud?.busy}
                  onClick={() =>
                    void run(() => window.musicmute.reviewCloudHandoff())
                  }
                >
                  {t("Review cloud handoff")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.musicmute.clearCloudHandoff())
                  }
                >
                  {t("Dismiss video")}
                </button>
              </section>
            )}
            <div className="home-links">
              <button
                className="primary"
                disabled={busy}
                onClick={() => void run(() => window.musicmute.selectInput())}
              >
                {"" + t("Choose audio or video") + ""}
              </button>
              {snapshot.setup.state !== "ready" && (
                <button onClick={() => void navigate("setup")}>
                  {"" + t("Prepare this PC") + ""}
                </button>
              )}
            </div>
            <p role="status">
              {snapshot.selectedInput
                ? t("Selected: {name}", { name: snapshot.selectedInput.name })
                : t("Choose a file or drop one here.")}
            </p>
            <p className="muted">{t(snapshot.setup.message)}</p>
            {snapshot.backgroundSaveError && !servicesFailed && (
              <p role="alert">
                {t(
                  "Background saving needs attention. Your retained audio is kept.",
                )}
              </p>
            )}
            {snapshot.reuse?.state === "looking-up" && (
              <p role="status">{t("Looking for a verified saved voice…")}</p>
            )}
            {snapshot.reuse?.state === "hit" && (
              <p role="status">{t("Playing a verified saved voice.")}</p>
            )}
            {snapshot.cloud?.mode !== "cloud" && (
              <PersonalPanel
                {...(snapshot.personal ? { view: snapshot.personal } : {})}
                {...(snapshot.selectedInput
                  ? { selected: snapshot.selectedInput }
                  : {})}
                prepared={snapshot.setup.state === "ready"}
                busy={busy}
                {...(snapshot.preferences
                  ? { defaultSource: snapshot.preferences.value.importSource }
                  : {})}
                linkImportVisible={nativeLinkImportVisible}
                sourceChanged={(source) =>
                  void run(() =>
                    window.musicmute.preferences({
                      type: "SET",
                      patch: { importSource: source },
                    }),
                  )
                }
                execute={(command) =>
                  run(() => window.musicmute.personal(command))
                }
              />
            )}
            <CloudPanel
              {...(snapshot.cloud ? { view: snapshot.cloud } : {})}
              {...(snapshot.selectedInput
                ? { selected: snapshot.selectedInput }
                : {})}
              busy={busy}
              execute={(command) => run(() => window.musicmute.cloud(command))}
              openLibrary={() => void navigate("library")}
            />
            <OutboxPanel
              {...(snapshot.outbox ? { view: snapshot.outbox } : {})}
              busy={busy}
              execute={(command) => run(() => window.musicmute.outbox(command))}
            />
            <div className="home-links">
              <button onClick={() => void navigate("account")}>
                {snapshot.account.state === "signed-in"
                  ? t("Manage your account")
                  : t("Sign in with email")}
              </button>
              {snapshot.account.state === "signed-out" && (
                <button
                  className="google-button"
                  disabled={
                    !!snapshot.accountUnavailable || !snapshot.accountDetails
                  }
                  onClick={() =>
                    void run(() =>
                      window.musicmute.account({
                        type: "SIGN_IN_GOOGLE",
                        link: false,
                      }),
                    )
                  }
                >
                  <GoogleMark />
                  {"" + t("Sign in with Google") + ""}
                </button>
              )}
              <button
                onClick={() =>
                  void run(() => window.musicmute.openProduct("web"))
                }
              >
                {"" + t("Open the web app ↗") + ""}
              </button>
            </div>
          </section>
        )}
        {snapshot?.section === "setup" && (
          <>
            <PreparePanel
              {...(snapshot.preparation ? { view: snapshot.preparation } : {})}
              message={snapshot.setup.message}
              busy={
                commandBusy ||
                shuttingDown ||
                (snapshot.initialization === "failed" &&
                  !snapshot.preparation) ||
                (snapshot.maintenance === true &&
                  !snapshot.fleetRecovery?.retryAvailable &&
                  !snapshot.preparationRecovery?.retryAvailable &&
                  !snapshot.preparationRecovery?.cancelAvailable)
              }
              execute={(action) => run(() => window.musicmute.prepare(action))}
            />
            {snapshot.initialization === "failed" &&
            !snapshot.setupAssistance ? (
              <section className="panel" aria-label={t("Chrome extension")}>
                <h3>{t("Chrome extension")}</h3>
                <p>
                  {t(
                    "This section is unavailable until local services reopen.",
                  )}
                </p>
              </section>
            ) : (
              <SetupAssistancePanel
                {...(snapshot.setupAssistance
                  ? { view: snapshot.setupAssistance }
                  : {})}
                busy={
                  commandBusy || shuttingDown || snapshot.maintenance === true
                }
                execute={(command) =>
                  run(() => window.musicmute.setupAssistance(command))
                }
              />
            )}
          </>
        )}
        {snapshot?.section === "account" && !sectionUnavailable && (
          <>
            <AccountPanel
              blocked={snapshot.maintenance === true}
              {...(snapshot.accountDetails
                ? { view: snapshot.accountDetails }
                : {})}
              {...(snapshot.accountUnavailable
                ? { unavailable: snapshot.accountUnavailable }
                : {})}
              execute={(command) =>
                run(() => window.musicmute.account(command))
              }
            />
            <UsagePanel {...(snapshot.usage ? { view: snapshot.usage } : {})} />
          </>
        )}
        {snapshot?.section === "worker" && !sectionUnavailable && (
          <WorkerPanel
            storeManagedUpdates={
              snapshot.consumerUpdate?.distribution === "microsoft-store"
            }
            {...(snapshot.fleet ? { view: snapshot.fleet } : {})}
            {...(snapshot.session ? { session: snapshot.session } : {})}
            {...(snapshot.fleetAdvanced
              ? { advanced: snapshot.fleetAdvanced }
              : {})}
            {...(snapshot.fleetAdvancedFollowing !== undefined
              ? { following: snapshot.fleetAdvancedFollowing }
              : {})}
            {...(snapshot.workerBenchmark?.input
              ? { selectedInput: snapshot.workerBenchmark.input }
              : {})}
            {...(snapshot.workerBenchmark
              ? { benchmark: snapshot.workerBenchmark }
              : {})}
            pickBenchmark={(kind) =>
              run(() => window.musicmute.fleetBenchmarkPick(kind))
            }
            clearBenchmark={() =>
              run(() => window.musicmute.fleetBenchmarkClear())
            }
            busy={busy}
            execute={(command) => run(() => window.musicmute.fleet(command))}
            executeAdvanced={(command) =>
              run(() => window.musicmute.fleetAdvanced(command))
            }
            exportReport={() =>
              run(() => window.musicmute.fleetAdvancedExport())
            }
            selectInput={() =>
              run(() => window.musicmute.fleetBenchmarkPick("input"))
            }
            signIn={() => void navigate("account")}
          />
        )}
        {snapshot?.section === "library" && !sectionUnavailable && (
          <LibraryPanel
            {...(snapshot.library ? { view: snapshot.library } : {})}
            {...(snapshot.history ? { history: snapshot.history } : {})}
            busy={busy}
            execute={(command) => run(() => window.musicmute.library(command))}
            play={(trackId, variant) =>
              void run(() => window.musicmute.libraryPlay(trackId, variant))
            }
            queue={(trackId) =>
              snapshot.playback?.queueRevision !== undefined &&
              void playback({
                type: "QUEUE_EDIT",
                action: "append",
                trackId,
                generation: snapshot.playback.generation,
                queueRevision: snapshot.playback.queueRevision,
              })
            }
            playNext={(trackId) =>
              snapshot.playback?.queueRevision !== undefined &&
              void playback({
                type: "QUEUE_EDIT",
                action: "insert-next",
                trackId,
                generation: snapshot.playback.generation,
                queueRevision: snapshot.playback.queueRevision,
              })
            }
            download={(id, variant) =>
              run(() => window.musicmute.libraryDownload(id, variant))
            }
            exportTrack={(id, variant) =>
              run(() => window.musicmute.libraryExport(id, variant))
            }
            {...(snapshot.libraryShareUnavailable === false
              ? {
                  shareTrack: (id: string, variant: "voice" | "original") =>
                    run(() => window.musicmute.libraryShare(id, variant)),
                }
              : {})}
            shareResult={snapshot.libraryShareResult}
            nextPage={() => run(() => window.musicmute.libraryNextPage())}
            historyCommand={(command) =>
              run(() => window.musicmute.history(command))
            }
            saveToAccount={(trackId) =>
              run(() => window.musicmute.librarySaveToAccount(trackId))
            }
            accountSavingAvailable={
              snapshot.outbox?.authenticated === true &&
              snapshot.accountDetails?.access.allowed === true
            }
          />
        )}
        {snapshot?.section === "diagnostics" && !sectionUnavailable && (
          <DiagnosticsPanel
            view={snapshot.diagnostics}
            unavailable={snapshot.diagnosticsUnavailable}
            busy={busy}
            execute={(command) =>
              run(() => window.musicmute.diagnostics(command))
            }
            exportReport={() => run(() => window.musicmute.diagnosticsExport())}
            clear={() => run(() => window.musicmute.diagnosticsClear())}
          />
        )}
        {snapshot?.background &&
          (snapshot.background.personalBusy ||
            snapshot.background.chromeBusy ||
            snapshot.background.fleetRunning) && (
            <p className="muted" role="status">
              {snapshot.background.personalBusy
                ? t("Personal processing is active. ")
                : ""}
              {snapshot.background.chromeBusy
                ? t("Chrome processing is active. ")
                : ""}
              {snapshot.background.fleetRunning
                ? t("Your enrolled worker is running in this Windows session.")
                : ""}
            </p>
          )}
        {snapshot?.section === "settings" && !sectionUnavailable && (
          <>
            <ConsumerUpdatePanel
              view={snapshot.consumerUpdate}
              unavailable={snapshot.updateUnavailable}
              maintenance={snapshot.maintenance}
              busy={commandBusy}
              execute={(command) =>
                run(() => window.musicmute.consumerUpdate(command))
              }
            />
            <PreferencesPanel
              {...(snapshot.preferences ? { view: snapshot.preferences } : {})}
              busy={busy}
              execute={(command) =>
                run(() => window.musicmute.preferences(command))
              }
            />
            <StoragePanel
              {...(snapshot.storage ? { view: snapshot.storage } : {})}
              busy={busy}
              execute={(command) =>
                run(() => window.musicmute.storage(command))
              }
            />
          </>
        )}
        {snapshot?.pendingPlayback && (
          <PreparingPlayerPanel
            key={snapshot.pendingPlayback.requestId}
            {...(snapshot.personal?.jobs.find(
              (job) => job.id === snapshot.pendingPlayback?.jobId,
            )
              ? {
                  job: snapshot.personal.jobs.find(
                    (job) => job.id === snapshot.pendingPlayback?.jobId,
                  )!,
                }
              : {})}
            cancel={() =>
              run(() =>
                window.musicmute.personal(
                  snapshot.pendingPlayback!.jobId
                    ? { type: "CANCEL", jobId: snapshot.pendingPlayback!.jobId }
                    : {
                        type: "CANCEL_REQUEST",
                        requestId: snapshot.pendingPlayback!.requestId,
                      },
                ),
              )
            }
          />
        )}
        <PlayerPanel
          {...(snapshot?.playback ? { view: snapshot.playback } : {})}
          {...(snapshot?.library
            ? {
                tracks: snapshot.library.tracks,
                title:
                  snapshot.library.tracks.find(
                    (track) => track.id === snapshot.playback?.trackId,
                  )?.title ?? t("Your audio"),
              }
            : {})}
          {...(snapshot?.preferences
            ? { defaultExpanded: snapshot.preferences.value.expandPlayer }
            : {})}
          expandedChanged={(expanded) =>
            void run(() =>
              window.musicmute.preferences({
                type: "SET",
                patch: { expandPlayer: expanded },
              }),
            )
          }
          execute={playback}
        />
      </main>
    </div>
  );
}
