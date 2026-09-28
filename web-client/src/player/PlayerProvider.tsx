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
  const { api } = useSignedIn();
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
    ) => {
      const operation = ++generation.current;
      if (
        job.id !== currentRef.current?.id ||
        grant.current?.artifact !== artifact
      )
        recovered.current = false;
      setError(null);
      setCurrent(job);
      setQueue(list.length ? list : [job]);
      setOriginal(artifact === "input");
      if (job.id !== currentRef.current?.id) setLoop(null);
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
          grant.current = selected;
        }
        if (generation.current !== operation) return;
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
        if (shouldPlay) await element.play();
        else element.pause();
      } catch (error) {
        if (generation.current === operation)
          setError(error instanceof Error ? error.message : "PLAYBACK_FAILED");
      }
    },
    [api],
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
        span &&
        span.end - span.start > 0.2 &&
        element.currentTime >= span.end - 0.05 &&
        element.currentTime > span.start
      ) {
        element.currentTime = span.start;
      }
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
        element.currentTime = span.start;
        void element.play();
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
      element.removeEventListener("timeupdate", onTime);
      element.removeEventListener("durationchange", onDuration);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("error", onError);
      element.removeEventListener("ended", onEnd);
    };
  }, [api, start, invalidatePlayback]);

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
          try {
            await audio.current?.play();
          } catch {
            await start(current, queue);
          }
        }
      },
      seek: (value) => {
        if (audio.current) audio.current.currentTime = value;
      },
      next: async () => {
        const index = queue.findIndex((job) => job.id === current?.id);
        const job =
          queue[chooseNextIndex(queue.length, index, repeat, shuffle)];
        if (job) await start(job, queue);
      },
      previous: async () => {
        if (audio.current && audio.current.currentTime > 3)
          audio.current.currentTime = 0;
        else {
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
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePlayer() {
  const value = useContext(Context);
  if (!value) throw new Error("PlayerProvider required");
  return value;
}
