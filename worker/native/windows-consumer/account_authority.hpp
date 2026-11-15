#pragma once

std::wstring fixedAccountAppPath() {
  const auto launcher = fixedLauncherPath();
  return launcher.substr(0, launcher.find_last_of(L'\\')) + L"\\MusicMute Local.exe";
}
std::vector<Handle> lockAccountAppAncestors(const std::wstring& path) {
  const auto app = fixedAccountAppPath(), root = app.substr(0, app.find_last_of(L'\\'));
  if (path.size() <= root.size() || _wcsnicmp(path.c_str(), root.c_str(), root.size()) != 0 || path[root.size()] != L'\\') fail("PATH_UNSAFE");
  std::vector<Handle> result;
  const auto last = path.find_last_of(L'\\');
  for (std::size_t end = 3; end <= last;) {
    const auto component = path.substr(0, end);
    auto handle = openEntry(component, true, false);
    if (component.size() >= root.size()) assertPrivateHandle(handle.value, false, true);
    result.push_back(std::move(handle));
    if (end == last) break;
    const auto next = path.find(L'\\', end + 1); end = next == std::wstring::npos || next > last ? last : next;
  }
  return result;
}
Json installedAccountAppPin() {
  const auto entry = fixedBrowserEntryPath();
  const auto path = entry.substr(0, entry.find_last_of(L'\\')) + L"\\account-authority-manifest.json";
  auto ancestors = lockAccountAppAncestors(path);
  auto file=std::move(openNativeChild(ancestors.back().value,path.substr(path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open).handle);
  if (!file.valid()) fail("HELPER_INTEGRITY_INVALID");
  BY_HANDLE_FILE_INFORMATION info{};
  check(GetFileInformationByHandle(file.value, &info), "PATH_UNSAFE");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1) fail("PATH_UNSAFE");
  assertPrivateHandle(file.value, false, true);
  std::vector<wchar_t> canonical(32768); const auto count = GetFinalPathNameByHandleW(file.value, canonical.data(), static_cast<DWORD>(canonical.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!count || count >= canonical.size()) fail("PATH_UNSAFE");
  std::wstring actual(canonical.data(), count); if (actual.starts_with(L"\\\\?\\")) actual.erase(0, 4); if (_wcsicmp(actual.c_str(), path.c_str()) != 0) fail("PATH_UNSAFE");
  LARGE_INTEGER size{}; check(GetFileSizeEx(file.value, &size), "HELPER_INTEGRITY_INVALID");
  if (size.QuadPart < 2 || size.QuadPart > 1024) fail("HELPER_INTEGRITY_INVALID");
  std::string bytes(static_cast<std::size_t>(size.QuadPart), '\0'); DWORD read = 0;
  check(ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) && read == bytes.size(), "HELPER_INTEGRITY_INVALID");
  const auto record = mm::JsonParser(bytes).parse();
  keys(record, {"version", "sha256", "bytes", "publisherSha256"});
  if (record.at("version").integer() != 1) fail("HELPER_INTEGRITY_INVALID");
  return Json::Object{{"app_sha256", record.at("sha256")}, {"app_bytes", record.at("bytes")}, {"publisher_sha256", record.at("publisherSha256")}};
}
Handle verifiedAccountApp(const Json& args) {
  const auto path = fixedAccountAppPath();
  auto file = lockHashedFile(path, args.at("app_sha256").string(), true, 256ULL * 1024 * 1024);
  LARGE_INTEGER size{};
  check(GetFileSizeEx(file.value, &size), "HELPER_INTEGRITY_INVALID");
  if (size.QuadPart < 1 || size.QuadPart > 256LL * 1024 * 1024 || size.QuadPart != args.at("app_bytes").integer()) fail("HELPER_INTEGRITY_INVALID");
  // The sealed application's previously approved inventory pins these exact
  // fixed-path bytes, size and publisher. Ordinary installed peer/Share checks
  // may use cached revocation; fresh installer approval never takes this path.
  verifyInstallerPublisher(path, file.value, args.at("publisher_sha256").string(),false,PeTrustPolicy::ApprovedInstalledCache);
  return file;
}
std::wstring liveAccountPeerImage(const Json& expected) {
  const auto pid = expected.at("pid").integer();
  if (pid < 1 || pid > 2147483647 || expected.at("sid").string() != currentIdentity().sid || expected.at("session_id").integer() != currentIdentity().session ||
      mm::dump(processIdentity(static_cast<DWORD>(pid))) != mm::dump(expected)) fail("PEER_DENIED");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid)));
  if (!process.valid() || creation(process.value) != expected.at("creation_time").string()) fail("PEER_DENIED");
  std::wstring image(32768, L'\0'); DWORD count = static_cast<DWORD>(image.size());
  check(QueryFullProcessImageNameW(process.value, 0, image.data(), &count), "PEER_DENIED");
  image.resize(count); return image;
}
Json launchAccountAuthority(const Json& args) {
  const auto singleton = inspectSingletonOwner(Json::Object{{"scope", "account"}});
  if (singleton.at("state").string() == "active" && !std::get<bool>(singleton.at("same_session").value)) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
  const auto path = fixedAccountAppPath();
  auto ancestors = lockAccountAppAncestors(path);
  auto app = verifiedAccountApp(args);
  auto command = quote(path) + L" --headless-account";
  BOOL inJob = FALSE;
  check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob), "JOB_UNAVAILABLE");
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  const auto directory = path.substr(0, path.find_last_of(L'\\'));
  auto environment=consumerEnvironment(directory);
  check(CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE,
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | (inJob ? CREATE_BREAKAWAY_FROM_JOB : 0),
    environment.data(), directory.c_str(), &startup, &process), "JOB_UNAVAILABLE");
  Handle child(process.hProcess), thread(process.hThread);
  // No inherited pipe/Job handle ties the sole authority to Chrome or GUI lifetime.
  return Json::Object{{"identity", processIdentity(process.dwProcessId)}};
}
Json verifyAccountPeer(const Json& args) {
  const auto peer = args.at("identity"); const auto role = args.at("role").string();
  if (role != "authority" && role != "browser") fail("BAD_REQUEST");
  const auto helper = parentBinding(peer);
  const auto entry = fixedBrowserEntryPath();
  auto ancestors = lockAccountAppAncestors(entry);
  const auto helperPath = entry.substr(0, entry.find_last_of(L'\\')) + L"\\musicmute-native.exe";
  if (_wcsicmp(helper.image.c_str(), helperPath.c_str()) != 0 ||
      _wcsicmp(liveAccountPeerImage(helper.parent).c_str(), fixedAccountAppPath().c_str()) != 0) fail("PEER_DENIED");
  auto app = verifiedAccountApp(args);
  if(role=="authority") {
    const auto gated=liveSingletonOwner(singletonRecord("account"));
    if(jsonNull(gated)||mm::dump(gated)!=mm::dump(helper.parent))fail("PEER_DENIED");
  }
  if (role == "browser") {
    const auto appParent = parentBinding(helper.parent);
    if (_wcsicmp(liveAccountPeerImage(appParent.parent).c_str(), fixedChromeHostPath().c_str()) != 0) fail("PEER_DENIED");
    const auto registration = browserProtectedRecord();
    if (std::holds_alternative<std::nullptr_t>(registration.value)) fail("PEER_DENIED");
    assertOwnedBrowserRegistration(registration);
    auto host = lockHashedFile(fixedChromeHostPath(), registration.at("host_sha256").string(), true);
  }
  (void)liveAccountPeerImage(peer);
  return Json::Object{{"verified", true}};
}
Json verifyOwnerProofPeers(const Json& args, bool desktop) {
  const auto authority = args.at("authority"), browser = args.at("browser");
  // Only the already-published sole account authority may forward an owner
  // proof. A browser proxy with the same signed app image is not that authority.
  const auto encoded = vault("vault_get", Json::Object{{"namespace", "account"}, {"key", "browser_ticket"}});
  if (std::holds_alternative<std::nullptr_t>(encoded.value)) fail("PEER_DENIED");
  auto bytes = base64Decode(encoded.at("bytes_base64").string(), 4096);
  const auto ticket = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse();
  SecureZeroMemory(bytes.data(), bytes.size());
  const auto owner = ticket.at("owner");
  const auto expected = Json::Object{{"sid", owner.at("sid")}, {"session_id", owner.at("sessionId")}, {"pid", owner.at("pid")}, {"creation_time", owner.at("creationTime")}};
  FILETIME time{}; GetSystemTimeAsFileTime(&time);
  const auto millis = static_cast<std::int64_t>((static_cast<std::uint64_t>(time.dwHighDateTime) << 32 | time.dwLowDateTime) / 10000) - 11644473600000LL;
  if (ticket.at("version").integer() != 1 || ticket.at("expires_at").integer() <= millis || ticket.at("expires_at").integer() > millis + 35000) fail("PEER_DENIED");
  // The authority's separate SessionClient helper is allowed only when both
  // live helper births resolve to the same exact sole app parent birth.
  if (mm::dump(expected) != mm::dump(authority) && mm::dump(parentBinding(expected).parent) != mm::dump(parentBinding(authority).parent)) fail("PEER_DENIED");
  const auto pin = installedAccountAppPin();
  auto authorityArgs = pin.object(); authorityArgs.emplace("identity", authority); authorityArgs.emplace("role", "authority");
  (void)verifyAccountPeer(authorityArgs);
  if (desktop && mm::dump(parentBinding(authority).parent) != mm::dump(parentBinding(browser).parent)) fail("PEER_DENIED");
  auto browserArgs = pin.object(); browserArgs.emplace("identity", browser); browserArgs.emplace("role", desktop ? "authority" : "browser");
  (void)verifyAccountPeer(browserArgs);
  return Json::Object{{"verified", true}};
}
Json verifyBrowserOwnerProofPeers(const Json& args) { return verifyOwnerProofPeers(args, false); }
Json verifyPersonalOwnerProofPeers(const Json& args) {
  const auto kind=args.at("owner_kind").string(); if(kind!="desktop"&&kind!="chrome")fail("BAD_REQUEST");
  return verifyOwnerProofPeers(Json::Object{{"authority",args.at("authority")},{"browser",args.at("owner")}},kind=="desktop");
}
