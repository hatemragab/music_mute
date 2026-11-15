#pragma once

struct RegistryHandle {
  HKEY key = nullptr;
  ~RegistryHandle() { if (key) RegCloseKey(key); }
};
std::wstring fixedLauncherPath() {
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &folder))) fail("PATH_UNSAFE");
  std::wstring root(folder); CoTaskMemFree(folder);
  return root + L"\\Programs\\MusicMute Local\\MusicMuteSession.exe";
}
std::wstring fixedWorkerLauncherPath() { return rootPath("fleet") + L"\\bin\\MusicMuteSession.exe"; }
std::wstring startupCommand() {
  const auto command = quote(fixedWorkerLauncherPath()) + L" --startup";
  if (command.size() > 260) fail("PATH_UNSAFE");
  return command;
}
std::string hashFile(HANDLE file,std::uint64_t maximum=256*1024*1024ULL) {
  // Integrity checks hash the complete file, including when this retained
  // handle was previously read or hashed. The limit also covers the full file.
  LARGE_INTEGER start{};check(SetFilePointerEx(file,start,nullptr,FILE_BEGIN),"HELPER_INTEGRITY_INVALID");
  struct Hash {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    // The destructor body releases CNG before its backing-storage member.
    std::vector<BYTE> object;
    ~Hash() { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); }
  } state;
  if (BCryptOpenAlgorithmProvider(&state.algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) fail("HELPER_INTEGRITY_INVALID");
  std::string result;
  DWORD bytes = 0, objectSize = 0;
  if (BCryptGetProperty(state.algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &bytes, 0) != 0 || objectSize > 65536) fail("HELPER_INTEGRITY_INVALID");
  state.object.resize(objectSize);
  if (BCryptCreateHash(state.algorithm, &state.hash, state.object.data(), objectSize, nullptr, 0, 0) != 0) fail("HELPER_INTEGRITY_INVALID");
  std::vector<BYTE> data(65536); DWORD read = 0; std::uint64_t total = 0;
  for (;;) {
    if (!ReadFile(file, data.data(), static_cast<DWORD>(data.size()), &read, nullptr)) fail("HELPER_INTEGRITY_INVALID");
    if (read == 0) break;
    total += read; if (total > maximum) fail("HELPER_INTEGRITY_INVALID");
    if (BCryptHashData(state.hash, data.data(), read, 0) != 0) fail("HELPER_INTEGRITY_INVALID");
  }
  BYTE digest[32]{};
  if (BCryptFinishHash(state.hash, digest, 32, 0) != 0) fail("HELPER_INTEGRITY_INVALID");
  constexpr char hex[] = "0123456789abcdef";
  for (const auto byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  return result;
}
Handle lockHashedFile(const std::wstring& path, const std::string& expected, bool appBinary = false,std::uint64_t maximum=256*1024*1024ULL) {
  if (expected.size() != 64 || expected.find_first_not_of("0123456789abcdef") != std::string::npos) fail("HELPER_INTEGRITY_INVALID");
  auto file=std::move(openNativePath(path,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file).handle);
  if (!file.valid()) fail("HELPER_INTEGRITY_INVALID");
  BY_HANDLE_FILE_INFORMATION info{}; check(GetFileInformationByHandle(file.value, &info), "PATH_UNSAFE");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1) fail("PATH_UNSAFE");
  std::vector<wchar_t> canonicalBuffer(32768);
  const auto count = GetFinalPathNameByHandleW(file.value, canonicalBuffer.data(), static_cast<DWORD>(canonicalBuffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (count == 0 || count >= canonicalBuffer.size()) fail("PATH_UNSAFE");
  std::wstring canonical(canonicalBuffer.data(), count);
  if (canonical.starts_with(L"\\\\?\\")) canonical.erase(0, 4);
  if (_wcsicmp(canonical.c_str(), path.c_str()) != 0) fail("PATH_UNSAFE");
  assertPrivateHandle(file.value, false, appBinary);
  if (hashFile(file.value,maximum) != expected) fail("HELPER_INTEGRITY_INVALID");
  return file;
}
std::string startupState() {
  RegistryHandle run;
  const auto opened = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_QUERY_VALUE, &run.key);
  if (opened == ERROR_FILE_NOT_FOUND) return "absent";
  if (opened != ERROR_SUCCESS) fail("IDENTITY_UNAVAILABLE");
  wchar_t text[1024]{}; DWORD size = sizeof(text), type = 0;
  const auto queried = RegQueryValueExW(run.key, L"MusicMuteSession", nullptr, &type, reinterpret_cast<BYTE*>(text), &size);
  if (queried == ERROR_FILE_NOT_FOUND) return "absent";
  if (queried != ERROR_SUCCESS || type != REG_SZ || size < 2 || size % 2 != 0 || size > sizeof(text) || text[size / 2 - 1] != L'\0') return "conflict";
  if (std::wstring(text) != startupCommand() && std::wstring(text) != quote(fixedLauncherPath()) + L" --startup") return "conflict";
  // Read-only compatibility guard. Never edit StartupApproved or bypass the
  // user's OS setting; unknown record formats remain visibly unknown.
  RegistryHandle approval;
  const auto approvalOpened = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", 0, KEY_QUERY_VALUE, &approval.key);
  if (approvalOpened == ERROR_FILE_NOT_FOUND) return "registered";
  if (approvalOpened != ERROR_SUCCESS) return "unknown";
  BYTE flags[64]{}; size = sizeof(flags); type = 0;
  const auto approvalRead = RegQueryValueExW(approval.key, L"MusicMuteSession", nullptr, &type, flags, &size);
  if (approvalRead == ERROR_FILE_NOT_FOUND) return "registered";
  if (approvalRead != ERROR_SUCCESS || type != REG_BINARY || size != 12) return "unknown";
  DWORD state = 0; std::memcpy(&state, flags, sizeof(state));
  if (state == 3 || state == 7) return "disabled";
  if (state == 2 || state == 6) return "registered";
  return "unknown";
}
Json inspectStartup() { return Json::Object{{"state", startupState()}, {"scope", "HKCU"}, {"value_name", "MusicMuteSession"}}; }
Json registerStartup(const Json& args) {
  auto ancestors=lockAncestors(fixedWorkerLauncherPath(),false,false,rootPath("fleet"));
  auto executable = lockHashedFile(fixedWorkerLauncherPath(), args.at("launcher_sha256").string());
  const auto state = startupState();
  if (state == "conflict") fail("STARTUP_CONFLICT");
  // Moving an owned old command keeps the same Run value/StartupApproved state;
  // the OS disabled setting is never overwritten or re-enabled.
  if (state == "unknown") return inspectStartup();
  RegistryHandle run; DWORD disposition = 0;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr, 0, KEY_SET_VALUE, nullptr, &run.key, &disposition) != ERROR_SUCCESS) fail("IDENTITY_UNAVAILABLE");
  const auto command = startupCommand();
  if (RegSetValueExW(run.key, L"MusicMuteSession", 0, REG_SZ, reinterpret_cast<const BYTE*>(command.c_str()), static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t))) != ERROR_SUCCESS) fail("IDENTITY_UNAVAILABLE");
  return inspectStartup();
}
Json removeStartup() {
  const auto state = startupState();
  if (state == "absent") return inspectStartup();
  if (state == "conflict") fail("STARTUP_CONFLICT");
  RegistryHandle run;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE, &run.key) != ERROR_SUCCESS) fail("IDENTITY_UNAVAILABLE");
  const auto removed = RegDeleteValueW(run.key, L"MusicMuteSession");
  if (removed != ERROR_SUCCESS && removed != ERROR_FILE_NOT_FOUND) fail("IDENTITY_UNAVAILABLE");
  return inspectStartup();
}
Json legacyWorkerConflict() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.valid()) fail("IDENTITY_UNAVAILABLE");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) fail("IDENTITY_UNAVAILABLE");
  do { if (_wcsicmp(entry.szExeFile, L"MusicMuteWorkerService.exe") == 0) return Json::Object{{"conflict", true}}; } while (Process32NextW(snapshot.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) fail("IDENTITY_UNAVAILABLE");
  return Json::Object{{"conflict", false}};
}
Json launchSessionAgent(const Json& args) {
  const auto singleton = inspectSingletonOwner(Json::Object{{"scope", "session"}});
  if (singleton.at("state").string() == "active" && !std::get<bool>(singleton.at("same_session").value)) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
  const auto launcher = fixedWorkerLauncherPath();
  auto ancestors=lockAncestors(launcher,false,false,rootPath("fleet"));
  auto file = lockHashedFile(launcher, args.at("launcher_sha256").string());
  auto command = quote(launcher) + L" --on-demand";
  BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob), "JOB_UNAVAILABLE");
  const DWORD flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | (inJob ? CREATE_BREAKAWAY_FROM_JOB : 0);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
  check(CreateProcessW(launcher.c_str(), command.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr, &startup, &process), "JOB_UNAVAILABLE");
  Handle child(process.hProcess); Handle thread(process.hThread);
  return Json::Object{{"identity", processIdentity(process.dwProcessId)}};
}
