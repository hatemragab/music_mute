#pragma once

// Two closed personal byte-retirement authorities. This is deliberately separate
// from cache eviction and dialog exports. The durable source record authorizes
// only its exact staged Share copy or explicitly deleting diagnostic report.
Json cleanupBirth(const Json& value) {
  keys(value,{"device","fileId","bornAt"});
  for(const auto* key:{"device","fileId","bornAt"}) {
    const auto text=value.at(key).string();
    if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");
  }
  if(value.at("fileId").string()=="0")fail("VAULT_CORRUPT");
  return Json::Object{{"device",value.at("device")},{"file_id",value.at("fileId")},{"born_at",value.at("bornAt")}};
}
Json cleanupFingerprint(const Json& value) {
  keys(value,{"device","fileId","bornAt","bytes","writtenAt","changedAt"});
  auto birth=cleanupBirth(Json::Object{{"device",value.at("device")},{"fileId",value.at("fileId")},{"bornAt",value.at("bornAt")}}).object();
  const auto bytes=value.at("bytes").integer();
  if(bytes<0||bytes>256LL*1024*1024)fail("VAULT_CORRUPT");
  for(const auto* key:{"writtenAt","changedAt"}){
    const auto text=value.at(key).string();if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");
  }
  birth.emplace("bytes",bytes);birth.emplace("written_at",value.at("writtenAt"));birth.emplace("changed_at",value.at("changedAt"));return birth;
}
Json cleanupOwner(const Json& value) {
  keys(value,{"sid","sessionId","pid","creationTime"});
  if(value.at("sid").string()!=currentIdentity().sid||value.at("sessionId").integer()<1||value.at("pid").integer()<1||value.at("pid").integer()>2147483647)fail("PEER_DENIED");
  const auto birth=value.at("creationTime").string();if(birth.empty()||birth.size()>20||birth.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");
  return Json::Object{{"sid",value.at("sid")},{"session_id",value.at("sessionId")},{"pid",value.at("pid")},{"creation_time",value.at("creationTime")}};
}
Json cleanupJournal() {
  const auto root=rootPath("personal"),journalPath=root+L"\\storage\\writes.json";
  auto parents=lockAncestors(journalPath,false,false,root,true);
  auto opened=openNativeChild(parents.back().value,L"writes.json",GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);auto file=std::move(opened.handle);
  if(!file.valid()){if(static_cast<ULONG>(opened.status)==nativeNameMissing)return Json::Object{{"version",1},{"writes",Json::Array{}}};fail("PATH_UNSAFE");}
  BY_HANDLE_FILE_INFORMATION info{};LARGE_INTEGER length{};check(GetFileInformationByHandle(file.value,&info)&&GetFileSizeEx(file.value,&length),"PATH_UNSAFE");
  if(info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)||info.nNumberOfLinks!=1||length.QuadPart<1||length.QuadPart>256*1024)fail("PATH_UNSAFE");assertPrivateHandle(file.value);
  std::string bytes(static_cast<std::size_t>(length.QuadPart),'\0');DWORD count=0;check(ReadFile(file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr)&&count==bytes.size(),"PATH_UNSAFE");
  const auto journal=mm::JsonParser::storageJournal(bytes);keys(journal,{"version","writes"});
  if(journal.at("version").integer()!=1||journal.at("writes").array().size()>256)fail("VAULT_CORRUPT");
  std::set<std::string> ids,paths;const std::set<std::string> allowed{"id","relativePath","kind","owner","settled","createdAt","publication","birth","copyBytes","share","input"};
  for(const auto& row:journal.at("writes").array()){
    for(const auto& [name,value]:row.object()){(void)value;if(!allowed.contains(name))fail("VAULT_CORRUPT");}
    const auto id=row.at("id").string(),path=row.at("relativePath").string(),kind=row.at("kind").string();
    if(!std::regex_match(id,std::regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"))||!ids.insert(id).second||!paths.insert(path).second||(kind!="file"&&kind!="tree")||row.at("createdAt").integer()<0)fail("VAULT_CORRUPT");
    (void)relativePath(path);(void)cleanupOwner(row.at("owner"));(void)std::get<bool>(row.at("settled").value);
    if(row.object().contains("birth"))(void)cleanupBirth(row.at("birth"));
    if(row.object().contains("copyBytes")&&(row.at("copyBytes").integer()<0||row.at("copyBytes").integer()>256LL*1024*1024))fail("VAULT_CORRUPT");
  }return journal;
}
Json cleanupShareAuthority(const Json& args) {
  const auto id=shareRequestId(args),relative="share\\requests\\"+id;
  const auto journal=cleanupJournal();Json selected=nullptr;
  for(const auto& row:journal.at("writes").array())if(row.at("relativePath").string()==relative){if(!jsonNull(selected))fail("VAULT_CORRUPT");selected=row;}
  if(jsonNull(selected))fail("VAULT_RECOVERY_REQUIRED");
  if(selected.at("kind").string()!="tree"||mm::dump(cleanupBirth(selected.at("birth")))!=mm::dump(args.at("birth")))fail("PATH_UNSAFE");
  const auto& share=selected.at("share");const auto owner=cleanupOwner(selected.at("owner"));
  const auto received=loadShareReceipt(id);const bool pending=std::get<bool>(share.at("nativePending").value);
  const auto fileRow=share.object().find("file");
  if(fileRow!=share.object().end()) {
    const auto& file=fileRow->second;const auto born=file.object().find("bornAt");
    keys(file,born==file.object().end()?std::set<std::string>{"relativePath","sha256","fingerprint"}:std::set<std::string>{"relativePath","sha256","fingerprint","bornAt"});
    auto fingerprint=file.at("fingerprint").object();
    if(born!=file.object().end())fingerprint.emplace("bornAt",born->second);
    else if(pending&&!jsonNull(received)){
      LONGLONG creation=0;try{creation=std::stoll(received.at("file_identity").at("creation_time").string());}catch(...){fail("VAULT_CORRUPT");}
      fingerprint.emplace("bornAt",nodeFileTime(creation));
    } else fail("VAULT_RECOVERY_REQUIRED");
    const Json expected=Json::Object{{"relative_path",file.at("relativePath")},{"sha256",file.at("sha256")},{"expected",cleanupFingerprint(fingerprint)}};
    if(mm::dump(expected)!=mm::dump(args.at("file")))fail("PATH_UNSAFE");
  } else if(!jsonNull(args.at("file"))&&mm::dump(owner)!=mm::dump(parentBinding(processIdentity(GetCurrentProcessId())).parent)) {
    // An unsealed copy has no durable leaf birth. Only its actual live copier
    // may supply its held-FD fingerprint; a replacement app must retain it.
    fail("VAULT_RECOVERY_REQUIRED");
  }
  if(pending) {
    const auto quiesced=share.object().find("quiesced");
    if(jsonNull(received)||quiesced==share.object().end()||!std::get<bool>(quiesced->second.value)||!std::get<bool>(received.at("quiesced").value)||
       (received.at("state").string()!="completed"&&received.at("state").string()!="cancelled")||fileRow==share.object().end()||
       mm::dump(owner)!=mm::dump(received.at("window_owner"))||mm::dump(cleanupOwner(share.at("helper")))!=mm::dump(received.at("helper"))||
       share.at("receipt").at("nonce").string()!=received.at("nonce").string()||
       received.at("relative_path").string()!=args.at("file").at("relative_path").string()||received.at("sha256").string()!=args.at("file").at("sha256").string()||
       received.at("bytes").integer()!=args.at("file").at("expected").at("bytes").integer())fail("VAULT_RECOVERY_REQUIRED");
    const auto& identity=received.at("file_identity");const auto& expected=args.at("file").at("expected");
    if(expected.at("device").string()!=std::to_string(identity.at("volume_serial").integer())||expected.at("file_id").string()!=identity.at("file_index").string())fail("PATH_UNSAFE");
  } else {
    if(!jsonNull(received))fail("VAULT_RECOVERY_REQUIRED");
    const auto actual=processIdentity(static_cast<DWORD>(owner.at("pid").integer()),true);
    if(mm::dump(actual)==mm::dump(owner)&&mm::dump(owner)!=mm::dump(parentBinding(processIdentity(GetCurrentProcessId())).parent))fail("PEER_DENIED");
  }
  return selected;
}
Json cleanupReportRegistry() {
  const auto text=repairProtectedBytes("chrome_diagnostic_reports");
  if(text.empty())return Json::Object{{"version",1},{"sid",currentIdentity().sid},{"reports",Json::Array{}},{"retired",Json::Array{}}};
  const auto registry=mm::JsonParser(text).parse();keys(registry,{"version","sid","reports","retired"});
  if(registry.at("version").integer()!=1||registry.at("sid").string()!=currentIdentity().sid||registry.at("reports").array().size()>4||registry.at("retired").array().size()>64)fail("VAULT_CORRUPT");return registry;
}
std::string cleanupKey(const std::string& kind,const std::string& id){auto compact=id;compact.erase(std::remove(compact.begin(),compact.end(),'-'),compact.end());return "personal_cleanup_"+kind+"_"+compact;}
Json readPersonalCleanup(const std::string& kind,const std::string& id) {
  const auto text=repairProtectedBytes(cleanupKey(kind,id));if(text.empty())return nullptr;
  const auto row=mm::JsonParser(text).parse();keys(row,{"version","kind","id","relative_path","birth","file","authority_sha256","ancestor_births","state"});
  if(row.at("version").integer()!=1||row.at("kind").string()!=kind||row.at("id").string()!=id||!repairDigest(row.at("authority_sha256").string()))fail("VAULT_CORRUPT");
  const auto state=row.at("state").string();if(state!="intent"&&state!="file-submitted"&&state!="file-gone"&&state!="directory-submitted"&&state!="completed")fail("VAULT_CORRUPT");return row;
}
void writePersonalCleanup(Json& row,const std::string& state){auto next=row.object();next["state"]=state;row=next;repairProtectedWrite(cleanupKey(row.at("kind").string(),row.at("id").string()),row);}
bool cleanupAbsent(const std::wstring& path){return nativePathMissing(path);}
bool submitPersonalDisposition(Handle& handle,Json& record,const std::string& state,const std::wstring& path,HANDLE parent) {
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;
  if(!SetFileInformationByHandle(handle.value,FileDispositionInfo,&disposition,sizeof(disposition))){const auto error=GetLastError();if(error==ERROR_ACCESS_DENIED||error==ERROR_SHARING_VIOLATION||error==ERROR_DIR_NOT_EMPTY||error==ERROR_LOCK_VIOLATION)return false;fail("PATH_UNSAFE");}
  writePersonalCleanup(record,state);const auto retiring=std::exchange(handle.value,nullptr);check(CloseHandle(retiring),"VAULT_RECOVERY_REQUIRED");return nativeChildMissing(parent,path.substr(path.find_last_of(L'\\')+1));
}
void assertShareCleanupNames(HANDLE directory,const Json& file) {
  unsigned count=0;
  for(const auto& entry:enumerateNativeDirectory(directory,2)){
    const auto& name=entry.name;
    if(++count>1||jsonNull(file)||entry.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||
       name!=wide(file.at("relative_path").string().substr(file.at("relative_path").string().find_last_of('\\')+1)))fail("PATH_UNSAFE");
  }
}
bool personalCleanupSourcePresent(const Json& record) {
  const auto kind=record.at("kind").string(),id=record.at("id").string();
  if(kind=="share"){const auto journal=cleanupJournal();for(const auto& row:journal.at("writes").array())if(row.at("relativePath").string()=="share\\requests\\"+id)return true;}
  else if(kind=="report"){const auto registry=cleanupReportRegistry();for(const auto& row:registry.at("reports").array())if(row.at("receipt").string()==id)return true;}
  else fail("VAULT_CORRUPT");return false;
}
bool retireCompletedPersonalCleanup(const Json& record) {
  if(record.at("state").string()!="completed"||personalCleanupSourcePresent(record))return false;
  const auto relative=record.at("relative_path").string();const auto kind=record.at("kind").string(),id=record.at("id").string();
  if(relative!=(kind=="share"?"share\\requests\\"+id:"diagnostics\\reports\\"+id+".json"))fail("VAULT_CORRUPT");
  const auto root=rootPath("personal"),path=root+L"\\"+wide(relative);auto parents=lockAncestors(path,false,false,root,true);
  if(mm::dump(cacheAncestorBirths(parents,relative))!=mm::dump(record.at("ancestor_births"))||!cleanupAbsent(path))fail("PATH_UNSAFE");
  (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",cleanupKey(kind,id)}});return true;
}
Json collectPersonalCleanupRecords() {
  const auto directory=rootPath("personal")+L"\\vault\\account";auto parents=lockAncestors(directory,true,true,rootPath("personal"));
  unsigned removed=0,retained=0,scanned=0;
  const std::regex namePattern("personal_cleanup_(share|report)_([a-f0-9]{32})\\.dpapi");
  for(const auto& entry:enumerateNativeDirectory(parents.back().value)){
    if(!PathMatchSpecW(entry.name.c_str(),L"personal_cleanup_*.dpapi"))continue;
    if(++scanned>20)fail("VAULT_RECOVERY_REQUIRED");std::smatch match;const auto name=utf8(entry.name);
    if(entry.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||!std::regex_match(name,match,namePattern))fail("PATH_UNSAFE");
    const auto compact=match[2].str(),id=compact.substr(0,8)+"-"+compact.substr(8,4)+"-"+compact.substr(12,4)+"-"+compact.substr(16,4)+"-"+compact.substr(20,12);
    const auto record=readPersonalCleanup(match[1].str(),id);if(jsonNull(record))fail("VAULT_CORRUPT");
    if(retireCompletedPersonalCleanup(record))++removed;else ++retained;
  }
  return Json::Object{{"removed",static_cast<int>(removed)},{"retained",static_cast<int>(retained)}};
}
Json recoverPersonalCleanups(const Json& args) {
  assertCacheLease(args);authorizePersonalDataCaller();return collectPersonalCleanupRecords();
}
Json retirePersonalBytes(const std::string& kind,const std::string& id,const std::string& relative,const Json& birth,const Json& file,const Json& authority) {
  auto record=readPersonalCleanup(kind,id);const auto root=rootPath("personal"),path=root+L"\\"+wide(relative);
  auto parents=lockAncestors(path,false,false,root,true);
  const auto parentBirths=cacheAncestorBirths(parents,relative);
  if(!jsonNull(record)) {
    if(record.at("relative_path").string()!=relative||mm::dump(record.at("birth"))!=mm::dump(birth)||mm::dump(record.at("file"))!=mm::dump(file)||mm::dump(record.at("ancestor_births"))!=mm::dump(parentBirths))fail("PATH_UNSAFE");
    if(record.at("state").string()=="completed"){
      if(!cleanupAbsent(path))fail("PATH_UNSAFE");return Json::Object{{"state","completed"}};
    }
    if(record.at("authority_sha256").string()!=repairBytesDigest(mm::dump(authority)))fail("VAULT_RECOVERY_REQUIRED");
  }
  const bool directory=kind=="share";bool absent=false,busy=false;auto target=openCacheDeleteEntry(path,directory,absent,busy,!directory,false,true,parents.back().value);
  if(busy)return Json::Object{{"state","pending"}};
  if(absent){if(jsonNull(record)||(record.at("state").string()!=(directory?"directory-submitted":"file-submitted")))return Json::Object{{"state","pending"}};
    writePersonalCleanup(record,"completed");return Json::Object{{"state","completed"}};}
  if(mm::dump(cacheHandleIdentity(target.value,directory))!=mm::dump(birth))fail("PATH_UNSAFE");
  if(directory)assertShareCleanupNames(target.value,file);
  else if(hashFile(target.value)!=file.at("sha256").string())fail("PATH_UNSAFE");
  if(jsonNull(record)){
    const auto recovered=collectPersonalCleanupRecords();
    if(recovered.at("retained").integer()>=20)fail("VAULT_RECOVERY_REQUIRED");
    record=Json::Object{{"version",1},{"kind",kind},{"id",id},{"relative_path",relative},{"birth",birth},{"file",file},{"authority_sha256",repairBytesDigest(mm::dump(authority))},{"ancestor_births",parentBirths},{"state","intent"}};repairProtectedWrite(cleanupKey(kind,id),record);
  }
  if(directory&&record.at("state").string()!="file-gone"&&record.at("state").string()!="directory-submitted") {
    if(!jsonNull(file)) {
      const auto leaf=root+L"\\"+wide(file.at("relative_path").string());bool leafAbsent=false,leafBusy=false;auto opened=openCacheDeleteEntry(leaf,false,leafAbsent,leafBusy,true,false,true,target.value);
      if(leafBusy)return Json::Object{{"state","pending"}};
      if(leafAbsent){if(record.at("state").string()!="file-submitted")return Json::Object{{"state","pending"}};}
      else {
        if(mm::dump(cacheHandleIdentity(opened.value,false))!=mm::dump(file.at("expected"))||hashFile(opened.value)!=file.at("sha256").string())fail("PATH_UNSAFE");
        if(!submitPersonalDisposition(opened,record,"file-submitted",leaf,target.value))return Json::Object{{"state","pending"}};
      }
    }
    writePersonalCleanup(record,"file-gone");
  }
  if(!submitPersonalDisposition(target,record,directory?"directory-submitted":"file-submitted",path,parents.back().value))return Json::Object{{"state","pending"}};
  writePersonalCleanup(record,"completed");return Json::Object{{"state","completed"}};
}
Json discardShareWorkspace(const Json& args) {
  assertCacheLease(args);authorizePersonalDataCaller();const auto id=shareRequestId(args);
  keys(args.at("birth"),{"device","file_id","born_at"});const auto file=args.at("file");
  if(!jsonNull(file)){keys(file,{"relative_path","expected","sha256"});const auto relative=file.at("relative_path").string(),prefix="share\\requests\\"+id+"\\media.";
    const std::set<std::string> extensions{"mp3","m4a","webm","ogg","aac","wav","flac"};
    if(!relative.starts_with(prefix)||!extensions.contains(relative.substr(prefix.size()))||!repairDigest(file.at("sha256").string()))fail("BAD_REQUEST");keys(file.at("expected"),{"device","file_id","born_at","bytes","written_at","changed_at"});}
  const auto authority=cleanupShareAuthority(args);return retirePersonalBytes("share",id,"share\\requests\\"+id,args.at("birth"),file,authority);
}
Json removeChromeDiagnosticReport(const Json& args) {
  assertCacheLease(args);authorizePersonalDataCaller();const auto id=shareRequestId(args);const auto registry=cleanupReportRegistry();Json selected=nullptr;
  for(const auto& row:registry.at("reports").array())if(row.at("receipt").string()==id){if(!jsonNull(selected))fail("VAULT_CORRUPT");selected=row;}
  if(jsonNull(selected)||selected.at("state").string()!="deleting")fail("VAULT_RECOVERY_REQUIRED");keys(selected,{"requestId","receipt","temporary","state","proof"});
  const auto& proof=selected.at("proof");keys(proof,{"device","fileId","bornAt","bytes","writtenAt","changedAt","sha256"});
  if(!repairDigest(proof.at("sha256").string())||proof.at("bytes").integer()<2||proof.at("bytes").integer()>512*1024)fail("VAULT_CORRUPT");
  auto fingerprint=proof.object();fingerprint.erase("sha256");const auto expected=cleanupFingerprint(fingerprint);const auto relative="diagnostics\\reports\\"+id+".json";
  return retirePersonalBytes("report",id,relative,expected,Json::Object{{"sha256",proof.at("sha256")}},selected);
}
