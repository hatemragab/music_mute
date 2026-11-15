#pragma once

// The Share sheet is the only delivery mechanism. No recipient, URL, shell
// command or renderer-selected path is accepted by this boundary.
namespace transfer = winrt::Windows::ApplicationModel::DataTransfer;
namespace storage = winrt::Windows::Storage;
constexpr UINT shareTerminalMessage = WM_APP + 43;
constexpr UINT shareSourceMessage = WM_APP + 44;
struct NativeShare {
  std::mutex mutex;
  Json receipt;
  Json windowOwner;
  std::wstring path;
  HWND root = nullptr;
  HWND popup = nullptr;
  std::atomic<bool> fenced{false};
  std::atomic<bool> released{false};
  std::atomic<bool> sourceLoaded{false};
  std::atomic<bool> sourceFailed{false};
  storage::StorageFile storageFile{nullptr};
  Handle file;
  std::vector<Handle> ancestors;
};
std::mutex shareTableMutex;
std::map<std::string, std::shared_ptr<NativeShare>> nativeShares;
std::string shareRequestId(const Json& args) {
  const auto id = args.at("request_id").string();
  static const std::regex pattern("^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$");
  if(!std::regex_match(id,pattern))fail("BAD_REQUEST");return id;
}
std::string shareVaultKey(const std::string& id) {
  std::string key="share_";for(const char c:id)if(c!='-')key+=c;return key;
}
void saveShareReceipt(const Json& receipt) {
  const auto text=mm::dump(receipt);
  (void)vault("vault_put",Json::Object{{"namespace","account"},{"key",shareVaultKey(receipt.at("request_id").string())},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()))}});
}
Json loadShareReceipt(const std::string& id) {
  const auto row=vault("vault_get",Json::Object{{"namespace","account"},{"key",shareVaultKey(id)}});
  if(jsonNull(row))return nullptr;
  auto bytes=base64Decode(row.at("bytes_base64").string(),8192);
  const auto text=std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size());
  SecureZeroMemory(bytes.data(),bytes.size());
  const auto receipt=mm::JsonParser(text).parse();
  keys(receipt,{"version","request_id","nonce","helper","window_owner","relative_path","sha256","bytes","file_identity","state","shown","quiesced","callback"});
  if(receipt.at("version").integer()!=1||receipt.at("request_id").string()!=id||receipt.at("window_owner").at("sid").string()!=currentIdentity().sid)fail("VAULT_CORRUPT");
  const auto nonce=receipt.at("nonce").string(),digest=receipt.at("sha256").string(),state=receipt.at("state").string(),relative=receipt.at("relative_path").string();
  const auto prefix="share\\requests\\"+id+"\\media.";
  static const std::set<std::string> extensions{"mp3","m4a","webm","ogg","aac","wav","flac"};
  if(nonce.size()!=64||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos||digest.size()!=64||digest.find_first_not_of("0123456789abcdef")!=std::string::npos||
    receipt.at("bytes").integer()<1||receipt.at("bytes").integer()>256*1024*1024||!relative.starts_with(prefix)||!extensions.contains(relative.substr(prefix.size()))||
    (state!="pending"&&state!="unconfirmed"&&state!="completed"&&state!="cancelled")||!std::holds_alternative<bool>(receipt.at("shown").value)||!std::holds_alternative<bool>(receipt.at("quiesced").value))fail("VAULT_CORRUPT");
  for(const auto name:{"helper","window_owner"}){
    const auto& peer=receipt.at(name);keys(peer,{"sid","session_id","pid","creation_time"});
    const auto birth=peer.at("creation_time").string();
    if(peer.at("sid").string()!=currentIdentity().sid||peer.at("session_id").integer()<1||peer.at("pid").integer()<1||peer.at("pid").integer()>2147483647||birth.empty()||birth.size()>20||birth.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");
  }
  if(receipt.at("helper").at("session_id").integer()!=receipt.at("window_owner").at("session_id").integer())fail("VAULT_CORRUPT");
  const auto& file=receipt.at("file_identity");keys(file,{"volume_serial","file_index","creation_time"});
  if(file.at("volume_serial").integer()<0||file.at("volume_serial").integer()>0xffffffffLL)fail("VAULT_CORRUPT");
  for(const auto name:{"file_index","creation_time"}){const auto decimal=file.at(name).string();if(decimal.empty()||decimal.size()>20||decimal[0]=='0'||decimal.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");try{(void)std::stoull(decimal);}catch(...){fail("VAULT_CORRUPT");}}
  const auto callback=receipt.at("callback");
  if((state=="completed"&&(!std::holds_alternative<std::string>(callback.value)||callback.string()!="ShareCompleted"))||(state=="cancelled"&&(!std::holds_alternative<std::string>(callback.value)||callback.string()!="ShareCanceled"))||
    ((state=="pending"||state=="unconfirmed")&&(!jsonNull(callback)||std::get<bool>(receipt.at("quiesced").value))))fail("VAULT_CORRUPT");
  return receipt;
}
Json shareFileIdentity(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file,&info),"PATH_UNSAFE");
  return Json::Object{{"volume_serial",static_cast<std::int64_t>(info.dwVolumeSerialNumber)},
    {"file_index",std::to_string((static_cast<std::uint64_t>(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},
    {"creation_time",std::to_string((static_cast<std::uint64_t>(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime)}};
}
void authorizeShareCaller(const Json& pin) {
  auto args=pin.object();args.emplace("identity",processIdentity(GetCurrentProcessId()));args.emplace("role","authority");
  (void)verifyAccountPeer(args);
}
bool liveShareWindow(const std::shared_ptr<NativeShare>& row) {
  if(!IsWindow(row->root))return false;DWORD pid=0;GetWindowThreadProcessId(row->root,&pid);
  try{return pid==row->windowOwner.at("pid").integer()&&mm::dump(processIdentity(pid))==mm::dump(row->windowOwner);}catch(...){return false;}
}
void emitShareReceipt(const Json& receipt) {
  std::lock_guard lock(outputMutex);
  const auto event=Json::Object{{"kind","share"},{"receipt",receipt},{"sequence",static_cast<std::int64_t>(++eventSequence)}};
  std::cout<<mm::dump(Json::Object{{"version",1},{"event",event}})<<'\n'<<std::flush;
}
void shareUpdate(const std::shared_ptr<NativeShare>& row,const std::string& state,const Json& callback,bool shown,bool quiesced) {
  std::lock_guard lock(row->mutex);
  const auto previousState=row->receipt.at("state").string();
  if((previousState=="completed"||previousState=="cancelled")&&state!=previousState)return;
  if(std::get<bool>(row->receipt.at("quiesced").value)&&!quiesced)return;
  auto value=row->receipt.object();value["state"]=state;value["callback"]=callback;value["shown"]=shown;value["quiesced"]=quiesced;
  const Json next(value);saveShareReceipt(next);row->receipt=next;emitShareReceipt(next);
}
bool shareQuiescence(const std::wstring& path,const Json& receipt) {
  // An actual terminal OS callback is necessary before probing file handles.
  const auto state=receipt.at("state").string();
  if((state!="completed"||receipt.at("callback").string()!="ShareCompleted")&&(state!="cancelled"||receipt.at("callback").string()!="ShareCanceled"))return false;
  auto file=std::move(openNativePath(path,GENERIC_READ|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::open,nullptr,false,true).handle);
  if(!file.valid())return false;
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file.value,&info),"PATH_UNSAFE");
  if((info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))||info.nNumberOfLinks!=1||mm::dump(shareFileIdentity(file.value))!=mm::dump(receipt.at("file_identity")))fail("PATH_UNSAFE");
  assertPrivateHandle(file.value);
  LARGE_INTEGER size{};check(GetFileSizeEx(file.value,&size),"PATH_UNSAFE");
  if(size.QuadPart!=receipt.at("bytes").integer()||hashFile(file.value)!=receipt.at("sha256").string())fail("PATH_UNSAFE");
  return true;
}
LRESULT CALLBACK shareWindowProcedure(HWND window,UINT message,WPARAM wparam,LPARAM lparam) {
  if(message==WM_CLOSE)return 0; // A window-close request is not ShareCanceled.
  return DefWindowProcW(window,message,wparam,lparam);
}
winrt::fire_and_forget loadShareSource(std::shared_ptr<NativeShare> row) {
  try {
    if(row->fenced||!liveShareWindow(row))throw winrt::hresult_error(E_ACCESSDENIED);
    auto file=co_await storage::StorageFile::GetFileFromPathAsync(row->path);
    if(row->fenced||!liveShareWindow(row))throw winrt::hresult_error(E_ACCESSDENIED);
    row->storageFile=file;row->sourceLoaded=true;
  }catch(...){row->fenced=true;row->sourceFailed=true;}
  // No exception may escape fire_and_forget. Resolve the StorageFile before
  // showing UI, so DataRequested's 200 ms budget never includes path lookup.
  (void)PostMessageW(row->popup,shareSourceMessage,0,0);
}
void runNativeShare(std::shared_ptr<NativeShare> row,std::string title) {
  bool initialized=false;transfer::DataTransferManager manager{nullptr};transfer::DataPackage package{nullptr};
  winrt::event_token requested{},completed{},cancelled{};bool hasRequested=false,hasPackage=false;
  try {
    winrt::init_apartment(winrt::apartment_type::single_threaded);initialized=true;
    WNDCLASSW wc{};wc.lpfnWndProc=shareWindowProcedure;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"MusicMutePrivateShareSource";
    if(!RegisterClassW(&wc)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)fail("SHARE_UNAVAILABLE");
    row->popup=CreateWindowExW(WS_EX_TOOLWINDOW,wc.lpszClassName,L"MusicMute Share",WS_POPUP,0,0,1,1,row->root,nullptr,wc.hInstance,nullptr);
    if(!row->popup||!liveShareWindow(row))fail("PEER_DENIED");
    loadShareSource(row);
    MSG loading{};
    while(!row->sourceLoaded&&!row->sourceFailed){if(GetMessageW(&loading,nullptr,0,0)<=0)fail("SHARE_UNAVAILABLE");TranslateMessage(&loading);DispatchMessageW(&loading);}
    if(row->sourceFailed||row->fenced||!row->storageFile||!liveShareWindow(row))fail("SHARE_UNAVAILABLE");
    const auto foreground=GetForegroundWindow();
    if(foreground!=row->root&&GetAncestor(foreground,GA_ROOTOWNER)!=row->root)fail("PEER_DENIED");
    auto interop=winrt::get_activation_factory<transfer::DataTransferManager,IDataTransferManagerInterop>();
    winrt::check_hresult(interop->GetForWindow(row->popup,winrt::guid_of<transfer::DataTransferManager>(),winrt::put_abi(manager)));
    package=transfer::DataPackage();package.RequestedOperation(transfer::DataPackageOperation::Copy);package.Properties().Title(wide(title));
    auto items=winrt::single_threaded_vector<storage::IStorageItem>();items.Append(row->storageFile);package.SetStorageItems(items.GetView(),true);
    completed=package.ShareCompleted([row](auto const&,auto const&){row->fenced=true;try{shareUpdate(row,"completed","ShareCompleted",true,false);}catch(...){}PostMessageW(row->popup,shareTerminalMessage,0,0);});
    cancelled=package.ShareCanceled([row](auto const&,auto const&){row->fenced=true;try{shareUpdate(row,"cancelled","ShareCanceled",true,false);}catch(...){}PostMessageW(row->popup,shareTerminalMessage,0,0);});hasPackage=true;
    requested=manager.DataRequested([row,package](auto const&,transfer::DataRequestedEventArgs const& args){
      try{if(row->fenced||!liveShareWindow(row))throw winrt::hresult_error(E_ACCESSDENIED);args.Request().Data(package);}
      catch(...){row->fenced=true;try{args.Request().FailWithDisplayText(L"The selected audio is no longer available.");}catch(...){}}
    });hasRequested=true;
    if(row->fenced||!liveShareWindow(row))fail("PEER_DENIED");
    winrt::check_hresult(interop->ShowShareUIForWindow(row->popup));shareUpdate(row,"pending",nullptr,true,false);
    MSG message{};bool terminal=false;
    while(GetMessageW(&message,nullptr,0,0)>0){
      if(message.hwnd==row->popup&&message.message==shareTerminalMessage){
        std::lock_guard lock(row->mutex);const auto state=row->receipt.at("state").string();terminal=state=="completed"||state=="cancelled";
        if(terminal)break;
      }
      TranslateMessage(&message);DispatchMessageW(&message);
    }
    row->fenced=true;
    if(hasRequested){manager.DataRequested(requested);hasRequested=false;}
    if(hasPackage){package.ShareCompleted(completed);package.ShareCanceled(cancelled);hasPackage=false;}
    package=nullptr;manager=nullptr;items.Clear();row->storageFile=nullptr;row->file.close();row->ancestors.clear();row->released=true;
    Json snapshot;{std::lock_guard lock(row->mutex);snapshot=row->receipt;}
    if(terminal){
      // Win32 provides no notification that another process closed its file
      // handle. Reconcile only this already-terminal private copy, bounded to
      // five minutes; this is not a job/status HTTP poll or TTL cleanup.
      const auto deadline=GetTickCount64()+300000;
      do{
        if(shareQuiescence(row->path,snapshot)){shareUpdate(row,snapshot.at("state").string(),snapshot.at("callback"),true,true);break;}
        if(GetTickCount64()>=deadline)break;
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }while(true);
    }
  }catch(...){
    row->fenced=true;
    try {std::lock_guard lock(row->mutex);if(row->receipt.at("state").string()=="pending"){auto next=row->receipt.object();next["state"]="unconfirmed";saveShareReceipt(next);row->receipt=next;emitShareReceipt(next);}}catch(...){}
  }
  try{if(hasRequested){manager.DataRequested(requested);hasRequested=false;}if(hasPackage){package.ShareCompleted(completed);package.ShareCanceled(cancelled);hasPackage=false;}}catch(...){}
  package=nullptr;manager=nullptr;row->storageFile=nullptr;row->file.close();row->ancestors.clear();
  if(!hasRequested&&!hasPackage&&(row->sourceLoaded||row->sourceFailed))row->released=true;
  if(row->popup)DestroyWindow(row->popup);if(initialized)winrt::uninit_apartment();
}
bool shareCopyAbsentAfterCompletion(const Json& receipt) {
  const auto state=receipt.at("state").string();
  if((state!="completed"&&state!="cancelled")||!std::get<bool>(receipt.at("quiesced").value))return false;
  const auto root=rootPath("personal"),base=root+L"\\share\\requests";
  auto ancestors=lockAncestors(base,false,true,root);
  const auto path=root+L"\\"+wide(receipt.at("relative_path").string());
  return nativePathMissing(path,true);
}
Json pruneNativeShareReceipts() {
  VaultNamespaceLock records("account");
  const auto root=rootPath("personal"),directory=root+L"\\vault\\account";
  auto ancestors=lockAncestors(directory,true,true,root);
  unsigned removed=0,retained=0,scanned=0;
  for(const auto& found:enumerateNativeDirectory(ancestors.back().value)){
    if(!PathMatchSpecW(found.name.c_str(),L"share_*.dpapi"))continue;
    if(++scanned>80)fail("SHARE_BUSY");const auto name=utf8(found.name);
    if(name.size()!=44||!name.starts_with("share_")||!name.ends_with(".dpapi")||found.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))fail("VAULT_CORRUPT");
    const auto hex=name.substr(6,32);if(hex.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("VAULT_CORRUPT");
    const auto id=hex.substr(0,8)+"-"+hex.substr(8,4)+"-"+hex.substr(12,4)+"-"+hex.substr(16,4)+"-"+hex.substr(20,12);
    (void)shareRequestId(Json::Object{{"request_id",id}});const auto receipt=loadShareReceipt(id);
    if(!jsonNull(receipt)&&removed<16&&shareCopyAbsentAfterCompletion(receipt)){
      (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",shareVaultKey(id)}});++removed;
    }else ++retained;
  }if(retained>64)fail("SHARE_BUSY");
  return Json::Object{{"removed",static_cast<std::int64_t>(removed)},{"retained",static_cast<std::int64_t>(retained)}};
}
void authorizeNativeShareDataCaller(bool store) {
  if(store) { if(!authorizeStoreGuiPrivateDataCaller())fail("PEER_DENIED"); }
  else authorizeShareCaller(installedAccountAppPin());
}
Json acknowledgeNativeShareCleanup(const Json& args,bool store=false) {
  authorizeNativeShareDataCaller(store);const auto id=shareRequestId(args),nonce=args.at("nonce").string();
  if(nonce.size()!=64||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");
  VaultNamespaceLock records("account");const auto receipt=loadShareReceipt(id);
  if(jsonNull(receipt))return Json::Object{{"removed",false}};
  if(!equalSecret(receipt.at("nonce").string(),nonce))fail("PEER_DENIED");
  if(!shareCopyAbsentAfterCompletion(receipt))return Json::Object{{"removed",false}};
  (void)vault("vault_delete",Json::Object{{"namespace","account"},{"key",shareVaultKey(id)}});
  return Json::Object{{"removed",true}};
}
Json startNativeShare(const Json& args,bool store=false) {
  const auto id=shareRequestId(args);
  if(store)authorizeNativeShareDataCaller(true);
  else authorizeShareCaller(Json::Object{{"app_sha256",args.at("app_sha256")},{"app_bytes",args.at("app_bytes")},{"publisher_sha256",args.at("publisher_sha256")}});
  const auto parent=parentBinding(processIdentity(GetCurrentProcessId())).parent;
  if(mm::dump(parent)!=mm::dump(args.at("window_owner")))fail("PEER_DENIED");
  const auto relative=args.at("relative_path").string();const auto prefix="share\\requests\\"+id+"\\media.";
  static const std::map<std::string,std::string> mimes{{"mp3","audio/mpeg"},{"m4a","audio/mp4"},{"webm","audio/webm"},{"ogg","audio/ogg"},{"aac","audio/aac"},{"wav","audio/wav"},{"flac","audio/flac"}};
  if(!relative.starts_with(prefix))fail("BAD_REQUEST");const auto extension=relative.substr(prefix.size());
  if(!mimes.contains(extension)||mimes.at(extension)!=args.at("mime").string()||args.at("bytes").integer()<1||args.at("bytes").integer()>256*1024*1024||args.at("title").string().empty()||args.at("title").string().size()>180)fail("BAD_REQUEST");
  const auto title=args.at("title").string();for(const unsigned char c:title)if(c<32||c==127)fail("BAD_REQUEST");(void)wide(title);
  const auto text=args.at("window_handle").string();if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("BAD_REQUEST");
  std::uint64_t number=0;try{number=std::stoull(text);}catch(...){fail("BAD_REQUEST");}if(number==0)fail("BAD_REQUEST");
  std::lock_guard table(shareTableMutex);
  // The account namespace mutex serializes the persistent slot bound across
  // the app's dedicated per-request helpers. Windows mutex nesting is recursive.
  VaultNamespaceLock records("account");
  const auto budget=pruneNativeShareReceipts();
  const auto previous=loadShareReceipt(id);
  if(!jsonNull(previous)){
    if(previous.at("relative_path").string()!=relative||previous.at("sha256").string()!=args.at("sha256").string()||previous.at("bytes").integer()!=args.at("bytes").integer()||mm::dump(previous.at("window_owner"))!=mm::dump(parent))fail("PEER_DENIED");return previous;
  }
  if(budget.at("retained").integer()>=64)fail("SHARE_BUSY");
  if(nativeShares.size()>=16)fail("SHARE_BUSY");
  auto row=std::make_shared<NativeShare>();row->windowOwner=parent;row->root=reinterpret_cast<HWND>(static_cast<std::uintptr_t>(number));
  const auto root=rootPath("personal");row->path=root+L"\\"+wide(relative);
  row->ancestors=lockAncestors(row->path,false,false,root);row->file=lockHashedFile(row->path,args.at("sha256").string());
  LARGE_INTEGER size{};check(GetFileSizeEx(row->file.value,&size),"PATH_UNSAFE");if(size.QuadPart!=args.at("bytes").integer())fail("PATH_UNSAFE");
  row->receipt=Json::Object{{"version",1},{"request_id",id},{"nonce",randomHex()},{"helper",processIdentity(GetCurrentProcessId())},{"window_owner",parent},{"relative_path",relative},{"sha256",args.at("sha256")},{"bytes",args.at("bytes")},{"file_identity",shareFileIdentity(row->file.value)},{"state","pending"},{"shown",false},{"quiesced",false},{"callback",nullptr}};
  if(!liveShareWindow(row))fail("PEER_DENIED");saveShareReceipt(row->receipt);nativeShares.emplace(id,row);
  const auto receipt=row->receipt;std::thread(runNativeShare,row,title).detach();return receipt;
}
Json inspectNativeShare(const Json& args,bool store=false) {
  authorizeNativeShareDataCaller(store);const auto id=shareRequestId(args);
  std::lock_guard table(shareTableMutex);auto receipt=loadShareReceipt(id);if(jsonNull(receipt))return nullptr;
  if(!std::get<bool>(receipt.at("quiesced").value)&&(receipt.at("state").string()=="completed"||receipt.at("state").string()=="cancelled")){
    const auto owned=nativeShares.find(id);
    if(owned!=nativeShares.end()){if(!owned->second->released)return receipt;}
    else {const auto helper=receipt.at("helper");const auto actual=processIdentity(static_cast<DWORD>(helper.at("pid").integer()),true);if(!jsonNull(actual)&&mm::dump(actual)==mm::dump(helper))return receipt;}
    const auto root=rootPath("personal"),path=root+L"\\"+wide(receipt.at("relative_path").string());auto ancestors=lockAncestors(path,false,false,root);
    if(shareQuiescence(path,receipt)){auto next=receipt.object();next["quiesced"]=true;receipt=next;saveShareReceipt(receipt);}
  }
  return receipt;
}
Json cancelNativeShare(const Json& args,bool store=false) {
  authorizeNativeShareDataCaller(store);const auto id=shareRequestId(args);const auto nonce=args.at("nonce").string();if(nonce.size()!=64||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");
  std::lock_guard table(shareTableMutex);const auto receipt=loadShareReceipt(id);if(jsonNull(receipt)||!equalSecret(receipt.at("nonce").string(),nonce))fail("PEER_DENIED");
  const auto found=nativeShares.find(id);if(found!=nativeShares.end())found->second->fenced=true;
  // Do not synthesize the OS event, close a recipient or authorize file deletion.
  return receipt;
}
