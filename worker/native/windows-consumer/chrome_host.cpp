#define MUSICMUTE_CONSUMER_NATIVE_LIBRARY
#include "main.cpp"
#include "store_browser.hpp"

namespace {
bool readChrome(void* target,DWORD count,bool header=false){DWORD offset=0;while(offset<count){DWORD read=0;if(!ReadFile(GetStdHandle(STD_INPUT_HANDLE),static_cast<BYTE*>(target)+offset,count-offset,&read,nullptr))return false;if(read==0){if(header&&offset==0)return false;fail("FRAME_TOO_LARGE");}offset+=read;}return true;}
void chromeWrite(const Json& reply){const auto body=mm::dump(reply);if(body.size()>65536)fail("FRAME_TOO_LARGE");const DWORD count=static_cast<DWORD>(body.size());DWORD wrote=0;check(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),&count,4,&wrote,nullptr)&&wrote==4,"PIPE_UNAVAILABLE");check(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),body.data(),count,&wrote,nullptr)&&wrote==count,"PIPE_UNAVAILABLE");}
int missingRuntime(const char* code){
  DWORD count=0;
  while(readChrome(&count,4,true)){
    if(count<2||count>65536)return 2;std::string bytes(count,'\0');if(!readChrome(bytes.data(),count))return 2;
    const auto request=mm::JsonParser(bytes,true).parse();SecureZeroMemory(bytes.data(),bytes.size());keys(request,{"protocol_version","request_id","type","payload"});
    const auto id=request.at("request_id").string(),type=request.at("type").string();
    if(request.at("protocol_version").integer()!=1||id.size()!=36||id.find_first_not_of("0123456789abcdefABCDEF-")!=std::string::npos)return 2;
    if(type=="HELLO")chromeWrite(Json::Object{{"protocol_version",1},{"request_id",id},{"type","HELLO"},{"payload",Json::Object{{"ready",false},{"version","0.1.3"},{"platform","win32"},{"arch","x64"},{"max_duration_seconds",1200},{"error_code",code},{"capabilities",Json::Array{}}}}});
    else chromeWrite(Json::Object{{"protocol_version",1},{"request_id",id},{"type","ERROR"},{"payload",Json::Object{{"error_code",code}}}});
  }
  return 0;
}
}
int wmain(int argc,wchar_t** argv){
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
  try{
    if(argc<2||argc>3)return 2;
    const std::wstring origin(argv[1]);
    if(argc==3){const std::wstring argument(argv[2]),prefix=L"--parent-window=";if(!argument.starts_with(prefix)||argument.size()>prefix.size()+20||argument.size()==prefix.size()||argument.substr(prefix.size()).find_first_not_of(L"0123456789")!=std::wstring::npos)return 2;}
    // Any attached package routes exclusively through current registered Store
    // authority. None/developer packages cannot reach the legacy publisher path.
    if(registeredPackageContext())return runStoreChromeHost(origin,argc==3?std::wstring(argv[2]):std::wstring{});
    const auto record=browserProtectedRecord();if(std::holds_alternative<std::nullptr_t>(record.value))return 2;assertOwnedBrowserRegistration(record);
    if(origin!=L"chrome-extension://"+wide(record.at("extension_id").string())+L"/")return 2;
    std::vector<wchar_t> image(32768);const auto imageSize=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));if(imageSize==0||imageSize>=image.size()||_wcsicmp(std::wstring(image.data(),imageSize).c_str(),fixedChromeHostPath().c_str())!=0)return 2;
    auto self=lockHashedFile(fixedChromeHostPath(),record.at("host_sha256").string(),true);
    const auto identity=identityReport();if(identity.at("native_arch").string()!="x64"||identity.at("process_arch").string()!="x64"||identity.at("os_major").integer()!=10||identity.at("os_build").integer()<19045)return missingRuntime("LOCAL_PLATFORM_UNSUPPORTED");
    // Electron's bundled Node proxy has no model/runtime/GPU preparation gate.
    const auto entry=fixedBrowserEntryPath();auto entryFile=lockHashedFile(entry,record.at("entry_sha256").string(),true);
    const auto resources=entry.substr(0,entry.find_last_of(L'\\')).substr(0,entry.substr(0,entry.find_last_of(L'\\')).find_last_of(L'\\'));
    const auto app=fixedAccountAppPath();auto appAncestors=lockAccountAppAncestors(app),entryAncestors=lockAccountAppAncestors(entry);auto appFile=verifiedAccountApp(installedAccountAppPin());
    std::wstring command=quote(app)+L" --native-browser-stdio --origin "+quote(origin)+L" --resources "+quote(resources);
    Handle input=inheritedCopy(GetStdHandle(STD_INPUT_HANDLE),0,true),output=inheritedCopy(GetStdHandle(STD_OUTPUT_HANDLE),0,true),error=inheritedCopy(GetStdHandle(STD_ERROR_HANDLE),0,true);
    SIZE_T attributeSize=0;InitializeProcThreadAttributeList(nullptr,1,0,&attributeSize);std::vector<BYTE> attributes(attributeSize);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());check(InitializeProcThreadAttributeList(list,1,0,&attributeSize),"JOB_UNAVAILABLE");
    struct Attributes{LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} lifetime{list};HANDLE inherited[]{input.value,output.value,error.value};check(UpdateProcThreadAttribute(list,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr),"JOB_UNAVAILABLE");
    auto environment=consumerEnvironment(app.substr(0,app.find_last_of(L'\\')));
    Handle job(CreateJobObjectW(nullptr,nullptr));if(!job.valid())fail("JOB_UNAVAILABLE");JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_BREAKAWAY_OK;check(SetInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"JOB_UNAVAILABLE");
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=input.value;startup.StartupInfo.hStdOutput=output.value;startup.StartupInfo.hStdError=error.value;startup.lpAttributeList=list;PROCESS_INFORMATION child{};
    check(CreateProcessW(app.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,environment.data(),rootPath("personal").c_str(),&startup.StartupInfo,&child),"JOB_UNAVAILABLE");Handle process(child.hProcess),thread(child.hThread);
    if(!AssignProcessToJobObject(job.value,process.value)){TerminateProcess(process.value,2);fail("JOB_UNAVAILABLE");}if(ResumeThread(thread.value)==static_cast<DWORD>(-1))fail("JOB_UNAVAILABLE");
    if(WaitForSingleObject(process.value,INFINITE)!=WAIT_OBJECT_0)return 2;DWORD exit=2;check(GetExitCodeProcess(process.value,&exit),"JOB_UNAVAILABLE");return exit==0?0:2;
  }catch(...){return 2;}
}
