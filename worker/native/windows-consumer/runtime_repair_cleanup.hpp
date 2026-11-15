#pragma once

// Separate fixed Prepare quarantine authority. It cannot delete arbitrary
// runtime/model/caches and never treats a parent PID exit as a child-tree proof.
constexpr std::uint64_t repairBytesMax=16ULL*1024*1024*1024;
std::string repairBytesDigest(const std::string& bytes){
  BCRYPT_ALG_HANDLE algorithm=nullptr;if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)!=0)fail("HELPER_INTEGRITY_INVALID");
  BYTE digest[32]{};const auto status=BCryptHash(algorithm,nullptr,0,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),static_cast<ULONG>(bytes.size()),digest,32);
  BCryptCloseAlgorithmProvider(algorithm,0);if(status!=0)fail("HELPER_INTEGRITY_INVALID");constexpr char hex[]="0123456789abcdef";std::string result;for(const auto byte:digest){result+=hex[byte>>4];result+=hex[byte&15];}return result;
}
std::string repairProtectedBytes(const std::string& key){
  const auto value=vault("vault_get",Json::Object{{"namespace","account"},{"key",key}});if(std::holds_alternative<std::nullptr_t>(value.value))return {};
  auto bytes=base64Decode(value.at("bytes_base64").string(),16384);std::string result(reinterpret_cast<const char*>(bytes.data()),bytes.size());SecureZeroMemory(bytes.data(),bytes.size());return result;
}
void repairProtectedWrite(const std::string& key,const Json& record){const auto text=mm::dump(record);if(text.size()>16384)fail("FRAME_TOO_LARGE");(void)vault("vault_put",Json::Object{{"namespace","account"},{"key",key},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()))}});}
Json repairJsBirth(const Json& value){keys(value,{"device","fileId","bornAt"});return Json::Object{{"device",value.at("device")},{"file_id",value.at("fileId")},{"born_at",value.at("bornAt")}};}
Json repairJsPeer(const Json& value){keys(value,{"sid","sessionId","pid","creationTime"});return Json::Object{{"sid",value.at("sid")},{"session_id",value.at("sessionId")},{"pid",value.at("pid")},{"creation_time",value.at("creationTime")}};}
bool repairDigest(const std::string& text){return text.size()==64&&text.find_first_not_of("0123456789abcdef")==std::string::npos;}
// Historical proofs authorize retirement of their exact authenticated backup
// only. Current runtime admission separately requires the current DLL policy.
bool knownRuntimeRetirementDllPolicy(const std::string& policy){return policy=="private-pe-imports-msvc-v1"||policy=="private-pe-imports-msvc-v2";}
void assertRepairMaintenance(const Json& args){
  const auto prepare=ownedMutexes.find("prepare");if(prepare==ownedMutexes.end()||!equalSecret(prepare->second.nonce,args.at("prepare_nonce").string()))fail("PEER_DENIED");
  const auto text=repairProtectedBytes("prepare_maintenance");if(text.empty())fail("PEER_DENIED");const auto maintenance=mm::JsonParser(text).parse();keys(maintenance,{"version","sid","transaction","target","owner","authority","phase"});
  if(maintenance.at("version").integer()!=1||maintenance.at("phase").string()!="retired"||maintenance.at("target").string()!=args.at("target").string()||maintenance.at("sid").string()!=currentIdentity().sid||mm::dump(repairJsPeer(maintenance.at("owner")))!=mm::dump(singletonParentIdentity()))fail("PEER_DENIED");
  assertNoSingleton("session");
  if(!std::get<bool>(latestWorkerTreesIdle().at("idle").value)||!std::get<bool>(latestWorkerTreesIdle("prepare").at("idle").value))fail("JOB_BUSY");
}
struct RepairInventoryRow {std::string path;bool directory;Json birth;std::int64_t bytes=0;std::string sha256;};
std::vector<RepairInventoryRow> parseRepairInventory(const std::string& bytes){
  const auto inventory=mm::JsonParser::runtimeRepairInventory(bytes);keys(inventory,{"version","entries"});if(inventory.at("version").integer()!=1)fail("VAULT_CORRUPT");
  const auto& entries=inventory.at("entries").array();if(entries.empty()||entries.size()>100000)fail("VAULT_CORRUPT");
  std::map<std::string,bool> paths;std::vector<RepairInventoryRow> rows;std::uint64_t total=0;
  for(const auto& item:entries){
    keys(item,{"path","kind","birth","bytes","sha256"});auto path=item.at("path").string();const auto kind=item.at("kind").string();if(kind!="file"&&kind!="directory")fail("VAULT_CORRUPT");const bool directory=kind=="directory";
    if(path.find('\\')!=std::string::npos||std::count(path.begin(),path.end(),'/')>=32)fail("VAULT_CORRUPT");auto lowered=path;std::transform(lowered.begin(),lowered.end(),lowered.begin(),[](unsigned char c){return static_cast<char>(tolower(c));});
    if(paths.contains(lowered))fail("VAULT_CORRUPT");
    if(path.empty()){if(!rows.empty()||!directory)fail("VAULT_CORRUPT");}else{
      auto relative=path;std::replace(relative.begin(),relative.end(),'/','\\');(void)relativePath(relative);
      const auto separator=lowered.find_last_of('/');const auto parent=separator==std::string::npos?std::string{}:lowered.substr(0,separator);const auto known=paths.find(parent);if(known==paths.end()||!known->second)fail("VAULT_CORRUPT");
    }
    auto birth=repairJsBirth(item.at("birth"));for(const auto& [key,value]:birth.object()){(void)key;if(!std::regex_match(value.string(),std::regex("[0-9]{1,30}")))fail("VAULT_CORRUPT");}if(birth.at("file_id").string()=="0")fail("VAULT_CORRUPT");
    RepairInventoryRow row{path,directory,birth,0,{}};
    if(directory){if(!std::holds_alternative<std::nullptr_t>(item.at("bytes").value)||!std::holds_alternative<std::nullptr_t>(item.at("sha256").value))fail("VAULT_CORRUPT");}
    else{row.bytes=item.at("bytes").integer();row.sha256=item.at("sha256").string();if(row.bytes<0||!repairDigest(row.sha256))fail("VAULT_CORRUPT");total+=static_cast<std::uint64_t>(row.bytes);if(total>repairBytesMax)fail("VAULT_CORRUPT");}
    paths.emplace(lowered,directory);rows.emplace_back(std::move(row));
  }
  return rows;
}
std::wstring repairRowPath(const std::wstring& root,const std::string& relative){if(relative.empty())return root;auto result=wide(relative);std::replace(result.begin(),result.end(),L'/',L'\\');return root+L"\\"+result;}
std::string readRepairInventoryFile(HANDLE file){
  LARGE_INTEGER size{},start{};check(GetFileSizeEx(file,&size)&&size.QuadPart>0&&size.QuadPart<=16*1024*1024,"PATH_UNSAFE");check(SetFilePointerEx(file,start,nullptr,FILE_BEGIN),"PATH_UNSAFE");std::string bytes(static_cast<std::size_t>(size.QuadPart),'\0');DWORD read=0;check(ReadFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&read,nullptr)&&read==bytes.size(),"PATH_UNSAFE");return bytes;
}
bool repairFileMatches(HANDLE file,const RepairInventoryRow& expected){
  if(mm::dump(cacheHandleBirth(file))!=mm::dump(expected.birth))fail("PATH_UNSAFE");LARGE_INTEGER size{},start{};check(GetFileSizeEx(file,&size),"PATH_UNSAFE");if(size.QuadPart!=expected.bytes)fail("PATH_UNSAFE");check(SetFilePointerEx(file,start,nullptr,FILE_BEGIN),"PATH_UNSAFE");if(hashFile(file,repairBytesMax)!=expected.sha256)fail("PATH_UNSAFE");return true;
}
bool disposeRepairHandle(Handle& file,const std::wstring& path,HANDLE parent){
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;
  if(!SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition))){const auto error=GetLastError();if(error==ERROR_ACCESS_DENIED||error==ERROR_SHARING_VIOLATION||error==ERROR_DIR_NOT_EMPTY||error==ERROR_LOCK_VIOLATION)return false;fail("PATH_UNSAFE");}
  const auto handle=std::exchange(file.value,nullptr);check(CloseHandle(handle),"VAULT_RECOVERY_REQUIRED");return nativeChildMissing(parent,path.substr(path.find_last_of(L'\\')+1));
}
Json removeRuntimeRepairBackup(const Json& args){
  const auto target=args.at("target").string(),digest=args.at("record_digest").string();if(!repairDigest(target)||!repairDigest(digest))fail("BAD_REQUEST");assertRepairMaintenance(args);
  const auto markerText=repairProtectedBytes("runtime_repair_cleanup");Json marker=markerText.empty()?Json(nullptr):mm::JsonParser(markerText).parse();
  auto text=repairProtectedBytes("prepare_runtime_repair");Json record=text.empty()?Json(nullptr):mm::JsonParser(text).parse();
  const bool matchingMarker=!std::holds_alternative<std::nullptr_t>(marker.value)&&marker.at("target").string()==target&&(marker.at("recordDigest").string()==digest||marker.at("deletingDigest").string()==digest);
  if(matchingMarker){keys(marker,{"version","target","recordDigest","deletingDigest","manifestSha256","sequence","newBirth","inventorySha256","inventoryBirth","state"});if(marker.at("version").integer()!=1)fail("VAULT_CORRUPT");}
  if(text.empty()&&(!matchingMarker||marker.at("state").string()!="completed"))fail("VAULT_RECOVERY_REQUIRED");
  if(!text.empty()){
    keys(record,{"version","target","archiveSha256","releaseVersion","sequence","owner","oldBirth","newBirth","oldTreeDigest","manifestSha256","previousManifestSha256","phase"});
    if(record.at("version").integer()!=1||record.at("target").string()!=target||(record.at("phase").string()!="activated"&&record.at("phase").string()!="deleting")||!repairDigest(record.at("oldTreeDigest").string())||!repairDigest(record.at("manifestSha256").string())||!repairDigest(record.at("archiveSha256").string())||record.at("sequence").integer()<1||repairJsPeer(record.at("owner")).at("sid").string()!=currentIdentity().sid||mm::dump(repairJsBirth(record.at("oldBirth")))==mm::dump(repairJsBirth(record.at("newBirth"))))fail("VAULT_CORRUPT");
    const auto actualDigest=repairBytesDigest(text);if(actualDigest!=digest&&(!matchingMarker||actualDigest!=marker.at("deletingDigest").string()))fail("PEER_DENIED");
  }
  const auto readyText=repairProtectedBytes("ready_receipt");if(readyText.empty())fail("PEER_DENIED");const auto ready=mm::JsonParser::runtimeRepairInventory(readyText);keys(ready,{"version","bootIdentity","sid","target","release","sequence","manifestSha256","modelSha256","fixtureSha256","modelFingerprint","qualification","activatedAt"});
  const auto manifest=text.empty()?marker.at("manifestSha256"):record.at("manifestSha256"),sequence=text.empty()?marker.at("sequence"):record.at("sequence"),newBirth=text.empty()?marker.at("newBirth"):record.at("newBirth");
  // This retires installed bytes; it cannot grant inference. Ready target,
  // manifest/sequence/new directory remain authoritative across a reboot, while
  // every actual inference reader separately requires the current boot witness.
  if(ready.at("version").integer()!=2||ready.at("sid").string()!=currentIdentity().sid||ready.at("target").string()!=target||ready.at("release").string()!=target||mm::dump(ready.at("sequence"))!=mm::dump(sequence)||mm::dump(ready.at("manifestSha256"))!=mm::dump(manifest)||!repairDigest(ready.at("bootIdentity").string()))fail("PEER_DENIED");
  const auto proofText=repairProtectedBytes("runtime_"+target.substr(0,56));if(proofText.empty())fail("PEER_DENIED");const auto proof=mm::JsonParser(proofText).parse();keys(proof,{"version","dllPolicy","sid","release","archiveSha256","sequence","manifestSha256"});
  if(proof.at("version").integer()!=2||proof.at("sid").string()!=currentIdentity().sid||proof.at("release").string()!=target||mm::dump(proof.at("sequence"))!=mm::dump(sequence)||mm::dump(proof.at("manifestSha256"))!=mm::dump(manifest)||!repairDigest(proof.at("archiveSha256").string())||(!text.empty()&&mm::dump(proof.at("archiveSha256"))!=mm::dump(record.at("archiveSha256")))||!knownRuntimeRetirementDllPolicy(proof.at("dllPolicy").string()))fail("PEER_DENIED");
  const auto canonical=rootPath("personal")+L"\\runtime\\releases\\"+wide(target);auto canonicalParents=lockAncestors(canonical,false,false,rootPath("personal"),true);auto canonicalRoot=openEntry(canonical,true,true,false,true);if(mm::dump(cacheHandleBirth(canonicalRoot.value))!=mm::dump(repairJsBirth(newBirth)))fail("PATH_UNSAFE");
  // The protected activated inventory proof is authority for retiring the old
  // bank. A newly damaged canonical manifest must not permanently occupy the
  // only quarantine slot; it still cannot authorize any executable/inference.
  const auto backup=rootPath("personal")+L"\\staging\\prepare-runtime-backup",sidecar=rootPath("personal")+L"\\staging\\prepare-runtime-backup.inventory.json";auto parents=lockAncestors(backup,false,false,rootPath("personal"),true);
  if(matchingMarker&&marker.at("state").string()=="completed"){
    for(const auto& path:{backup,sidecar}){if(!nativeChildMissing(parents.back().value,path.substr(path.find_last_of(L'\\')+1)))fail("PATH_UNSAFE");}
    if(!text.empty()){if(record.at("phase").string()!="deleting"||repairBytesDigest(text)!=marker.at("deletingDigest").string())fail("PEER_DENIED");(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key","prepare_runtime_repair"}});}return Json::Object{{"state","completed"}};
  }
  if(!std::holds_alternative<std::nullptr_t>(marker.value)&&!matchingMarker&&marker.at("state").string()!="completed")fail("VAULT_RECOVERY_REQUIRED");
  bool absent=false,busy=false;auto inventoryFile=openCacheDeleteEntry(sidecar,false,absent,busy,true,false,true,parents.back().value);if(busy)return Json::Object{{"state","pending"}};
  if(absent){if(!matchingMarker||(marker.at("state").string()!="inventory-deleting"&&marker.at("state").string()!="completed"))fail("PATH_UNSAFE");}
  if(matchingMarker&&(marker.at("state").string()=="tree-deleted"||marker.at("state").string()=="inventory-deleting")){if(!nativeChildMissing(parents.back().value,L"prepare-runtime-backup"))fail("PATH_UNSAFE");}
  if(!absent){
    const auto bytes=readRepairInventoryFile(inventoryFile.value);if(repairBytesDigest(bytes)!=record.at("oldTreeDigest").string())fail("PATH_UNSAFE");const auto entries=parseRepairInventory(bytes);
    if(mm::dump(entries.front().birth)!=mm::dump(repairJsBirth(record.at("oldBirth"))))fail("VAULT_CORRUPT");
    if(!matchingMarker){
      if(record.at("phase").string()!="activated")fail("VAULT_RECOVERY_REQUIRED");
      auto deleting=record.object();deleting["phase"]="deleting";const auto deletingDigest=repairBytesDigest(mm::dump(deleting));
      marker=Json::Object{{"version",1},{"target",target},{"recordDigest",digest},{"deletingDigest",deletingDigest},{"manifestSha256",manifest},{"sequence",sequence},{"newBirth",newBirth},{"inventorySha256",record.at("oldTreeDigest")},{"inventoryBirth",cacheHandleBirth(inventoryFile.value)},{"state","preflight"}};
      repairProtectedWrite("runtime_repair_cleanup",marker);repairProtectedWrite("prepare_runtime_repair",deleting);record=deleting;
    }else {
      if(mm::dump(cacheHandleBirth(inventoryFile.value))!=mm::dump(marker.at("inventoryBirth"))||record.at("oldTreeDigest").string()!=marker.at("inventorySha256").string())fail("PATH_UNSAFE");
      if(record.at("phase").string()=="activated"){auto deleting=record.object();deleting["phase"]="deleting";if(repairBytesDigest(mm::dump(deleting))!=marker.at("deletingDigest").string())fail("PEER_DENIED");repairProtectedWrite("prepare_runtime_repair",deleting);record=deleting;}
    }
    const bool initial=marker.at("state").string()=="preflight";
    if(initial||marker.at("state").string()=="deleting"){
      std::map<std::string,Handle> directories;std::map<std::string,HANDLE> retained;std::set<std::string> missingDirectories;std::set<std::wstring> known;const auto deadline=GetTickCount64()+25000;
      const auto lower=[](std::string value){std::transform(value.begin(),value.end(),value.begin(),[](unsigned char c){return static_cast<char>(tolower(c));});return value;};
      const auto parentHandle=[&](const std::string& relative)->HANDLE{if(relative.empty())return parents.back().value;const auto separator=relative.find_last_of('/');const auto parent=separator==std::string::npos?std::string{}:lower(relative.substr(0,separator));const auto found=retained.find(parent);if(found!=retained.end())return found->second;if(missingDirectories.contains(parent))return nullptr;fail("VAULT_CORRUPT");};
      for(const auto& entry:entries){if(GetTickCount64()>deadline)return Json::Object{{"state","pending"}};const auto path=repairRowPath(backup,entry.path);known.insert(path);
        if(entry.directory){const auto parent=parentHandle(entry.path);if(!parent){if(initial)fail("PATH_UNSAFE");missingDirectories.insert(lower(entry.path));continue;}auto handle=openCacheDeleteEntry(path,true,absent,busy,false,false,true,parent);if(busy)return Json::Object{{"state","pending"}};if(absent){if(initial)fail("PATH_UNSAFE");missingDirectories.insert(lower(entry.path));continue;}if(mm::dump(cacheHandleBirth(handle.value))!=mm::dump(entry.birth))fail("PATH_UNSAFE");retained.emplace(lower(entry.path),handle.value);directories.emplace(entry.path,std::move(handle));}
      }
      // Only inventory-listed objects may ever be removed. An added leaf or
      // directory makes cleanup fail closed; it is not recursively swept away.
      for(const auto& [relative,handle]:directories){
        for(const auto& row:enumerateNativeDirectory(handle.value)){const auto& name=row.name;if(row.attributes&FILE_ATTRIBUTE_REPARSE_POINT)fail("PATH_UNSAFE");const auto path=repairRowPath(backup,relative)+L"\\"+name;if(!known.contains(path))fail("PATH_UNSAFE");}
      }
      // Validate every existing recorded leaf before the first deletion. The
      // second pass validates again on the actual disposition handle.
      for(const auto& entry:entries){if(entry.directory)continue;if(GetTickCount64()>deadline)return Json::Object{{"state","pending"}};const auto path=repairRowPath(backup,entry.path);const auto parent=parentHandle(entry.path);if(!parent){if(initial)fail("PATH_UNSAFE");continue;}auto file=openCacheDeleteEntry(path,false,absent,busy,true,false,true,parent);if(busy)return Json::Object{{"state","pending"}};if(absent){if(initial)fail("PATH_UNSAFE");continue;}(void)repairFileMatches(file.value,entry);}
      if(initial){auto validated=marker.object();validated["state"]="deleting";repairProtectedWrite("runtime_repair_cleanup",validated);marker=validated;}
      for(const auto& entry:entries){if(entry.directory)continue;if(GetTickCount64()>deadline)return Json::Object{{"state","pending"}};const auto path=repairRowPath(backup,entry.path);const auto parent=parentHandle(entry.path);if(!parent){if(initial)fail("PATH_UNSAFE");continue;}auto file=openCacheDeleteEntry(path,false,absent,busy,true,false,true,parent);if(busy)return Json::Object{{"state","pending"}};if(absent){if(initial)fail("PATH_UNSAFE");continue;}(void)repairFileMatches(file.value,entry);if(!disposeRepairHandle(file,path,parent))return Json::Object{{"state","pending"}};}
      for(auto item=entries.rbegin();item!=entries.rend();++item){if(!item->directory)continue;const auto actual=directories.find(item->path);if(actual==directories.end())continue;if(!disposeRepairHandle(actual->second,repairRowPath(backup,item->path),parentHandle(item->path)))return Json::Object{{"state","pending"}};}
      auto updated=marker.object();updated["state"]="tree-deleted";repairProtectedWrite("runtime_repair_cleanup",updated);marker=updated;
    }
    if(marker.at("state").string()=="tree-deleted"){auto updated=marker.object();updated["state"]="inventory-deleting";repairProtectedWrite("runtime_repair_cleanup",updated);marker=updated;}
    if(marker.at("state").string()!="inventory-deleting")fail("VAULT_CORRUPT");if(!disposeRepairHandle(inventoryFile,sidecar,parents.back().value))return Json::Object{{"state","pending"}};
  }
  auto completed=marker.object();completed["state"]="completed";repairProtectedWrite("runtime_repair_cleanup",completed);
  // Completion proof is persisted first: an ACK loss or crash after deleting
  // the original WAL cannot turn an absent slot into invented authority.
  (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key","prepare_runtime_repair"}});return Json::Object{{"state","completed"}};
}
