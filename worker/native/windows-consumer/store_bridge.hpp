#pragma once
// Included by main.cpp inside its implementation namespace. OS authority itself
// is defined outside that namespace in store_authority.hpp.
#include "store_gui_issuer.hpp"
bool storeTransportMode = false;
std::unique_ptr<mmstore::BootstrapAttestation> storeBootstrap;
std::unique_ptr<mmstorerole::StoreRoleBinding> storeWorkerRole;
std::unique_ptr<mmstorenamespace::PrivateNamespaceAuthority> storePrivateNamespace;
std::map<std::string, mmstore::ImmutableFile> storeResourceLocks;

bool registeredPackageContext() {
  UINT32 characters = 0;
  const auto result = GetCurrentPackageFullName(&characters, nullptr);
  if (result == APPMODEL_ERROR_NO_PACKAGE) return false;
  if (result != ERROR_INSUFFICIENT_BUFFER || characters < 2 || characters > 4096)
    fail("HELPER_INTEGRITY_INVALID");
  return true;
}
Json storeObservation(const mmstore::Observation& value) {
  return Json::Object{
    {"identityName", utf8(value.identityName)}, {"publisher", utf8(value.publisher)},
    {"publisherId", utf8(value.publisherId)}, {"familyName", utf8(value.familyName)},
    {"fullName", utf8(value.fullName)}, {"packageVersion", utf8(value.packageVersion)},
    {"architecture", utf8(value.architecture)}, {"signatureKind", static_cast<std::int64_t>(value.signatureKind)},
    {"healthy", value.healthy}, {"current", value.current}, {"installedLocation", utf8(value.installedLocation)}
  };
}
Json storeProcess(const mmstore::ProcessIdentity& value) {
  return Json::Object{{"sid", utf8(value.sid)}, {"session_id", static_cast<std::int64_t>(value.sessionId)},
    {"pid", static_cast<std::int64_t>(value.pid)}, {"creation_time", utf8(value.creationTime)}};
}
mmstore::FilePin storePin(const Json& args, const char* digest, const char* size) {
  const auto bytes = args.at(size).integer();
  if (bytes < 1) fail("BAD_REQUEST");
  mmstore::FilePin result{args.at(digest).string(), static_cast<std::uint64_t>(bytes)};
  mmstore::validatePin(result); return result;
}
mmstore::CodeRole storeParentRole(const std::string& value) {
  if (value == "gui-application") return mmstore::CodeRole::guiApplication;
  if (value == "worker-node") return mmstore::CodeRole::workerNode;
  if (value == "worker-controls") return mmstore::CodeRole::workerControls;
  if (value == "worker-session") return mmstore::CodeRole::workerSession;
  fail("BAD_REQUEST");
}
bool authorizeStoreGuiPrivateDataCaller() {
  if (!storeTransportMode) return false;
  if (!storeBootstrap || !storePrivateNamespace ||
      storeBootstrap->package.kind() != mmstore::PackageKind::gui ||
      storeBootstrap->parent.role() != mmstore::CodeRole::guiApplication)
    fail("PEER_DENIED");
  storeBootstrap->self.revalidate(); storeBootstrap->parent.revalidate();
  storeBootstrap->package.revalidate(); storePrivateNamespace->revalidate();
  return true;
}
bool authorizeStorePersonalPrivateDataCaller() {
  if (!storeTransportMode) return false;
  if (storeBootstrap && storeBootstrap->package.kind() == mmstore::PackageKind::gui) return false;
  if (!storeBootstrap || !storePrivateNamespace || !storeWorkerRole ||
      storeBootstrap->package.kind() != mmstore::PackageKind::worker ||
      storeBootstrap->parent.role() != mmstore::CodeRole::workerNode ||
      storeWorkerRole->role() != mmstorerole::Role::personal)
    fail("PEER_DENIED");
  storeWorkerRole->revalidate(*storeBootstrap); storePrivateNamespace->revalidate();
  return true;
}
bool readStorePersonalCleanupState(const Json& owner, Json& state) {
  if (!storeTransportMode) return false;
  if (!authorizeStorePersonalPrivateDataCaller()) fail("PEER_DENIED");
  state = storeWorkerRole->cleanupState(*storeBootstrap, owner);
  (void)authorizeStorePersonalPrivateDataCaller();
  return true;
}
bool storeRetainedPersonalCleanupIdle(const Json& owner) {
  if (!storeTransportMode) return false;
  if (!authorizeStorePersonalPrivateDataCaller()) fail("PEER_DENIED");
  const auto actualOwner = Json::Object{{"role", "personal"}, {"nonce", storeWorkerRole->ownerNonce()},
    {"identity", storeProcess(storeBootstrap->parent.identity())}};
  if (!boundGpuRole || mm::dump(owner) != mm::dump(actualOwner) ||
      mm::dump(boundGpuRole->owner) != mm::dump(actualOwner) || gpuGuards.size() != 1)
    return false;
  const auto& proxy = gpuGuards.begin()->second;
  if (!proxy.storeProxy || !proxy.storeKeeper) fail("GPU_GUARD_UNSAFE");
  const auto inspect = [&] {
    (void)authorizeStorePersonalPrivateDataCaller(); proxy.storeKeeper->revalidate();
    const auto held = storeWorkerRole->broker(*storeBootstrap, mmstorerole::BrokerCommand::gpuInspect,
      Json::Object{{"luid", gpuGuards.begin()->first}, {"nonce", proxy.nonce}});
    keys(held, {"held"}); if (!std::get<bool>(held.at("held").value)) fail("GPU_GUARD_UNSAFE");
  };
  inspect();
  const bool idle = retainedEngineQuiescent();
  inspect();
  return idle;
}
#include "store_browser.hpp"
#include "store_account.hpp"
#include "store_worker_bridge.hpp"
#include "store_gui_worker.hpp"
#include "store_session_client.hpp"
bool storeCpuExpectationReceiving(const Json& expectation) { return mmstorerole::cpuOperationExpectation(expectation); }
bool authorizeStoreCpuCleanupCaller(const Json& expectation) {
  if (!storeTransportMode) return false;
  if (!storeBootstrap || !storePrivateNamespace || !mmstorerole::cpuOperationExpectation(expectation)) fail("PEER_DENIED");
  const auto& owner = expectation.at("nodeOwner"); const auto& identity = owner.at("identity");
  const auto current = storeBootstrap->self.identity();
  if (identity.at("sid").string() != utf8(current.sid) || identity.at("sessionId").integer() != current.sessionId) fail("PEER_DENIED");
  if (storeBootstrap->package.kind() == mmstore::PackageKind::gui) {
    (void)authorizeStoreGuiPrivateDataCaller(); if (!storeGuiSessionClient) fail("PEER_DENIED");
    // The original held GUI client chooses the Creator; the subsequent exact
    // row/memo query supplies the association, never the observed Node alone.
    storeGuiSessionClient->revalidate(*storeBootstrap, *storePrivateNamespace, true);
  } else {
    if (!storeWorkerRole || storeBootstrap->package.kind() != mmstore::PackageKind::worker || storeBootstrap->parent.role() != mmstore::CodeRole::workerNode ||
        (storeWorkerRole->role() != mmstorerole::Role::personal && storeWorkerRole->role() != mmstorerole::Role::prepare)) fail("PEER_DENIED");
    storeWorkerRole->revalidateCleanup(*storeBootstrap); storePrivateNamespace->revalidate();
    const auto& node = storeWorkerRole->nodeIdentity();
    if (owner.at("role").string() != mmstorerole::roleName(storeWorkerRole->role()) || owner.at("nonce").string() != storeWorkerRole->ownerNonce() ||
        identity.at("pid").integer() != node.pid || identity.at("creationTime").string() != utf8(node.creationTime) ||
        identity.at("sid").string() != utf8(node.sid) || identity.at("sessionId").integer() != node.sessionId) fail("PEER_DENIED");
  }
  return true;
}
void forgetStoreCpuOperationCleanupState(const Json& expectation,const std::string& requestId) {
  if (!storeTransportMode || !storeBootstrap || !storePrivateNamespace || !mmstorerole::cpuOperationExpectation(expectation) || !mmstorerole::data_policy::uuid(requestId)) fail("PEER_DENIED");
  if (storeBootstrap->package.kind() == mmstore::PackageKind::gui) {
    (void)authorizeStoreGuiPrivateDataCaller(); if (!storeGuiSessionClient) fail("PEER_DENIED");
    const Json command=Json::Object{{"version",1},{"requestId",requestId},{"action","cpu_operation_forget"},{"expectation",expectation}};
    const auto result=storeGuiSessionClient->exchange(*storeBootstrap,*storePrivateNamespace,"gui-session",&command);
    keys(result,{"forgotten"});if(!std::holds_alternative<bool>(result.at("forgotten").value)||!std::get<bool>(result.at("forgotten").value))fail("PEER_DENIED");
    (void)authorizeStoreGuiPrivateDataCaller();
  } else {
    if (!storeWorkerRole || storeBootstrap->package.kind()!=mmstore::PackageKind::worker || storeBootstrap->parent.role()!=mmstore::CodeRole::workerNode ||
        (storeWorkerRole->role()!=mmstorerole::Role::personal && storeWorkerRole->role()!=mmstorerole::Role::prepare))fail("PEER_DENIED");
    storeWorkerRole->revalidateCleanup(*storeBootstrap);storePrivateNamespace->revalidate();
    storeWorkerRole->cpuForgetCompleted(*storeBootstrap,expectation,requestId);
    storeWorkerRole->revalidateCleanup(*storeBootstrap);storePrivateNamespace->revalidate();
  }
}
void releaseStoreCpuOperationCleanupState(const Json& expectation,const std::string& requestId) {
  if (!storeTransportMode || !storeBootstrap || !storePrivateNamespace || !mmstorerole::cpuOperationExpectation(expectation) || !mmstorerole::data_policy::uuid(requestId)) fail("PEER_DENIED");
  if (storeBootstrap->package.kind() == mmstore::PackageKind::gui) {
    (void)authorizeStoreGuiPrivateDataCaller(); if (!storeGuiSessionClient) fail("PEER_DENIED");
    const Json command=Json::Object{{"version",1},{"requestId",requestId},{"action","cpu_operation_release"},{"expectation",expectation}};
    const auto result=storeGuiSessionClient->exchange(*storeBootstrap,*storePrivateNamespace,"gui-session",&command);
    keys(result,{"released"});if(!std::holds_alternative<bool>(result.at("released").value)||!std::get<bool>(result.at("released").value))fail("PEER_DENIED");
    (void)authorizeStoreGuiPrivateDataCaller();
  } else {
    if (!storeWorkerRole || storeBootstrap->package.kind()!=mmstore::PackageKind::worker || storeBootstrap->parent.role()!=mmstore::CodeRole::workerNode ||
        (storeWorkerRole->role()!=mmstorerole::Role::personal && storeWorkerRole->role()!=mmstorerole::Role::prepare))fail("PEER_DENIED");
    storeWorkerRole->revalidateCleanup(*storeBootstrap);storePrivateNamespace->revalidate();
    storeWorkerRole->cpuReleaseCompleted(*storeBootstrap,expectation,requestId);
    storeWorkerRole->revalidateCleanup(*storeBootstrap);storePrivateNamespace->revalidate();
  }
}
bool readStoreCpuOperationCleanupState(const Json& expectation, Json& state) {
  if (!storeTransportMode) return false;
  if (!storeBootstrap || !storePrivateNamespace || !mmstorerole::cpuOperationExpectation(expectation)) fail("PEER_DENIED");
  if (storeBootstrap->package.kind() == mmstore::PackageKind::gui) {
    (void)authorizeStoreGuiPrivateDataCaller();
    if (!storeGuiSessionClient) fail("PEER_DENIED");
    // The already-held genuine GUI client selects its own Creator/Job. The
    // receiving expectation cannot select another pipe, process or code root.
    auto id = randomHex().substr(0, 32); id[12] = '4'; id[16] = '8';
    const auto request = id.substr(0, 8) + "-" + id.substr(8, 4) + "-" + id.substr(12, 4) + "-" + id.substr(16, 4) + "-" + id.substr(20, 12);
    const Json command = Json::Object{{"version", 1}, {"requestId", request}, {"action", "cpu_operation_inspect"}, {"expectation", expectation}};
    state = storeGuiSessionClient->exchange(*storeBootstrap, *storePrivateNamespace, "gui-session", &command);
    (void)authorizeStoreGuiPrivateDataCaller();
  } else {
    if (!storeWorkerRole || storeBootstrap->package.kind() != mmstore::PackageKind::worker ||
        storeBootstrap->parent.role() != mmstore::CodeRole::workerNode ||
        (storeWorkerRole->role() != mmstorerole::Role::personal && storeWorkerRole->role() != mmstorerole::Role::prepare)) fail("PEER_DENIED");
    storeWorkerRole->revalidateCleanup(*storeBootstrap); storePrivateNamespace->revalidate();
    state = storeWorkerRole->cpuCleanupState(*storeBootstrap, expectation);
    storeWorkerRole->revalidateCleanup(*storeBootstrap); storePrivateNamespace->revalidate();
  }
  keys(state, {"retired"}); if (!std::holds_alternative<bool>(state.at("retired").value)) fail("PEER_DENIED");
  return true;
}
Json dispatchStore(const std::string& operation, const Json& args) {
  try {
    if (operation == "store_boot") {
      if (storeBootstrap) fail("PEER_DENIED");
      const auto role = args.at("role").string();
      if (role != "gui" && role != "worker") fail("BAD_REQUEST");
      const auto parentRole = storeParentRole(args.at("parent_role").string());
      if (role == "gui") keys(args, {"role", "parent_role", "issuer_nonce"});
      else if (parentRole == mmstore::CodeRole::workerNode)
        keys(args, {"role", "parent_role", "creator_pid", "creator_creation_time", "creator_channel", "creator_capability"});
      else keys(args, {"role", "parent_role"});
      const auto kind = role == "gui" ? mmstore::PackageKind::gui : mmstore::PackageKind::worker;
      const auto package = mmstore::resolveRegisteredPackage(kind);
      auto protectedInventory = package.openInventory();
      const auto inventoryBytes = protectedInventory.read(8 * 1024 * 1024);
      const std::string inventoryText(reinterpret_cast<const char*>(inventoryBytes.data()), inventoryBytes.size());
      const auto inventory = mmstoreinventory::parse(kind, mm::JsonParser::storeCodeInventory(inventoryText));
      const auto installedVersion = mmstore::parseVersion(package.observation().packageVersion);
      const auto sealedVersion = mmstore::parseVersion(inventory.packageVersion);
      if (installedVersion[0] != sealedVersion[0] || installedVersion[1] != sealedVersion[1] || installedVersion[2] != sealedVersion[2])
        fail("HELPER_INTEGRITY_INVALID");
      // Pins come only from the actual registered package's protected inventory.
      // A caller's digest/path/receipt cannot manufacture executable authority.
      const auto selfPin = mmstoreinventory::codePin(inventory, role == "gui" ? mmstore::CodeRole::guiNative : mmstore::CodeRole::workerNative);
      const auto parentPin = mmstoreinventory::codePin(inventory, parentRole);
      auto attestation = mmstore::attestHelperParent(kind, selfPin, parentPin, parentRole);
      if (role == "gui") authenticateStoreGuiIssuer(attestation, args.at("issuer_nonce").string());
      std::unique_ptr<mmstorerole::StoreRoleBinding> roleBinding;
      if (role == "worker" && parentRole == mmstore::CodeRole::workerNode) {
        const Json issuer = Json::Object{{"creator_pid", args.at("creator_pid")},
          {"creator_creation_time", args.at("creator_creation_time")},
          {"creator_channel", args.at("creator_channel")}, {"creator_capability", args.at("creator_capability")}};
        roleBinding = std::make_unique<mmstorerole::StoreRoleBinding>(mmstorerole::StoreRoleBinding::open(attestation, issuer));
      }
      protectedInventory.revalidate();
      if (attestation.package.observation().fullName != package.observation().fullName) fail("HELPER_INTEGRITY_INVALID");
      storeBootstrap = std::make_unique<mmstore::BootstrapAttestation>(std::move(attestation));
      storeWorkerRole = std::move(roleBinding);
      return Json::Object{{"version", 1}, {"package", storeObservation(storeBootstrap->package.observation())},
        {"helper", storeProcess(storeBootstrap->self.identity())}, {"parent", storeProcess(storeBootstrap->parent.identity())},
        {"logon_sid", utf8(storeBootstrap->self.identity().logonSid)}};
    }
    if (!storeBootstrap) fail("PEER_DENIED");
    storeBootstrap->self.revalidate(); storeBootstrap->parent.revalidate(); storeBootstrap->package.revalidate();
    if (storeWorkerRole) storeWorkerRole->revalidate(*storeBootstrap);
    if (storeGuiSessionOperation(operation)) {
      if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
      auto result = dispatchStoreGuiSession(*storeBootstrap, *storePrivateNamespace, operation, args);
      (void)authorizeStoreGuiPrivateDataCaller();
      return result;
    }
    if (storeGuiWorkerOperation(operation)) {
      if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
      if (storeGuiSessionClient && (operation == "store_worker_code_open" || operation == "store_worker_code_close"))
        fail("PEER_DENIED");
      auto result = dispatchStoreGuiWorker(*storeBootstrap, *storePrivateNamespace, operation, args);
      (void)authorizeStoreGuiPrivateDataCaller();
      return result;
    }
    if (storeWorkerBrokerOperation(operation)) return dispatchStoreWorkerBroker(operation, args);
    if (operation == "store_role_owner") {
      keys(args, {});
      if (!storePrivateNamespace || !storeWorkerRole ||
          storeBootstrap->package.kind() != mmstore::PackageKind::worker ||
          storeBootstrap->parent.role() != mmstore::CodeRole::workerNode)
        fail("PEER_DENIED");
      storePrivateNamespace->revalidate();
      return Json::Object{{"version", 1}, {"role", std::string(mmstorerole::roleName(storeWorkerRole->role()))},
        {"nonce", storeWorkerRole->ownerNonce()}, {"node", storeProcess(storeBootstrap->parent.identity())},
        {"package", storeObservation(storeWorkerRole->observation())},
        {"inventory_sha256", storeWorkerRole->inventorySha256()}, {"protocol_abi", 1}};
    }
    if (operation == "store_startup") {
      keys(args, {"intent"});
      const auto result = mmstorestartup::apply(*storeBootstrap, mmstorestartup::parseIntent(args.at("intent").string()));
      return Json::Object{{"before", std::string(mmstorestartup::stateName(result.before))},
        {"after", std::string(mmstorestartup::stateName(result.after))}, {"action", std::string(mmstorestartup::actionName(result.action))}};
    }
    if (operation == "store_package_lock") {
      keys(args, {"path", "sha256", "bytes"});
      if (storeResourceLocks.size() >= 16) fail("JOB_BUSY");
      const auto path = wide(args.at("path").string());
      auto file = storeBootstrap->package.openResource(path, storePin(args, "sha256", "bytes"));
      const auto token = randomHex();
      const auto absolute = file.absolutePath();
      const auto digest = file.pin().sha256; const auto bytes = file.pin().bytes;
      storeResourceLocks.emplace(token, std::move(file));
      return Json::Object{{"token", token}, {"path", utf8(absolute)},
        {"full_name", utf8(storeBootstrap->package.observation().fullName)}, {"sha256", digest},
        {"bytes", static_cast<std::int64_t>(bytes)}};
    }
    if (operation == "store_package_release") {
      keys(args, {"token"}); const auto token = args.at("token").string();
      const auto found = storeResourceLocks.find(token);
      if (found == storeResourceLocks.end()) fail("PEER_DENIED");
      found->second.revalidate(); storeResourceLocks.erase(found);
      return Json::Object{{"released", true}};
    }
    if (operation == "store_private_boot") {
      keys(args, {});
      const bool gui = storeBootstrap->package.kind() == mmstore::PackageKind::gui &&
        storeBootstrap->parent.role() == mmstore::CodeRole::guiApplication;
      const bool worker = storeBootstrap->package.kind() == mmstore::PackageKind::worker &&
        storeBootstrap->parent.role() == mmstore::CodeRole::workerNode && storeWorkerRole;
      // Node image origin alone grants nothing: Worker callers must retain
      // their actual creator-issued fixed-script and named-Job binding.
      if (storePrivateNamespace || (!gui && !worker))
        fail("PEER_DENIED");
      auto authority = mmstorenamespace::PrivateNamespaceAuthority::open(storeBootstrap->package);
      storePrivateNamespace = std::make_unique<mmstorenamespace::PrivateNamespaceAuthority>(std::move(authority));
      return Json::Object{{"authorized", true}, {"namespace", "unvirtualized-v1"}};
    }
    if (operation == "store_worker_discover") {
      keys(args, {});
      if (!storePrivateNamespace || storeBootstrap->package.kind() != mmstore::PackageKind::gui ||
          storeBootstrap->parent.role() != mmstore::CodeRole::guiApplication)
        fail("PEER_DENIED");
      storePrivateNamespace->revalidate();
      // Only actual absence becomes missing. Failed queries, unhealthy,
      // foreign, unsigned and stale deployments retain their denial.
      try {
        const auto worker = mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker);
        worker.revalidate();
        auto result = Json::Object{{"version", 1}, {"state", "installed"},
          {"package", storeObservation(worker.observation())}};
        storePrivateNamespace->revalidate();
        storeBootstrap->self.revalidate(); storeBootstrap->parent.revalidate();
        return result;
      } catch (const mmstore::Error& error) {
        if (error.code() != mmstore::ErrorCode::packageNotRegistered) throw;
        storePrivateNamespace->revalidate();
        return Json::Object{{"version", 1}, {"state", "missing"}};
      }
    }
    if (operation == "store_browser_registration" || operation == "store_browser_attach") {
      if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
      auto result = operation == "store_browser_registration"
        ? dispatchStoreBrowserRegistration(*storeBootstrap, *storePrivateNamespace, args)
        : attachStoreBrowserHost(*storeBootstrap, *storePrivateNamespace, args);
      (void)authorizeStoreGuiPrivateDataCaller();
      return result;
    }
    if (mmstoreaccountpolicy::operation(operation)) {
      if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
      auto result = dispatchStoreAccount(*storeBootstrap, *storePrivateNamespace, operation, args);
      (void)authorizeStoreGuiPrivateDataCaller();
      return result;
    }
    if (operation == "store_fixture_file_open") {
      // This Store-only retained data file never reaches executable trees,
      // legacy resume paths, package authority, a GPU lease or Ready records.
      if (!mmstorerole::workerDataOperation(mmstorerole::Role::prepare, operation, args)) fail("BAD_REQUEST");
      const auto authorize = [&] {
        if (!storeBootstrap || !storePrivateNamespace) fail("PEER_DENIED");
        if (storeBootstrap->package.kind() == mmstore::PackageKind::gui) {
          if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
        } else {
          if (!storeWorkerRole || storeWorkerRole->role()!=mmstorerole::Role::prepare ||
              storeBootstrap->parent.role()!=mmstore::CodeRole::workerNode) fail("PEER_DENIED");
          storeWorkerRole->revalidate(*storeBootstrap); storePrivateNamespace->revalidate();
        }
      };
      authorize(); auto result=openPrivateFile(args,true); authorize(); return result;
    }
    if (mmstoresharepolicy::operation(operation)) {
      if(!mmstoresharepolicy::input(operation,args))fail("BAD_REQUEST");
      if(!authorizeStoreGuiPrivateDataCaller())fail("PEER_DENIED");
      if(operation=="store_share_start" && mm::dump(args.at("window_owner"))!=mm::dump(storeProcess(storeBootstrap->parent.identity())))fail("PEER_DENIED");
      auto result=operation=="store_share_start"?startNativeShare(args,true):
        operation=="store_share_inspect"?inspectNativeShare(args,true):
        operation=="store_share_cancel"?cancelNativeShare(args,true):
        operation=="store_share_cleanup_acknowledge"?acknowledgeNativeShareCleanup(args,true):pruneNativeShareReceipts();
      (void)authorizeStoreGuiPrivateDataCaller();return result;
    }
    if (mmstoremodelpolicy::operation(operation)) {
      if (!mmstoremodelpolicy::input(operation, args)) fail("BAD_REQUEST");
      if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
      auto result = operation == "store_model_file_open" ? openStoreModelFile(args) :
        operation == "store_model_publish" ? publishStoreModel(args) : recoverStoreModelPublication();
      (void)authorizeStoreGuiPrivateDataCaller(); return result;
    }
    if (storeWorkerRole && storePrivateNamespace &&
        storeBootstrap->package.kind() == mmstore::PackageKind::worker &&
        storeBootstrap->parent.role() == mmstore::CodeRole::workerNode &&
        mmstorerole::workerDataOperation(storeWorkerRole->role(), operation, args)) {
      // A changed code subtree denies new work permanently, but the original
      // owner must still be able to close its held file or release its mutex.
      // This path remains behind the exact role/data receiving policy above
      // and retains all real package, logon, critical-code and Job checks.
      const bool cleanup = operation == "private_file_close" || operation == "release_mutex" ||
        operation == "store_cpu_operation_cleanup_inspect" || operation == "store_cpu_workspace_marker_retire" ||
        operation == "store_cpu_workspace_marker_acknowledge" || operation == "store_cpu_workspace_marker_release";
      const auto authorize = [&] {
        if (cleanup) storeWorkerRole->revalidateCleanup(*storeBootstrap);
        else storeWorkerRole->revalidate(*storeBootstrap);
        storePrivateNamespace->revalidate();
      };
      authorize();
      auto result = dispatchConsumerOperation(operation, args);
      authorize();
      return result;
    }
    if (mmstorenamespace::guiDataOperation(operation)) {
      if (!storePrivateNamespace || storeBootstrap->parent.role() != mmstore::CodeRole::guiApplication ||
          storeBootstrap->package.kind() != mmstore::PackageKind::gui)
        fail("PEER_DENIED");
      storePrivateNamespace->revalidate();
      auto result = dispatchConsumerOperation(operation, args);
      storeBootstrap->self.revalidate(); storeBootstrap->parent.revalidate(); storeBootstrap->package.revalidate();
      storePrivateNamespace->revalidate();
      return result;
    }
    // A Store helper cannot fall through into legacy release-root, retained
    // launcher, registry, mutable-code or Authenticode-leaf authority paths.
    fail("LAUNCH_VERIFICATION_REQUIRED");
  } catch (const mmstore::Error& error) {
    const auto observedWin32 = GetLastError();
    const auto diagnostic = mmstorediagnostic::mappedError(static_cast<std::uint32_t>(error.code()) + 1,
      error.nativeStatus() ? error.nativeStatus() : observedWin32);
    const char* wireCode = "HELPER_INTEGRITY_INVALID";
    if (error.code() == mmstore::ErrorCode::invalidInput) wireCode = "BAD_REQUEST";
    if (error.code() == mmstore::ErrorCode::unsupportedHost) wireCode = "UNSUPPORTED_HOST";
    if (error.code() == mmstore::ErrorCode::standardLogonRequired) wireCode = "INTERACTIVE_SESSION_REQUIRED";
    throw Failure(wireCode, diagnostic);
  }
}
