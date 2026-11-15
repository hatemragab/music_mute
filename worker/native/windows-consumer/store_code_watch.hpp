#pragma once
#include "store_code_watch_policy.hpp"
#include <array>
#include <cstddef>
#include <mutex>
namespace mmstoreruntime {
#ifdef _WIN32
namespace detail {
// A change detector alone is not code authority. CodeState posts this before
// its full immutable inventory admission and retains it alongside every leaf.
// This is one kernel request for the lease lifetime, never a polling rescan.
class HeldCodeChangeWatch final {
 public:
  explicit HeldCodeChangeWatch(const std::wstring& root)
    : root_(root), directory_(CreateFileW(root.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED, nullptr)),
      event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    mmstore::require(directory_.valid() && event_.valid(), mmstore::ErrorCode::fileDenied);
    birth_ = mmstore::detail::information(directory_.get(), true);
    mmstore::require(mmstore::detail::samePath(mmstore::detail::canonical(directory_.get()), root), mmstore::ErrorCode::pathDenied);
    operation_.hEvent = event_.get();
    constexpr DWORD changes = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_ATTRIBUTES |
      FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION | FILE_NOTIFY_CHANGE_SECURITY;
    mmstore::require(ReadDirectoryChangesW(directory_.get(), buffer_.data(), static_cast<DWORD>(buffer_.size()), TRUE,
      changes, nullptr, &operation_, nullptr) != FALSE, mmstore::ErrorCode::fileDenied);
    posted_ = true;
    // A completion before initial census already means the lease was changed.
    try { policy_.armed(observation()); } catch (...) { joinCancellation(); throw; }
  }
  ~HeldCodeChangeWatch() { joinCancellation(); }
  HeldCodeChangeWatch(const HeldCodeChangeWatch&) = delete;
  HeldCodeChangeWatch& operator=(const HeldCodeChangeWatch&) = delete;
  void requirePending() {
    std::lock_guard lock(mutex_);
    try { validateRoot(); policy_.requirePending(observation()); validateRoot(); }
    catch (...) { policy_.requirePending(CodeWatchObservation::error); }
  }
  void completedInitialCensus() {
    std::lock_guard lock(mutex_);
    try { validateRoot(); policy_.completedInitialCensus(observation()); validateRoot(); }
    catch (...) { policy_.requireLive(CodeWatchObservation::error); }
  }
  void requireLive() {
    std::lock_guard lock(mutex_);
    try { validateRoot(); policy_.requireLive(observation()); validateRoot(); }
    catch (...) { policy_.requireLive(CodeWatchObservation::error); }
  }
  // Actual scratch tests may wait for this unnamed event. It cannot be used to
  // signal/repost the watch or construct any registered-package authority.
  bool waitForChange(DWORD milliseconds) const {
    return WaitForSingleObject(event_.get(), milliseconds) == WAIT_OBJECT_0;
  }
 private:
  CodeWatchObservation observation() const noexcept {
    if (!posted_ || !directory_.valid() || !event_.valid()) return CodeWatchObservation::error;
    DWORD received = 0;
    if (GetOverlappedResult(directory_.get(), const_cast<OVERLAPPED*>(&operation_), &received, FALSE) != FALSE)
      return received == 0 ? CodeWatchObservation::overflow : CodeWatchObservation::changed;
    if (GetLastError() != ERROR_IO_INCOMPLETE || WaitForSingleObject(event_.get(), 0) != WAIT_TIMEOUT)
      return CodeWatchObservation::error;
    return CodeWatchObservation::pending;
  }
  void validateRoot() const {
    mmstore::require(mmstore::detail::sameFile(birth_, mmstore::detail::information(directory_.get(), true)) &&
      mmstore::detail::samePath(mmstore::detail::canonical(directory_.get()), root_), mmstore::ErrorCode::pathDenied);
  }
  void joinCancellation() noexcept {
    if (!posted_ || !directory_.valid()) return;
    // Buffer/OVERLAPPED/event memory stays owned until the exact original IO
    // completes. Closing a handle or requesting cancellation alone is no join.
    (void)CancelIoEx(directory_.get(), &operation_);
    DWORD received = 0;
    (void)GetOverlappedResult(directory_.get(), &operation_, &received, TRUE);
    posted_ = false;
  }
  std::wstring root_;
  mmstore::detail::Handle directory_, event_;
  BY_HANDLE_FILE_INFORMATION birth_{};
  OVERLAPPED operation_{};
  alignas(DWORD) std::array<std::byte, 65536> buffer_{};
  CodeWatchPolicy policy_;
  std::mutex mutex_;
  bool posted_ = false;
};
} // namespace detail
#endif
} // namespace mmstoreruntime
