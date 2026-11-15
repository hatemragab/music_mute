#pragma once

// Closed, current-SID cache eviction authority. Every mutation uses the same
// locked object whose identity was inventoried; no path-based DeleteFile/RmTree.
// The DPAPI intent is durable before FILE_DISPOSITION_INFO is submitted.
struct CacheCandidate {
  std::vector<Handle> ancestors;
  Handle entry;
  Json record;
  unsigned slot = 0;
  bool durable = false;
};
std::map<std::string, CacheCandidate> cacheCandidates;
std::string cacheKey(unsigned slot) { return "cache_delete_" + std::to_string(slot); }
bool cachePathAllowed(const std::string& text) {
  (void)relativePath(text, false);
  if(std::count(text.begin(),text.end(),'\\')>31)fail("BAD_REQUEST");
  const std::string id="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}",hash="[a-f0-9]{64}";
  const std::regex tree("^(library\\\\media\\\\"+hash+"\\\\[a-f0-9]{24}\\\\(voice|original)\\\\"+hash+"|(personal\\\\(jobs|inputs|engine-session)|cloud\\\\work|prepare\\\\(work|downloads))\\\\"+id+"|personal\\\\results\\\\"+id+"\\.pending)(\\\\[^\\\\]+)*$");
  const std::regex leaf("^(personal\\\\results\\\\"+id+"\\\\(vocals\\.mp3|original\\.(mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac))|library\\\\thumbnails\\\\"+hash+"\\.image)$");
  return std::regex_match(text,tree)||std::regex_match(text,leaf);
}
std::string nodeFileTime(LONGLONG value) {
  // Exact Node v24.18 libuv FILETIME -> Unix nanoseconds mapping, not a clock guess.
  constexpr LONGLONG offset=116444736000000000LL;
  if(value<offset||value-offset>92233720368547758LL)fail("PATH_UNSAFE");
  return std::to_string((value-offset)*100);
}
Json cacheHandleBirth(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info{};FILE_BASIC_INFO basic{};
  check(GetFileInformationByHandle(file,&info),"PATH_UNSAFE");
  check(GetFileInformationByHandleEx(file,FileBasicInfo,&basic,sizeof(basic)),"PATH_UNSAFE");
  return Json::Object{{"device",std::to_string(info.dwVolumeSerialNumber)},{"file_id",std::to_string((static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},{"born_at",nodeFileTime(basic.CreationTime.QuadPart)}};
}
Json cacheHandleIdentity(HANDLE file,bool directory) {
  auto result=cacheHandleBirth(file).object();
  if(!directory){FILE_BASIC_INFO basic{};LARGE_INTEGER size{};check(GetFileInformationByHandleEx(file,FileBasicInfo,&basic,sizeof(basic)),"PATH_UNSAFE");check(GetFileSizeEx(file,&size),"PATH_UNSAFE");if(size.QuadPart<0||size.QuadPart>9007199254740991LL)fail("PATH_UNSAFE");result.emplace("bytes",size.QuadPart);result.emplace("written_at",nodeFileTime(basic.LastWriteTime.QuadPart));result.emplace("changed_at",nodeFileTime(basic.ChangeTime.QuadPart));}
  return result;
}
Handle openCacheDeleteEntry(const std::wstring& path,bool directory,bool& absent,bool& busy,bool readData=false,bool allowAbsentAncestor=false,bool privateAcl=true,HANDLE parent=nullptr) {
  absent=false;busy=false;
  const auto access=DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|(directory?FILE_LIST_DIRECTORY:0)|(readData?GENERIC_READ:0);
  auto opened=parent?openNativeChild(parent,path.substr(path.find_last_of(L'\\')+1),access,FILE_SHARE_READ,directory?NativeChildKind::directory:NativeChildKind::file,NativeChildDisposition::open):openNativePath(path,access,FILE_SHARE_READ,directory?NativeChildKind::directory:NativeChildKind::file,NativeChildDisposition::open,nullptr,false,allowAbsentAncestor);
  auto result=std::move(opened.handle);
  if(!result.valid()){
    const auto error=GetLastError();
    const auto status=static_cast<ULONG>(opened.status);
    if(status==nativeNameMissing||(allowAbsentAncestor&&status==0xc000003aUL)){absent=true;return result;}
    if(error==ERROR_SHARING_VIOLATION||error==ERROR_LOCK_VIOLATION||error==ERROR_ACCESS_DENIED){busy=true;return result;}
    fail("PATH_UNSAFE");
  }
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(result.value,&info),"PATH_UNSAFE");
  if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||static_cast<bool>(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory||(!directory&&info.nNumberOfLinks!=1))fail("PATH_UNSAFE");
  if(privateAcl)assertPrivateHandle(result.value);
  std::vector<wchar_t> finalPath(32768);const auto count=GetFinalPathNameByHandleW(result.value,finalPath.data(),static_cast<DWORD>(finalPath.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(!count||count>=finalPath.size())fail("PATH_UNSAFE");std::wstring canonical(finalPath.data(),count);if(canonical.rfind(L"\\\\?\\",0)==0)canonical.erase(0,4);if(_wcsicmp(path.c_str(),canonical.c_str())!=0)fail("PATH_UNSAFE");
  return result;
}
Json readCacheRecord(unsigned slot) {
  const auto sealed=vault("vault_get",Json::Object{{"namespace","account"},{"key",cacheKey(slot)}});
  if(std::holds_alternative<std::nullptr_t>(sealed.value))return nullptr;
  auto bytes=base64Decode(sealed.at("bytes_base64").string(),16384);
  const auto record=mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size())).parse();SecureZeroMemory(bytes.data(),bytes.size());
  keys(record,{"version","request_id","nonce","relative_path","kind","expected","ancestor_births","cache_nonce","helper","state"});
  if(record.at("version").integer()!=1||!cachePathAllowed(record.at("relative_path").string())||(record.at("kind").string()!="file"&&record.at("kind").string()!="directory")||(record.at("state").string()!="intent"&&record.at("state").string()!="submitted"&&record.at("state").string()!="completed")||record.at("helper").at("sid").string()!=currentIdentity().sid)fail("VAULT_CORRUPT");
  const auto& births=record.at("ancestor_births").array();if(births.empty()||births.size()>32)fail("VAULT_CORRUPT");
  for(const auto& birth:births)keys(birth,{"device","file_id","born_at"});
  return record;
}
void writeCacheRecord(unsigned slot,const Json& record) {
  const auto bytes=mm::dump(record);if(bytes.size()>16384)fail("FRAME_TOO_LARGE");
  (void)vault("vault_put",Json::Object{{"namespace","account"},{"key",cacheKey(slot)},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()))}});
}
void eraseCacheRecord(unsigned slot){(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",cacheKey(slot)}});}
void assertCacheLease(const Json& args){const auto own=ownedMutexes.find("cache");if(own==ownedMutexes.end()||!equalSecret(own->second.nonce,args.at("cache_nonce").string()))fail("PEER_DENIED");}
Json cacheAncestorBirths(const std::vector<Handle>& handles,const std::string& relative){
  const auto count=static_cast<std::size_t>(std::count(relative.begin(),relative.end(),'\\'))+1;
  if(count>handles.size()||count>32)fail("PATH_UNSAFE");Json::Array result;
  // Above-root ancestors are still held, but only app-owned ancestry is a
  // persistent data authority. A volume's historical root timestamp is irrelevant.
  for(std::size_t n=handles.size()-count;n<handles.size();++n)result.emplace_back(cacheHandleBirth(handles[n].value));return result;
}
bool disposeCacheCandidate(CacheCandidate& candidate) {
  if(candidate.record.at("state").string()=="completed")return true;
  assertRetiredEngineSessionCache(candidate.record.at("relative_path").string());
  if(!candidate.entry.valid()){
    if(candidate.record.at("state").string()!="submitted")return false;
    const auto path=rootPath("personal")+L"\\"+wide(candidate.record.at("relative_path").string());
    if(!nativePathMissing(path))return false;
    auto completed=candidate.record.object();completed["state"]="completed";writeCacheRecord(candidate.slot,completed);candidate.record=completed;return true;
  }
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;
  if(!SetFileInformationByHandle(candidate.entry.value,FileDispositionInfo,&disposition,sizeof(disposition))){const auto error=GetLastError();if(error==ERROR_ACCESS_DENIED||error==ERROR_SHARING_VIOLATION||error==ERROR_DIR_NOT_EMPTY||error==ERROR_LOCK_VIOLATION)return false;fail("PATH_UNSAFE");}
  auto submitted=candidate.record.object();submitted["state"]="submitted";writeCacheRecord(candidate.slot,submitted);candidate.record=submitted;
  // Basic disposition, never POSIX immediate unlink: existing consuming handles
  // may defer final removal. Keep the intent and fence new cache admission.
  const auto retiring=std::exchange(candidate.entry.value,nullptr);check(CloseHandle(retiring),"VAULT_RECOVERY_REQUIRED");const auto path=rootPath("personal")+L"\\"+wide(candidate.record.at("relative_path").string());
  if(!nativePathMissing(path))return false;
  auto record=candidate.record.object();record["state"]="completed";writeCacheRecord(candidate.slot,record);candidate.record=record;return true;
}
bool cacheAdmissionRecover() {
  for(unsigned slot=0;slot<16;++slot){
    const auto record=readCacheRecord(slot);if(std::holds_alternative<std::nullptr_t>(record.value))continue;
    if(record.at("state").string()=="completed"){eraseCacheRecord(slot);continue;}
    const auto path=rootPath("personal")+L"\\"+wide(record.at("relative_path").string());
    CacheCandidate candidate;candidate.ancestors=lockAncestors(path,false,false,rootPath("personal"),true);candidate.record=record;candidate.slot=slot;candidate.durable=true;
    if(mm::dump(cacheAncestorBirths(candidate.ancestors,record.at("relative_path").string()))!=mm::dump(record.at("ancestor_births")))fail("PATH_UNSAFE");
    bool absent=false,busy=false;candidate.entry=openCacheDeleteEntry(path,record.at("kind").string()=="directory",absent,busy,false,false,true,candidate.ancestors.back().value);
    if(busy)return false;
    if(absent){
      // Only a durable positive disposition/completion certificate authorizes
      // retirement after absence. A pre-effect intent alone remains uncertain.
      if(record.at("state").string()!="submitted")return false;
      eraseCacheRecord(slot);continue;
    }
    if(mm::dump(cacheHandleIdentity(candidate.entry.value,record.at("kind").string()=="directory"))!=mm::dump(record.at("expected")))fail("PATH_UNSAFE");
    if(!disposeCacheCandidate(candidate))return false;
    eraseCacheRecord(slot);
  }
  return true;
}
void closeCacheCandidates(){cacheCandidates.clear();}
Json beginCacheDeletion(const Json& args) {
  assertCacheLease(args);const auto relative=args.at("relative_path").string(),kind=args.at("kind").string();
  if(!cachePathAllowed(relative)||(kind!="file"&&kind!="directory")||!std::regex_match(args.at("request_id").string(),std::regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")))fail("BAD_REQUEST");
  assertRetiredEngineSessionCache(relative);
  keys(args.at("expected"),kind=="file"?std::set<std::string>{"device","file_id","born_at","bytes","written_at","changed_at"}:std::set<std::string>{"device","file_id","born_at"});
  if(cacheCandidates.size()>=16)fail("JOB_BUSY");
  unsigned slot=0;for(;slot<16;++slot){bool occupied=false;for(const auto& [nonce,existing]:cacheCandidates)if(existing.slot==slot)occupied=true;if(!occupied&&std::holds_alternative<std::nullptr_t>(readCacheRecord(slot).value))break;}
  if(slot==16)fail("VAULT_RECOVERY_REQUIRED");
  const auto path=rootPath("personal")+L"\\"+wide(relative);CacheCandidate candidate;candidate.ancestors=lockAncestors(path,false,false,rootPath("personal"),true);
  bool absent=false,busy=false;candidate.entry=openCacheDeleteEntry(path,kind=="directory",absent,busy,false,false,true,candidate.ancestors.back().value);if(absent||busy)return nullptr;
  if(mm::dump(cacheHandleIdentity(candidate.entry.value,kind=="directory"))!=mm::dump(args.at("expected")))fail("PATH_UNSAFE");
  const auto nonce=randomHex();candidate.slot=slot;
  candidate.record=Json::Object{{"version",1},{"request_id",args.at("request_id")},{"nonce",nonce},{"relative_path",relative},{"kind",kind},{"expected",args.at("expected")},{"ancestor_births",cacheAncestorBirths(candidate.ancestors,relative)},{"cache_nonce",args.at("cache_nonce")},{"helper",processIdentity(GetCurrentProcessId())},{"state","intent"}};
  const auto result=Json::Object{{"request_id",args.at("request_id")},{"nonce",nonce},{"relative_path",relative},{"kind",kind}};
  cacheCandidates.emplace(nonce,std::move(candidate));return result;
}
CacheCandidate& cacheCandidate(const Json& args){assertCacheLease(args);const auto item=cacheCandidates.find(args.at("nonce").string());if(item==cacheCandidates.end())fail("PEER_DENIED");const auto& record=item->second.record;for(const auto* key:{"request_id","nonce","relative_path","kind","cache_nonce"})if(mm::dump(args.at(key))!=mm::dump(record.at(key)))fail("PEER_DENIED");return item->second;}
Json commitCacheDeletion(const Json& args){auto& candidate=cacheCandidate(args);if(!candidate.durable){writeCacheRecord(candidate.slot,candidate.record);candidate.durable=true;}return Json::Object{{"state",disposeCacheCandidate(candidate)?"completed":"pending"}};}
Json releaseCacheDeletion(const Json& args){auto& candidate=cacheCandidate(args);if(candidate.durable&&candidate.record.at("state").string()!="completed")fail("VAULT_RECOVERY_REQUIRED");if(candidate.durable)eraseCacheRecord(candidate.slot);cacheCandidates.erase(args.at("nonce").string());return Json::Object{{"released",true}};}
Json recoverCacheDeletions(const Json& args){assertCacheLease(args);if(!cacheCandidates.empty())fail("JOB_BUSY");unsigned completed=0;for(unsigned slot=0;slot<16;++slot)if(!std::holds_alternative<std::nullptr_t>(readCacheRecord(slot).value))++completed;const auto settled=cacheAdmissionRecover();return Json::Object{{"completed",settled?static_cast<int>(completed):0},{"pending",settled?0:static_cast<int>(completed)}};}
