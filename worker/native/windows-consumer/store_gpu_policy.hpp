#pragma once
#include "store_data_policy.hpp"

namespace mmstorerole {
inline bool gpuLeaseRole(Role role) noexcept { return role == Role::personal || role == Role::fleet || role == Role::prepare; }
inline bool validGpuLuid(std::string_view text) noexcept { return text.size() == 16 && text.find_first_not_of("0123456789abcdef") == std::string_view::npos; }
inline bool storeGpuIdentity(const mm::Json& value) noexcept {
  try {
    if (!data_policy::fields(value, {"source", "deviceIndex", "name", "vendorId", "deviceId", "subsystemId", "revision", "driverVersion", "luid", "dedicatedVideoMemoryBytes", "sharedSystemMemoryLimitBytes"}) ||
        value.at("source").string() != "DXGI EnumAdapters1/GetDesc1" || !validGpuLuid(value.at("luid").string())) return false;
    const auto ordinal = value.at("deviceIndex").integer(); if (ordinal < 0 || ordinal > 15) return false;
    for (const auto key : {"vendorId", "deviceId", "subsystemId", "revision"}) { const auto number = value.at(key).integer(); if (number < (std::string_view(key) == "vendorId" ? 1 : 0) || number > 0xffffffffLL) return false; }
    for (const auto key : {"dedicatedVideoMemoryBytes", "sharedSystemMemoryLimitBytes"}) { const auto number = value.at(key).integer(); if (number < 0 || number > 9007199254740991LL) return false; }
    const auto& name = value.at("name").string(); if (name.empty() || name.size() > 512 || name.find_first_of("\r\n\t") != std::string::npos) return false;
    for (const auto character : name) if (static_cast<unsigned char>(character) < 32 || static_cast<unsigned char>(character) == 127) return false;
    const auto& driver = value.at("driverVersion").string(); std::size_t at = 0;
    for (unsigned field = 0; field < 4; ++field) {
      const auto end = driver.find('.', at); const auto part = std::string_view(driver).substr(at, end == std::string::npos ? driver.size() - at : end - at);
      if (part.empty() || part.size() > 5 || part.find_first_not_of("0123456789") != std::string_view::npos) return false;
      unsigned number = 0; for (const auto c : part) number = number * 10 + static_cast<unsigned>(c - '0'); if (number > 65535) return false;
      if (field == 3) return end == std::string::npos;
      if (end == std::string::npos) return false; at = end + 1;
    }
    return false;
  } catch (...) { return false; }
}
inline bool storeGpuAcquire(Role role, const mm::Json& args) noexcept {
  try { return gpuLeaseRole(role) && data_policy::fields(args, {"gpu"}) && storeGpuIdentity(args.at("gpu")); } catch (...) { return false; }
}
inline bool storeGpuCapability(Role role, const mm::Json& args) noexcept {
  try { return gpuLeaseRole(role) && data_policy::fields(args, {"luid", "nonce"}) && validGpuLuid(args.at("luid").string()) && mmstore::validDigest(args.at("nonce").string()); } catch (...) { return false; }
}
} // namespace mmstorerole
