#pragma once

std::wstring protocolKeyName() {
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if(isolatedTestRoot.empty())fail("PROTOCOL_REGISTRATION_CONFLICT");
  return L"Software\\MusicMuteConsumerNativeTest\\"+isolatedTestRoot.substr(isolatedTestRoot.find_last_of(L'\\')+1)+L"\\Protocol";
#else
  return L"Software\\Classes\\musicmute-local";
#endif
}
std::wstring protocolCommand(){return quote(fixedAccountAppPath())+L" \"%1\"";}
bool protocolString(HKEY key,const wchar_t* name,const std::wstring& expected) {
  wchar_t value[32768]{};DWORD size=sizeof(value),type=0;
  const auto result=RegQueryValueExW(key,name,nullptr,&type,reinterpret_cast<BYTE*>(value),&size);
  return result==ERROR_SUCCESS&&type==REG_SZ&&size>=2&&size<=sizeof(value)&&size%2==0&&value[size/2-1]==L'\0'&&std::wstring(value)==expected;
}
Json protocolReceipt() {
  const auto encrypted=vault("vault_get",Json::Object{{"namespace","account"},{"key","protocol_registration"}});
  if(jsonNull(encrypted))return nullptr;
  auto bytes=base64Decode(encrypted.at("bytes_base64").string(),4096);
  const auto value=mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size())).parse();SecureZeroMemory(bytes.data(),bytes.size());
  keys(value,{"version","sid","command","phase"});const auto phase=value.at("phase").string();
  if(value.at("version").integer()!=1||value.at("sid").string()!=currentIdentity().sid||value.at("command").string()!=utf8(protocolCommand())||(phase!="registering"&&phase!="registered"&&phase!="removing"))fail("PROTOCOL_REGISTRATION_CONFLICT");
  return value;
}
void writeProtocolReceipt(const char* phase) {
  const auto text=mm::dump(Json::Object{{"version",1},{"sid",currentIdentity().sid},{"command",utf8(protocolCommand())},{"phase",phase}});
  (void)vault("vault_put",Json::Object{{"namespace","account"},{"key","protocol_registration"},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()))}});
}
bool protocolNode(HKEY key,const std::vector<std::pair<std::wstring,std::wstring>>& expected,const wchar_t* child,bool partial) {
  DWORD count=0,children=0;check(RegQueryInfoKeyW(key,nullptr,nullptr,nullptr,&children,nullptr,nullptr,&count,nullptr,nullptr,nullptr,nullptr)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
  if(count>expected.size()||children>(child?1UL:0UL))fail("PROTOCOL_REGISTRATION_CONFLICT");
  for(DWORD i=0;i<count;++i) {
    wchar_t name[256]{};DWORD length=256;check(RegEnumValueW(key,i,name,&length,nullptr,nullptr,nullptr,nullptr)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
    const auto found=std::find_if(expected.begin(),expected.end(),[&](const auto& entry){return entry.first==name;});
    if(found==expected.end()||!protocolString(key,name,found->second))fail("PROTOCOL_REGISTRATION_CONFLICT");
  }
  if(children) {wchar_t name[256]{};DWORD length=256;check(RegEnumKeyExW(key,0,name,&length,nullptr,nullptr,nullptr,nullptr)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");if(!child||wcscmp(child,name)!=0)fail("PROTOCOL_REGISTRATION_CONFLICT");}
  const bool complete=count==expected.size()&&children==(child?1UL:0UL);
  if(!complete&&!partial)fail("PROTOCOL_REGISTRATION_CONFLICT");return complete;
}
std::string protocolState(REGSAM view,bool partial=false) {
  RegistryHandle root;const auto opened=RegOpenKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,KEY_READ|view,&root.key);
  if(opened==ERROR_FILE_NOT_FOUND)return "absent";if(opened!=ERROR_SUCCESS)fail("PROTOCOL_REGISTRATION_CONFLICT");
  bool complete=protocolNode(root.key,{{L"",L"URL:MusicMute Local"},{L"URL Protocol",L""}},L"shell",partial);
  for(const auto* name:{L"shell",L"shell\\open",L"shell\\open\\command"}) {
    RegistryHandle next;const auto result=RegOpenKeyExW(root.key,name,0,KEY_READ|view,&next.key);
    if(result==ERROR_FILE_NOT_FOUND&&partial){complete=false;continue;}if(result!=ERROR_SUCCESS)fail("PROTOCOL_REGISTRATION_CONFLICT");
    const bool command=wcscmp(name,L"shell\\open\\command")==0;
    const auto values=command?std::vector<std::pair<std::wstring,std::wstring>>{{L"",protocolCommand()}}:std::vector<std::pair<std::wstring,std::wstring>>{};
    complete=protocolNode(next.key,values,command?nullptr:(wcscmp(name,L"shell")==0?L"open":L"command"),partial)&&complete;
  }
  return complete?"owned":"partial";
}
Json protocolRegistration(bool remove) {
  // Serialize both registry views with the DPAPI journal. Interrupted prefixes
  // are repairable only with this receipt and exact fixed expected subsets.
  VaultNamespaceLock lock("account");const auto receipt=protocolReceipt();const bool owned=!jsonNull(receipt);
  const auto first=protocolState(KEY_WOW64_32KEY,owned),second=protocolState(KEY_WOW64_64KEY,owned);
  if(!owned&&(first!="absent"||second!="absent"))fail("PROTOCOL_REGISTRATION_CONFLICT");
  if(remove&&first=="absent"&&second=="absent"&&!owned)return Json::Object{{"removed",true}};
  writeProtocolReceipt(remove?"removing":"registering");
  for(const auto view:{KEY_WOW64_32KEY,KEY_WOW64_64KEY}) {
    (void)protocolState(view,true);
    if(remove) {
      const auto key=protocolKeyName();const auto split=key.find_last_of(L'\\');RegistryHandle parent;
      const auto opened=RegOpenKeyExW(HKEY_CURRENT_USER,key.substr(0,split).c_str(),0,KEY_READ|KEY_WRITE|view,&parent.key);
      if(opened==ERROR_FILE_NOT_FOUND)continue;if(opened!=ERROR_SUCCESS)fail("PROTOCOL_REGISTRATION_CONFLICT");
      const auto result=RegDeleteTreeW(parent.key,key.substr(split+1).c_str());if(result!=ERROR_SUCCESS&&result!=ERROR_FILE_NOT_FOUND)fail("PROTOCOL_REGISTRATION_CONFLICT");
    }else {
      RegistryHandle root,command;DWORD disposition=0;
      check(RegCreateKeyExW(HKEY_CURRENT_USER,protocolKeyName().c_str(),0,nullptr,0,KEY_WRITE|view,nullptr,&root.key,&disposition)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
      const std::wstring title=L"URL:MusicMute Local",empty;
      check(RegSetValueExW(root.key,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(title.c_str()),static_cast<DWORD>((title.size()+1)*2))==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
      check(RegSetValueExW(root.key,L"URL Protocol",0,REG_SZ,reinterpret_cast<const BYTE*>(empty.c_str()),2)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
      check(RegCreateKeyExW(root.key,L"shell\\open\\command",0,nullptr,0,KEY_WRITE|view,nullptr,&command.key,&disposition)==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
      const auto value=protocolCommand();check(RegSetValueExW(command.key,nullptr,0,REG_SZ,reinterpret_cast<const BYTE*>(value.c_str()),static_cast<DWORD>((value.size()+1)*2))==ERROR_SUCCESS,"PROTOCOL_REGISTRATION_CONFLICT");
    }
  }
  const auto expected=remove?"absent":"owned";if(protocolState(KEY_WOW64_32KEY)!=expected||protocolState(KEY_WOW64_64KEY)!=expected)fail("PROTOCOL_REGISTRATION_CONFLICT");
  if(remove)(void)vault("vault_delete",Json::Object{{"namespace","account"},{"key","protocol_registration"}});else writeProtocolReceipt("registered");
  return Json::Object{{remove?"removed":"registered",true}};
}
