#pragma once
// Included only inside StoreSessionCreator's private implementation. All rows
// below belong to the living genuine Creator; no receiving DTO can mint them.
struct BenchmarkWaitOwner { ::Handle node,gui;std::atomic<bool> waiting{false}; };
struct BenchmarkPrepareRequest : PrepareRequest {
  Json wireRequest;std::string reportToken,summaryJson;bool resourcesClosed=false;
  std::vector<std::shared_ptr<BenchmarkWaitOwner>> waits;
};
std::map<std::string,std::shared_ptr<BenchmarkPrepareRequest>> benchmarking_;
bool benchmarkRequestsClosed() const {
  return std::none_of(benchmarking_.begin(),benchmarking_.end(),[](const auto& item){return !item.second->cleanup || !item.second->reportToken.empty() || !item.second->resourcesClosed;});
}
std::shared_ptr<BenchmarkPrepareRequest> benchmarkForNode(const NodeOwner& node) {
  require(node.preparing && node.preparing->benchmarkMode && !node.cpuMode,ErrorCode::processDenied);
  const auto found=std::find_if(benchmarking_.begin(),benchmarking_.end(),[&](const auto& row){return row.second.get()==node.preparing && !row.second->cleanup &&
    !std::holds_alternative<std::nullptr_t>(row.second->nativeOwner.value) && ownerMatches(Role::prepare,node,row.second->nativeOwner);});
  require(found!=benchmarking_.end(),ErrorCode::processDenied);return found->second;
}
void closeBenchmarkResources(BenchmarkPrepareRequest& request) {
  require(request.cleanup,ErrorCode::processDenied);
  if(!request.reportToken.empty()){(void)closePrivateFile(Json::Object{{"token",request.reportToken}});request.reportToken.clear();}
  for(auto& wait:request.waits){require(!wait->waiting,ErrorCode::processDenied);mmstorechild::closeOwned(wait->node.value);mmstorechild::closeOwned(wait->gui.value);}
  for(auto* handle:{&request.node,&request.guiProcess})mmstorechild::closeOwned(handle->value);request.resourcesClosed=true;
}
Json retirePartialBenchmark(BenchmarkPrepareRequest& request) {
  require(!request.issued,ErrorCode::processDenied);
  if(!request.cleanup){const auto node=owned_.find(Role::prepare);if(node!=owned_.end())retireUnresumedPrepare(request,node->second);
    else {require(std::holds_alternative<std::nullptr_t>(request.nativeOwner.value) && !request.node.valid(),ErrorCode::processDenied);request.cleanup=true;}}
  closeBenchmarkResources(request);
  return Json::Object{{"version",1},{"requestId",request.request.at("requestId")},{"inventorySha256",request.request.at("binding").at("inventorySha256")},{"state","retired"},{"job","confirmed"},{"gpu","confirmed"}};
}
void holdBenchmarkResult(BenchmarkPrepareRequest& request,const Json& args) {
  const auto size=args.at("rawBytes").integer();require(size>=2 && size<=8LL*1024*1024 && request.reportToken.empty(),ErrorCode::processDenied);
  const auto relative="prepare\\results\\"+request.request.at("requestId").string()+".benchmark.raw.json";
  (void)StoreEngineChild::holdFile(relative,8LL*1024*1024,&request.reportToken);auto& file=privateFileCapability(Json::Object{{"token",request.reportToken}});
  const auto before=validatePrivateFileCapability(file);require(before.at("bytes").integer()==size && hashFile(file.file.value,8LL*1024*1024)==args.at("rawSha256").string(),ErrorCode::digestMismatch);
  require(mm::dump(validatePrivateFileCapability(file))==mm::dump(before),ErrorCode::fileDenied);
  // Only this bounded numeric carrier contains fractional elapsed time. The
  // ordinary Native/Creator frames keep their original integer-only grammar.
  request.summaryJson="{\"configurationSha256\":\""+args.at("configurationSha256").string()+"\",\"rawBytes\":"+std::to_string(size)+",\"rawSha256\":\""+args.at("rawSha256").string()+"\",\"wallSeconds\":"+args.at("wallSeconds_json").string()+"}";
}
Json dispatchBenchmark(Role actor,BrokerCommand command,const Json& args) {
  std::shared_ptr<StoreEngineChild> child;
  {std::lock_guard lock(lifetimeMutex_);require(!ending_ && actor==Role::prepare,ErrorCode::processDenied);
    if(command==BrokerCommand::benchmarkStop)issuer_->code_.revalidateCleanupIdentity();else issuer_->code_.revalidateOperationIdentity();issuer_->self_.revalidate();data_.revalidate();
    const auto owner=owned_.find(actor);require(owner!=owned_.end(),ErrorCode::processDenied);auto& held=owner->second;
    const auto preparing=benchmarkForNode(held);
    if(command==BrokerCommand::benchmarkRequest){liveControlProcess(preparing->guiProcess.value,preparing->gui);return preparing->wireRequest;}
    if(command==BrokerCommand::benchmarkResult){require(args.at("requestId").string()==preparing->request.at("requestId").string() && preparing->failure.empty() && preparing->summaryJson.empty(),ErrorCode::processDenied);
      require(std::none_of(children_.begin(),children_.end(),[&](const auto& row){return sameSecret(row.second.child->ownerNonce_,held.nonce) && !row.second.stopped;}),ErrorCode::processDenied);
      if(args.object().contains("errorCode")){preparing->failure=args.at("errorCode").string();return Json::Object{{"accepted",true}};}
      require(held.gpu && WaitForSingleObject(held.gpu->keeper.value,0)==WAIT_TIMEOUT && WaitForSingleObject(held.gpu->release.value,0)==WAIT_TIMEOUT,ErrorCode::processDenied);
      const auto original=std::find_if(children_.begin(),children_.end(),[&](const auto& row){return row.second.child->benchmark_ && sameSecret(row.second.child->ownerNonce_,held.nonce);});
      require(original!=children_.end() && original->second.started && original->second.stopped && args.at("configurationSha256").string()==original->second.child->benchmarkConfigurationSha_,ErrorCode::processDenied);
      holdBenchmarkResult(*preparing,args);return Json::Object{{"accepted",true}};
    }
    if(command==BrokerCommand::benchmarkStop && args.object().contains("incarnation")){const auto incarnation=args.at("incarnation").string();const auto prior=children_.find(incarnation);
      if(prior!=children_.end()){auto& request=prior->second;require(request.child->benchmark_ && sameSecret(request.child->ownerNonce_,held.nonce) && request.relative=="prepare\\work\\"+preparing->request.at("requestId").string()+"\\store-benchmark-config.json",ErrorCode::processDenied);if(!request.stopped){request.child->stop();request.stopped=true;}}
      else rememberUnissuedFixed(incarnation,held.nonce,"benchmark",args);
      return Json::Object{{"job","confirmed"},{"stopped",true}};
    }
    if(command==BrokerCommand::benchmarkStart){const auto incarnation=args.at("incarnation").string();require(!closedFixedStarts_.contains(incarnation),ErrorCode::processDenied);const auto prior=children_.find(incarnation);
      if(prior!=children_.end()){require(prior->second.child->benchmark_ && !prior->second.stopped && sameSecret(prior->second.child->ownerNonce_,held.nonce),ErrorCode::processDenied);return toolStartReply(prior->second);}
      require(children_.size()<4096 && held.gpu && !held.gpu->abandoned && WaitForSingleObject(held.gpu->keeper.value,0)==WAIT_TIMEOUT && WaitForSingleObject(held.gpu->release.value,0)==WAIT_TIMEOUT &&
        std::none_of(children_.begin(),children_.end(),[&](const auto& row){return row.second.child->benchmark_ && sameSecret(row.second.child->ownerNonce_,held.nonce) && !row.second.stopped;}),ErrorCode::processDenied);
      const auto& configuration=preparing->request.at("configuration");require(mm::dump(held.gpu->gpu)==mm::dump(configuration.at("gpu")),ErrorCode::processDenied);
      if(configuration.object().contains("candidate"))require(configuration.at("candidate").at("engineDigest").string()==issuer_->code_.engineDigest(),ErrorCode::digestMismatch);
      std::lock_guard issuerLock(issuer_->mutex_);const auto node=issuer_->nodes_.find(actor);require(node!=issuer_->nodes_.end() && node->second.bound,ErrorCode::processDenied);
      node->second.process.revalidate();node->second.plan.revalidateOperationIdentity();detail::requireMember(node->second.process.handle(),held.job.value);
      const auto kind=preparing->request.at("operation").string()=="benchmark_file"?mmstoreruntime::LaunchKind::benchmarkFile:mmstoreruntime::LaunchKind::benchmarkCapacity;
      auto created=std::shared_ptr<StoreEngineChild>(new StoreEngineChild(issuer_->code_,issuer_->code_.heldLaunchPlan(mmstoreruntime::LaunchKind::pythonGuardian),issuer_->code_.heldLaunchPlan(kind),node->second.process.identity(),held.nonce));
      const auto relative="prepare\\work\\"+preparing->request.at("requestId").string()+"\\store-benchmark-config.json";
      auto& request=children_.emplace(incarnation,ChildRequest{relative,std::move(created),false,false,std::nullopt,{},false,{}}).first->second;
      request.child->benchmark_=true;request.child->retainGpuKeeper(held.gpu->keeper.value,held.gpu->release.value);
      request.child->startBenchmark(preparing->request,preparing->wireRequest.at("configuration_json").string(),held.job.value,node->second.process,node->second.plan,held.gpu->gpu);request.started=true;return toolStartReply(request);
    }
    const auto found=std::find_if(children_.begin(),children_.end(),[&](const auto& row){return row.second.child->benchmark_ && sameSecret(row.second.child->token_,args.at("token").string()) && sameSecret(row.second.child->ownerNonce_,held.nonce);});
    require(found!=children_.end(),ErrorCode::processDenied);auto& request=found->second;child=request.child;
    if(command==BrokerCommand::benchmarkStop){if(!request.stopped){child->stop();request.stopped=true;}return Json::Object{{"job","confirmed"},{"stopped",true}};}
    require(command==BrokerCommand::benchmarkRead && request.started && !request.stopped,ErrorCode::processDenied);
    std::lock_guard issuerLock(issuer_->mutex_);const auto node=issuer_->nodes_.find(actor);require(node!=issuer_->nodes_.end() && node->second.bound,ErrorCode::processDenied);child->revalidate(held.job.value,node->second.process,node->second.plan);
  }
  return child->readTool();
}
Json dispatchGuiBenchmark(const mmstore::ProcessIdentity& gui,HANDLE process,const Json& command) {
  const auto id=command.at("requestId").string(),action=command.at("action").string();std::shared_ptr<BenchmarkPrepareRequest> request;
  if(action=="benchmark_launch") {
    const auto original=decodeStoreBenchmarkRequest(command.at("request"));
    {std::lock_guard lock(lifetimeMutex_);require(!ending_ && published_ && benchmarking_.size()<4096 && !benchmarking_.contains(id) && !owned_.contains(Role::prepare) && benchmarkRequestsClosed() &&
      std::none_of(preparing_.begin(),preparing_.end(),[](const auto& row){return !row.second->cleanup;}) &&
      std::none_of(cpuPreparing_.begin(),cpuPreparing_.end(),[](const auto& row){return !row.second->cleanup || !row.second->resourcesClosed || !row.second->reportToken.empty();}) &&
      matchesBinding(original) && original.at("configuration").at("helperSha256").string()==issuer_->code_.nativeHelperPin().sha256,ErrorCode::processDenied);
      issuer_->code_.revalidateOperationIdentity();issuer_->self_.revalidate();data_.revalidate();bool selected=false;for(const auto& gpu:gpuInventory())if(mm::dump(gpu)==mm::dump(original.at("configuration").at("gpu")))selected=true;require(selected,ErrorCode::processDenied);
      request=std::make_shared<BenchmarkPrepareRequest>();request->benchmarkMode=true;request->request=original;request->wireRequest=command.at("request");request->gui=gui;
      benchmarking_.emplace(id,request);duplicateOwned(process,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,request->guiProcess);
    }
    (void)launch(Role::prepare,request.get());std::lock_guard lock(lifetimeMutex_);return request->launch;
  }
  {std::lock_guard lock(lifetimeMutex_);require(!ending_ && published_,ErrorCode::processDenied);const auto found=benchmarking_.find(id);require(found!=benchmarking_.end() && mmstore::detail::sameIdentity(found->second->gui,gui),ErrorCode::processDenied);request=found->second;
    if(action=="benchmark_recover"){require(mm::dump(request->request)==mm::dump(decodeStoreBenchmarkRequest(command.at("request"))) && request->wireRequest.at("configuration_json").string()==command.at("request").at("configuration_json").string(),ErrorCode::processDenied);
      issuer_->code_.revalidateCleanupIdentity();issuer_->self_.revalidate();data_.revalidate();if(!request->issued)return retirePartialBenchmark(*request);return request->launch;}
    require(request->issued && mm::dump(request->launch)==mm::dump(command.at("launch")),ErrorCode::processDenied);
  }
  if(action=="benchmark_wait" && !request->cleanup) {
    std::shared_ptr<BenchmarkWaitOwner> wait;
    {std::lock_guard lock(lifetimeMutex_);require(!request->cleanup && request->waits.size()<16,ErrorCode::processDenied);wait=std::make_shared<BenchmarkWaitOwner>();request->waits.push_back(wait);
      duplicateOwned(request->node.value,SYNCHRONIZE,wait->node);duplicateOwned(request->guiProcess.value,SYNCHRONIZE,wait->gui);wait->waiting=true;}
    HANDLE watched[]{wait->node.value,wait->gui.value,endingEvent_.value};const auto ended=WaitForMultipleObjects(3,watched,FALSE,25000);wait->waiting=false;
    require(ended==WAIT_TIMEOUT || ended==WAIT_OBJECT_0 || ended==WAIT_OBJECT_0+1,ErrorCode::processDenied);
    {std::lock_guard lock(lifetimeMutex_);mmstorechild::closeOwned(wait->node.value);mmstorechild::closeOwned(wait->gui.value);request->waits.erase(std::remove(request->waits.begin(),request->waits.end(),wait),request->waits.end());}
    if(ended==WAIT_TIMEOUT){auto result=request->launch.object();result.emplace("state","waiting");return result;}
    if(ended==WAIT_OBJECT_0+1){std::lock_guard lock(lifetimeMutex_);cleanupPreparation(*request);closeBenchmarkResources(*request);mmstore::fail(ErrorCode::processDenied);}
  }
  std::lock_guard lock(lifetimeMutex_);require(!ending_,ErrorCode::processDenied);if(action=="benchmark_cancel")issuer_->code_.revalidateCleanupIdentity();else issuer_->code_.revalidateOperationIdentity();issuer_->self_.revalidate();data_.revalidate();
  DWORD exit=2;if(action!="benchmark_cancel")require(request->node.valid() && GetExitCodeProcess(request->node.value,&exit) && exit!=STILL_ACTIVE,ErrorCode::processDenied);
  cleanupPreparation(*request);
  if(action=="benchmark_cancel"){request->cancelled=true;closeBenchmarkResources(*request);auto result=request->launch.object();result.emplace("job","confirmed");result.emplace("gpu","confirmed");return result;}
  auto result=request->launch.object();if(exit!=0 || request->cancelled || !request->failure.empty()){result.emplace("state","failed");result.emplace("errorCode",request->cancelled?"PREPARE_INTERRUPTED":request->failure.empty()?"OPERATION_FAILED":request->failure);return result;}
  require(!request->summaryJson.empty(),ErrorCode::processDenied);result.emplace("state","completed");result.emplace("result_json",request->summaryJson);return result;
}
