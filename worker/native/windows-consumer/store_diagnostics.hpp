#pragma once

// Diagnostic observations only. No field is a package, process, role or cleanup
// authority, and no caller text can enter this closed development-only channel.
#include <array>
#include <atomic>
#include <cstdint>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#endif

namespace mmstorediagnostic {
enum class Phase {
  entryContext, entrySelf, sessionWindow, sessionRegister, sessionNetwork,
  transportEof, storeBoot, storeStartup, storeDispatch, authority, jobCreate,
  jobLimits, pipeCreate, pipeFlags, attributeList, childCreate, childAssign,
  childAttest, childCheck, childResume, shutdownInput, shutdownUnassigned,
  shutdownRoot, shutdownKill, shutdownAccounting, shutdownCensus,
  shutdownConfirm, shutdownTimeout, complete
};
inline constexpr std::array<std::string_view, 29> phases{
  "entry-context", "entry-self", "session-window", "session-register",
  "session-network", "transport-eof", "store-boot", "store-startup",
  "store-dispatch", "authority", "job-create", "job-limits", "pipe-create",
  "pipe-flags", "attribute-list", "child-create", "child-assign",
  "child-attest", "child-check", "child-resume", "shutdown-input",
  "shutdown-unassigned", "shutdown-root", "shutdown-kill",
  "shutdown-accounting", "shutdown-census", "shutdown-confirm",
  "shutdown-timeout", "complete"
};
inline constexpr std::uint32_t unobserved = (std::numeric_limits<std::uint32_t>::max)();
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
inline constexpr bool enabled = true;
#else
inline constexpr bool enabled = false;
#endif
struct Record {
  Phase phase = Phase::authority;
  std::uint32_t code = 0, win32 = 0, wait = unobserved, exit = unobserved;
  std::uint32_t active = unobserved, assigned = unobserved, listed = unobserved;
};
struct ErrorNumbers { std::uint32_t code = 0, win32 = 0; };
inline constexpr ErrorNumbers mappedError(std::uint32_t code, std::uint32_t win32) noexcept {
  // Keep the original typed denial across wire-error translation without
  // accepting text or retaining observations from a different request.
  if constexpr (enabled) {
    if (code >= 1 && code <= 11) return {code, win32};
  }
  return {};
}
inline std::string_view phaseName(Phase phase) {
  const auto index = static_cast<std::size_t>(phase);
  if (index >= phases.size()) throw std::invalid_argument("DIAGNOSTIC_PHASE");
  return phases[index];
}
inline std::string line(const Record& value) {
  if (value.code > 11) throw std::invalid_argument("DIAGNOSTIC_CODE");
  std::string result = "MMDEV1 phase=";
  result += phaseName(value.phase);
  for (const auto& field : std::array<std::pair<std::string_view, std::uint32_t>, 7>{{
    {"code", value.code}, {"win32", value.win32}, {"wait", value.wait},
    {"exit", value.exit}, {"active", value.active}, {"assigned", value.assigned},
    {"listed", value.listed}}}) {
    result += ' '; result += field.first; result += '='; result += std::to_string(field.second);
  }
  result += '\n';
  if (result.size() > 256) throw std::invalid_argument("DIAGNOSTIC_SIZE");
  return result;
}
inline std::optional<Record> parse(std::string_view input) noexcept {
  try {
    if (input.empty() || input.size() > 256 || input.back() != '\n') return std::nullopt;
    input.remove_suffix(1);
    constexpr std::string_view prefix = "MMDEV1 phase=";
    if (!input.starts_with(prefix)) return std::nullopt;
    input.remove_prefix(prefix.size());
    const auto end = input.find(' ');
    if (end == std::string_view::npos) return std::nullopt;
    Record result; bool found = false;
    for (std::size_t index = 0; index < phases.size(); ++index)
      if (input.substr(0, end) == phases[index]) { result.phase = static_cast<Phase>(index); found = true; break; }
    if (!found) return std::nullopt;
    input.remove_prefix(end);
    for (const auto& field : std::array<std::pair<std::string_view, std::uint32_t*>, 7>{{
      {"code", &result.code}, {"win32", &result.win32}, {"wait", &result.wait},
      {"exit", &result.exit}, {"active", &result.active},
      {"assigned", &result.assigned}, {"listed", &result.listed}}}) {
      const auto key = std::string(" ") + std::string(field.first) + '=';
      if (!input.starts_with(key)) return std::nullopt;
      input.remove_prefix(key.size());
      const auto next = input.find(' '), size = next == std::string_view::npos ? input.size() : next;
      const auto number = input.substr(0, size);
      if (number.empty() || number.size() > 10 || (number.size() > 1 && number.front() == '0')) return std::nullopt;
      std::uint64_t value = 0;
      for (const char digit : number) {
        if (digit < '0' || digit > '9') return std::nullopt;
        value = value * 10 + static_cast<unsigned>(digit - '0');
      }
      if (value > unobserved) return std::nullopt;
      *field.second = static_cast<std::uint32_t>(value); input.remove_prefix(size);
    }
    if (!input.empty() || result.code > 11) return std::nullopt;
    return result;
  } catch (...) { return std::nullopt; }
}
class Lines {
 public:
  void append(std::span<const char> bytes) noexcept {
    try { for (const char byte : bytes) {
      if (byte == '\n') {
        if (!discarding_ && records_.size() < 4)
          if (const auto value = parse(partial_ + '\n')) records_.push_back(*value);
        partial_.clear(); discarding_ = false;
      } else if (!discarding_) {
        if (partial_.size() >= 255) { partial_.clear(); discarding_ = true; }
        else partial_ += byte;
      }
    } } catch (...) { partial_.clear(); discarding_ = true; }
  }
  std::optional<Record> latest() const { return records_.empty() ? std::nullopt : std::optional<Record>(records_.back()); }
  std::size_t size() const noexcept { return records_.size(); }
 private:
  std::string partial_; std::vector<Record> records_; bool discarding_ = false;
};
inline void emit(const Record& value) noexcept {
#if defined(_WIN32) && defined(MUSICMUTE_DEVELOPMENT_TEST_PACKAGE)
  static std::atomic<unsigned> count{0};
  auto observed = count.load();
  do { if (observed >= 4) return; } while (!count.compare_exchange_weak(observed, observed + 1));
  try {
    const auto bytes = line(value); const auto handle = GetStdHandle(STD_ERROR_HANDLE);
    if (!handle || handle == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0; (void)WriteFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &wrote, nullptr);
  } catch (...) { /* Observations cannot change a security decision. */ }
#else
  (void)value;
#endif
}
inline void emit(Phase phase, std::uint32_t win32, std::uint32_t code = 0) noexcept {
  Record value; value.phase = phase; value.win32 = win32; value.code = code; emit(value);
}
} // namespace mmstorediagnostic
