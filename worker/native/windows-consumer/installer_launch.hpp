#pragma once

// One fixed SID-wide transaction. The certificate is committed before either
// suspended monitor or installer executes. No PID absence is an exit proof.
struct InstallerTransactionLock {
  Handle handle;
  InstallerTransactionLock() {
    const auto sid = wide(currentIdentity().sid);
    Security security(L"O:" + sid + L"D:P(A;;0x001f0001;;;" + sid + L")(A;;0x001f0001;;;SY)");
    handle = Handle(CreateMutexW(&security.attributes, FALSE, (L"Global\\MusicMuteInstaller-v1-" + privateKernelSid()).c_str()));
    if (!handle.valid()) fail("JOB_UNAVAILABLE");
    assertPrivateMutex(handle.value);
    const auto waited = WaitForSingleObject(handle.value, 2000);
    if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) fail("JOB_BUSY");
  }
  ~InstallerTransactionLock() { if (handle.valid()) ReleaseMutex(handle.value); }
};
bool jsonNull(const Json& value) { return std::holds_alternative<std::nullptr_t>(value.value); }
void validateInstallerPin(const Json& pin) {
  keys(pin, {"identity", "sha256", "bytes", "publisher_sha256"});
  for (const auto* key : {"identity", "sha256", "publisher_sha256"}) {
    const auto& text = pin.at(key).string();
    if (text.size() != 64 || text.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  }
  if (pin.at("bytes").integer() < 1 || pin.at("bytes").integer() > 2LL * 1024 * 1024 * 1024) fail("BAD_REQUEST");
}
Json readInstallerCertificate() {
  const auto encrypted = vault("vault_get", Json::Object{{"namespace", "account"}, {"key", "installer_launch"}});
  if (jsonNull(encrypted)) return nullptr;
  auto bytes = base64Decode(encrypted.at("bytes_base64").string(), 8192);
  Json record;
  try { record = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse(); }
  catch (...) { SecureZeroMemory(bytes.data(), bytes.size()); fail("VAULT_CORRUPT"); }
  SecureZeroMemory(bytes.data(), bytes.size());
  keys(record, {"version", "nonce", "pin", "state", "monitor", "monitor_thread", "monitor_image", "monitor_sha256", "process", "exit_code", "tree_exited"});
  if (record.at("version").integer() != 1) fail("VAULT_CORRUPT");
  validateInstallerPin(record.at("pin"));
  const auto& nonce = record.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("VAULT_CORRUPT");
  const auto expectedImage=rootPath("personal")+L"\\updates\\staging\\"+wide(record.at("pin").at("identity").string())+L"\\monitor.exe";
  if(record.at("monitor_image").string()!=utf8(expectedImage))fail("VAULT_CORRUPT");
  const auto& imageDigest=record.at("monitor_sha256").string();if(imageDigest.size()!=64||imageDigest.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("VAULT_CORRUPT");
  const auto state = record.at("state").string();
  if (state != "launching" && state != "running" && state != "completed") fail("VAULT_CORRUPT");
  for (const auto* name : {"monitor", "process"}) {
    const auto& identity = record.at(name);
    if (jsonNull(identity)) continue;
    keys(identity, {"sid", "session_id", "pid", "creation_time"});
    if (identity.at("sid").string() != currentIdentity().sid || identity.at("pid").integer() < 1 || identity.at("pid").integer() > 2147483647 || identity.at("session_id").integer() < 1) fail("VAULT_CORRUPT");
    const auto& birth = identity.at("creation_time").string();
    if (birth.empty() || birth.size() > 20 || birth.find_first_not_of("0123456789") != std::string::npos) fail("VAULT_CORRUPT");
  }
  if(!jsonNull(record.at("monitor"))) {
    const auto& thread=record.at("monitor_thread");keys(thread,{"tid","creation_time"});
    const auto& birth=thread.at("creation_time").string();if(thread.at("tid").integer()<1||thread.at("tid").integer()>4294967295LL||birth.empty()||birth.size()>20||birth.find_first_not_of("0123456789")!=std::string::npos)fail("VAULT_CORRUPT");
  }else if(!jsonNull(record.at("monitor_thread")))fail("VAULT_CORRUPT");
  if (state == "completed") {
    if (jsonNull(record.at("monitor")) || jsonNull(record.at("process")) || record.at("exit_code").integer() < 0 || record.at("exit_code").integer() > 4294967295LL || !std::get<bool>(record.at("tree_exited").value)) fail("VAULT_CORRUPT");
  } else if (!jsonNull(record.at("exit_code")) || std::get<bool>(record.at("tree_exited").value)) fail("VAULT_CORRUPT");
  return record;
}
void writeInstallerCertificate(const Json& record) {
  const auto text = mm::dump(record);
  (void)vault("vault_put", Json::Object{{"namespace", "account"}, {"key", "installer_launch"}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}});
}
Handle exactInstallerProcess(const Json& identity) {
  if (jsonNull(identity)) return {};
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(identity.at("pid").integer())));
  if (!process.valid() || WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT || creation(process.value) != identity.at("creation_time").string()) return {};
  Handle token;
  check(OpenProcessToken(process.value, TOKEN_QUERY, &token.value), "IDENTITY_UNAVAILABLE");
  const auto actual = tokenIdentity(token.value);
  if (actual.sid != identity.at("sid").string() || static_cast<std::int64_t>(actual.session) != identity.at("session_id").integer()) return {};
  return process;
}
Json installerCertificateStatus(const Json& record) {
  auto state = record.at("state").string();
  if (state != "completed") {
    auto monitor = exactInstallerProcess(record.at("monitor"));
    if (!monitor.valid()) state = "unknown";
    else if (state == "running") {
      auto child = exactInstallerProcess(record.at("process"));
      if (!child.valid()) state = "launching"; // Monitor must publish the exact handle/tree exit proof.
    }
  }
  return Json::Object{{"state", state}, {"certificate", Json::Object{{"version", 1}, {"nonce", record.at("nonce")}, {"pin", record.at("pin")}, {"monitor", record.at("monitor")}, {"process", record.at("process")}, {"exit_code", record.at("exit_code")}, {"tree_exited", record.at("tree_exited")}}}};
}
std::string threadCreation(HANDLE thread) {
  FILETIME created{}, exited{}, kernel{}, user{};
  check(GetThreadTimes(thread, &created, &exited, &kernel, &user), "IDENTITY_UNAVAILABLE");
  return std::to_string((static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime);
}
void resumeInstallerMonitor(const Json& record) {
  if (record.at("state").string() != "launching" || jsonNull(record.at("monitor"))) return;
  const auto& identity = record.at("monitor");
  if (identity.at("session_id").integer() != currentIdentity().session) fail("PEER_DENIED");
  auto process = exactInstallerProcess(identity);
  if (!process.valid()) return;
  std::wstring actual(32768, L'\0'); DWORD count = static_cast<DWORD>(actual.size());
  check(QueryFullProcessImageNameW(process.value, 0, actual.data(), &count), "PEER_DENIED"); actual.resize(count);
  const auto image = wide(record.at("monitor_image").string());
  if (_wcsicmp(actual.c_str(), image.c_str()) != 0) fail("PEER_DENIED");
  auto locked = lockHashedFile(image, record.at("monitor_sha256").string(), true);
  const auto& expected = record.at("monitor_thread"); keys(expected, {"tid", "creation_time"});
  const auto tid = expected.at("tid").integer(); if (tid < 1 || tid > 4294967295LL) fail("PEER_DENIED");
  Handle thread(OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(tid)));
  if (!thread.valid() || static_cast<std::int64_t>(GetProcessIdOfThread(thread.value)) != identity.at("pid").integer() || threadCreation(thread.value) != expected.at("creation_time").string()) fail("PEER_DENIED");
  const auto previous = ResumeThread(thread.value);
  if (previous == static_cast<DWORD>(-1) || previous > 1) fail("JOB_UNAVAILABLE");
}
Json inspectInstallerLaunch(const Json& pin, bool recover) {
  validateInstallerPin(pin);
  InstallerTransactionLock lock;
  const auto record = readInstallerCertificate();
  if (jsonNull(record)) return Json::Object{{"state", "absent"}, {"certificate", nullptr}};
  if (mm::dump(record.at("pin")) != mm::dump(pin)) {
    if (record.at("state").string() == "completed") return Json::Object{{"state", "absent"}, {"certificate", nullptr}};
    fail("INSTALLER_LAUNCH_CONFLICT");
  }
  if (recover) resumeInstallerMonitor(record);
  return installerCertificateStatus(record);
}
Json removeCompletedInstallerMonitor(const Json& pin) {
  validateInstallerPin(pin);InstallerTransactionLock transaction;
  const auto record=readInstallerCertificate();
  if(jsonNull(record)||mm::dump(record.at("pin"))!=mm::dump(pin)||record.at("state").string()!="completed")fail("INSTALLER_LAUNCH_CONFLICT");
  const auto& expected=record.at("monitor");
  Handle monitor(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(expected.at("pid").integer())));
  if(!monitor.valid()) {if(GetLastError()!=ERROR_INVALID_PARAMETER)return Json::Object{{"removed",false}};}
  else if(creation(monitor.value)==expected.at("creation_time").string()) {
    const auto ended=WaitForSingleObject(monitor.value,0);if(ended==WAIT_TIMEOUT)return Json::Object{{"removed",false}};if(ended!=WAIT_OBJECT_0)fail("IDENTITY_UNAVAILABLE");
  }
  const auto path=wide(record.at("monitor_image").string());auto ancestors=lockAncestors(path,false,false,rootPath("personal"));
  auto opened=openNativeChild(ancestors.back().value,path.substr(path.find_last_of(L'\\')+1),GENERIC_READ|READ_CONTROL|DELETE,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open);auto file=std::move(opened.handle);
  if(!file.valid()){if(static_cast<ULONG>(opened.status)==nativeNameMissing)return Json::Object{{"removed",true}};return Json::Object{{"removed",false}};}
  BY_HANDLE_FILE_INFORMATION info{};check(GetFileInformationByHandle(file.value,&info),"PATH_UNSAFE");
  if(info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)||info.nNumberOfLinks!=1)fail("PATH_UNSAFE");assertPrivateHandle(file.value);
  if(hashFile(file.value,16ULL*1024*1024)!=record.at("monitor_sha256").string())fail("HELPER_INTEGRITY_INVALID");
  FILE_DISPOSITION_INFO disposition{TRUE};
  if(!SetFileInformationByHandle(file.value,FileDispositionInfo,&disposition,sizeof(disposition)))return Json::Object{{"removed",false}};
  return Json::Object{{"removed",true}};
}
std::wstring installerEnvironment() {
  return consumerEnvironment(fixedLauncherPath().substr(0,fixedLauncherPath().find_last_of(L'\\')));
}
int installerMonitorMain(const std::wstring& pipeText) {
  try {
    const auto host = identityReport();
    if (host.at("native_arch").string() != "x64" || host.at("process_arch").string() != "x64" || host.at("os_build").integer() < 19045) return 2;
    auto input = inheritedHandle(Json::Object{{"pipe", utf8(pipeText)}}, "pipe");
    DWORD size = 0, count = 0;
    check(ReadFile(input.value, &size, 4, &count, nullptr) && count == 4 && size > 0 && size <= 4096, "JOB_UNAVAILABLE");
    std::string bytes(size, '\0'); check(ReadFile(input.value, bytes.data(), size, &count, nullptr) && count == size, "JOB_UNAVAILABLE");
    const auto config = mm::JsonParser(bytes).parse(); SecureZeroMemory(bytes.data(), bytes.size()); input.close();
    keys(config, {"pin", "nonce", "ready"}); validateInstallerPin(config.at("pin"));
    auto ready = inheritedHandle(config, "ready");
    Handle job; Handle child;
    Json record;
    {
      InstallerTransactionLock transaction;
      record = readInstallerCertificate();
      if (jsonNull(record) || record.at("state").string() != "launching" || !equalSecret(record.at("nonce").string(), config.at("nonce").string()) || mm::dump(record.at("pin")) != mm::dump(config.at("pin")) || mm::dump(record.at("monitor")) != mm::dump(processIdentity(GetCurrentProcessId()))) return 2;
      const auto& pin = config.at("pin");
      const auto path = rootPath("personal") + L"\\updates\\staging\\" + wide(pin.at("identity").string()) + L"\\installer.exe";
      auto ancestors = lockAncestors(path, false, false, rootPath("personal"));
      auto executable = lockHashedFile(path, pin.at("sha256").string(), false, 2ULL * 1024 * 1024 * 1024);
      LARGE_INTEGER sizeBytes{}; check(GetFileSizeEx(executable.value, &sizeBytes) && sizeBytes.QuadPart == pin.at("bytes").integer(), "HELPER_INTEGRITY_INVALID");
      verifyInstallerPublisher(path, executable.value, pin.at("publisher_sha256").string(),true);
      const auto sid=wide(currentIdentity().sid);
      Security security(L"O:"+sid+L"D:P(A;;0x001f003f;;;"+sid+L")(A;;0x001f003f;;;SY)");
      const auto jobName=L"Local\\MusicMuteInstaller-v1-"+sid+L"-"+std::to_wstring(currentIdentity().session)+L"-"+wide(record.at("nonce").string());
      job = Handle(CreateJobObjectW(&security.attributes, jobName.c_str())); if (!job.valid()||GetLastError()==ERROR_ALREADY_EXISTS) fail("JOB_UNAVAILABLE");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "JOB_UNAVAILABLE");
      const auto launcher = fixedLauncherPath(), destination = launcher.substr(0, launcher.find_last_of(L'\\'));
      auto command = quote(path) + L" /CURRENTUSER /D=" + destination;
      auto environment = installerEnvironment(); STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION process{};
      check(CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP, environment.data(), destination.c_str(), &startup, &process), "JOB_UNAVAILABLE");
      child = Handle(process.hProcess); Handle thread(process.hThread);
      try {
        check(AssignProcessToJobObject(job.value, child.value), "JOB_UNAVAILABLE");
        auto next = record.object(); next["process"] = processIdentity(process.dwProcessId); record = next;
        writeInstallerCertificate(record); // Still suspended and kill-on-monitor-death.
        check(ResumeThread(thread.value) == 1, "JOB_UNAVAILABLE");
        next["state"] = "running"; record = next; writeInstallerCertificate(record);
      } catch (...) { TerminateProcess(child.value, 2); throw; }
    }
    // A closed parent pipe is an ACK loss, not permission to kill/relaunch.
    const BYTE acknowledged = 1; DWORD wrote = 0; (void)WriteFile(ready.value, &acknowledged, 1, &wrote, nullptr); ready.close();
    check(WaitForSingleObject(child.value, INFINITE) == WAIT_OBJECT_0, "JOB_UNAVAILABLE");
    DWORD exitCode = 0; check(GetExitCodeProcess(child.value, &exitCode), "JOB_UNAVAILABLE");
    for (;;) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      check(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "JOB_UNAVAILABLE");
      if (accounting.ActiveProcesses == 0) break;
      Sleep(20);
    }
    {
      InstallerTransactionLock transaction;
      const auto current = readInstallerCertificate();
      if (jsonNull(current) || !equalSecret(current.at("nonce").string(), record.at("nonce").string()) || mm::dump(current.at("process")) != mm::dump(record.at("process"))) return 2;
      auto completed = current.object(); completed["state"] = "completed"; completed["exit_code"] = static_cast<std::int64_t>(exitCode); completed["tree_exited"] = true;
      writeInstallerCertificate(completed);
    }
    return 0;
  } catch (...) { return 2; }
}
Json launchInstallerCertified(const Json& pin) {
  validateInstallerPin(pin);
  Handle readyRead, monitor;
  {
    InstallerTransactionLock transaction;
    const auto previous = readInstallerCertificate();
    if (!jsonNull(previous)) {
      if (mm::dump(previous.at("pin")) == mm::dump(pin)) {
        resumeInstallerMonitor(previous);
        const auto status = installerCertificateStatus(previous);
        if (status.at("state").string() == "unknown" || jsonNull(previous.at("process"))) fail("INSTALLER_LAUNCH_UNKNOWN");
        return Json::Object{{"started", true}, {"identity", previous.at("process")}, {"status", status}};
      }
      if (previous.at("state").string() != "completed") fail("INSTALLER_LAUNCH_CONFLICT");
    }
    std::vector<wchar_t> image(32768); const auto imageSize = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
    if (!imageSize || imageSize >= image.size()) fail("HELPER_INTEGRITY_INVALID");
    const std::wstring ownExecutable(image.data(), imageSize);
    auto ownFile=std::move(openNativePath(ownExecutable,GENERIC_READ|READ_CONTROL,FILE_SHARE_READ,NativeChildKind::file).handle);
    if (!ownFile.valid()) fail("HELPER_INTEGRITY_INVALID"); assertPrivateHandle(ownFile.value, false, true);
    const auto digest = hashFile(ownFile.value);
    auto lockedSelf = lockHashedFile(ownExecutable, digest, true);
    verifyInstallerPublisher(ownExecutable,lockedSelf.value,pin.at("publisher_sha256").string());
    // NSIS replaces installed app files. The independent monitor must not keep
    // the old installed helper image locked; copy only these verified exact
    // bytes to the fixed private transaction directory before launching it.
    const auto executable=rootPath("personal")+L"\\updates\\staging\\"+wide(pin.at("identity").string())+L"\\monitor.exe";
    auto monitorAncestors=lockAncestors(executable,false,false,rootPath("personal"));
    if(nativeChildMissing(monitorAncestors.back().value,L"monitor.exe")) {
      const auto temporary=executable+L".pending-"+wide(randomHex());Security privateFile(dataSddl());
      auto output=std::move(openNativeChild(monitorAncestors.back().value,temporary.substr(temporary.find_last_of(L'\\')+1),GENERIC_READ|GENERIC_WRITE|DELETE|READ_CONTROL,0,NativeChildKind::file,NativeChildDisposition::createNew,privateFile.descriptor,true).handle);
      if(!output.valid())fail("PATH_UNSAFE");bool publicationAttempted=false;
      try {
        LARGE_INTEGER beginning{};check(SetFilePointerEx(lockedSelf.value,beginning,nullptr,FILE_BEGIN),"HELPER_INTEGRITY_INVALID");
        std::vector<BYTE> buffer(65536);DWORD read=0,wrote=0;std::uint64_t total=0;
        for(;;){check(ReadFile(lockedSelf.value,buffer.data(),static_cast<DWORD>(buffer.size()),&read,nullptr),"HELPER_INTEGRITY_INVALID");if(!read)break;total+=read;if(total>16ULL*1024*1024)fail("HELPER_INTEGRITY_INVALID");check(WriteFile(output.value,buffer.data(),read,&wrote,nullptr)&&wrote==read,"PATH_UNSAFE");}
        if(total<1)fail("HELPER_INTEGRITY_INVALID");check(FlushFileBuffers(output.value),"PATH_UNSAFE");BY_HANDLE_FILE_INFORMATION staged{};check(GetFileInformationByHandle(output.value,&staged),"PATH_UNSAFE");if(staged.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||staged.nNumberOfLinks!=1)fail("PATH_UNSAFE");assertPrivateHandle(output.value);if(hashFile(output.value,16ULL*1024*1024)!=digest)fail("HELPER_INTEGRITY_INVALID");
        publicationAttempted=true;check(renameNativeChild(output.value,monitorAncestors.back().value,L"monitor.exe").status==0,"PATH_UNSAFE");output.close();
      }catch(...){if(!publicationAttempted){FILE_DISPOSITION_INFO disposal{TRUE};(void)SetFileInformationByHandle(output.value,FileDispositionInfo,&disposal,sizeof(disposal));}throw;}
    }
    auto copiedMonitor=lockHashedFile(executable,digest,false,16ULL*1024*1024);
    verifyInstallerPublisher(executable,copiedMonitor.value,pin.at("publisher_sha256").string());
    const auto nonce = randomHex();
    auto record = Json::Object{{"version", 1}, {"nonce", nonce}, {"pin", pin}, {"state", "launching"}, {"monitor", nullptr}, {"monitor_thread", nullptr}, {"monitor_image", utf8(executable)}, {"monitor_sha256", digest}, {"process", nullptr}, {"exit_code", nullptr}, {"tree_exited", false}};
    writeInstallerCertificate(record); // Any crash from now on has a visible blocked transaction.
    SECURITY_ATTRIBUTES inherited{sizeof(inherited), nullptr, TRUE}; Handle input, writer, readyWrite;
    check(CreatePipe(&input.value, &writer.value, &inherited, 8192), "JOB_UNAVAILABLE");
    check(CreatePipe(&readyRead.value, &readyWrite.value, &inherited, 4096), "JOB_UNAVAILABLE");
    check(SetHandleInformation(writer.value, HANDLE_FLAG_INHERIT, 0) && SetHandleInformation(readyRead.value, HANDLE_FLAG_INHERIT, 0), "JOB_UNAVAILABLE");
    const auto config = mm::dump(Json::Object{{"pin", pin}, {"nonce", nonce}, {"ready", handleText(readyWrite)}});
    DWORD size = static_cast<DWORD>(config.size()), wrote = 0;
    check(WriteFile(writer.value, &size, 4, &wrote, nullptr) && wrote == 4, "JOB_UNAVAILABLE");
    check(WriteFile(writer.value, config.data(), size, &wrote, nullptr) && wrote == size, "JOB_UNAVAILABLE"); writer.close();
    SIZE_T attributeSize = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeSize);
    std::vector<BYTE> storage(attributeSize); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    check(InitializeProcThreadAttributeList(attributes, 1, 0, &attributeSize), "JOB_UNAVAILABLE");
    struct AttributeLifetime { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributeLifetime() { DeleteProcThreadAttributeList(value); } } attributeLifetime{attributes};
    HANDLE handles[]{input.value, readyWrite.value};
    check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr), "JOB_UNAVAILABLE");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes; PROCESS_INFORMATION process{};
    auto command = quote(executable) + L" --installer-monitor " + wide(handleText(input));
    BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob), "JOB_UNAVAILABLE");
    auto environment = installerEnvironment();
    check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | (inJob ? CREATE_BREAKAWAY_FROM_JOB : 0), environment.data(), nullptr, &startup.StartupInfo, &process), "JOB_UNAVAILABLE");
    monitor = Handle(process.hProcess); Handle thread(process.hThread); input.close(); readyWrite.close();
    Security monitorSecurity(dataSddl()); Handle temporaryJob(CreateJobObjectW(&monitorSecurity.attributes, nullptr));
    if (!temporaryJob.valid()) { TerminateProcess(monitor.value, 2); fail("JOB_UNAVAILABLE"); }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION monitorLimits{}; monitorLimits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    try {
      check(SetInformationJobObject(temporaryJob.value, JobObjectExtendedLimitInformation, &monitorLimits, sizeof(monitorLimits)) && AssignProcessToJobObject(temporaryJob.value, monitor.value), "JOB_UNAVAILABLE");
      record["monitor"] = processIdentity(process.dwProcessId);
      record["monitor_thread"] = Json::Object{{"tid", static_cast<std::int64_t>(process.dwThreadId)}, {"creation_time", threadCreation(thread.value)}};
      writeInstallerCertificate(record);
      // After the durable exact monitor receipt exists, parent death must leave
      // this monitor available for recovery instead of orphaning an unknown launch.
      monitorLimits.BasicLimitInformation.LimitFlags = 0;
      check(SetInformationJobObject(temporaryJob.value, JobObjectExtendedLimitInformation, &monitorLimits, sizeof(monitorLimits)), "JOB_UNAVAILABLE");
      check(ResumeThread(thread.value) == 1, "JOB_UNAVAILABLE");
    } catch (...) { TerminateProcess(monitor.value, 2); throw; }
  }
  const auto deadline = GetTickCount64() + 10000;
  for (;;) {
    DWORD available = 0;
    if (PeekNamedPipe(readyRead.value, nullptr, 0, nullptr, &available, nullptr) && available) { BYTE ready = 0; DWORD read = 0; check(ReadFile(readyRead.value, &ready, 1, &read, nullptr) && read == 1 && ready == 1, "JOB_UNAVAILABLE"); break; }
    if (WaitForSingleObject(monitor.value, 0) == WAIT_OBJECT_0 || GetTickCount64() >= deadline) fail("INSTALLER_LAUNCH_UNKNOWN");
    Sleep(10);
  }
  const auto record = readInstallerCertificate();
  if (jsonNull(record) || mm::dump(record.at("pin")) != mm::dump(pin) || jsonNull(record.at("process"))) fail("INSTALLER_LAUNCH_UNKNOWN");
  return Json::Object{{"started", true}, {"identity", record.at("process")}, {"status", installerCertificateStatus(record)}};
}
