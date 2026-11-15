#pragma once
#include "store_role_policy.hpp"
#include "store_capability_policy.hpp"
#include "store_broker_policy.hpp"
#include "store_session_policy.hpp"
#include "store_runtime.hpp"
#include "store_namespace.hpp"
#include "store_role_browser.hpp"
#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <thread>

namespace mmstorerole {
#ifdef _WIN32
using mmstore::detail::Handle;
using mmstore::ErrorCode;
using mmstore::require;
inline mmstoreruntime::LaunchKind launchKind(Role role) {
  switch (role) {
    case Role::session: return mmstoreruntime::LaunchKind::sessionAgent;
    case Role::login: return mmstoreruntime::LaunchKind::loginAgent;
    case Role::personal: return mmstoreruntime::LaunchKind::personalAgent;
    case Role::fleet: return mmstoreruntime::LaunchKind::fleetAgent;
    case Role::prepare: return mmstoreruntime::LaunchKind::prepareAgent;
  }
  mmstore::fail(ErrorCode::invalidInput);
}
namespace detail {
inline std::string ascii(std::wstring_view text) {
  std::string result; result.reserve(text.size());
  for (const auto character : text) {
    require(character > 0 && character < 128, ErrorCode::invalidInput);
    result += static_cast<char>(character);
  }
  return result;
}
inline std::wstring wide(std::string_view text) {
  std::wstring result; result.reserve(text.size());
  for (const auto character : text) {
    require(static_cast<unsigned char>(character) > 0 && static_cast<unsigned char>(character) < 128, ErrorCode::invalidInput);
    result += static_cast<wchar_t>(character);
  }
  return result;
}
inline std::string secret() {
  std::array<unsigned char, 32> bytes{};
  require(BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, ErrorCode::processDenied);
  static constexpr char hex[] = "0123456789abcdef";
  std::string result; result.reserve(64);
  for (const auto byte : bytes) { result += hex[byte >> 4]; result += hex[byte & 15]; }
  SecureZeroMemory(bytes.data(), bytes.size()); return result;
}
inline std::wstring pipeName(std::uint32_t creator, std::string_view channel) {
  require(creator > 0 && creator <= 2147483647U && mmstore::validDigest(channel), ErrorCode::invalidInput);
  return L"\\\\.\\pipe\\MusicMuteStoreRole-" + std::to_wstring(creator) + L"-" + wide(channel);
}
inline DWORD remaining(ULONGLONG deadline) {
  const auto now = GetTickCount64(); require(now < deadline, ErrorCode::processDenied);
  return static_cast<DWORD>(deadline - now);
}
inline DWORD complete(HANDLE pipe, OVERLAPPED& operation, BOOL started, DWORD bytes, ULONGLONG deadline) {
  if (started) return bytes;
  require(GetLastError() == ERROR_IO_PENDING, ErrorCode::processDenied);
  const auto wait = WaitForSingleObject(operation.hEvent, remaining(deadline));
  if (wait != WAIT_OBJECT_0) {
    (void)CancelIoEx(pipe, &operation); (void)GetOverlappedResult(pipe, &operation, &bytes, TRUE);
    mmstore::fail(ErrorCode::processDenied);
  }
  require(GetOverlappedResult(pipe, &operation, &bytes, FALSE) != FALSE, ErrorCode::processDenied);
  return bytes;
}
inline std::string readBoundedFrame(HANDLE pipe, ULONGLONG deadline, std::size_t maximum) {
  require(maximum == 4096 || maximum == 32768 || maximum == 65536, ErrorCode::invalidInput);
  std::string frame; Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(event.valid(), ErrorCode::processDenied);
  for (;;) {
    std::array<char, 1024> buffer{}; DWORD read = 0; OVERLAPPED operation{}; operation.hEvent = event.get();
    require(ResetEvent(event.get()) != FALSE, ErrorCode::processDenied);
    const auto started = ReadFile(pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &read, &operation);
    read = complete(pipe, operation, started, read, deadline);
    require(read > 0 && frame.size() + read <= maximum, ErrorCode::processDenied);
    frame.append(buffer.data(), read);
    if (frame.find('\n') != std::string::npos) {
      require(frame.back() == '\n' && frame.find('\n') == frame.size() - 1 &&
        frame.find('\r') == std::string::npos, ErrorCode::processDenied);
      DWORD available = 0; require(PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr) != FALSE && available == 0, ErrorCode::processDenied);
      return frame;
    }
  }
}
inline std::string readFrame(HANDLE pipe, ULONGLONG deadline) { return readBoundedFrame(pipe, deadline, 4096); }
inline std::string readGuiFrame(HANDLE pipe, ULONGLONG deadline) { return readBoundedFrame(pipe, deadline, 32768); }
inline std::string readControlFrame(HANDLE pipe, ULONGLONG deadline) { return readBoundedFrame(pipe, deadline, 65536); }
inline DWORD guiCreatorTransfer(HANDLE pipe, void* buffer, DWORD count, bool writing, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(event.valid(), ErrorCode::processDenied);
  DWORD transferred = 0; OVERLAPPED operation{}; operation.hEvent = event.get();
  const auto started = writing ? WriteFile(pipe, buffer, count, &transferred, &operation) : ReadFile(pipe, buffer, count, &transferred, &operation);
  if (started) return transferred;
  auto error = GetLastError(); if (!writing && error == ERROR_BROKEN_PIPE) return 0;
  require(error == ERROR_IO_PENDING, ErrorCode::processDenied);
  if (WaitForSingleObject(event.get(), remaining(deadline)) != WAIT_OBJECT_0) {
    (void)CancelIoEx(pipe, &operation); (void)GetOverlappedResult(pipe, &operation, &transferred, TRUE); mmstore::fail(ErrorCode::processDenied);
  }
  if (GetOverlappedResult(pipe, &operation, &transferred, FALSE)) return transferred;
  error = GetLastError(); if (!writing && error == ERROR_BROKEN_PIPE) return 0;
  mmstore::fail(ErrorCode::processDenied);
}
inline mm::Json confirmGuiCreator(mmstore::AttestedProcess& helper, mmstore::AttestedProcess& gui) {
  helper.revalidate(); gui.revalidate();
  require(helper.role() == mmstore::CodeRole::guiNative && gui.role() == mmstore::CodeRole::guiApplication &&
    helper.observation().fullName == gui.observation().fullName && helper.identity().sid == gui.identity().sid &&
    helper.identity().logonSid == gui.identity().logonSid && helper.identity().sessionId == gui.identity().sessionId &&
    mmstore::detail::parentPid(helper.identity().pid) == gui.identity().pid && mmstore::detail::creation(gui.handle()) <= mmstore::detail::creation(helper.handle()), ErrorCode::processDenied);
  const auto name = L"\\\\.\\pipe\\MusicMuteStoreGuiCreator-" + std::to_wstring(gui.identity().pid), challenge = wide(secret());
  const auto deadline = GetTickCount64() + 3000; Handle pipe;
  for (;;) {
    pipe = Handle(CreateFileW(name.c_str(), FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (pipe.valid()) break;
    const auto error = GetLastError(); require(error == ERROR_PIPE_BUSY || error == ERROR_FILE_NOT_FOUND, ErrorCode::processDenied);
    (void)remaining(deadline); Sleep(5);
  }
  ULONG server = 0; require(GetNamedPipeServerProcessId(pipe.get(), &server) != FALSE && server == gui.identity().pid, ErrorCode::processDenied);
  auto request = mm::dump(mm::Json::Object{{"version", 1}, {"challenge", ascii(challenge)}, {"helper_pid", static_cast<std::int64_t>(helper.identity().pid)}, {"helper_creation_time", ascii(helper.identity().creationTime)}}) + "\n";
  require(request.size() <= 2048 && guiCreatorTransfer(pipe.get(), request.data(), static_cast<DWORD>(request.size()), true, deadline) == request.size(), ErrorCode::processDenied);
  std::string frame;
  for (;;) {
    std::array<char, 256> bytes{}; const auto count = guiCreatorTransfer(pipe.get(), bytes.data(), static_cast<DWORD>(bytes.size()), false, deadline);
    require(count > 0 && frame.size() + count <= 2048, ErrorCode::processDenied); frame.append(bytes.data(), count);
    if (frame.find('\n') != std::string::npos) break;
  }
  const auto proof = guiCreatorReply(frame, ascii(challenge), helper.identity().pid, ascii(helper.identity().creationTime), ascii(gui.observation().fullName));
  char extra = 0; require(guiCreatorTransfer(pipe.get(), &extra, 1, false, deadline) == 0, ErrorCode::processDenied);
  helper.revalidate(); gui.revalidate();
  return proof;
}
inline void writeBoundedFrame(HANDLE pipe, const mm::Json& value, ULONGLONG deadline, std::size_t maximum) {
  require(maximum == 4096 || maximum == 32768 || maximum == 65536, ErrorCode::invalidInput);
  const auto text = mm::dump(value) + "\n"; require(text.size() <= maximum, ErrorCode::processDenied);
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(event.valid(), ErrorCode::processDenied);
  DWORD written = 0; OVERLAPPED operation{}; operation.hEvent = event.get();
  const auto started = WriteFile(pipe, text.data(), static_cast<DWORD>(text.size()), &written, &operation);
  require(complete(pipe, operation, started, written, deadline) == text.size(), ErrorCode::processDenied);
}
inline void writeFrame(HANDLE pipe, const mm::Json& value, ULONGLONG deadline) { writeBoundedFrame(pipe, value, deadline, 4096); }
inline void writeGuiFrame(HANDLE pipe, const mm::Json& value, ULONGLONG deadline) { writeBoundedFrame(pipe, value, deadline, 32768); }
inline void awaitClientClose(HANDLE pipe, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(event.valid(), ErrorCode::processDenied);
  char extra = 0; DWORD read = 0; OVERLAPPED operation{}; operation.hEvent = event.get();
  const auto started = ReadFile(pipe, &extra, 1, &read, &operation);
  if (!started && GetLastError() == ERROR_BROKEN_PIPE) return;
  require(!started && GetLastError() == ERROR_IO_PENDING, ErrorCode::processDenied);
  const auto result = WaitForSingleObject(event.get(), remaining(deadline));
  if (result != WAIT_OBJECT_0) { (void)CancelIoEx(pipe, &operation); (void)GetOverlappedResult(pipe, &operation, &read, TRUE); mmstore::fail(ErrorCode::processDenied); }
  require(GetOverlappedResult(pipe, &operation, &read, FALSE) == FALSE && GetLastError() == ERROR_BROKEN_PIPE,
    ErrorCode::processDenied);
}
inline Handle duplicate(HANDLE source, DWORD access, bool inheritable = false) {
  HANDLE result = nullptr;
  require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, access, inheritable ? TRUE : FALSE, 0) != FALSE, ErrorCode::processDenied);
  return Handle(result);
}
inline void requireMember(HANDLE process, HANDLE job, bool expected = true) {
  BOOL member = FALSE;
  require(IsProcessInJob(process, job, &member) != FALSE && (member != FALSE) == expected, ErrorCode::processDenied);
}
inline void requireKillJob(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  require(QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) != FALSE &&
    (limits.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0 &&
    (limits.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) == 0, ErrorCode::processDenied);
}
} // namespace detail

class StoreSessionCreator;
class StoreRoleIssuer final {
 public:
  StoreRoleIssuer(const StoreRoleIssuer&) = delete;
  StoreRoleIssuer& operator=(const StoreRoleIssuer&) = delete;
  ~StoreRoleIssuer() { close(); }
  const mmstore::ProcessIdentity& creator() const noexcept { return self_.identity(); }
  static StoreRoleIssuer& currentCreator() {
    require(active_ && active_->creator().pid == GetCurrentProcessId() && !active_->closing_, ErrorCode::processDenied);
    active_->self_.revalidate(); return *active_;
  }
  mmstoreruntime::FixedLaunchPlan guardianPlan() const {
    self_.revalidate(); return code_.heldLaunchPlan(mmstoreruntime::LaunchKind::nativeHelper);
  }
  // Called only after this exact creator has made the fixed native executable
  // suspended. The live claim is published before its primary thread resumes.
  mm::Json registerGuardian(HANDLE process, HANDLE job, HANDLE observedNode, GuardianKind kind) {
    std::lock_guard lock(mutex_); pruneGuardians(); require(!closing_ && guardians_.size() < 32, ErrorCode::processDenied);
    code_.revalidateOperationIdentity(); self_.revalidate();
    const auto nodePid = GetProcessId(observedNode);
    const auto found = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == nodePid; });
    require(found != nodes_.end() && CompareObjectHandles(found->second.job.get(), job) != FALSE, ErrorCode::processDenied);
    auto& node = found->second; node.process.revalidate();
    require(mmstore::detail::sameIdentity(node.process.identity(), mmstore::detail::processIdentity(observedNode)), ErrorCode::processDenied);
    auto child = code_.attestHeldChild(mmstore::CodeRole::workerNative, mmstore::detail::processIdentity(process), self_);
    detail::requireMember(child.handle(), job, false);
    require(!guardians_.contains(child.identity().pid), ErrorCode::processDenied);
    const auto capability = detail::secret();
    guardians_.emplace(child.identity().pid, Guardian{std::move(child), nodePid, creator().pid, kind, capability});
    return mm::Json::Object{{"version", 1}, {"creator_pid", static_cast<std::int64_t>(creator().pid)},
      {"creator_creation_time", detail::ascii(creator().creationTime)}, {"creator_channel", channel_},
      {"creator_capability", capability}};
  }
  void confirmGpuGuardianExit(HANDLE process) {
    std::lock_guard lock(mutex_);
    const auto pid = GetProcessId(process); const auto found = guardians_.find(pid);
    require(found != guardians_.end() && found->second.kind == GuardianKind::gpu && found->second.bound && CompareObjectHandles(process, found->second.process.handle()) != FALSE, ErrorCode::processDenied);
    const auto deadline = GetTickCount64() + 10000; unsigned watchdogs = 0;
    for (const auto& [id, guard] : guardians_) {
      if (id != pid && !(guard.kind == GuardianKind::watchdog && guard.parent == pid)) continue;
      if (id != pid) { ++watchdogs; require(guard.bound, ErrorCode::processDenied); }
      const auto now = GetTickCount64(); DWORD exit = 2;
      require(now < deadline && WaitForSingleObject(guard.process.handle(), static_cast<DWORD>(deadline - now)) == WAIT_OBJECT_0 && GetExitCodeProcess(guard.process.handle(), &exit) != FALSE && exit == 0, ErrorCode::processDenied);
    }
    require(watchdogs == 1, ErrorCode::processDenied);
  }
  void abortJobGuardianStartup(HANDLE process, HANDLE job, HANDLE observedNode) {
    std::lock_guard lock(mutex_); code_.revalidateCleanupIdentity(); self_.revalidate();
    const auto found = guardians_.find(GetProcessId(process));
    require(found != guardians_.end() && found->second.kind == GuardianKind::job && found->second.parent == creator().pid &&
      CompareObjectHandles(found->second.process.handle(), process), ErrorCode::processDenied);
    const auto node = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == found->second.node; });
    require(node != nodes_.end() && CompareObjectHandles(node->second.process.handle(), observedNode) && CompareObjectHandles(node->second.job.get(), job), ErrorCode::processDenied);
    // Called only from this creator's failed-start RAII path. It is not a
    // cleanup certificate and no JSON operation can set this private phase.
    found->second.startupAborted = true;
  }
  std::wstring channelPath() const { return detail::pipeName(creator().pid, channel_); }
  void close() noexcept {
    closing_ = true;
    if (stop_.valid()) (void)SetEvent(stop_.get());
    if (server_.joinable()) server_.join();
    for (auto& worker : connections_) if (worker.thread.joinable()) worker.thread.join();
    connections_.clear();
    std::lock_guard lock(mutex_);
    for (auto& [role, node] : nodes_) { (void)role; node.capability.scrub(); }
    for (auto& [pid, helper] : helpers_) { (void)pid; helper.capability.scrub(); }
    for (auto& [pid, guardian] : guardians_) { (void)pid; SecureZeroMemory(guardian.capability.data(), guardian.capability.size()); }
    for (auto& [pid, client] : guiClients_) { (void)pid; client->closed = true; wipeGuiClient(*client); }
    guiClients_.clear(); nodes_.clear(); helpers_.clear(); guardians_.clear(); SecureZeroMemory(channel_.data(), channel_.size());
  }
 private:
  void pruneGuardians() {
    for (auto it = guardians_.begin(); it != guardians_.end();) {
      DWORD exit = 2;
      if (WaitForSingleObject(it->second.process.handle(), 0) == WAIT_OBJECT_0 && GetExitCodeProcess(it->second.process.handle(), &exit) != FALSE && exit == 0) {
        SecureZeroMemory(it->second.capability.data(), it->second.capability.size()); it = guardians_.erase(it);
      } else ++it;
    }
  }
  struct GuiClient {
    mmstore::AttestedProcess process, parent; std::string capability, bindCapability;
    mm::Json owner, creator; std::string inventory; Handle job; bool closed = false; ReplayFence replay; std::optional<StoreGuiBrowserScope> browser;
    CpuForgetCompletions completedCpuForget{};
  };
  static void confirmGuiRights(GuiClient& client, bool cleanupOnly = false) {
    if (cleanupOnly && client.browser) { client.browser->revalidateCleanup(); return; }
    const auto proof = detail::confirmGuiCreator(client.process, client.parent);
    if (client.browser) client.browser->confirm(proof, cleanupOnly);
    else require(std::holds_alternative<std::nullptr_t>(proof.at("browser_attachment").value) && std::holds_alternative<std::nullptr_t>(proof.at("source_helper").value), ErrorCode::processDenied);
  }
  static void wipeGuiClient(GuiClient& client) noexcept {
    SecureZeroMemory(client.capability.data(), client.capability.size()); SecureZeroMemory(client.bindCapability.data(), client.bindCapability.size());
  }
  void pruneGuiClients() {
    for (auto it = guiClients_.begin(); it != guiClients_.end();) {
      const auto& client = *it->second;
      if (WaitForSingleObject(client.process.handle(), 0) == WAIT_OBJECT_0 || WaitForSingleObject(client.parent.handle(), 0) == WAIT_OBJECT_0) {
        wipeGuiClient(*it->second); it = guiClients_.erase(it);
      } else ++it;
    }
  }
  void revalidateGuiSession(const GuiClient& client, bool cleanupOnly = false) {
    const auto found = nodes_.find(Role::session); require(found != nodes_.end() && found->second.bound, ErrorCode::processDenied);
    auto& node = found->second;
    require(sameSecret(node.ownershipNonce, client.owner.at("nonce").string()) &&
      mm::dump(wireIdentity(node.process.identity())) == mm::dump(client.owner.at("identity")) && CompareObjectHandles(node.job.get(), client.job.get()) != FALSE,
      ErrorCode::processDenied);
    node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity(); detail::requireKillJob(node.job.get()); detail::requireMember(node.process.handle(), node.job.get());
    detail::requireMember(self_.handle(), node.job.get(), false); detail::requireMember(client.process.handle(), node.job.get(), false);
  }
  static mm::Json guiBindReply(const GuiClient& client, std::string_view nonce) {
    return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", std::string(nonce)}, {"client_capability", client.capability},
      {"owner", client.owner}, {"creator", client.creator}, {"inventory_sha256", client.inventory}};
  }
  static mm::Json wireIdentity(const mmstore::ProcessIdentity& value) {
    return mm::Json::Object{{"sid", detail::ascii(value.sid)}, {"session_id", static_cast<std::int64_t>(value.sessionId)}, {"pid", static_cast<std::int64_t>(value.pid)}, {"creation_time", detail::ascii(value.creationTime)}};
  }
  struct Node {
    Role role; mmstore::AttestedProcess process; mmstoreruntime::FixedLaunchPlan plan;
    Handle job; HelperCapabilityGeneration capability; std::string ownershipNonce; bool bound = false;
  };
  struct Helper {
    mmstore::AttestedProcess process; std::uint32_t node; HelperCapabilityGeneration capability; bool bound = false;
    CpuForgetCompletions completedCpuForget{};
  };
  struct Guardian {
    mmstore::AttestedProcess process; std::uint32_t node, parent; GuardianKind kind; std::string capability; bool bound = false; ReplayFence replay;
    bool startupAborted = false;
  };
  StoreRoleIssuer(mmstoreruntime::WorkerCodeAuthority code, mmstore::AttestedProcess self)
    : code_(std::move(code)), self_(std::move(self)), channel_(detail::secret()), stop_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    require(stop_.valid(), ErrorCode::processDenied);
    connections_.reserve(16);
  }
  static std::unique_ptr<StoreRoleIssuer> open() {
    auto code = mmstoreruntime::resolveWorkerCode();
    const auto plan = code.heldLaunchPlan(mmstoreruntime::LaunchKind::session);
    auto self = code.attestHeldMember(mmstore::CodeRole::workerSession, mmstore::detail::processIdentity(GetCurrentProcess()));
    require(mmstore::currentPackageFullName() == code.observation().fullName, ErrorCode::processDenied);
    plan.revalidateFixedAdmission();
    auto result = std::unique_ptr<StoreRoleIssuer>(new StoreRoleIssuer(std::move(code), std::move(self)));
    // First pipe is created synchronously, before any owned Node can run.
    auto first = result->createPipe(true);
    result->server_ = std::thread([issuer = result.get(), initial = std::move(first)]() mutable { issuer->serve(std::move(initial)); });
    return result;
  }
  Handle createPipe(bool first) {
    self_.revalidate();
    const auto sddl = L"O:" + creator().sid + L"D:P(A;;GA;;;" + creator().sid + L")(A;;GA;;;SY)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE, ErrorCode::processDenied);
    mmstore::detail::Local lifetime{descriptor}; SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
    Handle pipe(CreateNamedPipeW(channelPath().c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
      (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      17, 4096, 4096, 0, &security));
    require(pipe.valid(), ErrorCode::processDenied); return pipe;
  }
  std::string registerNode(Role role, HANDLE process, HANDLE job, std::string_view ownershipNonce) {
    std::lock_guard lock(mutex_); require(!closing_ && nodes_.size() < 5 && !nodes_.contains(role), ErrorCode::processDenied);
    code_.revalidateOperationIdentity(); self_.revalidate();
    auto plan = code_.heldLaunchPlan(launchKind(role));
    auto child = code_.attestHeldChild(mmstore::CodeRole::workerNode, mmstore::detail::processIdentity(process), self_);
    detail::requireKillJob(job); detail::requireMember(child.handle(), job); detail::requireMember(self_.handle(), job, false);
    require(mmstore::validDigest(ownershipNonce), ErrorCode::processDenied);
    const auto capability = detail::secret();
    nodes_.emplace(role, Node{role, std::move(child), std::move(plan), detail::duplicate(job, JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE), HelperCapabilityGeneration(capability), std::string(ownershipNonce)});
    return capability;
  }
  mm::Json inheritedNodeBootstrap(Role role, std::string_view capability) const {
    return mm::Json::Object{{"version", 1}, {"role", std::string(roleName(role))},
      {"creator_pid", static_cast<std::int64_t>(creator().pid)}, {"creator_creation_time", detail::ascii(creator().creationTime)},
      {"creator_channel", channel_}, {"capability", std::string(capability)}};
  }
  void retireNode(Role role, std::string_view ownershipNonce) {
    retireNodeRecords(role, ownershipNonce, false);
  }
  void retireUnresumedNode(Role role, std::string_view ownershipNonce, HANDLE process, HANDLE job) {
    {
      std::lock_guard lock(mutex_); const auto found = nodes_.find(role);
      require(found != nodes_.end() && role == Role::prepare && sameSecret(found->second.ownershipNonce, ownershipNonce) &&
        CompareObjectHandles(found->second.process.handle(), process) && CompareObjectHandles(found->second.job.get(), job), ErrorCode::processDenied);
    }
    // This private method is available only to the original Creator, whose
    // retained request/primary-thread phase must still be unresumed.
    retireNodeRecords(role, ownershipNonce, true);
  }
  void retireNodeRecords(Role role, std::string_view ownershipNonce, bool unresumed) {
    std::lock_guard lock(mutex_);
    const auto found = nodes_.find(role);
    require(found != nodes_.end() && sameSecret(found->second.ownershipNonce, ownershipNonce), ErrorCode::processDenied);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{};
    require(QueryInformationJobObject(found->second.job.get(), JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr) != FALSE &&
      state.ActiveProcesses == 0 && WaitForSingleObject(found->second.process.handle(), 0) == WAIT_OBJECT_0, ErrorCode::processDenied);
    const auto nodePid = found->second.process.identity().pid;
    const auto deadline = GetTickCount64() + 10000;
    for (const auto& [pid, guardian] : guardians_) {
      (void)pid; if (guardian.node != nodePid) continue;
      const auto now = GetTickCount64(); DWORD code = 2;
      require(now < deadline && WaitForSingleObject(guardian.process.handle(), static_cast<DWORD>(deadline - now)) == WAIT_OBJECT_0 &&
        GetExitCodeProcess(guardian.process.handle(), &code) != FALSE && guardianRetirementExit(guardian.kind, unresumed, guardian.startupAborted, code), ErrorCode::processDenied);
    }
    for (auto iterator = helpers_.begin(); iterator != helpers_.end();) {
      if (iterator->second.node != nodePid) { ++iterator; continue; }
      iterator->second.capability.scrub(); iterator = helpers_.erase(iterator);
    }
    for (auto iterator = guardians_.begin(); iterator != guardians_.end();) {
      if (iterator->second.node != nodePid) { ++iterator; continue; }
      SecureZeroMemory(iterator->second.capability.data(), iterator->second.capability.size()); iterator = guardians_.erase(iterator);
    }
    found->second.capability.scrub(); nodes_.erase(found);
  }
  mm::Json accept(HANDLE pipe, const Request& request) {
    std::unique_lock lock(mutex_); require(!closing_, ErrorCode::processDenied);
    ULONG clientPid = 0; require(GetNamedPipeClientProcessId(pipe, &clientPid) != FALSE && clientPid > 0, ErrorCode::processDenied);
    const auto oldGui = guiClients_.find(clientPid);
    const bool originalBindRecovery = request.operation == "gui-client-bind" && oldGui != guiClients_.end() && !oldGui->second->closed && sameSecret(oldGui->second->bindCapability, request.capability);
    const bool cleanupOnly = request.operation == "gui-client-close" || request.operation == "helper-rotate" || originalBindRecovery ||
      (request.operation == "gui-session" && cleanupGuiCommand(request.args)) || (request.operation == "broker" && cleanupBrokerName(request.command));
    const auto verifyCode = [&] { if (cleanupOnly) code_.revalidateCleanupIdentity(); else code_.revalidateOperationIdentity(); self_.revalidate(); };
    verifyCode();
    if (request.operation == "gui-client-bind") {
      pruneGuiClients(); require(static_cast<bool>(gui_), ErrorCode::processDenied);
      const auto existing = guiClients_.find(clientPid);
      if (existing != guiClients_.end()) {
        auto& client = *existing->second;
        client.process.revalidate(); client.parent.revalidate();
        require(mmstore::detail::parentPid(clientPid) == client.parent.identity().pid, ErrorCode::processDenied);
        confirmGuiRights(client, cleanupOnly);
        if (!client.closed) {
          // A lost bind ACK recovers only the originally held claim. The
          // cached original Node may have exited; this grants cleanup only
          // until revalidateGuiSession admits actual subsequent new work.
          require(sameSecret(client.bindCapability, request.capability), ErrorCode::processDenied);
          client.replay.consume(request.nonce);
          return guiBindReply(client, request.nonce);
        }
        require(!sameSecret(client.bindCapability, request.capability), ErrorCode::processDenied);
      } else require(guiClients_.size() < 32, ErrorCode::processDenied);
      code_.revalidateOperationIdentity();
      const auto session = nodes_.find(Role::session); require(session != nodes_.end() && session->second.bound, ErrorCode::processDenied);
      session->second.process.revalidate(); session->second.plan.revalidateOperationIdentity(); detail::requireKillJob(session->second.job.get()); detail::requireMember(session->second.process.handle(), session->second.job.get());
      auto guiPackage = mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui); auto indexFile = guiPackage.openInventory();
      const auto bytes = indexFile.read(8 * 1024 * 1024); const auto inventory = mmstoreinventory::parse(mmstore::PackageKind::gui, mm::JsonParser::storeCodeInventory(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
      auto process = mmstore::attestProcess(clientPid, mmstore::CodeRole::guiNative, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiNative));
      const auto parentPid = mmstore::detail::parentPid(clientPid); auto parent = mmstore::attestProcess(parentPid, mmstore::CodeRole::guiApplication, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiApplication));
      require(process.observation().fullName == guiPackage.observation().fullName && parent.observation().fullName == process.observation().fullName &&
        parent.identity().sid == creator().sid && parent.identity().logonSid == creator().logonSid && parent.identity().sessionId == creator().sessionId &&
        mmstore::detail::creation(parent.handle()) <= mmstore::detail::creation(process.handle()) && mmstore::detail::parentPid(clientPid) == parent.identity().pid, ErrorCode::processDenied);
      detail::requireMember(process.handle(), session->second.job.get(), false); process.revalidate(); parent.revalidate(); indexFile.revalidate(); guiPackage.revalidate();
      const auto guiProof = detail::confirmGuiCreator(process, parent);
      const auto capability = detail::secret();
      auto client = std::make_shared<GuiClient>(GuiClient{std::move(process), std::move(parent), capability, request.capability,
        mm::Json::Object{{"role", "session-agent"}, {"nonce", session->second.ownershipNonce}, {"identity", wireIdentity(session->second.process.identity())}},
        wireIdentity(creator()), code_.inventorySha256(), detail::duplicate(session->second.job.get(), JOB_OBJECT_QUERY), false, {}, std::nullopt});
      if (!std::holds_alternative<std::nullptr_t>(guiProof.at("browser_attachment").value)) client->browser.emplace(StoreGuiBrowserScope::open(guiProof, inventory, client->process, client->parent));
      confirmGuiRights(*client, cleanupOnly); revalidateGuiSession(*client, cleanupOnly);
      client->replay.consume(request.nonce);
      if (existing != guiClients_.end()) { wipeGuiClient(*existing->second); existing->second = client; }
      else guiClients_.emplace(clientPid, client);
      return guiBindReply(*client, request.nonce);
    }
    if (request.operation == "gui-session" || request.operation == "gui-client-close") {
      const auto found = guiClients_.find(clientPid); require(found != guiClients_.end(), ErrorCode::processDenied); const auto client = found->second;
      require(sameSecret(client->capability, request.capability), ErrorCode::processDenied);
      client->process.revalidate(); client->parent.revalidate(); require(mmstore::detail::parentPid(clientPid) == client->parent.identity().pid, ErrorCode::processDenied);
      confirmGuiRights(*client, cleanupOnly);
      if (request.operation == "gui-client-close") {
        // Retain the exact live helper's closed tombstone until its held
        // process/parent dies. An ACK loss can repeat close without new work.
        client->replay.consume(request.nonce); client->closed = true;
        return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce}, {"closed", true}};
      }
      require(!client->closed && gui_ && storeCreatorGuiCommand(request.args), ErrorCode::processDenied); revalidateGuiSession(*client, cleanupOnly);
      client->replay.consume(request.nonce);
      const auto execute = gui_; lock.unlock();
      const auto result = execute(client, request.args);
      lock.lock(); require(!closing_ && !client->closed && guiClients_.contains(clientPid) && guiClients_.at(clientPid) == client, ErrorCode::processDenied);
      verifyCode(); client->process.revalidate(); client->parent.revalidate(); confirmGuiRights(*client, cleanupOnly); revalidateGuiSession(*client, cleanupOnly);
      return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce}, {"result", result}};
    }
    if (request.operation == "helper-rotate") {
      const auto found = helpers_.find(clientPid); require(found != helpers_.end() && found->second.bound, ErrorCode::processDenied);
      auto& helper = found->second; helper.process.revalidate();
      const auto parent = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == helper.node; });
      require(parent != nodes_.end() && parent->second.bound && mmstore::detail::parentPid(clientPid) == parent->second.process.identity().pid, ErrorCode::processDenied);
      auto& node = parent->second; node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity();
      detail::requireKillJob(node.job.get()); detail::requireMember(node.process.handle(), node.job.get()); detail::requireMember(helper.process.handle(), node.job.get());
      detail::requireMember(self_.handle(), node.job.get(), false);
      const auto rotation = helper.capability.rotate(request.capability, request.nonce, detail::secret());
      verifyCode(); helper.process.revalidate(); node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity();
      return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce}, {"rotated", rotation.rotated},
        {"capability", rotation.capability}, {"remaining", static_cast<std::int64_t>(rotation.remaining)},
        {"pid", static_cast<std::int64_t>(helper.process.identity().pid)}, {"creation_time", detail::ascii(helper.process.identity().creationTime)},
        {"node_pid", static_cast<std::int64_t>(node.process.identity().pid)}, {"node_creation_time", detail::ascii(node.process.identity().creationTime)},
        {"creator_pid", static_cast<std::int64_t>(creator().pid)}, {"creator_creation_time", detail::ascii(creator().creationTime)}};
    }
    if (request.operation == "broker") {
      const auto found = helpers_.find(clientPid);
      require(found != helpers_.end() && found->second.bound && sameSecret(found->second.capability.current(), request.capability), ErrorCode::processDenied);
      auto& helper = found->second; helper.process.revalidate();
      const auto parent = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == helper.node; });
      require(parent != nodes_.end() && parent->second.bound && mmstore::detail::parentPid(clientPid) == parent->second.process.identity().pid,
        ErrorCode::processDenied);
      auto& node = parent->second; node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity();
      detail::requireKillJob(node.job.get()); detail::requireMember(helper.process.handle(), node.job.get());
      detail::requireMember(self_.handle(), node.job.get(), false);
      const auto command = parseBrokerCommand(request.command);
      const auto actor = node.role;
      require(broker_ && brokerOperation(actor, command, request.args), ErrorCode::processDenied);
      helper.capability.enterBroker(request.capability, request.nonce);
      // Production callback is installed privately by the genuine creator. It
      // may await suspended guardian callbacks on other bounded connections;
      // no issuer-table lock or listener thread is held across that operation.
      const auto sourceIdentity = helper.process.identity();
      auto sourceProcess = detail::duplicate(helper.process.handle(), PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE);
      const auto execute = broker_; lock.unlock();
      bool finished = false;
      const auto finish = [&] { if (finished) return; finished = true; std::lock_guard guard(mutex_); const auto original = helpers_.find(clientPid);
        if (original != helpers_.end() && mmstore::detail::sameIdentity(original->second.process.identity(), sourceIdentity)) original->second.capability.finishBroker(); };
      try { const auto result = execute(actor, command, request.args, sourceIdentity, sourceProcess.get()); finish();
        return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce}, {"result", result}};
      } catch (...) { finish(); throw; }
    }
    if (request.operation == "register-watchdog") {
      const auto parent = guardians_.find(clientPid);
      require(parent != guardians_.end() && parent->second.bound && parent->second.kind == GuardianKind::gpu &&
        sameSecret(parent->second.capability, request.capability) && guardians_.size() < 32 && !guardians_.contains(request.child), ErrorCode::processDenied);
      parent->second.process.revalidate();
      const auto node = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == parent->second.node; });
      require(node != nodes_.end(), ErrorCode::processDenied); node->second.process.revalidate();
      Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, request.child)); require(process.valid(), ErrorCode::processDenied);
      auto child = code_.attestHeldChild(mmstore::CodeRole::workerNative, mmstore::detail::processIdentity(process.get()), parent->second.process);
      detail::requireMember(child.handle(), node->second.job.get(), false);
      parent->second.replay.consume(request.nonce);
      const auto capability = detail::secret();
      guardians_.emplace(request.child, Guardian{std::move(child), parent->second.node, clientPid, GuardianKind::watchdog, capability});
      return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce},
        {"pid", static_cast<std::int64_t>(request.child)}, {"creator_pid", static_cast<std::int64_t>(creator().pid)},
        {"creator_creation_time", detail::ascii(creator().creationTime)}, {"creator_channel", channel_},
        {"creator_capability", capability}};
    }
    if (request.operation == "guardian-bind") {
      const auto found = guardians_.find(clientPid);
      require(found != guardians_.end() && !found->second.bound && sameSecret(found->second.capability, request.capability), ErrorCode::processDenied);
      auto& guardian = found->second; guardian.process.revalidate();
      const auto parent = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == guardian.node; });
      require(parent != nodes_.end(), ErrorCode::processDenied); auto& node = parent->second;
      node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity(); detail::requireMember(guardian.process.handle(), node.job.get(), false);
      const auto jobName = L"Local\\MusicMuteOwnedRole-v1-" + creator().sid + L"-" + std::to_wstring(creator().sessionId) + L"-" +
        detail::wide(roleName(node.role)) + L"-" + detail::wide(node.ownershipNonce);
      const auto reply = mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce},
        {"capability", request.capability}, {"pid", static_cast<std::int64_t>(guardian.process.identity().pid)},
        {"creation_time", detail::ascii(guardian.process.identity().creationTime)}, {"kind", std::string(guardianName(guardian.kind))},
        {"role", std::string(roleName(node.role))},
        {"node_pid", static_cast<std::int64_t>(node.process.identity().pid)}, {"node_creation_time", detail::ascii(node.process.identity().creationTime)},
        {"job_name", detail::ascii(jobName)}, {"creator_pid", static_cast<std::int64_t>(creator().pid)},
        {"creator_creation_time", detail::ascii(creator().creationTime)}};
      guardian.replay.consume(request.nonce); guardian.bound = true; return reply;
    }
    if (request.operation == "helper-bind") {
      const auto found = helpers_.find(clientPid); require(found != helpers_.end() && !found->second.bound && sameSecret(found->second.capability.current(), request.capability), ErrorCode::processDenied);
      auto& helper = found->second; helper.process.revalidate();
      const auto parent = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == helper.node; });
      require(parent != nodes_.end() && parent->second.bound, ErrorCode::processDenied);
      auto& node = parent->second; node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity();
      require(mmstore::detail::parentPid(clientPid) == node.process.identity().pid, ErrorCode::processDenied);
      detail::requireMember(helper.process.handle(), node.job.get());
      const auto reply = mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce},
        {"capability", request.capability}, {"pid", static_cast<std::int64_t>(helper.process.identity().pid)},
        {"creation_time", detail::ascii(helper.process.identity().creationTime)}, {"role", std::string(roleName(node.role))},
        {"ownership_nonce", node.ownershipNonce},
        {"node_pid", static_cast<std::int64_t>(node.process.identity().pid)}, {"node_creation_time", detail::ascii(node.process.identity().creationTime)},
        {"creator_pid", static_cast<std::int64_t>(creator().pid)}, {"creator_creation_time", detail::ascii(creator().creationTime)}};
      helper.capability.bind(request.nonce); helper.bound = true; return reply;
    }
    const auto found = std::find_if(nodes_.begin(), nodes_.end(), [&](const auto& item) { return item.second.process.identity().pid == clientPid; });
    require(found != nodes_.end(), ErrorCode::processDenied); auto& node = found->second;
    node.process.revalidate(); if (cleanupOnly) node.plan.revalidateCleanupIdentity(); else node.plan.revalidateOperationIdentity(); detail::requireMember(node.process.handle(), node.job.get());
    if (request.operation == "node-rotate") {
      require(node.bound, ErrorCode::processDenied);
      const auto rotation = node.capability.rotate(request.capability, request.nonce, detail::secret());
      code_.revalidateOperationIdentity(); self_.revalidate(); node.process.revalidate(); node.plan.revalidateOperationIdentity();
      detail::requireKillJob(node.job.get()); detail::requireMember(node.process.handle(), node.job.get()); detail::requireMember(self_.handle(), node.job.get(), false);
      return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce}, {"rotated", rotation.rotated},
        {"capability", rotation.capability}, {"remaining", static_cast<std::int64_t>(rotation.remaining)},
        {"pid", static_cast<std::int64_t>(node.process.identity().pid)}, {"creation_time", detail::ascii(node.process.identity().creationTime)},
        {"node_pid", static_cast<std::int64_t>(node.process.identity().pid)}, {"node_creation_time", detail::ascii(node.process.identity().creationTime)},
        {"creator_pid", static_cast<std::int64_t>(creator().pid)}, {"creator_creation_time", detail::ascii(creator().creationTime)}};
    }
    require(sameSecret(node.capability.current(), request.capability), ErrorCode::processDenied);
    if (request.operation == "node-bind") {
      require(!node.bound, ErrorCode::processDenied); node.capability.bind(request.nonce); node.bound = true;
      return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce},
        {"role", std::string(roleName(node.role))}, {"pid", static_cast<std::int64_t>(node.process.identity().pid)},
        {"creation_time", detail::ascii(node.process.identity().creationTime)}};
    }
    for (auto iterator = helpers_.begin(); iterator != helpers_.end();) {
      if (WaitForSingleObject(iterator->second.process.handle(), 0) != WAIT_OBJECT_0) { ++iterator; continue; }
      iterator->second.capability.scrub(); iterator = helpers_.erase(iterator);
    }
    require(request.operation == "register-helper" && node.bound && helpers_.size() < 64 && !helpers_.contains(request.child), ErrorCode::processDenied);
    node.capability.enterBroker(request.capability, request.nonce);
    // Registration is an actual private actor operation too. Keep its active
    // fence through full child admission; exceptional completion cannot leave
    // a capability apparently idle or silently forget the original attempt.
    struct Registration { HelperCapabilityGeneration& capability; ~Registration() { capability.finishBroker(); } } registration{node.capability};
    const auto native = code_.heldLaunchPlan(mmstoreruntime::LaunchKind::nativeHelper); native.revalidateFixedAdmission();
    Handle actual(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, request.child));
    require(actual.valid(), ErrorCode::processDenied);
    auto helper = code_.attestHeldChild(mmstore::CodeRole::workerNative, mmstore::detail::processIdentity(actual.get()), node.process);
    detail::requireMember(helper.handle(), node.job.get());
    const auto capability = detail::secret(); const auto birth = detail::ascii(helper.identity().creationTime);
    helpers_.emplace(request.child, Helper{std::move(helper), node.process.identity().pid, HelperCapabilityGeneration(capability)});
    return mm::Json::Object{{"version", 1}, {"accepted", true}, {"request_nonce", request.nonce},
      {"pid", static_cast<std::int64_t>(request.child)}, {"creation_time", birth}, {"capability", capability},
      {"creator_pid", static_cast<std::int64_t>(creator().pid)}, {"creator_creation_time", detail::ascii(creator().creationTime)},
      {"creator_channel", channel_}, {"role", std::string(roleName(node.role))}};
  }
  void serve(Handle pipe) noexcept {
    try {
      while (!closing_) {
        Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(connected.valid(), ErrorCode::processDenied);
        OVERLAPPED operation{}; operation.hEvent = connected.get();
        const auto started = ConnectNamedPipe(pipe.get(), &operation);
        if (!started && GetLastError() != ERROR_PIPE_CONNECTED) {
          require(GetLastError() == ERROR_IO_PENDING, ErrorCode::processDenied);
          HANDLE watched[]{stop_.get(), connected.get()}; const auto result = WaitForMultipleObjects(2, watched, FALSE, INFINITE);
          if (result == WAIT_OBJECT_0) { (void)CancelIoEx(pipe.get(), &operation); DWORD ignored = 0; (void)GetOverlappedResult(pipe.get(), &operation, &ignored, TRUE); break; }
          require(result == WAIT_OBJECT_0 + 1, ErrorCode::processDenied); DWORD ignored = 0;
          require(GetOverlappedResult(pipe.get(), &operation, &ignored, FALSE) != FALSE, ErrorCode::processDenied);
        }
        for (auto iterator = connections_.begin(); iterator != connections_.end();) {
          if (!iterator->done->load()) { ++iterator; continue; }
          iterator->thread.join(); iterator = connections_.erase(iterator);
        }
        if (connections_.size() >= 16) { (void)DisconnectNamedPipe(pipe.get()); pipe = Handle(); pipe = createPipe(false); continue; }
        auto next = createPipe(false);
        auto done = std::make_shared<std::atomic<bool>>(false);
        std::thread worker([this, connection = std::move(pipe), done]() mutable {
          try {
            const auto request = parseRequest(detail::readControlFrame(connection.get(), GetTickCount64() + 10000));
            const auto deadline = GetTickCount64() + (request.operation == "broker" || request.operation == "gui-session" ? 30000 : 10000);
            const auto reply = accept(connection.get(), request);
            if ((request.operation == "broker" && controlLargeCommand(request.command)) ||
                (request.operation == "gui-session" && guiForward(request.args))) detail::writeBoundedFrame(connection.get(), reply, deadline, 65536);
            else if (request.operation == "gui-session") detail::writeGuiFrame(connection.get(), reply, deadline); else detail::writeFrame(connection.get(), reply, deadline);
            // A buffered WriteFile alone is not ACK delivery. Require the
            // complete client read and EOF before retiring this connection.
            detail::awaitClientClose(connection.get(), deadline);
          } catch (...) { /* The failed connection gains no authority. */ }
          (void)DisconnectNamedPipe(connection.get()); done->store(true);
        });
        connections_.push_back(Connection{std::move(worker), std::move(done)}); pipe = std::move(next);
      }
    } catch (...) { closing_ = true; (void)SetEvent(stop_.get()); }
  }
  mmstoreruntime::WorkerCodeAuthority code_; mmstore::AttestedProcess self_; std::string channel_;
  Handle stop_; std::thread server_; std::atomic<bool> closing_{false}; std::mutex mutex_;
  struct Connection { std::thread thread; std::shared_ptr<std::atomic<bool>> done; };
  std::vector<Connection> connections_;
  std::function<mm::Json(Role, BrokerCommand, const mm::Json&, const mmstore::ProcessIdentity&, HANDLE)> broker_;
  std::map<Role, Node> nodes_; std::map<std::uint32_t, Helper> helpers_;
  std::map<std::uint32_t, Guardian> guardians_;
  std::map<std::uint32_t, std::shared_ptr<GuiClient>> guiClients_;
  std::function<mm::Json(std::shared_ptr<GuiClient>, const mm::Json&)> gui_;
  inline static StoreRoleIssuer* active_ = nullptr;
  friend class StoreSessionCreator;
};

// A reply is retained only after an actual live fixed Store Session pipe and its
// one-use spawned-helper claim have authenticated the actual helper. It is never
// constructible from JSON, an on-disk receipt, a Node image, or selected PPID.
class StoreRoleBinding final {
 public:
  StoreRoleBinding(StoreRoleBinding&&) noexcept = default;
  StoreRoleBinding& operator=(StoreRoleBinding&&) noexcept = default;
  StoreRoleBinding(const StoreRoleBinding&) = delete;
  StoreRoleBinding& operator=(const StoreRoleBinding&) = delete;
  static StoreRoleBinding open(const mmstore::BootstrapAttestation& helper, const mm::Json& arguments) {
    exactFields(arguments, {"creator_pid", "creator_creation_time", "creator_channel", "creator_capability"});
    const auto creatorPid = pid(arguments.at("creator_pid"));
    const auto creatorBirth = arguments.at("creator_creation_time").string();
    const auto channel = arguments.at("creator_channel").string(), capability = arguments.at("creator_capability").string();
    require(validBirth(creatorBirth) && mmstore::validDigest(channel) && mmstore::validDigest(capability) &&
      helper.package.kind() == mmstore::PackageKind::worker && helper.parent.role() == mmstore::CodeRole::workerNode,
      ErrorCode::processDenied);
    helper.self.revalidate(); helper.parent.revalidate(); helper.package.revalidate();
    auto code = mmstoreruntime::resolveWorkerCode();
    const auto plan = code.heldLaunchPlan(mmstoreruntime::LaunchKind::session);
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, creatorPid)); require(process.valid(), ErrorCode::processDenied);
    auto creator = code.attestHeldMember(mmstore::CodeRole::workerSession, mmstore::detail::processIdentity(process.get()));
    require(detail::ascii(creator.identity().creationTime) == creatorBirth &&
      creator.observation().fullName == helper.package.observation().fullName, ErrorCode::processDenied);
    const auto name = detail::pipeName(creatorPid, channel); const auto deadline = GetTickCount64() + 10000;
    require(WaitNamedPipeW(name.c_str(), 10000) != FALSE, ErrorCode::processDenied);
    Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); require(pipe.valid(), ErrorCode::processDenied);
    ULONG server = 0; require(GetNamedPipeServerProcessId(pipe.get(), &server) != FALSE && server == creatorPid, ErrorCode::processDenied);
    creator.revalidate(); helper.self.revalidate(); helper.parent.revalidate();
    const auto nonce = detail::secret();
    detail::writeFrame(pipe.get(), mm::Json::Object{{"version", 1}, {"operation", "helper-bind"},
      {"request_nonce", nonce}, {"capability", capability}}, deadline);
    const auto reply = mm::JsonParser(detail::readFrame(pipe.get(), deadline)).parse();
    exactFields(reply, {"version", "accepted", "request_nonce", "capability", "pid", "creation_time", "role", "ownership_nonce",
      "node_pid", "node_creation_time", "creator_pid", "creator_creation_time"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) &&
      sameSecret(reply.at("request_nonce").string(), nonce) && sameSecret(reply.at("capability").string(), capability) &&
      pid(reply.at("pid")) == helper.self.identity().pid && detail::wide(reply.at("creation_time").string()) == helper.self.identity().creationTime &&
      pid(reply.at("node_pid")) == helper.parent.identity().pid && detail::wide(reply.at("node_creation_time").string()) == helper.parent.identity().creationTime &&
      pid(reply.at("creator_pid")) == creatorPid && reply.at("creator_creation_time").string() == creatorBirth, ErrorCode::processDenied);
    const auto role = parseRole(reply.at("role").string()); auto rolePlan = code.heldLaunchPlan(launchKind(role));
    const auto ownershipNonce = reply.at("ownership_nonce").string();
    require(mmstore::validDigest(ownershipNonce), ErrorCode::processDenied);
    const auto jobName = L"Local\\MusicMuteOwnedRole-v1-" + creator.identity().sid + L"-" + std::to_wstring(creator.identity().sessionId) +
      L"-" + detail::wide(roleName(role)) + L"-" + detail::wide(ownershipNonce);
    Handle job(OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, jobName.c_str())); require(job.valid(), ErrorCode::processDenied);
    detail::requireKillJob(job.get()); detail::requireMember(helper.self.handle(), job.get());
    detail::requireMember(helper.parent.handle(), job.get()); detail::requireMember(creator.handle(), job.get(), false);
    rolePlan.revalidateFixedAdmission(); creator.revalidate(); helper.self.revalidate(); helper.parent.revalidate();
    return StoreRoleBinding(std::move(code), std::move(creator), role, std::move(rolePlan), helper.parent.identity(), helper.self.identity(), ownershipNonce,
      std::move(job), channel, capability);
  }
  Role role() const noexcept { return role_; }
  const mmstore::ProcessIdentity& creatorIdentity() const noexcept { return creator_.identity(); }
  const mmstore::ProcessIdentity& nodeIdentity() const noexcept { return node_; }
  const std::string& ownerNonce() const noexcept { return ownershipNonce_; }
  std::string inventorySha256() const { return code_.inventorySha256(); }
  const mmstore::Observation& observation() const noexcept { return creator_.observation(); }
  HANDLE jobHandle() const noexcept { return job_.get(); }
  mmstore::AttestedProcess attestGpuKeeper(const mmstore::ProcessIdentity& identity) const {
    code_.revalidateOperationIdentity(); creator_.revalidate();
    auto keeper = code_.attestHeldChild(mmstore::CodeRole::workerNative, identity, creator_);
    detail::requireMember(keeper.handle(), job_.get(), false); return keeper;
  }
  HANDLE creatorHandle() const noexcept { return creator_.handle(); }
  mm::Json broker(const mmstore::BootstrapAttestation& helper, BrokerCommand command, const mm::Json& args) const {
    std::lock_guard serial(*brokerMutex_); require(brokerOperation(role_, command, args), ErrorCode::processDenied);
    const bool cleanupOnly = cleanupBrokerOperation(role_, command, args);
    const auto verify = [&] { if (cleanupOnly) revalidateCleanup(helper); else revalidate(helper); };
    verify();
    rotateIfNeeded(helper, cleanupOnly); ++brokerAttempts_;
    const auto name = detail::pipeName(creator_.identity().pid, channel_); const auto deadline = GetTickCount64() + 30000;
    require(WaitNamedPipeW(name.c_str(), 10000) != FALSE, ErrorCode::processDenied);
    Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); require(pipe.valid(), ErrorCode::processDenied);
    ULONG server = 0; require(GetNamedPipeServerProcessId(pipe.get(), &server) != FALSE && server == creator_.identity().pid, ErrorCode::processDenied);
    verify(); const auto nonce = detail::secret();
    const bool control = controlLargeCommand(brokerName(command));
    detail::writeBoundedFrame(pipe.get(), mm::Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", nonce},
      {"capability", capability_}, {"command", std::string(brokerName(command))}, {"args", args}}, deadline, control ? 65536 : 4096);
    const auto reply = mm::JsonParser(control ? detail::readControlFrame(pipe.get(), deadline) : detail::readFrame(pipe.get(), deadline)).parse();
    exactFields(reply, {"version", "accepted", "request_nonce", "result"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) && sameSecret(reply.at("request_nonce").string(), nonce), ErrorCode::processDenied);
    verify(); return reply.at("result");
  }
  mm::Json cleanupState(const mmstore::BootstrapAttestation& helper, const mm::Json& expectedOwner) const {
    require(role_ == Role::personal, ErrorCode::processDenied);
    const auto result = broker(helper, BrokerCommand::cleanupState, mm::Json::Object{{"owner", expectedOwner}});
    exactFields(result, {"retired", "tool_free"});
    require(std::holds_alternative<bool>(result.at("retired").value) && std::holds_alternative<bool>(result.at("tool_free").value) &&
      !(std::get<bool>(result.at("retired").value) && std::get<bool>(result.at("tool_free").value)), ErrorCode::processDenied);
    return result;
  }
  mm::Json cpuCleanupState(const mmstore::BootstrapAttestation& helper, const mm::Json& expectation) const {
    require(cpuOperationExpectation(expectation) && cpuToolRole(role_), ErrorCode::processDenied);
    const auto result = broker(helper, BrokerCommand::cpuInspect, mm::Json::Object{{"token", expectation.at("token")}, {"expectation", expectation}});
    exactFields(result, {"retired"}); require(std::holds_alternative<bool>(result.at("retired").value), ErrorCode::processDenied); return result;
  }
  void cpuForgetCompleted(const mmstore::BootstrapAttestation& helper, const mm::Json& expectation, const std::string& requestId) const {
    require(cpuOperationExpectation(expectation) && cpuToolRole(role_), ErrorCode::processDenied);
    const auto result = broker(helper, BrokerCommand::cpuForget, mm::Json::Object{{"expectation", expectation}, {"request_id", requestId}});
    exactFields(result, {"forgotten"}); require(std::holds_alternative<bool>(result.at("forgotten").value) &&
      std::get<bool>(result.at("forgotten").value), ErrorCode::processDenied);
  }
  void cpuReleaseCompleted(const mmstore::BootstrapAttestation& helper, const mm::Json& expectation, const std::string& requestId) const {
    require(cpuOperationExpectation(expectation) && cpuToolRole(role_), ErrorCode::processDenied);
    const auto result = broker(helper, BrokerCommand::cpuRelease, mm::Json::Object{{"expectation", expectation}, {"request_id", requestId}});
    exactFields(result, {"released"}); require(std::holds_alternative<bool>(result.at("released").value) && std::get<bool>(result.at("released").value), ErrorCode::processDenied);
  }
  void revalidate(const mmstore::BootstrapAttestation& helper) const {
    creator_.revalidate(); plan_.revalidateOperationIdentity(); code_.revalidateOperationIdentity();
    helper.self.revalidate(); helper.parent.revalidate(); helper.package.revalidate();
    require(mmstore::detail::sameIdentity(node_, helper.parent.identity()) &&
      mmstore::detail::sameIdentity(helper_, helper.self.identity()) &&
      helper.package.observation().fullName == creator_.observation().fullName, ErrorCode::processDenied);
    detail::requireKillJob(job_.get()); detail::requireMember(helper.self.handle(), job_.get());
    detail::requireMember(helper.parent.handle(), job_.get()); detail::requireMember(creator_.handle(), job_.get(), false);
  }
  void revalidateCleanup(const mmstore::BootstrapAttestation& helper) const {
    creator_.revalidate(); plan_.revalidateCleanupIdentity(); code_.revalidateCleanupIdentity();
    helper.self.revalidate(); helper.parent.revalidate(); helper.package.revalidate();
    require(mmstore::detail::sameIdentity(node_, helper.parent.identity()) &&
      mmstore::detail::sameIdentity(helper_, helper.self.identity()) &&
      helper.package.observation().fullName == creator_.observation().fullName, ErrorCode::processDenied);
    detail::requireKillJob(job_.get()); detail::requireMember(helper.self.handle(), job_.get());
    detail::requireMember(helper.parent.handle(), job_.get()); detail::requireMember(creator_.handle(), job_.get(), false);
  }
 private:
  struct PendingRotation { std::string previous, nonce; };
  void rotateIfNeeded(const mmstore::BootstrapAttestation& helper, bool cleanupOnly) const {
    if (!rotation_ && brokerAttempts_ < HelperCapabilityGeneration::rotationThreshold) return;
    if (!rotation_) rotation_.emplace(PendingRotation{capability_, detail::secret()});
    if (cleanupOnly) revalidateCleanup(helper); else revalidate(helper); const auto name = detail::pipeName(creator_.identity().pid, channel_); const auto deadline = GetTickCount64() + 10000;
    require(WaitNamedPipeW(name.c_str(), 10000), ErrorCode::processDenied);
    Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); require(pipe.valid(), ErrorCode::processDenied);
    ULONG server = 0; require(GetNamedPipeServerProcessId(pipe.get(), &server) && server == creator_.identity().pid, ErrorCode::processDenied);
    detail::writeFrame(pipe.get(), mm::Json::Object{{"version", 1}, {"operation", "helper-rotate"}, {"request_nonce", rotation_->nonce}, {"capability", rotation_->previous}}, deadline);
    const auto observed = parseHelperRotationReply(detail::readFrame(pipe.get(), deadline), rotation_->nonce, rotation_->previous,
      RotationPeer{helper_.pid, detail::ascii(helper_.creationTime)}, RotationPeer{node_.pid, detail::ascii(node_.creationTime)},
      RotationPeer{creator_.identity().pid, detail::ascii(creator_.identity().creationTime)});
    if (cleanupOnly) revalidateCleanup(helper); else revalidate(helper); capability_ = observed.capability;
    brokerAttempts_ = HelperCapabilityGeneration::rotationThreshold - observed.remaining;
    std::fill(rotation_->previous.begin(), rotation_->previous.end(), '\0'); std::fill(rotation_->nonce.begin(), rotation_->nonce.end(), '\0'); rotation_.reset();
  }
  StoreRoleBinding(mmstoreruntime::WorkerCodeAuthority code, mmstore::AttestedProcess creator, Role role,
    mmstoreruntime::FixedLaunchPlan plan, mmstore::ProcessIdentity node, mmstore::ProcessIdentity helper, std::string ownershipNonce, Handle job,
    std::string channel, std::string capability)
    : code_(std::move(code)), creator_(std::move(creator)), role_(role), plan_(std::move(plan)), node_(std::move(node)), helper_(std::move(helper)),
      ownershipNonce_(std::move(ownershipNonce)), job_(std::move(job)), channel_(std::move(channel)), capability_(std::move(capability)) {}
  mmstoreruntime::WorkerCodeAuthority code_; mmstore::AttestedProcess creator_; Role role_;
  mmstoreruntime::FixedLaunchPlan plan_; mmstore::ProcessIdentity node_, helper_;
  std::string ownershipNonce_; Handle job_;
  std::string channel_; mutable std::string capability_;
  mutable std::optional<PendingRotation> rotation_; mutable std::size_t brokerAttempts_ = 0;
  std::shared_ptr<std::mutex> brokerMutex_ = std::make_shared<std::mutex>();
};

// Deliberately narrower than WorkerCodeAuthority. It cannot return a launch
// plan, interpreter/tool path, runtime qualification or full-code authority.
// The live creator callback, backed by its complete held Worker census, is
// additionally mandatory before this partial fixed-code set admits a guardian.
class GuardianCodeAuthority final {
 public:
  GuardianCodeAuthority(GuardianCodeAuthority&&) noexcept = default;
  GuardianCodeAuthority& operator=(GuardianCodeAuthority&&) noexcept = default;
  GuardianCodeAuthority(const GuardianCodeAuthority&) = delete;
  GuardianCodeAuthority& operator=(const GuardianCodeAuthority&) = delete;
  static GuardianCodeAuthority open() {
    auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker);
    auto inventoryFile = package.openInventory(); const auto bytes = inventoryFile.read(8 * 1024 * 1024);
    auto inventory = mmstoreinventory::parse(mmstore::PackageKind::worker,
      mm::JsonParser::storeCodeInventory(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
    mmstoreruntime::validateWorkerInventory(inventory, package.observation());
    auto data = mmstorenamespace::PrivateNamespaceAuthority::open(package);
    GuardianCodeAuthority result(std::move(package), std::move(inventoryFile), std::move(inventory), std::move(data));
    for (const auto role : {mmstore::CodeRole::workerNative, mmstore::CodeRole::workerSession, mmstore::CodeRole::workerNode})
      result.fixed_.emplace(role, result.package_.openCode(role, mmstoreinventory::codePin(result.inventory_, role)));
    result.revalidateHeldIdentity(); return result;
  }
  void holdRoleEntry(Role role) {
    revalidateHeldIdentity(); const auto entry = roleEntry(role);
    require(!entry_.has_value(), ErrorCode::processDenied);
    entry_.emplace(package_.openCode(entry, mmstoreinventory::codePin(inventory_, entry)));
    entry_->revalidate(); revalidateHeldIdentity();
  }
  mmstore::AttestedProcess attestHeldMember(mmstore::CodeRole role, const mmstore::ProcessIdentity& expected) const {
    require(fixed_.contains(role), ErrorCode::processDenied); revalidateHeldIdentity();
    auto process = mmstore::attestProcess(expected.pid, role, mmstoreinventory::codePin(inventory_, role));
    require(mmstore::detail::sameIdentity(expected, process.identity()) && process.observation().fullName == package_.observation().fullName,
      ErrorCode::processDenied);
    process.revalidate(); revalidateHeldIdentity(); return process;
  }
  mmstore::AttestedProcess attestHeldChild(mmstore::CodeRole role, const mmstore::ProcessIdentity& expected,
      const mmstore::AttestedProcess& parent) const {
    parent.revalidate(); require(parent.observation().fullName == package_.observation().fullName, ErrorCode::processDenied);
    auto child = attestHeldMember(role, expected);
    require(mmstore::detail::parentPid(child.identity().pid) == parent.identity().pid &&
      mmstore::detail::creation(parent.handle()) <= mmstore::detail::creation(child.handle()) &&
      child.identity().pid != parent.identity().pid && child.identity().sid == parent.identity().sid &&
      child.identity().logonSid == parent.identity().logonSid && child.identity().sessionId == parent.identity().sessionId,
      ErrorCode::processDenied);
    child.revalidate(); parent.revalidate(); return child;
  }
  void revalidateHeldIdentity() const {
    package_.revalidate(); inventoryFile_.revalidate(); data_.revalidate();
    mmstoreruntime::validateWorkerInventory(inventory_, package_.observation());
    for (const auto& [role, file] : fixed_) { (void)role; file.revalidateIdentity(); }
    if (entry_) entry_->revalidateIdentity(); package_.revalidate();
  }
 private:
  static mmstore::CodeRole roleEntry(Role role) {
    switch (role) {
      case Role::session: return mmstore::CodeRole::workerSessionAgent;
      case Role::login: return mmstore::CodeRole::workerLoginAgent;
      case Role::personal: return mmstore::CodeRole::workerPersonalAgent;
      case Role::fleet: return mmstore::CodeRole::workerFleetAgent;
      case Role::prepare: return mmstore::CodeRole::workerPrepareAgent;
    }
    mmstore::fail(ErrorCode::invalidInput);
  }
  GuardianCodeAuthority(mmstore::RegisteredPackage package, mmstore::ImmutableFile inventoryFile,
    mmstoreinventory::Inventory inventory, mmstorenamespace::PrivateNamespaceAuthority data)
    : package_(std::move(package)), inventoryFile_(std::move(inventoryFile)), inventory_(std::move(inventory)), data_(std::move(data)) {}
  mmstore::RegisteredPackage package_; mmstore::ImmutableFile inventoryFile_; mmstoreinventory::Inventory inventory_;
  mmstorenamespace::PrivateNamespaceAuthority data_; std::map<mmstore::CodeRole, mmstore::ImmutableFile> fixed_;
  std::optional<mmstore::ImmutableFile> entry_;
};

class StoreGuardianBinding final {
 public:
  StoreGuardianBinding(StoreGuardianBinding&&) noexcept = default;
  StoreGuardianBinding& operator=(StoreGuardianBinding&&) noexcept = default;
  StoreGuardianBinding(const StoreGuardianBinding&) = delete;
  StoreGuardianBinding& operator=(const StoreGuardianBinding&) = delete;
  const mmstore::ProcessIdentity& creatorIdentity() const noexcept { return creator_.identity(); }
  const mmstore::ProcessIdentity& nodeIdentity() const {
    require(node_.has_value(), ErrorCode::processDenied); return node_->identity();
  }
  void requireActualParent(HANDLE parent) const {
    revalidate();
    require(GetProcessId(parent) == mmstore::detail::parentPid(self_.identity().pid), ErrorCode::processDenied);
    auto held = code_.attestHeldMember(mmstore::CodeRole::workerNative, mmstore::detail::processIdentity(parent)); held.revalidate();
  }
  static StoreGuardianBinding open(const mm::Json& issuer, GuardianKind kind, HANDLE job) {
    exactFields(issuer, {"version", "creator_pid", "creator_creation_time", "creator_channel", "creator_capability"});
    require(issuer.at("version").integer() == 1, ErrorCode::processDenied);
    const auto creatorPid = pid(issuer.at("creator_pid"));
    const auto birth = issuer.at("creator_creation_time").string();
    const auto channel = issuer.at("creator_channel").string(), capability = issuer.at("creator_capability").string();
    require(validBirth(birth) && mmstore::validDigest(channel) && mmstore::validDigest(capability), ErrorCode::processDenied);
    auto code = GuardianCodeAuthority::open();
    auto self = code.attestHeldMember(mmstore::CodeRole::workerNative, mmstore::detail::processIdentity(GetCurrentProcess()));
    Handle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, creatorPid)); require(parent.valid(), ErrorCode::processDenied);
    auto creator = code.attestHeldMember(mmstore::CodeRole::workerSession, mmstore::detail::processIdentity(parent.get()));
    require(detail::ascii(creator.identity().creationTime) == birth && self.observation().fullName == creator.observation().fullName,
      ErrorCode::processDenied);
    StoreGuardianBinding result(std::move(code), std::move(self), std::move(creator), kind, channel, capability);
    const auto nonce = detail::secret();
    const auto reply = result.exchange(mm::Json::Object{{"version", 1}, {"operation", "guardian-bind"},
      {"request_nonce", nonce}, {"capability", capability}});
    exactFields(reply, {"version", "accepted", "request_nonce", "capability", "pid", "creation_time", "kind", "role",
      "node_pid", "node_creation_time", "job_name", "creator_pid", "creator_creation_time"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) &&
      sameSecret(reply.at("request_nonce").string(), nonce) && sameSecret(reply.at("capability").string(), capability) &&
      pid(reply.at("pid")) == result.self_.identity().pid && detail::wide(reply.at("creation_time").string()) == result.self_.identity().creationTime &&
      reply.at("kind").string() == guardianName(kind) && pid(reply.at("creator_pid")) == creatorPid &&
      reply.at("creator_creation_time").string() == birth && validBirth(reply.at("node_creation_time").string()), ErrorCode::processDenied);
    Handle observed(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid(reply.at("node_pid")))); require(observed.valid(), ErrorCode::processDenied);
    auto node = result.code_.attestHeldMember(mmstore::CodeRole::workerNode, mmstore::detail::processIdentity(observed.get()));
    require(detail::ascii(node.identity().creationTime) == reply.at("node_creation_time").string(), ErrorCode::processDenied);
    const auto name = detail::wide(reply.at("job_name").string());
    require(name.starts_with(L"Local\\MusicMuteOwnedRole-v1-" + result.creator_.identity().sid + L"-" +
      std::to_wstring(result.creator_.identity().sessionId) + L"-") && name.size() <= 512, ErrorCode::processDenied);
    Handle actual(OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, name.c_str())); require(actual.valid(), ErrorCode::processDenied);
    require(CompareObjectHandles(actual.get(), job) != FALSE, ErrorCode::processDenied);
    detail::requireKillJob(job); detail::requireMember(node.handle(), job); detail::requireMember(result.self_.handle(), job, false);
    result.code_.holdRoleEntry(parseRole(reply.at("role").string()));
    result.node_ = std::move(node); result.job_ = std::move(actual); result.revalidate(); return result;
  }
  void revalidate() const {
    self_.revalidate(); creator_.revalidate(); code_.revalidateHeldIdentity();
    require(node_.has_value() && job_.valid(), ErrorCode::processDenied);
    node_->revalidate(); detail::requireKillJob(job_.get());
    detail::requireMember(node_->handle(), job_.get()); detail::requireMember(self_.handle(), job_.get(), false);
  }
  mm::Json registerWatchdog(HANDLE child) const {
    revalidate(); require(kind_ == GuardianKind::gpu, ErrorCode::processDenied);
    const auto identity = mmstore::detail::processIdentity(child);
    auto expected = code_.attestHeldChild(mmstore::CodeRole::workerNative, identity, self_);
    detail::requireMember(expected.handle(), job_.get(), false);
    const auto nonce = detail::secret();
    const auto reply = exchange(mm::Json::Object{{"version", 1}, {"operation", "register-watchdog"},
      {"request_nonce", nonce}, {"capability", capability_}, {"pid", static_cast<std::int64_t>(identity.pid)}});
    exactFields(reply, {"version", "accepted", "request_nonce", "pid", "creator_pid", "creator_creation_time", "creator_channel", "creator_capability"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) &&
      sameSecret(reply.at("request_nonce").string(), nonce) && pid(reply.at("pid")) == identity.pid &&
      pid(reply.at("creator_pid")) == creator_.identity().pid &&
      detail::wide(reply.at("creator_creation_time").string()) == creator_.identity().creationTime &&
      sameSecret(reply.at("creator_channel").string(), channel_) && mmstore::validDigest(reply.at("creator_capability").string()), ErrorCode::processDenied);
    return mm::Json::Object{{"version", 1}, {"creator_pid", reply.at("creator_pid")},
      {"creator_creation_time", reply.at("creator_creation_time")}, {"creator_channel", reply.at("creator_channel")},
      {"creator_capability", reply.at("creator_capability")}};
  }
 private:
  StoreGuardianBinding(GuardianCodeAuthority code, mmstore::AttestedProcess self, mmstore::AttestedProcess creator,
    GuardianKind kind, std::string channel, std::string capability)
    : code_(std::move(code)), self_(std::move(self)), creator_(std::move(creator)), kind_(kind), channel_(std::move(channel)), capability_(std::move(capability)) {}
  mm::Json exchange(const mm::Json& request) const {
    self_.revalidate(); creator_.revalidate();
    const auto name = detail::pipeName(creator_.identity().pid, channel_); const auto deadline = GetTickCount64() + 10000;
    require(WaitNamedPipeW(name.c_str(), 10000) != FALSE, ErrorCode::processDenied);
    Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); require(pipe.valid(), ErrorCode::processDenied);
    ULONG server = 0; require(GetNamedPipeServerProcessId(pipe.get(), &server) != FALSE && server == creator_.identity().pid, ErrorCode::processDenied);
    detail::writeFrame(pipe.get(), request, deadline);
    const auto reply = mm::JsonParser(detail::readFrame(pipe.get(), deadline)).parse();
    self_.revalidate(); creator_.revalidate(); return reply;
  }
  GuardianCodeAuthority code_; mmstore::AttestedProcess self_, creator_;
  GuardianKind kind_; std::string channel_, capability_; std::optional<mmstore::AttestedProcess> node_; Handle job_;
};
#endif
} // namespace mmstorerole
