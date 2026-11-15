#pragma once

bool releaseUsed(const std::wstring& root) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));if(!snapshot.valid())fail("IDENTITY_UNAVAILABLE");PROCESSENTRY32W row{};row.dwSize=sizeof(row);if(!Process32FirstW(snapshot.value,&row))fail("IDENTITY_UNAVAILABLE");unsigned count=0;
  do {if(++count>16384)fail("IDENTITY_UNAVAILABLE");const std::wstring name=row.szExeFile;if(_wcsicmp(name.c_str(),L"node.exe")&&_wcsicmp(name.c_str(),L"python.exe")&&_wcsicmp(name.c_str(),L"ffmpeg.exe")&&_wcsicmp(name.c_str(),L"ffprobe.exe")&&_wcsicmp(name.c_str(),L"yt-dlp.exe")&&_wcsicmp(name.c_str(),L"musicmute-native.exe"))continue;
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,row.th32ProcessID));if(!process.valid()){if(GetLastError()==ERROR_INVALID_PARAMETER)continue;return true;}if(WaitForSingleObject(process.value,0)==WAIT_OBJECT_0)continue;
    std::vector<wchar_t> path(32768);DWORD size=static_cast<DWORD>(path.size());if(!QueryFullProcessImageNameW(process.value,0,path.data(),&size))return true;const std::wstring actual(path.data(),size);if(actual.size()>root.size()&&actual[root.size()]==L'\\'&&_wcsnicmp(actual.c_str(),root.c_str(),root.size())==0)return true;
  }while(Process32NextW(snapshot.value,&row));if(GetLastError()!=ERROR_NO_MORE_FILES)fail("IDENTITY_UNAVAILABLE");return false;
}
Handle deleteEntry(const std::wstring& path,bool directory,HANDLE parent=nullptr) {
  const auto access=DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|(directory?FILE_LIST_DIRECTORY:0);auto opened=parent?openNativeChild(parent,path.substr(path.find_last_of(L'\\')+1),access,FILE_SHARE_READ|FILE_SHARE_WRITE,directory?NativeChildKind::directory:NativeChildKind::file,NativeChildDisposition::open):openNativePath(path,access,FILE_SHARE_READ|FILE_SHARE_WRITE,directory?NativeChildKind::directory:NativeChildKind::file);auto file=std::move(opened.handle);if(!file.valid())fail("PATH_UNSAFE");BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file.value,&info),"PATH_UNSAFE");if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||static_cast<bool>(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=directory||(!directory&&info.nNumberOfLinks!=1))fail("PATH_UNSAFE");
  std::vector<wchar_t> text(32768);const auto size=GetFinalPathNameByHandleW(file.value,text.data(),static_cast<DWORD>(text.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);if(!size||size>=text.size())fail("PATH_UNSAFE");std::wstring actual(text.data(),size);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);if(_wcsicmp(actual.c_str(),path.c_str())!=0)fail("PATH_UNSAFE");assertPrivateHandle(file.value);return file;
}
void removeReleaseTree(const std::wstring& path,unsigned depth,unsigned& count,HANDLE parent=nullptr) {
  if(depth>16||++count>100000)fail("PATH_UNSAFE");auto directory=deleteEntry(path,true,parent);
  for(const auto& entry:enumerateNativeDirectory(directory.value)){
    const auto& name=entry.name;(void)relativePath(utf8(name));if(entry.attributes&FILE_ATTRIBUTE_REPARSE_POINT)fail("PATH_UNSAFE");const auto child=path+L"\\"+name;
    if(entry.attributes&FILE_ATTRIBUTE_DIRECTORY)removeReleaseTree(child,depth+1,count,directory.value);
    else {if(++count>100000)fail("PATH_UNSAFE");auto file=deleteEntry(child,false,directory.value);FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;check(SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition)),"PATH_UNSAFE");}
  }
  FILE_DISPOSITION_INFO disposition{};disposition.DeleteFile=TRUE;check(SetFileInformationByHandle(directory.value,FileDispositionInfo,&disposition,sizeof(disposition)),"PATH_UNSAFE");
}
Json removeUnusedRelease(const Json& args) {
  const auto release=args.at("release").string();if(release.size()!=64||release.find_first_not_of("0123456789abcdef")!=std::string::npos||!ownedMutexes.contains("prepare"))fail("PEER_DENIED");const auto root=rootPath("personal")+L"\\runtime\\releases\\"+wide(release);auto parents=lockAncestors(root,false,false,rootPath("personal"));
  {auto directory=openEntry(root,true,true);auto manifest=lockHashedFile(root+L"\\release-manifest.json",args.at("manifest_sha256").string());if(releaseUsed(root))return Json::Object{{"removed",false}};}
  unsigned entries=0;removeReleaseTree(root,0,entries,parents.back().value);return Json::Object{{"removed",true}};
}
