#pragma once
#include "store_session_policy.hpp"
namespace mmstorerole {
inline constexpr std::uint64_t qualificationFixtureBytes = 1058444;
inline constexpr std::string_view qualificationFixtureSha256 = "a5f1aef50cb2fa12d3b1bade177b94dc6b68ff1e2b46be61d3376c971af040f6";
inline bool qualificationOperation(Role actor, std::string_view operation, const mm::Json& args) noexcept {
  try {
    if (actor != Role::prepare) return false;
    if (operation == "qualification-start" || (operation == "qualification-stop" && args.object().contains("incarnation"))) return data_policy::fields(args, {"incarnation"}) && data_policy::uuid(args.at("incarnation").string());
    return (operation == "qualification-read" || operation == "qualification-stop") && data_policy::fields(args, {"token"}) && mmstore::validDigest(args.at("token").string());
  } catch (...) { return false; }
}
} // namespace mmstorerole
