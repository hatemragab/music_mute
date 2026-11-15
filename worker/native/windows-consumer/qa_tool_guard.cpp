// Isolated acceptance bootstrap only. Not installed or included in runtime
// inventory. There is no production app/account/worker authority in this tool.
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <winternl.h>
#include <wintrust.h>
#include <softpub.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <set>
#include <regex>
#include <map>
#include <optional>
#include <string>
#include <vector>
#include "json.hpp"
using mm::Json;
namespace {
[[noreturn]] void bad(){throw std::runtime_error("ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED");}
void require(bool value){if(!value)bad();}
bool validToolTimeout(std::string_view step,std::int64_t timeout){
  const auto maximum=step=="compile"||step=="ctest"?300000:step=="describe"?10000:step=="configure"?120000:0;
  return timeout>=1000&&timeout<=maximum;
}
void testToolTimeout(){
  for(const auto* step:{"configure","compile","describe","ctest"}){
    const auto maximum=std::string_view(step)=="configure"?120000:std::string_view(step)=="describe"?10000:300000;
    require(validToolTimeout(step,1000)&&validToolTimeout(step,maximum)&&!validToolTimeout(step,999)&&!validToolTimeout(step,maximum+1));
  }
  require(validToolTimeout("ctest",300000)&&!validToolTimeout("ctest",300001)&&!validToolTimeout("unknown",1000));
}
enum class ToolPhase : std::uint8_t {target,requestInput,requestPolicy,paths,toolParents,toolImage,toolHash,policyParents,policyImage,policySize,policyHash,policyPe,policyTrust,policyPublisher,policyStable,currentIdentity,isolatedBuild,jobCreate,pipeCreate,attributeList,childCreate,jobAssign,childIdentity,childResume,outputLoop,jobZero,receiptWrite,selfTest,identityToken,identityUser,identitySidCopy,identitySession,identityElevation,identityComplete,ownerNonadmin,ownerSession,childNative,childNonadmin,childSession,childUser,count};
struct ToolFailureObservation {ToolPhase phase=ToolPhase::target;bool jobCreated=false,childCreated=false,trustObserved=false;std::uint32_t trustResult=0;};
ToolFailureObservation failureObservation;
void phase(ToolPhase value){failureObservation.phase=value;}
std::string formatFailureObservation(const ToolFailureObservation& value){
  constexpr const char* names[]{"target","request-input","request-policy","paths","tool-parents","tool-image","tool-hash","policy-parents","policy-image","policy-size","policy-hash","policy-pe","policy-trust","policy-publisher","policy-stable","current-identity","isolated-build","job-create","pipe-create","attribute-list","child-create","job-assign","child-identity","child-resume","output-loop","job-zero","receipt-write","self-test","identity-token","identity-user","identity-sid-copy","identity-session","identity-elevation","identity-complete","owner-nonadmin","owner-session","child-native","child-nonadmin","child-session","child-user"};
  static_assert(std::size(names)==static_cast<std::size_t>(ToolPhase::count));
  const auto index=static_cast<std::size_t>(value.phase);require(index<std::size(names)&&(!value.childCreated||value.jobCreated)&&(value.trustObserved||value.trustResult==0));
  return std::string("QA tool failure phase: phase=")+names[index]+"; job_created="+(value.jobCreated?"1":"0")+"; child_created="+(value.childCreated?"1":"0")+"; trust_observed="+(value.trustObserved?"1":"0")+"; trust_result="+std::to_string(value.trustResult)+"\n";
}
void testFailureObservation(){
  const ToolFailureObservation empty;require(formatFailureObservation(empty)=="QA tool failure phase: phase=target; job_created=0; child_created=0; trust_observed=0; trust_result=0\n");
  ToolFailureObservation trust;trust.phase=ToolPhase::policyTrust;trust.trustObserved=true;trust.trustResult=static_cast<std::uint32_t>(static_cast<LONG>(-2146885613));require(formatFailureObservation(trust).ends_with("; trust_observed=1; trust_result=2148081683\n"));
  trust.jobCreated=trust.childCreated=true;trust.trustResult=MAXDWORD;trust.phase=ToolPhase::selfTest;require(formatFailureObservation(trust).size()<256);
  for(unsigned n=0;n<3;++n){auto invalid=empty;if(n==0)invalid.phase=ToolPhase::count;else if(n==1)invalid.childCreated=true;else invalid.trustResult=1;bool rejected=false;try{(void)formatFailureObservation(invalid);}catch(...){rejected=true;}require(rejected);}
}
struct Handle {
  HANDLE value=nullptr;
  explicit Handle(HANDLE input=nullptr):value(input){}
  Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
  Handle(Handle&& other)noexcept:value(other.value){other.value=nullptr;}
  ~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);}
  bool valid()const{return value&&value!=INVALID_HANDLE_VALUE;}
};
std::wstring wide(const std::string& text){const auto length=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);require(length>0);std::wstring result(static_cast<std::size_t>(length),L'\0');require(MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),length)==length);return result;}
void keys(const Json& row,const std::set<std::string>& names){require(row.object().size()==names.size());for(const auto& [name,value]:row.object()){(void)value;require(names.contains(name));}}
void pathSyntax(const std::wstring& result){
  require(result.size()>=4&&result.size()<=4096&&((result[0]>=L'A'&&result[0]<=L'Z')||(result[0]>=L'a'&&result[0]<=L'z'))&&result[1]==L':'&&result[2]==L'\\');
  require(result.find_first_of(L"\"/\r\n\t")==std::wstring::npos&&result.find(L':',2)==std::wstring::npos&&result.back()!=L'\\');
  for(const auto character:result)require(character>=32&&character!=127&&!(character>=0x200b&&character<=0x200f)&&!(character>=0x202a&&character<=0x202e)&&!(character>=0x2060&&character<=0x206f)&&character!=0xfeff);
  for(auto start=std::size_t{3};start<result.size();){const auto end=result.find(L'\\',start);const auto part=result.substr(start,end==std::wstring::npos?result.size()-start:end-start);require(!part.empty()&&part!=L"."&&part!=L".."&&part.back()!=L'.'&&part.back()!=L' ');if(end==std::wstring::npos)break;start=end+1;}
}
std::wstring path(const std::string& value){
  const auto result=wide(value);pathSyntax(result);require(GetDriveTypeW(result.substr(0,3).c_str())==DRIVE_FIXED);return result;
}
Handle entry(const std::wstring& value,bool directory,bool data=false,bool directoryFence=false){
  Handle file(CreateFileW(value.c_str(),FILE_READ_ATTRIBUTES|READ_CONTROL|(data?GENERIC_READ:0)|(directory&&directoryFence?FILE_LIST_DIRECTORY:0),FILE_SHARE_READ|(directory&&directoryFence?FILE_SHARE_WRITE:0),nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));require(file.valid());
  BY_HANDLE_FILE_INFORMATION info{};require(GetFileInformationByHandle(file.value,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)&&static_cast<bool>(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)==directory&&(directory||info.nNumberOfLinks==1));
  std::vector<wchar_t> finalPath(32768);const auto length=GetFinalPathNameByHandleW(file.value,finalPath.data(),static_cast<DWORD>(finalPath.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);require(length>0&&length<finalPath.size());std::wstring actual(finalPath.data(),length);if(actual.starts_with(L"\\\\?\\"))actual.erase(0,4);require(_wcsicmp(actual.c_str(),value.c_str())==0);return file;
}
std::vector<Handle> parents(const std::wstring& value,bool includeLast,bool directoryFence=false){
  std::vector<Handle> result;result.emplace_back(entry(value.substr(0,3),true,false,directoryFence));
  for(auto separator=value.find(L'\\',3);separator!=std::wstring::npos;separator=value.find(L'\\',separator+1)){require(result.size()<64);result.emplace_back(entry(value.substr(0,separator),true,false,directoryFence));}
  if(includeLast)result.emplace_back(entry(value,true,false,directoryFence));return result;
}
std::string hash(HANDLE file){
  LARGE_INTEGER zero{};require(SetFilePointerEx(file,zero,nullptr,FILE_BEGIN));
  BCRYPT_ALG_HANDLE algorithm=nullptr;require(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)==0);
  struct Algorithm{BCRYPT_ALG_HANDLE value;~Algorithm(){BCryptCloseAlgorithmProvider(value,0);}} algorithmLifetime{algorithm};
  DWORD bytes=0,count=0;require(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&bytes),sizeof(bytes),&count,0)==0);std::vector<BYTE> object(bytes);BCRYPT_HASH_HANDLE hashed=nullptr;require(BCryptCreateHash(algorithm,&hashed,object.data(),bytes,nullptr,0,0)==0);
  struct Hash{BCRYPT_HASH_HANDLE value;~Hash(){BCryptDestroyHash(value);}} hashLifetime{hashed};std::vector<BYTE> buffer(65536);std::uint64_t total=0;
  while(true){require(ReadFile(file,buffer.data(),static_cast<DWORD>(buffer.size()),&count,nullptr));if(!count)break;total+=count;require(total<=256ULL*1024*1024&&BCryptHashData(hashed,buffer.data(),count,0)==0);}
  BYTE digest[32]{};require(BCryptFinishHash(hashed,digest,32,0)==0);constexpr char hex[]="0123456789abcdef";std::string result;for(const auto byte:digest){result+=hex[byte>>4];result+=hex[byte&15];}return result;
}
std::wstring quote(const std::wstring& value){require(value.find(L'"')==std::wstring::npos&&value.back()!=L'\\');return L"\""+value+L"\"";}
std::vector<wchar_t> environment(){
  wchar_t windows[32768]{};const auto size=GetWindowsDirectoryW(windows,32768);require(size>0&&size<32768);const std::wstring root(windows,size);
  require(root.size()>=3&&((root[0]>=L'A'&&root[0]<=L'Z')||(root[0]>=L'a'&&root[0]<=L'z'))&&root[1]==L':'&&root[2]==L'\\');
  struct Less{bool operator()(const std::wstring& a,const std::wstring& b)const{return _wcsicmp(a.c_str(),b.c_str())<0;}};
  std::map<std::wstring,std::wstring,Less> values{{L"SystemRoot",root},{L"SystemDrive",root.substr(0,2)},{L"WINDIR",root},{L"PATH",root+L"\\System32;"+root},{L"PROCESSOR_ARCHITECTURE",L"AMD64"},{L"MSBUILDDISABLENODEREUSE",L"1"}};
  for(const auto* name:{L"TEMP",L"TMP",L"USERPROFILE",L"LOCALAPPDATA",L"APPDATA",L"ProgramData",L"ALLUSERSPROFILE",L"ProgramFiles",L"ProgramFiles(x86)",L"ProgramW6432"}){std::vector<wchar_t> bytes(32768);const auto length=GetEnvironmentVariableW(name,bytes.data(),static_cast<DWORD>(bytes.size()));if(length&&length<bytes.size())values.emplace(name,std::wstring(bytes.data(),length));}
  std::wstring value;for(const auto& [name,data]:values)value+=name+L"="+data+L'\0';
  value+=L'\0';return std::vector<wchar_t>(value.begin(),value.end());
}
std::string base64(const std::vector<BYTE>& bytes){if(bytes.empty())return {};DWORD size=0;require(CryptBinaryToStringA(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&size));std::string result(size,'\0');require(CryptBinaryToStringA(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,result.data(),&size));result.resize(size);while(!result.empty()&&result.back()=='\0')result.pop_back();return result;}
bool jobEmpty(HANDLE job){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};require(QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr));return info.ActiveProcesses==0;}
constexpr DWORD censusCapacity=128;
struct TelemetryPolicy {
  std::wstring image,instance,version;
  std::string sha256;
  std::int64_t bytes=0;
};
std::optional<TelemetryPolicy> requestPolicy(const Json& request){
  const auto version=request.at("version").integer();
  if(version==1){keys(request,{"version","request_id","step","executable","sha256","repository","build","timeout_ms"});return std::nullopt;}
  require(version==2);keys(request,{"version","request_id","step","executable","sha256","repository","build","timeout_ms","compiler_telemetry"});
  const auto step=request.at("step").string();require(step=="configure"||step=="compile");
  const auto& row=request.at("compiler_telemetry");keys(row,{"kind","path","sha256","bytes"});require(row.at("kind").string()=="msvc-vctip");
  TelemetryPolicy result;result.image=wide(row.at("path").string());result.sha256=row.at("sha256").string();result.bytes=row.at("bytes").integer();
  pathSyntax(result.image);
  require(result.sha256.size()==64&&result.sha256.find_first_not_of("0123456789abcdef")==std::string::npos&&result.bytes>=1024&&result.bytes<=16*1024*1024);
  std::wsmatch parts;require(std::regex_match(result.image,parts,std::wregex(L"(.+)\\\\VC\\\\Tools\\\\MSVC\\\\(14\\.44\\.[0-9]{5})\\\\bin\\\\Hostx64\\\\x64\\\\VCTIP\\.exe",std::regex_constants::icase)));
  result.instance=parts[1].str();result.version=parts[2].str();
  const auto executable=wide(request.at("executable").string());pathSyntax(executable);
  require(result.instance.size()>=3&&_wcsicmp(executable.c_str(),(result.instance+L"\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe").c_str())==0);
  return result;
}
std::uint64_t timeValue(const FILETIME& value){return (static_cast<std::uint64_t>(value.dwHighDateTime)<<32)|value.dwLowDateTime;}
BY_HANDLE_FILE_INFORMATION fileInfo(HANDLE image){BY_HANDLE_FILE_INFORMATION value{};require(GetFileInformationByHandle(image,&value));return value;}
bool sameFile(const BY_HANDLE_FILE_INFORMATION& left,const BY_HANDLE_FILE_INFORMATION& right){
  return left.dwFileAttributes==right.dwFileAttributes&&left.nNumberOfLinks==1&&right.nNumberOfLinks==1&&left.dwVolumeSerialNumber==right.dwVolumeSerialNumber&&left.nFileIndexHigh==right.nFileIndexHigh&&left.nFileIndexLow==right.nFileIndexLow&&timeValue(left.ftCreationTime)==timeValue(right.ftCreationTime)&&timeValue(left.ftLastWriteTime)==timeValue(right.ftLastWriteTime)&&left.nFileSizeHigh==right.nFileSizeHigh&&left.nFileSizeLow==right.nFileSizeLow;
}
WORD approvedImageMachine(WORD machine,WORD magic){require((machine==IMAGE_FILE_MACHINE_I386&&magic==IMAGE_NT_OPTIONAL_HDR32_MAGIC)||(machine==IMAGE_FILE_MACHINE_AMD64&&magic==IMAGE_NT_OPTIONAL_HDR64_MAGIC));return machine;}
bool matchesToolMachine(WORD pinned,bool queried,USHORT process,USHORT native){return queried&&native==IMAGE_FILE_MACHINE_AMD64&&((pinned==IMAGE_FILE_MACHINE_I386&&process==IMAGE_FILE_MACHINE_I386)||(pinned==IMAGE_FILE_MACHINE_AMD64&&process==IMAGE_FILE_MACHINE_UNKNOWN));}
WORD peMachine(HANDLE image){
  LARGE_INTEGER zero{},size{};BYTE dos[64]{};DWORD read=0;
  require(GetFileSizeEx(image,&size)&&SetFilePointerEx(image,zero,nullptr,FILE_BEGIN)&&ReadFile(image,dos,64,&read,nullptr)&&read==64&&dos[0]=='M'&&dos[1]=='Z');
  DWORD offset=0;std::memcpy(&offset,dos+60,sizeof(offset));require(offset>=64&&offset<=1048576&&static_cast<std::int64_t>(offset)+26<=size.QuadPart);
  LARGE_INTEGER at{};at.QuadPart=offset;BYTE pe[26]{};require(SetFilePointerEx(image,at,nullptr,FILE_BEGIN)&&ReadFile(image,pe,26,&read,nullptr)&&read==26);
  WORD machine=0,magic=0;std::memcpy(&machine,pe+4,sizeof(machine));std::memcpy(&magic,pe+24,sizeof(magic));require(pe[0]=='P'&&pe[1]=='E'&&!pe[2]&&!pe[3]);return approvedImageMachine(machine,magic);
}
void microsoftImage(HANDLE image,const std::wstring& imagePath){
  phase(ToolPhase::policyPe);require(peMachine(image)==IMAGE_FILE_MACHINE_AMD64);
  WINTRUST_FILE_INFO file{};file.cbStruct=sizeof(file);file.pcwszFilePath=imagePath.c_str();file.hFile=image;
  WINTRUST_DATA trust{};trust.cbStruct=sizeof(trust);trust.dwUIChoice=WTD_UI_NONE;trust.fdwRevocationChecks=WTD_REVOKE_WHOLECHAIN;trust.dwUnionChoice=WTD_CHOICE_FILE;trust.pFile=&file;trust.dwStateAction=WTD_STATEACTION_VERIFY;trust.dwProvFlags=WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT|WTD_DISABLE_MD2_MD4|WTD_CACHE_ONLY_URL_RETRIEVAL;
  phase(ToolPhase::policyTrust);GUID policy=WINTRUST_ACTION_GENERIC_VERIFY_V2;const auto trusted=WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE),&policy,&trust);failureObservation.trustObserved=true;failureObservation.trustResult=static_cast<std::uint32_t>(trusted);
  struct State{GUID& policy;WINTRUST_DATA& trust;~State(){trust.dwStateAction=WTD_STATEACTION_CLOSE;(void)WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE),&policy,&trust);}} lifetime{policy,trust};
  require(trusted==ERROR_SUCCESS);phase(ToolPhase::policyPublisher);const auto provider=WTHelperProvDataFromStateData(trust.hWVTStateData);require(provider!=nullptr);const auto signer=WTHelperGetProvSignerFromChain(provider,0,FALSE,0);require(signer!=nullptr);const auto leaf=WTHelperGetProvCertFromChain(signer,0);require(leaf&&leaf->pCert);
  for(const auto* oid:{szOID_COMMON_NAME,szOID_ORGANIZATION_NAME}){wchar_t name[256]{};const auto length=CertGetNameStringW(leaf->pCert,CERT_NAME_ATTR_TYPE,0,const_cast<char*>(oid),name,256);require(length>=2&&length<=256&&wcscmp(name,L"Microsoft Corporation")==0);}
}
struct TelemetryAuthority {
  TelemetryPolicy policy;
  std::vector<Handle> ancestors;
  Handle image;
  BY_HANDLE_FILE_INFORMATION birth;
  static std::vector<Handle> lockedParents(const TelemetryPolicy& policy){phase(ToolPhase::policyParents);require(GetDriveTypeW(policy.image.substr(0,3).c_str())==DRIVE_FIXED);return parents(policy.image,false,true);}
  static Handle lockedImage(const TelemetryPolicy& policy){phase(ToolPhase::policyImage);return entry(policy.image,false,true);}
  explicit TelemetryAuthority(TelemetryPolicy input):policy(std::move(input)),ancestors(lockedParents(policy)),image(lockedImage(policy)),birth(fileInfo(image.value)){
    phase(ToolPhase::policySize);require(birth.nFileSizeHigh==0&&static_cast<std::int64_t>(birth.nFileSizeLow)==policy.bytes);phase(ToolPhase::policyHash);require(hash(image.value)==policy.sha256);microsoftImage(image.value,policy.image);phase(ToolPhase::policyStable);require(sameFile(birth,fileInfo(image.value)));
  }
  void unchanged()const{phase(ToolPhase::policyStable);require(sameFile(birth,fileInfo(image.value))&&hash(image.value)==policy.sha256&&sameFile(birth,fileInfo(image.value)));}
};
std::vector<BYTE> tokenInfo(HANDLE token,TOKEN_INFORMATION_CLASS kind){DWORD bytes=0;require(!GetTokenInformation(token,kind,nullptr,0,&bytes)&&GetLastError()==ERROR_INSUFFICIENT_BUFFER&&bytes>0&&bytes<=65536);std::vector<BYTE> result(bytes);require(GetTokenInformation(token,kind,result.data(),bytes,&bytes)&&bytes<=result.size());return result;}
struct ProcessIdentity {std::vector<BYTE> sid;DWORD session=0;bool elevated=false;};
ProcessIdentity identity(HANDLE process){
  phase(ToolPhase::identityToken);Handle token;require(OpenProcessToken(process,TOKEN_QUERY,&token.value));
  phase(ToolPhase::identityUser);const auto user=tokenInfo(token.value,TokenUser);require(user.size()>=sizeof(TOKEN_USER));const auto source=reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid;
  phase(ToolPhase::identitySidCopy);require(IsValidSid(source));const auto size=GetLengthSid(source);require(size>0&&size<=SECURITY_MAX_SID_SIZE);ProcessIdentity result;result.sid.resize(size);require(CopySid(size,result.sid.data(),source));
  phase(ToolPhase::identitySession);const auto session=tokenInfo(token.value,TokenSessionId);require(session.size()>=sizeof(DWORD));std::memcpy(&result.session,session.data(),sizeof(DWORD));
  // TokenElevation has a fixed documented layout; query it directly rather
  // than assuming its null-buffer probe uses a particular Win32 error code.
  phase(ToolPhase::identityElevation);TOKEN_ELEVATION elevation{};DWORD elevationBytes=0;require(GetTokenInformation(token.value,TokenElevation,&elevation,sizeof(elevation),&elevationBytes)&&elevationBytes==sizeof(elevation));result.elevated=elevation.TokenIsElevated!=0;
  phase(ToolPhase::identityComplete);return result;
}
std::uint64_t processBirth(HANDLE process){FILETIME created{},exit{},kernel{},user{};require(GetProcessTimes(process,&created,&exit,&kernel,&user));return timeValue(created);}
bool nativeProcess(HANDLE process){USHORT kind=0,native=0;return IsWow64Process2(process,&kind,&native)&&kind==IMAGE_FILE_MACHINE_UNKNOWN&&native==IMAGE_FILE_MACHINE_AMD64;}
struct RetirementFacts {
  bool rootSignalled=false,rootSucceeded=false,beforeDeadline=false,listComplete=false,imageMatches=false,native=false,sameUser=false,sameSession=false,nonAdmin=false,member=false,alive=false,birthMatches=false;
};
bool mayRetire(const RetirementFacts& value){return value.rootSignalled&&value.rootSucceeded&&value.beforeDeadline&&value.listComplete&&value.imageMatches&&value.native&&value.sameUser&&value.sameSession&&value.nonAdmin&&value.member&&value.alive&&value.birthMatches;}
std::set<DWORD> completeMembers(DWORD assigned,DWORD listed,const ULONG_PTR* identifiers){
  require(assigned==listed&&listed<=censusCapacity);std::set<DWORD> result;
  for(DWORD n=0;n<listed;++n)require(identifiers[n]>0&&identifiers[n]<=MAXDWORD&&result.insert(static_cast<DWORD>(identifiers[n])).second);return result;
}
std::set<DWORD> jobMembers(HANDLE job){
  struct ProcessList{DWORD assigned;DWORD listed;ULONG_PTR identifiers[censusCapacity];};static_assert(offsetof(ProcessList,identifiers)==offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST,ProcessIdList));ProcessList value{};
  require(QueryInformationJobObject(job,JobObjectBasicProcessIdList,&value,sizeof(value),nullptr));return completeMembers(value.assigned,value.listed,value.identifiers);
}
// Every member must qualify before any exact retained process handle is used.
// A basename never supplies cleanup authority, and no member is excluded from
// the unchanged whole-Job-zero certificate.
DWORD retireTelemetry(HANDLE job,HANDLE root,TelemetryAuthority& authority,const ProcessIdentity& owner,std::uint64_t rootBirth,ULONGLONG deadline){
  struct Member{DWORD id;Handle process;std::uint64_t birth;};std::vector<Member> retained;std::set<DWORD> members;
  try{
    DWORD exitCode=STILL_ACTIVE;require(WaitForSingleObject(root,0)==WAIT_OBJECT_0&&GetExitCodeProcess(root,&exitCode)&&exitCode==0&&GetTickCount64()<deadline);members=jobMembers(job);if(members.empty())return 0;
    FILETIME now{};GetSystemTimeAsFileTime(&now);
    for(const auto id:members){
      Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_TERMINATE|SYNCHRONIZE,FALSE,id));require(process.valid());BOOL member=FALSE;std::array<wchar_t,32768> image{};DWORD length=static_cast<DWORD>(image.size());
      require(IsProcessInJob(process.value,job,&member)&&QueryFullProcessImageNameW(process.value,0,image.data(),&length)&&length>0&&length<image.size());const auto user=identity(process.value);const auto birth=processBirth(process.value);
      const RetirementFacts facts{true,exitCode==0,GetTickCount64()<deadline,true,_wcsicmp(std::wstring(image.data(),length).c_str(),authority.policy.image.c_str())==0,nativeProcess(process.value),user.sid==owner.sid,user.session==owner.session,!owner.elevated&&!user.elevated,member!=FALSE,WaitForSingleObject(process.value,0)==WAIT_TIMEOUT,birth>=rootBirth&&birth<=timeValue(now)};
      require(mayRetire(facts));retained.push_back(Member{id,std::move(process),birth});
    }
    authority.unchanged();require(jobMembers(job)==members&&GetTickCount64()<deadline);
    for(const auto& value:retained){BOOL member=FALSE;const auto user=identity(value.process.value);require(GetProcessId(value.process.value)==value.id&&IsProcessInJob(value.process.value,job,&member)&&member&&WaitForSingleObject(value.process.value,0)==WAIT_TIMEOUT&&processBirth(value.process.value)==value.birth&&user.sid==owner.sid&&user.session==owner.session&&!user.elevated&&nativeProcess(value.process.value));}
  }catch(...){return 0;}
  // Collection/identity failure above cannot partially retire a mixed Job.
  for(const auto& value:retained){require(GetTickCount64()<deadline);require(TerminateProcess(value.process.value,0));}
  return static_cast<DWORD>(retained.size());
}
void testTelemetryPolicy(){
  Json::Object policy{{"kind","msvc-vctip"},{"path","C:\\ApprovedVS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\VCTIP.exe"},{"sha256",std::string(64,'a')},{"bytes",335288}};
  const Json::Object fields{{"version",1},{"request_id",std::string(64,'a')},{"step","configure"},{"executable","C:\\ApprovedVS\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe"},{"sha256",std::string(64,'b')},{"repository","C:\\Repository"},{"build","C:\\Build"},{"timeout_ms",120000}};
  require(!requestPolicy(fields));auto request=fields;request["version"]=2;request["compiler_telemetry"]=policy;const auto valid=requestPolicy(request);require(valid&&valid->version==L"14.44.35207"&&valid->instance==L"C:\\ApprovedVS");
  for(unsigned n=0;n<18;++n){auto invalid=request;auto item=policy;
    if(n==0)invalid["version"]=3;else if(n==1)invalid["version"]=1;else if(n==2)invalid["step"]="ctest";else if(n==3)invalid["step"]="describe";else if(n==4)invalid.erase("compiler_telemetry");else if(n==5)invalid["executable"]="C:\\OtherVS\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe";
    else{if(n==6)item["kind"]="other";else if(n==7)item["sha256"]=std::string(64,'A');else if(n==8)item["bytes"]=1023;else if(n==9)item["bytes"]=16777217;else if(n==10)item["path"]="C:\\ApprovedVS\\VC\\Tools\\MSVC\\14.45.35207\\bin\\Hostx64\\x64\\VCTIP.exe";else if(n==11)item["extra"]=true;else if(n==12)item["bytes"]=true;else if(n==13)item["path"]="C:\\ApprovedVS\\..\\Other\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\VCTIP.exe";else if(n==14)item["path"]=std::string("C:\\ApprovedVS")+'\0'+"\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\VCTIP.exe";else if(n==15)item["path"]="\\\\server\\ApprovedVS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\VCTIP.exe";else if(n==16)item["path"]="C:\\ApprovedVS\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx86\\x64\\VCTIP.exe";else invalid["compiler_telemetry"]=nullptr;if(n!=17)invalid["compiler_telemetry"]=item;}
    bool rejected=false;try{(void)requestPolicy(invalid);}catch(...){rejected=true;}require(rejected);
  }
  const RetirementFacts facts{true,true,true,true,true,true,true,true,true,true,true,true};require(mayRetire(facts));
  for(unsigned n=0;n<12;++n){auto invalid=facts;switch(n){case 0:invalid.rootSignalled=false;break;case 1:invalid.rootSucceeded=false;break;case 2:invalid.beforeDeadline=false;break;case 3:invalid.listComplete=false;break;case 4:invalid.imageMatches=false;break;case 5:invalid.native=false;break;case 6:invalid.sameUser=false;break;case 7:invalid.sameSession=false;break;case 8:invalid.nonAdmin=false;break;case 9:invalid.member=false;break;case 10:invalid.alive=false;break;default:invalid.birthMatches=false;}require(!mayRetire(invalid));}
  ULONG_PTR identifiers[]{1,2};require(completeMembers(2,2,identifiers)==std::set<DWORD>({1,2})&&completeMembers(0,0,identifiers).empty());
  for(unsigned n=0;n<5;++n){DWORD assigned=2,listed=2;ULONG_PTR invalid[]{1,2};if(n==0)assigned=3;else if(n==1)assigned=listed=censusCapacity+1;else if(n==2)invalid[1]=0;else if(n==3)invalid[1]=1;else invalid[1]=static_cast<ULONG_PTR>(MAXDWORD)+1;bool rejected=false;try{(void)completeMembers(assigned,listed,invalid);}catch(...){rejected=true;}require(rejected);}
}
void testToolMachine(){
  require(approvedImageMachine(IMAGE_FILE_MACHINE_I386,IMAGE_NT_OPTIONAL_HDR32_MAGIC)==IMAGE_FILE_MACHINE_I386&&approvedImageMachine(IMAGE_FILE_MACHINE_AMD64,IMAGE_NT_OPTIONAL_HDR64_MAGIC)==IMAGE_FILE_MACHINE_AMD64);
  require(matchesToolMachine(IMAGE_FILE_MACHINE_I386,true,IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_AMD64)&&matchesToolMachine(IMAGE_FILE_MACHINE_AMD64,true,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_AMD64));
  constexpr std::array<std::array<WORD,2>,5> malformed{{{IMAGE_FILE_MACHINE_I386,IMAGE_NT_OPTIONAL_HDR64_MAGIC},{IMAGE_FILE_MACHINE_AMD64,IMAGE_NT_OPTIONAL_HDR32_MAGIC},{IMAGE_FILE_MACHINE_ARM64,IMAGE_NT_OPTIONAL_HDR64_MAGIC},{0,IMAGE_NT_OPTIONAL_HDR32_MAGIC},{IMAGE_FILE_MACHINE_AMD64,0}}};
  for(const auto& value:malformed){bool rejected=false;try{(void)approvedImageMachine(value[0],value[1]);}catch(...){rejected=true;}require(rejected);}
  require(!matchesToolMachine(IMAGE_FILE_MACHINE_I386,false,IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_AMD64)&&!matchesToolMachine(IMAGE_FILE_MACHINE_AMD64,false,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_AMD64));
  constexpr std::array<std::array<WORD,3>,7> mismatched{{{IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_AMD64},{IMAGE_FILE_MACHINE_AMD64,IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_AMD64},{IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_I386,IMAGE_FILE_MACHINE_I386},{IMAGE_FILE_MACHINE_AMD64,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_ARM64},{IMAGE_FILE_MACHINE_AMD64,IMAGE_FILE_MACHINE_AMD64,IMAGE_FILE_MACHINE_AMD64},{0,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_AMD64},{IMAGE_FILE_MACHINE_ARM64,IMAGE_FILE_MACHINE_UNKNOWN,IMAGE_FILE_MACHINE_AMD64}}};
  for(const auto& value:mismatched)require(!matchesToolMachine(value[0],true,value[1],value[2]));
}
struct ToolTimeoutCensus {
  bool rootSignalled=false,accountingRead=false,listRead=false;
  DWORD active=0,listError=0,assigned=0,listed=0,inspected=0,memberConfirmed=0,unreadable=0,noLongerMember=0;
  // Image basenames are diagnostic labels, never executable authority.
  std::array<DWORD,7> images{}; // cmake, msbuild, cl, mspdbsrv, vctip, conhost, other
};
std::string formatTimeoutCensus(const ToolTimeoutCensus& value){
  require(value.listed<=censusCapacity&&value.inspected<=value.listed&&value.memberConfirmed<=value.inspected&&value.unreadable<=censusCapacity&&value.noLongerMember<=censusCapacity);
  DWORD classified=0;for(const auto count:value.images){require(count<=censusCapacity);classified+=count;}
  require(classified<=value.memberConfirmed&&classified+value.unreadable+value.noLongerMember==value.inspected);
  const auto number=[](DWORD count){return std::to_string(count);};
  return "\nQA tool timeout census: root_signalled="+number(value.rootSignalled?1:0)+"; accounting_read="+number(value.accountingRead?1:0)+"; active="+number(value.active)+"; list_read="+number(value.listRead?1:0)+"; list_error="+number(value.listError)+"; assigned="+number(value.assigned)+"; listed="+number(value.listed)+"; inspected="+number(value.inspected)+"; member_confirmed="+number(value.memberConfirmed)+"; cmake_name="+number(value.images[0])+"; msbuild_name="+number(value.images[1])+"; cl_name="+number(value.images[2])+"; mspdbsrv_name="+number(value.images[3])+"; vctip_name="+number(value.images[4])+"; conhost_name="+number(value.images[5])+"; other_name="+number(value.images[6])+"; unreadable="+number(value.unreadable)+"; no_longer_member="+number(value.noLongerMember)+"\n";
}
std::string timeoutCensus(HANDLE job,HANDLE root){
  ToolTimeoutCensus value;value.rootSignalled=WaitForSingleObject(root,0)==WAIT_OBJECT_0;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};value.accountingRead=QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)!=FALSE;if(value.accountingRead)value.active=accounting.ActiveProcesses;
  struct ProcessList{DWORD assigned;DWORD listed;ULONG_PTR identifiers[censusCapacity];};
  static_assert(offsetof(ProcessList,identifiers)==offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST,ProcessIdList));
  ProcessList members{};value.listRead=QueryInformationJobObject(job,JobObjectBasicProcessIdList,&members,sizeof(members),nullptr)!=FALSE;
  if(!value.listRead)value.listError=GetLastError();
  else if(members.listed>censusCapacity||members.listed>members.assigned){value.listRead=false;value.listError=ERROR_INVALID_DATA;}
  else{
    value.assigned=members.assigned;value.listed=members.listed;
    constexpr const wchar_t* names[]{L"cmake.exe",L"MSBuild.exe",L"cl.exe",L"mspdbsrv.exe",L"VCTIP.exe",L"conhost.exe"};
    for(DWORD n=0;n<value.listed;++n){
      ++value.inspected;
      if(!members.identifiers[n]||members.identifiers[n]>MAXDWORD){++value.unreadable;continue;}
      Handle member(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,static_cast<DWORD>(members.identifiers[n])));BOOL confirmed=FALSE;
      if(!member.valid()||!IsProcessInJob(member.value,job,&confirmed)){++value.unreadable;continue;}
      if(!confirmed){++value.noLongerMember;continue;}
      ++value.memberConfirmed;
      std::array<wchar_t,32768> image{};DWORD length=static_cast<DWORD>(image.size());
      if(!QueryFullProcessImageNameW(member.value,0,image.data(),&length)||!length||length>=image.size()){++value.unreadable;continue;}
      const std::wstring pathName(image.data(),length);const auto separator=pathName.find_last_of(L'\\');
      if(separator==std::wstring::npos){++value.unreadable;continue;}
      const auto basename=pathName.substr(separator+1);std::size_t kind=6;
      for(std::size_t index=0;index<std::size(names);++index)if(_wcsicmp(basename.c_str(),names[index])==0){kind=index;break;}
      ++value.images[kind];
    }
  }
  return formatTimeoutCensus(value);
}
void testTimeoutCensusFormat(){
  ToolTimeoutCensus value;value.rootSignalled=true;value.accountingRead=true;value.listRead=true;value.active=2;value.assigned=2;value.listed=2;value.inspected=2;value.memberConfirmed=2;value.images[0]=1;value.images[5]=1;
  const auto line=formatTimeoutCensus(value);require(line.starts_with("\nQA tool timeout census: root_signalled=1;")&&line.find("; cmake_name=1;")!=std::string::npos&&line.find("; conhost_name=1;")!=std::string::npos&&line.size()<1024);
  auto bounded=value;bounded.active=MAXDWORD;bounded.assigned=MAXDWORD;bounded.listed=censusCapacity;bounded.inspected=censusCapacity;bounded.memberConfirmed=censusCapacity;bounded.images={};bounded.images[6]=censusCapacity;require(formatTimeoutCensus(bounded).size()<1024);
  for(unsigned n=0;n<3;++n){auto invalid=value;if(n==0)invalid.listed=censusCapacity+1;else if(n==1)invalid.images[0]=censusCapacity+1;else invalid.inspected=3;bool rejected=false;try{(void)formatTimeoutCensus(invalid);}catch(const std::runtime_error&){rejected=true;}require(rejected);}
}
Json run(const Json& request,bool isolatedFixture=false){
  failureObservation={};phase(ToolPhase::requestPolicy);
  const auto policy=requestPolicy(request);require(!isolatedFixture||!policy);
  const auto id=request.at("request_id").string(),step=request.at("step").string();require(id.size()==64&&id.find_first_not_of("0123456789abcdef")==std::string::npos);
  require(step=="configure"||step=="compile"||step=="describe"||step=="ctest");phase(ToolPhase::paths);const auto executable=path(request.at("executable").string()),repository=path(request.at("repository").string()),build=path(request.at("build").string());
  const auto timeout=request.at("timeout_ms").integer();require(validToolTimeout(step,timeout));
  const auto leaf=executable.substr(executable.find_last_of(L'\\')+1);require(_wcsicmp(leaf.c_str(),isolatedFixture?L"consumer-native-job-fixture.exe":step=="ctest"?L"ctest.exe":step=="describe"?L"consumer-native-self-test.exe":L"cmake.exe")==0);
  phase(ToolPhase::toolParents);auto executableParents=parents(executable,false),repositoryParents=parents(repository,true),buildParents=parents(build,false);phase(ToolPhase::toolImage);auto image=entry(executable,false,true);
  phase(ToolPhase::toolHash);
  require(request.at("sha256").string().size()==64&&hash(image.value)==request.at("sha256").string());
  std::optional<TelemetryAuthority> telemetry;std::optional<ProcessIdentity> owner;std::optional<WORD> toolMachine;
  if(policy){phase(ToolPhase::toolImage);toolMachine.emplace(peMachine(image.value));telemetry.emplace(*policy);phase(ToolPhase::currentIdentity);owner.emplace(identity(GetCurrentProcess()));phase(ToolPhase::ownerNonadmin);require(!owner->elevated);phase(ToolPhase::ownerSession);require(owner->session!=0);}
  if(step=="describe"&&!isolatedFixture)require(_wcsicmp(executable.c_str(),(build+L"\\Release\\consumer-native-self-test.exe").c_str())==0);
  // Isolated folder grammar prevents targeting an installed runtime/build.
  phase(ToolPhase::isolatedBuild);const auto buildParent=build.substr(0,build.find_last_of(L'\\')),folder=buildParent.substr(buildParent.find_last_of(L'\\')+1);
  require(build.substr(build.find_last_of(L'\\')+1)==L"native-build"&&std::regex_match(folder,std::wregex(L"MusicMuteAcceptance-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")));
  auto command=quote(executable);
  if(isolatedFixture)command+=L" --qa-parent-exits";
  else if(step=="configure")command+=L" -S "+quote(repository+L"\\worker\\native\\windows-consumer")+L" -B "+quote(build)+L" -A x64 -T host=x64"+(policy?L",version="+policy->version+L" -DCMAKE_GENERATOR_INSTANCE="+quote(policy->instance):L"")+L" -DBUILD_TESTING=ON";
  else if(step=="compile")command+=L" --build "+quote(build)+L" --config Release --parallel 2 -- /nodeReuse:false /p:UseSharedCompilation=false";
  else if(step=="describe")command+=L" --describe-target";
  else command+=L" --test-dir "+quote(build)+L" -C Release --output-on-failure --no-tests=error";
  phase(ToolPhase::jobCreate);Handle job(CreateJobObjectW(nullptr,nullptr));require(job.valid());failureObservation.jobCreated=true;JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;require(SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)));
  phase(ToolPhase::pipeCreate);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};Handle output,writer;require(CreatePipe(&output.value,&writer.value,&security,65536));require(SetHandleInformation(output.value,HANDLE_FLAG_INHERIT,0));
  Handle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));require(input.valid());
  phase(ToolPhase::attributeList);SIZE_T attributeBytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&attributeBytes);std::vector<BYTE> attributes(attributeBytes);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());require(InitializeProcThreadAttributeList(list,1,0,&attributeBytes));struct Attributes{LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} attributesLifetime{list};
  HANDLE inherited[]{writer.value,input.value};require(UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr));
  STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdOutput=writer.value;startup.StartupInfo.hStdError=writer.value;startup.StartupInfo.hStdInput=input.value;startup.lpAttributeList=list;PROCESS_INFORMATION process{};auto env=environment();
  // Pipes supply the standard handles without a hidden console host that can
  // outlive an otherwise successful tool and keep its descendant Job active.
  phase(ToolPhase::childCreate);require(CreateProcessW(executable.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|DETACHED_PROCESS|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,env.data(),repository.c_str(),&startup.StartupInfo,&process));failureObservation.childCreated=true;Handle child(process.hProcess),thread(process.hThread);
  phase(ToolPhase::jobAssign);
  if(!AssignProcessToJobObject(job.value,child.value)){TerminateProcess(child.value,2);WaitForSingleObject(child.value,10000);bad();}
  phase(ToolPhase::childIdentity);const auto rootBirth=processBirth(child.value);
  if(owner){const auto rootOwner=identity(child.value);phase(ToolPhase::childNative);USHORT processMachine=0,nativeMachine=0;const bool queried=IsWow64Process2(child.value,&processMachine,&nativeMachine)!=FALSE;require(matchesToolMachine(*toolMachine,queried,processMachine,nativeMachine));phase(ToolPhase::childNonadmin);require(!rootOwner.elevated);phase(ToolPhase::childSession);require(rootOwner.session==owner->session);phase(ToolPhase::childUser);require(rootOwner.sid==owner->sid);}
  phase(ToolPhase::childResume);require(ResumeThread(thread.value)!=static_cast<DWORD>(-1));require(CloseHandle(writer.value));writer.value=nullptr;
  std::vector<BYTE> captured;const auto deadline=GetTickCount64()+static_cast<ULONGLONG>(timeout);std::string reason="completed";bool terminated=false;ULONGLONG nextTelemetryCheck=0;
  for(;;){phase(ToolPhase::outputLoop);DWORD available=0;const bool readable=PeekNamedPipe(output.value,nullptr,0,nullptr,&available,nullptr)!=FALSE;
    if(!readable&&GetLastError()!=ERROR_BROKEN_PIPE)bad();
    if(available){std::vector<BYTE> bytes(std::min<DWORD>(available,65536));DWORD count=0;require(ReadFile(output.value,bytes.data(),static_cast<DWORD>(bytes.size()),&count,nullptr));
      if(captured.size()+count>1024*1024){if(!terminated){require(TerminateJobObject(job.value,2));terminated=true;reason="overflow";}}
      else captured.insert(captured.end(),bytes.begin(),bytes.begin()+count);
    }
    const bool exited=WaitForSingleObject(child.value,0)==WAIT_OBJECT_0;
    if(exited&&jobEmpty(job.value)&&!available)break;
    if(telemetry&&exited&&!terminated&&GetTickCount64()<deadline&&GetTickCount64()>=nextTelemetryCheck){
      nextTelemetryCheck=GetTickCount64()+1000;
      const auto retired=retireTelemetry(job.value,child.value,*telemetry,*owner,rootBirth,deadline);
      if(retired){const auto diagnostic="\nQA tool pinned compiler telemetry retired: count="+std::to_string(retired)+"\n";if(captured.size()+diagnostic.size()<=1024*1024)captured.insert(captured.end(),diagnostic.begin(),diagnostic.end());}
    }
    if(GetTickCount64()>=deadline&&!terminated){
      // Best effort only: metadata failure or a full output cap cannot skip
      // termination or substitute for the unchanged actual Job-zero check.
      try{const auto diagnostic=timeoutCensus(job.value,child.value);if(captured.size()+diagnostic.size()<=1024*1024)captured.insert(captured.end(),diagnostic.begin(),diagnostic.end());}catch(...){}
      require(TerminateJobObject(job.value,2));terminated=true;reason="timeout";
    }
    // There is intentionally no false cleanup certificate after a kill ACK.
    // If actual zero cannot be established, retain the guard/Job until process
    // retirement or operator intervention; the outer harness fails closed.
    Sleep(5);
  }
  phase(ToolPhase::jobZero);require(jobEmpty(job.value));DWORD exitCode=2;require(GetExitCodeProcess(child.value,&exitCode)&&exitCode!=STILL_ACTIVE);
  return Json::Object{{"version",1},{"request_id",id},{"step",step},{"exit_code",static_cast<std::int64_t>(exitCode)},{"active_processes",0},{"cleanup","confirmed"},{"reason",reason},{"output_base64",base64(captured)}};
}
int isolatedGuardTest(const std::wstring& fixtureArgument) {
  testToolTimeout();
  testFailureObservation();
  testTimeoutCensusFormat();
  testTelemetryPolicy();
  testToolMachine();
  // Exercise the real identity APIs even when the bootstrap itself is elevated.
  // Only the existing v2 policy gate requires a non-admin interactive owner.
  const auto current=identity(GetCurrentProcess());DWORD processSession=0;
  require(!current.sid.empty()&&IsValidSid(const_cast<BYTE*>(current.sid.data()))&&ProcessIdToSessionId(GetCurrentProcessId(),&processSession)&&processSession==current.session);
  // CMake's TARGET_FILE passes forward separators on Windows. Normalize only
  // this QA sibling argument; the production request path grammar stays strict.
  auto fixture=fixtureArgument;std::replace(fixture.begin(),fixture.end(),L'/',L'\\');
  std::vector<wchar_t> self(32768);const auto count=GetModuleFileNameW(nullptr,self.data(),static_cast<DWORD>(self.size()));require(count>0&&count<self.size());
  const std::wstring image(self.data(),count);require(_wcsicmp(fixture.c_str(),(image.substr(0,image.find_last_of(L'\\'))+L"\\consumer-native-job-fixture.exe").c_str())==0);
  {auto exact=entry(image,false,true);USHORT processMachine=0,nativeMachine=0;const bool queried=IsWow64Process2(GetCurrentProcess(),&processMachine,&nativeMachine)!=FALSE;require(matchesToolMachine(peMachine(exact.value),queried,processMachine,nativeMachine));}
  wchar_t temporary[32768]{};const auto length=GetTempPathW(32768,temporary);require(length>0&&length<32768);
  BYTE random[16]{};require(BCryptGenRandom(nullptr,random,16,BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0);random[6]=(random[6]&15)|64;random[8]=(random[8]&63)|128;
  constexpr char hex[]="0123456789abcdef";std::string uuid;for(unsigned n=0;n<16;++n){if(n==4||n==6||n==8||n==10)uuid+='-';uuid+=hex[random[n]>>4];uuid+=hex[random[n]&15];}
  const auto root=std::wstring(temporary,length)+L"MusicMuteAcceptance-"+wide(uuid);require(CreateDirectoryW(root.c_str(),nullptr));
  std::string sha;{auto exact=entry(fixture,false,true);sha=hash(exact.value);}
  const auto narrow=[](const std::wstring& text){const auto size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);require(size>0);std::string result(static_cast<std::size_t>(size),'\0');require(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),size,nullptr,nullptr)==size);return result;};
  const Json request=Json::Object{{"version",1},{"request_id",std::string(64,'a')},{"step","describe"},{"executable",narrow(fixture)},{"sha256",sha},{"repository",narrow(root)},{"build",narrow(root+L"\\native-build")},{"timeout_ms",10000}};
  const auto started=GetTickCount64();const auto receipt=run(request,true);
  require(receipt.at("exit_code").integer()==0&&receipt.at("active_processes").integer()==0&&receipt.at("reason").string()=="completed"&&GetTickCount64()-started>=1000);
  auto timeoutRequest=request.object();timeoutRequest["request_id"]=std::string(64,'b');timeoutRequest["timeout_ms"]=1000;
  const auto timeoutStarted=GetTickCount64();const auto timeoutReceipt=run(timeoutRequest,true);
  require(timeoutReceipt.at("exit_code").integer()==0&&timeoutReceipt.at("active_processes").integer()==0&&timeoutReceipt.at("reason").string()=="timeout"&&GetTickCount64()-timeoutStarted>=1000);
  const auto encoded=timeoutReceipt.at("output_base64").string();DWORD decodedBytes=0;
  require(CryptStringToBinaryA(encoded.c_str(),static_cast<DWORD>(encoded.size()),CRYPT_STRING_BASE64,nullptr,&decodedBytes,nullptr,nullptr)&&decodedBytes<=1024*1024);
  std::string diagnostic(decodedBytes,'\0');require(CryptStringToBinaryA(encoded.c_str(),static_cast<DWORD>(encoded.size()),CRYPT_STRING_BASE64,reinterpret_cast<BYTE*>(diagnostic.data()),&decodedBytes,nullptr,nullptr));diagnostic.resize(decodedBytes);
  require(diagnostic.starts_with("\nQA tool timeout census: root_signalled=1;")&&diagnostic.find("; list_read=1;")!=std::string::npos);
  // Positive Job-zero only; leave the isolated empty directory for the operator,
  // rather than adding an unrelated recursive/path-based deletion capability.
  std::cout<<"QA guard waited for actual descendant Job zero\n";return 0;
}
}
int wmain(int argc,wchar_t** argv){
  try{
    USHORT process=0,native=0;require(IsWow64Process2(GetCurrentProcess(),&process,&native)&&native==IMAGE_FILE_MACHINE_AMD64&&(process==IMAGE_FILE_MACHINE_UNKNOWN||process==IMAGE_FILE_MACHINE_AMD64));
    OSVERSIONINFOEXW version{};version.dwOSVersionInfoSize=sizeof(version);using Query=LONG(WINAPI*)(PRTL_OSVERSIONINFOW);const auto query=reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlGetVersion"));require(query&&query(reinterpret_cast<PRTL_OSVERSIONINFOW>(&version))==0&&version.dwMajorVersion==10&&version.dwBuildNumber>=19045&&version.wProductType==VER_NT_WORKSTATION);
    if(argc==3&&std::wstring(argv[1])==L"--qa-self-test"){phase(ToolPhase::selfTest);return isolatedGuardTest(argv[2]);}
    phase(ToolPhase::requestInput);
    require(argc==2&&std::wstring(argv[1])==L"--qa-tool");
    std::string request;char ch=0;while(std::cin.get(ch)&&ch!='\n'){require(request.size()<16384);request+=ch;}
    const auto result=run(mm::JsonParser(request).parse());phase(ToolPhase::receiptWrite);std::cout<<mm::dump(result)<<'\n'<<std::flush;require(std::cout.good());return 0;
  }catch(...){std::cerr<<"ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED\n";try{std::cerr<<formatFailureObservation(failureObservation);}catch(...){}return 2;}
}
