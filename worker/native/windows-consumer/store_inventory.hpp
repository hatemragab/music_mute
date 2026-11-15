#pragma once
#include "json.hpp"
#include "store_authority.hpp"
#include <algorithm>
#include <cwctype>
#include <set>

namespace mmstoreinventory {
inline void exact(const mm::Json& row, std::initializer_list<const char*> names) {
  mmstore::require(row.object().size() == names.size(), mmstore::ErrorCode::invalidInput);
  for (const auto* name : names) mmstore::require(row.object().contains(name), mmstore::ErrorCode::invalidInput);
}
inline std::wstring pathText(const std::string& path) {
  // Inventory paths are emitted as ASCII by the audited consumer packager.
  // Restrict authority to those canonical names, rather than disagreeing about
  // Unicode case folding at the Windows executable boundary.
  mmstore::require(!path.empty() && path.size() <= 1024 &&
    std::all_of(path.begin(), path.end(), [](unsigned char value) { return value >= 32 && value < 127; }), mmstore::ErrorCode::invalidInput);
  const std::wstring result(path.begin(), path.end());
  mmstore::require(mmstore::validRelativePath(result), mmstore::ErrorCode::invalidInput); return result;
}
struct Entry { std::wstring path; mmstore::FilePin pin; };
struct Inventory { mmstore::PackageKind kind; std::wstring packageVersion; std::vector<Entry> entries; };
inline Inventory parse(mmstore::PackageKind kind, const mm::Json& value) {
  using namespace mmstore;
  exact(value, {"version", "role", "packageVersion", "protocolAbi", "appVersion", "buildNumber", "entries"});
  const bool gui = kind == PackageKind::gui;
  mmstore::require(value.at("version").integer() == 1 && value.at("protocolAbi").integer() == 1 &&
    value.at("role").string() == (gui ? "gui" : "worker") &&
    value.at("appVersion").string() == (gui ? "0.1.0" : "0.1.3") &&
    value.at("buildNumber").integer() >= 1 && value.at("buildNumber").integer() <= 2147483647,
    ErrorCode::invalidInput);
  const auto packageText = value.at("packageVersion").string();
  const std::wstring version(packageText.begin(), packageText.end());
  const auto parsed = parseVersion(version);
  require(parsed == (gui ? PackageVersion{0, 1, 0, 0} : PackageVersion{0, 1, 3, 0}), ErrorCode::invalidInput);
  const auto& rows = value.at("entries").array();
  require(!rows.empty() && rows.size() <= 65536, ErrorCode::invalidInput);
  std::set<std::wstring> paths; std::string previous; Inventory result{kind, version, {}};
  for (const auto& row : rows) {
    exact(row, {"path", "bytes", "sha256"}); const auto& text = row.at("path").string();
    const auto path = pathText(text);
    require(path.starts_with(gui ? L"app/" : L"worker/") && (previous.empty() || previous < text), ErrorCode::invalidInput);
    auto folded = path; std::transform(folded.begin(), folded.end(), folded.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
    require(paths.insert(folded).second, ErrorCode::invalidInput);
    const auto bytes = row.at("bytes").integer(); require(bytes >= 0, ErrorCode::invalidInput);
    FilePin pin{row.at("sha256").string(), static_cast<std::uint64_t>(bytes)}; validateInventoryPin(pin);
    result.entries.push_back({path, std::move(pin)}); previous = text;
  }
  return result;
}
inline const mmstore::FilePin& codePin(const Inventory& inventory, mmstore::CodeRole role) {
  const auto code = mmstore::codeSpec(role);
  mmstore::require(code.kind == inventory.kind, mmstore::ErrorCode::invalidInput);
  const auto found = std::find_if(inventory.entries.begin(), inventory.entries.end(), [&](const Entry& entry) { return entry.path == code.relativePath; });
  mmstore::require(found != inventory.entries.end(), mmstore::ErrorCode::fileDenied);
  mmstore::validatePin(found->pin); return found->pin;
}
inline bool samePin(const mmstore::FilePin& a, const mmstore::FilePin& b) { return a.bytes == b.bytes && a.sha256 == b.sha256; }
} // namespace mmstoreinventory
