#pragma once
#include "store_desktop_policy.hpp"

// Store authority is independent of the legacy per-user/Authenticode authority.
// Include this header at global scope. No injected OS verifier, loose-file
// allowance, caller-selected executable path or environment fallback exists.
#include "package_profile.hpp"
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <aclapi.h>
#include <appmodel.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <roapi.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <winrt/base.h>
#include <winrt/Windows.ApplicationModel.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Management.Deployment.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.System.h>
#endif

namespace mmstore {

enum class PackageKind { gui, worker };
enum class CodeRole {
  guiApplication, guiNative, guiSession, guiChromeHost, guiBrowserEntry,
  workerControls, workerSession, workerNative, workerNode, workerPython,
  workerLoginAgent, workerSessionAgent, workerPersonalAgent, workerFleetAgent,
  workerPrepareAgent, workerFfmpeg, workerFfprobe, workerDeno
};
enum class ErrorCode {
  invalidInput, unsupportedHost, standardLogonRequired, packageNotRegistered,
  packageQueryFailed, packageDenied, stalePackage, processDenied, pathDenied,
  fileDenied, digestMismatch
};
inline const char* errorName(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::invalidInput: return "STORE_INPUT_INVALID";
    case ErrorCode::unsupportedHost: return "STORE_HOST_UNSUPPORTED";
    case ErrorCode::standardLogonRequired: return "STORE_STANDARD_LOGON_REQUIRED";
    case ErrorCode::packageNotRegistered: return "STORE_PACKAGE_NOT_REGISTERED";
    case ErrorCode::packageQueryFailed: return "STORE_PACKAGE_QUERY_FAILED";
    case ErrorCode::packageDenied: return "STORE_PACKAGE_DENIED";
    case ErrorCode::stalePackage: return "STORE_PACKAGE_STALE";
    case ErrorCode::processDenied: return "STORE_PROCESS_DENIED";
    case ErrorCode::pathDenied: return "STORE_PATH_DENIED";
    case ErrorCode::fileDenied: return "STORE_FILE_DENIED";
    case ErrorCode::digestMismatch: return "STORE_DIGEST_MISMATCH";
  }
  return "STORE_INPUT_INVALID";
}
class Error final : public std::runtime_error {
 public:
  explicit Error(ErrorCode code, std::uint32_t nativeStatus = 0)
    : std::runtime_error(errorName(code)), code_(code), nativeStatus_(nativeStatus) {}
  ErrorCode code() const noexcept { return code_; }
  // Numeric diagnostic context only; no authority decision reads this field.
  std::uint32_t nativeStatus() const noexcept { return nativeStatus_; }
 private:
  ErrorCode code_;
  std::uint32_t nativeStatus_ = 0;
};
[[noreturn]] inline void fail(ErrorCode code) { throw Error(code); }
inline void require(bool value, ErrorCode code) { if (!value) fail(code); }

struct ExpectedPackage {
  PackageKind kind;
  std::wstring_view identityName, publisher, publisherId, familyName;
};
inline const ExpectedPackage& expectedPackage(PackageKind kind) {
  static constexpr ExpectedPackage gui{PackageKind::gui, mmstoreprofile::guiIdentity,
    mmstoreprofile::publisher, mmstoreprofile::publisherId, mmstoreprofile::guiFamily};
  static constexpr ExpectedPackage worker{PackageKind::worker, mmstoreprofile::workerIdentity,
    mmstoreprofile::publisher, mmstoreprofile::publisherId, mmstoreprofile::workerFamily};
  switch (kind) { case PackageKind::gui: return gui; case PackageKind::worker: return worker; }
  fail(ErrorCode::invalidInput);
}
struct CodeSpec { PackageKind kind; std::wstring_view relativePath; };
inline CodeSpec codeSpec(CodeRole role) {
  switch (role) {
    case CodeRole::guiApplication: return {PackageKind::gui, L"app/MusicMute Local.exe"};
    case CodeRole::guiNative: return {PackageKind::gui, L"app/resources/native/musicmute-native.exe"};
    case CodeRole::guiSession: return {PackageKind::gui, L"app/MusicMuteSession.exe"};
    case CodeRole::guiChromeHost: return {PackageKind::gui, L"app/MusicMuteChromeHost.exe"};
    case CodeRole::guiBrowserEntry: return {PackageKind::gui, L"app/resources/native/browser-host.cjs"};
    case CodeRole::workerControls: return {PackageKind::worker, L"worker/MusicMuteWorker.exe"};
    case CodeRole::workerSession: return {PackageKind::worker, L"worker/MusicMuteSession.exe"};
    case CodeRole::workerNative: return {PackageKind::worker, L"worker/runtime/native/musicmute-native.exe"};
    case CodeRole::workerNode: return {PackageKind::worker, L"worker/runtime/node/node.exe"};
    case CodeRole::workerPython: return {PackageKind::worker, L"worker/runtime/python/python.exe"};
    case CodeRole::workerLoginAgent: return {PackageKind::worker, L"worker/agent/login-worker.cjs"};
    case CodeRole::workerSessionAgent: return {PackageKind::worker, L"worker/agent/session-agent.cjs"};
    case CodeRole::workerPersonalAgent: return {PackageKind::worker, L"worker/agent/personal.cjs"};
    case CodeRole::workerFleetAgent: return {PackageKind::worker, L"worker/agent/fleet.cjs"};
    case CodeRole::workerPrepareAgent: return {PackageKind::worker, L"worker/agent/prepare.cjs"};
    case CodeRole::workerFfmpeg: return {PackageKind::worker, L"worker/runtime/bin/ffmpeg.exe"};
    case CodeRole::workerFfprobe: return {PackageKind::worker, L"worker/runtime/bin/ffprobe.exe"};
    case CodeRole::workerDeno: return {PackageKind::worker, L"worker/tools/youtube/bin/deno.exe"};
  }
  fail(ErrorCode::invalidInput);
}
using PackageVersion = std::array<std::uint16_t, 4>;
inline PackageVersion parseVersion(std::wstring_view text) {
  require(!text.empty() && text.size() <= 23, ErrorCode::invalidInput);
  PackageVersion result{};
  std::size_t at = 0;
  for (std::size_t n = 0; n < result.size(); ++n) {
    const auto start = at;
    std::uint32_t value = 0;
    while (at < text.size() && text[at] >= L'0' && text[at] <= L'9') {
      value = value * 10U + static_cast<std::uint32_t>(text[at++] - L'0');
      require(value <= 65535U && at - start <= 5, ErrorCode::invalidInput);
    }
    require(at > start && (at - start == 1 || text[start] != L'0'), ErrorCode::invalidInput);
    result[n] = static_cast<std::uint16_t>(value);
    if (n + 1 < result.size()) require(at < text.size() && text[at++] == L'.', ErrorCode::invalidInput);
  }
  require(at == text.size() && result != PackageVersion{}, ErrorCode::invalidInput);
  return result;
}
inline std::wstring versionText(const PackageVersion& version) {
  return std::to_wstring(version[0]) + L"." + std::to_wstring(version[1]) + L"." +
    std::to_wstring(version[2]) + L"." + std::to_wstring(version[3]);
}
inline bool validDigest(std::string_view digest) noexcept {
  return digest.size() == 64 && digest.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}
inline wchar_t asciiUpper(wchar_t value) noexcept {
  return value >= L'a' && value <= L'z' ? static_cast<wchar_t>(value - L'a' + L'A') : value;
}
inline bool reservedLeaf(std::wstring_view component) {
  const auto dot = component.find(L'.');
  std::wstring base(component.substr(0, dot));
  std::transform(base.begin(), base.end(), base.begin(), asciiUpper);
  return base == L"CON" || base == L"PRN" || base == L"AUX" || base == L"NUL" ||
    (base.size() == 4 && (base.starts_with(L"COM") || base.starts_with(L"LPT")) && base[3] >= L'1' && base[3] <= L'9');
}
inline bool validRelativePath(std::wstring_view path) {
  if (path.empty() || path.size() > 1024 || path.front() == L'/' || path.back() == L'/') return false;
  std::size_t start = 0;
  while (start < path.size()) {
    const auto slash = path.find(L'/', start);
    const auto part = path.substr(start, slash == std::wstring_view::npos ? path.size() - start : slash - start);
    if (part.empty() || part.size() > 255 || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ' || reservedLeaf(part)) return false;
    for (const auto c : part) if (c < 32 || c > 126 || std::wstring_view(L"\\:<>\"|?*").find(c) != std::wstring_view::npos) return false;
    if (slash == std::wstring_view::npos) break;
    start = slash + 1;
  }
  return true;
}
inline bool validInstalledLocation(std::wstring_view path) {
  if (path.size() < 4 || path.size() > 32700 || asciiUpper(path[0]) < L'A' || asciiUpper(path[0]) > L'Z' || path[1] != L':' || path[2] != L'\\' || path.back() == L'\\') return false;
  std::wstring relative(path.substr(3));
  std::replace(relative.begin(), relative.end(), L'\\', L'/');
  return validRelativePath(relative);
}
struct FilePin { std::string sha256; std::uint64_t bytes = 0; };
inline constexpr std::uint64_t maximumFileBytes = 512ULL * 1024 * 1024;
inline void validatePin(const FilePin& pin) {
  require(validDigest(pin.sha256) && pin.bytes > 0 && pin.bytes <= maximumFileBytes, ErrorCode::invalidInput);
}
// Empty source/metadata leaves are part of a complete protected package census.
// Fixed executable/script role pins continue to use validatePin above.
inline constexpr std::string_view emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
inline void validateInventoryPin(const FilePin& pin) {
  require(validDigest(pin.sha256) && pin.bytes <= maximumFileBytes &&
    (pin.bytes != 0 || pin.sha256 == emptySha256), ErrorCode::invalidInput);
}
struct Observation {
  std::wstring identityName, publisher, publisherId, familyName, fullName;
  std::wstring packageVersion, architecture, installedLocation;
  std::uint32_t signatureKind = 0;
  bool healthy = false, current = false;
};
inline void validateObservation(PackageKind kind, const Observation& value) {
  const auto& expected = expectedPackage(kind);
  require(value.identityName == expected.identityName && value.publisher == expected.publisher &&
    value.publisherId == expected.publisherId && value.familyName == expected.familyName &&
    value.architecture == L"x64" && value.signatureKind == mmstoreprofile::signatureKind && value.healthy && value.current &&
    validInstalledLocation(value.installedLocation), ErrorCode::packageDenied);
  PackageVersion version{};
  try { version = parseVersion(value.packageVersion); } catch (const Error&) { fail(ErrorCode::packageDenied); }
  require(value.fullName == std::wstring(expected.identityName) + L"_" + versionText(version) + L"_x64__" + std::wstring(expected.publisherId), ErrorCode::packageDenied);
}

#ifdef _WIN32
namespace detail {
class Handle {
 public:
  Handle() noexcept = default;
  explicit Handle(HANDLE value) noexcept : value_(value) {}
  ~Handle() { if (valid()) CloseHandle(value_); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { if (valid()) CloseHandle(value_); value_ = std::exchange(other.value_, nullptr); }
    return *this;
  }
  bool valid() const noexcept { return value_ && value_ != INVALID_HANDLE_VALUE; }
  HANDLE get() const noexcept { return value_; }
 private:
  HANDLE value_ = nullptr;
};
struct Local { void* value = nullptr; ~Local() { if (value) LocalFree(value); } };
struct Apartment {
  bool initialized = false;
  Apartment() {
    const auto result = RoInitialize(RO_INIT_MULTITHREADED);
    require(SUCCEEDED(result) || result == RPC_E_CHANGED_MODE, ErrorCode::packageQueryFailed);
    initialized = SUCCEEDED(result);
  }
  ~Apartment() { if (initialized) RoUninitialize(); }
};
inline std::wstring sidText(PSID sid) {
  require(sid && IsValidSid(sid), ErrorCode::standardLogonRequired);
  LPWSTR text = nullptr;
  require(ConvertSidToStringSidW(sid, &text) != FALSE, ErrorCode::standardLogonRequired);
  Local memory{text}; return std::wstring(text);
}
inline std::vector<BYTE> tokenBytes(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  (void)GetTokenInformation(token, kind, nullptr, 0, &bytes);
  require(GetLastError() == ERROR_INSUFFICIENT_BUFFER && bytes > 0 && bytes <= 65536, ErrorCode::standardLogonRequired);
  std::vector<BYTE> result(bytes);
  require(GetTokenInformation(token, kind, result.data(), bytes, &bytes) != FALSE, ErrorCode::standardLogonRequired);
  return result;
}
template<typename Value>
inline Value fixedTokenValue(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  Value value{}; DWORD bytes = 0;
  // Fixed token layouts are queried directly. In particular TokenElevation's
  // null-buffer probe must not be assumed to return ERROR_INSUFFICIENT_BUFFER.
  require(GetTokenInformation(token, kind, &value, sizeof(Value), &bytes) != FALSE && bytes == sizeof(Value), ErrorCode::standardLogonRequired);
  return value;
}
struct Logon { std::wstring sid, logonSid; DWORD session = 0; };
inline Logon logon(HANDLE process) {
  Handle token;
  HANDLE raw = nullptr;
  require(OpenProcessToken(process, TOKEN_QUERY, &raw) != FALSE, ErrorCode::standardLogonRequired);
  token = Handle(raw);
  const auto user = tokenBytes(token.get(), TokenUser);
  const auto groups = tokenBytes(token.get(), TokenGroups);
  const auto session = fixedTokenValue<DWORD>(token.get(), TokenSessionId);
  const auto elevation = fixedTokenValue<TOKEN_ELEVATION>(token.get(), TokenElevation);
  const auto integrity = tokenBytes(token.get(), TokenIntegrityLevel);
  const auto ui = fixedTokenValue<DWORD>(token.get(), TokenUIAccess);
  require(user.size() >= sizeof(TOKEN_USER) && integrity.size() >= sizeof(TOKEN_MANDATORY_LABEL), ErrorCode::standardLogonRequired);
  Logon result{sidText(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid), L"", session};
  require(result.session > 0 && result.sid != L"S-1-5-18" && result.sid != L"S-1-5-19" && result.sid != L"S-1-5-20" &&
    elevation.TokenIsElevated == 0 && ui == 0, ErrorCode::standardLogonRequired);
  const auto label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data())->Label.Sid;
  require(IsValidSid(label) && *GetSidSubAuthorityCount(label) > 0 &&
    *GetSidSubAuthority(label, *GetSidSubAuthorityCount(label) - 1U) == SECURITY_MANDATORY_MEDIUM_RID, ErrorCode::standardLogonRequired);
  const auto actual = reinterpret_cast<const TOKEN_GROUPS*>(groups.data());
  require(actual->GroupCount <= 1024 && groups.size() >= offsetof(TOKEN_GROUPS, Groups) + actual->GroupCount * sizeof(SID_AND_ATTRIBUTES), ErrorCode::standardLogonRequired);
  for (DWORD n = 0; n < actual->GroupCount; ++n) if ((actual->Groups[n].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
    require(result.logonSid.empty(), ErrorCode::standardLogonRequired);
    result.logonSid = sidText(actual->Groups[n].Sid);
  }
  require(result.logonSid.starts_with(L"S-1-5-5-"), ErrorCode::standardLogonRequired);
  return result;
}
inline void assertHost() {
  USHORT processMachine = 0, nativeMachine = 0;
  require(IsWow64Process2(GetCurrentProcess(), &processMachine, &nativeMachine) != FALSE && processMachine == IMAGE_FILE_MACHINE_UNKNOWN && nativeMachine == IMAGE_FILE_MACHINE_AMD64, ErrorCode::unsupportedHost);
  using VersionQuery = LONG(WINAPI*)(OSVERSIONINFOEXW*);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto query = module ? reinterpret_cast<VersionQuery>(GetProcAddress(module, "RtlGetVersion")) : nullptr;
  OSVERSIONINFOEXW version{}; version.dwOSVersionInfoSize = sizeof(version);
  require(query && query(&version) == 0 && version.dwMajorVersion == 10 && version.dwBuildNumber >= 19045 && version.wProductType == VER_NT_WORKSTATION, ErrorCode::unsupportedHost);
  (void)logon(GetCurrentProcess());
}
inline bool samePath(std::wstring_view first, std::wstring_view second) {
  return first.size() == second.size() && CompareStringOrdinal(first.data(), static_cast<int>(first.size()), second.data(), static_cast<int>(second.size()), TRUE) == CSTR_EQUAL;
}
inline std::wstring canonical(HANDLE file) {
  std::vector<wchar_t> path(32768);
  const auto bytes = GetFinalPathNameByHandleW(file, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  require(bytes > 0 && bytes < path.size(), ErrorCode::pathDenied);
  std::wstring result(path.data(), bytes);
  if (result.starts_with(L"\\\\?\\")) result.erase(0, 4);
  return result;
}
inline BY_HANDLE_FILE_INFORMATION information(HANDLE file, bool directory) {
  BY_HANDLE_FILE_INFORMATION result{};
  require(GetFileInformationByHandle(file, &result) != FALSE && (result.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
    ((result.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory && result.nNumberOfLinks > 0, ErrorCode::pathDenied);
  return result;
}
inline bool trustedWriter(std::wstring_view sid) {
  return sid == L"S-1-5-18" || sid == L"S-1-5-32-544" ||
    sid == L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
}
inline void assertImmutableAcl(HANDLE file, bool directory) {
  PSID owner = nullptr, group = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  // AccessCheck requires both owner and primary group in the descriptor.
  require(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, &group, &acl, nullptr, &descriptor) == ERROR_SUCCESS, ErrorCode::fileDenied);
  Local memory{descriptor};
  require(owner && group && IsValidSid(group) && trustedWriter(sidText(owner)) && acl && acl->AceCount <= 256, ErrorCode::fileDenied);
  const DWORD writes = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | (directory ? FILE_DELETE_CHILD : 0U);
  GENERIC_MAPPING mapping{FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
  for (DWORD n = 0; n < acl->AceCount; ++n) {
    void* raw = nullptr; require(GetAce(acl, n, &raw) != FALSE, ErrorCode::fileDenied);
    const auto head = static_cast<const ACE_HEADER*>(raw);
    if ((head->AceFlags & INHERIT_ONLY_ACE) != 0 || head->AceType == ACCESS_DENIED_ACE_TYPE || head->AceType == ACCESS_DENIED_OBJECT_ACE_TYPE || head->AceType == ACCESS_DENIED_CALLBACK_ACE_TYPE || head->AceType == ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE) continue;
    const bool ordinary = head->AceType == ACCESS_ALLOWED_ACE_TYPE;
    const bool conditionalOrObject = head->AceType == ACCESS_ALLOWED_OBJECT_ACE_TYPE || head->AceType == ACCESS_ALLOWED_CALLBACK_ACE_TYPE || head->AceType == ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE;
    require((ordinary || conditionalOrObject) && head->AceSize >= sizeof(ACE_HEADER) + sizeof(ACCESS_MASK), ErrorCode::fileDenied);
    const auto allowed = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
    DWORD mask = allowed->Mask; MapGenericMask(&mask, &mapping);
    if ((mask & writes) == 0) continue;
    // Conditional/object grants may authorize unknown users in a different
    // context. Read-only grants are harmless; a write grant is accepted only
    // for a directly inspectable fixed trusted OS/admin writer SID.
    require(ordinary && head->AceSize >= offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8, ErrorCode::fileDenied);
    const auto sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&allowed->SidStart));
    const auto remaining = head->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart);
    const auto count = reinterpret_cast<const BYTE*>(sid)[1];
    require(count <= SID_MAX_SUB_AUTHORITIES && GetSidLengthRequired(count) <= remaining && IsValidSid(sid), ErrorCode::fileDenied);
    require(trustedWriter(sidText(sid)), ErrorCode::fileDenied);
  }
  HANDLE raw = nullptr; require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &raw) != FALSE, ErrorCode::fileDenied);
  Handle token(raw); raw = nullptr;
  require(DuplicateTokenEx(token.get(), TOKEN_QUERY, nullptr, SecurityImpersonation, TokenImpersonation, &raw) != FALSE, ErrorCode::fileDenied);
  Handle impersonation(raw); PRIVILEGE_SET privileges{}; DWORD privilegeBytes = sizeof(privileges), granted = 0; BOOL access = FALSE;
  require(AccessCheck(descriptor, impersonation.get(), MAXIMUM_ALLOWED, &mapping, &privileges, &privilegeBytes, &granted, &access) != FALSE && access && (granted & writes) == 0, ErrorCode::fileDenied);
}
inline Handle openEntry(const std::wstring& path, bool directory, bool immutable) {
  Handle result(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL | (directory ? 0U : GENERIC_READ),
    directory && !immutable ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0U), nullptr));
  require(result.valid(), ErrorCode::fileDenied);
  (void)information(result.get(), directory);
  require(samePath(canonical(result.get()), path), ErrorCode::pathDenied);
  if (immutable) assertImmutableAcl(result.get(), directory);
  return result;
}
inline std::vector<Handle> rootHandles(const std::wstring& root) {
  require(validInstalledLocation(root), ErrorCode::pathDenied);
  // The OS registry supplies this exact current package location. WindowsApps
  // permits a standard user to traverse to their package but denies opening
  // the installation container itself, even for a zero-access metadata handle.
  // Anchor at the protected package boundary instead: this non-reparse,
  // normalized, immutable root stays held without delete sharing. Every code
  // descendant is held and checked separately; private/user paths do not use
  // this package-only authority.
  std::vector<Handle> result;
  result.push_back(openEntry(root, true, true));
  return result;
}
inline std::wstring joinedPath(std::wstring_view root, std::wstring_view relative) {
  require(validRelativePath(relative), ErrorCode::invalidInput);
  std::wstring result(root); result.push_back(L'\\');
  for (const auto c : relative) result.push_back(c == L'/' ? L'\\' : c);
  return result;
}
inline std::wstring registeredPath(std::wstring_view fullName) {
  UINT32 count = 0;
  require(GetPackagePathByFullName(std::wstring(fullName).c_str(), &count, nullptr) == ERROR_INSUFFICIENT_BUFFER && count > 1 && count <= 32768, ErrorCode::packageQueryFailed);
  std::vector<wchar_t> path(count);
  require(GetPackagePathByFullName(std::wstring(fullName).c_str(), &count, path.data()) == ERROR_SUCCESS, ErrorCode::packageQueryFailed);
  return std::wstring(path.data());
}
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
inline void assertDevelopmentSigner(const std::wstring& root);
#endif
inline Observation registeredObservation(PackageKind kind, std::wstring_view sid) {
  Apartment apartment;
  try {
    winrt::Windows::Management::Deployment::PackageManager manager;
    const auto& expected = expectedPackage(kind);
    const auto packages = manager.FindPackagesForUser(winrt::hstring(sid), winrt::hstring(expected.identityName), winrt::hstring(expected.publisher));
    std::size_t seen = 0, matched = 0; Observation result;
    for (const auto& package : packages) {
      require(++seen <= 64, ErrorCode::packageDenied);
      const auto id = package.Id();
      if (id.Name() != expected.identityName || id.Publisher() != expected.publisher || id.FamilyName() != expected.familyName) fail(ErrorCode::packageDenied);
      // Resource/framework/optional packages can coexist with the main package;
      // none of them is selected as an executable authority.
      if (package.IsFramework() || package.IsResourcePackage() || package.IsOptional() || package.IsBundle()) continue;
      // Transitional/multiple registration is denied rather than selecting a
      // staged or older generation by a caller-controlled version preference.
      require(++matched == 1, ErrorCode::stalePackage);
      require(!package.IsDevelopmentMode() && !package.IsStub() &&
        id.ResourceId().empty() && id.Architecture() == winrt::Windows::System::ProcessorArchitecture::X64 &&
        static_cast<std::uint32_t>(package.SignatureKind()) == mmstoreprofile::signatureKind && package.Status().VerifyIsOK(), ErrorCode::packageDenied);
      const auto version = id.Version();
      result = {std::wstring(id.Name()), std::wstring(id.Publisher()), std::wstring(id.PublisherId()), std::wstring(id.FamilyName()), std::wstring(id.FullName()),
        versionText({version.Major, version.Minor, version.Build, version.Revision}), L"x64", std::wstring(package.InstalledLocation().Path()),
        static_cast<std::uint32_t>(package.SignatureKind()), true, true};
      validateObservation(kind, result);
      require(samePath(result.installedLocation, registeredPath(result.fullName)), ErrorCode::packageDenied);
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
      assertDevelopmentSigner(result.installedLocation);
#endif
    }
    require(matched == 1, ErrorCode::packageNotRegistered);
    return result;
  } catch (const Error&) { throw; }
  catch (const winrt::hresult_error&) { fail(ErrorCode::packageQueryFailed); }
}
inline bool sameObservation(const Observation& first, const Observation& second) {
  return first.identityName == second.identityName && first.publisher == second.publisher && first.publisherId == second.publisherId &&
    first.familyName == second.familyName && first.fullName == second.fullName && first.packageVersion == second.packageVersion &&
    first.architecture == second.architecture && first.signatureKind == second.signatureKind && first.healthy == second.healthy && first.current == second.current &&
    samePath(first.installedLocation, second.installedLocation);
}
struct PackageState {
  PackageKind kind; Observation observation; Logon user; std::vector<Handle> roots;
  void revalidate() const {
    assertHost(); const auto currentUser = logon(GetCurrentProcess());
    require(currentUser.sid == user.sid && currentUser.logonSid == user.logonSid && currentUser.session == user.session, ErrorCode::standardLogonRequired);
    require(sameObservation(observation, registeredObservation(kind, user.sid)), ErrorCode::stalePackage);
    for (std::size_t n = 0; n < roots.size(); ++n) (void)information(roots[n].get(), true);
    require(!roots.empty() && samePath(canonical(roots.back().get()), observation.installedLocation), ErrorCode::pathDenied);
    assertImmutableAcl(roots.back().get(), true);
  }
};
inline std::uint64_t fileBytes(const BY_HANDLE_FILE_INFORMATION& value) { return (static_cast<std::uint64_t>(value.nFileSizeHigh) << 32U) | value.nFileSizeLow; }
inline bool sameFile(const BY_HANDLE_FILE_INFORMATION& a, const BY_HANDLE_FILE_INFORMATION& b) {
  return a.dwVolumeSerialNumber == b.dwVolumeSerialNumber && a.nFileIndexHigh == b.nFileIndexHigh && a.nFileIndexLow == b.nFileIndexLow &&
    a.nNumberOfLinks == b.nNumberOfLinks && a.dwFileAttributes == b.dwFileAttributes && fileBytes(a) == fileBytes(b) &&
    CompareFileTime(&a.ftCreationTime, &b.ftCreationTime) == 0 && CompareFileTime(&a.ftLastWriteTime, &b.ftLastWriteTime) == 0;
}
inline std::string hashFile(HANDLE file, std::uint64_t expectedBytes) {
  struct Hash {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    // CNG retains this storage until BCryptDestroyHash, including on failure.
    std::vector<BYTE> object;
    ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
  } state;
  require(expectedBytes <= maximumFileBytes && BCryptOpenAlgorithmProvider(&state.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, ErrorCode::fileDenied);
  DWORD objectBytes = 0, received = 0;
  require(BCryptGetProperty(state.algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes), &received, 0) == 0 && objectBytes > 0 && objectBytes <= 65536, ErrorCode::fileDenied);
  state.object.resize(objectBytes);
  require(BCryptCreateHash(state.algorithm, &state.hash, state.object.data(), objectBytes, nullptr, 0, 0) == 0 && SetFilePointerEx(file, {}, nullptr, FILE_BEGIN), ErrorCode::fileDenied);
  std::array<BYTE, 65536> buffer{}; std::uint64_t total = 0;
  for (;;) {
    DWORD receivedBytes = 0;
    require(ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &receivedBytes, nullptr) != FALSE, ErrorCode::fileDenied);
    if (!receivedBytes) break;
    total += receivedBytes;
    require(total <= expectedBytes && BCryptHashData(state.hash, buffer.data(), receivedBytes, 0) == 0, ErrorCode::fileDenied);
  }
  require(total == expectedBytes, ErrorCode::fileDenied);
  std::array<BYTE, 32> digest{};
  require(BCryptFinishHash(state.hash, digest.data(), static_cast<DWORD>(digest.size()), 0) == 0, ErrorCode::fileDenied);
  constexpr char alphabet[] = "0123456789abcdef"; std::string result;
  for (const auto value : digest) { result.push_back(alphabet[value >> 4U]); result.push_back(alphabet[value & 15U]); }
  return result;
}
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
inline void assertDevelopmentSigner(const std::wstring& root) {
  // Windows' registered Developer origin, health and immutable install tree
  // remain mandatory. This extra local-test boundary pins the actual signer,
  // rather than trusting another certificate with the same subject text.
  auto roots = rootHandles(root);
  auto signature = openEntry(joinedPath(root, L"AppxSignature.p7x"), false, true);
  const auto before = information(signature.get(), false);
  const auto bytes = fileBytes(before);
  require(before.nNumberOfLinks == 1 && bytes > 4 && bytes <= 2ULL * 1024 * 1024, ErrorCode::packageDenied);
  std::vector<BYTE> encoded(static_cast<std::size_t>(bytes)); DWORD received = 0;
  require(ReadFile(signature.get(), encoded.data(), static_cast<DWORD>(encoded.size()), &received, nullptr) != FALSE && received == encoded.size() &&
    encoded[0] == 'P' && encoded[1] == 'K' && encoded[2] == 'C' && encoded[3] == 'X', ErrorCode::packageDenied);
  CRYPT_DATA_BLOB blob{static_cast<DWORD>(encoded.size() - 4), encoded.data() + 4};
  struct Message {
    HCERTSTORE certificates = nullptr; HCRYPTMSG message = nullptr;
    ~Message() { if (message) CryptMsgClose(message); if (certificates) CertCloseStore(certificates, 0); }
  } parsed;
  require(CryptQueryObject(CERT_QUERY_OBJECT_BLOB, &blob, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED,
    CERT_QUERY_FORMAT_FLAG_BINARY, 0, nullptr, nullptr, nullptr, &parsed.certificates, &parsed.message, nullptr) != FALSE,
    ErrorCode::packageDenied);
  DWORD signers = 0, countBytes = sizeof(signers);
  require(CryptMsgGetParam(parsed.message, CMSG_SIGNER_COUNT_PARAM, 0, &signers, &countBytes) != FALSE &&
    countBytes == sizeof(signers) && signers == 1, ErrorCode::packageDenied);
  DWORD infoBytes = 0;
  require(CryptMsgGetParam(parsed.message, CMSG_SIGNER_CERT_INFO_PARAM, 0, nullptr, &infoBytes) != FALSE &&
    infoBytes >= sizeof(CERT_INFO) && infoBytes <= 65536, ErrorCode::packageDenied);
  std::vector<BYTE> signerInfo(infoBytes);
  require(CryptMsgGetParam(parsed.message, CMSG_SIGNER_CERT_INFO_PARAM, 0, signerInfo.data(), &infoBytes) != FALSE &&
    infoBytes == signerInfo.size(), ErrorCode::packageDenied);
  struct Certificate {
    PCCERT_CONTEXT value = nullptr;
    ~Certificate() { if (value) CertFreeCertificateContext(value); }
  } signer{CertFindCertificateInStore(parsed.certificates, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
    0, CERT_FIND_SUBJECT_CERT, signerInfo.data(), nullptr)};
  require(signer.value && signer.value->cbCertEncoded > 0 && signer.value->cbCertEncoded <= 65536 &&
    CertVerifyTimeValidity(nullptr, signer.value->pCertInfo) == 0, ErrorCode::packageDenied);
  CMSG_CTRL_VERIFY_SIGNATURE_EX_PARA verify{}; verify.cbSize = sizeof(verify);
  verify.dwSignerType = CMSG_VERIFY_SIGNER_CERT; verify.pvSigner = const_cast<PCERT_CONTEXT>(signer.value);
  require(CryptMsgControl(parsed.message, 0, CMSG_CTRL_VERIFY_SIGNATURE_EX, &verify) != FALSE, ErrorCode::packageDenied);
  std::array<BYTE, 32> digest{}; DWORD digestBytes = static_cast<DWORD>(digest.size());
  require(CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM, 0, nullptr, signer.value->pbCertEncoded,
    signer.value->cbCertEncoded, digest.data(), &digestBytes) != FALSE && digestBytes == digest.size(), ErrorCode::packageDenied);
  constexpr char hex[] = "0123456789abcdef"; std::string pin;
  for (const auto byte : digest) { pin += hex[byte >> 4U]; pin += hex[byte & 15U]; }
  require(pin == mmstoreprofile::certificateSha256 && sameFile(before, information(signature.get(), false)) &&
    !roots.empty() && samePath(canonical(roots.back().get()), root), ErrorCode::packageDenied);
}
#endif
}  // namespace detail

class ImmutableFile;
class RegisteredPackage {
 public:
  const Observation& observation() const noexcept { return state_->observation; }
  PackageKind kind() const noexcept { return state_->kind; }
  void revalidate() const { state_->revalidate(); }
  // This returns path data, never authorization to execute a caller-selected
  // file. Executable authority is available only through fixed CodeRole.
  std::wstring absoluteResourcePath(std::wstring_view relativePath) const {
    require(validRelativePath(relativePath), ErrorCode::invalidInput); revalidate();
    return detail::joinedPath(observation().installedLocation, relativePath);
  }
  // The bootstrap metadata is itself protected by the genuine registered
  // Store package. Its fixed location cannot be replaced by caller hash/path.
  ImmutableFile openInventory() const;
  ImmutableFile openManifest() const;
  ImmutableFile openResource(std::wstring_view relativePath, const FilePin& pin) const;
  ImmutableFile openCode(CodeRole role, const FilePin& pin) const;
 private:
  ImmutableFile openResourceImpl(std::wstring_view relativePath, const FilePin* pin, std::uint64_t maximumBytes) const;
  explicit RegisteredPackage(std::shared_ptr<detail::PackageState> state) : state_(std::move(state)) {}
  std::shared_ptr<detail::PackageState> state_;
  friend RegisteredPackage resolveRegisteredPackage(PackageKind);
  friend class ImmutableFile;
};
inline RegisteredPackage resolveRegisteredPackage(PackageKind kind) {
  detail::assertHost();
  const auto user = detail::logon(GetCurrentProcess());
  auto observation = detail::registeredObservation(kind, user.sid);
  auto roots = detail::rootHandles(observation.installedLocation);
  auto state = std::make_shared<detail::PackageState>(detail::PackageState{kind, std::move(observation), user, std::move(roots)});
  state->revalidate(); return RegisteredPackage(std::move(state));
}
class ImmutableFile {
 public:
  ImmutableFile(ImmutableFile&&) noexcept = default;
  ImmutableFile& operator=(ImmutableFile&&) noexcept = default;
  ImmutableFile(const ImmutableFile&) = delete;
  ImmutableFile& operator=(const ImmutableFile&) = delete;
  const FilePin& pin() const noexcept { return pin_; }
  const std::wstring& relativePath() const noexcept { return relative_; }
  HANDLE handle() const noexcept { return file_.get(); }
  std::wstring absolutePath() const { revalidate(); return detail::canonical(file_.get()); }
  // Admission always hashes the protected file. Its retained handle denies
  // write/delete sharing; ordinary callers also fail immutable ACL access.
  // Process-code checks can retain that initial digest binding and validate
  // the held file/generation without rehashing a large Electron EXE per call.
  // This policy never applies to private mutable files or imported receipts.
  void revalidateIdentity() const {
    package_->revalidate();
    require(detail::sameFile(birth_, detail::information(file_.get(), false)) &&
      detail::samePath(detail::canonical(file_.get()), detail::joinedPath(package_->observation.installedLocation, relative_)), ErrorCode::pathDenied);
    std::size_t slashAt = 0;
    for (std::size_t index = 0; index < ancestors_.size(); ++index) {
      const auto slash = relative_.find(L'/', slashAt);
      require(slash != std::wstring::npos && index < ancestorBirth_.size() &&
        detail::sameFile(ancestorBirth_[index], detail::information(ancestors_[index].get(), true)) &&
        detail::samePath(detail::canonical(ancestors_[index].get()), detail::joinedPath(package_->observation.installedLocation, relative_.substr(0, slash))), ErrorCode::pathDenied);
      detail::assertImmutableAcl(ancestors_[index].get(), true); slashAt = slash + 1;
    }
    detail::assertImmutableAcl(file_.get(), false);
    require(detail::sameFile(birth_, detail::information(file_.get(), false)), ErrorCode::pathDenied);
    package_->revalidate();
  }
  void revalidate() const {
    revalidateIdentity();
    require(detail::hashFile(file_.get(), pin_.bytes) == pin_.sha256, ErrorCode::digestMismatch);
    revalidateIdentity();
  }
  std::vector<std::byte> read(std::uint64_t maximumBytes) const {
    require(maximumBytes > 0 && maximumBytes <= maximumFileBytes && pin_.bytes <= maximumBytes, ErrorCode::invalidInput);
    revalidate();
    require(SetFilePointerEx(file_.get(), {}, nullptr, FILE_BEGIN) != FALSE, ErrorCode::fileDenied);
    std::vector<std::byte> result(static_cast<std::size_t>(pin_.bytes)); std::size_t at = 0;
    while (at < result.size()) {
      DWORD received = 0; const auto count = static_cast<DWORD>((std::min)(result.size() - at, std::size_t{65536}));
      require(ReadFile(file_.get(), result.data() + at, count, &received, nullptr) != FALSE && received > 0, ErrorCode::fileDenied);
      at += received;
    }
    BYTE extra = 0; DWORD received = 0;
    require(ReadFile(file_.get(), &extra, 1, &received, nullptr) != FALSE && received == 0, ErrorCode::fileDenied);
    revalidate(); return result;
  }
 private:
  ImmutableFile(std::shared_ptr<detail::PackageState> package, std::wstring relative, FilePin pin,
      std::vector<detail::Handle> ancestors, detail::Handle file, BY_HANDLE_FILE_INFORMATION birth)
    : package_(std::move(package)), relative_(std::move(relative)), pin_(std::move(pin)), ancestors_(std::move(ancestors)), file_(std::move(file)), birth_(birth) {
      ancestorBirth_.reserve(ancestors_.size()); for (const auto& ancestor : ancestors_) ancestorBirth_.push_back(detail::information(ancestor.get(), true));
    }
  std::shared_ptr<detail::PackageState> package_; std::wstring relative_; FilePin pin_;
  std::vector<detail::Handle> ancestors_; std::vector<BY_HANDLE_FILE_INFORMATION> ancestorBirth_; detail::Handle file_; BY_HANDLE_FILE_INFORMATION birth_{};
  friend class RegisteredPackage;
};
inline ImmutableFile RegisteredPackage::openResource(std::wstring_view relativePath, const FilePin& pin) const {
  validatePin(pin); return openResourceImpl(relativePath, &pin, maximumFileBytes);
}
inline ImmutableFile RegisteredPackage::openInventory() const {
  return openResourceImpl(L"store-code-inventory.json", nullptr, 8ULL * 1024 * 1024);
}
inline ImmutableFile RegisteredPackage::openManifest() const {
  // Deployment owns this exact manifest. It cannot be selected by caller input
  // or substituted with an outside receipt/ASAR declaration.
  return openResourceImpl(L"AppxManifest.xml", nullptr, 256ULL * 1024);
}
inline ImmutableFile RegisteredPackage::openResourceImpl(std::wstring_view relativePath, const FilePin* pin, std::uint64_t maximumBytes) const {
  require(validRelativePath(relativePath), ErrorCode::invalidInput); revalidate();
  std::vector<detail::Handle> ancestors;
  for (std::size_t at = 0;;) {
    const auto slash = relativePath.find(L'/', at);
    if (slash == std::wstring_view::npos) break;
    require(ancestors.size() < 32, ErrorCode::pathDenied);
    ancestors.push_back(detail::openEntry(detail::joinedPath(observation().installedLocation, relativePath.substr(0, slash)), true, true));
    at = slash + 1;
  }
  auto file = detail::openEntry(detail::joinedPath(observation().installedLocation, relativePath), false, true);
  const auto birth = detail::information(file.get(), false);
  const auto bytes = detail::fileBytes(birth);
  require(bytes > 0 && bytes <= maximumBytes, ErrorCode::fileDenied);
  if (pin) require(bytes == pin->bytes, ErrorCode::digestMismatch);
  const auto authorizedPin = pin ? *pin : FilePin{detail::hashFile(file.get(), bytes), bytes};
  ImmutableFile result(state_, std::wstring(relativePath), authorizedPin, std::move(ancestors), std::move(file), birth);
  result.revalidate(); return result;
}
inline ImmutableFile RegisteredPackage::openCode(CodeRole role, const FilePin& pin) const {
  const auto spec = codeSpec(role); require(spec.kind == kind(), ErrorCode::invalidInput);
  return openResource(spec.relativePath, pin);
}

struct ProcessIdentity {
  std::wstring sid, logonSid, creationTime;
  std::uint32_t sessionId = 0, pid = 0;
};
namespace detail {
inline std::uint64_t creation(HANDLE process) {
  FILETIME born{}, exit{}, kernel{}, user{};
  require(GetProcessTimes(process, &born, &exit, &kernel, &user) != FALSE, ErrorCode::processDenied);
  return (static_cast<std::uint64_t>(born.dwHighDateTime) << 32U) | born.dwLowDateTime;
}
inline std::wstring processImage(HANDLE process) {
  std::vector<wchar_t> image(32768); DWORD size = static_cast<DWORD>(image.size());
  require(QueryFullProcessImageNameW(process, 0, image.data(), &size) != FALSE && size > 0 && size < image.size(), ErrorCode::processDenied);
  return std::wstring(image.data(), size);
}
inline std::wstring processPackage(HANDLE process) {
  UINT32 size = 0;
  require(GetPackageFullName(process, &size, nullptr) == ERROR_INSUFFICIENT_BUFFER && size > 1 && size <= 1024, ErrorCode::processDenied);
  std::vector<wchar_t> name(size);
  require(GetPackageFullName(process, &size, name.data()) == ERROR_SUCCESS, ErrorCode::processDenied);
  return std::wstring(name.data());
}
inline ProcessIdentity processIdentity(HANDLE process) {
  require(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
  const auto user = logon(process); USHORT machine = 0, native = 0;
  require(IsWow64Process2(process, &machine, &native) != FALSE && machine == IMAGE_FILE_MACHINE_UNKNOWN && native == IMAGE_FILE_MACHINE_AMD64, ErrorCode::processDenied);
  const auto pid = GetProcessId(process); require(pid > 0, ErrorCode::processDenied);
  return {user.sid, user.logonSid, std::to_wstring(creation(process)), user.session, pid};
}
inline bool sameIdentity(const ProcessIdentity& a, const ProcessIdentity& b) {
  return a.sid == b.sid && a.logonSid == b.logonSid && a.creationTime == b.creationTime && a.sessionId == b.sessionId && a.pid == b.pid;
}
inline DWORD parentPid(DWORD pid) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); require(snapshot.valid(), ErrorCode::processDenied);
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); require(Process32FirstW(snapshot.get(), &entry) != FALSE, ErrorCode::processDenied);
  unsigned seen = 0;
  do { require(++seen <= 65536, ErrorCode::processDenied); if (entry.th32ProcessID == pid) { require(entry.th32ParentProcessID > 0 && entry.th32ParentProcessID != pid, ErrorCode::processDenied); return entry.th32ParentProcessID; } } while (Process32NextW(snapshot.get(), &entry));
  fail(ErrorCode::processDenied);
}
}  // namespace detail
// Observation only, useful for denying all legacy entry points when Windows has
// attached any package identity. Empty means the OS reported no package; it is
// never a Store proof and no query failure is converted to absence.
inline std::wstring currentPackageFullName() {
  UINT32 count = 0;
  const auto result = GetCurrentPackageFullName(&count, nullptr);
  if (result == APPMODEL_ERROR_NO_PACKAGE) return {};
  require(result == ERROR_INSUFFICIENT_BUFFER && count > 1 && count <= 1024, ErrorCode::processDenied);
  std::vector<wchar_t> name(count);
  require(GetCurrentPackageFullName(&count, name.data()) == ERROR_SUCCESS, ErrorCode::processDenied);
  return std::wstring(name.data());
}
class AttestedProcess {
 public:
  AttestedProcess(AttestedProcess&&) noexcept = default;
  AttestedProcess& operator=(AttestedProcess&&) noexcept = default;
  AttestedProcess(const AttestedProcess&) = delete;
  AttestedProcess& operator=(const AttestedProcess&) = delete;
  const ProcessIdentity& identity() const noexcept { return identity_; }
  const Observation& observation() const noexcept { return package_.observation(); }
  CodeRole role() const noexcept { return role_; }
  HANDLE handle() const noexcept { return process_.get(); }
  void revalidate() const {
    package_.revalidate(); code_.revalidateIdentity();
    require(detail::sameIdentity(identity_, detail::processIdentity(process_.get())) && detail::processPackage(process_.get()) == observation().fullName &&
      detail::samePath(detail::processImage(process_.get()), detail::joinedPath(observation().installedLocation, codeSpec(role_).relativePath)), ErrorCode::processDenied);
  }
 private:
  AttestedProcess(RegisteredPackage package, CodeRole role, detail::Handle process, ProcessIdentity identity, ImmutableFile code)
    : package_(std::move(package)), role_(role), process_(std::move(process)), identity_(std::move(identity)), code_(std::move(code)) {}
  RegisteredPackage package_; CodeRole role_; detail::Handle process_; ProcessIdentity identity_; ImmutableFile code_;
  friend AttestedProcess attestProcess(DWORD, CodeRole, const FilePin&);
};
inline AttestedProcess attestProcess(DWORD pid, CodeRole role, const FilePin& pin) {
  validatePin(pin); require(pid > 0, ErrorCode::invalidInput);
  const auto spec = codeSpec(role); auto package = resolveRegisteredPackage(spec.kind);
  detail::Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  require(process.valid(), ErrorCode::processDenied); const auto identity = detail::processIdentity(process.get());
  const auto current = detail::logon(GetCurrentProcess());
  require(identity.sid == current.sid && identity.logonSid == current.logonSid && identity.sessionId == current.session, ErrorCode::processDenied);
  require(detail::processPackage(process.get()) == package.observation().fullName && detail::samePath(detail::processImage(process.get()), detail::joinedPath(package.observation().installedLocation, spec.relativePath)), ErrorCode::processDenied);
  auto code = package.openCode(role, pin);
  AttestedProcess result(std::move(package), role, std::move(process), identity, std::move(code));
  result.revalidate(); return result;
}
struct BootstrapAttestation { RegisteredPackage package; AttestedProcess self; AttestedProcess parent; };
inline BootstrapAttestation attestHelperParent(PackageKind kind, const FilePin& selfPin, const FilePin& parentPin, CodeRole parentRole) {
  const bool allowed = kind == PackageKind::gui ? parentRole == CodeRole::guiApplication :
    (parentRole == CodeRole::workerNode || parentRole == CodeRole::workerControls || parentRole == CodeRole::workerSession);
  require(allowed && codeSpec(parentRole).kind == kind, ErrorCode::invalidInput);
  auto package = resolveRegisteredPackage(kind);
  auto self = attestProcess(GetCurrentProcessId(), kind == PackageKind::gui ? CodeRole::guiNative : CodeRole::workerNative, selfPin);
  const auto parent = detail::parentPid(self.identity().pid);
  auto issuer = attestProcess(parent, parentRole, parentPin);
  require(detail::creation(issuer.handle()) <= detail::creation(self.handle()) && detail::parentPid(self.identity().pid) == issuer.identity().pid &&
    self.observation().fullName == issuer.observation().fullName, ErrorCode::processDenied);
  self.revalidate(); issuer.revalidate(); package.revalidate();
  return {std::move(package), std::move(self), std::move(issuer)};
}
#endif  // _WIN32: there is deliberately no non-Windows OS authority substitute.

}  // namespace mmstore
