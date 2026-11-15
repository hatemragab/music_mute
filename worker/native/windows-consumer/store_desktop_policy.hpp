#pragma once
#include <cstdint>

namespace mmstoredesktop {
// Desktop Bridge otherwise permits descendants to leave the package. Keep the
// exact child and its subsequent descendants in the actual creator's package.
// This supplies no package identity: every suspended child is still attested.
inline constexpr std::uint32_t childPolicy = 0x02U | 0x04U;
}  // namespace mmstoredesktop

#ifdef _WIN32
#include <windows.h>
namespace mmstoredesktop {
static_assert(childPolicy ==
  (PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE |
   PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_OVERRIDE));
// Declare lifetimeStorage before the attribute-list RAII owner so the borrowed
// DWORD remains alive until DeleteProcThreadAttributeList has completed.
inline bool apply(LPPROC_THREAD_ATTRIBUTE_LIST attributes, DWORD& lifetimeStorage) {
  lifetimeStorage = childPolicy;
  if (!attributes) { SetLastError(ERROR_INVALID_PARAMETER); return false; }
  return UpdateProcThreadAttribute(attributes, 0,
    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, &lifetimeStorage,
    sizeof(lifetimeStorage), nullptr, nullptr) != FALSE;
}
}  // namespace mmstoredesktop
#endif
