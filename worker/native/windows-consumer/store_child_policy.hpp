#pragma once
#include "store_gpu_policy.hpp"
namespace mmstorerole {
inline std::string engineSessionId(std::string_view relative, Role actor = Role::personal) {
  mmstore::require(actor == Role::personal || actor == Role::fleet, mmstore::ErrorCode::invalidInput);
  const std::string_view prefix = actor == Role::fleet ? "fleet\\engine-session\\" : "personal\\engine-session\\", suffix = "\\engine-config.json";
  mmstore::require(relative.size() == prefix.size() + 36 + suffix.size() && relative.starts_with(prefix) && relative.ends_with(suffix), mmstore::ErrorCode::invalidInput);
  const auto id = relative.substr(prefix.size(), 36); mmstore::require(data_policy::uuid(id), mmstore::ErrorCode::invalidInput); return std::string(id);
}
inline bool childOperation(Role actor, std::string_view operation, const mm::Json& args) noexcept {
  try {
    if (actor != Role::personal && actor != Role::fleet) return false;
    if (operation == "child-start" || (operation=="child-stop" && args.object().contains("incarnation"))) return data_policy::fields(args, {"config_relative", "incarnation"}) &&
      !engineSessionId(args.at("config_relative").string(), actor).empty() && data_policy::uuid(args.at("incarnation").string());
    if (operation == "child-write") return data_policy::fields(args, {"token", "bytes_base64"}) && mmstore::validDigest(args.at("token").string()) &&
      data_policy::base64(args.at("bytes_base64").string(), 24576, false);
    return (operation == "child-read" || operation == "child-stop") && data_policy::fields(args, {"token"}) && mmstore::validDigest(args.at("token").string());
  } catch (...) { return false; }
}
inline bool fleetEngineConfig(const mm::Json& value, const std::string& session, const std::string& personalRoot,
    const std::string& fleetRoot, const std::string& workerRoot, const std::string& sid, const mm::Json& actualGpu) noexcept {
  try {
    return data_policy::uuid(session) && data_policy::personalSid(sid) && storeGpuIdentity(actualGpu) &&
      data_policy::fields(value, {"version", "sessionId", "sessionRoot", "jobsRoot", "releaseRoot", "modelPath", "sid", "gpuIdentity"}) &&
      value.at("version").integer() == 1 && value.at("sessionId").string() == session && value.at("sid").string() == sid &&
      value.at("sessionRoot").string() == personalRoot + "\\fleet\\engine-session\\" + session &&
      value.at("jobsRoot").string() == fleetRoot + "\\work" && value.at("releaseRoot").string() == workerRoot &&
      value.at("modelPath").string() == personalRoot + "\\models\\Kim_Vocal_2.onnx" && mm::dump(value.at("gpuIdentity")) == mm::dump(actualGpu);
  } catch (...) { return false; }
}
// Pure semantic receiving check only. Expected roots/SID/GPU must come from
// genuine Creator code/namespace/role/GPU authority, never a caller receipt.
inline bool personalEngineConfig(const mm::Json& value, const std::string& session, const std::string& personalRoot,
    const std::string& workerRoot, const std::string& sid, const mm::Json& actualGpu) noexcept {
  try {
    return data_policy::uuid(session) && data_policy::personalSid(sid) && storeGpuIdentity(actualGpu) &&
      data_policy::fields(value, {"version", "sessionId", "sessionRoot", "jobsRoot", "releaseRoot", "modelPath", "sid", "gpuIdentity"}) &&
      value.at("version").integer() == 2 && value.at("sessionId").string() == session && value.at("sid").string() == sid &&
      value.at("sessionRoot").string() == personalRoot + "\\personal\\engine-session\\" + session &&
      value.at("jobsRoot").string() == personalRoot + "\\personal\\jobs" && value.at("releaseRoot").string() == workerRoot &&
      value.at("modelPath").string() == personalRoot + "\\models\\Kim_Vocal_2.onnx" && mm::dump(value.at("gpuIdentity")) == mm::dump(actualGpu);
  } catch (...) { return false; }
}
} // namespace mmstorerole
