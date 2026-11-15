#include "store_inventory.hpp"
#include <functional>
#include <iostream>
namespace {
unsigned checks = 0;
void require(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_INVENTORY_TEST_FAILED"); }
void rejects(const std::function<void()>& call) { bool denied = false; try { call(); } catch (const std::exception&) { denied = true; } require(denied); }
mm::Json fixture() {
  const std::string hash(64, 'a');
  return mm::Json::Object{{"version", 1}, {"role", "gui"}, {"packageVersion", "0.1.0.0"},
    {"protocolAbi", 1}, {"appVersion", "0.1.0"}, {"buildNumber", 1},
    {"entries", mm::Json::Array{
      mm::Json::Object{{"path", "app/MusicMute Local.exe"}, {"bytes", 100}, {"sha256", hash}},
      mm::Json::Object{{"path", "app/resources/native/musicmute-native.exe"}, {"bytes", 100}, {"sha256", hash}}}}};
}
}
int main() {
  try {
    using namespace mmstoreinventory;
    const auto serialized = mm::dump(fixture());
    const auto good = parse(mmstore::PackageKind::gui, mm::JsonParser::storeCodeInventory(serialized));
    require(good.entries.size() == 2 && codePin(good, mmstore::CodeRole::guiApplication).bytes == 100);
    require(codePin(good, mmstore::CodeRole::guiNative).sha256 == std::string(64, 'a'));
    auto emptyRow = std::get<mm::Json::Object>(fixture().value);
    emptyRow["entries"] = mm::Json::Array{mm::Json::Object{{"path", "app/resources/empty.txt"}, {"bytes", 0}, {"sha256", std::string(mmstore::emptySha256)}}};
    require(parse(mmstore::PackageKind::gui, emptyRow).entries.front().pin.bytes == 0);
    emptyRow["entries"] = mm::Json::Array{mm::Json::Object{{"path", "app/MusicMute Local.exe"}, {"bytes", 0}, {"sha256", std::string(mmstore::emptySha256)}}};
    const auto emptyRole = parse(mmstore::PackageKind::gui, emptyRow);
    rejects([&] { (void)codePin(emptyRole, mmstore::CodeRole::guiApplication); });
    emptyRow["entries"] = mm::Json::Array{mm::Json::Object{{"path", "app/resources/empty.txt"}, {"bytes", 0}, {"sha256", std::string(64, 'a')}}};
    rejects([&] { (void)parse(mmstore::PackageKind::gui, emptyRow); });
    rejects([&] { (void)codePin(good, mmstore::CodeRole::workerNode); });
    rejects([&] { (void)codePin(good, mmstore::CodeRole::guiChromeHost); });
    rejects([&] { (void)parse(mmstore::PackageKind::worker, fixture()); });
    for (const auto* key : {"version", "protocolAbi", "buildNumber"}) {
      auto row = std::get<mm::Json::Object>(fixture().value); row[key] = 0;
      rejects([&] { (void)parse(mmstore::PackageKind::gui, row); });
    }
    for (const auto* path : {"../outside.exe", "worker/runtime/node/node.exe", "app/resources//helper.exe", "app/resources/CON.exe", "app/x:stream", "app/../copy.exe"}) {
      auto row = std::get<mm::Json::Object>(fixture().value);
      row["entries"] = mm::Json::Array{mm::Json::Object{{"path", path}, {"bytes", 10}, {"sha256", std::string(64, 'a')}}};
      rejects([&] { (void)parse(mmstore::PackageKind::gui, row); });
    }
    auto row = std::get<mm::Json::Object>(fixture().value);
    row["entries"] = mm::Json::Array{fixture().at("entries").array()[0], fixture().at("entries").array()[0]};
    rejects([&] { (void)parse(mmstore::PackageKind::gui, row); });
    row = std::get<mm::Json::Object>(fixture().value); row["packageVersion"] = "0.1.0.1";
    rejects([&] { (void)parse(mmstore::PackageKind::gui, row); });
    row = std::get<mm::Json::Object>(fixture().value); row["allowUnsigned"] = true;
    rejects([&] { (void)parse(mmstore::PackageKind::gui, row); });
    rejects([&] { (void)mm::JsonParser::storeCodeInventory("{\"version\":1,\"version\":1}"); });
    rejects([&] { (void)mm::JsonParser::storeCodeInventory(std::string(8 * 1024 * 1024 + 1, ' ')); });
    std::cout << "Store inventory receiving checks passed: " << checks << '\n'; return 0;
  } catch (...) { std::cerr << "STORE_INVENTORY_TEST_FAILED\n"; return 1; }
}
