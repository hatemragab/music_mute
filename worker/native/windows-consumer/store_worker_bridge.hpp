#pragma once
// Included by main.cpp's Store bridge after its retained actual bootstrap and
// namespace/role state. No request can reach a legacy mutable-code launcher.
bool storeWorkerBrokerOperation(std::string_view operation) noexcept {
  return operation == "store_benchmark_request" || operation == "store_benchmark_start" || operation == "store_benchmark_read" || operation == "store_benchmark_stop" || operation == "store_benchmark_result" || operation == "store_fleet_workspace_open" || operation == "store_fleet_workspace_recover" || operation == "store_fleet_workspace_inspect" || operation == "store_fleet_workspace_retire" ||
    operation == "store_transfer_start" || operation == "store_transfer_write" || operation == "store_transfer_read" || operation == "store_transfer_stop" || operation == "store_transfer_inspect" || operation == "store_role_launch" || operation == "store_role_stop" ||
    operation == "store_role_inspect" || operation == "store_role_peer" ||
    operation == "store_gpu_acquire" || operation == "store_gpu_release" || operation == "store_gpu_inspect" ||
    operation == "store_gpu_bind" || operation == "store_inference_idle" ||
    operation == "store_session_publish" || operation == "store_session_retire_children" || operation == "store_legacy_worker_conflict" || operation == "store_prepare_request" || operation == "store_prepare_result" ||
    operation == "store_control_request" || operation == "store_control_accept" || operation == "store_control_reply" || operation == "store_control_ack" || operation == "store_control_peer" ||
    operation == "store_cpu_prepare_request" || operation == "store_cpu_prepare_ready" || operation == "store_cpu_prepare_start" || operation == "store_cpu_prepare_result" ||
    operation == "store_cpu_operation_open" || operation == "store_cpu_operation_recover" || operation == "store_cpu_operation_bind_data" || operation == "store_cpu_operation_inspect" || operation == "store_cpu_operation_retire" ||
    operation == "store_tool_start" || operation == "store_tool_read" || operation == "store_tool_stop" ||
    operation == "store_qualification_start" || operation == "store_qualification_read" || operation == "store_qualification_stop" ||
    operation == "store_child_start" || operation == "store_child_read" || operation == "store_child_write" || operation == "store_child_stop" ||
    operation == "store_retained_engine_register" || operation == "store_retained_engine_begin" || operation == "store_retained_engine_complete" ||
    operation == "store_retained_engine_idle" || operation == "store_retained_engine_forget";
}
Json dispatchStoreWorkerBroker(const std::string& operation, const Json& args) {
  if (!storeWorkerBrokerOperation(operation) || !storeBootstrap || !storePrivateNamespace || !storeWorkerRole ||
      storeBootstrap->package.kind() != mmstore::PackageKind::worker || storeBootstrap->parent.role() != mmstore::CodeRole::workerNode)
    fail("PEER_DENIED");
  const bool cleanupOnly = operation == "store_benchmark_stop" || operation == "store_fleet_workspace_recover" || operation == "store_fleet_workspace_inspect" || operation == "store_fleet_workspace_retire" || operation == "store_transfer_stop" || operation == "store_transfer_inspect" || operation == "store_role_stop" || operation == "store_role_inspect" || operation == "store_child_stop" ||
    operation == "store_cpu_operation_recover" || operation == "store_cpu_operation_inspect" || operation == "store_cpu_operation_retire" || operation == "store_tool_stop" || operation == "store_qualification_stop" || operation == "store_gpu_release" || operation == "store_session_retire_children" || operation == "store_control_ack";
  const auto revalidate = [&] { if (cleanupOnly) storeWorkerRole->revalidateCleanup(*storeBootstrap); else storeWorkerRole->revalidate(*storeBootstrap); storePrivateNamespace->revalidate(); };
  revalidate();
  if(operation.starts_with("store_benchmark_")){
    const auto command=operation=="store_benchmark_request"?mmstorerole::BrokerCommand::benchmarkRequest:operation=="store_benchmark_start"?mmstorerole::BrokerCommand::benchmarkStart:
      operation=="store_benchmark_read"?mmstorerole::BrokerCommand::benchmarkRead:operation=="store_benchmark_stop"?mmstorerole::BrokerCommand::benchmarkStop:mmstorerole::BrokerCommand::benchmarkResult;
    if(!mmstorerole::brokerOperation(storeWorkerRole->role(),command,args))fail("BAD_REQUEST");const auto result=storeWorkerRole->broker(*storeBootstrap,command,args);revalidate();return result;
  }
  if (operation.starts_with("store_fleet_workspace_") || operation.starts_with("store_transfer_")) {
    const auto command = operation == "store_fleet_workspace_open" ? mmstorerole::BrokerCommand::fleetWorkspaceOpen : operation == "store_fleet_workspace_recover" ? mmstorerole::BrokerCommand::fleetWorkspaceRecover :
      operation == "store_fleet_workspace_inspect" ? mmstorerole::BrokerCommand::fleetWorkspaceInspect : operation == "store_fleet_workspace_retire" ? mmstorerole::BrokerCommand::fleetWorkspaceRetire :
      operation == "store_transfer_start" ? mmstorerole::BrokerCommand::transferStart : operation == "store_transfer_write" ? mmstorerole::BrokerCommand::transferWrite :
      operation == "store_transfer_read" ? mmstorerole::BrokerCommand::transferRead : operation == "store_transfer_stop" ? mmstorerole::BrokerCommand::transferStop : mmstorerole::BrokerCommand::transferInspect;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(),command,args)) fail("BAD_REQUEST");
    const auto result=storeWorkerRole->broker(*storeBootstrap,command,args); revalidate(); return result;
  }
  if (operation == "store_cpu_prepare_request" || operation == "store_cpu_prepare_ready" || operation == "store_cpu_prepare_start" || operation == "store_cpu_prepare_result") {
    const auto command = operation == "store_cpu_prepare_request" ? mmstorerole::BrokerCommand::cpuPrepareRequest : operation == "store_cpu_prepare_ready" ? mmstorerole::BrokerCommand::cpuPrepareReady :
      operation == "store_cpu_prepare_start" ? mmstorerole::BrokerCommand::cpuPrepareStart : mmstorerole::BrokerCommand::cpuPrepareResult;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args); revalidate(); return result;
  }
  if (operation == "store_cpu_operation_open" || operation == "store_cpu_operation_recover" || operation == "store_cpu_operation_bind_data" || operation == "store_cpu_operation_inspect" || operation == "store_cpu_operation_retire") {
    const auto command = operation == "store_cpu_operation_open" ? mmstorerole::BrokerCommand::cpuOpen : operation == "store_cpu_operation_recover" ? mmstorerole::BrokerCommand::cpuRecover : operation == "store_cpu_operation_bind_data" ? mmstorerole::BrokerCommand::cpuBindData : operation == "store_cpu_operation_inspect" ? mmstorerole::BrokerCommand::cpuInspect : mmstorerole::BrokerCommand::cpuRetire;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args); revalidate(); return result;
  }
  if (operation == "store_qualification_start" || operation == "store_qualification_read" || operation == "store_qualification_stop") {
    const auto command = operation == "store_qualification_start" ? mmstorerole::BrokerCommand::qualificationStart : operation == "store_qualification_read" ? mmstorerole::BrokerCommand::qualificationRead : mmstorerole::BrokerCommand::qualificationStop;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args); revalidate(); return result;
  }
  if (operation == "store_tool_start" || operation == "store_tool_read" || operation == "store_tool_stop") {
    const auto command = operation == "store_tool_start" ? mmstorerole::BrokerCommand::toolStart : operation == "store_tool_read" ? mmstorerole::BrokerCommand::toolRead : mmstorerole::BrokerCommand::toolStop;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args);
    revalidate(); return result;
  }
  if (operation == "store_child_start" || operation == "store_child_read" || operation == "store_child_write" || operation == "store_child_stop") {
    const auto command = operation == "store_child_start" ? mmstorerole::BrokerCommand::childStart : operation == "store_child_read" ? mmstorerole::BrokerCommand::childRead :
      operation == "store_child_write" ? mmstorerole::BrokerCommand::childWrite : mmstorerole::BrokerCommand::childStop;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args);
    revalidate(); return result;
  }
  if (operation == "store_control_request" || operation == "store_control_accept" || operation == "store_control_reply" || operation == "store_control_ack" || operation == "store_control_peer") {
    const auto command = operation == "store_control_request" ? mmstorerole::BrokerCommand::controlRequest :
      operation == "store_control_accept" ? mmstorerole::BrokerCommand::controlAccept :
      operation == "store_control_reply" ? mmstorerole::BrokerCommand::controlReply : operation == "store_control_ack" ? mmstorerole::BrokerCommand::controlAck : mmstorerole::BrokerCommand::controlPeer;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args);
    revalidate(); return result;
  }
  if (operation == "store_legacy_worker_conflict") {
    // Observation only. The fixed legacy process census cannot launch, stop or
    // authorize code, and is available only to the actual held Session Node.
    if (!mmstorerole::sessionReadonlyInspection(storeWorkerRole->role(), args)) fail("BAD_REQUEST");
    const auto result = legacyWorkerConflict();
    revalidate(); return result;
  }
  if (operation == "store_session_publish" || operation == "store_session_retire_children" || operation == "store_prepare_request" || operation == "store_prepare_result") {
    const auto command = operation == "store_session_publish" ? mmstorerole::BrokerCommand::sessionPublish : operation == "store_session_retire_children" ? mmstorerole::BrokerCommand::sessionRetire : operation == "store_prepare_request" ? mmstorerole::BrokerCommand::prepareRequest : mmstorerole::BrokerCommand::prepareResult;
    if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
    if (command == mmstorerole::BrokerCommand::sessionPublish) {
      const auto lease = ownedMutexes.find("session"); if (lease == ownedMutexes.end() || !lease->second.handle.valid()) fail("PEER_DENIED");
      assertPrivateMutex(lease->second.handle.value); assertSingletonPublication("session");
      const auto record = singletonRecord("session"); if (std::holds_alternative<std::nullptr_t>(record.value) || record.at("nonce").string() != lease->second.nonce || mm::dump(record.at("helper")) != mm::dump(storeProcess(storeBootstrap->self.identity())) || mm::dump(record.at("owner")) != mm::dump(storeProcess(storeBootstrap->parent.identity()))) fail("PEER_DENIED");
    }
    const auto result = storeWorkerRole->broker(*storeBootstrap, command, args); revalidate(); return result;
  }
  const auto boundOwner = Json::Object{{"role", std::string(mmstorerole::roleName(storeWorkerRole->role()))}, {"nonce", storeWorkerRole->ownerNonce()}, {"identity", processIdentity(storeWorkerRole->nodeIdentity().pid)}};
  const auto ensureBinding = [&] {
    if (!mmstorerole::gpuLeaseRole(storeWorkerRole->role())) fail("PEER_DENIED");
    const auto admitted = storeWorkerRole->broker(*storeBootstrap, mmstorerole::BrokerCommand::gpuAdmit, Json::Object{});
    keys(admitted, {"admitted"}); if (!std::get<bool>(admitted.at("admitted").value)) fail("PEER_DENIED");
    if (boundGpuRole) { if (mm::dump(boundGpuRole->owner) != mm::dump(boundOwner)) fail("PEER_DENIED"); return; }
    auto actual = std::make_unique<BoundGpuRole>(); actual->job = inheritedCopy(storeWorkerRole->jobHandle(), 0, true);
    actual->process = inheritedCopy(storeBootstrap->parent.handle(), PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE);
    actual->rootController = inheritedCopy(storeWorkerRole->creatorHandle(), SYNCHRONIZE); actual->owner = boundOwner; boundGpuRole = std::move(actual);
  };
  if (operation == "store_gpu_bind") { keys(args, {}); ensureBinding(); return Json::Object{{"bound", true}}; }
  if (operation == "store_inference_idle") { keys(args, {}); ensureBinding(); return Json::Object{{"idle", gpuRoleIdle(boundGpuRole->job.value, boundGpuRole->owner)}}; }
  if (operation.starts_with("store_retained_engine_")) {
    ensureBinding(); if (storeWorkerRole->role() != mmstorerole::Role::personal || gpuGuards.size() != 1) fail("PEER_DENIED");
    const auto& proxy = gpuGuards.begin()->second; if (!proxy.storeProxy || !proxy.storeKeeper) fail("GPU_GUARD_UNSAFE");
    proxy.storeKeeper->revalidate();
    const auto held = storeWorkerRole->broker(*storeBootstrap, mmstorerole::BrokerCommand::gpuInspect, Json::Object{{"luid", gpuGuards.begin()->first}, {"nonce", proxy.nonce}});
    keys(held, {"held"}); if (!std::get<bool>(held.at("held").value)) fail("GPU_GUARD_UNSAFE");
    if (operation == "store_retained_engine_register") { keys(args, {"guardian", "engine"}); return registerRetainedEngine(args); }
    if (operation == "store_retained_engine_begin") { keys(args, {"token", "job_id"}); return beginRetainedEngine(args); }
    if (operation == "store_retained_engine_complete") { keys(args, {"token", "job_id"}); return completeRetainedEngine(args); }
    if (operation == "store_retained_engine_idle") { keys(args, {"token"}); return inspectRetainedEngine(args); }
    keys(args, {"token"}); return forgetRetainedEngine(args);
  }
  const auto command = operation == "store_role_launch" ? mmstorerole::BrokerCommand::launch :
    operation == "store_role_stop" ? mmstorerole::BrokerCommand::stop :
    operation == "store_role_inspect" ? mmstorerole::BrokerCommand::inspect :
    operation == "store_role_peer" ? mmstorerole::BrokerCommand::peer :
    operation == "store_gpu_acquire" ? mmstorerole::BrokerCommand::gpuAcquire :
    operation == "store_gpu_release" ? mmstorerole::BrokerCommand::gpuRelease : mmstorerole::BrokerCommand::gpuInspect;
  if (!mmstorerole::brokerOperation(storeWorkerRole->role(), command, args)) fail("BAD_REQUEST");
  if (command == mmstorerole::BrokerCommand::gpuAcquire) { ensureBinding(); if (!gpuGuards.empty()) fail("GPU_GUARD_UNSAFE"); }
  if (command == mmstorerole::BrokerCommand::gpuRelease || command == mmstorerole::BrokerCommand::gpuInspect) {
    const auto proxy = gpuGuards.find(args.at("luid").string());
    if (proxy == gpuGuards.end() || !proxy->second.storeProxy || !proxy->second.storeKeeper || !mmstorerole::sameSecret(proxy->second.nonce, args.at("nonce").string())) fail("GPU_GUARD_UNSAFE");
    proxy->second.storeKeeper->revalidate();
  }
  const auto result = storeWorkerRole->broker(*storeBootstrap, command, args);
  if (command == mmstorerole::BrokerCommand::gpuAcquire) {
    if (!std::get<bool>(result.at("acquired").value)) { keys(result, {"acquired"}); return result; }
    keys(result, {"acquired", "luid", "nonce", "gpu", "abandoned", "keeper"});
    if (std::get<bool>(result.at("abandoned").value) || mm::dump(result.at("gpu")) != mm::dump(args.at("gpu")) || !mmstore::validDigest(result.at("nonce").string())) fail("GPU_GUARD_UNSAFE");
    const auto& expected = result.at("keeper"); if (!mmstorerole::data_policy::identity(expected)) fail("GPU_GUARD_UNSAFE");
    mmstore::detail::Handle keeperProcess(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(expected.at("pid").integer())));
    if (!keeperProcess.valid()) fail("GPU_GUARD_UNSAFE");
    const auto actualKeeper = mmstore::detail::processIdentity(keeperProcess.get());
    if (expected.at("sid").string() != mmstorerole::detail::ascii(actualKeeper.sid) || expected.at("session_id").integer() != actualKeeper.sessionId || expected.at("creation_time").string() != mmstorerole::detail::ascii(actualKeeper.creationTime)) fail("GPU_GUARD_UNSAFE");
    OwnedGpuGuard guard; guard.storeKeeper.emplace(storeWorkerRole->attestGpuKeeper(actualKeeper));
    guard.keeper = inheritedCopy(guard.storeKeeper->handle(), PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE); guard.job = inheritedCopy(storeWorkerRole->jobHandle(), 0, true);
    guard.nonce = result.at("nonce").string(); guard.identity = processIdentity(GetCurrentProcessId()); guard.gpu = result.at("gpu"); guard.roleBound = true; guard.storeProxy = true;
    const auto luid = result.at("luid").string(); if (luid != guard.gpu.at("luid").string() || !mmstorerole::validGpuLuid(luid)) fail("GPU_GUARD_UNSAFE");
    const auto admitted = Json::Object{{"acquired", true}, {"luid", luid}, {"nonce", guard.nonce}, {"identity", guard.identity}, {"gpu", guard.gpu}, {"abandoned", false}};
    gpuGuards.emplace(luid, std::move(guard)); return admitted;
  }
  if (command == mmstorerole::BrokerCommand::gpuRelease || command == mmstorerole::BrokerCommand::gpuInspect) {
    const auto proxy = gpuGuards.find(args.at("luid").string());
    if (proxy == gpuGuards.end() || !proxy->second.storeProxy || !proxy->second.storeKeeper || !mmstorerole::sameSecret(proxy->second.nonce, args.at("nonce").string())) fail("GPU_GUARD_UNSAFE");
    if (command == mmstorerole::BrokerCommand::gpuRelease) { keys(result, {"released"}); if (!std::get<bool>(result.at("released").value)) fail("GPU_GUARD_UNSAFE"); gpuGuards.erase(proxy); }
    else { keys(result, {"held"}); if (std::get<bool>(result.at("held").value)) proxy->second.storeKeeper->revalidate(); }
  }
  revalidate(); return result;
}
