#pragma once

void inspectInstallerDirectory(const std::wstring& path,std::vector<Handle>& directories,unsigned depth,std::size_t& entries) {
  if(depth>16||directories.size()>=256)fail("PATH_UNSAFE");
  directories.push_back(openEntry(path,true,false,false,true));assertPrivateHandle(directories.back().value,false,true);
  const auto directory=directories.back().value;
  for(const auto& item:enumerateNativeDirectory(directory,2048)){
    const auto& name=item.name;
    if(++entries>2048||name.empty()||name.find_first_of(L"\\/:")!=std::wstring::npos||item.attributes&FILE_ATTRIBUTE_REPARSE_POINT)fail("PATH_UNSAFE");
    const auto child=path+L"\\"+name;
    if(item.attributes&FILE_ATTRIBUTE_DIRECTORY)inspectInstallerDirectory(child,directories,depth+1,entries);
    else{auto file=openEntry(child,false,false);assertPrivateHandle(file.value,false,true);}
  }
}
std::vector<Handle> installerDirectoryHandles(const std::wstring& root) {
  const auto programs=root.substr(0,root.find_last_of(L'\\'));auto ancestors=lockAncestors(programs,false,false,programs);
  Security security(dataSddl());
  // Only fixed current-user Programs/app directories may be created, after all
  // host and signed-parent authorization. Existing ownership is never repaired.
  auto createdProgram=openNativeChild(ancestors.back().value,programs.substr(programs.find_last_of(L'\\')+1),READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,NativeChildKind::directory,NativeChildDisposition::createNew,security.descriptor);if(!createdProgram.handle.valid()&&GetLastError()!=ERROR_ALREADY_EXISTS&&GetLastError()!=ERROR_FILE_EXISTS)fail("PATH_UNSAFE");
  auto program=openEntry(programs,true,false,false,true);assertPrivateHandle(program.value,false,true);ancestors.push_back(std::move(program));
  auto createdRoot=openNativeChild(ancestors.back().value,root.substr(root.find_last_of(L'\\')+1),READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY,FILE_SHARE_READ|FILE_SHARE_WRITE,NativeChildKind::directory,NativeChildDisposition::createNew,security.descriptor);if(!createdRoot.handle.valid()&&GetLastError()!=ERROR_ALREADY_EXISTS&&GetLastError()!=ERROR_FILE_EXISTS)fail("PATH_UNSAFE");
  std::size_t entries=0;inspectInstallerDirectory(root,ancestors,0,entries);return ancestors;
}
void retainInstallerDirectoryHandles(HANDLE parent,const std::vector<Handle>& directories) {
  std::vector<HANDLE> remote;
  try{for(const auto& directory:directories){HANDLE copy=nullptr;if(!DuplicateHandle(GetCurrentProcess(),directory.value,parent,&copy,0,FALSE,0))fail("PATH_UNSAFE");remote.push_back(copy);}
    if(WaitForSingleObject(parent,0)!=WAIT_TIMEOUT)fail("PEER_DENIED");
  }catch(...){for(const auto copy:remote){HANDLE local=nullptr;if(DuplicateHandle(parent,copy,GetCurrentProcess(),&local,0,FALSE,DUPLICATE_CLOSE_SOURCE)&&local)CloseHandle(local);}throw;}
  // These bounded, non-inheritable zero-access references belong to the signed
  // NSIS parent until it exits. They retain original no-write/no-delete share
  // modes through extraction/uninstall without a separate guardian or ACK gap.
}
void installerPathPreflight() {
  const auto host=identityReport();if(host.at("native_arch").string()!="x64"||host.at("process_arch").string()!="x64"||host.at("os_major").integer()!=10||host.at("os_build").integer()<19045)fail("UNSUPPORTED_HOST");
  const auto issuer=parentBinding(processIdentity(GetCurrentProcessId())).parent;
  Handle parent(OpenProcess(PROCESS_DUP_HANDLE|PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(issuer.at("pid").integer())));
  if(!parent.valid()||creation(parent.value)!=issuer.at("creation_time").string()||WaitForSingleObject(parent.value,0)!=WAIT_TIMEOUT)fail("PEER_DENIED");
  std::vector<wchar_t> self(32768);const auto count=GetModuleFileNameW(nullptr,self.data(),static_cast<DWORD>(self.size()));if(!count||count>=self.size())fail("HELPER_INTEGRITY_INVALID");
  const std::wstring selfPath(self.data(),count);auto initial=std::move(openNativePath(selfPath,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file).handle);if(!initial.valid())fail("HELPER_INTEGRITY_INVALID");
  const auto digest=hashFile(initial.value,16ULL*1024*1024);auto helper=lockHashedFile(selfPath,digest,true,16ULL*1024*1024);
  const auto publisher=trustedPePublisher(selfPath,helper.value,false,PeTrustPolicy::FreshApproval);
  const auto issuerPath=liveAccountPeerImage(issuer);auto issuerInitial=std::move(openNativePath(issuerPath,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file).handle);if(!issuerInitial.valid())fail("PEER_DENIED");
  const auto issuerDigest=hashFile(issuerInitial.value,2ULL*1024*1024*1024);auto installer=lockHashedFile(issuerPath,issuerDigest,true,2ULL*1024*1024*1024);
  verifyInstallerPublisher(issuerPath,installer.value,publisher,true);
  if(!signedInstallerMarker(issuerPath,L"MusicMuteLocalSetup.exe")&&!signedInstallerMarker(issuerPath,L"MusicMuteLocalUninstall.exe"))fail("PEER_DENIED");
  const auto executable=fixedAccountAppPath(),root=executable.substr(0,executable.find_last_of(L'\\'));
  auto directories=installerDirectoryHandles(root);
  if(mm::dump(processIdentity(static_cast<DWORD>(issuer.at("pid").integer())))!=mm::dump(issuer))fail("PEER_DENIED");
  retainInstallerDirectoryHandles(parent.value,directories);
}
