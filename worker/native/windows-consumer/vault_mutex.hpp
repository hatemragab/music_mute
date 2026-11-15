#pragma once

void assertPrivateMutex(HANDLE mutex);
struct VaultNamespaceLock {
  Handle handle;
  explicit VaultNamespaceLock(const std::string& space) {
    if (space != "account" && space != "fleet") fail("BAD_REQUEST");
    const auto sid = wide(currentIdentity().sid);
    Security security(L"O:" + sid + L"D:P(A;;0x001f0001;;;" + sid + L")(A;;0x001f0001;;;SY)");
    handle = Handle(CreateMutexW(&security.attributes, FALSE, (L"Global\\MusicMuteVault-v1-" + privateKernelSid() + L"-" + wide(space)).c_str()));
    if (!handle.valid()) fail("VAULT_UNAVAILABLE");
    assertPrivateMutex(handle.value);
    const auto waited = WaitForSingleObject(handle.value, 5000);
    if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) fail("VAULT_UNAVAILABLE");
  }
  ~VaultNamespaceLock() { if (handle.valid()) ReleaseMutex(handle.value); }
};
