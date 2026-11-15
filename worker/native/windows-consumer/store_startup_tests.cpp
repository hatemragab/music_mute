#include "store_startup.hpp"
#include "store_inventory.hpp"
#include <array>
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_STARTUP_TEST_FAILED"); }
void denied(const std::function<void()>& operation, mmstore::ErrorCode expected) {
  bool rejected = false;
  try { operation(); } catch (const mmstore::Error& error) { rejected = error.code() == expected; }
  check(rejected);
}
void portablePolicy() {
  using namespace mmstore;
  using namespace mmstorestartup;
  const Error ordinary(ErrorCode::packageQueryFailed);
  check(ordinary.code() == ErrorCode::packageQueryFailed && ordinary.nativeStatus() == 0);
  const Error withStatus(ErrorCode::packageQueryFailed, 0x80070005U);
  const Error copied = withStatus;
  check(copied.code() == ordinary.code() && copied.nativeStatus() == 0x80070005U &&
    std::string_view(copied.what()) == ordinary.what());
  denied([] { throw Error(ErrorCode::packageQueryFailed, 0x8000000EU); }, ErrorCode::packageQueryFailed);
  check(taskId == L"MusicMuteWorkerStartup");
  check(actionName(Action::none) == "none"); check(actionName(Action::requestEnable) == "request-enable"); check(actionName(Action::disable) == "disable");
  denied([] { (void)actionName(static_cast<Action>(999)); }, ErrorCode::invalidInput);
  const std::array states{State::disabled, State::disabledByUser, State::enabled, State::disabledByPolicy, State::enabledByPolicy};
  const std::array<std::string_view, 5> names{"disabled", "disabled-by-user", "enabled", "disabled-by-policy", "enabled-by-policy"};
  for (std::size_t n = 0; n < states.size(); ++n) {
    const auto state = states[n];
    check(stateFromValue(static_cast<std::int32_t>(n)) == state);
    check(stateName(state) == names[n]);
    for (const auto parent : {CodeRole::workerControls, CodeRole::workerNode, CodeRole::workerSession}) {
      check(decide(Intent::inspect, state, parent, false) == Action::none);
      check(decide(Intent::inspect, state, parent, true) == Action::none);
    }
    check(decide(Intent::requestEnable, state, CodeRole::workerControls, true) == (state == State::disabled ? Action::requestEnable : Action::none));
    check(decide(Intent::disable, state, CodeRole::workerControls, true) == (state == State::enabled ? Action::disable : Action::none));
    for (const auto intent : {Intent::requestEnable, Intent::disable}) {
      denied([&] { (void)decide(intent, state, CodeRole::workerControls, false); }, ErrorCode::processDenied);
      for (const auto parent : {CodeRole::workerNode, CodeRole::workerSession, CodeRole::workerPython,
        CodeRole::workerNative, CodeRole::workerPersonalAgent, CodeRole::guiApplication, CodeRole::guiSession}) {
        denied([&] { (void)decide(intent, state, parent, true); }, ErrorCode::processDenied);
        denied([&] { (void)decide(intent, state, parent, false); }, ErrorCode::processDenied);
      }
    }
    for (const auto parent : {CodeRole::guiApplication, CodeRole::guiNative, CodeRole::workerPython, static_cast<CodeRole>(999)})
      denied([&] { (void)decide(Intent::inspect, state, parent, true); }, ErrorCode::processDenied);
  }
  for (const auto state : {State::disabledByUser, State::disabledByPolicy, State::enabledByPolicy}) {
    check(decide(Intent::requestEnable, state, CodeRole::workerControls, true) == Action::none);
    check(decide(Intent::disable, state, CodeRole::workerControls, true) == Action::none);
  }
  for (const auto value : {-1, 5, 999, (std::numeric_limits<std::int32_t>::max)()})
    denied([&] { (void)stateFromValue(value); }, ErrorCode::invalidInput);
  denied([] { (void)stateName(static_cast<State>(999)); }, ErrorCode::invalidInput);
  denied([] { (void)decide(Intent::inspect, static_cast<State>(999), CodeRole::workerControls, true); }, ErrorCode::invalidInput);
  denied([] { (void)decide(static_cast<Intent>(999), State::disabled, CodeRole::workerControls, true); }, ErrorCode::invalidInput);
  check(parseIntent("inspect") == Intent::inspect);
  check(parseIntent("request-enable") == Intent::requestEnable);
  check(parseIntent("disable") == Intent::disable);
  for (const auto* text : {"", "enable", "requestEnable", "request-enable ", " request-enable", "REQUEST-ENABLE",
    "force-enable", "disable-by-user", "MusicMuteWorkerStartup", "hkcu-run"})
    denied([&] { (void)parseIntent(text); }, ErrorCode::invalidInput);
  denied([] { (void)parseIntent(std::string_view("inspect\0enable", 14)); }, ErrorCode::invalidInput);
}
#ifdef _WIN32
void boundedOperationPolicy() {
  using winrt::Windows::Foundation::AsyncStatus;
  struct Operation {
    AsyncStatus status;
    bool cancelThrows = false;
    mutable unsigned results = 0, cancellations = 0, errorReads = 0;
    AsyncStatus wait_for(std::chrono::seconds limit) const {
      check(limit == std::chrono::seconds(10)); return status;
    }
    winrt::hresult ErrorCode() const {
      ++errorReads; return winrt::hresult{static_cast<std::int32_t>(0x80070005U)};
    }
    void Cancel() const {
      ++cancellations;
      if (cancelThrows) throw winrt::hresult_error(winrt::hresult{static_cast<std::int32_t>(0x80004005U)});
    }
    int GetResults() const { ++results; return 42; }
  };
  const Operation complete{AsyncStatus::Completed};
  check(mmstorestartup::detail::boundedResult(complete) == 42);
  check(complete.results == 1 && complete.cancellations == 0 && complete.errorReads == 0);
  for (const auto status : {AsyncStatus::Started, AsyncStatus::Canceled, AsyncStatus::Error}) {
    const Operation operation{status};
    bool rejected = false;
    try { (void)mmstorestartup::detail::boundedResult(operation); }
    catch (const mmstore::Error& error) {
      rejected = error.code() == mmstore::ErrorCode::packageQueryFailed &&
        error.nativeStatus() == (status == AsyncStatus::Error ? 0x80070005U : 0U);
    }
    check(rejected && operation.results == 0 && operation.cancellations == 1 &&
      operation.errorReads == (status == AsyncStatus::Error ? 1U : 0U));
  }
  const Operation failedCancellation{AsyncStatus::Error, true};
  bool originalError = false;
  try { (void)mmstorestartup::detail::boundedResult(failedCancellation); }
  catch (const mmstore::Error& error) {
    originalError = error.code() == mmstore::ErrorCode::packageQueryFailed && error.nativeStatus() == 0x80070005U;
  }
  check(originalError && failedCancellation.results == 0 && failedCancellation.errorReads == 1 &&
    failedCancellation.cancellations == 1);
}
void actualOriginDenial() {
  using namespace mmstore;
  auto package = resolveRegisteredPackage(PackageKind::worker);
  check(package.observation().signatureKind == mmstoreprofile::signatureKind && package.observation().healthy && package.observation().current);
  auto source = package.openInventory();
  const auto bytes = source.read(8 * 1024 * 1024);
  const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  const auto inventory = mmstoreinventory::parse(PackageKind::worker, mm::JsonParser::storeCodeInventory(text));
  const auto self = mmstoreinventory::codePin(inventory, CodeRole::workerNative);
  const auto parent = mmstoreinventory::codePin(inventory, CodeRole::workerControls);
  // The test process is not the fixed packaged helper. It must not obtain any
  // StartupTask capability by possessing package metadata or executable pins.
  denied([&] { (void)attestHelperParent(PackageKind::worker, self, parent, CodeRole::workerControls); }, ErrorCode::processDenied);
  source.revalidate(); package.revalidate(); ++checks;
}
#endif
} // namespace
int main(int argc, char** argv) {
  try {
    const bool policyOnly = argc == 2 && std::string_view(argv[1]) == "--policy-only";
    mmstore::require(argc == 1 || policyOnly, mmstore::ErrorCode::invalidInput);
    portablePolicy(); std::cout << "Store startup portable policy checks passed: " << checks << '\n';
#ifdef _WIN32
    boundedOperationPolicy();
#endif
    if (policyOnly) return 0;
#ifdef _WIN32
    try { actualOriginDenial(); }
    catch (const mmstore::Error& error) {
      if (error.code() != mmstore::ErrorCode::packageNotRegistered && error.code() != mmstore::ErrorCode::unsupportedHost) throw;
      std::cout << "Store startup OS checks skipped: unsupported host or no expected registered Store Worker. No positive StartupTask access was established.\n";
      return 77;
    }
    std::cout << "Actual Store origin denial passed; positive StartupTask state/change and login checks require the fixed production helper launched by genuine Worker controls.\n";
#else
    std::cout << "Store startup OS checks unavailable on this platform. No positive StartupTask access was established.\n";
#endif
    // Never turn registered-package observation/denial into positive StartupTask
    // proof, and never enable/disable a real user's startup setting in this test.
    return 77;
  } catch (const std::exception& error) {
    std::cerr << "Store startup test failed: " << error.what() << '\n'; return 1;
  }
}
