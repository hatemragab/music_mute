#define MUSICMUTE_STORE_SESSION_CLIENT_POLICY_ONLY
#include "store_session_client.hpp"
#include <functional>
#include <iostream>

namespace {
using mm::Json;
unsigned checks = 0;
constexpr auto requestId = "11111111-2222-4333-8444-555555555555";
constexpr auto otherRequestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const std::string digest(64, 'a');

void check(bool value) {
  ++checks;
  if (!value) throw std::runtime_error("STORE_SESSION_CLIENT_POLICY_FAILED_" + std::to_string(checks));
}
void denied(const std::function<void()>& operation, mmstore::ErrorCode expected) {
  bool rejected = false;
  try { operation(); }
  catch (const mmstore::Error& error) { rejected = error.code() == expected; }
  check(rejected);
}
Json replace(Json value, std::initializer_list<const char*> path, Json replacement) {
  auto* cursor = &value;
  for (auto at = path.begin(); at != path.end(); ++at) {
    auto& object = std::get<Json::Object>(cursor->value);
    if (at + 1 == path.end()) object[*at] = std::move(replacement);
    else cursor = &object.at(*at);
  }
  return value;
}
Json erase(Json value, std::initializer_list<const char*> path) {
  auto* cursor = &value;
  for (auto at = path.begin(); at != path.end(); ++at) {
    auto& object = std::get<Json::Object>(cursor->value);
    if (at + 1 == path.end()) check(object.erase(*at) == 1);
    else cursor = &object.at(*at);
  }
  return value;
}
const std::vector<Json> wrongTypes{nullptr, true, Json::Array{}, Json::Object{}, "caller", Json::Decimal{"1.0"}};
Json process(int pid) {
  return Json::Object{{"sid", "S-1-5-21-100-200-300-1001"}, {"session_id", 1},
    {"pid", pid}, {"creation_time", "132000000000000001"}};
}
Json prepareRequest() {
  // Synthetic grammar fixture only. The DTO cannot construct registered code,
  // a Creator-issued helper claim, a Session, a Job or a GPU lease.
  return Json::Object{{"version", 1}, {"requestId", requestId}, {"operation", "qualify"},
    {"binding", Json::Object{{"package", Json::Object{
      {"identityName", "portable-policy-fixture"}, {"publisher", "fixture"}, {"publisherId", "fixture"},
      {"familyName", "fixture"}, {"fullName", "fixture_0.1.3.0_x64__fixture"}, {"packageVersion", "0.1.3.0"},
      {"architecture", "x64"}, {"signatureKind", static_cast<std::int64_t>(mmstoreprofile::signatureKind)}, {"healthy", true}, {"current", true},
      {"installedLocation", "C:\\Program Files\\WindowsApps\\portable-policy-fixture"}}},
      {"inventorySha256", digest}, {"runtimeManifestSha256", digest},
      {"sid", "S-1-5-21-100-200-300-1001"}, {"bootIdentity", digest},
      {"recipeDigests", Json::Object{{"kim-vocals-v2", digest}, {"kim-vocals-v2-trim", digest}}}}},
    {"gpu", Json::Object{{"source", "DXGI EnumAdapters1/GetDesc1"}, {"deviceIndex", 0},
      {"name", "Portable policy fixture"}, {"vendorId", 4098}, {"deviceId", 42}, {"subsystemId", 1},
      {"revision", 1}, {"driverVersion", "31.0.1.1"}, {"luid", "0000000000000042"},
      {"dedicatedVideoMemoryBytes", 8589934592LL}, {"sharedSystemMemoryLimitBytes", 8000000000LL}}},
    {"fixture", Json::Object{{"kind", "fixed"}}}};
}
Json prepareLaunch() {
  const auto identity = process(43);
  return Json::Object{{"version", 1}, {"requestId", requestId}, {"inventorySha256", digest},
    {"owner", Json::Object{{"role", "prepare"}, {"nonce", digest},
      {"identity", Json::Object{{"sid", identity.at("sid")}, {"sessionId", identity.at("session_id")},
        {"pid", identity.at("pid")}, {"creationTime", identity.at("creation_time")}}}}}};
}
Json command(const char* action) {
  const bool request = std::string_view(action) == "prepare_launch" || std::string_view(action) == "prepare_recover";
  return Json::Object{{"version", 1}, {"requestId", requestId}, {"action", action},
    {request ? "request" : "launch", request ? prepareRequest() : prepareLaunch()}};
}
void commandDenied(const Json& value) {
  denied([&] { mmstoresessionclientpolicy::input("store_session_command", Json::Object{{"command", value}}); },
    mmstore::ErrorCode::invalidInput);
}
void receivingCommands() {
  using namespace mmstoresessionclientpolicy;
  for (const auto* name : {"store_session_open", "store_session_close", "store_session_presence"}) {
    check(operation(name)); input(name, Json::Object{}); ++checks;
    for (const auto* claim : {"pid", "parent_pid", "job", "nonce", "package", "path", "allow_unsigned", "command"})
      denied([&] { input(name, Json::Object{{claim, "caller"}}); }, mmstore::ErrorCode::invalidInput);
    for (const auto& type : wrongTypes) {
      if (std::holds_alternative<Json::Object>(type.value)) continue;
      denied([&] { input(name, type); }, mmstore::ErrorCode::invalidInput);
    }
  }
  check(operation("store_session_command"));
  for (const auto* alias : {"", "session_open", "store_session_open ", "STORE_SESSION_OPEN", "store_session_activate", "store_session_recover"}) {
    check(!operation(alias));
    denied([&] { input(alias, Json::Object{}); }, mmstore::ErrorCode::invalidInput);
  }
  for (const auto* action : {"prepare_launch", "prepare_recover", "prepare_wait", "prepare_cancel"}) {
    const auto baseline = command(action);
    input("store_session_command", Json::Object{{"command", baseline}}); ++checks;
    for (const auto* key : {"version", "requestId", "action"}) commandDenied(erase(baseline, {key}));
    commandDenied(replace(baseline, {"caller_pid"}, 42));
    commandDenied(replace(baseline, {"requestId"}, otherRequestId));
    commandDenied(replace(baseline, {"version"}, 2));
    for (const auto& type : wrongTypes) {
      commandDenied(type);
      commandDenied(replace(baseline, {"version"}, type));
    }
    const auto* nested = std::string_view(action) == "prepare_launch" || std::string_view(action) == "prepare_recover" ? "request" : "launch";
    commandDenied(erase(baseline, {nested}));
    commandDenied(replace(baseline, {nested, "requestId"}, otherRequestId));
    commandDenied(replace(baseline, {nested, "caller_path"}, "C:\\caller.exe"));
    for (const auto& type : wrongTypes) commandDenied(replace(baseline, {nested}, type));
  }
  for (const auto* action : {"prepare_launch ", "PREPARE_CANCEL", "launch", "execute", "shutdown", "worker_launch"})
    commandDenied(replace(command("prepare_launch"), {"action"}, action));
  for (const auto& type : wrongTypes)
    denied([&] { input("store_session_command", type); }, mmstore::ErrorCode::invalidInput);
  denied([&] { input("store_session_command", Json::Object{}); }, mmstore::ErrorCode::invalidInput);
  denied([&] { input("store_session_command", Json::Object{{"command", command("prepare_launch")}, {"owner", "caller"}}); }, mmstore::ErrorCode::invalidInput);

  const auto launch = command("prepare_launch");
  for (const auto* field : {"binding", "gpu", "fixture", "operation", "version"}) commandDenied(erase(launch, {"request", field}));
  for (const auto* field : {"package", "inventorySha256", "runtimeManifestSha256", "sid", "bootIdentity", "recipeDigests"})
    commandDenied(erase(launch, {"request", "binding", field}));
  commandDenied(replace(launch, {"request", "binding", "scope"}, "caller"));
  for (const auto* field : {"inventorySha256", "runtimeManifestSha256", "bootIdentity"}) {
    commandDenied(replace(launch, {"request", "binding", field}, std::string(64, 'A')));
    commandDenied(replace(launch, {"request", "binding", field}, std::string(63, 'a')));
  }
  for (const auto& type : wrongTypes) commandDenied(replace(launch, {"request", "binding", "sid"}, type));
  for (const auto* sid : {"", "S-1-5-18", "S-1-5-21-1-2-3", "S-1-5-21-1-2-3-4294967296", "S-1-5-21-01-2-3-4"})
    commandDenied(replace(launch, {"request", "binding", "sid"}, sid));
  const auto cloudSid = replace(launch, {"request", "binding", "sid"}, "S-1-12-1-1-2-3-4");
  input("store_session_command", Json::Object{{"command", cloudSid}}); ++checks;
  const auto inspect = replace(launch, {"request", "operation"}, "inspect");
  input("store_session_command", Json::Object{{"command", inspect}}); ++checks;
  commandDenied(replace(launch, {"request", "binding", "recipeDigests", "cpu-fallback"}, digest));
  commandDenied(replace(launch, {"request", "binding", "recipeDigests", "kim-vocals-v2"}, "bad"));
  for (const auto kind : {0, 1, 2, 3, 4}) {
    if (kind != static_cast<int>(mmstoreprofile::signatureKind)) commandDenied(replace(launch, {"request", "binding", "package", "signatureKind"}, kind));
  }
  commandDenied(replace(launch, {"request", "binding", "package", "healthy"}, false));
  commandDenied(replace(launch, {"request", "binding", "package", "current"}, false));
  for (const auto* architecture : {"x86", "arm64", "x64-on-arm64"}) commandDenied(replace(launch, {"request", "binding", "package", "architecture"}, architecture));
  commandDenied(replace(launch, {"request", "operation"}, "process"));
  commandDenied(replace(launch, {"request", "gpu", "source"}, "caller"));
  commandDenied(replace(launch, {"request", "gpu", "luid"}, "000000000000004A"));
  commandDenied(replace(launch, {"request", "gpu", "deviceIndex"}, 16));
  commandDenied(replace(launch, {"request", "gpu", "path"}, "C:\\caller.dll"));
  commandDenied(replace(launch, {"request", "fixture", "path"}, "C:\\song.wav"));
  auto approved = replace(launch, {"request", "fixture"}, Json::Object{{"kind", "approved"},
    {"relativePath", "prepare\\approved\\" + digest + ".wav"}, {"sha256", digest}, {"bytes", 44}});
  input("store_session_command", Json::Object{{"command", approved}}); ++checks;
  const auto largestFixture = replace(approved, {"request", "fixture", "bytes"}, 64LL * 1024 * 1024);
  input("store_session_command", Json::Object{{"command", largestFixture}}); ++checks;
  commandDenied(replace(approved, {"request", "fixture", "relativePath"}, "prepare\\approved\\..\\song.wav"));
  commandDenied(replace(approved, {"request", "fixture", "bytes"}, 43));
  commandDenied(replace(approved, {"request", "fixture", "bytes"}, 64LL * 1024 * 1024 + 1));
  const auto waiting = command("prepare_wait");
  commandDenied(replace(waiting, {"launch", "owner", "role"}, "session-agent"));
  commandDenied(replace(waiting, {"launch", "owner", "identity", "pid"}, 0));
  commandDenied(replace(waiting, {"launch", "owner", "identity", "creationTime"}, "01"));
  commandDenied(replace(waiting, {"launch", "owner", "nonce"}, "caller"));
}
void discoveryLocator() {
  using namespace mmstoresessionclientpolicy;
  const Json baseline = Json::Object{{"version", 1}, {"creator", process(41)}, {"creator_channel", digest},
    {"inventory_sha256", digest}, {"owner", Json::Object{{"role", "session-agent"}, {"nonce", digest}, {"identity", process(42)}}}};
  locator(baseline, digest); ++checks;
  const auto reject = [&](const Json& value, std::string_view inventory = digest) {
    denied([&] { locator(value, inventory); }, mmstore::ErrorCode::processDenied);
  };
  for (const auto* field : {"version", "creator", "creator_channel", "inventory_sha256", "owner"}) reject(erase(baseline, {field}));
  for (const auto* field : {"role", "nonce", "identity"}) reject(erase(baseline, {"owner", field}));
  for (const auto* role : {"prepare", "worker-node", "session-agent ", "SESSION-AGENT"}) reject(replace(baseline, {"owner", "role"}, role));
  for (const auto* scope : {"creator", "owner"}) reject(replace(baseline, {scope, "caller"}, true));
  reject(replace(baseline, {"allow_unsigned"}, true));
  reject(replace(baseline, {"version"}, 2)); reject(baseline, std::string(64, 'b')); reject(baseline, "bad");
  for (const auto* field : {"creator_channel", "inventory_sha256"}) {
    reject(replace(baseline, {field}, std::string(64, 'A'))); reject(replace(baseline, {field}, "bad"));
    for (const auto& type : wrongTypes) reject(replace(baseline, {field}, type));
  }
  reject(replace(baseline, {"owner", "nonce"}, "bad"));
  reject(replace(baseline, {"owner", "identity", "pid"}, 41));
  reject(replace(baseline, {"owner", "identity", "sid"}, "S-1-5-21-100-200-300-1002"));
  reject(replace(baseline, {"owner", "identity", "session_id"}, 2));
  for (const auto& type : wrongTypes) { reject(type); reject(replace(baseline, {"creator"}, type)); reject(replace(baseline, {"owner"}, type)); }
  for (const auto* field : {"sid", "session_id", "pid", "creation_time"}) reject(erase(baseline, {"creator", field}));
  for (const auto number : {std::int64_t{0}, std::int64_t{-1}, std::int64_t{2147483648LL}}) {
    reject(replace(baseline, {"creator", "pid"}, number));
    reject(replace(baseline, {"owner", "identity", "pid"}, number));
  }
  for (const auto number : {std::int64_t{0}, std::int64_t{-1}, std::int64_t{4294967296LL}}) reject(replace(baseline, {"creator", "session_id"}, number));
  for (const auto* birth : {"", "0", "01", "-1", "1e2", "18446744073709551616"}) {
    reject(replace(baseline, {"creator", "creation_time"}, birth));
    reject(replace(baseline, {"owner", "identity", "creation_time"}, birth));
  }
  auto largest = replace(baseline, {"creator", "pid"}, 2147483647);
  largest = replace(largest, {"creator", "creation_time"}, "18446744073709551615");
  locator(largest, digest); ++checks;
}
void frameBoundaries() {
  const auto wire = [](const char* operation, const Json* value = nullptr) {
    Json::Object request{{"version", 1}, {"operation", operation}, {"request_nonce", digest}, {"capability", std::string(64, 'b')}};
    if (value) request.emplace("command", *value);
    return mm::dump(request) + "\n";
  };
  for (const auto* operation : {"gui-client-bind", "gui-client-close"}) check(mmstorerole::parseRequest(wire(operation)).operation == operation);
  const auto value = command("prepare_launch"); const auto baseline = wire("gui-session", &value);
  check(mmstorerole::parseRequest(baseline).operation == "gui-session");
  check(mm::dump(mmstorerole::parseRequest(baseline).args) == mm::dump(value));
  for (const auto& invalid : {baseline.substr(0, baseline.size() - 1), baseline + "\n", baseline + baseline,
    std::string("\xef\xbb\xbf") + baseline, baseline.substr(0, baseline.size() - 1) + "\r\n", std::string(4097, 'x')})
    denied([&] { (void)mmstorerole::parseRequest(invalid); }, mmstore::ErrorCode::invalidInput);
  for (const auto* claim : {"pid", "creator", "job", "path", "allow_unsigned"}) {
    const auto changed = replace(mm::JsonParser(baseline).parse(), {claim}, "caller");
    denied([&] { (void)mmstorerole::parseRequest(mm::dump(changed) + "\n"); }, mmstore::ErrorCode::invalidInput);
  }
  denied([&] { (void)mmstorerole::parseRequest("{\"version\":1," + baseline.substr(1)); }, mmstore::ErrorCode::invalidInput);
  for (const auto* operation : {"gui-session ", "GUI-SESSION", "gui-session-close", "store_session_open"})
    denied([&] { (void)mmstorerole::parseRequest(wire(operation)); }, mmstore::ErrorCode::invalidInput);
}
void guiCreatorReceiving() {
  constexpr auto birth = "132000000000000001";
  constexpr auto package = "portable-policy-generation";
  const Json reply = Json::Object{{"version", 1}, {"confirmed", true}, {"challenge", digest},
    {"helper_pid", 42}, {"helper_creation_time", birth}, {"package_full_name", package}, {"browser_attachment", nullptr}, {"source_helper", nullptr}};
  const auto wire = [](const Json& value) { return mm::dump(value) + "\n"; };
  const auto receive = [&](std::string_view frame) { return mmstorerole::guiCreatorReply(frame, digest, 42, birth, package); };
  // This reflects receiving data only. Actual kernel server PID, held GUI and
  // helper code/current generation, and the private live table are separate.
  check(mm::dump(receive(wire(reply))) == mm::dump(reply));
  const auto attached = replace(replace(reply, {"browser_attachment"}, Json::Object{}), {"source_helper"}, Json::Object{{"pid", 43}, {"creation_time", birth}});
  check(mm::dump(receive(wire(attached))) == mm::dump(attached));
  const auto reject = [&](std::string_view frame) {
    denied([&] { (void)receive(frame); }, mmstore::ErrorCode::processDenied);
  };
  for (const auto* field : {"version", "confirmed", "challenge", "helper_pid", "helper_creation_time", "package_full_name", "browser_attachment", "source_helper"})
    reject(wire(erase(reply, {field})));
  reject(wire(replace(reply, {"source_helper"}, Json::Object{{"pid", 43}, {"creation_time", birth}})));
  reject(wire(replace(attached, {"source_helper"}, nullptr)));
  for (const auto& source : std::vector<Json>{Json::Object{}, Json::Object{{"pid", 0}, {"creation_time", birth}},
      Json::Object{{"pid", 2147483648LL}, {"creation_time", birth}}, Json::Object{{"pid", 43}, {"creation_time", "01"}},
      Json::Object{{"pid", 43}, {"creation_time", birth}, {"proof", true}}, Json(true), Json("source")})
    reject(wire(replace(attached, {"source_helper"}, source)));
  reject(wire(replace(reply, {"caller_proof"}, true)));
  reject(wire(replace(reply, {"version"}, 2)));
  reject(wire(replace(reply, {"confirmed"}, false)));
  reject(wire(replace(reply, {"challenge"}, std::string(64, 'b'))));
  reject(wire(replace(reply, {"helper_pid"}, 43)));
  reject(wire(replace(reply, {"helper_pid"}, 0)));
  reject(wire(replace(reply, {"helper_creation_time"}, "132000000000000002")));
  reject(wire(replace(reply, {"package_full_name"}, "different-generation")));
  for (const auto& type : wrongTypes) {
    reject(wire(replace(reply, {"challenge"}, type)));
    reject(wire(replace(reply, {"helper_creation_time"}, type)));
    reject(wire(replace(reply, {"package_full_name"}, type)));
    if (!std::holds_alternative<std::nullptr_t>(type.value) && !std::holds_alternative<Json::Object>(type.value))
      reject(wire(replace(reply, {"browser_attachment"}, type)));
  }
  const auto baseline = wire(reply);
  for (const auto& frame : {baseline.substr(0, baseline.size() - 1), baseline + "\n", baseline + baseline,
    std::string("\xef\xbb\xbf") + baseline, baseline.substr(0, baseline.size() - 1) + "\r\n",
    std::string(1, '\0') + baseline, std::string(2049, 'x'), std::string("\xc0") + baseline}) reject(frame);
  reject("{\"version\":1," + baseline.substr(1));
  reject("{\"\\u0076ersion\":1," + baseline.substr(1));
  denied([&] { (void)mmstorerole::guiCreatorReply(baseline, std::string(64, 'A'), 42, birth, package); }, mmstore::ErrorCode::processDenied);
  denied([&] { (void)mmstorerole::guiCreatorReply(baseline, digest, 0, birth, package); }, mmstore::ErrorCode::processDenied);
  denied([&] { (void)mmstorerole::guiCreatorReply(baseline, digest, 42, "01", package); }, mmstore::ErrorCode::processDenied);
}
void prepareFailurePublisher() {
  using namespace mmstorerole;
  // Actor here is a receiving policy fixture. Production obtains it only from
  // its genuine Creator-owned bound helper/Node/Job table, never this DTO.
  for (const auto* code : {"GPU_UNSUPPORTED", "INTEGRITY_INVALID", "PERMISSION_DENIED", "BUSY",
    "PREPARE_INTERRUPTED", "OPERATION_FAILED", "NATIVE_HELPER_UNAVAILABLE"}) {
    const Json failure = Json::Object{{"requestId", requestId}, {"errorCode", code}};
    check(brokerOperation(Role::prepare, BrokerCommand::prepareResult, failure));
    for (const auto actor : {Role::session, Role::login, Role::personal, Role::fleet})
      check(!brokerOperation(actor, BrokerCommand::prepareResult, failure));
    for (const auto* claim : {"role", "owner", "pid", "job", "path", "details", "rawSha256", "rawBytes", "allow_unsigned"})
      check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(failure, {claim}, "caller")));
    check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, erase(failure, {"requestId"})));
    check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, erase(failure, {"errorCode"})));
    for (const auto& type : wrongTypes) {
      check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(failure, {"requestId"}, type)));
      check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(failure, {"errorCode"}, type)));
    }
  }
  const Json failure = Json::Object{{"requestId", requestId}, {"errorCode", "OPERATION_FAILED"}};
  for (const auto* code : {"", "READY", "PASS", "operation_failed", "OPERATION_FAILED ", "CPU_FALLBACK", "C:\\private\\error.log"})
    check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(failure, {"errorCode"}, code)));
  for (const auto* id : {"", "11111111-2222-3333-8444-555555555555", "11111111-2222-4333-7444-555555555555", "11111111-2222-4333-8444-55555555555G"})
    check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(failure, {"requestId"}, id)));
  const Json raw = Json::Object{{"requestId", requestId}, {"rawSha256", digest}, {"rawBytes", 1}};
  check(brokerOperation(Role::prepare, BrokerCommand::prepareResult, raw));
  check(brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(raw, {"rawBytes"}, 16384)));
  check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(raw, {"errorCode"}, "OPERATION_FAILED")));
  check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(raw, {"rawSha256"}, std::string(64, 'A'))));
  for (const auto bytes : {0, 16385}) check(!brokerOperation(Role::prepare, BrokerCommand::prepareResult, replace(raw, {"rawBytes"}, bytes)));
  const Json envelope = Json::Object{{"version", 1}, {"operation", "broker"}, {"command", "prepare-result"},
    {"request_nonce", digest}, {"capability", std::string(64, 'b')}, {"args", failure}};
  const auto frame = mm::dump(envelope) + "\n";
  const auto parsed = parseRequest(frame);
  check(parsed.command == "prepare-result" && mm::dump(parsed.args) == mm::dump(failure));
  auto duplicate = frame;
  const auto at = duplicate.find("\"errorCode\":");
  check(at != std::string::npos);
  duplicate.insert(at, "\"errorCode\":\"BUSY\",");
  denied([&] { (void)parseRequest(duplicate); }, mmstore::ErrorCode::invalidInput);
}
} // namespace

int main() {
  try {
    receivingCommands(); discoveryLocator(); frameBoundaries(); guiCreatorReceiving(); prepareFailurePublisher();
    std::cout << "STORE_SESSION_CLIENT_POLICY " << checks << " passed; portable receiving fixtures only\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
