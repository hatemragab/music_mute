#pragma once

// A retained personal engine is still inference for physical GPU ownership.
// This separate capability proves only that its exact two Python generations
// have detached the previous attempt. It never changes gpuRoleIdle.
struct RetainedEngine {
  Handle guardian,engine;
  Json owner,guardianIdentity,engineIdentity;
  std::wstring ownerImage,pythonImage,helperImage;
  std::string token,busyJob;
  bool retiring=false;
};
std::unique_ptr<RetainedEngine> retainedEngine;
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
thread_local const char* retainedEngineCensusStage="not-started";
#define MUSICMUTE_RETAINED_CHECK(value) (retainedEngineCensusStage=(value))
#else
#define MUSICMUTE_RETAINED_CHECK(value) ((void)0)
#endif
std::wstring retainedProcessImage(HANDLE process) {
  std::wstring image(32768,L'\0');DWORD count=static_cast<DWORD>(image.size());
  check(QueryFullProcessImageNameW(process,0,image.data(),&count)&&count>0&&count<image.size(),"PEER_DENIED");image.resize(count);return image;
}
Json retainedHandleIdentity(HANDLE process) {
  if(!process||process==INVALID_HANDLE_VALUE||WaitForSingleObject(process,0)!=WAIT_TIMEOUT)fail("PEER_DENIED");
  Handle token;check(OpenProcessToken(process,TOKEN_QUERY,&token.value),"PEER_DENIED");const auto identity=tokenIdentity(token.value);
  return Json::Object{{"sid",identity.sid},{"session_id",static_cast<std::int64_t>(identity.session)},{"pid",static_cast<std::int64_t>(GetProcessId(process))},{"creation_time",creation(process)}};
}
void retainedIdentity(const Json& identity) {
  keys(identity,{"sid","session_id","pid","creation_time"});const auto pid=identity.at("pid").integer(),session=identity.at("session_id").integer();const auto birth=identity.at("creation_time").string();
  if(pid<1||pid>2147483647||session<1||session>0xffffffffLL||birth.empty()||birth.size()>20||birth.front()=='0'||birth.find_first_not_of("0123456789")!=std::string::npos)fail("BAD_REQUEST");
  try{if(std::to_string(std::stoull(birth))!=birth)fail("BAD_REQUEST");}catch(...){fail("BAD_REQUEST");}
  const auto own=currentIdentity();if(identity.at("sid").string()!=own.sid||session!=own.session)fail("PEER_DENIED");
}
std::wstring retainedPythonImage(const std::wstring& nodeImage) {
  const std::wstring suffix=L"\\runtime\\node\\node.exe";
  if(nodeImage.size()<=suffix.size()||_wcsicmp(nodeImage.c_str()+nodeImage.size()-suffix.size(),suffix.c_str())!=0)fail("PEER_DENIED");
  return nodeImage.substr(0,nodeImage.size()-suffix.size())+L"\\runtime\\python\\python.exe";
}
bool retainedGpuGuardHeld(){
  try{if(gpuGuards.size()!=1)return false;const auto& guard=gpuGuards.begin()->second;if(guard.storeProxy){if(!guard.storeKeeper)return false;guard.storeKeeper->revalidate();}return guard.roleBound&&guard.keeper.valid()&&WaitForSingleObject(guard.keeper.value,0)==WAIT_TIMEOUT&&mm::dump(guard.identity)==mm::dump(processIdentity(GetCurrentProcessId()));}catch(...){return false;}
}
void assertRetainedOwner() {
  if(!boundGpuRole||boundGpuRole->owner.at("role").string()!="personal")fail("JOB_NOT_OWNED");
  if(mm::dump(retainedHandleIdentity(boundGpuRole->process.value))!=mm::dump(boundGpuRole->owner.at("identity"))||mm::dump(parentBinding(processIdentity(GetCurrentProcessId())).parent)!=mm::dump(boundGpuRole->owner.at("identity")))fail("PEER_DENIED");
  if(!retainedGpuGuardHeld())fail("GPU_GUARD_UNSAFE");
}
bool retainedEngineCensus(HANDLE job,const RetainedEngine& cache) {
  try{
    MUSICMUTE_RETAINED_CHECK("retiring");
    if(cache.retiring)return false;
    const auto& owner=cache.owner.at("identity");
    MUSICMUTE_RETAINED_CHECK("owner-birth");
    if(mm::dump(processIdentity(static_cast<DWORD>(owner.at("pid").integer())))!=mm::dump(owner))return false;
    Handle ownerHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(owner.at("pid").integer())));
    MUSICMUTE_RETAINED_CHECK("owner-held-birth-image");
    if(!ownerHandle.valid()||mm::dump(retainedHandleIdentity(ownerHandle.value))!=mm::dump(owner)||_wcsicmp(retainedProcessImage(ownerHandle.value).c_str(),cache.ownerImage.c_str())!=0)return false;
    MUSICMUTE_RETAINED_CHECK("peer-identity-shape");
    for(const auto* process:{&cache.guardianIdentity,&cache.engineIdentity})retainedIdentity(*process);
    MUSICMUTE_RETAINED_CHECK("peer-held-birth");
    if(mm::dump(retainedHandleIdentity(cache.guardian.value))!=mm::dump(cache.guardianIdentity)||mm::dump(retainedHandleIdentity(cache.engine.value))!=mm::dump(cache.engineIdentity))return false;
    MUSICMUTE_RETAINED_CHECK("guardian-parent-query");const auto guardian=parentBinding(cache.guardianIdentity);
    MUSICMUTE_RETAINED_CHECK("engine-parent-query");const auto engine=parentBinding(cache.engineIdentity);
    MUSICMUTE_RETAINED_CHECK("peer-parent-image-match");
    if(mm::dump(guardian.parent)!=mm::dump(owner)||mm::dump(engine.parent)!=mm::dump(cache.guardianIdentity)||_wcsicmp(guardian.image.c_str(),cache.pythonImage.c_str())!=0||_wcsicmp(engine.image.c_str(),cache.pythonImage.c_str())!=0){
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
      std::cerr<<"Native retained lineage/image match: guardian_parent="<<(mm::dump(guardian.parent)==mm::dump(owner))<<"; engine_parent="<<(mm::dump(engine.parent)==mm::dump(cache.guardianIdentity))<<"; guardian_image="<<(_wcsicmp(guardian.image.c_str(),cache.pythonImage.c_str())==0)<<"; engine_image="<<(_wcsicmp(engine.image.c_str(),cache.pythonImage.c_str())==0)<<'\n';
#endif
      return false;
    }
    std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+64*sizeof(ULONG_PTR));auto list=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
    MUSICMUTE_RETAINED_CHECK("bounded-job-query");
    if(!QueryInformationJobObject(job,JobObjectBasicProcessIdList,list,static_cast<DWORD>(bytes.size()),nullptr)||list->NumberOfAssignedProcesses!=list->NumberOfProcessIdsInList||list->NumberOfProcessIdsInList>64)return false;
    bool ownerSeen=false,guardianSeen=false,engineSeen=false;std::set<DWORD> seen;
    for(DWORD n=0;n<list->NumberOfProcessIdsInList;++n){
      MUSICMUTE_RETAINED_CHECK("job-pid-shape");
      if(list->ProcessIdList[n]<1||list->ProcessIdList[n]>2147483647)return false;const auto pid=static_cast<DWORD>(list->ProcessIdList[n]);if(!seen.insert(pid).second)return false;
      const auto process=processIdentity(pid,true);if(std::holds_alternative<std::nullptr_t>(process.value))return false;
      if(mm::dump(process)==mm::dump(owner)){ownerSeen=true;continue;}
      if(mm::dump(process)==mm::dump(cache.guardianIdentity)){guardianSeen=true;continue;}
      if(mm::dump(process)==mm::dump(cache.engineIdentity)){engineSeen=true;continue;}
      MUSICMUTE_RETAINED_CHECK("extra-peer-parent-image");const auto peer=parentBinding(process);if(mm::dump(peer.parent)!=mm::dump(owner)||_wcsicmp(peer.image.c_str(),cache.helperImage.c_str())!=0){
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
        const auto name=peer.image.substr(peer.image.find_last_of(L'\\')+1);
        std::cerr<<"Native retained extra peer category: console_host="<<(_wcsicmp(name.c_str(),L"conhost.exe")==0)<<"; owner_image="<<(_wcsicmp(peer.image.c_str(),cache.ownerImage.c_str())==0)<<"; python_image="<<(_wcsicmp(peer.image.c_str(),cache.pythonImage.c_str())==0)<<"; helper_image="<<(_wcsicmp(peer.image.c_str(),cache.helperImage.c_str())==0)<<"; parent_owner="<<(mm::dump(peer.parent)==mm::dump(owner))<<"; parent_guardian="<<(mm::dump(peer.parent)==mm::dump(cache.guardianIdentity))<<"; parent_engine="<<(mm::dump(peer.parent)==mm::dump(cache.engineIdentity))<<"; assigned="<<list->NumberOfAssignedProcesses<<"; listed="<<list->NumberOfProcessIdsInList<<'\n';
#endif
        return false;
      }
    }
    // Repeat the held-birth query after the census; PID reuse, exit or a query
    // failure cannot become quiescence. There is no arbitrary Python whitelist.
    MUSICMUTE_RETAINED_CHECK("final-members-held-birth");
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    if(!ownerSeen||!guardianSeen||!engineSeen)std::cerr<<"Native retained Job members: owner="<<ownerSeen<<"; guardian="<<guardianSeen<<"; engine="<<engineSeen<<"; assigned="<<list->NumberOfAssignedProcesses<<"; listed="<<list->NumberOfProcessIdsInList<<'\n';
#endif
    return ownerSeen&&guardianSeen&&engineSeen&&mm::dump(retainedHandleIdentity(cache.guardian.value))==mm::dump(cache.guardianIdentity)&&mm::dump(retainedHandleIdentity(cache.engine.value))==mm::dump(cache.engineIdentity);
  }catch(...){return false;}
}
std::unique_ptr<RetainedEngine> createRetainedEngine(HANDLE job,const Json& owner,const Json& guardian,const Json& engine,const std::wstring& ownerImage,const std::wstring& pythonImage,const std::wstring& helperImage) {
  retainedIdentity(guardian);retainedIdentity(engine);if(guardian.at("pid").integer()==engine.at("pid").integer()||guardian.at("pid").integer()==owner.at("identity").at("pid").integer()||engine.at("pid").integer()==owner.at("identity").at("pid").integer())fail("PEER_DENIED");
  auto cache=std::make_unique<RetainedEngine>();cache->owner=owner;cache->guardianIdentity=guardian;cache->engineIdentity=engine;cache->ownerImage=ownerImage;cache->pythonImage=pythonImage;cache->helperImage=helperImage;
  cache->guardian=Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(guardian.at("pid").integer())));cache->engine=Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(engine.at("pid").integer())));
  if(!cache->guardian.valid()||!cache->engine.valid()||!retainedEngineCensus(job,*cache)){
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    std::cerr<<"Native retained engine registration rejected; census_stage="<<retainedEngineCensusStage<<'\n';
#endif
    fail("PEER_DENIED");
  }cache->token=randomHex();return cache;
}
Json registerRetainedEngine(const Json& args) {
  assertRetainedOwner();if(retainedEngine)fail("JOB_BUSY");
  const auto nodeImage=retainedProcessImage(boundGpuRole->process.value);std::vector<wchar_t> self(32768);const auto count=GetModuleFileNameW(nullptr,self.data(),static_cast<DWORD>(self.size()));if(!count||count>=self.size())fail("PEER_DENIED");
  auto cache=createRetainedEngine(boundGpuRole->job.value,boundGpuRole->owner,args.at("guardian"),args.at("engine"),nodeImage,retainedPythonImage(nodeImage),std::wstring(self.data(),count));const auto token=cache->token;retainedEngine=std::move(cache);return Json::Object{{"token",token}};
}
RetainedEngine& retainedEngineCapability(const Json& args) {
  assertRetainedOwner();const auto token=args.at("token").string();if(token.size()!=64||token.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");if(!retainedEngine||!equalSecret(retainedEngine->token,token)||mm::dump(retainedEngine->owner)!=mm::dump(boundGpuRole->owner))fail("PEER_DENIED");return *retainedEngine;
}
std::string retainedJobId(const Json& args){const auto id=args.at("job_id").string();if(!std::regex_match(id,std::regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")))fail("BAD_REQUEST");return id;}
void beginRetainedEngineAttempt(RetainedEngine& cache,HANDLE job,const std::string& id){if(!cache.busyJob.empty()||!retainedEngineCensus(job,cache))fail("JOB_BUSY");cache.busyJob=id;}
void completeRetainedEngineAttempt(RetainedEngine& cache,HANDLE job,const std::string& id){if(cache.busyJob!=id||!retainedEngineCensus(job,cache))fail("PEER_DENIED");cache.busyJob.clear();}
Json beginRetainedEngine(const Json& args){auto& cache=retainedEngineCapability(args);beginRetainedEngineAttempt(cache,boundGpuRole->job.value,retainedJobId(args));return Json::Object{{"busy",true}};}
Json completeRetainedEngine(const Json& args){auto& cache=retainedEngineCapability(args);completeRetainedEngineAttempt(cache,boundGpuRole->job.value,retainedJobId(args));return Json::Object{{"idle",true}};}
bool retainedEngineQuiescent(){return retainedEngine&&boundGpuRole&&boundGpuRole->owner.at("role").string()=="personal"&&retainedGpuGuardHeld()&&mm::dump(retainedEngine->owner)==mm::dump(boundGpuRole->owner)&&retainedEngine->busyJob.empty()&&retainedEngineCensus(boundGpuRole->job.value,*retainedEngine);}
Json inspectRetainedEngine(const Json& args){auto& cache=retainedEngineCapability(args);return Json::Object{{"idle",cache.busyJob.empty()&&retainedEngineCensus(boundGpuRole->job.value,cache)}};}
void retireRetainedEngineHandles(RetainedEngine& cache,HANDLE job){
  if(!gpuRoleIdle(job,cache.owner)||(!cache.retiring&&(WaitForSingleObject(cache.guardian.value,0)!=WAIT_OBJECT_0||WaitForSingleObject(cache.engine.value,0)!=WAIT_OBJECT_0)))fail("GPU_GUARD_UNSAFE");
  cache.retiring=true;
  for(auto* handle:{&cache.guardian,&cache.engine})if(handle->valid()){check(CloseHandle(handle->value),"GPU_GUARD_UNSAFE");handle->value=nullptr;}
}
Json forgetRetainedEngine(const Json& args){
  auto& cache=retainedEngineCapability(args);retireRetainedEngineHandles(cache,boundGpuRole->job.value);
  retainedEngine.reset();return Json::Object{{"forgotten",true}};
}
#undef MUSICMUTE_RETAINED_CHECK
