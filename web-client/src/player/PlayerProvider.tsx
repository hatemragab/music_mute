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

interface PlayerContextValue {
  current: JobView | null;
  playing: boolean;
  time: number;
  duration: number;
  error: string | null;
  queue: JobView[];
  speed: number;
  volume: number;
  repeat: boolean;
  shuffle: boolean;
  play: (job: JobView, queue?: JobView[]) => Promise<void>;
  toggle: () => Promise<void>;
  seek: (time: number) => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  setSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setRepeat: (repeat: boolean) => void;
  setShuffle: (shuffle: boolean) => void;
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
  const [repeat, setRepeat] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const grant = useRef<{
    jobId: string;
    url: string;
    expiresAt: number;
  } | null>(null);
  const currentRef = useRef<JobView | null>(null);
  const queueRef = useRef<JobView[]>([]);
  const repeatRef = useRef(false);
  const shuffleRef = useRef(false);
  const speedRef = useRef(1);
  const generation = useRef(0);
  const recovered = useRef(false);
  const invalidatePlayback = useCallback(() => {
    generation.current += 1;
  }, []);

  const start = useCallback(
    async (job: JobView, list = queueRef.current, resumeAt = 0) => {
      const operation = ++generation.current;
      if (job.id !== currentRef.current?.id) recovered.current = false;
      setError(null);
      setCurrent(job);
      setQueue(list.length ? list : [job]);
      try {
        const element = audio.current;
        if (!element) throw new Error("PLAYBACK_UNAVAILABLE");
        let selected = grant.current;
        if (
          !selected ||
          selected.jobId !== job.id ||
          selected.expiresAt < Date.now() + 30_000
        ) {
          const result = await jobsApi(api).grant(
            job.id,
            "output",
            crypto.randomUUID(),
          );
          selected = {
            jobId: job.id,
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
        await element.play();
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
  }, [current, queue, repeat, shuffle]);
  useEffect(() => {
    const element = new Audio();
    audio.current = element;
    const onTime = () => setTime(element.currentTime || 0);
    const onDuration = () =>
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
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
        void start(currentRef.current, queueRef.current, element.currentTime);
      } else setError("PLAYBACK_FAILED");
    };
    const onEnd = () => {
      const list = queueRef.current;
      const index = list.findIndex(
        (item) => item.id === currentRef.current?.id,
      );
      const target = shuffleRef.current
        ? list[Math.floor(Math.random() * list.length)]
        : (list[index + 1] ?? (repeatRef.current ? list[0] : undefined));
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
        const job = queue[index + 1] ?? (repeat ? queue[0] : undefined);
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
