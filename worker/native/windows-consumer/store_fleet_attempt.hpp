#pragma once
#include "store_fleet_policy.hpp"
#include "store_child_handle.hpp"
#include <set>
// Included after main.cpp. Only the actual Creator registers this owner;
// receiving expectations cannot construct it or adopt a foreign directory.
namespace mmstorerole {
class StoreSessionCreator;
class StoreFleetAttemptDirectory final {
 private:
  struct Entry { ::Handle handle; Json birth = nullptr; bool submitted = false, closed = false; NativeChildKind kind; std::wstring path, leaf; };
  StoreFleetAttemptDirectory(std::string id, std::string extension, std::string nonce, Json nodeOwner, std::string inventory, std::string manifest)
    : id_(std::move(id)), extension_(std::move(extension)), ownerNonce_(std::move(nonce)), token_(detail::secret()), inventory_(std::move(inventory)), manifest_(std::move(manifest)),
      key_("store_attempt_" + id_), nodeOwner_(std::move(nodeOwner)), root_(rootPath("fleet") + L"\\work\\" + wide(id_)) {}
  void persist(const std::string& state) {
    auto row = Json::Object{{"version",1},{"kind","store-fleet-attempt"},{"token",token_},{"attempt_id",id_},{"extension",extension_},
      {"node_owner",nodeOwner_},{"inventory_sha256",inventory_},{"runtime_manifest_sha256",manifest_},{"state",state},
      {"directory_birth",directory_.birth}};
    const auto encoded = mm::dump(row);
    // Keep both original intent/admitted bytes before their writes. A failed
    // put may have committed either exact private record, never a foreign row.
    journalRecords_.insert(encoded);
    durable_=true;
    (void)vault("vault_put",Json::Object{{"namespace","fleet"},{"key",key_},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(encoded.data()),static_cast<DWORD>(encoded.size()))}});
    intentCommitted_=true;
  }
  void open() {
    require(!retired_ && !attempted_, ErrorCode::processDenied);
    const auto prior = vault("vault_get",Json::Object{{"namespace","fleet"},{"key",key_}});
    require(std::holds_alternative<std::nullptr_t>(prior.value),ErrorCode::processDenied);
    persist("intent");
    // This walker adopts every raw original slot before validation and retains
    // a partial validated prefix. No temporary vector can lose a failed close.
    holdStorePrivateDirectories(rootPath("fleet") + L"\\work",rootPath("fleet"),parents_);
    require(!parents_.empty(),ErrorCode::pathDenied);
    directory_.kind = NativeChildKind::directory; directory_.path = root_; directory_.leaf = wide(id_);
    Security security(dataSddl()); attempted_ = true;
    const auto opened = openNativeChild(parents_.back().value,directory_.leaf,DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY|FILE_TRAVERSE,
      FILE_SHARE_READ|FILE_SHARE_WRITE,NativeChildKind::directory,NativeChildDisposition::createNew,security.descriptor,false,&directory_.handle);
    require(opened.status == 0 && directory_.handle.valid(),ErrorCode::pathDenied);
    validate(directory_); directory_.birth = cacheHandleBirth(directory_.handle.value);
    require(nativeChildMissing(directory_.handle.value,L"output"),ErrorCode::pathDenied);
    auto output = std::make_shared<Entry>(); output->kind = NativeChildKind::directory; output->path = root_ + L"\\output"; output->leaf = L"output"; entries_.emplace(output->path,output);
    const auto child = openNativeChild(directory_.handle.value,L"output",DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY|FILE_TRAVERSE,
      FILE_SHARE_READ|FILE_SHARE_WRITE,NativeChildKind::directory,NativeChildDisposition::createNew,security.descriptor,false,&output->handle);
    require(child.status == 0 && output->handle.valid(),ErrorCode::pathDenied); validate(*output); output->birth = cacheHandleBirth(output->handle.value);
    persist("admitted"); admitted_ = true;
  }
  static void validate(Entry& entry) {
    require(entry.handle.valid(),ErrorCode::pathDenied); nativeEntryInformation(entry.handle.value,entry.kind); assertPrivateHandle(entry.handle.value);
    require(_wcsicmp(nativeCanonical(entry.handle.value).c_str(),entry.path.c_str()) == 0,ErrorCode::pathDenied);
    if (!std::holds_alternative<std::nullptr_t>(entry.birth.value)) require(mm::dump(cacheHandleBirth(entry.handle.value)) == mm::dump(entry.birth),ErrorCode::pathDenied);
  }
  Json expectation() {
    require(admitted_ && !std::holds_alternative<std::nullptr_t>(directory_.birth.value),ErrorCode::processDenied);
    return Json::Object{{"version",1},{"distribution","microsoft-store"},{"kind","fleet-attempt"},{"attemptId",id_},{"token",token_},
      {"inventorySha256",inventory_},{"runtimeManifestSha256",manifest_},{"nodeOwner",nodeOwner_},{"directoryBirth",directory_.birth}};
  }
  Json reply() {
    require(admitted_ && !retired_,ErrorCode::processDenied); validate(directory_);
    return Json::Object{{"expectation",expectation()},{"root",utf8(root_)},{"input",utf8(root_+L"\\input."+wide(extension_))},{"output",utf8(root_+L"\\output\\vocals.mp3")}};
  }
  void dispose(Entry& entry,HANDLE parent,std::size_t depth,std::size_t& count) {
    require(depth <= 8 && ++count <= 10000,ErrorCode::pathDenied);
    if (entry.closed) { require(nativeChildMissing(parent,entry.leaf),ErrorCode::pathDenied); return; }
    validate(entry); if (std::holds_alternative<std::nullptr_t>(entry.birth.value)) entry.birth=cacheHandleBirth(entry.handle.value);
    if (entry.kind == NativeChildKind::directory) {
      const auto children = enumerateNativeDirectory(entry.handle.value,10000);
      for (const auto& child : children) {
        const auto path = entry.path + L"\\" + child.name;
        auto found = entries_.find(path);
        if (found == entries_.end()) {
          auto retained = std::make_shared<Entry>(); retained->kind = (child.attributes&FILE_ATTRIBUTE_DIRECTORY)?NativeChildKind::directory:NativeChildKind::file;
          retained->path = path; retained->leaf = child.name; found = entries_.emplace(path,retained).first;
        }
        auto& retained = *found->second;
        require(!retained.closed,ErrorCode::pathDenied);
        if (!retained.handle.valid()) {
          const auto opened = openNativeChild(entry.handle.value,retained.leaf,DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|(retained.kind==NativeChildKind::directory?FILE_LIST_DIRECTORY|FILE_TRAVERSE:0),
            FILE_SHARE_READ|FILE_SHARE_WRITE,retained.kind,NativeChildDisposition::open,nullptr,false,&retained.handle);
          require(opened.status==0 && retained.handle.valid(),ErrorCode::pathDenied);
        }
        dispose(retained,entry.handle.value,depth+1,count);
      }
      require(enumerateNativeDirectory(entry.handle.value,1).empty(),ErrorCode::pathDenied);
    }
    if (!entry.submitted) { FILE_DISPOSITION_INFO deletion{TRUE}; require(SetFileInformationByHandle(entry.handle.value,FileDispositionInfo,&deletion,sizeof(deletion)),ErrorCode::pathDenied); entry.submitted=true; }
    mmstorechild::closeOwned(entry.handle.value); entry.closed=true; require(nativeChildMissing(parent,entry.leaf),ErrorCode::pathDenied);
  }
  void retire() {
    if (retired_) return;
    require(!processingInput_.valid(),ErrorCode::processDenied);
    // Caller proves original transfer/processing quiescence under Creator lock.
    if (!directoryMissing_ && directory_.handle.valid()) { std::size_t count=0; dispose(directory_,parents_.back().value,0,count); directoryMissing_=true; }
    else if (!directoryMissing_ && directory_.closed) { require(!parents_.empty() && parents_.back().valid() && nativeChildMissing(parents_.back().value,directory_.leaf),ErrorCode::pathDenied); directoryMissing_=true; }
    // No create-new handle means this owner never owned an existing UUID leaf.
    // In particular a collision is not permission to enumerate or delete it.
    require(!directory_.handle.valid(),ErrorCode::pathDenied);
    for (auto& [path,entry]:entries_) { (void)path; require(!entry->handle.valid(),ErrorCode::pathDenied); }
    if (durable_) { const auto original=vault("vault_get",Json::Object{{"namespace","fleet"},{"key",key_}});
      if(std::holds_alternative<std::nullptr_t>(original.value)) {
        // Absence can settle only this owner's failed pre-effect intent or
        // the exact original delete attempt after owned leaf retirement.
        require((!intentCommitted_ && !attempted_) || (journalDeleteAttempted_ && (!directory_.closed || directoryMissing_)),ErrorCode::processDenied);
        durable_=false;
      } else {
        const auto bytes=base64Decode(original.at("bytes_base64").string(),16384); const auto record=mm::JsonParser(std::string(bytes.begin(),bytes.end())).parse();
        require(journalRecords_.contains(mm::dump(record)),ErrorCode::processDenied);
        journalDeleteAttempted_=true;
        (void)vault("vault_delete",Json::Object{{"namespace","fleet"},{"key",key_}}); durable_=false;
      }
    }
    // Keep original anchors through journal recovery. After the positive
    // missing witness/clear, partial checked closes retry without reopening.
    for (auto it=parents_.rbegin();it!=parents_.rend();++it) mmstorechild::closeOwned(it->value);
    retired_=true;
  }
  std::string id_,extension_,ownerNonce_,token_,inventory_,manifest_,key_;
  Json nodeOwner_; std::wstring root_; std::vector<::Handle> parents_; Entry directory_{};
  std::map<std::wstring,std::shared_ptr<Entry>> entries_;
  std::set<std::string> journalRecords_;
  ::Handle processingInput_;Json processingBirth_=nullptr;std::string processingIncarnation_,processingRequest_;
  bool attempted_=false,durable_=false,intentCommitted_=false,admitted_=false,retired_=false,directoryMissing_=false,journalDeleteAttempted_=false;
  friend class StoreSessionCreator;
};
} // namespace mmstorerole
