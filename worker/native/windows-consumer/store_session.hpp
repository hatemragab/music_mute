#pragma once
// Included by launcher.cpp after the existing native library. No caller-selected
// code/config path, private runtime shim, receipt, shell or GUI-owned Job can
// create this independent Store Session authority.
#include "store_role.hpp"
#include "store_namespace.hpp"
#include "store_child.hpp"
#include "store_fleet_attempt.hpp"

namespace mmstorerole {
class StoreSessionCreator final {
 public:
  StoreSessionCreator(const StoreSessionCreator&) = delete;
  StoreSessionCreator& operator=(const StoreSessionCreator&) = delete;
  ~StoreSessionCreator() {
    ending_ = true;
    if (endingEvent_.valid()) (void)SetEvent(endingEvent_.value);
    if (publishedEvent_.valid()) (void)ResetEvent(publishedEvent_.value);
    if (windowThread_.joinable()) {
      (void)PostThreadMessageW(windowThreadId_, WM_QUIT, 0, 0);
      windowThread_.join();
    }
    terminateOwned(); if (issuer_) issuer_->close(); (void)retireOwned();
    StoreRoleIssuer::active_ = nullptr;
    active_ = nullptr;
  }
  static int run() noexcept {
    try {
      auto creator = open(); creator->startWindow(); creator->launch(Role::session);
      auto& node = creator->owned_.at(Role::session);
      HANDLE watched[]{creator->endingEvent_.value, node.process.value};
      const auto ended = WaitForMultipleObjects(2, watched, FALSE, INFINITE);
      if (ended != WAIT_OBJECT_0 && ended != WAIT_OBJECT_0 + 1) return 2;
      DWORD nodeExit = 2; const bool sessionExit = ended == WAIT_OBJECT_0 + 1;
      if (sessionExit && GetExitCodeProcess(node.process.value, &nodeExit) == FALSE) return 2;
      creator->ending_ = true; (void)SetEvent(creator->endingEvent_.value);
      if (creator->publishedEvent_.valid() && ResetEvent(creator->publishedEvent_.value) == FALSE) return 2;
      creator->terminateOwned(); creator->issuer_->close();
      return creator->retireOwned() && (!sessionExit || nodeExit == 0) ? 0 : 2;
    } catch (...) { return 2; }
  }
 private:
  struct PrepareRequest {
    Json request, launch = nullptr, nativeOwner = nullptr, raw = nullptr; std::string failure;
    mmstore::ProcessIdentity gui; ::Handle guiProcess, node; std::atomic<bool> cleanup{false}; bool cancelled = false, issued = false,benchmarkMode=false;
  };
  struct CpuPrepareRequest : PrepareRequest {
    Json wireRequest;
    Json expectation = nullptr, summary = nullptr;
    ::Handle ready, start, result;
    std::string reportToken;
    bool started = false, resourcesClosed = false;
    std::atomic<std::size_t> waits{0};
  };
  struct NodeOwner {
    ::Handle job, process, guardian; std::string nonce; Json identity;
    ::Handle startupInput, startupWriter, startupOutput, startupThread;
    StoreJobGuardianStartup guardianStartup;
    PrepareRequest* preparing = nullptr;
    bool resumed = false, issuerRetired = false, treeRetired = false, jobRetired = false, jobCreated = false;
    std::optional<OwnedGpuGuard> gpu; std::string gpuLuid; std::map<std::string, std::string> releasedGpu;
    bool cpuMode = false;
  };
  struct ControlRequest {
    std::string id, token, payload, response;
    Role target, sourceRole; bool gui = false; mmstore::ProcessIdentity source, peer, targetNode, receiver;
    ::Handle sourceProcess, targetProcess, targetJob, receiverProcess, ready;
    std::shared_ptr<StoreRoleIssuer::GuiClient> guiClient;
    Json targetOwner; bool targetExpected = false, delivered = false, complete = false;
  };
  struct ChildRequest { std::string relative; std::shared_ptr<StoreEngineChild> child; bool started = false, stopped = false; std::optional<FixedToolKind> tool; std::string configurationSha256; bool qualification = false; std::string operationToken; std::vector<BYTE> fleetInput; std::optional<mmstore::ProcessIdentity> fleetWriter; };
  struct TransferRequest {
    Json tuple;std::string ownerNonce,workspaceToken;std::shared_ptr<StoreEngineChild> child;bool started=false,stopped=false;
  };
  struct CpuOperation {
    Json expectation; std::string configToken, ownerNonce, requestId, configurationSha256, operation;
    Role role; bool admitted = false, retired = false;
    ::Handle metadataProcess; std::optional<mmstore::ProcessIdentity> metadata;
    Json configuration = nullptr;
  };
#include "store_benchmark_creator.hpp"
  StoreSessionCreator(std::unique_ptr<StoreRoleIssuer> issuer, mmstorenamespace::PrivateNamespaceAuthority data)
    : issuer_(std::move(issuer)), data_(std::move(data)), endingEvent_(CreateEventW(nullptr, TRUE, FALSE, nullptr)),
      windowReady_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    require(endingEvent_.valid() && windowReady_.valid(), ErrorCode::processDenied);
  }
  static std::unique_ptr<StoreSessionCreator> open() {
    require(!active_ && !StoreRoleIssuer::active_, ErrorCode::processDenied);
    auto issuer = StoreRoleIssuer::open();
    auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker);
    require(package.observation().fullName == issuer->self_.observation().fullName, ErrorCode::processDenied);
    auto data = mmstorenamespace::PrivateNamespaceAuthority::open(package);
    auto creator = std::unique_ptr<StoreSessionCreator>(new StoreSessionCreator(std::move(issuer), std::move(data)));
    creator->issuer_->gui_ = [actual = creator.get()](std::shared_ptr<StoreRoleIssuer::GuiClient> client, const Json& command) { return actual->dispatchGui(std::move(client), command); };
    creator->issuer_->broker_ = [actual = creator.get()](Role actor, BrokerCommand command, const Json& args,
        const mmstore::ProcessIdentity& source, HANDLE process) {
      return actual->dispatchBroker(actor, command, args, source, process);
    };
    active_ = creator.get(); StoreRoleIssuer::active_ = creator->issuer_.get(); return creator;
  }
  static std::wstring filteredEnvironment(const mmstoreruntime::FixedLaunchPlan& plan) {
    std::vector<wchar_t> buffer(32768); const auto count = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
    require(count > 0 && count < buffer.size(), ErrorCode::processDenied); const std::wstring windows(buffer.data(), count);
    require(mmstore::validInstalledLocation(windows), ErrorCode::processDenied);
    ConsumerEnvironmentEntries entries;
    const auto executable = plan.executablePath();
    entries.emplace(L"PATH", executable.substr(0, executable.find_last_of(L'\\')) + L";" + windows + L"\\System32");
    entries.emplace(L"SystemRoot", windows); entries.emplace(L"WINDIR", windows);
    // Data locations come from the existing native known-folder/owner policy;
    // NODE_OPTIONS, NODE_PATH, Python paths and shell/startup injection are absent.
    const auto personal = rootPath("personal");
    entries.emplace(L"LOCALAPPDATA", personal.substr(0, personal.find_last_of(L'\\')));
    return encodeConsumerEnvironment(entries);
  }
  static Json ownerRecord(Role role, const NodeOwner& owner) {
    return Json::Object{{"role", std::string(roleName(role))}, {"nonce", owner.nonce}, {"identity", owner.identity}};
  }
  static bool ownerMatches(Role role, const NodeOwner& held, const Json& value) {
    return value.at("role").string() == roleName(role) && sameSecret(value.at("nonce").string(), held.nonce) &&
      mm::dump(value.at("identity")) == mm::dump(held.identity);
  }
  void retireRole(Role role, NodeOwner& owner) {
    require(processingRole(role) && retired_.size() < 4096 && retire(owner), ErrorCode::processDenied);
    // Job zero and the independent guardian's actual successful exit precede
    // issuer-table retirement. Failed cleanup retains the role and blocks reuse.
    for (auto& [incarnation, request] : children_) { (void)incarnation; if (request.child->ownerNonce_ == owner.nonce && !request.stopped) { request.child->stop(); request.stopped = true; } }
    for(auto& [incarnation,transfer]:transfers_){(void)incarnation;if(sameSecret(transfer.ownerNonce,owner.nonce) && !transfer.stopped){require(transfer.child!=nullptr,ErrorCode::processDenied);transfer.child->stop();transfer.stopped=true;}}
    for(auto& [id,attempt]:fleetAttempts_){(void)id;if(sameSecret(attempt->ownerNonce_,owner.nonce)){require(fleetAttemptQuiescent(*attempt),ErrorCode::processDenied);attempt->retire();}}
    // Keep the original issuer table while bounded child/file cleanup can
    // fail. A retry must reach those exact retained owners before retirement.
    for (auto& [incarnation, operation] : cpuOperations_) { (void)incarnation; if (sameSecret(operation.ownerNonce, owner.nonce)) retireCpuOperation(operation); }
    if (!owner.issuerRetired) { issuer_->retireNode(role, owner.nonce); owner.issuerRetired = true; }
    closeStoreJobGuardianStartup(owner.guardianStartup);
    for (auto* handle : {&owner.startupInput, &owner.startupWriter, &owner.startupOutput, &owner.startupThread, &owner.guardian, &owner.process, &owner.job}) mmstorechild::closeOwned(handle->value);
    if (owner.gpu) for (auto* handle : {&owner.gpu->keeper, &owner.gpu->release, &owner.gpu->job}) mmstorechild::closeOwned(handle->value);
    retired_.emplace(owner.nonce, ownerRecord(role, owner)); owned_.erase(role);
  }
  Json dispatchBroker(Role actor, BrokerCommand command, const Json& args, const mmstore::ProcessIdentity& source, HANDLE process) {
    require(brokerOperation(actor, command, args), ErrorCode::processDenied);
    if (actor == Role::prepare) {
      std::lock_guard lock(lifetimeMutex_); const auto owner = owned_.find(actor);
      require(owner != owned_.end(), ErrorCode::processDenied);
      if (owner->second.cpuMode) require(command != BrokerCommand::prepareRequest && command != BrokerCommand::prepareResult &&
        command != BrokerCommand::qualificationStart && command != BrokerCommand::qualificationRead && command != BrokerCommand::qualificationStop &&
        command != BrokerCommand::benchmarkRequest && command != BrokerCommand::benchmarkStart && command != BrokerCommand::benchmarkRead && command != BrokerCommand::benchmarkStop && command != BrokerCommand::benchmarkResult &&
        command != BrokerCommand::gpuAcquire && command != BrokerCommand::gpuInspect && command != BrokerCommand::gpuRelease, ErrorCode::processDenied);
    }
    if(command==BrokerCommand::benchmarkRequest || command==BrokerCommand::benchmarkStart || command==BrokerCommand::benchmarkRead || command==BrokerCommand::benchmarkStop || command==BrokerCommand::benchmarkResult)return dispatchBenchmark(actor,command,args);
    if(command==BrokerCommand::fleetWorkspaceOpen || command==BrokerCommand::fleetWorkspaceRecover || command==BrokerCommand::fleetWorkspaceInspect || command==BrokerCommand::fleetWorkspaceRetire) return dispatchFleetWorkspace(actor,command,args);
    if(command==BrokerCommand::transferStart || command==BrokerCommand::transferWrite || command==BrokerCommand::transferRead || command==BrokerCommand::transferStop || command==BrokerCommand::transferInspect) return dispatchTransfer(actor,command,args);
    if (command == BrokerCommand::cpuPrepareRequest || command == BrokerCommand::cpuPrepareReady || command == BrokerCommand::cpuPrepareStart || command == BrokerCommand::cpuPrepareResult)
      return dispatchCpuPreparation(actor, command, args);
    if (command == BrokerCommand::controlRequest || command == BrokerCommand::controlAccept || command == BrokerCommand::controlReply || command == BrokerCommand::controlAck || command == BrokerCommand::controlPeer)
      return dispatchControl(actor, command, args, source, process);
    if (command == BrokerCommand::childStart || command == BrokerCommand::childRead || command == BrokerCommand::childWrite || command == BrokerCommand::childStop)
      return dispatchChild(actor, command, args, source);
    if (command == BrokerCommand::toolStart || command == BrokerCommand::toolRead || command == BrokerCommand::toolStop) return dispatchTool(actor, command, args);
    if (command == BrokerCommand::cpuOpen || command == BrokerCommand::cpuRecover || command == BrokerCommand::cpuBindData || command == BrokerCommand::cpuInspect || command == BrokerCommand::cpuRetire || command == BrokerCommand::cpuForget || command == BrokerCommand::cpuRelease) return dispatchCpuOperation(actor, command, args, source, process);
    if (command == BrokerCommand::qualificationStart || command == BrokerCommand::qualificationRead || command == BrokerCommand::qualificationStop) return dispatchQualification(actor, command, args);
    if (command == BrokerCommand::launch) return launch(parseRole(args.at("role").string()));
    std::lock_guard lock(lifetimeMutex_);
    require(!ending_, ErrorCode::processDenied); issuer_->self_.revalidate(); data_.revalidate();
    if (command == BrokerCommand::gpuAdmit) {
      const auto owner = owned_.find(actor); require(owner != owned_.end() && !owner->second.cpuMode &&
        WaitForSingleObject(owner->second.process.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
      detail::requireKillJob(owner->second.job.value); detail::requireMember(owner->second.process.value, owner->second.job.value);
      return Json::Object{{"admitted", true}};
    }
    if (command == BrokerCommand::sessionPublish) { publishSession(source, process); return Json::Object{{"published", true}}; }
    if (command == BrokerCommand::sessionRetire) {
      // Control publication belongs to this original singleton helper. It is
      // withdrawn before the SDK releases that helper's SID mutex. Ordinary
      // maintenance drains use role-stop and keep the control Session alive.
      require(!publisher_ || mmstore::detail::sameIdentity(*publisher_, source), ErrorCode::processDenied);
      require(!publishedEvent_.valid() || ResetEvent(publishedEvent_.value), ErrorCode::processDenied); published_ = false;
      retireChildren(); return Json::Object{{"cleanup", "confirmed"}};
    }
    if (command == BrokerCommand::prepareRequest || command == BrokerCommand::prepareResult) {
      const auto role = owned_.find(Role::prepare); require(role != owned_.end(), ErrorCode::processDenied);
      const auto found = std::find_if(preparing_.begin(), preparing_.end(), [&](const auto& entry) { return !entry.second->cleanup && !std::holds_alternative<std::nullptr_t>(entry.second->nativeOwner.value) && ownerMatches(Role::prepare, role->second, entry.second->nativeOwner); });
      require(found != preparing_.end(), ErrorCode::processDenied); auto& request = *found->second;
      if (command == BrokerCommand::prepareRequest) return request.request;
      require(args.at("requestId").string() == found->first && std::holds_alternative<std::nullptr_t>(request.raw.value) && request.failure.empty(), ErrorCode::processDenied);
      require(std::none_of(children_.begin(), children_.end(), [&](const auto& item) { return sameSecret(item.second.child->ownerNonce_, role->second.nonce) && !item.second.stopped; }), ErrorCode::processDenied);
      if (args.object().contains("errorCode")) { request.failure = args.at("errorCode").string(); return Json::Object{{"accepted", true}}; }
      if (request.request.at("operation").string() == "qualify") require(role->second.gpu &&
        WaitForSingleObject(role->second.gpu->keeper.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(role->second.gpu->release.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
      request.raw = readPreparationResult(found->first, args.at("rawSha256").string(), static_cast<std::uint64_t>(args.at("rawBytes").integer()));
      return Json::Object{{"accepted", true}};
    }
    if (command == BrokerCommand::gpuAcquire || command == BrokerCommand::gpuRelease || command == BrokerCommand::gpuInspect) return gpuBroker(actor, command, args);
    if (command == BrokerCommand::cleanupState) return cleanupState(args.at("owner"));
    const auto& requested = args.at("owner"); const auto role = parseRole(requested.at("role").string());
    const auto found = owned_.find(role);
    if (found == owned_.end() || !ownerMatches(role, found->second, requested)) {
      const auto prior = retired_.find(requested.at("nonce").string());
      require(prior != retired_.end() && mm::dump(prior->second) == mm::dump(requested), ErrorCode::processDenied);
      require(command != BrokerCommand::stop, ErrorCode::processDenied);
      return command == BrokerCommand::inspect ? Json(Json::Object{{"exited", true}}) : Json(Json::Object{{"owned", false}});
    }
    auto& held = found->second;
    if (command == BrokerCommand::stop) { retireRole(role, held); return Json::Object{{"stopped", true}, {"cleanup", "confirmed"}}; }
    if (command == BrokerCommand::inspect) {
      if (held.treeRetired) { retireRole(role, held); return Json::Object{{"exited", true}}; }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
      require(QueryInformationJobObject(held.job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr) != FALSE, ErrorCode::processDenied);
      if (state.ActiveProcesses != 0) return Json::Object{{"exited", false}};
      retireRole(role, held); return Json::Object{{"exited", true}};
    }
    const auto& expected = args.at("identity");
    const auto peerPid = pid(expected.at("pid"));
    if (expected.at("sid").string() != detail::ascii(issuer_->creator().sid) ||
        expected.at("session_id").integer() != issuer_->creator().sessionId) return Json::Object{{"owned", false}};
    std::lock_guard issuerLock(issuer_->mutex_);
    const auto node = issuer_->nodes_.find(role); require(node != issuer_->nodes_.end(), ErrorCode::processDenied);
    node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity();
    if (peerPid == node->second.process.identity().pid) {
      detail::requireMember(node->second.process.handle(), held.job.value);
      return Json::Object{{"owned", expected.at("creation_time").string() == detail::ascii(node->second.process.identity().creationTime)}};
    }
    const auto helper = issuer_->helpers_.find(peerPid);
    if (helper == issuer_->helpers_.end() || !helper->second.bound || helper->second.node != node->second.process.identity().pid)
      return Json::Object{{"owned", false}};
    helper->second.process.revalidate(); detail::requireMember(helper->second.process.handle(), held.job.value);
    return Json::Object{{"owned", expected.at("creation_time").string() == detail::ascii(helper->second.process.identity().creationTime)}};
  }
  Json cleanupState(const Json& expected) {
    // Called only after the actor's actual bound helper/Node/Job admission. The
    // requested owner is an expectation; only this Creator's private tables
    // can establish retirement or tool-free state.
    issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
    const auto prior = retired_.find(expected.at("nonce").string());
    if (prior != retired_.end()) {
      require(mm::dump(prior->second) == mm::dump(expected), ErrorCode::processDenied);
      return Json::Object{{"retired", true}, {"tool_free", false}};
    }
    const auto owned = owned_.find(Role::personal);
    require(owned != owned_.end() && ownerMatches(Role::personal, owned->second, expected), ErrorCode::processDenied);
    auto& role = owned->second;
    for (const auto& [incarnation, child] : children_) {
      (void)incarnation;
      if (sameSecret(child.child->ownerNonce_, role.nonce) && !child.stopped)
        return Json::Object{{"retired", false}, {"tool_free", false}};
    }
    std::lock_guard issuerLock(issuer_->mutex_);
    const auto node = issuer_->nodes_.find(Role::personal);
    require(node != issuer_->nodes_.end() && node->second.bound && sameSecret(node->second.ownershipNonce, role.nonce) &&
      mm::dump(StoreRoleIssuer::wireIdentity(node->second.process.identity())) == mm::dump(role.identity) &&
      CompareObjectHandles(node->second.job.get(), role.job.value), ErrorCode::processDenied);
    node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity(); detail::requireKillJob(role.job.value);
    detail::requireMember(node->second.process.handle(), role.job.value); detail::requireMember(issuer_->self_.handle(), role.job.value, false);
    std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 64 * sizeof(ULONG_PTR));
    auto* census = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
    require(QueryInformationJobObject(role.job.value, JobObjectBasicProcessIdList, census, static_cast<DWORD>(bytes.size()), nullptr) &&
      census->NumberOfAssignedProcesses == census->NumberOfProcessIdsInList && census->NumberOfProcessIdsInList <= 64, ErrorCode::processDenied);
    bool nodeSeen = false; std::set<DWORD> seen;
    for (DWORD index = 0; index < census->NumberOfProcessIdsInList; ++index) {
      require(census->ProcessIdList[index] >= 1 && census->ProcessIdList[index] <= 2147483647, ErrorCode::processDenied);
      const auto member = static_cast<DWORD>(census->ProcessIdList[index]); require(seen.insert(member).second, ErrorCode::processDenied);
      if (member == node->second.process.identity().pid) { nodeSeen = true; continue; }
      const auto helper = issuer_->helpers_.find(member);
      if (helper == issuer_->helpers_.end() || !helper->second.bound || helper->second.node != node->second.process.identity().pid)
        return Json::Object{{"retired", false}, {"tool_free", false}};
      helper->second.process.revalidate(); detail::requireMember(helper->second.process.handle(), role.job.value);
    }
    require(nodeSeen, ErrorCode::processDenied);
    node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity(); issuer_->code_.revalidateOperationIdentity(); data_.revalidate();
    return Json::Object{{"retired", false}, {"tool_free", true}};
  }
  Json childStartReply(const ChildRequest& request) {
    return Json::Object{{"token", request.child->token_}, {"started", request.started}, {"guardian", request.started ? StoreRoleIssuer::wireIdentity(request.child->identity_) : Json(nullptr)}};
  }
  void validateFleetNode(NodeOwner& owner,bool cleanupOnly) {
    if(cleanupOnly)issuer_->code_.revalidateCleanupIdentity();else issuer_->code_.revalidateOperationIdentity();issuer_->self_.revalidate();data_.revalidate();
    std::lock_guard lock(issuer_->mutex_);const auto node=issuer_->nodes_.find(Role::fleet);require(node!=issuer_->nodes_.end() && node->second.bound &&
      sameSecret(node->second.ownershipNonce,owner.nonce) && CompareObjectHandles(node->second.job.get(),owner.job.value),ErrorCode::processDenied);
    node->second.process.revalidate();if(cleanupOnly)node->second.plan.revalidateCleanupIdentity();else node->second.plan.revalidateOperationIdentity();
    detail::requireKillJob(owner.job.value);detail::requireMember(node->second.process.handle(),owner.job.value);detail::requireMember(issuer_->self_.handle(),owner.job.value,false);
  }
  bool fleetAttemptQuiescent(StoreFleetAttemptDirectory& row) {
    for(const auto& [incarnation,transfer]:transfers_){(void)incarnation;if(sameSecret(transfer.workspaceToken,row.token_) && !transfer.stopped)return false;}
    if(!row.processingRequest_.empty()) {
      const auto found=children_.find(row.processingIncarnation_);require(found!=children_.end() && sameSecret(found->second.child->ownerNonce_,row.ownerNonce_),ErrorCode::processDenied);
      if(!found->second.stopped && !found->second.child->completedFleetRequest(row.processingRequest_))return false;
      mmstorechild::closeOwned(row.processingInput_.value);
      if(!found->second.stopped)found->second.child->forgetCompletedFleetRequest(row.processingRequest_);
      row.processingRequest_.clear();row.processingIncarnation_.clear();
    }
    return true;
  }
  Json dispatchFleetWorkspace(Role actor,BrokerCommand command,const Json& args) {
    std::lock_guard lock(lifetimeMutex_);require(!ending_ && actor==Role::fleet,ErrorCode::processDenied);const auto owner=owned_.find(actor);require(owner!=owned_.end(),ErrorCode::processDenied);
    const bool cleanupOnly=command!=BrokerCommand::fleetWorkspaceOpen;validateFleetNode(owner->second,cleanupOnly);
    if(command==BrokerCommand::fleetWorkspaceOpen || command==BrokerCommand::fleetWorkspaceRecover) {
      const auto id=args.at("attempt_id").string(),extension=args.at("extension").string();auto found=fleetAttempts_.find(id);
      if(found!=fleetAttempts_.end()) {auto& row=*found->second;require(row.extension_==extension && sameSecret(row.ownerNonce_,owner->second.nonce) && mm::dump(row.nodeOwner_)==mm::dump(publicOwner(ownerRecord(actor,owner->second))),ErrorCode::processDenied);
        if(command==BrokerCommand::fleetWorkspaceRecover){require(fleetAttemptQuiescent(row),ErrorCode::processDenied);row.retire();return Json::Object{{"quiescent",true},{"retired",true}};}
        return row.reply();
      }
      require(command==BrokerCommand::fleetWorkspaceOpen && fleetAttempts_.size()<4096,ErrorCode::processDenied);
      auto row=std::shared_ptr<StoreFleetAttemptDirectory>(new StoreFleetAttemptDirectory(id,extension,owner->second.nonce,publicOwner(ownerRecord(actor,owner->second)),issuer_->code_.inventorySha256(),issuer_->code_.runtimeManifestPin().sha256));
      fleetAttempts_.emplace(id,row);row->open();validateFleetNode(owner->second,false);return row->reply();
    }
    const auto& expected=args.at("expectation");const auto found=fleetAttempts_.find(expected.at("attemptId").string());require(found!=fleetAttempts_.end(),ErrorCode::processDenied);auto& row=*found->second;
    require(sameSecret(row.ownerNonce_,owner->second.nonce) && mm::dump(row.expectation())==mm::dump(expected),ErrorCode::processDenied);
    const auto quiescent=fleetAttemptQuiescent(row);
    if(command==BrokerCommand::fleetWorkspaceRetire){require(quiescent,ErrorCode::processDenied);row.retire();}
    return Json::Object{{"quiescent",quiescent},{"retired",row.retired_}};
  }
  Json dispatchTransfer(Role actor,BrokerCommand command,const Json& args) {
    std::shared_ptr<StoreEngineChild> child;
    {std::lock_guard lock(lifetimeMutex_);require(!ending_ && actor==Role::fleet,ErrorCode::processDenied);const auto owner=owned_.find(actor);require(owner!=owned_.end(),ErrorCode::processDenied);auto& held=owner->second;
      const bool cleanupOnly=command==BrokerCommand::transferStop || command==BrokerCommand::transferInspect;validateFleetNode(held,cleanupOnly);
      if(command==BrokerCommand::transferStart || (command==BrokerCommand::transferStop && args.object().contains("incarnation"))) {
        const auto incarnation=args.at("incarnation").string(),id=args.at("attempt_id").string(),workspaceToken=args.at("workspace_token").string();
        const auto attempt=fleetAttempts_.find(id);require(attempt!=fleetAttempts_.end() && sameSecret(attempt->second->token_,workspaceToken) && sameSecret(attempt->second->ownerNonce_,held.nonce),ErrorCode::processDenied);auto& workspace=*attempt->second;
        const auto expected="work\\"+id+"\\"+(args.at("operation").string()=="download"?"input."+workspace.extension_:"output\\vocals.mp3");require(args.at("relative_path").string()==expected,ErrorCode::processDenied);
        auto existing=transfers_.find(incarnation);
        if(existing!=transfers_.end()) {auto& row=existing->second;require(mm::dump(row.tuple)==mm::dump(args) && sameSecret(row.ownerNonce,held.nonce) && sameSecret(row.workspaceToken,workspaceToken),ErrorCode::processDenied);
          if(command==BrokerCommand::transferStop){if(!row.stopped){require(row.child!=nullptr,ErrorCode::processDenied);row.child->stop();row.stopped=true;}return Json::Object{{"job","confirmed"},{"stopped",true}};}
          require(!row.stopped && row.child,ErrorCode::processDenied);return Json::Object{{"token",row.child->token_},{"started",row.started},{"process",row.started?StoreRoleIssuer::wireIdentity(row.child->identity_):Json(nullptr)}};
        }
        require(transfers_.size()<4096,ErrorCode::processDenied);
        if(command==BrokerCommand::transferStop){transfers_.emplace(incarnation,TransferRequest{args,held.nonce,workspaceToken,{},false,true});return Json::Object{{"job","confirmed"},{"stopped",true}};}
        require(workspace.admitted_ && !workspace.retired_ && fleetAttemptQuiescent(workspace),ErrorCode::processDenied);StoreFleetAttemptDirectory::validate(workspace.directory_);
        std::lock_guard issuerLock(issuer_->mutex_);const auto node=issuer_->nodes_.find(actor);require(node!=issuer_->nodes_.end() && node->second.bound,ErrorCode::processDenied);
        auto created=std::shared_ptr<StoreEngineChild>(new StoreEngineChild(issuer_->code_,issuer_->code_.heldLaunchPlan(mmstoreruntime::LaunchKind::fleetTransfer),node->second.process.identity(),held.nonce));
        auto& row=transfers_.emplace(incarnation,TransferRequest{args,held.nonce,workspaceToken,std::move(created),false,false}).first->second;
        const auto upload=args.at("operation").string()=="upload";HANDLE parent=workspace.directory_.handle.value;
        if(upload){const auto output=workspace.entries_.find(workspace.root_+L"\\output");require(output!=workspace.entries_.end(),ErrorCode::pathDenied);StoreFleetAttemptDirectory::validate(*output->second);parent=output->second->handle.value;}
        row.child->startTransfer(workspace.root_,args.at("operation").string(),id,incarnation,workspace.root_+L"\\"+(upload?L"output\\vocals.mp3":L"input."+wide(workspace.extension_)),parent,held.job.value,node->second.process,node->second.plan);row.started=true;
        return Json::Object{{"token",row.child->token_},{"started",true},{"process",StoreRoleIssuer::wireIdentity(row.child->identity_)}};
      }
      const auto found=std::find_if(transfers_.begin(),transfers_.end(),[&](const auto& row){return row.second.child && sameSecret(row.second.child->token_,args.at("token").string()) && sameSecret(row.second.ownerNonce,held.nonce);});require(found!=transfers_.end(),ErrorCode::processDenied);auto& row=found->second;child=row.child;
      if(command==BrokerCommand::transferStop){if(!row.stopped){child->stop();row.stopped=true;}return Json::Object{{"job","confirmed"},{"stopped",true}};}
      if(command==BrokerCommand::transferInspect)return Json::Object{{"retired",row.stopped}};
      require(row.started && !row.stopped,ErrorCode::processDenied);std::lock_guard issuerLock(issuer_->mutex_);const auto node=issuer_->nodes_.find(actor);require(node!=issuer_->nodes_.end() && node->second.bound,ErrorCode::processDenied);child->revalidate(held.job.value,node->second.process,node->second.plan);
    }
    return command==BrokerCommand::transferRead?child->readTool():child->writeTransfer(args);
  }
  void bindFleetProcessing(ChildRequest& request,const std::string& incarnation,const Json& args,NodeOwner& owner,const mmstore::ProcessIdentity& source) {
    if(request.fleetWriter)require(mmstore::detail::sameIdentity(*request.fleetWriter,source),ErrorCode::processDenied);else request.fleetWriter=source;
    const auto bytes=base64Decode(args.at("bytes_base64").string(),24576);require(request.fleetInput.size()+bytes.size()<=65540,ErrorCode::processDenied);request.fleetInput.insert(request.fleetInput.end(),bytes.begin(),bytes.end());
    if(request.fleetInput.size()<4)return;
    const auto& buffer=request.fleetInput;const std::uint32_t size=(static_cast<std::uint32_t>(buffer[0])<<24)|(static_cast<std::uint32_t>(buffer[1])<<16)|(static_cast<std::uint32_t>(buffer[2])<<8)|buffer[3];
    require(size>0 && size<=65536 && buffer.size()<=size+4,ErrorCode::processDenied);if(buffer.size()<size+4)return;
    const auto value=mm::JsonParser(std::string(buffer.begin()+4,buffer.end()),true).parse();require(data_policy::fields(value,{"protocolVersion","type","command","requestId","incarnation","sentAt","payload"}) &&
      value.at("protocolVersion").integer()==1 && value.at("type").string()=="request" && value.at("incarnation").string()==incarnation && data_policy::uuid(value.at("requestId").string()),ErrorCode::processDenied);
    const auto command=value.at("command").string();require(command=="process" || command=="ping",ErrorCode::processDenied);
    if(command=="process") {
      const auto& payload=value.at("payload");require(data_policy::fields(payload,{"attemptId","attemptDirectory","input","modelCacheRoot","provider","directmlDeviceId","ffmpegPath","ffprobePath","recipe"}),ErrorCode::processDenied);
      const auto found=fleetAttempts_.find(payload.at("attemptId").string());require(found!=fleetAttempts_.end(),ErrorCode::processDenied);auto& attempt=*found->second;
      require(attempt.admitted_ && !attempt.retired_ && sameSecret(attempt.ownerNonce_,owner.nonce) && fleetAttemptQuiescent(attempt) && payload.at("attemptDirectory").string()==utf8(attempt.root_) &&
        payload.at("modelCacheRoot").string()==utf8(rootPath("personal")+L"\\models") && payload.at("provider").string()=="directml" && owner.gpu && payload.at("directmlDeviceId").integer()==owner.gpu->gpu.at("deviceIndex").integer() &&
        payload.at("ffmpegPath").string()==utf8(request.child->engine_.mediaRoot()+L"\\ffmpeg.exe") && payload.at("ffprobePath").string()==utf8(request.child->engine_.mediaRoot()+L"\\ffprobe.exe"),ErrorCode::processDenied);
      const auto& input=payload.at("input");require(data_policy::fields(input,{"path","bytes","sha256"}) && input.at("path").string()==utf8(attempt.root_+L"\\input."+wide(attempt.extension_)) && data_policy::integer(input.at("bytes"),1,1000000000),ErrorCode::processDenied);
      const auto inputDigest=fleetInputDigestHex(input.at("sha256").string());
      attempt.processingIncarnation_=incarnation;attempt.processingRequest_=value.at("requestId").string();
      request.child->registerFleetRequest(attempt.processingRequest_);
      const auto opened=openNativeChild(attempt.directory_.handle.value,L"input."+wide(attempt.extension_),GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open,nullptr,false,&attempt.processingInput_);
      require(opened.status==0 && attempt.processingInput_.valid(),ErrorCode::pathDenied);assertPrivateHandle(attempt.processingInput_.value);attempt.processingBirth_=cacheHandleBirth(attempt.processingInput_.value);
      const auto info=cacheHandleIdentity(attempt.processingInput_.value,false);require(info.at("bytes").integer()==input.at("bytes").integer() && hashFile(attempt.processingInput_.value,1000000000)==inputDigest,ErrorCode::digestMismatch);
    } else require(data_policy::fields(value.at("payload"),{}),ErrorCode::processDenied);
    std::fill(request.fleetInput.begin(),request.fleetInput.end(),BYTE{});request.fleetInput.clear();request.fleetWriter.reset();
  }
  Json dispatchChild(Role actor, BrokerCommand command, const Json& args,const mmstore::ProcessIdentity& source) {
    std::shared_ptr<StoreEngineChild> child;std::unique_lock<std::mutex> writeOrder;
    if(actor==Role::fleet && command==BrokerCommand::childWrite){
      {std::lock_guard lock(lifetimeMutex_);const auto owner=owned_.find(actor);require(owner!=owned_.end(),ErrorCode::processDenied);const auto found=std::find_if(children_.begin(),children_.end(),[&](const auto& row){return sameSecret(row.second.child->token_,args.at("token").string()) && sameSecret(row.second.child->ownerNonce_,owner->second.nonce);});require(found!=children_.end(),ErrorCode::processDenied);child=found->second.child;}
      writeOrder=std::unique_lock<std::mutex>(child->brokerWriteMutex_);
    }
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && (actor == Role::personal || actor == Role::fleet), ErrorCode::processDenied);
      const auto owner = owned_.find(actor); require(owner != owned_.end(), ErrorCode::processDenied); auto& owned = owner->second;
      if(command==BrokerCommand::childStop && args.object().contains("incarnation")) {
        const auto incarnation=args.at("incarnation").string(),relative=args.at("config_relative").string();
        const auto prior=children_.find(incarnation);
        if(prior!=children_.end()){auto& request=prior->second;require(!request.tool && !request.qualification && !request.child->benchmark_ && request.relative==relative && sameSecret(request.child->ownerNonce_,owned.nonce),ErrorCode::processDenied);if(!request.stopped){request.child->stop();request.stopped=true;}}
        else rememberUnissuedFixed(incarnation,owned.nonce,std::string("engine-")+std::string(roleName(actor)),args);
        return Json::Object{{"job","confirmed"},{"stopped",true}};
      }
      if (command == BrokerCommand::childStart) {
        const auto incarnation = args.at("incarnation").string(), relative = args.at("config_relative").string();
        require(!closedFixedStarts_.contains(incarnation),ErrorCode::processDenied);
        const auto existing = children_.find(incarnation);
        if (existing != children_.end()) {
          require(!existing->second.tool && !existing->second.stopped && existing->second.relative == relative && sameSecret(existing->second.child->ownerNonce_, owned.nonce) &&
            mmstore::detail::sameIdentity(existing->second.child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
          return childStartReply(existing->second);
        }
        const auto activeEngines = std::count_if(children_.begin(), children_.end(), [&](const auto& item) { return !item.second.tool && !item.second.stopped && sameSecret(item.second.child->ownerNonce_, owned.nonce); });
        require(children_.size() < 4096 && activeEngines < (actor == Role::fleet ? 2 : 1), ErrorCode::processDenied);
        require(owned.gpu && owned.gpu->keeper.valid() && WaitForSingleObject(owned.gpu->keeper.value, 0) == WAIT_TIMEOUT &&
          owned.gpu->release.valid() && WaitForSingleObject(owned.gpu->release.value, 0) == WAIT_TIMEOUT && !owned.gpu->abandoned,
          ErrorCode::processDenied);
        std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(actor); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
        node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity(); detail::requireMember(node->second.process.handle(), owned.job.value);
        auto created = std::shared_ptr<StoreEngineChild>(new StoreEngineChild(issuer_->code_, issuer_->code_.heldLaunchPlan(mmstoreruntime::LaunchKind::pythonGuardian),
          issuer_->code_.heldLaunchPlan(actor == Role::fleet ? mmstoreruntime::LaunchKind::fleetEngine : mmstoreruntime::LaunchKind::personalEngine), node->second.process.identity(), owned.nonce));
        auto& request = children_.emplace(incarnation, ChildRequest{relative, std::move(created), false, false, std::nullopt, {}, false, {}}).first->second;
        // Keep the exact private owner before config/pipe/spawn/resume can
        // fail; a repeated original incarnation recovers cleanup only.
        request.child->retainGpuKeeper(owned.gpu->keeper.value, owned.gpu->release.value);
        request.child->start(relative, incarnation, owned.job.value, node->second.process, node->second.plan, owned.gpu->gpu);
        request.started = true; return childStartReply(request);
      }
      const auto found = std::find_if(children_.begin(), children_.end(), [&](const auto& item) { return !item.second.tool && sameSecret(item.second.child->token_, args.at("token").string()) && sameSecret(item.second.child->ownerNonce_, owned.nonce); });
      require(found != children_.end(), ErrorCode::processDenied); auto& request = found->second; child = request.child;
      require(mmstore::detail::sameIdentity(child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
      if (command == BrokerCommand::childStop) {
        if (!request.stopped) { child->stop(); request.stopped = true; }
        return Json::Object{{"job", "confirmed"}, {"stopped", true}};
      }
      require(request.started && !request.stopped, ErrorCode::processDenied);
      std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(actor); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
      child->revalidate(owned.job.value, node->second.process, node->second.plan);
      if(actor==Role::fleet && command==BrokerCommand::childWrite)bindFleetProcessing(request,found->first,args,owned,source);
    }
    // IO runs on its actual private held owner outside the creator mutex;
    // another independently admitted helper can stop the same exact Job.
    return command == BrokerCommand::childRead ? child->read() : child->write(args);
  }
  Json cpuOperationReply(const CpuOperation& row) {
    return Json::Object{{"expectation", row.expectation}, {"admitted", row.admitted}, {"retired", row.retired}};
  }
  void retireCpuOperation(CpuOperation& row) {
    if (row.retired) return;
    // The helper owns metadata private-file capabilities. Its actual held
    // process must have exited; Node/parent PID absence is never sufficient.
    for (auto& [incarnation, child] : children_) { (void)incarnation;
      if (!child.operationToken.empty() && sameSecret(child.operationToken, row.expectation.at("token").string()) && !child.stopped) { child.child->stop(); child.stopped = true; }
    }
    require(!row.metadataProcess.valid() || WaitForSingleObject(row.metadataProcess.value, 0) == WAIT_OBJECT_0, ErrorCode::processDenied);
    if (!row.configToken.empty()) { (void)closePrivateFile(Json::Object{{"token", row.configToken}}); row.configToken.clear(); }
    row.retired = true;
    // Child Job zero, reader/writer joins and every file closure are already
    // confirmed. Keep the original operation tombstone as retirement proof;
    // release only its now-closed child objects, never active/warm children.
    for (auto entry = children_.begin(); entry != children_.end();) {
      if (!entry->second.operationToken.empty() && sameSecret(entry->second.operationToken, row.expectation.at("token").string()) && entry->second.stopped) entry = children_.erase(entry);
      else ++entry;
    }
  }
  Json forgetCpuOperation(const Json& expected, const std::string& requestId, CpuForgetCompletions& completed) {
    require(cpuOperationExpectation(expected), ErrorCode::processDenied);
    // Completion records stay on the actual actor until the sealed SDK
    // receives the native ACK and releases that original completion.
    if (completed.completed(expected, requestId)) return Json::Object{{"forgotten", true}};
    const auto found = cpuOperations_.find(expected.at("incarnation").string());
    require(found != cpuOperations_.end() && mm::dump(found->second.expectation) == mm::dump(expected), ErrorCode::processDenied);
    auto& row = found->second;
    require(row.retired && row.configToken.empty() && std::none_of(children_.begin(), children_.end(), [&](const auto& item) {
      return !item.second.operationToken.empty() && sameSecret(item.second.operationToken, row.expectation.at("token").string());
    }), ErrorCode::processDenied);
    require(!row.metadataProcess.valid() || WaitForSingleObject(row.metadataProcess.value, 0) == WAIT_OBJECT_0, ErrorCode::processDenied);
    completed.begin(expected, requestId);
    mmstorechild::closeOwned(row.metadataProcess.value);
    const auto preparation = cpuPreparing_.find(row.requestId);
    if (preparation != cpuPreparing_.end() && mm::dump(preparation->second->expectation) == mm::dump(expected)) {
      closeCpuPreparationResources(*preparation->second); cpuPreparing_.erase(preparation);
    }
    for(auto it=closedFixedStarts_.begin();it!=closedFixedStarts_.end();){const auto& entry=it->second;
      if(entry.at("kind").string()=="tool" && entry.at("tuple").at("operation_token").string()==expected.at("token").string())it=closedFixedStarts_.erase(it);else++it;}
    completed.finish(expected, requestId); cpuOperations_.erase(found);
    return Json::Object{{"forgotten", true}};
  }
  Json dispatchCpuOperation(Role actor, BrokerCommand command, const Json& args, const mmstore::ProcessIdentity& source, HANDLE process) {
    std::lock_guard lock(lifetimeMutex_);
    require(!ending_ && cpuOperationPolicy(actor, brokerName(command), args), ErrorCode::processDenied);
    if (command == BrokerCommand::cpuRecover || command == BrokerCommand::cpuInspect || command == BrokerCommand::cpuRetire || command == BrokerCommand::cpuForget || command == BrokerCommand::cpuRelease) issuer_->code_.revalidateCleanupIdentity();
    else issuer_->code_.revalidateOperationIdentity();
    issuer_->self_.revalidate(); data_.revalidate();
    const auto foundOwner = owned_.find(actor); require(foundOwner != owned_.end(), ErrorCode::processDenied); auto& owner = foundOwner->second;
    std::lock_guard issuerLock(issuer_->mutex_);
    const auto node = issuer_->nodes_.find(actor); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
    node->second.process.revalidate(); detail::requireMember(node->second.process.handle(), owner.job.value);
    require(GetProcessId(process) == source.pid, ErrorCode::processDenied);
    if (command == BrokerCommand::cpuForget || command == BrokerCommand::cpuRelease) {
      const auto helper = issuer_->helpers_.find(source.pid);
      require(helper != issuer_->helpers_.end() && helper->second.bound && helper->second.node == node->second.process.identity().pid &&
        mmstore::detail::sameIdentity(helper->second.process.identity(), source), ErrorCode::processDenied);
      helper->second.process.revalidate(); detail::requireMember(helper->second.process.handle(), owner.job.value);
      require(mm::dump(args.at("expectation").at("nodeOwner")) == mm::dump(publicOwner(ownerRecord(actor, owner))), ErrorCode::processDenied);
      if (command == BrokerCommand::cpuRelease) { helper->second.completedCpuForget.release(args.at("expectation"), args.at("request_id").string()); return Json::Object{{"released", true}}; }
      return forgetCpuOperation(args.at("expectation"), args.at("request_id").string(), helper->second.completedCpuForget);
    }
    if (command == BrokerCommand::cpuOpen || command == BrokerCommand::cpuRecover) {
      const auto incarnation = args.at("incarnation").string(), request = args.at("request_id").string(), operation = args.at("operation").string(), digest = args.at("configuration_sha256").string();
      if (actor == Role::prepare) {
        const auto preparation = cpuPreparationForNode(owner);
        require(preparation->request.at("requestId").string() == request && preparation->request.at("configuration").at("operation").string() == operation, ErrorCode::processDenied);
        liveControlProcess(preparation->guiProcess.value, preparation->gui);
      }
      auto found = cpuOperations_.find(incarnation);
      if (found != cpuOperations_.end()) {
        auto& row = found->second;
        require(row.role == actor && sameSecret(row.ownerNonce, owner.nonce) && row.requestId == request && row.operation == operation && row.configurationSha256 == digest &&
          mm::dump(row.expectation.at("nodeOwner")) == mm::dump(publicOwner(ownerRecord(actor, owner))), ErrorCode::processDenied);
        return cpuOperationReply(row);
      }
      require(command == BrokerCommand::cpuOpen && cpuOperations_.size() < 4096 && std::none_of(cpuOperations_.begin(), cpuOperations_.end(), [&](const auto& item) {
        return !item.second.retired && sameSecret(item.second.ownerNonce, owner.nonce) && item.second.requestId == request;
      }), ErrorCode::processDenied);
      const auto token = detail::secret();
      const auto expectation = Json::Object{{"version", 1}, {"distribution", "microsoft-store"}, {"kind", "cpu-tools"}, {"requestId", request}, {"incarnation", incarnation},
        {"operation", operation}, {"configurationSha256", digest}, {"inventorySha256", issuer_->code_.inventorySha256()}, {"runtimeManifestSha256", issuer_->code_.runtimeManifestPin().sha256},
        {"nodeOwner", publicOwner(ownerRecord(actor, owner))}, {"token", token}};
      auto& row = cpuOperations_.emplace(incarnation, CpuOperation{expectation, {}, owner.nonce, request, digest, operation, actor, false, false, {}, std::nullopt}).first->second;
      // Publish the retained owner before any private handle acquisition. A
      // failed admission remains recoverable, but cannot launch a tool.
      (void)StoreEngineChild::holdFile(fixedToolWork(cpuOperationRepresentative(operation), request) + "\\store-tool-config.json", 16384, &row.configToken);
      auto& config = privateFileCapability(Json::Object{{"token", row.configToken}}); const auto before = validatePrivateFileCapability(config);
      const auto size = before.at("bytes").integer(); require(size > 1 && size <= 16384 && hashFile(config.file.value, 16384) == digest, ErrorCode::digestMismatch);
      const auto read = readPrivateFile(Json::Object{{"token", row.configToken}, {"position", 0}, {"length", size}});
      const auto bytes = base64Decode(read.at("bytes_base64").string(), 16384);
      require(read.at("bytes_read").integer() == size && bytes.size() == static_cast<std::size_t>(size) && mm::dump(validatePrivateFileCapability(config)) == mm::dump(before), ErrorCode::fileDenied);
      const auto value = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()), true).parse();
      require(value.at("operation").string() == operation && fixedToolConfiguration(cpuOperationRepresentative(operation), value, request, utf8(node->second.process.identity().sid),
        issuer_->code_.inventorySha256(), issuer_->code_.runtimeManifestPin().sha256, issuer_->code_.nativeHelperPin().sha256), ErrorCode::processDenied);
      if (actor == Role::prepare) require(mm::dump(value) == mm::dump(cpuPreparationForNode(owner)->request.at("configuration")), ErrorCode::processDenied);
      row.configuration = value; row.admitted = true; return cpuOperationReply(row);
    }
    const auto found = std::find_if(cpuOperations_.begin(), cpuOperations_.end(), [&](const auto& entry) { return sameSecret(entry.second.expectation.at("token").string(), args.at("token").string()); });
    require(found != cpuOperations_.end(), ErrorCode::processDenied); auto& row = found->second;
    require(row.role == actor && sameSecret(row.ownerNonce, owner.nonce) && mm::dump(row.expectation.at("nodeOwner")) == mm::dump(publicOwner(ownerRecord(actor, owner))), ErrorCode::processDenied);
    if (command == BrokerCommand::cpuInspect) { require(mm::dump(args.at("expectation")) == mm::dump(row.expectation), ErrorCode::processDenied); return Json::Object{{"retired", row.retired}}; }
    if (command == BrokerCommand::cpuRetire) { require(!row.metadata || !mmstore::detail::sameIdentity(*row.metadata, source), ErrorCode::processDenied); retireCpuOperation(row); return Json::Object{{"retired", true}}; }
    require(command == BrokerCommand::cpuBindData && row.admitted && !row.retired, ErrorCode::processDenied);
    const auto helper = issuer_->helpers_.find(source.pid); require(helper != issuer_->helpers_.end() && helper->second.bound && helper->second.node == node->second.process.identity().pid, ErrorCode::processDenied);
    helper->second.process.revalidate(); detail::requireMember(helper->second.process.handle(), owner.job.value);
    require(mmstore::detail::sameIdentity(helper->second.process.identity(), source), ErrorCode::processDenied);
    if (row.metadata) require(mmstore::detail::sameIdentity(*row.metadata, source), ErrorCode::processDenied);
    else { row.metadataProcess = inheritedCopy(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); row.metadata = source; }
    return Json::Object{{"bound", true}};
  }
  Json toolStartReply(const ChildRequest& request) {
    return Json::Object{{"token", request.child->token_}, {"started", request.started},
      {"process", request.started ? StoreRoleIssuer::wireIdentity(request.child->identity_) : Json(nullptr)}};
  }
  void rememberUnissuedFixed(const std::string& incarnation,const std::string& nonce,std::string_view kind,const Json& tuple) {
    const auto value=Json::Object{{"ownerNonce",nonce},{"kind",std::string(kind)},{"tuple",tuple}};const auto found=closedFixedStarts_.find(incarnation);
    if(found!=closedFixedStarts_.end()){require(mm::dump(found->second)==mm::dump(value),ErrorCode::processDenied);return;}
    require(closedFixedStarts_.size()<4096,ErrorCode::processDenied);closedFixedStarts_.emplace(incarnation,value);
  }
  Json dispatchTool(Role actor, BrokerCommand command, const Json& args) {
    std::shared_ptr<StoreEngineChild> child;
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && cpuToolRole(actor), ErrorCode::processDenied);
      if (command == BrokerCommand::toolStop) issuer_->code_.revalidateCleanupIdentity(); else issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      const auto owner = owned_.find(actor); require(owner != owned_.end(), ErrorCode::processDenied); auto& owned = owner->second;
      if(command==BrokerCommand::toolStop && args.object().contains("incarnation")) {
        const auto incarnation=args.at("incarnation").string(),operationToken=args.at("operation_token").string();
        const auto operation=std::find_if(cpuOperations_.begin(),cpuOperations_.end(),[&](const auto& row){return sameSecret(row.second.expectation.at("token").string(),operationToken);});
        require(operation!=cpuOperations_.end() && operation->second.role==actor && sameSecret(operation->second.ownerNonce,owned.nonce) &&
          operation->second.requestId==args.at("request_id").string() && operation->second.configurationSha256==args.at("configuration_sha256").string(),ErrorCode::processDenied);
        const auto prior=children_.find(incarnation);
        if(prior!=children_.end()){auto& request=prior->second;require(request.tool && fixedToolName(*request.tool)==args.at("kind").string() &&
          request.configurationSha256==args.at("configuration_sha256").string() && request.operationToken==operationToken && sameSecret(request.child->ownerNonce_,owned.nonce),ErrorCode::processDenied);
          if(!request.stopped){request.child->stop();request.stopped=true;}}
        else rememberUnissuedFixed(incarnation,owned.nonce,"tool",args);
        return Json::Object{{"job","confirmed"},{"stopped",true}};
      }
      if (command == BrokerCommand::toolStart) {
        const auto kind = parseFixedTool(args.at("kind").string());
        const auto requestId = args.at("request_id").string(), incarnation = args.at("incarnation").string(), configurationSha256 = args.at("configuration_sha256").string();
        const auto relative = fixedToolWork(kind, requestId) + "\\store-tool-config.json";
        require(!closedFixedStarts_.contains(incarnation),ErrorCode::processDenied);
        const auto operationToken = args.at("operation_token").string();
        if (actor == Role::prepare) {
          const auto preparation = cpuPreparationForNode(owned);
          require(preparation->started && !std::holds_alternative<std::nullptr_t>(preparation->expectation.value) &&
            preparation->request.at("requestId").string() == requestId && sameSecret(preparation->expectation.at("token").string(), operationToken), ErrorCode::processDenied);
          liveControlProcess(preparation->guiProcess.value, preparation->gui);
        }
        const auto operation = std::find_if(cpuOperations_.begin(), cpuOperations_.end(), [&](const auto& entry) { return sameSecret(entry.second.expectation.at("token").string(), operationToken); });
        require(operation != cpuOperations_.end() && operation->second.admitted && !operation->second.retired && operation->second.metadataProcess.valid() &&
          WaitForSingleObject(operation->second.metadataProcess.value, 0) == WAIT_TIMEOUT && operation->second.role == actor && sameSecret(operation->second.ownerNonce, owned.nonce) &&
          operation->second.requestId == requestId && operation->second.configurationSha256 == configurationSha256, ErrorCode::processDenied);
        auto& heldConfig = privateFileCapability(Json::Object{{"token", operation->second.configToken}});
        (void)validatePrivateFileCapability(heldConfig);
        require(fixedToolWork(cpuOperationRepresentative(operation->second.operation), requestId) == fixedToolWork(kind, requestId), ErrorCode::processDenied);
        const auto prior = children_.find(incarnation);
        if (prior != children_.end()) {
          require(prior->second.tool && *prior->second.tool == kind && !prior->second.stopped && prior->second.relative == relative && prior->second.configurationSha256 == configurationSha256 && sameSecret(prior->second.operationToken, operationToken) &&
            sameSecret(prior->second.child->ownerNonce_, owned.nonce) &&
            mmstore::detail::sameIdentity(prior->second.child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
          return toolStartReply(prior->second);
        }
        require(children_.size() < 4096 && std::count_if(children_.begin(), children_.end(), [&](const auto& item) {
          return item.second.tool && !item.second.stopped && sameSecret(item.second.child->ownerNonce_, owned.nonce);
        }) < 4, ErrorCode::processDenied);
        std::lock_guard issuerLock(issuer_->mutex_);
        const auto node = issuer_->nodes_.find(actor); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
        node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity(); detail::requireMember(node->second.process.handle(), owned.job.value);
        auto created = std::shared_ptr<StoreEngineChild>(new StoreEngineChild(issuer_->code_, issuer_->code_.heldLaunchPlan(fixedToolLaunch(kind)), node->second.process.identity(), owned.nonce));
        auto& request = children_.emplace(incarnation, ChildRequest{relative, std::move(created), false, false, kind, configurationSha256, false, operationToken}).first->second;
        request.child->startTool(kind, requestId, configurationSha256, owned.job.value, node->second.process, node->second.plan); request.started = true;
        return toolStartReply(request);
      }
      const auto found = std::find_if(children_.begin(), children_.end(), [&](const auto& item) { return item.second.tool &&
        sameSecret(item.second.child->token_, args.at("token").string()) && sameSecret(item.second.child->ownerNonce_, owned.nonce); });
      require(found != children_.end(), ErrorCode::processDenied); auto& request = found->second; child = request.child;
      require(mmstore::detail::sameIdentity(child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
      if (command == BrokerCommand::toolStop) {
        if (!request.stopped) { child->stop(); request.stopped = true; }
        return Json::Object{{"job", "confirmed"}, {"stopped", true}};
      }
      require(request.started && !request.stopped, ErrorCode::processDenied);
      std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(actor); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
      child->revalidate(owned.job.value, node->second.process, node->second.plan);
    }
    return child->readTool();
  }
  Json dispatchQualification(Role actor, BrokerCommand command, const Json& args) {
    std::shared_ptr<StoreEngineChild> child;
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && actor == Role::prepare && qualificationOperation(actor, brokerName(command), args), ErrorCode::processDenied);
      if (command == BrokerCommand::qualificationStop) issuer_->code_.revalidateCleanupIdentity(); else issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      const auto owner = owned_.find(Role::prepare); require(owner != owned_.end(), ErrorCode::processDenied); auto& owned = owner->second;
      if(command==BrokerCommand::qualificationStop && args.object().contains("incarnation")) {
        const auto original=std::find_if(preparing_.begin(),preparing_.end(),[&](const auto& row){return !row.second->cleanup && !std::holds_alternative<std::nullptr_t>(row.second->nativeOwner.value) && ownerMatches(Role::prepare,owned,row.second->nativeOwner);});
        require(original!=preparing_.end() && original->second->request.at("operation").string()=="qualify",ErrorCode::processDenied);
        const auto incarnation=args.at("incarnation").string(),relative="prepare\\work\\"+original->first+"\\store-qualification-request.json";
        const auto prior=children_.find(incarnation);if(prior!=children_.end()){auto& request=prior->second;require(request.qualification && request.relative==relative && sameSecret(request.child->ownerNonce_,owned.nonce),ErrorCode::processDenied);if(!request.stopped){request.child->stop();request.stopped=true;}}
        else rememberUnissuedFixed(incarnation,owned.nonce,"qualification",args);
        return Json::Object{{"job","confirmed"},{"stopped",true}};
      }
      if (command == BrokerCommand::qualificationStart) {
        const auto preparing = std::find_if(preparing_.begin(), preparing_.end(), [&](const auto& item) { return !item.second->cleanup &&
          !std::holds_alternative<std::nullptr_t>(item.second->nativeOwner.value) && ownerMatches(Role::prepare, owned, item.second->nativeOwner); });
        require(preparing != preparing_.end() && preparing->second->request.at("operation").string() == "qualify" && owned.gpu &&
          WaitForSingleObject(owned.gpu->keeper.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(owned.gpu->release.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
        const auto incarnation = args.at("incarnation").string(), relative = "prepare\\work\\" + preparing->first + "\\store-qualification-request.json";
        require(!closedFixedStarts_.contains(incarnation),ErrorCode::processDenied);
        const auto prior = children_.find(incarnation);
        if (prior != children_.end()) {
          require(prior->second.qualification && !prior->second.stopped && prior->second.relative == relative &&
            sameSecret(prior->second.child->ownerNonce_, owned.nonce) && mmstore::detail::sameIdentity(prior->second.child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
          return toolStartReply(prior->second);
        }
        require(children_.size() < 4096 && std::none_of(children_.begin(), children_.end(), [&](const auto& item) { return item.second.qualification && !item.second.stopped && sameSecret(item.second.child->ownerNonce_, owned.nonce); }), ErrorCode::processDenied);
        std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(Role::prepare);
        require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied); node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity(); detail::requireMember(node->second.process.handle(), owned.job.value);
        const auto& selected = preparing->second->request.at("gpu"); require(owned.gpuLuid == selected.at("luid").string(), ErrorCode::processDenied);
        bool current = false; for (const auto& gpu : gpuInventory()) if (mm::dump(gpu) == mm::dump(selected)) current = true; require(current, ErrorCode::processDenied);
        auto created = std::shared_ptr<StoreEngineChild>(new StoreEngineChild(issuer_->code_, issuer_->code_.heldLaunchPlan(mmstoreruntime::LaunchKind::pythonGuardian),
          issuer_->code_.heldLaunchPlan(mmstoreruntime::LaunchKind::qualification), node->second.process.identity(), owned.nonce));
        auto& request = children_.emplace(incarnation, ChildRequest{relative, std::move(created), false, false, std::nullopt, {}, true, {}}).first->second;
        request.child->retainGpuKeeper(owned.gpu->keeper.value, owned.gpu->release.value);
        request.child->startQualification(preparing->second->request, owned.job.value, node->second.process, node->second.plan, selected); request.started = true;
        return toolStartReply(request);
      }
      const auto found = std::find_if(children_.begin(), children_.end(), [&](const auto& item) { return item.second.qualification && sameSecret(item.second.child->token_, args.at("token").string()) && sameSecret(item.second.child->ownerNonce_, owned.nonce); });
      require(found != children_.end(), ErrorCode::processDenied); auto& request = found->second; child = request.child;
      require(mmstore::detail::sameIdentity(child->owner_, mmstore::detail::processIdentity(owned.process.value)), ErrorCode::processDenied);
      if (command == BrokerCommand::qualificationStop) {
        if (!request.stopped) { child->stop(); request.stopped = true; }
        return Json::Object{{"job", "confirmed"}, {"stopped", true}};
      }
      require(request.started && !request.stopped, ErrorCode::processDenied);
      std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(Role::prepare); require(node != issuer_->nodes_.end() && node->second.bound, ErrorCode::processDenied);
      child->revalidate(owned.job.value, node->second.process, node->second.plan);
    }
    return child->readTool();
  }
  static void liveControlProcess(HANDLE process, const mmstore::ProcessIdentity& expected) {
    require(process != nullptr && process != INVALID_HANDLE_VALUE && WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
      mmstore::detail::sameIdentity(mmstore::detail::processIdentity(process), expected), ErrorCode::processDenied);
  }
  void controlTarget(ControlRequest& request) {
    issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
    liveControlProcess(request.targetProcess.value, request.targetNode);
    const auto owned = owned_.find(request.target);
    require(owned != owned_.end() && ownerMatches(request.target, owned->second, request.targetOwner), ErrorCode::processDenied);
    detail::requireKillJob(request.targetJob.value); detail::requireMember(request.targetProcess.value, request.targetJob.value);
    std::lock_guard lock(issuer_->mutex_); const auto node = issuer_->nodes_.find(request.target);
    require(node != issuer_->nodes_.end() && node->second.bound && mmstore::detail::sameIdentity(node->second.process.identity(), request.targetNode) &&
      CompareObjectHandles(node->second.job.get(), request.targetJob.value), ErrorCode::processDenied);
    node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity();
  }
  void controlSource(ControlRequest& request) {
    liveControlProcess(request.sourceProcess.value, request.source);
    std::lock_guard lock(issuer_->mutex_);
    if (request.gui) {
      require(request.guiClient && !request.guiClient->closed && mmstore::detail::sameIdentity(request.guiClient->parent.identity(), request.source), ErrorCode::processDenied);
      request.guiClient->process.revalidate(); request.guiClient->parent.revalidate();
      StoreRoleIssuer::confirmGuiRights(*request.guiClient);
      require(mmstore::detail::sameIdentity(request.peer, request.guiClient->browser ? request.guiClient->browser->peer() : request.source), ErrorCode::processDenied); return;
    }
    const auto source = issuer_->helpers_.find(request.source.pid); const auto node = issuer_->nodes_.find(request.sourceRole);
    require(source != issuer_->helpers_.end() && source->second.bound && node != issuer_->nodes_.end() && node->second.bound &&
      source->second.node == node->second.process.identity().pid && mmstore::detail::sameIdentity(source->second.process.identity(), request.source), ErrorCode::processDenied);
    source->second.process.revalidate(); node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity();
    detail::requireKillJob(node->second.job.get()); detail::requireMember(source->second.process.handle(), node->second.job.get());
  }
  // This is a transport-lifetime observation on an already admitted private
  // record. The caller must independently revalidate its actual target/code.
  // It never acknowledges business work or role/Job/GPU retirement.
  bool controlSourceRetired(ControlRequest& request) {
    const auto sourceState = WaitForSingleObject(request.sourceProcess.value, 0);
    require(sourceState == WAIT_OBJECT_0 || sourceState == WAIT_TIMEOUT, ErrorCode::processDenied);
    if (!request.gui) return sourceState == WAIT_OBJECT_0;
    std::lock_guard lock(issuer_->mutex_);
    require(request.guiClient && mmstore::detail::sameIdentity(request.guiClient->parent.identity(), request.source) &&
      CompareObjectHandles(request.guiClient->parent.handle(), request.sourceProcess.value), ErrorCode::processDenied);
    // A replaced GUI generation is uncertainty, even when its old helper has
    // exited. Only current genuine registered Store GUI code can be observed.
    auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui);
    require(package.observation().fullName == request.guiClient->parent.observation().fullName &&
      package.observation().fullName == request.guiClient->process.observation().fullName, ErrorCode::stalePackage);
    package.revalidate();
    const auto helperState = WaitForSingleObject(request.guiClient->process.handle(), 0);
    require(helperState == WAIT_OBJECT_0 || helperState == WAIT_TIMEOUT, ErrorCode::processDenied);
    if (sourceState == WAIT_TIMEOUT) request.guiClient->parent.revalidate();
    if (helperState == WAIT_TIMEOUT) request.guiClient->process.revalidate();
    return sourceState == WAIT_OBJECT_0 || helperState == WAIT_OBJECT_0 || request.guiClient->closed || (request.guiClient->browser && request.guiClient->browser->retired());
  }
  void pruneControl() {
    for (auto it = controls_.begin(); it != controls_.end();) {
      // Only a confirmed dead actual source can retire a never-delivered or
      // completed transport record. An uncertain in-flight dispatch stays.
      if (WaitForSingleObject(it->second->sourceProcess.value, 0) == WAIT_OBJECT_0 &&
          (!it->second->delivered || it->second->complete)) it = controls_.erase(it);
      else ++it;
    }
  }
  std::shared_ptr<ControlRequest> enqueueControl(Role actor, Role target, bool gui, const std::string& id, const std::string& payload,
      const mmstore::ProcessIdentity& source, HANDLE process, std::shared_ptr<StoreRoleIssuer::GuiClient> guiClient = {}, const Json& expectedTarget = nullptr) {
    std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied); assertPublication();
    liveControlProcess(process, source); pruneControl();
    const auto existing = controls_.find(id);
    if (existing != controls_.end()) {
      require(mmstore::detail::sameIdentity(existing->second->source, source) && existing->second->target == target && existing->second->payload == payload,
        ErrorCode::processDenied);
      require(existing->second->targetExpected == !std::holds_alternative<std::nullptr_t>(expectedTarget.value) &&
        (!existing->second->targetExpected || mm::dump(existing->second->targetOwner) == mm::dump(expectedTarget)), ErrorCode::processDenied);
      return existing->second;
    }
    require(controls_.size() < 128 && !controlAcks_.contains(id), ErrorCode::processDenied);
    const auto plain = base64Decode(payload, 4096); const auto json = mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()), plain.size()), true).parse();
    require(controlPayload(actor, target, gui, json, gui && guiClient && guiClient->browser.has_value()), ErrorCode::processDenied);
    if (!gui && target == Role::session) {
      const auto actual = owned_.find(actor); require(actual != owned_.end(), ErrorCode::processDenied);
      const auto& row = json.at("ownerReceipt");
      require(row.at("role").string() == roleName(actor) && sameSecret(row.at("nonce").string(), actual->second.nonce), ErrorCode::processDenied);
      const auto& peer = row.at("identity"); require(peer.at("sid").string() == utf8(issuer_->creator().sid) &&
        peer.at("sessionId").integer() == issuer_->creator().sessionId && peer.at("pid").integer() == GetProcessId(actual->second.process.value) &&
        peer.at("creationTime").string() == actual->second.identity.at("creation_time").string(), ErrorCode::processDenied);
      detail::requireMember(process, actual->second.job.value);
    }
    const auto targetOwner = owned_.find(target); require(targetOwner != owned_.end(), ErrorCode::processDenied);
    const auto targetExpected = !std::holds_alternative<std::nullptr_t>(expectedTarget.value);
    require(targetExpected == (!gui && actor == Role::session && (target == Role::personal || target == Role::fleet)) &&
      (!targetExpected || ownerMatches(target, targetOwner->second, expectedTarget)), ErrorCode::processDenied);
    auto request = std::make_shared<ControlRequest>(); request->id = id; request->token = detail::secret(); request->payload = payload; request->target = target; request->sourceRole = actor; request->gui = gui;
    request->source = source; request->peer = source; request->sourceProcess = inheritedCopy(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); request->guiClient = std::move(guiClient);
    if (request->guiClient && request->guiClient->browser) request->peer = request->guiClient->browser->peer();
    request->targetNode = mmstore::detail::processIdentity(targetOwner->second.process.value);
    request->targetOwner = ownerRecord(target, targetOwner->second); request->targetExpected = targetExpected;
    request->targetProcess = inheritedCopy(targetOwner->second.process.value, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE);
    request->targetJob = inheritedCopy(targetOwner->second.job.value, JOB_OBJECT_QUERY);
    request->ready = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(request->ready.valid(), ErrorCode::processDenied);
    controlSource(*request); controlTarget(*request); controls_.emplace(id, request);
    auto event = controlEvents_.find(target);
    if (event == controlEvents_.end()) event = controlEvents_.emplace(target, ::Handle(CreateEventW(nullptr, FALSE, FALSE, nullptr))).first;
    require(event->second.valid() && SetEvent(event->second.value), ErrorCode::processDenied); return request;
  }
  Json waitControl(const std::shared_ptr<ControlRequest>& request) {
    HANDLE watched[]{request->ready.value, request->sourceProcess.value, request->targetProcess.value, endingEvent_.value};
    const auto waited = WaitForMultipleObjects(4, watched, FALSE, 25000);
    require(waited == WAIT_TIMEOUT || waited == WAIT_OBJECT_0, ErrorCode::processDenied);
    std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied);
    controlSource(*request); controlTarget(*request);
    Json::Object result{{"version", 1}, {"requestId", request->id}, {"state", request->complete ? "completed" : "waiting"}};
    if (request->complete) result.emplace("payload_base64", request->response);
    if (request->targetExpected) result.emplace("target_owner", request->targetOwner);
    return result;
  }
  Json acknowledgeControl(const std::string& id, const mmstore::ProcessIdentity& source, HANDLE process) {
    std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied); liveControlProcess(process, source);
    const auto found = controls_.find(id);
    if (found != controls_.end()) {
      require(found->second->complete && mmstore::detail::sameIdentity(found->second->source, source) && controlAcks_.size() < 4096, ErrorCode::processDenied);
      controlAcks_.emplace(id, source); controls_.erase(found);
    } else {
      const auto retired = controlAcks_.find(id); require(retired != controlAcks_.end() && mmstore::detail::sameIdentity(retired->second, source), ErrorCode::processDenied);
    }
    return Json::Object{{"acknowledged", true}};
  }
  Json dispatchControl(Role actor, BrokerCommand command, const Json& args, const mmstore::ProcessIdentity& source, HANDLE process) {
    if (command == BrokerCommand::controlRequest)
      return waitControl(enqueueControl(actor, args.at("target").string() == "session" ? Role::session : args.at("target").string() == "fleet" ? Role::fleet : Role::personal, false,
        args.at("requestId").string(), args.at("payload_base64").string(), source, process, {},
        args.object().contains("expected_target") ? args.at("expected_target") : Json(nullptr)));
    if (command == BrokerCommand::controlAck) return acknowledgeControl(args.at("requestId").string(), source, process);
    if (command == BrokerCommand::controlReply || command == BrokerCommand::controlPeer) {
      std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied); liveControlProcess(process, source);
      const auto found = std::find_if(controls_.begin(), controls_.end(), [&](const auto& entry) { return sameSecret(entry.second->token, args.at("token").string()); });
      require(found != controls_.end(), ErrorCode::processDenied); auto& request = *found->second;
      require(request.target == actor && request.delivered && mmstore::detail::sameIdentity(request.receiver, source) &&
        CompareObjectHandles(request.receiverProcess.value, process), ErrorCode::processDenied);
      controlTarget(request);
      const auto transportRetired = controlSourceRetired(request);
      if (command == BrokerCommand::controlPeer) {
        require(!request.complete && (request.gui ? (args.at("kind").string() == "gui" || (args.at("kind").string() == "chrome" && request.guiClient && request.guiClient->browser)) : args.at("kind").string() == roleName(request.sourceRole)) &&
          mm::dump(args.at("identity")) == mm::dump(StoreRoleIssuer::wireIdentity(request.peer)), ErrorCode::processDenied);
        if (transportRetired) return Json::Object{{"verified", false}};
        controlSource(request); return Json::Object{{"verified", true}};
      }
      if (!transportRetired) controlSource(request);
      if (request.complete) require(request.response == args.at("payload_base64").string(), ErrorCode::processDenied);
      else { request.response = args.at("payload_base64").string(); request.complete = true; require(SetEvent(request.ready.value), ErrorCode::processDenied); }
      if (transportRetired) return Json::Object{{"accepted", true}, {"transport_retired", true}};
      return Json::Object{{"accepted", true}};
    }
    require(command == BrokerCommand::controlAccept, ErrorCode::processDenied);
    ::Handle event;
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied);
      auto found = controlEvents_.find(actor);
      if (found == controlEvents_.end()) found = controlEvents_.emplace(actor, ::Handle(CreateEventW(nullptr, FALSE, FALSE, nullptr))).first;
      require(found->second.valid(), ErrorCode::processDenied); event = inheritedCopy(found->second.value, SYNCHRONIZE);
    }
    for (unsigned pass = 0; pass < 2; ++pass) {
      {
        std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied); liveControlProcess(process, source); pruneControl();
        for (auto entry = controls_.begin(); entry != controls_.end();) {
          auto request = entry->second;
          if (request->target != actor || request->delivered || request->complete) { ++entry; continue; }
          controlTarget(*request);
          if (controlSourceRetired(*request)) { entry = controls_.erase(entry); continue; }
          controlSource(*request);
          const auto owner = owned_.find(actor); require(owner != owned_.end(), ErrorCode::processDenied); detail::requireMember(process, owner->second.job.value);
          request->receiver = source; request->receiverProcess = inheritedCopy(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); request->delivered = true;
          return Json::Object{{"version", 1}, {"token", request->token}, {"payload_base64", request->payload}, {"peer", StoreRoleIssuer::wireIdentity(request->peer)}};
        }
      }
      if (pass == 1) break;
      HANDLE watched[]{event.value, process, endingEvent_.value}; const auto waited = WaitForMultipleObjects(3, watched, FALSE, 25000);
      require(waited == WAIT_TIMEOUT || waited == WAIT_OBJECT_0, ErrorCode::processDenied); if (waited == WAIT_TIMEOUT) break;
    }
    return nullptr;
  }
  Json gpuBroker(Role role, BrokerCommand command, const Json& args) {
    require(gpuLeaseRole(role), ErrorCode::processDenied);
    const auto found = owned_.find(role); require(found != owned_.end() && !found->second.cpuMode, ErrorCode::processDenied); auto& node = found->second;
    if (command == BrokerCommand::gpuRelease) issuer_->code_.revalidateCleanupIdentity(); else issuer_->code_.revalidateOperationIdentity();
    require(WaitForSingleObject(node.process.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
    detail::requireMember(node.process.value, node.job.value); detail::requireMember(GetCurrentProcess(), node.job.value, false);
    if (command == BrokerCommand::gpuAcquire) {
      Json actual; for (const auto& gpu : gpuInventory()) if (mm::dump(gpu) == mm::dump(args.at("gpu"))) { actual = gpu; break; }
      require(!std::holds_alternative<std::nullptr_t>(actual.value), ErrorCode::processDenied);
      if(role==Role::prepare && node.preparing){const auto& requested=node.preparing->benchmarkMode?node.preparing->request.at("configuration").at("gpu"):node.preparing->request.at("gpu");require(mm::dump(requested)==mm::dump(actual),ErrorCode::processDenied);}
      const auto luid = actual.at("luid").string();
      if (!node.gpu) {
        // Store the exact holder before starting it so an uncertain ACK remains
        // owned and recoverable through whole-role retirement, never discarded.
        node.gpu.emplace(); node.gpuLuid = luid; auto& guard = *node.gpu;
        guard.nonce = detail::secret(); guard.identity = processIdentity(GetCurrentProcessId()); guard.gpu = actual; guard.roleBound = true;
        guard.job = inheritedCopy(node.job.value, 0, true); guard.release = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        require(guard.release.valid(), ErrorCode::processDenied);
        BoundGpuRole bound; bound.job = inheritedCopy(node.job.value, 0, true); bound.process = inheritedCopy(node.process.value, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE);
        bound.rootController = inheritedCopy(GetCurrentProcess(), SYNCHRONIZE); bound.owner = ownerRecord(role, node);
        if (!startIndependentGpuKeeper(guard, luid, &bound)) {
          DWORD exit = 2; require(guard.keeper.valid() && WaitForSingleObject(guard.keeper.value, 5000) == WAIT_OBJECT_0 && GetExitCodeProcess(guard.keeper.value, &exit) != FALSE && exit == 0, ErrorCode::processDenied);
          node.gpu.reset(); node.gpuLuid.clear(); return Json::Object{{"acquired", false}};
        }
      }
      auto& guard = *node.gpu;
      require(node.gpuLuid == luid && mm::dump(guard.gpu) == mm::dump(actual) && !guard.abandoned &&
        WaitForSingleObject(guard.keeper.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(guard.release.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
      return Json::Object{{"acquired", true}, {"luid", luid}, {"nonce", guard.nonce}, {"gpu", guard.gpu}, {"abandoned", false}, {"keeper", processIdentity(GetProcessId(guard.keeper.value))}};
    }
    const auto& luid = args.at("luid").string(); const auto& nonce = args.at("nonce").string();
    if (!node.gpu) {
      const auto prior = node.releasedGpu.find(nonce); require(prior != node.releasedGpu.end() && prior->second == luid, ErrorCode::processDenied);
      return command == BrokerCommand::gpuRelease ? Json(Json::Object{{"released", true}}) : Json(Json::Object{{"held", false}});
    }
    auto& guard = *node.gpu; require(node.gpuLuid == luid && sameSecret(guard.nonce, nonce), ErrorCode::processDenied);
    if (command == BrokerCommand::gpuInspect) return Json::Object{{"held", WaitForSingleObject(guard.keeper.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(guard.release.value, 0) == WAIT_TIMEOUT}};
    const auto helperPath = issuer_->code_.cleanupNativeHelperPath();
    require(node.releasedGpu.size() < 4096 && gpuRoleIdle(node.job.value, ownerRecord(role, node), helperPath), ErrorCode::processDenied);
    require(SetEvent(guard.release.value) != FALSE, ErrorCode::processDenied);
    issuer_->confirmGpuGuardianExit(guard.keeper.value);
    node.releasedGpu.emplace(nonce, luid); node.gpu.reset(); node.gpuLuid.clear(); return Json::Object{{"released", true}};
  }
  static Json publicIdentity(const Json& identity) {
    return Json::Object{{"sid", identity.at("sid")}, {"sessionId", identity.at("session_id")}, {"pid", identity.at("pid")}, {"creationTime", identity.at("creation_time")}};
  }
  static Json publicOwner(const Json& owner) { return Json::Object{{"role", owner.at("role")}, {"nonce", owner.at("nonce")}, {"identity", publicIdentity(owner.at("identity"))}}; }
  static Json readPreparationResult(const std::string& id, const std::string& digest, std::uint64_t expected) {
    require(data_policy::uuid(id) && mmstore::validDigest(digest) && expected > 0 && expected <= 16384, ErrorCode::processDenied);
    const auto opened = openPrivateFile(Json::Object{{"root", "personal"}, {"relative_path", "prepare\\results\\" + id + ".json"}, {"mode", "read"}, {"maximum_bytes", 16384}, {"expected_birth", nullptr}});
    const auto token = opened.at("token").string();
    struct File { std::string token; bool open = true; ~File() { if (open) { try { (void)closePrivateFile(Json::Object{{"token", token}}); } catch (...) {} } } } file{token};
    auto& capability = privateFileCapability(Json::Object{{"token", token}}); const auto identity = validatePrivateFileCapability(capability);
    require(identity.at("bytes").integer() == static_cast<std::int64_t>(expected) && hashFile(capability.file.value, 16384) == digest, ErrorCode::digestMismatch);
    const auto read = readPrivateFile(Json::Object{{"token", token}, {"position", 0}, {"length", static_cast<std::int64_t>(expected)}});
    const auto bytes = base64Decode(read.at("bytes_base64").string(), 16384);
    require(bytes.size() == expected && read.at("bytes_read").integer() == static_cast<std::int64_t>(expected) && mm::dump(validatePrivateFileCapability(capability)) == mm::dump(identity) && hashFile(capability.file.value, 16384) == digest, ErrorCode::digestMismatch);
    // Qualification measurements legitimately contain decimal numbers. The
    // bounded private report remains receiving data, never launch/GPU authority.
    auto result = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()), true).parse();
    (void)closePrivateFile(Json::Object{{"token", token}}); file.open = false; return result;
  }
  void assertPublication() {
    require(published_ && publisher_ && publisherProcess_.valid(), ErrorCode::processDenied);
    liveControlProcess(publisherProcess_.value, *publisher_);
    const auto record = singletonRecord("session"); require(mm::dump(record) == mm::dump(publisherRecord_), ErrorCode::processDenied);
    std::lock_guard lock(issuer_->mutex_); const auto helper = issuer_->helpers_.find(publisher_->pid);
    require(helper != issuer_->helpers_.end() && helper->second.bound && mmstore::detail::sameIdentity(helper->second.process.identity(), *publisher_), ErrorCode::processDenied);
    helper->second.process.revalidate();
  }
  void publishSession(const mmstore::ProcessIdentity& source, HANDLE process) {
    require(!published_, ErrorCode::processDenied); const auto found = owned_.find(Role::session); require(found != owned_.end(), ErrorCode::processDenied);
    const auto record = singletonRecord("session"); require(!std::holds_alternative<std::nullptr_t>(record.value) && mm::dump(record.at("owner")) == mm::dump(found->second.identity) &&
      mm::dump(record.at("helper")) == mm::dump(StoreRoleIssuer::wireIdentity(source)), ErrorCode::processDenied);
    liveControlProcess(process, source); publisherProcess_ = inheritedCopy(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); publisher_ = source; publisherRecord_ = record;
    const auto text = mm::dump(Json::Object{{"version", 1}, {"creator", StoreRoleIssuer::wireIdentity(issuer_->creator())}, {"creator_channel", issuer_->channel_},
      {"inventory_sha256", issuer_->code_.inventorySha256()}, {"owner", ownerRecord(Role::session, found->second)}});
    require(text.size() <= 4096, ErrorCode::processDenied); data_.revalidate();
    Security security(L"O:" + issuer_->creator().sid + L"D:P(A;;GA;;;" + issuer_->creator().sid + L")(A;;GA;;;SY)");
    const auto name = L"Local\\MusicMuteStoreSessionPublished-v1-" + issuer_->creator().sid + L"-" + std::to_wstring(issuer_->creator().sessionId);
    publishedEvent_ = ::Handle(CreateEventW(&security.attributes, TRUE, FALSE, name.c_str())); require(publishedEvent_.valid(), ErrorCode::processDenied); assertPrivateMutex(publishedEvent_.value);
    require(ResetEvent(publishedEvent_.value) != FALSE, ErrorCode::processDenied);
    (void)vault("vault_put", Json::Object{{"namespace", "fleet"}, {"key", "store_session_locator"}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}});
    data_.revalidate(); issuer_->self_.revalidate(); require(SetEvent(publishedEvent_.value) != FALSE, ErrorCode::processDenied); published_ = true;
  }
  void retireChildren() {
    for (const auto role : {Role::personal, Role::fleet, Role::prepare}) { const auto found = owned_.find(role); if (found != owned_.end()) retireRole(role, found->second); }
  }
  static void duplicateOwned(HANDLE source, DWORD rights, ::Handle& output) {
    require(!output.valid(), ErrorCode::processDenied);
    const auto copied = DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &output.value, rights, FALSE, 0);
    // The original row adopts any returned handle before validation can throw.
    require(copied != FALSE && output.valid(), ErrorCode::processDenied);
  }
  std::shared_ptr<CpuPrepareRequest> cpuPreparationForNode(const NodeOwner& node) {
    require(node.cpuMode && !node.gpu, ErrorCode::processDenied);
    const auto found = std::find_if(cpuPreparing_.begin(), cpuPreparing_.end(), [&](const auto& entry) {
      return !entry.second->cleanup && !std::holds_alternative<std::nullptr_t>(entry.second->nativeOwner.value) &&
        ownerMatches(Role::prepare, node, entry.second->nativeOwner);
    });
    require(found != cpuPreparing_.end(), ErrorCode::processDenied); return found->second;
  }
  static std::pair<std::string, std::uint64_t> cpuResultPath(const CpuPrepareRequest& request) {
    const auto id = request.request.at("requestId").string(), operation = request.request.at("configuration").at("operation").string();
    require(data_policy::uuid(id) && cpuOperationName(operation), ErrorCode::processDenied);
    if (operation == "silence_analyze") return {"prepare\\work\\" + id + "\\silence-map.json", 1024 * 1024};
    const auto leaf = operation == "diagnostics_doctor" ? "doctor-result.json" : operation == "browser_check_youtube" ? "youtube-check-result.json" : "media-result.json";
    return {"cloud\\work\\" + id + "\\" + leaf, 4096};
  }
  void holdCpuResult(CpuPrepareRequest& request, const Json& args) {
    const auto [relative, maximum] = cpuResultPath(request); const auto expected = args.at("bytes").integer();
    require(expected >= 2 && static_cast<std::uint64_t>(expected) <= maximum && request.reportToken.empty(), ErrorCode::processDenied);
    (void)StoreEngineChild::holdFile(relative, maximum, &request.reportToken);
    auto& file = privateFileCapability(Json::Object{{"token", request.reportToken}}); const auto before = validatePrivateFileCapability(file);
    require(before.at("bytes").integer() == expected && hashFile(file.file.value, maximum) == args.at("sha256").string(), ErrorCode::digestMismatch);
    std::vector<BYTE> bytes; bytes.reserve(static_cast<std::size_t>(expected));
    for (std::int64_t position = 0; position < expected;) {
      const auto length = std::min<std::int64_t>(expected - position, static_cast<std::int64_t>(privateFileChunk));
      const auto read = readPrivateFile(Json::Object{{"token", request.reportToken}, {"position", position}, {"length", length}});
      const auto chunk = base64Decode(read.at("bytes_base64").string(), privateFileChunk);
      require(read.at("bytes_read").integer() == length && chunk.size() == static_cast<std::size_t>(length), ErrorCode::fileDenied);
      bytes.insert(bytes.end(), chunk.begin(), chunk.end()); position += length;
    }
    require(bytes.size() == static_cast<std::size_t>(expected) &&
      mm::dump(validatePrivateFileCapability(file)) == mm::dump(before) && hashFile(file.file.value, maximum) == args.at("sha256").string(), ErrorCode::digestMismatch);
    // Reports contain legitimate fractional measurements. This bounded JSON
    // check grants no model, GPU, code or workspace-retirement authority.
    (void)mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()), true).parse();
    request.summary = Json::Object{{"relativePath", relative}, {"bytes", expected}, {"sha256", args.at("sha256")}};
  }
  struct CpuWait {
    std::shared_ptr<CpuPrepareRequest> request;
    explicit CpuWait(std::shared_ptr<CpuPrepareRequest> value) : request(std::move(value)) { request->waits.fetch_add(1); }
    CpuWait(const CpuWait&) = delete;
    CpuWait& operator=(const CpuWait&) = delete;
    ~CpuWait() { request->waits.fetch_sub(1); }
  };
  Json dispatchCpuPreparation(Role actor, BrokerCommand command, const Json& args) {
    std::shared_ptr<CpuPrepareRequest> request;
    std::optional<CpuWait> waiting;
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && actor == Role::prepare, ErrorCode::processDenied);
      issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      const auto node = owned_.find(actor); require(node != owned_.end(), ErrorCode::processDenied); request = cpuPreparationForNode(node->second);
      liveControlProcess(request->guiProcess.value, request->gui);
      if (command == BrokerCommand::cpuPrepareRequest) return request->wireRequest;
      if (command == BrokerCommand::cpuPrepareReady) {
        require(args.at("requestId").string() == request->request.at("requestId").string(), ErrorCode::processDenied);
        const auto& expected = args.at("expectation"); const auto found = cpuOperations_.find(expected.at("incarnation").string());
        require(found != cpuOperations_.end(), ErrorCode::processDenied); auto& row = found->second;
        require(row.admitted && !row.retired && row.role == actor && sameSecret(row.ownerNonce, node->second.nonce) &&
          mm::dump(row.expectation) == mm::dump(expected) && mm::dump(row.configuration) == mm::dump(request->request.at("configuration")) &&
          mm::dump(expected.at("nodeOwner")) == mm::dump(request->launch.at("owner")) && row.metadata && row.metadataProcess.valid(), ErrorCode::processDenied);
        liveControlProcess(row.metadataProcess.value, *row.metadata);
        (void)validatePrivateFileCapability(privateFileCapability(Json::Object{{"token", row.configToken}}));
        if (!std::holds_alternative<std::nullptr_t>(request->expectation.value)) require(mm::dump(request->expectation) == mm::dump(expected), ErrorCode::processDenied);
        else request->expectation = expected;
        require(SetEvent(request->ready.value) != FALSE, ErrorCode::processDenied); return Json::Object{{"accepted", true}};
      }
      if (command == BrokerCommand::cpuPrepareResult) {
        require(args.at("requestId").string() == request->request.at("requestId").string() && request->failure.empty() &&
          std::holds_alternative<std::nullptr_t>(request->summary.value) && std::none_of(children_.begin(), children_.end(), [&](const auto& child) {
            return sameSecret(child.second.child->ownerNonce_, node->second.nonce) && !child.second.stopped;
          }) && std::none_of(cpuOperations_.begin(), cpuOperations_.end(), [&](const auto& operation) {
            return sameSecret(operation.second.ownerNonce, node->second.nonce) && !operation.second.retired;
          }), ErrorCode::processDenied);
        if (args.object().contains("errorCode")) request->failure = args.at("errorCode").string();
        else { require(request->started && !std::holds_alternative<std::nullptr_t>(request->expectation.value), ErrorCode::processDenied); holdCpuResult(*request, args); }
        require(SetEvent(request->result.value) != FALSE && SetEvent(request->ready.value) != FALSE, ErrorCode::processDenied);
        return Json::Object{{"accepted", true}};
      }
      require(command == BrokerCommand::cpuPrepareStart && !std::holds_alternative<std::nullptr_t>(request->expectation.value), ErrorCode::processDenied);
      waiting.emplace(request);
    }
    HANDLE watched[]{request->start.value, request->node.value, request->guiProcess.value, endingEvent_.value};
    const auto ended = WaitForMultipleObjects(4, watched, FALSE, 25000);
    require(ended == WAIT_TIMEOUT || ended == WAIT_OBJECT_0, ErrorCode::processDenied);
    std::lock_guard lock(lifetimeMutex_); require(!ending_ && !request->cleanup && request->failure.empty(), ErrorCode::processDenied);
    issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
    const auto node = owned_.find(actor); require(node != owned_.end() && cpuPreparationForNode(node->second) == request, ErrorCode::processDenied);
    liveControlProcess(request->guiProcess.value, request->gui);
    require(ended != WAIT_OBJECT_0 || request->started, ErrorCode::processDenied); return Json::Object{{"started", ended == WAIT_OBJECT_0}};
  }
  void cleanupCpuPreparation(CpuPrepareRequest& request) {
    cleanupPreparation(request);
    if (!request.reportToken.empty()) { (void)closePrivateFile(Json::Object{{"token", request.reportToken}}); request.reportToken.clear(); }
  }
  void retireUnresumedPrepare(PrepareRequest& request, NodeOwner& node) {
    require(node.preparing == &request && !node.resumed, ErrorCode::processDenied);
    if (node.job.valid() && node.jobCreated && !node.jobRetired) {
      detail::requireMember(GetCurrentProcess(), node.job.value, false);
      require(TerminateJobObject(node.job.value, 2) != FALSE, ErrorCode::processDenied);
    }
    require(node.jobCreated || (!node.process.valid() && !node.guardian.valid()), ErrorCode::processDenied);
    if (node.process.valid() && !node.jobRetired) {
      const auto state = WaitForSingleObject(node.process.value, 0);
      require(state == WAIT_TIMEOUT || state == WAIT_OBJECT_0, ErrorCode::processDenied);
      if (state == WAIT_TIMEOUT) require(TerminateProcess(node.process.value, 2) != FALSE, ErrorCode::processDenied);
      require(WaitForSingleObject(node.process.value, 10000) == WAIT_OBJECT_0, ErrorCode::processDenied);
    }
    if (node.job.valid() && node.jobCreated && !node.jobRetired) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
      require(QueryInformationJobObject(node.job.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr) && state.ActiveProcesses == 0, ErrorCode::processDenied);
    }
    node.jobRetired = true;
    if (!node.issuerRetired) {
      bool registered = false;
      {
        std::lock_guard issuerLock(issuer_->mutex_); const auto admitted = issuer_->nodes_.find(Role::prepare);
        if (admitted != issuer_->nodes_.end()) {
          require(node.process.valid() && sameSecret(admitted->second.ownershipNonce, node.nonce) &&
            CompareObjectHandles(admitted->second.process.handle(), node.process.value) && CompareObjectHandles(admitted->second.job.get(), node.job.value), ErrorCode::processDenied);
          registered = true;
        }
      }
      if (registered) issuer_->retireUnresumedNode(Role::prepare, node.nonce, node.process.value, node.job.value);
      else require(!node.guardian.valid() || node.guardianStartup.aborted, ErrorCode::processDenied);
      node.issuerRetired = true;
    }
    if (node.guardian.valid()) {
      DWORD exit = 2; require(WaitForSingleObject(node.guardian.value, 10000) == WAIT_OBJECT_0 && GetExitCodeProcess(node.guardian.value, &exit) &&
        guardianRetirementExit(GuardianKind::job, true, node.guardianStartup.aborted, exit), ErrorCode::processDenied);
    }
    require(!node.gpu, ErrorCode::processDenied);
    node.treeRetired = true;
    closeStoreJobGuardianStartup(node.guardianStartup);
    for (auto* handle : {&node.startupInput, &node.startupWriter, &node.startupOutput, &node.startupThread, &node.guardian, &node.process, &node.job}) mmstorechild::closeOwned(handle->value);
    if (!std::holds_alternative<std::nullptr_t>(request.nativeOwner.value)) {
      const auto found = retired_.find(node.nonce);
      if (found == retired_.end()) { require(retired_.size() < 4096, ErrorCode::processDenied); retired_.emplace(node.nonce, request.nativeOwner); }
      else require(mm::dump(found->second) == mm::dump(request.nativeOwner), ErrorCode::processDenied);
    }
    owned_.erase(Role::prepare); request.cleanup = true;
  }
  Json retirePartialCpuPreparation(CpuPrepareRequest& request) {
    require(!request.issued, ErrorCode::processDenied);
    if (!request.cleanup) {
      const auto node = owned_.find(Role::prepare);
      if (node != owned_.end()) retireUnresumedPrepare(request, node->second);
      else {
        require(std::holds_alternative<std::nullptr_t>(request.nativeOwner.value) && !request.node.valid(), ErrorCode::processDenied);
        request.cleanup = true;
      }
    }
    closeCpuPreparationResources(request);
    return Json::Object{{"version", 1}, {"requestId", request.request.at("requestId")},
      {"inventorySha256", request.request.at("binding").at("inventorySha256")}, {"state", "retired"}, {"job", "confirmed"}, {"gpu", "not-required"}};
  }
  void closeCpuPreparationResources(CpuPrepareRequest& request) {
    require(request.cleanup && request.reportToken.empty() && request.waits.load() == 0, ErrorCode::processDenied);
    for (auto* handle : {&request.ready, &request.start, &request.result, &request.node, &request.guiProcess}) mmstorechild::closeOwned(handle->value);
    request.resourcesClosed = true;
  }
  Json dispatchGuiCpu(const mmstore::ProcessIdentity& gui, HANDLE process, const Json& command) {
    const auto id = command.at("requestId").string(), action = command.at("action").string();
    std::shared_ptr<CpuPrepareRequest> request;
    std::optional<CpuWait> waiting;
    if (action == "cpu_launch") {
      const auto originalRequest = decodeStoreCpuMediaRequest(command.at("request"));
      {
        std::lock_guard lock(lifetimeMutex_);
        require(!ending_ && published_ && benchmarkRequestsClosed() && cpuPreparing_.size() < 4096 && !cpuPreparing_.contains(id) && !preparing_.contains(id) &&
          !owned_.contains(Role::prepare) && std::none_of(preparing_.begin(), preparing_.end(), [](const auto& item) { return !item.second->cleanup.load(); }) &&
          std::none_of(cpuPreparing_.begin(), cpuPreparing_.end(), [](const auto& item) { return !item.second->cleanup.load() || !item.second->reportToken.empty() || (!item.second->issued && !item.second->resourcesClosed); }) &&
          matchesBinding(originalRequest) && originalRequest.at("configuration").at("helperSha256").string() == issuer_->code_.nativeHelperPin().sha256, ErrorCode::processDenied);
        issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
        request = std::make_shared<CpuPrepareRequest>(); request->request = originalRequest; request->wireRequest = command.at("request"); request->gui = gui;
        // Publish the request before acquiring any process/event handle. A
        // partial launch stays owned and blocks another Prepare admission.
        cpuPreparing_.emplace(id, request);
        duplicateOwned(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, request->guiProcess);
        request->ready.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); require(request->ready.valid(), ErrorCode::processDenied);
        request->start.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); require(request->start.valid(), ErrorCode::processDenied);
        request->result.value = CreateEventW(nullptr, TRUE, FALSE, nullptr); require(request->result.valid(), ErrorCode::processDenied);
      }
      (void)launch(Role::prepare, request.get(), true); std::lock_guard lock(lifetimeMutex_); return request->launch;
    }
    {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && published_, ErrorCode::processDenied);
      const auto found = cpuPreparing_.find(id); require(found != cpuPreparing_.end() && mmstore::detail::sameIdentity(found->second->gui, gui), ErrorCode::processDenied); request = found->second;
      if (action == "cpu_recover") {
        require(mm::dump(request->request) == mm::dump(decodeStoreCpuMediaRequest(command.at("request"))) &&
          request->wireRequest.at("configuration_json").string() == command.at("request").at("configuration_json").string(), ErrorCode::processDenied);
        if (!request->issued) return retirePartialCpuPreparation(*request);
        return request->launch;
      }
      require(request->issued && mm::dump(request->launch) == mm::dump(command.at("launch")), ErrorCode::processDenied);
      if (action == "cpu_cancel") {
        issuer_->code_.revalidateCleanupIdentity(); issuer_->self_.revalidate(); data_.revalidate(); cleanupCpuPreparation(*request); request->cancelled = true;
        auto response = request->launch.object(); response.emplace("job", "confirmed"); response.emplace("gpu", "not-required"); return response;
      }
      require(!request->cleanup && (action == "cpu_wait" || request->failure.empty()), ErrorCode::processDenied);
      if (action == "cpu_start") {
        const auto node = owned_.find(Role::prepare); require(node != owned_.end() && cpuPreparationForNode(node->second) == request &&
          !std::holds_alternative<std::nullptr_t>(request->expectation.value), ErrorCode::processDenied);
        issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate(); liveControlProcess(request->guiProcess.value, request->gui);
        const auto row = cpuOperations_.find(request->expectation.at("incarnation").string()); require(row != cpuOperations_.end() && row->second.admitted && !row->second.retired &&
          mm::dump(row->second.expectation) == mm::dump(request->expectation) && row->second.metadata, ErrorCode::processDenied);
        liveControlProcess(row->second.metadataProcess.value, *row->second.metadata);
        require(SetEvent(request->start.value) != FALSE, ErrorCode::processDenied); request->started = true;
        auto response = request->launch.object(); response.emplace("started", true); return response;
      }
      require(action == "cpu_ready" || (action == "cpu_wait" && request->started), ErrorCode::processDenied);
      waiting.emplace(request);
    }
    HANDLE watched[]{action == "cpu_ready" ? request->ready.value : request->result.value, request->node.value, request->guiProcess.value, endingEvent_.value};
    const auto ended = WaitForMultipleObjects(4, watched, FALSE, 25000);
    require(ended == WAIT_TIMEOUT || ended == WAIT_OBJECT_0 || ended == WAIT_OBJECT_0 + 1, ErrorCode::processDenied);
    std::lock_guard lock(lifetimeMutex_); require(!ending_ && !request->cleanup, ErrorCode::processDenied);
    issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate(); liveControlProcess(request->guiProcess.value, request->gui);
    auto response = request->launch.object();
    if (ended == WAIT_TIMEOUT) { response.emplace("state", "waiting"); return response; }
    if (action == "cpu_ready") {
      require(request->failure.empty() && !std::holds_alternative<std::nullptr_t>(request->expectation.value), ErrorCode::processDenied);
      const auto node = owned_.find(Role::prepare); require(node != owned_.end() && cpuPreparationForNode(node->second) == request &&
        WaitForSingleObject(node->second.process.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
      const auto row = cpuOperations_.find(request->expectation.at("incarnation").string()); require(row != cpuOperations_.end() && row->second.admitted && !row->second.retired &&
        mm::dump(row->second.expectation) == mm::dump(request->expectation) && row->second.metadata, ErrorCode::processDenied);
      liveControlProcess(row->second.metadataProcess.value, *row->second.metadata);
      response.emplace("state", "ready"); response.emplace("expectation", request->expectation); return response;
    }
    if (!request->failure.empty() || (ended == WAIT_OBJECT_0 + 1 && std::holds_alternative<std::nullptr_t>(request->summary.value))) {
      response.emplace("state", "failed"); response.emplace("errorCode", request->failure.empty() ? "OPERATION_FAILED" : request->failure); return response;
    }
    require(!std::holds_alternative<std::nullptr_t>(request->summary.value), ErrorCode::processDenied);
    response.emplace("state", "completed"); response.emplace("result", request->summary); return response;
  }
  bool matchesBinding(const Json& request) {
    const auto& binding = request.at("binding"); const auto manifest = issuer_->code_.runtimeManifestPin();
    return mm::dump(binding.at("package")) == mm::dump(storeObservation(issuer_->code_.observation())) && binding.at("inventorySha256").string() == issuer_->code_.inventorySha256() &&
      binding.at("runtimeManifestSha256").string() == manifest.sha256 && binding.at("sid").string() == utf8(issuer_->creator().sid) && binding.at("bootIdentity").string() == consumerBootIdentity().at("boot_id").string();
  }
  Json dispatchGui(std::shared_ptr<StoreRoleIssuer::GuiClient> client, const Json& command) {
    require(static_cast<bool>(client), ErrorCode::processDenied); const auto gui = client->parent.identity(); const auto process = client->parent.handle();
    require(storeCreatorGuiCommand(command), ErrorCode::processDenied); const auto id = command.at("requestId").string(), action = command.at("action").string();
    require(!client->browser || action == "session_forward" || action == "session_forward_ack", ErrorCode::processDenied);
    if (action == "cpu_operation_forget" || action == "cpu_operation_release") {
      std::lock_guard lock(lifetimeMutex_); issuer_->code_.revalidateCleanupIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      if (action == "cpu_operation_release") { client->completedCpuForget.release(command.at("expectation"), command.at("requestId").string()); return Json::Object{{"released", true}}; }
      return forgetCpuOperation(command.at("expectation"), command.at("requestId").string(), client->completedCpuForget);
    }
    if (action == "cpu_operation_inspect") {
      std::lock_guard lock(lifetimeMutex_); issuer_->code_.revalidateCleanupIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      const auto& expected = command.at("expectation");
      const auto row = cpuOperations_.find(expected.at("incarnation").string());
      require(row != cpuOperations_.end() && mm::dump(row->second.expectation) == mm::dump(expected), ErrorCode::processDenied);
      return Json::Object{{"retired", row->second.retired}};
    }
    if (action == "session_forward") return waitControl(enqueueControl(Role::session, Role::session, true, id, command.at("payload_base64").string(), gui, process, client));
    if (action == "session_forward_ack") return acknowledgeControl(id, gui, process);
    { std::lock_guard lock(lifetimeMutex_); assertPublication(); }
    if (action == "fleet_owner" || action == "fleet_peer") {
      std::lock_guard lock(lifetimeMutex_); require(!ending_ && published_, ErrorCode::processDenied);
      issuer_->code_.revalidateOperationIdentity(); issuer_->self_.revalidate(); data_.revalidate();
      const auto owned = owned_.find(Role::fleet);
      if (action == "fleet_owner" && owned == owned_.end()) return Json::Object{{"version", 1}, {"inventorySha256", issuer_->code_.inventorySha256()}, {"owner", nullptr}};
      if (owned == owned_.end()) return Json::Object{{"owned", false}};
      auto& role = owned->second;
      require(role.resumed && !role.issuerRetired && !role.treeRetired && role.process.valid() && role.job.valid(), ErrorCode::processDenied);
      liveControlProcess(role.process.value, mmstore::detail::processIdentity(role.process.value));
      detail::requireKillJob(role.job.value); detail::requireMember(role.process.value, role.job.value);
      std::lock_guard issuerLock(issuer_->mutex_); const auto node = issuer_->nodes_.find(Role::fleet);
      require(node != issuer_->nodes_.end() && node->second.bound && CompareObjectHandles(node->second.process.handle(), role.process.value) && CompareObjectHandles(node->second.job.get(), role.job.value), ErrorCode::processDenied);
      node->second.process.revalidate(); node->second.plan.revalidateOperationIdentity();
      const auto owner = publicOwner(ownerRecord(Role::fleet, role));
      if (action == "fleet_owner") return Json::Object{{"version", 1}, {"inventorySha256", issuer_->code_.inventorySha256()}, {"owner", owner}};
      if (mm::dump(command.at("owner")) != mm::dump(owner)) return Json::Object{{"owned", false}};
      const auto& peer = command.at("identity");
      if (mm::dump(peer) == mm::dump(owner.at("identity"))) return Json::Object{{"owned", true}};
      const auto helper = issuer_->helpers_.find(pid(peer.at("pid")));
      if (helper == issuer_->helpers_.end() || !helper->second.bound || helper->second.node != node->second.process.identity().pid) return Json::Object{{"owned", false}};
      helper->second.process.revalidate(); detail::requireMember(helper->second.process.handle(), role.job.value);
      return Json::Object{{"owned", mm::dump(peer) == mm::dump(publicIdentity(StoreRoleIssuer::wireIdentity(helper->second.process.identity())))}};
    }
    if (action.starts_with("benchmark_"))return dispatchGuiBenchmark(gui,process,command);
    if (action.starts_with("cpu_")) return dispatchGuiCpu(gui, process, command);
    if (action == "prepare_launch") {
      std::shared_ptr<PrepareRequest> request;
      { std::lock_guard lock(lifetimeMutex_); require(!ending_ && published_ && benchmarkRequestsClosed() && preparing_.size() < 4096 && !preparing_.contains(id) && !owned_.contains(Role::prepare) &&
          std::none_of(preparing_.begin(), preparing_.end(), [](const auto& item) { return !item.second->cleanup.load(); }) &&
          std::none_of(cpuPreparing_.begin(), cpuPreparing_.end(), [](const auto& item) { return !item.second->cleanup.load() || !item.second->reportToken.empty() || (!item.second->issued && !item.second->resourcesClosed); }) && matchesBinding(command.at("request")), ErrorCode::processDenied);
        issuer_->code_.revalidateOperationIdentity(); data_.revalidate();
        bool selected = false; for (const auto& gpu : gpuInventory()) if (mm::dump(gpu) == mm::dump(command.at("request").at("gpu"))) selected = true; require(selected, ErrorCode::processDenied);
        request = std::make_shared<PrepareRequest>(); request->request = command.at("request"); request->gui = gui; request->guiProcess = inheritedCopy(process, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); preparing_.emplace(id, request);
      }
      (void)launch(Role::prepare, request.get()); std::lock_guard lock(lifetimeMutex_); return request->launch;
    }
    std::shared_ptr<PrepareRequest> request;
    { std::lock_guard lock(lifetimeMutex_); require(!ending_ && published_, ErrorCode::processDenied); const auto found = preparing_.find(id); require(found != preparing_.end() && mmstore::detail::sameIdentity(found->second->gui, gui), ErrorCode::processDenied); request = found->second;
      if (action == "prepare_recover") { require(mm::dump(request->request) == mm::dump(command.at("request")) && !std::holds_alternative<std::nullptr_t>(request->launch.value), ErrorCode::processDenied); return request->launch; }
      require(mm::dump(request->launch) == mm::dump(command.at("launch")), ErrorCode::processDenied);
    }
    if (action == "prepare_wait" && !request->cleanup) {
      HANDLE watched[]{request->node.value, request->guiProcess.value, endingEvent_.value}; const auto ended = WaitForMultipleObjects(3, watched, FALSE, 25000);
      if (ended == WAIT_TIMEOUT) { auto waiting = request->launch.object(); waiting.emplace("state", "waiting"); return waiting; }
      require(ended == WAIT_OBJECT_0 || ended == WAIT_OBJECT_0 + 1, ErrorCode::processDenied);
      if (ended == WAIT_OBJECT_0 + 1) { std::lock_guard lock(lifetimeMutex_); cleanupPreparation(*request); mmstore::fail(ErrorCode::processDenied); }
    }
    std::lock_guard lock(lifetimeMutex_); require(!ending_, ErrorCode::processDenied); if (action == "prepare_cancel") issuer_->code_.revalidateCleanupIdentity(); else issuer_->code_.revalidateOperationIdentity(); data_.revalidate();
    cleanupPreparation(*request);
    if (action == "prepare_cancel") { request->cancelled = true; auto result = request->launch.object(); result.emplace("job", "confirmed"); result.emplace("gpu", "confirmed"); return result; }
    DWORD exit = 2; require(GetExitCodeProcess(request->node.value, &exit) != FALSE && exit != STILL_ACTIVE, ErrorCode::processDenied);
    if (exit != 0 || request->cancelled) {
      const auto failure = request->cancelled ? "PREPARE_INTERRUPTED" : request->failure.empty() ? "OPERATION_FAILED" : request->failure;
      require(storePrepareFailure(failure), ErrorCode::processDenied);
      auto result = request->launch.object(); result.emplace("state", "failed"); result.emplace("errorCode", failure); return result;
    }
    require(request->failure.empty() && !std::holds_alternative<std::nullptr_t>(request->raw.value), ErrorCode::processDenied);
    auto result = request->launch.object(); result.emplace("operation", request->request.at("operation")); result.emplace("bootIdentity", request->request.at("binding").at("bootIdentity")); result.emplace("raw", request->raw);
    auto response = request->launch.object(); response.emplace("state", "completed"); response.emplace("result", std::move(result)); return response;
  }
  void cleanupPreparation(PrepareRequest& request) {
    if (request.cleanup) return;
    require(!std::holds_alternative<std::nullptr_t>(request.nativeOwner.value), ErrorCode::processDenied);
    const auto found = owned_.find(Role::prepare);
    if (found != owned_.end()) {
      require(ownerMatches(Role::prepare, found->second, request.nativeOwner), ErrorCode::processDenied);
      if (!found->second.resumed) { retireUnresumedPrepare(request, found->second); return; }
      retireRole(Role::prepare, found->second);
    }
    else {
      const auto prior = retired_.find(request.nativeOwner.at("nonce").string());
      require(prior != retired_.end() && mm::dump(prior->second) == mm::dump(request.nativeOwner), ErrorCode::processDenied);
    }
    request.cleanup = true;
  }
  void terminateOwned() noexcept {
    std::lock_guard lock(lifetimeMutex_);
    for (const auto role : {Role::personal, Role::fleet, Role::prepare, Role::session}) {
      const auto found = owned_.find(role); if (found != owned_.end() && found->second.jobCreated && found->second.job.valid()) (void)TerminateJobObject(found->second.job.value, 2);
    }
  }
  bool retireOwned() noexcept {
    std::lock_guard lock(lifetimeMutex_); bool complete = true;
    for (const auto role : {Role::personal, Role::fleet, Role::prepare, Role::session}) {
      const auto found = owned_.find(role); if (found != owned_.end() && !retire(found->second)) complete = false;
    }
    if (complete) for (auto& [incarnation, request] : children_) { (void)incarnation; try { request.child->stop(); request.stopped = true; } catch (...) { complete = false; } }
    if(complete)for(auto& [incarnation,transfer]:transfers_){(void)incarnation;try{if(transfer.child)transfer.child->stop();transfer.stopped=true;}catch(...){complete=false;}}
    if(complete)for(auto& [id,attempt]:fleetAttempts_){(void)id;try{require(fleetAttemptQuiescent(*attempt),ErrorCode::processDenied);attempt->retire();}catch(...){complete=false;}}
    if(complete)for(auto& [id,request]:benchmarking_){(void)id;try{request->cleanup=true;closeBenchmarkResources(*request);}catch(...){complete=false;}}
    if (complete) for (auto& [incarnation, operation] : cpuOperations_) { (void)incarnation; try { retireCpuOperation(operation); } catch (...) { complete = false; } }
    if (complete) for (auto& [id, request] : cpuPreparing_) { (void)id;
      try {
        if (!request->reportToken.empty()) { (void)closePrivateFile(Json::Object{{"token", request->reportToken}}); request->reportToken.clear(); }
        request->cleanup = true; closeCpuPreparationResources(*request);
      } catch (...) { complete = false; }
    }
    if (complete) for (auto& [role, owner] : owned_) { (void)role;
      try {
        for (auto* handle : {&owner.startupInput, &owner.startupWriter, &owner.startupOutput, &owner.startupThread, &owner.guardian, &owner.process, &owner.job}) mmstorechild::closeOwned(handle->value);
        closeStoreJobGuardianStartup(owner.guardianStartup);
        if (owner.gpu) for (auto* handle : {&owner.gpu->keeper, &owner.gpu->release, &owner.gpu->job}) mmstorechild::closeOwned(handle->value);
      } catch (...) { complete = false; }
    }
    return complete;
  }
  Json launch(Role role, PrepareRequest* preparing = nullptr, bool cpuMode = false) {
    std::lock_guard lock(lifetimeMutex_);
    require(!ending_ && role != Role::login && !owned_.contains(role) && owned_.size() < 4 &&
      (role != Role::prepare || preparing) && (!cpuMode || role == Role::prepare), ErrorCode::processDenied);
    if (preparing) {
      require(role == Role::prepare && !preparing->cleanup && !preparing->issued, ErrorCode::processDenied);
      const auto id = preparing->request.at("requestId").string();
      if (cpuMode) { const auto found = cpuPreparing_.find(id); require(found != cpuPreparing_.end() && found->second.get() == preparing, ErrorCode::processDenied); }
      else if(preparing->benchmarkMode){const auto found=benchmarking_.find(id);require(found!=benchmarking_.end() && found->second.get()==preparing,ErrorCode::processDenied);}
      else { const auto found = preparing_.find(id); require(found != preparing_.end() && found->second.get() == preparing, ErrorCode::processDenied); }
    }
    issuer_->self_.revalidate(); data_.revalidate();
    const auto plan = issuer_->code_.heldLaunchPlan(launchKind(role));
    const auto executable = plan.executablePath(), directory = plan.workingDirectory();
    auto prefix = plan.argumentPrefix(); require(prefix.size() == 1, ErrorCode::processDenied);
    auto command = quote(executable) + L" " + quote(prefix.front()) + (cpuMode ? L" --store-cpu" : preparing && preparing->benchmarkMode ? L" --store-benchmark" : L" --store-session");
    const auto nonce = detail::secret();
    NodeOwner owned; owned.nonce = nonce; owned.cpuMode = cpuMode; owned.preparing = preparing;
    // Retain the exact original owner before any kernel acquisition. Failed
    // CreatePipe/CreateProcess/assignment/guardian/ACK phases remain reachable.
    auto& retained = owned_.emplace(role, std::move(owned)).first->second;
    const auto name = roleJobName(std::string(roleName(role)), nonce);
    Security security(L"O:" + issuer_->creator().sid + L"D:P(A;;GA;;;" + issuer_->creator().sid + L")(A;;GA;;;SY)");
    retained.job.value = CreateJobObjectW(&security.attributes, name.c_str()); const auto jobError = GetLastError();
    retained.jobCreated = retained.job.valid() && jobError != ERROR_ALREADY_EXISTS;
    require(retained.jobCreated, ErrorCode::processDenied);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(retained.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, ErrorCode::processDenied);
    SECURITY_ATTRIBUTES pipeSecurity{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    require(CreatePipe(&retained.startupInput.value, &retained.startupWriter.value, &pipeSecurity, 4096) != FALSE &&
      SetHandleInformation(retained.startupWriter.value, HANDLE_FLAG_INHERIT, 0) != FALSE, ErrorCode::processDenied);
    retained.startupOutput.value = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &pipeSecurity, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(retained.startupOutput.valid(), ErrorCode::processDenied);
    SIZE_T bytes = 0; (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    require(bytes > 0, ErrorCode::processDenied); std::vector<BYTE> storage(bytes);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(attributes, 2, 0, &bytes) != FALSE, ErrorCode::processDenied);
    DWORD desktopPolicy = 0;
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } attributesLifetime{attributes};
    HANDLE inherited[]{retained.startupInput.value, retained.startupOutput.value};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != FALSE,
      ErrorCode::processDenied);
    require(mmstoredesktop::apply(attributes, desktopPolicy), ErrorCode::processDenied);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = retained.startupInput.value;
    startup.StartupInfo.hStdOutput = retained.startupOutput.value; startup.StartupInfo.hStdError = retained.startupOutput.value;
    auto environment = filteredEnvironment(plan); PROCESS_INFORMATION process{};
    plan.revalidateFixedAdmission(); data_.revalidate();
    const auto created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      environment.data(), directory.c_str(), &startup.StartupInfo, &process);
    retained.process.value = process.hProcess; retained.startupThread.value = process.hThread;
    require(created != FALSE && retained.process.valid() && retained.startupThread.valid(), ErrorCode::processDenied);
    struct SuspendedChild { NodeOwner* owner; bool running = false; ~SuspendedChild() { if (!running) { if (owner->job.valid()) (void)TerminateJobObject(owner->job.value, 2); if (owner->process.valid()) { (void)TerminateProcess(owner->process.value, 2); (void)WaitForSingleObject(owner->process.value, 5000); } } } } rollback{&retained};
    retained.identity = processIdentity(GetProcessId(retained.process.value));
    const auto owner = Json::Object{{"role", std::string(roleName(role))}, {"nonce", nonce}, {"identity", retained.identity}};
    if (preparing) {
      require(role == Role::prepare, ErrorCode::processDenied); preparing->nativeOwner = owner; duplicateOwned(retained.process.value, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, preparing->node);
      preparing->launch = Json::Object{{"version", 1}, {"requestId", preparing->request.at("requestId")}, {"owner", publicOwner(owner)}, {"inventorySha256", issuer_->code_.inventorySha256()}};
    }
    require(AssignProcessToJobObject(retained.job.value, retained.process.value) != FALSE, ErrorCode::processDenied);
    detail::requireMember(retained.process.value, retained.job.value); detail::requireMember(GetCurrentProcess(), retained.job.value, false);
    const auto capability = issuer_->registerNode(role, retained.process.value, retained.job.value, nonce);
    // Creator is outside the observed Node/processing Job. This independent
    // guardian is born suspended, one-use issuer-bound and acknowledged before
    // any Node instruction executes; no GUI breakaway is involved.
    (void)startIndependentJobGuardian(retained.job.value, retained.process.value, owner, &retained.guardian, &retained.guardianStartup);
    require(retained.guardian.valid(), ErrorCode::processDenied);
    data_.revalidate(); writeOwnershipRecord(owner, retained.guardian.value);
    const auto startupBytes = mm::dump(issuer_->inheritedNodeBootstrap(role, capability)) + "\n";
    require(startupBytes.size() <= 4096, ErrorCode::processDenied); DWORD written = 0;
    require(WriteFile(retained.startupWriter.value, startupBytes.data(), static_cast<DWORD>(startupBytes.size()), &written, nullptr) != FALSE &&
      written == startupBytes.size(), ErrorCode::processDenied);
    for (auto* handle : {&retained.startupWriter, &retained.startupInput, &retained.startupOutput}) mmstorechild::closeOwned(handle->value);
    plan.revalidateFixedAdmission(); issuer_->self_.revalidate(); data_.revalidate();
    require(ResumeThread(retained.startupThread.value) != static_cast<DWORD>(-1), ErrorCode::processDenied);
    retained.resumed = true; rollback.running = true; if (preparing) preparing->issued = true;
    mmstorechild::closeOwned(retained.startupThread.value);
    return ownerRecord(role, retained);
  }
  static bool retire(NodeOwner& owned) noexcept {
    if (owned.treeRetired) return true;
    if (!owned.job.valid()) return true;
    if (!owned.jobCreated) return false;
    if (!TerminateJobObject(owned.job.value, 2)) return false;
    const auto deadline = GetTickCount64() + 10000;
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(owned.job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return false;
      if (accounting.ActiveProcesses == 0) break;
      if (GetTickCount64() >= deadline) return false;
      Sleep(10);
    }
    if (!owned.guardian.valid() || WaitForSingleObject(owned.guardian.value, 10000) != WAIT_OBJECT_0) return false;
    DWORD code = 2; if (!GetExitCodeProcess(owned.guardian.value, &code) || code != 0) return false;
    if (owned.gpu) { code = 2; if (!owned.gpu->keeper.valid() || WaitForSingleObject(owned.gpu->keeper.value, 10000) != WAIT_OBJECT_0 || !GetExitCodeProcess(owned.gpu->keeper.value, &code) || code != 0) return false; }
    owned.treeRetired = true; return true;
  }
  static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM parameter, LPARAM detailValue) {
    if (message == WM_QUERYENDSESSION) return TRUE;
    if (active_ && ((message == WM_ENDSESSION && parameter) ||
        (message == WM_WTSSESSION_CHANGE && parameter == WTS_SESSION_LOGOFF))) {
      active_->ending_ = true;
      if (active_->publishedEvent_.valid()) (void)ResetEvent(active_->publishedEvent_.value);
      active_->terminateOwned();
      (void)SetEvent(active_->endingEvent_.value);
    }
    return DefWindowProcW(window, message, parameter, detailValue);
  }
  void startWindow() {
    windowThread_ = std::thread([this] {
      windowThreadId_ = GetCurrentThreadId();
      WNDCLASSW kind{}; kind.lpfnWndProc = windowProc; kind.hInstance = GetModuleHandleW(nullptr); kind.lpszClassName = L"MusicMuteStoreSessionCreator";
      const auto registered = RegisterClassW(&kind);
      if (!registered) { windowFailed_ = true; (void)SetEvent(windowReady_.value); return; }
      const auto window = CreateWindowExW(0, kind.lpszClassName, L"MusicMute Store Session", WS_OVERLAPPED, 0, 0, 0, 0,
        nullptr, nullptr, kind.hInstance, nullptr);
      if (!window || !WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)) { windowFailed_ = true; (void)SetEvent(windowReady_.value); return; }
      (void)SetEvent(windowReady_.value);
      MSG message{}; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
      (void)WTSUnRegisterSessionNotification(window); (void)DestroyWindow(window);
    });
    require(WaitForSingleObject(windowReady_.value, 5000) == WAIT_OBJECT_0 && !windowFailed_, ErrorCode::processDenied);
  }
  std::unique_ptr<StoreRoleIssuer> issuer_; mmstorenamespace::PrivateNamespaceAuthority data_;
  ::Handle endingEvent_, windowReady_, publishedEvent_; bool published_ = false;
  std::map<std::string, std::shared_ptr<PrepareRequest>> preparing_; std::atomic<bool> ending_{false}, windowFailed_{false};
  std::map<std::string, std::shared_ptr<CpuPrepareRequest>> cpuPreparing_;
  std::mutex lifetimeMutex_; std::map<Role, NodeOwner> owned_; std::map<std::string, Json> retired_;
  std::map<std::string, std::shared_ptr<ControlRequest>> controls_; std::map<Role, ::Handle> controlEvents_;
  std::map<std::string, mmstore::ProcessIdentity> controlAcks_;
  std::optional<mmstore::ProcessIdentity> publisher_; ::Handle publisherProcess_; Json publisherRecord_;
  std::map<std::string, ChildRequest> children_;
  std::map<std::string, CpuOperation> cpuOperations_;
  std::map<std::string,std::shared_ptr<StoreFleetAttemptDirectory>> fleetAttempts_;
  std::map<std::string,TransferRequest> transfers_;
  std::map<std::string,Json> closedFixedStarts_;
  std::thread windowThread_; DWORD windowThreadId_ = 0;
  inline static StoreSessionCreator* active_ = nullptr;
};
} // namespace mmstorerole
