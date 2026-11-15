#pragma once

// Included inside the native helper namespace after the Win32 policy primitives.
// Authentication finishes before business code receives any application payload.
struct PendingPipeConnection {
  Handle pipe;
  Json peer;
  std::string nonce;
  ULONGLONG deadline = 0;
};
std::mutex connectionMutex;
std::map<std::string, std::shared_ptr<PendingPipeConnection>> connections;
std::jthread connectionJanitor;
std::once_flag connectionJanitorStarted;

void startConnectionJanitor() {
  std::call_once(connectionJanitorStarted, [] {
    connectionJanitor = std::jthread([](std::stop_token stopping) {
      while (!stopping.stop_requested()) {
        {
          std::lock_guard lock(connectionMutex);
          for (auto item = connections.begin(); item != connections.end();) {
            if (GetTickCount64() >= item->second->deadline) item = connections.erase(item);
            else ++item;
          }
        }
        Sleep(25);
      }
    });
  });
}
void pipeTransfer(HANDLE pipe, void* data, DWORD length, bool write, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.valid()) fail("PIPE_UNAVAILABLE");
  DWORD offset = 0;
  while (offset < length) {
    (void)remaining(deadline);
    ResetEvent(event.value); OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
    const BOOL started = write ? WriteFile(pipe, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation) : ReadFile(pipe, static_cast<BYTE*>(data) + offset, length - offset, &count, &operation);
    finishOverlapped(pipe, operation, started, count, deadline);
    if (count == 0 || count > length - offset) fail("PIPE_UNAVAILABLE");
    offset += count;
  }
}
Json pipeAccept(const Json& args) {
  const auto nonce = args.at("nonce").string();
  const auto channel = args.at("channel").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto capability = channel + ":" + nonce;
  if (usedPipeCapabilities.size() >= 4096 || !usedPipeCapabilities.insert(capability).second) fail("PEER_DENIED");
  const auto timeout = args.at("timeout_ms").integer();
  if (timeout < 100 || timeout > 30000) fail("BAD_REQUEST");
  startConnectionJanitor();
  { std::lock_guard lock(connectionMutex); if (connections.size() >= 16) fail("PIPE_UNAVAILABLE"); }
  const auto identity = currentIdentity();
  const auto& expected = args.at("peer");
  const bool boundPeer = !std::holds_alternative<std::nullptr_t>(expected.value);
  if (boundPeer && (expected.at("sid").string() != identity.sid || expected.at("session_id").integer() != identity.session)) fail("PEER_DENIED");
  Security security(L"O:" + wide(identity.sid) + L"D:P(A;;0x0012019b;;;" + wide(identity.logonSid) + L")");
  Handle pipe(CreateNamedPipeW(wide(pipeName(channel)).c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 49152, 8192, 0, &security.attributes));
  if (!pipe.valid()) fail("PIPE_UNAVAILABLE");
  const auto deadline = GetTickCount64() + static_cast<ULONGLONG>(timeout);
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr)); if (!event.valid()) fail("PIPE_UNAVAILABLE");
  OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
  const BOOL connected = ConnectNamedPipe(pipe.value, &operation);
  if (!connected && GetLastError() != ERROR_PIPE_CONNECTED) finishOverlapped(pipe.value, operation, connected, count, deadline);
  ULONG pid = 0; check(GetNamedPipeClientProcessId(pipe.value, &pid), "PEER_DENIED");
  const auto actual = processIdentity(pid);
  if (std::holds_alternative<std::nullptr_t>(actual.value) || actual.at("sid").string() != identity.sid || actual.at("session_id").integer() != identity.session || (boundPeer && mm::dump(actual) != mm::dump(expected))) fail("PEER_DENIED");
  DWORD size = 0; pipeTransfer(pipe.value, &size, 4, false, deadline);
  if (size == 0 || size > 8192) fail("FRAME_TOO_LARGE");
  std::string frame(size, '\0'); pipeTransfer(pipe.value, frame.data(), size, false, deadline);
  check(ImpersonateNamedPipeClient(pipe.value), "PEER_DENIED");
  try {
    Handle token; check(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token.value), "PEER_DENIED");
    const auto impersonated = tokenIdentity(token.value);
    if (impersonated.sid != identity.sid || impersonated.logonSid != identity.logonSid || impersonated.session != identity.session) fail("PEER_DENIED");
  } catch (...) { RevertToSelf(); throw; }
  check(RevertToSelf(), "PEER_DENIED");
  const auto request = mm::JsonParser(frame).parse();
  if (request.at("version").integer() != 1 || request.at("sequence").integer() != 1 || !equalSecret(request.at("nonce").string(), nonce)) fail("PEER_DENIED");
  const auto payload = base64Decode(request.at("payload_base64").string(), 4096);
  auto pending = std::make_shared<PendingPipeConnection>();
  pending->pipe = std::move(pipe); pending->peer = actual; pending->nonce = nonce; pending->deadline = deadline;
  const auto token = randomHex();
  { std::lock_guard lock(connectionMutex); connections.emplace(token, pending); }
  return Json::Object{{"connection", Json::Object{{"token", token}, {"nonce", nonce}, {"peer", actual}}}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}};
}
std::shared_ptr<PendingPipeConnection> takeConnection(const Json& args) {
  const auto token = args.at("token").string();
  std::shared_ptr<PendingPipeConnection> result;
  {
    std::lock_guard lock(connectionMutex);
    const auto item = connections.find(token);
    if (item == connections.end()) fail("PIPE_UNAVAILABLE");
    if (!equalSecret(item->second->nonce, args.at("nonce").string()) || mm::dump(item->second->peer) != mm::dump(args.at("peer"))) fail("PEER_DENIED");
    result = item->second; connections.erase(item);
  }
  (void)remaining(result->deadline);
  ULONG pid = 0; check(GetNamedPipeClientProcessId(result->pipe.value, &pid), "PEER_DENIED");
  if (mm::dump(processIdentity(pid)) != mm::dump(result->peer)) fail("PEER_DENIED");
  return result;
}
Json pipeReply(const Json& args) {
  const auto payload = base64Decode(args.at("payload_base64").string(), 32768);
  const auto pending = takeConnection(args);
  auto frame = mm::dump(Json::Object{{"version", 1}, {"sequence", 1}, {"nonce", pending->nonce}, {"payload_base64", base64Encode(payload.data(), static_cast<DWORD>(payload.size()))}});
  DWORD size = static_cast<DWORD>(frame.size());
  pipeTransfer(pending->pipe.value, &size, 4, true, pending->deadline);
  pipeTransfer(pending->pipe.value, frame.data(), size, true, pending->deadline);
  DWORD acknowledged = 0;
  pipeTransfer(pending->pipe.value, &acknowledged, 4, false, pending->deadline);
  if (acknowledged != 0x4d4d0001) fail("PROTOCOL_MISMATCH");
  DisconnectNamedPipe(pending->pipe.value);
  return Json::Object{{"replied", true}};
}
Json pipeClose(const Json& args) {
  const auto pending = takeConnection(args);
  DisconnectNamedPipe(pending->pipe.value);
  return Json::Object{{"closed", true}};
}
