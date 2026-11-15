import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, sep } from "node:path";
import {
  journalCodes,
  uiEvents,
  uiCommands,
  companionEvents,
  numberMetrics,
  booleanMetrics,
  cloudReplyValidationReasons,
  stages,
  warningStages,
} from "./native-journal-inventory.mjs";

const UUID =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const definitions = {
  macos_ui: {
    kind: "ui",
    names: ["ui-events.jsonl", "ui-events.jsonl.1"],
    maxBytes: 512 * 1024,
  },
  macos_companion: {
    kind: "companion",
    names: [
      "events.jsonl",
      "events.1.jsonl",
      "events.2.jsonl",
      "events.3.jsonl",
    ],
    maxBytes: 5 * 1024 * 1024,
  },
  macos_desktop: {
    kind: "companion",
    subdirectory: "desktop",
    names: [
      "events.jsonl",
      "events.1.jsonl",
      "events.2.jsonl",
      "events.3.jsonl",
    ],
    maxBytes: 5 * 1024 * 1024,
  },
  macos_setup: {
    kind: "companion",
    subdirectory: "setup",
    names: [
      "events.jsonl",
      "events.1.jsonl",
      "events.2.jsonl",
      "events.3.jsonl",
    ],
    maxBytes: 5 * 1024 * 1024,
  },
};

/** Fixed application-owned journals only; never follow arbitrary operator paths. */
export async function discoverMusicMuteJournals(home = homedir()) {
  const directory = join(
    home,
    "Library",
    "Application Support",
    "MusicMuteLocal",
    "logs",
  );
  const files = {},
    missing = [];
  try {
    let current = parse(directory).root;
    for (const part of relative(current, directory)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("Unsafe journal parent");
    }
    const info = await lstat(directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw Error("Unsafe journal owner");
  } catch {
    return { files, missing: Object.keys(definitions) };
  }
  for (const [name, definition] of Object.entries(definitions)) {
    try {
      const sourceDirectory = definition.subdirectory
        ? join(directory, definition.subdirectory)
        : directory;
      const owner = await lstat(sourceDirectory);
      if (
        !owner.isDirectory() ||
        owner.isSymbolicLink() ||
        owner.uid !== process.getuid?.() ||
        (owner.mode & 0o077) !== 0
      )
        throw Error("Unsafe journal directory");
      const include = [];
      for (const [index, file] of definition.names.entries()) {
        const path = join(sourceDirectory, file);
        try {
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1 ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o077) !== 0 ||
            info.size > definition.maxBytes
          )
            throw Error("Unsafe journal file");
          include.push(path);
        } catch (error) {
          if (error.code === "ENOENT" && index > 0) continue;
          throw error;
        }
      }
      files[name] = { kind: definition.kind, include };
    } catch {
      missing.push(name);
    }
  }
  return { files, missing };
}

/** Produce Vector-native normalization; raw attributes never enter the capture. */
export function nativeJournalTransform(kind, captureId, journalName = kind) {
  if (!["ui", "companion"].includes(kind))
    throw Error("Unsupported native journal schema");
  const ui = kind === "ui";
  const code = JSON.stringify(journalCodes),
    events = JSON.stringify(ui ? uiEvents : companionEvents);
  const metrics =
    numberMetrics
      .map(
        (key) =>
          `if is_integer(parsed.metrics.${key}) || is_float(parsed.metrics.${key}) { .data.metrics.${key} = parsed.metrics.${key} }`,
      )
      .join("\n") +
    "\n" +
    booleanMetrics
      .map(
        (key) =>
          `if is_boolean(parsed.metrics.${key}) { .data.metrics.${key} = parsed.metrics.${key} }`,
      )
      .join("\n");
  return `parsed, parse_error = parse_json(string!(.message))
collected = now()
. = { "timestamp": collected, "timestampSource": "collection", "receivedAt": collected, "collectedAt": collected, "source": "macos", "origin": "native_journal", "category": "native_journal", "component": ${JSON.stringify(ui ? "app-ui" : "companion")}, "name": "native_journal.invalid", "event": "native_journal.invalid", "summary": "Native application journal metadata", "level": "warn", "instanceId": ${JSON.stringify("journal-" + journalName + "-" + captureId)}, "captureId": ${JSON.stringify(captureId)}, "requestId": null, "userId": null, "data": { "omitted": "raw_journal_attributes", "invalidRecord": true } }
if parse_error == null && is_object(parsed) && parsed.schema_version == 1 && is_string(parsed.session_id) && match(string!(parsed.session_id), r'${UUID}') && is_string(parsed.event) && includes(${events}, parsed.event) {
 .instanceId = parsed.session_id
 .name = "native_journal." + string!(parsed.event)
 .event = .name
 .operation = parsed.event
 .level = "info"
 .data.invalidRecord = false
 .data.journal = ${JSON.stringify(journalName)}
 .data.code = "NONE"
 if is_string(parsed.code) {
  if includes(${code}, parsed.code) { .data.code = parsed.code } else { .data.code = "UNKNOWN_ERROR"; .data.codeOmitted = true }
 }
 source_time = ${ui ? "parsed.at" : "parsed.recorded_at"}
 if is_string(source_time) {
  parsed_time, time_error = parse_timestamp(string!(source_time), format: "%+")
  if time_error == null { .timestamp = parsed_time; .sourceTimestamp = parsed_time; .timestampSource = "service" } else { .data.timestampOmitted = true }
 } else { .data.timestampOmitted = true }
 ${
   ui
     ? `if parsed.event == "app_operation_error" { .level = "error"; .result = "failed" }
 if is_string(parsed.command) && includes(${JSON.stringify(uiCommands)}, parsed.command) { .operation = parsed.command; .data.command = parsed.command } else { .data.commandOmitted = true }`
     : `${journalName === "macos_companion" ? 'if parsed.component == "extension" { .source = "chrome-extension" }' : ""}
 if includes(["extension", "companion", "engine", "harness"], parsed.component) { .component = parsed.component } else { .data.componentOmitted = true }
 if parsed.severity == "warning" { .level = "warn" }
 if parsed.severity == "error" { .level = "error"; .result = "failed" }
 if is_integer(parsed.sequence) && int!(parsed.sequence) > 0 { .seq = parsed.sequence }
 if is_string(parsed.request_id) && match(string!(parsed.request_id), r'${UUID}') { .requestId = parsed.request_id }
 if is_string(parsed.job_id) && match(string!(parsed.job_id), r'${UUID}') { .jobId = parsed.job_id; .data.job_id = parsed.job_id }
 .data.metrics = {}
 ${metrics}
 if exists(parsed.metrics.validation_reason) {
  if parsed.event == "diagnostic_error" && parsed.code == "CLOUD_REPLY_INVALID" && is_string(parsed.metrics.validation_reason) && includes(${JSON.stringify(cloudReplyValidationReasons)}, parsed.metrics.validation_reason) { .data.metrics.validation_reason = parsed.metrics.validation_reason } else { .data.validationReasonOmitted = true }
 }
 if is_integer(parsed.metrics.duration_ms) || is_float(parsed.metrics.duration_ms) { .durationMs = parsed.metrics.duration_ms }
 if is_string(parsed.metrics.stage) && includes(${JSON.stringify(stages)}, parsed.metrics.stage) { .data.stage = parsed.metrics.stage }
 if includes(["none","HELLO","START","CANCEL","STATUS","EVENT","DIAGNOSTICS","CLEAR_CACHE","CHECK","PLAYBACK_STARTED"], parsed.metrics.native_command) { .data.command = parsed.metrics.native_command }
 if parsed.event == "stage_started" || parsed.event == "job_started" || parsed.event == "process_started" { .phase = "started" }
 if parsed.event == "stage_completed" || parsed.event == "job_ready" || parsed.event == "process_exited" { .phase = "completed" }
 if parsed.event == "job_ready" { .result = "success" }
 if parsed.event == "job_cancelled" { .phase = "cancelled"; .result = "cancelled" }
 if parsed.event == "job_failed" { .result = "failed" }
 if parsed.event == "diagnostic_error" && is_string(parsed.metrics.stage) && includes(${JSON.stringify(warningStages)}, parsed.metrics.stage) {
  .operation = parsed.metrics.stage
  .phase = "failed"
  .result = "failed"
  if parsed.code == "CANCELLED" { .phase = "cancelled"; .result = "cancelled" } else {
   if is_integer(parsed.metrics.http_status) && int!(parsed.metrics.http_status) >= 400 && int!(parsed.metrics.http_status) <= 599 { .status = parsed.metrics.http_status }
  }
 }`
 }
}
`;
}

export function addNativeJournalSources(
  sources,
  transforms,
  captureId,
  journalFiles = {},
) {
  for (const [name, definition] of Object.entries(journalFiles)) {
    if (
      !Object.hasOwn(definitions, name) ||
      definition.kind !== definitions[name].kind ||
      !Array.isArray(definition.include) ||
      definition.include.length < 1 ||
      definition.include.length > definitions[name].names.length
    )
      throw Error("Invalid native journal definition");
    sources[`journal_${name}`] = {
      type: "file",
      include: definition.include,
      read_from: "end",
      max_line_bytes: 131072,
      max_read_bytes: 262144,
      glob_minimum_cooldown_ms: 250,
      ignore_checkpoints: false,
      fingerprint: { strategy: "checksum", lines: 1 },
    };
    transforms[`normalize_journal_${name}`] = {
      type: "remap",
      inputs: [`journal_${name}`],
      drop_on_error: true,
      source: nativeJournalTransform(definition.kind, captureId, name),
    };
  }
}
