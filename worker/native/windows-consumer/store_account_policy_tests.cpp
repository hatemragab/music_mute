#define MUSICMUTE_STORE_ACCOUNT_POLICY_ONLY
#include "store_account.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_ACCOUNT_POLICY_FAILED"); }
void denied(const std::function<void()>& operation) { bool refused = false; try { operation(); } catch (const std::exception&) { refused = true; } check(refused); }
constexpr std::int64_t now = 1800000000000LL;
const std::string package = "27120VCHATSDK.MusicMute_0.1.0.2_x64__5q1esjnkz8cve";
mm::Json peer(int pid) { return mm::Json::Object{{"sid", "S-1-5-21-1-2-3-1001"}, {"session_id", 1}, {"pid", pid}, {"creation_time", "1337133713371337"}}; }
mm::Json ticket() { return mm::Json::Object{{"version", 2}, {"owner", peer(42)}, {"server", peer(43)}, {"gui", peer(41)}, {"instance_id", "a1234567-1234-4123-8123-123456789abc"}, {"channel", std::string(64, 'a')}, {"nonce", std::string(64, 'b')}, {"expires_at", now + 30000}, {"lease_nonce", std::string(64, 'c')}, {"package_full_name", package}}; }
}
int main() {
  try {
    using namespace mmstoreaccountpolicy;
    for (const auto* name : {"store_account_owner_bind", "store_account_ticket_publish", "store_account_ticket_read", "store_account_ticket_claim", "store_account_ticket_remove", "store_account_peer_verify", "store_account_same_gui", "store_account_launch", "store_account_pipe_accept", "store_account_pipe_connect", "store_account_pipe_reply", "store_account_pipe_close"}) check(operation(name));
    for (const auto* name : {"pipe_connect", "launch_account_authority", "store_account_execute", "store_account_registry", "STORE_ACCOUNT_LAUNCH", ""}) check(!operation(name));
    input("store_account_launch", mm::Json::Object{}, now); ++checks;
    denied([] { input("store_account_launch", mm::Json::Object{{"path", "C:/caller.exe"}}, now); });
    denied([] { input("store_account_launch", mm::Json::Object{{"allow_unsigned", true}}, now); });
    input("store_account_owner_bind", mm::Json::Object{{"nonce", std::string(64, 'a')}}, now); ++checks;
    for (const auto& value : {std::string{}, std::string(63, 'a'), std::string(64, 'A'), std::string(65, 'a')}) denied([&] { input("store_account_owner_bind", mm::Json::Object{{"nonce", value}}, now); });
    identity(peer(42)); ++checks;
    for (const auto& [name, value] : mm::Json::Object{{"pid", 0}, {"session_id", 0}, {"sid", "S-1-5-18"}, {"creation_time", "0001"}}) { auto row = peer(42).object(); row[name] = value; denied([&] { identity(row); }); }
    auto azure = peer(42).object(); azure["sid"] = "S-1-12-1-0-1-4294967295-1001"; identity(azure); ++checks;
    for (const auto* sid : {"S-1-5-21-1-2-3-4294967296", "S-1-5-21-1-2-3-01", "S-1-12-1-1-2-3", "S-1-5-21-1-2-3-1-extra"}) { auto row = peer(42).object(); row["sid"] = sid; denied([&] { identity(row); }); }
    ticket(ticket(), package, now); ++checks;
    for (const auto& [name, value] : mm::Json::Object{{"version", 1}, {"expires_at", now}, {"nonce", "claimed"}, {"instance_id", "a1234567-1234-1123-8123-123456789abc"}, {"package_full_name", "foreign"}}) { auto row = ticket().object(); row[name] = value; denied([&] { ticket(row, package, now); }); }
    auto row = ticket().object(); row["server"] = peer(42); denied([&] { ticket(row, package, now); });
    row = ticket().object(); auto foreign = peer(43).object(); foreign["session_id"] = 2; row["server"] = foreign; denied([&] { ticket(row, package, now); });
    row = ticket().object(); row["allow_unsigned"] = true; denied([&] { ticket(row, package, now); });
    expiry(now + 35000, now); ++checks; denied([] { expiry(now + 35001, now); });
    for (const auto& text : {std::string{}, std::string("AA=="), std::string("AAA="), std::string("AAAA")}) { base64(text, 4096); ++checks; }
    for (const auto* text : {"AB==", "AAB=", "AA=", "AA==extra", "AA__", "===="}) denied([&] { base64(text, 4096); });
    denied([] { base64(std::string(5464, 'A'), 4096); });
    input("store_account_pipe_accept", mm::Json::Object{{"channel", std::string(64, 'a')}, {"nonce", std::string(64, 'b')}, {"timeout_ms", 30000}}, now); ++checks;
    denied([] { input("store_account_pipe_accept", mm::Json::Object{{"channel", std::string(64, 'a')}, {"nonce", std::string(64, 'b')}, {"timeout_ms", 30001}}, now); });
    const auto challenge = std::string(64, 'd');
    const mm::Json reply = mm::Json::Object{{"version", 1}, {"confirmed", true}, {"challenge", challenge}, {"helper_pid", 42}, {"helper_creation_time", "1337133713371337"}, {"package_full_name", package}, {"browser_attachment", nullptr}, {"source_helper", nullptr}};
    creatorReply(reply, challenge, peer(42), package); ++checks;
    auto attachedReply = reply.object(); attachedReply["browser_attachment"] = mm::Json::Object{};
    attachedReply["source_helper"] = mm::Json::Object{{"pid", 43}, {"creation_time", "1337133713371337"}};
    creatorReply(attachedReply, challenge, peer(42), package); ++checks;
    auto nullSource = attachedReply; nullSource["source_helper"] = nullptr; denied([&] { creatorReply(nullSource, challenge, peer(42), package); });
    for (const auto& source : std::vector<mm::Json>{mm::Json::Object{}, mm::Json::Object{{"pid", 0}, {"creation_time", "1337133713371337"}},
        mm::Json::Object{{"pid", 2147483648LL}, {"creation_time", "1337133713371337"}}, mm::Json::Object{{"pid", 43}, {"creation_time", "01"}},
        mm::Json::Object{{"pid", 43}, {"creation_time", "1337133713371337"}, {"path", "caller"}}, mm::Json(true)}) {
      auto bad = attachedReply; bad["source_helper"] = source; denied([&] { creatorReply(bad, challenge, peer(42), package); });
    }
    auto unrelated = reply.object(); unrelated["source_helper"] = attachedReply.at("source_helper"); denied([&] { creatorReply(unrelated, challenge, peer(42), package); });

    for (const auto& [name, value] : mm::Json::Object{{"confirmed", false}, {"challenge", std::string(64, 'e')}, {"helper_pid", 43}, {"helper_creation_time", "1337133713371338"}, {"package_full_name", "foreign"}}) { auto changed = reply.object(); changed[name] = value; denied([&] { creatorReply(changed, challenge, peer(42), package); }); }
    const mm::Json browser = mm::Json::Object{{"version", 1}, {"accepted", true}, {"host", peer(40)}, {"gui", peer(41)}, {"chrome", peer(39)}, {"origin", std::string(browserOrigin)}, {"package_full_name", package}};
    attachment(browser, peer(41), package); ++checks;
    for (const auto& [name, value] : mm::Json::Object{{"origin", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"}, {"accepted", false}, {"package_full_name", "foreign"}, {"gui", peer(42)}, {"chrome", peer(40)}}) { auto changed = browser.object(); changed[name] = value; denied([&] { attachment(changed, peer(41), package); }); }
    // Actual shared strict parser execution, not source-string assertions.
    check(mm::JsonParser("{\"text\":\"مرحبا 🎵\"}").parse().at("text").string() == "مرحبا 🎵");
    denied([] { (void)mm::JsonParser("{\"version\":1,\"version\":2}").parse(); });
    std::cout << "STORE_ACCOUNT_POLICY_PASS checks=" << checks << '\n'; return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
