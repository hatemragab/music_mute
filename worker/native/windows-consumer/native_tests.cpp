#define MUSICMUTE_CONSUMER_NATIVE_TEST
#include "main.cpp"
#include <filesystem>
#include <winioctl.h>
#include <source_location>

namespace {
const char* nativeCheckpoint="startup";
void checkpoint(const char* value) {nativeCheckpoint=value;std::cerr<<"Native checkpoint: "<<value<<'\n';}
bool safeFailureCode(const std::string& code) {return !code.empty()&&code.size()<=64&&std::all_of(code.begin(),code.end(),[](char value){return (value>='A'&&value<='Z')||(value>='0'&&value<='9')||value=='_';});}
void require(bool condition,const std::source_location& location=std::source_location::current()) {
  if (!condition) {std::cerr<<"Native assertion failed at line "<<location.line()<<'\n';throw Failure("NATIVE_TEST_FAILED");}
}
template <typename Action> void rejects(const char* code, Action action,const std::source_location& location=std::source_location::current()) {
  try { action(); } catch (const Failure& error) {
    if(error.code!=code&&safeFailureCode(error.code))std::cerr<<"Native rejection returned code "<<error.code<<'\n';
    require(error.code == code,location);return;
  }
  std::cerr<<"Native expected rejection missing at line "<<location.line()<<'\n';
  throw Failure("NATIVE_TEST_EXPECTED_REJECTION");
}
void writeFixture(const std::wstring& path, const std::string& bytes,const std::source_location& site=std::source_location::current()) {
  Security security(dataSddl());
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  const auto createError=GetLastError();
  if(!file.valid())std::cerr<<"Native fixture file creation failed: caller_line="<<site.line()<<"; win32_error="<<createError<<'\n';
  require(file.valid(),site); DWORD wrote = 0;
  require(WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &wrote, nullptr) && wrote == bytes.size(),site);
}
void directory(const std::string& root, const std::string& relative) {
  (void)dispatch("ensure_private_directory", Json::Object{{"root", root}, {"relative_path", relative}});
}
// Exercise the actual Store pipe functions against new synthetic local pipes;
// this supplies no installed package, account peer or readiness authority.
void storePipeEofFixtures() {
  checkpoint("store-pipe-disconnect-eof");
  struct Pair {
    Handle server, client;
    Pair() {
      const auto name = L"\\\\.\\pipe\\MusicMuteStoreEofFixture-" + wide(randomHex());
      Security security(dataSddl());
      server = Handle(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &security.attributes));
      require(server.valid());
      client = Handle(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr));
      require(client.valid());
      Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(event.valid());
      OVERLAPPED operation{}; operation.hEvent = event.value;
      require(ConnectNamedPipe(server.value, &operation) || GetLastError() == ERROR_PIPE_CONNECTED);
    }
    void replyAndAck() {
      const auto deadline = GetTickCount64() + 5000;
      const Json reply = Json::Object{{"version", 1}, {"confirmed", true}};
      const Json ack = Json::Object{{"version", 1}, {"accepted", true}};
      storeBrowserSendLine(server.value, reply, deadline);
      require(mm::dump(storeBrowserReceiveLine(client.value, deadline)) == mm::dump(reply));
      storeBrowserSendLine(client.value, ack, deadline);
      require(mm::dump(storeBrowserReceiveLine(server.value, deadline)) == mm::dump(ack));
    }
    void disconnect() { require(DisconnectNamedPipe(server.value)); }
  };
  // The server's deliberate post-ACK disconnect yields zero-byte read EOF.
  // Windows can report ERROR_PIPE_NOT_CONNECTED, not only ERROR_BROKEN_PIPE.
  Pair immediate; immediate.replyAndAck(); immediate.disconnect();
  storeAccountEof(immediate.client.value, GetTickCount64() + 5000);
  char byte = 'x';
  rejects("PIPE_UNAVAILABLE", [&] { (void)storeBrowserTransfer(immediate.client.value, &byte, 1, true, GetTickCount64() + 5000); });
  Pair pending; pending.replyAndAck(); std::exception_ptr serverError;
  std::thread disconnect([&] { try { Sleep(50); pending.disconnect(); } catch (...) { serverError = std::current_exception(); } });
  try { storeAccountEof(pending.client.value, GetTickCount64() + 5000); }
  catch (...) { disconnect.join(); throw; }
  disconnect.join(); if (serverError) std::rethrow_exception(serverError);
  // EOF remains invalid before a complete required frame, including after a
  // valid prefix has been consumed. Flush the prefix before disconnecting.
  Pair truncated; std::thread truncate([&] {
    try {
      std::string prefix = "{\"version\":1";
      require(storeBrowserTransfer(truncated.server.value, prefix.data(), static_cast<DWORD>(prefix.size()), true, GetTickCount64() + 5000) == prefix.size());
      require(FlushFileBuffers(truncated.server.value)); truncated.disconnect();
    } catch (...) { serverError = std::current_exception(); }
  });
  try { rejects("PEER_DENIED", [&] { (void)storeBrowserReceiveLine(truncated.client.value, GetTickCount64() + 5000); }); }
  catch (...) { truncate.join(); throw; }
  truncate.join(); if (serverError) std::rethrow_exception(serverError);
  Pair premature; premature.disconnect();
  rejects("PEER_DENIED", [&] { (void)storeBrowserReceiveLine(premature.client.value, GetTickCount64() + 5000); });
  Pair extra; require(storeBrowserTransfer(extra.server.value, &byte, 1, true, GetTickCount64() + 5000) == 1);
  rejects("PEER_DENIED", [&] { storeAccountEof(extra.client.value, GetTickCount64() + 5000); });
  Pair expired;
  rejects("TIMEOUT", [&] { storeAccountEof(expired.client.value, GetTickCount64()); });
}
void retainedEngineFixtures(const std::wstring& executable){
  checkpoint("retained-engine-exact-generations");
  // The copied test executable is a stand-in at one fixed Python image. No
  // production role-binding, installed runtime, account or GPU is bypassed.
  // As in the existing GPU keeper fixtures, DETACHED_PROCESS removes the
  // console rather than creating hidden conhost Job members. The inherited
  // Job chain and explicit anonymous-pipe/event handles remain intact.
  directory("personal","native-retained-engine");const auto python=rootPath("personal")+L"\\native-retained-engine\\python.exe";
  require(CopyFileW(executable.c_str(),python.c_str(),TRUE));
  Handle job(CreateJobObjectW(nullptr,nullptr));require(job.valid());
  // This isolated nested Job intentionally has no kill-on-close flag: its
  // owner is this test process. Every child is independently waited below.
  require(AssignProcessToJobObject(job.value,GetCurrentProcess()));
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};Handle reader,writer;
  require(CreatePipe(&reader.value,&writer.value,&security,4096));require(SetHandleInformation(reader.value,HANDLE_FLAG_INHERIT,0));Handle addGrandchild(CreateEventW(&security,TRUE,FALSE,nullptr));require(addGrandchild.valid());
  SIZE_T attributeBytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&attributeBytes);std::vector<BYTE> attributes(attributeBytes);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());require(InitializeProcThreadAttributeList(list,1,0,&attributeBytes));
  struct Attributes{LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} lifetime{list};HANDLE inherited[]{writer.value,addGrandchild.value};require(UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr));
  auto command=quote(python)+L" --retained-fixture-guardian "+wide(handleText(writer))+L" "+wide(handleText(addGrandchild));STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=list;PROCESS_INFORMATION process{};
  require(CreateProcessW(python.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|DETACHED_PROCESS|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&process));Handle guardian(process.hProcess),thread(process.hThread);writer.close();require(ResumeThread(thread.value)!=static_cast<DWORD>(-1));
  // On any assertion failure, the exact fixture processes are terminated and
  // positively waited. No user Job or unrelated child enters this cleanup.
  struct Children{Handle* first;Handle* second;~Children(){for(auto* child:{second,first})if(child&&child->valid()&&WaitForSingleObject(child->value,0)==WAIT_TIMEOUT){TerminateProcess(child->value,2);WaitForSingleObject(child->value,5000);}}};
  Handle engine;Children cleanup{&guardian,&engine};const auto deadline=GetTickCount64()+5000;DWORD available=0;
  for(;;){require(PeekNamedPipe(reader.value,nullptr,0,nullptr,&available,nullptr));if(available>=sizeof(DWORD))break;require(WaitForSingleObject(guardian.value,0)==WAIT_TIMEOUT&&GetTickCount64()<deadline);Sleep(5);}
  DWORD enginePid=0,read=0;require(ReadFile(reader.value,&enginePid,sizeof(enginePid),&read,nullptr)&&read==sizeof(enginePid)&&enginePid>0);engine=Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_TERMINATE|SYNCHRONIZE,FALSE,enginePid));require(engine.valid());
  checkpoint("retained-engine-peer-identities");const Json owner=Json::Object{{"role","personal"},{"nonce",randomHex()},{"identity",processIdentity(GetCurrentProcessId())}};const auto guardianIdentity=processIdentity(GetProcessId(guardian.value)),engineIdentity=processIdentity(enginePid);
  checkpoint("retained-engine-register-exact");
  const auto ownerImage=retainedProcessImage(GetCurrentProcess());auto cache=createRetainedEngine(job.value,owner,guardianIdentity,engineIdentity,ownerImage,python,ownerImage);
  require(retainedEngineCensus(job.value,*cache));require(!gpuRoleIdle(job.value,owner));
  rejects("GPU_GUARD_UNSAFE",[&]{retireRetainedEngineHandles(*cache,job.value);});
  const auto first="11111111-1111-4111-8111-111111111111",second="22222222-2222-4222-8222-222222222222";
  checkpoint("retained-engine-begin-first");beginRetainedEngineAttempt(*cache,job.value,first);require(cache->busyJob==first);
  rejects("JOB_BUSY",[&]{beginRetainedEngineAttempt(*cache,job.value,second);});
  rejects("PEER_DENIED",[&]{completeRetainedEngineAttempt(*cache,job.value,second);});require(cache->busyJob==first);
  checkpoint("retained-engine-complete-first");completeRetainedEngineAttempt(*cache,job.value,first);require(cache->busyJob.empty()&&retainedEngineCensus(job.value,*cache));
  checkpoint("retained-engine-registration-negatives");
  auto changed=guardianIdentity.object();changed["creation_time"]=std::to_string(std::stoull(guardianIdentity.at("creation_time").string())+1);
  rejects("PEER_DENIED",[&]{(void)createRetainedEngine(job.value,owner,changed,engineIdentity,ownerImage,python,ownerImage);});
  rejects("PEER_DENIED",[&]{(void)createRetainedEngine(job.value,owner,engineIdentity,guardianIdentity,ownerImage,python,ownerImage);});
  rejects("PEER_DENIED",[&]{(void)createRetainedEngine(job.value,owner,guardianIdentity,engineIdentity,ownerImage,ownerImage,ownerImage);});
  require(retainedPythonImage(L"C:\\fixture\\runtime\\node\\node.exe")==L"C:\\fixture\\runtime\\python\\python.exe");rejects("PEER_DENIED",[&]{(void)retainedPythonImage(L"C:\\arbitrary\\node.exe");});
  // A tool child born under the registered engine is not one of the two
  // retained generations. Its actual living presence blocks completion.
  checkpoint("retained-engine-request-grandchild");beginRetainedEngineAttempt(*cache,job.value,first);require(SetEvent(addGrandchild.value));const auto childDeadline=GetTickCount64()+5000;
  for(;;){require(PeekNamedPipe(reader.value,nullptr,0,nullptr,&available,nullptr));if(available>=sizeof(DWORD))break;require(WaitForSingleObject(engine.value,0)==WAIT_TIMEOUT&&GetTickCount64()<childDeadline);Sleep(5);}
  DWORD grandchildPid=0;require(ReadFile(reader.value,&grandchildPid,sizeof(grandchildPid),&read,nullptr)&&read==sizeof(grandchildPid)&&grandchildPid>0);reader.close();Handle grandchild(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_TERMINATE|SYNCHRONIZE,FALSE,grandchildPid));require(grandchild.valid());Children grandchildCleanup{&grandchild,nullptr};
  checkpoint("retained-engine-grandchild-lineage");require(mm::dump(parentBinding(processIdentity(grandchildPid)).parent)==mm::dump(engineIdentity));require(!retainedEngineCensus(job.value,*cache));rejects("PEER_DENIED",[&]{completeRetainedEngineAttempt(*cache,job.value,first);});require(cache->busyJob==first);
  require(TerminateProcess(grandchild.value,2)&&WaitForSingleObject(grandchild.value,5000)==WAIT_OBJECT_0);grandchild.close();const auto cleanDeadline=GetTickCount64()+5000;while(!retainedEngineCensus(job.value,*cache)){require(GetTickCount64()<cleanDeadline);Sleep(5);}checkpoint("retained-engine-grandchild-cleaned-complete");completeRetainedEngineAttempt(*cache,job.value,first);
  // A third same-image Python remains denied: exact generations and lineage
  // are required, even if it is a direct child of the owner.
  checkpoint("retained-engine-other-python-negative");STARTUPINFOW extraStartup{};extraStartup.cb=sizeof(extraStartup);auto extraCommand=quote(python)+L" --retained-fixture-leaf";PROCESS_INFORMATION extraProcess{};require(CreateProcessW(python.c_str(),extraCommand.data(),nullptr,nullptr,FALSE,DETACHED_PROCESS,nullptr,nullptr,&extraStartup,&extraProcess));Handle extra(extraProcess.hProcess),extraThread(extraProcess.hThread);Children extraCleanup{&extra,nullptr};
  require(!retainedEngineCensus(job.value,*cache));rejects("JOB_BUSY",[&]{beginRetainedEngineAttempt(*cache,job.value,second);});require(TerminateProcess(extra.value,2)&&WaitForSingleObject(extra.value,5000)==WAIT_OBJECT_0);extra.close();extraThread.close();
  const auto extraExitDeadline=GetTickCount64()+5000;while(!retainedEngineCensus(job.value,*cache)){require(GetTickCount64()<extraExitDeadline);Sleep(5);}
  // Even a registered idle cache cannot release the ordinary physical guard.
  boundGpuRole=std::make_unique<BoundGpuRole>();boundGpuRole->owner=owner;boundGpuRole->job=inheritedCopy(job.value,0,true);boundGpuRole->process=inheritedCopy(GetCurrentProcess(),PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE);retainedEngine=std::move(cache);
  require(!retainedEngineQuiescent());
  OwnedGpuGuard guard;guard.roleBound=true;guard.nonce=randomHex();guard.identity=processIdentity(GetCurrentProcessId());guard.job=inheritedCopy(job.value,0,true);guard.keeper=inheritedCopy(GetCurrentProcess(),SYNCHRONIZE);const auto guardNonce=guard.nonce;gpuGuards.emplace("0000000000000000",std::move(guard));
  require(retainedEngineQuiescent());retainedEngine->busyJob=first;require(!retainedEngineQuiescent());retainedEngine->busyJob.clear();
  checkpoint("retained-engine-physical-release-denied");rejects("GPU_GUARD_UNSAFE",[&]{(void)releaseGpuGuard(Json::Object{{"luid","0000000000000000"},{"nonce",guardNonce},{"identity",processIdentity(GetCurrentProcessId())}});});
  checkpoint("retained-engine-missing-peer-denied");require(TerminateProcess(engine.value,2)&&WaitForSingleObject(engine.value,5000)==WAIT_OBJECT_0);require(!retainedEngineCensus(job.value,*retainedEngine)&&!retainedEngineQuiescent());rejects("GPU_GUARD_UNSAFE",[&]{retireRetainedEngineHandles(*retainedEngine,job.value);});
  require(TerminateProcess(guardian.value,2)&&WaitForSingleObject(guardian.value,5000)==WAIT_OBJECT_0);require(!retainedEngineQuiescent());
  // Job membership can briefly lag process signalling. Only the old positive
  // census qualifies retirement; no elapsed timeout is accepted as proof.
  const auto idleDeadline=GetTickCount64()+5000;while(!gpuRoleIdle(job.value,owner)){require(GetTickCount64()<idleDeadline);Sleep(5);}
  checkpoint("retained-engine-forget-after-exit");retireRetainedEngineHandles(*retainedEngine,job.value);require(!retainedEngine->guardian.valid()&&!retainedEngine->engine.valid());retainedEngine.reset();boundGpuRole.reset();gpuGuards.clear();guardian.close();engine.close();thread.close();
  require(cachePathAllowed("personal\\engine-session\\11111111-1111-4111-8111-111111111111\\cache.bin"));require(!cachePathAllowed("personal\\engine-session\\arbitrary\\cache.bin"));
}
Json currentBrowserBirth() {auto file=openBrowserFile(browserManifestPath());return browserFileBirth(file.value);}
void fixtureBrowserCreation(const std::string& text) {
  const auto value=std::stoull(text);const FILETIME time{static_cast<DWORD>(value),static_cast<DWORD>(value>>32)};
  auto file=openBrowserFile(browserManifestPath(),true,true);require(SetFileTime(file.value,&time,nullptr,nullptr));
}
void libraryRenameFixtures() {
  // Exercise the actual internal mutation core in private short-path fixtures.
  // These calls do not grant installed app, journal or public wire authority.
  checkpoint("library-handle-renames");
  const auto root=rootPath("personal");directory("personal","native-library-move");
  const auto base=root+L"\\native-library-move",stage=base+L"\\stage.bin",published=base+L"\\published.bin",conflict=base+L"\\conflict.bin";
  writeFixture(stage,"library-publication");writeFixture(conflict,"foreign-publication");
  {
    auto sourceParents=lockAncestors(stage,false,false,root,true);auto targetParents=lockAncestors(published,false,false,root,true);
    bool absent=false,busy=false;auto held=openCacheDeleteEntry(stage,false,absent,busy,true);require(held.valid()&&!absent&&!busy);
    const auto birth=cacheHandleBirth(held.value);const auto sha=hashFile(held.value);require(sha==repairBytesDigest("library-publication"));
    checkpoint("library-whole-file-hash");
    LARGE_INTEGER offset{};offset.QuadPart=5;require(SetFilePointerEx(held.value,offset,nullptr,FILE_BEGIN));
    require(hashFile(held.value)==sha); // Nonzero starting offset.
    require(hashFile(held.value)==sha); // Repeated retained-handle hash at EOF.
    constexpr std::uint64_t publicationBytes=sizeof("library-publication")-1;
    require(hashFile(held.value,publicationBytes)==sha);
    rejects("HELPER_INTEGRITY_INVALID",[&]{(void)hashFile(held.value,publicationBytes-1);});
    require(hashFile(held.value,publicationBytes)==sha); // Recover after a bound rejection.
    checkpoint("library-file-publication");
    renameLibraryHandle(held.value,published);
    require(cleanupAbsent(stage));
    require(mm::dump(cacheHandleBirth(held.value))==mm::dump(birth));
    require(hashFile(held.value)==sha);
    rejects("PATH_UNSAFE",[&]{renameLibraryHandle(held.value,conflict);});
    require(mm::dump(cacheHandleBirth(held.value))==mm::dump(birth));
    require(hashFile(held.value)==sha);
  }
  {auto exact=lockHashedFile(published,repairBytesDigest("library-publication"));require(exact.valid());}
  {auto exact=lockHashedFile(conflict,repairBytesDigest("foreign-publication"));require(exact.valid());}
  directory("personal","native-library-move\\tree");directory("personal","native-library-move\\tree-conflict");
  const auto tree=base+L"\\tree",tombstone=base+L"\\tree-deleted",treeConflict=base+L"\\tree-conflict";
  writeFixture(tree+L"\\original.wav","library-tree");writeFixture(treeConflict+L"\\original.wav","foreign-tree");
  {
    auto sourceParents=lockAncestors(tree,false,false,root,true);auto targetParents=lockAncestors(tombstone,false,false,root,true);
    bool absent=false,busy=false;auto held=openCacheDeleteEntry(tree,true,absent,busy);require(held.valid()&&!absent&&!busy);const auto birth=cacheHandleBirth(held.value);
    renameLibraryHandle(held.value,tombstone);require(cleanupAbsent(tree));require(mm::dump(cacheHandleBirth(held.value))==mm::dump(birth));
    renameLibraryHandle(held.value,tree);require(cleanupAbsent(tombstone));require(mm::dump(cacheHandleBirth(held.value))==mm::dump(birth));
    rejects("PATH_UNSAFE",[&]{renameLibraryHandle(held.value,treeConflict);});require(mm::dump(cacheHandleBirth(held.value))==mm::dump(birth));
  }
  {auto exact=lockHashedFile(tree+L"\\original.wav",repairBytesDigest("library-tree"));require(exact.valid());}
  {auto exact=lockHashedFile(treeConflict+L"\\original.wav",repairBytesDigest("foreign-tree"));require(exact.valid());}
  checkpoint("remaining-isolated-checks");
}
// Candidate-only bounded mount-point probe. Every path belongs to the random
// native fixture root; an in-place mutation is restored through its exact handle.
struct FixtureMountPointData {
  DWORD tag; WORD length; WORD reserved;
  WORD substituteOffset; WORD substituteLength; WORD printOffset; WORD printLength;
};
static_assert(sizeof(FixtureMountPointData)==16);
struct FixtureReparseHeader {DWORD tag;WORD length;WORD reserved;};
static_assert(sizeof(FixtureReparseHeader)==8);
std::vector<BYTE> fixtureMountPointBytes(const std::wstring& target) {
  const auto substitute=L"\\??\\"+target;
  const auto substituteBytes=substitute.size()*sizeof(wchar_t),printBytes=target.size()*sizeof(wchar_t);
  const auto dataBytes=8+substituteBytes+printBytes+2*sizeof(wchar_t);
  require(dataBytes<=16376&&dataBytes<=65535);
  std::vector<BYTE> buffer(sizeof(FixtureMountPointData)+substituteBytes+printBytes+2*sizeof(wchar_t));
  auto* info=reinterpret_cast<FixtureMountPointData*>(buffer.data());
  info->tag=IO_REPARSE_TAG_MOUNT_POINT;info->length=static_cast<WORD>(dataBytes);
  info->substituteLength=static_cast<WORD>(substituteBytes);
  info->printOffset=static_cast<WORD>(substituteBytes+sizeof(wchar_t));info->printLength=static_cast<WORD>(printBytes);
  std::memcpy(buffer.data()+sizeof(FixtureMountPointData),substitute.data(),substituteBytes);
  std::memcpy(buffer.data()+sizeof(FixtureMountPointData)+info->printOffset,target.data(),printBytes);
  return buffer;
}
struct FixtureReparseRestore {
  HANDLE file;BY_HANDLE_FILE_INFORMATION original;bool active=false;bool restored=true;
  bool restore() noexcept {
    if(!active)return restored;
    BY_HANDLE_FILE_INFORMATION before{},after{};DWORD returned=0;
    const bool same=GetFileInformationByHandle(file,&before)&&before.dwVolumeSerialNumber==original.dwVolumeSerialNumber&&before.nFileIndexHigh==original.nFileIndexHigh&&before.nFileIndexLow==original.nFileIndexLow&&before.ftCreationTime.dwHighDateTime==original.ftCreationTime.dwHighDateTime&&before.ftCreationTime.dwLowDateTime==original.ftCreationTime.dwLowDateTime;
    FixtureReparseHeader header{IO_REPARSE_TAG_MOUNT_POINT,0,0};
    restored=same&&DeviceIoControl(file,FSCTL_DELETE_REPARSE_POINT,&header,sizeof(header),nullptr,0,&returned,nullptr)&&GetFileInformationByHandle(file,&after)&&after.dwVolumeSerialNumber==original.dwVolumeSerialNumber&&after.nFileIndexHigh==original.nFileIndexHigh&&after.nFileIndexLow==original.nFileIndexLow&&after.ftCreationTime.dwHighDateTime==original.ftCreationTime.dwHighDateTime&&after.ftCreationTime.dwLowDateTime==original.ftCreationTime.dwLowDateTime&&!(after.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT);
    if(restored)active=false;
    return restored;
  }
  ~FixtureReparseRestore(){if(active&&!restore())std::cerr<<"Native fixture reparse restoration unconfirmed\n";}
};
void emptyDirectoryReparseFixtures() {
  checkpoint("empty-directory-reparse-probe");
  const auto root=rootPath("personal");const std::string relative="native-policy-fixtures\\reparse-probe";
  for(const auto* name:{"target","control","held","nonempty"})directory("personal",relative+"\\"+name);
  const auto base=root+L"\\"+wide(relative),target=base+L"\\target";
  writeFixture(target+L"\\sentinel.bin","reparse-target-sentinel");
  auto targetSentinel=lockHashedFile(target+L"\\sentinel.bin",repairBytesDigest("reparse-target-sentinel"));
  auto targetParents=lockAncestors(target,false,true,root,true);
  constexpr DWORD metadataSharing=FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE;
  {auto sentinel=openNativeChild(targetParents.back().value,L"sentinel.bin",FILE_READ_ATTRIBUTES|READ_CONTROL,metadataSharing,NativeChildKind::file,NativeChildDisposition::open);require(sentinel.handle.valid()&&sentinel.status==0);require(mm::dump(cacheHandleBirth(sentinel.handle.value))==mm::dump(cacheHandleBirth(targetSentinel.value)));}
  writeFixture(base+L"\\nonempty\\child.bin","nonempty-control");
  const auto buffer=fixtureMountPointBytes(target);
  // Prove the relative primitive can create/read an ordinary private child.
  {
    auto parent=openEntry(base+L"\\control",true,true,false,true);Security childSecurity(dataSddl());
    auto child=openNativeChild(parent.value,L"preflight.bin",GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::createNew,childSecurity.attributes.lpSecurityDescriptor);
    require(child.handle.valid()&&child.status==0);assertPrivateHandle(child.handle.value);
    const std::string contents="relative-preflight";DWORD wrote=0;require(WriteFile(child.handle.value,contents.data(),static_cast<DWORD>(contents.size()),&wrote,nullptr)&&wrote==contents.size());require(hashFile(child.handle.value)==repairBytesDigest(contents));
    FILE_DISPOSITION_INFO remove{};remove.DeleteFile=TRUE;require(SetFileInformationByHandle(child.handle.value,FileDispositionInfo,&remove,sizeof(remove)));child.handle.close();require(cleanupAbsent(base+L"\\control\\preflight.bin"));
    rejects("PATH_UNSAFE",[&]{(void)openNativeChild(parent.value,L"..\\escape.bin",GENERIC_READ,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);});
    rejects("PATH_UNSAFE",[&]{(void)openNativeChild(parent.value,L"file:stream",GENERIC_READ,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);});
  }
  bool relativeAttempted=false,relativeContained=false,relativeTargetAbsent=false,productionWalkRejected=false,productionCreateRejected=false,productionInventoryRejected=false,productionMissingRejected=false;
  auto probe=[&](const char* label,const std::wstring& path,bool held) {
    std::vector<Handle> parents;if(held)parents=lockAncestors(path,false,true,root,true);
    Handle attacker(CreateFileW(path.c_str(),FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));require(attacker.valid());assertPrivateHandle(attacker.value);
    BY_HANDLE_FILE_INFORMATION original{};require(GetFileInformationByHandle(attacker.value,&original)&&!(original.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
    if(held)require(mm::dump(cacheHandleBirth(parents.back().value))==mm::dump(cacheHandleBirth(attacker.value)));
    FixtureReparseRestore restore{attacker.value,original};DWORD returned=0;
    const auto set=DeviceIoControl(attacker.value,FSCTL_SET_REPARSE_POINT,const_cast<BYTE*>(buffer.data()),static_cast<DWORD>(buffer.size()),nullptr,0,&returned,nullptr);const auto error=GetLastError();restore.active=set!=FALSE;
    std::cerr<<"Native fixture reparse probe: case="<<label<<"; set="<<(set?1:0)<<"; win32_error="<<(set?0:error)<<'\n';
    if(set)rejects("PATH_UNSAFE",[&]{(void)openEntry(path,true,true);});
    if(set&&held){
      relativeAttempted=true;Security childSecurity(dataSddl());
      auto rejected=[&](auto action){try{action();}catch(const Failure& failure){return failure.code=="PATH_UNSAFE";}return false;};
      productionWalkRejected=rejected([&]{(void)openNativePath(path+L"\\sentinel.bin",GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file);});
      productionCreateRejected=rejected([&]{(void)lockAncestors(path+L"\\new-private",true,true,root);});
      productionInventoryRejected=rejected([&]{(void)enumerateNativeDirectory(parents.back().value);});
      productionMissingRejected=rejected([&]{(void)nativeChildMissing(parents.back().value,L"absent.bin");})&&rejected([&]{(void)nativePathMissing(path+L"\\absent.bin");});

      auto child=openNativeChild(parents.back().value,L"contained.bin",GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::createNew,childSecurity.attributes.lpSecurityDescriptor);
      std::cerr<<"Native fixture relative child: created="<<(child.handle.valid()?1:0)<<"; ntstatus="<<static_cast<ULONG>(child.status)<<'\n';
      auto targetLeaf=openNativeChild(targetParents.back().value,L"contained.bin",FILE_READ_ATTRIBUTES|READ_CONTROL,metadataSharing,NativeChildKind::file,NativeChildDisposition::open);const auto lookupError=GetLastError();
      relativeTargetAbsent=!targetLeaf.handle.valid()&&static_cast<ULONG>(targetLeaf.status)==0xc0000034UL&&lookupError==ERROR_FILE_NOT_FOUND;
      std::cerr<<"Native fixture relative child target: absent="<<(relativeTargetAbsent?1:0)<<"; ntstatus="<<static_cast<ULONG>(targetLeaf.status)<<"; win32_error="<<(targetLeaf.handle.valid()?0:lookupError)<<'\n';targetLeaf.handle.close();
      if(child.handle.valid()){
        assertPrivateHandle(child.handle.value);std::vector<wchar_t> finalName(32768);const auto count=GetFinalPathNameByHandleW(child.handle.value,finalName.data(),static_cast<DWORD>(finalName.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
        std::wstring actual;if(count&&count<finalName.size())actual.assign(finalName.data(),count);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);relativeContained=_wcsicmp(actual.c_str(),(path+L"\\contained.bin").c_str())==0;
        // Only this CREATE_NEW handle is retired, even on a failed containment proof.
        FILE_DISPOSITION_INFO remove{};remove.DeleteFile=TRUE;require(SetFileInformationByHandle(child.handle.value,FileDispositionInfo,&remove,sizeof(remove)));child.handle.close();
      }else relativeContained=static_cast<ULONG>(child.status)==0xc0000280UL; // STATUS_REPARSE_POINT_ENCOUNTERED, not a generic open denial.
    }
    require(restore.restore());
    require(mm::dump(cacheHandleBirth(attacker.value))==mm::dump(cacheHandleBirth(openEntry(path,true,true).value)));
    return std::pair<bool,DWORD>{set!=FALSE,set?0:error};
  };
  const auto control=probe("unheld-empty",base+L"\\control",false);
  const auto nonempty=probe("nonempty",base+L"\\nonempty",true);
  const auto held=probe("held-empty",base+L"\\held",true);
  require(control.first);
  require(!nonempty.first&&nonempty.second==ERROR_DIR_NOT_EMPTY);
  require(hashFile(targetSentinel.value)==repairBytesDigest("reparse-target-sentinel"));
  // The OS may permit in-place metadata mutation. Secure child operations must
  // reject that parent or remain within its original retained directory object.
  require(cleanupAbsent(target+L"\\contained.bin"));
  require(!held.first||(relativeAttempted&&relativeContained&&relativeTargetAbsent));
  require(held.first&&productionWalkRejected&&productionCreateRejected&&productionInventoryRejected&&productionMissingRejected);
  require(nativeChildMissing(targetParents.back().value,L"new-private"));
}

std::wstring fixtureCanonicalPath(HANDLE file) {
  std::vector<wchar_t> name(32768);
  const auto count=GetFinalPathNameByHandleW(file,name.data(),static_cast<DWORD>(name.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  require(count&&count<name.size());std::wstring path(name.data(),count);
  if(path.starts_with(L"\\\\?\\"))path.erase(0,4);
  return path;
}
void relativeDirectoryRenameFixtures() {
  checkpoint("relative-rename-ordinary");
  const auto root=rootPath("personal");const std::string relative="native-rename-probe";
  for(const auto* name:{"stage","ordinary","held","target"})directory("personal",relative+"\\"+name);
  const auto base=root+L"\\"+wide(relative),stagePath=base+L"\\stage\\source.bin",ordinaryPath=base+L"\\ordinary\\published.bin",heldPath=base+L"\\held",targetPath=base+L"\\target";
  require((targetPath+L"\\contained.bin").size()<MAX_PATH);
  writeFixture(stagePath,"relative-rename-source");
  writeFixture(base+L"\\ordinary\\foreign.bin","foreign-rename-target");
  writeFixture(targetPath+L"\\sentinel.bin","rename-target-sentinel");
  auto targetSentinel=lockHashedFile(targetPath+L"\\sentinel.bin",repairBytesDigest("rename-target-sentinel"));
  auto ancestors=lockAncestors(base,false,true,root,true);
  auto directoryHandle=[&](const std::wstring& leaf){
    // A target-directory relative rename requires traverse access. Keep read
    // sharing fences while allowing the kernel's child-publication write open.
    auto opened=openNativeChild(ancestors.back().value,leaf,FILE_TRAVERSE|FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NativeChildKind::directory,NativeChildDisposition::open);
    require(opened.handle.valid()&&opened.status==0);assertPrivateHandle(opened.handle.value);
    BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(opened.handle.value,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY));
    require(_wcsicmp(fixtureCanonicalPath(opened.handle.value).c_str(),(base+L"\\"+leaf).c_str())==0);
    return std::move(opened.handle);
  };
  auto stageParent=directoryHandle(L"stage"),ordinaryParent=directoryHandle(L"ordinary"),heldParent=directoryHandle(L"held"),targetParent=directoryHandle(L"target");
  auto source=openNativeChild(stageParent.value,L"source.bin",GENERIC_READ|DELETE|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);
  require(source.handle.valid()&&source.status==0);assertPrivateHandle(source.handle.value);
  BY_HANDLE_FILE_INFORMATION sourceInfo{};require(GetFileInformationByHandle(source.handle.value,&sourceInfo)&&!(sourceInfo.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&sourceInfo.nNumberOfLinks==1);
  require(_wcsicmp(fixtureCanonicalPath(source.handle.value).c_str(),stagePath.c_str())==0);
  const auto birth=cacheHandleBirth(source.handle.value),sentinelBirth=cacheHandleBirth(targetSentinel.value);
  const auto sha=hashFile(source.handle.value);require(sha==repairBytesDigest("relative-rename-source"));
  const auto publication=renameNativeChild(source.handle.value,ordinaryParent.value,L"published.bin");const bool published=publication.status==0;
  std::cerr<<"Native fixture relative rename: case=ordinary; renamed="<<(published?1:0)<<"; ntstatus="<<static_cast<ULONG>(publication.status)<<"; win32_error="<<publication.error<<'\n';
  require(published);
  require(cleanupAbsent(stagePath));
  require(_wcsicmp(fixtureCanonicalPath(source.handle.value).c_str(),ordinaryPath.c_str())==0);
  require(mm::dump(cacheHandleBirth(source.handle.value))==mm::dump(birth));require(hashFile(source.handle.value)==sha);
  checkpoint("relative-rename-conflict");
  // The foreign leaf is deliberately unlocked: ReplaceIfExists FALSE, rather
  // than a foreign reader's share denial, must preserve its original payload.
  const auto conflict=renameNativeChild(source.handle.value,ordinaryParent.value,L"foreign.bin");const bool replaced=conflict.status==0;
  std::cerr<<"Native fixture relative rename: case=conflict; renamed="<<(replaced?1:0)<<"; ntstatus="<<static_cast<ULONG>(conflict.status)<<"; win32_error="<<conflict.error<<'\n';
  require(!replaced);
  require(_wcsicmp(fixtureCanonicalPath(source.handle.value).c_str(),ordinaryPath.c_str())==0);
  require(mm::dump(cacheHandleBirth(source.handle.value))==mm::dump(birth));require(hashFile(source.handle.value)==sha);
  {auto foreign=openNativeChild(ordinaryParent.value,L"foreign.bin",GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);require(foreign.handle.valid()&&foreign.status==0);assertPrivateHandle(foreign.handle.value);require(hashFile(foreign.handle.value)==repairBytesDigest("foreign-rename-target"));}
  rejects("PATH_UNSAFE",[&]{(void)renameNativeChild(source.handle.value,ordinaryParent.value,L"..\\escape.bin");});
  rejects("PATH_UNSAFE",[&]{(void)renameNativeChild(source.handle.value,ordinaryParent.value,L"file:stream");});
  const auto returnedToStage=renameNativeChild(source.handle.value,stageParent.value,L"source.bin");
  std::cerr<<"Native fixture relative rename: case=return-stage; renamed="<<(returnedToStage.status==0?1:0)<<"; ntstatus="<<static_cast<ULONG>(returnedToStage.status)<<"; win32_error="<<returnedToStage.error<<'\n';
  require(returnedToStage.status==0);
  require(_wcsicmp(fixtureCanonicalPath(source.handle.value).c_str(),stagePath.c_str())==0);
  require(mm::dump(cacheHandleBirth(source.handle.value))==mm::dump(birth));require(hashFile(source.handle.value)==sha);
  // This independent retained target proves the metadata lookup rights and
  // sharing before it is used to distinguish a missing leaf from any denial.
  constexpr DWORD metadataSharing=FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE;
  {auto sentinel=openNativeChild(targetParent.value,L"sentinel.bin",FILE_READ_ATTRIBUTES|READ_CONTROL,metadataSharing,NativeChildKind::file,NativeChildDisposition::open);require(sentinel.handle.valid()&&sentinel.status==0);assertPrivateHandle(sentinel.handle.value);require(mm::dump(cacheHandleBirth(sentinel.handle.value))==mm::dump(sentinelBirth));}
  ULONG targetLookupStatus=0;DWORD targetLookupError=0;
  auto missingTarget=[&](){
    auto leaf=openNativeChild(targetParent.value,L"contained.bin",FILE_READ_ATTRIBUTES|READ_CONTROL,metadataSharing,NativeChildKind::file,NativeChildDisposition::open);const auto error=GetLastError();
    targetLookupStatus=static_cast<ULONG>(leaf.status);targetLookupError=error;
    return !leaf.handle.valid()&&static_cast<ULONG>(leaf.status)==0xc0000034UL&&error==ERROR_FILE_NOT_FOUND;
  };
  require(missingTarget());
  checkpoint("relative-rename-reparse");
  Handle attacker(CreateFileW(heldPath.c_str(),FILE_WRITE_ATTRIBUTES|READ_CONTROL,metadataSharing,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));require(attacker.valid());assertPrivateHandle(attacker.value);
  BY_HANDLE_FILE_INFORMATION original{};require(GetFileInformationByHandle(attacker.value,&original)&&!(original.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
  require(mm::dump(cacheHandleBirth(attacker.value))==mm::dump(cacheHandleBirth(heldParent.value)));
  FixtureReparseRestore restore{attacker.value,original};const auto buffer=fixtureMountPointBytes(targetPath);DWORD returned=0;
  const auto set=DeviceIoControl(attacker.value,FSCTL_SET_REPARSE_POINT,const_cast<BYTE*>(buffer.data()),static_cast<DWORD>(buffer.size()),nullptr,0,&returned,nullptr);const auto setError=GetLastError();restore.active=set!=FALSE;
  std::cerr<<"Native fixture relative rename reparse: set="<<(set?1:0)<<"; win32_error="<<(set?0:setError)<<'\n';
  bool renamed=false,contained=false,stable=false,targetAbsent=false,removed=false;NTSTATUS renameStatus=0;DWORD renameError=0;
  if(set){
    const auto mutation=renameNativeChild(source.handle.value,heldParent.value,L"contained.bin");renameStatus=mutation.status;renameError=mutation.error;renamed=renameStatus==0;
    const auto actualSource=fixtureCanonicalPath(source.handle.value),expectedSource=renamed?heldPath+L"\\contained.bin":stagePath;
    contained=_wcsicmp(actualSource.c_str(),expectedSource.c_str())==0;
    stable=mm::dump(cacheHandleBirth(source.handle.value))==mm::dump(birth)&&hashFile(source.handle.value)==sha;
    targetAbsent=missingTarget();
    // Retire only the original source fixture handle, even if containment fails.
    // The target metadata lookup closes before disposition is submitted.
    FILE_DISPOSITION_INFO remove{};remove.DeleteFile=TRUE;removed=SetFileInformationByHandle(source.handle.value,FileDispositionInfo,&remove,sizeof(remove))!=FALSE;source.handle.close();
  }
  const auto restored=restore.restore();
  std::cerr<<"Native fixture relative rename: case=held-reparse; attempted="<<(set?1:0)<<"; renamed="<<(renamed?1:0)<<"; ntstatus="<<static_cast<ULONG>(renameStatus)<<"; win32_error="<<renameError<<"; contained="<<(contained?1:0)<<"; target_absent="<<(targetAbsent?1:0)<<"; target_lookup_ntstatus="<<targetLookupStatus<<"; target_lookup_win32_error="<<targetLookupError<<"; restored="<<(restored?1:0)<<'\n';
  // Restore the original directory object before every final safety assertion
  // or the main test's recursive cleanup. A blocked mutation is no attack proof.
  require(restored);
  require(mm::dump(cacheHandleBirth(attacker.value))==mm::dump(cacheHandleBirth(heldParent.value)));
  require(set!=FALSE);
  require(stable&&removed);
  require(mm::dump(cacheHandleBirth(targetSentinel.value))==mm::dump(sentinelBirth));require(hashFile(targetSentinel.value)==repairBytesDigest("rename-target-sentinel"));
  require(targetAbsent&&missingTarget());
  require(cleanupAbsent(stagePath)&&cleanupAbsent(heldPath+L"\\contained.bin"));
  require(contained);
}



void centralNativePathFixtures(){
  checkpoint("central-native-paths");const auto root=rootPath("personal");directory("personal","native-boundary\\ordinary\\child");directory("personal","native-boundary\\foreign");const auto base=root+L"\\native-boundary",ordinary=base+L"\\ordinary",child=ordinary+L"\\child",file=ordinary+L"\\source.bin";writeFixture(file,"held-relative-file");
  auto parents=lockAncestors(ordinary,false,true,root);require(_wcsicmp(nativeCanonical(parents.back().value).c_str(),ordinary.c_str())==0);require(parents.size()==nativePathComponents(ordinary).size());
  require(nativeChildMissing(parents.back().value,L"absent.bin"));require(!nativeChildMissing(parents.back().value,L"source.bin"));require(!nativeChildMissing(parents.back().value,L"child"));require(nativePathMissing(ordinary+L"\\absent.bin"));require(nativePathMissing(ordinary+L"\\absent-parent\\leaf.bin",true));rejects("PATH_UNSAFE",[&]{(void)nativePathMissing(ordinary+L"\\absent-parent\\leaf.bin");});
  {auto opened=openNativePath(file,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file);require(opened.handle.valid());require(hashFile(opened.handle.value)==repairBytesDigest("held-relative-file"));Handle writer(CreateFileW(file.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));require(!writer.valid()&&GetLastError()==ERROR_SHARING_VIOLATION);require(!nativePathMissing(file));}
  const auto rows=enumerateNativeDirectory(parents.back().value);require(rows.size()==2);bool sawFile=false,sawDirectory=false;for(const auto& row:rows){if(row.name==L"source.bin")sawFile=!(row.attributes&FILE_ATTRIBUTE_DIRECTORY);if(row.name==L"child")sawDirectory=(row.attributes&FILE_ATTRIBUTE_DIRECTORY)!=0;}require(sawFile&&sawDirectory);rejects("PATH_UNSAFE",[&]{(void)enumerateNativeDirectory(parents.back().value,1);});
  // Recursive deletion callers reuse the exact DELETE directory rather than
  // reopening its ancestors and weakening the no-delete-sharing fence.
  auto deletion=openNativeChild(parents.back().value,L"child",DELETE|FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::directory,NativeChildDisposition::open);require(deletion.handle.valid());require(enumerateNativeDirectory(deletion.handle.value).empty());require(nativeChildMissing(deletion.handle.value,L"gone.bin"));Security security(dataSddl());auto created=openNativeChild(deletion.handle.value,L"owned.bin",GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::createNew,security.descriptor,true);require(created.handle.valid());const std::string text="write-through-child";DWORD wrote=0;require(WriteFile(created.handle.value,text.data(),static_cast<DWORD>(text.size()),&wrote,nullptr)&&wrote==text.size());require(FlushFileBuffers(created.handle.value));require(hashFile(created.handle.value)==repairBytesDigest(text));FILE_DISPOSITION_INFO remove{TRUE};require(SetFileInformationByHandle(created.handle.value,FileDispositionInfo,&remove,sizeof(remove)));created.handle.close();require(nativeChildMissing(deletion.handle.value,L"owned.bin"));
  // Parse only bounded actual WinSDK directory-record layouts. Malformed
  // lengths, offsets, traversal and embedded NULs never become child names.
  constexpr auto header=offsetof(FILE_ID_BOTH_DIR_INFO,FileName);auto synthetic=[&](const std::wstring& name){std::vector<BYTE> bytes(header+name.size()*sizeof(wchar_t));auto* row=reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(bytes.data());row->FileNameLength=static_cast<DWORD>(name.size()*sizeof(wchar_t));row->FileAttributes=FILE_ATTRIBUTE_NORMAL;std::memcpy(row->FileName,name.data(),row->FileNameLength);return bytes;};
  const auto valid=synthetic(L"file.bin");require(decodeNativeDirectoryBuffer(valid,1).front().name==L"file.bin");
  auto malformed=valid;reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(malformed.data())->FileNameLength=3;rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(malformed,1);});malformed=valid;reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(malformed.data())->NextEntryOffset=1;rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(malformed,1);});malformed=valid;reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(malformed.data())->NextEntryOffset=65528;rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(malformed,1);});rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(synthetic(L"..\\escape"),1);});rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(synthetic(std::wstring(L"nul\0leaf",8)),1);});rejects("PATH_UNSAFE",[&]{(void)decodeNativeDirectoryBuffer(valid,0);});
}
void vaultReplacementFixtures(){
  checkpoint("vault-exact-replacement");const auto root=rootPath("personal"),base=root+L"\\vault\\account";const std::string key="native_transaction";const Json args=Json::Object{{"namespace","account"},{"key",key}};auto put=[&](const std::string& text){auto value=args.object();value["bytes_base64"]=base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()));return vault("vault_put",value);};
  for(const auto fault:{VaultReplaceFault::intent,VaultReplaceFault::backedUp,VaultReplaceFault::renamed}){
    (void)put("old-ciphertext");auto parents=lockAncestors(base,false,true,root);bool absent=false;auto before=vaultOpen(parents.back().value,base,wide(key)+L".dpapi",false,absent);require(!absent);const auto old=vaultPin(before.value);before.close();vaultReplaceFault=fault;rejects("VAULT_UNAVAILABLE",[&]{(void)put("new-ciphertext");});vaultReplaceFault=VaultReplaceFault::none;require(!nativeChildMissing(parents.back().value,L".replace-"+wide(key)));
    const auto entries=enumerateNativeDirectory(parents.back().value);std::size_t stages=0,backups=0;for(const auto& row:entries){if(row.name.starts_with(L".txn-")&&row.name.ends_with(L".new"))++stages;if(row.name.starts_with(L".txn-")&&row.name.ends_with(L".old")){++backups;auto held=vaultOpen(parents.back().value,base,row.name,false,absent);require(!absent&&sameVaultPin(held.value,old));}}if(fault==VaultReplaceFault::intent){auto held=vaultOpen(parents.back().value,base,wide(key)+L".dpapi",false,absent);require(!absent&&sameVaultPin(held.value,old));require(stages==1&&backups==0);}else require(backups==1);
    require(vault("vault_get",args).at("bytes_base64").string()==base64Encode(reinterpret_cast<const BYTE*>("new-ciphertext"),14));require(nativeChildMissing(parents.back().value,L".replace-"+wide(key)));for(const auto& row:enumerateNativeDirectory(parents.back().value))require(!row.name.starts_with(L".txn-"));
  }
  // A same-content foreign active generation cannot satisfy the intent's birth.
  (void)put("old-again");vaultReplaceFault=VaultReplaceFault::backedUp;rejects("VAULT_UNAVAILABLE",[&]{(void)put("new-again");});vaultReplaceFault=VaultReplaceFault::none;auto parents=lockAncestors(base,false,true,root);std::wstring stageName,backupName;for(const auto& row:enumerateNativeDirectory(parents.back().value)){if(row.name.starts_with(L".txn-")&&row.name.ends_with(L".new"))stageName=row.name;if(row.name.starts_with(L".txn-")&&row.name.ends_with(L".old"))backupName=row.name;}require(!stageName.empty()&&!backupName.empty());bool absent=false;Json stagePin,backupPin;std::vector<BYTE> bytes;{auto stage=vaultOpen(parents.back().value,base,stageName,false,absent);require(!absent);stagePin=vaultPin(stage.value);bytes=readVaultBlob(stage.value,"MMCV0001");auto backup=vaultOpen(parents.back().value,base,backupName,false,absent);require(!absent);backupPin=vaultPin(backup.value);}
  writeFixture(base+L"\\"+wide(key)+L".dpapi",std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size()));rejects("VAULT_RECOVERY_REQUIRED",[&]{(void)vault("vault_get",args);});{auto stage=vaultOpen(parents.back().value,base,stageName,false,absent);require(!absent&&sameVaultPin(stage.value,stagePin));auto backup=vaultOpen(parents.back().value,base,backupName,false,absent);require(!absent&&sameVaultPin(backup.value,backupPin));auto foreign=vaultOpen(parents.back().value,base,wide(key)+L".dpapi",true,absent);require(!absent&&!sameVaultPin(foreign.value,stagePin));vaultRetire(foreign);}require(vault("vault_get",args).at("bytes_base64").string()==base64Encode(reinterpret_cast<const BYTE*>("new-again"),9));(void)vault("vault_delete",args);
}
void vaultLegacyRecoveryFixtures(){
  checkpoint("vault-legacy-staging-policy");const auto root=rootPath("personal"),base=root+L"\\vault\\account";auto parents=lockAncestors(base,true,true,root);const auto parent=parents.back().value;std::vector<std::wstring> names;
  for(unsigned count=0;count<16;++count){const auto name=L".pending-"+wide(randomHex());writeFixture(base+L"\\"+name,"legacy-encrypted-staging");names.push_back(name);}
  checkpoint("vault-legacy-limit16");
  rejects("VAULT_RECOVERY_REQUIRED",[&]{(void)vault("vault_put",Json::Object{{"namespace","account"},{"key","legacy_limit"},{"bytes_base64","c3ludGhldGlj"}});});
  checkpoint("vault-legacy-retire16");
  for(const auto& name:names){bool absent=false;auto held=vaultOpen(parent,base,name,true,absent);require(!absent);vaultRetire(held);}require(nativeChildMissing(parent,L"legacy_limit.dpapi"));
  const auto legacy=L".pending-"+wide(randomHex()),orphan=L".txn-"+wide(randomHex())+L".new";writeFixture(base+L"\\"+legacy,"legacy-encrypted-staging");writeFixture(base+L"\\"+orphan,"orphan-encrypted-staging");FILETIME now{};GetSystemTimeAsFileTime(&now);const auto ticks=(static_cast<ULONGLONG>(now.dwHighDateTime)<<32)|now.dwLowDateTime;const auto prior=ticks-2ULL*864000000000ULL;const FILETIME old{static_cast<DWORD>(prior),static_cast<DWORD>(prior>>32)};
  checkpoint("vault-legacy-age-before");
  for(const auto& name:{legacy,orphan}){auto attributes=openNativeChild(parent,name,FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::file,NativeChildDisposition::open);require(attributes.handle.valid()&&SetFileTime(attributes.handle.value,nullptr,nullptr,&old));}
  checkpoint("vault-legacy-age-after");
  auto reader=lockHashedFile(base+L"\\"+legacy,repairBytesDigest("legacy-encrypted-staging"));checkpoint("vault-legacy-busy-recover");const auto pending=vaultRecover(Json::Object{{"namespace","account"}});require(pending.at("removed").integer()==0&&pending.at("skipped").integer()>=2);require(!nativeChildMissing(parent,legacy)&&!nativeChildMissing(parent,orphan));reader.close();checkpoint("vault-legacy-reader-closed-recover");const auto recovered=vaultRecover(Json::Object{{"namespace","account"}});require(recovered.at("removed").integer()==1&&recovered.at("skipped").integer()>=1);require(nativeChildMissing(parent,legacy)&&!nativeChildMissing(parent,orphan));bool absent=false;auto exact=vaultOpen(parent,base,orphan,true,absent);require(!absent);vaultRetire(exact);
  checkpoint("vault-stale-inventory-fresh-generation");
  const auto replaced=L".pending-"+wide(randomHex());writeFixture(base+L"\\"+replaced,"old-pending-generation");
  {auto attributes=openNativeChild(parent,replaced,FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::file,NativeChildDisposition::open);require(attributes.handle.valid()&&SetFileTime(attributes.handle.value,nullptr,nullptr,&old));}
  NativeDirectoryEntry stale{};bool found=false;for(const auto& row:enumerateNativeDirectory(parent))if(row.name==replaced){stale=row;found=true;}require(found);
  auto retainedOld=vaultOpen(parent,base,replaced,true,absent);require(!absent);const auto oldBirth=vaultBirth(retainedOld.value);const auto preserved=L".held-old-"+wide(randomHex());require(renameNativeChild(retainedOld.value,parent,preserved).status==0);
  writeFixture(base+L"\\"+replaced,"fresh-pending-generation");Json freshBirth;
  {auto held=vaultOpen(parent,base,replaced,true,absent);require(!absent);freshBirth=vaultBirth(held.value);require(freshBirth.at("file_id").string()!=oldBirth.at("file_id").string());require(SetFileTime(held.value,nullptr,nullptr,&now));}
  require(recoverLegacyVaultEntry(parent,base,stale,ticks)==VaultLegacyRecovery::skipped);
  {auto held=vaultOpen(parent,base,replaced,false,absent);require(!absent&&mm::dump(vaultBirth(held.value))==mm::dump(freshBirth));require(hashFile(held.value)==repairBytesDigest("fresh-pending-generation"));}
  const auto futureTicks=ticks+864000000000ULL;const FILETIME future{static_cast<DWORD>(futureTicks),static_cast<DWORD>(futureTicks>>32)};
  {auto attributes=openNativeChild(parent,replaced,FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::file,NativeChildDisposition::open);require(attributes.handle.valid()&&SetFileTime(attributes.handle.value,nullptr,nullptr,&future));}
  require(recoverLegacyVaultEntry(parent,base,stale,ticks)==VaultLegacyRecovery::skipped);require(!nativeChildMissing(parent,replaced));
  // Once that exact held generation is itself old, stale enumeration no longer
  // decides its eligibility; the actual handle supplies the required age.
  {auto attributes=openNativeChild(parent,replaced,FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::file,NativeChildDisposition::open);require(attributes.handle.valid()&&SetFileTime(attributes.handle.value,nullptr,nullptr,&old));}
  require(recoverLegacyVaultEntry(parent,base,stale,ticks)==VaultLegacyRecovery::removed);require(nativeChildMissing(parent,replaced));require(mm::dump(vaultBirth(retainedOld.value))==mm::dump(oldBirth));require(hashFile(retainedOld.value)==repairBytesDigest("old-pending-generation"));vaultRetire(retainedOld);require(nativeChildMissing(parent,preserved));
}

void retainedLauncherFixtures(){
  checkpoint("retained-launcher-transaction");const auto root=rootPath("fleet");directory("fleet","native-launcher");const auto base=root+L"\\native-launcher",destination=base+L"\\launcher.exe",source=base+L"\\source.exe";const std::string oldText="old-launcher",newText="new-launcher",publisher(64,'a');const auto oldSha=repairBytesDigest(oldText),newSha=repairBytesDigest(newText);writeFixture(source,newText);auto approved=lockHashedFile(source,newSha,false,16ULL*1024*1024);auto parents=lockAncestors(base,false,true,root);const auto parent=parents.back().value;
  const Json desired=Json::Object{{"sha256",newSha},{"publisher_sha256",publisher}};auto previous=[&](){return Json(Json::Object{{"sha256",oldSha},{"publisher_sha256",publisher}});};auto verifier=[&](const std::wstring& path,HANDLE held,const std::string& expected){require(expected==publisher);assertPrivateHandle(held);require(_wcsicmp(nativeCanonical(held).c_str(),path.c_str())==0);};auto publish=[&](){return retainLauncherFiles(parent,destination,approved.value,desired,previous,verifier);};
  for(const auto fault:{RetainedLauncherFault::none,RetainedLauncherFault::intent,RetainedLauncherFault::backedUp,RetainedLauncherFault::renamed,RetainedLauncherFault::published}){
    writeFixture(destination,oldText);retainedLauncherFault=fault;if(fault==RetainedLauncherFault::none)require(std::get<bool>(publish().at("retained").value));else{rejects("PATH_UNSAFE",[&]{(void)publish();});retainedLauncherFault=RetainedLauncherFault::none;require(!jsonNull(readLauncherChange()));if(fault==RetainedLauncherFault::intent){auto original=lockHashedFile(destination,oldSha);require(original.valid());}else{auto backup=lockHashedFile(destination+L".previous",oldSha);require(backup.valid());}require(std::get<bool>(publish().at("retained").value));}
    {auto current=lockHashedFile(destination,newSha);require(current.valid());}require(nativeChildMissing(parent,L"launcher.exe.pending")&&nativeChildMissing(parent,L"launcher.exe.previous")&&jsonNull(readLauncherChange()));
  }
  // Failed staging pin validation leaves the exact prior launcher untouched.
  writeFixture(destination,oldText);writeFixture(base+L"\\bad-source.exe","wrong-source");auto bad=lockHashedFile(base+L"\\bad-source.exe",repairBytesDigest("wrong-source"));rejects("HELPER_INTEGRITY_INVALID",[&]{(void)retainLauncherFiles(parent,destination,bad.value,desired,previous,verifier);});{auto old=lockHashedFile(destination,oldSha);require(old.valid());}require(nativeChildMissing(parent,L"launcher.exe.pending")&&nativeChildMissing(parent,L"launcher.exe.previous")&&jsonNull(readLauncherChange()));
  // Foreign content clone after old backup is never overwritten or adopted.
  retainedLauncherFault=RetainedLauncherFault::backedUp;rejects("PATH_UNSAFE",[&]{(void)publish();});retainedLauncherFault=RetainedLauncherFault::none;const auto receipt=readLauncherChange();writeFixture(destination,newText);rejects("PATH_UNSAFE",[&]{(void)publish();});require(mm::dump(readLauncherChange())==mm::dump(receipt));{auto foreign=lockHashedFile(destination,newSha);require(mm::dump(launcherBirth(foreign.value))!=mm::dump(receipt.at("new_birth")));auto backup=lockHashedFile(destination+L".previous",oldSha);require(mm::dump(launcherBirth(backup.value))==mm::dump(receipt.at("old").at("birth")));auto stage=lockHashedFile(destination+L".pending",newSha);require(mm::dump(launcherBirth(stage.value))==mm::dump(receipt.at("new_birth")));}require(DeleteFileW(destination.c_str()));require(std::get<bool>(publish().at("retained").value));
  // An unsafe owned fixture ACL fails before backup or publication.
  writeFixture(destination,oldText);Security broad(L"D:P(A;;FA;;;WD)");Security safe(dataSddl());require(SetFileSecurityW(destination.c_str(),DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,broad.descriptor));rejects("ACL_UNSAFE",[&]{(void)publish();});require(SetFileSecurityW(destination.c_str(),DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,safe.descriptor));{auto old=lockHashedFile(destination,oldSha);require(old.valid());}require(jsonNull(readLauncherChange())&&nativeChildMissing(parent,L"launcher.exe.pending")&&nativeChildMissing(parent,L"launcher.exe.previous"));
}
void libraryAbsentRecoveryFixtures(){
  checkpoint("library-absent-parent-recovery");const auto root=rootPath("personal");directory("personal","native-library-recovery");directory("personal","native-library-foreign");const auto parentPath=root+L"\\native-library-recovery",base=parentPath+L"\\gone";auto parents=lockAncestors(parentPath,false,true,root);auto row=[](const std::string& path,bool isDirectory,const std::string& state){return Json(Json::Object{{"path",path},{"directory",isDirectory},{"expected",Json::Object{}},{"sha256",isDirectory?Json(nullptr):Json(std::string(64,'a'))},{"state",state}});};
  auto gone=[&](){std::vector<LibraryRetireEntry> rows;rows.push_back({"",true,Handle{},row("",true,"submitted")});rows.push_back({"original",true,Handle{},row("original",true,"submitted")});rows.push_back({"original\\media.wav",false,Handle{},row("original\\media.wav",false,"submitted")});return rows;};
  {auto rows=gone();require(reopenLibraryRows(rows,base,parents.back().value));for(const auto& entry:rows)require(entry.row.at("state").string()=="gone"&&!entry.handle.valid());}
  {auto rows=gone();auto intent=rows.back().row.object();intent["state"]="intent";rows.back().row=intent;require(!reopenLibraryRows(rows,base,parents.back().value));require(rows.back().row.at("state").string()=="intent");}
  {auto rows=gone();std::swap(rows[1],rows[2]);rejects("VAULT_CORRUPT",[&]{(void)reopenLibraryRows(rows,base,parents.back().value);});}
  {auto rows=gone();rejects("VAULT_CORRUPT",[&]{(void)reopenLibraryRows(rows,base,nullptr);});auto foreign=lockAncestors(root+L"\\native-library-foreign",false,true,root);rejects("PATH_UNSAFE",[&]{(void)reopenLibraryRows(rows,base,foreign.back().value);});}
  // The root remains present, but a submitted subdirectory's lost ACK proves
  // only that subtree absent. Its original root identity is still checked.
  directory("personal","native-library-recovery\\present");const auto present=parentPath+L"\\present";Json rootBirth;{auto held=openEntry(present,true,true);rootBirth=cacheHandleIdentity(held.value,true);}auto rows=gone();auto live=rows.front().row.object();live["expected"]=rootBirth;live["state"]="intent";rows.front().row=live;require(reopenLibraryRows(rows,present,parents.back().value));require(rows.front().handle.valid()&&rows.front().row.at("state").string()=="intent");require(rows[1].row.at("state").string()=="gone"&&rows[2].row.at("state").string()=="gone");
}

// The deliberate two-link fixture cannot use production openNativeChild,
// which correctly rejects such a leaf. This test-only acquisition still uses
// the retained parent and a fixed single leaf, without an absolute fallback.
bool retireFixtureAlias(HANDLE parent,const std::wstring& path,const BY_HANDLE_FILE_INFORMATION& expected){
  nativeEntryInformation(parent,NativeChildKind::directory);
  using Create=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
  const auto module=GetModuleHandleW(L"ntdll.dll");const auto create=reinterpret_cast<Create>(GetProcAddress(module,"NtCreateFile"));if(!create)return false;
  const std::wstring leaf=L"linked.bin";UNICODE_STRING name{};name.Length=static_cast<USHORT>(leaf.size()*sizeof(wchar_t));name.MaximumLength=static_cast<USHORT>((leaf.size()+1)*sizeof(wchar_t));name.Buffer=const_cast<PWSTR>(leaf.c_str());
  OBJECT_ATTRIBUTES attributes{};attributes.Length=sizeof(attributes);attributes.RootDirectory=parent;attributes.ObjectName=&name;attributes.Attributes=0x40|0x1000; // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE.
  IO_STATUS_BLOCK io{};HANDLE value=nullptr;const auto status=create(&value,GENERIC_READ|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|SYNCHRONIZE,&attributes,&io,nullptr,FILE_ATTRIBUTE_NORMAL,FILE_SHARE_READ,static_cast<ULONG>(NativeChildDisposition::open),0x20|0x00200000|0x40,nullptr,0);Handle file(value);
  if(status!=0||!file.valid())return false;BY_HANDLE_FILE_INFORMATION current{};
  if(!GetFileInformationByHandle(file.value,&current)||(current.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))||current.nNumberOfLinks!=2||!samePrivateAncestorBirth(current,expected)||_wcsicmp(nativeCanonical(file.value).c_str(),path.c_str()))return false;
  assertPrivateHandle(file.value);FILE_DISPOSITION_INFO remove{TRUE};if(!SetFileInformationByHandle(file.value,FileDispositionInfo,&remove,sizeof(remove)))return false;
  if(!CloseHandle(file.value))return false;file.value=nullptr;return true;
}
void privateFileCapabilityFixtures(){
  checkpoint("private-file-raw-ancestor-birth");BY_HANDLE_FILE_INFORMATION raw{};raw.dwVolumeSerialNumber=7;raw.nFileIndexLow=11;require(samePrivateAncestorBirth(raw,raw));auto distinct=raw;distinct.ftCreationTime.dwLowDateTime=1;require(!samePrivateAncestorBirth(raw,distinct));const auto preEpoch=116444736000000000ULL-1;raw.ftCreationTime={static_cast<DWORD>(preEpoch),static_cast<DWORD>(preEpoch>>32)};require(samePrivateAncestorBirth(raw,raw));distinct=raw;++distinct.dwVolumeSerialNumber;require(!samePrivateAncestorBirth(raw,distinct));distinct=raw;++distinct.nFileIndexLow;require(!samePrivateAncestorBirth(raw,distinct));distinct=raw;++distinct.nFileIndexHigh;require(!samePrivateAncestorBirth(raw,distinct));distinct=raw;++distinct.ftCreationTime.dwHighDateTime;require(!samePrivateAncestorBirth(raw,distinct));
  checkpoint("private-file-capability-io");require(privateFileCapabilities.empty());const auto root=rootPath("personal");directory("personal","native-private-files");directory("personal","prepare\\downloads");directory("personal","models");const auto base=root+L"\\native-private-files";
  auto openCap=[](const std::string& relative,const std::string& mode,std::int64_t maximum,const Json& expected=Json(nullptr)){return dispatch("private_file_open",Json::Object{{"root","personal"},{"relative_path",relative},{"mode",mode},{"maximum_bytes",maximum},{"expected_birth",expected}});};
  auto invoke=[](const std::string& operation,const std::string& token,const Json::Object& extra=Json::Object{}){auto args=extra;args["token"]=token;return dispatch(operation,args);};auto encoded=[](const std::string& bytes){return base64Encode(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()));};auto birth=[](const Json& identity){return Json(Json::Object{{"device",identity.at("device")},{"file_id",identity.at("file_id")},{"born_at",identity.at("born_at")}});};
  rejects("BAD_REQUEST",[&]{(void)dispatch("private_file_open",Json::Object{{"root","fleet"},{"relative_path","native-private-files\\data.bin"},{"mode","read"},{"maximum_bytes",64},{"expected_birth",nullptr}});});
  require(openCap("native-private-files\\missing.bin","read",64).at("state").string()=="missing");const auto created=openCap("native-private-files\\data.bin","create-new",64);require(created.at("state").string()=="opened");const auto token=created.at("token").string();require(token.size()==64&&token.find_first_not_of("0123456789abcdef")==std::string::npos);const auto originalBirth=birth(created.at("identity"));require(created.at("identity").at("bytes").integer()==0);
  require(invoke("private_file_write",token,{{"position",0},{"bytes_base64",encoded("abc")}}).at("bytes_written").integer()==3);require(invoke("private_file_write",token,{{"position",3},{"bytes_base64",encoded("def")}}).at("bytes_written").integer()==3);require(invoke("private_file_info",token).at("identity").at("bytes").integer()==6);require(mm::dump(birth(invoke("private_file_info",token).at("identity")))==mm::dump(originalBirth));
  auto partial=invoke("private_file_read",token,{{"position",4},{"length",static_cast<int>(privateFileChunk)}});require(partial.at("bytes_read").integer()==2&&partial.at("bytes_base64").string()==encoded("ef"));const auto eof=invoke("private_file_read",token,{{"position",6},{"length",10}});require(eof.at("bytes_read").integer()==0&&eof.at("bytes_base64").string().empty());require(invoke("private_file_read",token,{{"position",64},{"length",0}}).at("bytes_read").integer()==0);
  rejects("BAD_REQUEST",[&]{(void)invoke("private_file_write",token,{{"position",64},{"bytes_base64",encoded("x")}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_write",token,{{"position",0},{"bytes_base64","@@@="}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_write",token,{{"position",0},{"bytes_base64",encoded(std::string(privateFileChunk+1,'x'))}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_read",token,{{"position",-1},{"length",1}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_read",token,{{"position",65},{"length",1}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_read",token,{{"position",0},{"length",static_cast<int>(privateFileChunk+1)}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_truncate",token,{{"length",65}});});
  for(const auto* noncanonical:{"Zh==","Zg=","Zg===","Z g==","Zg==\n"})rejects("BAD_REQUEST",[&]{(void)invoke("private_file_write",token,{{"position",0},{"bytes_base64",noncanonical}});});
  require(invoke("private_file_truncate",token,{{"length",4}}).at("identity").at("bytes").integer()==4);require(std::get<bool>(invoke("private_file_sync",token).at("synced").value));require(invoke("private_file_read",token,{{"position",0},{"length",10}}).at("bytes_base64").string()==encoded("abcd"));
  checkpoint("private-file-exclusive-fences");const auto file=base+L"\\data.bin",renamed=base+L"\\renamed.bin",link=base+L"\\linked.bin";
  const auto moved=MoveFileExW(file.c_str(),renamed.c_str(),0);const auto moveError=moved?0:GetLastError();std::cerr<<"Native private file fence: operation=rename; succeeded="<<(moved?1:0)<<"; win32_error="<<moveError<<'\n';
  require(!moved&&moveError==ERROR_SHARING_VIOLATION);
  const auto removed=DeleteFileW(file.c_str());const auto removeError=removed?0:GetLastError();std::cerr<<"Native private file fence: operation=delete; succeeded="<<(removed?1:0)<<"; win32_error="<<removeError<<'\n';
  require(!removed&&removeError==ERROR_SHARING_VIOLATION);
  require(nativePathMissing(renamed)&&nativePathMissing(link));
  {Handle writer(CreateFileW(file.c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));const auto writerError=GetLastError();require(!writer.valid()&&writerError==ERROR_SHARING_VIOLATION);}
  // Share denial covers data/delete opens, not metadata-only hard-link creation.
  // This fixture proves rejection while an alias exists; it does not prove
  // atomic containment of an alias introduced between two validation checks.
  checkpoint("private-file-held-alias-rejection");auto aliasParents=lockAncestors(file,false,false,root,true);const auto linked=CreateHardLinkW(link.c_str(),file.c_str(),nullptr);const auto linkError=linked?0:GetLastError();std::cerr<<"Native private file fence: operation=hardlink; succeeded="<<(linked?1:0)<<"; win32_error="<<linkError<<'\n';require(linked!=FALSE);
  BY_HANDLE_FILE_INFORMATION originalInformation{},aliasInformation{};Handle alias(CreateFileW(link.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  const bool exactAlias=alias.valid()&&GetFileInformationByHandle(privateFileCapabilities.at(token).file.value,&originalInformation)&&GetFileInformationByHandle(alias.value,&aliasInformation)&&!(aliasInformation.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&samePrivateAncestorBirth(originalInformation,aliasInformation);
  std::cerr<<"Native private file alias: exact_original="<<(exactAlias?1:0)<<"; original_links="<<originalInformation.nNumberOfLinks<<"; alias_links="<<aliasInformation.nNumberOfLinks<<'\n';
  auto aliasRejected=[&](const std::string& operation,const Json::Object& fields){try{(void)invoke(operation,token,fields);}catch(const Failure& failure){return failure.code=="PATH_UNSAFE";}return false;};
  const bool aliasInfoRejected=aliasRejected("private_file_info",{}),aliasReadRejected=aliasRejected("private_file_read",{{"position",0},{"length",4}}),aliasWriteRejected=aliasRejected("private_file_write",{{"position",0},{"bytes_base64",encoded("x")}}),aliasTruncateRejected=aliasRejected("private_file_truncate",{{"length",0}}),aliasSyncRejected=aliasRejected("private_file_sync",{});
  // Restore the exact owned alias only after positive token close, before the
  // security assertions or subsequent fixture work. Unknown aliases are kept.
  const auto closed=invoke("private_file_close",token);const bool positiveClose=std::get<bool>(closed.at("closed").value);const bool aliasRemoved=positiveClose&&exactAlias&&retireFixtureAlias(aliasParents.back().value,link,aliasInformation);const bool witnessClosed=alias.valid()&&CloseHandle(alias.value);if(witnessClosed)alias.value=nullptr;const bool aliasAbsent=aliasRemoved&&witnessClosed&&nativeChildMissing(aliasParents.back().value,L"linked.bin");
  require(positiveClose);require(exactAlias&&originalInformation.nNumberOfLinks==2&&aliasInformation.nNumberOfLinks==2);require(aliasInfoRejected&&aliasReadRejected&&aliasWriteRejected&&aliasTruncateRejected&&aliasSyncRejected);require(aliasRemoved&&witnessClosed&&aliasAbsent);
  {auto unchanged=lockHashedFile(file,repairBytesDigest("abcd"));require(mm::dump(cacheHandleBirth(unchanged.value))==mm::dump(originalBirth));require(cacheHandleIdentity(unchanged.value,false).at("bytes").integer()==4);}
  rejects("BAD_REQUEST",[&]{(void)invoke("private_file_info",token);});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_close",token);});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_info",std::string(64,'0'));});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_close","not-a-token");});
  // Prove the file-system supports a hard-link operation when no lease is held,
  // then reject opening that non-single-link generation through this bridge.
  require(CreateHardLinkW(link.c_str(),file.c_str(),nullptr));rejects("PATH_UNSAFE",[&]{(void)openCap("native-private-files\\data.bin","read",64);});require(retireFixtureAlias(aliasParents.back().value,link,originalInformation));require(nativeChildMissing(aliasParents.back().value,L"linked.bin"));
  rejects("PATH_UNSAFE",[&]{(void)openCap("native-private-files\\data.bin","create-new",64);});const auto reading=openCap("native-private-files\\data.bin","read",64).at("token").string();require(reading!=token);rejects("BAD_REQUEST",[&]{(void)invoke("private_file_write",reading,{{"position",0},{"bytes_base64",encoded("x")}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_truncate",reading,{{"length",0}});});rejects("BAD_REQUEST",[&]{(void)invoke("private_file_sync",reading);});require(invoke("private_file_read",reading,{{"position",0},{"length",8}}).at("bytes_base64").string()==encoded("abcd"));require(std::get<bool>(invoke("private_file_close",reading).at("closed").value));
  rejects("BAD_REQUEST",[&]{(void)dispatch("private_file_open",Json::Object{{"root","personal"},{"relative_path","native-private-files\\data.bin"},{"mode","read"},{"maximum_bytes",64}});});
  const auto schemaToken=openCap("native-private-files\\data.bin","read",64).at("token").string();rejects("BAD_REQUEST",[&]{(void)invoke("private_file_read",schemaToken,{{"position",0},{"length",1},{"unexpected",true}});});require(invoke("private_file_read",schemaToken,{{"position",0},{"length",1}}).at("bytes_base64").string()==encoded("a"));(void)invoke("private_file_close",schemaToken);
  checkpoint("private-file-resume-generation");const auto runtimePath=root+L"\\prepare\\downloads\\runtime.part";rejects("PATH_UNSAFE",[&]{(void)openCap("prepare\\downloads\\runtime.part","resume",64,originalBirth);});writeFixture(runtimePath,"resume-content");Json runtimeBirth;{auto held=lockHashedFile(runtimePath,repairBytesDigest("resume-content"));runtimeBirth=cacheHandleBirth(held.value);}auto stale=runtimeBirth.object();stale["born_at"]=std::to_string(std::stoull(runtimeBirth.at("born_at").string())+100);rejects("PATH_UNSAFE",[&]{(void)openCap("prepare\\downloads\\runtime.part","resume",64,stale);});{auto held=lockHashedFile(runtimePath,repairBytesDigest("resume-content"));require(mm::dump(cacheHandleBirth(held.value))==mm::dump(runtimeBirth));}
  const auto resumed=openCap("prepare\\downloads\\runtime.part","resume",64,runtimeBirth);require(resumed.at("identity").at("bytes").integer()==14);const auto resumedToken=resumed.at("token").string();require(invoke("private_file_truncate",resumedToken,{{"length",6}}).at("identity").at("bytes").integer()==6);require(invoke("private_file_write",resumedToken,{{"position",6},{"bytes_base64",encoded("fixed")}}).at("bytes_written").integer()==5);require(invoke("private_file_read",resumedToken,{{"position",0},{"length",20}}).at("bytes_base64").string()==encoded("resumefixed"));(void)invoke("private_file_close",resumedToken);
  writeFixture(root+L"\\models\\Kim_Vocal_2.onnx.part","model-part");Json modelBirth;{auto held=lockHashedFile(root+L"\\models\\Kim_Vocal_2.onnx.part",repairBytesDigest("model-part"));modelBirth=cacheHandleBirth(held.value);}const auto model=openCap("models\\Kim_Vocal_2.onnx.part","resume",64,modelBirth).at("token").string();(void)invoke("private_file_close",model);rejects("BAD_REQUEST",[&]{(void)openCap("native-private-files\\data.bin","resume",64,originalBirth);});rejects("BAD_REQUEST",[&]{(void)openCap("prepare\\downloads\\runtime.part","resume",64);});rejects("BAD_REQUEST",[&]{(void)openCap("native-private-files\\data.bin","read",64,originalBirth);});
  rejects("BAD_REQUEST",[&]{(void)openCap("native-private-files\\data.bin","read",0);});rejects("BAD_REQUEST",[&]{(void)openCap("native-private-files\\data.bin","read",static_cast<std::int64_t>(privateFileMaximum+1));});rejects("PATH_UNSAFE",[&]{(void)openCap("native-private-files\\data.bin","read",3);});rejects("BAD_REQUEST",[&]{(void)openCap("native-private-files\\data.bin","invalid",64);});rejects("PATH_UNSAFE",[&]{(void)openCap("..\\outside.bin","create-new",64);});std::string deep;for(unsigned depth=0;depth<33;++depth)deep+=(depth?"\\":"")+std::string("part");rejects("BAD_REQUEST",[&]{(void)openCap(deep,"read",64);});
  checkpoint("private-file-capacity-close");std::vector<std::string> tokens;for(unsigned count=0;count<16;++count)tokens.push_back(openCap("native-private-files\\data.bin","read",64).at("token").string());rejects("JOB_BUSY",[&]{(void)openCap("native-private-files\\data.bin","read",64);});for(const auto& heldToken:tokens)(void)invoke("private_file_close",heldToken);require(privateFileCapabilities.empty());
}

void privateFileAncestorAttackFixtures(){
  checkpoint("private-file-live-ancestor-generation");const auto root=rootPath("personal");directory("personal","native-capability-attack\\held");directory("personal","native-capability-attack\\empty");directory("personal","native-capability-attack\\target");const auto base=root+L"\\native-capability-attack",parent=base+L"\\held",empty=base+L"\\empty",target=base+L"\\target";writeFixture(target+L"\\sentinel.bin","capability-target-sentinel");auto sentinel=lockHashedFile(target+L"\\sentinel.bin",repairBytesDigest("capability-target-sentinel"));const auto sentinelBirth=cacheHandleBirth(sentinel.value);
  const auto opened=dispatch("private_file_open",Json::Object{{"root","personal"},{"relative_path","native-capability-attack\\held\\owned.bin"},{"mode","create-new"},{"maximum_bytes",64},{"expected_birth",nullptr}});const auto token=opened.at("token").string();(void)dispatch("private_file_write",Json::Object{{"token",token},{"position",0},{"bytes_base64","b3duZWQ="}});
  Handle attacker(CreateFileW(parent.c_str(),FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));require(attacker.valid());BY_HANDLE_FILE_INFORMATION original{};require(GetFileInformationByHandle(attacker.value,&original));const auto creation=(static_cast<ULONGLONG>(original.ftCreationTime.dwHighDateTime)<<32)|original.ftCreationTime.dwLowDateTime;const auto changed=creation+1;const FILETIME modified{static_cast<DWORD>(changed),static_cast<DWORD>(changed>>32)};
  struct RestoreTime{HANDLE handle;FILETIME time;bool active=true;bool restore(){if(!active)return true;if(!SetFileTime(handle,&time,nullptr,nullptr))return false;active=false;return true;}~RestoreTime(){if(active&&!restore())std::cerr<<"Native fixture time restoration unconfirmed\n";}}restoreTime{attacker.value,original.ftCreationTime};require(SetFileTime(attacker.value,&modified,nullptr,nullptr));
  auto rejected=[&](const std::string& operation,const Json::Object& fields){auto args=fields;args["token"]=token;try{(void)dispatch(operation,args);}catch(const Failure& failure){return failure.code=="PATH_UNSAFE";}return false;};const bool infoRejected=rejected("private_file_info",{}),readRejected=rejected("private_file_read",{{"position",0},{"length",8}}),writeRejected=rejected("private_file_write",{{"position",0},{"bytes_base64","eA=="}}),truncateRejected=rejected("private_file_truncate",{{"length",0}}),syncRejected=rejected("private_file_sync",{});
  const auto closed=dispatch("private_file_close",Json::Object{{"token",token}});const bool restored=restoreTime.restore();require(restored);require(std::get<bool>(closed.at("closed").value));require(infoRejected&&readRejected&&writeRejected&&truncateRejected&&syncRejected);{auto held=lockHashedFile(parent+L"\\owned.bin",repairBytesDigest("owned"));require(held.valid());}require(hashFile(sentinel.value)==repairBytesDigest("capability-target-sentinel")&&mm::dump(cacheHandleBirth(sentinel.value))==mm::dump(sentinelBirth));
  checkpoint("private-file-reparse-open");auto emptyParents=lockAncestors(empty,false,true,root),targetParents=lockAncestors(target,false,true,root);Handle reparseAttacker(CreateFileW(empty.c_str(),FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));require(reparseAttacker.valid());BY_HANDLE_FILE_INFORMATION emptyOriginal{};require(GetFileInformationByHandle(reparseAttacker.value,&emptyOriginal));FixtureReparseRestore restore{reparseAttacker.value,emptyOriginal};const auto buffer=fixtureMountPointBytes(target);DWORD returned=0;const auto set=DeviceIoControl(reparseAttacker.value,FSCTL_SET_REPARSE_POINT,const_cast<BYTE*>(buffer.data()),static_cast<DWORD>(buffer.size()),nullptr,0,&returned,nullptr);restore.active=set!=FALSE;
  auto blocked=[&](const std::string& mode,const std::string& leaf){try{(void)dispatch("private_file_open",Json::Object{{"root","personal"},{"relative_path","native-capability-attack\\empty\\"+leaf},{"mode",mode},{"maximum_bytes",64},{"expected_birth",nullptr}});}catch(const Failure& failure){return failure.code=="PATH_UNSAFE";}return false;};const bool readBlocked=set&&blocked("read","sentinel.bin"),createBlocked=set&&blocked("create-new","created.bin");const bool targetMissing=nativeChildMissing(targetParents.back().value,L"created.bin");const bool directoryRestored=restore.restore();require(directoryRestored);require(set!=FALSE&&readBlocked&&createBlocked&&targetMissing);require(hashFile(sentinel.value)==repairBytesDigest("capability-target-sentinel")&&mm::dump(cacheHandleBirth(sentinel.value))==mm::dump(sentinelBirth));require(privateFileCapabilities.empty());
}

void pendingNativeLeafFixtures(){
  checkpoint("native-delete-pending-absence");const auto root=rootPath("personal");directory("personal","native-pending-leaf");const auto parentPath=root+L"\\native-pending-leaf",path=parentPath+L"\\pending.bin";writeFixture(path,"pending-reader-generation");auto parents=lockAncestors(parentPath,false,true,root);
  auto reader=openNativeChild(parents.back().value,L"pending.bin",GENERIC_READ|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_DELETE,NativeChildKind::file,NativeChildDisposition::open);require(reader.handle.valid());require(hashFile(reader.handle.value)==repairBytesDigest("pending-reader-generation"));
  auto deleting=openNativeChild(parents.back().value,L"pending.bin",GENERIC_READ|DELETE|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);require(deleting.handle.valid());require(mm::dump(cacheHandleBirth(deleting.handle.value))==mm::dump(cacheHandleBirth(reader.handle.value)));FILE_DISPOSITION_INFO disposition{TRUE};require(SetFileInformationByHandle(deleting.handle.value,FileDispositionInfo,&disposition,sizeof(disposition)));deleting.handle.close();
  auto pending=openNativeChild(parents.back().value,L"pending.bin",FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::any,NativeChildDisposition::open);const auto pendingError=GetLastError();std::cerr<<"Native pending leaf lookup: ntstatus="<<static_cast<ULONG>(pending.status)<<"; win32_error="<<(pending.handle.valid()?0:pendingError)<<'\n';require(!pending.handle.valid()&&static_cast<ULONG>(pending.status)==0xc0000056UL);require(!nativeChildMissing(parents.back().value,L"pending.bin"));require(!nativePathMissing(path));
  // A blocked publish must preserve its own source. Pending never means an
  // absent destination, and an atomic no-replace rename cannot overwrite it.
  const auto stagePath=parentPath+L"\\stage.bin";writeFixture(stagePath,"pending-publish-source");auto stage=openNativeChild(parents.back().value,L"stage.bin",GENERIC_READ|DELETE|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);require(stage.handle.valid());const auto stageBirth=cacheHandleBirth(stage.handle.value);require(renameNativeChild(stage.handle.value,parents.back().value,L"pending.bin").status!=0);require(mm::dump(cacheHandleBirth(stage.handle.value))==mm::dump(stageBirth));require(hashFile(stage.handle.value)==repairBytesDigest("pending-publish-source"));require(_wcsicmp(nativeCanonical(stage.handle.value).c_str(),stagePath.c_str())==0);stage.handle.close();
  reader.handle.close();auto absent=openNativeChild(parents.back().value,L"pending.bin",FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::any,NativeChildDisposition::open);const auto absentError=GetLastError();require(!absent.handle.valid()&&static_cast<ULONG>(absent.status)==0xc0000034UL&&absentError==ERROR_FILE_NOT_FOUND);require(nativeChildMissing(parents.back().value,L"pending.bin"));require(nativePathMissing(path));
}

void browserRegistrationFixtures() {
  // Synthetic asset pins exercise only the real fixed manifest/registry
  // mutation primitives in the random fixture root/key, never package approval.
  const Json pins=Json::Object{{"sid",currentIdentity().sid},{"extension_id",std::string(32,'a')},{"host_sha256",std::string(64,'a')},{"host_bytes",1},{"entry_sha256",std::string(64,'b')},{"entry_bytes",1}};
  checkpoint("browser-publish");auto record=publishBrowserManifest(pins);
  checkpoint("browser-register");
  browserWriteProtected("browser_registration",record);
  {BrowserRegistryTransaction transaction(false);transaction.commit();}
  browserEraseProtected("browser_manifest_change");
  require(browserRegistryState(KEY_WOW64_32KEY)=="owned"&&browserRegistryState(KEY_WOW64_64KEY)=="owned");
  assertOwnedBrowserRegistration(record);
  require(mm::dump(readBrowserManifest())==mm::dump(expectedBrowserManifest(std::string(32,'a'))));
  // Closing the last uncommitted transaction rolls back BOTH registry views.
  checkpoint("browser-rollback");
  {BrowserRegistryTransaction rollback(true);}
  require(browserRegistryState(KEY_WOW64_32KEY)=="owned"&&browserRegistryState(KEY_WOW64_64KEY)=="owned");
  // A current generation stays locked against replacement/deletion while read.
  checkpoint("browser-locked-generation");
  {auto held=openBrowserFile(browserManifestPath());require(!DeleteFileW(browserManifestPath().c_str()));require(!MoveFileExW(browserManifestPath().c_str(),(browserManifestPath()+L".other").c_str(),0));}
  const auto original=browserManifestPath()+L".original";
  checkpoint("browser-content-clone");
  require(MoveFileExW(browserManifestPath().c_str(),original.c_str(),0));
  writeFixture(browserManifestPath(),mm::dump(expectedBrowserManifest(std::string(32,'a'))));
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)unregisterBrowser();});
  require(!browserMissing(browserManifestPath())); // content clone survives
  require(DeleteFileW(browserManifestPath().c_str())&&MoveFileExW(original.c_str(),browserManifestPath().c_str(),0));
  // A foreign value denies before any manifest mutation; fixture restores only
  // its own random test key. No production Chrome registry path is touched.
  checkpoint("browser-foreign-value");
  {RegistryHandle key;require(RegOpenKeyExW(HKEY_CURRENT_USER,browserKeyPath().c_str(),0,KEY_SET_VALUE|KEY_WOW64_32KEY,&key.key)==ERROR_SUCCESS);const std::wstring foreign=L"C:\\foreign.json";require(RegSetValueExW(key.key,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(foreign.c_str()),static_cast<DWORD>((foreign.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS);}
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{BrowserRegistryTransaction denied(false);});
  assertOwnedBrowserRegistration(record);
  {RegistryHandle key;require(RegOpenKeyExW(HKEY_CURRENT_USER,browserKeyPath().c_str(),0,KEY_SET_VALUE|KEY_WOW64_32KEY,&key.key)==ERROR_SUCCESS);const auto path=browserManifestPath();require(RegSetValueExW(key.key,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(path.c_str()),static_cast<DWORD>((path.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS);}
  // Positive disposition with an open reader is pending. Retrying after that
  // exact reader closes resumes the persisted staged generation, not a clone.
  checkpoint("browser-pending-retirement");
  Handle reader(CreateFileW(browserManifestPath().c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(reader.valid());
  auto changed=pins.object();changed["host_sha256"]=std::string(64,'c');
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(changed);});
  require(browserReadProtected("browser_manifest_change").at("phase").string()=="old-submitted");
  reader.close();record=publishBrowserManifest(changed);
  checkpoint("browser-lost-publish-ack");
  {auto file=openBrowserFile(browserManifestPath());const auto observed=browserFileBirth(file.value);const auto& expected=record.at("manifest_birth");const auto content=mm::dump(readBrowserHandle(file.value))==mm::dump(expectedBrowserManifest(std::string(32,'a')));LARGE_INTEGER start{};check(SetFilePointerEx(file.value,start,nullptr,FILE_BEGIN),"BROWSER_REGISTRATION_CONFLICT");const auto hashMatches=hashFile(file.value)==record.at("manifest_sha256").string();const auto change=browserReadProtected("browser_manifest_change");
    std::cerr<<"Native publication identity: volume="<<(mm::dump(observed.at("volume"))==mm::dump(expected.at("volume")))<<"; file_id="<<(mm::dump(observed.at("file_id"))==mm::dump(expected.at("file_id")))<<"; creation_time="<<(mm::dump(observed.at("creation_time"))==mm::dump(expected.at("creation_time")))<<"; content="<<content<<"; hash="<<hashMatches<<"; phase_published="<<(change.at("phase").string()=="published")<<'\n';}
  require(mm::dump(publishBrowserManifest(changed))==mm::dump(record)); // lost publish ACK
  browserWriteProtected("browser_registration",record);browserEraseProtected("browser_manifest_change");

  checkpoint("browser-published-timestamp-denial");
  assertOwnedBrowserRegistration(record); // first success has the FULL staged birth
  const auto approvedCreation=record.at("manifest_birth").at("creation_time").string();
  fixtureBrowserCreation(std::to_string(std::stoull(approvedCreation)+1));
  const auto tamperedBirth=currentBrowserBirth();
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(changed);});
  require(mm::dump(currentBrowserBirth())==mm::dump(tamperedBirth)); // published time is never repaired
  fixtureBrowserCreation(approvedCreation);assertOwnedBrowserRegistration(record);
  browserEraseProtected("browser_manifest_change");

  checkpoint("browser-interrupted-rename");
  auto next=changed;next["host_sha256"]=std::string(64,'d');
  browserPublicationFault=BrowserPublicationFault::renamed;
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  browserPublicationFault=BrowserPublicationFault::none;
  const auto interrupted=browserReadProtected("browser_manifest_change");
  require(interrupted.at("phase").string()=="old-removed");
  const auto stagePath=rootPath("personal")+L"\\integration\\"+wide(interrupted.at("temporary").string());
  require(browserMissing(stagePath));
  // Force the documented tunneled value even on a volume with tunneling off.
  fixtureBrowserCreation(approvedCreation);
  require(currentBrowserBirth().at("creation_time").string()!=interrupted.at("desired").at("manifest_birth").at("creation_time").string());
  const auto pendingBirth=currentBrowserBirth();
  checkpoint("browser-pending-generation-denials");
  fixtureBrowserCreation(std::to_string(std::stoull(approvedCreation)+1));
  const auto unexpectedTime=currentBrowserBirth();
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(unexpectedTime));
  fixtureBrowserCreation(approvedCreation);
  auto wrongPhase=interrupted.object();wrongPhase["phase"]="published";
  browserWriteProtected("browser_manifest_change",wrongPhase);
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(pendingBirth));
  browserWriteProtected("browser_manifest_change",interrupted);
  writeFixture(stagePath,"foreign-stage-fixture");
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(pendingBirth));require(DeleteFileW(stagePath.c_str()));
  writeFixture(browserManifestPath(),"{\"unexpected\":true}");
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(pendingBirth));
  writeFixture(browserManifestPath(),mm::dump(expectedBrowserManifest(std::string(32,'a'))));
  auto wrongHash=interrupted.object(),wrongDesired=interrupted.at("desired").object();wrongDesired["manifest_sha256"]=std::string(64,'0');wrongHash["desired"]=wrongDesired;
  browserWriteProtected("browser_manifest_change",wrongHash);
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(pendingBirth));
  browserWriteProtected("browser_manifest_change",interrupted);
  auto overflow=interrupted.object(),overflowDesired=interrupted.at("desired").object(),overflowBirth=interrupted.at("desired").at("manifest_birth").object();overflowBirth["creation_time"]="18446744073709551616";overflowDesired["manifest_birth"]=overflowBirth;overflow["desired"]=overflowDesired;
  browserWriteProtected("browser_manifest_change",overflow);
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(pendingBirth));
  browserWriteProtected("browser_manifest_change",interrupted);

  checkpoint("browser-pending-clone-denial");
  const auto heldOriginal=browserManifestPath()+L".interrupted-original";
  require(MoveFileExW(browserManifestPath().c_str(),heldOriginal.c_str(),0));
  writeFixture(browserManifestPath(),mm::dump(expectedBrowserManifest(std::string(32,'a'))));
  fixtureBrowserCreation(interrupted.at("desired").at("manifest_birth").at("creation_time").string());
  const auto cloneBirth=currentBrowserBirth();
  require(cloneBirth.at("file_id").string()!=interrupted.at("desired").at("manifest_birth").at("file_id").string());
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(next);});
  require(mm::dump(currentBrowserBirth())==mm::dump(cloneBirth));
  require(DeleteFileW(browserManifestPath().c_str())&&MoveFileExW(heldOriginal.c_str(),browserManifestPath().c_str(),0));
  fixtureBrowserCreation(approvedCreation);
  checkpoint("browser-interrupted-rename-recovery");
  record=publishBrowserManifest(next);
  require(mm::dump(record)==mm::dump(interrupted.at("desired")));assertOwnedBrowserRegistration(record);
  require(mm::dump(publishBrowserManifest(next))==mm::dump(record));
  browserWriteProtected("browser_registration",record);browserEraseProtected("browser_manifest_change");

  checkpoint("browser-interrupted-restoration");
  auto restored=next;restored["host_sha256"]=std::string(64,'e');
  browserPublicationFault=BrowserPublicationFault::restored;
  rejects("BROWSER_REGISTRATION_CONFLICT",[&]{(void)publishBrowserManifest(restored);});
  browserPublicationFault=BrowserPublicationFault::none;
  const auto restoredIntent=browserReadProtected("browser_manifest_change");
  require(restoredIntent.at("phase").string()=="old-removed");assertOwnedBrowserRegistration(restoredIntent.at("desired"));
  record=publishBrowserManifest(restored);require(mm::dump(record)==mm::dump(restoredIntent.at("desired")));
  require(mm::dump(publishBrowserManifest(restored))==mm::dump(record));
  changed=restored;
  browserWriteProtected("browser_registration",record);browserEraseProtected("browser_manifest_change");
  checkpoint("browser-unregister");
  require(std::get<bool>(unregisterBrowser().at("removed").value));
  require(browserRegistryState(KEY_WOW64_32KEY)=="absent"&&browserRegistryState(KEY_WOW64_64KEY)=="absent");
  require(RemoveDirectoryW((rootPath("personal")+L"\\integration").c_str()));
  // The strict owned record permits fixed missing-parent repair; it does not
  // turn access errors/foreign keys/reparse parents into absence.
  checkpoint("browser-missing-parent-repair");
  browserWriteProtected("browser_registration",record);assertOwnedBrowserRegistration(record,"",true);
  record=publishBrowserManifest(changed);browserWriteProtected("browser_registration",record);
  {BrowserRegistryTransaction repaired(false);repaired.commit();}
  browserEraseProtected("browser_manifest_change");assertOwnedBrowserRegistration(record);
  require(std::get<bool>(unregisterBrowser().at("removed").value));
  require(std::get<bool>(unregisterBrowser().at("removed").value)); // lost remove ACK
  const auto isolatedKeyParent=browserKeyPath().substr(0,browserKeyPath().find_last_of(L'\\'));
  checkpoint("browser-fixture-cleanup");
  for(const REGSAM view:{KEY_WOW64_32KEY,KEY_WOW64_64KEY}){const auto status=RegDeleteKeyExW(HKEY_CURRENT_USER,isolatedKeyParent.c_str(),view,0);require(status==ERROR_SUCCESS||status==ERROR_FILE_NOT_FOUND);}
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  if(argc==2&&std::wstring(argv[1])==L"--retained-fixture-leaf"){Sleep(INFINITE);return 0;}
  if(argc==4&&std::wstring(argv[1])==L"--retained-fixture-engine"){
    try{
      const auto output=reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(utf8(argv[2])))),request=reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(utf8(argv[3]))));if(WaitForSingleObject(request,10000)!=WAIT_OBJECT_0)return 2;
      Handle job(CreateJobObjectW(nullptr,nullptr));if(!job.valid())return 2;JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))return 2;
      auto command=quote(argv[0])+L" --retained-fixture-leaf";STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};if(!CreateProcessW(argv[0],command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|DETACHED_PROCESS,nullptr,nullptr,&startup,&process))return 2;Handle child(process.hProcess),thread(process.hThread);if(!AssignProcessToJobObject(job.value,child.value)||ResumeThread(thread.value)==static_cast<DWORD>(-1)){TerminateProcess(child.value,2);WaitForSingleObject(child.value,5000);return 2;}
      DWORD wrote=0;if(!WriteFile(output,&process.dwProcessId,sizeof(process.dwProcessId),&wrote,nullptr)||wrote!=sizeof(process.dwProcessId))return 2;CloseHandle(output);CloseHandle(request);Sleep(INFINITE);return 0;
    }catch(...){return 2;}
  }
  if(argc==4&&std::wstring(argv[1])==L"--retained-fixture-guardian"){
    try{
      const auto output=reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(utf8(argv[2]))));
      const auto request=reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(std::stoull(utf8(argv[3]))));
      Handle job(CreateJobObjectW(nullptr,nullptr));if(!job.valid())return 2;JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;if(!SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))return 2;
      SIZE_T attributeBytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&attributeBytes);std::vector<BYTE> attributes(attributeBytes);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());if(!InitializeProcThreadAttributeList(list,1,0,&attributeBytes))return 2;struct Attributes{LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} lifetime{list};HANDLE inherited[]{output,request};if(!UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr))return 2;
      auto command=quote(argv[0])+L" --retained-fixture-engine "+argv[2]+L" "+argv[3];STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=list;PROCESS_INFORMATION process{};
      if(!CreateProcessW(argv[0],command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|DETACHED_PROCESS|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&process))return 2;Handle engine(process.hProcess),thread(process.hThread);
      if(!AssignProcessToJobObject(job.value,engine.value)||ResumeThread(thread.value)==static_cast<DWORD>(-1)){TerminateProcess(engine.value,2);WaitForSingleObject(engine.value,5000);return 2;}
      DWORD wrote=0;if(!WriteFile(output,&process.dwProcessId,sizeof(process.dwProcessId),&wrote,nullptr)||wrote!=sizeof(process.dwProcessId))return 2;CloseHandle(output);Sleep(INFINITE);return 0;
    }catch(...){return 2;}
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--describe-target") {
    // Read-only QA target inventory, not a production authority/bypass. Never
    // exports SID/user paths and never creates fixture/install state or runs inference.
    try {
      const auto host=identityReport();OSVERSIONINFOEXW version{};version.dwOSVersionInfoSize=sizeof(version);
      using Query=LONG(WINAPI*)(PRTL_OSVERSIONINFOW);const auto query=reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlGetVersion"));
      if(!query||query(reinterpret_cast<PRTL_OSVERSIONINFOW>(&version))!=0||version.wProductType!=VER_NT_WORKSTATION)return 2;
      const auto report=Json::Object{{"version",1},{"nativeArch",host.at("native_arch")},{"processArch",host.at("process_arch")},{"major",host.at("os_major")},{"build",host.at("os_build")},{"edition","workstation"},{"gpus",gpuInventory()}};
      const auto text=mm::dump(report);DWORD wrote=0;const auto output=GetStdHandle(STD_OUTPUT_HANDLE);return WriteFile(output,text.data(),static_cast<DWORD>(text.size()),&wrote,nullptr)&&wrote==text.size()?0:2;
    }catch(...){return 2;}
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--installer-monitor") return installerMonitorMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--job-guardian") return independentJobMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--gpu-guardian") return independentGpuMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--gpu-watchdog") return independentGpuWatchdogMain(argv[2]);
  if (argc != 2) return 2;
  try {
    // Exact compiled isolated fixture only. The production terminal primitive
    // must self-exit with detached stack-referencing threads still active.
    checkpoint("transport-terminal");std::wstring terminalCommand=quote(argv[1])+L" --transport-terminal";
    STARTUPINFOW terminalStartup{};terminalStartup.cb=sizeof(terminalStartup);PROCESS_INFORMATION terminalProcess{};
    require(CreateProcessW(argv[1],terminalCommand.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&terminalStartup,&terminalProcess));
    Handle terminal(terminalProcess.hProcess),terminalThread(terminalProcess.hThread);
    if(WaitForSingleObject(terminal.value,5000)!=WAIT_OBJECT_0){TerminateProcess(terminal.value,2);throw Failure("NATIVE_TEST_FAILED");}
    DWORD terminalCode=0;require(GetExitCodeProcess(terminal.value,&terminalCode)&&terminalCode==2);
    checkpoint("identity");const auto report = identityReport();
    require(report.at("native_arch").string() == "x64" && report.at("os_build").integer() >= 19045);
    // Preserve the full isolation nonce without making fixed temporary names
    // exceed the Win32 path bound on this test executable's ordinary paths.
    checkpoint("private-root");isolatedTestRoot = wide(report.at("local_app_data").string()) + L"\\MMCN-" + wide(randomHex());
    Security security(dataSddl());
    require(CreateDirectoryW(isolatedTestRoot.c_str(), &security.attributes));
    directory("personal", ""); directory("fleet", "");
    const auto personal = rootPath("personal");
    const auto fleet = rootPath("fleet");
    require(personal.find(isolatedTestRoot) == 0 && fleet.find(isolatedTestRoot) == 0);
    checkpoint("store-empty-leaf-hash");
    const auto emptySource=personal+L"\\empty-source.py";
    writeFixture(emptySource,"");
    {auto file=openEntry(emptySource,false,true,false,true);require(mmstore::detail::hashFile(file.value,0)==mmstore::emptySha256);}
    writeFixture(emptySource,"x");
    {auto file=openEntry(emptySource,false,true,false,true);bool deniedEmpty=false;try{(void)mmstore::detail::hashFile(file.value,0);}catch(const mmstore::Error& error){deniedEmpty=error.code()==mmstore::ErrorCode::fileDenied;}require(deniedEmpty);}
    require(DeleteFileW(emptySource.c_str()));
    privateFileCapabilityFixtures();
    privateFileAncestorAttackFixtures();
    pendingNativeLeafFixtures();
    browserRegistrationFixtures();
    checkpoint("remaining-isolated-checks");
    const auto me = processIdentity(GetCurrentProcessId());
    // Fixed scopes only; duplicate requests keep the exact first lease and
    // never add a recursive Win32 count. This isolated CTest remains Windows-only.
    for(const std::string scope:{"cache","metadata"}){
      const auto first=acquireMutex(Json::Object{{"scope",scope}});
      require(std::get<bool>(first.at("acquired").value));
      const auto busy=acquireMutex(Json::Object{{"scope",scope}});
      require(mm::dump(busy)=="{\"acquired\":false}");
      rejects("PEER_DENIED",[&]{(void)releaseMutex(Json::Object{{"scope",scope},{"nonce",randomHex()},{"identity",first.at("identity")}});});
      require(!std::get<bool>(acquireMutex(Json::Object{{"scope",scope}}).at("acquired").value));
      (void)releaseMutex(Json::Object{{"scope",scope},{"nonce",first.at("nonce")},{"identity",first.at("identity")}});
      const auto next=acquireMutex(Json::Object{{"scope",scope}});
      require(std::get<bool>(next.at("acquired").value)&&next.at("nonce").string()!=first.at("nonce").string());
      (void)releaseMutex(Json::Object{{"scope",scope},{"nonce",next.at("nonce")},{"identity",next.at("identity")}});
    }

    // Actual handle/disposition/ACL tests in the isolated root. They are source
    // fixtures only until CTest runs on the approved Windows x64 target.
    directory("personal","library\\thumbnails");
    const std::string cacheRelative="library\\thumbnails\\"+std::string(64,'a')+".image";
    const auto cachePath=personal+L"\\"+wide(cacheRelative);
    writeFixture(cachePath,"cache-fixture");
    auto cacheLease=acquireMutex(Json::Object{{"scope","cache"}});
    Json expectedCache;
    { auto exact=openEntry(cachePath,false,true);expectedCache=cacheHandleIdentity(exact.value,false); }
    auto candidate=beginCacheDeletion(Json::Object{{"request_id","11111111-1111-4111-8111-111111111111"},{"relative_path",cacheRelative},{"kind","file"},{"expected",expectedCache},{"cache_nonce",cacheLease.at("nonce")}});
    require(!MoveFileExW(cachePath.c_str(),(cachePath+L".replaced").c_str(),MOVEFILE_REPLACE_EXISTING));
    require(!DeleteFileW(cachePath.c_str()));
    auto candidateArgs=candidate.object();candidateArgs.emplace("cache_nonce",cacheLease.at("nonce"));
    auto wrongCandidate=candidateArgs;wrongCandidate["nonce"]=randomHex();
    rejects("PEER_DENIED",[&]{(void)commitCacheDeletion(wrongCandidate);});
    require(commitCacheDeletion(candidateArgs).at("state").string()=="completed");
    // Deliberately drop the commit ACK: the protected exact completion survives
    // release/reacquire and is reconciled before any new pin/writer admission.
    (void)releaseMutex(Json::Object{{"scope","cache"},{"nonce",cacheLease.at("nonce")},{"identity",cacheLease.at("identity")}});
    cacheLease=acquireMutex(Json::Object{{"scope","cache"}});
    require(std::get<bool>(cacheLease.at("acquired").value));
    require(GetFileAttributesW(cachePath.c_str())==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND);
    require(std::holds_alternative<std::nullptr_t>(readCacheRecord(0).value));
    writeFixture(cachePath,"cache-reader-fixture");
    Handle consumer(CreateFileW(cachePath.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(consumer.valid());
    expectedCache=cacheHandleIdentity(consumer.value,false);
    candidate=beginCacheDeletion(Json::Object{{"request_id","22222222-2222-4222-8222-222222222222"},{"relative_path",cacheRelative},{"kind","file"},{"expected",expectedCache},{"cache_nonce",cacheLease.at("nonce")}});
    candidateArgs=candidate.object();candidateArgs.emplace("cache_nonce",cacheLease.at("nonce"));
    require(commitCacheDeletion(candidateArgs).at("state").string()=="pending");
    rejects("VAULT_RECOVERY_REQUIRED",[&]{(void)releaseCacheDeletion(candidateArgs);});
    (void)releaseMutex(Json::Object{{"scope","cache"},{"nonce",cacheLease.at("nonce")},{"identity",cacheLease.at("identity")}});
    require(!std::get<bool>(acquireMutex(Json::Object{{"scope","cache"}}).at("acquired").value));
    consumer.close();cacheLease=acquireMutex(Json::Object{{"scope","cache"}});require(std::get<bool>(cacheLease.at("acquired").value));
    require(std::holds_alternative<std::nullptr_t>(readCacheRecord(0).value));
    (void)releaseMutex(Json::Object{{"scope","cache"},{"nonce",cacheLease.at("nonce")},{"identity",cacheLease.at("identity")}});

    // Closed copier deletion uses the same real disposition/certificate core.
    // Synthetic fixture authority is NOT installed Main/role authentication.
    const auto thumbnailAttributes=GetFileAttributesW((personal+L"\\library\\thumbnails").c_str());
    require(thumbnailAttributes!=INVALID_FILE_ATTRIBUTES&&(thumbnailAttributes&FILE_ATTRIBUTE_DIRECTORY)&&!(thumbnailAttributes&FILE_ATTRIBUTE_REPARSE_POINT));
    const std::string partialRelative="library\\thumbnails\\"+std::string(64,'e')+".image.11111111-1111-4111-8111-111111111111.tmp";
    const auto partialPath=personal+L"\\"+wide(partialRelative);require(partialPath.size()<MAX_PATH);writeFixture(partialPath,"partial");Json partialBirth;
    {auto exact=openEntry(partialPath,false,true);partialBirth=cacheHandleBirth(exact.value);}
    const Json partialAuthority=Json::Object{{"fixture","copier-exit"}};
    Handle partialReader(CreateFileW(partialPath.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(partialReader.valid());
    require(retireStorageCleanup("partial",partialRelative,partialBirth,partialAuthority,nullptr,1024*1024).at("state").string()=="pending");
    partialReader.close();const auto partialReceipt=retireStorageCleanup("partial",partialRelative,partialBirth,partialAuthority,nullptr,1024*1024);
    require(partialReceipt.at("state").string()=="completed");require(mm::dump(retireStorageCleanup("partial",partialRelative,partialBirth,partialAuthority,nullptr,1024*1024))==mm::dump(partialReceipt));
    writeFixture(partialPath,"foreign replacement");rejects("PATH_UNSAFE",[&]{(void)retireStorageCleanup("partial",partialRelative,partialBirth,partialAuthority,nullptr,1024*1024);});

    // The production Library snapshot/disposition core is shared with this
    // random isolated root. This does not bypass installed Main authorization.
    directory("personal","native-library-delete");const auto libraryBase=personal+L"\\native-library-delete";
    writeFixture(libraryBase+L"\\original.wav","original");writeFixture(libraryBase+L"\\vocals.mp3","voice");writeFixture(libraryBase+L"\\pair.json","{}");
    std::vector<LibraryRetireEntry> libraryRows;snapshotLibraryTree(libraryBase,"",libraryRows,true);require(libraryRows.size()==4);
    require(!DeleteFileW((libraryBase+L"\\vocals.mp3").c_str())); // selected handles prevent replacement
    writeFixture(libraryBase+L"\\foreign.txt","foreign");rejects("PATH_UNSAFE",[&]{assertLibraryTreeNames(libraryBase,libraryRows);});require(DeleteFileW((libraryBase+L"\\foreign.txt").c_str()));
    writeLibraryRows(15,libraryRows);const auto savedLibrary=readLibraryRows(15,1);require(savedLibrary.size()==4&&mm::dump(savedLibrary.front().row)==mm::dump(libraryRows.front().row));
    require(disposeLibraryRows(15,libraryRows,libraryBase));require(GetFileAttributesW(libraryBase.c_str())==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND);
    const auto completedLibrary=readLibraryRows(15,1);for(const auto& row:completedLibrary)require(row.row.at("state").string()=="gone");
    (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",libraryRetireKey(15,0)}});

    // Authenticated fixed quarantine, stale operational witness is irrelevant
    // to installed-byte retirement. Fixtures never grant inference authority.
    const auto jsBirth=[](const Json& birth){return Json::Object{{"device",birth.at("device")},{"fileId",birth.at("file_id")},{"bornAt",birth.at("born_at")}};};
    const auto jsPeer=[](const Json& peer){return Json::Object{{"sid",peer.at("sid")},{"sessionId",peer.at("session_id")},{"pid",peer.at("pid")},{"creationTime",peer.at("creation_time")}};};
    const std::string repairTarget(64,'b'),repairArchive(64,'c'),repairManifest(64,'d');
    require(knownRuntimeRetirementDllPolicy("private-pe-imports-msvc-v1"));
    require(knownRuntimeRetirementDllPolicy("private-pe-imports-msvc-v2"));
    require(!knownRuntimeRetirementDllPolicy("private-pe-imports-msvc-v3"));
    require(!knownRuntimeRetirementDllPolicy(""));
    directory("personal","runtime\\releases\\"+repairTarget);directory("personal","staging\\prepare-runtime-backup");
    const auto canonicalRepair=personal+L"\\runtime\\releases\\"+wide(repairTarget),backupRepair=personal+L"\\staging\\prepare-runtime-backup";
    writeFixture(backupRepair+L"\\old.bin","old");Json oldBirth,newBirth,leafBirth;std::string leafSha;
    {auto oldRoot=openEntry(backupRepair,true,true),newRoot=openEntry(canonicalRepair,true,true);oldBirth=jsBirth(cacheHandleBirth(oldRoot.value));newBirth=jsBirth(cacheHandleBirth(newRoot.value));}
    {auto leaf=openEntry(backupRepair+L"\\old.bin",false,true);leafBirth=jsBirth(cacheHandleBirth(leaf.value));}
    {Handle leaf(CreateFileW((backupRepair+L"\\old.bin").c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(leaf.valid());leafSha=hashFile(leaf.value);}
    const auto repairInventory=mm::dump(Json::Object{{"version",1},{"entries",Json::Array{Json::Object{{"path",""},{"kind","directory"},{"birth",oldBirth},{"bytes",nullptr},{"sha256",nullptr}},Json::Object{{"path","old.bin"},{"kind","file"},{"birth",leafBirth},{"bytes",3},{"sha256",leafSha}}}}});
    require(parseRepairInventory(repairInventory).size()==2);
    writeFixture(personal+L"\\staging\\prepare-runtime-backup.inventory.json",repairInventory);
    const auto repairRow=Json::Object{{"version",1},{"target",repairTarget},{"archiveSha256",repairArchive},{"releaseVersion","fixture"},{"sequence",1},{"owner",jsPeer(singletonParentIdentity())},{"oldBirth",oldBirth},{"newBirth",newBirth},{"oldTreeDigest",repairBytesDigest(repairInventory)},{"manifestSha256",repairManifest},{"previousManifestSha256",nullptr},{"phase","activated"}};
    repairProtectedWrite("prepare_runtime_repair",repairRow);
    repairProtectedWrite("prepare_maintenance",Json::Object{{"version",1},{"sid",currentIdentity().sid},{"transaction","11111111-1111-4111-8111-111111111111"},{"target",repairTarget},{"owner",jsPeer(singletonParentIdentity())},{"authority",nullptr},{"phase","retired"}});
    repairProtectedWrite("ready_receipt",Json::Object{{"version",2},{"bootIdentity",std::string(64,'e')},{"sid",currentIdentity().sid},{"target",repairTarget},{"release",repairTarget},{"sequence",1},{"manifestSha256",repairManifest},{"modelSha256",std::string(64,'f')},{"fixtureSha256",std::string(64,'a')},{"modelFingerprint",Json::Object{}},{"qualification",Json::Object{}},{"activatedAt","2026-10-10T00:00:00Z"}});
    repairProtectedWrite("runtime_"+repairTarget.substr(0,56),Json::Object{{"version",2},{"dllPolicy","private-pe-imports-msvc-v1"},{"sid",currentIdentity().sid},{"release",repairTarget},{"archiveSha256",repairArchive},{"sequence",1},{"manifestSha256",repairManifest}});
    const auto prepareDelete=acquireMutex(Json::Object{{"scope","prepare"}});require(std::get<bool>(prepareDelete.at("acquired").value));
    auto repairArgs=Json::Object{{"target",repairTarget},{"record_digest",repairBytesDigest(repairProtectedBytes("prepare_runtime_repair"))},{"prepare_nonce",prepareDelete.at("nonce")}};
    const auto forged=repairArgs;auto wrongRepair=forged;wrongRepair["prepare_nonce"]=randomHex();rejects("PEER_DENIED",[&]{(void)removeRuntimeRepairBackup(wrongRepair);});
    writeFixture(backupRepair+L"\\foreign.bin","foreign");rejects("PATH_UNSAFE",[&]{(void)removeRuntimeRepairBackup(repairArgs);});
    // The isolated test removes its deliberately added fixture, not a production
    // recursive cleanup path. A partial Native WAL remains protected meanwhile.
    require(DeleteFileW((backupRepair+L"\\foreign.bin").c_str()));
    require(removeRuntimeRepairBackup(repairArgs).at("state").string()=="completed");
    require(repairProtectedBytes("prepare_runtime_repair").empty());
    // A retired v1 backup remains retired after a current v2 qualification;
    // neither historical policy nor this cleanup endpoint grants readiness.
    repairProtectedWrite("runtime_"+repairTarget.substr(0,56),Json::Object{{"version",2},{"dllPolicy","private-pe-imports-msvc-v2"},{"sid",currentIdentity().sid},{"release",repairTarget},{"archiveSha256",repairArchive},{"sequence",1},{"manifestSha256",repairManifest}});
    require(removeRuntimeRepairBackup(repairArgs).at("state").string()=="completed");
    repairProtectedWrite("runtime_"+repairTarget.substr(0,56),Json::Object{{"version",2},{"dllPolicy","private-pe-imports-msvc-v3"},{"sid",currentIdentity().sid},{"release",repairTarget},{"archiveSha256",repairArchive},{"sequence",1},{"manifestSha256",repairManifest}});
    rejects("PEER_DENIED",[&]{(void)removeRuntimeRepairBackup(repairArgs);});
    repairProtectedWrite("runtime_"+repairTarget.substr(0,56),Json::Object{{"version",2},{"dllPolicy","private-pe-imports-msvc-v2"},{"sid",currentIdentity().sid},{"release",repairTarget},{"archiveSha256",repairArchive},{"sequence",1},{"manifestSha256",repairManifest}});
    writeFixture(personal+L"\\staging\\prepare-runtime-backup.inventory.json","foreign");rejects("PATH_UNSAFE",[&]{(void)removeRuntimeRepairBackup(repairArgs);});
    require(DeleteFileW((personal+L"\\staging\\prepare-runtime-backup.inventory.json").c_str()));
    (void)releaseMutex(Json::Object{{"scope","prepare"},{"nonce",prepareDelete.at("nonce")},{"identity",prepareDelete.at("identity")}});
    (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key","prepare_maintenance"}});

    require(startupCommand()==quote(rootPath("fleet")+L"\\bin\\MusicMuteSession.exe")+L" --startup");
    const auto login=mm::dump(Json::Object{{"version",1},{"sid",currentIdentity().sid},{"release",std::string(64,'a')},{"nodeSha256",std::string(64,'b')},{"nativeSha256",std::string(64,'c')},{"entrySha256",std::string(64,'d')},{"launcherSha256",std::string(64,'e')},{"capsuleSha256",std::string(64,'f')}});
    (void)vault("vault_put",Json::Object{{"namespace","fleet"},{"key","login_bootstrap"},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(login.data()),static_cast<DWORD>(login.size()))}});
    require(readLoginReceipt().at("release").string()==std::string(64,'a'));
    require(std::get<bool>(latestWorkerTreesIdle().at("idle").value));
    // Authenticator is an injected boundary in this isolated fixture ONLY; the
    // production wire has no setter/bypass. Live signed shim lineage is W34.
    workerLoginAuthenticated=true;
    const auto loginFence=acquireMutex(Json::Object{{"scope","activation"}});
    require(singletonRecord("session").at("nonce").string()==loginFence.at("nonce").string());
    rejects("PEER_DENIED",[&]{(void)releaseMutex(Json::Object{{"scope","activation"},{"nonce",randomHex()},{"identity",loginFence.at("identity")}});});
    require(singletonRecord("session").at("nonce").string()==loginFence.at("nonce").string());
    (void)releaseMutex(Json::Object{{"scope","activation"},{"nonce",loginFence.at("nonce")},{"identity",loginFence.at("identity")}});
    require(jsonNull(singletonRecord("session")));
    workerLoginAuthenticated=false;
    const auto ordinaryActivation=acquireMutex(Json::Object{{"scope","activation"}});
    require(jsonNull(singletonRecord("session")));
    (void)releaseMutex(Json::Object{{"scope","activation"},{"nonce",ordinaryActivation.at("nonce")},{"identity",ordinaryActivation.at("identity")}});
    require(supportedConsumerWindowsVersion(10,19045,VER_NT_WORKSTATION)&&supportedConsumerWindowsVersion(10,22621,VER_NT_WORKSTATION));
    require(!supportedConsumerWindowsVersion(10,19044,VER_NT_WORKSTATION)&&!supportedConsumerWindowsVersion(10,26100,VER_NT_SERVER)&&!supportedConsumerWindowsVersion(11,30000,VER_NT_WORKSTATION));
    const auto environment=encodeConsumerEnvironment(ConsumerEnvironmentEntries{{L"z",L"last"},{L"PATH",L"C:\\Fixed"},{L"a",L"first"}});
    require(environment.starts_with(L"a=first")&&environment.find(std::wstring(2,L'\0'))==environment.size()-2);
    const auto pathAt=environment.find(L"PATH=C:\\Fixed"),lastAt=environment.find(L"z=last");require(pathAt>0&&pathAt<lastAt);
    rejects("BAD_REQUEST",[&]{(void)encodeConsumerEnvironment(ConsumerEnvironmentEntries{{L"BAD=KEY",L"value"}});});
    rejects("BAD_REQUEST",[&]{(void)encodeConsumerEnvironment(ConsumerEnvironmentEntries{{L"KEY",std::wstring(L"a\0b",3)}});});
    directory("personal","native-policy-fixtures");
    require(!(peTrustFlags(PeTrustPolicy::FreshApproval)&WTD_CACHE_ONLY_URL_RETRIEVAL));
    require(peTrustFlags(PeTrustPolicy::ApprovedInstalledCache)&WTD_CACHE_ONLY_URL_RETRIEVAL);
    require((peTrustFlags(PeTrustPolicy::ApprovedInstalledCache)&WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT)!=0);
    require(!(peTrustFlags(PeTrustPolicy::ApprovedInstalledCache)&(WTD_REVOCATION_CHECK_NONE|WTD_HASH_ONLY_FLAG|WTD_NO_POLICY_USAGE_FLAG)));
    const auto pePath=personal+L"\\native-policy-fixtures\\policy.bin";
    auto pePolicy=[&](WORD machine,WORD magic,bool bootstrapper){
      std::string bytes(128,'\0');bytes[0]='M';bytes[1]='Z';const DWORD offset=64;std::memcpy(bytes.data()+60,&offset,4);bytes[64]='P';bytes[65]='E';std::memcpy(bytes.data()+68,&machine,2);std::memcpy(bytes.data()+88,&magic,2);writeFixture(pePath,bytes);
      Handle file(CreateFileW(pePath.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));require(file.valid());assertSignedPeArchitecture(file.value,bootstrapper);
    };
    pePolicy(IMAGE_FILE_MACHINE_AMD64,IMAGE_NT_OPTIONAL_HDR64_MAGIC,false);
    pePolicy(IMAGE_FILE_MACHINE_I386,IMAGE_NT_OPTIONAL_HDR32_MAGIC,true);
    rejects("HELPER_INTEGRITY_INVALID",[&]{pePolicy(IMAGE_FILE_MACHINE_I386,IMAGE_NT_OPTIONAL_HDR32_MAGIC,false);});
    rejects("HELPER_INTEGRITY_INVALID",[&]{pePolicy(IMAGE_FILE_MACHINE_ARM64,IMAGE_NT_OPTIONAL_HDR64_MAGIC,true);});
    const auto installRoot=personal+L"\\native-policy-fixtures\\installed";
    {
      auto directories=installerDirectoryHandles(installRoot);
      require(!directories.empty());
      require(!MoveFileExW(installRoot.c_str(),(installRoot+L"-renamed").c_str(),0));
      require(!RemoveDirectoryW(installRoot.c_str()));
      // Installer retention duplicates the same file object with zero access.
      // Closing the originals must not release its original sharing fence.
      HANDLE duplicate=nullptr;
      require(DuplicateHandle(GetCurrentProcess(),directories.back().value,GetCurrentProcess(),&duplicate,0,FALSE,0));
      Handle retained(duplicate);directories.clear();
      require(!MoveFileExW(installRoot.c_str(),(installRoot+L"-renamed").c_str(),0));
      require(!RemoveDirectoryW(installRoot.c_str()));
    }
    // These same-user private paths can rename once the last fence is closed.
    require(MoveFileExW(installRoot.c_str(),(installRoot+L"-renamed").c_str(),0));
    require(MoveFileExW((installRoot+L"-renamed").c_str(),installRoot.c_str(),0));
    directory("personal","native-policy-fixtures\\ancestor-parent\\nested");
    const auto ancestorRoot=personal+L"\\native-policy-fixtures\\ancestor-parent";
    {
      auto ancestors=lockAncestors(ancestorRoot+L"\\nested\\future.bin",false,false,personal,true);
      require(!ancestors.empty());
      require(!MoveFileExW(ancestorRoot.c_str(),(ancestorRoot+L"-renamed").c_str(),0));
      require(!RemoveDirectoryW((ancestorRoot+L"\\nested").c_str()));
      // Full-path publication opens the held target directory for FILE_ADD_FILE.
      // Its write sharing must allow the child rename while still fencing parents.
      const auto stagePath=ancestorRoot+L"\\nested\\stage.bin",publishedPath=ancestorRoot+L"\\nested\\future.bin";
      writeFixture(stagePath,"fixture");
      {
        Handle stage(CreateFileW(stagePath.c_str(),GENERIC_READ|DELETE|READ_CONTROL,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(stage.valid());assertPrivateHandle(stage.value);
        // Match the production Win32 rename buffer, including its trailing NUL.
        std::vector<BYTE> childRenameBuffer(sizeof(FILE_RENAME_INFO)+(publishedPath.size()+1)*sizeof(wchar_t));auto* childRename=reinterpret_cast<FILE_RENAME_INFO*>(childRenameBuffer.data());childRename->ReplaceIfExists=FALSE;childRename->RootDirectory=nullptr;childRename->FileNameLength=static_cast<DWORD>(publishedPath.size()*sizeof(wchar_t));std::memcpy(childRename->FileName,publishedPath.data(),childRename->FileNameLength);
        const auto childRenamed=SetFileInformationByHandle(stage.value,FileRenameInfo,childRename,static_cast<DWORD>(childRenameBuffer.size()));const auto childRenameError=GetLastError();
        if(!childRenamed)std::cerr<<"Native fixture API failure: operation=SetFileInformationByHandleRenameChild; win32_error="<<childRenameError<<'\n';
        require(childRenamed);
      }
      require(GetFileAttributesW(stagePath.c_str())==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND);
      {
        auto payload=lockHashedFile(publishedPath,repairBytesDigest("fixture"));
        Handle writer(CreateFileW(publishedPath.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        require(!writer.valid()&&GetLastError()==ERROR_SHARING_VIOLATION);
      }
      // The same writer succeeds after the immutable payload handle closes.
      Handle writer(CreateFileW(publishedPath.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));require(writer.valid());
      require(!MoveFileExW(ancestorRoot.c_str(),(ancestorRoot+L"-renamed").c_str(),0));
    }
    require(MoveFileExW(ancestorRoot.c_str(),(ancestorRoot+L"-renamed").c_str(),0));
    require(MoveFileExW((ancestorRoot+L"-renamed").c_str(),ancestorRoot.c_str(),0));
    libraryRenameFixtures();
    writeFixture(installRoot+L"\\original.bin","fixture");require(CreateHardLinkW((installRoot+L"\\alias.bin").c_str(),(installRoot+L"\\original.bin").c_str(),nullptr));
    rejects("PATH_UNSAFE",[&]{(void)installerDirectoryHandles(installRoot);});
    require(DeleteFileW((installRoot+L"\\alias.bin").c_str()));
    const auto manifest=[](const std::string& xml){assertAsInvokerManifest(reinterpret_cast<const BYTE*>(xml.data()),static_cast<DWORD>(xml.size()));};
    manifest("<assembly><requestedExecutionLevel level='asInvoker' uiAccess='false'/></assembly>");
    for(const auto* xml:{"<assembly><requestedExecutionLevel level='requireAdministrator'/></assembly>",
      "<assembly><requestedExecutionLevel level='asInvoker'/><requestedExecutionLevel level='requireAdministrator'/></assembly>",
      "<assembly><requestedExecutionLevel level='asInvoker' uiAccess='true'/></assembly>",
      "<assembly><requestedExecutionLevel level='asInvoker'/>",
      "<!DOCTYPE assembly [<!ENTITY external SYSTEM 'file:///C:/private'>]><assembly><requestedExecutionLevel level='asInvoker'/>&external;</assembly>"})
      rejects("HELPER_INTEGRITY_INVALID",[&]{manifest(xml);});
    // Closed Share grammar can be checked without displaying a dialog or
    // creating production account authority/registration state.
    require(shareRequestId(Json::Object{{"request_id","fdcf10d8-20a1-4d3e-a3db-4eb86414955e"}})=="fdcf10d8-20a1-4d3e-a3db-4eb86414955e");
    rejects("BAD_REQUEST",[&]{(void)shareRequestId(Json::Object{{"request_id","..\\arbitrary"}});});
    rejects("JOB_NOT_OWNED",[&]{(void)dispatch("inference_idle",Json::Object{});});
    rejects("JOB_NOT_OWNED",[&]{(void)dispatch("retained_engine_register",Json::Object{{"guardian",me},{"engine",me}});});
    for(const auto* operation:{"retained_engine_idle","retained_engine_forget"})rejects("JOB_NOT_OWNED",[&]{(void)dispatch(operation,Json::Object{{"token",randomHex()}});});
    for(const auto* operation:{"retained_engine_begin","retained_engine_complete"})rejects("JOB_NOT_OWNED",[&]{(void)dispatch(operation,Json::Object{{"token",randomHex()},{"job_id","11111111-1111-4111-8111-111111111111"}});});
    const auto boot=consumerBootIdentity();require(mm::dump(boot)==mm::dump(consumerBootIdentity()));
    require(RegDeleteKeyExW(HKEY_CURRENT_USER,consumerBootKey().c_str(),KEY_WOW64_64KEY,0)==ERROR_SUCCESS);
    {Security privateKey(dataSddl());RegistryHandle persistent;DWORD disposition=0;const auto status=RegCreateKeyExW(HKEY_CURRENT_USER,consumerBootKey().c_str(),0,nullptr,REG_OPTION_NON_VOLATILE,KEY_READ|KEY_WRITE,&privateKey.attributes,&persistent.key,&disposition);if(status!=ERROR_SUCCESS)std::cerr<<"Native fixture registry API failure: operation=RegCreatePersistentBootKey; lstatus="<<status<<'\n';require(status==ERROR_SUCCESS&&disposition==REG_CREATED_NEW_KEY);}
    rejects("BOOT_IDENTITY_UNAVAILABLE",[&]{(void)consumerBootIdentity();});
    require(RegDeleteKeyExW(HKEY_CURRENT_USER,consumerBootKey().c_str(),KEY_WOW64_64KEY,0)==ERROR_SUCCESS);
    // Synthetic receipt fixtures exercise actual isolated DPAPI/file cleanup,
    // not OS Share callbacks and not production signed-app authorization.
    const auto shareId=std::string("fdcf10d8-20a1-4d3e-a3db-4eb86414955e");
    directory("personal","share\\requests\\"+shareId);
    const auto shareRelative="share\\requests\\"+shareId+"\\media.mp3";
    const auto sharePath=personal+L"\\"+wide(shareRelative);
    writeFixture(sharePath,"synthetic share bytes");
    Handle shareFile(CreateFileW(sharePath.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));require(shareFile.valid());
    auto shareRecord=Json::Object{{"version",1},{"request_id",shareId},{"nonce",randomHex()},{"helper",me},{"window_owner",me},{"relative_path",shareRelative},{"sha256",hashFile(shareFile.value)},{"bytes",21},{"file_identity",shareFileIdentity(shareFile.value)},{"state","pending"},{"shown",true},{"quiesced",false},{"callback",nullptr}};
    shareFile.close();saveShareReceipt(shareRecord);
    require(pruneNativeShareReceipts().at("retained").integer()==1);
    shareRecord["state"]="completed";shareRecord["callback"]="ShareCompleted";saveShareReceipt(shareRecord);
    require(pruneNativeShareReceipts().at("removed").integer()==0);
    shareRecord["quiesced"]=true;saveShareReceipt(shareRecord);
    require(pruneNativeShareReceipts().at("removed").integer()==0);
    require(DeleteFileW(sharePath.c_str()));
    require(pruneNativeShareReceipts().at("removed").integer()==1&&jsonNull(loadShareReceipt(shareId)));
    // These synthetic retired-byte authorities test exact HANDLE deletion and
    // certificate continuation only. They do not simulate real Share callbacks,
    // signed Main authorization or a production installation.
    directory("personal","storage");writeFixture(personal+L"\\storage\\writes.json","{\"version\":1,\"writes\":[]}");
    // Authenticated metadata recovery uses only a durable positive disposition,
    // exact held ancestry and an actually exited copier birth. Intent absence
    // remains uncertain. The fault rewrite is isolated test data, not an API.
    for(const auto* state:{"submitted","intent"}){
      const auto id=std::string(state)=="submitted"?"33333333-3333-4333-8333-333333333333":"44444444-4444-4444-8444-444444444444";
      const auto relative="library\\thumbnails\\"+std::string(64,'f')+".image."+id+".tmp";const auto path=personal+L"\\"+wide(relative);writeFixture(path,"recovery");Json birth;{auto file=openEntry(path,false,true);birth=cacheHandleBirth(file.value);}
      const auto receipt=retireStorageCleanup("partial",relative,birth,Json::Object{{"fixture",state}},nullptr,1024*1024);const auto digest=receipt.at("receipt_id").string();auto record=storageCleanupRecord(digest).object();record["state"]=state;record["creator"]=Json::Object{{"sid",me.at("sid")},{"session_id",me.at("session_id")},{"pid",static_cast<std::int64_t>(terminalProcess.dwProcessId)},{"creation_time",creation(terminal.value)}};repairProtectedWrite(storageCleanupKey(digest),record);
      (void)recoverStorageCleanupRecords();const auto recovered=storageCleanupRecord(digest);if(std::string(state)=="submitted")require(jsonNull(recovered));else{require(recovered.at("state").string()=="intent");(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",storageCleanupKey(digest)}});}
    }
    directory("personal","diagnostics\\reports");
    const std::string cleanupId="21111111-1111-4111-8111-111111111111",cleanupRelative="diagnostics\\reports\\"+cleanupId+".json";
    const auto cleanupPath=personal+L"\\"+wide(cleanupRelative);writeFixture(cleanupPath,"synthetic diagnostic bytes");
    Json cleanupExpected;std::string cleanupSha;
    {
      auto exact=openEntry(cleanupPath,false,true);cleanupExpected=cacheHandleIdentity(exact.value,false);
      Handle readable(CreateFileW(cleanupPath.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      require(readable.valid());require(mm::dump(cacheHandleIdentity(readable.value,false))==mm::dump(cleanupExpected));
      cleanupSha=hashFile(readable.value);
    }
    const Json cleanupAuthority=Json::Object{{"state","deleting"},{"receipt",cleanupId}};
    Handle cleanupReader(CreateFileW(cleanupPath.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));require(cleanupReader.valid());
    require(retirePersonalBytes("report",cleanupId,cleanupRelative,cleanupExpected,Json::Object{{"sha256",cleanupSha}},cleanupAuthority).at("state").string()=="pending");
    require(readPersonalCleanup("report",cleanupId).at("state").string()=="file-submitted");
    cleanupReader.close();
    require(retirePersonalBytes("report",cleanupId,cleanupRelative,cleanupExpected,Json::Object{{"sha256",cleanupSha}},cleanupAuthority).at("state").string()=="completed");
    require(retirePersonalBytes("report",cleanupId,cleanupRelative,cleanupExpected,Json::Object{{"sha256",cleanupSha}},cleanupAuthority).at("state").string()=="completed");
    writeFixture(cleanupPath,"replacement");
    rejects("PATH_UNSAFE",[&]{(void)retirePersonalBytes("report",cleanupId,cleanupRelative,cleanupExpected,Json::Object{{"sha256",cleanupSha}},cleanupAuthority);});
    require(DeleteFileW(cleanupPath.c_str()));require(collectPersonalCleanupRecords().at("removed").integer()==1);
    require(me.at("sid").string() == report.at("sid").string());
    require(me.at("creation_time").string() == report.at("creation_time").string());
    rejects("PATH_UNSAFE", [&] { (void)relativePath("..\\outside"); });
    rejects("PATH_UNSAFE", [&] { (void)relativePath("vault:secret"); });
    rejects("PATH_UNSAFE", [&] { (void)relativePath("NUL.json"); });
    // UTF-8 bytes and universal wide escapes keep the Windows reserved-name
    // check independent of the compiler's source code page.
    for (const char* reserved : {"COM\xC2\xB9.txt", "COM\xC2\xB2.txt", "COM\xC2\xB3.txt", "LPT\xC2\xB9.txt", "LPT\xC2\xB2.txt", "LPT\xC2\xB3.txt"})
      rejects("PATH_UNSAFE", [&] { (void)relativePath(reserved); });
    // Isolated HKCU subtree only. An interrupted own registration can repair;
    // a foreign empty key or unexpected value must never be adopted/deleted.
    require(protocolState(KEY_WOW64_32KEY)=="absent"&&protocolState(KEY_WOW64_64KEY)=="absent");
    { RegistryHandle partial;DWORD created=0;require(RegCreateKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,nullptr,0,KEY_WRITE|KEY_WOW64_32KEY,nullptr,&partial.key,&created)==ERROR_SUCCESS); }
    rejects("PROTOCOL_REGISTRATION_CONFLICT",[&]{(void)protocolRegistration(false);});
    writeProtocolReceipt("registering");
    require(protocolState(KEY_WOW64_32KEY,true)=="partial");
    (void)protocolRegistration(false);
    require(protocolState(KEY_WOW64_32KEY)=="owned"&&protocolState(KEY_WOW64_64KEY)=="owned");
    { RegistryHandle partial;require(RegOpenKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,KEY_WRITE|KEY_WOW64_32KEY,&partial.key)==ERROR_SUCCESS);require(RegDeleteValueW(partial.key,L"URL Protocol")==ERROR_SUCCESS); }
    (void)protocolRegistration(false);
    { RegistryHandle foreign;require(RegOpenKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,KEY_WRITE|KEY_WOW64_32KEY,&foreign.key)==ERROR_SUCCESS);const wchar_t value[]=L"foreign";require(RegSetValueExW(foreign.key,L"unexpected",0,REG_SZ,reinterpret_cast<const BYTE*>(value),sizeof(value))==ERROR_SUCCESS); }
    rejects("PROTOCOL_REGISTRATION_CONFLICT",[&]{(void)protocolRegistration(true);});
    { RegistryHandle foreign;require(RegOpenKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,KEY_WRITE|KEY_WOW64_32KEY,&foreign.key)==ERROR_SUCCESS);require(RegDeleteValueW(foreign.key,L"unexpected")==ERROR_SUCCESS); }
    (void)protocolRegistration(true);require(jsonNull(protocolReceipt()));
    for(const auto view:{KEY_WOW64_32KEY,KEY_WOW64_64KEY}) {
      RegistryHandle parent;const auto opened=RegOpenKeyExW(HKEY_CURRENT_USER,L"Software\\MusicMuteConsumerNativeTest",0,KEY_READ|KEY_WRITE|view,&parent.key);
      require(opened==ERROR_SUCCESS||opened==ERROR_FILE_NOT_FOUND);
      if(opened==ERROR_SUCCESS){const auto own=isolatedTestRoot.substr(isolatedTestRoot.find_last_of(L'\\')+1);const auto result=RegDeleteTreeW(parent.key,own.c_str());require(result==ERROR_SUCCESS||result==ERROR_FILE_NOT_FOUND);}
    }
    // Synthetic certificate validation exercises actual DPAPI/atomic storage,
    // without launching an installer or touching an installed application.
    const auto installerPin = Json::Object{{"identity", randomHex()}, {"sha256", randomHex()}, {"bytes", 128}, {"publisher_sha256", randomHex()}};
    require(inspectInstallerLaunch(installerPin, false).at("state").string() == "absent");
    auto installerRecord = Json::Object{{"version", 1}, {"nonce", randomHex()}, {"pin", installerPin}, {"state", "launching"}, {"monitor", nullptr}, {"monitor_thread", nullptr}, {"monitor_image", utf8(personal+L"\\updates\\staging\\"+wide(installerPin.at("identity").string())+L"\\monitor.exe")}, {"monitor_sha256", randomHex()}, {"process", nullptr}, {"exit_code", nullptr}, {"tree_exited", false}};
    writeInstallerCertificate(installerRecord);
    require(inspectInstallerLaunch(installerPin, false).at("state").string() == "unknown");
    require(inspectInstallerLaunch(installerPin, true).at("state").string() == "unknown");
    auto differentPin = installerPin; differentPin["sha256"] = randomHex();
    rejects("INSTALLER_LAUNCH_CONFLICT", [&] { (void)inspectInstallerLaunch(differentPin, false); });
    installerRecord["monitor"] = me;installerRecord["monitor_thread"]=Json::Object{{"tid",static_cast<std::int64_t>(GetCurrentThreadId())},{"creation_time",threadCreation(GetCurrentThread())}}; installerRecord["process"] = me; installerRecord["state"] = "completed"; installerRecord["exit_code"] = 0; installerRecord["tree_exited"] = true;
    writeInstallerCertificate(installerRecord);
    require(inspectInstallerLaunch(installerPin, false).at("state").string() == "completed");
    require(inspectInstallerLaunch(differentPin, false).at("state").string() == "absent");
    installerRecord["tree_exited"] = false; writeInstallerCertificate(installerRecord);
    rejects("VAULT_CORRUPT", [&] { (void)inspectInstallerLaunch(installerPin, false); });
    (void)vault("vault_delete", Json::Object{{"namespace", "account"}, {"key", "installer_launch"}});

    for (const auto* name : {"account", "fleet"}) {
      (void)dispatch("vault_put", Json::Object{{"namespace", name}, {"key", "fixture"}, {"bytes_base64", "c3ludGhldGlj"}});
      const auto record = dispatch("vault_get", Json::Object{{"namespace", name}, {"key", "fixture"}});
      require(record.at("bytes_base64").string() == "c3ludGhldGlj");
    }
    // A held destination disallows replacement: old ciphertext must survive a
    // failed atomic commit and no plaintext staging record is ever created.
    Handle held(CreateFileW((personal + L"\\vault\\account\\fixture.dpapi").c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(held.valid());
    rejects("VAULT_UNAVAILABLE", [&] { (void)dispatch("vault_put", Json::Object{{"namespace", "account"}, {"key", "fixture"}, {"bytes_base64", "cmVwbGFjZW1lbnQ="}}); });
    held.close();
    require(dispatch("vault_get", Json::Object{{"namespace", "account"}, {"key", "fixture"}}).at("bytes_base64").string() == "c3ludGhldGlj");
    (void)dispatch("vault_delete", Json::Object{{"namespace", "account"}, {"key", "fixture"}});
    require(std::holds_alternative<std::nullptr_t>(dispatch("vault_get", Json::Object{{"namespace", "account"}, {"key", "fixture"}}).value));
    require(dispatch("vault_get", Json::Object{{"namespace", "fleet"}, {"key", "fixture"}}).at("bytes_base64").string() == "c3ludGhldGlj");
    writeFixture(fleet + L"\\vault\\fleet\\fixture.dpapi", "corrupt synthetic record");
    rejects("VAULT_CORRUPT", [&] { (void)dispatch("vault_get", Json::Object{{"namespace", "fleet"}, {"key", "fixture"}}); });
    (void)dispatch("vault_delete", Json::Object{{"namespace", "fleet"}, {"key", "fixture"}});

    directory("personal", "acl-test");
    auto unsafe = personal + L"\\acl-test";
    Security broad(L"D:P(A;;FA;;;WD)");
    require(SetFileSecurityW(unsafe.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, broad.descriptor));
    rejects("ACL_UNSAFE", [&] { (void)dispatch("validate_path", Json::Object{{"root", "personal"}, {"relative_path", "acl-test"}, {"kind", "directory"}}); });
    require(SetFileSecurityW(unsafe.c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, security.descriptor));

    const auto channel = randomHex(); const auto nonce = randomHex();
    std::exception_ptr clientError;
    Json clientResult;
    std::thread client([&] {
      try { clientResult = pipeConnect(Json::Object{{"channel", channel}, {"nonce", nonce}, {"peer", me}, {"timeout_ms", 5000}, {"payload_base64", "cXVlc3Rpb24="}}); }
      catch (...) { clientError = std::current_exception(); }
    });
    Json serverResult;
    try { serverResult = pipeExchange(Json::Object{{"channel", channel}, {"nonce", nonce}, {"peer", me}, {"timeout_ms", 5000}, {"response_base64", "YW5zd2Vy"}}); }
    catch (...) { client.join(); throw; }
    client.join(); if (clientError) std::rethrow_exception(clientError);
    require(serverResult.at("payload_base64").string() == "cXVlc3Rpb24=");
    require(clientResult.at("payload_base64").string() == "YW5zd2Vy");
    const auto dynamicChannel = randomHex(); const auto dynamicNonce = randomHex();
    clientError = nullptr;
    std::thread dynamicClient([&] {
      try { clientResult = pipeConnect(Json::Object{{"channel", dynamicChannel}, {"nonce", dynamicNonce}, {"peer", me}, {"timeout_ms", 5000}, {"payload_base64", "cXVlc3Rpb24="}}); }
      catch (...) { clientError = std::current_exception(); }
    });
    try {
      const auto accepted = dispatch("pipe_accept", Json::Object{{"channel", dynamicChannel}, {"nonce", dynamicNonce}, {"peer", nullptr}, {"timeout_ms", 5000}});
      require(accepted.at("payload_base64").string() == "cXVlc3Rpb24=");
      const auto& connection = accepted.at("connection");
      auto reply = Json::Object{{"token", connection.at("token")}, {"nonce", connection.at("nonce")}, {"peer", connection.at("peer")}, {"payload_base64", "YW5zd2Vy"}};
      (void)dispatch("pipe_reply", reply);
      rejects("PIPE_UNAVAILABLE", [&] { (void)dispatch("pipe_reply", reply); });
    } catch (...) { dynamicClient.join(); throw; }
    dynamicClient.join(); if (clientError) std::rethrow_exception(clientError);
    require(clientResult.at("payload_base64").string() == "YW5zd2Vy");
    rejects("TIMEOUT", [&] { (void)pipeExchange(Json::Object{{"channel", randomHex()}, {"nonce", randomHex()}, {"peer", me}, {"timeout_ms", 100}, {"response_base64", ""}}); });
    const auto foreign = Json::Object{{"sid", me.at("sid")}, {"session_id", me.at("session_id").integer() + 1}, {"pid", me.at("pid")}, {"creation_time", me.at("creation_time")}};
    rejects("PEER_DENIED", [&] { (void)pipeConnect(Json::Object{{"channel", randomHex()}, {"nonce", randomHex()}, {"peer", foreign}, {"timeout_ms", 100}, {"payload_base64", ""}}); });

    storePipeEofFixtures();

    directory("personal", "runtime\\releases\\fixture\\runtime\\node");
    directory("personal", "runtime\\releases\\fixture\\agent");
    const auto runtime = personal + L"\\runtime\\releases\\fixture";
    require(CopyFileW(argv[1], (runtime + L"\\runtime\\node\\node.exe").c_str(), TRUE));
    require(SetFileSecurityW((runtime + L"\\runtime\\node\\node.exe").c_str(), DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, security.descriptor));
    writeFixture(runtime + L"\\agent\\fleet.cjs", "synthetic fixed entry");
    writeFixture(fleet + L"\\consumer-config.json", "{}");
    const auto child = dispatch("launch_owned", Json::Object{{"role", "fleet"}, {"release", "fixture"}});
    require(!std::get<bool>(latestWorkerTreesIdle().at("idle").value));
    const auto marker = fleet + L"\\consumer-config.json.child-pid";
    const auto deadline = GetTickCount64() + 5000;
    while (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES) { require(GetTickCount64() < deadline); Sleep(10); }
    Handle markerFile(CreateFileW(marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(markerFile.valid()); char pidText[32]{}; DWORD read = 0;
    require(ReadFile(markerFile.value, pidText, 31, &read, nullptr)); markerFile.close();
    Handle descendant(OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(std::stoul(pidText))));
    require(descendant.valid());
    const auto staleSingleton = mm::dump(Json::Object{{"version", 1}, {"scope", "account"}, {"nonce", randomHex()}, {"helper", me}, {"owner", child.at("identity")}});
    (void)vault("vault_put", Json::Object{{"namespace", "account"}, {"key", "singleton_account"}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(staleSingleton.data()), static_cast<DWORD>(staleSingleton.size()))}});
    require(inspectSingletonOwner(Json::Object{{"scope", "account"}}).at("state").string() == "active");
    // There is deliberately no owned kernel mutex here. A live prior parent
    // still denies takeover after helper abandonment; SID/birth is authoritative.
    rejects("WINDOWS_SESSION_ALREADY_ACTIVE", [&] { (void)acquireMutex(Json::Object{{"scope", "account"}}); });
    rejects("JOB_NOT_OWNED", [&] { (void)dispatch("stop_owned", Json::Object{{"role", "fleet"}, {"nonce", randomHex()}, {"identity", child.at("identity")}}); });
    require(WaitForSingleObject(descendant.value, 0) == WAIT_TIMEOUT);
    (void)dispatch("stop_owned", Json::Object{{"role", "fleet"}, {"nonce", child.at("nonce")}, {"identity", child.at("identity")}});
    require(WaitForSingleObject(descendant.value, 5000) == WAIT_OBJECT_0);
    require(std::get<bool>(dispatch("owned_tree_exited", Json::Object{{"owner", child}}).at("exited").value));
    require(std::get<bool>(latestWorkerTreesIdle().at("idle").value));
    require(inspectSingletonOwner(Json::Object{{"scope", "account"}}).at("state").string() == "absent");
    const auto accountLease = acquireMutex(Json::Object{{"scope", "account"}});
    assertSingletonPublication("account");
    (void)releaseMutex(Json::Object{{"scope", "account"}, {"nonce", accountLease.at("nonce")}, {"identity", accountLease.at("identity")}});
    require(inspectSingletonOwner(Json::Object{{"scope", "account"}}).at("state").string() == "absent");
    descendant.close();
    // Synthetic physical-mutex watchdog crash fixture: no installed GPU object,
    // registry, credentials or user media is touched by this test.
    const auto gpuName=L"Global\\MusicMuteConsumerGpuFixture-"+wide(randomHex()),gpuMarker=personal+L"\\gpu-owner.ready";
    const auto tokenSid=wide(currentIdentity().sid);Security gpuSecurity(L"O:"+tokenSid+L"D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)");
    GpuKeeperLifetime gpuFixture;gpuFixture.roleBound=false;gpuFixture.owner=nullptr;
    gpuFixture.mutex=Handle(CreateMutexExW(&gpuSecurity.attributes,gpuName.c_str(),0,READ_CONTROL|SYNCHRONIZE|MUTEX_MODIFY_STATE));require(gpuFixture.mutex.valid());
    gpuFixture.job=Handle(CreateJobObjectW(nullptr,nullptr));Handle keeperJob(CreateJobObjectW(nullptr,nullptr));require(gpuFixture.job.valid()&&keeperJob.valid());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;require(SetInformationJobObject(gpuFixture.job.value,JobObjectExtendedLimitInformation,&limit,sizeof(limit)));require(SetInformationJobObject(keeperJob.value,JobObjectExtendedLimitInformation,&limit,sizeof(limit)));
    STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
    auto keeperCommand=quote(argv[1])+L" --gpu-mutex "+quote(gpuName)+L" "+quote(gpuMarker);require(CreateProcessW(argv[1],keeperCommand.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process));Handle fixtureKeeper(process.hProcess),fixtureKeeperThread(process.hThread);require(AssignProcessToJobObject(keeperJob.value,fixtureKeeper.value));require(ResumeThread(fixtureKeeperThread.value)!=static_cast<DWORD>(-1));
    const auto ownedDeadline=GetTickCount64()+5000;while(GetFileAttributesW(gpuMarker.c_str())==INVALID_FILE_ATTRIBUTES){require(GetTickCount64()<ownedDeadline);Sleep(5);}
    auto engineCommand=quote(argv[1])+L" --leaf";require(CreateProcessW(argv[1],engineCommand.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process));Handle fixtureEngine(process.hProcess),fixtureEngineThread(process.hThread);require(AssignProcessToJobObject(gpuFixture.job.value,fixtureEngine.value));require(ResumeThread(fixtureEngineThread.value)!=static_cast<DWORD>(-1));
    gpuFixture.safeRelease=Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));require(gpuFixture.safeRelease.valid());gpuFixture.watchdog=startGpuWatchdog(gpuFixture,fixtureKeeper.value);
    require(TerminateProcess(fixtureKeeper.value,2));require(WaitForSingleObject(fixtureKeeper.value,5000)==WAIT_OBJECT_0);
    DWORD recovered=WAIT_FAILED;std::thread contender([&]{recovered=WaitForSingleObject(gpuFixture.mutex.value,0);/* No ReleaseMutex: abandoned ownership must stay poisoned until this thread exits. */});contender.join();require(recovered==WAIT_ABANDONED);
    require(WaitForSingleObject(fixtureEngine.value,5000)==WAIT_OBJECT_0);require(WaitForSingleObject(gpuFixture.watchdog.value,5000)==WAIT_OBJECT_0);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION gone{};require(QueryInformationJobObject(gpuFixture.job.value,JobObjectBasicAccountingInformation,&gone,sizeof(gone),nullptr)&&gone.ActiveProcesses==0);
    gpuFixture.mutex.close();Handle freshGpu(CreateMutexExW(&gpuSecurity.attributes,gpuName.c_str(),0,READ_CONTROL|SYNCHRONIZE|MUTEX_MODIFY_STATE));require(freshGpu.valid());require(WaitForSingleObject(freshGpu.value,0)==WAIT_OBJECT_0);require(ReleaseMutex(freshGpu.value));
    centralNativePathFixtures();
    vaultReplacementFixtures();
    vaultLegacyRecoveryFixtures();
    retainedLauncherFixtures();
    libraryAbsentRecoveryFixtures();
    emptyDirectoryReparseFixtures();
    relativeDirectoryRenameFixtures();
    retainedEngineFixtures(argv[0]);
    const auto bootCleanup=RegDeleteKeyExW(HKEY_CURRENT_USER,consumerBootKey().c_str(),KEY_WOW64_64KEY,0);require(bootCleanup==ERROR_SUCCESS||bootCleanup==ERROR_FILE_NOT_FOUND);
    // This isolated random test root is the only deletion target; never installed
    // data. Reparse probes restored each exact handle before reaching here.
    std::filesystem::remove_all(isolatedTestRoot);
    std::cout << "Native isolated identity/ACL/DPAPI/pipe/Job Object tests passed\n";
    return 0;
  } catch (const Failure& error) {
    jobs.clear();
    std::cerr<<"Native retained engine latest census stage: "<<retainedEngineCensusStage<<'\n';
    std::cerr << "Native isolated consumer check failed; checkpoint="<<nativeCheckpoint<<"; code="<<(safeFailureCode(error.code)?error.code:"NATIVE_TEST_EXCEPTION")<<"; scratch retained\n";
    return 2;
  } catch (const mmstore::Error& error) {
    jobs.clear();
    std::cerr << "Native isolated consumer check failed; checkpoint="<<nativeCheckpoint<<"; code=STORE_TEST_BOUNDARY_FAILED; store_error="<<static_cast<unsigned>(error.code())<<"; scratch retained\n";
    return 2;
  } catch (const std::exception&) {
    jobs.clear();
    std::cerr << "Native isolated consumer check failed; checkpoint="<<nativeCheckpoint<<"; code=NATIVE_TEST_EXCEPTION; scratch retained\n";
    return 2;
  }
}
