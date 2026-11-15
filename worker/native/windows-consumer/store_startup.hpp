#pragma once

// Global-scope production StartupTask adapter. The API's current package is
// always the actual authenticated Worker helper; no task ID/root is accepted
// from a caller and no external startup launcher or registry fallback exists.
#include "store_authority.hpp"
#include <chrono>
#ifdef _WIN32
#include <winrt/Windows.Foundation.h>
#endif

namespace mmstorestartup {
inline constexpr std::wstring_view taskId = L"MusicMuteWorkerStartup";
enum class State { disabled, disabledByUser, enabled, disabledByPolicy, enabledByPolicy };
enum class Intent { inspect, requestEnable, disable };
enum class Action { none, requestEnable, disable };
inline std::string_view actionName(Action action) {
  switch (action) {
    case Action::none: return "none";
    case Action::requestEnable: return "request-enable";
    case Action::disable: return "disable";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline State stateFromValue(std::int32_t value) {
  switch (value) {
    case 0: return State::disabled;
    case 1: return State::disabledByUser;
    case 2: return State::enabled;
    case 3: return State::disabledByPolicy;
    case 4: return State::enabledByPolicy;
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline std::string_view stateName(State state) {
  switch (state) {
    case State::disabled: return "disabled";
    case State::disabledByUser: return "disabled-by-user";
    case State::enabled: return "enabled";
    case State::disabledByPolicy: return "disabled-by-policy";
    case State::enabledByPolicy: return "enabled-by-policy";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline Intent parseIntent(std::string_view value) {
  if (value == "inspect") return Intent::inspect;
  if (value == "request-enable") return Intent::requestEnable;
  if (value == "disable") return Intent::disable;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline bool supportedParent(mmstore::CodeRole role) noexcept {
  return role == mmstore::CodeRole::workerControls || role == mmstore::CodeRole::workerNode || role == mmstore::CodeRole::workerSession;
}
// Pure policy for tests and actual OS observations only. Passing fixture values
// does not create authenticated StartupTask access; apply() supplies the actual
// held parent and independently checks the foreground window itself.
inline Action decide(Intent intent, State current, mmstore::CodeRole parent, bool visibleForeground) {
  (void)stateName(current);
  mmstore::require(supportedParent(parent), mmstore::ErrorCode::processDenied);
  if (intent == Intent::inspect) return Action::none;
  mmstore::require(intent == Intent::requestEnable || intent == Intent::disable, mmstore::ErrorCode::invalidInput);
  mmstore::require(parent == mmstore::CodeRole::workerControls && visibleForeground, mmstore::ErrorCode::processDenied);
  if (intent == Intent::requestEnable) return current == State::disabled ? Action::requestEnable : Action::none;
  // Disable must not erase a Windows user/policy disable into ordinary Disabled,
  // or remove EnabledByPolicy and create a later application re-enable path.
  return current == State::enabled ? Action::disable : Action::none;
}
struct Result { State before, after; Action action; };

#ifdef _WIN32
namespace detail {
class MtaScope {
 public:
  MtaScope() {
    const auto result = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(result)) throw mmstore::Error(mmstore::ErrorCode::packageQueryFailed, static_cast<std::uint32_t>(result));
    initialized_ = true;
  }
  ~MtaScope() { if (initialized_) RoUninitialize(); }
  MtaScope(const MtaScope&) = delete;
  MtaScope& operator=(const MtaScope&) = delete;
 private:
  bool initialized_ = false;
};
template<typename Operation>
inline auto boundedResult(const Operation& operation) {
  const auto status = operation.wait_for(std::chrono::seconds(10));
  if (status != winrt::Windows::Foundation::AsyncStatus::Completed) {
    const auto nativeStatus = status == winrt::Windows::Foundation::AsyncStatus::Error
      ? static_cast<std::uint32_t>(operation.ErrorCode().value) : 0U;
    // An enable request that times out has an uncertain outcome. Return no
    // success, never retry it automatically and let a new explicit inspect read
    // actual Windows state. Cancellation cannot manufacture a rollback claim.
    try { operation.Cancel(); } catch (const winrt::hresult_error&) {}
    throw mmstore::Error(mmstore::ErrorCode::packageQueryFailed, nativeStatus);
  }
  return operation.GetResults();
}
inline void assertWorkerOrigin(const mmstore::BootstrapAttestation& proof) {
  proof.package.revalidate(); proof.self.revalidate(); proof.parent.revalidate();
  const auto& package = proof.package.observation();
  mmstore::validateObservation(mmstore::PackageKind::worker, package);
  mmstore::require(proof.package.kind() == mmstore::PackageKind::worker &&
    proof.self.role() == mmstore::CodeRole::workerNative && proof.self.identity().pid == GetCurrentProcessId() &&
    supportedParent(proof.parent.role()) && proof.self.observation().fullName == package.fullName &&
    proof.parent.observation().fullName == package.fullName && mmstore::currentPackageFullName() == package.fullName &&
    proof.self.identity().sid == proof.parent.identity().sid && proof.self.identity().logonSid == proof.parent.identity().logonSid &&
    proof.self.identity().sessionId == proof.parent.identity().sessionId &&
    mmstore::detail::creation(proof.parent.handle()) <= mmstore::detail::creation(proof.self.handle()) &&
    mmstore::detail::parentPid(proof.self.identity().pid) == proof.parent.identity().pid, mmstore::ErrorCode::processDenied);
}
inline bool visibleControls(const mmstore::BootstrapAttestation& proof) {
  if (proof.parent.role() != mmstore::CodeRole::workerControls) return false;
  const auto window = GetForegroundWindow();
  if (!window || !IsWindow(window) || !IsWindowVisible(window) || IsIconic(window) || GetAncestor(window, GA_ROOT) != window) return false;
  DWORD pid = 0;
  if (GetWindowThreadProcessId(window, &pid) == 0 || pid != proof.parent.identity().pid) return false;
  RECT rect{};
  if (!GetWindowRect(window, &rect) || rect.right <= rect.left || rect.bottom <= rect.top) return false;
  SetLastError(ERROR_SUCCESS);
  const auto style = GetWindowLongPtrW(window, GWL_STYLE);
  if ((style == 0 && GetLastError() != ERROR_SUCCESS) || (style & WS_CHILD) != 0) return false;
  // No caller-provided HWND/visibility flag and no SetForegroundWindow attempt.
  // Root's trusted visible controls additionally owns the explicit user action.
  proof.parent.revalidate();
  return GetForegroundWindow() == window && IsWindowVisible(window);
}
inline winrt::Windows::ApplicationModel::StartupTask currentTask() {
  // Query only this package's fixed manifest task. No caller-selected ID or
  // enumeration of other application entries can supply startup authority.
  auto selected = boundedResult(winrt::Windows::ApplicationModel::StartupTask::GetAsync(winrt::hstring{taskId}));
  mmstore::require(selected && selected.TaskId() == taskId, mmstore::ErrorCode::fileDenied);
  return selected;
}
inline State observedState(const winrt::Windows::ApplicationModel::StartupTask& task) {
  return stateFromValue(static_cast<std::int32_t>(task.State()));
}
} // namespace detail

// Invoke on the helper's MTA/background stdio thread, never a controls UI thread.
// The caller cannot pass an observation receipt, success adapter, alternate task
// name or a boolean that claims consent/visibility in place of native proof.
inline Result apply(const mmstore::BootstrapAttestation& proof, Intent intent) {
  try {
    // Validate the closed intent before making any OS call or state change.
    mmstore::require(intent == Intent::inspect || intent == Intent::requestEnable || intent == Intent::disable, mmstore::ErrorCode::invalidInput);
    detail::MtaScope apartment;
    detail::assertWorkerOrigin(proof);
    auto task = detail::currentTask();
    detail::assertWorkerOrigin(proof);
    const auto before = detail::observedState(task);
    auto action = decide(intent, before, proof.parent.role(), intent == Intent::inspect ? false : detail::visibleControls(proof));
    if (action != Action::none) {
      // Re-read immediately before the write. A concurrent user/policy disable
      // changes the decision to no action; RequestEnableAsync itself also
      // respects DisabledByUser. Never call Disable on that protected state.
      action = decide(intent, detail::observedState(task), proof.parent.role(), detail::visibleControls(proof));
      detail::assertWorkerOrigin(proof);
      if (action == Action::requestEnable) (void)stateFromValue(static_cast<std::int32_t>(detail::boundedResult(task.RequestEnableAsync())));
      else if (action == Action::disable) task.Disable();
    }
    const auto after = detail::observedState(task);
    detail::assertWorkerOrigin(proof);
    return {before, after, action};
  } catch (const mmstore::Error&) { throw; }
  catch (const winrt::hresult_error& error) {
    throw mmstore::Error(mmstore::ErrorCode::packageQueryFailed, static_cast<std::uint32_t>(error.code().value));
  }
}
#endif // _WIN32: no injected or portable StartupTask success implementation.
} // namespace mmstorestartup
