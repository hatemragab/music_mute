#pragma once

// The mutex is SID-wide; only pipes and peer verification remain logon-bound.
// Keep the real parent birth in DPAPI so an abandoned helper mutex cannot allow
// another logon while the original account/agent authority still lives.
Json singletonParentIdentity();
struct SingletonAuthorityLock {
  Handle handle;
  SingletonAuthorityLock(){const auto sid=wide(currentIdentity().sid);Security security(L"O:"+sid+L"D:P(A;;0x001f0001;;;"+sid+L")(A;;0x001f0001;;;SY)");handle=Handle(CreateMutexW(&security.attributes,FALSE,(L"Global\\MusicMuteAuthority-v1-"+privateKernelSid()).c_str()));if(!handle.valid())fail("IDENTITY_UNAVAILABLE");assertPrivateMutex(handle.value);const auto waited=WaitForSingleObject(handle.value,5000);if(waited!=WAIT_OBJECT_0&&waited!=WAIT_ABANDONED)fail("IDENTITY_UNAVAILABLE");}
  ~SingletonAuthorityLock(){if(handle.valid())ReleaseMutex(handle.value);}
};
std::string singletonNamespace(const std::string& scope) {
  if (scope == "session") return "fleet";
  if (scope == "account") return "account";
  fail("BAD_REQUEST");
}
Json singletonRecord(const std::string& scope) {
  const auto encrypted = vault("vault_get", Json::Object{{"namespace", singletonNamespace(scope)}, {"key", "singleton_" + scope}});
  if (std::holds_alternative<std::nullptr_t>(encrypted.value)) return nullptr;
  auto bytes = base64Decode(encrypted.at("bytes_base64").string(), 4096);
  Json record;
  try { record = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse(); }
  catch (...) { SecureZeroMemory(bytes.data(), bytes.size()); fail("VAULT_CORRUPT"); }
  SecureZeroMemory(bytes.data(), bytes.size());
  keys(record, {"version", "scope", "nonce", "helper", "owner"});
  if (record.at("version").integer() != 1 || record.at("scope").string() != scope) fail("VAULT_CORRUPT");
  const auto nonce = record.at("nonce").string();
  if (nonce.size() != 64 || nonce.find_first_not_of("0123456789abcdef") != std::string::npos) fail("VAULT_CORRUPT");
  for (const auto* name : {"helper", "owner"}) {
    const auto& identity = record.at(name); keys(identity, {"sid", "session_id", "pid", "creation_time"});
    if (identity.at("sid").string() != currentIdentity().sid || identity.at("session_id").integer() < 1 || identity.at("pid").integer() < 1 || identity.at("pid").integer() > 2147483647) fail("VAULT_CORRUPT");
    const auto& birth = identity.at("creation_time").string();
    if (birth.empty() || birth.size() > 20 || birth.find_first_not_of("0123456789") != std::string::npos) fail("VAULT_CORRUPT");
  }
  return record;
}
// null means exact prior process is gone/replaced. Access denied is unknown and
// propagates as a refusal; it never becomes permission to take ownership.
Json liveSingletonOwner(const Json& record) {
  if (std::holds_alternative<std::nullptr_t>(record.value)) return nullptr;
  const auto& owner = record.at("owner");
  const auto actual = processIdentity(static_cast<DWORD>(owner.at("pid").integer()), true);
  return mm::dump(actual) == mm::dump(owner) ? owner : Json(nullptr);
}
void claimSingleton(const std::string& scope, const std::string& nonce) {
  SingletonAuthorityLock authority;
  const auto parent = singletonParentIdentity(), prior = liveSingletonOwner(singletonRecord(scope));
  if (!std::holds_alternative<std::nullptr_t>(prior.value) && mm::dump(parent) != mm::dump(prior)) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
  const auto other=liveSingletonOwner(singletonRecord(scope=="account"?"session":"account"));
  if(!std::holds_alternative<std::nullptr_t>(other.value)&&other.at("session_id").integer()!=currentIdentity().session)fail("WINDOWS_SESSION_ALREADY_ACTIVE");
  const auto text = mm::dump(Json::Object{{"version", 1}, {"scope", scope}, {"nonce", nonce}, {"helper", processIdentity(GetCurrentProcessId())}, {"owner", parent}});
  (void)vault("vault_put", Json::Object{{"namespace", singletonNamespace(scope)}, {"key", "singleton_" + scope}, {"bytes_base64", base64Encode(reinterpret_cast<const BYTE*>(text.data()), static_cast<DWORD>(text.size()))}});
}
void clearSingleton(const std::string& scope, const std::string& nonce) {
  SingletonAuthorityLock authority;
  const auto record = singletonRecord(scope);
  if (std::holds_alternative<std::nullptr_t>(record.value) || !equalSecret(record.at("nonce").string(), nonce) || mm::dump(record.at("helper")) != mm::dump(processIdentity(GetCurrentProcessId()))) fail("PEER_DENIED");
  (void)vault("vault_delete", Json::Object{{"namespace", singletonNamespace(scope)}, {"key", "singleton_" + scope}});
}
Json inspectSingletonOwner(const Json& args) {
  const auto scope = args.at("scope").string();
  const auto owner = liveSingletonOwner(singletonRecord(scope));
  const bool absent = std::holds_alternative<std::nullptr_t>(owner.value);
  return Json::Object{{"state", absent ? "absent" : "active"}, {"owner", owner}, {"same_session", !absent && owner.at("session_id").integer() == currentIdentity().session}};
}
void assertSingletonPublication(const std::string& scope) {
  const auto owner = liveSingletonOwner(singletonRecord(scope));
  if (std::holds_alternative<std::nullptr_t>(owner.value) || mm::dump(owner) != mm::dump(singletonParentIdentity())) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
}
void assertNoSingleton(const std::string& scope) {
  if (!std::holds_alternative<std::nullptr_t>(liveSingletonOwner(singletonRecord(scope)).value)) fail("WINDOWS_SESSION_ALREADY_ACTIVE");
}
