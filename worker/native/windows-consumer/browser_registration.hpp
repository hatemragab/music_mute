#pragma once
#include <ktmw32.h>

void checkBrowserApi(BOOL result,const char* operation){
  if(result)return;
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  const auto error=GetLastError();std::cerr<<"Browser fixture API failure: operation="<<operation<<"; win32_error="<<error<<'\n';
#else
  (void)operation;
#endif
  fail("BROWSER_REGISTRATION_CONFLICT");
}
std::wstring browserKeyPath(){
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if(isolatedTestRoot.empty())fail("BROWSER_REGISTRATION_CONFLICT");
  return L"Software\\MusicMuteConsumerNativeTest\\"+isolatedTestRoot.substr(isolatedTestRoot.find_last_of(L'\\')+1)+L"\\BrowserHost";
#else
  return L"Software\\Google\\Chrome\\NativeMessagingHosts\\com.musicmute.local";
#endif
}
std::wstring fixedChromeHostPath(){const auto launcher=fixedLauncherPath();return launcher.substr(0,launcher.find_last_of(L'\\'))+L"\\MusicMuteChromeHost.exe";}
std::wstring fixedBrowserEntryPath(){const auto launcher=fixedLauncherPath();return launcher.substr(0,launcher.find_last_of(L'\\'))+L"\\resources\\native\\browser-host.cjs";}
std::wstring browserManifestPath(){return rootPath("personal")+L"\\integration\\com.musicmute.local.json";}
Json browserReadProtected(const std::string& key){const auto value=vault("vault_get",Json::Object{{"namespace","account"},{"key",key}});if(std::holds_alternative<std::nullptr_t>(value.value))return nullptr;auto bytes=base64Decode(value.at("bytes_base64").string(),8192);const auto record=mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size())).parse();SecureZeroMemory(bytes.data(),bytes.size());return record;}
void browserWriteProtected(const std::string& key,const Json& value){const auto bytes=mm::dump(value);if(bytes.size()>8192)fail("BROWSER_REGISTRATION_CONFLICT");(void)vault("vault_put",Json::Object{{"namespace","account"},{"key",key},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(bytes.data()),static_cast<DWORD>(bytes.size()))}});}
void browserEraseProtected(const std::string& key){(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",key}});}
Json browserProtectedRecord(){return browserReadProtected("browser_registration");}
Json expectedBrowserManifest(const std::string& id){return Json::Object{{"name","com.musicmute.local"},{"description","MusicMute Windows companion"},{"path",utf8(fixedChromeHostPath())},{"type","stdio"},{"allowed_origins",Json::Array{Json("chrome-extension://"+id+"/")}}};}
Json browserFileBirth(HANDLE file){BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file,&info),"BROWSER_REGISTRATION_CONFLICT");return Json::Object{{"volume",std::to_string(info.dwVolumeSerialNumber)},{"file_id",std::to_string((static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},{"creation_time",std::to_string((static_cast<ULONGLONG>(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime)}};}
Handle openBrowserFile(const std::wstring& path,bool deletion=false,bool publication=false){
  if(publication&&!deletion)fail("BROWSER_REGISTRATION_CONFLICT");
  auto file=std::move(openNativePath(path,GENERIC_READ|READ_CONTROL|(deletion?DELETE:0)|(publication?FILE_WRITE_ATTRIBUTES:0),FILE_SHARE_READ,NativeChildKind::file).handle);checkBrowserApi(file.valid(),"CreateFileOpenBrowser");
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file.value,&info),"BROWSER_REGISTRATION_CONFLICT");if(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||info.nNumberOfLinks!=1)fail("BROWSER_REGISTRATION_CONFLICT");assertPrivateHandle(file.value);
  std::vector<wchar_t> bytes(32768);const auto size=GetFinalPathNameByHandleW(file.value,bytes.data(),static_cast<DWORD>(bytes.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);if(!size||size>=bytes.size())fail("BROWSER_REGISTRATION_CONFLICT");std::wstring actual(bytes.data(),size);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);if(_wcsicmp(actual.c_str(),path.c_str()))fail("BROWSER_REGISTRATION_CONFLICT");return file;
}
Json readBrowserHandle(HANDLE file){LARGE_INTEGER size{},start{};check(GetFileSizeEx(file,&size)&&size.QuadPart>=2&&size.QuadPart<=4096&&SetFilePointerEx(file,start,nullptr,FILE_BEGIN),"BROWSER_REGISTRATION_CONFLICT");std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD read=0;check(ReadFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&read,nullptr)&&read==bytes.size(),"BROWSER_REGISTRATION_CONFLICT");return mm::JsonParser(bytes).parse();}
Json readBrowserManifest(){auto parents=lockAncestors(browserManifestPath(),false,false,rootPath("personal"),true);auto file=openBrowserFile(browserManifestPath());return readBrowserHandle(file.value);}
bool browserMissing(const std::wstring& path){return nativePathMissing(path,true);}
void validateBrowserRecord(const Json& record){
  if(std::holds_alternative<std::nullptr_t>(record.value))fail("BROWSER_REGISTRATION_CONFLICT");
  keys(record,{"version","sid","extension_id","host_sha256","host_bytes","entry_sha256","entry_bytes","manifest_birth","manifest_sha256"});
  if(record.at("version").integer()!=2||record.at("sid").string()!=currentIdentity().sid)fail("BROWSER_REGISTRATION_CONFLICT");
  const auto id=record.at("extension_id").string();if(id.size()!=32||id.find_first_not_of("abcdefghijklmnop")!=std::string::npos)fail("BROWSER_REGISTRATION_CONFLICT");
  keys(record.at("manifest_birth"),{"volume","file_id","creation_time"});
  for(const auto* field:{"host_sha256","entry_sha256","manifest_sha256"}){const auto sha=record.at(field).string();if(sha.size()!=64||sha.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BROWSER_REGISTRATION_CONFLICT");}
  for(const auto& [name,value]:record.at("manifest_birth").object()){(void)name;const auto text=value.string();if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("BROWSER_REGISTRATION_CONFLICT");}
  if(record.at("host_bytes").integer()<1||record.at("host_bytes").integer()>16*1024*1024||record.at("entry_bytes").integer()<1||record.at("entry_bytes").integer()>32*1024*1024)fail("BROWSER_REGISTRATION_CONFLICT");
}
void assertBrowserPayload(HANDLE file,const Json& record){
  validateBrowserRecord(record);
  if(mm::dump(readBrowserHandle(file))!=mm::dump(expectedBrowserManifest(record.at("extension_id").string())))fail("BROWSER_REGISTRATION_CONFLICT");
  LARGE_INTEGER start{};check(SetFilePointerEx(file,start,nullptr,FILE_BEGIN),"BROWSER_REGISTRATION_CONFLICT");if(hashFile(file)!=record.at("manifest_sha256").string())fail("BROWSER_REGISTRATION_CONFLICT");
}
void assertBrowserHandle(HANDLE file,const Json& record){
  validateBrowserRecord(record);if(mm::dump(browserFileBirth(file))!=mm::dump(record.at("manifest_birth")))fail("BROWSER_REGISTRATION_CONFLICT");assertBrowserPayload(file,record);
}
void normalizeBrowserPublicationBirth(HANDLE file,const Json& record,const Json& old){
  validateBrowserRecord(record);const auto actual=browserFileBirth(file),expected=record.at("manifest_birth");
  if(mm::dump(actual)!=mm::dump(expected)){
    // NTFS can tunnel the removed name's creation time onto a renamed file.
    // Only the exact journal-pinned generation may have that time restored.
    if(actual.at("volume").string()!=expected.at("volume").string()||actual.at("file_id").string()!=expected.at("file_id").string())fail("BROWSER_REGISTRATION_CONFLICT");
    if(!std::holds_alternative<std::nullptr_t>(old.value)){validateBrowserRecord(old);if(actual.at("creation_time").string()!=old.at("manifest_birth").at("creation_time").string())fail("BROWSER_REGISTRATION_CONFLICT");}
    assertBrowserPayload(file,record);
    ULONGLONG value=0;try{value=std::stoull(expected.at("creation_time").string());}catch(...){fail("BROWSER_REGISTRATION_CONFLICT");}if(!value)fail("BROWSER_REGISTRATION_CONFLICT");
    const FILETIME creationTime{static_cast<DWORD>(value),static_cast<DWORD>(value>>32)};check(SetFileTime(file,&creationTime,nullptr,nullptr),"BROWSER_REGISTRATION_CONFLICT");
  }
  // Timestamp normalization never substitutes for the complete birth/hash.
  assertBrowserHandle(file,record);
}
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
enum class BrowserPublicationFault {none,renamed,restored};
BrowserPublicationFault browserPublicationFault=BrowserPublicationFault::none;
#endif
void assertOwnedBrowserRegistration(const Json& record,const std::string& repairId="",bool allowMissing=false){
  (void)repairId;validateBrowserRecord(record);
  // Missing owned parent repair first proves the actual private root/record.
  auto root=lockAncestors(rootPath("personal"),false,true,rootPath("personal"),true);
  if(allowMissing&&browserMissing(browserManifestPath()))return;
  auto parents=lockAncestors(browserManifestPath(),false,false,rootPath("personal"),true);auto file=openBrowserFile(browserManifestPath());assertBrowserHandle(file.value,record);
}
std::string browserRegistryHandleState(HKEY key){
  DWORD values=0,children=0;check(RegQueryInfoKeyW(key,nullptr,nullptr,nullptr,&children,nullptr,nullptr,&values,nullptr,nullptr,nullptr,nullptr)==ERROR_SUCCESS,"BROWSER_REGISTRATION_CONFLICT");if(children||values!=1)return "conflict";
  wchar_t path[32768]{};DWORD bytes=sizeof(path),type=0;const auto status=RegQueryValueExW(key,nullptr,nullptr,&type,reinterpret_cast<BYTE*>(path),&bytes);
  if(status!=ERROR_SUCCESS||type!=REG_SZ||bytes<2||bytes%2||bytes>sizeof(path)||path[bytes/2-1]!=L'\0'||std::wstring(path,bytes/2-1).find(L'\0')!=std::wstring::npos||_wcsicmp(path,browserManifestPath().c_str()))return "conflict";return "owned";
}
std::string browserRegistryState(REGSAM view){RegistryHandle key;const auto result=RegOpenKeyExW(HKEY_CURRENT_USER,browserKeyPath().c_str(),0,KEY_QUERY_VALUE|view,&key.key);if(result==ERROR_FILE_NOT_FOUND)return "absent";if(result!=ERROR_SUCCESS)fail("BROWSER_REGISTRATION_CONFLICT");return browserRegistryHandleState(key.key);}
struct BrowserRegistryTransaction {
  Handle transaction;
  std::vector<std::unique_ptr<RegistryHandle>> handles;
  BrowserRegistryTransaction(bool remove):transaction(CreateTransaction(nullptr,nullptr,TRANSACTION_DO_NOT_PROMOTE,0,0,25000,nullptr)){
    if(!transaction.valid())fail("BROWSER_REGISTRATION_CONFLICT");
    for(const REGSAM view:{KEY_WOW64_32KEY,KEY_WOW64_64KEY}){
      auto key=std::make_unique<RegistryHandle>();const auto opened=RegOpenKeyTransactedW(HKEY_CURRENT_USER,browserKeyPath().c_str(),0,KEY_QUERY_VALUE|KEY_SET_VALUE|DELETE|view,&key->key,transaction.value,nullptr);
      if(remove&&opened==ERROR_KEY_DELETED&&!handles.empty())continue; // Shared WOW views, already deleted in this transaction.
      if(opened!=ERROR_SUCCESS&&opened!=ERROR_FILE_NOT_FOUND)fail("BROWSER_REGISTRATION_CONFLICT");
      if(opened==ERROR_SUCCESS&&browserRegistryHandleState(key->key)!="owned")fail("BROWSER_REGISTRATION_CONFLICT");
      if(remove){if(opened==ERROR_SUCCESS&&RegDeleteKeyTransactedW(HKEY_CURRENT_USER,browserKeyPath().c_str(),view,0,transaction.value,nullptr)!=ERROR_SUCCESS)fail("BROWSER_REGISTRATION_CONFLICT");}
      else {
        if(opened==ERROR_FILE_NOT_FOUND){DWORD created=0;check(RegCreateKeyTransactedW(HKEY_CURRENT_USER,browserKeyPath().c_str(),0,nullptr,0,KEY_QUERY_VALUE|KEY_SET_VALUE|view,nullptr,&key->key,&created,transaction.value,nullptr)==ERROR_SUCCESS&&created==REG_CREATED_NEW_KEY,"BROWSER_REGISTRATION_CONFLICT");}
        const auto path=browserManifestPath();check(RegSetValueExW(key->key,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(path.c_str()),static_cast<DWORD>((path.size()+1)*sizeof(wchar_t)))==ERROR_SUCCESS,"BROWSER_REGISTRATION_CONFLICT");
      }
      handles.emplace_back(std::move(key));
    }
  }
  void commit(){check(CommitTransaction(transaction.value),"BROWSER_REGISTRATION_CONFLICT");handles.clear();}
};
void browserChangePhase(Json& change,const std::string& phase){auto next=change.object();next["phase"]=phase;change=next;browserWriteProtected("browser_manifest_change",change);}
void disposeBrowserManifest(Handle& file,Json& change){
  FILE_DISPOSITION_INFO info{};info.DeleteFile=TRUE;check(SetFileInformationByHandle(file.value,FileDispositionInfo,&info,sizeof(info)),"BROWSER_REGISTRATION_CONFLICT");browserChangePhase(change,"old-submitted");
  const auto retiring=std::exchange(file.value,nullptr);check(CloseHandle(retiring),"BROWSER_REGISTRATION_CONFLICT");if(!browserMissing(browserManifestPath()))fail("BROWSER_REGISTRATION_CONFLICT");browserChangePhase(change,"old-removed");
}
void renameBrowserStage(HANDLE file,HANDLE parent){const auto result=renameNativeChild(file,parent,L"com.musicmute.local.json");if(result.status!=0){SetLastError(result.error);checkBrowserApi(FALSE,"SetFileInformationByHandleRenameBrowserStage");}}
void boundBrowserStages(HANDLE directory){
  unsigned count=0;
  for(const auto& entry:enumerateNativeDirectory(directory)){
    if(!PathMatchSpecW(entry.name.c_str(),L".browser-*"))continue;
    if(++count>=16||entry.attributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)||!std::regex_match(utf8(entry.name),std::regex("\\.browser-[a-f0-9]{64}")))fail("BROWSER_REGISTRATION_CONFLICT");
  }
}
Json publishBrowserManifest(const Json& desiredPins){
  const auto root=rootPath("personal"),directory=root+L"\\integration";auto parents=lockAncestors(directory,true,true,root,true);
  auto change=browserReadProtected("browser_manifest_change");
  if(std::holds_alternative<std::nullptr_t>(change.value)){
    const auto old=browserProtectedRecord();if(!std::holds_alternative<std::nullptr_t>(old.value))assertOwnedBrowserRegistration(old,"",true);else if(!browserMissing(browserManifestPath()))fail("BROWSER_REGISTRATION_CONFLICT");
    boundBrowserStages(parents.back().value);const auto relative=".browser-"+randomHex();Security security(dataSddl());auto stage=std::move(openNativeChild(parents.back().value,wide(relative),GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::createNew,security.descriptor,true).handle);checkBrowserApi(stage.valid(),"CreateFileCreateBrowserStage");
    try {
    const auto bytes=mm::dump(expectedBrowserManifest(desiredPins.at("extension_id").string()));DWORD wrote=0;
    check(WriteFile(stage.value,bytes.data(),static_cast<DWORD>(bytes.size()),&wrote,nullptr)&&wrote==bytes.size()&&FlushFileBuffers(stage.value),"BROWSER_REGISTRATION_CONFLICT");
    auto desired=desiredPins.object();desired["version"]=2;desired["manifest_birth"]=browserFileBirth(stage.value);LARGE_INTEGER start{};check(SetFilePointerEx(stage.value,start,nullptr,FILE_BEGIN),"BROWSER_REGISTRATION_CONFLICT");desired["manifest_sha256"]=hashFile(stage.value);
    change=Json::Object{{"version",1},{"operation","register"},{"desired",desired},{"old",old},{"temporary",relative},{"phase",std::holds_alternative<std::nullptr_t>(old.value)||browserMissing(browserManifestPath())?"old-removed":"staged"}};
    browserWriteProtected("browser_manifest_change",change);
    } catch(...) {
      // Only this still-exclusive created HANDLE may be discarded. A lost
      // protected intent ACK retains the stage; there is no pathname cleanup.
      bool unbound=false;try{unbound=std::holds_alternative<std::nullptr_t>(browserReadProtected("browser_manifest_change").value);}catch(...){}
      if(unbound){FILE_DISPOSITION_INFO info{};info.DeleteFile=TRUE;(void)SetFileInformationByHandle(stage.value,FileDispositionInfo,&info,sizeof(info));}throw;
    }
    const auto closing=std::exchange(stage.value,nullptr);check(CloseHandle(closing),"BROWSER_REGISTRATION_CONFLICT");
  }
  keys(change,{"version","operation","desired","old","temporary","phase"});if(change.at("version").integer()!=1||change.at("operation").string()!="register")fail("BROWSER_REGISTRATION_CONFLICT");
  const auto desired=change.at("desired");validateBrowserRecord(desired);for(const auto* key:{"sid","extension_id","host_sha256","host_bytes","entry_sha256","entry_bytes"})if(mm::dump(desired.at(key))!=mm::dump(desiredPins.at(key)))fail("BROWSER_REGISTRATION_CONFLICT");
  const auto temporary=change.at("temporary").string();if(!std::regex_match(temporary,std::regex("\\.browser-[a-f0-9]{64}")))fail("BROWSER_REGISTRATION_CONFLICT");
  const auto stagePath=directory+L"\\"+wide(temporary);
  // Exact staged birth, not content equivalence, proves lost publication ACK.
  if(!browserMissing(browserManifestPath())){
    const bool interruptedRename=change.at("phase").string()=="old-removed"&&browserMissing(stagePath);
    auto current=openBrowserFile(browserManifestPath(),true,interruptedRename);
    if(mm::dump(browserFileBirth(current.value))==mm::dump(desired.at("manifest_birth"))){assertBrowserHandle(current.value,desired);browserChangePhase(change,"published");return desired;}
    if(interruptedRename){if(!browserMissing(stagePath))fail("BROWSER_REGISTRATION_CONFLICT");normalizeBrowserPublicationBirth(current.value,desired,change.at("old"));browserChangePhase(change,"published");return desired;}
    if(std::holds_alternative<std::nullptr_t>(change.at("old").value))fail("BROWSER_REGISTRATION_CONFLICT");assertBrowserHandle(current.value,change.at("old"));disposeBrowserManifest(current,change);
  }else if(change.at("phase").string()=="old-submitted")browserChangePhase(change,"old-removed");
  else if(change.at("phase").string()!="old-removed"&&change.at("phase").string()!="published")fail("BROWSER_REGISTRATION_CONFLICT");
  auto stage=openBrowserFile(stagePath,true,true);assertBrowserHandle(stage.value,desired);renameBrowserStage(stage.value,parents.back().value);
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if(browserPublicationFault==BrowserPublicationFault::renamed)fail("BROWSER_REGISTRATION_CONFLICT");
#endif
  normalizeBrowserPublicationBirth(stage.value,desired,change.at("old"));
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if(browserPublicationFault==BrowserPublicationFault::restored)fail("BROWSER_REGISTRATION_CONFLICT");
#endif
  browserChangePhase(change,"published");return desired;
}
Json registerBrowser(const Json& args){
  VaultNamespaceLock serialize("account");const auto id=args.at("extension_id").string();if(id.size()!=32||id.find_first_not_of("abcdefghijklmnop")!=std::string::npos)fail("BAD_REQUEST");
  auto host=lockHashedFile(fixedChromeHostPath(),args.at("host_sha256").string(),true),entry=lockHashedFile(fixedBrowserEntryPath(),args.at("entry_sha256").string(),true);LARGE_INTEGER hostBytes{},entryBytes{};check(GetFileSizeEx(host.value,&hostBytes)&&GetFileSizeEx(entry.value,&entryBytes),"BROWSER_REGISTRATION_CONFLICT");
  if(hostBytes.QuadPart!=args.at("host_bytes").integer()||entryBytes.QuadPart!=args.at("entry_bytes").integer()||hostBytes.QuadPart<1||hostBytes.QuadPart>16*1024*1024||entryBytes.QuadPart<1||entryBytes.QuadPart>32*1024*1024)fail("HELPER_INTEGRITY_INVALID");
  BrowserRegistryTransaction registry(false);
  const Json pins=Json::Object{{"sid",currentIdentity().sid},{"extension_id",id},{"host_sha256",args.at("host_sha256")},{"host_bytes",args.at("host_bytes")},{"entry_sha256",args.at("entry_sha256")},{"entry_bytes",args.at("entry_bytes")}};
  const auto old=browserProtectedRecord();
  bool unchanged=!std::holds_alternative<std::nullptr_t>(old.value)&&std::holds_alternative<std::nullptr_t>(browserReadProtected("browser_manifest_change").value)&&!browserMissing(browserManifestPath());
  if(unchanged){assertOwnedBrowserRegistration(old);for(const auto& [name,value]:pins.object())if(mm::dump(old.at(name))!=mm::dump(value))unchanged=false;}
  const auto desired=unchanged?old:publishBrowserManifest(pins);
  auto ancestry=lockAncestors(browserManifestPath(),false,false,rootPath("personal"),true);auto generation=openBrowserFile(browserManifestPath());assertBrowserHandle(generation.value,desired);
  browserWriteProtected("browser_registration",desired);registry.commit();browserEraseProtected("browser_manifest_change");
  if(browserRegistryState(KEY_WOW64_32KEY)!="owned"||browserRegistryState(KEY_WOW64_64KEY)!="owned")fail("BROWSER_REGISTRATION_CONFLICT");return Json::Object{{"registered",true},{"views",Json::Array{32,64}}};
}
Json unregisterBrowser(){
  VaultNamespaceLock serialize("account");auto record=browserProtectedRecord();const auto pending=browserReadProtected("browser_manifest_change");
  if(browserRegistryState(KEY_WOW64_32KEY)=="absent"&&browserRegistryState(KEY_WOW64_64KEY)=="absent"&&std::holds_alternative<std::nullptr_t>(record.value)&&std::holds_alternative<std::nullptr_t>(pending.value)&&browserMissing(browserManifestPath()))return Json::Object{{"removed",true}};
  if(std::holds_alternative<std::nullptr_t>(record.value)&&!std::holds_alternative<std::nullptr_t>(pending.value)&&pending.at("operation").string()=="remove"&&pending.at("phase").string()=="old-removed")record=pending.at("record");
  validateBrowserRecord(record);BrowserRegistryTransaction registry(true);
  auto parents=lockAncestors(rootPath("personal"),false,true,rootPath("personal"),true);auto change=pending;
  if(std::holds_alternative<std::nullptr_t>(change.value)){assertOwnedBrowserRegistration(record,"",true);change=Json::Object{{"version",1},{"operation","remove"},{"record",record},{"phase",browserMissing(browserManifestPath())?"old-removed":"intent"}};browserWriteProtected("browser_manifest_change",change);}
  keys(change,{"version","operation","record","phase"});if(change.at("version").integer()!=1||change.at("operation").string()!="remove"||mm::dump(change.at("record"))!=mm::dump(record))fail("BROWSER_REGISTRATION_CONFLICT");
  if(!browserMissing(browserManifestPath())){auto ancestry=lockAncestors(browserManifestPath(),false,false,rootPath("personal"),true);auto file=openBrowserFile(browserManifestPath(),true);assertBrowserHandle(file.value,record);disposeBrowserManifest(file,change);}
  else if(change.at("phase").string()!="old-submitted"&&change.at("phase").string()!="old-removed")fail("BROWSER_REGISTRATION_CONFLICT");
  browserChangePhase(change,"old-removed");registry.commit();if(browserRegistryState(KEY_WOW64_32KEY)!="absent"||browserRegistryState(KEY_WOW64_64KEY)!="absent")fail("BROWSER_REGISTRATION_CONFLICT");browserEraseProtected("browser_registration");browserEraseProtected("browser_manifest_change");return Json::Object{{"removed",true}};
}
Json inspectBrowser(const Json& args){try{VaultNamespaceLock serialize("account");if(!std::holds_alternative<std::nullptr_t>(browserReadProtected("browser_manifest_change").value)||browserRegistryState(KEY_WOW64_32KEY)!="owned"||browserRegistryState(KEY_WOW64_64KEY)!="owned")return Json::Object{{"registered",false}};const auto record=browserProtectedRecord();assertOwnedBrowserRegistration(record);for(const auto* key:{"extension_id","host_sha256","host_bytes","entry_sha256","entry_bytes"})if(mm::dump(record.at(key))!=mm::dump(args.at(key)))return Json::Object{{"registered",false}};auto host=lockHashedFile(fixedChromeHostPath(),args.at("host_sha256").string(),true),entry=lockHashedFile(fixedBrowserEntryPath(),args.at("entry_sha256").string(),true);LARGE_INTEGER first{},second{};check(GetFileSizeEx(host.value,&first)&&GetFileSizeEx(entry.value,&second),"BROWSER_REGISTRATION_CONFLICT");return Json::Object{{"registered",first.QuadPart==args.at("host_bytes").integer()&&second.QuadPart==args.at("entry_bytes").integer()}};}catch(const Failure&){return Json::Object{{"registered",false}};}}
