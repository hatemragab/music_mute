#pragma once

struct OwnedMutex { Handle handle; std::string nonce; Json identity; bool loginPublication=false; };
void claimSingleton(const std::string& scope, const std::string& nonce);
void clearSingleton(const std::string& scope, const std::string& nonce);
void assertNoSingleton(const std::string& scope);
std::map<std::string, OwnedMutex> ownedMutexes;
bool cacheAdmissionRecover();
void closeCacheCandidates();
std::wstring mutexName(const std::string& scope) {
  const auto sid = privateKernelSid();
  if (scope == "session" || scope == "activation") return L"Global\\MusicMuteConsumerSession-" + sid;
  if (scope == "account") return L"Global\\MusicMuteConsumerAccount-" + sid;
  if (scope == "prepare") return L"Global\\MusicMuteConsumerPrepare-" + sid;
  if (scope == "acquisition") return L"Global\\MusicMuteConsumerAcquisition-" + sid;
  if (scope == "cache") return L"Global\\MusicMuteConsumerCache-" + sid;
  if (scope == "metadata") return L"Global\\MusicMuteConsumerMetadata-" + sid;
  fail("BAD_REQUEST");
}
void assertPrivateMutex(HANDLE mutex) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(mutex, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) fail("ACL_UNSAFE");
  LocalMemory memory{descriptor};
  if (!owner || sidString(owner) != currentIdentity().sid || !acl || acl->AceCount == 0) fail("ACL_UNSAFE");
  for (DWORD n = 0; n < acl->AceCount; ++n) {
    void* entry = nullptr; check(GetAce(acl, n, &entry), "ACL_UNSAFE");
    const auto* header = static_cast<const ACE_HEADER*>(entry);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) fail("ACL_UNSAFE");
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(entry);
    const auto sid = sidString(const_cast<DWORD*>(&ace->SidStart));
    if (sid != currentIdentity().sid && sid != "S-1-5-18") fail("ACL_UNSAFE");
  }
}
Json acquireMutex(const Json& args) {
  const auto scope = args.at("scope").string();
  // One lease per helper/scope: contention must not enter Win32's same-thread
  // recursive acquisition or replace the original nonce/handle ownership.
  if (ownedMutexes.contains(scope)) return Json::Object{{"acquired", false}};
  if ((scope == "session" && ownedMutexes.contains("activation")) || (scope == "activation" && ownedMutexes.contains("session"))) fail("JOB_BUSY");
  const auto sid = wide(currentIdentity().sid);
  Security security(L"O:" + sid + L"D:P(A;;0x001f0001;;;" + sid + L")(A;;0x001f0001;;;SY)");
  Handle mutex(CreateMutexW(&security.attributes, FALSE, mutexName(scope).c_str()));
  if (!mutex.valid()) fail("IDENTITY_UNAVAILABLE");
  assertPrivateMutex(mutex.value);
  const DWORD waited = WaitForSingleObject(mutex.value, 0);
  if (waited == WAIT_TIMEOUT) return Json::Object{{"acquired", false}};
  if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) fail("IDENTITY_UNAVAILABLE");
  OwnedMutex owner;
  owner.handle = std::move(mutex); owner.nonce = randomHex(); owner.identity = processIdentity(GetCurrentProcessId());
  try {
    // A durable deletion intent fences all new cache writers/pins until its
    // exact object is settled. Abandonment alone is never cleanup authority.
    if (scope == "cache" && !cacheAdmissionRecover()) {
      check(ReleaseMutex(owner.handle.value), "IDENTITY_UNAVAILABLE");
      return Json::Object{{"acquired", false}};
    }
    if (scope == "session" || scope == "account") claimSingleton(scope, owner.nonce);
    if (scope == "activation") {
      assertNoSingleton("session");
      if(workerLoginAuthenticated){claimSingleton("session",owner.nonce);owner.loginPublication=true;}
    }
  } catch (...) { ReleaseMutex(owner.handle.value); throw; }
  const auto result = Json::Object{{"acquired", true}, {"scope", scope}, {"nonce", owner.nonce}, {"identity", owner.identity}, {"abandoned", waited == WAIT_ABANDONED}};
  ownedMutexes.emplace(scope, std::move(owner));
  return result;
}
Json releaseMutex(const Json& args) {
  const auto item = ownedMutexes.find(args.at("scope").string());
  if (item == ownedMutexes.end()) fail("PEER_DENIED");
  if (!equalSecret(item->second.nonce, args.at("nonce").string()) || mm::dump(item->second.identity) != mm::dump(args.at("identity"))) fail("PEER_DENIED");
  if (item->first == "cache") closeCacheCandidates();
  if (item->first == "account") retireStoreAccountOwner();
  if (item->first == "session" || item->first == "account") clearSingleton(item->first, item->second.nonce);
  if(item->first=="activation"&&item->second.loginPublication)clearSingleton("session",item->second.nonce);
  check(ReleaseMutex(item->second.handle.value), "IDENTITY_UNAVAILABLE");
  ownedMutexes.erase(item);
  return Json::Object{{"released", true}};
}
