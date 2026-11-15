#include "store_controls_policy.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_CONTROLS_TEST_FAILED"); }
void denied(const std::function<void()>& action) {
  bool rejected = false; try { action(); } catch (const std::exception&) { rejected = true; }
  check(rejected);
}
mmstore::Observation observation() {
  const auto& expected = mmstore::expectedPackage(mmstore::PackageKind::worker);
  return {std::wstring(expected.identityName), std::wstring(expected.publisher), std::wstring(expected.publisherId),
    std::wstring(expected.familyName), std::wstring(expected.identityName) + L"_0.1.3.7_x64__" + std::wstring(expected.publisherId),
    L"0.1.3.7", L"x64", L"C:\\Program Files\\WindowsApps\\MusicMuteWorker", mmstoreprofile::signatureKind, true, true};
}
mm::Json boot() {
  using mmstorecontrols::ascii;
  const auto expected = observation();
  return mm::Json::Object{{"version", 1}, {"logon_sid", "S-1-5-5-100-200"},
    {"parent", mm::Json::Object{{"sid", "S-1-5-21-1-2-3-1001"}, {"session_id", 1}, {"pid", 100}, {"creation_time", "133000000000000001"}}},
    {"helper", mm::Json::Object{{"sid", "S-1-5-21-1-2-3-1001"}, {"session_id", 1}, {"pid", 101}, {"creation_time", "133000000000000002"}}},
    {"package", mm::Json::Object{{"identityName", ascii(expected.identityName)}, {"publisher", ascii(expected.publisher)},
      {"publisherId", ascii(expected.publisherId)}, {"familyName", ascii(expected.familyName)}, {"fullName", ascii(expected.fullName)},
      {"packageVersion", ascii(expected.packageVersion)}, {"architecture", "x64"}, {"signatureKind", static_cast<std::int64_t>(mmstoreprofile::signatureKind)}, {"healthy", true},
      {"current", true}, {"installedLocation", ascii(expected.installedLocation)}}}};
}
void receiving() {
  using namespace mmstorecontrols;
  const WireProcess parent{"S-1-5-21-1-2-3-1001", "133000000000000001", 1, 100};
  const WireProcess helper{"S-1-5-21-1-2-3-1001", "133000000000000002", 1, 101};
  const auto verify = [&](const mm::Json& value) { boot(value, observation(), parent, helper, "S-1-5-5-100-200"); };
  verify(::boot()); ++checks;
  // Every claimed origin field must match the held actual package observation.
  for (const auto* name : {"identityName", "publisher", "publisherId", "familyName", "fullName", "packageVersion", "architecture", "installedLocation"}) {
    auto row = ::boot().object(); auto package = row.at("package").object(); package[name] = "forged"; row["package"] = package;
    denied([&] { verify(row); });
    row = ::boot().object(); package = row.at("package").object(); package.erase(name); row["package"] = package;
    denied([&] { verify(row); });
  }
  for (const auto* name : {"healthy", "current"}) {
    auto row = ::boot().object(); auto package = row.at("package").object(); package[name] = false; row["package"] = package;
    denied([&] { verify(row); });
  }
  for (const auto kind : {0, 1, 2, 3, 4, -1}) {
    if (kind == static_cast<int>(mmstoreprofile::signatureKind)) continue;
    auto row = ::boot().object(); auto package = row.at("package").object(); package["signatureKind"] = kind; row["package"] = package;
    denied([&] { verify(row); });
  }
  for (const auto* role : {"parent", "helper"}) {
    for (const auto* name : {"sid", "creation_time"}) {
      auto row = ::boot().object(); auto identity = row.at(role).object(); identity[name] = "forged"; row[role] = identity;
      denied([&] { verify(row); });
    }
    for (const auto* name : {"pid", "session_id"}) {
      for (const auto value : {0, -1, 999}) {
        auto row = ::boot().object(); auto identity = row.at(role).object(); identity[name] = value; row[role] = identity;
        denied([&] { verify(row); });
      }
    }
    auto row = ::boot().object(); auto identity = row.at(role).object(); identity["role"] = "worker-controls"; row[role] = identity;
    denied([&] { verify(row); });
  }
  auto row = ::boot().object(); row["logon_sid"] = "S-1-5-5-100-201"; denied([&] { verify(row); });
  row = ::boot().object(); row["version"] = 2; denied([&] { verify(row); });
  row = ::boot().object(); row["ready"] = true; denied([&] { verify(row); });
  auto copied = observation(); copied.signatureKind = 0;
  denied([&] { boot(::boot(), copied, parent, helper, "S-1-5-5-100-200"); });
  copied = observation(); copied.current = false;
  denied([&] { boot(::boot(), copied, parent, helper, "S-1-5-5-100-200"); });
  denied([&] { boot(::boot(), observation(), parent, parent, "S-1-5-5-100-200"); });
  denied([&] { boot(::boot(), observation(), parent, helper, ""); });
  check(ascii(L"safe-path") == "safe-path");
  denied([] { (void)ascii(L"bad\npath"); }); denied([] { (void)ascii(L"\u0601"); });
}
void envelopesAndFrames() {
  using namespace mmstorecontrols;
  const mm::Json good = mm::Json::Object{{"version", 1}, {"id", 1}, {"ok", true}, {"result", mm::Json::Object{{"value", 1}}}};
  check(response(good, 1).at("value").integer() == 1);
  denied([&] { (void)response(good, 2); }); denied([&] { (void)response(good, 0); });
  auto row = good.object(); row["other"] = true; denied([&] { (void)response(row, 1); });
  row = good.object(); row["version"] = 2; denied([&] { (void)response(row, 1); });
  row = good.object(); row["ok"] = "true"; denied([&] { (void)response(row, 1); });
  row = good.object(); row["result"] = mm::Json::Array{}; denied([&] { (void)response(row, 1); });
  for (const auto* error : {"PEER_DENIED", "UNKNOWN_ERROR", "private C:/song", "", "lowercase"}) {
    const mm::Json failure = mm::Json::Object{{"version", 1}, {"id", 1}, {"ok", false}, {"error", mm::Json::Object{{"code", error}}}};
    denied([&] { (void)response(failure, 1); });
  }
  const auto frame = mm::dump(good) + '\n';
  for (std::size_t split = 0; split <= frame.size(); ++split) {
    Frames frames; frames.append(std::span<const char>(frame.data(), split));
    frames.append(std::span<const char>(frame.data() + split, frame.size() - split));
    auto value = frames.take(); check(value && response(*value, 1).at("value").integer() == 1 && !frames.pending() && !frames.take());
  }
  Frames partial; const std::string half = "{\"version\":1";
  partial.append(half); check(partial.pending() && !partial.take());
  denied([] { Frames frames; frames.append(std::string(65537, 'x')); });
  denied([] { Frames frames; frames.append(std::string("\n")); });
  denied([] { Frames frames; frames.append(std::string("{\"version\":1,\"version\":1}\n")); (void)frames.take(); });
  denied([] { Frames frames; frames.append(std::string("{\"x\":\"\xc0\xaf\"}\n")); (void)frames.take(); });
  denied([] { Frames frames; std::string bytes; for (int n = 0; n < 17; ++n) bytes += "{}\n"; frames.append(bytes); });
  std::int64_t sequence = 0;
  const auto event = [](const char* name, int number) -> mm::Json { return mm::Json::Object{{"version", 1},
    {"event", mm::Json::Object{{"kind", "session"}, {"event", name}, {"sequence", number}}}}; };
  check(sessionEvent(event("network", 1), sequence) && sequence == 1);
  check(!sessionEvent(good, sequence));
  denied([&] { (void)sessionEvent(event("network", 1), sequence); });
  for (const auto* name : {"ending", "ending_requested", "lock", "unlock", "suspend", "resume", "unknown"}) {
    std::int64_t previous = 0; denied([&] { (void)sessionEvent(event(name, 1), previous); });
  }
}
void startupPolicy() {
  using namespace mmstorecontrols; using namespace mmstorestartup;
  const auto reply = [](State before, State after, const char* action) -> mm::Json {
    return mm::Json::Object{{"before", std::string(stateName(before))}, {"after", std::string(stateName(after))}, {"action", action}};
  };
  const std::array states{State::disabled, State::disabledByUser, State::enabled, State::disabledByPolicy, State::enabledByPolicy};
  for (const auto current : states) {
    check(enableAvailable(current) == (current == State::disabled)); check(disableAvailable(current) == (current == State::enabled));
    for (const auto next : states) {
      check(startup(reply(current, next, "none"), Intent::inspect).after == next);
      check(startup(reply(current, next, "none"), Intent::requestEnable).action == Action::none);
      check(startup(reply(current, next, "none"), Intent::disable).action == Action::none);
      if (current == State::disabled) check(startup(reply(current, next, "request-enable"), Intent::requestEnable).after == next);
      else denied([&] { (void)startup(reply(current, next, "request-enable"), Intent::requestEnable); });
      if (current == State::enabled) check(startup(reply(current, next, "disable"), Intent::disable).after == next);
      else denied([&] { (void)startup(reply(current, next, "disable"), Intent::disable); });
    }
  }
  for (const auto intent : {Intent::inspect, Intent::requestEnable}) denied([&] { (void)startup(reply(State::enabled, State::disabled, "disable"), intent); });
  for (const auto intent : {Intent::inspect, Intent::disable}) denied([&] { (void)startup(reply(State::disabled, State::enabled, "request-enable"), intent); });
  for (const auto* name : {"enable", "force-enable", "", "NONE", "request-enable "}) {
    denied([&] { (void)startup(reply(State::disabled, State::enabled, name), Intent::requestEnable); });
  }
  auto row = reply(State::disabled, State::enabled, "none").object(); row["ready"] = true;
  denied([&] { (void)startup(row, Intent::inspect); });
  denied([&] { (void)startup(reply(State::disabled, State::enabled, "none"), static_cast<Intent>(999)); });
  denied([] { (void)enableAvailable(static_cast<State>(999)); });
  denied([] { (void)disableAvailable(static_cast<State>(999)); });
}
void windowSizing() {
  using mmstorecontrols::clientSize;
  struct Expected { std::uint32_t dpi; int width, height, minimumWidth, minimumHeight; };
  for (const auto expected : std::array<Expected, 4>{{
      {96, 740, 370, 650, 350}, {120, 925, 463, 813, 438},
      {144, 1110, 555, 975, 525}, {192, 1480, 740, 1300, 700}}}) {
    const auto initial = clientSize(expected.dpi, false), minimum = clientSize(expected.dpi, true);
    check(initial.width == expected.width && initial.height == expected.height);
    check(minimum.width == expected.minimumWidth && minimum.height == expected.minimumHeight);
    check(initial.width >= minimum.width && initial.height >= minimum.height);
    // The fixed button floor ends at 256 logical pixels; minimum client space must
    // retain it at every tested DPI, independent of the Windows frame size.
    check(minimum.height > static_cast<int>((256ULL * expected.dpi + 48ULL) / 96ULL));
  }
  for (const auto minimum : {false, true}) {
    denied([&] { (void)clientSize(0, minimum); });
    denied([&] { (void)clientSize(UINT32_MAX, minimum); });
  }
}
} // namespace
int main(int argc, char**) {
  if (argc != 1) return 2;
  try { receiving(); envelopesAndFrames(); startupPolicy(); windowSizing(); std::cout << "Store controls policy checks: " << checks << '\n'; return 0; }
  catch (...) { std::cerr << "STORE_CONTROLS_TEST_FAILED\n"; return 1; }
}
