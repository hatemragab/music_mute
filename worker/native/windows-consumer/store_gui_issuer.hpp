#pragma once
// Included inside main.cpp's implementation namespace. A selected Windows
// process-parent attribute is not a GUI-issued child claim. The running sealed
// GUI owns this one-use pipe/nonce and records the actual spawned helper PID.
DWORD storeIssuerTransfer(HANDLE pipe, void* bytes, DWORD length, bool write, ULONGLONG deadline) {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.valid()) fail("PIPE_UNAVAILABLE");
  OVERLAPPED operation{}; operation.hEvent = event.value; DWORD count = 0;
  const auto now = GetTickCount64(); if (now >= deadline) fail("TIMEOUT");
  const BOOL started = write ? WriteFile(pipe, bytes, length, &count, &operation) : ReadFile(pipe, bytes, length, &count, &operation);
  if (!started) {
    const auto error = GetLastError();
    if (!write && error == ERROR_BROKEN_PIPE) return 0;
    if (error != ERROR_IO_PENDING) fail("PIPE_UNAVAILABLE");
    const auto waitingAt = GetTickCount64();
    const DWORD budget = waitingAt < deadline ? static_cast<DWORD>(deadline - waitingAt) : 0;
    if (WaitForSingleObject(event.value, budget) != WAIT_OBJECT_0) {
      (void)CancelIoEx(pipe, &operation);
      (void)GetOverlappedResult(pipe, &operation, &count, TRUE);
      fail("TIMEOUT");
    }
    if (!GetOverlappedResult(pipe, &operation, &count, FALSE)) {
      if (!write && GetLastError() == ERROR_BROKEN_PIPE) return 0;
      fail("PIPE_UNAVAILABLE");
    }
  }
  if (count > length || (write && count == 0)) fail("PIPE_UNAVAILABLE");
  return count;
}
void authenticateStoreGuiIssuer(mmstore::BootstrapAttestation& boot, const std::string& nonce) {
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos ||
      boot.package.kind() != mmstore::PackageKind::gui || boot.parent.role() != mmstore::CodeRole::guiApplication)
    fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); boot.package.revalidate();
  const auto name = L"\\\\.\\pipe\\MusicMuteStoreGuiBootstrap-" + std::to_wstring(boot.parent.identity().pid) + L"-" + wide(nonce);
  const auto deadline = GetTickCount64() + 10000;
  Handle pipe;
  for (;;) {
    // Identification prevents the server from impersonating this helper.
    pipe = Handle(CreateFileW(name.c_str(), FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE, 0, nullptr,
      OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    if (pipe.valid()) break;
    const auto error = GetLastError();
    if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) fail("PIPE_UNAVAILABLE");
    (void)remaining(deadline); Sleep(5);
  }
  ULONG actualServer = 0;
  check(GetNamedPipeServerProcessId(pipe.value, &actualServer), "PEER_DENIED");
  if (actualServer != boot.parent.identity().pid) fail("PEER_DENIED");
  boot.parent.revalidate();
  auto request = mm::dump(Json::Object{{"version", 1}, {"nonce", nonce},
    {"pid", static_cast<std::int64_t>(boot.self.identity().pid)}, {"creation_time", utf8(boot.self.identity().creationTime)}}) + "\n";
  if (request.size() > 4096) fail("BAD_REQUEST");
  std::size_t written = 0;
  while (written < request.size()) written += storeIssuerTransfer(pipe.value, request.data() + written, static_cast<DWORD>(request.size() - written), true, deadline);
  SecureZeroMemory(request.data(), request.size());
  std::string reply;
  for (;;) {
    char byte = 0; const auto count = storeIssuerTransfer(pipe.value, &byte, 1, false, deadline);
    if (count != 1) fail("PEER_DENIED");
    if (byte == '\n') break;
    if (reply.size() >= 4096 || byte == '\r' || byte == '\0') fail("PEER_DENIED");
    reply.push_back(byte);
  }
  auto acknowledged = mm::JsonParser(reply).parse();
  mmstoreguiissuer::validateReply(acknowledged, nonce, boot.self.identity().pid, utf8(boot.self.identity().creationTime));
  SecureZeroMemory(reply.data(), reply.size());
  char extra = 0;
  if (storeIssuerTransfer(pipe.value, &extra, 1, false, deadline) != 0) fail("PEER_DENIED");
  boot.self.revalidate(); boot.parent.revalidate(); boot.package.revalidate();
}
