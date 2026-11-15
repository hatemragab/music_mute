#pragma once
#include "store_role_policy.hpp"
#include <algorithm>
#include <array>

namespace mmstorerole {
namespace data_policy {
inline bool fields(const mm::Json& value, std::initializer_list<std::string_view> names) {
  if (!std::holds_alternative<mm::Json::Object>(value.value) || value.object().size() != names.size()) return false;
  return std::all_of(names.begin(), names.end(), [&](auto name) { return value.object().contains(std::string(name)); });
}
inline bool integer(const mm::Json& value, std::int64_t minimum, std::int64_t maximum) {
  return std::holds_alternative<std::int64_t>(value.value) && value.integer() >= minimum && value.integer() <= maximum;
}
inline bool digits(std::string_view value, std::size_t maximum, bool zero = false) {
  if (value.empty() || value.size() > maximum || value.find_first_not_of("0123456789") != std::string_view::npos) return false;
  if (value.front() == '0') return zero && value.size() == 1;
  return value.size() < 20 || value <= "18446744073709551615";
}
inline bool personalSid(std::string_view sid) {
  if ((!sid.starts_with("S-1-5-21-") && !sid.starts_with("S-1-12-1-")) || sid.size() > 96) return false;
  auto tail = std::string_view(sid).substr(9);
  for (unsigned n = 0; n < 4; ++n) {
    const auto dash = tail.find('-');
    const auto component = tail.substr(0, dash);
    if (!digits(component, 10, true) || (component.size() == 10 && component > "4294967295")) return false;
    if (n == 3) { if (dash != std::string_view::npos) return false; }
    else { if (dash == std::string_view::npos) return false; tail.remove_prefix(dash + 1); }
  }
  return true;
}
inline bool identity(const mm::Json& value) {
  if (!fields(value, {"sid", "session_id", "pid", "creation_time"}) || !personalSid(value.at("sid").string())) return false;
  return integer(value.at("session_id"), 1, 4294967295LL) && integer(value.at("pid"), 1, 2147483647) && validBirth(value.at("creation_time").string());
}
inline bool birth(const mm::Json& value) {
  if (!fields(value, {"device", "file_id", "born_at"})) return false;
  const auto& device = value.at("device").string();
  return digits(device, 10, true) && (device.size() < 10 || device <= "4294967295") &&
    validBirth(value.at("file_id").string()) && validBirth(value.at("born_at").string());
}
inline bool fingerprint(const mm::Json& value, bool directory) {
  if (directory) return birth(value);
  if (!fields(value, {"device", "file_id", "born_at", "bytes", "written_at", "changed_at"})) return false;
  const mm::Json::Object nodeBirth{{"device", value.at("device")}, {"file_id", value.at("file_id")}, {"born_at", value.at("born_at")}};
  return birth(nodeBirth) && integer(value.at("bytes"), 0, 9007199254740991LL) &&
    digits(value.at("written_at").string(), 19, true) && digits(value.at("changed_at").string(), 19, true);
}
inline bool hex(std::string_view value, std::size_t size) {
  return value.size() == size && value.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}
inline bool uuid(std::string_view value) {
  if (value.size() != 36 || value[14] != '4' || std::string_view("89ab").find(value[19]) == std::string_view::npos) return false;
  for (std::size_t n = 0; n < value.size(); ++n) {
    if (n == 8 || n == 13 || n == 18 || n == 23) { if (value[n] != '-') return false; }
    else if (std::string_view("0123456789abcdef").find(value[n]) == std::string_view::npos) return false;
  }
  return true;
}
inline bool approvedFixturePath(std::string_view value) {
  constexpr std::string_view prefix="prepare\\approved\\";
  return value.size()==prefix.size()+64+4 && value.starts_with(prefix) && value.ends_with(".wav") &&
    mmstore::validDigest(value.substr(prefix.size(),64));
}
inline bool base64(std::string_view value, std::size_t maximum, bool empty) {
  if (value.empty()) return empty;
  if (value.size() % 4 || value.size() > ((maximum + 2) / 3) * 4) return false;
  constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::size_t padding = value.back() == '=' ? 1 : 0;
  if (padding && value[value.size() - 2] == '=') ++padding;
  for (std::size_t n = 0; n < value.size() - padding; ++n)
    if (alphabet.find(value[n]) == std::string_view::npos) return false;
  if (value.size() / 4 * 3 - padding > maximum) return false;
  // Reject alternate encodings with nonzero unused bits; native writes also
  // compare the decoded bytes' canonical encoding before touching a handle.
  if (padding && (alphabet.find(value[value.size() - padding - 1]) & (padding == 2 ? 15 : 3))) return false;
  return true;
}
inline std::string lower(std::string_view value) {
  std::string result(value);
  for (auto& c : result) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
  return result;
}
inline bool relative(std::string_view value, bool empty) {
  if (value.empty()) return empty;
  if (value.size() > 4096 || value.front() == '\\' || value.back() == '\\' ||
      std::count(value.begin(), value.end(), '\\') >= 32 || value.find_first_of("/:<>\"|?*") != std::string_view::npos) return false;
  for (const unsigned char c : value) if (c < 32 || c == 127) return false;
  while (!value.empty()) {
    const auto split = value.find('\\');
    const auto part = value.substr(0, split);
    if (part.empty() || part == "." || part == ".." || part.back() == '.' || part.back() == ' ') return false;
    const auto stem = lower(part.substr(0, part.find('.')));
    if (stem == "con" || stem == "prn" || stem == "aux" || stem == "nul" ||
        (stem.size() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem[3] >= '1' && stem[3] <= '9')) return false;
    if (split == std::string_view::npos) break;
    value.remove_prefix(split + 1);
  }
  return true;
}
inline bool dataPath(Role role, std::string_view root, std::string_view path, bool empty, bool directoryInspection = false) {
  if ((root != "personal" && root != "fleet") || (root == "fleet" && role == Role::personal) || !relative(path, empty)) return false;
  const auto folded = lower(path);
  // DPAPI is available only through the key policy below. Raw file mutation
  // must never reach unrelated vaults or legacy executable/update trees.
  if (directoryInspection && root == "fleet" && folded == "vault\\fleet") return true;
  auto rest = std::string_view(folded);
  while (!rest.empty()) {
    const auto split = rest.find('\\');
    const auto part = rest.substr(0, split);
    if (part == "vault" || part == "runtime" || part == "updates" || part == "installers") return false;
    if (split == std::string_view::npos) break;
    rest.remove_prefix(split + 1);
  }
  return true;
}
inline bool scope(Role role, std::string_view value) {
  if (value == "session") return role == Role::session;
  if (value == "prepare" || value == "cache" || value == "metadata") return role != Role::login;
  return value == "acquisition" && role == Role::personal;
}
inline bool accountKey(Role role, std::string_view key, std::string_view operation) {
  const bool read = operation == "vault_get", remove = operation == "vault_delete";
  if (key == "installation") return !remove;
  if (key == "prepare_maintenance" || key == "prepare_journal" || key == "prepare_model_transfer" || key == "store_model_ready")
    return read || role == Role::prepare;
  if (key == "startup_measurements") return !remove && (role == Role::session || role == Role::prepare || role == Role::personal);
  if (key.starts_with("prepare_fixture_") && hex(key.substr(16),48)) return role == Role::prepare;
  if (key == "personal_ticket" || key == "personal_admission_ticket" || key == "personal_events_ticket")
    return role == Role::personal || (read && role == Role::session);
  if (key == "personal_requests" || key == "personal_acquisition" || key == "youtube_guest")
    return role == Role::personal && !remove;
  return role == Role::personal && key.starts_with("personal_input_") && uuid(key.substr(15));
}
inline bool fleetKey(Role role, std::string_view key, std::string_view operation) {
  const bool read = operation == "vault_get", remove = operation == "vault_delete";
  if (key == "session_state") return role == Role::session && !remove;
  if (key == "session_ticket") return role == Role::session || (read && (role == Role::personal || role == Role::fleet));
  if (key == "enrollment") return (role == Role::session || role == Role::fleet) && !remove;
  if (key == "removed" || key == "purged_tombstone" || key == "confirmed_unpair" || key == "capacity" || key == "requalification" || key == "store_active_runtime")
    return read && (role == Role::session || role == Role::fleet || role == Role::prepare);
  if (key == "fleet_ticket") return role == Role::fleet || (read && role == Role::session);
  if (key == "gpu_broker_index" || key == "gpu_broker_state" || (key.starts_with("gpu_broker_") && hex(key.substr(11), 16)))
    return role == Role::session;
  // These are observations of guardian-written records. A mutable receipt
  // cannot mint a new Job, role, launch permission or exit certificate.
  if (key == "latest_personal_job" || key == "latest_fleet_job" || key == "latest_prepare_job" ||
      (key.starts_with("job_owner_") && hex(key.substr(10), 54)) || (key.starts_with("job_exit_") && hex(key.substr(9), 55))) return read;
  return false;
}
inline bool personalCleanup(std::string_view operation, const mm::Json& args) {
  // These schemas admit only the established guarded data operations. Their
  // effects still require the original cache lease, durable journal and exact
  // held object. No raw delete, executable path or retirement assertion exists.
  const auto cache = [&] { return mmstore::validDigest(args.at("cache_nonce").string()); };
  const auto request = [&] { return uuid(args.at("request_id").string()); };
  const auto path = [&] { return dataPath(Role::personal, "personal", args.at("relative_path").string(), false); };
  const auto receipt = [&] { return mmstore::validDigest(args.at("receipt_id").string()) && mmstore::validDigest(args.at("nonce").string()); };
  if (operation == "cache_delete_recover" || operation == "personal_cleanup_recover" ||
      operation == "storage_cleanup_recover" || operation == "library_tree_cleanup_list")
    return fields(args, {"cache_nonce"}) && cache();
  if (operation == "cache_delete_begin") {
    if (!fields(args, {"request_id", "relative_path", "kind", "expected", "cache_nonce"}) || !cache() || !request() || !path()) return false;
    const auto& kind = args.at("kind").string();
    return (kind == "file" || kind == "directory") && fingerprint(args.at("expected"), kind == "directory");
  }
  if (operation == "cache_delete_commit" || operation == "cache_delete_release")
    return fields(args, {"request_id", "relative_path", "kind", "nonce", "cache_nonce"}) && cache() && request() && path() &&
      mmstore::validDigest(args.at("nonce").string()) && (args.at("kind").string() == "file" || args.at("kind").string() == "directory");
  if (operation == "storage_partial_discard") return fields(args, {"request_id", "cache_nonce"}) && cache() && request();
  if (operation == "library_artifact_discard") return fields(args, {"request_id", "relative_path", "expected", "cache_nonce"}) &&
    cache() && request() && path() && fingerprint(args.at("expected"), false);
  if (operation == "library_tree_discard") return fields(args, {"relative_path", "birth", "deletion_id", "cache_nonce"}) && cache() && path() &&
    birth(args.at("birth")) && (std::holds_alternative<std::nullptr_t>(args.at("deletion_id").value) || uuid(args.at("deletion_id").string()));
  if (operation == "library_tree_cleanup_ack" || operation == "storage_cleanup_ack")
    return fields(args, {"receipt_id", "nonce", "cache_nonce"}) && cache() && receipt();
  if (operation == "library_local_move") return fields(args, {"request_id", "direction", "cache_nonce"}) && cache() && request() &&
    (args.at("direction").string() == "tombstone" || args.at("direction").string() == "restore");
  if (operation == "library_artifact_publish" || operation == "library_artifact_publication_inspect")
    return fields(args, {"request_id", "component", "cache_nonce"}) && cache() && request() &&
      (args.at("component").string() == "media" || args.at("component").string() == "metadata");
  if (operation == "storage_workspace_marker_retire") {
    if (!fields(args, {"relative_path", "owner", "cache_nonce"}) || !cache() || !path()) return false;
    const auto& owner = args.at("owner");
    return fields(owner, {"role", "nonce", "identity"}) && owner.at("role").string() == "personal" &&
      mmstore::validDigest(owner.at("nonce").string()) && identity(owner.at("identity"));
  }
  return false;
}
inline bool cpuExpectation(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value, {"version", "distribution", "kind", "requestId", "incarnation", "operation", "configurationSha256", "inventorySha256", "runtimeManifestSha256", "nodeOwner", "token"}) ||
        value.at("version").integer() != 1 || value.at("distribution").string() != "microsoft-store" || value.at("kind").string() != "cpu-tools" ||
        !data_policy::uuid(value.at("requestId").string()) || !data_policy::uuid(value.at("incarnation").string()) || (value.at("operation").string() != "cloud_prepare" && value.at("operation").string() != "cloud_probe" && value.at("operation").string() != "silence_analyze" && value.at("operation").string() != "diagnostics_doctor" && value.at("operation").string() != "browser_check_youtube")) return false;
    for (const auto key : {"configurationSha256", "inventorySha256", "runtimeManifestSha256", "token"}) if (!mmstore::validDigest(value.at(key).string())) return false;
    const auto& owner = value.at("nodeOwner");
    if (!data_policy::fields(owner, {"role", "nonce", "identity"}) || (owner.at("role").string() != "personal" && owner.at("role").string() != "prepare") || !mmstore::validDigest(owner.at("nonce").string())) return false;
    const auto& identity = owner.at("identity");
    return data_policy::fields(identity, {"sid", "sessionId", "pid", "creationTime"}) && data_policy::identity(mm::Json::Object{
      {"sid", identity.at("sid")}, {"session_id", identity.at("sessionId")}, {"pid", identity.at("pid")}, {"creation_time", identity.at("creationTime")}});
  } catch (...) { return false; }
}
inline bool cpuWorkspaceRetire(Role role, const mm::Json& args) {
  if ((role != Role::personal && role != Role::prepare) || !fields(args, {"relative_path", "expectation", "cache_nonce"}) || !mmstore::validDigest(args.at("cache_nonce").string()) || !cpuExpectation(args.at("expectation"))) return false;
  const auto& expected = args.at("expectation");
  return expected.at("nodeOwner").at("role").string() == roleName(role) && args.at("relative_path").string() == std::string(expected.at("operation").string() == "silence_analyze" ? "prepare\\work\\" : "cloud\\work\\") + expected.at("requestId").string();
}
} // namespace data_policy

// Receiving policy only. The caller must already hold and revalidate an actual
// creator-issued StoreRoleBinding, package namespace and current generation.
// Returning true never substitutes for the existing native handle/lease checks.
inline bool workerDataOperation(Role role, std::string_view operation, const mm::Json& args) noexcept {
  using namespace data_policy;
  try {
    if (role != Role::session && role != Role::personal && role != Role::fleet && role != Role::prepare) return false;
    if (operation == "store_cpu_operation_cleanup_inspect") return (role == Role::personal || role == Role::prepare) && fields(args, {"expectation"}) && cpuExpectation(args.at("expectation")) && args.at("expectation").at("nodeOwner").at("role").string() == roleName(role);
    if (operation == "store_cpu_workspace_marker_acknowledge") return (role == Role::personal || role == Role::prepare) && fields(args, {"receipt_id", "nonce", "expectation", "cache_nonce"}) && mmstore::validDigest(args.at("receipt_id").string()) && mmstore::validDigest(args.at("nonce").string()) && mmstore::validDigest(args.at("cache_nonce").string()) && cpuExpectation(args.at("expectation")) && args.at("expectation").at("nodeOwner").at("role").string() == roleName(role);
    if (operation == "store_cpu_workspace_marker_release") return (role == Role::personal || role == Role::prepare) && fields(args, {"receipt_id", "nonce", "expectation", "ack_nonce", "cache_nonce"}) && mmstore::validDigest(args.at("receipt_id").string()) && mmstore::validDigest(args.at("nonce").string()) && mmstore::validDigest(args.at("ack_nonce").string()) && mmstore::validDigest(args.at("cache_nonce").string()) && cpuExpectation(args.at("expectation")) && args.at("expectation").at("nodeOwner").at("role").string() == roleName(role);
    if (operation == "store_cpu_workspace_marker_retire") return cpuWorkspaceRetire(role, args);
    if (operation == "store_fixture_file_open") return role == Role::prepare &&
      fields(args,{"root","relative_path","mode","maximum_bytes","expected_birth"}) && args.at("root").string()=="personal" &&
      approvedFixturePath(args.at("relative_path").string()) && integer(args.at("maximum_bytes"),44,64*1024*1024) &&
      ((args.at("mode").string()=="create-new" && std::holds_alternative<std::nullptr_t>(args.at("expected_birth").value)) ||
       (args.at("mode").string()=="resume" && birth(args.at("expected_birth"))));
    if (role == Role::personal && personalCleanup(operation, args)) return true;
    if (operation == "identity" || operation == "boot_identity" || operation == "gpu_inventory") return fields(args, {});
    if (operation == "process_identity") return fields(args, {"pid"}) && integer(args.at("pid"), 1, 2147483647);
    if (operation == "ensure_private_directory") return fields(args, {"root", "relative_path"}) &&
      dataPath(role, args.at("root").string(), args.at("relative_path").string(), true);
    if (operation == "validate_path") {
      if (!fields(args, {"root", "relative_path", "kind"})) return false;
      const auto& kind = args.at("kind").string();
      return (kind == "file" || kind == "directory" || kind == "absent") &&
        dataPath(role, args.at("root").string(), args.at("relative_path").string(), true, kind == "directory");
    }
    if (operation == "private_file_open") {
      if (!fields(args, {"root", "relative_path", "mode", "maximum_bytes", "expected_birth"}) || args.at("root").string() != "personal" ||
          !dataPath(role, "personal", args.at("relative_path").string(), false) || !integer(args.at("maximum_bytes"), 1, 4294967296LL)) return false;
      const auto& mode = args.at("mode").string();
      if (mode == "resume") return role == Role::prepare && args.at("relative_path").string() == "models\\Kim_Vocal_2.onnx.part" && birth(args.at("expected_birth"));
      return (mode == "read" || mode == "create-new") && std::holds_alternative<std::nullptr_t>(args.at("expected_birth").value);
    }
    if (operation == "private_file_info" || operation == "private_file_sync" || operation == "private_file_close")
      return fields(args, {"token"}) && mmstore::validDigest(args.at("token").string());
    if (operation == "private_file_read") return fields(args, {"token", "position", "length"}) &&
      mmstore::validDigest(args.at("token").string()) && integer(args.at("position"), 0, 4294967296LL) && integer(args.at("length"), 0, 24576);
    if (operation == "private_file_write") return fields(args, {"token", "position", "bytes_base64"}) &&
      mmstore::validDigest(args.at("token").string()) && integer(args.at("position"), 0, 4294967296LL) && base64(args.at("bytes_base64").string(), 24576, true);
    if (operation == "private_file_truncate") return fields(args, {"token", "length"}) && mmstore::validDigest(args.at("token").string()) && integer(args.at("length"), 0, 4294967296LL);
    if (operation == "vault_get" || operation == "vault_put" || operation == "vault_delete") {
      if (!(operation == "vault_put" ? fields(args, {"namespace", "key", "bytes_base64"}) : fields(args, {"namespace", "key"}))) return false;
      const auto& name = args.at("namespace").string(); const auto& key = args.at("key").string();
      if (key.empty() || key.size() > 64 || key.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) return false;
      if (!(name == "account" ? accountKey(role, key, operation) : name == "fleet" && fleetKey(role, key, operation))) return false;
      return operation != "vault_put" || base64(args.at("bytes_base64").string(), 16384, false);
    }
    // Namespace-wide recovery can retire unrelated records and is GUI-owned.
    if (operation == "vault_recover") return false;
    if (operation == "acquire_mutex") return fields(args, {"scope"}) && scope(role, args.at("scope").string());
    if (operation == "release_mutex") return fields(args, {"scope", "nonce", "identity"}) && scope(role, args.at("scope").string()) &&
      mmstore::validDigest(args.at("nonce").string()) && identity(args.at("identity"));
    if (operation == "singleton_inspect") return fields(args, {"scope"}) && args.at("scope").string() == "session" && role == Role::session;
    return false;
  } catch (...) { return false; }
}
} // namespace mmstorerole
