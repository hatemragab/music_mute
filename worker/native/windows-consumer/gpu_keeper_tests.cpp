#define MUSICMUTE_CONSUMER_NATIVE_TEST
#include "main.cpp"
#include <source_location>

// Windows-only isolated CTest source. Every object uses a fresh GUID; no DXGI
// query, production GPU name, model, installed file, vault, foreign user token or
// administrator action is used. These assertions have not run on the Mac.
namespace {
const char* fixturePhase = "startup";
unsigned fixtureAssertionLine = 0;
std::string fixtureFailureCode(const Failure& error) {
  if (error.code.empty() || error.code.size() > 64 ||
    error.code.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789") != std::string::npos)
    return "UNEXPECTED_FAILURE_CODE";
  return error.code;
}
void fixtureRequire(bool condition, const std::source_location site = std::source_location::current()) {
  if (!condition) {
    fixtureAssertionLine = site.line();
    std::cerr << "GPU keeper fixture assertion: phase=" << fixturePhase << " line=" << fixtureAssertionLine << '\n';
    throw Failure("GPU_KEEPER_FIXTURE_FAILED");
  }
}
template <typename Action> void fixtureRejects(const char* code, Action action) {
  try { action(); } catch (const Failure& error) {
    fixtureRequire(error.code == code); return;
  }
  throw Failure("GPU_KEEPER_FIXTURE_REJECTION_MISSING");
}
std::wstring fixtureName() {
  GUID id{};
  fixtureRequire(SUCCEEDED(CoCreateGuid(&id)));
  wchar_t text[40]{};
  fixtureRequire(StringFromGUID2(id, text, 40) > 0);
  return L"Global\\MusicMuteGpuKeeperCTest-" + std::wstring(text);
}
std::wstring fixtureImage() {
  std::vector<wchar_t> text(32768);
  const auto count = GetModuleFileNameW(nullptr, text.data(), static_cast<DWORD>(text.size()));
  fixtureRequire(count > 0 && count < text.size());
  return std::wstring(text.data(), count);
}
std::wstring publicFixtureSddl() {
  return L"O:" + wide(currentIdentity().sid) +
    L"D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)";
}
Handle fixtureMutex(const std::wstring& name, const std::wstring& sddl, DWORD* error = nullptr) {
  Security security(sddl);
  Handle result(CreateMutexExW(&security.attributes, name.c_str(), 0,
    READ_CONTROL | SYNCHRONIZE | MUTEX_MODIFY_STATE));
  const auto created = GetLastError();
  if (error) *error = created;
  fixtureRequire(result.valid());
  return result;
}
Handle fixtureJob() {
  Handle result(CreateJobObjectW(nullptr, nullptr));
  fixtureRequire(result.valid());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  fixtureRequire(SetInformationJobObject(result.value, JobObjectExtendedLimitInformation,
    &limits, sizeof(limits)) != FALSE);
  return result;
}
DWORD fixtureProcesses(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  fixtureRequire(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
    &info, sizeof(info), nullptr) != FALSE);
  return info.ActiveProcesses;
}
void fixtureExitedLeaves(HANDLE first, HANDLE second) {
  const auto firstInitial = WaitForSingleObject(first, 0), secondInitial = WaitForSingleObject(second, 0);
  HANDLE leaves[]{first, second};
  // Job accounting zero may precede final process-object signaling on Windows.
  // Confirm both exact handles together within one existing five-second bound;
  // accounting zero remains a separate mandatory assertion at each call site.
  const auto completed = WaitForMultipleObjects(2, leaves, TRUE, 5000);
  DWORD firstExit = 0, secondExit = 0;
  const bool exitsRead = GetExitCodeProcess(first, &firstExit) != FALSE &&
    GetExitCodeProcess(second, &secondExit) != FALSE;
  std::cerr << "GPU keeper leaf completion: initial_first=" << firstInitial
    << " initial_second=" << secondInitial << " completed=" << completed
    << " exits_read=" << exitsRead << " first_exit=" << firstExit << " second_exit=" << secondExit << '\n';
  fixtureRequire(completed == WAIT_OBJECT_0 && exitsRead);
}
Handle fixtureLeaf(HANDLE job) {
  const auto image = fixtureImage();
  auto command = quote(image) + L" --fixture-leaf";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  // These sleeping leaves use no console or standard streams. CREATE_NO_WINDOW
  // still creates a hidden conhost for each leaf, adding two real Job members.
  // Detach the console up front while retaining the inherited QA Job chain and
  // suspended assignment to this fixture's exact kill-on-close Job.
  fixtureRequire(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, FALSE,
    CREATE_SUSPENDED | DETACHED_PROCESS, nullptr, nullptr, &startup, &process) != FALSE);
  Handle child(process.hProcess), thread(process.hThread);
  if (!AssignProcessToJobObject(job, child.value)) {
    TerminateProcess(child.value, 2);
    throw Failure("GPU_KEEPER_FIXTURE_ASSIGNMENT_FAILED");
  }
  fixtureRequire(ResumeThread(thread.value) != static_cast<DWORD>(-1));
  return child;
}
Json fixtureRead(HANDLE pipe, HANDLE process, std::size_t maximum) {
  const auto deadline = GetTickCount64() + 5000;
  for (;;) {
    DWORD available = 0;
    fixtureRequire(PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) != FALSE);
    if (available >= sizeof(DWORD)) break;
    fixtureRequire(WaitForSingleObject(process, 0) == WAIT_TIMEOUT && GetTickCount64() < deadline);
    Sleep(5);
  }
  DWORD count = 0, read = 0;
  fixtureRequire(ReadFile(pipe, &count, sizeof(count), &read, nullptr) != FALSE &&
    read == sizeof(count) && count > 0 && count <= maximum);
  std::string text(count, '\0');
  fixtureRequire(ReadFile(pipe, text.data(), count, &read, nullptr) != FALSE && read == count);
  return mm::JsonParser(text).parse();
}
struct FixtureKeeper {
  Handle process, thread, watchdog, backupWatchdog, release;
  ~FixtureKeeper() {
    // Only these exact disposable processes can be terminated on test failure.
    if (release.valid()) SetEvent(release.value);
    for (const auto handle : {process.value, watchdog.value, backupWatchdog.value}) {
      if (handle && WaitForSingleObject(handle, 5000) == WAIT_TIMEOUT) {
        TerminateProcess(handle, 2); WaitForSingleObject(handle, 5000);
      }
    }
  }
};
Handle fixtureWatchdog(const Json& receipt, HANDLE keeper) {
  const auto pid = receipt.at("pid").integer();
  fixtureRequire(pid > 0 && pid <= 2147483647);
  const auto actual = processIdentity(static_cast<DWORD>(pid));
  fixtureRequire(mm::dump(actual) == mm::dump(receipt));
  const auto parent = parentBinding(actual);
  fixtureRequire(parent.parent.at("pid").integer() == GetProcessId(keeper) &&
    parent.parent.at("creation_time").string() == creation(keeper) &&
    _wcsicmp(parent.image.c_str(), fixtureImage().c_str()) == 0);
  Handle result(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | PROCESS_TERMINATE,
    FALSE, static_cast<DWORD>(pid)));
  fixtureRequire(result.valid() && creation(result.value) == actual.at("creation_time").string());
  return result;
}
void startFixtureKeeper(FixtureKeeper& result, HANDLE job, HANDLE mutex, bool redundant) {
  auto jobCopy = inheritedCopy(job, JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE);
  auto mutexCopy = inheritedCopy(mutex, READ_CONTROL | SYNCHRONIZE | MUTEX_MODIFY_STATE);
  auto controller = inheritedCopy(GetCurrentProcess(), SYNCHRONIZE);
  result.release = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  fixtureRequire(result.release.valid());
  auto releaseCopy = inheritedCopy(result.release.value, SYNCHRONIZE);
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle input, writer, readyRead, readyWrite;
  fixtureRequire(CreatePipe(&input.value, &writer.value, &security, 16384) != FALSE);
  fixtureRequire(CreatePipe(&readyRead.value, &readyWrite.value, &security, 8192) != FALSE);
  fixtureRequire(SetHandleInformation(writer.value, HANDLE_FLAG_INHERIT, 0) != FALSE);
  fixtureRequire(SetHandleInformation(readyRead.value, HANDLE_FLAG_INHERIT, 0) != FALSE);
  const auto config = Json::Object{{"job", handleText(jobCopy)}, {"mutex", handleText(mutexCopy)},
    {"controller", handleText(controller)}, {"release", handleText(releaseCopy)},
    {"ready", handleText(readyWrite)}, {"redundant", redundant}};
  const auto text = mm::dump(config);
  const DWORD count = static_cast<DWORD>(text.size()); DWORD wrote = 0;
  fixtureRequire(count <= 8192 && WriteFile(writer.value, &count, sizeof(count), &wrote, nullptr) != FALSE && wrote == sizeof(count));
  fixtureRequire(WriteFile(writer.value, text.data(), count, &wrote, nullptr) != FALSE && wrote == count);
  writer.close();
  SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<BYTE> attributes(size);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  fixtureRequire(InitializeProcThreadAttributeList(list, 1, 0, &size) != FALSE);
  struct AttributeGuard { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeGuard() { DeleteProcThreadAttributeList(value); } } guard{list};
  HANDLE handles[]{jobCopy.value, mutexCopy.value, controller.value, releaseCopy.value, input.value, readyWrite.value};
  fixtureRequire(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, sizeof(handles), nullptr, nullptr) != FALSE);
  const auto image = fixtureImage(); auto command = quote(image) + L" --fixture-keeper " + wide(handleText(input));
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
  PROCESS_INFORMATION process{};
  fixtureRequire(CreateProcessW(image.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &startup.StartupInfo, &process) != FALSE);
  result.process = Handle(process.hProcess); result.thread = Handle(process.hThread);
  input.close(); readyWrite.close();
  const auto ready = fixtureRead(readyRead.value, result.process.value, 4096);
  if (!std::get<bool>(ready.at("ready").value)) {
    const auto code = fixtureFailureCode(Failure(ready.at("failure_code").string()));
    std::cerr << "GPU keeper fixture child failed: phase=" << ready.at("phase").string()
      << " line=" << ready.at("assertion_line").integer() << " code=" << code << '\n';
  }
  fixtureRequire(std::get<bool>(ready.at("ready").value));
  result.watchdog = fixtureWatchdog(ready.at("watchdog"), result.process.value);
  if (redundant) result.backupWatchdog = fixtureWatchdog(ready.at("backup"), result.process.value);
}
int fixtureKeeperMain(const std::wstring& inputText) {
  Handle ready;
  try {
    fixturePhase = "keeper-config";
    auto input = inheritedHandle(Json::Object{{"pipe", utf8(inputText)}}, "pipe");
    // Anonymous pipe already contains bounded parent-authored test configuration.
    DWORD count = 0, read = 0;
    fixtureRequire(ReadFile(input.value, &count, sizeof(count), &read, nullptr) != FALSE && read == sizeof(count) && count > 0 && count <= 8192);
    std::string text(count, '\0');
    fixtureRequire(ReadFile(input.value, text.data(), count, &read, nullptr) != FALSE && read == count);
    const auto config = mm::JsonParser(text).parse();
    GpuKeeperLifetime lifetime;
    lifetime.job = inheritedHandle(config, "job"); lifetime.mutex = inheritedHandle(config, "mutex");
    lifetime.controller = inheritedHandle(config, "controller"); lifetime.release = inheritedHandle(config, "release");
    ready = inheritedHandle(config, "ready");
    fixturePhase = "keeper-acquire";
    fixtureRequire(safePublicGpuMutex(lifetime.mutex.value));
    fixtureRequire(WaitForSingleObject(lifetime.mutex.value, 0) == WAIT_OBJECT_0);
    lifetime.held = true; lifetime.roleBound = false; lifetime.owner = nullptr;
    lifetime.safeRelease = Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    fixtureRequire(lifetime.safeRelease.valid());
    fixturePhase = "keeper-start-watchdog";
    lifetime.watchdog = startGpuWatchdog(lifetime);
    Handle backup;
    if (std::get<bool>(config.at("redundant").value)) {
      fixturePhase = "keeper-start-backup";
      backup = startGpuWatchdog(lifetime);
    }
    fixturePhase = "keeper-ready";
    writeGpuReady(ready.value, Json::Object{{"ready", true},
      {"watchdog", processIdentity(GetProcessId(lifetime.watchdog.value))},
      {"backup", backup.valid() ? processIdentity(GetProcessId(backup.value)) : Json(nullptr)}});
    ready.close();
    fixturePhase = "keeper-wait";
    HANDLE watched[]{lifetime.release.value, lifetime.controller.value, lifetime.watchdog.value};
    const auto ended = WaitForMultipleObjects(3, watched, FALSE, INFINITE);
    // This is the production completion routine, including its positive Job
    // census before thread-owned ReleaseMutex; the test does not emulate idle.
    fixturePhase = "keeper-cleanup";
    finishGpuKeeperLifetime(lifetime, ended);
    ExitProcess(0);
  } catch (const Failure& error) {
    const auto code = fixtureFailureCode(error);
    std::cerr << "GPU keeper fixture child failed: phase=" << fixturePhase << " line="
      << fixtureAssertionLine << " code=" << code << '\n';
    // Only fixed test diagnostics travel on the existing readiness pipe.
    if (ready.valid()) {
      try { writeGpuReady(ready.value, Json::Object{{"ready", false}, {"phase", fixturePhase},
        {"assertion_line", static_cast<int>(fixtureAssertionLine)}, {"failure_code", code}}); }
      catch (...) {}
    }
    return 2;
  } catch (...) {
    // Exact inherited kill-on-close Job handles are retained on uncertainty.
    // CTest's owning parent is responsible for bounded fixture failure cleanup.
    return 2;
  }
}
void aclAndSquattingCases() {
  const auto sid = wide(currentIdentity().sid);
  auto valid = fixtureMutex(fixtureName(), publicFixtureSddl());
  fixtureRequire(safePublicGpuMutex(valid.value));
  for (const auto& acl : {
    L"D:(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)",
    L"D:P(A;;GA;;;AU)(A;;0x001f0001;;;SY)",
    L"D:P(A;;0x00120001;;;WD)(A;;0x001f0001;;;SY)",
    L"D:P(A;;0x00120001;;;AU)",
    L"D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)(A;;GR;;;S-1-5-21-101-202-303-1001)"}) {
    const auto name = fixtureName();
    auto squatter = fixtureMutex(name, L"O:" + sid + acl);
    fixtureRequire(!safePublicGpuMutex(squatter.value));
    DWORD opened = ERROR_SUCCESS;
    auto reopened = fixtureMutex(name, publicFixtureSddl(), &opened);
    fixtureRequire(opened == ERROR_ALREADY_EXISTS && !safePublicGpuMutex(reopened.value));
    // Opening never overwrites the existing broader/foreign security descriptor.
  }
  const auto wrongType = fixtureName();
  Security security(L"O:" + sid + L"D:P(A;;GA;;;" + sid + L")(A;;GA;;;SY)");
  Handle event(CreateEventW(&security.attributes, TRUE, FALSE, wrongType.c_str()));
  fixtureRequire(event.valid());
  Handle denied(CreateMutexExW(&security.attributes, wrongType.c_str(), 0, READ_CONTROL | SYNCHRONIZE | MUTEX_MODIFY_STATE));
  fixtureRequire(!denied.valid() && GetLastError() == ERROR_INVALID_HANDLE);
  fixtureRequire(WaitForSingleObject(event.value, 0) == WAIT_TIMEOUT);
  auto privateCurrent = fixtureMutex(fixtureName(), L"O:" + sid +
    L"D:P(A;;GA;;;" + sid + L")(A;;GA;;;SY)");
  assertPrivateMutex(privateCurrent.value);
  auto privateForeign = fixtureMutex(fixtureName(), L"O:" + sid +
    L"D:P(A;;GA;;;" + sid + L")(A;;GA;;;SY)(A;;GR;;;S-1-5-21-101-202-303-1001)");
  fixtureRejects("ACL_UNSAFE", [&] { assertPrivateMutex(privateForeign.value); });
  // Foreign-SID ACE policy is tested; no actual foreign user's token is opened.
}
void watchdogFirstCase() {
  auto job = fixtureJob(), mutex = fixtureMutex(fixtureName(), publicFixtureSddl());
  auto leaf = fixtureLeaf(job.value), second = fixtureLeaf(job.value);
  FixtureKeeper keeper; startFixtureKeeper(keeper, job.value, mutex.value, false);
  const auto active = fixtureProcesses(job.value);
  if (active != 2) {
    // Numeric observations identify early exit versus unintended membership;
    // they reveal no fixture names, process IDs, paths or account identities.
    DWORD leafExit = 0, secondExit = 0;
    BOOL leafMember = FALSE, secondMember = FALSE, keeperMember = FALSE, watchdogMember = FALSE;
    const bool exitsRead = GetExitCodeProcess(leaf.value, &leafExit) != FALSE &&
      GetExitCodeProcess(second.value, &secondExit) != FALSE;
    const bool membersRead = IsProcessInJob(leaf.value, job.value, &leafMember) != FALSE &&
      IsProcessInJob(second.value, job.value, &secondMember) != FALSE &&
      IsProcessInJob(keeper.process.value, job.value, &keeperMember) != FALSE &&
      IsProcessInJob(keeper.watchdog.value, job.value, &watchdogMember) != FALSE;
    std::cerr << "GPU keeper pre-fault census: active=" << active << " exits_read=" << exitsRead
      << " leaf_exit=" << leafExit << " second_exit=" << secondExit
      << " members_read=" << membersRead << " leaf_member=" << leafMember
      << " second_member=" << secondMember << " keeper_member=" << keeperMember
      << " watchdog_member=" << watchdogMember << '\n';
    constexpr DWORD capacity = 16;
    std::vector<BYTE> listBytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + capacity * sizeof(ULONG_PTR));
    auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(listBytes.data());
    const bool listRead = QueryInformationJobObject(job.value, JobObjectBasicProcessIdList,
      list, static_cast<DWORD>(listBytes.size()), nullptr) != FALSE &&
      list->NumberOfProcessIdsInList <= capacity &&
      list->NumberOfAssignedProcesses == list->NumberOfProcessIdsInList;
    unsigned knownMembers = 0, consoleMembers = 0, unclassifiedMembers = 0;
    std::vector<wchar_t> systemDirectory(32768);
    const auto systemCount = GetSystemDirectoryW(systemDirectory.data(), static_cast<UINT>(systemDirectory.size()));
    const std::wstring consoleImage = systemCount > 0 && systemCount < systemDirectory.size()
      ? std::wstring(systemDirectory.data(), systemCount) + L"\\conhost.exe" : L"";
    if (listRead) for (DWORD index = 0; index < list->NumberOfProcessIdsInList; ++index) {
      const auto pid = list->ProcessIdList[index];
      if (pid == GetProcessId(leaf.value) || pid == GetProcessId(second.value) ||
        pid == GetProcessId(keeper.process.value) || pid == GetProcessId(keeper.watchdog.value)) {
        ++knownMembers; continue;
      }
      if (pid == 0 || pid > MAXDWORD) { ++unclassifiedMembers; continue; }
      Handle memberHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid)));
      BOOL stillMember = FALSE;
      std::vector<wchar_t> image(32768); DWORD imageCount = static_cast<DWORD>(image.size());
      if (memberHandle.valid() && IsProcessInJob(memberHandle.value, job.value, &stillMember) != FALSE &&
        stillMember && !consoleImage.empty() &&
        QueryFullProcessImageNameW(memberHandle.value, 0, image.data(), &imageCount) != FALSE &&
        _wcsicmp(std::wstring(image.data(), imageCount).c_str(), consoleImage.c_str()) == 0)
        ++consoleMembers;
      else ++unclassifiedMembers;
    }
    std::cerr << "GPU keeper Job list: read=" << listRead
      << " assigned=" << list->NumberOfAssignedProcesses << " listed=" << list->NumberOfProcessIdsInList
      << " known=" << knownMembers << " system_console=" << consoleMembers
      << " unclassified=" << unclassifiedMembers << '\n';
  }
  fixtureRequire(active == 2);
  fixtureRequire(WaitForSingleObject(mutex.value, 0) == WAIT_TIMEOUT);
  fixtureRequire(TerminateProcess(keeper.watchdog.value, 2) != FALSE);
  fixtureRequire(WaitForSingleObject(keeper.watchdog.value, 5000) == WAIT_OBJECT_0);
  // The keeper runs the real completion path when its watchdog dies first.
  fixtureRequire(WaitForSingleObject(mutex.value, 5000) == WAIT_OBJECT_0);
  fixtureRequire(fixtureProcesses(job.value) == 0);
  fixtureExitedLeaves(leaf.value, second.value);
  fixtureRequire(ReleaseMutex(mutex.value) != FALSE);
  fixtureRequire(WaitForSingleObject(keeper.process.value, 5000) == WAIT_OBJECT_0);
  DWORD exit = 2; fixtureRequire(GetExitCodeProcess(keeper.process.value, &exit) != FALSE && exit == 0);
}
void multipleGuardianLossCase() {
  const auto name = fixtureName();
  auto job = fixtureJob(), mutex = fixtureMutex(name, publicFixtureSddl());
  auto leaf = fixtureLeaf(job.value), second = fixtureLeaf(job.value);
  FixtureKeeper keeper; startFixtureKeeper(keeper, job.value, mutex.value, true);
  // Freeze only our exact disposable keeper before losing its primary watchdog,
  // so it cannot finish ordinary cleanup between the two deliberate deaths.
  fixtureRequire(SuspendThread(keeper.thread.value) != static_cast<DWORD>(-1));
  fixtureRequire(TerminateProcess(keeper.watchdog.value, 2) != FALSE);
  fixtureRequire(TerminateProcess(keeper.process.value, 2) != FALSE);
  fixtureRequire(WaitForSingleObject(keeper.process.value, 5000) == WAIT_OBJECT_0);
  fixtureRequire(WaitForSingleObject(keeper.watchdog.value, 5000) == WAIT_OBJECT_0);
  // A surviving independent production watchdog retains the object, terminates
  // the exact disposable Job and waits for zero after both other guardians die.
  fixtureRequire(WaitForSingleObject(keeper.backupWatchdog.value, 5000) == WAIT_OBJECT_0);
  fixtureRequire(fixtureProcesses(job.value) == 0);
  fixtureExitedLeaves(leaf.value, second.value);
  DWORD abandoned = WAIT_FAILED;
  std::thread contender([&] { abandoned = WaitForSingleObject(mutex.value, 0); });
  contender.join();
  fixtureRequire(abandoned == WAIT_ABANDONED); // Never turn abandonment into a permit.
  mutex.close();
  auto fresh = fixtureMutex(name, publicFixtureSddl());
  fixtureRequire(WaitForSingleObject(fresh.value, 0) == WAIT_OBJECT_0);
  fixtureRequire(ReleaseMutex(fresh.value) != FALSE);
  // Simultaneous loss of every reference and real logout/multiuser scheduling
  // remain W34; this test covers two lost guardians with one retained watchdog.
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--fixture-leaf") { Sleep(INFINITE); return 0; }
  if (argc == 3 && std::wstring(argv[1]) == L"--fixture-keeper") return fixtureKeeperMain(argv[2]);
  if (argc == 3 && std::wstring(argv[1]) == L"--gpu-watchdog") return independentGpuWatchdogMain(argv[2]);
  if (argc != 1) return 2;
  try {
    fixturePhase = "identity";
    const auto report = identityReport();
    fixtureRequire(report.at("native_arch").string() == "x64" && report.at("os_build").integer() >= 19045);
    fixturePhase = "acl-and-squatting"; aclAndSquattingCases();
    fixturePhase = "watchdog-first"; watchdogFirstCase();
    fixturePhase = "multiple-guardian-loss"; multipleGuardianLossCase();
    std::cout << "Isolated GPU ACL/squatting/SID-policy/guardian fixtures passed\n";
    return 0;
  } catch (const Failure& error) {
    std::cerr << "Isolated GPU keeper fixture failed: phase=" << fixturePhase << " line="
      << fixtureAssertionLine << " code=" << fixtureFailureCode(error) << "; no native acceptance recorded\n";
    return 2;
  } catch (...) {
    std::cerr << "Isolated GPU keeper fixture failed: phase=" << fixturePhase
      << " code=UNEXPECTED_EXCEPTION; no native acceptance recorded\n";
    return 2;
  }
}
