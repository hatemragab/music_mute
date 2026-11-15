#pragma once

// A BCD boot-loader GUID is not a reboot epoch. This app-owned volatile witness
// survives process exits and cannot survive hive unload/reboot. An early hive
// unload invalidates qualification conservatively; no wall/uptime estimate.
std::wstring consumerBootKey() {
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if(isolatedTestRoot.empty())fail("BOOT_IDENTITY_UNAVAILABLE");
  // Match the production key's direct HKCU parent. Creating a missing nested
  // volatile path also makes its intermediate keys volatile, invalidating the
  // fixture's deliberate persistent-key replacement.
  return L"MusicMuteConsumerNativeBootTest-"+isolatedTestRoot.substr(isolatedTestRoot.find_last_of(L'\\')+1);
#else
  return L"MusicMuteConsumerBoot-v1";
#endif
}
void assertPrivateBootKey(HKEY key) {
  PSID owner=nullptr;PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(GetSecurityInfo(key,SE_REGISTRY_KEY,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&descriptor)!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");
  LocalMemory memory{descriptor};SECURITY_DESCRIPTOR_CONTROL control{};DWORD revision=0;
  if(!owner||sidString(owner)!=currentIdentity().sid||!acl||!acl->AceCount||!GetSecurityDescriptorControl(descriptor,&control,&revision)||!(control&SE_DACL_PROTECTED))fail("BOOT_IDENTITY_UNAVAILABLE");
  for(DWORD n=0;n<acl->AceCount;++n){void* item=nullptr;if(!GetAce(acl,n,&item)||static_cast<ACE_HEADER*>(item)->AceType!=ACCESS_ALLOWED_ACE_TYPE)fail("BOOT_IDENTITY_UNAVAILABLE");
    const auto sid=sidString(const_cast<DWORD*>(&static_cast<ACCESS_ALLOWED_ACE*>(item)->SidStart));if(sid!=currentIdentity().sid&&sid!="S-1-5-18")fail("BOOT_IDENTITY_UNAVAILABLE");}
}
Json consumerBootIdentity() {
  const auto sid=wide(currentIdentity().sid);Security security(L"O:"+sid+L"D:P(A;;KA;;;"+sid+L")(A;;KA;;;SY)");
  Security kernelSecurity(L"O:"+sid+L"D:P(A;;0x001f0001;;;"+sid+L")(A;;0x001f0001;;;SY)");
  Handle mutex(CreateMutexW(&kernelSecurity.attributes,FALSE,(L"Global\\MusicMuteConsumerBoot-"+privateKernelSid()).c_str()));
  if(!mutex.valid())fail("BOOT_IDENTITY_UNAVAILABLE");assertPrivateMutex(mutex.value);
  const auto waited=WaitForSingleObject(mutex.value,5000);if(waited!=WAIT_OBJECT_0&&waited!=WAIT_ABANDONED)fail("BOOT_IDENTITY_UNAVAILABLE");
  struct Unlock{HANDLE value;~Unlock(){ReleaseMutex(value);}}unlock{mutex.value};
  const auto name=consumerBootKey();RegistryHandle key;DWORD disposition=0;
  const auto opened=RegOpenKeyExW(HKEY_CURRENT_USER,name.c_str(),REG_OPTION_OPEN_LINK,KEY_READ|KEY_WRITE|READ_CONTROL|KEY_WOW64_64KEY,&key.key);
  if(opened==ERROR_FILE_NOT_FOUND){RegistryHandle created;if(RegCreateKeyExW(HKEY_CURRENT_USER,name.c_str(),0,nullptr,REG_OPTION_VOLATILE,KEY_READ|KEY_WRITE|READ_CONTROL|KEY_WOW64_64KEY,&security.attributes,&created.key,&disposition)!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");
    // Reopen without following an existing registry symbolic link after a race.
    if(RegOpenKeyExW(HKEY_CURRENT_USER,name.c_str(),REG_OPTION_OPEN_LINK,KEY_READ|KEY_WRITE|READ_CONTROL|KEY_WOW64_64KEY,&key.key)!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");
  }else if(opened!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");
  assertPrivateBootKey(key.key);DWORD children=0,values=0;
  if(RegQueryInfoKeyW(key.key,nullptr,nullptr,nullptr,&children,nullptr,nullptr,&values,nullptr,nullptr,nullptr,nullptr)!=ERROR_SUCCESS||children||values>1)fail("BOOT_IDENTITY_UNAVAILABLE");
  // dwOptions is ignored for an existing key. Prove volatility rather than
  // trusting REG_OPTION_VOLATILE in the open/create call. A fresh stable child
  // under a volatile parent MUST fail (MS-RRP BaseRegCreateKey).
  const auto probeName=L"probe-"+wide(randomHex());RegistryHandle probe;DWORD probeDisposition=0;
  const auto probed=RegCreateKeyExW(key.key,probeName.c_str(),0,nullptr,REG_OPTION_NON_VOLATILE,KEY_READ|KEY_WRITE,&security.attributes,&probe.key,&probeDisposition);
  if(probed!=ERROR_CHILD_MUST_BE_VOLATILE){if(probed==ERROR_SUCCESS&&probeDisposition==REG_CREATED_NEW_KEY){RegCloseKey(probe.key);probe.key=nullptr;(void)RegDeleteKeyW(key.key,probeName.c_str());}fail("BOOT_IDENTITY_UNAVAILABLE");}
  std::string witness;
  if(values==0){witness=randomHex();if(RegSetValueExW(key.key,L"id",0,REG_BINARY,reinterpret_cast<const BYTE*>(witness.data()),static_cast<DWORD>(witness.size()))!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");}
  else{char bytes[64]{};DWORD type=0,size=sizeof(bytes);if(RegQueryValueExW(key.key,L"id",nullptr,&type,reinterpret_cast<BYTE*>(bytes),&size)!=ERROR_SUCCESS||type!=REG_BINARY||size!=64)fail("BOOT_IDENTITY_UNAVAILABLE");witness.assign(bytes,64);}
  if(witness.size()!=64||witness.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BOOT_IDENTITY_UNAVAILABLE");
  // An HKEY may remain open after deletion. Require the live named key to
  // remain the same closed private witness before returning it.
  if(RegQueryInfoKeyW(key.key,nullptr,nullptr,nullptr,&children,nullptr,nullptr,&values,nullptr,nullptr,nullptr,nullptr)!=ERROR_SUCCESS||children||values!=1)fail("BOOT_IDENTITY_UNAVAILABLE");
  RegistryHandle named;char namedBytes[64]{};DWORD namedType=0,namedSize=sizeof(namedBytes);
  if(RegOpenKeyExW(HKEY_CURRENT_USER,name.c_str(),REG_OPTION_OPEN_LINK,KEY_READ|READ_CONTROL|KEY_WOW64_64KEY,&named.key)!=ERROR_SUCCESS)fail("BOOT_IDENTITY_UNAVAILABLE");assertPrivateBootKey(named.key);
  if(RegQueryValueExW(named.key,L"id",nullptr,&namedType,reinterpret_cast<BYTE*>(namedBytes),&namedSize)!=ERROR_SUCCESS||namedType!=REG_BINARY||namedSize!=64||witness!=std::string(namedBytes,64))fail("BOOT_IDENTITY_UNAVAILABLE");
  return Json::Object{{"boot_id",witness},{"source","volatile-registry-witness-v1"}};
}
