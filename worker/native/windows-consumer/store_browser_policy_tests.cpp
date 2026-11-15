#define MUSICMUTE_STORE_BROWSER_POLICY_ONLY
#include "store_browser.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_BROWSER_POLICY_FAILED"); }
void denied(const std::function<void()>& operation) {
  bool refused = false; try { operation(); } catch (const std::exception&) { refused = true; } check(refused);
}
mm::Json manifest() {
  return mm::Json::Object{{"name", "com.musicmute.local"}, {"description", "MusicMute Windows companion"},
    {"path", "../../MusicMuteChromeHost.exe"}, {"type", "stdio"},
    {"allowed_origins", mm::Json::Array{mm::Json(std::string(mmstorebrowserpolicy::origin))}}};
}
}
int main() {
  try {
    using namespace mmstorebrowserpolicy;
    check(parseIntent(mm::Json::Object{{"intent", "inspect"}}) == Intent::inspect);
    check(parseIntent(mm::Json::Object{{"intent", "register"}}) == Intent::registration);
    check(parseIntent(mm::Json::Object{{"intent", "remove"}}) == Intent::removal);
    for (const auto* value : {"", "launch", "register-unsigned", "query", "REGISTER"})
      denied([&] { (void)parseIntent(mm::Json::Object{{"intent", value}}); });
    denied([] { (void)parseIntent(mm::Json::Object{{"intent", "register"}, {"path", "C:/caller.exe"}}); });
    denied([] { (void)parseIntent(mm::Json::Object{{"intent", "register"}, {"allowUnsigned", true}}); });
    validateManifest(manifest()); ++checks;
    for (const auto& [key, value] : mm::Json::Object{{"path", "C:/caller.exe"}, {"type", "shell"},
        {"name", "com.musicmute.other"}, {"description", "Other"}}) {
      auto fields = manifest().object(); fields[key] = value; denied([&] { validateManifest(fields); });
    }
    auto fields = manifest().object(); fields["allowed_origins"] = mm::Json::Array{mm::Json(std::string(origin)), mm::Json("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")};
    denied([&] { validateManifest(fields); }); fields = manifest().object(); fields["allowUnsigned"] = true; denied([&] { validateManifest(fields); });
    validateOrigin(origin); ++checks;
    for (const auto* value : {"", "chrome-extension://npkabaieihgikeiahjojlkjjakajjnpa/", "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep", "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/?x=1"}) denied([&] { validateOrigin(value); });
    check(parentWindow(L"") == 0); check(parentWindow(L"--parent-window=0") == 0);
    check(parentWindow(L"--parent-window=18446744073709551615") == UINT64_MAX);
    for (const auto* value : {L"--parent-window=", L"--parent-window=-1", L"--parent-window=1x", L"--parent-window=18446744073709551616", L"--origin=0"}) denied([&] { (void)parentWindow(value); });
    const mm::Json attach = mm::Json::Object{{"host_pid", 42}, {"nonce", std::string(64, 'a')}, {"origin", std::string(origin)}};
    validateAttachInput(attach); ++checks;
    for (const auto& [name, value] : mm::Json::Object{{"host_pid", 0}, {"nonce", std::string(64, 'A')}, {"origin", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"}}) {
      auto row = attach.object(); row[name] = value; denied([&] { validateAttachInput(row); });
    }
    auto extra = attach.object(); extra["package"] = "claimed-store"; denied([&] { validateAttachInput(extra); });
    const std::string path = "C:\\Program Files\\WindowsApps\\Package\\app\\resources\\native\\com.musicmute.local.json";
    check(ordinaryQueryMatches("\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.musicmute.local\r\n    (Default)    REG_SZ    " + path + "\r\n", path));
    check(ordinaryQueryMatches("    label\tREG_SZ\t" + path + "\n", path));
    for (const auto& text : {std::string{}, "REG_SZ " + path + "x", "REG_SZ " + path + "\nREG_SZ " + path,
        "REG_EXPAND_SZ " + path, "REG_SZevil " + path, std::string(16385, 'a')}) check(!ordinaryQueryMatches(text, path));
    check(!ordinaryQueryMatches("REG_SZ " + path, std::string("C:\\x\0hidden", 11)));
    // Execute the shared strict Unicode/duplicate JSON grammar used by the
    // attach exchange; neither parsed text nor a synthetic Store fixture grants authority.
    check(mm::JsonParser("{\"text\":\"مرحبا 🎵\"}").parse().at("text").string() == "مرحبا 🎵");
    for (const auto* text : {"{\"nonce\":\"a\",\"nonce\":\"b\"}", "{\"text\":\"\\ud800\"}"}) denied([&] { (void)mm::JsonParser(text).parse(); });
    auto badUtf8 = std::string("{\"text\":\"") + static_cast<char>(0xc0) + static_cast<char>(0x80) + "\"}";
    denied([&] { (void)mm::JsonParser(badUtf8).parse(); });
    std::cout << "STORE_BROWSER_POLICY_PASS checks=" << checks << "\n"; return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
