#pragma once

// Closed receiving policy for the Worker controls' existing native stdio wire.
// These parsers cannot create Store authority: their expectations come from
// held OS package/process attestations in store_controls.cpp.
#include "json.hpp"
#include "store_startup.hpp"
#include <deque>
#include <limits>
#include <optional>
#include <span>

namespace mmstorecontrols {
inline constexpr std::size_t maximumFrame = 65536;
struct ClientSize { int width, height; };
// Match layout/font scaling, then let Windows add the current non-client frame.
inline ClientSize clientSize(std::uint32_t dpi, bool minimum) {
  mmstore::require(dpi > 0, mmstore::ErrorCode::invalidInput);
  const auto width = ((minimum ? 650ULL : 740ULL) * dpi + 48ULL) / 96ULL;
  const auto height = ((minimum ? 350ULL : 370ULL) * dpi + 48ULL) / 96ULL;
  mmstore::require(width > 0 && height > 0 &&
    width <= static_cast<std::uint64_t>((std::numeric_limits<int>::max)()) &&
    height <= static_cast<std::uint64_t>((std::numeric_limits<int>::max)()), mmstore::ErrorCode::invalidInput);
  return {static_cast<int>(width), static_cast<int>(height)};
}
inline void exact(const mm::Json& row, std::initializer_list<const char*> names) {
  mmstore::require(row.object().size() == names.size(), mmstore::ErrorCode::invalidInput);
  for (const auto* name : names) mmstore::require(row.object().contains(name), mmstore::ErrorCode::invalidInput);
}
inline std::string ascii(std::wstring_view text) {
  std::string result; result.reserve(text.size());
  for (const auto c : text) {
    mmstore::require(c >= 32 && c < 127, mmstore::ErrorCode::invalidInput);
    result.push_back(static_cast<char>(c));
  }
  return result;
}
class Frames {
 public:
  void append(std::span<const char> bytes) {
    for (const auto byte : bytes) {
      if (byte == '\n') {
        mmstore::require(!partial_.empty() && complete_.size() < 16, mmstore::ErrorCode::invalidInput);
        complete_.push_back(std::move(partial_)); partial_.clear();
      } else {
        mmstore::require(partial_.size() < maximumFrame, mmstore::ErrorCode::invalidInput);
        partial_.push_back(byte);
      }
    }
  }
  std::optional<mm::Json> take() {
    if (complete_.empty()) return {};
    auto frame = std::move(complete_.front()); complete_.pop_front();
    return mm::JsonParser(frame).parse();
  }
  bool pending() const noexcept { return !complete_.empty() || !partial_.empty(); }
 private:
  std::string partial_; std::deque<std::string> complete_;
};
// Session events can arrive between replies. Controls own no processing child,
// so a child-exit or lifecycle transition must not be mistaken for a reply.
inline bool sessionEvent(const mm::Json& row, std::int64_t& previous) {
  if (!row.object().contains("event")) return false;
  exact(row, {"version", "event"});
  const auto& event = row.at("event"); exact(event, {"kind", "event", "sequence"});
  const auto sequence = event.at("sequence").integer();
  mmstore::require(row.at("version").integer() == 1 && event.at("kind").string() == "session" &&
    sequence > previous && sequence > 0, mmstore::ErrorCode::invalidInput);
  previous = sequence;
  // A changing/ending interactive session conservatively aborts this transient
  // action. Only a harmless network notification may be skipped.
  mmstore::require(event.at("event").string() == "network", mmstore::ErrorCode::processDenied);
  return true;
}
inline mm::Json response(const mm::Json& row, std::int64_t id) {
  mmstore::require(id > 0, mmstore::ErrorCode::invalidInput);
  const bool ok = std::get<bool>(row.at("ok").value);
  exact(row, ok ? std::initializer_list<const char*>{"version", "id", "ok", "result"} :
    std::initializer_list<const char*>{"version", "id", "ok", "error"});
  mmstore::require(row.at("version").integer() == 1 && row.at("id").integer() == id, mmstore::ErrorCode::invalidInput);
  if (!ok) {
    exact(row.at("error"), {"code"});
    const auto& code = row.at("error").at("code").string();
    mmstore::require(!code.empty() && code.size() <= 64 &&
      code.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ_") == std::string::npos, mmstore::ErrorCode::invalidInput);
    mmstore::fail(mmstore::ErrorCode::processDenied); // Never expose raw helper text.
  }
  (void)row.at("result").object(); return row.at("result");
}
struct WireProcess {
  std::string sid, creationTime;
  std::uint32_t sessionId = 0, pid = 0;
};
inline void process(const mm::Json& row, const WireProcess& expected) {
  exact(row, {"sid", "session_id", "pid", "creation_time"});
  mmstore::require(expected.pid > 0 && expected.sessionId > 0 &&
    row.at("sid").string() == expected.sid && row.at("session_id").integer() == expected.sessionId &&
    row.at("pid").integer() == expected.pid && row.at("creation_time").string() == expected.creationTime,
    mmstore::ErrorCode::processDenied);
}
inline void boot(const mm::Json& row, const mmstore::Observation& expected,
  const WireProcess& parent, const WireProcess& helper, std::string_view logonSid) {
  mmstore::validateObservation(mmstore::PackageKind::worker, expected);
  exact(row, {"version", "package", "helper", "parent", "logon_sid"});
  mmstore::require(row.at("version").integer() == 1 && !logonSid.empty() &&
    row.at("logon_sid").string() == logonSid && parent.sid == helper.sid &&
    parent.sessionId == helper.sessionId && parent.pid != helper.pid, mmstore::ErrorCode::processDenied);
  const auto& package = row.at("package");
  exact(package, {"identityName", "publisher", "publisherId", "familyName", "fullName", "packageVersion",
    "architecture", "signatureKind", "healthy", "current", "installedLocation"});
  mmstore::require(package.at("identityName").string() == ascii(expected.identityName) &&
    package.at("publisher").string() == ascii(expected.publisher) && package.at("publisherId").string() == ascii(expected.publisherId) &&
    package.at("familyName").string() == ascii(expected.familyName) && package.at("fullName").string() == ascii(expected.fullName) &&
    package.at("packageVersion").string() == ascii(expected.packageVersion) && package.at("architecture").string() == "x64" &&
    package.at("signatureKind").integer() == mmstoreprofile::signatureKind && std::get<bool>(package.at("healthy").value) &&
    std::get<bool>(package.at("current").value) && package.at("installedLocation").string() == ascii(expected.installedLocation),
    mmstore::ErrorCode::processDenied);
  process(row.at("parent"), parent); process(row.at("helper"), helper);
}
inline mmstorestartup::State state(std::string_view name) {
  for (const auto candidate : {mmstorestartup::State::disabled, mmstorestartup::State::disabledByUser,
    mmstorestartup::State::enabled, mmstorestartup::State::disabledByPolicy, mmstorestartup::State::enabledByPolicy})
    if (mmstorestartup::stateName(candidate) == name) return candidate;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline mmstorestartup::Result startup(const mm::Json& row, mmstorestartup::Intent intent) {
  using namespace mmstorestartup;
  exact(row, {"before", "after", "action"});
  Result result{state(row.at("before").string()), state(row.at("after").string()), Action::none};
  const auto& name = row.at("action").string();
  if (name == "request-enable") result.action = Action::requestEnable;
  else if (name == "disable") result.action = Action::disable;
  else mmstore::require(name == "none", mmstore::ErrorCode::invalidInput);
  (void)parseIntent(intent == Intent::inspect ? "inspect" : intent == Intent::requestEnable ? "request-enable" :
    intent == Intent::disable ? "disable" : "invalid");
  // An OS/user race can change the final state. It cannot authorize an action
  // outside this explicit request or the protected initial-state policy.
  mmstore::require(result.action == Action::none ||
    (intent == Intent::requestEnable && result.action == Action::requestEnable && result.before == State::disabled) ||
    (intent == Intent::disable && result.action == Action::disable && result.before == State::enabled), mmstore::ErrorCode::invalidInput);
  return result;
}
inline bool enableAvailable(mmstorestartup::State value) { (void)mmstorestartup::stateName(value); return value == mmstorestartup::State::disabled; }
inline bool disableAvailable(mmstorestartup::State value) { (void)mmstorestartup::stateName(value); return value == mmstorestartup::State::enabled; }
} // namespace mmstorecontrols
