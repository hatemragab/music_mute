#pragma once

struct ParentBinding { Json parent; std::wstring image; };
ParentBinding parentBinding(const Json& expected) {
  const auto pid = expected.at("pid").integer();
  if (pid < 1 || pid > 2147483647 || expected.at("sid").string() != currentIdentity().sid || expected.at("session_id").integer() != currentIdentity().session) fail("PEER_DENIED");
  if (mm::dump(processIdentity(static_cast<DWORD>(pid))) != mm::dump(expected)) fail("PEER_DENIED");
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); if (!snapshot.valid()) fail("IDENTITY_UNAVAILABLE");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); DWORD parentPid = 0;
  check(Process32FirstW(snapshot.value, &entry), "IDENTITY_UNAVAILABLE");
  do { if (entry.th32ProcessID == pid) { parentPid = entry.th32ParentProcessID; break; } } while (Process32NextW(snapshot.value, &entry));
  if (parentPid == 0) fail("PEER_DENIED");
  const auto parent = processIdentity(parentPid);
  if (parent.at("sid").string() != currentIdentity().sid || parent.at("session_id").integer() != currentIdentity().session || std::stoull(parent.at("creation_time").string()) > std::stoull(expected.at("creation_time").string())) fail("PEER_DENIED");
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid))); if (!process.valid()) fail("PEER_DENIED");
  if (creation(process.value) != expected.at("creation_time").string()) fail("PEER_DENIED");
  std::wstring image(32768, L'\0'); DWORD count = static_cast<DWORD>(image.size());
  check(QueryFullProcessImageNameW(process.value, 0, image.data(), &count), "PEER_DENIED"); image.resize(count);
  return {parent, image};
}
Json sameParentProcess(const Json& args) {
  const auto first = parentBinding(args.at("first")), second = parentBinding(args.at("second"));
  return Json::Object{{"same", mm::dump(first.parent) == mm::dump(second.parent) && _wcsicmp(first.image.c_str(), second.image.c_str()) == 0}};
}
Json singletonParentIdentity() { return parentBinding(processIdentity(GetCurrentProcessId())).parent; }
