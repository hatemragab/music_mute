#pragma once
#include "store_child_handle.hpp"

// This process is independent of the stdio controller. It keeps the exact Job
// alive long enough to terminate and prove all descendants gone after a crash.
std::string exitCertificateKey(const Json& owner) {
  const auto nonce = owner.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("JOB_NOT_OWNED");
  return "job_exit_" + nonce.substr(0, 55);
}
std::string ownershipRecordKey(const Json& owner) {
  (void)exitCertificateKey(owner); return "job_owner_" + owner.at("nonce").string().substr(0,54);
}
void writeOwnershipRecord(const Json& owner,HANDLE guardian) {
  const auto text=mm::dump(Json::Object{{"version",1},{"owner",owner},{"controller",processIdentity(GetCurrentProcessId())},{"guardian",processIdentity(GetProcessId(guardian))}});
  (void)vault("vault_put",Json::Object{{"namespace","fleet"},{"key",ownershipRecordKey(owner)},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()))}});
  // A fixed bounded index is published before the owned child can run. Login
  // recovery may query its positive whole-Job certificate; PID absence is not proof.
  const auto role=owner.at("role").string();
  if(role=="personal"||role=="fleet"||role=="prepare")
    (void)vault("vault_put",Json::Object{{"namespace","fleet"},{"key","latest_"+role+"_job"},{"bytes_base64",base64Encode(reinterpret_cast<const BYTE*>(text.data()),static_cast<DWORD>(text.size()))}});
}
void writeExitCertificate(const Json& owner) {
  const auto text = mm::dump(Json::Object{{"version", 1}, {"owner", owner}, {"tree_exited", true}});
  (void)vault("vault_put", Json::Object{{"namespace", "fleet"}, {"key", exitCertificateKey(owner)}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}});
}
Json ownedTreeExited(const Json& args) {
  const auto& owner = args.at("owner");
  keys(owner, {"role", "nonce", "identity"});
  const auto role = owner.at("role").string();
  if (role != "personal" && role != "fleet" && role != "prepare" && role != "session-agent") fail("BAD_REQUEST");
  const auto& identity = owner.at("identity");
  if (identity.at("sid").string() != currentIdentity().sid) fail("PEER_DENIED");
  const auto encrypted = vault("vault_get", Json::Object{{"namespace", "fleet"}, {"key", exitCertificateKey(owner)}});
  if (std::holds_alternative<std::nullptr_t>(encrypted.value)) return Json::Object{{"exited", false}};
  auto plain = base64Decode(encrypted.at("bytes_base64").string(), 4096);
  const auto receipt = mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()), plain.size())).parse();
  SecureZeroMemory(plain.data(), plain.size());
  keys(receipt, {"version", "owner", "tree_exited"});
  if (receipt.at("version").integer() != 1 || !std::get<bool>(receipt.at("tree_exited").value) || mm::dump(receipt.at("owner")) != mm::dump(owner)) fail("JOB_NOT_OWNED");
  return Json::Object{{"exited", true}};
}
struct IndependentJobLifetime {
  Handle job; Handle child; Handle controller; Handle windowReady; Json owner;
  std::optional<mmstorerole::StoreGuardianBinding> storeBinding;
  std::atomic<bool> windowFailed{false};
  std::mutex finishMutex;
  bool finished = false;
  void finish() {
    std::lock_guard lock(finishMutex);
    if (finished) return;
    check(TerminateJobObject(job.value, 2), "JOB_UNAVAILABLE");
    const auto deadline = GetTickCount64() + 10000;
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      check(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "JOB_UNAVAILABLE");
      if (accounting.ActiveProcesses == 0) break;
      if (GetTickCount64() >= deadline) fail("JOB_UNAVAILABLE");
      Sleep(10);
    }
    writeExitCertificate(owner);
    finished = true;
  }
};
IndependentJobLifetime* independentLifetime = nullptr;
LRESULT CALLBACK independentJobWindow(HWND window, UINT message, WPARAM parameter, LPARAM detail) {
  if (message == WM_QUERYENDSESSION) return TRUE;
  if (message == WM_ENDSESSION && parameter && independentLifetime) {
    try { independentLifetime->finish(); ExitProcess(0); } catch (...) { ExitProcess(2); }
  }
  return DefWindowProcW(window, message, parameter, detail);
}
Handle inheritedHandle(const Json& config, const char* key) {
  const auto& text = config.at(key).string();
  if (text.empty() || text.size() > 20 || text.find_first_not_of("0123456789") != std::string::npos) fail("JOB_UNAVAILABLE");
  Handle handle(reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(std::stoull(text))));
  DWORD flags = 0; check(GetHandleInformation(handle.value, &flags), "JOB_UNAVAILABLE");
  if (!(flags & HANDLE_FLAG_INHERIT)) fail("JOB_UNAVAILABLE");
  check(SetHandleInformation(handle.value, HANDLE_FLAG_INHERIT, 0), "JOB_UNAVAILABLE");
  return handle;
}
int independentJobMain(const std::wstring& pipeText) {
  try {
    const Json pipeConfig = Json::Object{{"pipe", utf8(pipeText)}};
    auto input = inheritedHandle(pipeConfig, "pipe");
    DWORD size = 0, read = 0;
    check(ReadFile(input.value, &size, sizeof(size), &read, nullptr) && read == sizeof(size), "JOB_UNAVAILABLE");
    if (size == 0 || size > 8192) return 2;
    std::string bytes(size, '\0');
    check(ReadFile(input.value, bytes.data(), size, &read, nullptr) && read == size, "JOB_UNAVAILABLE");
    const auto config = mm::JsonParser(bytes).parse();
    SecureZeroMemory(bytes.data(), bytes.size());
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
    isolatedTestRoot = wide(config.at("test_root").string());
#endif
    IndependentJobLifetime lifetime;
    lifetime.job = inheritedHandle(config, "job"); lifetime.child = inheritedHandle(config, "child"); lifetime.controller = inheritedHandle(config, "controller"); lifetime.owner = config.at("owner");
    auto ready = inheritedHandle(config, "ready");
    if (!mmstore::currentPackageFullName().empty()) {
      lifetime.storeBinding.emplace(mmstorerole::StoreGuardianBinding::open(config.at("store_issuer"),
        mmstorerole::GuardianKind::job, lifetime.job.value));
      if (GetProcessId(lifetime.controller.value) != lifetime.storeBinding->creatorIdentity().pid ||
          creation(lifetime.controller.value) != mmstorerole::detail::ascii(lifetime.storeBinding->creatorIdentity().creationTime)) return 2;
      if (GetProcessId(lifetime.child.value) != lifetime.storeBinding->nodeIdentity().pid ||
          creation(lifetime.child.value) != mmstorerole::detail::ascii(lifetime.storeBinding->nodeIdentity().creationTime)) return 2;
    }
    const auto& identity = lifetime.owner.at("identity");
    if (identity.at("sid").string() != currentIdentity().sid || identity.at("session_id").integer() != currentIdentity().session || identity.at("pid").integer() != GetProcessId(lifetime.child.value) || identity.at("creation_time").string() != creation(lifetime.child.value)) return 2;
    BOOL belongs = FALSE; check(IsProcessInJob(lifetime.child.value, lifetime.job.value, &belongs) && belongs, "JOB_NOT_OWNED");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    check(QueryInformationJobObject(lifetime.job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr), "JOB_UNAVAILABLE");
    if (!(limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)) return 2;
    independentLifetime = &lifetime;
    lifetime.windowReady=Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!lifetime.windowReady.valid())return 2;
    std::thread([] {
      WNDCLASSW kind{}; kind.lpfnWndProc = independentJobWindow; kind.hInstance = GetModuleHandleW(nullptr); kind.lpszClassName = L"MusicMuteOwnedTreeCleanup";
      if (!RegisterClassW(&kind)||!CreateWindowExW(0, kind.lpszClassName, L"MusicMute Owned Tree", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, kind.hInstance, nullptr)){independentLifetime->windowFailed=true;SetEvent(independentLifetime->windowReady.value);return;}
      SetEvent(independentLifetime->windowReady.value);
      MSG message{}; while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    }).detach();
    if(WaitForSingleObject(lifetime.windowReady.value,5000)!=WAIT_OBJECT_0||lifetime.windowFailed){lifetime.finish();ExitProcess(2);}
    const BYTE acknowledged = 1; DWORD wrote = 0;
    check(WriteFile(ready.value, &acknowledged, 1, &wrote, nullptr) && wrote == 1, "JOB_UNAVAILABLE"); ready.close();
    HANDLE watched[]{lifetime.controller.value, lifetime.child.value};
    if (WaitForMultipleObjects(2, watched, FALSE, INFINITE) >= WAIT_OBJECT_0 + 2) return 2;
    lifetime.finish();
    // Avoid a detached window callback touching a destroyed stack lifetime.
    ExitProcess(0);
  } catch (...) { return 2; }
}
Handle inheritedCopy(HANDLE source, DWORD access, bool sameAccess = false) {
  Handle result; check(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result.value, access, TRUE, sameAccess ? DUPLICATE_SAME_ACCESS : 0), "JOB_UNAVAILABLE"); return result;
}
std::string handleText(const Handle& value) { return std::to_string(reinterpret_cast<ULONG_PTR>(value.value)); }
struct StoreJobGuardianStartup {
  Handle jobCopy, childCopy, controller, input, writer, readyRead, readyWrite, thread;
  bool aborted = false;
};
void closeStoreJobGuardianStartup(StoreJobGuardianStartup& startup) {
  for (auto* handle : {&startup.jobCopy, &startup.childCopy, &startup.controller, &startup.input, &startup.writer, &startup.readyRead, &startup.readyWrite, &startup.thread}) mmstorechild::closeOwned(handle->value);
}
Handle startIndependentJobGuardian(HANDLE job, HANDLE child, const Json& owner, Handle* originalGuardian = nullptr, StoreJobGuardianStartup* originalStartup = nullptr) {
  const bool store = !mmstore::currentPackageFullName().empty();
  if (store) check(originalGuardian && originalStartup && !originalGuardian->valid(), "JOB_UNAVAILABLE");
  else check(!originalGuardian && !originalStartup, "JOB_UNAVAILABLE");
  StoreJobGuardianStartup localStartup; auto& startupOwner = originalStartup ? *originalStartup : localStartup;
  Handle localGuardian; auto& guardian = originalGuardian ? *originalGuardian : localGuardian;
  const auto copy = [&](HANDLE source, DWORD rights, Handle& target) {
    check(!target.valid(), "JOB_UNAVAILABLE");
    if (store) { const auto copied = DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &target.value, rights, TRUE, 0); check(copied && target.valid(), "JOB_UNAVAILABLE"); }
    else target = inheritedCopy(source, rights);
  };
  auto& jobCopy = startupOwner.jobCopy; auto& childCopy = startupOwner.childCopy; auto& controller = startupOwner.controller;
  copy(job, JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, jobCopy);
  copy(child, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, childCopy);
  copy(GetCurrentProcess(), SYNCHRONIZE, controller);
  SECURITY_ATTRIBUTES pipeSecurity{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  auto& input = startupOwner.input; auto& writer = startupOwner.writer; auto& readyRead = startupOwner.readyRead; auto& readyWrite = startupOwner.readyWrite;
  check(CreatePipe(&input.value, &writer.value, &pipeSecurity, 16384), "JOB_UNAVAILABLE");
  check(CreatePipe(&readyRead.value, &readyWrite.value, &pipeSecurity, 4096), "JOB_UNAVAILABLE");
  check(SetHandleInformation(writer.value, HANDLE_FLAG_INHERIT, 0), "JOB_UNAVAILABLE");
  check(SetHandleInformation(readyRead.value, HANDLE_FLAG_INHERIT, 0), "JOB_UNAVAILABLE");
  auto configuration = Json::Object{{"job", handleText(jobCopy)}, {"child", handleText(childCopy)}, {"controller", handleText(controller)}, {"ready", handleText(readyWrite)}, {"owner", owner}};
#ifdef MUSICMUTE_CONSUMER_NATIVE_TEST
  configuration.emplace("test_root", utf8(isolatedTestRoot));
#endif
  SIZE_T attributeSize = 0;
  InitializeProcThreadAttributeList(nullptr, store ? 2 : 1, 0, &attributeSize);
  std::vector<BYTE> attributeBytes(attributeSize);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeBytes.data());
  check(InitializeProcThreadAttributeList(attributes, store ? 2 : 1, 0, &attributeSize), "JOB_UNAVAILABLE");
  DWORD desktopPolicy = 0;
  struct AttributeLifetime { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeLifetime() { DeleteProcThreadAttributeList(value); } } attributeLifetime{attributes};
  HANDLE inherited[]{jobCopy.value, childCopy.value, controller.value, input.value, readyWrite.value};
  check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr), "JOB_UNAVAILABLE");
  if (store) check(mmstoredesktop::apply(attributes, desktopPolicy), "JOB_UNAVAILABLE");
  std::vector<wchar_t> image(32768); const auto size = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
  if (size == 0 || size >= image.size()) fail("JOB_UNAVAILABLE");
  std::optional<mmstoreruntime::FixedLaunchPlan> storePlan;
  if (store) storePlan.emplace(mmstorerole::StoreRoleIssuer::currentCreator().guardianPlan());
  const std::wstring executable = store ? storePlan->executablePath() : std::wstring(image.data(), size);
  auto command = quote(executable) + (store ? L" --store-job-guardian " : L" --job-guardian ") + wide(handleText(input));
  auto environment=consumerEnvironment(executable.substr(0,executable.find_last_of(L'\\')));
  BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob), "JOB_UNAVAILABLE");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes; PROCESS_INFORMATION process{};
  const auto created = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT |
    (store ? CREATE_SUSPENDED : consumerIndependentJobFlags(inJob)), environment.data(), nullptr, &startup.StartupInfo, &process);
  guardian.value = process.hProcess; auto& thread = startupOwner.thread; thread.value = process.hThread;
  check(created && guardian.valid() && thread.valid(), "JOB_UNAVAILABLE");
  struct UnreadyGuardian { HANDLE process, job, node; bool store; bool* aborted; bool ready = false; ~UnreadyGuardian() { if (!ready) {
    *aborted = true;
    if (store) try { mmstorerole::StoreRoleIssuer::currentCreator().abortJobGuardianStartup(process, job, node); } catch (...) {}
    (void)TerminateProcess(process, 2); (void)WaitForSingleObject(process, 5000);
  } } } rollback{guardian.value, job, child, store, &startupOwner.aborted};
  if (store) {
    storePlan->revalidateFixedAdmission();
    configuration.emplace("store_issuer", mmstorerole::StoreRoleIssuer::currentCreator().registerGuardian(guardian.value, job, child, mmstorerole::GuardianKind::job));
  }
  const auto bytes = mm::dump(configuration); DWORD count = static_cast<DWORD>(bytes.size()), wrote = 0;
  check(WriteFile(writer.value, &count, 4, &wrote, nullptr) && wrote == 4, "JOB_UNAVAILABLE");
  check(WriteFile(writer.value, bytes.data(), count, &wrote, nullptr) && wrote == count, "JOB_UNAVAILABLE");
  if (store) mmstorechild::closeOwned(writer.value); else writer.close();
  if (store) check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "JOB_UNAVAILABLE");
  if (store) { mmstorechild::closeOwned(input.value); mmstorechild::closeOwned(readyWrite.value); } else { input.close(); readyWrite.close(); }
  const auto deadline = GetTickCount64() + 5000;
  for (;;) {
    DWORD available = 0;
    if (!PeekNamedPipe(readyRead.value, nullptr, 0, nullptr, &available, nullptr) || WaitForSingleObject(guardian.value, 0) == WAIT_OBJECT_0 || GetTickCount64() >= deadline) { TerminateProcess(guardian.value, 2); fail("JOB_UNAVAILABLE"); }
    if (available) { BYTE ready = 0; DWORD read = 0; check(ReadFile(readyRead.value, &ready, 1, &read, nullptr) && read == 1 && ready == 1, "JOB_UNAVAILABLE"); break; }
    Sleep(5);
  }
  if (store) closeStoreJobGuardianStartup(startupOwner);
  rollback.ready = true;
  // Store's exact process was retained in its Node owner before registration
  // or readiness could fail. Legacy callers retain their original return API.
  return store ? Handle{} : std::move(localGuardian);
}
