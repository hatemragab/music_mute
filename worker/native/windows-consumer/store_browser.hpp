#pragma once
#include "json.hpp"
#include "store_authority.hpp"
#include "store_inventory.hpp"
#include "store_namespace.hpp"

namespace mmstorebrowserpolicy {
inline constexpr std::string_view extensionId = "acmgefmmndomcpdlgnafkjbgobinllep";
inline constexpr std::string_view origin = "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/";
inline constexpr std::wstring_view manifestRelative = L"app/resources/native/com.musicmute.local.json";
inline constexpr std::wstring_view alias = L"MusicMuteChromeHost.exe";
enum class Intent { inspect, registration, removal };
inline Intent parseIntent(const mm::Json& args) {
  try {
    mmstoreinventory::exact(args, {"intent"});
    const auto& value = args.at("intent").string();
    if (value == "inspect") return Intent::inspect;
    if (value == "register") return Intent::registration;
    if (value == "remove") return Intent::removal;
  } catch (...) {}
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline void validateManifest(const mm::Json& value) {
  try {
    mmstoreinventory::exact(value, {"name", "description", "path", "type", "allowed_origins"});
    mmstore::require(value.at("name").string() == "com.musicmute.local" &&
      value.at("description").string() == "MusicMute Windows companion" &&
      value.at("path").string() == "../../MusicMuteChromeHost.exe" &&
      value.at("type").string() == "stdio" && value.at("allowed_origins").array().size() == 1 &&
      value.at("allowed_origins").array().front().string() == origin, mmstore::ErrorCode::fileDenied);
  } catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(mmstore::ErrorCode::fileDenied); }
}
inline void validateOrigin(std::string_view value) {
  mmstore::require(value == origin, mmstore::ErrorCode::processDenied);
}
inline std::uint64_t parentWindow(std::wstring_view value) {
  if (value.empty()) return 0;
  constexpr std::wstring_view prefix = L"--parent-window=";
  mmstore::require(value.starts_with(prefix), mmstore::ErrorCode::invalidInput);
  value.remove_prefix(prefix.size());
  mmstore::require(!value.empty() && value.size() <= 20 &&
    value.find_first_not_of(L"0123456789") == std::wstring_view::npos, mmstore::ErrorCode::invalidInput);
  std::uint64_t result = 0;
  for (const auto c : value) {
    const auto digit = static_cast<unsigned>(c - L'0');
    mmstore::require(result <= (UINT64_MAX - digit) / 10, mmstore::ErrorCode::invalidInput);
    result = result * 10 + digit;
  }
  return result;
}
inline std::uint32_t pid(const mm::Json& value) {
  const auto number = value.integer();
  mmstore::require(number > 0 && number <= 2147483647, mmstore::ErrorCode::invalidInput);
  return static_cast<std::uint32_t>(number);
}
inline void validateAttachInput(const mm::Json& value) {
  try {
    mmstoreinventory::exact(value, {"host_pid", "nonce", "origin"});
    (void)pid(value.at("host_pid"));
    mmstore::require(mmstore::validDigest(value.at("nonce").string()), mmstore::ErrorCode::invalidInput);
    validateOrigin(value.at("origin").string());
  } catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(mmstore::ErrorCode::invalidInput); }
}
// A bounded ASCII path is from the registered package authority, never caller
// input. Locale-specific reg.exe labels cannot authorize a different value.
inline bool ordinaryQueryMatches(std::string_view output, std::string_view path) {
  if (output.empty() || output.size() > 16384 || path.empty() || path.size() > 32700 ||
      output.find('\0') != std::string_view::npos || (path.find_first_of("\r\n") != std::string_view::npos || path.find('\0') != std::string_view::npos))
    return false;
  const auto marker = output.find("REG_SZ");
  if (marker == std::string_view::npos || output.find("REG_SZ", marker + 6) != std::string_view::npos) return false;
  std::size_t start = marker + 6;
  if (start == output.size() || (output[start] != ' ' && output[start] != '\t')) return false;
  while (start < output.size() && (output[start] == ' ' || output[start] == '\t')) ++start;
  const auto line = output.find_first_of("\r\n", start);
  auto actual = output.substr(start, line == std::string_view::npos ? output.size() - start : line - start);
  while (!actual.empty() && (actual.back() == ' ' || actual.back() == '\t')) actual.remove_suffix(1);
  if (actual.size() != path.size()) return false;
  for (std::size_t n = 0; n < actual.size(); ++n) {
    const auto upper = [](char c) { return c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c; };
    if (upper(actual[n]) != upper(path[n])) return false;
  }
  return true;
}
} // namespace mmstorebrowserpolicy

#if defined(_WIN32) && !defined(MUSICMUTE_STORE_BROWSER_POLICY_ONLY)
// Production includes this implementation only after the existing guarded
// private/vault/registry helpers, inside main.cpp's implementation namespace.
// No received receipt, injected verifier or caller-selected executable is used.
#include <mscat.h>

inline void storeBrowserNeed(bool result) { if (!result) fail("BROWSER_REGISTRATION_CONFLICT"); }
inline std::wstring storeBrowserSystemDirectory() {
  wchar_t path[32768]{}; const auto size = GetSystemDirectoryW(path, 32768);
  storeBrowserNeed(size > 0 && size < 32768); return std::wstring(path, size);
}
inline BY_HANDLE_FILE_INFORMATION storeBrowserBirth(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION value{}; storeBrowserNeed(GetFileInformationByHandle(file, &value) != FALSE); return value;
}
inline Handle storeBrowserRegular(const std::wstring& path, bool singleLink) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  storeBrowserNeed(file.valid()); const auto birth = storeBrowserBirth(file.value);
  storeBrowserNeed(!(birth.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
    (!singleLink || birth.nNumberOfLinks == 1) && _wcsicmp(nativeCanonical(file.value).c_str(), path.c_str()) == 0);
  return file;
}
inline std::wstring storeBrowserSidText(PSID value) {
  PWSTR raw = nullptr; storeBrowserNeed(value && IsValidSid(value) && ConvertSidToStringSidW(value, &raw));
  LocalMemory cleanup{raw}; return std::wstring(raw);
}
inline bool storeBrowserPrivilegedSid(PSID value) {
  if (IsWellKnownSid(value, WinLocalSystemSid) || IsWellKnownSid(value, WinBuiltinAdministratorsSid)) return true;
  const auto text = storeBrowserSidText(value);
  if (text == L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464") return true;
  BYTE crypto[SECURITY_MAX_SID_SIZE]{}; DWORD bytes = static_cast<DWORD>(sizeof(crypto)), domainBytes = 256;
  wchar_t domain[256]{}; SID_NAME_USE use{};
  storeBrowserNeed(LookupAccountNameW(nullptr, L"NT SERVICE\\CryptSvc", crypto, &bytes, domain, &domainBytes, &use));
  return EqualSid(value, crypto) != FALSE;
}
inline void storeBrowserOsAcl(HANDLE file, bool directory) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  storeBrowserNeed(GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS);
  LocalMemory cleanup{descriptor};
  storeBrowserNeed(owner && acl && IsValidAcl(acl) && storeBrowserPrivilegedSid(owner));
  const DWORD mutation = DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL | GENERIC_WRITE | FILE_WRITE_ATTRIBUTES |
    (directory ? FILE_DELETE_CHILD : FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA);
  ACL_SIZE_INFORMATION size{}; storeBrowserNeed(GetAclInformation(acl, &size, sizeof(size), AclSizeInformation) && size.AceCount <= 256);
  for (DWORD i = 0; i < size.AceCount; ++i) {
    void* raw = nullptr; storeBrowserNeed(GetAce(acl, i, &raw)); const auto head = static_cast<ACE_HEADER*>(raw);
    if (head->AceFlags & INHERIT_ONLY_ACE || head->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    storeBrowserNeed(head->AceType == ACCESS_ALLOWED_ACE_TYPE && head->AceSize >= offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8);
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    const auto id = reinterpret_cast<PSID>(const_cast<DWORD*>(&ace->SidStart));
    const auto remaining = head->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart);
    storeBrowserNeed(reinterpret_cast<BYTE*>(id)[1] <= SID_MAX_SUB_AUTHORITIES &&
      GetSidLengthRequired(reinterpret_cast<BYTE*>(id)[1]) <= remaining && IsValidSid(id));
    if (ace->Mask & mutation) storeBrowserNeed(storeBrowserPrivilegedSid(id));
  }
}
inline std::vector<Handle> storeBrowserOsAncestors(const std::wstring& file) {
  storeBrowserNeed(file.size() >= 4 && file[1] == L':' && file[2] == L'\\' &&
    file.find(L'/') == std::wstring::npos && GetDriveTypeW(file.substr(0, 3).c_str()) == DRIVE_FIXED);
  std::vector<Handle> held; std::size_t end = 3;
  for (;;) {
    const auto path = file.substr(0, end);
    Handle directory(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    storeBrowserNeed(directory.valid()); const auto birth = storeBrowserBirth(directory.value);
    storeBrowserNeed((birth.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(birth.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
      _wcsicmp(nativeCanonical(directory.value).c_str(), path.c_str()) == 0);
    storeBrowserOsAcl(directory.value, true); held.push_back(std::move(directory));
    storeBrowserNeed(held.size() <= 32); const auto next = file.find(L'\\', end == 3 ? end : end + 1);
    if (next == std::wstring::npos) break; end = next;
  }
  return held;
}

inline std::wstring storeBrowserCertificateName(PCCERT_CONTEXT certificate, const char* oid) { wchar_t text[256]{}; const auto n = CertGetNameStringW(certificate, CERT_NAME_ATTR_TYPE, 0, const_cast<char*>(oid), text, 256); storeBrowserNeed(n > 1 && n <= 256); return text; }
inline mm::Json storeBrowserTrustedWindowsSigner(WINTRUST_DATA& trust) {
  const auto provider = WTHelperProvDataFromStateData(trust.hWVTStateData); storeBrowserNeed(provider && provider->csSigners == 1);
  const auto signer = WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0); storeBrowserNeed(signer && signer->pChainContext && signer->csCertChain >= 2 && signer->csCertChain <= 8 && signer->pChainContext->TrustStatus.dwErrorStatus == CERT_TRUST_NO_ERROR);
  const auto leaf = WTHelperGetProvCertFromChain(signer, 0); storeBrowserNeed(leaf && leaf->pCert && storeBrowserCertificateName(leaf->pCert, szOID_COMMON_NAME) == L"Microsoft Windows" && storeBrowserCertificateName(leaf->pCert, szOID_ORGANIZATION_NAME) == L"Microsoft Corporation");
  DWORD bytes = 0; storeBrowserNeed(CertGetEnhancedKeyUsage(leaf->pCert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, nullptr, &bytes) && bytes > 0 && bytes < 65536); std::vector<BYTE> buffer(bytes); auto usage = reinterpret_cast<PCERT_ENHKEY_USAGE>(buffer.data()); storeBrowserNeed(CertGetEnhancedKeyUsage(leaf->pCert, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, usage, &bytes) && usage->cUsageIdentifier <= 32);
  bool code = false, component = false; for (DWORD i = 0; i < usage->cUsageIdentifier; ++i) { storeBrowserNeed(usage->rgpszUsageIdentifier[i]); code = code || std::strcmp(usage->rgpszUsageIdentifier[i], szOID_PKIX_KP_CODE_SIGNING) == 0; component = component || std::strcmp(usage->rgpszUsageIdentifier[i], "1.3.6.1.4.1.311.10.3.6") == 0; } storeBrowserNeed(code && component);
  mm::Json::Array chain; for (DWORD i = 0; i < signer->csCertChain; ++i) { const auto cert = WTHelperGetProvCertFromChain(signer, i); storeBrowserNeed(cert && cert->pCert); const auto name = storeBrowserCertificateName(cert->pCert, szOID_COMMON_NAME); storeBrowserNeed(storeBrowserCertificateName(cert->pCert, szOID_ORGANIZATION_NAME) == L"Microsoft Corporation"); chain.push_back(mm::Json(utf8(name))); }
  return mm::Json::Object{{"trusted_windows_signer", true}, {"code_signing_eku", true}, {"windows_component_eku", true}, {"chain", chain}};
}
struct StoreBrowserRegAuthority {
  std::vector<Handle> ancestors, catalogAncestors; Handle catalog; std::string imageHash, catalogHash; BY_HANDLE_FILE_INFORMATION imageBirth{}, catalogBirth{}; mm::Json observation;
  void unchanged(HANDLE image) { storeBrowserOsAcl(image, false); if (catalog.valid()) storeBrowserOsAcl(catalog.value, false); storeBrowserNeed(mmstore::detail::sameFile(imageBirth, storeBrowserBirth(image)) && hashFile(image) == imageHash && mmstore::detail::sameFile(imageBirth, storeBrowserBirth(image))); if (catalog.valid()) storeBrowserNeed(mmstore::detail::sameFile(catalogBirth, storeBrowserBirth(catalog.value)) && hashFile(catalog.value) == catalogHash && mmstore::detail::sameFile(catalogBirth, storeBrowserBirth(catalog.value))); }
};
inline StoreBrowserRegAuthority storeBrowserVerifyMicrosoftReg(const std::wstring& path, HANDLE file) {
  storeBrowserNeed(_wcsicmp(path.c_str(), (storeBrowserSystemDirectory() + L"\\reg.exe").c_str()) == 0); StoreBrowserRegAuthority result; result.ancestors = storeBrowserOsAncestors(path); storeBrowserOsAcl(file, false); result.imageBirth = storeBrowserBirth(file); storeBrowserNeed(mmstore::detail::fileBytes(result.imageBirth) > 0 && mmstore::detail::fileBytes(result.imageBirth) <= 16ULL * 1024 * 1024); result.imageHash = hashFile(file); assertSignedPeArchitecture(file, false);
  WINTRUST_FILE_INFO info{sizeof(info), path.c_str(), file, nullptr}; WINTRUST_DATA data{}; data.cbStruct = sizeof(data); data.dwUIChoice = WTD_UI_NONE; data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN; data.dwUnionChoice = WTD_CHOICE_FILE; data.pFile = &info; data.dwStateAction = WTD_STATEACTION_VERIFY; data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_DISABLE_MD2_MD4 | WTD_CACHE_ONLY_URL_RETRIEVAL; GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  struct State { GUID& action; WINTRUST_DATA& data; ~State() { if (data.hWVTStateData) { data.dwStateAction = WTD_STATEACTION_CLOSE; (void)WinVerifyTrust(nullptr, &action, &data); data.hWVTStateData = nullptr; } } } state{action, data}; storeBrowserNeed(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); const auto embedded = WinVerifyTrust(nullptr, &action, &data);
  if (embedded == ERROR_SUCCESS) { result.observation = mm::Json::Object{{"signature_type", "embedded"}, {"signer", storeBrowserTrustedWindowsSigner(data)}}; result.unchanged(file); return result; }
  storeBrowserNeed(embedded == TRUST_E_NOSIGNATURE); data.dwStateAction = WTD_STATEACTION_CLOSE; (void)WinVerifyTrust(nullptr, &action, &data); data.hWVTStateData = nullptr;
  const auto module = GetModuleHandleW(L"wintrust.dll"); storeBrowserNeed(module); wchar_t moduleFile[32768]{}; const auto moduleBytes = GetModuleFileNameW(module, moduleFile, 32768); storeBrowserNeed(moduleBytes > 0 && moduleBytes < 32768 && _wcsicmp(moduleFile, (storeBrowserSystemDirectory() + L"\\wintrust.dll").c_str()) == 0);
  using Acquire = decltype(&CryptCATAdminAcquireContext2); using Calculate = decltype(&CryptCATAdminCalcHashFromFileHandle2); Acquire acquire = nullptr; Calculate calculate = nullptr; const auto acquireAddress = GetProcAddress(module, "CryptCATAdminAcquireContext2"), calculateAddress = GetProcAddress(module, "CryptCATAdminCalcHashFromFileHandle2"); storeBrowserNeed(acquireAddress && calculateAddress); static_assert(sizeof(acquire) == sizeof(acquireAddress)); std::memcpy(&acquire, &acquireAddress, sizeof(acquire)); std::memcpy(&calculate, &calculateAddress, sizeof(calculate)); CERT_STRONG_SIGN_PARA strong{}; strong.cbSize = sizeof(strong); strong.dwInfoChoice = CERT_STRONG_SIGN_OID_INFO_CHOICE; strong.pszOID = const_cast<LPSTR>(szOID_CERT_STRONG_SIGN_OS_CURRENT); HCATADMIN admin = nullptr; storeBrowserNeed(acquire(&admin, nullptr, L"SHA256", &strong, 0)); struct Admin { HCATADMIN h; ~Admin() { if (h) CryptCATAdminReleaseContext(h, 0); } } adminLifetime{admin}; DWORD hashBytes = 0; storeBrowserNeed(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); storeBrowserNeed(calculate(admin, file, &hashBytes, nullptr, 0) && hashBytes == 32); std::vector<BYTE> memberHash(hashBytes); storeBrowserNeed(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); storeBrowserNeed(calculate(admin, file, &hashBytes, memberHash.data(), 0) && hashBytes == 32); std::wstring tag; constexpr wchar_t hex[] = L"0123456789ABCDEF"; for (const auto b : memberHash) { tag += hex[b >> 4]; tag += hex[b & 15]; }
  const auto catalog = CryptCATAdminEnumCatalogFromHash(admin, memberHash.data(), hashBytes, 0, nullptr); storeBrowserNeed(catalog); struct Catalog { HCATADMIN a; HCATINFO h; ~Catalog() { if (h) CryptCATAdminReleaseCatalogContext(a, h, 0); } } catalogLifetime{admin, catalog}; CATALOG_INFO catalogInfo{}; catalogInfo.cbStruct = sizeof(catalogInfo); storeBrowserNeed(CryptCATCatalogInfoFromContext(catalog, &catalogInfo, 0)); storeBrowserNeed(wcsnlen_s(catalogInfo.wszCatalogFile, MAX_PATH) < MAX_PATH); const std::wstring catalogPath(catalogInfo.wszCatalogFile); const auto catalogRoot = storeBrowserSystemDirectory() + L"\\CatRoot\\"; storeBrowserNeed(catalogPath.size() < 32768 && catalogPath.size() > catalogRoot.size() && _wcsnicmp(catalogPath.c_str(), catalogRoot.c_str(), catalogRoot.size()) == 0 && catalogPath.ends_with(L".cat")); result.catalogAncestors = storeBrowserOsAncestors(catalogPath); result.catalog = storeBrowserRegular(catalogPath, false); storeBrowserOsAcl(result.catalog.value, false); result.catalogBirth = storeBrowserBirth(result.catalog.value); storeBrowserNeed(mmstore::detail::fileBytes(result.catalogBirth) > 0 && mmstore::detail::fileBytes(result.catalogBirth) <= 64ULL * 1024 * 1024); result.catalogHash = hashFile(result.catalog.value);
  WINTRUST_CATALOG_INFO member{}; member.cbStruct = sizeof(member); member.pcwszCatalogFilePath = catalogPath.c_str(); member.pcwszMemberTag = tag.c_str(); member.pcwszMemberFilePath = path.c_str(); member.hMemberFile = file; member.pbCalculatedFileHash = memberHash.data(); member.cbCalculatedFileHash = hashBytes; member.hCatAdmin = admin; State catalogState{action, data}; data.dwUnionChoice = WTD_CHOICE_CATALOG; data.pCatalog = &member; data.dwStateAction = WTD_STATEACTION_VERIFY; storeBrowserNeed(SetFilePointerEx(file, {}, nullptr, FILE_BEGIN)); const auto status = WinVerifyTrust(nullptr, &action, &data); storeBrowserNeed(status == ERROR_SUCCESS); const auto signer = storeBrowserTrustedWindowsSigner(data); result.observation = mm::Json::Object{{"signature_type", "catalog"}, {"catalog", utf8(catalogPath)}, {"catalog_sha256", result.catalogHash}, {"sha256_member_tag", utf8(tag)}, {"member_trust_result", 0}, {"signer", signer}}; result.unchanged(file); return result;
}

struct StoreBrowserQuery { DWORD exitCode = 2; std::string output; };
inline void storeBrowserWaitJobZero(HANDLE job, DWORD budget = 5000) {
  const auto deadline = GetTickCount64() + budget;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value{};
    check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &value, sizeof(value), nullptr), "JOB_UNAVAILABLE");
    if (value.ActiveProcesses == 0) return;
    if (GetTickCount64() >= deadline) fail("JOB_UNAVAILABLE");
    Sleep(5);
  }
}
inline StoreBrowserQuery storeBrowserOrdinaryQuery(REGSAM view) {
  if (view != KEY_WOW64_32KEY && view != KEY_WOW64_64KEY) fail("BAD_REQUEST");
  const auto executable = storeBrowserSystemDirectory() + L"\\reg.exe";
  auto held = storeBrowserRegular(executable, false); auto trust = storeBrowserVerifyMicrosoftReg(executable, held.value);
  const auto commandKey = L"HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.musicmute.local";
  auto command = quote(executable) + L" QUERY " + quote(commandKey) + L" /ve" +
    (view == KEY_WOW64_32KEY ? L" /reg:32" : L" /reg:64");
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE}; HANDLE readRaw = nullptr, writeRaw = nullptr;
  check(CreatePipe(&readRaw, &writeRaw, &security, 0), "PIPE_UNAVAILABLE"); Handle reader(readRaw), writer(writeRaw);
  check(SetHandleInformation(reader.value, HANDLE_FLAG_INHERIT, 0), "PIPE_UNAVAILABLE");
  Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
  check(input.valid(), "PIPE_UNAVAILABLE"); SIZE_T bytes = 0; InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
  std::vector<BYTE> storage(bytes); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  check(InitializeProcThreadAttributeList(attributes, 2, 0, &bytes), "JOB_UNAVAILABLE");
  struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } lifetime{attributes};
  HANDLE inherited[]{writer.value, input.value};
  check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr), "JOB_UNAVAILABLE");
  DWORD policy = PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE;
  check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, &policy, sizeof(policy), nullptr, nullptr), "JOB_UNAVAILABLE");
  STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start); start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  start.StartupInfo.hStdInput = input.value; start.StartupInfo.hStdOutput = writer.value; start.StartupInfo.hStdError = writer.value; start.lpAttributeList = attributes;
  std::wstring environment = L"SystemRoot=" + storeBrowserSystemDirectory().substr(0, storeBrowserSystemDirectory().find_last_of(L'\\'));
  environment.push_back(L'\0'); environment.push_back(L'\0');
  Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.valid(), "JOB_UNAVAILABLE");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "JOB_UNAVAILABLE");
  PROCESS_INFORMATION created{}; trust.unchanged(held.value);
  check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(), storeBrowserSystemDirectory().c_str(), &start.StartupInfo, &created), "JOB_UNAVAILABLE");
  Handle process(created.hProcess), thread(created.hThread);
  if (!AssignProcessToJobObject(job.value, process.value)) {
    check(TerminateProcess(process.value, 2), "JOB_UNAVAILABLE");
    check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "JOB_UNAVAILABLE"); fail("JOB_UNAVAILABLE");
  }
  try {
    BOOL member = FALSE; check(IsProcessInJob(process.value, job.value, &member) && member, "JOB_UNAVAILABLE");
    const auto user = mmstore::detail::logon(process.value), current = mmstore::detail::logon(GetCurrentProcess());
    if (user.sid != current.sid || user.logonSid != current.logonSid || user.session != current.session ||
        !mmstore::detail::samePath(mmstore::detail::processImage(process.value), executable)) fail("PEER_DENIED");
    UINT32 packageSize = 0;
    if (GetPackageFullName(process.value, &packageSize, nullptr) != APPMODEL_ERROR_NO_PACKAGE) fail("PEER_DENIED");
    trust.unchanged(held.value); check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "JOB_UNAVAILABLE");
    writer.close(); input.close(); StoreBrowserQuery result; const auto deadline = GetTickCount64() + 10000; bool exited = false, eof = false;
    while (!exited) {
      DWORD available = 0;
      if (!PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr)) {
        if (GetLastError() != ERROR_BROKEN_PIPE) fail("PIPE_UNAVAILABLE"); eof = true;
      } else if (available) {
        BYTE buffer[4096]{}; DWORD received = 0;
        check(ReadFile(reader.value, buffer, (std::min)(available, static_cast<DWORD>(sizeof(buffer))), &received, nullptr) && received > 0, "PIPE_UNAVAILABLE");
        if (result.output.size() + received > 16384) fail("FRAME_TOO_LARGE");
        result.output.append(reinterpret_cast<const char*>(buffer), received);
      }
      const auto wait = WaitForSingleObject(process.value, 5);
      if (wait == WAIT_OBJECT_0) exited = true;
      else if (wait != WAIT_TIMEOUT) fail("JOB_UNAVAILABLE");
      if (!exited && GetTickCount64() >= deadline) fail("TIMEOUT");
    }
    check(GetExitCodeProcess(process.value, &result.exitCode), "JOB_UNAVAILABLE");
    // A root exit cannot leave a descendant or an unbounded inherited writer.
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    check(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "JOB_UNAVAILABLE");
    if (accounting.ActiveProcesses) { check(TerminateJobObject(job.value, 2), "JOB_UNAVAILABLE"); storeBrowserWaitJobZero(job.value); fail("JOB_UNAVAILABLE"); }
    storeBrowserWaitJobZero(job.value);
    while (!eof) {
      DWORD available = 0;
      if (!PeekNamedPipe(reader.value, nullptr, 0, nullptr, &available, nullptr)) {
        check(GetLastError() == ERROR_BROKEN_PIPE, "PIPE_UNAVAILABLE"); eof = true; break;
      }
      if (!available) fail("PIPE_UNAVAILABLE");
      BYTE buffer[4096]{}; DWORD received = 0;
      check(ReadFile(reader.value, buffer, (std::min)(available, static_cast<DWORD>(sizeof(buffer))), &received, nullptr) && received > 0, "PIPE_UNAVAILABLE");
      if (result.output.size() + received > 16384) fail("FRAME_TOO_LARGE");
      result.output.append(reinterpret_cast<const char*>(buffer), received);
    }
    trust.unchanged(held.value); if (result.exitCode > 1) fail("BROWSER_REGISTRATION_CONFLICT"); return result;
  } catch (...) {
    check(TerminateJobObject(job.value, 2), "JOB_UNAVAILABLE");
    check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "JOB_UNAVAILABLE");
    storeBrowserWaitJobZero(job.value); throw;
  }
}

struct StoreBrowserFiles {
  mmstore::RegisteredPackage package;
  mmstore::ImmutableFile inventory, host, entry, application, manifest;
  void revalidate() const {
    package.revalidate(); inventory.revalidateIdentity(); host.revalidateIdentity(); entry.revalidateIdentity();
    application.revalidateIdentity(); manifest.revalidateIdentity();
  }
};
inline StoreBrowserFiles storeBrowserFiles(const mmstore::RegisteredPackage& package) {
  if (package.kind() != mmstore::PackageKind::gui) fail("PEER_DENIED");
  auto inventoryFile = package.openInventory(); const auto bytes = inventoryFile.read(8 * 1024 * 1024);
  const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  const auto inventory = mmstoreinventory::parse(mmstore::PackageKind::gui, mm::JsonParser::storeCodeInventory(text));
  const auto deployed = mmstore::parseVersion(package.observation().packageVersion), sealed = mmstore::parseVersion(inventory.packageVersion);
  if (deployed[0] != sealed[0] || deployed[1] != sealed[1] || deployed[2] != sealed[2]) fail("HELPER_INTEGRITY_INVALID");
  const auto manifestPin = std::find_if(inventory.entries.begin(), inventory.entries.end(), [](const auto& value) {
    return value.path == mmstorebrowserpolicy::manifestRelative;
  });
  if (manifestPin == inventory.entries.end()) fail("HELPER_INTEGRITY_INVALID");
  auto manifest = package.openResource(mmstorebrowserpolicy::manifestRelative, manifestPin->pin);
  const auto manifestBytes = manifest.read(4096);
  mmstorebrowserpolicy::validateManifest(mm::JsonParser(std::string(reinterpret_cast<const char*>(manifestBytes.data()), manifestBytes.size())).parse());
  StoreBrowserFiles result{package, std::move(inventoryFile),
    package.openCode(mmstore::CodeRole::guiChromeHost, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiChromeHost)),
    package.openCode(mmstore::CodeRole::guiBrowserEntry, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiBrowserEntry)),
    package.openCode(mmstore::CodeRole::guiApplication, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiApplication)),
    std::move(manifest)};
  result.revalidate(); return result;
}
inline Json storeBrowserDesired(const StoreBrowserFiles& files) {
  return Json::Object{{"version", 1}, {"sid", currentIdentity().sid}, {"extension_id", std::string(mmstorebrowserpolicy::extensionId)},
    {"package_full_name", utf8(files.package.observation().fullName)}, {"manifest_path", utf8(files.manifest.absolutePath())},
    {"manifest_sha256", files.manifest.pin().sha256}, {"manifest_bytes", static_cast<std::int64_t>(files.manifest.pin().bytes)},
    {"host_sha256", files.host.pin().sha256}, {"host_bytes", static_cast<std::int64_t>(files.host.pin().bytes)},
    {"entry_sha256", files.entry.pin().sha256}, {"entry_bytes", static_cast<std::int64_t>(files.entry.pin().bytes)}};
}
inline void storeBrowserValidateRecord(const Json& value, const mmstore::RegisteredPackage& current) {
  keys(value, {"version", "sid", "extension_id", "package_full_name", "manifest_path", "manifest_sha256", "manifest_bytes", "host_sha256", "host_bytes", "entry_sha256", "entry_bytes"});
  if (value.at("version").integer() != 1 || value.at("sid").string() != currentIdentity().sid ||
      value.at("extension_id").string() != mmstorebrowserpolicy::extensionId) fail("BROWSER_REGISTRATION_CONFLICT");
  const auto full = wide(value.at("package_full_name").string()); const auto& expected = mmstore::expectedPackage(mmstore::PackageKind::gui);
  const auto prefix = std::wstring(expected.identityName) + L"_", suffix = L"_x64__" + std::wstring(expected.publisherId);
  if (!full.starts_with(prefix) || !full.ends_with(suffix) || full.size() <= prefix.size() + suffix.size()) fail("BROWSER_REGISTRATION_CONFLICT");
  const auto version = full.substr(prefix.size(), full.size() - prefix.size() - suffix.size());
  if (mmstore::versionText(mmstore::parseVersion(version)) != version) fail("BROWSER_REGISTRATION_CONFLICT");
  const auto root = current.observation().installedLocation;
  const auto oldRoot = root.substr(0, root.find_last_of(L'\\') + 1) + full;
  const auto manifestPath = mmstore::detail::joinedPath(oldRoot, mmstorebrowserpolicy::manifestRelative);
  if (value.at("manifest_path").string() != utf8(manifestPath)) fail("BROWSER_REGISTRATION_CONFLICT");
  for (const auto* field : {"manifest_sha256", "host_sha256", "entry_sha256"})
    if (!mmstore::validDigest(value.at(field).string())) fail("BROWSER_REGISTRATION_CONFLICT");
  for (const auto& [field, maximum] : std::array<std::pair<const char*, std::int64_t>, 3>{
      {{"manifest_bytes", 4096}, {"host_bytes", 16 * 1024 * 1024}, {"entry_bytes", 32 * 1024 * 1024}}})
    if (value.at(field).integer() < 1 || value.at(field).integer() > maximum) fail("BROWSER_REGISTRATION_CONFLICT");
}
inline std::wstring storeBrowserKey() { return L"Software\\Google\\Chrome\\NativeMessagingHosts\\com.musicmute.local"; }
inline void storeBrowserKeyAcl(HKEY key) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  check(GetSecurityInfo(key, SE_REGISTRY_KEY, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS, "BROWSER_REGISTRATION_CONFLICT");
  LocalMemory cleanup{descriptor}; SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  if (!owner || storeBrowserSidText(owner) != wide(currentIdentity().sid) || !acl || !IsValidAcl(acl) ||
      !GetSecurityDescriptorControl(descriptor, &control, &revision) || !(control & SE_DACL_PROTECTED)) fail("BROWSER_REGISTRATION_CONFLICT");
  ACL_SIZE_INFORMATION info{};
  check(GetAclInformation(acl, &info, sizeof(info), AclSizeInformation), "BROWSER_REGISTRATION_CONFLICT");
  if (info.AceCount != 2) fail("BROWSER_REGISTRATION_CONFLICT"); bool user = false, system = false;
  for (DWORD n = 0; n < 2; ++n) {
    void* raw = nullptr; check(GetAce(acl, n, &raw), "BROWSER_REGISTRATION_CONFLICT");
    const auto head = static_cast<const ACE_HEADER*>(raw);
    if (head->AceType != ACCESS_ALLOWED_ACE_TYPE || head->AceFlags || head->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8) fail("BROWSER_REGISTRATION_CONFLICT");
    const auto ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw); const auto sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&ace->SidStart));
    const auto count = reinterpret_cast<const BYTE*>(sid)[1];
    if (ace->Mask != KEY_ALL_ACCESS || count > SID_MAX_SUB_AUTHORITIES ||
        GetSidLengthRequired(count) > head->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart) || !IsValidSid(sid)) fail("BROWSER_REGISTRATION_CONFLICT");
    const auto value = storeBrowserSidText(sid);
    if (value == wide(currentIdentity().sid) && !user) user = true;
    else if (value == L"S-1-5-18" && !system) system = true;
    else fail("BROWSER_REGISTRATION_CONFLICT");
  }
  if (!user || !system) fail("BROWSER_REGISTRATION_CONFLICT");
}
inline std::string storeBrowserKeyValue(HKEY key) {
  storeBrowserKeyAcl(key); DWORD children = 0, values = 0;
  check(RegQueryInfoKeyW(key, nullptr, nullptr, nullptr, &children, nullptr, nullptr, &values, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS,
    "BROWSER_REGISTRATION_CONFLICT");
  if (children || values != 1) fail("BROWSER_REGISTRATION_CONFLICT");
  wchar_t path[32768]{}; DWORD type = 0, bytes = sizeof(path);
  check(RegQueryValueExW(key, nullptr, nullptr, &type, reinterpret_cast<BYTE*>(path), &bytes) == ERROR_SUCCESS, "BROWSER_REGISTRATION_CONFLICT");
  if (type != REG_SZ || bytes < 4 || bytes > sizeof(path) || bytes % 2 || path[bytes / 2 - 1] != L'\0') fail("BROWSER_REGISTRATION_CONFLICT");
  const std::wstring text(path, bytes / 2 - 1);
  if (text.find(L'\0') != std::wstring::npos) fail("BROWSER_REGISTRATION_CONFLICT"); return utf8(text);
}
inline std::string storeBrowserRegistryValue(REGSAM view) {
  RegistryHandle key; const auto status = RegOpenKeyExW(HKEY_CURRENT_USER, storeBrowserKey().c_str(), 0,
    KEY_QUERY_VALUE | READ_CONTROL | view, &key.key);
  if (status == ERROR_FILE_NOT_FOUND) return {};
  if (status != ERROR_SUCCESS) fail("BROWSER_REGISTRATION_CONFLICT"); return storeBrowserKeyValue(key.key);
}
inline bool storeBrowserOrdinaryOwned(const std::string& path) {
  for (const auto view : {KEY_WOW64_32KEY, KEY_WOW64_64KEY}) {
    const auto query = storeBrowserOrdinaryQuery(view);
    if (query.exitCode != 0 || !mmstorebrowserpolicy::ordinaryQueryMatches(query.output, path)) return false;
  }
  return true;
}
inline void storeBrowserRegistryTransaction(const std::string& oldPath, const std::string& newPath) {
  Handle transaction(CreateTransaction(nullptr, nullptr, TRANSACTION_DO_NOT_PROMOTE, 0, 0, 25000, nullptr));
  check(transaction.valid(), "BROWSER_REGISTRATION_CONFLICT"); std::vector<std::unique_ptr<RegistryHandle>> held;
  const auto sddl = L"O:" + wide(currentIdentity().sid) + L"D:P(A;;KA;;;" + wide(currentIdentity().sid) + L")(A;;KA;;;SY)";
  Security security(sddl);
  for (const auto view : {KEY_WOW64_32KEY, KEY_WOW64_64KEY}) {
    auto key = std::make_unique<RegistryHandle>(); const auto opened = RegOpenKeyTransactedW(HKEY_CURRENT_USER, storeBrowserKey().c_str(), 0,
      KEY_QUERY_VALUE | KEY_SET_VALUE | READ_CONTROL | DELETE | view, &key->key, transaction.value, nullptr);
    if (newPath.empty() && opened == ERROR_KEY_DELETED && !held.empty()) continue;
    if (opened == ERROR_SUCCESS) {
      const auto actual = storeBrowserKeyValue(key->key);
      if (actual != oldPath && !(actual == newPath && !held.empty() && !newPath.empty())) fail("BROWSER_REGISTRATION_CONFLICT");
    } else if (opened == ERROR_FILE_NOT_FOUND) {
      if (!oldPath.empty()) fail("BROWSER_REGISTRATION_CONFLICT");
    } else fail("BROWSER_REGISTRATION_CONFLICT");
    if (newPath.empty()) {
      if (opened == ERROR_SUCCESS)
        check(RegDeleteKeyTransactedW(HKEY_CURRENT_USER, storeBrowserKey().c_str(), view, 0, transaction.value, nullptr) == ERROR_SUCCESS,
          "BROWSER_REGISTRATION_CONFLICT");
    } else {
      if (opened == ERROR_FILE_NOT_FOUND) {
        DWORD created = 0; SECURITY_ATTRIBUTES attributes{sizeof(attributes), security.descriptor, FALSE};
        check(RegCreateKeyTransactedW(HKEY_CURRENT_USER, storeBrowserKey().c_str(), 0, nullptr, 0,
          KEY_QUERY_VALUE | KEY_SET_VALUE | READ_CONTROL | view, &attributes, &key->key, &created, transaction.value, nullptr) == ERROR_SUCCESS &&
          created == REG_CREATED_NEW_KEY, "BROWSER_REGISTRATION_CONFLICT");
      }
      const auto target = wide(newPath);
      check(RegSetValueExW(key->key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(target.c_str()),
        static_cast<DWORD>((target.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS, "BROWSER_REGISTRATION_CONFLICT");
      storeBrowserKeyAcl(key->key);
    }
    held.emplace_back(std::move(key));
  }
  check(CommitTransaction(transaction.value), "BROWSER_REGISTRATION_CONFLICT"); held.clear();
}
inline Json storeBrowserStatus(const StoreBrowserFiles& files, const char* state) {
  const bool registered = std::strcmp(state, "registered") == 0;
  return Json::Object{{"version", 1}, {"registered", registered}, {"state", state},
    {"package_full_name", utf8(files.package.observation().fullName)}, {"manifest_sha256", files.manifest.pin().sha256},
    {"launch_target", "current-package"}, {"alias_required", false}, {"ordinary_registry_verified", registered},
    {"extension_id", std::string(mmstorebrowserpolicy::extensionId)}};
}
inline Json dispatchStoreBrowserRegistration(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data, const Json& args) {
  const auto intent = mmstorebrowserpolicy::parseIntent(args);
  if (boot.package.kind() != mmstore::PackageKind::gui || boot.parent.role() != mmstore::CodeRole::guiApplication ||
      boot.self.role() != mmstore::CodeRole::guiNative) fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); boot.package.revalidate(); data.revalidate();
  auto files = storeBrowserFiles(boot.package); const auto desired = storeBrowserDesired(files);
  VaultNamespaceLock serialize("account");
  auto old = browserReadProtected("store_browser_registration"); auto pending = browserReadProtected("store_browser_change");
  if (!jsonNull(old)) storeBrowserValidateRecord(old, boot.package);
  std::string current32, current64;
  try { current32 = storeBrowserRegistryValue(KEY_WOW64_32KEY); current64 = storeBrowserRegistryValue(KEY_WOW64_64KEY); }
  catch (const Failure& error) { if (intent == mmstorebrowserpolicy::Intent::inspect && error.code == "BROWSER_REGISTRATION_CONFLICT") return storeBrowserStatus(files, "conflict"); throw; }
  const auto oldPath = jsonNull(old) ? std::string{} : old.at("manifest_path").string();
  if (current32 != current64) {
    if (intent == mmstorebrowserpolicy::Intent::inspect) return storeBrowserStatus(files, "conflict");
    fail("BROWSER_REGISTRATION_CONFLICT");
  }
  if (!jsonNull(pending)) {
    keys(pending, {"version", "intent", "old", "desired", "before_path"});
    if (pending.at("version").integer() != 1 ||
        (pending.at("intent").string() != "register" && pending.at("intent").string() != "remove") ||
        mm::dump(pending.at("old")) != mm::dump(old)) fail("BROWSER_REGISTRATION_CONFLICT");
    if (!jsonNull(pending.at("old"))) storeBrowserValidateRecord(pending.at("old"), boot.package);
    if (!jsonNull(pending.at("desired"))) storeBrowserValidateRecord(pending.at("desired"), boot.package);
    const auto before = pending.at("before_path").string();
    if ((!before.empty() && before != oldPath) ||
        (pending.at("intent").string() == "register") != !jsonNull(pending.at("desired"))) fail("BROWSER_REGISTRATION_CONFLICT");
    const auto after = jsonNull(pending.at("desired")) ? std::string{} : pending.at("desired").at("manifest_path").string();
    if (current32 != before && current32 != after) fail("BROWSER_REGISTRATION_CONFLICT");
    if (intent == mmstorebrowserpolicy::Intent::inspect) return storeBrowserStatus(files, "repair-required");
    if (!current32.empty() && !storeBrowserOrdinaryOwned(current32)) fail("BROWSER_REGISTRATION_CONFLICT");
    // Recover only the exact protected intent and the matching actual owned key
    // bytes. A stale servicing generation is ownership history, never code trust.
    if (current32 == after) {
      if (jsonNull(pending.at("desired"))) { browserEraseProtected("store_browser_registration"); old = nullptr; }
      else { old = pending.at("desired"); browserWriteProtected("store_browser_registration", old); }
    }
    browserEraseProtected("store_browser_change"); pending = nullptr;
  }
  const auto effectivePath = jsonNull(old) ? std::string{} : old.at("manifest_path").string();
  if (!current32.empty() && current32 != effectivePath) {
    if (intent == mmstorebrowserpolicy::Intent::inspect) return storeBrowserStatus(files, "conflict");
    fail("BROWSER_REGISTRATION_CONFLICT");
  }
  if (intent == mmstorebrowserpolicy::Intent::inspect) {
    if (current32.empty()) return storeBrowserStatus(files, "absent");
    if (mm::dump(old) != mm::dump(desired)) return storeBrowserStatus(files, "repair-required");
    if (!storeBrowserOrdinaryOwned(current32)) return storeBrowserStatus(files, "conflict");
    files.revalidate(); boot.self.revalidate(); boot.parent.revalidate(); data.revalidate();
    return storeBrowserStatus(files, "registered");
  }
  if (!current32.empty() && !storeBrowserOrdinaryOwned(current32)) fail("BROWSER_REGISTRATION_CONFLICT");
  const bool remove = intent == mmstorebrowserpolicy::Intent::removal;
  const auto nextPath = remove ? std::string{} : desired.at("manifest_path").string();
  if (remove && current32.empty() && jsonNull(old)) return storeBrowserStatus(files, "absent");
  if (!remove && current32 == nextPath && mm::dump(old) == mm::dump(desired)) {
    files.revalidate(); data.revalidate(); return storeBrowserStatus(files, "registered");
  }
  browserWriteProtected("store_browser_change", Json::Object{{"version", 1}, {"intent", remove ? "remove" : "register"},
    {"old", old}, {"desired", remove ? Json(nullptr) : desired}, {"before_path", current32}});
  files.revalidate(); boot.self.revalidate(); boot.parent.revalidate(); data.revalidate();
  storeBrowserRegistryTransaction(current32, nextPath);
  if (storeBrowserRegistryValue(KEY_WOW64_32KEY) != nextPath || storeBrowserRegistryValue(KEY_WOW64_64KEY) != nextPath)
    fail("BROWSER_REGISTRATION_CONFLICT");
  if (!remove && !storeBrowserOrdinaryOwned(nextPath)) fail("BROWSER_REGISTRATION_CONFLICT");
  if (remove) {
    // The fixed ordinary queries must also report no default value after the
    // exact owned key removal; any successful read is a namespace conflict.
    for (const auto view : {KEY_WOW64_32KEY, KEY_WOW64_64KEY})
      if (storeBrowserOrdinaryQuery(view).exitCode != 1) fail("BROWSER_REGISTRATION_CONFLICT");
  }
  files.revalidate(); boot.self.revalidate(); boot.parent.revalidate(); data.revalidate();
  if (remove) browserEraseProtected("store_browser_registration"); else browserWriteProtected("store_browser_registration", desired);
  browserEraseProtected("store_browser_change"); return storeBrowserStatus(files, remove ? "absent" : "registered");
}

inline Json storeBrowserWireIdentity(const mmstore::ProcessIdentity& value) {
  return Json::Object{{"sid", utf8(value.sid)}, {"session_id", static_cast<std::int64_t>(value.sessionId)},
    {"pid", static_cast<std::int64_t>(value.pid)}, {"creation_time", utf8(value.creationTime)}};
}
inline mmstore::FilePin storeBrowserRolePin(const StoreBrowserFiles& files, mmstore::CodeRole role) {
  const auto bytes = files.inventory.read(8 * 1024 * 1024);
  const auto inventory = mmstoreinventory::parse(mmstore::PackageKind::gui,
    mm::JsonParser::storeCodeInventory(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
  return mmstoreinventory::codePin(inventory, role);
}
struct StoreBrowserChromePeer {
  Handle process;
  std::vector<Handle> parents;
  Handle code;
  mmstore::ProcessIdentity identity;
  std::wstring path;
  BY_HANDLE_FILE_INFORMATION birth{};
  std::string digest;
  void revalidate(bool live = true) const {
    if (live && WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT) fail("PEER_DENIED");
    const auto user = mmstore::detail::logon(process.value);
    if (user.sid != identity.sid || user.logonSid != identity.logonSid || user.session != identity.sessionId ||
        mmstore::detail::creation(process.value) != std::stoull(identity.creationTime) ||
        !mmstore::detail::samePath(mmstore::detail::processImage(process.value), path) ||
        !mmstore::detail::sameFile(birth, storeBrowserBirth(code.value)) ||
        _wcsicmp(nativeCanonical(code.value).c_str(), path.c_str()) || hashFile(code.value) != digest) fail("PEER_DENIED");
  }
};
inline StoreBrowserChromePeer storeBrowserChromePeer(std::uint64_t window) {
  const auto input = GetStdHandle(STD_INPUT_HANDLE), output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE) fail("PEER_DENIED");
  ULONG first = 0, second = 0;
  // Anonymous Chromium STDIO support requires its own physical acceptance. A
  // failing kernel query is denied; an argv parent or receipt is no substitute.
  check(GetNamedPipeServerProcessId(input, &first) && GetNamedPipeServerProcessId(output, &second), "PEER_DENIED");
  if (!first || first != second || first == GetCurrentProcessId()) fail("PEER_DENIED");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, first));
  if (!process.valid() || WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT) fail("PEER_DENIED");
  const auto user = mmstore::detail::logon(process.value), current = mmstore::detail::logon(GetCurrentProcess());
  if (user.sid != current.sid || user.logonSid != current.logonSid || user.session != current.session) fail("PEER_DENIED");
  USHORT machine = 0, native = 0;
  check(IsWow64Process2(process.value, &machine, &native) && native == IMAGE_FILE_MACHINE_AMD64 &&
    (machine == IMAGE_FILE_MACHINE_UNKNOWN || machine == IMAGE_FILE_MACHINE_I386), "PEER_DENIED");
  const auto registered = registeredChromePath(), path = mmstore::detail::processImage(process.value);
  if (!mmstore::detail::samePath(path, registered)) fail("PEER_DENIED");
  auto parents = lockExportParents(path); auto code = storeBrowserRegular(path, true);
  if (!chromeProductIdentity(path)) fail("PEER_DENIED");
  (void)trustedPePublisher(path, code.value, true, PeTrustPolicy::FreshApproval, L"Google LLC");
  if (window) {
    if (window > UINTPTR_MAX) fail("PEER_DENIED"); DWORD owner = 0;
    const auto handle = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(window));
    if (!IsWindow(handle) || !GetWindowThreadProcessId(handle, &owner) || owner != first) fail("PEER_DENIED");
  }
  const auto birth = storeBrowserBirth(code.value); const auto digest = hashFile(code.value);
  const auto processBirth = std::to_wstring(mmstore::detail::creation(process.value));
  StoreBrowserChromePeer peer{std::move(process), std::move(parents), std::move(code),
    {user.sid, user.logonSid, processBirth, user.session, first}, path, birth, digest};
  peer.revalidate(); return peer;
}
inline DWORD storeBrowserTransfer(HANDLE pipe, void* bytes, DWORD length, bool write, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); check(event.valid(), "PIPE_UNAVAILABLE");
  OVERLAPPED op{}; op.hEvent = event.value; DWORD count = 0;
  if (GetTickCount64() >= deadline) fail("TIMEOUT");
  const BOOL started = write ? WriteFile(pipe, bytes, length, &count, &op) : ReadFile(pipe, bytes, length, &count, &op);
  if (!started) {
    const auto error = GetLastError();
    if (!write && count == 0 && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)) return 0;
    if (error != ERROR_IO_PENDING) fail("PIPE_UNAVAILABLE");
    const auto now = GetTickCount64(); const auto budget = now < deadline ? static_cast<DWORD>(deadline - now) : 0;
    if (WaitForSingleObject(event.value, budget) != WAIT_OBJECT_0) {
      (void)CancelIoEx(pipe, &op); (void)GetOverlappedResult(pipe, &op, &count, TRUE); fail("TIMEOUT");
    }
    if (!GetOverlappedResult(pipe, &op, &count, FALSE)) {
      const auto completedError = GetLastError();
      if (!write && count == 0 && (completedError == ERROR_BROKEN_PIPE || completedError == ERROR_PIPE_NOT_CONNECTED)) return 0;
      fail("PIPE_UNAVAILABLE");
    }
  }
  if (count > length || (write && !count)) fail("PIPE_UNAVAILABLE"); return count;
}
inline void storeBrowserSendLine(HANDLE pipe, const Json& value, ULONGLONG deadline) {
  auto text = mm::dump(value) + "\n"; if (text.size() > 4096) fail("FRAME_TOO_LARGE"); std::size_t at = 0;
  while (at < text.size()) at += storeBrowserTransfer(pipe, text.data() + at, static_cast<DWORD>(text.size() - at), true, deadline);
  SecureZeroMemory(text.data(), text.size());
}
inline Json storeBrowserReceiveLine(HANDLE pipe, ULONGLONG deadline) {
  std::string text;
  for (;;) {
    char byte = 0; if (storeBrowserTransfer(pipe, &byte, 1, false, deadline) != 1) fail("PEER_DENIED");
    if (byte == '\n') break;
    if (text.size() >= 4095 || byte == '\r' || byte == '\0') fail("PEER_DENIED"); text.push_back(byte);
  }
  const auto value = mm::JsonParser(text).parse(); SecureZeroMemory(text.data(), text.size()); return value;
}
inline std::wstring storeBrowserAttachPipe(DWORD host, const std::string& nonce) {
  if (!host || !mmstore::validDigest(nonce)) fail("BAD_REQUEST");
  return L"\\\\.\\pipe\\MusicMuteStoreChromeAttach-" + std::to_wstring(host) + L"-" + wide(nonce);
}
inline void storeBrowserConnectOwned(HANDLE pipe, HANDLE child, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); check(event.valid(), "PIPE_UNAVAILABLE");
  OVERLAPPED op{}; op.hEvent = event.value;
  if (ConnectNamedPipe(pipe, &op)) return;
  const auto error = GetLastError(); if (error == ERROR_PIPE_CONNECTED) return;
  if (error != ERROR_IO_PENDING) fail("PIPE_UNAVAILABLE");
  HANDLE waits[]{event.value, child}; const auto now = GetTickCount64();
  const auto result = WaitForMultipleObjects(2, waits, FALSE, now < deadline ? static_cast<DWORD>(deadline - now) : 0);
  if (result != WAIT_OBJECT_0) {
    (void)CancelIoEx(pipe, &op); DWORD completed = 0; (void)GetOverlappedResult(pipe, &op, &completed, TRUE);
    fail(result == WAIT_TIMEOUT ? "TIMEOUT" : "PEER_DENIED");
  }
  DWORD completed = 0; check(GetOverlappedResult(pipe, &op, &completed, FALSE), "PIPE_UNAVAILABLE");
}
inline Json attachStoreBrowserHost(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data, const Json& args) {
  mmstorebrowserpolicy::validateAttachInput(args);
  if (boot.package.kind() != mmstore::PackageKind::gui || boot.parent.role() != mmstore::CodeRole::guiApplication ||
      boot.self.role() != mmstore::CodeRole::guiNative) fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); data.revalidate();
  auto files = storeBrowserFiles(boot.package); const auto hostPid = mmstorebrowserpolicy::pid(args.at("host_pid"));
  if (hostPid == boot.self.identity().pid || hostPid == boot.parent.identity().pid) fail("PEER_DENIED");
  auto host = mmstore::attestProcess(hostPid, mmstore::CodeRole::guiChromeHost, files.host.pin());
  if (host.observation().fullName != boot.package.observation().fullName) fail("PEER_DENIED");
  const auto nonce = args.at("nonce").string(); const auto pipeName = storeBrowserAttachPipe(hostPid, nonce);
  const auto deadline = GetTickCount64() + 35000; Handle pipe;
  for (;;) {
    pipe = Handle(CreateFileW(pipeName.c_str(), FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, nullptr,
      OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (pipe.valid()) break;
    const auto error = GetLastError(); if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) fail("PIPE_UNAVAILABLE");
    if (GetTickCount64() >= deadline) fail("TIMEOUT"); host.revalidate(); Sleep(5);
  }
  ULONG actual = 0; check(GetNamedPipeServerProcessId(pipe.value, &actual) && actual == hostPid, "PEER_DENIED");
  host.revalidate(); boot.self.revalidate(); boot.parent.revalidate(); data.revalidate();
  storeBrowserSendLine(pipe.value, Json::Object{{"version", 1}, {"nonce", nonce},
    {"origin", std::string(mmstorebrowserpolicy::origin)}, {"helper", storeBrowserWireIdentity(boot.self.identity())},
    {"gui", storeBrowserWireIdentity(boot.parent.identity())}}, deadline);
  const auto reply = storeBrowserReceiveLine(pipe.value, deadline);
  keys(reply, {"version", "accepted", "nonce", "host", "gui", "chrome", "origin", "package_full_name"});
  if (reply.at("version").integer() != 1 || !std::get<bool>(reply.at("accepted").value) ||
      !equalSecret(reply.at("nonce").string(), nonce) || reply.at("origin").string() != mmstorebrowserpolicy::origin ||
      reply.at("package_full_name").string() != utf8(boot.package.observation().fullName) ||
      mm::dump(reply.at("host")) != mm::dump(storeBrowserWireIdentity(host.identity())) ||
      mm::dump(reply.at("gui")) != mm::dump(storeBrowserWireIdentity(boot.parent.identity()))) fail("PEER_DENIED");
  keys(reply.at("chrome"), {"sid", "session_id", "pid", "creation_time"});
  const auto chromePid = mmstorebrowserpolicy::pid(reply.at("chrome").at("pid"));
  Handle chrome(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, chromePid));
  if (!chrome.valid() || chromePid == hostPid || chromePid == boot.parent.identity().pid || chromePid == boot.self.identity().pid ||
      reply.at("chrome").at("sid").string() != utf8(boot.self.identity().sid) ||
      reply.at("chrome").at("session_id").integer() != boot.self.identity().sessionId ||
      reply.at("chrome").at("creation_time").string() != creation(chrome.value)) fail("PEER_DENIED");
  const auto chromeUser = mmstore::detail::logon(chrome.value);
  if (chromeUser.sid != boot.self.identity().sid || chromeUser.logonSid != boot.self.identity().logonSid ||
      chromeUser.session != boot.self.identity().sessionId || WaitForSingleObject(chrome.value, 0) != WAIT_TIMEOUT) fail("PEER_DENIED");
  char extra = 0; if (storeBrowserTransfer(pipe.value, &extra, 1, false, deadline) != 0) fail("PEER_DENIED");
  host.revalidate(); boot.self.revalidate(); boot.parent.revalidate(); files.revalidate(); data.revalidate();
  auto response = reply.object(); response.erase("nonce"); return response;
}
inline int runStoreChromeHost(const std::wstring& origin, const std::wstring& parentArgument) {
  mmstorebrowserpolicy::validateOrigin(utf8(origin)); const auto window = mmstorebrowserpolicy::parentWindow(parentArgument);
  const auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui);
  auto data = mmstorenamespace::PrivateNamespaceAuthority::open(package); auto files = storeBrowserFiles(package);
  auto self = mmstore::attestProcess(GetCurrentProcessId(), mmstore::CodeRole::guiChromeHost, files.host.pin());
  if (self.observation().fullName != package.observation().fullName ||
      mmstore::currentPackageFullName() != package.observation().fullName) fail("PEER_DENIED");
  auto chrome = storeBrowserChromePeer(window); auto nonce = randomHex();
  const auto pipeName = storeBrowserAttachPipe(GetCurrentProcessId(), nonce);
  Security pipeSecurity(L"O:" + wide(currentIdentity().sid) + L"D:P(A;;FA;;;" + wide(currentIdentity().sid) + L")(A;;FA;;;SY)");
  Handle server(CreateNamedPipeW(pipeName.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &pipeSecurity.attributes));
  check(server.valid(), "PIPE_UNAVAILABLE");
  const auto app = files.application.absolutePath(); const auto directory = app.substr(0, app.find_last_of(L'\\'));
  const auto resources = directory + L"\\resources";
  auto command = quote(app) + L" --native-browser-stdio --origin " + quote(origin) + L" --resources " + quote(resources) +
    L" --store-browser-host " + std::to_wstring(GetCurrentProcessId()) + L" --store-browser-nonce " + quote(wide(nonce));
  Handle input = inheritedCopy(GetStdHandle(STD_INPUT_HANDLE), 0, true), output = inheritedCopy(GetStdHandle(STD_OUTPUT_HANDLE), 0, true),
    error = inheritedCopy(GetStdHandle(STD_ERROR_HANDLE), 0, true);
  SIZE_T attributeBytes = 0; InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeBytes);
  std::vector<BYTE> storage(attributeBytes); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  check(InitializeProcThreadAttributeList(attributes, 2, 0, &attributeBytes), "JOB_UNAVAILABLE");
  DWORD desktopPolicy = 0;
  struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } attributeLifetime{attributes};
  HANDLE inherited[]{input.value, output.value, error.value};
  check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr), "JOB_UNAVAILABLE");
  check(mmstoredesktop::apply(attributes, desktopPolicy), "JOB_UNAVAILABLE");
  STARTUPINFOEXW start{}; start.StartupInfo.cb = sizeof(start); start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  start.StartupInfo.hStdInput = input.value; start.StartupInfo.hStdOutput = output.value; start.StartupInfo.hStdError = error.value; start.lpAttributeList = attributes;
  Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.valid(), "JOB_UNAVAILABLE");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "JOB_UNAVAILABLE");
  auto environment = consumerEnvironment(directory); PROCESS_INFORMATION created{}; files.revalidate(); self.revalidate(); chrome.revalidate(); data.revalidate();
  check(CreateProcessW(app.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(), directory.c_str(), &start.StartupInfo, &created), "JOB_UNAVAILABLE");
  Handle process(created.hProcess), thread(created.hThread);
  if (!AssignProcessToJobObject(job.value, process.value)) {
    check(TerminateProcess(process.value, 2), "JOB_UNAVAILABLE");
    check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "JOB_UNAVAILABLE"); fail("JOB_UNAVAILABLE");
  }
  try {
    // This owned CreateProcess result is the issuer table, not an imported PID
    // or a selected-parent attribute. Keep the actual child handle/birth alive.
    auto child = mmstore::attestProcess(created.dwProcessId, mmstore::CodeRole::guiApplication, files.application.pin());
    if (child.observation().fullName != self.observation().fullName ||
        mmstore::detail::parentPid(child.identity().pid) != self.identity().pid) fail("PEER_DENIED");
    BOOL member = FALSE; check(IsProcessInJob(process.value, job.value, &member) && member, "JOB_UNAVAILABLE");
    self.revalidate(); child.revalidate(); chrome.revalidate(); files.revalidate(); data.revalidate();
    check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "JOB_UNAVAILABLE");
    input.close(); output.close(); error.close(); const auto deadline = GetTickCount64() + 35000;
    storeBrowserConnectOwned(server.value, process.value, deadline);
    ULONG actualClient = 0, actualServer = 0;
    check(GetNamedPipeClientProcessId(server.value, &actualClient) && GetNamedPipeServerProcessId(server.value, &actualServer) &&
      actualServer == self.identity().pid, "PEER_DENIED");
    const auto helperPin = storeBrowserRolePin(files, mmstore::CodeRole::guiNative);
    auto helper = mmstore::attestProcess(actualClient, mmstore::CodeRole::guiNative, helperPin);
    if (helper.observation().fullName != self.observation().fullName || helper.identity().pid == child.identity().pid ||
        mmstore::detail::parentPid(helper.identity().pid) != child.identity().pid ||
        mmstore::detail::creation(child.handle()) > mmstore::detail::creation(helper.handle())) fail("PEER_DENIED");
    const auto request = storeBrowserReceiveLine(server.value, deadline);
    keys(request, {"version", "nonce", "origin", "helper", "gui"});
    if (request.at("version").integer() != 1 || !equalSecret(request.at("nonce").string(), nonce) ||
        request.at("origin").string() != mmstorebrowserpolicy::origin ||
        mm::dump(request.at("helper")) != mm::dump(storeBrowserWireIdentity(helper.identity())) ||
        mm::dump(request.at("gui")) != mm::dump(storeBrowserWireIdentity(child.identity()))) fail("PEER_DENIED");
    // The sealed helper reaches store_browser_attach only after the GUI's own
    // one-use actual spawned-helper issuer and private bootstrap succeeded.
    // A package image/selected PPID alone has no attach operation authority.
    helper.revalidate(); child.revalidate(); self.revalidate(); chrome.revalidate(); data.revalidate(); files.revalidate();
    storeBrowserSendLine(server.value, Json::Object{{"version", 1}, {"accepted", true}, {"nonce", nonce},
      {"host", storeBrowserWireIdentity(self.identity())}, {"gui", storeBrowserWireIdentity(child.identity())},
      {"chrome", storeBrowserWireIdentity(chrome.identity)}, {"origin", std::string(mmstorebrowserpolicy::origin)},
      {"package_full_name", utf8(package.observation().fullName)}}, deadline);
    server.close(); SecureZeroMemory(nonce.data(), nonce.size());
    // The sealed proxy uses the existing shared Unicode/framing/command/account
    // contracts. The native launcher neither handles nor receives account tokens.
    const auto wait = WaitForSingleObject(process.value, INFINITE); check(wait == WAIT_OBJECT_0, "JOB_UNAVAILABLE");
    DWORD result = 2; check(GetExitCodeProcess(process.value, &result), "JOB_UNAVAILABLE");
    // On Chrome EOF, the proxy closes its private helpers. Unexpected lingering
    // descendants remain confined to this Job and are positively retired.
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    check(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "JOB_UNAVAILABLE");
    if (accounting.ActiveProcesses) check(TerminateJobObject(job.value, 2), "JOB_UNAVAILABLE");
    storeBrowserWaitJobZero(job.value); files.revalidate(); data.revalidate();
    return result == 0 ? 0 : 2;
  } catch (...) {
    check(TerminateJobObject(job.value, 2), "JOB_UNAVAILABLE");
    check(WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0, "JOB_UNAVAILABLE");
    storeBrowserWaitJobZero(job.value); throw;
  }
}
#endif // _WIN32 implementation
