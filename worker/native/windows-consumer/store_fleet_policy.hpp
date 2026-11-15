#pragma once
#include "store_session_policy.hpp"
namespace mmstorerole {
// Worker/Python processing uses canonical standard-base64 SHA-256. Convert
// only that existing 32-byte wire digest for comparison with the held file's
// native lowercase-hex digest; this observation grants no file authority.
inline std::string fleetInputDigestHex(std::string_view value) {
  require(value.size() == 44 && value.back() == '=' && data_policy::base64(value,32,false),mmstore::ErrorCode::invalidInput);
  constexpr std::string_view alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  constexpr std::string_view hex="0123456789abcdef";
  std::string result; result.reserve(64);
  unsigned accumulator=0,bits=0;
  for(const auto character:value) {
    if(character=='=')break;
    const auto digit=alphabet.find(character);require(digit!=std::string_view::npos,mmstore::ErrorCode::invalidInput);
    accumulator=(accumulator<<6)|static_cast<unsigned>(digit);bits+=6;
    if(bits>=8){bits-=8;const auto byte=(accumulator>>bits)&255U;result.push_back(hex[byte>>4]);result.push_back(hex[byte&15U]);}
  }
  require(result.size()==64,mmstore::ErrorCode::invalidInput);return result;
}
inline bool fleetInputExtension(std::string_view value) noexcept {
  return value == "aac" || value == "flac" || value == "m4a" || value == "mp3" || value == "ogg" || value == "wav" || value == "webm" || value == "mp4" || value == "bin";
}
inline bool fleetAttemptExpectation(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value,{"version","distribution","kind","attemptId","token","inventorySha256","runtimeManifestSha256","nodeOwner","directoryBirth"}) ||
      value.at("version").integer() != 1 || value.at("distribution").string() != "microsoft-store" || value.at("kind").string() != "fleet-attempt" ||
      !data_policy::uuid(value.at("attemptId").string()) || !mmstore::validDigest(value.at("token").string()) || !mmstore::validDigest(value.at("inventorySha256").string()) ||
      !mmstore::validDigest(value.at("runtimeManifestSha256").string())) return false;
    const auto& owner = value.at("nodeOwner"); const auto& birth = value.at("directoryBirth");
    return data_policy::fields(owner,{"role","nonce","identity"}) && owner.at("role").string() == "fleet" && mmstore::validDigest(owner.at("nonce").string()) &&
      storeFleetIdentity(owner.at("identity")) && data_policy::fields(birth,{"device","file_id","born_at"}) &&
      data_policy::digits(birth.at("device").string(),10,true) && std::stoull(birth.at("device").string()) <= 0xffffffffULL && data_policy::digits(birth.at("file_id").string(),20) && birth.at("file_id").string() != "0" &&
      data_policy::digits(birth.at("born_at").string(),20,true);
  } catch (...) { return false; }
}
inline bool fleetWorkspaceOperation(Role role, std::string_view name, const mm::Json& args) noexcept {
  try {
    if (role != Role::fleet) return false;
    if (name == "fleet-workspace-open" || name == "fleet-workspace-recover") return data_policy::fields(args,{"attempt_id","extension"}) &&
      data_policy::uuid(args.at("attempt_id").string()) && fleetInputExtension(args.at("extension").string());
    return (name == "fleet-workspace-inspect" || name == "fleet-workspace-retire") && data_policy::fields(args,{"expectation"}) && fleetAttemptExpectation(args.at("expectation"));
  } catch (...) { return false; }
}
inline bool fleetTransferOperation(Role role, std::string_view name, const mm::Json& args) noexcept {
  try {
    if (role != Role::fleet) return false;
    if (name == "transfer-start" || (name == "transfer-stop" && args.object().contains("incarnation"))) {
      if (!data_policy::fields(args,{"incarnation","operation","attempt_id","relative_path","workspace_token"}) ||
        !data_policy::uuid(args.at("incarnation").string()) || !data_policy::uuid(args.at("attempt_id").string()) || !mmstore::validDigest(args.at("workspace_token").string())) return false;
      const auto prefix = "work\\" + args.at("attempt_id").string() + "\\", path = args.at("relative_path").string(), operation = args.at("operation").string();
      if (operation == "upload") return path == prefix + "output\\vocals.mp3";
      return operation == "download" && path.starts_with(prefix + "input.") && fleetInputExtension(path.substr(prefix.size()+6));
    }
    if (name == "transfer-write") return data_policy::fields(args,{"token","bytes_base64","end"}) && mmstore::validDigest(args.at("token").string()) &&
      data_policy::base64(args.at("bytes_base64").string(),24576,false) && std::holds_alternative<bool>(args.at("end").value);
    return (name == "transfer-read" || name == "transfer-stop" || name == "transfer-inspect") && data_policy::fields(args,{"token"}) && mmstore::validDigest(args.at("token").string());
  } catch (...) { return false; }
}
} // namespace mmstorerole
