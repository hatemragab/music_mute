#define MUSICMUTE_STORE_GUI_WORKER_POLICY_ONLY
#include "store_gui_worker.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_GUI_WORKER_POLICY_FAILED"); }
void denied(const std::function<void()>& operation) {
  bool rejected = false;
  try { operation(); } catch (const mmstore::Error&) { rejected = true; }
  check(rejected);
}
mmstore::Observation fixtureObservation() {
  const auto& expected = mmstore::expectedPackage(mmstore::PackageKind::worker);
  return {std::wstring(expected.identityName), std::wstring(expected.publisher), std::wstring(expected.publisherId),
    std::wstring(expected.familyName), std::wstring(expected.identityName) + L"_0.1.3.7_x64__" + std::wstring(expected.publisherId),
    L"0.1.3.7", L"x64", L"C:\\Program Files\\WindowsApps\\policy-fixture", mmstoreprofile::signatureKind, true, true};
}
mmstoreinventory::Inventory fixtureInventory() {
  mmstoreinventory::Inventory result{mmstore::PackageKind::worker, L"0.1.3.0", {}};
  const mmstore::FilePin synthetic{std::string(64, 'a'), 1};
  for (const auto role : mmstoreruntime::workerRoles)
    result.entries.push_back({std::wstring(mmstore::codeSpec(role).relativePath), synthetic});
  for (const auto file : mmstoreruntime::engineFiles)
    result.entries.push_back({std::wstring(L"worker/app/engine/musicmute_engine/") + std::wstring(file), synthetic});
  for (const auto* path : {L"worker/app/package.json", L"worker/app/dist/package.json", L"worker/app/dist/src/runtime/store-transfer-process.js", L"worker/runtime/requirements-directml.lock.txt",
    L"worker/tools/downloader/store_downloader_bootstrap.py", L"worker/release-manifest.json"})
    result.entries.push_back({path, synthetic});
  for (const auto path : mmstoreruntime::ortLibraries) result.entries.push_back({std::wstring(path), synthetic});
  std::sort(result.entries.begin(), result.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  return result;
}
}

int main() {
  try {
    using namespace mmstoreguiworkerpolicy;
    // Portable fixture grammar/policy only: these observations cannot create a
    // registered WorkerCodeAuthority or invoke Windows activation.
    for (const auto* operation : {"store_worker_code_open", "store_worker_code_check",
      "store_worker_code_benchmark",
      "store_worker_code_cleanup_check",
      "store_worker_code_close", "store_worker_session_activate"}) {
      input(operation, mm::Json::Object{}); ++checks;
      for (const auto* name : {"path", "sha256", "bytes", "package", "token", "aumid", "arguments", "allow_unsigned"})
        denied([&] { input(operation, mm::Json::Object{{name, "caller"}}); });
      for (const auto& value : {mm::Json(nullptr), mm::Json(mm::Json::Array{}), mm::Json("{}")})
        denied([&] { input(operation, value); });
    }
    for (const auto* name : {"worker_code_open", "store_worker_code_open ", "STORE_WORKER_CODE_OPEN", "store_worker_launch", ""})
      denied([&] { input(name, mm::Json::Object{}); });
    check(std::wstring(sessionAumid) == std::wstring(mmstore::expectedPackage(mmstore::PackageKind::worker).familyName) + L"!MusicMuteWorkerSession");
    auto source = fixtureInventory(); const auto observed = fixtureObservation();
    check(manifestEntry(source, observed).path == manifestPath);
    auto found = std::find_if(source.entries.begin(), source.entries.end(), [](const auto& entry) { return entry.path == manifestPath; });
    const auto index = static_cast<std::size_t>(found - source.entries.begin());
    for (const auto size : {std::uint64_t{1}, maximumManifestBytes}) {
      auto valid = source; valid.entries[index].pin.bytes = size;
      check(manifestEntry(valid, observed).pin.bytes == size);
    }
    for (const auto size : {std::uint64_t{0}, maximumManifestBytes + 1}) {
      auto invalid = source; invalid.entries[index].pin.bytes = size;
      if (!size) invalid.entries[index].pin.sha256 = std::string(mmstore::emptySha256);
      denied([&] { (void)manifestEntry(invalid, observed); });
    }
    auto missing = source; missing.entries.erase(missing.entries.begin() + static_cast<std::ptrdiff_t>(index));
    denied([&] { (void)manifestEntry(missing, observed); });
    for (const auto* path : {L"worker/Release-manifest.json", L"worker/release-manifest.json.exe", L"app/release-manifest.json", L"worker/../release-manifest.json"}) {
      auto changed = source; changed.entries[index].path = path;
      std::sort(changed.entries.begin(), changed.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
      denied([&] { (void)manifestEntry(changed, observed); });
    }
    for (const auto kind : {0U, 1U, 2U, 3U, 4U}) {
      if (kind == mmstoreprofile::signatureKind) continue;
      auto changed = observed; changed.signatureKind = kind;
      denied([&] { (void)manifestEntry(source, changed); });
    }
    auto unhealthy = observed; unhealthy.healthy = false;
    denied([&] { (void)manifestEntry(source, unhealthy); });
    auto stale = observed; stale.current = false;
    denied([&] { (void)manifestEntry(source, stale); });
    auto x86 = observed; x86.architecture = L"x86";
    denied([&] { (void)manifestEntry(source, x86); });
    auto incompatible = observed; incompatible.packageVersion = L"0.1.4.0";
    incompatible.fullName = std::wstring(mmstore::expectedPackage(mmstore::PackageKind::worker).identityName) +
      L"_0.1.4.0_x64__" + std::wstring(mmstore::expectedPackage(mmstore::PackageKind::worker).publisherId);
    denied([&] { (void)manifestEntry(source, incompatible); });
    std::cout << "STORE_GUI_WORKER_POLICY " << checks << " passed; portable fixtures only\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
