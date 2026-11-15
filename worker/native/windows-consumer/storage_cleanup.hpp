#pragma once

// Separate closed authorities for dead/settled copier temporaries and exact
// retired-Job marker metadata. No cache, runtime or user export path is accepted.
void authorizeStorageCleanup() {
  if(authorizeStorePersonalPrivateDataCaller())return;
  if(boundGpuRole){const auto binding=parentBinding(processIdentity(GetCurrentProcessId()));if(mm::dump(binding.parent)!=mm::dump(boundGpuRole->owner.at("identity")))fail("PEER_DENIED");return;}
  authorizePersonalDataCaller();
}
void assertRetiredEngineSessionCache(const std::string& relative){
  const std::string prefix="personal\\engine-session\\";if(relative.rfind(prefix,0)!=0)return;
  const auto separator=relative.find('\\',prefix.size());const auto workspace=relative.substr(0,separator);
  const auto path=rootPath("personal")+L"\\storage\\workspaces\\"+wide(repairBytesDigest(workspace))+L".json";
  auto parents=lockAncestors(path,false,false,rootPath("personal"),true);auto marker=openNativeChild(parents.back().value,path.substr(path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);
  if(!marker.handle.valid())fail("PEER_DENIED");assertPrivateHandle(marker.handle.value);LARGE_INTEGER size{};check(GetFileSizeEx(marker.handle.value,&size)&&size.QuadPart>=2&&size.QuadPart<=2048,"PATH_UNSAFE");std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD count=0;check(ReadFile(marker.handle.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size(),"PATH_UNSAFE");const auto row=mm::JsonParser(bytes).parse();keys(row,{"version","relativePath","owner","purpose","createdAt"});const auto& owner=row.at("owner");keys(owner,{"role","nonce","identity"});
  const Json wireOwner=Json::Object{{"role",owner.at("role")},{"nonce",owner.at("nonce")},{"identity",cleanupOwner(owner.at("identity"))}};
  if(row.at("version").integer()!=1||row.at("relativePath").string()!=workspace||row.at("purpose").string()!="processing"||row.at("createdAt").integer()<0||owner.at("role").string()!="personal"||!repairDigest(owner.at("nonce").string()))fail("PATH_UNSAFE");
  Json storeState=nullptr;const bool store=readStorePersonalCleanupState(wireOwner,storeState);
  const bool retired=store?std::get<bool>(storeState.at("retired").value):std::get<bool>(ownedTreeExited(Json::Object{{"owner",wireOwner}}).at("exited").value);
  const bool boundIdle=store?std::get<bool>(storeState.at("tool_free").value):boundGpuRole&&mm::dump(boundGpuRole->owner)==mm::dump(wireOwner)&&gpuRoleIdle(boundGpuRole->job.value,boundGpuRole->owner);
  if(!retired&&!boundIdle)fail("PEER_DENIED");
}
std::string storageCleanupKey(const std::string& digest){if(!repairDigest(digest))fail("BAD_REQUEST");return "storage_cleanup_"+digest.substr(0,48);}
Json storageCleanupRecord(const std::string& digest){const auto text=repairProtectedBytes(storageCleanupKey(digest));if(text.empty())return nullptr;const auto row=mm::JsonParser(text).parse();keys(row,{"version","receipt_id","nonce","kind","relative_path","authority_sha256","creator","ancestor_births","fingerprint","sha256","state"});if(row.at("version").integer()!=1||row.at("receipt_id").string()!=digest||!repairDigest(row.at("nonce").string())||!repairDigest(row.at("authority_sha256").string())||!repairDigest(row.at("sha256").string()))fail("VAULT_CORRUPT");const auto kind=row.at("kind").string(),state=row.at("state").string();if((kind!="partial"&&kind!="workspace"&&kind!="store-cpu-workspace"&&kind!="artifact")||(state!="intent"&&state!="submitted"&&state!="completed"))fail("VAULT_CORRUPT");return row;}
void storageCleanupState(Json& record,const std::string& state){auto next=record.object();next["state"]=state;record=next;repairProtectedWrite(storageCleanupKey(record.at("receipt_id").string()),record);}
Json storageCleanupReply(const Json& record){return Json::Object{{"state","completed"},{"receipt_id",record.at("receipt_id")},{"nonce",record.at("nonce")}};}
bool storageCleanupSourcePresent(const Json& row){if(row.at("kind").string()=="workspace"||row.at("kind").string()=="store-cpu-workspace")return !cleanupAbsent(rootPath("personal")+L"\\"+wide(row.at("relative_path").string()));const auto journal=cleanupJournal();for(const auto& source:journal.at("writes").array())if(source.at("relativePath").string()==row.at("relative_path").string())return true;else if(source.object().contains("publication")){const auto& pub=source.at("publication");for(const auto* key:{"relativePath","metadataPath","temporaryMetadata"})if(pub.at(key).string()==row.at("relative_path").string())return true;}return false;}
unsigned recoverStorageCleanupRecords(){
  const auto root=rootPath("personal"),directory=root+L"\\vault\\account";auto parents=lockAncestors(directory,true,true,root,true);unsigned retained=0,scanned=0;
  for(const auto& entry:enumerateNativeDirectory(parents.back().value)){
    if(!PathMatchSpecW(entry.name.c_str(),L"storage_cleanup_*.dpapi"))continue;
    if(++scanned>256||entry.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||!std::regex_match(utf8(entry.name),std::regex("storage_cleanup_[a-f0-9]{48}\\.dpapi")))fail("VAULT_RECOVERY_REQUIRED");
    const auto text=repairProtectedBytes(utf8(entry.name).substr(0,64));const auto parsed=mm::JsonParser(text).parse();auto row=storageCleanupRecord(parsed.at("receipt_id").string());
    if(row.at("kind").string()=="store-cpu-workspace"){++retained;continue;}
    if(row.at("state").string()=="submitted"){const auto creator=row.at("creator"),actual=processIdentity(static_cast<DWORD>(creator.at("pid").integer()),true);if(jsonNull(actual)||mm::dump(actual)!=mm::dump(creator)){const auto relative=row.at("relative_path").string();const auto path=root+L"\\"+wide(relative);auto exact=lockAncestors(path,false,false,root,true);if(mm::dump(cacheAncestorBirths(exact,relative))==mm::dump(row.at("ancestor_births"))&&nativeChildMissing(exact.back().value,path.substr(path.find_last_of(L'\\')+1)))storageCleanupState(row,"completed");}}
    bool retired=false;if(row.at("state").string()=="completed"&&!storageCleanupSourcePresent(row)){
      const auto creator=row.at("creator");const auto actual=processIdentity(static_cast<DWORD>(creator.at("pid").integer()),true);
      if(jsonNull(actual)||mm::dump(actual)!=mm::dump(creator)){const auto relative=row.at("relative_path").string();const auto path=root+L"\\"+wide(relative);auto exact=lockAncestors(path,false,false,root,true);if(mm::dump(cacheAncestorBirths(exact,relative))==mm::dump(row.at("ancestor_births"))&&nativeChildMissing(exact.back().value,path.substr(path.find_last_of(L'\\')+1))){(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",storageCleanupKey(row.at("receipt_id").string())}});retired=true;}}
    }if(!retired)++retained;
  }return retained;
}
Json retireStorageCleanup(const std::string& kind,const std::string& relative,const Json& birth,const Json& authority,Handle* selectedHandle=nullptr,std::int64_t maxBytes=2048,const Json& expected=nullptr,std::vector<Handle>* retainedParents=nullptr) {
  const auto authoritySha=repairBytesDigest(mm::dump(authority)),digest=repairBytesDigest(kind+":"+relative+":"+authoritySha);
  const auto root=rootPath("personal"),path=root+L"\\"+wide(relative);
  std::vector<Handle> localParents;if(!retainedParents)localParents=lockAncestors(path,false,false,root,true);auto& parents=retainedParents?*retainedParents:localParents;
  if(parents.empty()||!parents.back().valid())fail("PATH_UNSAFE");const auto ancestors=cacheAncestorBirths(parents,relative);auto record=storageCleanupRecord(digest);
  if(!jsonNull(record)){if(record.at("kind").string()!=kind||record.at("relative_path").string()!=relative||record.at("authority_sha256").string()!=authoritySha||mm::dump(record.at("ancestor_births"))!=mm::dump(ancestors))fail("PATH_UNSAFE");if(record.at("state").string()=="completed"){if(retainedParents?!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)):!cleanupAbsent(path))fail("PATH_UNSAFE");return storageCleanupReply(record);}}
  if(retainedParents&&!selectedHandle){if(jsonNull(record)||record.at("state").string()!="submitted"||!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)))return Json::Object{{"state","pending"}};storageCleanupState(record,"completed");return storageCleanupReply(record);}
  bool absent=false,busy=false;Handle opened;Handle& file=selectedHandle?*selectedHandle:opened;if(!selectedHandle)opened=openCacheDeleteEntry(path,false,absent,busy,true,false,true,parents.back().value);if(busy)return Json::Object{{"state","pending"}};
  if(absent){if(jsonNull(record)||record.at("state").string()!="submitted")return Json::Object{{"state","pending"}};storageCleanupState(record,"completed");return storageCleanupReply(record);}
  if(!jsonNull(birth)&&mm::dump(cacheHandleBirth(file.value))!=mm::dump(birth))fail("PATH_UNSAFE");const auto fingerprint=cacheHandleIdentity(file.value,false);if(!jsonNull(expected)&&mm::dump(expected)!=mm::dump(fingerprint))fail("PATH_UNSAFE");if(fingerprint.at("bytes").integer()>maxBytes)fail("PATH_UNSAFE");LARGE_INTEGER start{};check(SetFilePointerEx(file.value,start,nullptr,FILE_BEGIN),"PATH_UNSAFE");const auto sha=hashFile(file.value,static_cast<std::uint64_t>(maxBytes));
  if(!jsonNull(record)&&(mm::dump(record.at("fingerprint"))!=mm::dump(fingerprint)||record.at("sha256").string()!=sha))fail("PATH_UNSAFE");
  if(jsonNull(record)){if(recoverStorageCleanupRecords()>=256)fail("VAULT_RECOVERY_REQUIRED");record=Json::Object{{"version",1},{"receipt_id",digest},{"nonce",randomHex()},{"kind",kind},{"relative_path",relative},{"authority_sha256",authoritySha},{"creator",parentBinding(processIdentity(GetCurrentProcessId())).parent},{"ancestor_births",ancestors},{"fingerprint",fingerprint},{"sha256",sha},{"state","intent"}};repairProtectedWrite(storageCleanupKey(digest),record);}
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;if(!SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition))){const auto error=GetLastError();if(error==ERROR_ACCESS_DENIED||error==ERROR_SHARING_VIOLATION||error==ERROR_LOCK_VIOLATION)return Json::Object{{"state","pending"}};fail("PATH_UNSAFE");}
  storageCleanupState(record,"submitted");check(CloseHandle(file.value),"VAULT_RECOVERY_REQUIRED");file.value=nullptr;if(!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)))return Json::Object{{"state","pending"}};storageCleanupState(record,"completed");return storageCleanupReply(record);
}
Json discardStoragePartial(const Json& args){
  assertCacheLease(args);authorizeStorageCleanup();const auto id=shareRequestId(args);const auto journal=cleanupJournal();Json selected=nullptr;for(const auto& row:journal.at("writes").array())if(row.at("id").string()==id){if(!jsonNull(selected))fail("VAULT_CORRUPT");selected=row;}
  if(jsonNull(selected)||selected.at("kind").string()!="file"||!selected.object().contains("birth")||selected.object().contains("publication")||selected.object().contains("share")||selected.object().contains("input"))fail("VAULT_RECOVERY_REQUIRED");
  const auto relative=selected.at("relativePath").string();const std::string uuid="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  const bool thumbnail=std::regex_match(relative,std::regex("library\\\\thumbnails\\\\[a-f0-9]{64}\\.image\\."+uuid+"\\.tmp"));
  const bool diagnostic=std::regex_match(relative,std::regex("diagnostics\\\\reports\\\\"+uuid+"\\.json\\."+uuid+"\\.tmp"));
  const bool outbox=std::regex_match(relative,std::regex("outbox\\\\[a-f0-9]{64}\\\\"+uuid+"\\\\(?:original\\.(?:m4a|mp4|webm|mp3|opus|ogg|aac|wav|flac)|vocals\\.mp3)\\."+uuid+"\\.part"));
  if(!thumbnail&&!diagnostic&&!outbox)fail("PATH_UNSAFE");
  const auto owner=cleanupOwner(selected.at("owner")),actual=processIdentity(static_cast<DWORD>(owner.at("pid").integer()),true);if(!std::get<bool>(selected.at("settled").value)&&mm::dump(actual)==mm::dump(owner))return Json::Object{{"state","pending"}};
  if(diagnostic){const auto registry=cleanupReportRegistry();for(const auto& row:registry.at("reports").array())if(row.at("temporary").string()==relative&&row.at("state").string()=="staged")return Json::Object{{"state","pending"}};}
  return retireStorageCleanup("partial",relative,cleanupBirth(selected.at("birth")),selected,nullptr,thumbnail?1024*1024:diagnostic?2*1024*1024:100000000);
}
Json retireStorageWorkspaceMarker(const Json& args){
  assertCacheLease(args);authorizeStorageCleanup();const auto relative=args.at("relative_path").string();const std::string uuid="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  if(!std::regex_match(relative,std::regex("(?:personal\\\\(?:jobs|inputs|engine-session)|cloud\\\\work|prepare\\\\(?:work|downloads))\\\\"+uuid)))fail("PATH_UNSAFE");
  Json storeState=nullptr;const bool store=readStorePersonalCleanupState(args.at("owner"),storeState);
  const bool retired=store?std::get<bool>(storeState.at("retired").value):std::get<bool>(ownedTreeExited(Json::Object{{"owner",args.at("owner")}}).at("exited").value);
  // Normal personal completion leaves its Node/fixed helpers alive. Only that
  // exact bound owner can use the actual inference/tool-free Job census. An
  // unbound/restarted helper still needs positive whole-Job retirement.
  const bool boundIdle=store?std::get<bool>(storeState.at("tool_free").value):boundGpuRole&&mm::dump(boundGpuRole->owner)==mm::dump(args.at("owner"))&&gpuRoleIdle(boundGpuRole->job.value,boundGpuRole->owner);
  // Only completed personal attempt markers can use retained quiescence. The
  // session workspace remains protected until the original tool-free census
  // succeeds after both Python generations actually exit.
  const bool retainedIdle=std::regex_match(relative,std::regex("personal\\\\(?:jobs|inputs)\\\\"+uuid))&&(store?storeRetainedPersonalCleanupIdle(args.at("owner")):boundGpuRole&&mm::dump(boundGpuRole->owner)==mm::dump(args.at("owner"))&&retainedEngineQuiescent());
  if(!retired&&!boundIdle&&!retainedIdle)return Json::Object{{"state","pending"}};
  const auto marker="storage\\workspaces\\"+repairBytesDigest(relative)+".json";const auto root=rootPath("personal"),path=root+L"\\"+wide(marker);auto parents=lockAncestors(path,false,false,root,true);
  const Json binding=Json::Object{{"relative_path",relative},{"owner",args.at("owner")}};
  // Exact completed certificate permits lost-ACK retry when the marker is gone.
  const auto prior=storageCleanupRecord(repairBytesDigest("workspace:"+marker+":"+repairBytesDigest(mm::dump(binding))));
  if(!jsonNull(prior))return retireStorageCleanup("workspace",marker,nullptr,binding);
  bool absent=false,busy=false;auto held=openCacheDeleteEntry(path,false,absent,busy,true,false,true,parents.back().value);if(absent||busy)return Json::Object{{"state","pending"}};
  LARGE_INTEGER size{};check(GetFileSizeEx(held.value,&size)&&size.QuadPart>=2&&size.QuadPart<=2048,"PATH_UNSAFE");std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD count=0;check(ReadFile(held.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size(),"PATH_UNSAFE");const auto row=mm::JsonParser(bytes).parse();keys(row,{"version","relativePath","owner","purpose","createdAt"});
  const auto& owner=row.at("owner");keys(owner,{"role","nonce","identity"});const Json wireOwner=Json::Object{{"role",owner.at("role")},{"nonce",owner.at("nonce")},{"identity",cleanupOwner(owner.at("identity"))}};
  const auto purpose=row.at("purpose").string();if(row.at("version").integer()!=1||row.at("relativePath").string()!=relative||mm::dump(wireOwner)!=mm::dump(args.at("owner"))||(purpose!="processing"&&purpose!="download"&&purpose!="sync"&&purpose!="update")||row.at("createdAt").integer()<0)fail("PATH_UNSAFE");
  if(retainedIdle&&!retired&&!boundIdle&&purpose!="processing")fail("PATH_UNSAFE");
  const auto birth=cacheHandleBirth(held.value);return retireStorageCleanup("workspace",marker,birth,binding,&held);
}
struct StoreCpuMarkerClosure { Json binding; std::vector<Handle> parents; Handle file; Json receipt=nullptr; };
std::map<std::string, StoreCpuMarkerClosure> storeCpuMarkerClosures;
struct StoreCpuMarkerAckClosure { Json binding; std::string nonce; std::vector<Handle> parents,scratchParents; Handle scratch; bool observed=false,scratchChecked=false; std::string forgetRequest; bool forgetPending=false; std::string ackNonce; bool acknowledged=false; };
std::map<std::string, StoreCpuMarkerAckClosure> storeCpuMarkerAckClosures;
void holdStoreCpuMarkerLeaf(HANDLE parent,const std::wstring& path,Handle& retained,bool& absent,bool& busy) {
  absent=false;busy=false;
  const auto opened=openNativeChild(parent,path.substr(path.find_last_of(L'\\')+1),DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|GENERIC_READ,FILE_SHARE_READ,
    NativeChildKind::file,NativeChildDisposition::open,nullptr,false,&retained);
  if(opened.status!=0||!retained.valid()){
    const auto status=static_cast<ULONG>(opened.status),error=GetLastError();
    if(status==nativeNameMissing){absent=true;return;}
    if(error==ERROR_SHARING_VIOLATION||error==ERROR_LOCK_VIOLATION||error==ERROR_ACCESS_DENIED){busy=true;return;}
    fail("PATH_UNSAFE");
  }
  assertPrivateHandle(retained.value);if(_wcsicmp(nativeCanonical(retained.value).c_str(),path.c_str()))fail("PATH_UNSAFE");
}
std::string storeCpuWorkspace(const Json& expectation) {
  const auto operation=expectation.at("operation").string();
  return (operation=="silence_analyze"?"prepare":"cloud")+std::string("\\work\\")+expectation.at("requestId").string();
}
void requireStoreCpuRetired(const Json& expectation) {
  Json state=nullptr;if(!readStoreCpuOperationCleanupState(expectation,state)||!std::get<bool>(state.at("retired").value))fail("VAULT_RECOVERY_REQUIRED");
}
void observeStoreCpuReservationRemoved(StoreCpuMarkerAckClosure& closure,const Json& expected) {
  if(closure.scratchChecked)return;
  const auto root=rootPath("personal"),directory=root+L"\\storage",path=directory+L"\\scratch-reservations.json";
  holdStorePrivateDirectories(directory,root,closure.scratchParents);
  if(!closure.scratch.valid()) {
    const auto opened=openNativeChild(closure.scratchParents.back().value,L"scratch-reservations.json",GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open,nullptr,false,&closure.scratch);
    if(opened.status!=0||!closure.scratch.valid()){
      if(static_cast<ULONG>(opened.status)==nativeNameMissing){closure.scratchChecked=true;return;}
      fail("VAULT_RECOVERY_REQUIRED");
    }
    assertPrivateHandle(closure.scratch.value);if(_wcsicmp(nativeCanonical(closure.scratch.value).c_str(),path.c_str()))fail("PATH_UNSAFE");
  }
  const auto before=cacheHandleIdentity(closure.scratch.value,false);const auto size=before.at("bytes").integer();if(size<2||size>65536)fail("VAULT_CORRUPT");
  LARGE_INTEGER start{};check(SetFilePointerEx(closure.scratch.value,start,nullptr,FILE_BEGIN),"PATH_UNSAFE");
  std::string bytes(static_cast<std::size_t>(size),'\0');DWORD count=0;check(ReadFile(closure.scratch.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size(),"PATH_UNSAFE");
  const auto value=mm::JsonParser(bytes,true).parse();keys(value,{"version","reservations"});
  if(value.at("version").integer()!=1||value.at("reservations").array().size()>64||mm::dump(cacheHandleIdentity(closure.scratch.value,false))!=mm::dump(before))fail("VAULT_CORRUPT");
  for(const auto& row:value.at("reservations").array()) {
    auto fields=std::set<std::string>{"id","bytes","relativePath","owner","createdAt","nativePending"};
    if(row.object().contains("nativeOwner"))fields.emplace("nativeOwner");if(row.object().contains("storeCpuOwner"))fields.emplace("storeCpuOwner");keys(row,fields);
    if(row.at("relativePath").string()==storeCpuWorkspace(expected))fail("VAULT_RECOVERY_REQUIRED");
    if(row.object().contains("storeCpuOwner")) {
      const auto& owner=row.at("storeCpuOwner");if(!storeCpuExpectationReceiving(owner))fail("VAULT_CORRUPT");
      if(owner.at("token").string()==expected.at("token").string())fail("VAULT_RECOVERY_REQUIRED");
    }
  }
  closure.scratchChecked=true;
}
Json retireStoreCpuWorkspaceMarker(const Json& args) {
  assertCacheLease(args);const auto& expected=args.at("expectation");Json state=nullptr;
  if(!readStoreCpuOperationCleanupState(expected,state))fail("PEER_DENIED");
  if(!std::get<bool>(state.at("retired").value))return Json::Object{{"state","pending"}};
  const auto relative=args.at("relative_path").string();if(relative!=storeCpuWorkspace(expected))fail("PATH_UNSAFE");
  const auto marker="storage\\workspaces\\"+repairBytesDigest(relative)+".json";
  const auto root=rootPath("personal"),path=root+L"\\"+wide(marker);
  const Json binding=Json::Object{{"relative_path",relative},{"expectation",expected}};
  const auto digest=repairBytesDigest("store-cpu-workspace:"+marker+":"+repairBytesDigest(mm::dump(binding)));
  auto found=storeCpuMarkerClosures.find(digest);
  if(found==storeCpuMarkerClosures.end()) {
    if(storeCpuMarkerClosures.size()>=256)fail("VAULT_RECOVERY_REQUIRED");
    found=storeCpuMarkerClosures.emplace(digest,StoreCpuMarkerClosure{binding,{},{},nullptr}).first;
  }
  auto& closure=found->second;if(mm::dump(closure.binding)!=mm::dump(binding))fail("PEER_DENIED");
  if(jsonNull(closure.receipt))holdStorePrivateDirectories(path.substr(0,path.find_last_of(L'\\')),root,closure.parents);
  Json result=closure.receipt;
  const auto prior=storageCleanupRecord(digest);
  if(jsonNull(result)&&!jsonNull(prior)&&(prior.at("state").string()=="completed"||
      (prior.at("state").string()=="submitted"&&!closure.file.valid()&&nativeChildMissing(closure.parents.back().value,path.substr(path.find_last_of(L'\\')+1)))))result=retireStorageCleanup("store-cpu-workspace",marker,nullptr,binding,nullptr,2048,nullptr,&closure.parents);
  else if(jsonNull(result)) {
    if(!closure.file.valid()) {
      bool absent=false,busy=false;holdStoreCpuMarkerLeaf(closure.parents.back().value,path,closure.file,absent,busy);
      if(absent||busy)return Json::Object{{"state","pending"}};
    }
    LARGE_INTEGER size{};check(GetFileSizeEx(closure.file.value,&size)&&size.QuadPart>=2&&size.QuadPart<=2048,"PATH_UNSAFE");
    LARGE_INTEGER start{};check(SetFilePointerEx(closure.file.value,start,nullptr,FILE_BEGIN),"PATH_UNSAFE");
    std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD count=0;check(ReadFile(closure.file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size(),"PATH_UNSAFE");
    const auto row=mm::JsonParser(bytes,true).parse();keys(row,{"version","relativePath","owner","purpose","createdAt"});
    if(row.at("version").integer()!=2||row.at("relativePath").string()!=relative||row.at("purpose").string()!="processing"||
        row.at("createdAt").integer()<0||row.at("createdAt").integer()>9007199254740991LL||mm::dump(row.at("owner"))!=mm::dump(expected))fail("PATH_UNSAFE");
    requireStoreCpuRetired(expected);
    result=retireStorageCleanup("store-cpu-workspace",marker,cacheHandleBirth(closure.file.value),binding,&closure.file,2048,nullptr,&closure.parents);
  }
  if(result.at("state").string()=="completed") {
    closure.receipt=result;
    if(closure.file.value){check(CloseHandle(closure.file.value),"VAULT_RECOVERY_REQUIRED");closure.file.value=nullptr;}
    for(auto& parent:closure.parents)if(parent.value){check(CloseHandle(parent.value),"VAULT_RECOVERY_REQUIRED");parent.value=nullptr;}
    requireStoreCpuRetired(expected);storeCpuMarkerClosures.erase(found);
  }
  return result;
}
Json acknowledgeStoreCpuWorkspaceMarker(const Json& args) {
  assertCacheLease(args);const auto& expected=args.at("expectation");if(!storeCpuExpectationReceiving(expected))fail("PEER_DENIED");
  const auto relative=storeCpuWorkspace(expected),marker="storage\\workspaces\\"+repairBytesDigest(relative)+".json";
  const Json binding=Json::Object{{"relative_path",relative},{"expectation",expected}};
  const auto digest=repairBytesDigest("store-cpu-workspace:"+marker+":"+repairBytesDigest(mm::dump(binding))),nonce=args.at("nonce").string();
  if(args.at("receipt_id").string()!=digest||!repairDigest(nonce)||storeCpuMarkerClosures.contains(digest))fail("PEER_DENIED");
  auto found=storeCpuMarkerAckClosures.find(digest);
  if(found==storeCpuMarkerAckClosures.end()) {
    if(storeCpuMarkerAckClosures.size()>=256)fail("VAULT_RECOVERY_REQUIRED");
    const auto original=storageCleanupRecord(digest);
    if(jsonNull(original)||original.at("kind").string()!="store-cpu-workspace"||original.at("state").string()!="completed"||
        original.at("nonce").string()!=nonce||original.at("relative_path").string()!=marker||
        original.at("authority_sha256").string()!=repairBytesDigest(mm::dump(binding)))fail("PEER_DENIED");
    auto id=randomHex().substr(0,32);id[12]='4';id[16]='8';const auto request=id.substr(0,8)+"-"+id.substr(8,4)+"-"+id.substr(12,4)+"-"+id.substr(16,4)+"-"+id.substr(20,12);
    requireStoreCpuRetired(expected);
    found=storeCpuMarkerAckClosures.emplace(digest,StoreCpuMarkerAckClosure{binding,nonce,{},{},{},false,false,request,false,randomHex(),false}).first;
  }
  auto& closure=found->second;if(closure.nonce!=nonce||mm::dump(closure.binding)!=mm::dump(binding))fail("PEER_DENIED");
  const auto reply=[&](){return Json::Object{{"acknowledged",true},{"ack_nonce",closure.ackNonce}};};
  if(closure.acknowledged)return reply();
  if(closure.forgetPending){forgetStoreCpuOperationCleanupState(expected,closure.forgetRequest);closure.acknowledged=true;return reply();}
  requireStoreCpuRetired(expected);
  const auto record=storageCleanupRecord(digest);
  if(!jsonNull(record)&&(record.at("kind").string()!="store-cpu-workspace"||record.at("state").string()!="completed"||record.at("nonce").string()!=nonce||record.at("relative_path").string()!=marker||record.at("authority_sha256").string()!=repairBytesDigest(mm::dump(binding))))fail("PEER_DENIED");
  const auto root=rootPath("personal"),path=root+L"\\"+wide(marker);
  if(!closure.observed) {
    holdStorePrivateDirectories(path.substr(0,path.find_last_of(L'\\')),root,closure.parents);
    if((!jsonNull(record)&&mm::dump(cacheAncestorBirths(closure.parents,marker))!=mm::dump(record.at("ancestor_births")))||
        !nativeChildMissing(closure.parents.back().value,path.substr(path.find_last_of(L'\\')+1)))fail("PATH_UNSAFE");
    closure.observed=true;
  }
  observeStoreCpuReservationRemoved(closure,expected);
  if(closure.scratch.value){check(CloseHandle(closure.scratch.value),"VAULT_RECOVERY_REQUIRED");closure.scratch.value=nullptr;}
  for(auto& parent:closure.scratchParents)if(parent.value){check(CloseHandle(parent.value),"VAULT_RECOVERY_REQUIRED");parent.value=nullptr;}
  for(auto& parent:closure.parents)if(parent.value){check(CloseHandle(parent.value),"VAULT_RECOVERY_REQUIRED");parent.value=nullptr;}
  requireStoreCpuRetired(expected);
  if(!jsonNull(record))(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",storageCleanupKey(digest)}});
  closure.forgetPending=true;forgetStoreCpuOperationCleanupState(expected,closure.forgetRequest);
  closure.acknowledged=true;
  return reply();
}
// This only releases bounded completion bookkeeping after the SDK received the
// original positive ACK. It never attests file, Job or reservation closure.
Json releaseStoreCpuWorkspaceMarker(const Json& args) {
  assertCacheLease(args);
  const auto& expected=args.at("expectation");if(!authorizeStoreCpuCleanupCaller(expected))fail("PEER_DENIED");
  const auto relative=storeCpuWorkspace(expected),marker="storage\\workspaces\\"+repairBytesDigest(relative)+".json";
  const Json binding=Json::Object{{"relative_path",relative},{"expectation",expected}};
  const auto digest=repairBytesDigest("store-cpu-workspace:"+marker+":"+repairBytesDigest(mm::dump(binding)));
  const auto nonce=args.at("nonce").string(),ack=args.at("ack_nonce").string();
  if(args.at("receipt_id").string()!=digest||!repairDigest(nonce)||!repairDigest(ack))fail("PEER_DENIED");
  const auto found=storeCpuMarkerAckClosures.find(digest);
  if(found==storeCpuMarkerAckClosures.end())return Json::Object{{"released",true}};
  const auto& closure=found->second;
  if(!closure.acknowledged||closure.nonce!=nonce||closure.ackNonce!=ack||mm::dump(closure.binding)!=mm::dump(binding))fail("PEER_DENIED");
  releaseStoreCpuOperationCleanupState(expected,closure.forgetRequest);
  storeCpuMarkerAckClosures.erase(found);
  return Json::Object{{"released",true}};
}
Json acknowledgeStorageCleanup(const Json& args){assertCacheLease(args);authorizeStorageCleanup();const auto digest=args.at("receipt_id").string(),nonce=args.at("nonce").string();if(!repairDigest(digest)||!repairDigest(nonce))fail("BAD_REQUEST");if(storeCpuMarkerClosures.contains(digest)||storeCpuMarkerAckClosures.contains(digest))fail("PEER_DENIED");const auto record=storageCleanupRecord(digest);if(jsonNull(record))return Json::Object{{"acknowledged",true}};if(record.at("kind").string()=="store-cpu-workspace")fail("PEER_DENIED");if(record.at("state").string()!="completed"||record.at("nonce").string()!=nonce)fail("PEER_DENIED");const auto relative=record.at("relative_path").string();const auto root=rootPath("personal"),path=root+L"\\"+wide(relative);auto parents=lockAncestors(path,false,false,root,true);if(mm::dump(cacheAncestorBirths(parents,relative))!=mm::dump(record.at("ancestor_births"))||!cleanupAbsent(path))fail("PATH_UNSAFE");(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",storageCleanupKey(digest)}});return Json::Object{{"acknowledged",true}};}
Json discardLibraryArtifact(const Json& args){
  assertCacheLease(args);authorizeStorageCleanup();const auto id=shareRequestId(args),relative=args.at("relative_path").string();
  const auto journal=cleanupJournal();Json selected=nullptr;for(const auto& row:journal.at("writes").array())if(row.at("id").string()==id){if(!jsonNull(selected))fail("VAULT_CORRUPT");selected=row;}
  if(jsonNull(selected)||selected.at("kind").string()!="file"||!selected.object().contains("birth"))fail("VAULT_RECOVERY_REQUIRED");
  const auto owner=cleanupOwner(selected.at("owner"));if(mm::dump(owner)!=mm::dump(parentBinding(processIdentity(GetCurrentProcessId())).parent)){const auto actual=processIdentity(static_cast<DWORD>(owner.at("pid").integer()),true);if(mm::dump(actual)==mm::dump(owner)&&!std::get<bool>(selected.at("settled").value))fail("PEER_DENIED");}
  const std::string prefix="library\\\\media\\\\[a-f0-9]{64}\\\\[a-f0-9]{24}\\\\(voice|original)\\\\[a-f0-9]{64}\\\\";
  if(!std::regex_match(relative,std::regex(prefix+"(media\\.(mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac)(\\.[a-f0-9-]{36}\\.part)?|media\\.json(\\.[a-f0-9-]{36}\\.tmp)?)")))fail("PATH_UNSAFE");
  Json birth=nullptr;if(relative==selected.at("relativePath").string())birth=cleanupBirth(selected.at("birth"));
  else if(selected.object().contains("publication")){const auto& pub=selected.at("publication");if(relative==pub.at("relativePath").string())birth=cleanupBirth(selected.at("birth"));else if((relative==pub.at("metadataPath").string()||relative==pub.at("temporaryMetadata").string())&&pub.object().contains("temporaryMetadataBirth"))birth=cleanupBirth(pub.at("temporaryMetadataBirth"));}
  if(jsonNull(birth))fail("PATH_UNSAFE");keys(args.at("expected"),{"device","file_id","born_at","bytes","written_at","changed_at"});
  return retireStorageCleanup("artifact",relative,birth,Json::Object{{"write",selected},{"expected",args.at("expected")}},nullptr,256LL*1024*1024,args.at("expected"));
}
