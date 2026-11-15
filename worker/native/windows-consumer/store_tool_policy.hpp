#pragma once
#include "store_data_policy.hpp"
#include "store_runtime.hpp"
#include <cmath>
// Receiving policy for fixed CPU utilities. It never admits a caller command,
// executable, environment, root, script or GPU/readiness receipt.
namespace mmstorerole {
enum class FixedToolKind {
  cloudProbeInput, cloudTranscode, cloudProbeOutput, silenceProbe, silenceDecode,
  doctorMetadata, doctorMedia, downloaderVersion, downloaderHelp, downloaderEjs,
  denoVersion, denoProvider
};
inline std::string_view fixedToolName(FixedToolKind kind) {
  switch (kind) {
    case FixedToolKind::cloudProbeInput: return "cloud-probe-input";
    case FixedToolKind::cloudTranscode: return "cloud-transcode";
    case FixedToolKind::cloudProbeOutput: return "cloud-probe-output";
    case FixedToolKind::silenceProbe: return "silence-probe";
    case FixedToolKind::silenceDecode: return "silence-decode";
    case FixedToolKind::doctorMetadata: return "doctor-metadata";
    case FixedToolKind::doctorMedia: return "doctor-media";
    case FixedToolKind::downloaderVersion: return "downloader-version";
    case FixedToolKind::downloaderHelp: return "downloader-help";
    case FixedToolKind::downloaderEjs: return "downloader-ejs";
    case FixedToolKind::denoVersion: return "deno-version";
    case FixedToolKind::denoProvider: return "deno-provider";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline FixedToolKind parseFixedTool(std::string_view name) {
  for (const auto kind : {FixedToolKind::cloudProbeInput, FixedToolKind::cloudTranscode, FixedToolKind::cloudProbeOutput,
      FixedToolKind::silenceProbe, FixedToolKind::silenceDecode, FixedToolKind::doctorMetadata, FixedToolKind::doctorMedia,
      FixedToolKind::downloaderVersion, FixedToolKind::downloaderHelp, FixedToolKind::downloaderEjs,
      FixedToolKind::denoVersion, FixedToolKind::denoProvider}) if (fixedToolName(kind) == name) return kind;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline bool cpuToolRole(Role actor) noexcept { return actor == Role::personal || actor == Role::prepare; }
inline bool fixedToolOperation(Role actor, std::string_view operation, const mm::Json& args) noexcept {
  try {
    if (!cpuToolRole(actor)) return false;
    if (operation == "tool-start" || (operation == "tool-stop" && args.object().contains("incarnation"))) return data_policy::fields(args, {"kind", "request_id", "incarnation", "configuration_sha256", "operation_token"}) &&
      !fixedToolName(parseFixedTool(args.at("kind").string())).empty() && data_policy::uuid(args.at("request_id").string()) &&
      data_policy::uuid(args.at("incarnation").string()) && mmstore::validDigest(args.at("configuration_sha256").string()) && mmstore::validDigest(args.at("operation_token").string());
    return (operation == "tool-read" || operation == "tool-stop") && data_policy::fields(args, {"token"}) &&
      mmstore::validDigest(args.at("token").string());
  } catch (...) { return false; }
}
inline mmstoreruntime::LaunchKind fixedToolLaunch(FixedToolKind kind) {
  using mmstoreruntime::LaunchKind;
  switch (kind) {
    case FixedToolKind::cloudProbeInput: case FixedToolKind::cloudProbeOutput: case FixedToolKind::silenceProbe: return LaunchKind::ffprobe;
    case FixedToolKind::cloudTranscode: case FixedToolKind::silenceDecode: return LaunchKind::ffmpeg;
    case FixedToolKind::doctorMetadata: return LaunchKind::doctorMetadata;
    case FixedToolKind::doctorMedia: return LaunchKind::doctorMedia;
    case FixedToolKind::downloaderVersion: case FixedToolKind::downloaderHelp: case FixedToolKind::downloaderEjs: return LaunchKind::downloader;
    case FixedToolKind::denoVersion: case FixedToolKind::denoProvider: return LaunchKind::deno;
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline bool silenceTool(FixedToolKind kind) noexcept { return kind == FixedToolKind::silenceProbe || kind == FixedToolKind::silenceDecode; }
inline std::string fixedToolWork(FixedToolKind kind, const std::string& id) {
  mmstore::require(data_policy::uuid(id), mmstore::ErrorCode::invalidInput);
  return std::string(silenceTool(kind) ? "prepare\\work\\" : "cloud\\work\\") + id;
}
inline bool fixedToolConfiguration(FixedToolKind kind, const mm::Json& config, const std::string& request,
    const std::string& sid, const std::string& inventory, const std::string& manifest, const std::string& helper) noexcept {
  try {
    const auto operation = config.at("operation").string();
    const bool cloud = kind == FixedToolKind::cloudProbeInput || kind == FixedToolKind::cloudTranscode || kind == FixedToolKind::cloudProbeOutput;
    const bool silence = silenceTool(kind), doctor = kind == FixedToolKind::doctorMetadata || kind == FixedToolKind::doctorMedia;
    if (!(cloud ? (operation == "cloud_prepare" || (kind == FixedToolKind::cloudProbeInput && operation == "cloud_probe")) :
        silence ? operation == "silence_analyze" : doctor ? operation == "diagnostics_doctor" : operation == "browser_check_youtube")) return false;
    if (!(silence ? data_policy::fields(config, {"version", "operation", "requestId", "executionId", "release", "sid", "manifestSha256", "helperSha256", "inputBytes", "inputSha256", "durationSeconds"}) :
        cloud ? data_policy::fields(config, {"version", "operation", "requestId", "executionId", "release", "sid", "manifestSha256", "helperSha256", "inputBytes"}) :
        data_policy::fields(config, {"version", "operation", "requestId", "executionId", "release", "sid", "manifestSha256", "helperSha256"}))) return false;
    if (config.at("version").integer() != 1 || !data_policy::uuid(request) || config.at("requestId").string() != request ||
        !data_policy::uuid(config.at("executionId").string()) || !data_policy::personalSid(sid) || config.at("sid").string() != sid ||
        !mmstore::validDigest(inventory) || !mmstore::validDigest(manifest) || !mmstore::validDigest(helper) ||
        config.at("release").string() != inventory || config.at("manifestSha256").string() != manifest || config.at("helperSha256").string() != helper) return false;
    if ((cloud || silence) && !data_policy::integer(config.at("inputBytes"), 1, 256LL * 1024 * 1024)) return false;
    if (silence) {
      const auto& duration = config.at("durationSeconds");
      double number = 0;
      if (const auto* decimal = std::get_if<mm::Json::Decimal>(&duration.value)) { std::size_t consumed = 0; number = std::stod(decimal->text, &consumed); if (consumed != decimal->text.size()) return false; }
      else number = static_cast<double>(duration.integer());
      return mmstore::validDigest(config.at("inputSha256").string()) && std::isfinite(number) && number > 0 && number <= 7200;
    }
    return true;
  } catch (...) { return false; }
}
} // namespace mmstorerole
