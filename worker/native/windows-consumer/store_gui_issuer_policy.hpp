#pragma once
#include "json.hpp"
#include "store_authority.hpp"

namespace mmstoreguiissuer {
// Receiving validation alone is not authority. Production also checks the
// actual live GUI pipe server and the GUI's one-use spawned-child table.
inline void validateReply(const mm::Json& reply, std::string_view nonce,
    std::uint32_t helperPid, std::string_view helperBirth) {
  using mmstore::require;
  constexpr auto denied = mmstore::ErrorCode::processDenied;
  try {
    require(mmstore::validDigest(nonce) && helperPid > 0 && helperPid <= 2147483647U && !helperBirth.empty(), denied);
    const auto& fields = reply.object();
    require(fields.size() == 5 && fields.contains("version") && fields.contains("accepted") &&
      fields.contains("nonce") && fields.contains("pid") && fields.contains("creation_time"), denied);
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) &&
      reply.at("nonce").string() == nonce && reply.at("pid").integer() == static_cast<std::int64_t>(helperPid) &&
      reply.at("creation_time").string() == helperBirth, denied);
  } catch (const mmstore::Error&) { throw; }
  catch (const std::exception&) { mmstore::fail(denied); }
}
}
