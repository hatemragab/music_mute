#pragma once
#include "json.hpp"
#include "store_authority.hpp"
#include <set>

namespace mmstorerole {
enum class Role { session, login, personal, fleet, prepare };
enum class GuardianKind { job, gpu, watchdog };
// Bookkeeping policy only. The actual Creator must separately prove the
// original suspended Node/Job and held guardian lineage/exit before using it.
inline bool guardianRetirementExit(GuardianKind kind, bool unresumed, bool startupAborted, std::uint32_t exit) noexcept {
  return exit == 0 || (kind == GuardianKind::job && unresumed && startupAborted && exit == 2);
}
inline std::string_view guardianName(GuardianKind kind) {
  switch (kind) {
    case GuardianKind::job: return "job";
    case GuardianKind::gpu: return "gpu";
    case GuardianKind::watchdog: return "watchdog";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline std::string_view roleName(Role role) {
  switch (role) {
    case Role::session: return "session-agent";
    case Role::login: return "login-worker";
    case Role::personal: return "personal";
    case Role::fleet: return "fleet";
    case Role::prepare: return "prepare";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline Role parseRole(std::string_view value) {
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare})
    if (value == roleName(role)) return role;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
// Receiving policy only. Native dispatch separately revalidates the genuine
// held Worker role/namespace before and after its fixed readonly census.
inline bool sessionReadonlyInspection(Role role, const mm::Json& args) noexcept {
  return role == Role::session && std::holds_alternative<mm::Json::Object>(args.value) && args.object().empty();
}
inline bool sameSecret(std::string_view first, std::string_view second) noexcept {
  if (!mmstore::validDigest(first) || !mmstore::validDigest(second)) return false;
  unsigned different = 0;
  for (std::size_t n = 0; n < first.size(); ++n)
    different |= static_cast<unsigned char>(first[n]) ^ static_cast<unsigned char>(second[n]);
  return different == 0;
}
inline void exactFields(const mm::Json& value, std::initializer_list<std::string_view> names) {
  const auto& fields = value.object();
  mmstore::require(fields.size() == names.size(), mmstore::ErrorCode::invalidInput);
  for (const auto name : names)
    mmstore::require(fields.contains(std::string(name)), mmstore::ErrorCode::invalidInput);
}
inline bool validBirth(std::string_view value) noexcept {
  if (value.empty() || value.size() > 20 || value.front() == '0' ||
      value.find_first_not_of("0123456789") != std::string_view::npos) return false;
  return value.size() < 20 || value <= "18446744073709551615";
}
inline std::uint32_t pid(const mm::Json& value) {
  const auto number = value.integer();
  mmstore::require(number > 0 && number <= 2147483647, mmstore::ErrorCode::invalidInput);
  return static_cast<std::uint32_t>(number);
}
// Receiving grammar only; the caller supplies expectations from actual held
// process/package authority, never from a GUI command or locator receipt.
inline mm::Json guiCreatorReply(std::string_view frame, std::string_view challenge,
    std::uint32_t helperPid, std::string_view helperBirth, std::string_view package) {
  using mmstore::require; constexpr auto error = mmstore::ErrorCode::processDenied;
  try {
    require(mmstore::validDigest(challenge) && helperPid > 0 && validBirth(helperBirth) && !package.empty() &&
      frame.size() >= 2 && frame.size() <= 2048 && frame.back() == '\n' && frame.find('\n') == frame.size() - 1 &&
      frame.find('\r') == std::string_view::npos && frame.find('\0') == std::string_view::npos && !frame.starts_with("\xef\xbb\xbf"), error);
    auto reply = mm::JsonParser(frame.substr(0, frame.size() - 1)).parse();
    exactFields(reply, {"version", "confirmed", "challenge", "helper_pid", "helper_creation_time", "package_full_name", "browser_attachment", "source_helper"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("confirmed").value) &&
      sameSecret(reply.at("challenge").string(), challenge) && pid(reply.at("helper_pid")) == helperPid &&
      reply.at("helper_creation_time").string() == helperBirth && reply.at("package_full_name").string() == package &&
      (std::holds_alternative<std::nullptr_t>(reply.at("browser_attachment").value) || std::holds_alternative<mm::Json::Object>(reply.at("browser_attachment").value)), error);
    if (std::holds_alternative<std::nullptr_t>(reply.at("browser_attachment").value))
      require(std::holds_alternative<std::nullptr_t>(reply.at("source_helper").value), error);
    else {
      const auto& source = reply.at("source_helper"); exactFields(source, {"pid", "creation_time"});
      (void)pid(source.at("pid")); require(validBirth(source.at("creation_time").string()), error);
    }
    return reply;
  } catch (...) { mmstore::fail(error); }
}
struct Request {
  std::string operation, nonce, capability; std::uint32_t child = 0;
  std::string command; mm::Json args = mm::Json::Object{};
};
inline Request parseRequest(std::string_view frame) {
  using mmstore::require;
  constexpr auto error = mmstore::ErrorCode::invalidInput;
  try {
    require(!frame.empty() && frame.size() <= 65536 && frame.back() == '\n' &&
      frame.find('\n') == frame.size() - 1 && frame.find('\r') == std::string_view::npos &&
      !frame.starts_with("\xef\xbb\xbf"), error);
    const auto value = mm::JsonParser(frame.substr(0, frame.size() - 1)).parse();
    Request result; result.operation = value.at("operation").string();
    result.nonce = value.at("request_nonce").string(); result.capability = value.at("capability").string();
    require(value.at("version").integer() == 1 && mmstore::validDigest(result.nonce) && mmstore::validDigest(result.capability), error);
    if (result.operation == "broker") {
      exactFields(value, {"version", "operation", "request_nonce", "capability", "command", "args"});
      result.command = value.at("command").string();
      require(result.command == "role-launch" || result.command == "role-stop" ||
        result.command == "role-inspect" || result.command == "role-peer" || result.command == "gpu-acquire" ||
        result.command == "gpu-release" || result.command == "gpu-inspect" || result.command == "gpu-admit" || result.command == "session-publish" ||
        result.command == "session-retire-children" || result.command == "prepare-request" || result.command == "prepare-result" ||
        result.command == "control-request" || result.command == "control-accept" || result.command == "control-reply" || result.command == "control-ack" || result.command == "control-peer" ||
        result.command == "child-start" || result.command == "child-read" || result.command == "child-write" || result.command == "child-stop" ||
        result.command == "personal-cleanup-state" || result.command == "tool-start" || result.command == "tool-read" || result.command == "tool-stop" ||
        result.command == "qualification-start" || result.command == "qualification-read" || result.command == "qualification-stop" ||
        result.command == "cpu-operation-open" || result.command == "cpu-operation-recover" || result.command == "cpu-operation-bind-data" ||
        result.command == "cpu-operation-inspect" || result.command == "cpu-operation-retire" || result.command == "cpu-operation-forget" || result.command == "cpu-operation-release" || result.command == "cpu-prepare-request" || result.command == "cpu-prepare-ready" ||
        result.command == "cpu-prepare-start" || result.command == "cpu-prepare-result" || result.command == "benchmark-request" || result.command == "benchmark-start" || result.command == "benchmark-read" || result.command == "benchmark-stop" || result.command == "benchmark-result" || result.command == "fleet-workspace-open" || result.command == "fleet-workspace-recover" || result.command == "fleet-workspace-inspect" || result.command == "fleet-workspace-retire" || result.command == "transfer-start" || result.command == "transfer-write" || result.command == "transfer-read" || result.command == "transfer-stop" || result.command == "transfer-inspect", error);
      result.args = value.at("args"); (void)result.args.object();
    } else if (result.operation == "gui-session") {
      exactFields(value, {"version", "operation", "request_nonce", "capability", "command"}); result.args = value.at("command"); (void)result.args.object();
    } else if (result.operation == "register-helper" || result.operation == "register-watchdog") {
      exactFields(value, {"version", "operation", "request_nonce", "capability", "pid"});
      result.child = pid(value.at("pid"));
    } else {
      exactFields(value, {"version", "operation", "request_nonce", "capability"});
      require(result.operation == "node-bind" || result.operation == "helper-bind" || result.operation == "guardian-bind" ||
        result.operation == "gui-client-bind" || result.operation == "gui-client-close" || result.operation == "helper-rotate" || result.operation == "node-rotate", error);
    }
    // Ordinary ownership/guardian/bootstrap messages retain their original
    // 4096-byte boundary. Only the closed control transport carries larger
    // bounded receiving bytes; actual actor admission still precedes dispatch.
    require(frame.size() <= 4096 || (result.operation == "broker" &&
      (result.command == "control-request" || result.command == "control-reply" || result.command == "child-write" || result.command == "transfer-write")) ||
      (result.operation == "gui-session" && (result.args.at("action").string() == "session_forward" ||
        (frame.size() <= 32768 && (result.args.at("action").string() == "cpu_launch" || result.args.at("action").string() == "cpu_recover" || result.args.at("action").string() == "benchmark_launch" || result.args.at("action").string() == "benchmark_recover")))), error);
    return result;
  } catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(error); }
}
// A receiving replay fence is policy only. It cannot mint OS/process authority.
class ReplayFence {
 public:
  std::size_t usedCount() const noexcept { return used_.size(); }
  void consume(std::string_view nonce) {
    mmstore::require(mmstore::validDigest(nonce) && used_.size() < 4096 &&
      used_.insert(std::string(nonce)).second, mmstore::ErrorCode::processDenied);
  }
 private:
  std::set<std::string> used_;
};
} // namespace mmstorerole
