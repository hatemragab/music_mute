#pragma once

bool gpuRoleIdle(HANDLE job,const Json& owner,const std::wstring& helperImage) {
  std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+64*sizeof(ULONG_PTR));
  auto list=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  if(!QueryInformationJobObject(job,JobObjectBasicProcessIdList,list,static_cast<DWORD>(bytes.size()),nullptr)||list->NumberOfAssignedProcesses!=list->NumberOfProcessIdsInList||list->NumberOfProcessIdsInList>64)return false;
  if(helperImage.empty())return false;
  for(DWORD n=0;n<list->NumberOfProcessIdsInList;++n) {
    if(list->ProcessIdList[n]>2147483647)return false;
    const auto process=processIdentity(static_cast<DWORD>(list->ProcessIdList[n]),true);
    if(std::holds_alternative<std::nullptr_t>(process.value))continue;
    if(mm::dump(process)==mm::dump(owner.at("identity")))continue;
    const auto peer=parentBinding(process);
    // Only the trusted Node and its fixed native helper peers may remain.
    // Python/FFmpeg/downloader/transfer children all block physical release.
    if(mm::dump(peer.parent)!=mm::dump(owner.at("identity"))||_wcsicmp(peer.image.c_str(),helperImage.c_str())!=0)return false;
  }
  return true;
}
bool gpuRoleIdle(HANDLE job,const Json& owner) {
  std::vector<wchar_t> self(32768);const auto count=GetModuleFileNameW(nullptr,self.data(),static_cast<DWORD>(self.size()));if(count==0||count>=self.size())return false;
  return gpuRoleIdle(job,owner,std::wstring(self.data(),count));
}
struct GpuKeeperLifetime {
  Handle job,mutex,controller,node,rootController,release,windowReady,watchdog,safeRelease;
  Json owner;
  bool roleBound=false,held=false;
  std::optional<mmstorerole::StoreGuardianBinding> storeBinding;
  std::atomic<bool> ending{false};
  std::mutex cleanupMutex;
  void destroyTree() {
    std::lock_guard lock(cleanupMutex);
    check(TerminateJobObject(job.value,2),"GPU_GUARD_UNSAFE");
    // Keep the physical mutex while cleanup is unconfirmed. There is no
    // timeout path that releases it in front of still-live inference children.
    for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};check(QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr),"GPU_GUARD_UNSAFE");if(info.ActiveProcesses==0)break;Sleep(10);}
    if(roleBound)writeExitCertificate(owner);
  }
};
GpuKeeperLifetime* gpuKeeperLifetime=nullptr;
std::unique_ptr<GpuKeeperLifetime> gpuKeeperStorage;
LRESULT CALLBACK gpuKeeperWindow(HWND window,UINT message,WPARAM parameter,LPARAM detail) {
  if(message==WM_QUERYENDSESSION)return TRUE;
  if(message==WM_ENDSESSION&&parameter&&gpuKeeperLifetime){
    // The owning main thread performs cleanup and ReleaseMutex; mutex ownership
    // never moves to this window thread.
    gpuKeeperLifetime->ending=true;
    TerminateJobObject(gpuKeeperLifetime->job.value,2);
    SetEvent(gpuKeeperLifetime->release.value);
  }
  return DefWindowProcW(window,message,parameter,detail);
}
void writeGpuReady(HANDLE pipe,const Json& result) {
  const auto text=mm::dump(result);const DWORD count=static_cast<DWORD>(text.size());DWORD wrote=0;
  check(WriteFile(pipe,&count,4,&wrote,nullptr)&&wrote==4,"GPU_GUARD_UNSAFE");check(WriteFile(pipe,text.data(),count,&wrote,nullptr)&&wrote==count,"GPU_GUARD_UNSAFE");
}
// A second independent process retains a non-owning reference to the same
// physical mutex. If its owner crashes, that named object cannot disappear
// while the exact old Job still contains inference descendants.
struct GpuWatchdogLifetime {Handle reference,job,keeper,approved;std::optional<mmstorerole::StoreGuardianBinding> storeBinding;};
std::unique_ptr<GpuWatchdogLifetime> gpuWatchdogStorage;
int independentGpuWatchdogMain(const std::wstring& pipeText) {
  try {
    auto input=inheritedHandle(Json::Object{{"pipe",utf8(pipeText)}},"pipe");DWORD count=0,read=0;
    check(ReadFile(input.value,&count,4,&read,nullptr)&&read==4&&count>0&&count<=8192,"GPU_GUARD_UNSAFE");
    std::string bytes(count,'\0');check(ReadFile(input.value,bytes.data(),count,&read,nullptr)&&read==count,"GPU_GUARD_UNSAFE");const auto config=mm::JsonParser(bytes).parse();
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    isolatedTestRoot=wide(config.at("test_root").string());
#endif
    gpuWatchdogStorage=std::make_unique<GpuWatchdogLifetime>();auto& lifetime=*gpuWatchdogStorage;
    lifetime.reference=inheritedHandle(config,"mutex");lifetime.job=inheritedHandle(config,"job");lifetime.keeper=inheritedHandle(config,"keeper");lifetime.approved=inheritedHandle(config,"approved");auto ready=inheritedHandle(config,"ready");
    if(!mmstore::currentPackageFullName().empty()){
      lifetime.storeBinding.emplace(mmstorerole::StoreGuardianBinding::open(config.at("store_issuer"),mmstorerole::GuardianKind::watchdog,lifetime.job.value));
      lifetime.storeBinding->requireActualParent(lifetime.keeper.value);
    }
    check(safePublicGpuMutex(lifetime.reference.value),"GPU_GUARD_UNSAFE");
    writeGpuReady(ready.value,Json::Object{{"ready",true}});ready.close();
    check(WaitForSingleObject(lifetime.keeper.value,INFINITE)==WAIT_OBJECT_0,"GPU_GUARD_UNSAFE");
    if(WaitForSingleObject(lifetime.approved.value,0)!=WAIT_OBJECT_0) {
      check(TerminateJobObject(lifetime.job.value,2),"GPU_GUARD_UNSAFE");
      for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};check(QueryInformationJobObject(lifetime.job.value,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr),"GPU_GUARD_UNSAFE");if(info.ActiveProcesses==0)break;Sleep(10);}
      if(std::get<bool>(config.at("role_bound").value))writeExitCertificate(config.at("owner"));
    }
    // Closing the reference is safe only after this proof or an idle-release
    // approval issued by the owning keeper itself.
    ExitProcess(0);
  } catch(...) {
    // A cleanup/query error must retain every inherited handle and contention.
    // No ExitProcess/stack unwinding is allowed while old-tree exit is unknown.
    for(;;)Sleep(1000);
  }
}
Handle startGpuWatchdog(GpuKeeperLifetime& lifetime,HANDLE observedKeeper=GetCurrentProcess()) {
  auto reference=inheritedCopy(lifetime.mutex.value,READ_CONTROL|SYNCHRONIZE),job=inheritedCopy(lifetime.job.value,JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE),keeper=inheritedCopy(observedKeeper,SYNCHRONIZE),approved=inheritedCopy(lifetime.safeRelease.value,SYNCHRONIZE);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};Handle input,writer,readyRead,readyWrite;
  check(CreatePipe(&input.value,&writer.value,&security,16384),"GPU_GUARD_UNSAFE");check(CreatePipe(&readyRead.value,&readyWrite.value,&security,8192),"GPU_GUARD_UNSAFE");
  check(SetHandleInformation(writer.value,HANDLE_FLAG_INHERIT,0),"GPU_GUARD_UNSAFE");check(SetHandleInformation(readyRead.value,HANDLE_FLAG_INHERIT,0),"GPU_GUARD_UNSAFE");
  auto config=Json::Object{{"mutex",handleText(reference)},{"job",handleText(job)},{"keeper",handleText(keeper)},{"approved",handleText(approved)},{"ready",handleText(readyWrite)},{"role_bound",lifetime.roleBound},{"owner",lifetime.owner}};
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  config.emplace("test_root",utf8(isolatedTestRoot));
#endif
  const bool store=!mmstore::currentPackageFullName().empty();
  DWORD desktopPolicy=0;
  SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,store?2:1,0,&size);std::vector<BYTE> attributes(size);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());check(InitializeProcThreadAttributeList(list,store?2:1,0,&size),"GPU_GUARD_UNSAFE");struct Attributes{LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} attributesLifetime{list};
  HANDLE handles[]{reference.value,job.value,keeper.value,approved.value,input.value,readyWrite.value};check(UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr),"GPU_GUARD_UNSAFE");
  if(store)check(mmstoredesktop::apply(list,desktopPolicy),"GPU_GUARD_UNSAFE");
  if(store&&(!lifetime.storeBinding||!lifetime.roleBound))fail("GPU_GUARD_UNSAFE");
  std::vector<wchar_t> image(32768);const auto imageSize=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));if(imageSize==0||imageSize>=image.size())fail("GPU_GUARD_UNSAFE");const std::wstring executable(image.data(),imageSize);auto command=quote(executable)+(store?L" --store-gpu-watchdog ":L" --gpu-watchdog ")+wide(handleText(input));
  BOOL inJob=FALSE;check(IsProcessInJob(GetCurrentProcess(),nullptr,&inJob),"GPU_GUARD_UNSAFE");STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=list;PROCESS_INFORMATION process{};
  auto environment=consumerEnvironment(executable.substr(0,executable.find_last_of(L'\\')));
  check(CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|(store?CREATE_SUSPENDED:consumerIndependentJobFlags(inJob)),environment.data(),nullptr,&startup.StartupInfo,&process),"GPU_GUARD_UNSAFE");Handle child(process.hProcess),thread(process.hThread);
  struct WatchdogStart {HANDLE child;bool running=false;~WatchdogStart(){if(!running){(void)TerminateProcess(child,2);(void)WaitForSingleObject(child,5000);}}} rollback{child.value,!store};
  if(store)config.emplace("store_issuer",lifetime.storeBinding->registerWatchdog(child.value));
  const auto text=mm::dump(config);DWORD count=static_cast<DWORD>(text.size()),wrote=0;check(WriteFile(writer.value,&count,4,&wrote,nullptr)&&wrote==4,"GPU_GUARD_UNSAFE");check(WriteFile(writer.value,text.data(),count,&wrote,nullptr)&&wrote==count,"GPU_GUARD_UNSAFE");writer.close();
  if(store){check(ResumeThread(thread.value)!=static_cast<DWORD>(-1),"GPU_GUARD_UNSAFE");rollback.running=true;}input.close();readyWrite.close();
  const auto deadline=GetTickCount64()+5000;for(;;){DWORD available=0;if(!PeekNamedPipe(readyRead.value,nullptr,0,nullptr,&available,nullptr)||GetTickCount64()>=deadline)fail("GPU_GUARD_UNSAFE");if(available>=4)break;if(WaitForSingleObject(child.value,0)==WAIT_OBJECT_0)fail("GPU_GUARD_UNSAFE");Sleep(5);}
  DWORD read=0;check(ReadFile(readyRead.value,&count,4,&read,nullptr)&&read==4&&count>0&&count<=4096,"GPU_GUARD_UNSAFE");std::string result(count,'\0');check(ReadFile(readyRead.value,result.data(),count,&read,nullptr)&&read==count,"GPU_GUARD_UNSAFE");check(std::get<bool>(mm::JsonParser(result).parse().at("ready").value),"GPU_GUARD_UNSAFE");return child;
}
// Shared by the production keeper and isolated BUILD_TESTING fixtures. The
// acquiring thread keeps its physical mutex until exact old-Job cleanup.
void finishGpuKeeperLifetime(GpuKeeperLifetime& lifetime,DWORD ended) {
  if(ended!=WAIT_OBJECT_0||lifetime.ending){lifetime.destroyTree();}
  else {
    if(lifetime.roleBound){if(!gpuRoleIdle(lifetime.job.value,lifetime.owner))lifetime.destroyTree();}
    else{JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};check(QueryInformationJobObject(lifetime.job.value,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr),"GPU_GUARD_UNSAFE");if(info.ActiveProcesses!=0)lifetime.destroyTree();}
  }
  check(SetEvent(lifetime.safeRelease.value),"GPU_GUARD_UNSAFE");check(ReleaseMutex(lifetime.mutex.value),"GPU_GUARD_UNSAFE");lifetime.held=false;
}
int independentGpuMain(const std::wstring& pipeText) {
  try {
    auto input=inheritedHandle(Json::Object{{"pipe",utf8(pipeText)}},"pipe");DWORD count=0,read=0;
    check(ReadFile(input.value,&count,4,&read,nullptr)&&read==4,"GPU_GUARD_UNSAFE");if(count==0||count>8192)return 2;
    std::string bytes(count,'\0');check(ReadFile(input.value,bytes.data(),count,&read,nullptr)&&read==count,"GPU_GUARD_UNSAFE");const auto config=mm::JsonParser(bytes).parse();SecureZeroMemory(bytes.data(),bytes.size());
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    isolatedTestRoot=wide(config.at("test_root").string());
#endif
    auto ready=inheritedHandle(config,"ready");gpuKeeperStorage=std::make_unique<GpuKeeperLifetime>();auto& lifetime=*gpuKeeperStorage;
    lifetime.job=inheritedHandle(config,"job");lifetime.controller=inheritedHandle(config,"controller");lifetime.release=inheritedHandle(config,"release");
    if(!mmstore::currentPackageFullName().empty()){
      lifetime.storeBinding.emplace(mmstorerole::StoreGuardianBinding::open(config.at("store_issuer"),mmstorerole::GuardianKind::gpu,lifetime.job.value));
      if(GetProcessId(lifetime.controller.value)!=lifetime.storeBinding->creatorIdentity().pid||creation(lifetime.controller.value)!=mmstorerole::detail::ascii(lifetime.storeBinding->creatorIdentity().creationTime))return 2;
    }
    lifetime.roleBound=std::get<bool>(config.at("role_bound").value);lifetime.owner=config.at("owner");
    if(lifetime.storeBinding&&!lifetime.roleBound)return 2;
    if(lifetime.roleBound){lifetime.node=inheritedHandle(config,"node");const auto& identity=lifetime.owner.at("identity");if(identity.at("sid").string()!=currentIdentity().sid||identity.at("session_id").integer()!=currentIdentity().session||identity.at("creation_time").string()!=creation(lifetime.node.value)||identity.at("pid").integer()!=GetProcessId(lifetime.node.value))return 2;BOOL belongs=FALSE;check(IsProcessInJob(lifetime.node.value,lifetime.job.value,&belongs)&&belongs,"JOB_NOT_OWNED");}
    if(lifetime.roleBound)lifetime.rootController=inheritedHandle(config,"root_controller");
    if(lifetime.storeBinding&&(GetProcessId(lifetime.node.value)!=lifetime.storeBinding->nodeIdentity().pid||creation(lifetime.node.value)!=mmstorerole::detail::ascii(lifetime.storeBinding->nodeIdentity().creationTime)))return 2;
    const auto luid=config.at("luid").string();Json actual;
    for(const auto& adapter:gpuInventory())if(adapter.at("luid").string()==luid){actual=adapter;break;}
    if(mm::dump(actual)!=mm::dump(config.at("gpu"))){writeGpuReady(ready.value,Json::Object{{"acquired",false}});return 0;}
    const auto sid=wide(currentIdentity().sid);Security security(L"O:"+sid+L"D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)");
    lifetime.mutex=Handle(CreateMutexExW(&security.attributes,(L"Global\\MusicMuteDirectML-v1-"+wide(luid)).c_str(),0,READ_CONTROL|SYNCHRONIZE|MUTEX_MODIFY_STATE));
    if(!lifetime.mutex.valid()||!safePublicGpuMutex(lifetime.mutex.value)){writeGpuReady(ready.value,Json::Object{{"acquired",false}});return 0;}
    const auto acquired=WaitForSingleObject(lifetime.mutex.value,0);
    // An abandoned owner is never a GPU permit. Its watchdog retains a
    // reference until old-tree cleanup, and rejection deliberately preserves
    // abandoned state rather than clearing it with ReleaseMutex.
    if(acquired!=WAIT_OBJECT_0){writeGpuReady(ready.value,Json::Object{{"acquired",false}});return 0;}
    lifetime.held=true;gpuKeeperLifetime=&lifetime;lifetime.windowReady=Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!lifetime.windowReady.valid())fail("GPU_GUARD_UNSAFE");
    lifetime.safeRelease=Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!lifetime.safeRelease.valid())fail("GPU_GUARD_UNSAFE");
    lifetime.watchdog=startGpuWatchdog(lifetime);
    std::thread([]{WNDCLASSW kind{};kind.lpfnWndProc=gpuKeeperWindow;kind.hInstance=GetModuleHandleW(nullptr);kind.lpszClassName=L"MusicMutePhysicalGpuKeeper";if(!RegisterClassW(&kind)||!CreateWindowExW(0,kind.lpszClassName,L"MusicMute GPU",WS_OVERLAPPED,0,0,0,0,nullptr,nullptr,kind.hInstance,nullptr)){gpuKeeperLifetime->ending=true;SetEvent(gpuKeeperLifetime->windowReady.value);return;}SetEvent(gpuKeeperLifetime->windowReady.value);MSG message{};while(GetMessageW(&message,nullptr,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}}).detach();
    if(WaitForSingleObject(lifetime.windowReady.value,5000)!=WAIT_OBJECT_0||lifetime.ending){
      if(lifetime.roleBound){if(!gpuRoleIdle(lifetime.job.value,lifetime.owner))lifetime.destroyTree();}
      else {JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};check(QueryInformationJobObject(lifetime.job.value,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr),"GPU_GUARD_UNSAFE");if(info.ActiveProcesses!=0)lifetime.destroyTree();}
      check(SetEvent(lifetime.safeRelease.value),"GPU_GUARD_UNSAFE");check(ReleaseMutex(lifetime.mutex.value),"GPU_GUARD_UNSAFE");lifetime.held=false;writeGpuReady(ready.value,Json::Object{{"acquired",false}});ExitProcess(2);
    }
    writeGpuReady(ready.value,Json::Object{{"acquired",true},{"abandoned",acquired==WAIT_ABANDONED}});ready.close();
    HANDLE watched[]{lifetime.release.value,lifetime.controller.value,lifetime.watchdog.value,lifetime.node.value,lifetime.rootController.value};
    const auto ended=WaitForMultipleObjects(lifetime.roleBound?5:3,watched,FALSE,INFINITE);
    finishGpuKeeperLifetime(lifetime,ended);
    ExitProcess(0);
  }catch(...){
    // With a successfully acquired guard, retain contention rather than
    // implicitly release during an unproved tree-cleanup failure.
    if(gpuKeeperLifetime&&gpuKeeperLifetime->held){for(;;)Sleep(1000);}
    return 2;
  }
}
bool startIndependentGpuKeeper(OwnedGpuGuard& guard,const std::string& luid,const BoundGpuRole* actualRole) {
  const bool store=!mmstore::currentPackageFullName().empty();
  bool completed=false,resumed=!store;
  struct FailedStart { OwnedGpuGuard& guard; bool& completed;bool& resumed; ~FailedStart(){if(!completed&&guard.keeper.valid()){if(!resumed)(void)TerminateProcess(guard.keeper.value,2);else SetEvent(guard.release.value);WaitForSingleObject(guard.keeper.value,5000);}} } failedStart{guard,completed,resumed};
  auto job=inheritedCopy(guard.job.value,JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE);
  auto controller=inheritedCopy(GetCurrentProcess(),SYNCHRONIZE);
  auto release=inheritedCopy(guard.release.value,EVENT_MODIFY_STATE|SYNCHRONIZE);
  Handle node,rootController;if(actualRole){node=inheritedCopy(actualRole->process.value,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE);rootController=inheritedCopy(actualRole->rootController.value,SYNCHRONIZE);}
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};Handle input,writer,readyRead,readyWrite;
  check(CreatePipe(&input.value,&writer.value,&security,16384),"GPU_GUARD_UNSAFE");check(CreatePipe(&readyRead.value,&readyWrite.value,&security,8192),"GPU_GUARD_UNSAFE");
  check(SetHandleInformation(writer.value,HANDLE_FLAG_INHERIT,0),"GPU_GUARD_UNSAFE");check(SetHandleInformation(readyRead.value,HANDLE_FLAG_INHERIT,0),"GPU_GUARD_UNSAFE");
  auto config=Json::Object{{"job",handleText(job)},{"controller",handleText(controller)},{"release",handleText(release)},{"ready",handleText(readyWrite)},{"role_bound",guard.roleBound},{"owner",actualRole?actualRole->owner:Json(nullptr)},{"luid",luid},{"gpu",guard.gpu}};
  if(node.valid())config.emplace("node",handleText(node));
  if(rootController.valid())config.emplace("root_controller",handleText(rootController));
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  config.emplace("test_root",utf8(isolatedTestRoot));
#endif
  DWORD desktopPolicy=0;
  SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,store?2:1,0,&size);std::vector<BYTE> attributes(size);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  check(InitializeProcThreadAttributeList(list,store?2:1,0,&size),"GPU_GUARD_UNSAFE");struct AttributeLifetime{LPPROC_THREAD_ATTRIBUTE_LIST value;~AttributeLifetime(){DeleteProcThreadAttributeList(value);}} attributeLifetime{list};
  std::vector<HANDLE> inherited{job.value,controller.value,release.value,input.value,readyWrite.value};if(node.valid())inherited.push_back(node.value);
  if(rootController.valid())inherited.push_back(rootController.value);
  check(UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),inherited.size()*sizeof(HANDLE),nullptr,nullptr),"GPU_GUARD_UNSAFE");
  if(store)check(mmstoredesktop::apply(list,desktopPolicy),"GPU_GUARD_UNSAFE");
  if(store&&(!guard.roleBound||!actualRole))fail("GPU_GUARD_UNSAFE");
  std::optional<mmstoreruntime::FixedLaunchPlan> storePlan;if(store)storePlan.emplace(mmstorerole::StoreRoleIssuer::currentCreator().guardianPlan());
  std::vector<wchar_t> image(32768);const DWORD imageSize=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));if(imageSize==0||imageSize>=image.size())fail("GPU_GUARD_UNSAFE");const std::wstring executable=store?storePlan->executablePath():std::wstring(image.data(),imageSize);
  auto command=quote(executable)+(store?L" --store-gpu-guardian ":L" --gpu-guardian ")+wide(handleText(input));BOOL inJob=FALSE;check(IsProcessInJob(GetCurrentProcess(),nullptr,&inJob),"GPU_GUARD_UNSAFE");
  STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=list;PROCESS_INFORMATION process{};
  auto environment=consumerEnvironment(executable.substr(0,executable.find_last_of(L'\\')));
  check(CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT|(store?CREATE_SUSPENDED:consumerIndependentJobFlags(inJob)),environment.data(),nullptr,&startup.StartupInfo,&process),"GPU_GUARD_UNSAFE");
  guard.keeper=Handle(process.hProcess);Handle thread(process.hThread);
  if(store){storePlan->revalidateFixedAdmission();config.emplace("store_issuer",mmstorerole::StoreRoleIssuer::currentCreator().registerGuardian(guard.keeper.value,guard.job.value,actualRole->process.value,mmstorerole::GuardianKind::gpu));}
  const auto text=mm::dump(config);DWORD count=static_cast<DWORD>(text.size()),wrote=0;
  check(WriteFile(writer.value,&count,4,&wrote,nullptr)&&wrote==4,"GPU_GUARD_UNSAFE");check(WriteFile(writer.value,text.data(),count,&wrote,nullptr)&&wrote==count,"GPU_GUARD_UNSAFE");writer.close();
  if(store){check(ResumeThread(thread.value)!=static_cast<DWORD>(-1),"GPU_GUARD_UNSAFE");resumed=true;}input.close();readyWrite.close();
  const auto deadline=GetTickCount64()+5000;
  for(;;){DWORD available=0;if(!PeekNamedPipe(readyRead.value,nullptr,0,nullptr,&available,nullptr)||GetTickCount64()>=deadline)fail("GPU_GUARD_UNSAFE");if(available>=4)break;if(WaitForSingleObject(guard.keeper.value,0)==WAIT_OBJECT_0)fail("GPU_GUARD_UNSAFE");Sleep(5);}
  DWORD read=0;check(ReadFile(readyRead.value,&count,4,&read,nullptr)&&read==4&&count>0&&count<=4096,"GPU_GUARD_UNSAFE");std::string result(count,'\0');check(ReadFile(readyRead.value,result.data(),count,&read,nullptr)&&read==count,"GPU_GUARD_UNSAFE");const auto value=mm::JsonParser(result).parse();
  if(!std::get<bool>(value.at("acquired").value)){completed=true;return false;}
  guard.abandoned=std::get<bool>(value.at("abandoned").value);
  Handle watched=inheritedCopy(guard.keeper.value,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE);Handle approved=inheritedCopy(guard.release.value,SYNCHRONIZE);
  if(store) {
    auto observedNode=inheritedCopy(actualRole->process.value,SYNCHRONIZE),observedJob=inheritedCopy(actualRole->job.value,JOB_OBJECT_QUERY);
    std::thread([keeper=std::move(watched),releaseSignal=std::move(approved),node=std::move(observedNode),job=std::move(observedJob)] {
      if(WaitForSingleObject(keeper.value,INFINITE)!=WAIT_OBJECT_0)ExitProcess(2);
      if(WaitForSingleObject(releaseSignal.value,0)==WAIT_OBJECT_0)return;
      DWORD exit=2;JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
      // A completed transient Prepare Node legitimately ends its own lease.
      // Permit this only after the actual keeper succeeded and the exact owned
      // Node/whole Job exited. An unexpected keeper death while Node lives still
      // retires the Creator so independent guardians fence all processing.
      if(WaitForSingleObject(node.value,0)==WAIT_OBJECT_0&&GetExitCodeProcess(keeper.value,&exit)&&exit==0&&
         QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&state,sizeof(state),nullptr)&&state.ActiveProcesses==0)return;
      ExitProcess(2);
    }).detach();
  } else {
    std::thread([keeper=std::move(watched),releaseSignal=std::move(approved)]{if(WaitForSingleObject(keeper.value,INFINITE)==WAIT_OBJECT_0&&WaitForSingleObject(releaseSignal.value,0)!=WAIT_OBJECT_0)ExitProcess(2);}).detach();
  }
  completed=true;return true;
}

// Legacy helpers retain their original global binding and lifetime behavior.
bool startIndependentGpuKeeper(OwnedGpuGuard& guard,const std::string& luid) {
  return startIndependentGpuKeeper(guard,luid,boundGpuRole.get());
}
