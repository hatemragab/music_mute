import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { jobsApi } from "../api/jobs";
import type { JobView } from "../api/types";
import { recordLibraryPlay } from "../library/preferences";
import {
  chooseNextIndex,
  passageLoop,
  type LoopSpan,
  type RepeatMode,
} from "./playback";

interface PlayerContextValue {
  current: JobView | null;
  playing: boolean;
  time: number;
  duration: number;
  error: string | null;
  queue: JobView[];
  speed: number;
  volume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  autoNext: boolean;
  original: boolean;
  loop: LoopSpan | null;
  play: (job: JobView, queue?: JobView[]) => Promise<void>;
  toggle: () => Promise<void>;
  seek: (time: number) => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  setSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setRepeat: (repeat: RepeatMode) => void;
  setShuffle: (shuffle: boolean) => void;
  setAutoNext: (autoNext: boolean) => void;
  toggleLoop: () => void;
  selectOriginal: (original: boolean) => Promise<void>;
  removeFromQueue: (jobId: string) => void;
}
const Context = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const { api, user } = useSignedIn();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<JobView | null>(null);
  const [queue, setQueue] = useState<JobView[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeedState] = useState(1);
  const [volume, setVolumeState] = useState(1);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [shuffle, setShuffle] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  const [original, setOriginal] = useState(false);
  const [loop, setLoop] = useState<LoopSpan | null>(null);
  const grant = useRef<{
    jobId: string;
    artifact: "input" | "output";
    url: string;
    expiresAt: number;
  } | null>(null);
  const currentRef = useRef<JobView | null>(null);
  const queueRef = useRef<JobView[]>([]);
  const repeatRef = useRef<RepeatMode>("off");
  const shuffleRef = useRef(false);
  const autoNextRef = useRef(true);
  const loopRef = useRef<LoopSpan | null>(null);
  const speedRef = useRef(1);
  const generation = useRef(0);
  const recovered = useRef(false);
  const playSession = useRef<{ jobId: string; counted: boolean } | null>(null);
  const pendingLoopPlay = useRef<string | null>(null);
  const manualSeek = useRef(false);
  const creditStart = useCallback(
    (operation: number) => {
      const session = playSession.current;
      if (generation.current !== operation || !session || session.counted)
        return;
      session.counted = true;
      recordLibraryPlay(user.uid, session.jobId);
    },
    [user.uid],
  );
  const invalidatePlayback = useCallback(() => {
    generation.current += 1;
  }, []);

  const start = useCallback(
    async (
      job: JobView,
      list = queueRef.current,
      resumeAt = 0,
      artifact: "input" | "output" = "output",
      shouldPlay = true,
      countAsPlay = true,
    ) => {
      const operation = ++generation.current;
      if (
        job.id !== currentRef.current?.id ||
        grant.current?.artifact !== artifact
      )
        recovered.current = false;
      setError(null);
      audio.current?.pause();
      audio.current?.removeAttribute("src");
      audio.current?.load();
      if (countAsPlay || playSession.current?.jobId !== job.id)
        playSession.current = { jobId: job.id, counted: false };
      pendingLoopPlay.current = null;
      manualSeek.current = false;
      setCurrent(job);
      setQueue(list.length ? list : [job]);
      setOriginal(artifact === "input");
      if (job.id !== currentRef.current?.id) {
        loopRef.current = null;
        setLoop(null);
      }
      currentRef.current = job;
      queueRef.current = list.length ? list : [job];
      try {
        const element = audio.current;
        if (!element) throw new Error("PLAYBACK_UNAVAILABLE");
        let selected = grant.current;
        if (
          !selected ||
          selected.jobId !== job.id ||
          selected.artifact !== artifact ||
          selected.expiresAt < Date.now() + 30_000
        ) {
          const result = await jobsApi(api).grant(
            job.id,
            artifact,
            crypto.randomUUID(),
          );
          selected = {
            jobId: job.id,
            artifact,
            url: result.url,
            expiresAt: Date.parse(result.expiresAt),
          };
        }
        if (generation.current !== operation) return;
        grant.current = selected;
        element.src = selected.url;
        element.playbackRate = speedRef.current;
        if (resumeAt > 0)
          element.addEventListener(
            "loadedmetadata",
            () => {
              if (generation.current === operation)
                element.currentTime = resumeAt;
            },
            { once: true },
          );
        if (shouldPlay) {
          await element.play();
          creditStart(operation);
        } else element.pause();
      } catch (error) {
        if (generation.current === operation)
          setError(error instanceof Error ? error.message : "PLAYBACK_FAILED");
      }
    },
    [api, creditStart],
  );

  useEffect(() => {
    currentRef.current = current;
    queueRef.current = queue;
    repeatRef.current = repeat;
    shuffleRef.current = shuffle;
    autoNextRef.current = autoNext;
    loopRef.current = loop;
  }, [current, queue, repeat, shuffle, autoNext, loop]);
  useEffect(() => {
    const element = new Audio();
    audio.current = element;
    const onTime = () => {
      const span = loopRef.current;
      if (
        pendingLoopPlay.current &&
        span &&
        !element.paused &&
        !element.seeking &&
        element.currentTime > span.start
      ) {
        recordLibraryPlay(user.uid, pendingLoopPlay.current);
        pendingLoopPlay.current = null;
      }
      if (
        span &&
        span.end - span.start > 0.2 &&
        element.currentTime >= span.end - 0.05 &&
        element.currentTime > span.start
      ) {
        pendingLoopPlay.current =
          !element.paused && !element.seeking && !manualSeek.current
            ? (currentRef.current?.id ?? null)
            : null;
        element.currentTime = span.start;
      }
      if (!element.seeking) manualSeek.current = false;
      setTime(element.currentTime || 0);
    };
    const onDuration = () => {
      const duration = Number.isFinite(element.duration) ? element.duration : 0;
      setDuration(duration);
      if (duration > 0) setError(null);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      if (
        !recovered.current &&
        grant.current &&
        Date.now() >= grant.current.expiresAt - 30_000 &&
        currentRef.current
      ) {
        recovered.current = true;
        void start(
          currentRef.current,
          queueRef.current,
          element.currentTime,
          grant.current.artifact,
          true,
          false,
        );
      } else if (element.error?.code !== MediaError.MEDIA_ERR_ABORTED) {
        element.pause();
        setError("PLAYBACK_FAILED");
      }
    };
    const onEnd = () => {
      const list = queueRef.current;
      const span = loopRef.current;
      if (span && currentRef.current) {
        const operation = generation.current;
        pendingLoopPlay.current = currentRef.current.id;
        element.currentTime = span.start;
        void element.play().catch(() => {
          if (generation.current !== operation || audio.current !== element)
            return;
          pendingLoopPlay.current = null;
          setError("PLAYBACK_FAILED");
        });
        return;
      }
      const index = list.findIndex(
        (item) => item.id === currentRef.current?.id,
      );
      if (repeatRef.current === "one" && currentRef.current) {
        void start(currentRef.current, list);
        return;
      }
      if (!autoNextRef.current) return;
      const nextIndex = chooseNextIndex(
        list.length,
        index,
        repeatRef.current === "all" ? "all" : "off",
        shuffleRef.current,
      );
      const target = list[nextIndex];
      if (target) void start(target, list);
    };
    element.addEventListener("timeupdate", onTime);
    element.addEventListener("durationchange", onDuration);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("error", onError);
    element.addEventListener("ended", onEnd);
    return () => {
      invalidatePlayback();
      element.pause();
      element.removeAttribute("src");
      element.load();
      audio.current = null;
      grant.current = null;
      playSession.current = null;
      pendingLoopPlay.current = null;
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("durationchange", onDuration);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("error", onError);
      element.removeEventListener("ended", onEnd);
    };
  }, [api, start, invalidatePlayback, user.uid]);

  const value = useMemo<PlayerContextValue>(
    () => ({
      current,
      playing,
      time,
      duration,
      error,
      queue,
      speed,
      volume,
      repeat,
      shuffle,
      autoNext,
      original,
      loop,
      play: start,
      toggle: async () => {
        if (playing) audio.current?.pause();
        else if (current) {
          const element = audio.current;
          const operation = generation.current;
          if (!element) return;
          try {
            const ended = element.ended;
            await element.play();
            if (ended && generation.current === operation)
              recordLibraryPlay(user.uid, current.id);
            else creditStart(operation);
          } catch {
            if (generation.current !== operation || audio.current !== element)
              return;
            await start(
              current,
              queue,
              element.currentTime,
              original ? "input" : "output",
              true,
              false,
            );
          }
        }
      },
      seek: (value) => {
        manualSeek.current = true;
        pendingLoopPlay.current = null;
        if (audio.current) audio.current.currentTime = value;
      },
      next: async () => {
        const index = queue.findIndex((job) => job.id === current?.id);
        const job =
          queue[chooseNextIndex(queue.length, index, repeat, shuffle)];
        if (job) await start(job, queue);
      },
      previous: async () => {
        if (audio.current && audio.current.currentTime > 3) {
          manualSeek.current = true;
          pendingLoopPlay.current = null;
          audio.current.currentTime = 0;
        } else {
          const index = queue.findIndex((job) => job.id === current?.id);
          const job = queue[index - 1];
          if (job) await start(job, queue);
        }
      },
      setSpeed: (value) => {
        speedRef.current = value;
        if (audio.current) audio.current.playbackRate = value;
        setSpeedState(value);
      },
      setVolume: (value) => {
        const next = Math.max(0, Math.min(1, value));
        if (audio.current) audio.current.volume = next;
        setVolumeState(next);
      },
      setRepeat,
      setShuffle,
      setAutoNext,
      toggleLoop: () => {
        pendingLoopPlay.current = null;
        if (loop) {
          setLoop(null);
          return;
        }
        const span = passageLoop(
          audio.current?.currentTime ?? time,
          audio.current?.duration || duration,
        );
        if (span) setLoop(span);
      },
      selectOriginal: async (nextOriginal) => {
        if (!current || original === nextOriginal) return;
        if (nextOriginal && !current.canDownloadInput) {
          setError("ORIGINAL_UNAVAILABLE");
          return;
        }
        await start(
          current,
          queue,
          audio.current?.currentTime ?? time,
          nextOriginal ? "input" : "output",
          playing,
          false,
        );
      },
      removeFromQueue: (jobId) => {
        if (jobId !== current?.id)
          setQueue((items) => items.filter((item) => item.id !== jobId));
      },
    }),
    [
      current,
      playing,
      time,
      duration,
      error,
      queue,
      speed,
      volume,
      repeat,
      shuffle,
      autoNext,
      original,
      loop,
      start,
      creditStart,
      user.uid,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePlayer() {
  const value = useContext(Context);
  if (!value) throw new Error("PlayerProvider required");
  return value;
}
