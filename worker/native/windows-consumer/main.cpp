#include "json.hpp"
#include <winsock2.h>
#include <ws2ipdef.h>
#include <windows.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>
#include <shlobj.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <winternl.h>
#include <winver.h>
#include <wtsapi32.h>
#include <tlhelp32.h>
#include <dxgi1_2.h>
#include <d3d12.h>
#include <shobjidl_core.h>
#include <xmllite.h>
#include <shlwapi.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cctype>
#include <cstring>
#include <cwctype>
#include <cwchar>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <set>
#include <regex>
#include <sstream>
#include <thread>
#include <utility>
#include <map>
#include "store_authority.hpp"
#include "store_diagnostics.hpp"
#include "store_startup.hpp"
#include "store_inventory.hpp"
#include "store_namespace.hpp"
#include "store_gui_issuer_policy.hpp"
#include "store_role.hpp"
#include "store_data_policy.hpp"
#include "store_share_policy.hpp"
#include "store_model_policy.hpp"

using mm::Json;
namespace {
constexpr std::size_t maxFrame = 65536;
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
std::wstring isolatedTestRoot;
#endif
struct Failure : std::exception {
  std::string code;
  mmstorediagnostic::ErrorNumbers diagnostic;
  explicit Failure(std::string value, mmstorediagnostic::ErrorNumbers observed = {})
    : code(std::move(value)), diagnostic(observed) {}
  const char* what() const noexcept override { return code.c_str(); }
};
[[noreturn]] void fail(const char* code) { throw Failure(code); }
void check(BOOL result, const char* code) { if (!result) fail(code); }
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE handle) : value(handle) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(std::exchange(other.value, nullptr)) {}
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { close(); value = std::exchange(other.value, nullptr); } return *this; }
  ~Handle() { close(); }
  void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
  bool valid() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct LocalMemory {
  void* value = nullptr;
  ~LocalMemory() { if (value) LocalFree(value); }
};
std::wstring wide(const std::string& text) {
  if (text.empty()) return {};
  const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!count) fail("BAD_REQUEST");
  std::wstring result(static_cast<std::size_t>(count), L'\0');
  check(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count), "BAD_REQUEST");
  return result;
}
std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!count) fail("IDENTITY_UNAVAILABLE");
  std::string result(static_cast<std::size_t>(count), '\0');
  check(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr), "IDENTITY_UNAVAILABLE");
  return result;
}
std::string sidString(PSID sid) {
  LPWSTR text = nullptr;
  check(ConvertSidToStringSidW(sid, &text), "IDENTITY_UNAVAILABLE");
  LocalMemory memory{ text };
  return utf8(text);
}
std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD count = 0;
  GetTokenInformation(token, kind, nullptr, 0, &count);
  if (!count || count > 65536) fail("IDENTITY_UNAVAILABLE");
  std::vector<BYTE> bytes(count);
  check(GetTokenInformation(token, kind, bytes.data(), count, &count), "IDENTITY_UNAVAILABLE");
  return bytes;
}
struct Identity {
  std::string sid;
  std::string logonSid;
  DWORD session = 0;
};
Identity tokenIdentity(HANDLE token) {
  const auto user = tokenInfo(token, TokenUser);
  const auto groups = tokenInfo(token, TokenGroups);
  Identity result;
  result.sid = sidString(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid);
  const auto* tokenGroups = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  for (DWORD index = 0; index < tokenGroups->GroupCount; ++index)
    if ((tokenGroups->Groups[index].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
      result.logonSid = sidString(tokenGroups->Groups[index].Sid);
  if (result.logonSid.empty()) fail("INTERACTIVE_SESSION_REQUIRED");
  const auto session = tokenInfo(token, TokenSessionId);
  result.session = *reinterpret_cast<const DWORD*>(session.data());
  if (result.session == 0) fail("INTERACTIVE_SESSION_REQUIRED");
  return result;
}
Identity currentIdentity() {
  Handle token;
  check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value), "IDENTITY_UNAVAILABLE");
  const auto elevation=tokenInfo(token.value,TokenElevation);if(reinterpret_cast<const TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated)fail("UNSUPPORTED_HOST");
  return tokenIdentity(token.value);
}
std::string creation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  check(GetProcessTimes(process, &created, &exited, &kernel, &user), "IDENTITY_UNAVAILABLE");
  const auto value = (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  return std::to_string(value);
}
Json processIdentity(DWORD pid, bool absentAllowed = false) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  if (!process.valid()) {
    if (absentAllowed && GetLastError() == ERROR_INVALID_PARAMETER) return nullptr;
    fail("IDENTITY_UNAVAILABLE");
  }
  if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) return nullptr;
  Handle token;
  check(OpenProcessToken(process.value, TOKEN_QUERY, &token.value), "IDENTITY_UNAVAILABLE");
  const auto identity = tokenIdentity(token.value);
  return Json::Object{{"sid", identity.sid}, {"session_id", static_cast<std::int64_t>(identity.session)}, {"pid", static_cast<std::int64_t>(pid)}, {"creation_time", creation(process.value)}};
}
std::string architecture(USHORT machine) {
  if (machine == IMAGE_FILE_MACHINE_AMD64) return "x64";
  if (machine == IMAGE_FILE_MACHINE_ARM64) return "arm64";
  if (machine == IMAGE_FILE_MACHINE_I386) return "x86";
  return "unknown";
}
bool supportedConsumerWindowsVersion(DWORD major,DWORD build,BYTE productType) {
  return major==10&&build>=19045&&productType==VER_NT_WORKSTATION;
}
Json identityReport() {
  const auto identity = currentIdentity();
  using Wow64Process2 = BOOL(WINAPI*)(HANDLE, USHORT*, USHORT*);
  const auto query = reinterpret_cast<Wow64Process2>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2"));
  if (!query) fail("IDENTITY_UNAVAILABLE");
  USHORT processMachine = 0, nativeMachine = 0;
  check(query(GetCurrentProcess(), &processMachine, &nativeMachine), "IDENTITY_UNAVAILABLE");
  using VersionQuery = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
  const auto versionQuery = reinterpret_cast<VersionQuery>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOEXW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  if (!versionQuery || versionQuery(reinterpret_cast<PRTL_OSVERSIONINFOW>(&version)) != 0) fail("IDENTITY_UNAVAILABLE");
  if(!supportedConsumerWindowsVersion(version.dwMajorVersion,version.dwBuildNumber,version.wProductType))fail("UNSUPPORTED_HOST");
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &folder))) fail("PATH_UNSAFE");
  const std::wstring localAppData(folder);
  CoTaskMemFree(folder);
  return Json::Object{{"sid", identity.sid}, {"logon_sid", identity.logonSid}, {"session_id", static_cast<std::int64_t>(identity.session)}, {"pid", static_cast<std::int64_t>(GetCurrentProcessId())}, {"creation_time", creation(GetCurrentProcess())}, {"native_arch", architecture(nativeMachine)}, {"process_arch", architecture(processMachine ? processMachine : nativeMachine)}, {"os_build", static_cast<std::int64_t>(version.dwBuildNumber)}, {"os_major", static_cast<std::int64_t>(version.dwMajorVersion)}, {"local_app_data", utf8(localAppData)}};
}
std::wstring relativePath(const std::string& text, bool emptyAllowed = false) {
  if (text.empty()) { if (emptyAllowed) return {}; fail("PATH_UNSAFE"); }
  if (text.size() > 4096 || text.find_first_of("/:\r\n\0") != std::string::npos || text.front() == '\\' || text.back() == '\\') fail("PATH_UNSAFE");
  const auto value = wide(text);
  std::size_t position = 0;
  while (position < value.size()) {
    const auto separator = value.find(L'\\', position);
    const auto end = separator == std::wstring::npos ? value.size() : separator;
    auto part = value.substr(position, end - position);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ' || part.find_first_of(L"<>\"|?*") != std::wstring::npos) fail("PATH_UNSAFE");
    for (const wchar_t c : part) if (c < 32) fail("PATH_UNSAFE");
    auto stem = part.substr(0, part.find(L'.'));
    std::transform(stem.begin(), stem.end(), stem.begin(), [](wchar_t c) { return static_cast<wchar_t>(towupper(c)); });
    if (stem == L"CON" || stem == L"PRN" || stem == L"AUX" || stem == L"NUL" || (stem.size() == 4 && (stem.substr(0, 3) == L"COM" || stem.substr(0, 3) == L"LPT") && ((stem[3] >= L'1' && stem[3] <= L'9') || stem[3] == L'\u00B9' || stem[3] == L'\u00B2' || stem[3] == L'\u00B3'))) fail("PATH_UNSAFE");
    position = end + 1;
  }
  return value;
}
bool registeredPackageContext();
bool developmentPackageNamespace() {
  return mmstoreprofile::developmentTest && registeredPackageContext();
}
std::wstring rootPath(const std::string& kind) {
  if (kind != "personal" && kind != "fleet") fail("BAD_REQUEST");
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &folder))) fail("PATH_UNSAFE");
  std::wstring result(folder); CoTaskMemFree(folder);
  if (result.size() < 3 || result[1] != L':' || result[2] != L'\\' || result.find_first_of(L"\r\n") != std::wstring::npos) fail("PATH_UNSAFE");
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if (!isolatedTestRoot.empty()) result = isolatedTestRoot;
#endif
  if (developmentPackageNamespace())
    return result + L"\\" + std::wstring(kind == "personal" ? mmstoreprofile::personalDataLeaf : mmstoreprofile::fleetDataLeaf);
  return result + (kind == "personal" ? L"\\MusicMuteLocal" : L"\\MusicMuteWorker");
}
std::wstring privateKernelSid() {
  auto sid = wide(currentIdentity().sid);
  if (developmentPackageNamespace()) sid += L"-Development";
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  if (!isolatedTestRoot.empty()) sid += L"-Test-" + isolatedTestRoot.substr(isolatedTestRoot.size() - 64);
#endif
  return sid;
}
struct Security {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE};
  explicit Security(const std::wstring& sddl) {
    check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr), "ACL_UNSAFE");
    attributes.lpSecurityDescriptor = descriptor;
  }
  ~Security() { if (descriptor) LocalFree(descriptor); }
};
std::wstring dataSddl() {
  const auto sid = wide(currentIdentity().sid);
  return L"O:" + sid + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
}
void assertPrivateHandle(HANDLE handle, bool protectedRequired = false, bool allowAdministrators = false) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) fail("ACL_UNSAFE");
  LocalMemory memory{descriptor};
  if (!owner || sidString(owner) != currentIdentity().sid || !acl) fail("ACL_UNSAFE");
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  check(GetSecurityDescriptorControl(descriptor, &control, &revision), "ACL_UNSAFE");
  if ((protectedRequired && !(control & SE_DACL_PROTECTED)) || acl->AceCount == 0) fail("ACL_UNSAFE");
  for (DWORD n = 0; n < acl->AceCount; ++n) {
    void* entry = nullptr; check(GetAce(acl, n, &entry), "ACL_UNSAFE");
    const auto* header = static_cast<const ACE_HEADER*>(entry);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) fail("ACL_UNSAFE");
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(entry);
    const auto sid = sidString(const_cast<DWORD*>(&ace->SidStart));
    if (sid != currentIdentity().sid && sid != "S-1-5-18" && !(allowAdministrators && sid == "S-1-5-32-544")) fail("ACL_UNSAFE");
  }
}
enum class NativeChildKind {file,directory,any};
enum class NativeChildDisposition : ULONG {open=1,createNew=2};
struct NativeRelativeOpen {Handle handle;NTSTATUS status;};
constexpr ULONG nativeNameMissing=0xc0000034UL;
constexpr ULONG nativeReparseEncountered=0xc0000280UL;
void nativeLeaf(const std::wstring& leaf){
  if(leaf.empty()||leaf.size()>255||leaf.find(L'\\')!=std::wstring::npos||leaf.find(L'\0')!=std::wstring::npos||relativePath(utf8(leaf))!=leaf)fail("PATH_UNSAFE");
}
std::wstring nativeCanonical(HANDLE file){
  std::vector<wchar_t> buffer(32768);const auto count=GetFinalPathNameByHandleW(file,buffer.data(),static_cast<DWORD>(buffer.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if(!count||count>=buffer.size())fail("PATH_UNSAFE");std::wstring result(buffer.data(),count);if(result.starts_with(L"\\\\?\\"))result.erase(0,4);return result;
}
BY_HANDLE_FILE_INFORMATION nativeEntryInformation(HANDLE file,NativeChildKind kind){
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file,&info),"PATH_UNSAFE");
  const bool directory=(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)!=0;
  if((info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||(kind!=NativeChildKind::any&&directory!=(kind==NativeChildKind::directory))||(!directory&&info.nNumberOfLinks!=1))fail("PATH_UNSAFE");return info;
}
NativeRelativeOpen openNativeChild(HANDLE parent,const std::wstring& leaf,ACCESS_MASK access,DWORD sharing,NativeChildKind kind,NativeChildDisposition disposition,PSECURITY_DESCRIPTOR security=nullptr,bool writeThrough=false,Handle* retained=nullptr){
  nativeLeaf(leaf);
  if(retained&&retained->valid())fail("PATH_UNSAFE");
  if((kind!=NativeChildKind::file&&kind!=NativeChildKind::directory&&kind!=NativeChildKind::any)||(disposition!=NativeChildDisposition::open&&disposition!=NativeChildDisposition::createNew)||(kind==NativeChildKind::any&&disposition!=NativeChildDisposition::open))fail("PATH_UNSAFE");
  // Keep the explicit prototype's reparse-parent test meaningful: the native
  // OBJ_DONT_REPARSE resolution must reject it, without a path-based fallback.
  BY_HANDLE_FILE_INFORMATION parentInfo{};check(GetFileInformationByHandle(parent,&parentInfo),"PATH_UNSAFE");if(!(parentInfo.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))fail("PATH_UNSAFE");
  using Create=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
  using DosError=ULONG(NTAPI*)(NTSTATUS);
  const auto module=GetModuleHandleW(L"ntdll.dll");const auto create=reinterpret_cast<Create>(GetProcAddress(module,"NtCreateFile"));const auto error=reinterpret_cast<DosError>(GetProcAddress(module,"RtlNtStatusToDosError"));if(!create||!error)fail("PATH_UNSAFE");
  UNICODE_STRING name{};name.Length=static_cast<USHORT>(leaf.size()*sizeof(wchar_t));name.MaximumLength=static_cast<USHORT>((leaf.size()+1)*sizeof(wchar_t));name.Buffer=const_cast<PWSTR>(leaf.c_str());
  OBJECT_ATTRIBUTES attributes{};attributes.Length=sizeof(attributes);attributes.RootDirectory=parent;attributes.ObjectName=&name;attributes.Attributes=0x40|0x1000; /* OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE; no OBJ_INHERIT. */ attributes.SecurityDescriptor=security;
  const ULONG options=0x20|0x00200000|(writeThrough?0x2:0)|(kind==NativeChildKind::directory?0x1:kind==NativeChildKind::file?0x40:0);
  // Synchronization and metadata reads are required by this helper itself,
  // even when the caller asks only for data or attribute writes.
  IO_STATUS_BLOCK io{};HANDLE opened=nullptr;const auto status=create(&opened,access|SYNCHRONIZE|FILE_READ_ATTRIBUTES,&attributes,&io,nullptr,FILE_ATTRIBUTE_NORMAL,sharing,static_cast<ULONG>(disposition),options,nullptr,0);
  Handle result(opened);
  if(retained){
    *retained=std::move(result);
    if(status!=0){SetLastError(error(status));return {Handle(INVALID_HANDLE_VALUE),status};}
    if(!retained->valid())fail("PATH_UNSAFE");nativeEntryInformation(retained->value,kind);return {Handle{},status};
  }
  if(status!=0){result.close();SetLastError(error(status));return {Handle(INVALID_HANDLE_VALUE),status};}
  if(!result.valid())fail("PATH_UNSAFE");nativeEntryInformation(result.value,kind);return {std::move(result),status};
}
enum class NativeFileInformation : ULONG {rename=10};
struct NativeRelativeRename {NTSTATUS status;DWORD error;};
[[maybe_unused]] NativeRelativeRename renameNativeChild(HANDLE source,HANDLE parent,const std::wstring& leaf){
  // Both objects are already retained by the caller. Resolve only this one
  // validated destination component; never reopen an absolute target path.
  nativeLeaf(leaf);
  BY_HANDLE_FILE_INFORMATION parentInfo{};check(GetFileInformationByHandle(parent,&parentInfo),"PATH_UNSAFE");if(!(parentInfo.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY))fail("PATH_UNSAFE");
  // FileRenameInformation (10) uses this native x64 layout. The SDK's public
  // FILE_INFORMATION_CLASS enum exposes fewer values; use a closed 32-bit enum.
  static_assert(sizeof(NativeFileInformation)==4&&sizeof(FILE_RENAME_INFO)==24&&offsetof(FILE_RENAME_INFO,RootDirectory)==8&&offsetof(FILE_RENAME_INFO,FileNameLength)==16&&offsetof(FILE_RENAME_INFO,FileName)==20);
  using SetInformation=NTSTATUS(NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,NativeFileInformation);
  using DosError=ULONG(NTAPI*)(NTSTATUS);
  const auto module=GetModuleHandleW(L"ntdll.dll");const auto set=reinterpret_cast<SetInformation>(GetProcAddress(module,"NtSetInformationFile"));const auto error=reinterpret_cast<DosError>(GetProcAddress(module,"RtlNtStatusToDosError"));if(!set||!error)fail("PATH_UNSAFE");
  std::vector<BYTE> buffer(sizeof(FILE_RENAME_INFO)+(leaf.size()+1)*sizeof(wchar_t));
  auto* rename=reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());rename->ReplaceIfExists=FALSE;rename->RootDirectory=parent;rename->FileNameLength=static_cast<DWORD>(leaf.size()*sizeof(wchar_t));
  std::memcpy(rename->FileName,leaf.data(),rename->FileNameLength);
  IO_STATUS_BLOCK io{};const auto status=set(source,&io,buffer.data(),static_cast<ULONG>(buffer.size()),NativeFileInformation::rename);
  return {status,status==0?ERROR_SUCCESS:error(status)};
}
// The volume root is the only absolute filesystem anchor. Every component
// after it is resolved through a retained, non-reparse directory object.
std::vector<std::wstring> nativePathComponents(const std::wstring& path){
  if(path.size()<3||!((path[0]>=L'A'&&path[0]<=L'Z')||(path[0]>=L'a'&&path[0]<=L'z'))||path[1]!=L':'||path[2]!=L'\\'||path.find(L'\0')!=std::wstring::npos)fail("PATH_UNSAFE");
  std::vector<std::wstring> parts{path.substr(0,3)};if(path.size()==3)return parts;
  const auto relative=path.substr(3);if(relativePath(utf8(relative))!=relative)fail("PATH_UNSAFE");
  for(std::size_t offset=3;offset<path.size();){const auto end=path.find(L'\\',offset);const auto leaf=path.substr(offset,end==std::wstring::npos?path.size()-offset:end-offset);nativeLeaf(leaf);parts.push_back(leaf);if(end==std::wstring::npos)break;offset=end+1;}return parts;
}
bool nativeWithinRoot(const std::wstring& path,const std::wstring& root){return !root.empty()&&path.size()>=root.size()&&_wcsnicmp(path.c_str(),root.c_str(),root.size())==0&&(path.size()==root.size()||path[root.size()]==L'\\');}
std::vector<Handle> walkNativeDirectories(const std::wstring& path,bool createDirectories,const std::wstring& privateRoot,bool allowAbsentAncestor,bool& absent){
  const auto parts=nativePathComponents(path);std::vector<Handle> handles;absent=false;
  constexpr DWORD sharing=FILE_SHARE_READ|FILE_SHARE_WRITE;constexpr ACCESS_MASK access=READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY|FILE_TRAVERSE;
  Handle anchor(CreateFileW(parts.front().c_str(),access,sharing,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));if(!anchor.valid())fail("PATH_UNSAFE");nativeEntryInformation(anchor.value,NativeChildKind::directory);if(_wcsicmp(nativeCanonical(anchor.value).c_str(),parts.front().c_str()))fail("PATH_UNSAFE");handles.push_back(std::move(anchor));
  Security security(dataSddl());std::wstring component=parts.front();
  for(std::size_t index=1;index<parts.size();++index){if(component.size()>3)component+=L'\\';component+=parts[index];const bool owned=nativeWithinRoot(component,privateRoot);
    auto opened=openNativeChild(handles.back().value,parts[index],access,sharing,NativeChildKind::directory,NativeChildDisposition::open);
    if(!opened.handle.valid()&&static_cast<ULONG>(opened.status)==nativeNameMissing&&createDirectories&&owned){opened=openNativeChild(handles.back().value,parts[index],access,sharing,NativeChildKind::directory,NativeChildDisposition::createNew,security.descriptor);if(!opened.handle.valid()&&static_cast<ULONG>(opened.status)==0xc0000035UL)opened=openNativeChild(handles.back().value,parts[index],access,sharing,NativeChildKind::directory,NativeChildDisposition::open);}
    if(!opened.handle.valid()){if(allowAbsentAncestor&&static_cast<ULONG>(opened.status)==nativeNameMissing){handles.clear();absent=true;SetLastError(ERROR_PATH_NOT_FOUND);return handles;}fail("PATH_UNSAFE");}
    if(_wcsicmp(nativeCanonical(opened.handle.value).c_str(),component.c_str()))fail("PATH_UNSAFE");if(owned)assertPrivateHandle(opened.handle.value,_wcsicmp(component.c_str(),privateRoot.c_str())==0);handles.push_back(std::move(opened.handle));
  }return handles;
}
NativeRelativeOpen openNativePath(const std::wstring& path,ACCESS_MASK access,DWORD sharing,NativeChildKind kind,NativeChildDisposition disposition=NativeChildDisposition::open,PSECURITY_DESCRIPTOR security=nullptr,bool writeThrough=false,bool allowAbsentAncestor=false){
  const auto parts=nativePathComponents(path);if(parts.size()==1){if(kind!=NativeChildKind::directory||disposition!=NativeChildDisposition::open||security||writeThrough)fail("PATH_UNSAFE");Handle anchor(CreateFileW(path.c_str(),access|SYNCHRONIZE,sharing,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));const auto error=GetLastError();if(!anchor.valid()){SetLastError(error);fail("PATH_UNSAFE");}nativeEntryInformation(anchor.value,NativeChildKind::directory);if(_wcsicmp(nativeCanonical(anchor.value).c_str(),path.c_str()))fail("PATH_UNSAFE");return {std::move(anchor),0};}const auto split=path.find_last_of(L'\\');const auto parent=split==2?path.substr(0,3):path.substr(0,split);bool absent=false;auto parents=walkNativeDirectories(parent,false,L"",allowAbsentAncestor,absent);
  if(absent)return {Handle(INVALID_HANDLE_VALUE),static_cast<NTSTATUS>(0xc000003aUL)};
  auto opened=openNativeChild(parents.back().value,parts.back(),access,sharing,kind,disposition,security,writeThrough);const auto error=GetLastError();
  if(opened.handle.valid()&&_wcsicmp(nativeCanonical(opened.handle.value).c_str(),path.c_str()))fail("PATH_UNSAFE");parents.clear();if(!opened.handle.valid())SetLastError(error);return opened;
}
Handle openEntry(const std::wstring& path,bool directory,bool privateEntry,bool protectedRequired=false,bool immutable=false){
  auto result=std::move(openNativePath(path,READ_CONTROL|FILE_READ_ATTRIBUTES|(directory?(FILE_LIST_DIRECTORY|FILE_TRAVERSE):immutable?GENERIC_READ:0),immutable&&!directory?FILE_SHARE_READ:FILE_SHARE_READ|FILE_SHARE_WRITE,directory?NativeChildKind::directory:NativeChildKind::file).handle);
  if(!result.valid())fail("PATH_UNSAFE");if(privateEntry)assertPrivateHandle(result.value,protectedRequired);return result;
}
// False is deliberately not an absence certificate: active readers and access
// denials keep cleanup pending. Only the exact missing leaf status proves true.
bool nativeChildMissing(HANDLE parent,const std::wstring& leaf){
  nativeEntryInformation(parent,NativeChildKind::directory);
  auto opened=openNativeChild(parent,leaf,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NativeChildKind::any,NativeChildDisposition::open);
  if(opened.handle.valid())return false;const auto status=static_cast<ULONG>(opened.status);
  if(status==nativeNameMissing)return true;
  // An exact delete-pending leaf still exists until its last reader closes.
  // It cannot certify absence or authorize publication into that name.
  if(status==0xc0000022UL||status==0xc0000043UL||status==0xc0000056UL||status==0xc00000baUL||status==0xc0000103UL)return false;
  fail("PATH_UNSAFE");
}
bool nativePathMissing(const std::wstring& path,bool allowAbsentAncestor=false){
  const auto parts=nativePathComponents(path);if(parts.size()==1)return false;const auto split=path.find_last_of(L'\\');const auto parent=split==2?path.substr(0,3):path.substr(0,split);bool absent=false;auto parents=walkNativeDirectories(parent,false,L"",allowAbsentAncestor,absent);return absent||nativeChildMissing(parents.back().value,parts.back());
}
struct NativeDirectoryEntry{std::wstring name;DWORD attributes;FILETIME lastWriteTime;};
std::vector<NativeDirectoryEntry> decodeNativeDirectoryBuffer(const std::vector<BYTE>& buffer,std::size_t maximum){
  constexpr auto header=offsetof(FILE_ID_BOTH_DIR_INFO,FileName);std::vector<NativeDirectoryEntry> result;
  for(std::size_t offset=0;;){if(offset%8||offset>buffer.size()||buffer.size()-offset<header)fail("PATH_UNSAFE");const auto* row=reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data()+offset);const auto bytes=static_cast<std::size_t>(row->FileNameLength);
    if(!bytes||bytes%sizeof(wchar_t)||bytes>510||bytes>buffer.size()-offset-header)fail("PATH_UNSAFE");const std::wstring name(row->FileName,bytes/sizeof(wchar_t));
    if(name!=L"."&&name!=L".."){nativeLeaf(name);if(result.size()>=maximum)fail("PATH_UNSAFE");const auto time=static_cast<ULONGLONG>(row->LastWriteTime.QuadPart);result.push_back({name,row->FileAttributes,FILETIME{static_cast<DWORD>(time),static_cast<DWORD>(time>>32)}});}
    if(!row->NextEntryOffset)break;if(row->NextEntryOffset%8||row->NextEntryOffset<header+bytes||row->NextEntryOffset>buffer.size()-offset)fail("PATH_UNSAFE");offset+=row->NextEntryOffset;
  }return result;
}
std::vector<NativeDirectoryEntry> enumerateNativeDirectory(HANDLE directory,std::size_t maximum=100000){
  if(maximum==0||maximum>100000)fail("PATH_UNSAFE");const auto before=nativeEntryInformation(directory,NativeChildKind::directory);std::vector<NativeDirectoryEntry> result;std::set<std::wstring> names;std::vector<BYTE> buffer(65536);std::size_t nameBytes=0;bool first=true;
  for(std::size_t batches=0;;++batches){if(batches>100002)fail("PATH_UNSAFE");std::fill(buffer.begin(),buffer.end(),BYTE{0});
    if(!GetFileInformationByHandleEx(directory,first?FileIdBothDirectoryRestartInfo:FileIdBothDirectoryInfo,buffer.data(),static_cast<DWORD>(buffer.size()))){if(GetLastError()==ERROR_NO_MORE_FILES)break;fail("PATH_UNSAFE");}first=false;
    auto rows=decodeNativeDirectoryBuffer(buffer,maximum-result.size());for(auto& row:rows){auto folded=row.name;std::transform(folded.begin(),folded.end(),folded.begin(),[](wchar_t c){return static_cast<wchar_t>(towupper(c));});if(!names.insert(folded).second)fail("PATH_UNSAFE");nameBytes+=row.name.size()*sizeof(wchar_t);if(nameBytes>64ULL*1024*1024)fail("PATH_UNSAFE");result.push_back(std::move(row));}
  }
  const auto after=nativeEntryInformation(directory,NativeChildKind::directory);if(before.dwVolumeSerialNumber!=after.dwVolumeSerialNumber||before.nFileIndexHigh!=after.nFileIndexHigh||before.nFileIndexLow!=after.nFileIndexLow||before.ftCreationTime.dwHighDateTime!=after.ftCreationTime.dwHighDateTime||before.ftCreationTime.dwLowDateTime!=after.ftCreationTime.dwLowDateTime)fail("PATH_UNSAFE");return result;
}
std::vector<Handle> lockAncestors(const std::wstring& path,bool createDirectories,bool includeLast,const std::wstring& privateRoot,bool immutable=false){
  (void)immutable;nativePathComponents(path);const auto split=path.find_last_of(L'\\');const auto directory=includeLast?path:split==2?path.substr(0,3):path.substr(0,split);bool absent=false;return walkNativeDirectories(directory,createDirectories,privateRoot,false,absent);
}
std::wstring ownedPath(const Json& args) {
  const auto root = rootPath(args.at("root").string());
  const auto relative = relativePath(args.at("relative_path").string(), true);
  return relative.empty() ? root : root + L"\\" + relative;
}
std::vector<BYTE> base64Decode(const std::string& text, std::size_t limit) {
  if (text.empty()) return {};
  if (text.size() > ((limit + 2) / 3) * 4 || text.size() % 4 != 0) fail("BAD_REQUEST");
  DWORD count = 0;
  check(CryptStringToBinaryA(text.c_str(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &count, nullptr, nullptr), "BAD_REQUEST");
  if (count > limit) fail("BAD_REQUEST");
  std::vector<BYTE> result(count);
  check(CryptStringToBinaryA(text.c_str(), static_cast<DWORD>(text.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, result.data(), &count, nullptr, nullptr), "BAD_REQUEST");
  return result;
}
std::string base64Encode(const BYTE* bytes, DWORD count) {
  if (count == 0) return "";
  DWORD size = 0;
  check(CryptBinaryToStringA(bytes, count, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size), "VAULT_UNAVAILABLE");
  std::string result(size, '\0');
  check(CryptBinaryToStringA(bytes, count, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &size), "VAULT_UNAVAILABLE");
  if (!result.empty() && result.back() == '\0') result.pop_back();
  return result;
}
std::string randomHex() {
  std::vector<BYTE> bytes(32);
  if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) fail("IDENTITY_UNAVAILABLE");
  constexpr char hex[] = "0123456789abcdef";
  std::string result; for (const auto byte : bytes) { result += hex[byte >> 4]; result += hex[byte & 15]; } return result;
}
#include "events.hpp"
#include "vault_mutex.hpp"
std::string vaultKey(const Json& args) {
  const auto key = args.at("key").string();
  if (key.empty() || key.size() > 64 || key.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_-") != std::string::npos) fail("BAD_REQUEST");
  return key;
}
std::string hashFile(HANDLE file,std::uint64_t maximum);
void keys(const Json& object,const std::set<std::string>& allowed);
Json vaultBirth(HANDLE file){const auto info=nativeEntryInformation(file,NativeChildKind::file);return Json::Object{{"volume",std::to_string(info.dwVolumeSerialNumber)},{"file_id",std::to_string((static_cast<ULONGLONG>(info.nFileIndexHigh)<<32)|info.nFileIndexLow)},{"creation_time",std::to_string((static_cast<ULONGLONG>(info.ftCreationTime.dwHighDateTime)<<32)|info.ftCreationTime.dwLowDateTime)}};}
void validateVaultPin(const Json& pin){
  keys(pin,{"birth","sha256","bytes"});const auto& birth=pin.at("birth");keys(birth,{"volume","file_id","creation_time"});for(const auto& [name,value]:birth.object()){const auto text=value.string();if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_RECOVERY_REQUIRED");ULONGLONG number=0;try{number=std::stoull(text);}catch(...){fail("VAULT_RECOVERY_REQUIRED");}if(std::to_string(number)!=text||(name=="volume"?number>0xffffffffULL:number==0))fail("VAULT_RECOVERY_REQUIRED");}
  const auto sha=pin.at("sha256").string();if(sha.size()!=64||sha.find_first_not_of("0123456789abcdef")!=std::string::npos||pin.at("bytes").integer()<12||pin.at("bytes").integer()>32768)fail("VAULT_RECOVERY_REQUIRED");
}
Json vaultPin(HANDLE file){LARGE_INTEGER size{};check(GetFileSizeEx(file,&size),"VAULT_RECOVERY_REQUIRED");if(size.QuadPart<12||size.QuadPart>32768)fail("VAULT_RECOVERY_REQUIRED");return Json::Object{{"birth",vaultBirth(file)},{"sha256",hashFile(file,32768)},{"bytes",static_cast<std::int64_t>(size.QuadPart)}};}
bool sameVaultPin(HANDLE file,const Json& expected){return mm::dump(vaultPin(file))==mm::dump(expected);}
Handle vaultOpen(HANDLE parent,const std::wstring& directory,const std::wstring& leaf,bool mutate,bool& absent,bool* busy=nullptr){
  if(busy)*busy=false;auto opened=openNativeChild(parent,leaf,GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES|(mutate?(DELETE|FILE_WRITE_ATTRIBUTES):0),FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);const auto error=GetLastError();absent=false;
  if(!opened.handle.valid()){if(static_cast<ULONG>(opened.status)==nativeNameMissing){absent=true;return std::move(opened.handle);}if(busy&&(error==ERROR_SHARING_VIOLATION||error==ERROR_ACCESS_DENIED)){*busy=true;return std::move(opened.handle);}SetLastError(error);fail("VAULT_UNAVAILABLE");}
  assertPrivateHandle(opened.handle.value);if(_wcsicmp(nativeCanonical(opened.handle.value).c_str(),(directory+L"\\"+leaf).c_str()))fail("PATH_UNSAFE");return std::move(opened.handle);
}
void vaultRetire(Handle& file){FILE_DISPOSITION_INFO disposition{TRUE};check(SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition)),"VAULT_RECOVERY_REQUIRED");const auto retiring=std::exchange(file.value,nullptr);check(CloseHandle(retiring),"VAULT_RECOVERY_REQUIRED");}
void writeVaultBlob(HANDLE file,const char* magic,const DATA_BLOB& blob){DWORD wrote=0;check(blob.cbData>0&&blob.cbData<=32756,"VAULT_UNAVAILABLE");check(WriteFile(file,magic,8,&wrote,nullptr)&&wrote==8,"VAULT_UNAVAILABLE");check(WriteFile(file,&blob.cbData,4,&wrote,nullptr)&&wrote==4,"VAULT_UNAVAILABLE");check(WriteFile(file,blob.pbData,blob.cbData,&wrote,nullptr)&&wrote==blob.cbData,"VAULT_UNAVAILABLE");check(FlushFileBuffers(file),"VAULT_UNAVAILABLE");}
std::vector<BYTE> readVaultBlob(HANDLE file,const char* magic){
  LARGE_INTEGER size{};check(GetFileSizeEx(file,&size),"VAULT_CORRUPT");if(size.QuadPart<13||size.QuadPart>32768)fail("VAULT_CORRUPT");check(SetFilePointerEx(file,{},nullptr,FILE_BEGIN),"VAULT_CORRUPT");std::vector<BYTE> data(static_cast<std::size_t>(size.QuadPart));DWORD read=0;check(ReadFile(file,data.data(),static_cast<DWORD>(data.size()),&read,nullptr)&&read==data.size(),"VAULT_CORRUPT");DWORD declared=0;std::memcpy(&declared,data.data()+8,4);if(std::memcmp(data.data(),magic,8)||declared!=data.size()-12)fail("VAULT_CORRUPT");return data;
}
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
enum class VaultReplaceFault{none,intent,backedUp,renamed};
VaultReplaceFault vaultReplaceFault=VaultReplaceFault::none;
void vaultReplacementCheckpoint(VaultReplaceFault point){if(vaultReplaceFault==point)fail("VAULT_UNAVAILABLE");}
#endif
// A single immutable authenticated intent describes both exact ciphertext
// generations. Publication never replaces an unheld leaf, and no backup is
// disposed until the new generation is positively retained and verified.
void recoverVaultReplacement(HANDLE parent,const std::wstring& directory,const std::string& space,const std::string& key){
  const auto journalLeaf=L".replace-"+wide(key);bool missing=false;auto journal=vaultOpen(parent,directory,journalLeaf,true,missing);if(missing)return;
  const auto journalPin=vaultPin(journal.value);auto sealed=readVaultBlob(journal.value,"MMCVJ001");auto entropyText="MusicMuteConsumerVaultReplace:v1:"+space+":"+key;DATA_BLOB entropy{static_cast<DWORD>(entropyText.size()),reinterpret_cast<BYTE*>(entropyText.data())},encrypted{static_cast<DWORD>(sealed.size()-12),sealed.data()+12},plain{};
  if(!CryptUnprotectData(&encrypted,nullptr,&entropy,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&plain))fail("VAULT_RECOVERY_REQUIRED");LocalMemory memory{plain.pbData};Json intent;
  try{if(plain.cbData<2||plain.cbData>8192)fail("VAULT_RECOVERY_REQUIRED");intent=mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.pbData),plain.cbData)).parse();}catch(...){SecureZeroMemory(plain.pbData,plain.cbData);throw;}SecureZeroMemory(plain.pbData,plain.cbData);
  keys(intent,{"version","namespace","key","nonce","old","new"});const auto nonce=intent.at("nonce").string();if(intent.at("version").integer()!=1||intent.at("namespace").string()!=space||intent.at("key").string()!=key||nonce.size()!=64||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("VAULT_RECOVERY_REQUIRED");
  const auto& desired=intent.at("new");validateVaultPin(desired);const auto& old=intent.at("old");const bool hadOld=!std::holds_alternative<std::nullptr_t>(old.value);if(hadOld){validateVaultPin(old);if(old.at("birth").at("volume").string()!=desired.at("birth").at("volume").string()||old.at("birth").at("file_id").string()==desired.at("birth").at("file_id").string())fail("VAULT_RECOVERY_REQUIRED");}
  const auto activeLeaf=wide(key)+L".dpapi",stageLeaf=L".txn-"+wide(nonce)+L".new",backupLeaf=L".txn-"+wide(nonce)+L".old";
  bool activeMissing=false,stageMissing=false,backupMissing=false;auto active=vaultOpen(parent,directory,activeLeaf,true,activeMissing);auto stage=vaultOpen(parent,directory,stageLeaf,true,stageMissing);auto backup=vaultOpen(parent,directory,backupLeaf,true,backupMissing);
  const bool newActive=!activeMissing&&sameVaultPin(active.value,desired);const bool oldActive=hadOld&&!activeMissing&&sameVaultPin(active.value,old);
  if((!activeMissing&&!newActive&&!oldActive)||(!stageMissing&&!sameVaultPin(stage.value,desired))||(!backupMissing&&(!hadOld||!sameVaultPin(backup.value,old))))fail("VAULT_RECOVERY_REQUIRED");
  if(newActive){if(!stageMissing)fail("VAULT_RECOVERY_REQUIRED");}
  else{
    if(stageMissing||(!hadOld&&!backupMissing)||(hadOld&&activeMissing&&backupMissing)||(oldActive&&!backupMissing))fail("VAULT_RECOVERY_REQUIRED");
    if(oldActive){const auto moved=renameNativeChild(active.value,parent,backupLeaf);if(moved.status!=0)fail("VAULT_UNAVAILABLE");if(!sameVaultPin(active.value,old))fail("VAULT_RECOVERY_REQUIRED");backup=std::move(active);backupMissing=false;activeMissing=true;
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
      vaultReplacementCheckpoint(VaultReplaceFault::backedUp);
#endif
    }
    if(!nativeChildMissing(parent,activeLeaf))fail("VAULT_RECOVERY_REQUIRED");const auto moved=renameNativeChild(stage.value,parent,activeLeaf);
    if(moved.status!=0){if(backup.valid()&&nativeChildMissing(parent,activeLeaf)){const auto restored=renameNativeChild(backup.value,parent,activeLeaf);if(restored.status==0&&!sameVaultPin(backup.value,old))fail("VAULT_RECOVERY_REQUIRED");}fail("VAULT_UNAVAILABLE");}
    // Name tunneling is normalized only after this invocation successfully
    // moved the exact held stage; recovery never blesses a cloned generation.
    const auto now=vaultBirth(stage.value),birth=desired.at("birth");if(now.at("volume").string()!=birth.at("volume").string()||now.at("file_id").string()!=birth.at("file_id").string())fail("VAULT_RECOVERY_REQUIRED");
    const auto movedPin=vaultPin(stage.value);if(movedPin.at("sha256").string()!=desired.at("sha256").string()||movedPin.at("bytes").integer()!=desired.at("bytes").integer())fail("VAULT_RECOVERY_REQUIRED");
    if(now.at("creation_time").string()!=birth.at("creation_time").string()){const auto stamp=std::stoull(birth.at("creation_time").string());const FILETIME time{static_cast<DWORD>(stamp),static_cast<DWORD>(stamp>>32)};check(SetFileTime(stage.value,&time,nullptr,nullptr),"VAULT_RECOVERY_REQUIRED");}
    if(!sameVaultPin(stage.value,desired))fail("VAULT_RECOVERY_REQUIRED");active=std::move(stage);
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    vaultReplacementCheckpoint(VaultReplaceFault::renamed);
#endif
  }
  if(!sameVaultPin(active.value,desired))fail("VAULT_RECOVERY_REQUIRED");if(backup.valid()){if(!sameVaultPin(backup.value,old))fail("VAULT_RECOVERY_REQUIRED");vaultRetire(backup);}if(!nativeChildMissing(parent,stageLeaf)||!nativeChildMissing(parent,backupLeaf))fail("VAULT_RECOVERY_REQUIRED");if(!sameVaultPin(journal.value,journalPin))fail("VAULT_RECOVERY_REQUIRED");vaultRetire(journal);if(!nativeChildMissing(parent,journalLeaf))fail("VAULT_RECOVERY_REQUIRED");
}
Json vault(const std::string& operation,const Json& args){
  const auto space=args.at("namespace").string();if(space!="account"&&space!="fleet")fail("BAD_REQUEST");VaultNamespaceLock namespaceLock(space);const auto key=vaultKey(args);const auto root=rootPath(space=="account"?"personal":"fleet"),directory=root+L"\\vault\\"+wide(space);auto ancestors=lockAncestors(directory,true,true,root);const auto parent=ancestors.back().value;const auto leaf=wide(key)+L".dpapi";
  recoverVaultReplacement(parent,directory,space,key);
  if(operation=="vault_delete"){bool absent=false;auto input=vaultOpen(parent,directory,leaf,true,absent);if(!absent)vaultRetire(input);return Json::Object{{"deleted",true}};}
  auto entropyText="MusicMuteConsumerVault:v1:"+space+":"+key;DATA_BLOB entropy{static_cast<DWORD>(entropyText.size()),reinterpret_cast<BYTE*>(entropyText.data())},result{};
  if(operation=="vault_get"){bool absent=false;auto input=vaultOpen(parent,directory,leaf,false,absent);if(absent)return nullptr;auto data=readVaultBlob(input.value,"MMCV0001");DATA_BLOB encrypted{static_cast<DWORD>(data.size()-12),data.data()+12};if(!CryptUnprotectData(&encrypted,nullptr,&entropy,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&result))fail("VAULT_CORRUPT");LocalMemory output{result.pbData};if(!result.cbData||result.cbData>16384){SecureZeroMemory(result.pbData,result.cbData);fail("VAULT_CORRUPT");}const auto encoded=base64Encode(result.pbData,result.cbData);SecureZeroMemory(result.pbData,result.cbData);return Json::Object{{"version",1},{"bytes_base64",encoded}};}
  // Obtain deletion authority over the old object before any publication. An
  // active reader therefore rejects a replacement while its old bytes remain.
  bool absent=false;auto old=vaultOpen(parent,directory,leaf,true,absent);Json oldPin=nullptr;if(!absent)oldPin=vaultPin(old.value);
  auto plain=base64Decode(args.at("bytes_base64").string(),16384);if(plain.empty())fail("BAD_REQUEST");DATA_BLOB plaintext{static_cast<DWORD>(plain.size()),plain.data()};const BOOL encrypted=CryptProtectData(&plaintext,nullptr,&entropy,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&result);SecureZeroMemory(plain.data(),plain.size());check(encrypted,"VAULT_UNAVAILABLE");LocalMemory output{result.pbData};
  const auto entries=enumerateNativeDirectory(parent);std::size_t pending=0,journals=0,legacy=0;for(const auto& entry:entries){if(entry.name.starts_with(L".pending-"))++legacy;if(entry.name.starts_with(L".replace-"))++journals;if(entry.name.starts_with(L".pending-")||entry.name.starts_with(L".txn-")||entry.name.starts_with(L".replace-"))++pending;}if(legacy>=16||journals>=16||pending>=48)fail("VAULT_RECOVERY_REQUIRED");
  const auto nonce=randomHex();const auto stageLeaf=L".txn-"+wide(nonce)+L".new",journalLeaf=L".replace-"+wide(key);Security security(dataSddl());auto writer=std::move(openNativeChild(parent,stageLeaf,GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES,0,NativeChildKind::file,NativeChildDisposition::createNew,security.descriptor,true).handle);if(!writer.valid())fail("VAULT_UNAVAILABLE");Handle journal;bool durable=false;
  try{
    writeVaultBlob(writer.value,"MMCV0001",result);assertPrivateHandle(writer.value);const auto pin=vaultPin(writer.value);Json intent=Json::Object{{"version",1},{"namespace",space},{"key",key},{"nonce",nonce},{"old",oldPin},{"new",pin}};auto text=mm::dump(intent);if(text.size()>8192)fail("VAULT_UNAVAILABLE");auto journalEntropyText="MusicMuteConsumerVaultReplace:v1:"+space+":"+key;DATA_BLOB journalEntropy{static_cast<DWORD>(journalEntropyText.size()),reinterpret_cast<BYTE*>(journalEntropyText.data())},intentPlain{static_cast<DWORD>(text.size()),reinterpret_cast<BYTE*>(text.data())},sealed{};const auto protectedIntent=CryptProtectData(&intentPlain,nullptr,&journalEntropy,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&sealed);SecureZeroMemory(text.data(),text.size());check(protectedIntent,"VAULT_UNAVAILABLE");LocalMemory sealedMemory{sealed.pbData};
    journal=std::move(openNativeChild(parent,journalLeaf,GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL|FILE_READ_ATTRIBUTES|FILE_WRITE_ATTRIBUTES,0,NativeChildKind::file,NativeChildDisposition::createNew,security.descriptor,true).handle);if(!journal.valid())fail("VAULT_RECOVERY_REQUIRED");writeVaultBlob(journal.value,"MMCVJ001",sealed);assertPrivateHandle(journal.value);durable=true;
  }catch(...){if(!durable){if(journal.valid())vaultRetire(journal);vaultRetire(writer);}throw;}
  writer.close();journal.close();old.close();
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  vaultReplacementCheckpoint(VaultReplaceFault::intent);
#endif
  recoverVaultReplacement(parent,directory,space,key);return Json::Object{{"version",1},{"stored",true}};
}
enum class VaultLegacyRecovery{removed,skipped};
VaultLegacyRecovery recoverLegacyVaultEntry(HANDLE parent,const std::wstring& directory,const NativeDirectoryEntry& entry,ULONGLONG now){
  const auto& name=entry.name;if(name.size()!=73||!name.starts_with(L".pending-")||name.substr(9).find_first_not_of(L"0123456789abcdef")!=std::wstring::npos)fail("VAULT_RECOVERY_REQUIRED");
  const auto inventoried=(static_cast<ULONGLONG>(entry.lastWriteTime.dwHighDateTime)<<32)|entry.lastWriteTime.dwLowDateTime;
  if(inventoried>now||now-inventoried<864000000000ULL)return VaultLegacyRecovery::skipped;
  bool absent=false,busy=false;auto file=vaultOpen(parent,directory,name,true,absent,&busy);if(absent||busy)return VaultLegacyRecovery::skipped;
  // Enumeration is only a prefilter. The name may now denote a fresh private
  // generation; age authority must come from this exact retained object.
  const auto info=nativeEntryInformation(file.value,NativeChildKind::file);const auto modified=(static_cast<ULONGLONG>(info.ftLastWriteTime.dwHighDateTime)<<32)|info.ftLastWriteTime.dwLowDateTime;
  if(modified>now||now-modified<864000000000ULL)return VaultLegacyRecovery::skipped;
  LARGE_INTEGER size{};check(GetFileSizeEx(file.value,&size),"VAULT_UNAVAILABLE");if(size.QuadPart>32768)fail("VAULT_RECOVERY_REQUIRED");vaultRetire(file);return VaultLegacyRecovery::removed;
}
Json vaultRecover(const Json& args){
  const auto space=args.at("namespace").string();if(space!="account"&&space!="fleet")fail("BAD_REQUEST");VaultNamespaceLock namespaceLock(space);const auto root=rootPath(space=="account"?"personal":"fleet"),directory=root+L"\\vault\\"+wide(space);auto ancestors=lockAncestors(directory,true,true,root);const auto parent=ancestors.back().value;
  auto entries=enumerateNativeDirectory(parent);std::size_t journals=0;for(const auto& entry:entries)if(entry.name.starts_with(L".replace-")){if(++journals>16)fail("VAULT_RECOVERY_REQUIRED");const auto key=utf8(entry.name.substr(9));(void)vaultKey(Json::Object{{"key",key}});recoverVaultReplacement(parent,directory,space,key);}
  entries=enumerateNativeDirectory(parent);unsigned inspected=0;int removed=0,skipped=0;bool limited=false;FILETIME nowFile{};GetSystemTimeAsFileTime(&nowFile);const auto now=(static_cast<ULONGLONG>(nowFile.dwHighDateTime)<<32)|nowFile.dwLowDateTime;
  for(const auto& entry:entries){const auto& name=entry.name;if(name.starts_with(L".txn-")||name.starts_with(L".replace-")){++skipped;continue;}if(!name.starts_with(L".pending-"))continue;if(++inspected>16){limited=true;break;}if(recoverLegacyVaultEntry(parent,directory,entry,now)==VaultLegacyRecovery::removed)++removed;else ++skipped;}
  return Json::Object{{"removed",removed},{"skipped",skipped},{"limited",limited}};
}
std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  unsigned backslashes = 0;
  for (const wchar_t c : value) {
    if (c == L'\\') { ++backslashes; continue; }
    result.append(c == L'"' ? backslashes * 2 + 1 : backslashes, L'\\');
    backslashes = 0; result += c;
  }
  result.append(backslashes * 2, L'\\');
  return result + L'"';
}
#include "environment.hpp"
DWORD consumerIndependentJobFlags(BOOL inJob) {
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  // Isolated CTest guardians remain descendants of the non-breakaway QA Job.
  // Their own role/GPU Jobs are still independent nested Jobs. This branch is
  // absent from all installed executables and cannot enable production launch.
  (void)inJob; return 0;
#else
  return inJob ? CREATE_BREAKAWAY_FROM_JOB : 0;
#endif
}
struct OwnedJob { Handle job; Handle process; Handle guardian; std::string nonce; Json identity; };
std::wstring roleJobName(const std::string& role, const std::string& nonce) {
  if ((role != "personal" && role != "fleet" && role != "prepare" && role != "session-agent") || nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto user = currentIdentity();
  return L"Local\\MusicMuteOwnedRole-v1-" + wide(user.sid) + L"-" + std::to_wstring(user.session) + L"-" + wide(role) + L"-" + wide(nonce);
}
bool equalSecret(const std::string& first, const std::string& second);
void keys(const Json& object, const std::set<std::string>& allowed);
#include "job_guardian.hpp"
std::map<std::string, OwnedJob> jobs;
std::set<std::string> usedPipeCapabilities;
void attachPreparingGpuJobs(HANDLE process);
Json launchOwned(const Json& args) {
  const auto role = args.at("role").string();
  if (role != "session-agent" && role != "fleet" && role != "personal" && role != "prepare") fail("BAD_REQUEST");
  const auto release = args.at("release").string();
  if (release.empty() || release.size() > 96 || release.front() == '.' || release.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-") != std::string::npos) fail("BAD_REQUEST");
  if (jobs.size() >= 8 || jobs.contains(role)) fail("JOB_BUSY");
  const auto root = rootPath("personal");
  const auto runtime = root + L"\\runtime\\releases\\" + wide(release);
  const auto executable = runtime + L"\\runtime\\node\\node.exe";
  const auto entry = runtime + (role == "session-agent" ? L"\\agent\\session-agent.cjs" : role == "personal" ? L"\\agent\\personal.cjs" : role == "prepare" ? L"\\agent\\prepare.cjs" : L"\\agent\\fleet.cjs");
  const auto config = rootPath(role == "fleet" ? "fleet" : "personal") + (role == "prepare" ? L"\\prepare-config.json" : role == "personal" ? L"\\personal-config.json" : L"\\consumer-config.json");
  auto ancestors = lockAncestors(executable, false, false, root);
  auto entryAncestors = lockAncestors(entry, false, false, root);
  auto executableFile = openEntry(executable, false, true, false, true);
  auto entryFile = openEntry(entry, false, true, false, true);
  auto configAncestors = lockAncestors(config, false, false, rootPath(role == "fleet" ? "fleet" : "personal"));
  auto configFile = openEntry(config, false, true, false, true);
  OwnedJob owner;
  owner.nonce = randomHex();
  Security jobSecurity(dataSddl());
  owner.job = Handle(CreateJobObjectW(&jobSecurity.attributes, roleJobName(role, owner.nonce).c_str()));
  if (!owner.job.valid()) fail("JOB_UNAVAILABLE");
  if (GetLastError() == ERROR_ALREADY_EXISTS) fail("JOB_BUSY");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
  check(SetInformationJobObject(owner.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "JOB_UNAVAILABLE");
  auto command = quote(executable) + L" " + quote(entry) + L" --consumer-config " + quote(config);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  auto environment=consumerEnvironment(runtime+L"\\runtime\\node",owner.nonce,role);
  // Console detachment avoids hidden conhost peers. It does not break away
  // from the inherited Job chain; suspended role assignment still precedes run.
  check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT, environment.data(), root.c_str(), &startup, &process), "JOB_UNAVAILABLE");
  owner.process = Handle(process.hProcess); Handle thread(process.hThread);
  if (!AssignProcessToJobObject(owner.job.value, owner.process.value)) { TerminateProcess(owner.process.value, 2); fail("JOB_UNAVAILABLE"); }
  attachPreparingGpuJobs(owner.process.value);
  owner.identity = processIdentity(process.dwProcessId);
  const auto result = Json::Object{{"role", role}, {"nonce", owner.nonce}, {"identity", owner.identity}};
  owner.guardian = startIndependentJobGuardian(owner.job.value, owner.process.value, result);
  try { writeOwnershipRecord(result,owner.guardian.value); } catch (...) { TerminateJobObject(owner.job.value,2);throw; }
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) { TerminateJobObject(owner.job.value, 2); fail("JOB_UNAVAILABLE"); }
  watchOwnedProcess(owner.process.value, result);
  jobs.emplace(role, std::move(owner));
  return result;
}
Json stopOwned(const Json& args) {
  const auto role = args.at("role").string();
  const auto item = jobs.find(role);
  if (item == jobs.end()) fail("JOB_NOT_OWNED");
  const auto& identity = args.at("identity");
  if (args.at("nonce").string() != item->second.nonce || mm::dump(identity) != mm::dump(item->second.identity)) fail("JOB_NOT_OWNED");
  check(TerminateJobObject(item->second.job.value, 2), "JOB_UNAVAILABLE");
  if (WaitForSingleObject(item->second.process.value, 5000) != WAIT_OBJECT_0) fail("JOB_UNAVAILABLE");
  const auto deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    check(QueryInformationJobObject(item->second.job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "JOB_UNAVAILABLE");
    if (accounting.ActiveProcesses == 0) break;
    if (GetTickCount64() >= deadline) fail("JOB_UNAVAILABLE");
    Sleep(10);
  }
  if (WaitForSingleObject(item->second.guardian.value, 5000) != WAIT_OBJECT_0) fail("JOB_UNAVAILABLE");
  writeExitCertificate(Json::Object{{"role", role}, {"nonce", item->second.nonce}, {"identity", item->second.identity}});
  jobs.erase(item);
  return Json::Object{{"stopped", true}};
}
Json isOwnedProcess(const Json& args) {
  const auto& owner = args.at("owner");
  const auto item = jobs.find(owner.at("role").string());
  if (item == jobs.end() || !equalSecret(item->second.nonce, owner.at("nonce").string()) || mm::dump(item->second.identity) != mm::dump(owner.at("identity"))) fail("JOB_NOT_OWNED");
  const auto& expected = args.at("identity");
  const auto pid = expected.at("pid").integer();
  if (pid < 1 || pid > 2147483647) fail("BAD_REQUEST");
  const auto actual = processIdentity(static_cast<DWORD>(pid), true);
  if (std::holds_alternative<std::nullptr_t>(actual.value)) return Json::Object{{"owned", false}};
  if (mm::dump(actual) != mm::dump(expected)) fail("PEER_DENIED");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(pid)));
  if (!process.valid()) fail("IDENTITY_UNAVAILABLE");
  if (creation(process.value) != actual.at("creation_time").string()) fail("PEER_DENIED");
  BOOL owned = FALSE; check(IsProcessInJob(process.value, item->second.job.value, &owned), "IDENTITY_UNAVAILABLE");
  return Json::Object{{"owned", static_cast<bool>(owned)}};
}
std::string pipeName(const std::string& channel) {
  if (channel.size() != 64 || channel.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto identity = currentIdentity();
  return "\\\\.\\pipe\\MusicMuteConsumer-" + std::to_string(identity.session) + "-" + channel;
}
bool equalSecret(const std::string& first, const std::string& second) {
  if (first.size() != 64 || second.size() != 64) return false;
  unsigned difference = 0;
  for (std::size_t n = 0; n < first.size(); ++n) difference |= static_cast<unsigned char>(first[n]) ^ static_cast<unsigned char>(second[n]);
  return difference == 0;
}
DWORD remaining(ULONGLONG deadline) {
  const auto now = GetTickCount64();
  if (now >= deadline) fail("TIMEOUT");
  return static_cast<DWORD>(deadline - now);
}
void finishOverlapped(HANDLE pipe, OVERLAPPED& operation, BOOL started, DWORD& count, ULONGLONG deadline) {
  if (started) return;
  if (GetLastError() != ERROR_IO_PENDING) fail("PIPE_UNAVAILABLE");
  if (WaitForSingleObject(operation.hEvent, remaining(deadline)) != WAIT_OBJECT_0) { CancelIoEx(pipe, &operation); GetOverlappedResult(pipe, &operation, &count, TRUE); fail("TIMEOUT"); }
  check(GetOverlappedResult(pipe, &operation, &count, FALSE), "PIPE_UNAVAILABLE");
}
Json pipeExchange(const Json& args) {
  const auto expected = args.at("peer");
  const auto nonce = args.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto capability = args.at("channel").string() + ":" + nonce;
  if (usedPipeCapabilities.size() >= 4096 || !usedPipeCapabilities.insert(capability).second) fail("PEER_DENIED");
  const auto timeout = args.at("timeout_ms").integer();
  if (timeout < 100 || timeout > 30000) fail("BAD_REQUEST");
  const auto response = base64Decode(args.at("response_base64").string(), 32768);
  const auto identity = currentIdentity();
  if (expected.at("sid").string() != identity.sid || expected.at("session_id").integer() != identity.session) fail("PEER_DENIED");
  const auto name = wide(pipeName(args.at("channel").string()));
  // Specific read/write rights exclude FILE_CREATE_PIPE_INSTANCE. A logon SID
  // confines the pipe to this interactive session, and remote clients are denied.
  Security security(L"O:" + wide(identity.sid) + L"D:P(A;;0x0012019b;;;" + wide(identity.logonSid) + L")");
  Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 49152, 8192, 0, &security.attributes));
  if (!pipe.valid()) fail("PIPE_UNAVAILABLE");
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.valid()) fail("PIPE_UNAVAILABLE");
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(timeout);
  OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
  const BOOL connected = ConnectNamedPipe(pipe.value, &operation);
  if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) finishOverlapped(pipe.value, operation, connected, count, deadline);
  ULONG pid = 0; check(GetNamedPipeClientProcessId(pipe.value, &pid), "PEER_DENIED");
  const auto actual = processIdentity(pid);
  if (mm::dump(actual) != mm::dump(expected)) fail("PEER_DENIED");
  auto transfer = [&](void* data, DWORD length, bool write) {
    DWORD offset = 0;
    while (offset < length) {
      ResetEvent(event.value); operation = {}; operation.hEvent = event.value; count = 0;
      const BOOL started = write ? WriteFile(pipe.value, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation) : ReadFile(pipe.value, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation);
      finishOverlapped(pipe.value, operation, started, count, deadline);
      if (count == 0 || count > length - offset) fail("PIPE_UNAVAILABLE");
      offset += count;
    }
  };
  DWORD size = 0; transfer(&size, 4, false);
  if (size == 0 || size > 8192) fail("FRAME_TOO_LARGE");
  std::string frame(size, '\0'); transfer(frame.data(), size, false);
  check(ImpersonateNamedPipeClient(pipe.value), "PEER_DENIED");
  try {
    Handle token; check(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value), "PEER_DENIED");
    const auto impersonated = tokenIdentity(token.value);
    if (impersonated.sid != identity.sid || impersonated.logonSid != identity.logonSid || impersonated.session != identity.session) fail("PEER_DENIED");
  } catch (...) { RevertToSelf(); throw; }
  check(RevertToSelf(), "PEER_DENIED");
  const auto request = mm::JsonParser(frame).parse();
  if (request.at("version").integer() != 1 || request.at("sequence").integer() != 1 || !equalSecret(request.at("nonce").string(), nonce)) fail("PEER_DENIED");
  const auto payload = base64Decode(request.at("payload_base64").string(), 4096);
  const auto output = mm::dump(Json::Object{{"version", 1}, {"sequence", 1}, {"nonce", nonce}, {"payload_base64", base64Encode(response.data(), static_cast<DWORD>(response.size()))}});
  size = static_cast<DWORD>(output.size()); transfer(&size, 4, true); transfer(const_cast<char*>(output.data()), size, true);
  DWORD acknowledged = 0; transfer(&acknowledged, 4, false);
  if (acknowledged != 0x4d4d0001) fail("PROTOCOL_MISMATCH");
  DisconnectNamedPipe(pipe.value);
  return Json::Object{{"peer", actual}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}};
}
Json pipeConnect(const Json& args) {
  const auto expected = args.at("peer");
  const auto nonce = args.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto timeout = args.at("timeout_ms").integer();
  if (timeout < 100 || timeout > 30000) fail("BAD_REQUEST");
  const auto payload = base64Decode(args.at("payload_base64").string(), 4096);
  const auto identity = currentIdentity();
  if (expected.at("sid").string() != identity.sid || expected.at("session_id").integer() != identity.session) fail("PEER_DENIED");
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(timeout);
  const auto name = wide(pipeName(args.at("channel").string()));
  Handle pipe;
  while (!pipe.valid()) {
    pipe = Handle(CreateFileW(name.c_str(), FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (pipe.valid()) break;
    const auto error = GetLastError();
    if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) fail("PIPE_UNAVAILABLE");
    (void)remaining(deadline); Sleep(5);
  }
  ULONG pid = 0; check(GetNamedPipeServerProcessId(pipe.value, &pid), "PEER_DENIED");
  const auto actual = processIdentity(pid);
  if (mm::dump(actual) != mm::dump(expected)) fail("PEER_DENIED");
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.valid()) fail("PIPE_UNAVAILABLE");
  auto transfer = [&](void* data, DWORD length, bool write) {
    DWORD offset = 0;
    while (offset < length) {
      ResetEvent(event.value); OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
      const BOOL started = write ? WriteFile(pipe.value, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation) : ReadFile(pipe.value, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation);
      finishOverlapped(pipe.value, operation, started, count, deadline);
      if (count == 0 || count > length - offset) fail("PIPE_UNAVAILABLE");
      offset += count;
    }
  };
  auto frame = mm::dump(Json::Object{{"version", 1}, {"sequence", 1}, {"nonce", nonce}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}});
  DWORD size = static_cast<DWORD>(frame.size()); transfer(&size, 4, true); transfer(frame.data(), size, true);
  transfer(&size, 4, false);
  if (size == 0 || size > 49152) fail("FRAME_TOO_LARGE");
  frame.assign(size, '\0'); transfer(frame.data(), size, false);
  const auto response = mm::JsonParser(frame).parse();
  if (response.at("version").integer() != 1 || response.at("sequence").integer() != 1 || !equalSecret(response.at("nonce").string(), nonce)) fail("PEER_DENIED");
  const auto bytes = base64Decode(response.at("payload_base64").string(), 32768);
  DWORD acknowledged = 0x4d4d0001; transfer(&acknowledged, 4, true);
  return Json::Object{{"peer", actual}, {"payload_base64", base64Encode(bytes.data(), static_cast<DWORD>(bytes.size()))}};
}
#include "pipe_dispatch.hpp"
// Only the exact signed retained-shim lineage can turn an activation fence into
// a temporary SID-wide login authority. Ordinary UI activation stays unchanged.
bool workerLoginAuthenticated = false;
void retireStoreAccountOwner();
#include "mutex.hpp"
#include "singleton.hpp"
#include "control_claim.hpp"
#include "startup.hpp"
#include "boot_identity.hpp"
#include "browser_registration.hpp"
#include "installer.hpp"
#include "release_cleanup.hpp"
#include "peer_parent.hpp"
#include "account_authority.hpp"
#include "login_worker.hpp"
#include "installer_maintenance.hpp"
#include "installer_path.hpp"
#include "protocol_registration.hpp"
#include "gpu.hpp"
#include "retained_engine.hpp"
bool authorizeStoreGuiPrivateDataCaller();
#include "share.hpp"
void assertRetiredEngineSessionCache(const std::string& relative);
#include "cache_delete.hpp"
#include "runtime_repair_cleanup.hpp"
#include "export_discard.hpp"
#include "chrome_extensions.hpp"
bool authorizeStoreGuiPrivateDataCaller();
bool authorizeStorePersonalPrivateDataCaller();
bool readStorePersonalCleanupState(const Json& owner, Json& state);
bool readStoreCpuOperationCleanupState(const Json& expectation, Json& state);
bool storeCpuExpectationReceiving(const Json& expectation);
bool authorizeStoreCpuCleanupCaller(const Json& expectation);
void forgetStoreCpuOperationCleanupState(const Json& expectation,const std::string& requestId);
void releaseStoreCpuOperationCleanupState(const Json& expectation,const std::string& requestId);
void holdStorePrivateDirectories(const std::wstring& path,const std::wstring& privateRoot,std::vector<Handle>& retained);
bool storeRetainedPersonalCleanupIdle(const Json& owner);
void authorizePersonalDataCaller() {
  if (authorizeStorePersonalPrivateDataCaller()) return;
  if (authorizeStoreGuiPrivateDataCaller()) return;
  authorizeShareCaller(installedAccountAppPin());
}
#include "personal_cleanup.hpp"
#include "storage_cleanup.hpp"
#include "library_cleanup.hpp"

void keys(const Json& object, const std::set<std::string>& allowed) {
  if (object.object().size() != allowed.size()) fail("BAD_REQUEST");
  for (const auto& [key, value] : object.object()) { (void)value; if (!allowed.contains(key)) fail("BAD_REQUEST"); }
}
constexpr std::uint64_t privateFileMaximum=4294967296ULL;
constexpr DWORD privateFileChunk=24576;
struct PrivateFileCapability{
  std::vector<Handle> ancestors;std::vector<std::wstring> ancestorPaths;std::vector<BY_HANDLE_FILE_INFORMATION> ancestorBirths;Handle file;std::wstring path,root;Json birth;std::uint64_t maximum=0;bool writable=false;bool storeModelStage=false;
};
std::map<std::string,PrivateFileCapability> privateFileCapabilities;
std::uint64_t privateFileNumber(const Json& value,std::uint64_t maximum,bool positive=false){
  if(!std::holds_alternative<std::int64_t>(value.value))fail("BAD_REQUEST");const auto number=value.integer();if(number<0||(positive&&number==0)||static_cast<std::uint64_t>(number)>maximum)fail("BAD_REQUEST");return static_cast<std::uint64_t>(number);
}
std::string privateFileString(const Json& value){if(!std::holds_alternative<std::string>(value.value))fail("BAD_REQUEST");return value.string();}
void validatePrivateFileBirth(const Json& birth){
  if(!std::holds_alternative<Json::Object>(birth.value))fail("BAD_REQUEST");keys(birth,{"device","file_id","born_at"});for(const auto& [name,value]:birth.object()){const auto text=privateFileString(value);if(text.empty()||text.size()>20||text.find_first_not_of("0123456789")!=std::string::npos)fail("BAD_REQUEST");ULONGLONG number=0;try{number=std::stoull(text);}catch(...){fail("BAD_REQUEST");}if(std::to_string(number)!=text||(name=="device"?number>0xffffffffULL:number==0))fail("BAD_REQUEST");}
}
bool samePrivateAncestorBirth(const BY_HANDLE_FILE_INFORMATION& first,const BY_HANDLE_FILE_INFORMATION& second){return first.dwVolumeSerialNumber==second.dwVolumeSerialNumber&&first.nFileIndexHigh==second.nFileIndexHigh&&first.nFileIndexLow==second.nFileIndexLow&&first.ftCreationTime.dwHighDateTime==second.ftCreationTime.dwHighDateTime&&first.ftCreationTime.dwLowDateTime==second.ftCreationTime.dwLowDateTime;}
void validatePrivateFileAncestors(const PrivateFileCapability& capability){
  if(capability.ancestors.empty()||capability.ancestors.size()!=capability.ancestorPaths.size()||capability.ancestors.size()!=capability.ancestorBirths.size())fail("PATH_UNSAFE");
  for(std::size_t index=0;index<capability.ancestors.size();++index){const auto handle=capability.ancestors[index].value;const auto info=nativeEntryInformation(handle,NativeChildKind::directory);if(_wcsicmp(nativeCanonical(handle).c_str(),capability.ancestorPaths[index].c_str())||!samePrivateAncestorBirth(info,capability.ancestorBirths[index]))fail("PATH_UNSAFE");if(nativeWithinRoot(capability.ancestorPaths[index],capability.root))assertPrivateHandle(handle,_wcsicmp(capability.ancestorPaths[index].c_str(),capability.root.c_str())==0);}
}
Json validatePrivateFileCapability(const PrivateFileCapability& capability){
  if(!capability.file.valid())fail("PATH_UNSAFE");validatePrivateFileAncestors(capability);
  nativeEntryInformation(capability.file.value,NativeChildKind::file);assertPrivateHandle(capability.file.value);if(_wcsicmp(nativeCanonical(capability.file.value).c_str(),capability.path.c_str())||mm::dump(cacheHandleBirth(capability.file.value))!=mm::dump(capability.birth))fail("PATH_UNSAFE");const auto identity=cacheHandleIdentity(capability.file.value,false);if(identity.at("bytes").integer()<0||static_cast<std::uint64_t>(identity.at("bytes").integer())>capability.maximum)fail("PATH_UNSAFE");return identity;
}
PrivateFileCapability& privateFileCapability(const Json& args){
  const auto token=privateFileString(args.at("token"));if(token.size()!=64||token.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");const auto found=privateFileCapabilities.find(token);if(found==privateFileCapabilities.end())fail("BAD_REQUEST");return found->second;
}
Json openPrivateFile(const Json& args,bool storeFixture=false,bool storeModel=false,bool storeFixed=false,std::string* originalToken=nullptr){
  if(privateFileString(args.at("root"))!="personal")fail("BAD_REQUEST");const auto relative=privateFileString(args.at("relative_path")),mode=privateFileString(args.at("mode"));const auto nativeRelative=relativePath(relative);if(std::count(relative.begin(),relative.end(),'\\')>=32)fail("BAD_REQUEST");const auto maximum=privateFileNumber(args.at("maximum_bytes"),privateFileMaximum,true);if(mode!="read"&&mode!="create-new"&&mode!="resume")fail("BAD_REQUEST");
  const auto& expected=args.at("expected_birth");if(mode=="resume"){if(relative!="prepare\\downloads\\runtime.part"&&relative!="models\\Kim_Vocal_2.onnx.part"&&!(storeFixture&&mmstorerole::data_policy::approvedFixturePath(relative)))fail("BAD_REQUEST");validatePrivateFileBirth(expected);}else if(!std::holds_alternative<std::nullptr_t>(expected.value))fail("BAD_REQUEST");if(privateFileCapabilities.size()>=16)fail("JOB_BUSY");
  if(storeModel&&(relative!="models\\Kim_Vocal_2.onnx.part"||maximum!=mmstoremodelpolicy::bytes||mode=="read"))fail("BAD_REQUEST");
  if(storeFixed&&(storeFixture||storeModel||mode!="read"||!originalToken||!originalToken->empty()))fail("BAD_REQUEST");
  const bool retained=storeModel||storeFixed;
  PrivateFileCapability local;std::string token;
  if(retained){for(unsigned attempt=0;attempt<16;++attempt){token=randomHex();if(!privateFileCapabilities.contains(token))break;token.clear();}if(token.empty())fail("IDENTITY_UNAVAILABLE");privateFileCapabilities.emplace(token,PrivateFileCapability{});if(storeFixed)*originalToken=token;}
  auto& capability=retained?privateFileCapabilities.at(token):local;
  capability.storeModelStage=storeModel;capability.root=rootPath("personal");capability.path=capability.root+L"\\"+nativeRelative;capability.maximum=maximum;capability.writable=mode!="read";
  if(retained)holdStorePrivateDirectories(capability.path.substr(0,capability.path.find_last_of(L'\\')),capability.root,capability.ancestors);
  else capability.ancestors=lockAncestors(capability.path,false,false,capability.root,true);
  for(const auto& ancestor:capability.ancestors){capability.ancestorPaths.push_back(nativeCanonical(ancestor.value));capability.ancestorBirths.push_back(nativeEntryInformation(ancestor.value,NativeChildKind::directory));}
  validatePrivateFileAncestors(capability);Security security(dataSddl());auto opened=openNativeChild(capability.ancestors.back().value,capability.path.substr(capability.path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL|(capability.writable?GENERIC_WRITE:0)|(storeModel?(DELETE|FILE_WRITE_ATTRIBUTES):0),capability.writable?0:FILE_SHARE_READ,NativeChildKind::file,mode=="create-new"?NativeChildDisposition::createNew:NativeChildDisposition::open,mode=="create-new"?security.descriptor:nullptr,false,retained?&capability.file:nullptr);
  if(retained?(opened.status!=0||!capability.file.valid()):!opened.handle.valid()){if(mode=="read"&&static_cast<ULONG>(opened.status)==nativeNameMissing)return Json::Object{{"state","missing"}};fail("PATH_UNSAFE");}if(!retained)capability.file=std::move(opened.handle);capability.birth=cacheHandleBirth(capability.file.value);
  // Resume proves the exact existing generation before any cursor/write/EOF
  // mutation; it never truncates or substitutes a same-content generation.
  if(mode=="resume"&&mm::dump(capability.birth)!=mm::dump(expected))fail("PATH_UNSAFE");const auto identity=validatePrivateFileCapability(capability);
  if(!retained){for(unsigned attempt=0;attempt<16;++attempt){token=randomHex();if(!privateFileCapabilities.contains(token))break;token.clear();}if(token.empty())fail("IDENTITY_UNAVAILABLE");privateFileCapabilities.emplace(token,std::move(capability));}
  return Json::Object{{"state","opened"},{"token",token},{"identity",identity}};
}
void seekPrivateFile(HANDLE file,std::uint64_t position){LARGE_INTEGER offset{};offset.QuadPart=static_cast<LONGLONG>(position);check(SetFilePointerEx(file,offset,nullptr,FILE_BEGIN),"PATH_UNSAFE");}
Json readPrivateFile(const Json& args){
  auto& capability=privateFileCapability(args);const auto position=privateFileNumber(args.at("position"),capability.maximum);const auto length=privateFileNumber(args.at("length"),privateFileChunk);const auto identity=validatePrivateFileCapability(capability);const auto size=static_cast<std::uint64_t>(identity.at("bytes").integer());const auto available=position>=size?0:std::min(size-position,capability.maximum-position);const auto requested=static_cast<DWORD>(std::min(length,available));std::vector<BYTE> bytes(requested);DWORD read=0;
  if(requested){seekPrivateFile(capability.file.value,position);check(ReadFile(capability.file.value,bytes.data(),requested,&read,nullptr)&&read<=requested,"PATH_UNSAFE");}validatePrivateFileCapability(capability);return Json::Object{{"bytes_base64",base64Encode(bytes.data(),read)},{"bytes_read",static_cast<std::int64_t>(read)}};
}
Json writePrivateFile(const Json& args){
  auto& capability=privateFileCapability(args);if(!capability.writable)fail("BAD_REQUEST");const auto position=privateFileNumber(args.at("position"),capability.maximum);const auto encoded=privateFileString(args.at("bytes_base64"));auto bytes=base64Decode(encoded,privateFileChunk);if(base64Encode(bytes.data(),static_cast<DWORD>(bytes.size()))!=encoded)fail("BAD_REQUEST");if(bytes.size()>capability.maximum-position)fail("BAD_REQUEST");validatePrivateFileCapability(capability);DWORD written=0;
  if(!bytes.empty()){seekPrivateFile(capability.file.value,position);check(WriteFile(capability.file.value,bytes.data(),static_cast<DWORD>(bytes.size()),&written,nullptr)&&written<=bytes.size(),"PATH_UNSAFE");}validatePrivateFileCapability(capability);return Json::Object{{"bytes_written",static_cast<std::int64_t>(written)}};
}
Json truncatePrivateFile(const Json& args){
  auto& capability=privateFileCapability(args);if(!capability.writable)fail("BAD_REQUEST");const auto length=privateFileNumber(args.at("length"),capability.maximum);validatePrivateFileCapability(capability);seekPrivateFile(capability.file.value,length);check(SetEndOfFile(capability.file.value),"PATH_UNSAFE");return Json::Object{{"identity",validatePrivateFileCapability(capability)}};
}
Json syncPrivateFile(const Json& args){auto& capability=privateFileCapability(args);if(!capability.writable)fail("BAD_REQUEST");validatePrivateFileCapability(capability);check(FlushFileBuffers(capability.file.value),"PATH_UNSAFE");return Json::Object{{"synced",true},{"identity",validatePrivateFileCapability(capability)}};}
void retireClosedStoreModelPublication(const std::string& token);
Json closePrivateFile(const Json& args){
  auto& capability=privateFileCapability(args);bool closed=true;const auto closeRetained=[&](Handle& handle){if(!handle.value)return;if(handle.value==INVALID_HANDLE_VALUE||!CloseHandle(handle.value)){closed=false;return;}handle.value=nullptr;};closeRetained(capability.file);for(auto& ancestor:capability.ancestors)closeRetained(ancestor);if(!closed)fail("PATH_UNSAFE");const auto token=privateFileString(args.at("token"));if(capability.storeModelStage)retireClosedStoreModelPublication(token);privateFileCapabilities.erase(token);return Json::Object{{"closed",true}};
}
Json dispatchConsumerOperation(const std::string& operation, const Json& args);
#include "store_model.hpp"
#include "store_bridge.hpp"
// Shared private-data primitives retain the same validation in both authority
// modes. Store dispatch admits only its closed data list before calling here.
Json dispatchConsumerOperation(const std::string& operation, const Json& args) {
  if (operation == "identity") { keys(args, {}); return identityReport(); }
  const auto report = identityReport();
  if (report.at("native_arch").string() != "x64" || report.at("process_arch").string() != "x64" || report.at("os_major").integer() != 10 || report.at("os_build").integer() < 19045) fail("UNSUPPORTED_HOST");
  if(operation=="private_file_open"){keys(args,{"root","relative_path","mode","maximum_bytes","expected_birth"});return openPrivateFile(args);}
  if(operation=="private_file_info"){keys(args,{"token"});return Json::Object{{"identity",validatePrivateFileCapability(privateFileCapability(args))}};}
  if(operation=="private_file_read"){keys(args,{"token","position","length"});return readPrivateFile(args);}
  if(operation=="private_file_write"){keys(args,{"token","position","bytes_base64"});return writePrivateFile(args);}
  if(operation=="private_file_truncate"){keys(args,{"token","length"});return truncatePrivateFile(args);}
  if(operation=="private_file_sync"){keys(args,{"token"});return syncPrivateFile(args);}
  if(operation=="private_file_close"){keys(args,{"token"});return closePrivateFile(args);}
  if(operation=="share_workspace_discard"){keys(args,{"request_id","birth","file","cache_nonce"});return discardShareWorkspace(args);}
  if(operation=="diagnostic_report_remove"){keys(args,{"request_id","cache_nonce"});return removeChromeDiagnosticReport(args);}
  if(operation=="personal_cleanup_recover"){keys(args,{"cache_nonce"});return recoverPersonalCleanups(args);}
  if(operation=="storage_partial_discard"){keys(args,{"request_id","cache_nonce"});return discardStoragePartial(args);}
  if(operation=="library_artifact_discard"){keys(args,{"request_id","relative_path","expected","cache_nonce"});return discardLibraryArtifact(args);}
  if(operation=="library_tree_discard"){keys(args,{"relative_path","birth","deletion_id","cache_nonce"});return discardLibraryTree(args);}
  if(operation=="library_tree_cleanup_ack"){keys(args,{"receipt_id","nonce","cache_nonce"});return acknowledgeLibraryTreeCleanup(args);}
  if(operation=="library_tree_cleanup_list"){keys(args,{"cache_nonce"});return listLibraryCleanups(args);}
  if(operation=="library_local_move"){keys(args,{"request_id","direction","cache_nonce"});return moveLocalLibraryDeletion(args);}
  if(operation=="library_artifact_publish"){keys(args,{"request_id","component","cache_nonce"});return publishLibraryArtifact(args);}
  if(operation=="library_artifact_publication_inspect"){keys(args,{"request_id","component","cache_nonce"});return inspectLibraryArtifactPublication(args);}
  if(operation=="storage_workspace_marker_retire"){keys(args,{"relative_path","owner","cache_nonce"});return retireStorageWorkspaceMarker(args);}
  if(operation=="store_cpu_operation_cleanup_inspect"){keys(args,{"expectation"});Json state=nullptr;if(!readStoreCpuOperationCleanupState(args.at("expectation"),state))fail("PEER_DENIED");return state;}
  if(operation=="store_cpu_workspace_marker_retire"){keys(args,{"relative_path","expectation","cache_nonce"});return retireStoreCpuWorkspaceMarker(args);}
  if(operation=="store_cpu_workspace_marker_acknowledge"){keys(args,{"receipt_id","nonce","expectation","cache_nonce"});return acknowledgeStoreCpuWorkspaceMarker(args);}
  if(operation=="store_cpu_workspace_marker_release"){keys(args,{"receipt_id","nonce","expectation","ack_nonce","cache_nonce"});return releaseStoreCpuWorkspaceMarker(args);}
  if(operation=="storage_cleanup_ack"){keys(args,{"receipt_id","nonce","cache_nonce"});return acknowledgeStorageCleanup(args);}
  if(operation=="storage_cleanup_recover"){keys(args,{"cache_nonce"});assertCacheLease(args);authorizeStorageCleanup();return Json::Object{{"retained",static_cast<int>(recoverStorageCleanupRecords())}};}
  if(operation=="cache_delete_begin"){keys(args,{"request_id","relative_path","kind","expected","cache_nonce"});return beginCacheDeletion(args);}
  if(operation=="cache_delete_commit"||operation=="cache_delete_release"){keys(args,{"request_id","relative_path","kind","nonce","cache_nonce"});return operation=="cache_delete_commit"?commitCacheDeletion(args):releaseCacheDeletion(args);}
  if(operation=="cache_delete_recover"){keys(args,{"cache_nonce"});return recoverCacheDeletions(args);}
  if(operation=="runtime_repair_backup_remove"){keys(args,{"target","record_digest","prepare_nonce"});return removeRuntimeRepairBackup(args);}
  if(operation=="created_export_discard"){keys(args,{"request_id","path","creator","expected","app_sha256","app_bytes","publisher_sha256"});return discardCreatedExport(args);}
  if(operation=="created_export_destination_validate"){keys(args,{"path","app_sha256","app_bytes","publisher_sha256"});return validateExportDestination(args);}
  if(operation=="created_export_discard_inspect"){keys(args,{"request_id","app_sha256","app_bytes","publisher_sha256"});return inspectCreatedExportDiscard(args);}
  if(operation=="created_export_discard_ack"){keys(args,{"request_id","nonce","app_sha256","app_bytes","publisher_sha256"});return acknowledgeCreatedExportDiscard(args);}
  if(operation=="chrome_extensions_open"){keys(args,{"app_sha256","app_bytes","publisher_sha256"});return openChromeExtensions(args);}
  // Witness initialization is a registry write. Unsupported/emulated hosts
  // must pass the same native architecture/OS policy before it is reachable.
  if(operation=="boot_identity"){keys(args,{});return consumerBootIdentity();}
  if(operation=="worker_login_peer_verify"){keys(args,{});auto proof=verifyWorkerLoginPeer();workerLoginAuthenticated=true;return proof;}
  if(operation=="worker_login_idle"){keys(args,{"scope"});return workerLoginIdle(args.at("scope").string());}
  if(operation=="startup_retain"){keys(args,{"launcher_sha256","publisher_sha256"});return retainWorkerLauncher(args);}
  if(operation=="share_start"){keys(args,{"request_id","window_handle","window_owner","relative_path","sha256","bytes","title","mime","app_sha256","app_bytes","publisher_sha256"});return startNativeShare(args);}
  if(operation=="share_inspect"){keys(args,{"request_id"});return inspectNativeShare(args);}
  if(operation=="share_cancel"){keys(args,{"request_id","nonce"});return cancelNativeShare(args);}
  if(operation=="share_cleanup_acknowledge"){keys(args,{"request_id","nonce"});return acknowledgeNativeShareCleanup(args);}
  if(operation=="share_cleanup_completed"){keys(args,{});authorizeShareCaller(installedAccountAppPin());return pruneNativeShareReceipts();}
  if (operation == "process_identity") {
    keys(args, {"pid"}); const auto pid = args.at("pid").integer();
    if (pid < 1 || pid > 2147483647) fail("BAD_REQUEST");
    return processIdentity(static_cast<DWORD>(pid), true);
  }
  if (operation == "ensure_private_directory") {
    keys(args, {"root", "relative_path"}); const auto root = rootPath(args.at("root").string()); const auto path = ownedPath(args);
    auto handles = lockAncestors(path, true, true, root);
    return Json::Object{{"path", utf8(path)}};
  }
  if (operation == "validate_path") {
    keys(args, {"root", "relative_path", "kind"}); const auto root = rootPath(args.at("root").string()); const auto path = ownedPath(args);
    auto handles = lockAncestors(path, false, false, root);
    const auto kind = args.at("kind").string();
    if (kind == "absent") { if (!nativeChildMissing(handles.back().value,path.substr(path.find_last_of(L'\\')+1))) fail("PATH_UNSAFE"); }
    else if (kind == "file" || kind == "directory") { auto entry = openEntry(path, kind == "directory", true); }
    else fail("BAD_REQUEST");
    return Json::Object{{"safe", true}};
  }
  if (operation == "vault_put") { keys(args, {"namespace", "key", "bytes_base64"}); return vault(operation, args); }
  if (operation == "vault_get" || operation == "vault_delete") { keys(args, {"namespace", "key"}); return vault(operation, args); }
  if (operation == "vault_recover") { keys(args, {"namespace"}); return vaultRecover(args); }
  if (operation == "launch_owned") { keys(args, {"role", "release"}); return launchOwned(args); }
  if (operation == "stop_owned") { keys(args, {"role", "nonce", "identity"}); return stopOwned(args); }
  if (operation == "is_owned_process") { keys(args, {"owner", "identity"}); return isOwnedProcess(args); }
  if (operation == "owned_tree_exited") { keys(args, {"owner"}); return ownedTreeExited(args); }
  if(operation=="wait_process_exit") {
    keys(args,{"identity","timeout_ms"});const auto& expected=args.at("identity");const auto milliseconds=args.at("timeout_ms").integer();if(milliseconds<100||milliseconds>30000||expected.at("sid").string()!=currentIdentity().sid||expected.at("session_id").integer()!=currentIdentity().session)fail("PEER_DENIED");
    const auto pid=expected.at("pid").integer();if(pid<1||pid>2147483647||pid==GetCurrentProcessId())fail("BAD_REQUEST");Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(pid)));if(!process.valid()){if(GetLastError()==ERROR_INVALID_PARAMETER)return Json::Object{{"exited",true}};fail("IDENTITY_UNAVAILABLE");}
    if(creation(process.value)!=expected.at("creation_time").string())return Json::Object{{"exited",true}};Handle token;check(OpenProcessToken(process.value,TOKEN_QUERY,&token.value),"IDENTITY_UNAVAILABLE");const auto peer=tokenIdentity(token.value);if(peer.sid!=currentIdentity().sid||peer.session!=currentIdentity().session)fail("PEER_DENIED");const auto waited=WaitForSingleObject(process.value,static_cast<DWORD>(milliseconds));if(waited!=WAIT_OBJECT_0&&waited!=WAIT_TIMEOUT)fail("IDENTITY_UNAVAILABLE");return Json::Object{{"exited",waited==WAIT_OBJECT_0}};
  }
  if (operation == "same_parent_process") { keys(args, {"first", "second"}); return sameParentProcess(args); }
  if (operation == "claim_session_ticket") { keys(args, {"nonce"}); return claimSessionTicket(args); }
  if (operation == "claim_browser_account_ticket") { keys(args, {"nonce"}); return claimBrowserAccountTicket(args); }
  if (operation == "pipe_exchange") { keys(args, {"channel", "nonce", "peer", "timeout_ms", "response_base64"}); return pipeExchange(args); }
  if (operation == "pipe_connect") { keys(args, {"channel", "nonce", "peer", "timeout_ms", "payload_base64"}); return pipeConnect(args); }
  if (operation == "pipe_accept") { keys(args, {"channel", "nonce", "peer", "timeout_ms"}); return pipeAccept(args); }
  if (operation == "pipe_reply") { keys(args, {"token", "nonce", "peer", "payload_base64"}); return pipeReply(args); }
  if (operation == "pipe_close") { keys(args, {"token", "nonce", "peer"}); return pipeClose(args); }
  if (operation == "acquire_mutex") { keys(args, {"scope"}); return acquireMutex(args); }
  if (operation == "singleton_inspect") { keys(args, {"scope"}); return inspectSingletonOwner(args); }
  if (operation == "singleton_assert_publication") { keys(args, {"scope"}); assertSingletonPublication(args.at("scope").string()); return Json::Object{{"authorized", true}}; }
  if (operation == "release_mutex") { keys(args, {"scope", "nonce", "identity"}); return releaseMutex(args); }
  if (operation == "startup_inspect") { keys(args, {}); return inspectStartup(); }
  if (operation == "startup_register") { keys(args, {"launcher_sha256"}); return registerStartup(args); }
  if (operation == "startup_remove") { keys(args, {}); return removeStartup(); }
  if (operation == "legacy_worker_conflict") { keys(args, {}); return legacyWorkerConflict(); }
  if (operation == "launch_session_agent") { keys(args, {"launcher_sha256"}); return launchSessionAgent(args); }
  if (operation == "launcher_verify") { keys(args, {"launcher_sha256"}); auto file = lockHashedFile(fixedLauncherPath(), args.at("launcher_sha256").string(), true); LARGE_INTEGER bytes{}; check(GetFileSizeEx(file.value, &bytes), "HELPER_INTEGRITY_INVALID"); if (bytes.QuadPart < 1 || bytes.QuadPart > 16 * 1024 * 1024) fail("HELPER_INTEGRITY_INVALID"); return Json::Object{{"verified", true}, {"bytes", bytes.QuadPart}}; }
  if(operation=="browser_register"){keys(args,{"extension_id","host_sha256","host_bytes","entry_sha256","entry_bytes"});return registerBrowser(args);}
  if(operation=="browser_inspect"){keys(args,{"extension_id","host_sha256","host_bytes","entry_sha256","entry_bytes"});return inspectBrowser(args);}
  if(operation=="browser_unregister"){keys(args,{});return unregisterBrowser();}
  if(operation=="installer_verify"||operation=="installer_launch"){keys(args,{"identity","sha256","bytes","publisher_sha256"});return installerOperation(args,operation=="installer_launch");}
  if(operation=="installer_launch_inspect"||operation=="installer_launch_recover"){keys(args,{"identity","sha256","bytes","publisher_sha256"});return inspectInstallerLaunch(args,operation=="installer_launch_recover");}
  if(operation=="installer_monitor_remove_completed"){keys(args,{"identity","sha256","bytes","publisher_sha256"});return removeCompletedInstallerMonitor(args);}
  if(operation=="account_authority_launch"){keys(args,{"app_sha256","app_bytes","publisher_sha256"});return launchAccountAuthority(args);}
  if(operation=="browser_owner_proof_peers"){keys(args,{"authority","browser"});return verifyBrowserOwnerProofPeers(args);}
  if(operation=="personal_owner_proof_peers"){keys(args,{"authority","owner","owner_kind"});return verifyPersonalOwnerProofPeers(args);}
  if(operation=="account_peer_verify"){keys(args,{"identity","role","app_sha256","app_bytes","publisher_sha256"});return verifyAccountPeer(args);}
  if(operation=="installer_maintenance_peer_verify"){keys(args,{"identity","action","app_sha256","app_bytes","publisher_sha256"});return verifyInstallerMaintenancePeer(args);}
  if(operation=="protocol_register"||operation=="protocol_unregister"){keys(args,{});return protocolRegistration(operation=="protocol_unregister");}
  if(operation=="release_remove_unused"){keys(args,{"release","manifest_sha256"});return removeUnusedRelease(args);}
  if (operation == "gpu_inventory") { keys(args, {}); return Json::Object{{"gpus", gpuInventory()}}; }
  if (operation == "acquire_gpu_guard") { keys(args, {"luid"}); return acquireGpuGuard(args); }
  if (operation == "bind_role_job") { keys(args, {"owner"}); return bindRoleJob(args); }
  if (operation == "inference_idle") {keys(args,{});if(!boundGpuRole)fail("JOB_NOT_OWNED");return Json::Object{{"idle",gpuRoleIdle(boundGpuRole->job.value,boundGpuRole->owner)}};}
  if(operation=="retained_engine_register"){keys(args,{"guardian","engine"});return registerRetainedEngine(args);}
  if(operation=="retained_engine_begin"){keys(args,{"token","job_id"});return beginRetainedEngine(args);}
  if(operation=="retained_engine_complete"){keys(args,{"token","job_id"});return completeRetainedEngine(args);}
  if(operation=="retained_engine_idle"){keys(args,{"token"});return inspectRetainedEngine(args);}
  if(operation=="retained_engine_forget"){keys(args,{"token"});return forgetRetainedEngine(args);}
  if (operation == "release_gpu_guard") { keys(args, {"luid", "nonce", "identity"}); return releaseGpuGuard(args); }
  fail("BAD_REQUEST");
}
Json dispatch(const std::string& operation, const Json& args) {
  if (storeTransportMode) return dispatchStore(operation, args);
  if (operation.starts_with("store_")) fail("PEER_DENIED");
  return dispatchConsumerOperation(operation, args);
}
} // namespace

#include "transport_terminal.hpp"
#if !defined(MUSICMUTE_CONSUMER_NATIVE_TEST) && !defined(MUSICMUTE_CONSUMER_NATIVE_LIBRARY)
LRESULT CALLBACK sessionWindowProc(HWND window, UINT message, WPARAM parameter, LPARAM detail) {
  if (message == WM_QUERYENDSESSION) { emitSessionEvent("ending_requested"); return TRUE; }
  if (message == WM_ENDSESSION) { if (parameter) { emitSessionEvent("ending"); mm::terminateConsumerTransport(0); } else emitSessionEvent("resume"); }
  if (message == WM_WTSSESSION_CHANGE) {
    if (parameter == WTS_SESSION_LOCK) emitSessionEvent("lock");
    if (parameter == WTS_SESSION_UNLOCK) emitSessionEvent("unlock");
    if (parameter == WTS_SESSION_LOGOFF) { emitSessionEvent("ending"); mm::terminateConsumerTransport(0); }
  }
  if (message == WM_POWERBROADCAST) {
    if (parameter == PBT_APMSUSPEND) emitSessionEvent("suspend");
    if (parameter == PBT_APMRESUMEAUTOMATIC || parameter == PBT_APMRESUMESUSPEND) emitSessionEvent("resume");
  }
  return DefWindowProcW(window, message, parameter, detail);
}
int wmain(int argc, wchar_t** argv) {
  auto entryPhase = mmstorediagnostic::Phase::entryContext;
  try {
    storeTransportMode = argc == 2 && std::wstring(argv[1]) == L"--store-stdio";
    const bool packaged = registeredPackageContext();
    if (packaged && argc == 3) {
      const std::wstring entry(argv[1]);
      if (entry == L"--store-job-guardian" || entry == L"--store-gpu-guardian" || entry == L"--store-gpu-watchdog") {
        const auto worker = mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker);
        if (mmstore::currentPackageFullName() != worker.observation().fullName) return 2;
        // Each receiver additionally consumes the creator's actual suspended-
        // child registration and verifies the inherited exact observed Job.
        if (entry == L"--store-job-guardian") return independentJobMain(argv[2]);
        if (entry == L"--store-gpu-guardian") return independentGpuMain(argv[2]);
        return independentGpuWatchdogMain(argv[2]);
      }
    }
    if (packaged && !storeTransportMode) return 2;
    if (storeTransportMode) {
      entryPhase = mmstorediagnostic::Phase::entrySelf;
      // Early fixed self query enforces only this binary's compiled package
      // identity, signature origin and optional exact local-test signer pin.
      const auto fullName = mmstore::currentPackageFullName();
      const auto gui = std::wstring(mmstore::expectedPackage(mmstore::PackageKind::gui).identityName) + L"_";
      const auto worker = std::wstring(mmstore::expectedPackage(mmstore::PackageKind::worker).identityName) + L"_";
      const auto kind = fullName.starts_with(gui) ? mmstore::PackageKind::gui :
        fullName.starts_with(worker) ? mmstore::PackageKind::worker : throw mmstore::Error(mmstore::ErrorCode::packageDenied);
      (void)mmstore::resolveRegisteredPackage(kind);
    }
  } catch (const mmstore::Error& error) {
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
    if (storeTransportMode) mmstorediagnostic::emit(entryPhase, GetLastError(), static_cast<std::uint32_t>(error.code()) + 1);
#else
    (void)error;
#endif
    return 2;
  } catch (...) {
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
    if (storeTransportMode) mmstorediagnostic::emit(entryPhase, GetLastError());
#endif
    return 2;
  }
  (void)entryPhase;
  if(argc==2&&std::wstring(argv[1])==L"--installer-path-preflight") {try{installerPathPreflight();return 0;}catch(...){return 2;}}
  if(argc==2&&std::wstring(argv[1])==L"--installer-preflight") {
    try {const auto host=identityReport();if(host.at("native_arch").string()!="x64"||host.at("process_arch").string()!="x64"||host.at("os_major").integer()!=10||host.at("os_build").integer()<19045)return 2;assertNoSingleton("account");assertNoSingleton("session");return 0;}catch(...){return 2;}
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--installer-monitor") return installerMonitorMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--job-guardian") return independentJobMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--gpu-guardian") return independentGpuMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--gpu-watchdog") return independentGpuWatchdogMain(argv[2]);
  if (argc != 1 && !storeTransportMode) return 2;
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  // Hidden top-level window receives logout/shutdown messages; message-only
  // windows do not receive broadcast WM_QUERYENDSESSION/WM_ENDSESSION.
  std::thread([] {
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = sessionWindowProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = L"MusicMuteConsumerSessionGuardian";
    if (!RegisterClassW(&windowClass)) {
      if (storeTransportMode) mmstorediagnostic::emit(mmstorediagnostic::Phase::sessionWindow, GetLastError());
      mm::terminateConsumerTransport(2);
    }
    HWND window = CreateWindowExW(0, windowClass.lpszClassName, L"MusicMute Session", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, windowClass.hInstance, nullptr);
    if (!window) {
      if (storeTransportMode) mmstorediagnostic::emit(mmstorediagnostic::Phase::sessionWindow, GetLastError());
      mm::terminateConsumerTransport(2);
    }
    if (!WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)) {
      if (storeTransportMode) mmstorediagnostic::emit(mmstorediagnostic::Phase::sessionRegister, GetLastError());
      mm::terminateConsumerTransport(2);
    }
    HANDLE networkNotification = nullptr;
    const auto callback = [](PVOID, PMIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE) { emitSessionEvent("network"); };
    const auto notified = NotifyIpInterfaceChange(AF_UNSPEC, callback, nullptr, FALSE, &networkNotification);
    if (notified != NO_ERROR) {
      if (storeTransportMode) mmstorediagnostic::emit(mmstorediagnostic::Phase::sessionNetwork, notified);
      mm::terminateConsumerTransport(2);
    }
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    mm::terminateConsumerTransport(2);
  }).detach();
  // A separate input reader detects EOF even while a native operation is waiting.
  // Terminal self-exit closes this helper's handles; the independent Job
  // guardian performs actual child termination/Job-zero certificate separately.
  std::mutex mutex; std::condition_variable changed;
  std::vector<std::string> frames;
  std::atomic<bool> invalid{false};
  std::thread reader([&] {
    std::string frame;
    for (;;) {
      const int c = std::getchar();
      if (c == EOF) {
        if (storeTransportMode) mmstorediagnostic::emit(mmstorediagnostic::Phase::transportEof, 0);
        mm::terminateConsumerTransport(2);
      }
      if (c == '\n') {
        std::lock_guard lock(mutex);
        if (frames.size() >= 16) mm::terminateConsumerTransport(2);
        frames.push_back(std::move(frame)); frame.clear(); changed.notify_one();
      } else {
        if (frame.size() >= maxFrame) { invalid = true; changed.notify_one(); mm::terminateConsumerTransport(2); }
        frame += static_cast<char>(c);
      }
    }
  });
  reader.detach();
  std::uint64_t previous = 0;
  std::atomic<unsigned> pipeClients{0};
  for (;;) {
    std::string frame;
    { std::unique_lock lock(mutex); changed.wait(lock, [&] { return !frames.empty() || invalid.load(); }); if (invalid) mm::terminateConsumerTransport(2); frame = std::move(frames.front()); frames.erase(frames.begin()); }
    Json id(nullptr);
    auto requestPhase = mmstorediagnostic::Phase::storeDispatch;
    try {
      const auto request = mm::JsonParser(frame).parse();
      keys(request, {"version", "id", "operation", "args"});
      const auto sequence = request.at("id").integer();
      if (request.at("version").integer() != 1 || sequence < 1 || static_cast<std::uint64_t>(sequence) <= previous) fail("PROTOCOL_MISMATCH");
      id = sequence; previous = static_cast<std::uint64_t>(sequence);
      if (request.at("operation").string() == "store_boot") requestPhase = mmstorediagnostic::Phase::storeBoot;
      else if (request.at("operation").string() == "store_startup") requestPhase = mmstorediagnostic::Phase::storeStartup;
      if(!storeTransportMode && request.at("operation").string()=="pipe_connect") {
        if(pipeClients.fetch_add(1)>=16){--pipeClients;fail("PIPE_UNAVAILABLE");}
        const auto arguments=request.at("args");
        try {
          std::thread([arguments,id,&pipeClients]{
            try { keys(arguments,{"channel","nonce","peer","timeout_ms","payload_base64"});const auto value=pipeConnect(arguments);writeNativeMessage(Json::Object{{"version",1},{"id",id},{"ok",true},{"result",value}}); }
            catch(const Failure& error){writeNativeMessage(Json::Object{{"version",1},{"id",id},{"ok",false},{"error",Json::Object{{"code",error.code}}}});}
            catch(...){writeNativeMessage(Json::Object{{"version",1},{"id",id},{"ok",false},{"error",Json::Object{{"code","BAD_REQUEST"}}}});}
            --pipeClients;
          }).detach();
        }catch(...){--pipeClients;throw;}
        SecureZeroMemory(frame.data(),frame.size());continue;
      }
      const auto value = dispatch(request.at("operation").string(), request.at("args"));
      writeNativeMessage(Json::Object{{"version", 1}, {"id", id}, {"ok", true}, {"result", value}});
    } catch (const Failure& error) {
      if (storeTransportMode) mmstorediagnostic::emit(requestPhase,
        error.diagnostic.code ? error.diagnostic.win32 : GetLastError(), error.diagnostic.code);
      writeNativeMessage(Json::Object{{"version", 1}, {"id", id}, {"ok", false}, {"error", Json::Object{{"code", error.code}}}});
    } catch (const mmstore::Error& error) {
      if (storeTransportMode) mmstorediagnostic::emit(requestPhase, GetLastError(), static_cast<std::uint32_t>(error.code()) + 1);
      writeNativeMessage(Json::Object{{"version", 1}, {"id", id}, {"ok", false}, {"error", Json::Object{{"code", "BAD_REQUEST"}}}});
    } catch (...) {
      if (storeTransportMode) mmstorediagnostic::emit(requestPhase, GetLastError());
      writeNativeMessage(Json::Object{{"version", 1}, {"id", id}, {"ok", false}, {"error", Json::Object{{"code", "BAD_REQUEST"}}}});
    }
    SecureZeroMemory(frame.data(), frame.size());
    if (!std::cout) mm::terminateConsumerTransport(2);
  }
}
#endif
