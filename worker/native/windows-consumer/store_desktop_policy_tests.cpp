#include "store_desktop_policy.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
void require(bool value) { if (!value) throw std::runtime_error("DESKTOP_POLICY_CONTRACT"); }
}
int main() {
  try {
    require(mmstoredesktop::childPolicy == 6 && (mmstoredesktop::childPolicy & 1U) == 0);
#ifdef _WIN32
    DWORD policy = 1;
    SetLastError(ERROR_SUCCESS);
    require(!mmstoredesktop::apply(nullptr, policy));
    require(policy == 6 && GetLastError() == ERROR_INVALID_PARAMETER);
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    const auto input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &security, OPEN_EXISTING, 0, nullptr);
    require(input != INVALID_HANDLE_VALUE);
    struct File { HANDLE value; ~File() { CloseHandle(value); } } file{input};
    SIZE_T bytes = 0;
    (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
    require(bytes > 0);
    std::vector<BYTE> storage(bytes);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(attributes, 2, 0, &bytes) != FALSE);
    // policy precedes this owner: its borrowed value remains alive at deletion.
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } lifetime{attributes};
    HANDLE inherited[]{input};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      inherited, sizeof(inherited), nullptr, nullptr) != FALSE);
    require(mmstoredesktop::apply(attributes, policy) && policy == 6);
    DWORD flags = 0;
    require(GetHandleInformation(input, &flags) != FALSE && (flags & HANDLE_FLAG_INHERIT));
    std::cout << "Store desktop child policy and actual Win32 attribute-list contract passed. Installed child package identity is a separate launch check.\n";
#else
    std::cout << "Store desktop child policy portable constants passed; Win32 attributes were not exercised.\n";
#endif
    return 0;
  } catch (...) { return 1; }
}
