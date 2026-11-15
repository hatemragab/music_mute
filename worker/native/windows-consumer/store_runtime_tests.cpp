#include "store_runtime.hpp"
#include <functional>
#include <iostream>
#include <type_traits>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_RUNTIME_TEST_FAILED"); }
void denied(const std::function<void()>& operation, mmstore::ErrorCode expected) {
  bool rejected = false;
  try { operation(); } catch (const mmstore::Error& error) { rejected = error.code() == expected; }
  check(rejected);
}
mmstore::Observation policyObservation() {
  const auto& expected = mmstore::expectedPackage(mmstore::PackageKind::worker);
  return {std::wstring(expected.identityName), std::wstring(expected.publisher), std::wstring(expected.publisherId),
    std::wstring(expected.familyName), std::wstring(expected.identityName) + L"_0.1.3.7_x64__" + std::wstring(expected.publisherId),
    L"0.1.3.7", L"x64", L"C:\\Program Files\\WindowsApps\\policy-fixture", mmstoreprofile::signatureKind, true, true};
}
mmstoreinventory::Inventory policyInventory() {
  mmstoreinventory::Inventory result{mmstore::PackageKind::worker, L"0.1.3.0", {}};
  const mmstore::FilePin synthetic{std::string(64, 'a'), 1};
  for (const auto role : mmstoreruntime::workerRoles) result.entries.push_back({std::wstring(mmstore::codeSpec(role).relativePath), synthetic});
  for (const auto file : mmstoreruntime::engineFiles)
    result.entries.push_back({std::wstring(L"worker/app/engine/musicmute_engine/") + std::wstring(file), synthetic});
  for (const auto* path : {L"worker/app/package.json", L"worker/app/dist/package.json", L"worker/runtime/requirements-directml.lock.txt",
    L"worker/tools/downloader/store_downloader_bootstrap.py", L"worker/app/dist/src/runtime/store-transfer-process.js",
    L"worker/runtime/python/python312.dll", L"worker/runtime/python/Lib/site-packages/onnxruntime/capi/DirectML.dll",
    L"worker/runtime/python/Lib/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.pyd"}) result.entries.push_back({path, synthetic});
  std::sort(result.entries.begin(), result.entries.end(), [](const auto& first, const auto& second) { return first.path < second.path; });
  return result;
}
std::string asciiPath(std::wstring_view path) {
  mmstore::require(mmstore::validRelativePath(path), mmstore::ErrorCode::invalidInput);
  std::string result; result.reserve(path.size());
  for (const auto value : path) {
    mmstore::require(value >= 32 && value < 127, mmstore::ErrorCode::invalidInput);
    result.push_back(static_cast<char>(value));
  }
  return result;
}
mm::Json inventoryJson(const mmstoreinventory::Inventory& inventory) {
  mm::Json::Array entries;
  for (const auto& entry : inventory.entries) entries.push_back(mm::Json::Object{
    {"path", asciiPath(entry.path)}, {"sha256", entry.pin.sha256}, {"bytes", static_cast<std::int64_t>(entry.pin.bytes)}});
  return mm::Json::Object{{"version", 1}, {"role", "worker"}, {"packageVersion", "0.1.3.0"},
    {"protocolAbi", 1}, {"appVersion", "0.1.3"}, {"buildNumber", 1}, {"entries", std::move(entries)}};
}
void portablePolicy() {
  using namespace mmstore;
  using namespace mmstoreruntime;
  const auto source = policyInventory(); const auto observed = policyObservation();
  check(asciiPath(L"worker/runtime/python/python312.dll") == "worker/runtime/python/python312.dll");
  for (const auto* path : {L"worker/\u202epython.dll", L"worker/\u00e9.dll", L"worker/../python.dll"})
    denied([&] { (void)asciiPath(path); }, ErrorCode::invalidInput);
  denied([] { (void)asciiPath(std::wstring_view(L"worker/a\0hidden", 15)); }, ErrorCode::invalidInput);
  validateWorkerInventory(source, observed); ++checks;
  const auto parsed = mmstoreinventory::parse(PackageKind::worker, mm::JsonParser::storeCodeInventory(mm::dump(inventoryJson(source))));
  validateWorkerInventory(parsed, observed); ++checks;
  auto emptyMetadata = source;
  emptyMetadata.entries.push_back({L"worker/runtime/python/Lib/site-packages/audio_separator/__init__.py", {std::string(emptySha256), 0}});
  std::sort(emptyMetadata.entries.begin(), emptyMetadata.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  validateWorkerInventory(emptyMetadata, observed); ++checks;
  auto invalidEmptyMetadata = emptyMetadata;
  const auto emptyLeaf = std::find_if(invalidEmptyMetadata.entries.begin(), invalidEmptyMetadata.entries.end(), [](const auto& entry) { return entry.pin.bytes == 0; });
  emptyLeaf->pin.sha256 = std::string(64, 'a');
  denied([&] { validateWorkerInventory(invalidEmptyMetadata, observed); }, ErrorCode::invalidInput);
  auto emptyNode = source;
  const auto node = std::find_if(emptyNode.entries.begin(), emptyNode.entries.end(), [](const auto& entry) { return entry.path == mmstore::codeSpec(CodeRole::workerNode).relativePath; });
  node->pin = {std::string(emptySha256), 0};
  denied([&] { validateWorkerInventory(emptyNode, observed); }, ErrorCode::invalidInput);
  for (const auto& required : source.entries) {
    auto missing = source;
    missing.entries.erase(std::find_if(missing.entries.begin(), missing.entries.end(), [&](const auto& entry) { return entry.path == required.path; }));
    denied([&] { validateWorkerInventory(missing, observed); }, ErrorCode::fileDenied);
  }
  for (const auto* version : {L"0.1.4.0", L"0.2.3.0", L"1.1.3.0"}) {
    auto changed = observed; changed.packageVersion = version;
    changed.fullName = std::wstring(expectedPackage(PackageKind::worker).identityName) + L"_" + version + L"_x64__" +
      std::wstring(expectedPackage(PackageKind::worker).publisherId);
    denied([&] { validateWorkerInventory(source, changed); }, ErrorCode::stalePackage);
  }
  auto nonzeroSubmitted = source; nonzeroSubmitted.packageVersion = L"0.1.3.7";
  denied([&] { validateWorkerInventory(nonzeroSubmitted, observed); }, ErrorCode::stalePackage);
  auto wrongKind = source; wrongKind.kind = PackageKind::gui;
  denied([&] { validateWorkerInventory(wrongKind, observed); }, ErrorCode::packageDenied);
  auto outside = source; outside.entries.front().path = L"app/outside.exe";
  denied([&] { validateWorkerInventory(outside, observed); }, ErrorCode::invalidInput);
  auto traversal = source; traversal.entries.front().path = L"worker/../outside.exe";
  denied([&] { validateWorkerInventory(traversal, observed); }, ErrorCode::invalidInput);
  auto badPin = source; badPin.entries.front().pin.sha256[0] = 'A';
  denied([&] { validateWorkerInventory(badPin, observed); }, ErrorCode::invalidInput);
  auto duplicate = source; duplicate.entries.insert(duplicate.entries.begin(), duplicate.entries.front());
  denied([&] { validateWorkerInventory(duplicate, observed); }, ErrorCode::invalidInput);
  auto caseAlias = source; auto alias = caseAlias.entries.front(); alias.path = foldedPath(alias.path);
  caseAlias.entries.push_back(alias);
  std::sort(caseAlias.entries.begin(), caseAlias.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  denied([&] { validateWorkerInventory(caseAlias, observed); }, ErrorCode::invalidInput);
  auto unsorted = source; std::swap(unsorted.entries[0], unsorted.entries[1]);
  denied([&] { validateWorkerInventory(unsorted, observed); }, ErrorCode::invalidInput);
  auto ambiguity = source;
  ambiguity.entries.push_back({L"worker/runtime/python/duplicate/DirectML.dll", {std::string(64, 'a'), 1}});
  std::sort(ambiguity.entries.begin(), ambiguity.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  // Different module-local DLLs may share a basename. The actual installed
  // census must cover every file; this policy fixture is not OS authority.
  validateWorkerInventory(ambiguity, observed); ++checks;
  auto dualBackends = source;
  dualBackends.entries.push_back({L"worker/runtime/python/Lib/site-packages/torch_directml/DirectML.dll", {std::string(64, 'b'), 2}});
  std::sort(dualBackends.entries.begin(), dualBackends.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  validateWorkerInventory(dualBackends, observed); ++checks;
  const auto receivedDual = mmstoreinventory::parse(PackageKind::worker,
    mm::JsonParser::storeCodeInventory(mm::dump(inventoryJson(dualBackends))));
  validateWorkerInventory(receivedDual, observed); ++checks;
  check(requiredEntry(dualBackends, ortLibraries[1]).pin.sha256 !=
    requiredEntry(dualBackends, L"worker/runtime/python/Lib/site-packages/torch_directml/DirectML.dll").pin.sha256);
  for (const auto required : ortLibraries) {
    auto missingBackend = dualBackends;
    missingBackend.entries.erase(std::find_if(missingBackend.entries.begin(), missingBackend.entries.end(), [&](const auto& entry) { return entry.path == required; }));
    denied([&] { validateWorkerInventory(missingBackend, observed); }, ErrorCode::fileDenied);
    const auto receivedMissing = mmstoreinventory::parse(PackageKind::worker,
      mm::JsonParser::storeCodeInventory(mm::dump(inventoryJson(missingBackend))));
    denied([&] { validateWorkerInventory(receivedMissing, observed); }, ErrorCode::fileDenied);
  }
  auto misleadingBackend = dualBackends;
  const auto ort = std::find_if(misleadingBackend.entries.begin(), misleadingBackend.entries.end(), [](const auto& entry) { return entry.path == ortLibraries[1]; });
  ort->path = L"worker/runtime/python/elsewhere/DirectML.dll";
  std::sort(misleadingBackend.entries.begin(), misleadingBackend.entries.end(), [](const auto& a, const auto& b) { return a.path < b.path; });
  denied([&] { validateWorkerInventory(misleadingBackend, observed); }, ErrorCode::fileDenied);
  auto oversized = source;
  for (unsigned n = 0; n < 129; ++n) oversized.entries.push_back({L"worker/z-limit/" + std::to_wstring(1000 + n), {std::string(64, 'a'), maximumFileBytes}});
  denied([&] { validateWorkerInventory(oversized, observed); }, ErrorCode::fileDenied);
  const std::array kinds{LaunchKind::controls, LaunchKind::session, LaunchKind::nativeHelper, LaunchKind::loginAgent,
    LaunchKind::sessionAgent, LaunchKind::personalAgent, LaunchKind::fleetAgent, LaunchKind::prepareAgent,
    LaunchKind::personalEngine, LaunchKind::fleetEngine, LaunchKind::qualification, LaunchKind::pythonGuardian,
    LaunchKind::benchmarkFile, LaunchKind::benchmarkCapacity, LaunchKind::fleetTransfer, LaunchKind::modelTool, LaunchKind::ffmpeg, LaunchKind::ffprobe, LaunchKind::deno};
  for (const auto kind : kinds) {
    const auto spec = launchSpec(kind);
    check(processRole(spec.executable) && codeSpec(spec.executable).kind == PackageKind::worker);
    (void)requiredEntry(source, codeSpec(spec.executable).relativePath); ++checks;
    if (!spec.entry.empty()) {
      (void)requiredEntry(source, spec.pythonModule ? L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry)); ++checks;
    }
  }
  check(!processRole(CodeRole::guiApplication)); check(!processRole(CodeRole::workerPersonalAgent));
  check(!processRole(static_cast<CodeRole>(999)));
  denied([] { (void)launchSpec(static_cast<LaunchKind>(999)); }, ErrorCode::invalidInput);
  check(launchSpec(LaunchKind::personalEngine).entry == L"store_consumer_personal");
  check(launchSpec(LaunchKind::fleetEngine).entry == L"child");
  check(launchSpec(LaunchKind::qualification).entry == L"store_qualification");
#ifdef _WIN32
  static_assert(!std::is_default_constructible_v<WorkerCodeAuthority>);
  static_assert(!std::is_default_constructible_v<FixedLaunchPlan>);
  const ProcessIdentity identity{L"S-1-5-21-1-2-3-1000", L"S-1-5-5-1-2", L"123456789", 1, 123};
  check(sameProcessIdentity(identity, identity));
  for (unsigned n = 0; n < 5; ++n) {
    auto changed = identity;
    switch (n) { case 0: ++changed.pid; break; case 1: changed.creationTime += L"0"; break;
      case 2: changed.sid += L"1"; break; case 3: changed.logonSid += L"1"; break; case 4: ++changed.sessionId; break; }
    check(!sameProcessIdentity(identity, changed));
  }
#endif
}
#ifdef _WIN32
void actualStore() {
  using namespace mmstoreruntime;
  auto authority = resolveWorkerCode();
  check(authority.observation().signatureKind == mmstoreprofile::signatureKind && authority.retainedFileCount() > workerRoles.size());
  auto personal = authority.launchPlan(LaunchKind::personalEngine);
  check(personal.executableRole() == mmstore::CodeRole::workerPython && personal.argumentPrefix().size() == 5);
  check(personal.argumentPrefix()[0] == L"-I" && personal.argumentPrefix()[1] == L"-B" && personal.argumentPrefix()[2] == L"-c");
  check(personal.argumentPrefix()[3].find(L"musicmute_engine.store_consumer_personal") != std::wstring::npos);
  check(personal.argumentPrefix()[4] == personal.engineRoot());
  auto node = authority.launchPlan(LaunchKind::personalAgent);
  check(node.argumentPrefix().size() == 1 && node.observation().fullName == authority.observation().fullName);
  personal.revalidate(); node.revalidate(); ++checks;
  denied([&] { (void)authority.launchPlan(static_cast<LaunchKind>(999)); }, mmstore::ErrorCode::invalidInput);
  denied([&] { (void)authority.attestMember(mmstore::CodeRole::guiApplication, {}); }, mmstore::ErrorCode::invalidInput);
  // This test executable is not one of the fixed packaged production roles.
  const auto self = mmstore::detail::processIdentity(GetCurrentProcess());
  denied([&] { (void)authority.attestMember(mmstore::CodeRole::workerNode, self); }, mmstore::ErrorCode::processDenied);
}
#endif
} // namespace
int main(int argc, char** argv) {
  try {
    const bool policyOnly = argc == 2 && std::string_view(argv[1]) == "--policy-only";
    mmstore::require(argc == 1 || policyOnly, mmstore::ErrorCode::invalidInput);
    portablePolicy(); std::cout << "Store Worker portable policy checks passed: " << checks << '\n';
    if (policyOnly) return 0;
#ifdef _WIN32
    try { actualStore(); }
    catch (const mmstore::Error& error) {
      if (error.code() != mmstore::ErrorCode::packageNotRegistered && error.code() != mmstore::ErrorCode::unsupportedHost) throw;
      std::cout << "Store Worker OS checks skipped: unsupported host or no expected registered Store Worker. No positive Store runtime authority was established.\n";
      return 77;
    }
    std::cout << "Store Worker actual protected code checks passed. Process launch and guardian/GPU readiness are separate acceptance gates.\n";
    return 0;
#else
    std::cout << "Store Worker OS checks unavailable on this platform. No positive Store runtime authority was established.\n";
    return 77;
#endif
  } catch (const std::exception& error) {
    std::cerr << "Store Worker test failed: " << error.what() << '\n'; return 1;
  }
}
