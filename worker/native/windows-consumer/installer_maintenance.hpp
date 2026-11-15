#pragma once

bool signedInstallerMarker(const std::wstring& path,const wchar_t* marker) {
  DWORD ignored=0;const auto size=GetFileVersionInfoSizeW(path.c_str(),&ignored);
  if(size<1||size>65536)return false;
  std::vector<BYTE> bytes(size);if(!GetFileVersionInfoW(path.c_str(),0,size,bytes.data()))return false;
  struct Translation {WORD language;WORD codePage;};Translation* translations=nullptr;UINT count=0;
  if(!VerQueryValueW(bytes.data(),L"\\VarFileInfo\\Translation",reinterpret_cast<void**>(&translations),&count)||count<sizeof(Translation)||count>1024||count%sizeof(Translation))return false;
  for(UINT n=0;n<count/sizeof(Translation);++n) {
    wchar_t prefix[64]{};swprintf_s(prefix,L"\\StringFileInfo\\%04x%04x\\",translations[n].language,translations[n].codePage);
    const auto read=[&](const wchar_t* name,const wchar_t* expected){LPWSTR value=nullptr;UINT length=0;return VerQueryValueW(bytes.data(),(std::wstring(prefix)+name).c_str(),reinterpret_cast<void**>(&value),&length)&&length>0&&length<=256&&value[length-1]==L'\0'&&wcscmp(value,expected)==0;};
    if(read(L"ProductName",L"MusicMute Local")&&read(L"OriginalFilename",marker))return true;
  }
  return false;
}
Json verifyInstallerMaintenancePeer(const Json& args) {
  const auto action=args.at("action").string();if(action!="install"&&action!="uninstall")fail("BAD_REQUEST");
  const auto peer=args.at("identity");const auto caller=parentBinding(peer);
  const auto entry=fixedBrowserEntryPath(),helperPath=entry.substr(0,entry.find_last_of(L'\\'))+L"\\musicmute-native.exe";
  if(_wcsicmp(caller.image.c_str(),helperPath.c_str())!=0||_wcsicmp(liveAccountPeerImage(caller.parent).c_str(),fixedAccountAppPath().c_str())!=0)fail("PEER_DENIED");
  auto appAncestors=lockAccountAppAncestors(fixedAccountAppPath());auto app=verifiedAccountApp(args);
  const auto issuer=parentBinding(caller.parent).parent;const auto path=liveAccountPeerImage(issuer);
  auto initial=std::move(openNativePath(path,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file).handle);if(!initial.valid())fail("PEER_DENIED");
  const auto digest=hashFile(initial.value,2ULL*1024*1024*1024);auto executable=lockHashedFile(path,digest,true,2ULL*1024*1024*1024);
  verifyInstallerPublisher(path,executable.value,args.at("publisher_sha256").string(),true);
  const auto marker=action=="install"?L"MusicMuteLocalSetup.exe":L"MusicMuteLocalUninstall.exe";
  if(!signedInstallerMarker(path,marker))fail("PEER_DENIED");
  Json nonce=nullptr;
  if(action=="install") {
    const auto record=readInstallerCertificate();
    if(!jsonNull(record)&&record.at("state").string()!="completed") {
      const auto& process=record.at("process");
      if(jsonNull(process)||process.at("session_id").integer()!=currentIdentity().session)fail("PEER_DENIED");
      const auto name=L"Local\\MusicMuteInstaller-v1-"+wide(currentIdentity().sid)+L"-"+std::to_wstring(currentIdentity().session)+L"-"+wide(record.at("nonce").string());
      Handle job(OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,name.c_str()));if(!job.valid())fail("PEER_DENIED");
      auto actual=exactInstallerProcess(issuer);BOOL belongs=FALSE;
      if(!actual.valid()||!IsProcessInJob(actual.value,job.value,&belongs)||!belongs)fail("PEER_DENIED");
      nonce=record.at("nonce");
    }
  }
  if(mm::dump(processIdentity(static_cast<DWORD>(issuer.at("pid").integer())))!=mm::dump(issuer))fail("PEER_DENIED");
  return Json::Object{{"authorized",true},{"issuer",issuer},{"certificate_nonce",nonce}};
}
