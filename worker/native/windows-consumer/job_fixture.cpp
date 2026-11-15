#include <windows.h>
#include <string>
#include <atomic>
#include <thread>
#include "transport_terminal.hpp"

// Publish only complete, closed fixture bytes. Existence of the final marker
// must not race a writer handle or a partially written PID/ready payload.
bool publishFixtureMarker(const std::wstring& marker,const std::string& bytes) {
  const auto pending=marker+L".pending";
  const auto file=CreateFileW(pending.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE)return false;
  DWORD wrote=0;
  const bool saved=WriteFile(file,bytes.data(),static_cast<DWORD>(bytes.size()),&wrote,nullptr)&&wrote==bytes.size()&&FlushFileBuffers(file);
  const bool closed=CloseHandle(file)!=FALSE;
  return saved&&closed&&MoveFileExW(pending.c_str(),marker.c_str(),MOVEFILE_WRITE_THROUGH)!=FALSE;
}

int wmain(int argc, wchar_t** argv) {
  if(argc==2&&std::wstring(argv[1])==L"--qa-brief-leaf"){Sleep(1200);return 0;}
  if(argc==2&&std::wstring(argv[1])==L"--qa-parent-exits"){
    wchar_t executable[32768]{};const auto size=GetModuleFileNameW(nullptr,executable,32768);if(!size||size>=32768)return 2;
    auto command=L"\""+std::wstring(executable)+L"\" --qa-brief-leaf";STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION child{};
    if(!CreateProcessW(executable,command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child))return 2;
    CloseHandle(child.hThread);CloseHandle(child.hProcess);return 0;
  }
  if(argc==2&&std::wstring(argv[1])==L"--transport-terminal") {
    std::atomic<unsigned> active{0};
    for(unsigned i=0;i<4;++i)std::thread([&]{++active;for(;;)Sleep(1);}).detach();
    while(active.load()!=4)Sleep(1);
    mm::terminateConsumerTransport(2);
  }
  if(argc==4&&std::wstring(argv[1])==L"--gpu-mutex") {
    const auto mutex=OpenMutexW(SYNCHRONIZE|MUTEX_MODIFY_STATE,FALSE,argv[2]);if(!mutex||WaitForSingleObject(mutex,0)!=WAIT_OBJECT_0)return 2;
    if(!publishFixtureMarker(argv[3],"ready"))return 2;Sleep(INFINITE);return 0;
  }
  if (argc == 2 && std::wstring(argv[1]) == L"--leaf") { Sleep(INFINITE); return 0; }
  if (argc != 4 || std::wstring(argv[2]) != L"--consumer-config") return 2;
  wchar_t executable[32768]{};
  const DWORD count = GetModuleFileNameW(nullptr, executable, 32768);
  if (!count || count >= 32768) return 2;
  std::wstring command = L"\"" + std::wstring(executable) + L"\" --leaf";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) return 2;
  CloseHandle(process.hThread); CloseHandle(process.hProcess);
  const auto marker = std::wstring(argv[3]) + L".child-pid";
  const auto pid = std::to_string(process.dwProcessId);
  if (!publishFixtureMarker(marker,pid)) return 2;
  Sleep(INFINITE);
  return 0;
}
