#pragma once
#include "store_data_policy.hpp"

namespace mmstorerole {
// This is bounded receiving/routing grammar only. Payload peer data cannot
// replace the actual privately held source/target actors in the Creator.
inline bool controlRole(Role role) noexcept { return role == Role::session || role == Role::personal || role == Role::fleet; }
inline bool controlRequest(Role source, const mm::Json& args) noexcept {
  try {
    const auto& target = args.at("target").string();
    if (!data_policy::uuid(args.at("requestId").string()) || !data_policy::base64(args.at("payload_base64").string(), 4096, false)) return false;
    if (source == Role::session && (target == "personal" || target == "fleet")) {
      if (!data_policy::fields(args, {"requestId", "target", "payload_base64", "expected_target"})) return false;
      const auto& owner = args.at("expected_target");
      return data_policy::fields(owner, {"role", "nonce", "identity"}) && owner.at("role").string() == target &&
        mmstore::validDigest(owner.at("nonce").string()) && data_policy::identity(owner.at("identity"));
    }
    return (source == Role::personal || source == Role::fleet) && target == "session" &&
      data_policy::fields(args, {"requestId", "target", "payload_base64"});
  } catch (...) { return false; }
}
inline bool controlResult(const mm::Json& args) noexcept {
  try { return data_policy::fields(args, {"token", "payload_base64"}) && mmstore::validDigest(args.at("token").string()) &&
    data_policy::base64(args.at("payload_base64").string(), 32768, false); } catch (...) { return false; }
}
inline bool guiForward(const mm::Json& args) noexcept {
  try {
    if (data_policy::fields(args, {"version", "requestId", "action"}) && args.at("version").integer() == 1 &&
        data_policy::uuid(args.at("requestId").string()) && args.at("action").string() == "session_forward_ack") return true;
    return data_policy::fields(args, {"version", "requestId", "action", "payload_base64"}) && args.at("version").integer() == 1 &&
      data_policy::uuid(args.at("requestId").string()) && args.at("action").string() == "session_forward" &&
      data_policy::base64(args.at("payload_base64").string(), 4096, false);
  } catch (...) { return false; }
}
inline bool controlAck(Role source, const mm::Json& args) noexcept {
  try { return controlRole(source) && data_policy::fields(args, {"requestId"}) && data_policy::uuid(args.at("requestId").string()); }
  catch (...) { return false; }
}
inline bool controlLargeCommand(std::string_view command) noexcept {
  return command == "control-request" || command == "control-accept" || command == "control-reply" ||
    command == "tool-read" || command == "child-start" || command == "child-read" || command == "child-write" || command == "child-stop" || command == "cpu-prepare-request" || command == "benchmark-request" || command == "benchmark-read" || command == "transfer-write" || command == "transfer-read";
}
inline bool controlPayload(Role source, Role target, bool gui, const mm::Json& payload, bool browser = false) noexcept {
  try {
    if (browser && !gui) return false;
    const auto& fields = payload.object();
    if (target == Role::fleet) {
      if (gui || source != Role::session || payload.at("version").integer() != 1 || !data_policy::uuid(payload.at("requestId").string())) return false;
      const auto& action = payload.at("action").string();
      if (action == "reconcile" || action == "stop" || action == "sleep" || action == "inference_proof")
        return data_policy::fields(payload, {"version", "requestId", "action"});
      if (action == "intent") return data_policy::fields(payload, {"version", "requestId", "action", "intent"}) &&
        (payload.at("intent").string() == "running" || payload.at("intent").string() == "paused" || payload.at("intent").string() == "draining");
      if (action == "admission_pending") return data_policy::fields(payload, {"version", "requestId", "action", "pending"}) && std::holds_alternative<bool>(payload.at("pending").value);
      if (action == "guard_acquire") { const auto& luid = payload.at("gpuLuid").string(); return data_policy::fields(payload, {"version", "requestId", "action", "gpuLuid"}) && luid.size() == 16 && luid.find_first_not_of("0123456789abcdef") == std::string::npos; }
      return action == "guard_release" && data_policy::fields(payload, {"version", "requestId", "action", "guardNonce"}) && mmstore::validDigest(payload.at("guardNonce").string());
    }
    if (target == Role::personal) {
      if (gui || source != Role::session || !fields.contains("command") || !fields.contains("peer") ||
          (fields.size() != 2 && fields.size() != 3) || (fields.size() == 3 && !fields.contains("captured_scope"))) return false;
      const auto& command = payload.at("command");
      if (command.at("version").integer() != 1 || !data_policy::uuid(command.at("requestId").string())) return false;
      const auto& action = command.at("action").string();
      return action == "status" || action == "idle_proof" || action == "yield_idle" || action == "jobs" || action == "wait_changes" ||
        action == "submit" || action == "cancel" || action == "detach" || action == "scope" || action == "stop" ||
        action == "guard_acquire" || action == "guard_status" || action == "guard_release";
    }
    if (target != Role::session) return false;
    if (!gui) {
      if (source != Role::personal && source != Role::fleet) return false;
      const auto& kind = payload.at("kind").string();
      if (kind == "personal-activity") return source == Role::personal && data_policy::fields(payload, {"version", "kind", "request_id", "ownerReceipt"}) &&
        payload.at("version").integer() == 1 && data_policy::uuid(payload.at("request_id").string());
      if (kind != "gpu-admission" || payload.at("version").integer() != 1 || !data_policy::uuid(payload.at("requestId").string())) return false;
      if (!(data_policy::fields(payload, {"version", "kind", "action", "requestId", "generation", "ownerReceipt", "gpuIdentity"}) ||
            data_policy::fields(payload, {"version", "kind", "action", "requestId", "generation", "ownerReceipt", "gpuIdentity", "leaseNonce"}))) return false;
      const auto& action = payload.at("action").string();
      return action == "cancel" || action == "status" || (source == Role::personal && (action == "request_personal" || action == "release_personal")) ||
        (source == Role::fleet && (action == "request_fleet" || action == "fleet_yielded"));
    }
    if (fields.contains("kind")) {
      const auto& kind = payload.at("kind").string();
      if (kind == "personal-owner-proof") return payload.at("version").integer() == 1 && payload.at("owner_kind").string() == (browser ? "chrome" : "desktop");
      if (kind != "personal-command" || payload.at("version").integer() != 1 || payload.at("owner_kind").string() != (browser ? "chrome" : "desktop")) return false;
      if (browser && fields.contains("submission_authority") && payload.at("submission_authority").at("kind").string() != "guest") return false;
      const auto& action = payload.at("command").at("action").string();
      return action == "status" || action == "submit" || action == "jobs" || action == "cancel" || action == "detach" || action == "wait_changes";
    }
    if (payload.at("version").integer() != 1 || !data_policy::uuid(payload.at("request_id").string())) return false;
    const auto& action = payload.at("action").string();
    if (browser && action != "status" && action != "wait_state" && action != "personal_attach" && action != "personal_detach") return false;
    if (action == "status" || action == "fleet_restart") return data_policy::fields(payload, {"version", "request_id", "action"});
    if (action == "maintenance_begin" || action == "maintenance_end") return data_policy::fields(payload, {"version", "request_id", "action", "transaction"}) && data_policy::uuid(payload.at("transaction").string());
    if (action == "maintenance_resume") return data_policy::fields(payload, {"version", "request_id", "action", "transaction", "instance_id"}) &&
      data_policy::uuid(payload.at("transaction").string()) && data_policy::uuid(payload.at("instance_id").string());
    // Store code/model replacement is OS-owned; legacy retire-for-updater is
    // deliberately absent. Other commands are parsed again by the unchanged
    // sealed Session dispatcher before any business mutation.
    if (action == "wait_state") return data_policy::fields(payload, {"version", "request_id", "action", "after_revision"}) || data_policy::fields(payload, {"version", "request_id", "action", "after_revision", "instance_id"});
    if (action == "fleet_intent") return data_policy::fields(payload, {"version", "request_id", "action", "intent"});
    if (action == "personal_attach") return data_policy::fields(payload, {"version", "request_id", "action", "owner_id", "owner_kind"}) && payload.at("owner_kind").string() == (browser ? "chrome" : "desktop");
    if (action == "personal_detach") return data_policy::fields(payload, {"version", "request_id", "action", "owner_id"});
    if (action == "account_scope") return data_policy::fields(payload, {"version", "request_id", "action", "scope"});
    return action == "fleet_force" && data_policy::fields(payload, {"version", "request_id", "action", "reason", "machine_id", "authority", "expected_revision", "confirmation"}) &&
      (payload.at("reason").string() == "stop" || payload.at("reason").string() == "restart" || payload.at("reason").string() == "revoke");
  } catch (...) { return false; }
}
} // namespace mmstorerole
