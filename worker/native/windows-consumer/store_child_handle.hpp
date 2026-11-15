#pragma once
#include "store_authority.hpp"
namespace mmstorechild {
#ifdef _WIN32
// Cleanup primitive only; the caller already owns the exact original handle.
// Failed close retains that owner and cannot confirm retirement.
inline void closeOwned(HANDLE& value) {
  if (!value || value == INVALID_HANDLE_VALUE) return;
  mmstore::require(CloseHandle(value) != FALSE, mmstore::ErrorCode::processDenied);
  value = nullptr;
}
#endif
} // namespace mmstorechild
