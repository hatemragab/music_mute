#pragma once

// Fixed current-logon claim prevents two clients consuming one listener.
// Commands and credentials never enter this record.
Json claimControlTicket(const Json& args, bool browserAccount) {
  const auto nonce = args.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  const auto identity = currentIdentity(); const auto sid = wide(identity.sid);
  Security security(L"O:" + sid + L"D:P(A;;0x001f0001;;;" + sid + L")(A;;0x001f0001;;;SY)");
  Handle mutex(CreateMutexW(&security.attributes, FALSE, ((browserAccount ? L"Local\\MusicMuteBrowserAccountTicket-" : L"Local\\MusicMuteControlTicket-") + sid + L"-" + std::to_wstring(identity.session)).c_str()));
  if (!mutex.valid()) fail("PIPE_UNAVAILABLE"); assertPrivateMutex(mutex.value);
  const auto waited = WaitForSingleObject(mutex.value, 2000);
  if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) fail("PIPE_UNAVAILABLE");
  struct Release { HANDLE value; ~Release() { ReleaseMutex(value); } } release{mutex.value};
  const std::string nameSpace = browserAccount ? "account" : "fleet", ticketKey = browserAccount ? "browser_ticket" : "session_ticket", claimKey = browserAccount ? "browser_ticket_claim" : "session_ticket_claim";
  const auto ticket = vault("vault_get", Json::Object{{"namespace", nameSpace}, {"key", ticketKey}});
  if (std::holds_alternative<std::nullptr_t>(ticket.value)) return Json::Object{{"claimed", false}};
  auto bytes = base64Decode(ticket.at("bytes_base64").string(), 4096);
  const auto value = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse(); SecureZeroMemory(bytes.data(), bytes.size());
  if (value.at("version").integer() != 1 || value.at("nonce").string() != nonce || value.at("server").at("sid").string() != identity.sid || value.at("server").at("sessionId").integer() != identity.session) return Json::Object{{"claimed", false}};
  const auto previous = vault("vault_get", Json::Object{{"namespace", nameSpace}, {"key", claimKey}});
  if (!std::holds_alternative<std::nullptr_t>(previous.value)) {
    auto oldBytes = base64Decode(previous.at("bytes_base64").string(), 4096);
    const auto old = mm::JsonParser(std::string(reinterpret_cast<const char*>(oldBytes.data()), oldBytes.size())).parse(); SecureZeroMemory(oldBytes.data(), oldBytes.size());
    if (old.at("nonce").string() == nonce) return Json::Object{{"claimed", false}};
  }
  const auto text = mm::dump(Json::Object{{"version", 1}, {"nonce", nonce}, {"identity", processIdentity(GetCurrentProcessId())}});
  (void)vault("vault_put", Json::Object{{"namespace", nameSpace}, {"key", claimKey}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}});
  return Json::Object{{"claimed", true}};
}
Json claimSessionTicket(const Json& args) { return claimControlTicket(args, false); }
Json claimBrowserAccountTicket(const Json& args) { return claimControlTicket(args, true); }
