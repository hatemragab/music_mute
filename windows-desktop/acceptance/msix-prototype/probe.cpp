#include <windows.h>
#include <appmodel.h>
#include <sddl.h>
#include <aclapi.h>
#include <shlobj.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <mscat.h>
#include <bcrypt.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.System.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <iostream>
#include <memory>
#include <cstring>
#include "qa-config.hpp"
#include "protocol.hpp"

namespace {
using msixqa::require;
const char* observedPhase = "context";
mm::Json::Object namespaceObservations;
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete; Handle& operator=(const Handle&) = delete;
  Handle(Handle&& h) noexcept : value(std::exchange(h.value, INVALID_HANDLE_VALUE)) {}
  Handle& operator=(Handle&& h) noexcept { if (this != &h) { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); value = std::exchange(h.value, INVALID_HANDLE_VALUE); } return *this; }
};
struct Key { HKEY value = nullptr; ~Key() { if (value) RegCloseKey(value); } };
std::string utf8(const std::wstring& text) {
  require(text.size() < 32768); if (text.empty()) return {};
  const auto n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr); require(n > 0);
  std::string out(static_cast<std::size_t>(n), '\0'); require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr) == n); return out;
}
std::wstring canonical(HANDLE file) {
  std::wstring text(32768, L'\0'); const auto n = GetFinalPathNameByHandleW(file, text.data(), static_cast<DWORD>(text.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS); require(n > 0 && n < text.size()); text.resize(n); if (text.starts_with(L"\\\\?\\")) text.erase(0, 4); return text;
}
std::wstring modulePath() { std::wstring text(32768, L'\0'); const auto n = GetModuleFileNameW(nullptr, text.data(), static_cast<DWORD>(text.size())); require(n > 0 && n < text.size()); text.resize(n); return text; }
std::wstring localData(DWORD flags = KF_FLAG_NO_PACKAGE_REDIRECTION) { PWSTR raw = nullptr; const auto result = SHGetKnownFolderPath(FOLDERID_LocalAppData, flags, nullptr, &raw); namespaceObservations["known_folder_flags"] = static_cast<std::int64_t>(flags); namespaceObservations["known_folder_hresult"] = static_cast<std::int64_t>(result); require(SUCCEEDED(result)); std::wstring out(raw); CoTaskMemFree(raw); return out; }
std::wstring systemDirectory() { wchar_t text[MAX_PATH + 1]{}; const auto n = GetSystemDirectoryW(text, MAX_PATH); require(n > 0 && n < MAX_PATH); return std::wstring(text, n); }
std::wstring sid(HANDLE process = GetCurrentProcess()) {
  Handle token; require(OpenProcessToken(process, TOKEN_QUERY, &token.value)); DWORD n = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &n); require(n > 0 && n < 65536); std::vector<BYTE> bytes(n); require(GetTokenInformation(token.value, TokenUser, bytes.data(), n, &n)); PWSTR raw = nullptr; require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &raw)); std::wstring result(raw); LocalFree(raw); return result;
}
bool elevated(HANDLE process = GetCurrentProcess()) { Handle token; require(OpenProcessToken(process, TOKEN_QUERY, &token.value)); TOKEN_ELEVATION value{}; DWORD n = 0; require(GetTokenInformation(token.value, TokenElevation, &value, sizeof(value), &n)); return value.TokenIsElevated != 0; }
mm::Json windowsVersion() {
  using Query = LONG (NTAPI*)(OSVERSIONINFOW*);
  const auto address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"); require(address != nullptr); Query query = nullptr; static_assert(sizeof(query) == sizeof(address)); std::memcpy(&query, &address, sizeof(query)); OSVERSIONINFOW value{}; value.dwOSVersionInfoSize = sizeof(value); require(query(&value) == 0);
  USHORT process = 0, native = 0; require(IsWow64Process2(GetCurrentProcess(), &process, &native) && native == IMAGE_FILE_MACHINE_AMD64 && (process == IMAGE_FILE_MACHINE_UNKNOWN || process == IMAGE_FILE_MACHINE_AMD64));
  return mm::Json::Object{{"major", static_cast<std::int64_t>(value.dwMajorVersion)}, {"build", static_cast<std::int64_t>(value.dwBuildNumber)}, {"native_arch", "x64"}, {"process_arch", "x64"}};
}
mm::Json processPackage(HANDLE process) {
  UINT32 n = 0; const auto status = GetPackageFullName(process, &n, nullptr);
  if (status == APPMODEL_ERROR_NO_PACKAGE) return mm::Json::Object{{"has_identity", false}, {"full_name", nullptr}};
  require(status == ERROR_INSUFFICIENT_BUFFER && n > 1 && n < 32768); std::wstring text(n, L'\0'); require(GetPackageFullName(process, &n, text.data()) == ERROR_SUCCESS); text.resize(n - 1); return mm::Json::Object{{"has_identity", true}, {"full_name", utf8(text)}};
}
mm::Json applicationIdentity(HANDLE process) {
  UINT32 n = 0; const auto status = GetApplicationUserModelId(process, &n, nullptr);
  if (status == APPMODEL_ERROR_NO_APPLICATION) return mm::Json::Object{{"query_status", static_cast<std::int64_t>(status)}, {"has_application_identity", false}, {"user_model_id", nullptr}};
  require(status == ERROR_INSUFFICIENT_BUFFER && n > 1 && n < 32768); std::wstring text(n, L'\0'); require(GetApplicationUserModelId(process, &n, text.data()) == ERROR_SUCCESS); text.resize(n - 1);
  return mm::Json::Object{{"query_status", 0}, {"has_application_identity", true}, {"user_model_id", utf8(text)}};
}
std::string hash(HANDLE file) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE digest = nullptr;
  require(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0);
  struct Crypto { BCRYPT_ALG_HANDLE& a; BCRYPT_HASH_HANDLE& h; ~Crypto() { if (h) BCryptDestroyHash(h); if (a) BCryptCloseAlgorithmProvider(a, 0); } } cleanup{algorithm, digest};
  require(BCryptCreateHash(algorithm, &digest, nullptr, 0, nullptr, 0, 0) == 0);
  require(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); std::vector<BYTE> bytes(65536); DWORD n = 0; std::uint64_t total = 0;
  for (;;) { require(ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &n, nullptr)); if (!n) break; total += n; require(total <= 16ULL * 1024 * 1024); require(BCryptHashData(digest, bytes.data(), n, 0) == 0); }
  BYTE result[32]{}; require(BCryptFinishHash(digest, result, sizeof(result), 0) == 0); constexpr char hex[] = "0123456789abcdef"; std::string out; for (const auto b : result) { out += hex[b >> 4]; out += hex[b & 15]; } return out;
}
Handle regular(const std::wstring& path, bool singleLink) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(file.value != INVALID_HANDLE_VALUE); BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(file.value, &info)); require(!(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) && (!singleLink || info.nNumberOfLinks == 1)); require(_wcsicmp(canonical(file.value).c_str(), path.c_str()) == 0); return file;
}
#ifdef MUSICMUTE_MSIX_QA_CHROME_HOST
// Read-only kernel observations from actual inherited Chrome handles. These
// fields are evidence, never authority or a production admission override.
mm::Json pipeProcessObservation(ULONG expectedPid) {
  mm::Json::Object result{{"requested_pid", static_cast<std::int64_t>(expectedPid)}, {"opened", false}};
  if (!expectedPid) return result;
  SetLastError(0); Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, expectedPid));
  result["open_error"] = static_cast<std::int64_t>(process.value == nullptr || process.value == INVALID_HANDLE_VALUE ? GetLastError() : 0);
  if (process.value == nullptr || process.value == INVALID_HANDLE_VALUE) return result;
  result["opened"] = true; result["observed_pid"] = static_cast<std::int64_t>(GetProcessId(process.value));
  result["wait_observation"] = static_cast<std::int64_t>(WaitForSingleObject(process.value, 0));
  try {
    std::wstring image(32768, L'\0'); DWORD length = static_cast<DWORD>(image.size()); require(QueryFullProcessImageNameW(process.value, 0, image.data(), &length) && length > 0 && length < image.size()); image.resize(length);
    FILETIME birth{}, exit{}, kernel{}, user{}; require(GetProcessTimes(process.value, &birth, &exit, &kernel, &user)); DWORD session = 0; require(ProcessIdToSessionId(expectedPid, &session));
    result["image"] = utf8(image); result["sid"] = utf8(sid(process.value)); result["session_id"] = static_cast<std::int64_t>(session);
    result["creation_time"] = std::to_string((static_cast<ULONGLONG>(birth.dwHighDateTime) << 32) | birth.dwLowDateTime);
    result["metadata_complete"] = true;
  } catch (...) { result["metadata_complete"] = false; result["metadata_error"] = static_cast<std::int64_t>(GetLastError()); }
  return result;
}
mm::Json standardPipeObservation(DWORD standardHandle) {
  const auto handle = GetStdHandle(standardHandle); mm::Json::Object result;
  SetLastError(0); const auto type = GetFileType(handle); result["file_type"] = static_cast<std::int64_t>(type); result["file_type_error"] = static_cast<std::int64_t>(GetLastError());
  DWORD flags = 0; SetLastError(0); const auto flagsOk = GetHandleInformation(handle, &flags);
  result["handle_flags_query_ok"] = flagsOk != FALSE; result["handle_flags_query_error"] = static_cast<std::int64_t>(flagsOk ? 0 : GetLastError()); result["handle_flags"] = static_cast<std::int64_t>(flags);
  for (const bool server : {true, false}) {
    ULONG pid = 0; SetLastError(0); const auto ok = server ? GetNamedPipeServerProcessId(handle, &pid) : GetNamedPipeClientProcessId(handle, &pid); const auto error = ok ? 0 : GetLastError();
    result[server ? "server_query" : "client_query"] = mm::Json::Object{{"ok", ok != FALSE}, {"error", static_cast<std::int64_t>(error)}, {"pid", static_cast<std::int64_t>(pid)}, {"process", ok && pid ? pipeProcessObservation(pid) : mm::Json(nullptr)}};
  }
  return result;
}
mm::Json standardPipesObservation() {
  return mm::Json::Object{{"qa_only", true}, {"read_only", true}, {"authority_granted", false}, {"native_process", pipeProcessObservation(GetCurrentProcessId())}, {"stdin", standardPipeObservation(STD_INPUT_HANDLE)}, {"stdout", standardPipeObservation(STD_OUTPUT_HANDLE)}};
}
#endif
struct Context {
  winrt::Windows::ApplicationModel::Package package{nullptr}; std::wstring root, userSid; Handle self; DWORD session = 0; int signatureKind = -1;
  Context() {
    winrt::init_apartment(); package = winrt::Windows::ApplicationModel::Package::Current();
    require(package.Id().Name() == MM_QA_NAME && package.Id().Publisher() == MM_QA_PUBLISHER);
    signatureKind = static_cast<int>(package.SignatureKind()); require(signatureKind == 0);
    root = package.InstalledLocation().Path().c_str(); userSid = sid(); require(!elevated()); require(ProcessIdToSessionId(GetCurrentProcessId(), &session) && session != 0);
#ifdef MUSICMUTE_MSIX_QA_CHROME_HOST
    const auto expected = root + L"\\MusicMuteMsixChromeHost.exe";
#else
    const auto expected = root + L"\\MusicMuteMsixProbe.exe";
#endif
    require(_wcsicmp(modulePath().c_str(), expected.c_str()) == 0); self = regular(expected, false);
    require(package.Id().Architecture() == winrt::Windows::System::ProcessorArchitecture::X64);
  }
  mm::Json observation() {
    BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(self.value, &info));
    mm::Json::Object result{{"version", 1}, {"qa_only", true}, {"namespace_profile", utf8(MM_QA_NAMESPACE_PROFILE)}, {"data_cohort", utf8(MM_QA_DATA_COHORT)}, {"data_role", utf8(MM_QA_DATA_ROLE)}, {"windows", windowsVersion()}, {"package_name", utf8(package.Id().Name().c_str())}, {"publisher", utf8(package.Id().Publisher().c_str())}, {"package_full_name", utf8(package.Id().FullName().c_str())}, {"package_family_name", utf8(package.Id().FamilyName().c_str())}, {"package_root", utf8(root)}, {"signature_kind", signatureKind}, {"production_store_origin_allowed", msixqa::productionStoreOriginAllowed(signatureKind)}, {"sid", utf8(userSid)}, {"session_id", static_cast<std::int64_t>(session)}, {"elevated", false}, {"image", utf8(canonical(self.value))}, {"image_sha256", hash(self.value)}, {"image_links", static_cast<std::int64_t>(info.nNumberOfLinks)}, {"image_file_id", std::to_string((static_cast<ULONGLONG>(info.nFileIndexHigh) << 32) | info.nFileIndexLow)}, {"process_package", processPackage(GetCurrentProcess())}, {"application_identity", applicationIdentity(GetCurrentProcess())}};
#ifdef MUSICMUTE_MSIX_QA_CHROME_HOST
    result["standard_pipes"] = standardPipesObservation();
#endif
    return result;
  }
};
std::wstring quote(const std::wstring& text) { require(!text.empty() && text.find_first_of(L"\"\r\n") == std::wstring::npos); return L"\"" + text + L"\""; }
void assertOwner(HANDLE file, const std::wstring& userSid) {
  PSID owner = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr; require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &descriptor) == ERROR_SUCCESS); PWSTR raw = nullptr; const bool converted = owner && ConvertSidToStringSidW(owner, &raw); const bool ok = converted && userSid == raw; if (converted) namespaceObservations["last_opened_owner_sid"] = utf8(raw); namespaceObservations["required_owner_sid"] = utf8(userSid); if (raw) LocalFree(raw); if (descriptor) LocalFree(descriptor); require(ok);
}
// Every physical ancestor remains held without FILE_SHARE_DELETE. Creation never
// traverses an unchecked pre-existing MusicMute parent or adopts an existing QA
// directory. Both shell-known physical namespace candidates are checked first.
std::vector<Handle> directoryAncestors(const std::wstring& path, const std::wstring& userSid) {
  require(path.size() >= 3 && path.size() < 32768 && path[1] == L':' && path[2] == L'\\' && path.find(L'/') == std::wstring::npos && path.find_first_of(L"\r\n\"") == std::wstring::npos);
  std::vector<Handle> held; std::size_t end = 3;
  for (;;) {
    const auto prefix = path.substr(0, end);
    observedPhase = "ancestor-open"; namespaceObservations["ancestor_requested"] = utf8(prefix);
    Handle directory(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES | (end == path.size() ? READ_CONTROL : 0), FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(directory.value != INVALID_HANDLE_VALUE); observedPhase = "ancestor-attributes"; BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(directory.value, &info)); namespaceObservations["ancestor_attributes"] = static_cast<std::int64_t>(info.dwFileAttributes); require((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)); observedPhase = "ancestor-canonical"; const auto opened = canonical(directory.value); namespaceObservations["ancestor_opened"] = utf8(opened); require(_wcsicmp(opened.c_str(), prefix.c_str()) == 0);
    if (end == path.size()) { observedPhase = "ancestor-owner"; assertOwner(directory.value, userSid); }
    held.push_back(std::move(directory)); if (end == path.size()) break;
    const auto start = end == 3 ? end : end + 1; require(start < path.size()); end = path.find(L'\\', start); if (end == std::wstring::npos) end = path.size(); const auto component = path.substr(start, end - start); require(!component.empty() && component != L"." && component != L".." && component.back() != L'.' && component.back() != L' ' && component.find(L':') == std::wstring::npos);
  }
  return held;
}
struct PrivateDirectory { std::wstring requested, root; std::vector<Handle> ancestors, redirectedAncestors; Handle directory; };
PrivateDirectory privateDirectory(const Context& context, const std::wstring& mode) {
  require(mode == L"direct" || mode == L"system" || mode == L"breakaway");
  observedPhase = "known-folder-default"; const auto base = localData(KF_FLAG_DEFAULT); namespaceObservations["known_folder_default"] = utf8(base); observedPhase = "known-folder-redirected"; const auto redirected = localData(KF_FLAG_RETURN_FILTER_REDIRECTION_TARGET); namespaceObservations["known_folder_redirected"] = utf8(redirected);
  PrivateDirectory result; result.ancestors = directoryAncestors(base, context.userSid); if (_wcsicmp(base.c_str(), redirected.c_str()) != 0) result.redirectedAncestors = directoryAncestors(redirected, context.userSid);
  const auto leaf = std::wstring(L"MusicMuteMsixQA-") + MM_QA_ID + L"-" + mode; result.requested = base + L"\\" + leaf;
  observedPhase = "qa-directory-create"; namespaceObservations["qa_directory_requested"] = utf8(result.requested);
  const auto sddl = L"O:" + context.userSid + L"D:P(A;OICI;FA;;;" + context.userSid + L")(A;OICI;FA;;;SY)"; PSECURITY_DESCRIPTOR descriptor = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE}; const auto created = CreateDirectoryW(result.requested.c_str(), &security); LocalFree(descriptor); require(created);
  namespaceObservations["qa_directory_created"] = true; observedPhase = "qa-directory-open"; result.directory = Handle(CreateFileW(result.requested.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(result.directory.value != INVALID_HANDLE_VALUE); BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(result.directory.value, &info) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)); observedPhase = "qa-directory-owner"; assertOwner(result.directory.value, context.userSid); observedPhase = "qa-directory-canonical"; result.root = canonical(result.directory.value); namespaceObservations["qa_directory_opened"] = utf8(result.root); require(_wcsicmp(result.root.c_str(), (base + L"\\" + leaf).c_str()) == 0 || _wcsicmp(result.root.c_str(), (redirected + L"\\" + leaf).c_str()) == 0); return result;
}
struct Registration { std::wstring name, key, manifest; Handle held, host; };
Registration prepareManifest(Context& context, const PrivateDirectory& directory, const std::wstring& mode, bool alias) {
  observedPhase = "manifest-prepare";
  require(mode == L"direct" || mode == L"system" || mode == L"breakaway");
  const auto name = std::wstring(alias ? MM_QA_HOST_ALIAS : MM_QA_HOST_FIXED) + L"." + mode;
  const auto path = directory.root + L"\\" + mode + (alias ? L"-alias.json" : L"-fixed.json");
  // Both targets are static: no executable path or command can arrive over IPC.
  const auto target = alias ? localData() + L"\\Microsoft\\WindowsApps\\" + MM_QA_ALIAS : context.root + L"\\MusicMuteMsixChromeHost.exe";
  auto heldHost = regular(context.root + L"\\MusicMuteMsixChromeHost.exe", false);
  const auto text = mm::dump(mm::Json::Object{{"name", utf8(name)}, {"description", "MusicMute S03 isolated QA"}, {"path", utf8(target)}, {"type", "stdio"}, {"allowed_origins", mm::Json::Array{mm::Json(utf8(MM_QA_ORIGIN))}}});
  const auto sddl = L"O:" + context.userSid + L"D:P(A;;FA;;;" + context.userSid + L")(A;;FA;;;SY)"; PSECURITY_DESCRIPTOR descriptor = nullptr; observedPhase = "manifest-security-descriptor"; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE}; observedPhase = "manifest-create"; Handle writer(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ, &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); LocalFree(descriptor); require(writer.value != INVALID_HANDLE_VALUE); observedPhase = "manifest-file-proof"; BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(writer.value, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) && info.nNumberOfLinks == 1 && _wcsicmp(canonical(writer.value).c_str(), path.c_str()) == 0); assertOwner(writer.value, context.userSid); DWORD n = 0; require(WriteFile(writer.value, text.data(), static_cast<DWORD>(text.size()), &n, nullptr) && n == text.size() && FlushFileBuffers(writer.value));
  return Registration{name, L"Software\\Google\\Chrome\\NativeMessagingHosts\\" + name, path, std::move(writer), std::move(heldHost)};
}
mm::Json registryState(const Registration& registration, REGSAM view) {
  Key key; const auto opened = RegOpenKeyExW(HKEY_CURRENT_USER, registration.key.c_str(), 0, KEY_QUERY_VALUE | view, &key.value); if (opened == ERROR_FILE_NOT_FOUND) return mm::Json::Object{{"state", "absent"}}; require(opened == ERROR_SUCCESS);
  DWORD type = 0, n = 0, values = 0, children = 0; require(RegQueryInfoKeyW(key.value, nullptr, nullptr, nullptr, &children, nullptr, nullptr, &values, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS); require(RegQueryValueExW(key.value, nullptr, nullptr, &type, nullptr, &n) == ERROR_SUCCESS && type == REG_SZ && n >= 2 && n <= 65536 && n % 2 == 0); std::wstring text(n / 2, L'\0'); require(RegQueryValueExW(key.value, nullptr, nullptr, &type, reinterpret_cast<BYTE*>(text.data()), &n) == ERROR_SUCCESS && text.back() == L'\0'); text.pop_back(); require(text.find(L'\0') == std::wstring::npos);
  return mm::Json::Object{{"state", text == registration.manifest && children == 0 && values == 1 ? "owned" : "conflict"}, {"manifest", utf8(text)}};
}
void directRegister(const Registration& r, REGSAM view) {
  const auto state = registryState(r, view).at("state").string();
  if (state == "owned") return; // HKCU Software keys can share both registry views.
  require(state == "absent"); Key key; DWORD disposition = 0; require(RegCreateKeyExW(HKEY_CURRENT_USER, r.key.c_str(), 0, nullptr, 0, KEY_SET_VALUE | view, nullptr, &key.value, &disposition) == ERROR_SUCCESS && disposition == REG_CREATED_NEW_KEY); require(RegSetValueExW(key.value, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(r.manifest.c_str()), static_cast<DWORD>((r.manifest.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS);
}
BY_HANDLE_FILE_INFORMATION fileBirth(HANDLE file) { BY_HANDLE_FILE_INFORMATION info{}; require(GetFileInformationByHandle(file, &info)); return info; }
bool sameBirth(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwFileAttributes == b.dwFileAttributes && a.nNumberOfLinks == b.nNumberOfLinks && a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow && CompareFileTime(&a.ftCreationTime, &b.ftCreationTime) == 0 && CompareFileTime(&a.ftLastWriteTime, &b.ftLastWriteTime) == 0 && a.nFileSizeHigh == b.nFileSizeHigh && a.nFileSizeLow == b.nFileSizeLow;
}
std::wstring sidText(PSID value) { PWSTR raw = nullptr; require(value && IsValidSid(value) && ConvertSidToStringSidW(value, &raw)); std::wstring out(raw); LocalFree(raw); return out; }
bool privilegedOsSid(PSID value) {
  if (IsWellKnownSid(value, WinLocalSystemSid) || IsWellKnownSid(value, WinBuiltinAdministratorsSid)) return true;
  const auto text = sidText(value);
  if (text == L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464") return true; // TrustedInstaller
  BYTE crypto[SECURITY_MAX_SID_SIZE]{}; DWORD bytes = static_cast<DWORD>(sizeof(crypto)), domainBytes = 256; wchar_t domain[256]{}; SID_NAME_USE use{};
  require(LookupAccountNameW(nullptr, L"NT SERVICE\\CryptSvc", crypto, &bytes, domain, &domainBytes, &use));
  return EqualSid(value, crypto) != FALSE;
}
void protectedOsAcl(HANDLE file, bool directory) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS);
  struct Descriptor { PSECURITY_DESCRIPTOR p; ~Descriptor() { if (p) LocalFree(p); } } cleanup{descriptor};
  require(owner && acl && IsValidAcl(acl) && privilegedOsSid(owner));
  const DWORD mutation = DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL | GENERIC_WRITE | FILE_WRITE_ATTRIBUTES | (directory ? FILE_DELETE_CHILD : FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA);
  ACL_SIZE_INFORMATION size{}; require(GetAclInformation(acl, &size, sizeof(size), AclSizeInformation) && size.AceCount <= 256);
  for (DWORD i = 0; i < size.AceCount; ++i) { void* raw = nullptr; require(GetAce(acl, i, &raw)); const auto head = static_cast<ACE_HEADER*>(raw); if (head->AceFlags & INHERIT_ONLY_ACE) continue; if (head->AceType == ACCESS_DENIED_ACE_TYPE) continue; require(head->AceType == ACCESS_ALLOWED_ACE_TYPE); const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw); if (ace->Mask & mutation) require(privilegedOsSid(&ace->SidStart)); }
}
std::vector<Handle> osAncestors(const std::wstring& file) {
  require(file.size() >= 4 && file[1] == L':' && file[2] == L'\\' && file.find(L'/') == std::wstring::npos && GetDriveTypeW(file.substr(0, 3).c_str()) == DRIVE_FIXED);
  std::vector<Handle> held; std::size_t end = 3;
  for (;;) { const auto prefix = file.substr(0, end); observedPhase = "system-os-ancestor"; Handle directory(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(directory.value != INVALID_HANDLE_VALUE); const auto info = fileBirth(directory.value); require((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && _wcsicmp(canonical(directory.value).c_str(), prefix.c_str()) == 0); protectedOsAcl(directory.value, true); held.push_back(std::move(directory)); const auto next = file.find(L'\\', end == 3 ? end : end + 1); if (next == std::wstring::npos) break; end = next; }
  return held;
}
std::wstring certificateName(PCCERT_CONTEXT certificate, const char* oid) { wchar_t text[256]{}; const auto n = CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0, const_cast<char*>(oid), text, 256); require(n > 1 && n <= 256); return text; }
mm::Json trustedWindowsSigner(WINTRUST_DATA& trust) {
  const auto provider = WTHelperProvDataFromStateData(trust.hWVTStateData); require(provider && provider->csSigners == 1);
  const auto signer = WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0); require(signer && signer->pChainContext && signer->csCertChain >= 2 && signer->csCertChain <= 8 && signer->pChainContext->TrustStatus.dwErrorStatus == CERT_TRUST_NO_ERROR);
  const auto leaf = WTHelperGetProvCertFromChain(signer, 0); require(leaf && leaf->pCert && certificateName(leaf->pCert, szOID_COMMON_NAME) == L"Microsoft Windows" && certificateName(leaf->pCert, szOID_ORGANIZATION_NAME) == L"Microsoft Corporation");
  DWORD bytes = 0; require(CertGetEnhancedKeyUsage(leaf->pCert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, nullptr, &bytes) && bytes > 0 && bytes < 65536); std::vector<BYTE> buffer(bytes); auto usage = reinterpret_cast<PCERT_ENHKEY_USAGE>(buffer.data()); require(CertGetEnhancedKeyUsage(leaf->pCert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, usage, &bytes) && usage->cUsageIdentifier <= 32);
  bool code = false, component = false; for (DWORD i = 0; i < usage->cUsageIdentifier; ++i) { require(usage->rgpszUsageIdentifier[i]); code = code || std::strcmp(usage->rgpszUsageIdentifier[i], szOID_PKIX_KP_CODE_SIGNING) == 0; component = component || std::strcmp(usage->rgpszUsageIdentifier[i], "1.3.6.1.4.1.311.10.3.6") == 0; } require(code && component);
  mm::Json::Array chain; for (DWORD i = 0; i < signer->csCertChain; ++i) { const auto cert = WTHelperGetProvCertFromChain(signer, i); require(cert && cert->pCert); const auto name = certificateName(cert->pCert, szOID_COMMON_NAME); require(certificateName(cert->pCert, szOID_ORGANIZATION_NAME) == L"Microsoft Corporation"); chain.push_back(mm::Json(utf8(name))); }
  return mm::Json::Object{{"trusted_windows_signer", true}, {"code_signing_eku", true}, {"windows_component_eku", true}, {"chain", chain}};
}
struct RegAuthority {
  std::vector<Handle> ancestors, catalogAncestors; Handle catalog; std::string imageHash, catalogHash; BY_HANDLE_FILE_INFORMATION imageBirth{}, catalogBirth{}; mm::Json observation;
  void unchanged(HANDLE image) { observedPhase = "system-reg-stability"; protectedOsAcl(image, false); if (catalog.value != INVALID_HANDLE_VALUE) protectedOsAcl(catalog.value, false); require(sameBirth(imageBirth, fileBirth(image)) && hash(image) == imageHash && sameBirth(imageBirth, fileBirth(image))); if (catalog.value != INVALID_HANDLE_VALUE) require(sameBirth(catalogBirth, fileBirth(catalog.value)) && hash(catalog.value) == catalogHash && sameBirth(catalogBirth, fileBirth(catalog.value))); }
};
RegAuthority verifyMicrosoftReg(const std::wstring& path, HANDLE file) {
  require(_wcsicmp(path.c_str(), (systemDirectory() + L"\\reg.exe").c_str()) == 0); RegAuthority result; result.ancestors = osAncestors(path); observedPhase = "system-reg-os-acl"; protectedOsAcl(file, false); result.imageBirth = fileBirth(file); result.imageHash = hash(file); require(result.imageHash == "ef37663b44ac66920c6f33694deea01acb78ae3f3012884819373fa04c3eb5f0");
  WINTRUST_FILE_INFO info{sizeof(info), path.c_str(), file, nullptr}; WINTRUST_DATA data{}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE; data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; data.dwUnionChoice = WTD_CHOICE_FILE; data.pFile = &info; data.dwStateAction = WTD_STATEACTION_VERIFY; data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_DISABLE_MD2_MD4 | WTD_CACHE_ONLY_URL_RETRIEVAL; GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  struct State { GUID& action; WINTRUST_DATA& data; ~State() { if (data.hWVTStateData) { data.dwStateAction = WTD_STATEACTION_CLOSE; (void)WinVerifyTrust(nullptr, &action, &data); data.hWVTStateData = nullptr; } } } state{action, data}; observedPhase = "system-reg-embedded-trust"; require(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); const auto embedded = WinVerifyTrust(nullptr, &action, &data);
  if (embedded == ERROR_SUCCESS) { result.observation = mm::Json::Object{{"signature_type", "embedded"}, {"signer", trustedWindowsSigner(data)}}; result.unchanged(file); return result; }
  require(embedded == TRUST_E_NOSIGNATURE); data.dwStateAction = WTD_STATEACTION_CLOSE; (void)WinVerifyTrust(nullptr, &action, &data); data.hWVTStateData = nullptr;
  observedPhase = "system-reg-catalog-context"; const auto module = GetModuleHandleW(L"wintrust.dll"); require(module); wchar_t moduleFile[32768]{}; require(GetModuleFileNameW(module, moduleFile, 32768) > 0 && _wcsicmp(moduleFile, (systemDirectory() + L"\\wintrust.dll").c_str()) == 0);
  using Acquire = decltype(&CryptCATAdminAcquireContext2); using Calculate = decltype(&CryptCATAdminCalcHashFromFileHandle2); Acquire acquire = nullptr; Calculate calculate = nullptr; const auto acquireAddress = GetProcAddress(module, "CryptCATAdminAcquireContext2"), calculateAddress = GetProcAddress(module, "CryptCATAdminCalcHashFromFileHandle2"); require(acquireAddress && calculateAddress); static_assert(sizeof(acquire) == sizeof(acquireAddress)); std::memcpy(&acquire, &acquireAddress, sizeof(acquire)); std::memcpy(&calculate, &calculateAddress, sizeof(calculate)); CERT_STRONG_SIGN_PARA strong{}; strong.cbSize = sizeof(strong); strong.dwInfoChoice = CERT_STRONG_SIGN_OID_INFO_CHOICE; strong.pszOID = const_cast<LPSTR>(szOID_CERT_STRONG_SIGN_OS_CURRENT); HCATADMIN admin = nullptr; require(acquire(&admin, nullptr, L"SHA256", &strong, 0)); struct Admin { HCATADMIN h; ~Admin() { if (h) CryptCATAdminReleaseContext(h, 0); } } adminLifetime{admin}; DWORD hashBytes = 0; require(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); require(calculate(admin, file, &hashBytes, nullptr, 0) && hashBytes == 32); std::vector<BYTE> memberHash(hashBytes); require(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); require(calculate(admin, file, &hashBytes, memberHash.data(), 0) && hashBytes == 32); std::wstring tag; constexpr wchar_t hex[] = L"0123456789ABCDEF"; for (const auto b : memberHash) { tag += hex[b >> 4]; tag += hex[b & 15]; }
  observedPhase = "system-reg-catalog-lookup"; const auto catalog = CryptCATAdminEnumCatalogFromHash(admin, memberHash.data(), hashBytes, 0, nullptr); require(catalog); struct Catalog { HCATADMIN a; HCATINFO h; ~Catalog() { if (h) CryptCATAdminReleaseCatalogContext(a, h, 0); } } catalogLifetime{admin, catalog}; CATALOG_INFO catalogInfo{}; catalogInfo.cbStruct = sizeof(catalogInfo); require(CryptCATCatalogInfoFromContext(catalog, &catalogInfo, 0)); const std::wstring catalogPath(catalogInfo.wszCatalogFile); const auto catalogRoot = systemDirectory() + L"\\CatRoot\\"; require(catalogPath.size() < 32768 && catalogPath.size() > catalogRoot.size() && _wcsnicmp(catalogPath.c_str(), catalogRoot.c_str(), catalogRoot.size()) == 0 && catalogPath.ends_with(L".cat")); result.catalogAncestors = osAncestors(catalogPath); result.catalog = regular(catalogPath, false); observedPhase = "system-reg-catalog-os-acl"; protectedOsAcl(result.catalog.value, false); result.catalogBirth = fileBirth(result.catalog.value); result.catalogHash = hash(result.catalog.value);
  WINTRUST_CATALOG_INFO member{}; member.cbStruct = sizeof(member); member.pcwszCatalogFilePath = catalogPath.c_str(); member.pcwszMemberTag = tag.c_str(); member.pcwszMemberFilePath = path.c_str(); member.hMemberFile = file; member.pbCalculatedFileHash = memberHash.data(); member.cbCalculatedFileHash = hashBytes; member.hCatAdmin = admin; State catalogState{action, data}; data.dwUnionChoice = WTD_CHOICE_CATALOG; data.pCatalog = &member; data.dwStateAction = WTD_STATEACTION_VERIFY; observedPhase = "system-reg-catalog-member-trust"; require(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); const auto status = WinVerifyTrust(nullptr, &action, &data); require(status == ERROR_SUCCESS); const auto signer = trustedWindowsSigner(data); result.observation = mm::Json::Object{{"signature_type", "catalog"}, {"catalog", utf8(catalogPath)}, {"catalog_sha256", result.catalogHash}, {"sha256_member_tag", utf8(tag)}, {"member_trust_result", 0}, {"signer", signer}}; result.unchanged(file); return result;
}
mm::Json systemRegister(const Registration& r, REGSAM view, bool breakaway) {
  observedPhase = "registry-preflight";
  const auto state = registryState(r, view).at("state").string();
  if (state == "owned") return mm::Json::Object{{"tool_skipped", true}, {"same_owned_value_visible_in_second_view", true}};
  require(state == "absent"); observedPhase = "system-reg-trust"; const auto executable = systemDirectory() + L"\\reg.exe"; auto pinned = regular(executable, false); auto authority = verifyMicrosoftReg(executable, pinned.value);
  const auto viewArg = view == KEY_WOW64_32KEY ? L" /reg:32" : L" /reg:64"; auto command = quote(executable) + L" ADD " + quote(L"HKCU\\" + r.key) + L" /ve /t REG_SZ /d " + quote(r.manifest) + viewArg;
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE}; HANDLE readRaw = INVALID_HANDLE_VALUE, writeRaw = INVALID_HANDLE_VALUE; require(CreatePipe(&readRaw, &writeRaw, &security, 0)); Handle reader(readRaw), writer(writeRaw); require(SetHandleInformation(reader.value, HANDLE_FLAG_INHERIT, 0)); Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr)); require(input.value != INVALID_HANDLE_VALUE);
  SIZE_T needed = 0; const DWORD attributeCount = breakaway ? 2U : 1U; InitializeProcThreadAttributeList(nullptr, attributeCount, 0, &needed); std::vector<BYTE> attributes(needed); auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data()); require(InitializeProcThreadAttributeList(list, attributeCount, 0, &needed)); struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST p; ~Attributes() { DeleteProcThreadAttributeList(p); } } cleanup{list}; HANDLE inherited[]{writer.value, input.value}; require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr)); DWORD policy = PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE; if (breakaway) require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, &policy, sizeof(policy), nullptr, nullptr));
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = input.value; startup.StartupInfo.hStdOutput = writer.value; startup.StartupInfo.hStdError = writer.value; startup.lpAttributeList = list; PROCESS_INFORMATION child{};
  std::wstring environment = L"SystemRoot=" + systemDirectory().substr(0, systemDirectory().find_last_of(L'\\')); environment.push_back(L'\0'); environment += L"TEMP=" + r.manifest.substr(0, r.manifest.find_last_of(L'\\')); environment.push_back(L'\0'); environment.push_back(L'\0');
  Handle job(CreateJobObjectW(nullptr, nullptr)); require(job.value != INVALID_HANDLE_VALUE && job.value != nullptr); JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{}; limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limit, sizeof(limit)));
  observedPhase = "system-reg-create-suspended"; authority.unchanged(pinned.value); require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environment.data(), systemDirectory().c_str(), &startup.StartupInfo, &child)); Handle process(child.hProcess), thread(child.hThread); if (!AssignProcessToJobObject(job.value, process.value)) { TerminateProcess(process.value, 2); WaitForSingleObject(process.value, 5000); throw std::runtime_error("MSIX_QA_INVALID"); }
  BOOL member = FALSE; DWORD ownSession = 0, childSession = 0; std::wstring childImage(32768, L'\0'); DWORD imageLength = static_cast<DWORD>(childImage.size()); require(IsProcessInJob(process.value, job.value, &member) && member && ProcessIdToSessionId(GetCurrentProcessId(), &ownSession) && ProcessIdToSessionId(child.dwProcessId, &childSession) && ownSession == childSession && sid(process.value) == sid() && !elevated(process.value) && QueryFullProcessImageNameW(process.value, 0, childImage.data(), &imageLength)); childImage.resize(imageLength); require(_wcsicmp(childImage.c_str(), executable.c_str()) == 0);
  observedPhase = "system-reg-child-attest"; const auto childPackage = processPackage(process.value); authority.unchanged(pinned.value); observedPhase = "system-reg-resume"; require(ResumeThread(thread.value) != static_cast<DWORD>(-1)); writer = Handle{}; input = Handle{};
  const auto started = GetTickCount64(); std::size_t outputBytes = 0; bool exited = false; DWORD code = 2;
  while (GetTickCount64() - started < 10000) { DWORD available = 0; if (PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr) && available) { BYTE buffer[4096]; DWORD received = 0; require(ReadFile(reader.value, buffer, std::min<DWORD>(available, sizeof(buffer)), &received, nullptr)); outputBytes += received; if (outputBytes > 16384) break; } if (WaitForSingleObject(process.value, 20) == WAIT_OBJECT_0) { exited = true; require(GetExitCodeProcess(process.value, &code)); break; } }
  if (!exited || outputBytes > 16384) { require(TerminateJobObject(job.value, 2)); require(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0); }
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{}; const auto cleanupStarted = GetTickCount64(); do { require(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)); if (!accounting.ActiveProcesses) break; Sleep(10); } while (GetTickCount64() - cleanupStarted < 5000); require(accounting.ActiveProcesses == 0);
  // A fast root exit is not evidence that its pipe stayed under the cap. Once
  // the entire Job is empty, inspect all remaining buffered output as well.
  while (outputBytes <= 16384) { DWORD available = 0; if (!PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr)) { require(GetLastError() == ERROR_BROKEN_PIPE); break; } if (!available) break; if (available > 16384 - outputBytes) { outputBytes = 16385; break; } BYTE buffer[4096]; DWORD received = 0; require(ReadFile(reader.value, buffer, std::min<DWORD>(available, sizeof(buffer)), &received, nullptr) && received > 0); outputBytes += received; }
  authority.unchanged(pinned.value); return mm::Json::Object{{"tool_trust", authority.observation}, {"tool", "signed-System32-reg.exe"}, {"tool_sha256", hash(pinned.value)}, {"desktop_breakaway_requested", breakaway}, {"child_package", childPackage}, {"exit_code", static_cast<std::int64_t>(code)}, {"output_bytes", static_cast<std::int64_t>(outputBytes)}, {"completed", exited && outputBytes <= 16384}, {"owned_job_active_processes", 0}};
}
mm::Json registerManifests(Context& context, const std::wstring& mode) {
  auto directory = privateDirectory(context, mode); mm::Json::Array results;
  for (const auto alias : {false, true}) {
    auto r = prepareManifest(context, directory, mode, alias); mm::Json::Array tools;
    for (const auto view : {KEY_WOW64_32KEY, KEY_WOW64_64KEY}) { if (mode == L"direct") directRegister(r, view); else tools.push_back(systemRegister(r, view, mode == L"breakaway")); }
    results.push_back(mm::Json::Object{{"host_name", utf8(r.name)}, {"registry_key", utf8(L"HKCU\\" + r.key)}, {"target_kind", alias ? "alias" : "fixed-package-path"}, {"manifest", utf8(canonical(r.held.value))}, {"manifest_sha256", hash(r.held.value)}, {"host_image_sha256", hash(r.host.value)}, {"package_view32", registryState(r, KEY_WOW64_32KEY)}, {"package_view64", registryState(r, KEY_WOW64_64KEY)}, {"tools", tools}});
  }
  return mm::Json::Object{{"mode", utf8(mode)}, {"package", context.observation()}, {"qa_directory_requested", utf8(directory.requested)}, {"qa_directory_observed", utf8(directory.root)}, {"registrations", results}, {"ordinary_chrome_visibility_proven", false}};
}
mm::Json namespaceObservation(Context& context) {
  observedPhase = "known-folder-default"; const auto base = localData(KF_FLAG_DEFAULT); namespaceObservations["known_folder_default"] = utf8(base); observedPhase = "known-folder-redirected"; const auto redirected = localData(KF_FLAG_RETURN_FILTER_REDIRECTION_TARGET); namespaceObservations["known_folder_redirected"] = utf8(redirected); auto ancestors = directoryAncestors(base, context.userSid); auto redirectedAncestors = directoryAncestors(redirected, context.userSid); return mm::Json::Object{{"qa_only", true}, {"read_only", true}, {"package", context.observation()}, {"namespace", namespaceObservations}};
}
mm::Json systemRegTrustObservation(Context& context) {
  const auto path = systemDirectory() + L"\\reg.exe"; auto image = regular(path, false); auto authority = verifyMicrosoftReg(path, image.value); authority.unchanged(image.value); return mm::Json::Object{{"qa_only", true}, {"read_only", true}, {"package", context.observation()}, {"system_reg_sha256", hash(image.value)}, {"trust", authority.observation}};
}
mm::Json registerPackageManifest(Context& context) {
  observedPhase = "immutable-manifest-proof"; const auto name = std::wstring(MM_QA_HOST_FIXED) + L".immutable", path = context.root + L"\\NativeMessagingHost.json"; auto manifest = regular(path, false); require(hash(manifest.value) == MM_QA_IMMUTABLE_MANIFEST_SHA256); auto host = regular(context.root + L"\\MusicMuteMsixChromeHost.exe", false); Registration registration{name, L"Software\\Google\\Chrome\\NativeMessagingHosts\\" + name, path, std::move(manifest), std::move(host)}; mm::Json::Array tools; for (const auto view : {KEY_WOW64_32KEY, KEY_WOW64_64KEY}) tools.push_back(systemRegister(registration, view, true)); return mm::Json::Object{{"qa_only", true}, {"package", context.observation()}, {"host_name", utf8(name)}, {"manifest", utf8(canonical(registration.held.value))}, {"manifest_sha256", hash(registration.held.value)}, {"host_image_sha256", hash(registration.host.value)}, {"package_view32", registryState(registration, KEY_WOW64_32KEY)}, {"package_view64", registryState(registration, KEY_WOW64_64KEY)}, {"tools", tools}, {"ordinary_chrome_visibility_proven", false}};
}
std::string sharedMarker(const Context& context) { return "MusicMute S03 unvirtualized shared QA " + utf8(MM_QA_DATA_COHORT) + " owner " + utf8(context.userSid) + "\n"; }
void assertSharedAcl(HANDLE file, const std::wstring& userSid, bool directory) {
  observedPhase = "shared-private-acl";
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS);
  struct Descriptor { PSECURITY_DESCRIPTOR value; ~Descriptor() { if (value) LocalFree(value); } } held{descriptor};
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  require(descriptor && owner && acl && GetSecurityDescriptorControl(descriptor, &control, &revision) && (control & SE_DACL_PROTECTED) && sidText(owner) == userSid && acl->AceCount == 2);
  bool user = false, system = false;
  for (DWORD index = 0; index < 2; ++index) {
    void* raw = nullptr; require(GetAce(acl, index, &raw)); const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    const auto flags = directory ? static_cast<BYTE>(OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : static_cast<BYTE>(0);
    require(ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == flags && ace->Mask == FILE_ALL_ACCESS && IsValidSid(const_cast<DWORD*>(&ace->SidStart)));
    if (sidText(const_cast<DWORD*>(&ace->SidStart)) == userSid) { require(!user); user = true; }
    else { require(!system && IsWellKnownSid(const_cast<DWORD*>(&ace->SidStart), WinLocalSystemSid)); system = true; }
  }
  require(user && system);
}
PrivateDirectory sharedDirectory(Context& context, bool create) {
  observedPhase = "shared-profile"; require(std::wstring(MM_QA_NAMESPACE_PROFILE) == L"unvirtualized-candidate-v1" && (std::wstring(MM_QA_DATA_ROLE) == L"gui" || std::wstring(MM_QA_DATA_ROLE) == L"worker"));
  observedPhase = "shared-known-folder"; const auto base = localData(KF_FLAG_NO_PACKAGE_REDIRECTION); namespaceObservations["shared_known_folder"] = utf8(base); auto lower = base; for (auto& ch : lower) if (ch >= L'A' && ch <= L'Z') ch = static_cast<wchar_t>(ch + (L'a' - L'A')); require(lower.find(L"\\packages\\") == std::wstring::npos && !lower.ends_with(L"\\packages"));
  PrivateDirectory result; result.ancestors = directoryAncestors(base, context.userSid); result.requested = base + L"\\MusicMuteMsixQA-" + MM_QA_DATA_COHORT + L"-shared";
  if (create) { observedPhase = "shared-exclusive-create"; require(std::wstring(MM_QA_DATA_ROLE) == L"gui"); const auto sddl = L"O:" + context.userSid + L"D:P(A;OICI;FA;;;" + context.userSid + L")(A;OICI;FA;;;SY)"; PSECURITY_DESCRIPTOR descriptor = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE}; const auto made = CreateDirectoryW(result.requested.c_str(), &security); LocalFree(descriptor); require(made); }
  observedPhase = "shared-directory-proof"; result.directory = Handle(CreateFileW(result.requested.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); require(result.directory.value != INVALID_HANDLE_VALUE); const auto info = fileBirth(result.directory.value); require((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)); assertOwner(result.directory.value, context.userSid); assertSharedAcl(result.directory.value, context.userSid, true); result.root = canonical(result.directory.value); namespaceObservations["shared_requested"] = utf8(result.requested); namespaceObservations["shared_opened"] = utf8(result.root); require(_wcsicmp(result.root.c_str(), result.requested.c_str()) == 0);
  return result;
}
Handle sharedWrite(Context& context, const PrivateDirectory& directory, const std::wstring& leaf, const std::string& bytes) {
  require((leaf == L"cohort.txt" || leaf == L"gui-v1.txt" || leaf == L"gui-v2.txt" || leaf == L"worker-v1.txt") && !bytes.empty() && bytes.size() <= 1024);
  observedPhase = "shared-file-exclusive-create"; const auto path = directory.root + L"\\" + leaf; const auto sddl = L"O:" + context.userSid + L"D:P(A;;FA;;;" + context.userSid + L")(A;;FA;;;SY)"; PSECURITY_DESCRIPTOR descriptor = nullptr; require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)); SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE}; Handle writer(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ, &security, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); LocalFree(descriptor); require(writer.value != INVALID_HANDLE_VALUE); const auto birth = fileBirth(writer.value); require(!(birth.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && birth.nNumberOfLinks == 1 && _wcsicmp(canonical(writer.value).c_str(), path.c_str()) == 0); assertOwner(writer.value, context.userSid); assertSharedAcl(writer.value, context.userSid, false); DWORD written = 0; require(WriteFile(writer.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size() && FlushFileBuffers(writer.value)); return writer;
}
Handle sharedRead(Context& context, const PrivateDirectory& directory, const std::wstring& leaf, const std::string& expected) {
  require(leaf == L"cohort.txt" || leaf == L"gui-v1.txt" || leaf == L"gui-v2.txt" || leaf == L"worker-v1.txt");
  observedPhase = "shared-file-existing-proof"; auto file = regular(directory.root + L"\\" + leaf, true); assertOwner(file.value, context.userSid); assertSharedAcl(file.value, context.userSid, false); const auto info = fileBirth(file.value); require(info.nFileSizeHigh == 0 && info.nFileSizeLow == expected.size() && expected.size() <= 1024); require(SetFilePointerEx(file.value, {}, nullptr, FILE_BEGIN)); std::string actual(expected.size(), '\0'); DWORD received = 0; require(ReadFile(file.value, actual.data(), static_cast<DWORD>(actual.size()), &received, nullptr) && received == actual.size() && actual == expected); return file;
}
std::string sharedData(const std::string& role) { require(role == "gui-v1" || role == "gui-v2" || role == "worker-v1"); return "MusicMute S03 " + utf8(MM_QA_DATA_COHORT) + " " + role + " fixed QA bytes\n"; }
mm::Json sharedObservation(Context& context, const PrivateDirectory& directory) {
  const auto rootBirth = fileBirth(directory.directory.value); auto cohort = sharedRead(context, directory, L"cohort.txt", sharedMarker(context)); auto gui = sharedRead(context, directory, L"gui-v1.txt", sharedData("gui-v1")); mm::Json::Array files;
  files.push_back(mm::Json::Object{{"leaf", "cohort.txt"}, {"final_path", utf8(canonical(cohort.value))}, {"sha256", hash(cohort.value)}, {"owner_sid_verified", true}, {"single_link_verified", true}, {"private_acl_verified", true}}); files.push_back(mm::Json::Object{{"leaf", "gui-v1.txt"}, {"final_path", utf8(canonical(gui.value))}, {"sha256", hash(gui.value)}, {"owner_sid_verified", true}, {"single_link_verified", true}, {"private_acl_verified", true}});
  for (const auto& role : {std::string("worker-v1"), std::string("gui-v2")}) { const auto leaf = role == "worker-v1" ? std::wstring(L"worker-v1.txt") : std::wstring(L"gui-v2.txt"); const auto attributes = GetFileAttributesW((directory.root + L"\\" + leaf).c_str()); if (attributes == INVALID_FILE_ATTRIBUTES) { require(GetLastError() == ERROR_FILE_NOT_FOUND); files.push_back(mm::Json::Object{{"leaf", role + ".txt"}, {"state", "absent"}}); } else { auto item = sharedRead(context, directory, leaf, sharedData(role)); files.push_back(mm::Json::Object{{"leaf", role + ".txt"}, {"final_path", utf8(canonical(item.value))}, {"sha256", hash(item.value)}, {"owner_sid_verified", true}, {"single_link_verified", true}, {"private_acl_verified", true}}); } }
  return mm::Json::Object{{"qa_only", true}, {"package", context.observation()}, {"shared_requested", utf8(directory.requested)}, {"shared_opened", utf8(directory.root)}, {"outside_packages_verified", true}, {"directory_private_acl_verified", true}, {"directory_volume_serial", static_cast<std::int64_t>(rootBirth.dwVolumeSerialNumber)}, {"directory_file_id", std::to_string((static_cast<ULONGLONG>(rootBirth.nFileIndexHigh) << 32) | rootBirth.nFileIndexLow)}, {"directory_creation_filetime", std::to_string((static_cast<ULONGLONG>(rootBirth.ftCreationTime.dwHighDateTime) << 32) | rootBirth.ftCreationTime.dwLowDateTime)}, {"directory_owner_sid", utf8(context.userSid)}, {"files", files}, {"production_data_parity_proven", false}, {"store_capability_approval_proven", false}};
}
mm::Json sharedOperation(Context& context, const std::wstring& mode) {
  require(mode == L"--shared-create" || mode == L"--shared-add-worker" || mode == L"--shared-add-gui-v2" || mode == L"--shared-observe"); auto directory = sharedDirectory(context, mode == L"--shared-create");
  if (mode == L"--shared-create") { auto cohort = sharedWrite(context, directory, L"cohort.txt", sharedMarker(context)); auto gui = sharedWrite(context, directory, L"gui-v1.txt", sharedData("gui-v1")); }
  else { auto cohort = sharedRead(context, directory, L"cohort.txt", sharedMarker(context)); auto gui = sharedRead(context, directory, L"gui-v1.txt", sharedData("gui-v1")); const auto guiHash = hash(gui.value); if (mode == L"--shared-add-worker") { require(std::wstring(MM_QA_DATA_ROLE) == L"worker"); auto file = sharedWrite(context, directory, L"worker-v1.txt", sharedData("worker-v1")); } else if (mode == L"--shared-add-gui-v2") { require(std::wstring(MM_QA_DATA_ROLE) == L"gui"); auto worker = sharedRead(context, directory, L"worker-v1.txt", sharedData("worker-v1")); auto file = sharedWrite(context, directory, L"gui-v2.txt", sharedData("gui-v2")); } require(hash(gui.value) == guiHash); }
  return sharedObservation(context, directory);
}
[[maybe_unused]] bool readFrame(void* target, DWORD bytes, bool header) { DWORD offset = 0; while (offset < bytes) { DWORD n = 0; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), static_cast<BYTE*>(target) + offset, bytes - offset, &n, nullptr)) { if (!offset && header && GetLastError() == ERROR_BROKEN_PIPE) return false; throw std::runtime_error("MSIX_QA_INVALID"); } if (!n) { if (!offset && header) return false; throw std::runtime_error("MSIX_QA_INVALID"); } offset += n; } return true; }
[[maybe_unused]] void writeFrame(const mm::Json& row) { const auto bytes = mm::dump(row); const auto header = msixqa::frameHeader(bytes.size()); DWORD n = 0; require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), header.data(), 4, &n, nullptr) && n == 4); require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes.data(), static_cast<DWORD>(bytes.size()), &n, nullptr) && n == bytes.size()); }
}

int wmain(int argc, wchar_t** argv) {
  try {
    Context context;
#ifdef MUSICMUTE_MSIX_QA_CHROME_HOST
    require(argc == 2 || argc == 3); require(std::wstring(argv[1]) == MM_QA_ORIGIN); if (argc == 3) { const std::wstring value(argv[2]), prefix = L"--parent-window="; require(value.starts_with(prefix) && value.size() > prefix.size() && value.size() <= prefix.size() + 20 && value.substr(prefix.size()).find_first_not_of(L"0123456789") == std::wstring::npos); }
    _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
    std::array<unsigned char, 4> header{}; std::size_t frames = 0;
    while (readFrame(header.data(), 4, true)) { require(++frames <= 32); std::string bytes(msixqa::frameSize(header), '\0'); require(readFrame(bytes.data(), static_cast<DWORD>(bytes.size()), false)); writeFrame(msixqa::reply(bytes, context.observation())); }
#else
    require(argc == 2); const std::wstring mode(argv[1]); mm::Json result;
    if (mode == L"--observe") result = context.observation();
    else if (mode == L"--namespace-observe") result = namespaceObservation(context);
    else if (mode == L"--system-reg-trust-observe") result = systemRegTrustObservation(context);
    else if (mode == L"--register-package-manifest") result = registerPackageManifest(context);
    else if (mode == L"--shared-create" || mode == L"--shared-add-worker" || mode == L"--shared-add-gui-v2" || mode == L"--shared-observe") result = sharedOperation(context, mode);
    else if (mode == L"--register-direct") result = registerManifests(context, L"direct");
    else if (mode == L"--register-system") result = registerManifests(context, L"system");
    else if (mode == L"--register-system-breakaway") result = registerManifests(context, L"breakaway");
    else throw std::runtime_error("MSIX_QA_INVALID");
    std::cout << mm::dump(result) << '\n';
#endif
    return 0;
  } catch (...) { const auto error = GetLastError(); std::cerr << "MSIX_QA_FAILED " << mm::dump(mm::Json::Object{{"qa_only", true}, {"phase", observedPhase}, {"last_win32_error_observed", static_cast<std::int64_t>(error)}, {"namespace", namespaceObservations}}) << '\n'; return 2; }
}
