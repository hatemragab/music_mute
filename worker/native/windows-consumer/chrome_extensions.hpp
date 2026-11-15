#pragma once

// User-requested Setup help only. App Paths locates Chrome; signed immutable
// bytes and Google publisher/product are authority, never an ambient Shell/PATH.
std::wstring registeredChromePath(){
  for(const auto hive:{HKEY_CURRENT_USER,HKEY_LOCAL_MACHINE}){
    std::wstring candidate;
    for(const REGSAM view:{KEY_WOW64_64KEY,KEY_WOW64_32KEY}){
      RegistryHandle key;const auto opened=RegOpenKeyExW(hive,L"Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",0,KEY_QUERY_VALUE|view,&key.key);
      if(opened==ERROR_FILE_NOT_FOUND)continue;if(opened!=ERROR_SUCCESS)fail("CHROME_UNAVAILABLE");
      wchar_t value[4097]{};DWORD bytes=sizeof(value),type=0;const auto read=RegQueryValueExW(key.key,nullptr,nullptr,&type,reinterpret_cast<BYTE*>(value),&bytes);
      if(read!=ERROR_SUCCESS||type!=REG_SZ||bytes<2||bytes>sizeof(value)||bytes%2||value[bytes/2-1]!=L'\0')fail("CHROME_UNAVAILABLE");
      const std::wstring path(value,bytes/2-1);if(path.find(L'\0')!=std::wstring::npos)fail("CHROME_UNAVAILABLE");
      (void)exportDiscardPath(utf8(path));if(path.size()<11||_wcsicmp(path.substr(path.find_last_of(L'\\')+1).c_str(),L"chrome.exe"))fail("CHROME_UNAVAILABLE");
      if(!candidate.empty()&&_wcsicmp(candidate.c_str(),path.c_str()))fail("CHROME_UNAVAILABLE");candidate=path;
    }
    // A current-user registration is authoritative over machine registration;
    // malformed/conflicting entries fail rather than selecting another browser.
    if(!candidate.empty())return candidate;
  }
  fail("CHROME_UNAVAILABLE");
}
bool chromeProductIdentity(const std::wstring& path){
  DWORD ignored=0;const auto size=GetFileVersionInfoSizeW(path.c_str(),&ignored);if(size<1||size>1024*1024)return false;
  std::vector<BYTE> bytes(size);if(!GetFileVersionInfoW(path.c_str(),0,size,bytes.data()))return false;
  struct Translation{WORD language;WORD codepage;};Translation* translations=nullptr;UINT count=0;
  if(!VerQueryValueW(bytes.data(),L"\\VarFileInfo\\Translation",reinterpret_cast<void**>(&translations),&count)||count<sizeof(Translation)||count>1024||count%sizeof(Translation))return false;
  for(unsigned n=0;n<count/sizeof(Translation);++n){wchar_t prefix[96]{};if(swprintf_s(prefix,L"\\StringFileInfo\\%04x%04x\\",translations[n].language,translations[n].codepage)<0)return false;
    const auto read=[&](const wchar_t* name,const wchar_t* expected){LPWSTR value=nullptr;UINT length=0;return VerQueryValueW(bytes.data(),(std::wstring(prefix)+name).c_str(),reinterpret_cast<void**>(&value),&length)&&length>0&&length<=256&&value[length-1]==L'\0'&&wcscmp(value,expected)==0;};
    if(read(L"ProductName",L"Google Chrome")&&read(L"OriginalFilename",L"chrome.exe")&&read(L"CompanyName",L"Google LLC"))return true;
  }return false;
}
Json openChromeExtensions(const Json& args){
  authorizeExportMain(args);const auto path=registeredChromePath();auto parents=lockExportParents(path);
  auto file=std::move(openNativeChild(parents.back().value,path.substr(path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open).handle);if(!file.valid())fail("CHROME_UNAVAILABLE");
  BY_HANDLE_FILE_INFORMATION info{};LARGE_INTEGER bytes{};check(GetFileInformationByHandle(file.value,&info)&&GetFileSizeEx(file.value,&bytes),"CHROME_UNAVAILABLE");if(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||info.nNumberOfLinks!=1||bytes.QuadPart<1||bytes.QuadPart>256LL*1024*1024)fail("CHROME_UNAVAILABLE");
  std::vector<wchar_t> canonical(32768);const auto size=GetFinalPathNameByHandleW(file.value,canonical.data(),static_cast<DWORD>(canonical.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);if(!size||size>=canonical.size())fail("CHROME_UNAVAILABLE");std::wstring actual(canonical.data(),size);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);if(_wcsicmp(actual.c_str(),path.c_str()))fail("CHROME_UNAVAILABLE");
  const auto sha=hashFile(file.value);if(!chromeProductIdentity(path))fail("CHROME_UNAVAILABLE");
  const auto approvedText=repairProtectedBytes("approved_chrome");Json approved=approvedText.empty()?Json(nullptr):mm::JsonParser(approvedText).parse();bool existing=false;
  if(!std::holds_alternative<std::nullptr_t>(approved.value)){keys(approved,{"version","path","sha256","bytes","publisherSha256"});existing=approved.at("version").integer()==1&&approved.at("path").string()==utf8(path)&&approved.at("sha256").string()==sha&&approved.at("bytes").integer()==bytes.QuadPart;}
  // x86 signed Chrome is a browser bootstrap, not a MusicMute runtime payload.
  // Native host/app/worker/model remain x64; ARM PEs are always refused.
  const auto publisher=trustedPePublisher(path,file.value,true,existing?PeTrustPolicy::ApprovedInstalledCache:PeTrustPolicy::FreshApproval,L"Google LLC");
  if(existing&&approved.at("publisherSha256").string()!=publisher)fail("CHROME_UNAVAILABLE");
  if(!existing)repairProtectedWrite("approved_chrome",Json::Object{{"version",1},{"path",utf8(path)},{"sha256",sha},{"bytes",bytes.QuadPart},{"publisherSha256",publisher}});
  auto command=quote(path)+L" chrome://extensions";auto environment=consumerEnvironment(path.substr(0,path.find_last_of(L'\\')));BOOL inJob=FALSE;check(IsProcessInJob(GetCurrentProcess(),nullptr,&inJob),"JOB_UNAVAILABLE");STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
  check(CreateProcessW(path.c_str(),command.data(),nullptr,nullptr,FALSE,CREATE_NEW_PROCESS_GROUP|CREATE_UNICODE_ENVIRONMENT|(inJob?CREATE_BREAKAWAY_FROM_JOB:0),environment.data(),path.substr(0,path.find_last_of(L'\\')).c_str(),&startup,&process),"CHROME_UNAVAILABLE");Handle child(process.hProcess),thread(process.hThread);
  // Existing Chrome may consume the fixed URL and exit this bootstrap quickly.
  // CreateProcess ACK means launched, never UI visibility or extension installed.
  return Json::Object{{"started",true}};
}
