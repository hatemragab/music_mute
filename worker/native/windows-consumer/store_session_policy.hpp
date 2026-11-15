#pragma once
#include "store_gpu_policy.hpp"
#include "store_control_policy.hpp"
#include "store_cpu_policy.hpp"

namespace mmstorerole {
inline bool storePrepareFailure(std::string_view code) noexcept {
  return code == "GPU_UNSUPPORTED" || code == "INTEGRITY_INVALID" || code == "PERMISSION_DENIED" || code == "BUSY" ||
    code == "PREPARE_INTERRUPTED" || code == "OPERATION_FAILED" || code == "NATIVE_HELPER_UNAVAILABLE";
}
inline bool storePreparationBinding(const mm::Json& binding) noexcept {
  try {
    if (!data_policy::fields(binding, {"package", "inventorySha256", "runtimeManifestSha256", "sid", "bootIdentity", "recipeDigests"}) ||
        !mmstore::validDigest(binding.at("inventorySha256").string()) || !mmstore::validDigest(binding.at("runtimeManifestSha256").string()) || !mmstore::validDigest(binding.at("bootIdentity").string()) || !data_policy::personalSid(binding.at("sid").string())) return false;
    const auto& package = binding.at("package");
    if (!data_policy::fields(package, {"identityName", "publisher", "publisherId", "familyName", "fullName", "packageVersion", "architecture", "signatureKind", "healthy", "current", "installedLocation"}) ||
        package.at("signatureKind").integer() != mmstoreprofile::signatureKind || !std::get<bool>(package.at("healthy").value) || !std::get<bool>(package.at("current").value) || package.at("architecture").string() != "x64") return false;
    for (const auto key : {"identityName", "publisher", "publisherId", "familyName", "fullName", "packageVersion", "installedLocation"}) { const auto& text = package.at(key).string(); if (text.empty() || text.size() > 32768) return false; }
    const auto& recipes = binding.at("recipeDigests");
    if (!data_policy::fields(recipes, {"kim-vocals-v2", "kim-vocals-v2-trim"}) || !mmstore::validDigest(recipes.at("kim-vocals-v2").string()) || !mmstore::validDigest(recipes.at("kim-vocals-v2-trim").string())) return false;
    return true;
  } catch (...) { return false; }
}
inline bool storePrepareRequest(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value, {"version", "requestId", "operation", "binding", "gpu", "fixture"}) || value.at("version").integer() != 1 ||
        !data_policy::uuid(value.at("requestId").string()) || (value.at("operation").string() != "qualify" && value.at("operation").string() != "inspect") ||
        !storeGpuIdentity(value.at("gpu")) || !storePreparationBinding(value.at("binding"))) return false;
    const auto& fixture = value.at("fixture");
    if (fixture.at("kind").string() == "fixed") return data_policy::fields(fixture, {"kind"});
    return data_policy::fields(fixture, {"kind", "relativePath", "sha256", "bytes"}) && fixture.at("kind").string() == "approved" &&
      mmstore::validDigest(fixture.at("sha256").string()) && fixture.at("relativePath").string() == "prepare\\approved\\" + fixture.at("sha256").string() + ".wav" && data_policy::integer(fixture.at("bytes"), 44, 64LL * 1024 * 1024);
  } catch (...) { return false; }
}
inline bool storePrepareLaunch(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value, {"version", "requestId", "owner", "inventorySha256"}) || value.at("version").integer() != 1 || !data_policy::uuid(value.at("requestId").string()) || !mmstore::validDigest(value.at("inventorySha256").string())) return false;
    const auto& owner = value.at("owner"); if (!data_policy::fields(owner, {"role", "nonce", "identity"}) || owner.at("role").string() != "prepare" || !mmstore::validDigest(owner.at("nonce").string())) return false;
    const auto& identity = owner.at("identity"); if (!data_policy::fields(identity, {"sid", "sessionId", "pid", "creationTime"})) return false;
    return data_policy::identity(mm::Json::Object{{"sid", identity.at("sid")}, {"session_id", identity.at("sessionId")}, {"pid", identity.at("pid")}, {"creation_time", identity.at("creationTime")}});
  } catch (...) { return false; }
}
inline bool storeCpuMediaRequest(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value, {"version", "requestId", "binding", "configuration"}) || value.at("version").integer() != 1 ||
        !data_policy::uuid(value.at("requestId").string()) || !storePreparationBinding(value.at("binding"))) return false;
    const auto& config = value.at("configuration"); const auto& binding = value.at("binding");
    if (!cpuOperationName(config.at("operation").string())) return false;
    return fixedToolConfiguration(cpuOperationRepresentative(config.at("operation").string()), config, value.at("requestId").string(), binding.at("sid").string(),
      binding.at("inventorySha256").string(), binding.at("runtimeManifestSha256").string(), config.at("helperSha256").string());
  } catch (...) { return false; }
}
// Only this closed private carrier permits decimal configuration values. The
// enclosing native/Creator/role frames keep their integer-only JSON grammar.
inline mm::Json decodeStoreCpuMediaRequest(const mm::Json& wire) {
  mmstore::require(data_policy::fields(wire, {"version", "requestId", "binding", "configuration_json"}), mmstore::ErrorCode::invalidInput);
  const auto& text = wire.at("configuration_json").string();
  mmstore::require(!text.empty() && text.size() <= 8192, mmstore::ErrorCode::invalidInput);
  const mm::Json request = mm::Json::Object{{"version", wire.at("version")}, {"requestId", wire.at("requestId")}, {"binding", wire.at("binding")},
    {"configuration", mm::JsonParser(text, true).parse()}};
  mmstore::require(storeCpuMediaRequest(request), mmstore::ErrorCode::invalidInput);
  return request;
}
inline mm::Json encodeStoreCpuMediaRequest(const mm::Json& request) {
  mmstore::require(storeCpuMediaRequest(request), mmstore::ErrorCode::invalidInput);
  const auto text = mm::dump(request.at("configuration"));
  mmstore::require(!text.empty() && text.size() <= 8192, mmstore::ErrorCode::invalidInput);
  return mm::Json::Object{{"version", request.at("version")}, {"requestId", request.at("requestId")}, {"binding", request.at("binding")}, {"configuration_json", text}};
}
inline bool storeGuiCpuCommand(const mm::Json& value) noexcept {
  try {
    const auto action = value.at("action").string();
    if (value.at("version").integer() != 1 || !data_policy::uuid(value.at("requestId").string())) return false;
    if (action == "cpu_launch" || action == "cpu_recover") return data_policy::fields(value, {"version", "requestId", "action", "request"}) &&
      storeCpuMediaRequest(decodeStoreCpuMediaRequest(value.at("request"))) && value.at("requestId").string() == value.at("request").at("requestId").string();
    return (action == "cpu_ready" || action == "cpu_start" || action == "cpu_wait" || action == "cpu_cancel") &&
      data_policy::fields(value, {"version", "requestId", "action", "launch"}) && storePrepareLaunch(value.at("launch")) &&
      value.at("requestId").string() == value.at("launch").at("requestId").string();
  } catch (...) { return false; }
}
inline bool storeGuiCpuLargeFrame(const mm::Json& value) noexcept {
  if (!storeGuiCpuCommand(value)) return false;
  try { const auto action = value.at("action").string(); return action == "cpu_launch" || action == "cpu_recover"; }
  catch (...) { return false; }
}
inline bool storeCpuPrepareReady(const mm::Json& value) noexcept {
  try { return data_policy::fields(value, {"requestId", "expectation"}) && data_policy::uuid(value.at("requestId").string()) &&
    cpuOperationExpectation(value.at("expectation")) && value.at("requestId").string() == value.at("expectation").at("requestId").string() &&
    value.at("expectation").at("nodeOwner").at("role").string() == "prepare"; }
  catch (...) { return false; }
}
inline bool storeCpuPrepareResult(const mm::Json& value) noexcept {
  try {
    if (!data_policy::uuid(value.at("requestId").string())) return false;
    if (data_policy::fields(value, {"requestId", "errorCode"})) return storePrepareFailure(value.at("errorCode").string());
    return data_policy::fields(value, {"requestId", "bytes", "sha256"}) && data_policy::integer(value.at("bytes"), 2, 1024LL * 1024) && mmstore::validDigest(value.at("sha256").string());
  } catch (...) { return false; }
}
inline bool storeFleetIdentity(const mm::Json& value) noexcept {
  try { return data_policy::fields(value, {"sid", "sessionId", "pid", "creationTime"}) && data_policy::identity(mm::Json::Object{
    {"sid", value.at("sid")}, {"session_id", value.at("sessionId")}, {"pid", value.at("pid")}, {"creation_time", value.at("creationTime")}}); }
  catch (...) { return false; }
}
inline bool storeFleetOwner(const mm::Json& value) noexcept {
  try { return data_policy::fields(value, {"role", "nonce", "identity"}) && value.at("role").string() == "fleet" &&
    mmstore::validDigest(value.at("nonce").string()) && storeFleetIdentity(value.at("identity")); }
  catch (...) { return false; }
}
inline bool storeBenchmarkConfiguration(const mm::Json& config, const mm::Json& binding, const std::string& id, const std::string& operation) noexcept {
  try {
    auto mandatory=config.object();for(const auto* optional:{"groupSize","candidate","saveAudio"}) mandatory.erase(optional);
    if(!data_policy::fields(mandatory,{"bootIdentity","version","operation","requestId","release","sid","manifestSha256","helperSha256","gpu","fixture","recipe","warmupRuns","measuredRuns"}) ||
      config.at("version").integer()!=1 || config.at("operation").string()!=operation || config.at("requestId").string()!=id ||
      config.at("bootIdentity").string()!=binding.at("bootIdentity").string() || config.at("sid").string()!=binding.at("sid").string() ||
      config.at("release").string()!=binding.at("inventorySha256").string() || config.at("manifestSha256").string()!=binding.at("runtimeManifestSha256").string() ||
      !mmstore::validDigest(config.at("helperSha256").string()) || !storeGpuIdentity(config.at("gpu"))) return false;
    const bool capacity=operation=="benchmark_capacity";
    if(!capacity && operation!="benchmark_file") return false;
    const auto& recipe=config.at("recipe").string();
    if((recipe!="kim-vocals-v2" && recipe!="kim-vocals-v2-trim") || (capacity && recipe!="kim-vocals-v2") ||
      !data_policy::integer(config.at("warmupRuns"),capacity?1:0,2) || !data_policy::integer(config.at("measuredRuns"),3,10)) return false;
    const auto& fixture=config.at("fixture");if(!data_policy::fields(fixture,{"relativePath","sha256","bytes"}) || !mmstore::validDigest(fixture.at("sha256").string()) ||
      !data_policy::integer(fixture.at("bytes"),44,capacity?64LL*1024*1024:256LL*1024*1024) || fixture.at("relativePath").string()!=(capacity?"prepare\\approved\\"+fixture.at("sha256").string()+".wav":"prepare\\work\\"+id+"\\source.wav")) return false;
    if(config.object().contains("groupSize") && config.at("groupSize").integer()!=1) return false;
    if(config.object().contains("saveAudio") && (capacity?std::get<bool>(config.at("saveAudio").value):false)) return false;
    if(config.object().contains("saveAudio") && !std::holds_alternative<bool>(config.at("saveAudio").value)) return false;
    if(config.object().contains("candidate")) {const auto& candidate=config.at("candidate");if(capacity || !data_policy::fields(candidate,{"release","manifestSha256","engineDigest"}) ||
      candidate.at("release").string()!=binding.at("inventorySha256").string() || candidate.at("manifestSha256").string()!=binding.at("runtimeManifestSha256").string() || !mmstore::validDigest(candidate.at("engineDigest").string())) return false;}
    return true;
  }catch(...){return false;}
}
inline mm::Json decodeStoreBenchmarkRequest(const mm::Json& wire) {
  mmstore::require(data_policy::fields(wire,{"version","requestId","operation","binding","configuration_json"}) && wire.at("version").integer()==1 &&
    data_policy::uuid(wire.at("requestId").string()) && storePreparationBinding(wire.at("binding")),mmstore::ErrorCode::invalidInput);
  const auto& text=wire.at("configuration_json").string();mmstore::require(!text.empty() && text.size()<=16384,mmstore::ErrorCode::invalidInput);
  const auto config=mm::JsonParser(text,true).parse();
  mmstore::require(storeBenchmarkConfiguration(config,wire.at("binding"),wire.at("requestId").string(),wire.at("operation").string()),mmstore::ErrorCode::invalidInput);
  return mm::Json::Object{{"version",1},{"requestId",wire.at("requestId")},{"operation",wire.at("operation")},{"binding",wire.at("binding")},{"configuration",config}};
}
inline bool storeGuiBenchmarkCommand(const mm::Json& value) noexcept {
  try {
    if(value.at("version").integer()!=1 || !data_policy::uuid(value.at("requestId").string())) return false;
    const auto& action=value.at("action").string();
    if(action=="benchmark_launch" || action=="benchmark_recover") return data_policy::fields(value,{"version","requestId","action","request"}) &&
      decodeStoreBenchmarkRequest(value.at("request")).at("requestId").string()==value.at("requestId").string();
    return (action=="benchmark_wait" || action=="benchmark_cancel") && data_policy::fields(value,{"version","requestId","action","launch"}) &&
      storePrepareLaunch(value.at("launch")) && value.at("launch").at("requestId").string()==value.at("requestId").string();
  }catch(...){return false;}
}
inline bool storeGuiBenchmarkLargeFrame(const mm::Json& value) noexcept {
  if (!storeGuiBenchmarkCommand(value)) return false;
  try { const auto& action = value.at("action").string(); return action == "benchmark_launch" || action == "benchmark_recover"; }
  catch (...) { return false; }
}
inline bool storeBenchmarkResult(const mm::Json& value) noexcept {
  try {
    if(!data_policy::uuid(value.at("requestId").string())) return false;
    if(data_policy::fields(value,{"requestId","errorCode"})) return storePrepareFailure(value.at("errorCode").string());
    if(!data_policy::fields(value,{"requestId","configurationSha256","rawBytes","rawSha256","wallSeconds_json"}) ||
      !mmstore::validDigest(value.at("configurationSha256").string()) || !mmstore::validDigest(value.at("rawSha256").string()) ||
      !data_policy::integer(value.at("rawBytes"),2,8LL*1024*1024)) return false;
    const auto& text=value.at("wallSeconds_json").string();if(text.empty() || text.size()>32) return false;
    const auto parsed=mm::JsonParser(text,true).parse();double seconds=0;
    if(const auto* decimal=std::get_if<mm::Json::Decimal>(&parsed.value)){std::size_t consumed=0;seconds=std::stod(decimal->text,&consumed);if(consumed!=decimal->text.size()) return false;}else seconds=static_cast<double>(parsed.integer());
    return std::isfinite(seconds) && seconds>0 && seconds<=86400;
  }catch(...){return false;}
}
inline bool storeSessionCommand(const mm::Json& value) noexcept {
  try {
    const auto action = value.at("action").string();
    if(action.starts_with("benchmark_")) return storeGuiBenchmarkCommand(value);
    if (action == "fleet_owner" || action == "fleet_peer") return value.at("version").integer() == 1 && data_policy::uuid(value.at("requestId").string()) &&
      (action == "fleet_owner" ? data_policy::fields(value, {"version", "requestId", "action"}) :
        data_policy::fields(value, {"version", "requestId", "action", "owner", "identity"}) && storeFleetOwner(value.at("owner")) && storeFleetIdentity(value.at("identity")));
    if (action.starts_with("cpu_") && action != "cpu_operation_inspect") return storeGuiCpuCommand(value);
    if (action == "cpu_operation_inspect") return data_policy::fields(value, {"version", "requestId", "action", "expectation"}) && value.at("version").integer() == 1 && data_policy::uuid(value.at("requestId").string()) && cpuOperationExpectation(value.at("expectation"));
    if (action == "session_forward" || action == "session_forward_ack") return guiForward(value);
    if ((action == "prepare_launch" || action == "prepare_recover") && data_policy::fields(value, {"version", "requestId", "action", "request"}))
      return value.at("version").integer() == 1 && data_policy::uuid(value.at("requestId").string()) && storePrepareRequest(value.at("request")) && value.at("requestId").string() == value.at("request").at("requestId").string();
    return (action == "prepare_wait" || action == "prepare_cancel") && data_policy::fields(value, {"version", "requestId", "action", "launch"}) &&
      value.at("version").integer() == 1 && data_policy::uuid(value.at("requestId").string()) && storePrepareLaunch(value.at("launch")) && value.at("requestId").string() == value.at("launch").at("requestId").string();
  } catch (...) { return false; }
}
inline bool storeCpuForgetCommand(const mm::Json& value) noexcept {
  try { return data_policy::fields(value, {"version", "requestId", "action", "expectation"}) &&
    value.at("version").integer() == 1 && data_policy::uuid(value.at("requestId").string()) &&
    (value.at("action").string() == "cpu_operation_forget" || value.at("action").string() == "cpu_operation_release") && cpuOperationExpectation(value.at("expectation")); }
  catch (...) { return false; }
}
// Only the genuine compiled GUI ACK path constructs this private action.
// storeSessionCommand remains the separate public receiving allowlist.
inline bool storeCreatorGuiCommand(const mm::Json& value) noexcept {
  return storeSessionCommand(value) || storeCpuForgetCommand(value);
}
} // namespace mmstorerole
