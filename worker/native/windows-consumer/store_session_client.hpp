#pragma once
#include "store_role.hpp"

namespace mmstoresessionclientpolicy {
inline bool operation(std::string_view name) noexcept {
  return name == "store_session_open" || name == "store_session_command" || name == "store_session_close" || name == "store_session_presence";
}
inline void input(std::string_view name, const mm::Json& args) {
  try {
  mmstore::require(operation(name), mmstore::ErrorCode::invalidInput);
  if (name != "store_session_command") { mmstoreinventory::exact(args, {}); return; }
  mmstoreinventory::exact(args, {"command"});
  mmstore::require(mmstorerole::storeSessionCommand(args.at("command")), mmstore::ErrorCode::invalidInput);
  } catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(mmstore::ErrorCode::invalidInput); }
}
inline void locator(const mm::Json& value, std::string_view inventory) {
  try {
  mmstoreinventory::exact(value, {"version", "creator", "creator_channel", "inventory_sha256", "owner"});
  mmstore::require(value.at("version").integer() == 1 && mmstore::validDigest(inventory) &&
    value.at("inventory_sha256").string() == inventory && mmstore::validDigest(value.at("creator_channel").string()) &&
    mmstorerole::data_policy::identity(value.at("creator")), mmstore::ErrorCode::processDenied);
  const auto& owner = value.at("owner");
  mmstoreinventory::exact(owner, {"role", "nonce", "identity"});
  mmstore::require(owner.at("role").string() == "session-agent" && mmstore::validDigest(owner.at("nonce").string()) &&
    mmstorerole::data_policy::identity(owner.at("identity")), mmstore::ErrorCode::processDenied);
  const auto& node = owner.at("identity"); const auto& creator = value.at("creator");
  mmstore::require(node.at("sid").string() == creator.at("sid").string() &&
    node.at("session_id").integer() == creator.at("session_id").integer() &&
    node.at("pid").integer() != creator.at("pid").integer(), mmstore::ErrorCode::processDenied);
  } catch (...) { mmstore::fail(mmstore::ErrorCode::processDenied); }
}
} // namespace mmstoresessionclientpolicy

#if defined(_WIN32) && !defined(MUSICMUTE_STORE_SESSION_CLIENT_POLICY_ONLY)
// Included after store_gui_worker.hpp inside the native implementation namespace.
// The locator/ACK is discovery only; living code, actual kernel pipe PID and the
// Creator's private registered Session Node/Job table independently grant bind.
inline mmstore::ProcessIdentity storeSessionObservedProcess(const Json& value, const mmstore::ProcessIdentity& current) {
  if (!mmstorerole::data_policy::identity(value) || value.at("sid").string() != utf8(current.sid) ||
      value.at("session_id").integer() != current.sessionId) fail("PEER_DENIED");
  return {current.sid, current.logonSid, wide(value.at("creation_time").string()), current.sessionId,
    static_cast<std::uint32_t>(value.at("pid").integer())};
}
inline Json storeSessionCamelProcess(const mmstore::ProcessIdentity& value) {
  return Json::Object{{"sid", utf8(value.sid)}, {"sessionId", static_cast<std::int64_t>(value.sessionId)},
    {"pid", static_cast<std::int64_t>(value.pid)}, {"creationTime", utf8(value.creationTime)}};
}
inline Json storeSessionLocatorRead() {
  const auto row = vault("vault_get", Json::Object{{"namespace", "fleet"}, {"key", "store_session_locator"}});
  if (std::holds_alternative<std::nullptr_t>(row.value)) return nullptr;
  keys(row, {"version", "bytes_base64"}); if (row.at("version").integer() != 1) fail("PEER_DENIED");
  auto plain = base64Decode(row.at("bytes_base64").string(), 4096);
  struct Wipe { std::vector<BYTE>& bytes; ~Wipe() { SecureZeroMemory(bytes.data(), bytes.size()); } } wipe{plain};
  if (plain.empty()) fail("PEER_DENIED");
  return mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()), plain.size())).parse();
}
struct StoreGuiSessionClient {
  mmstore::AttestedProcess creator, node;
  mmstore::detail::Handle job;
  std::string channel, capability, bindCapability, ownerNonce, inventory;
  std::wstring packageFullName;
  Json owner;
  bool bound = false;
  StoreGuiSessionClient(mmstore::AttestedProcess creatorValue, mmstore::AttestedProcess nodeValue,
      mmstore::detail::Handle jobValue, std::string channelValue, std::string capabilityValue,
      std::string nonceValue, std::string inventoryValue, std::wstring packageValue, Json ownerValue)
    : creator(std::move(creatorValue)), node(std::move(nodeValue)), job(std::move(jobValue)), channel(std::move(channelValue)),
      capability(capabilityValue), bindCapability(std::move(capabilityValue)), ownerNonce(std::move(nonceValue)),
      inventory(std::move(inventoryValue)), packageFullName(std::move(packageValue)), owner(std::move(ownerValue)) {}
  ~StoreGuiSessionClient() {
    SecureZeroMemory(capability.data(), capability.size());
    SecureZeroMemory(bindCapability.data(), bindCapability.size());
  }
  void bind(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, bool cleanup = false);

  void revalidate(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, bool cleanup = false) const {
    storeGuiWorkerBoot(boot, data);
    if (!storeGuiWorkerCodeLease || (cleanup ? storeGuiWorkerCodeLease->inventoryGeneration : storeGuiWorkerCodeLease->code.inventorySha256()) != inventory ||
        storeGuiWorkerCodeLease->code.observation().fullName != packageFullName) fail("PEER_DENIED");
    if (cleanup) storeGuiWorkerCodeLease->revalidateCleanup(); else storeGuiWorkerCodeLease->revalidate(); creator.revalidate();
    // Exact client retirement does not require a still-running Session Node.
    // Its original actual handles/private cap remain bound; no new work is
    // admitted through this cleanup-only path.
    if (!cleanup) node.revalidate();
    mmstorerole::detail::requireKillJob(job.get());
    if (!cleanup) mmstorerole::detail::requireMember(node.handle(), job.get());
    mmstorerole::detail::requireMember(creator.handle(), job.get(), false);
    mmstorerole::detail::requireMember(boot.self.handle(), job.get(), false);
  }
  Json exchange(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data,
      std::string_view operation, const Json* command = nullptr) {
    const bool cleanup = operation == "gui-client-close" ||
      (operation == "gui-session" && command && mmstorerole::cleanupGuiCommand(*command));
    if (!bound) {
      if (!cleanup) fail("PEER_DENIED");
      // Recover only this originally held private bind after a lost ACK.
      // It cannot select another Creator, Node, package or caller capability.
      bind(boot, data, true);
    }
    revalidate(boot, data, cleanup);
    const auto name = mmstorerole::detail::pipeName(creator.identity().pid, channel);
    const auto deadline = GetTickCount64() + 32000;
    check(WaitNamedPipeW(name.c_str(), 5000), "PIPE_UNAVAILABLE");
    mmstore::detail::Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (!pipe.valid()) fail("PIPE_UNAVAILABLE");
    ULONG actual = 0; check(GetNamedPipeServerProcessId(pipe.get(), &actual) && actual == creator.identity().pid, "PEER_DENIED");
    revalidate(boot, data, cleanup);
    const auto nonce = mmstorerole::detail::secret();
    Json::Object request{{"version", 1}, {"operation", std::string(operation)}, {"request_nonce", nonce}, {"capability", capability}};
    if (command) request.emplace("command", *command);
    const bool forwarding = operation == "gui-session" && command && mmstorerole::guiForward(*command);
    const bool cpuConfiguration = operation == "gui-session" && command && mmstorerole::storeGuiCpuLargeFrame(*command);
    const bool benchmarkConfiguration = operation == "gui-session" && command && mmstorerole::storeGuiBenchmarkLargeFrame(*command);
    if (forwarding) mmstorerole::detail::writeBoundedFrame(pipe.get(), request, deadline, 65536);
    else if (cpuConfiguration || benchmarkConfiguration) mmstorerole::detail::writeGuiFrame(pipe.get(), request, deadline);
    else mmstorerole::detail::writeFrame(pipe.get(), request, deadline);
    const auto reply = mm::JsonParser(forwarding ? mmstorerole::detail::readControlFrame(pipe.get(), deadline) :
      mmstorerole::detail::readGuiFrame(pipe.get(), deadline)).parse();
    keys(reply, operation == "gui-client-close" ? std::set<std::string>{"version", "accepted", "request_nonce", "closed"} :
      std::set<std::string>{"version", "accepted", "request_nonce", "result"});
    if (reply.at("version").integer() != 1 || !std::get<bool>(reply.at("accepted").value) ||
        !equalSecret(reply.at("request_nonce").string(), nonce)) fail("PEER_DENIED");
    check(GetNamedPipeServerProcessId(pipe.get(), &actual) && actual == creator.identity().pid, "PEER_DENIED");
    revalidate(boot, data, cleanup);
    // Close this exact complete connection before returning. The Creator
    // independently awaits client EOF; waiting for server EOF here deadlocks.
    pipe = mmstore::detail::Handle();
    if (operation == "gui-client-close") {
      if (!std::get<bool>(reply.at("closed").value)) fail("PEER_DENIED");
      return Json::Object{{"closed", true}};
    }
    return reply.at("result");
  }
  Json observation() const {
    return Json::Object{{"version", 1},
      {"owner", Json::Object{{"role", "session-agent"}, {"nonce", ownerNonce}, {"identity", storeSessionCamelProcess(node.identity())}}},
      {"creator", storeSessionCamelProcess(creator.identity())}, {"inventorySha256", inventory}};
  }
};
std::unique_ptr<StoreGuiSessionClient> storeGuiSessionClient;
inline std::unique_ptr<StoreGuiSessionClient> openStoreGuiSessionClient(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data) {
  storeGuiWorkerBoot(boot, data); if (!storeGuiWorkerCodeLease || storeGuiSessionClient) fail("PEER_DENIED");
  storeGuiWorkerCodeLease->revalidate();
  const auto eventName = L"Local\\MusicMuteStoreSessionPublished-v1-" + boot.self.identity().sid + L"-" + std::to_wstring(boot.self.identity().sessionId);
  Security security(L"O:" + boot.self.identity().sid + L"D:P(A;;GA;;;" + boot.self.identity().sid + L")(A;;GA;;;SY)");
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), security.descriptor, FALSE};
  mmstore::detail::Handle published(CreateEventW(&attributes, TRUE, FALSE, eventName.c_str()));
  if (!published.valid()) fail("PIPE_UNAVAILABLE");
  // The last DPAPI locator may outlive its Creator. Always join the living
  // publication event before one fixed read; a stale non-null file cannot
  // bypass a newly activated Session's true singleton/publication boundary.
  // This event is discovery only. Its contents still need actual code,
  // process/Job/pipe and receiving Creator claims below.
  check(WaitForSingleObject(published.get(), 28000) == WAIT_OBJECT_0, "TIMEOUT");
  auto locator = storeSessionLocatorRead();
  if (std::holds_alternative<std::nullptr_t>(locator.value)) fail("PEER_DENIED");
  const auto inventory = storeGuiWorkerCodeLease->code.inventorySha256();
  mmstoresessionclientpolicy::locator(locator, inventory);
  const auto creatorExpected = storeSessionObservedProcess(locator.at("creator"), boot.self.identity()),
    nodeExpected = storeSessionObservedProcess(locator.at("owner").at("identity"), boot.self.identity());
  auto creator = storeGuiWorkerCodeLease->code.attestHeldMember(mmstore::CodeRole::workerSession, creatorExpected);
  auto node = storeGuiWorkerCodeLease->code.attestHeldChild(mmstore::CodeRole::workerNode, nodeExpected, creator);
  const auto ownerNonce = locator.at("owner").at("nonce").string(), channel = locator.at("creator_channel").string();
  const auto jobName = L"Local\\MusicMuteOwnedRole-v1-" + boot.self.identity().sid + L"-" + std::to_wstring(boot.self.identity().sessionId) +
    L"-session-agent-" + wide(ownerNonce);
  mmstore::detail::Handle job(OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, jobName.c_str())); if (!job.valid()) fail("PEER_DENIED");
  const auto capability = mmstorerole::detail::secret();
  auto result = std::make_unique<StoreGuiSessionClient>(std::move(creator), std::move(node), std::move(job), channel, capability,
    ownerNonce, inventory, storeGuiWorkerCodeLease->code.observation().fullName, locator.at("owner"));
  result->revalidate(boot, data);
  return result;
}
inline void StoreGuiSessionClient::bind(mmstore::BootstrapAttestation& boot,
    mmstorenamespace::PrivateNamespaceAuthority& data, bool cleanup) {
  if (bound) fail("PEER_DENIED");
  revalidate(boot, data, cleanup);
  const auto name = mmstorerole::detail::pipeName(creator.identity().pid, channel);
  const auto deadline = GetTickCount64() + 10000;
  check(WaitNamedPipeW(name.c_str(), 5000), "PIPE_UNAVAILABLE");
  mmstore::detail::Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr)); if (!pipe.valid()) fail("PIPE_UNAVAILABLE");
  ULONG actual = 0; check(GetNamedPipeServerProcessId(pipe.get(), &actual) && actual == creator.identity().pid, "PEER_DENIED");
  const auto nonce = mmstorerole::detail::secret();
  revalidate(boot, data, cleanup);
  mmstorerole::detail::writeFrame(pipe.get(), Json::Object{{"version", 1}, {"operation", "gui-client-bind"}, {"request_nonce", nonce}, {"capability", bindCapability}}, deadline);
  const auto reply = mm::JsonParser(mmstorerole::detail::readGuiFrame(pipe.get(), deadline)).parse();
  keys(reply, {"version", "accepted", "request_nonce", "client_capability", "owner", "creator", "inventory_sha256"});
  if (reply.at("version").integer() != 1 || !std::get<bool>(reply.at("accepted").value) || !equalSecret(reply.at("request_nonce").string(), nonce) ||
      !mmstore::validDigest(reply.at("client_capability").string()) || mm::dump(reply.at("owner")) != mm::dump(owner) ||
      mm::dump(reply.at("creator")) != mm::dump(Json::Object{{"sid", utf8(creator.identity().sid)}, {"session_id", static_cast<std::int64_t>(creator.identity().sessionId)},
        {"pid", static_cast<std::int64_t>(creator.identity().pid)}, {"creation_time", utf8(creator.identity().creationTime)}}) || reply.at("inventory_sha256").string() != inventory) fail("PEER_DENIED");
  check(GetNamedPipeServerProcessId(pipe.get(), &actual) && actual == creator.identity().pid, "PEER_DENIED");
  revalidate(boot, data, cleanup); capability = reply.at("client_capability").string(); bound = true;
}
inline bool storeGuiSessionOperation(std::string_view operation) { return mmstoresessionclientpolicy::operation(operation); }
inline Json dispatchStoreGuiSession(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data,
    const std::string& operation, const Json& args) {
  mmstoresessionclientpolicy::input(operation, args); storeGuiWorkerBoot(boot, data);
  if (operation == "store_session_presence") {
    // Passive discovery only. Do not create an event, launch a Session, read a
    // stale locator or replace any original pending client. Present still
    // requires the complete actual Creator/Node/code/Job bind before commands.
    if (!storeGuiWorkerCodeLease || storeGuiSessionClient) fail("PEER_DENIED");
    storeGuiWorkerCodeLease->revalidate();
    const auto name = L"Local\\MusicMuteStoreSessionPublished-v1-" + boot.self.identity().sid + L"-" + std::to_wstring(boot.self.identity().sessionId);
    mmstore::detail::Handle published(OpenEventW(SYNCHRONIZE | READ_CONTROL, FALSE, name.c_str()));
    bool present = false;
    if (!published.valid()) {
      if (GetLastError() != ERROR_FILE_NOT_FOUND) fail("PIPE_UNAVAILABLE");
    } else {
      assertPrivateMutex(published.get());
      const auto result = WaitForSingleObject(published.get(), 0);
      if (result != WAIT_OBJECT_0 && result != WAIT_TIMEOUT) fail("PIPE_UNAVAILABLE");
      present = result == WAIT_OBJECT_0;
    }
    storeGuiWorkerCodeLease->revalidate(); storeGuiWorkerBoot(boot, data);
    return Json::Object{{"present", present}};
  }
  if (operation == "store_session_open") {
    if (storeGuiSessionClient) fail("PEER_DENIED");
    // Install the actual pending owner before the first bind write. A lost
    // acknowledgement retains this exact private capability and held handles
    // for store_session_close; no second client borrows its uncertain state.
    storeGuiSessionClient = openStoreGuiSessionClient(boot, data);
    storeGuiSessionClient->bind(boot, data);
    auto observed = storeGuiSessionClient->observation(); storeGuiSessionClient->revalidate(boot, data);
    return observed;
  }
  if (!storeGuiSessionClient) fail("PEER_DENIED");
  if (operation == "store_session_close") {
    auto result = storeGuiSessionClient->exchange(boot, data, "gui-client-close");
    storeGuiSessionClient.reset(); return result;
  }
  return storeGuiSessionClient->exchange(boot, data, "gui-session", &args.at("command"));
}
#endif
