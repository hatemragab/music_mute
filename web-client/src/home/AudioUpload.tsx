import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import type { ProcessingPolicyView } from "../api/types";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, useI18n } from "../i18n";
import {
  inspectDuration,
  prepareAudio,
  sha256Hex,
  uploadWithProgress,
  type UploadGrant,
} from "./audio-preparation";

export function AudioUpload({
  allowed,
  policy,
}: {
  allowed: boolean;
  policy?: ProcessingPolicyView;
}) {
  const { api, user } = useSignedIn();
  const { t, number } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [rights, setRights] = useState(false);
  const [trim, setTrim] = useState(true);
  const [phase, setPhase] = useState<
    "idle" | "inspect" | "prepare" | "upload" | "confirm"
  >("idle");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function choose(selected: File | null) {
    controller.current?.abort();
    setFile(null);
    setDuration(0);
    setError("");
    setRights(false);
    if (!selected) return;
    if (
      selected.type.startsWith("video/") ||
      !/\.(m4a|mp4|webm|opus|ogg|aac|mp3|wav|flac)$/i.test(selected.name)
    ) {
      setError(t("unsupportedAudio"));
      return;
    }
    if (selected.size > (policy?.limits.maxLocalSourceBytes ?? 200_000_000)) {
      setError(t("fileTooLarge"));
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setPhase("inspect");
    try {
      const seconds = await inspectDuration(selected, abort.signal);
      if (seconds > (policy?.limits.maxDurationSeconds ?? 1200)) {
        setError(t("durationTooLong"));
        return;
      }
      setDuration(seconds);
      setFile(selected);
    } catch (error) {
      if (!abort.signal.aborted) setError(friendlyError(error, t));
    } finally {
      setPhase("idle");
    }
  }
  function changed(event: ChangeEvent<HTMLInputElement>) {
    void choose(event.target.files?.[0] ?? null);
  }
  function dropped(event: DragEvent) {
    event.preventDefault();
    void choose(event.dataTransfer.files[0] ?? null);
  }

  async function submit() {
    if (!file || !duration || phase !== "idle" || !allowed) return;
    if (!rights) {
      setError(t("missingRights"));
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setError("");
    setPhase("prepare");
    try {
      const prepared = await prepareAudio(file, duration, abort.signal);
      const preparedDuration =
        prepared.blob === file
          ? duration
          : await inspectDuration(
              new File([prepared.blob], `prepared.${prepared.extension}`, {
                type: prepared.contentType,
              }),
              abort.signal,
            );
      if (preparedDuration > (policy?.limits.maxDurationSeconds ?? 1200))
        throw new Error("MEDIA_TOO_LONG");
      if (
        prepared.blob.size >
        (policy?.limits.maxPreparedAudioBytes ?? 50_000_000)
      )
        throw new Error("PREPARED_AUDIO_TOO_LARGE");
      const sha256 = await sha256Hex(prepared.blob);
      const operationKey = `musicmute.web.upload.${user.uid}`;
      const fingerprint = `${sha256}:${prepared.blob.size}:${trim}`;
      let requestId: string = crypto.randomUUID();
      try {
        const previous = JSON.parse(
          sessionStorage.getItem(operationKey) || "null",
        ) as { fingerprint?: string; requestId?: string } | null;
        if (previous?.fingerprint === fingerprint && previous.requestId)
          requestId = previous.requestId;
      } catch {
        /* discard malformed local state */
      }
      sessionStorage.setItem(
        operationKey,
        JSON.stringify({ fingerprint, requestId }),
      );
      const created = await api.post<{
        id: string;
        status: string;
        upload?: UploadGrant;
      }>("/jobs", {
        policyVersion: 2,
        preparationProfileId:
          policy?.preparationProfile.id || "audio-cap-aac-lc-160-v1",
        source: "audio_file",
        requestId,
        trimEnabled: trim,
        input: {
          extension: prepared.extension,
          contentType: prepared.contentType,
          bytes: prepared.blob.size,
          durationSeconds: preparedDuration,
          sha256,
        },
        sourceTitle: file.name.slice(0, 200),
        sourceKind: "file",
      });
      if (created.status === "awaiting_upload") {
        setPhase("upload");
        const grant =
          created.upload ??
          (await api.post<UploadGrant>(`/jobs/${created.id}/upload-grants`, {
            requestId,
          }));
        await uploadWithProgress(
          grant,
          prepared.blob,
          abort.signal,
          setPercent,
        );
        setPhase("confirm");
        await api.post(`/jobs/${created.id}/upload-completions`, {});
      }
      sessionStorage.removeItem(operationKey);
      await queryClient.invalidateQueries({ queryKey: [user.uid, "jobs"] });
      navigate(`/jobs/${created.id}`);
    } catch (error) {
      if (!abort.signal.aborted) setError(friendlyError(error, t));
    } finally {
      setPhase("idle");
      setPercent(0);
    }
  }
  return (
    <div className="intake-form">
      <h2>{t("uploadAudio")}</h2>
      <div
        className="drop-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropped}
      >
        <span aria-hidden="true">♫</span>
        <label>
          {t("selectAudio")}
          <input
            type="file"
            accept="audio/*,.m4a,.mp3,.aac,.opus,.ogg,.webm,.wav,.flac"
            onChange={changed}
          />
        </label>
        <small>{t("dropAudio")}</small>
      </div>
      {file && (
        <div className="file-review">
          <h3>{t("review")}</h3>
          <p dir="auto">{file.name}</p>
          <small>
            {number(file.size / 1_000_000)} MB · {number(Math.round(duration))}{" "}
            {t("seconds")}
          </small>
          <label className="check">
            <input
              type="checkbox"
              checked={trim}
              onChange={(event) => setTrim(event.target.checked)}
            />
            {t("trim")}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={rights}
              onChange={(event) => setRights(event.target.checked)}
            />
            {t("rights")}
          </label>
        </div>
      )}
      {phase !== "idle" && (
        <div role="status">
          <p>
            {phase === "prepare"
              ? t("preparing")
              : phase === "upload"
                ? t("uploading")
                : t("loading")}
          </p>
          {phase === "upload" && <progress max="100" value={percent} />}
        </div>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="action-row">
        <button
          className="primary"
          type="button"
          disabled={!file || !allowed || phase !== "idle"}
          onClick={() => void submit()}
        >
          {t("startUpload")}
        </button>
        {phase !== "idle" && (
          <button type="button" onClick={() => controller.current?.abort()}>
            {t("cancel")}
          </button>
        )}
      </div>
      <small>{t("browserLimit")}</small>
    </div>
  );
}
