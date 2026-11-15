#pragma once

// The sole signed Main authorizes an exclusively created dialog destination.
// Chrome/worker helpers and renderer path strings cannot invoke this authority.
struct ExportDiscardLock {
  Handle handle;
  ExportDiscardLock(){const auto sid=wide(currentIdentity().sid);Security acl(L"O:"+sid+L"D:P(A;;0x001f0001;;;"+sid+L")(A;;0x001f0001;;;SY)");handle=Handle(CreateMutexW(&acl.attributes,FALSE,(L"Global\\MusicMuteCreatedExport-v1-"+privateKernelSid()).c_str()));if(!handle.valid())fail("IDENTITY_UNAVAILABLE");assertPrivateMutex(handle.value);const auto waited=WaitForSingleObject(handle.value,0);if(waited==WAIT_TIMEOUT)fail("JOB_BUSY");if(waited!=WAIT_OBJECT_0&&waited!=WAIT_ABANDONED)fail("IDENTITY_UNAVAILABLE");}
  ~ExportDiscardLock(){if(handle.valid())ReleaseMutex(handle.value);}
};
bool exportRequestId(const std::string& id){return std::regex_match(id,std::regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"));}
std::string exportDiscardKey(const std::string& id){if(!exportRequestId(id))fail("BAD_REQUEST");auto compact=id;compact.erase(std::remove(compact.begin(),compact.end(),'-'),compact.end());return "export_discard_"+compact;}
void authorizeExportMain(const Json& args){
  (void)verifyAccountPeer(Json::Object{{"identity",processIdentity(GetCurrentProcessId())},{"role","authority"},{"app_sha256",args.at("app_sha256")},{"app_bytes",args.at("app_bytes")},{"publisher_sha256",args.at("publisher_sha256")}});
}
std::wstring exportDiscardPath(const std::string& text){
  if(text.size()<4||text.size()>4096||!((text[0]>='A'&&text[0]<='Z')||(text[0]>='a'&&text[0]<='z'))||text[1]!=':'||text[2]!='\\')fail("PATH_UNSAFE");
  (void)relativePath(text.substr(3));const auto path=wide(text),drive=path.substr(0,3);const auto type=GetDriveTypeW(drive.c_str());if(type!=DRIVE_FIXED&&type!=DRIVE_REMOVABLE)fail("PATH_UNSAFE");return path;
}
std::vector<Handle> lockExportParents(const std::wstring& path){
  std::vector<Handle> handles;const auto last=path.find_last_of(L'\\');
  handles.emplace_back(openEntry(path.substr(0,3),true,false,false,true));
  for(auto end=path.find(L'\\',3);end!=std::wstring::npos&&end<=last;end=path.find(L'\\',end+1)){handles.emplace_back(openEntry(path.substr(0,end),true,false,false,true));}
  if(handles.empty()||handles.size()>64)fail("PATH_UNSAFE");return handles;
}
Json exportParentBirths(const std::vector<Handle>& handles){
  Json::Array result;for(const auto& handle:handles){BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(handle.value,&info),"PATH_UNSAFE");
    result.emplace_back(Json::Object{{"volume",std::to_string(info.dwVolumeSerialNumber)},{"file_id",std::to_string((static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},{"creation_time",std::to_string((static_cast<ULONGLONG>(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime)}});
  }return result;
}
Json validateExportDestination(const Json& args){
  authorizeExportMain(args);const auto path=exportDiscardPath(args.at("path").string());auto parents=lockExportParents(path);
  // The Node caller still uses exclusive creation and records the real FD birth.
  // This preflight never grants deletion or infers ownership from a pathname.
  if(!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)))fail("PATH_UNSAFE");
  return Json::Object{{"validated",true}};
}
void assertExportFileOwner(HANDLE file){
  PSID owner=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;if(GetSecurityInfo(file,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,nullptr,nullptr,nullptr,&descriptor)!=ERROR_SUCCESS)fail("ACL_UNSAFE");LocalMemory memory{descriptor};if(!owner||sidString(owner)!=currentIdentity().sid)fail("PEER_DENIED");
  // Export is an explicit user destination and may have inherited public-reader
  // ACLs. Its owner, creation proof and signed Main are mandatory; private-cache
  // DACL assumptions cannot be imposed on Downloads/removable local folders.
}
Json readExportDiscard(const std::string& id){
  const auto text=repairProtectedBytes(exportDiscardKey(id));if(text.empty())return nullptr;const auto record=mm::JsonParser(text).parse();
  keys(record,{"version","request_id","nonce","path","creator","expected","ancestor_births","state"});
  if(record.at("version").integer()!=1||record.at("request_id").string()!=id||!exportRequestId(id)||!repairDigest(record.at("nonce").string())||record.at("creator").at("sid").string()!=currentIdentity().sid||(record.at("state").string()!="intent"&&record.at("state").string()!="submitted"&&record.at("state").string()!="completed"))fail("VAULT_CORRUPT");
  (void)exportDiscardPath(record.at("path").string());keys(record.at("creator"),{"sid","session_id","pid","creation_time"});keys(record.at("expected"),{"device","file_id","born_at","bytes","written_at","changed_at"});
  const auto& ancestors=record.at("ancestor_births").array();if(ancestors.empty()||ancestors.size()>64)fail("VAULT_CORRUPT");for(const auto& item:ancestors)keys(item,{"volume","file_id","creation_time"});return record;
}
void writeExportDiscard(const Json& record){repairProtectedWrite(exportDiscardKey(record.at("request_id").string()),record);}
Json exportDiscardResult(const Json& record){if(record.at("state").string()!="completed")return Json::Object{{"state","pending"}};return Json::Object{{"state","completed"},{"request_id",record.at("request_id")},{"nonce",record.at("nonce")}};}
void pruneCompletedExportDiscards(){
  const auto directory=rootPath("personal")+L"\\vault\\account";auto parents=lockAncestors(directory,true,true,rootPath("personal"));unsigned count=0;
  for(const auto& row:enumerateNativeDirectory(parents.back().value)){
    if(!PathMatchSpecW(row.name.c_str(),L"export_discard_*.dpapi"))continue;
    if(++count>16)fail("VAULT_RECOVERY_REQUIRED");const auto name=utf8(row.name);if(!std::regex_match(name,std::regex("export_discard_[a-f0-9]{32}\\.dpapi"))||row.attributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))fail("PATH_UNSAFE");auto compact=name.substr(15,32);const auto id=compact.substr(0,8)+"-"+compact.substr(8,4)+"-"+compact.substr(12,4)+"-"+compact.substr(16,4)+"-"+compact.substr(20,12);const auto record=readExportDiscard(id);
    if(record.at("state").string()=="completed"){const auto& creator=record.at("creator");const auto actual=processIdentity(static_cast<DWORD>(creator.at("pid").integer()),true);if(mm::dump(actual)!=mm::dump(creator)){(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",exportDiscardKey(id)}});--count;}}
  }if(count>=16)fail("VAULT_RECOVERY_REQUIRED");
}
Json discardCreatedExport(const Json& args){
  authorizeExportMain(args);const auto id=args.at("request_id").string();(void)exportDiscardKey(id);keys(args.at("expected"),{"device","file_id","born_at","bytes","written_at","changed_at"});keys(args.at("creator"),{"sid","session_id","pid","creation_time"});
  if(mm::dump(args.at("creator"))!=mm::dump(singletonParentIdentity()))fail("PEER_DENIED");
  ExportDiscardLock lock;auto record=readExportDiscard(id);
  if(!std::holds_alternative<std::nullptr_t>(record.value)){for(const auto* key:{"path","creator","expected"})if(mm::dump(record.at(key))!=mm::dump(args.at(key)))fail("PEER_DENIED");if(record.at("state").string()=="completed")return exportDiscardResult(record);}
  const auto path=exportDiscardPath(args.at("path").string());auto parents=lockExportParents(path);
  if(!std::holds_alternative<std::nullptr_t>(record.value)&&mm::dump(record.at("ancestor_births"))!=mm::dump(exportParentBirths(parents)))fail("PATH_UNSAFE");
  bool absent=false,busy=false;auto file=openCacheDeleteEntry(path,false,absent,busy,false,false,false,parents.back().value);if(busy)return Json::Object{{"state","pending"}};
  if(absent){
    if(std::holds_alternative<std::nullptr_t>(record.value)||record.at("state").string()!="submitted")return Json::Object{{"state","pending"}};
    auto completed=record.object();completed["state"]="completed";writeExportDiscard(completed);return exportDiscardResult(completed);
  }
  assertExportFileOwner(file.value);if(mm::dump(cacheHandleIdentity(file.value,false))!=mm::dump(args.at("expected")))fail("PATH_UNSAFE");
  if(std::holds_alternative<std::nullptr_t>(record.value)){
    pruneCompletedExportDiscards();record=Json::Object{{"version",1},{"request_id",id},{"nonce",randomHex()},{"path",args.at("path")},{"creator",args.at("creator")},{"expected",args.at("expected")},{"ancestor_births",exportParentBirths(parents)},{"state","intent"}};writeExportDiscard(record);
  }
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;
  if(!SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition))){const auto error=GetLastError();if(error==ERROR_ACCESS_DENIED||error==ERROR_SHARING_VIOLATION||error==ERROR_LOCK_VIOLATION)return Json::Object{{"state","pending"}};fail("PATH_UNSAFE");}
  auto submitted=record.object();submitted["state"]="submitted";writeExportDiscard(submitted);record=submitted;
  const auto closing=std::exchange(file.value,nullptr);check(CloseHandle(closing),"VAULT_RECOVERY_REQUIRED");
  if(!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)))return Json::Object{{"state","pending"}};
  auto completed=record.object();completed["state"]="completed";writeExportDiscard(completed);return exportDiscardResult(completed);
}
Json inspectCreatedExportDiscard(const Json& args){authorizeExportMain(args);ExportDiscardLock lock;const auto record=readExportDiscard(args.at("request_id").string());return std::holds_alternative<std::nullptr_t>(record.value)?Json(Json::Object{{"state","absent"}}):exportDiscardResult(record);}
Json acknowledgeCreatedExportDiscard(const Json& args){
  authorizeExportMain(args);const auto id=args.at("request_id").string(),nonce=args.at("nonce").string();if(!repairDigest(nonce))fail("BAD_REQUEST");ExportDiscardLock lock;const auto record=readExportDiscard(id);
  if(!std::holds_alternative<std::nullptr_t>(record.value)){
    if(record.at("state").string()!="completed"||!equalSecret(record.at("nonce").string(),nonce))fail("PEER_DENIED");(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",exportDiscardKey(id)}});
  }
  // Idempotent metadata retirement after the caller's previously verified
  // completion. This branch never produces a file-deletion completion receipt.
  return Json::Object{{"acknowledged",true}};
}
