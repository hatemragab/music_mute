#pragma once
#include "json.hpp"
#include "store_runtime.hpp"
#include <memory>
#include <string_view>

namespace mmstoreguiworkerpolicy {
inline constexpr std::wstring_view manifestPath = L"worker/release-manifest.json";
inline constexpr std::uint64_t maximumManifestBytes = 8ULL * 1024 * 1024;
inline constexpr std::wstring_view sessionAumid = mmstoreprofile::workerSessionAumid;
inline bool operation(std::string_view value) noexcept {
  return value == "store_worker_code_open" || value == "store_worker_code_check" ||
    value == "store_worker_code_benchmark" ||
    value == "store_worker_code_cleanup_check" ||
    value == "store_worker_code_close" || value == "store_worker_session_activate";
}
// This validates receiving grammar only, never registration/code authority.
inline void input(std::string_view name, const mm::Json& args) {
  try {
    mmstore::require(operation(name), mmstore::ErrorCode::invalidInput);
    mmstoreinventory::exact(args, {});
  } catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(mmstore::ErrorCode::invalidInput); }
}
inline const mmstoreinventory::Entry& manifestEntry(const mmstoreinventory::Inventory& inventory,
    const mmstore::Observation& observed) {
  mmstoreruntime::validateWorkerInventory(inventory, observed);
  const auto& entry = mmstoreruntime::requiredEntry(inventory, manifestPath);
  mmstore::validatePin(entry.pin);
  mmstore::require(entry.pin.bytes <= maximumManifestBytes, mmstore::ErrorCode::fileDenied);
  return entry;
}
} // namespace mmstoreguiworkerpolicy

#if defined(_WIN32) && !defined(MUSICMUTE_STORE_GUI_WORKER_POLICY_ONLY)
// Included inside main.cpp's implementation namespace after its Store/core
// helpers. Initial authority is the complete hashed and retained Worker tree;
// reflected observations and caller-supplied hashes cannot create this lease.
inline void storeGuiWorkerBoot(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data) {
  if (boot.package.kind() != mmstore::PackageKind::gui ||
      boot.self.role() != mmstore::CodeRole::guiNative ||
      boot.parent.role() != mmstore::CodeRole::guiApplication) fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); boot.package.revalidate(); data.revalidate();
}
struct StoreGuiWorkerCodeLease {
  mmstoreruntime::WorkerCodeAuthority code;
  const std::string inventoryGeneration;
  mmstore::RegisteredPackage registration;
  mmstore::ImmutableFile inventoryFile;
  const mmstoreinventory::Inventory inventory;
  mmstore::ImmutableFile manifest;
  mmstore::ImmutableFile session;

  static mmstoreinventory::Inventory readInventory(const mmstore::ImmutableFile& file) {
    const auto bytes = file.read(8 * 1024 * 1024);
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    return mmstoreinventory::parse(mmstore::PackageKind::worker, mm::JsonParser::storeCodeInventory(text));
  }
  StoreGuiWorkerCodeLease()
    : code(mmstoreruntime::resolveWorkerCode()), inventoryGeneration(code.inventorySha256()),
      registration(mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker)),
      inventoryFile(registration.openInventory()), inventory(readInventory(inventoryFile)),
      manifest(registration.openResource(mmstoreguiworkerpolicy::manifestPath,
        mmstoreguiworkerpolicy::manifestEntry(inventory, registration.observation()).pin)),
      session(registration.openCode(mmstore::CodeRole::workerSession,
        mmstoreinventory::codePin(inventory, mmstore::CodeRole::workerSession))) {
    revalidate();
  }
  void revalidate() const {
    // The complete private inventory was parsed, hashed and held at creation.
    // Ordinary data/control checks cannot admit another leaf or launch path.
    code.revalidateOperationIdentity(); registration.revalidate(); inventoryFile.revalidateIdentity();
    if (!mmstore::detail::sameObservation(code.observation(), registration.observation()) ||
        code.inventorySha256() != inventoryFile.pin().sha256 || manifest.relativePath() != mmstoreguiworkerpolicy::manifestPath ||
        manifest.pin().bytes < 1 || manifest.pin().bytes > mmstoreguiworkerpolicy::maximumManifestBytes) fail("PEER_DENIED");
    manifest.revalidateIdentity(); session.revalidateIdentity(); code.revalidateOperationIdentity();
  }
  void revalidateCleanup() const {
    // Original owned cleanup may retire while the immutable-tree watch is
    // poisoned. Current genuine registration and every critical held identity
    // remain mandatory; this method admits no new code or Session launch.
    code.revalidateCleanupIdentity(); registration.revalidate(); inventoryFile.revalidateIdentity();
    if (!mmstore::detail::sameObservation(code.observation(), registration.observation()) ||
        inventoryGeneration != inventoryFile.pin().sha256 || manifest.relativePath() != mmstoreguiworkerpolicy::manifestPath ||
        manifest.pin().bytes < 1 || manifest.pin().bytes > mmstoreguiworkerpolicy::maximumManifestBytes) fail("PEER_DENIED");
    manifest.revalidateIdentity(); session.revalidateIdentity(); code.revalidateCleanupIdentity();
  }
  void admitSession() const {
    revalidate();
    const auto plan = code.heldLaunchPlan(mmstoreruntime::LaunchKind::session);
    plan.revalidateFixedAdmission(); session.revalidate();
    if (plan.executableRole() != mmstore::CodeRole::workerSession ||
        !mmstore::detail::samePath(plan.executablePath(), session.absolutePath()) ||
        plan.executablePin().sha256 != session.pin().sha256 ||
        plan.executablePin().bytes != session.pin().bytes) fail("PEER_DENIED");
    // This shared helper checks PE architecture only. Genuine Store origin is
    // proved independently by the held registered package and sealed code tree.
    assertSignedPeArchitecture(session.handle(), false);
    const auto image = session.absolutePath();
    const auto module = LoadLibraryExW(image.c_str(), nullptr,
      LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
    if (!module) fail("HELPER_INTEGRITY_INVALID");
    struct Resource { HMODULE value; ~Resource() { FreeLibrary(value); } } resource{module};
    const auto entry = FindResourceW(module, MAKEINTRESOURCEW(1), RT_MANIFEST);
    if (!entry) fail("HELPER_INTEGRITY_INVALID");
    const auto bytes = SizeofResource(module, entry);
    const auto loaded = LoadResource(module, entry);
    const auto manifestData = static_cast<const BYTE*>(LockResource(loaded));
    assertAsInvokerManifest(manifestData, bytes);
    session.revalidate(); plan.revalidateFixedAdmission(); revalidate();
  }
  Json observation() const {
    revalidate();
    return Json::Object{{"version", 1}, {"package", storeObservation(code.observation())},
      {"inventory_sha256", code.inventorySha256()},
      {"manifest", Json::Object{{"path", utf8(manifest.relativePath())},
        {"bytes", static_cast<std::int64_t>(manifest.pin().bytes)}, {"sha256", manifest.pin().sha256}}}};
  }
  Json benchmarkCodeView() const {
    revalidate();
    const auto digest = code.engineDigest();
    const auto helper = code.nativeHelperPin();
    auto result = Json::Object{{"inventorySha256", code.inventorySha256()},
      {"runtimeManifestSha256", manifest.pin().sha256},
      {"helperSha256", helper.sha256}, {"engineDigest", digest}};
    revalidate(); return result;
  }
};
std::unique_ptr<StoreGuiWorkerCodeLease> storeGuiWorkerCodeLease;
inline bool storeGuiWorkerOperation(std::string_view operation) noexcept {
  return mmstoreguiworkerpolicy::operation(operation);
}
inline Json dispatchStoreGuiWorker(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data, const std::string& operation, const Json& args) {
  try {
    mmstoreguiworkerpolicy::input(operation, args); storeGuiWorkerBoot(boot, data);
    if (operation == "store_worker_code_open") {
      if (storeGuiWorkerCodeLease) fail("PEER_DENIED");
      auto opened = std::make_unique<StoreGuiWorkerCodeLease>();
      auto result = opened->observation(); storeGuiWorkerBoot(boot, data);
      storeGuiWorkerCodeLease = std::move(opened); return result;
    }
    if (!storeGuiWorkerCodeLease) fail("PEER_DENIED");
    if (operation == "store_worker_code_cleanup_check") {
      storeGuiWorkerCodeLease->revalidateCleanup(); storeGuiWorkerBoot(boot, data);
      return Json::Object{{"valid", true}};
    }
    storeGuiWorkerCodeLease->revalidate();
    if (operation == "store_worker_code_check") {
      storeGuiWorkerBoot(boot, data); return Json::Object{{"valid", true}};
    }
    if (operation == "store_worker_code_benchmark") {
      auto result = storeGuiWorkerCodeLease->benchmarkCodeView();
      storeGuiWorkerBoot(boot, data); return result;
    }
    if (operation == "store_worker_code_close") {
      storeGuiWorkerCodeLease.reset(); storeGuiWorkerBoot(boot, data);
      return Json::Object{{"released", true}};
    }
    if (operation == "store_worker_session_activate") {
      storeGuiWorkerCodeLease->admitSession(); storeGuiWorkerBoot(boot, data);
      // Windows owns this fixed launch outside a transient caller's Job. The
      // PID is only the OS launch-contract ACK; Session authentication/GPU/Job
      // readiness is proved separately, never by this response.
      // https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-iapplicationactivationmanager
      mmstore::detail::Apartment apartment;
      winrt::com_ptr<IApplicationActivationManager> manager;
      check(SUCCEEDED(CoCreateInstance(CLSID_ApplicationActivationManager, nullptr,
        CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(manager.put()))), "JOB_UNAVAILABLE");
      DWORD pid = 0;
      check(SUCCEEDED(manager->ActivateApplication(mmstoreguiworkerpolicy::sessionAumid.data(),
        nullptr, AO_NOERRORUI, &pid)) && pid > 0 && pid <= 2147483647, "JOB_UNAVAILABLE");
      storeGuiWorkerCodeLease->admitSession(); storeGuiWorkerBoot(boot, data);
      return Json::Object{{"activated", true}, {"pid", static_cast<std::int64_t>(pid)},
        {"package", storeObservation(storeGuiWorkerCodeLease->code.observation())}};
    }
    fail("BAD_REQUEST");
  } catch (...) {
    // The existing Session client borrows this exact lease. Failed validation
    // cannot destroy that owner and strand (or dangle) its original cleanup.
    // New work remains denied; only explicit same-owner retirement closes it.
    throw;
  }
}
#endif
