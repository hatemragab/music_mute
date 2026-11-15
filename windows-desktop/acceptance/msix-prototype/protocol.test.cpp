#include "protocol.hpp"
#include <iostream>
#include <sstream>

int main(int argc, char**) {
  if (argc != 1) return 2;
  try {
    const auto hello = msixqa::reply(R"({"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"HELLO","payload":{}})", mm::Json::Object{{"signature_kind", 0}});
    msixqa::require(!std::get<bool>(hello.at("payload").at("ready").value));
    msixqa::require(hello.at("payload").at("observation").at("signature_kind").integer() == 0);
    const auto echo = msixqa::reply(R"({"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"ECHO","payload":{"text":"مرحبا 🎵"}})", nullptr);
    msixqa::require(echo.at("payload").at("text").string() == "مرحبا 🎵");
    for (const auto size : {2U, 65536U}) msixqa::require(msixqa::frameSize(msixqa::frameHeader(size)) == size);
    for (const auto size : {0U, 1U, 65537U, 0xffffffffU}) {
      bool denied = false; try { (void)msixqa::frameHeader(size); } catch (...) { denied = true; } msixqa::require(denied);
    }
    for (const auto* invalid : {
      R"({"protocol_version":1,"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"HELLO","payload":{}})",
      R"({"protocol_version":1,"request_id":"bad","type":"HELLO","payload":{}})",
      R"({"protocol_version":2,"request_id":"00000000-0000-0000-0000-000000000001","type":"HELLO","payload":{}})",
      R"({"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"SHELL","payload":{}})",
      R"({"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"HELLO","payload":{"path":"C:\\private"}})",
      R"({"protocol_version":1,"request_id":"00000000-0000-0000-0000-000000000001","type":"ECHO","payload":{"text":"\ud800"}})"
    }) {
      bool denied = false; try { (void)msixqa::reply(invalid, nullptr); } catch (...) { denied = true; } msixqa::require(denied);
    }
    for (int kind = 0; kind <= 4; ++kind) msixqa::require(msixqa::productionStoreOriginAllowed(kind) == (kind == 3));
    std::cout << "MSIX_QA_PROTOCOL_PASS\n";
    return 0;
  } catch (...) { std::cerr << "MSIX_QA_PROTOCOL_FAILED\n"; return 2; }
}
