#pragma once
#include "json.hpp"
#include "store_authority.hpp"
#include "store_inventory.hpp"
#include <cstdint>
#include <string_view>

// Receiving policy only. These exact observations do not grant package,
// process, browser, or creator authority; callers must retain and re-attest
// the actual OS peers and private creator relationship independently.
namespace mmstorebrowserattachment {
inline constexpr std::string_view browserOrigin = "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/";
inline void need(bool result) { mmstore::require(result, mmstore::ErrorCode::invalidInput); }
inline std::uint64_t decimal(std::string_view value, std::uint64_t maximum) {
  need(!value.empty() && value.size() <= 20 && value.front() != '0');
  std::uint64_t result = 0;
  for (const auto c : value) { need(c >= '0' && c <= '9'); const auto digit = static_cast<unsigned>(c - '0'); need(result <= (maximum - digit) / 10); result = result * 10 + digit; }
  need(result > 0 && result <= maximum); return result;
}
inline void identity(const mm::Json& value) {
  mmstoreinventory::exact(value, {"sid", "session_id", "pid", "creation_time"});
  need(value.at("pid").integer() >= 1 && value.at("pid").integer() <= 2147483647 && value.at("session_id").integer() >= 1 && value.at("session_id").integer() <= 0xffffffffLL);
  const auto& birth = value.at("creation_time").string(); need(birth.size() >= 2); (void)decimal(birth, UINT64_MAX);
  const auto& sid = value.at("sid").string();
  const auto prefix = sid.starts_with("S-1-5-21-") ? std::string_view("S-1-5-21-") : std::string_view("S-1-12-1-");
  need(sid.starts_with(prefix) && sid.size() <= 184); std::size_t at = prefix.size();
  for (unsigned part = 0; part < 4; ++part) {
    const auto end = sid.find('-', at); need(part == 3 ? end == std::string::npos : end != std::string::npos);
    const auto component = std::string_view(sid).substr(at, end == std::string::npos ? sid.size() - at : end - at);
    if (component != "0") (void)decimal(component, 0xffffffffULL);
    at = end == std::string::npos ? sid.size() : end + 1;
  }
}
inline void attachment(const mm::Json& value, const mm::Json& gui, std::string_view package) {
  mmstoreinventory::exact(value, {"version", "accepted", "host", "gui", "chrome", "origin", "package_full_name"});
  need(value.at("version").integer() == 1 && std::get<bool>(value.at("accepted").value) && value.at("origin").string() == browserOrigin && value.at("package_full_name").string() == package && mm::dump(value.at("gui")) == mm::dump(gui));
  for (const auto* name : {"host", "gui", "chrome"}) identity(value.at(name));
  need(value.at("host").at("pid").integer() != value.at("chrome").at("pid").integer());
  for (const auto* name : {"host", "chrome"}) { const auto& peer = value.at(name); need(peer.at("sid").string() == gui.at("sid").string() && peer.at("session_id").integer() == gui.at("session_id").integer() && peer.at("pid").integer() != gui.at("pid").integer()); }
}
} // namespace mmstorebrowserattachment
