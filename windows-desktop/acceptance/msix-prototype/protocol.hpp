#pragma once
#include "json.hpp"
#include <array>
#include <limits>

namespace msixqa {
inline void require(bool ok) { if (!ok) throw std::runtime_error("MSIX_QA_INVALID"); }
inline void exact(const mm::Json& row, std::initializer_list<const char*> keys) {
  require(row.object().size() == keys.size());
  for (const auto* key : keys) require(row.object().contains(key));
}
inline bool requestId(const std::string& id) {
  if (id.size() != 36) return false;
  for (std::size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
    else if (std::string("0123456789abcdefABCDEF").find(id[i]) == std::string::npos) return false;
  }
  return true;
}
inline mm::Json reply(const std::string& bytes, const mm::Json& observation) {
  const auto row = mm::JsonParser(bytes).parse();
  exact(row, {"protocol_version", "request_id", "type", "payload"});
  require(row.at("protocol_version").integer() == 1 && requestId(row.at("request_id").string()));
  const auto type = row.at("type").string();
  mm::Json payload;
  if (type == "HELLO") {
    exact(row.at("payload"), {});
    payload = mm::Json::Object{{"ready", false}, {"qa_only", true}, {"observation", observation}};
  } else if (type == "ECHO") {
    exact(row.at("payload"), {"text"});
    const auto text = row.at("payload").at("text").string();
    require(text.size() <= 4096);
    payload = mm::Json::Object{{"text", text}, {"qa_only", true}};
  } else throw std::runtime_error("MSIX_QA_INVALID");
  return mm::Json::Object{{"protocol_version", 1}, {"request_id", row.at("request_id")}, {"type", type}, {"payload", payload}};
}
inline std::array<unsigned char, 4> frameHeader(std::size_t size) {
  require(size >= 2 && size <= 65536);
  const auto n = static_cast<std::uint32_t>(size);
  return {static_cast<unsigned char>(n), static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16), static_cast<unsigned char>(n >> 24)};
}
inline std::uint32_t frameSize(const std::array<unsigned char, 4>& h) {
  const auto n = static_cast<std::uint32_t>(h[0]) | (static_cast<std::uint32_t>(h[1]) << 8) | (static_cast<std::uint32_t>(h[2]) << 16) | (static_cast<std::uint32_t>(h[3]) << 24);
  require(n >= 2 && n <= 65536); return n;
}
inline bool productionStoreOriginAllowed(int kind) { return kind == 3; }
}
