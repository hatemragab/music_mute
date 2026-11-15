#pragma once

struct ConsumerEnvironmentOrder {
  bool operator()(const std::wstring& a,const std::wstring& b) const {
    const auto compared=CompareStringOrdinal(a.data(),static_cast<int>(a.size()),b.data(),static_cast<int>(b.size()),TRUE);
    if(!compared)fail("JOB_UNAVAILABLE");return compared==CSTR_LESS_THAN;
  }
};
using ConsumerEnvironmentEntries=std::map<std::wstring,std::wstring,ConsumerEnvironmentOrder>;
std::wstring encodeConsumerEnvironment(const ConsumerEnvironmentEntries& entries) {
  std::wstring block;
  for(const auto& [name,value]:entries){
    if(name.empty()||name.find_first_of(L"=\0",0,2)!=std::wstring::npos||value.find(L'\0')!=std::wstring::npos||name.size()+value.size()>32760)fail("BAD_REQUEST");
    block+=name;block+=L'=';block+=value;block+=L'\0';
    if(block.size()>32766)fail("BAD_REQUEST");
  }
  block+=L'\0';if(entries.empty())block+=L'\0';return block;
}
std::wstring consumerEnvironment(const std::wstring& executablePath,const std::string& nonce="",const std::string& role="") {
  ConsumerEnvironmentEntries entries;
  for(const wchar_t* name:{L"SystemRoot",L"WINDIR",L"TEMP",L"TMP",L"USERPROFILE",L"LOCALAPPDATA",L"APPDATA",L"ProgramFiles"}){
    std::vector<wchar_t> value(32768);const auto count=GetEnvironmentVariableW(name,value.data(),static_cast<DWORD>(value.size()));
    if(count==0)continue;if(count>=value.size())fail("BAD_REQUEST");entries.emplace(name,std::wstring(value.data(),count));
  }
  entries.emplace(L"PATH",executablePath);
  if(!nonce.empty()||!role.empty()){
    if(nonce.size()!=64||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos||(role!="personal"&&role!="fleet"&&role!="prepare"&&role!="session-agent"))fail("BAD_REQUEST");
    entries.emplace(L"MUSICMUTE_OWNERSHIP_NONCE",wide(nonce));entries.emplace(L"MUSICMUTE_OWNERSHIP_ROLE",wide(role));
  }
  return encodeConsumerEnvironment(entries);
}
