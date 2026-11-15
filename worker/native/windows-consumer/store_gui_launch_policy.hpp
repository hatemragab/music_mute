#pragma once
#include "store_authority.hpp"
#include <span>

namespace mmstoreguilaunch {
// A package observation selects a fixed authority, never a path or a role
// supplied by activation arguments. Unknown package identities cannot reach
// the legacy launcher even when they contain the same executable filename.
inline mmstore::PackageKind packageKind(std::wstring_view fullName) {
  for (const auto kind : {mmstore::PackageKind::gui, mmstore::PackageKind::worker}) {
    const auto& expected = mmstore::expectedPackage(kind);
    const auto prefix = std::wstring(expected.identityName) + L"_";
    const auto suffix = L"_x64__" + std::wstring(expected.publisherId);
    if (!fullName.starts_with(prefix) || !fullName.ends_with(suffix) ||
        fullName.size() <= prefix.size() + suffix.size()) continue;
    try {
      const auto version = fullName.substr(prefix.size(), fullName.size() - prefix.size() - suffix.size());
      if (mmstore::versionText(mmstore::parseVersion(version)) == version) return kind;
    } catch (const mmstore::Error&) {}
  }
  mmstore::fail(mmstore::ErrorCode::packageDenied);
}
inline unsigned hex(wchar_t value) {
  if (value >= L'0' && value <= L'9') return static_cast<unsigned>(value - L'0');
  if (value >= L'a' && value <= L'f') return static_cast<unsigned>(value - L'a' + 10);
  if (value >= L'A' && value <= L'F') return static_cast<unsigned>(value - L'A' + 10);
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline std::wstring queryValue(std::wstring_view raw) {
  std::wstring result;
  for (std::size_t n = 0; n < raw.size(); ++n) {
    auto value = raw[n];
    if (value == L'%') {
      mmstore::require(n + 2 < raw.size(), mmstore::ErrorCode::invalidInput);
      value = static_cast<wchar_t>(hex(raw[n + 1]) * 16U + hex(raw[n + 2])); n += 2;
    } else if (value == L'+') value = L' ';
    mmstore::require(value >= 32 && value < 127, mmstore::ErrorCode::invalidInput);
    result += value;
  }
  return result;
}
// Mirrors the public video identity/estimate contract in app-handoff.ts. Only
// canonical, token-free output reaches Electron; encoded known query names,
// ordering and the optional URL slash do not alter the accepted feature.
inline std::wstring publicActivation(std::wstring_view raw) {
  using mmstore::require; using mmstore::ErrorCode;
  require(!raw.empty() && raw.size() <= 2048, ErrorCode::invalidInput);
  while (!raw.empty() && raw.front() <= 32) raw.remove_prefix(1);
  while (!raw.empty() && raw.back() <= 32) raw.remove_suffix(1);
  std::wstring normalized;
  for (const auto value : raw) if (value != L'\t' && value != L'\r' && value != L'\n') normalized += value;
  constexpr std::wstring_view scheme = L"musicmute-local:";
  require(normalized.size() >= scheme.size(), ErrorCode::invalidInput);
  for (std::size_t n = 0; n < scheme.size(); ++n) {
    const auto value = normalized[n];
    require((value >= L'A' && value <= L'Z' ? static_cast<wchar_t>(value - L'A' + L'a') : value) == scheme[n], ErrorCode::invalidInput);
  }
  std::wstring_view rest(normalized); rest.remove_prefix(scheme.size());
  if (rest == L"//setup" || rest == L"//setup/") return L"musicmute-local://setup";
  constexpr std::wstring_view cloud = L"//cloud";
  require(rest.starts_with(cloud), ErrorCode::invalidInput); rest.remove_prefix(cloud.size());
  if (rest.starts_with(L'/')) rest.remove_prefix(1);
  require(rest.starts_with(L'?'), ErrorCode::invalidInput); rest.remove_prefix(1);
  std::wstring video, duration;
  bool seenVideo = false, seenDuration = false;
  while (!rest.empty()) {
    const auto amp = rest.find(L'&');
    const auto pair = rest.substr(0, amp);
    if (amp == std::wstring_view::npos) rest = {}; else rest.remove_prefix(amp + 1);
    if (pair.empty()) continue;
    const auto equal = pair.find(L'=');
    require(equal != std::wstring_view::npos, ErrorCode::invalidInput);
    const auto name = queryValue(pair.substr(0, equal)), value = queryValue(pair.substr(equal + 1));
    if (name == L"video_id") {
      require(!seenVideo && value.size() == 11 &&
        value.find_first_not_of(L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") == std::wstring::npos,
        ErrorCode::invalidInput);
      seenVideo = true; video = value;
    } else {
      require(name == L"duration_seconds" && !seenDuration && !value.empty() && value.size() <= 4 &&
        value.front() >= L'1' && value.front() <= L'9' && value.find_first_not_of(L"0123456789") == std::wstring::npos,
        ErrorCode::invalidInput);
      unsigned seconds = 0; for (const auto digit : value) seconds = seconds * 10U + static_cast<unsigned>(digit - L'0');
      require(seconds <= 1200, ErrorCode::invalidInput); seenDuration = true; duration = value;
    }
  }
  require(seenVideo, ErrorCode::invalidInput);
  return L"musicmute-local://cloud?video_id=" + video + (seenDuration ? L"&duration_seconds=" + duration : L"");
}
inline std::wstring activation(std::span<const std::wstring_view> arguments) {
  mmstore::require(arguments.size() <= 1, mmstore::ErrorCode::invalidInput);
  if (arguments.empty()) return {};
  if (arguments.front() == L"--headless-account") return L"--headless-account";
  return publicActivation(arguments.front());
}
} // namespace mmstoreguilaunch
