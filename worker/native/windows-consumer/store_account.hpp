#pragma once
#include "json.hpp"
#include "store_authority.hpp"
#include "store_inventory.hpp"
#include "store_browser_attachment_policy.hpp"
#include <array>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string_view>
#include <thread>

namespace mmstoreaccountpolicy {
inline constexpr std::string_view ticketKey = "store_browser_ticket";
inline constexpr std::string_view claimKey = "store_browser_ticket_claim";
inline constexpr std::wstring_view guiAumid = mmstoreprofile::guiAumid;
inline constexpr std::wstring_view activationArguments = L"--headless-account";
inline constexpr std::string_view browserOrigin = mmstorebrowserattachment::browserOrigin;
inline bool operation(std::string_view value) {
  static constexpr std::array names{"store_account_owner_bind", "store_account_ticket_publish",
    "store_account_ticket_read", "store_account_ticket_claim", "store_account_ticket_remove",
    "store_account_peer_verify", "store_account_same_gui", "store_account_launch",
    "store_account_pipe_accept", "store_account_pipe_connect", "store_account_pipe_reply", "store_account_pipe_close"};
  return std::find(names.begin(), names.end(), value) != names.end();
}
inline void need(bool result) { mmstore::require(result, mmstore::ErrorCode::invalidInput); }
inline std::uint64_t decimal(std::string_view value, std::uint64_t maximum) { return mmstorebrowserattachment::decimal(value, maximum); }
inline bool nonce(std::string_view value) { return mmstore::validDigest(value); }
inline bool uuid(std::string_view value) {
  if (value.size() != 36 || value[14] != '4' || std::string_view("89ab").find(value[19]) == std::string_view::npos) return false;
  for (std::size_t n = 0; n < value.size(); ++n) { if (n == 8 || n == 13 || n == 18 || n == 23) { if (value[n] != '-') return false; } else if (std::string_view("0123456789abcdef").find(value[n]) == std::string_view::npos) return false; }
  return true;
}
inline void identity(const mm::Json& value) { mmstorebrowserattachment::identity(value); }
inline void timeout(const mm::Json& value) { need(value.integer() >= 100 && value.integer() <= 30000); }
inline void expiry(const mm::Json& value, std::int64_t now) { need(now >= 0 && now <= INT64_MAX - 35000 && value.integer() > now && value.integer() <= now + 35000); }
inline void base64(const mm::Json& value, std::size_t maximum) {
  const auto& text = value.string(); need(text.size() % 4 == 0 && text.size() <= ((maximum + 2) / 3) * 4);
  if (text.empty()) return;
  const auto padding = text.ends_with("==") ? 2U : text.ends_with("=") ? 1U : 0U;
  const auto alphabet = std::string_view("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
  for (std::size_t n = 0; n < text.size() - padding; ++n) need(alphabet.find(text[n]) != std::string_view::npos);
  for (std::size_t n = text.size() - padding; n < text.size(); ++n) need(text[n] == '=');
  need((text.size() / 4) * 3 - padding <= maximum);
  if (padding) { const auto last = alphabet.find(text[text.size() - padding - 1]); need(last != std::string_view::npos && (last & (padding == 2 ? 15U : 3U)) == 0); }
}
inline void input(std::string_view name, const mm::Json& value, std::int64_t now) {
  try {
    need(operation(name));
    if (name == "store_account_ticket_read" || name == "store_account_launch") mmstoreinventory::exact(value, {});
    else if (name == "store_account_owner_bind" || name == "store_account_ticket_claim") { mmstoreinventory::exact(value, {"nonce"}); need(nonce(value.at("nonce").string())); }
    else if (name == "store_account_ticket_remove") { mmstoreinventory::exact(value, {"instance_id"}); need(uuid(value.at("instance_id").string())); }
    else if (name == "store_account_ticket_publish") {
      mmstoreinventory::exact(value, {"owner", "instance_id", "channel", "nonce", "expires_at"}); identity(value.at("owner"));
      need(uuid(value.at("instance_id").string()) && nonce(value.at("channel").string()) && nonce(value.at("nonce").string())); expiry(value.at("expires_at"), now);
    } else if (name == "store_account_peer_verify") { mmstoreinventory::exact(value, {"peer", "role"}); identity(value.at("peer")); need(value.at("role").string() == "authority" || value.at("role").string() == "browser"); }
    else if (name == "store_account_same_gui") { mmstoreinventory::exact(value, {"left", "right"}); identity(value.at("left")); identity(value.at("right")); }
    else if (name == "store_account_pipe_accept") { mmstoreinventory::exact(value, {"channel", "nonce", "timeout_ms"}); need(nonce(value.at("channel").string()) && nonce(value.at("nonce").string())); timeout(value.at("timeout_ms")); }
    else if (name == "store_account_pipe_connect") {
      mmstoreinventory::exact(value, {"channel", "nonce", "peer", "payload_base64", "timeout_ms"}); need(nonce(value.at("channel").string()) && nonce(value.at("nonce").string())); identity(value.at("peer")); base64(value.at("payload_base64"), 4096); timeout(value.at("timeout_ms"));
    } else if (name == "store_account_pipe_reply" || name == "store_account_pipe_close") {
      if (name == "store_account_pipe_reply") { mmstoreinventory::exact(value, {"token", "nonce", "peer", "payload_base64"}); base64(value.at("payload_base64"), 32768); }
      else mmstoreinventory::exact(value, {"token", "nonce", "peer"});
      need(nonce(value.at("token").string()) && nonce(value.at("nonce").string())); identity(value.at("peer"));
    }
  } catch (const mmstore::Error&) { throw; } catch (...) { mmstore::fail(mmstore::ErrorCode::invalidInput); }
}
inline void ticket(const mm::Json& value, std::string_view package, std::int64_t now, bool currentExpiry = true) {
  mmstoreinventory::exact(value, {"version", "owner", "server", "gui", "instance_id", "channel", "nonce", "expires_at", "lease_nonce", "package_full_name"});
  need(value.at("version").integer() == 2 && value.at("package_full_name").string() == package && uuid(value.at("instance_id").string()) && nonce(value.at("channel").string()) && nonce(value.at("nonce").string()) && nonce(value.at("lease_nonce").string()));
  for (const auto* name : {"owner", "server", "gui"}) identity(value.at(name));
  const auto& gui = value.at("gui");
  need(value.at("owner").at("pid").integer() != value.at("server").at("pid").integer());
  for (const auto* name : {"owner", "server"}) { const auto& peer = value.at(name); need(peer.at("sid").string() == gui.at("sid").string() && peer.at("session_id").integer() == gui.at("session_id").integer() && peer.at("pid").integer() != gui.at("pid").integer() && decimal(peer.at("creation_time").string(), UINT64_MAX) >= decimal(gui.at("creation_time").string(), UINT64_MAX)); }
  if (currentExpiry) expiry(value.at("expires_at"), now); else need(value.at("expires_at").integer() > 0);
}
inline void attachment(const mm::Json& value, const mm::Json& gui, std::string_view package) { mmstorebrowserattachment::attachment(value, gui, package); }
inline void creatorReply(const mm::Json& value, std::string_view challenge, const mm::Json& helper, std::string_view package) {
  mmstoreinventory::exact(value, {"version", "confirmed", "challenge", "helper_pid", "helper_creation_time", "package_full_name", "browser_attachment", "source_helper"});
  need(nonce(challenge) && value.at("version").integer() == 1 && std::get<bool>(value.at("confirmed").value) && value.at("challenge").string() == challenge && value.at("helper_pid").integer() == helper.at("pid").integer() && value.at("helper_creation_time").string() == helper.at("creation_time").string() && value.at("package_full_name").string() == package);
  const auto& browser = value.at("browser_attachment"); const auto& source = value.at("source_helper");
  if (std::holds_alternative<std::nullptr_t>(browser.value)) need(std::holds_alternative<std::nullptr_t>(source.value));
  else {
    need(std::holds_alternative<mm::Json::Object>(browser.value));
    mmstoreinventory::exact(source, {"pid", "creation_time"});
    need(source.at("pid").integer() > 0 && source.at("pid").integer() <= INT32_MAX &&
      decimal(source.at("creation_time").string(), UINT64_MAX) > 0);
  }
}
} // namespace mmstoreaccountpolicy

#if defined(_WIN32) && !defined(MUSICMUTE_STORE_ACCOUNT_POLICY_ONLY)
// Included inside main.cpp after core mutex/vault/pipe primitives and the
// protected Store browser/inventory helpers. All rights derive from held OS
// package/code/process authority; receiving JSON is an expectation only.
inline std::int64_t storeAccountNow() {
  FILETIME time{}; GetSystemTimeAsFileTime(&time);
  return static_cast<std::int64_t>(((static_cast<std::uint64_t>(time.dwHighDateTime) << 32U) | time.dwLowDateTime) / 10000ULL) - 11644473600000LL;
}
inline void storeAccountBoot(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data) {
  if (boot.package.kind() != mmstore::PackageKind::gui || boot.self.role() != mmstore::CodeRole::guiNative || boot.parent.role() != mmstore::CodeRole::guiApplication) fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); boot.package.revalidate(); data.revalidate();
}
inline Handle storeAccountConnectFixed(const std::wstring& name, DWORD expectedPid, ULONGLONG deadline) {
  Handle pipe;
  for (;;) {
    pipe = Handle(CreateFileW(name.c_str(), FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, nullptr, OPEN_EXISTING,
      FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (pipe.valid()) break;
    const auto error = GetLastError(); if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) fail("PIPE_UNAVAILABLE");
    (void)remaining(deadline); Sleep(5);
  }
  ULONG server = 0; check(GetNamedPipeServerProcessId(pipe.value, &server) && server == expectedPid, "PEER_DENIED"); return pipe;
}
inline void storeAccountEof(HANDLE pipe, ULONGLONG deadline) {
  char extra = 0; if (storeBrowserTransfer(pipe, &extra, 1, false, deadline) != 0) fail("PEER_DENIED");
}
inline Json storeAccountCreator(mmstore::AttestedProcess& helper, mmstore::AttestedProcess& gui, const StoreBrowserFiles& files) {
  helper.revalidate(); gui.revalidate(); files.revalidate();
  if (helper.role() != mmstore::CodeRole::guiNative || gui.role() != mmstore::CodeRole::guiApplication ||
      helper.observation().fullName != files.package.observation().fullName || gui.observation().fullName != files.package.observation().fullName ||
      mmstore::detail::parentPid(helper.identity().pid) != gui.identity().pid ||
      mmstore::detail::creation(helper.handle()) < mmstore::detail::creation(gui.handle())) fail("PEER_DENIED");
  const auto challenge = randomHex(); const auto deadline = GetTickCount64() + 3000;
  auto pipe = storeAccountConnectFixed(L"\\\\.\\pipe\\MusicMuteStoreGuiCreator-" + std::to_wstring(gui.identity().pid), gui.identity().pid, deadline);
  gui.revalidate(); helper.revalidate();
  storeBrowserSendLine(pipe.value, Json::Object{{"version", 1}, {"challenge", challenge},
    {"helper_pid", static_cast<std::int64_t>(helper.identity().pid)}, {"helper_creation_time", utf8(helper.identity().creationTime)}}, deadline);
  const auto reply = storeBrowserReceiveLine(pipe.value, deadline);
  mmstoreaccountpolicy::creatorReply(reply, challenge, storeBrowserWireIdentity(helper.identity()), utf8(files.package.observation().fullName));
  storeAccountEof(pipe.value, deadline);
  helper.revalidate(); gui.revalidate(); files.revalidate();
  const auto& browser = reply.at("browser_attachment");
  if (!std::holds_alternative<std::nullptr_t>(browser.value)) {
    mmstoreaccountpolicy::attachment(browser, storeBrowserWireIdentity(gui.identity()), utf8(files.package.observation().fullName));
    const auto& expected = reply.at("source_helper");
    auto source = mmstore::attestProcess(mmstorebrowserpolicy::pid(expected.at("pid")), mmstore::CodeRole::guiNative,
      storeBrowserRolePin(files, mmstore::CodeRole::guiNative));
    if (source.observation().fullName != files.package.observation().fullName ||
      utf8(source.identity().creationTime) != expected.at("creation_time").string() ||
      source.identity().sid != gui.identity().sid || source.identity().logonSid != gui.identity().logonSid ||
      source.identity().sessionId != gui.identity().sessionId || mmstore::detail::parentPid(source.identity().pid) != gui.identity().pid ||
      mmstore::detail::creation(source.handle()) < mmstore::detail::creation(gui.handle())) fail("PEER_DENIED");
    source.revalidate(); helper.revalidate(); gui.revalidate(); files.revalidate();
  }
  return browser;
}
struct StoreAccountPeer {
  mmstore::AttestedProcess helper, gui;
  Json browser = nullptr;
  void revalidate(const StoreBrowserFiles& files) { browser = storeAccountCreator(helper, gui, files); }
};
inline StoreAccountPeer storeAccountPeer(const Json& expected, const StoreBrowserFiles& files) {
  mmstoreaccountpolicy::identity(expected);
  auto helper = mmstore::attestProcess(mmstorebrowserpolicy::pid(expected.at("pid")), mmstore::CodeRole::guiNative, storeBrowserRolePin(files, mmstore::CodeRole::guiNative));
  if (mm::dump(expected) != mm::dump(storeBrowserWireIdentity(helper.identity())) || helper.observation().fullName != files.package.observation().fullName) fail("PEER_DENIED");
  auto gui = mmstore::attestProcess(mmstore::detail::parentPid(helper.identity().pid), mmstore::CodeRole::guiApplication, files.application.pin());
  StoreAccountPeer result{std::move(helper), std::move(gui)}; result.revalidate(files); return result;
}
inline void storeAccountBrowserPeer(StoreAccountPeer& peer, const StoreBrowserFiles& files) {
  peer.revalidate(files);
  if (std::holds_alternative<std::nullptr_t>(peer.browser.value)) fail("PEER_DENIED");
  const auto browser = peer.browser;
  mmstoreaccountpolicy::attachment(browser, storeBrowserWireIdentity(peer.gui.identity()), utf8(files.package.observation().fullName));
  auto host = mmstore::attestProcess(mmstorebrowserpolicy::pid(browser.at("host").at("pid")), mmstore::CodeRole::guiChromeHost, files.host.pin());
  if (mm::dump(storeBrowserWireIdentity(host.identity())) != mm::dump(browser.at("host")) || host.observation().fullName != files.package.observation().fullName) fail("PEER_DENIED");
  const auto expected = browser.at("chrome"); const auto pid = mmstorebrowserpolicy::pid(expected.at("pid"));
  Handle chrome(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid)); if (!chrome.valid()) fail("PEER_DENIED");
  const auto user = mmstore::detail::logon(chrome.value); const auto current = mmstore::detail::logon(GetCurrentProcess());
  if (user.sid != current.sid || user.logonSid != current.logonSid || user.session != current.session || WaitForSingleObject(chrome.value, 0) != WAIT_TIMEOUT) fail("PEER_DENIED");
  USHORT machine = 0, native = 0; check(IsWow64Process2(chrome.value, &machine, &native) && native == IMAGE_FILE_MACHINE_AMD64 && (machine == IMAGE_FILE_MACHINE_UNKNOWN || machine == IMAGE_FILE_MACHINE_I386), "PEER_DENIED");
  const auto path = mmstore::detail::processImage(chrome.value); if (!mmstore::detail::samePath(path, registeredChromePath()) || !chromeProductIdentity(path)) fail("PEER_DENIED");
  auto ancestors = lockExportParents(path); auto code = storeBrowserRegular(path, true); (void)trustedPePublisher(path, code.value, true, PeTrustPolicy::FreshApproval, L"Google LLC");
  const mmstore::ProcessIdentity identity{user.sid, user.logonSid, std::to_wstring(mmstore::detail::creation(chrome.value)), user.session, pid};
  if (mm::dump(storeBrowserWireIdentity(identity)) != mm::dump(expected) || pid == host.identity().pid || pid == peer.gui.identity().pid || pid == peer.helper.identity().pid) fail("PEER_DENIED");
  StoreBrowserChromePeer held{std::move(chrome), std::move(ancestors), std::move(code), identity, path, {}, {}};
  held.birth = storeBrowserBirth(held.code.value); held.digest = hashFile(held.code.value); held.revalidate(); host.revalidate();
  peer.revalidate(files);
  if (mm::dump(peer.browser) != mm::dump(browser)) fail("PEER_DENIED");
}
std::unique_ptr<StoreBrowserFiles> storeAccountCode;
std::once_flag storeAccountCodeOpened;
inline const StoreBrowserFiles& storeAccountFiles(const mmstore::RegisteredPackage& package) {
  std::call_once(storeAccountCodeOpened, [&] { storeAccountCode = std::make_unique<StoreBrowserFiles>(storeBrowserFiles(package)); });
  if (!storeAccountCode || storeAccountCode->package.observation().fullName != package.observation().fullName) fail("PEER_DENIED");
  storeAccountCode->revalidate(); return *storeAccountCode;
}

struct StoreAccountOwnerEndpoint {
  std::atomic<bool> live{true};
  std::string nonce;
  mmstore::ProcessIdentity owner, gui;
  std::wstring packageFullName;
  StoreBrowserFiles files;
  mmstorenamespace::PrivateNamespaceAuthority data;
  mmstore::AttestedProcess self, parent;
  Handle firstPipe;
  std::jthread thread;
  std::wstring name() const { return L"\\\\.\\pipe\\MusicMuteStoreAccountOwner-" + std::to_wstring(owner.pid) + L"-" + wide(nonce); }
  Handle create() const {
    Security security(L"O:" + owner.sid + L"D:P(A;;0x0012019b;;;" + owner.logonSid + L")");
    Handle pipe(CreateNamedPipeW(name().c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, &security.attributes));
    if (!pipe.valid()) fail("PIPE_UNAVAILABLE"); return pipe;
  }
  StoreAccountOwnerEndpoint(std::string value, mmstore::ProcessIdentity helper, mmstore::ProcessIdentity parentIdentity, std::wstring package)
    : nonce(std::move(value)), owner(std::move(helper)), gui(std::move(parentIdentity)), packageFullName(std::move(package)),
      files(storeBrowserFiles(mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui))),
      data(mmstorenamespace::PrivateNamespaceAuthority::open(files.package)),
      self(mmstore::attestProcess(owner.pid, mmstore::CodeRole::guiNative, storeBrowserRolePin(files, mmstore::CodeRole::guiNative))),
      parent(mmstore::attestProcess(gui.pid, mmstore::CodeRole::guiApplication, files.application.pin())), firstPipe(create()) {
    if (files.package.observation().fullName != packageFullName || !mmstore::detail::sameIdentity(self.identity(), owner) || !mmstore::detail::sameIdentity(this->parent.identity(), gui)) fail("PEER_DENIED");
    thread = std::jthread([this](std::stop_token stopping) { serve(stopping); });
  }
  ~StoreAccountOwnerEndpoint() { live.store(false); thread.request_stop(); if (thread.joinable()) thread.join(); }
  void serve(std::stop_token stopping) {
    auto pipe = std::move(firstPipe);
    while (!stopping.stop_requested() && live.load()) {
      try {
        if (!pipe.valid()) pipe = create();
        Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.valid()) fail("PIPE_UNAVAILABLE");
        OVERLAPPED connect{}; connect.hEvent = event.value; DWORD transferred = 0;
        const BOOL connected = ConnectNamedPipe(pipe.value, &connect);
        if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) {
          const auto error = GetLastError(); if (error != ERROR_IO_PENDING) fail("PIPE_UNAVAILABLE");
          while (!stopping.stop_requested() && live.load() && WaitForSingleObject(event.value, 100) == WAIT_TIMEOUT) {}
          if (stopping.stop_requested() || !live.load()) { (void)CancelIoEx(pipe.value, &connect); (void)GetOverlappedResult(pipe.value, &connect, &transferred, TRUE); break; }
          check(GetOverlappedResult(pipe.value, &connect, &transferred, FALSE), "PIPE_UNAVAILABLE");
        }
        const auto deadline = GetTickCount64() + 10000;
        files.revalidate(); data.revalidate(); self.revalidate(); parent.revalidate();
        if (!mmstore::detail::sameIdentity(self.identity(), owner) || !mmstore::detail::sameIdentity(parent.identity(), gui)) fail("PEER_DENIED");
        (void)storeAccountCreator(self, parent, files);
        ULONG clientPid = 0; check(GetNamedPipeClientProcessId(pipe.value, &clientPid), "PEER_DENIED");
        const auto expected = processIdentity(clientPid); auto peer = storeAccountPeer(expected, files);
        if (!mmstore::detail::sameIdentity(peer.gui.identity(), gui)) storeAccountBrowserPeer(peer, files);
        check(ImpersonateNamedPipeClient(pipe.value), "PEER_DENIED");
        try { Handle token; check(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value), "PEER_DENIED"); const auto user = tokenIdentity(token.value); if (user.sid != utf8(owner.sid) || user.logonSid != utf8(owner.logonSid) || user.session != owner.sessionId) fail("PEER_DENIED"); }
        catch (...) { RevertToSelf(); throw; }
        check(RevertToSelf(), "PEER_DENIED");
        const auto request = storeBrowserReceiveLine(pipe.value, deadline); keys(request, {"version", "challenge"});
        const auto challenge = request.at("challenge").string(); if (request.at("version").integer() != 1 || !mmstoreaccountpolicy::nonce(challenge) || !live.load() || stopping.stop_requested()) fail("PEER_DENIED");
        self.revalidate(); parent.revalidate(); peer.revalidate(files); data.revalidate();
        if (!mmstore::detail::sameIdentity(peer.gui.identity(), gui)) storeAccountBrowserPeer(peer, files);
        storeBrowserSendLine(pipe.value, Json::Object{{"version", 1}, {"owned", true}, {"challenge", challenge},
          {"owner", storeBrowserWireIdentity(owner)}, {"gui", storeBrowserWireIdentity(gui)}, {"lease_nonce", nonce}, {"package_full_name", utf8(packageFullName)}}, deadline);
        // A bounded ACK proves the reader consumed the line before Win32's
        // explicit disconnect, which otherwise may discard unread pipe bytes.
        DWORD acknowledged = 0; pipeTransfer(pipe.value, &acknowledged, 4, false, deadline);
        if (acknowledged != 0x4d4d0001) fail("PROTOCOL_MISMATCH");
      } catch (...) { /* A refused peer never changes or grants account rights. */ }
      if (pipe.valid()) { DisconnectNamedPipe(pipe.value); pipe = Handle(); }
    }
    live.store(false);
  }
};
std::unique_ptr<StoreAccountOwnerEndpoint> storeAccountOwnerEndpoint;
std::optional<Json> storeAccountPublishedTicket;
std::map<std::string, Json> storeAccountConnections;
std::set<std::string> storeAccountClientCapabilities;
inline void retireStoreAccountOwner() { if (storeAccountOwnerEndpoint) { storeAccountOwnerEndpoint->live.store(false); storeAccountOwnerEndpoint.reset(); } }

inline void storeAccountHeldOwner(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, const std::string* expectedNonce = nullptr) {
  storeAccountBoot(boot, data);
  const auto item = ownedMutexes.find("account");
  if (item == ownedMutexes.end() || !item->second.handle.valid() ||
      (expectedNonce && !equalSecret(*expectedNonce, item->second.nonce)) ||
      mm::dump(item->second.identity) != mm::dump(storeBrowserWireIdentity(boot.self.identity()))) fail("PEER_DENIED");
  assertPrivateMutex(item->second.handle.value);
  const auto publication = singletonRecord("account");
  if (std::holds_alternative<std::nullptr_t>(publication.value) || publication.at("nonce").string() != item->second.nonce ||
      mm::dump(publication.at("helper")) != mm::dump(item->second.identity) ||
      mm::dump(publication.at("owner")) != mm::dump(storeBrowserWireIdentity(boot.parent.identity()))) fail("PEER_DENIED");
}
inline StoreAccountPeer storeAccountOwnerProof(const Json& expected, const std::string& leaseNonce, const Json& expectedGui, const StoreBrowserFiles& files) {
  if (!mmstoreaccountpolicy::nonce(leaseNonce)) fail("PEER_DENIED");
  auto owner = storeAccountPeer(expected, files);
  if (mm::dump(expectedGui) != mm::dump(storeBrowserWireIdentity(owner.gui.identity()))) fail("PEER_DENIED");
  const auto publication = singletonRecord("account");
  if (std::holds_alternative<std::nullptr_t>(publication.value) || publication.at("nonce").string() != leaseNonce ||
      mm::dump(publication.at("helper")) != mm::dump(expected) || mm::dump(publication.at("owner")) != mm::dump(expectedGui)) fail("PEER_DENIED");
  const auto challenge = randomHex(); const auto deadline = GetTickCount64() + 12000;
  auto pipe = storeAccountConnectFixed(L"\\\\.\\pipe\\MusicMuteStoreAccountOwner-" + std::to_wstring(owner.helper.identity().pid) + L"-" + wide(leaseNonce), owner.helper.identity().pid, deadline);
  owner.revalidate(files);
  storeBrowserSendLine(pipe.value, Json::Object{{"version", 1}, {"challenge", challenge}}, deadline);
  const auto reply = storeBrowserReceiveLine(pipe.value, deadline);
  keys(reply, {"version", "owned", "challenge", "owner", "gui", "lease_nonce", "package_full_name"});
  if (reply.at("version").integer() != 1 || !std::get<bool>(reply.at("owned").value) || reply.at("challenge").string() != challenge ||
      reply.at("lease_nonce").string() != leaseNonce || reply.at("package_full_name").string() != utf8(files.package.observation().fullName) ||
      mm::dump(reply.at("owner")) != mm::dump(expected) || mm::dump(reply.at("gui")) != mm::dump(expectedGui)) fail("PEER_DENIED");
  DWORD acknowledged = 0x4d4d0001; pipeTransfer(pipe.value, &acknowledged, 4, true, deadline);
  storeAccountEof(pipe.value, deadline); owner.revalidate(files);
  // A servicing/retirement or publication change during the challenge cannot
  // reuse this live endpoint proof as authority for a different generation.
  if (mm::dump(singletonRecord("account")) != mm::dump(publication)) fail("PEER_DENIED");
  return owner;
}
inline Json storeAccountReadRecord() {
  const auto encoded = vault("vault_get", Json::Object{{"namespace", "account"}, {"key", std::string(mmstoreaccountpolicy::ticketKey)}});
  if (std::holds_alternative<std::nullptr_t>(encoded.value)) return nullptr;
  auto bytes = base64Decode(encoded.at("bytes_base64").string(), 4096);
  try { const auto result = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse(); SecureZeroMemory(bytes.data(), bytes.size()); return result; }
  catch (...) { SecureZeroMemory(bytes.data(), bytes.size()); throw; }
}
inline void storeAccountWriteRecord(std::string_view key, const Json& value) {
  auto text = mm::dump(value); if (text.size() > 4096) fail("FRAME_TOO_LARGE");
  (void)vault("vault_put", Json::Object{{"namespace", "account"}, {"key", std::string(key)}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}}); SecureZeroMemory(text.data(), text.size());
}
inline void storeAccountValidateTicket(const Json& ticket, const StoreBrowserFiles& files, bool expiry = true) {
  mmstoreaccountpolicy::ticket(ticket, utf8(files.package.observation().fullName), storeAccountNow(), expiry);
  auto owner = storeAccountOwnerProof(ticket.at("owner"), ticket.at("lease_nonce").string(), ticket.at("gui"), files);
  auto listener = storeAccountPeer(ticket.at("server"), files);
  if (!mmstore::detail::sameIdentity(owner.gui.identity(), listener.gui.identity())) fail("PEER_DENIED");
  owner.revalidate(files); listener.revalidate(files);
}

inline Json storeAccountAccept(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, const StoreBrowserFiles& files, const Json& args) {
  if (!storeAccountPublishedTicket) fail("PEER_DENIED");
  const auto ticket = *storeAccountPublishedTicket;
  storeAccountValidateTicket(ticket, files);
  if (mm::dump(ticket.at("server")) != mm::dump(storeBrowserWireIdentity(boot.self.identity())) ||
      ticket.at("channel").string() != args.at("channel").string() || ticket.at("nonce").string() != args.at("nonce").string()) fail("PEER_DENIED");
  const auto channel = args.at("channel").string(), nonce = args.at("nonce").string(), capability = channel + ":" + nonce;
  if (usedPipeCapabilities.size() >= 4096 || !usedPipeCapabilities.insert(capability).second) fail("PEER_DENIED");
  startConnectionJanitor(); { std::lock_guard lock(connectionMutex); if (connections.size() >= 16 || storeAccountConnections.size() >= 16) fail("PIPE_UNAVAILABLE"); }
  const auto identity = currentIdentity(); Security security(L"O:" + wide(identity.sid) + L"D:P(A;;0x0012019b;;;" + wide(identity.logonSid) + L")");
  Handle pipe(CreateNamedPipeW(wide(pipeName(channel)).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 49152, 8192, 0, &security.attributes));
  if (!pipe.valid()) fail("PIPE_UNAVAILABLE");
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(args.at("timeout_ms").integer());
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.valid()) fail("PIPE_UNAVAILABLE");
  OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
  const BOOL connected = ConnectNamedPipe(pipe.value, &operation);
  if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) finishOverlapped(pipe.value, operation, connected, count, deadline);
  ULONG clientPid = 0; check(GetNamedPipeClientProcessId(pipe.value, &clientPid), "PEER_DENIED");
  const auto actual = processIdentity(clientPid); auto peer = storeAccountPeer(actual, files); storeAccountBrowserPeer(peer, files);
  // Actual kernel client, sealed code and genuine creator are established before
  // reading application bytes; impersonation proves the current logon as well.
  check(ImpersonateNamedPipeClient(pipe.value), "PEER_DENIED");
  try { Handle token; check(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value), "PEER_DENIED"); const auto user = tokenIdentity(token.value); if (user.sid != identity.sid || user.logonSid != identity.logonSid || user.session != identity.session) fail("PEER_DENIED"); }
  catch (...) { RevertToSelf(); throw; }
  check(RevertToSelf(), "PEER_DENIED"); storeAccountValidateTicket(ticket, files); storeAccountBoot(boot, data); storeAccountBrowserPeer(peer, files);
  DWORD size = 0; pipeTransfer(pipe.value, &size, 4, false, deadline); if (size == 0 || size > 8192) fail("FRAME_TOO_LARGE");
  std::string frame(size, '\0'); pipeTransfer(pipe.value, frame.data(), size, false, deadline);
  const auto request = mm::JsonParser(frame).parse(); keys(request, {"version", "sequence", "nonce", "payload_base64"});
  if (request.at("version").integer() != 1 || request.at("sequence").integer() != 1 || !equalSecret(request.at("nonce").string(), nonce)) fail("PEER_DENIED");
  const auto payload = base64Decode(request.at("payload_base64").string(), 4096); storeAccountBrowserPeer(peer, files);
  auto pending = std::make_shared<PendingPipeConnection>(); pending->pipe = std::move(pipe); pending->peer = actual; pending->nonce = nonce; pending->deadline = deadline;
  const auto token = randomHex(); { std::lock_guard lock(connectionMutex); connections.emplace(token, pending); storeAccountConnections.emplace(token, ticket); }
  return Json::Object{{"version", 1}, {"connection", Json::Object{{"token", token}, {"nonce", nonce}, {"peer", actual}}}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}};
}
inline Json storeAccountConnect(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, const StoreBrowserFiles& files, const Json& args) {
  const auto ticket = storeAccountReadRecord(); if (std::holds_alternative<std::nullptr_t>(ticket.value)) fail("PEER_DENIED");
  storeAccountValidateTicket(ticket, files);
  if (ticket.at("channel").string() != args.at("channel").string() || ticket.at("nonce").string() != args.at("nonce").string() || mm::dump(ticket.at("server")) != mm::dump(args.at("peer"))) fail("PEER_DENIED");
  const auto capability = args.at("channel").string() + ":" + args.at("nonce").string();
  if (storeAccountClientCapabilities.size() >= 4096 || !storeAccountClientCapabilities.insert(capability).second) fail("PEER_DENIED");
  const auto expected = args.at("peer"); auto server = storeAccountPeer(expected, files);
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(args.at("timeout_ms").integer());
  auto pipe = storeAccountConnectFixed(wide(pipeName(args.at("channel").string())), server.helper.identity().pid, deadline);
  server.revalidate(files); storeAccountValidateTicket(ticket, files); storeAccountBoot(boot, data);
  const auto claim = vault("vault_get", Json::Object{{"namespace", "account"}, {"key", std::string(mmstoreaccountpolicy::claimKey)}});
  if (std::holds_alternative<std::nullptr_t>(claim.value)) fail("PEER_DENIED");
  auto claimBytes = base64Decode(claim.at("bytes_base64").string(), 4096); const auto claimed = mm::JsonParser(std::string(reinterpret_cast<const char*>(claimBytes.data()), claimBytes.size())).parse(); SecureZeroMemory(claimBytes.data(), claimBytes.size());
  keys(claimed, {"version", "nonce", "channel", "identity", "package_full_name"});
  if (claimed.at("version").integer() != 2 || claimed.at("nonce").string() != args.at("nonce").string() || claimed.at("channel").string() != args.at("channel").string() || claimed.at("package_full_name").string() != utf8(boot.package.observation().fullName) || mm::dump(claimed.at("identity")) != mm::dump(storeBrowserWireIdentity(boot.self.identity()))) fail("PEER_DENIED");
  auto frame = mm::dump(Json::Object{{"version", 1}, {"sequence", 1}, {"nonce", args.at("nonce")}, {"payload_base64", args.at("payload_base64")}}); DWORD size = static_cast<DWORD>(frame.size());
  pipeTransfer(pipe.value, &size, 4, true, deadline); pipeTransfer(pipe.value, frame.data(), size, true, deadline);
  pipeTransfer(pipe.value, &size, 4, false, deadline); if (size == 0 || size > 49152) fail("FRAME_TOO_LARGE");
  frame.assign(size, '\0'); pipeTransfer(pipe.value, frame.data(), size, false, deadline);
  const auto response = mm::JsonParser(frame).parse(); keys(response, {"version", "sequence", "nonce", "payload_base64"});
  if (response.at("version").integer() != 1 || response.at("sequence").integer() != 1 || response.at("nonce").string() != args.at("nonce").string()) fail("PEER_DENIED");
  const auto payload = base64Decode(response.at("payload_base64").string(), 32768); server.revalidate(files); storeAccountBoot(boot, data);
  DWORD acknowledged = 0x4d4d0001; pipeTransfer(pipe.value, &acknowledged, 4, true, deadline);
  return Json::Object{{"version", 1}, {"peer", expected}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}};
}

inline Json dispatchStoreAccount(mmstore::BootstrapAttestation& boot, mmstorenamespace::PrivateNamespaceAuthority& data, const std::string& operation, const Json& args) {
  mmstoreaccountpolicy::input(operation, args, storeAccountNow()); storeAccountBoot(boot, data); const auto& files = storeAccountFiles(boot.package);
  if (operation == "store_account_owner_bind") {
    const auto nonce = args.at("nonce").string(); storeAccountHeldOwner(boot, data, &nonce);
    if (storeAccountOwnerEndpoint && (!storeAccountOwnerEndpoint->live.load() || storeAccountOwnerEndpoint->nonce != nonce)) fail("PEER_DENIED");
    if (!storeAccountOwnerEndpoint) storeAccountOwnerEndpoint = std::make_unique<StoreAccountOwnerEndpoint>(nonce, boot.self.identity(), boot.parent.identity(), boot.package.observation().fullName);
    return Json::Object{{"version", 1}, {"bound", true}, {"owner", storeBrowserWireIdentity(boot.self.identity())}, {"gui", storeBrowserWireIdentity(boot.parent.identity())}, {"lease_nonce", nonce}, {"package_full_name", utf8(boot.package.observation().fullName)}};
  }
  if (operation == "store_account_ticket_publish") {
    const auto publication = singletonRecord("account"); if (std::holds_alternative<std::nullptr_t>(publication.value) || mm::dump(publication.at("helper")) != mm::dump(args.at("owner"))) fail("PEER_DENIED");
    auto owner = storeAccountOwnerProof(args.at("owner"), publication.at("nonce").string(), publication.at("owner"), files);
    if (!mmstore::detail::sameIdentity(owner.gui.identity(), boot.parent.identity()) || owner.helper.identity().pid == boot.self.identity().pid) fail("PEER_DENIED");
    const Json ticket = Json::Object{{"version", 2}, {"owner", args.at("owner")}, {"server", storeBrowserWireIdentity(boot.self.identity())}, {"gui", storeBrowserWireIdentity(boot.parent.identity())},
      {"instance_id", args.at("instance_id")}, {"channel", args.at("channel")}, {"nonce", args.at("nonce")}, {"expires_at", args.at("expires_at")}, {"lease_nonce", publication.at("nonce")}, {"package_full_name", utf8(boot.package.observation().fullName)}};
    storeAccountValidateTicket(ticket, files); storeAccountWriteRecord(mmstoreaccountpolicy::ticketKey, ticket); storeAccountPublishedTicket = ticket;
    return Json::Object{{"version", 1}, {"published", true}, {"ticket", ticket}};
  }
  if (operation == "store_account_ticket_read") {
    const auto ticket = storeAccountReadRecord(); if (std::holds_alternative<std::nullptr_t>(ticket.value)) return Json::Object{{"version", 1}, {"ticket", nullptr}};
    mmstoreaccountpolicy::ticket(ticket, utf8(files.package.observation().fullName), storeAccountNow(), false);
    if (ticket.at("expires_at").integer() <= storeAccountNow()) return Json::Object{{"version", 1}, {"ticket", nullptr}};
    storeAccountValidateTicket(ticket, files); return Json::Object{{"version", 1}, {"ticket", ticket}};
  }
  if (operation == "store_account_ticket_claim") {
    const auto identity = currentIdentity(); Security security(L"O:" + wide(identity.sid) + L"D:P(A;;0x001f0001;;;" + wide(identity.sid) + L")(A;;0x001f0001;;;SY)");
    Handle mutex(CreateMutexW(&security.attributes, FALSE, (L"Local\\MusicMuteStoreAccountTicket-" + privateKernelSid() + L"-" + std::to_wstring(identity.session)).c_str())); if (!mutex.valid()) fail("PIPE_UNAVAILABLE"); assertPrivateMutex(mutex.value);
    const auto waited = WaitForSingleObject(mutex.value, 2000); if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) fail("PIPE_UNAVAILABLE"); struct Release { HANDLE handle; ~Release() { ReleaseMutex(handle); } } lifetime{mutex.value};
    const auto ticket = storeAccountReadRecord(); if (std::holds_alternative<std::nullptr_t>(ticket.value) || ticket.at("nonce").string() != args.at("nonce").string()) return Json::Object{{"version", 1}, {"claimed", false}};
    storeAccountValidateTicket(ticket, files);
    const auto prior = vault("vault_get", Json::Object{{"namespace", "account"}, {"key", std::string(mmstoreaccountpolicy::claimKey)}});
    if (!std::holds_alternative<std::nullptr_t>(prior.value)) { auto bytes = base64Decode(prior.at("bytes_base64").string(), 4096); const auto old = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse(); SecureZeroMemory(bytes.data(), bytes.size()); keys(old, {"version", "nonce", "channel", "identity", "package_full_name"}); if (old.at("version").integer() != 2) fail("VAULT_CORRUPT"); if (old.at("nonce").string() == args.at("nonce").string()) return Json::Object{{"version", 1}, {"claimed", false}}; }
    storeAccountWriteRecord(mmstoreaccountpolicy::claimKey, Json::Object{{"version", 2}, {"nonce", args.at("nonce")}, {"channel", ticket.at("channel")}, {"identity", storeBrowserWireIdentity(boot.self.identity())}, {"package_full_name", utf8(boot.package.observation().fullName)}});
    return Json::Object{{"version", 1}, {"claimed", true}};
  }
  if (operation == "store_account_ticket_remove") {
    storeAccountHeldOwner(boot, data); const auto ticket = storeAccountReadRecord();
    if (std::holds_alternative<std::nullptr_t>(ticket.value)) return Json::Object{{"version", 1}, {"removed", false}};
    mmstoreaccountpolicy::ticket(ticket, utf8(files.package.observation().fullName), storeAccountNow(), false);
    if (ticket.at("instance_id").string() != args.at("instance_id").string() || mm::dump(ticket.at("owner")) != mm::dump(storeBrowserWireIdentity(boot.self.identity())) || ticket.at("lease_nonce").string() != ownedMutexes.at("account").nonce) fail("PEER_DENIED");
    (void)vault("vault_delete", Json::Object{{"namespace", "account"}, {"key", std::string(mmstoreaccountpolicy::ticketKey)}});
    return Json::Object{{"version", 1}, {"removed", true}};
  }
  if (operation == "store_account_peer_verify") {
    auto peer = storeAccountPeer(args.at("peer"), files);
    if (args.at("role").string() == "authority") {
      const auto publication = singletonRecord("account"); if (std::holds_alternative<std::nullptr_t>(publication.value) || mm::dump(publication.at("helper")) != mm::dump(args.at("peer"))) fail("PEER_DENIED");
      (void)storeAccountOwnerProof(args.at("peer"), publication.at("nonce").string(), publication.at("owner"), files);
    } else storeAccountBrowserPeer(peer, files);
    return Json::Object{{"version", 1}, {"verified", true}, {"peer", storeBrowserWireIdentity(peer.helper.identity())}, {"gui", storeBrowserWireIdentity(peer.gui.identity())}, {"package_full_name", utf8(boot.package.observation().fullName)}};
  }
  if (operation == "store_account_same_gui") {
    auto left = storeAccountPeer(args.at("left"), files), right = storeAccountPeer(args.at("right"), files);
    storeAccountBrowserPeer(left, files); storeAccountBrowserPeer(right, files);
    return Json::Object{{"version", 1}, {"same_gui", mmstore::detail::sameIdentity(left.gui.identity(), right.gui.identity())}};
  }
  if (operation == "store_account_launch") {
    const auto prior = inspectSingletonOwner(Json::Object{{"scope", "account"}}); if (prior.at("state").string() == "active" && !std::get<bool>(prior.at("same_session").value)) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
    // The OS activation broker owns lifetime outside Chrome's transient Job.
    // This ACK is an observation; only a later live mutex/ticket proof grants rights.
    mmstore::detail::Apartment apartment;
    winrt::com_ptr<IApplicationActivationManager> manager;
    check(SUCCEEDED(CoCreateInstance(CLSID_ApplicationActivationManager, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(manager.put()))), "JOB_UNAVAILABLE");
    DWORD pid = 0; check(SUCCEEDED(manager->ActivateApplication(mmstoreaccountpolicy::guiAumid.data(), mmstoreaccountpolicy::activationArguments.data(), AO_NOERRORUI, &pid)) && pid > 0 && pid <= 2147483647, "JOB_UNAVAILABLE");
    files.revalidate(); storeAccountBoot(boot, data);
    return Json::Object{{"version", 1}, {"activation", "acknowledged"}, {"pid", static_cast<std::int64_t>(pid)}, {"aumid", utf8(std::wstring(mmstoreaccountpolicy::guiAumid))}};
  }
  if (operation == "store_account_pipe_accept") return storeAccountAccept(boot, data, files, args);
  if (operation == "store_account_pipe_connect") return storeAccountConnect(boot, data, files, args);
  if (operation == "store_account_pipe_reply" || operation == "store_account_pipe_close") {
    const auto token = args.at("token").string(); Json ticket;
    { std::lock_guard lock(connectionMutex); const auto item = storeAccountConnections.find(token); if (item == storeAccountConnections.end() || !connections.contains(token)) fail("PEER_DENIED"); ticket = item->second; storeAccountConnections.erase(item); }
    storeAccountValidateTicket(ticket, files, false); auto peer = storeAccountPeer(args.at("peer"), files);
    if (operation == "store_account_pipe_reply") storeAccountBrowserPeer(peer, files);
    storeAccountBoot(boot, data);
    auto result = (operation == "store_account_pipe_reply" ? pipeReply(args) : pipeClose(args)).object(); result.emplace("version", 1); return result;
  }
  fail("BAD_REQUEST");
}
#endif
