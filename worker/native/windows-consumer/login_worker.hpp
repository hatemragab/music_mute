#pragma once

Json readLoginReceipt() {
  const auto encrypted=vault("vault_get",Json::Object{{"namespace","fleet"},{"key","login_bootstrap"}});
  if(std::holds_alternative<std::nullptr_t>(encrypted.value))fail("HELPER_INTEGRITY_INVALID");
  auto plain=base64Decode(encrypted.at("bytes_base64").string(),4096);
  Json receipt;
  try{receipt=mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()),plain.size())).parse();}
  catch(...){SecureZeroMemory(plain.data(),plain.size());throw;}
  SecureZeroMemory(plain.data(),plain.size());
  keys(receipt,{"version","sid","release","nodeSha256","nativeSha256","entrySha256","launcherSha256","capsuleSha256"});
  if(receipt.at("version").integer()!=1||receipt.at("sid").string()!=currentIdentity().sid)fail("PEER_DENIED");
  for(const auto key:{"release","nodeSha256","nativeSha256","entrySha256","launcherSha256","capsuleSha256"}){
    const auto value=receipt.at(key).string();if(value.size()!=64||value.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("HELPER_INTEGRITY_INVALID");
  }
  return receipt;
}
struct LockedLoginFiles {
  Json receipt; std::wstring runtime,capsuleRoot; std::string publisher;
  std::vector<Handle> ancestors,files;
  explicit LockedLoginFiles(const Json& value):receipt(value) {
    const auto root=rootPath("personal");
    runtime=root+L"\\runtime\\releases\\"+wide(receipt.at("release").string());
    capsuleRoot=root+L"\\login\\"+wide(receipt.at("capsuleSha256").string());
    ancestors=lockAncestors(runtime+L"\\runtime\\native",false,true,root);
    auto nodeAncestors=lockAncestors(runtime+L"\\runtime\\node",false,true,root);for(auto& handle:nodeAncestors)ancestors.push_back(std::move(handle));
    auto more=lockAncestors(runtime+L"\\agent",false,true,root);for(auto& handle:more)ancestors.push_back(std::move(handle));
    more=lockAncestors(capsuleRoot+L"\\resources\\runtime",false,true,root);for(auto& handle:more)ancestors.push_back(std::move(handle));
    files.push_back(lockHashedFile(runtime+L"\\runtime\\node\\node.exe",receipt.at("nodeSha256").string()));
    files.push_back(lockHashedFile(runtime+L"\\runtime\\native\\musicmute-native.exe",receipt.at("nativeSha256").string()));
    files.push_back(lockHashedFile(runtime+L"\\agent\\login-worker.cjs",receipt.at("entrySha256").string(),false,32ULL*1024*1024));
    auto capsule=lockHashedFile(capsuleRoot+L"\\capsule.json",receipt.at("capsuleSha256").string(),false,8192);
    LARGE_INTEGER size{};check(GetFileSizeEx(capsule.value,&size),"HELPER_INTEGRITY_INVALID");
    if(size.QuadPart<2||size.QuadPart>8192)fail("HELPER_INTEGRITY_INVALID");
    check(SetFilePointerEx(capsule.value,{},nullptr,FILE_BEGIN),"HELPER_INTEGRITY_INVALID");
    std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD read=0;
    check(ReadFile(capsule.value,bytes.data(),static_cast<DWORD>(bytes.size()),&read,nullptr)&&read==bytes.size(),"HELPER_INTEGRITY_INVALID");
    const auto manifest=mm::JsonParser(bytes).parse();keys(manifest,{"version","appVersion","publisherSha256","entries"});
    publisher=manifest.at("publisherSha256").string();
    if(manifest.at("version").integer()!=1||publisher.size()!=64||publisher.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("HELPER_INTEGRITY_INVALID");
    std::vector<std::string> paths{"desktop-build.json","runtime-public-keys.json","runtime/runtime-metadata.json","runtime/runtime-source.json","update-channel.json"};
    const auto& entries=manifest.at("entries").array();
    // Only an explicitly ASAR-approved catalog trust input may extend the
    // required capsule. Retained worker recovery never invents a catalog feed.
    if(entries.size()==paths.size()+1)paths.push_back("worker-catalog-update-channel.json");
    if(entries.size()!=paths.size())fail("HELPER_INTEGRITY_INVALID");
    for(std::size_t i=0;i<paths.size();++i){const auto& entry=entries[i];keys(entry,{"placement","path","bytes","sha256"});
      if(entry.at("placement").string()!="resources"||entry.at("path").string()!=paths[i]||entry.at("bytes").integer()<1||entry.at("bytes").integer()>16384)fail("HELPER_INTEGRITY_INVALID");
      auto path=wide(paths[i]);std::replace(path.begin(),path.end(),L'/',L'\\');
      auto file=lockHashedFile(capsuleRoot+L"\\resources\\"+path,entry.at("sha256").string(),false,16384);
      check(GetFileSizeEx(file.value,&size)&&size.QuadPart==entry.at("bytes").integer(),"HELPER_INTEGRITY_INVALID");files.push_back(std::move(file));
    }
    files.push_back(std::move(capsule));
  }
};
// Exact retained launcher generations use bounded staging and backup names.
// The protected intent precedes either rename; no foreign name is replaced.
bool launcherDigest(const std::string& value){return value.size()==64&&value.find_first_not_of("0123456789abcdef")==std::string::npos;}
Json launcherBirth(HANDLE file){return browserFileBirth(file);}
void validateLauncherBirth(const Json& birth){keys(birth,{"volume","file_id","creation_time"});for(const auto& [name,value]:birth.object()){const auto text=value.string();if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");ULONGLONG number=0;try{number=std::stoull(text);}catch(...){fail("VAULT_CORRUPT");}if(std::to_string(number)!=text||(name=="volume"?number>0xffffffffULL:number==0))fail("VAULT_CORRUPT");}}
Json readLauncherChange(){
  const auto encrypted=vault("vault_get",Json::Object{{"namespace","fleet"},{"key","worker_launcher_change"}});if(std::holds_alternative<std::nullptr_t>(encrypted.value))return nullptr;
  auto plain=base64Decode(encrypted.at("bytes_base64").string(),8192);Json row;
  try{row=mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()),plain.size())).parse();}catch(...){SecureZeroMemory(plain.data(),plain.size());throw;}SecureZeroMemory(plain.data(),plain.size());
  keys(row,{"version","sid","sha256","publisher_sha256","new_birth","old","phase"});if(row.at("version").integer()!=1||row.at("sid").string()!=currentIdentity().sid||!launcherDigest(row.at("sha256").string())||!launcherDigest(row.at("publisher_sha256").string()))fail("VAULT_CORRUPT");validateLauncherBirth(row.at("new_birth"));
  if(!std::holds_alternative<std::nullptr_t>(row.at("old").value)){const auto& old=row.at("old");keys(old,{"sha256","publisher_sha256","birth"});if(!launcherDigest(old.at("sha256").string())||!launcherDigest(old.at("publisher_sha256").string()))fail("VAULT_CORRUPT");validateLauncherBirth(old.at("birth"));if(old.at("birth").at("volume").string()!=row.at("new_birth").at("volume").string()||old.at("birth").at("file_id").string()==row.at("new_birth").at("file_id").string())fail("VAULT_CORRUPT");}
  const auto phase=row.at("phase").string();if(phase!="intent"&&phase!="backed-up"&&phase!="published")fail("VAULT_CORRUPT");return row;
}
void launcherChangePhase(Json& row,const std::string& phase){auto next=row.object();next["phase"]=phase;const auto bytes=mm::dump(Json(next));if(bytes.size()>8192)fail("FRAME_TOO_LARGE");(void)vault("vault_put",Json::Object{{"namespace","fleet"},{"key","worker_launcher_change"},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()))}});row=next;}
Handle openLauncherFile(HANDLE parent,const std::wstring& path,bool& absent,bool mutate){
  auto opened=openNativeChild(parent,path.substr(path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES|(mutate?(DELETE|FILE_WRITE_ATTRIBUTES):0),FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);absent=false;
  auto file=std::move(opened.handle);if(!file.valid()){if(static_cast<ULONG>(opened.status)==0xc0000034UL){absent=true;return file;}fail("PATH_UNSAFE");}
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file.value,&info),"PATH_UNSAFE");if(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||info.nNumberOfLinks!=1)fail("PATH_UNSAFE");assertPrivateHandle(file.value);
  std::vector<wchar_t> canonical(32768);const auto count=GetFinalPathNameByHandleW(file.value,canonical.data(),static_cast<DWORD>(canonical.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);if(!count||count>=canonical.size())fail("PATH_UNSAFE");std::wstring actual(canonical.data(),count);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);if(_wcsicmp(actual.c_str(),path.c_str()))fail("PATH_UNSAFE");return file;
}
template<class PublisherCheck> void assertLauncherPin(HANDLE file,const std::wstring& path,const std::string& sha,const std::string& publisher,PublisherCheck& verify){if(hashFile(file,16ULL*1024*1024)!=sha)fail("HELPER_INTEGRITY_INVALID");verify(path,file,publisher);}
template<class PublisherCheck> void assertLauncherGeneration(HANDLE file,const std::wstring& path,const Json& birth,const std::string& sha,const std::string& publisher,PublisherCheck& verify){if(mm::dump(launcherBirth(file))!=mm::dump(birth))fail("PATH_UNSAFE");assertLauncherPin(file,path,sha,publisher,verify);}
template<class PublisherCheck> void normalizeMovedLauncher(HANDLE file,const std::wstring& path,const Json& birth,const std::string& sha,const std::string& publisher,PublisherCheck& verify){
  // Called only after this invocation positively renamed this exact handle.
  // NTFS name tunneling may alter creation time, never volume/file identity.
  const auto actual=launcherBirth(file);if(actual.at("volume").string()!=birth.at("volume").string()||actual.at("file_id").string()!=birth.at("file_id").string())fail("PATH_UNSAFE");assertLauncherPin(file,path,sha,publisher,verify);
  if(actual.at("creation_time").string()!=birth.at("creation_time").string()){ULONGLONG stamp=0;try{stamp=std::stoull(birth.at("creation_time").string());}catch(...){fail("PATH_UNSAFE");}if(!stamp)fail("PATH_UNSAFE");const FILETIME time{static_cast<DWORD>(stamp),static_cast<DWORD>(stamp>>32)};check(SetFileTime(file,&time,nullptr,nullptr),"PATH_UNSAFE");}assertLauncherGeneration(file,path,birth,sha,publisher,verify);
}
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
enum class RetainedLauncherFault {none,intent,backedUp,renamed,published};
RetainedLauncherFault retainedLauncherFault=RetainedLauncherFault::none;
void retainedLauncherCheckpoint(RetainedLauncherFault point){if(retainedLauncherFault==point)fail("PATH_UNSAFE");}
#endif
template<class PreviousPin,class PublisherCheck> Json retainLauncherFiles(HANDLE parent,const std::wstring& destination,HANDLE approvedSource,const Json& desired,PreviousPin previousPin,PublisherCheck publisherCheck){
  keys(desired,{"sha256","publisher_sha256"});const auto sha=desired.at("sha256").string(),publisher=desired.at("publisher_sha256").string();if(!launcherDigest(sha)||!launcherDigest(publisher))fail("HELPER_INTEGRITY_INVALID");
  VaultNamespaceLock serialize("fleet");const auto leaf=destination.substr(destination.find_last_of(L'\\')+1),stagePath=destination+L".pending",backupPath=destination+L".previous";auto change=readLauncherChange();
  if(std::holds_alternative<std::nullptr_t>(change.value)){
    bool absent=false;auto current=openLauncherFile(parent,destination,absent,false);Json old=nullptr;
    if(!absent){if(hashFile(current.value,16ULL*1024*1024)==sha){publisherCheck(destination,current.value,publisher);return Json::Object{{"retained",true}};}
      const auto prior=previousPin();keys(prior,{"sha256","publisher_sha256"});if(!launcherDigest(prior.at("sha256").string())||!launcherDigest(prior.at("publisher_sha256").string()))fail("HELPER_INTEGRITY_INVALID");assertLauncherPin(current.value,destination,prior.at("sha256").string(),prior.at("publisher_sha256").string(),publisherCheck);old=Json::Object{{"sha256",prior.at("sha256")},{"publisher_sha256",prior.at("publisher_sha256")},{"birth",launcherBirth(current.value)}};
    }
    if(!nativeChildMissing(parent,leaf+L".pending")||!nativeChildMissing(parent,leaf+L".previous"))fail("PATH_UNSAFE");Security security(dataSddl());auto writer=std::move(openNativeChild(parent,leaf+L".pending",GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES,0,NativeChildKind::file,NativeChildDisposition::createNew,security.descriptor,true).handle);if(!writer.valid())fail("PATH_UNSAFE");
    Json birth;try{check(SetFilePointerEx(approvedSource,{},nullptr,FILE_BEGIN),"PATH_UNSAFE");std::vector<BYTE> buffer(65536);DWORD read=0,wrote=0;std::uint64_t total=0;for(;;){check(ReadFile(approvedSource,buffer.data(),static_cast<DWORD>(buffer.size()),&read,nullptr),"PATH_UNSAFE");if(!read)break;total+=read;if(total>16ULL*1024*1024)fail("HELPER_INTEGRITY_INVALID");check(WriteFile(writer.value,buffer.data(),read,&wrote,nullptr)&&wrote==read,"PATH_UNSAFE");}if(!total)fail("HELPER_INTEGRITY_INVALID");check(FlushFileBuffers(writer.value),"PATH_UNSAFE");assertPrivateHandle(writer.value);if(hashFile(writer.value,16ULL*1024*1024)!=sha)fail("HELPER_INTEGRITY_INVALID");birth=launcherBirth(writer.value);}catch(...){FILE_DISPOSITION_INFO disposition{TRUE};(void)SetFileInformationByHandle(writer.value,FileDispositionInfo,&disposition,sizeof(disposition));throw;}
    writer.close();bool stageAbsent=false;auto stage=openLauncherFile(parent,stagePath,stageAbsent,true);if(stageAbsent)fail("PATH_UNSAFE");assertLauncherGeneration(stage.value,stagePath,birth,sha,publisher,publisherCheck);
    change=Json::Object{{"version",1},{"sid",currentIdentity().sid},{"sha256",sha},{"publisher_sha256",publisher},{"new_birth",birth},{"old",old},{"phase","intent"}};launcherChangePhase(change,"intent");
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    retainedLauncherCheckpoint(RetainedLauncherFault::intent);
#endif
  }
  if(change.at("sha256").string()!=sha||change.at("publisher_sha256").string()!=publisher)fail("PATH_UNSAFE");
  const auto old=change.at("old"),newBirth=change.at("new_birth");bool currentAbsent=false;auto current=openLauncherFile(parent,destination,currentAbsent,false);
  const bool currentNew=!currentAbsent&&mm::dump(launcherBirth(current.value))==mm::dump(newBirth);
  if(currentNew){
    assertLauncherGeneration(current.value,destination,newBirth,sha,publisher,publisherCheck);if(!nativeChildMissing(parent,leaf+L".pending"))fail("PATH_UNSAFE");
    bool backupAbsent=false;auto backup=openLauncherFile(parent,backupPath,backupAbsent,true);
    if(!std::holds_alternative<std::nullptr_t>(old.value)){if(backupAbsent&&change.at("phase").string()!="published")fail("PATH_UNSAFE");if(!backupAbsent)assertLauncherGeneration(backup.value,backupPath,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);}else if(!backupAbsent)fail("PATH_UNSAFE");
    if(change.at("phase").string()!="published")launcherChangePhase(change,"published");
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    retainedLauncherCheckpoint(RetainedLauncherFault::published);
#endif
    if(!backupAbsent){FILE_DISPOSITION_INFO disposition{TRUE};check(SetFileInformationByHandle(backup.value,FileDispositionInfo,&disposition,sizeof(disposition)),"PATH_UNSAFE");const auto retiring=std::exchange(backup.value,nullptr);check(CloseHandle(retiring),"VAULT_RECOVERY_REQUIRED");if(!nativeChildMissing(parent,leaf+L".previous"))fail("PATH_UNSAFE");}
    (void)vault("vault_delete",Json::Object{{"namespace","fleet"},{"key","worker_launcher_change"}});return Json::Object{{"retained",true}};
  }
  if(change.at("phase").string()=="published")fail("PATH_UNSAFE");bool stageAbsent=false;auto stage=openLauncherFile(parent,stagePath,stageAbsent,true);if(stageAbsent)fail("PATH_UNSAFE");assertLauncherGeneration(stage.value,stagePath,newBirth,sha,publisher,publisherCheck);
  bool backupAbsent=false;auto backup=openLauncherFile(parent,backupPath,backupAbsent,true);
  if(std::holds_alternative<std::nullptr_t>(old.value)){if(!currentAbsent||!backupAbsent)fail("PATH_UNSAFE");}
  else{
    if(!currentAbsent){if(!backupAbsent)fail("PATH_UNSAFE");assertLauncherGeneration(current.value,destination,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);current.close();bool disappeared=false;auto exact=openLauncherFile(parent,destination,disappeared,true);if(disappeared)fail("PATH_UNSAFE");assertLauncherGeneration(exact.value,destination,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);check(renameNativeChild(exact.value,parent,leaf+L".previous").status==0,"PATH_UNSAFE");normalizeMovedLauncher(exact.value,backupPath,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);backup=std::move(exact);backupAbsent=false;
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
      retainedLauncherCheckpoint(RetainedLauncherFault::backedUp);
#endif
    }else{if(backupAbsent)fail("PATH_UNSAFE");assertLauncherGeneration(backup.value,backupPath,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);}
  }
  launcherChangePhase(change,"backed-up");if(!nativeChildMissing(parent,leaf))fail("PATH_UNSAFE");const auto renamed=renameNativeChild(stage.value,parent,leaf);
  if(renamed.status!=0){
    // Roll back only into a positively absent destination; never replace a leaf.
    if(backup.valid()&&nativeChildMissing(parent,leaf)){const auto restored=renameNativeChild(backup.value,parent,leaf);if(restored.status==0){normalizeMovedLauncher(backup.value,destination,old.at("birth"),old.at("sha256").string(),old.at("publisher_sha256").string(),publisherCheck);launcherChangePhase(change,"intent");}}
    fail("PATH_UNSAFE");
  }
  normalizeMovedLauncher(stage.value,destination,newBirth,sha,publisher,publisherCheck);
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  retainedLauncherCheckpoint(RetainedLauncherFault::renamed);
#endif
  launcherChangePhase(change,"published");
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  retainedLauncherCheckpoint(RetainedLauncherFault::published);
#endif
  if(backup.valid()){FILE_DISPOSITION_INFO disposition{TRUE};check(SetFileInformationByHandle(backup.value,FileDispositionInfo,&disposition,sizeof(disposition)),"PATH_UNSAFE");const auto retiring=std::exchange(backup.value,nullptr);check(CloseHandle(retiring),"VAULT_RECOVERY_REQUIRED");if(!nativeChildMissing(parent,leaf+L".previous"))fail("PATH_UNSAFE");}
  (void)vault("vault_delete",Json::Object{{"namespace","fleet"},{"key","worker_launcher_change"}});return Json::Object{{"retained",true}};
}

Json retainWorkerLauncher(const Json& args) {
  const auto source=fixedLauncherPath(),destination=fixedWorkerLauncherPath();
  auto sourceAncestors=lockAccountAppAncestors(source);
  auto original=lockHashedFile(source,args.at("launcher_sha256").string(),true,16ULL*1024*1024);
  verifyInstallerPublisher(source,original.value,args.at("publisher_sha256").string(),false,PeTrustPolicy::ApprovedInstalledCache);
  const auto caller=parentBinding(processIdentity(GetCurrentProcessId()));
  if(_wcsicmp(liveAccountPeerImage(caller.parent).c_str(),fixedAccountAppPath().c_str())!=0)fail("PEER_DENIED");
  const auto appPin=installedAccountAppPin();
  if(appPin.at("publisher_sha256").string()!=args.at("publisher_sha256").string())fail("PEER_DENIED");
  auto app=verifiedAccountApp(appPin);
  auto ancestors=lockAncestors(destination,true,false,rootPath("fleet"));
  const Json desired=Json::Object{{"sha256",args.at("launcher_sha256")},{"publisher_sha256",args.at("publisher_sha256")}};
  const auto previous=[](){LockedLoginFiles files(readLoginReceipt());return Json(Json::Object{{"sha256",files.receipt.at("launcherSha256")},{"publisher_sha256",files.publisher}});};
  const auto publisher=[](const std::wstring& path,HANDLE file,const std::string& expected){verifyInstallerPublisher(path,file,expected,false,PeTrustPolicy::ApprovedInstalledCache);};
  return retainLauncherFiles(ancestors.back().value,destination,original.value,desired,previous,publisher);
}
Json verifyWorkerLoginPeer() {
  LockedLoginFiles files(readLoginReceipt());
  const auto helper=parentBinding(processIdentity(GetCurrentProcessId())),node=parentBinding(helper.parent);
  if(_wcsicmp(helper.image.c_str(),(files.runtime+L"\\runtime\\native\\musicmute-native.exe").c_str())!=0||
    _wcsicmp(node.image.c_str(),(files.runtime+L"\\runtime\\node\\node.exe").c_str())!=0||
    _wcsicmp(liveAccountPeerImage(node.parent).c_str(),fixedWorkerLauncherPath().c_str())!=0)fail("PEER_DENIED");
  auto ancestors=lockAncestors(fixedWorkerLauncherPath(),false,false,rootPath("fleet"));
  auto launcher=lockHashedFile(fixedWorkerLauncherPath(),files.receipt.at("launcherSha256").string(),false,16ULL*1024*1024);
  verifyInstallerPublisher(fixedWorkerLauncherPath(),launcher.value,files.publisher,false,PeTrustPolicy::ApprovedInstalledCache);
  return Json::Object{{"verified",true},{"release",files.receipt.at("release")},{"capsule_sha256",files.receipt.at("capsuleSha256")},{"launcher_sha256",files.receipt.at("launcherSha256")},{"resources_root",utf8(files.capsuleRoot+L"\\resources")}};
}
bool exactLoginControllerRetired(const Json& expected) {
  keys(expected,{"sid","session_id","pid","creation_time"});
  if(expected.at("sid").string()!=currentIdentity().sid||expected.at("pid").integer()<1||expected.at("pid").integer()>2147483647)fail("JOB_NOT_OWNED");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(expected.at("pid").integer())));
  if(!process.valid())return GetLastError()==ERROR_INVALID_PARAMETER;
  if(creation(process.value)!=expected.at("creation_time").string())return true;
  return WaitForSingleObject(process.value,0)==WAIT_OBJECT_0;
}
Json latestWorkerTreesIdle(const std::string& scope="session") {
  if(scope!="session"&&scope!="prepare")fail("BAD_REQUEST");
  const std::vector<std::string> roles=scope=="session"?std::vector<std::string>{"personal","fleet"}:std::vector<std::string>{"prepare"};
  for(const auto& role:roles){
    const auto encrypted=vault("vault_get",Json::Object{{"namespace","fleet"},{"key",std::string("latest_")+role+"_job"}});
    if(std::holds_alternative<std::nullptr_t>(encrypted.value))continue;
    auto plain=base64Decode(encrypted.at("bytes_base64").string(),4096);
    Json record;try{record=mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()),plain.size())).parse();}catch(...){SecureZeroMemory(plain.data(),plain.size());throw;}
    SecureZeroMemory(plain.data(),plain.size());keys(record,{"version","owner","controller","guardian"});
    if(record.at("version").integer()!=1||record.at("owner").at("role").string()!=role)fail("JOB_NOT_OWNED");
    if(!std::get<bool>(ownedTreeExited(Json::Object{{"owner",record.at("owner")}}).at("exited").value))return Json::Object{{"idle",false}};
    // A failed physical-release/close ACK may leave its controller alive. Whole
    // Job zero AND exact controller retirement are required for this stronger
    // Prepare cleanup acknowledgement; PID absence alone is never sufficient.
    if(scope=="prepare"&&!exactLoginControllerRetired(record.at("controller")))return Json::Object{{"idle",false}};
  }
  return Json::Object{{"idle",true}};
}
Json workerLoginIdle(const std::string& scope) { (void)verifyWorkerLoginPeer();return latestWorkerTreesIdle(scope); }
int launchLoginWorker() {
  LockedLoginFiles files(readLoginReceipt());
  auto ancestors=lockAncestors(fixedWorkerLauncherPath(),false,false,rootPath("fleet"));
  auto launcher=lockHashedFile(fixedWorkerLauncherPath(),files.receipt.at("launcherSha256").string(),false,16ULL*1024*1024);
  verifyInstallerPublisher(fixedWorkerLauncherPath(),launcher.value,files.publisher,false,PeTrustPolicy::ApprovedInstalledCache);
  const auto node=files.runtime+L"\\runtime\\node\\node.exe",entry=files.runtime+L"\\agent\\login-worker.cjs";
  auto command=quote(node)+L" "+quote(entry)+L" --login-worker";auto environment=consumerEnvironment(files.runtime+L"\\runtime\\node");
  STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION child{};BOOL inJob=FALSE;
  check(IsProcessInJob(GetCurrentProcess(),nullptr,&inJob),"JOB_UNAVAILABLE");
  check(CreateProcessW(node.c_str(),command.data(),nullptr,nullptr,FALSE,DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP|CREATE_UNICODE_ENVIRONMENT|(inJob?CREATE_BREAKAWAY_FROM_JOB:0),environment.data(),rootPath("personal").c_str(),&startup,&child),"JOB_UNAVAILABLE");
  Handle process(child.hProcess),thread(child.hThread);
  // Preserve authenticated parent birth and immutable inputs throughout bootstrap.
  if(WaitForSingleObject(process.value,20*60*1000)!=WAIT_OBJECT_0)return 2;
  DWORD code=2;check(GetExitCodeProcess(process.value,&code),"JOB_UNAVAILABLE");return code==0?0:2;
}
