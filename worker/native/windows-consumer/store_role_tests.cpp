#include "store_role.hpp"
#include "store_data_policy.hpp"
#include "store_child_policy.hpp"
#include "store_share_policy.hpp"
#include "store_model_policy.hpp"
#include <functional>
#include <iostream>
#include <type_traits>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_ROLE_TEST_FAILED"); }
void denied(const std::function<void()>& operation) {
  bool rejected = false;
  try { operation(); } catch (const mmstore::Error&) { rejected = true; }
  check(rejected);
}
void storeModelPolicy() {
  using mm::Json;
  const Json birth = Json::Object{{"device", "1"}, {"file_id", "7"}, {"born_at", "132000000000000001"}};
  const std::vector<std::pair<std::string, Json>> valid{
    {"store_model_file_open", Json::Object{{"mode", "create-new"}, {"expected_birth", nullptr}}},
    {"store_model_file_open", Json::Object{{"mode", "resume"}, {"expected_birth", birth}}},
    {"store_model_publish", Json::Object{{"token", std::string(64, 'a')}}},
    {"store_model_recover", Json::Object{}}
  };
  for (const auto& [name, args] : valid) {
    check(mmstoremodelpolicy::operation(name)); check(mmstoremodelpolicy::input(name, args));
    for (const auto& [key, ignored] : args.object()) {
      (void)ignored; auto missing = args.object(); missing.erase(key); check(!mmstoremodelpolicy::input(name, missing));
      auto wrong = args.object(); wrong[key] = Json::Array{}; check(!mmstoremodelpolicy::input(name, wrong));
    }
    for (const auto* key : {"root", "path", "relative_path", "sha256", "bytes", "signature_kind", "model", "prepare_nonce"}) {
      auto extra = args.object(); extra[key] = "caller"; check(!mmstoremodelpolicy::input(name, extra));
    }
    for (const auto actor : {mmstorerole::Role::session, mmstorerole::Role::personal, mmstorerole::Role::fleet, mmstorerole::Role::prepare})
      check(!mmstorerole::workerDataOperation(actor, name, args));
  }
  for (const auto* mode : {"read", "RESUME", "write", "resume ", ""})
    check(!mmstoremodelpolicy::input("store_model_file_open", Json::Object{{"mode", mode}, {"expected_birth", birth}}));
  check(!mmstoremodelpolicy::input("store_model_file_open", Json::Object{{"mode", "resume"}, {"expected_birth", nullptr}}));
  check(!mmstoremodelpolicy::input("store_model_file_open", Json::Object{{"mode", "create-new"}, {"expected_birth", birth}}));
  for (const auto* name : {"model_publish", "store_model_publish ", "STORE_MODEL_RECOVER", "private_file_publish"})
    check(!mmstoremodelpolicy::operation(name));
}
void childPolicy() {
  using namespace mmstorerole; using mm::Json;
  const std::string id = "12345678-1234-4234-8234-123456789012", nonce(64, 'a');
  const std::string relative = "personal\\engine-session\\" + id + "\\engine-config.json";
  const Json start = Json::Object{{"config_relative", relative}, {"incarnation", id}};
  const Json write = Json::Object{{"token", nonce}, {"bytes_base64", "e30="}};
  const Json token = Json::Object{{"token", nonce}};
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
    check(childOperation(role, "child-start", start) == (role == Role::personal));
    check(childOperation(role, "child-write", write) == (role == Role::personal || role == Role::fleet));
    for (const auto* operation : {"child-read", "child-stop"}) check(childOperation(role, operation, token) == (role == Role::personal || role == Role::fleet));
  }
  for (const auto& [operation, valid] : std::vector<std::pair<std::string, Json>>{{"child-start", start}, {"child-write", write}, {"child-read", token}, {"child-stop", token}}) {
    for (const auto& [key, unused] : valid.object()) {
      (void)unused; auto missing = valid.object(); missing.erase(key); check(!childOperation(Role::personal, operation, missing));
      for (const auto& wrong : {Json(nullptr), Json(true), Json(1), Json(Json::Array{})}) { auto bad = valid.object(); bad[key] = wrong; check(!childOperation(Role::personal, operation, bad)); }
    }
    for (const auto* key : {"path", "command", "env", "cwd", "gpu", "job", "owner"}) { auto extra = valid.object(); extra[key] = "caller selected"; check(!childOperation(Role::personal, operation, extra)); }
  }
  for (const auto* path : {"personal/engine-session/12345678-1234-4234-8234-123456789012/engine-config.json", "..\\engine-config.json", "C:\\private\\engine-config.json", "PERSONAL\\engine-session\\12345678-1234-4234-8234-123456789012\\engine-config.json", "personal\\engine-session\\12345678-1234-4234-8234-123456789012\\engine-config.json:stream"}) {
    auto bad = start.object(); bad["config_relative"] = path; check(!childOperation(Role::personal, "child-start", bad));
  }
  for (const auto* encoded : {"", "e31=", "e30=\n", "====", "e30=="}) { auto bad = write.object(); bad["bytes_base64"] = encoded; check(!childOperation(Role::personal, "child-write", bad)); }
  auto boundary = write.object(); boundary["bytes_base64"] = std::string(32768, 'A'); check(childOperation(Role::personal, "child-write", boundary)); boundary["bytes_base64"] = std::string(32772, 'A'); check(!childOperation(Role::personal, "child-write", boundary));
  for (const auto* operation : {"execute", "child-start ", "CHILD-READ", "process_spawn", "child-shell"}) check(!childOperation(Role::personal, operation, token));
  const std::string personalRoot = "C:\\Users\\fixture\\MusicMuteLocal", workerRoot = "C:\\Program Files\\WindowsApps\\fixture\\worker", sid = "S-1-12-1-100-200-300-400";
  const Json gpu = Json::Object{{"source", "DXGI EnumAdapters1/GetDesc1"}, {"deviceIndex", 3}, {"name", "Synthetic adapter"}, {"vendorId", 32902}, {"deviceId", 1234}, {"subsystemId", 5678}, {"revision", 1}, {"driverVersion", "32.0.1.1"}, {"luid", "0000000000000042"}, {"dedicatedVideoMemoryBytes", 0}, {"sharedSystemMemoryLimitBytes", 8000000000LL}};
  const Json config = Json::Object{{"version", 2}, {"sessionId", id}, {"sessionRoot", personalRoot + "\\personal\\engine-session\\" + id}, {"jobsRoot", personalRoot + "\\personal\\jobs"}, {"releaseRoot", workerRoot}, {"modelPath", personalRoot + "\\models\\Kim_Vocal_2.onnx"}, {"sid", sid}, {"gpuIdentity", gpu}};
  check(personalEngineConfig(config, id, personalRoot, workerRoot, sid, gpu));
  for (const auto& [key, unused] : config.object()) { (void)unused; auto missing = config.object(); missing.erase(key); check(!personalEngineConfig(missing, id, personalRoot, workerRoot, sid, gpu)); auto wrong = config.object(); wrong[key] = nullptr; check(!personalEngineConfig(wrong, id, personalRoot, workerRoot, sid, gpu)); }
  for (const auto* key : {"sessionRoot", "jobsRoot", "releaseRoot", "modelPath", "sid", "sessionId"}) { auto bad = config.object(); bad[key] = config.at(key).string() + "\\.."; check(!personalEngineConfig(bad, id, personalRoot, workerRoot, sid, gpu)); }
  auto old = config.object(); old["version"] = 1; check(!personalEngineConfig(old, id, personalRoot, workerRoot, sid, gpu));
  auto extra = config.object(); extra["recipe"] = "lower quality"; check(!personalEngineConfig(extra, id, personalRoot, workerRoot, sid, gpu));
  auto otherGpu = gpu.object(); otherGpu["deviceIndex"] = 4; check(!personalEngineConfig(config, id, personalRoot, workerRoot, sid, otherGpu));
  otherGpu = gpu.object(); otherGpu["driverVersion"] = "32.0.1.2"; check(!personalEngineConfig(config, id, personalRoot, workerRoot, sid, otherGpu));
  auto local = config.object(); local["sid"] = "S-1-5-21-100-200-300-400"; check(personalEngineConfig(local, id, personalRoot, workerRoot, "S-1-5-21-100-200-300-400", gpu));
}
void controlPolicy() {
  using namespace mmstorerole; using mm::Json;
  const auto id = "12345678-1234-4234-8234-123456789012";
  const Json expectedTarget = Json::Object{{"role", "personal"}, {"nonce", std::string(64, 'c')}, {"identity", Json::Object{{"sid", "S-1-12-1-100-200-300-400"}, {"session_id", 1}, {"pid", 123}, {"creation_time", "132000000000000001"}}}};
  const Json request = Json::Object{{"requestId", id}, {"target", "personal"}, {"payload_base64", "e30="}, {"expected_target", expectedTarget}};
  const Json reply = Json::Object{{"token", std::string(64, 'a')}, {"payload_base64", "e30="}};
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
    check(brokerOperation(role, BrokerCommand::controlRequest, request) == (role == Role::session));
    auto session = request.object(); session["target"] = "session"; session.erase("expected_target");
    check(brokerOperation(role, BrokerCommand::controlRequest, session) == (role == Role::personal || role == Role::fleet));
    check(brokerOperation(role, BrokerCommand::controlAccept, Json::Object{}) == controlRole(role));
    check(brokerOperation(role, BrokerCommand::controlReply, reply) == controlRole(role));
    check(!brokerOperation(role, BrokerCommand::controlAccept, Json::Object{{"peer", true}}));
  }
  for (const auto& [key, unused] : expectedTarget.object()) { (void)unused; auto badOwner = expectedTarget.object(); badOwner.erase(key); auto bad = request.object(); bad["expected_target"] = badOwner; check(!controlRequest(Role::session, bad)); }
  for (const auto* role : {"session-agent", "fleet", "prepare", "personal "}) { auto badOwner = expectedTarget.object(); badOwner["role"] = role; auto bad = request.object(); bad["expected_target"] = badOwner; check(!controlRequest(Role::session, bad)); }
  auto noExpectation = request.object(); noExpectation.erase("expected_target"); check(!controlRequest(Role::session, noExpectation));
  for (const auto& [input, command] : std::vector<std::pair<Json, BrokerCommand>>{{request, BrokerCommand::controlRequest}, {reply, BrokerCommand::controlReply}}) for (const auto& [key, unused] : input.object()) {
    (void)unused; auto bad = input.object(); bad.erase(key);
    check(!brokerOperation(Role::session, command, bad));
  }
  for (const auto* target : {"prepare", "fleet", "session-agent", "../personal", "PERSONAL"}) {
    auto invalid = request.object(); invalid["target"] = target;
    for (const auto role : {Role::session, Role::personal, Role::fleet}) check(!controlRequest(role, invalid));
  }
  for (const auto* encoded : {"", "e30=\n", "e31=", "e30==", "YQ=", "===="}) {
    auto invalid = request.object(); invalid["payload_base64"] = encoded; check(!controlRequest(Role::session, invalid));
    auto result = reply.object(); result["payload_base64"] = encoded; check(!controlResult(result));
  }
  const Json gui = Json::Object{{"version", 1}, {"requestId", id}, {"action", "session_forward"}, {"payload_base64", "e30="}};
  check(storeSessionCommand(gui)); auto forbidden = gui.object(); forbidden["peer"] = Json::Object{}; check(!storeSessionCommand(forbidden));
  check(storeSessionCommand(Json::Object{{"version", 1}, {"requestId", id}, {"action", "session_forward_ack"}}));
  const Json status = Json::Object{{"version", 1}, {"request_id", id}, {"action", "status"}};
  check(controlPayload(Role::session, Role::session, true, status));
  // Browser is a receiving scope selected by the private GuiClient, never by
  // a payload flag. These checks grant no real browser/creator authority.
  const Json chromeAttach=Json::Object{{"version",1},{"request_id",id},{"action","personal_attach"},{"owner_id",id},{"owner_kind","chrome"}};
  const Json desktopAttach=Json::Object{{"version",1},{"request_id",id},{"action","personal_attach"},{"owner_id",id},{"owner_kind","desktop"}};
  check(!controlPayload(Role::session,Role::session,true,chromeAttach));
  check(controlPayload(Role::session,Role::session,true,chromeAttach,true));
  check(!controlPayload(Role::session,Role::session,true,desktopAttach,true));
  check(controlPayload(Role::session,Role::session,true,desktopAttach));
  check(!controlPayload(Role::session,Role::session,false,chromeAttach,true));
  const Json chromeCommand=Json::Object{{"version",1},{"kind","personal-command"},{"owner_kind","chrome"},{"command",Json::Object{{"version",1},{"requestId",id},{"action","status"}}}};
  check(controlPayload(Role::session,Role::session,true,chromeCommand,true));
  check(!controlPayload(Role::session,Role::session,true,chromeCommand));
  auto foreign=chromeCommand.object();foreign["owner_kind"]="desktop";check(!controlPayload(Role::session,Role::session,true,foreign,true));
  foreign=chromeCommand.object();foreign["submission_authority"]=Json::Object{{"kind","account"},{"scope",Json::Object{}}};check(!controlPayload(Role::session,Role::session,true,foreign,true));
  foreign["submission_authority"]=Json::Object{{"kind","guest"}};check(controlPayload(Role::session,Role::session,true,foreign,true));
  for (const auto* action : {"maintenance_begin","maintenance_end","maintenance_resume","fleet_intent","fleet_restart","fleet_force","account_scope","execute"}) {auto privilege=status.object();privilege["action"]=action;check(!controlPayload(Role::session,Role::session,true,privilege,true));}

  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) check(!controlPayload(role, Role::session, false, status));
  for (const auto* action : {"maintenance_commit", "execute", "prepare_launch", "register-helper"}) {
    auto bad = status.object(); bad["action"] = action; check(!controlPayload(Role::session, Role::session, true, bad));
  }
  auto maintenance = status.object(); maintenance["action"] = "maintenance_begin"; maintenance["transaction"] = id;
  check(controlPayload(Role::session, Role::session, true, maintenance)); maintenance["path"] = "cmd.exe"; check(!controlPayload(Role::session, Role::session, true, maintenance));
  const Json resume = Json::Object{{"version", 1}, {"request_id", id}, {"action", "maintenance_resume"}, {"transaction", id}, {"instance_id", id}};
  check(controlPayload(Role::session, Role::session, true, resume));
  for (const auto& [key, unused] : resume.object()) { (void)unused; auto missing = resume.object(); missing.erase(key); check(!controlPayload(Role::session, Role::session, true, missing)); }
  for (const auto* key : {"intent", "idle", "reset_budget", "owner", "gpu"}) { auto extra = resume.object(); extra[key] = true; check(!controlPayload(Role::session, Role::session, true, extra)); }
  for (const auto role : {Role::session, Role::personal, Role::fleet, Role::prepare}) check(!controlPayload(role, Role::session, false, resume));
  denied([&] { (void)parseRequest(std::string(4500, ' ') + mm::dump(Json::Object{{"version", 1}, {"operation", "node-bind"}, {"request_nonce", std::string(64, 'a')}, {"capability", std::string(64, 'b')}}) + "\n"); });
  denied([&] { (void)parseRequest(std::string(65537, ' ')); });
  auto large = reply.object(); large["payload_base64"] = std::string(6000, 'A');
  const auto frame = mm::dump(Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", std::string(64, 'a')}, {"capability", std::string(64, 'b')}, {"command", "control-reply"}, {"args", large}}) + "\n";
  check(parseRequest(frame).command == "control-reply"); check(controlResult(large));
  large["payload_base64"] = std::string(44000, 'A'); check(!controlResult(large));
  const Json peer = Json::Object{{"token", std::string(64, 'a')}, {"kind", "gui"}, {"identity", Json::Object{{"sid", "S-1-12-1-100-200-300-400"}, {"session_id", 1}, {"pid", 123}, {"creation_time", "132000000000000001"}}}};
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) check(brokerOperation(role, BrokerCommand::controlPeer, peer) == controlRole(role));
  auto browserPeer = peer.object(); browserPeer["kind"] = "chrome"; check(brokerOperation(Role::session, BrokerCommand::controlPeer, browserPeer));
  for (const auto* kind : {"desktop", "worker-node", "session", "SESSION-AGENT", ""}) { auto bad = peer.object(); bad["kind"] = kind; check(!brokerOperation(Role::session, BrokerCommand::controlPeer, bad)); }
  for (const auto& [key, unused] : peer.object()) { (void)unused; auto bad = peer.object(); bad.erase(key); check(!brokerOperation(Role::session, BrokerCommand::controlPeer, bad)); }
}
std::string request(std::string operation = "node-bind") {
  return mm::dump(mm::Json::Object{{"version", 1}, {"operation", std::move(operation)},
    {"request_nonce", std::string(64, 'a')}, {"capability", std::string(64, 'b')}}) + "\n";
}
void policy() {
  using namespace mmstorerole;
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare})
    check(parseRole(roleName(role)) == role);
  for (const auto* value : {"", "Session-agent", "worker-node", "native", "../../fleet", "fleet ", "FLEET"})
    denied([&] { (void)parseRole(value); });
  for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
    check(sessionReadonlyInspection(role, mm::Json::Object{}) == (role == Role::session));
    for (const auto& args : {mm::Json(nullptr), mm::Json(true), mm::Json(1), mm::Json(""), mm::Json(mm::Json::Array{}),
        mm::Json(mm::Json::Object{{"scope", "session"}}), mm::Json(mm::Json::Object{{"service", "MusicMuteWorkerService.exe"}})})
      check(!sessionReadonlyInspection(role, args));
  }
  check(sameSecret(std::string(64, 'a'), std::string(64, 'a')));
  check(!sameSecret(std::string(64, 'a'), std::string(64, 'b')));
  check(!sameSecret(std::string(63, 'a'), std::string(63, 'a')));
  check(!sameSecret(std::string(64, 'A'), std::string(64, 'A')));
  for (const auto* value : {"1", "132000000000000000", "18446744073709551615"}) check(validBirth(value));
  for (const auto* value : {"", "0", "01", "-1", "1.0", "1e2", "18446744073709551616", "999999999999999999999", " 1", "1\n"}) check(!validBirth(value));
  check(pid(mm::Json(1)) == 1); check(pid(mm::Json(2147483647)) == 2147483647U);
  for (const auto number : {std::int64_t{-1}, std::int64_t{0}, std::int64_t{2147483648LL}})
    denied([&] { (void)pid(mm::Json(number)); });
  for (const auto* operation : {"node-bind", "helper-bind", "guardian-bind"}) check(parseRequest(request(operation)).operation == operation);
  for (const auto* operation : {"register-helper", "register-watchdog"}) {
    auto value = mm::JsonParser(request(operation)).parse().object(); value.emplace("pid", 42);
    check(parseRequest(mm::dump(value) + "\n").child == 42);
  }
  const auto baseline = request();
  for (const auto& value : {baseline.substr(0, baseline.size() - 1), baseline + "\n", baseline + baseline,
    std::string("\xef\xbb\xbf") + baseline, baseline.substr(0, baseline.size() - 1) + "\r\n", std::string(4097, 'x'), std::string("{}\n")})
    denied([&] { (void)parseRequest(value); });
  for (const auto* operation : {"launch", "execute", "store_boot", "register-guardian", "Node-bind"})
    denied([&] { (void)parseRequest(request(operation)); });
  const auto original = mm::JsonParser(baseline).parse();
  for (const auto* field : {"version", "operation", "request_nonce", "capability"}) {
    auto value = original.object(); value.erase(field); denied([&] { (void)parseRequest(mm::dump(value) + "\n"); });
  }
  for (const auto* field : {"path", "role", "pid", "parent", "job", "creation_time"}) {
    auto value = original.object(); value.emplace(field, "untrusted"); denied([&] { (void)parseRequest(mm::dump(value) + "\n"); });
  }
  auto extra = original.object(); extra["version"] = 2; denied([&] { (void)parseRequest(mm::dump(extra) + "\n"); });
  extra = original.object(); extra["capability"] = std::string(64, 'A'); denied([&] { (void)parseRequest(mm::dump(extra) + "\n"); });
  denied([&] { (void)parseRequest("{\"version\":1," + baseline.substr(1)); });
  denied([&] { (void)parseRequest("{\"\\u0076ersion\":1," + baseline.substr(1)); });
  ReplayFence fence; fence.consume(std::string(64, 'a')); ++checks;
  denied([&] { fence.consume(std::string(64, 'a')); });
  denied([&] { fence.consume(std::string(63, 'b')); });
  ReplayFence bounded;
  for (unsigned n = 0; n < 4096; ++n) {
    auto nonce = std::string(64, '0'); const std::string hex = "0123456789abcdef";
    for (unsigned shift = 0; shift < 4; ++shift) nonce[63 - shift] = hex[(n >> (shift * 4)) & 15];
    bounded.consume(nonce);
  }
  denied([&] { bounded.consume(std::string(64, 'f')); });
#ifdef _WIN32
  static_assert(!std::is_default_constructible_v<StoreRoleIssuer>);
  static_assert(!std::is_default_constructible_v<StoreRoleBinding>);
  static_assert(!std::is_default_constructible_v<StoreGuardianBinding>);
  static_assert(!std::is_copy_constructible_v<StoreRoleBinding>);
#endif
}
void dataPolicy() {
  using namespace mmstorerole;
  using mm::Json;
  const auto secret = std::string(64, 'a');
  const Json process = Json::Object{{"sid", "S-1-5-21-100-200-300-1001"}, {"session_id", 1},
    {"pid", 42}, {"creation_time", "132000000000000001"}};
  const auto vault = [](const char* space, const std::string& key, bool write = false) {
    Json::Object result{{"namespace", space}, {"key", key}};
    if (write) result.emplace("bytes_base64", "e30=");
    return Json(result);
  };
  struct Input { std::string operation; Json args; };
  const std::vector<Input> admitted{
    {"identity", Json::Object{}}, {"boot_identity", Json::Object{}}, {"gpu_inventory", Json::Object{}},
    {"process_identity", Json::Object{{"pid", 42}}},
    {"ensure_private_directory", Json::Object{{"root", "personal"}, {"relative_path", ""}}},
    {"validate_path", Json::Object{{"root", "personal"}, {"relative_path", "library\\audio.wav"}, {"kind", "file"}}},
    {"private_file_open", Json::Object{{"root", "personal"}, {"relative_path", "models\\Kim_Vocal_2.onnx.part"}, {"mode", "create-new"}, {"maximum_bytes", 4294967296LL}, {"expected_birth", nullptr}}},
    {"private_file_info", Json::Object{{"token", secret}}},
    {"private_file_read", Json::Object{{"token", secret}, {"position", 0}, {"length", 24576}}},
    {"private_file_write", Json::Object{{"token", secret}, {"position", 0}, {"bytes_base64", "YQ=="}}},
    {"private_file_truncate", Json::Object{{"token", secret}, {"length", 4294967296LL}}},
    {"private_file_sync", Json::Object{{"token", secret}}}, {"private_file_close", Json::Object{{"token", secret}}},
    {"vault_get", vault("account", "prepare_maintenance")},
    {"vault_put", vault("account", "prepare_model_transfer", true)},
    {"vault_delete", vault("account", "prepare_model_transfer")},
    {"acquire_mutex", Json::Object{{"scope", "prepare"}}},
    {"release_mutex", Json::Object{{"scope", "prepare"}, {"nonce", secret}, {"identity", process}}}
  };
  for (const auto& input : admitted) {
    check(workerDataOperation(Role::prepare, input.operation, input.args));
    check(!workerDataOperation(Role::login, input.operation, input.args));
    auto extra = input.args.object(); extra.emplace("untrusted", true);
    check(!workerDataOperation(Role::prepare, input.operation, extra));
    for (const auto& [name, unused] : input.args.object()) {
      (void)unused;
      auto missing = input.args.object(); missing.erase(name);
      check(!workerDataOperation(Role::prepare, input.operation, missing));
      auto wrong = input.args.object(); wrong[name] = Json::Array{};
      check(!workerDataOperation(Role::prepare, input.operation, wrong));
    }
    check(!workerDataOperation(Role::prepare, input.operation, Json::Array{}));
  }
  for (const auto role : {Role::session, Role::personal, Role::fleet, Role::prepare}) {
    check(workerDataOperation(role, "vault_get", vault("account", "installation")));
    check(workerDataOperation(role, "vault_put", vault("account", "installation", true)));
    check(!workerDataOperation(role, "vault_delete", vault("account", "installation")));
    check(workerDataOperation(role, "vault_get", vault("account", "store_model_ready")));
    check(workerDataOperation(role, "vault_put", vault("account", "store_model_ready", true)) == (role == Role::prepare));
    check(workerDataOperation(role, "vault_get", vault("account", "startup_measurements")) == (role != Role::fleet));
    check(workerDataOperation(role, "vault_put", vault("account", "startup_measurements", true)) == (role != Role::fleet));
    check(!workerDataOperation(role, "vault_delete", vault("account", "startup_measurements")));
    for (const auto* key : {"credential", "signout_state", "browser_ticket", "account_owner", "ready_receipt", "runtime_sequence",
        "runtime_status", "prepare_runtime_transfer", "agent_bootstrap", "login_bootstrap", "active_runtime", "consumer_update_journal"})
      for (const auto* operation : {"vault_get", "vault_put", "vault_delete"})
        for (const auto* space : {"account", "fleet"})
          check(!workerDataOperation(role, operation, vault(space, key, std::string_view(operation) == "vault_put")));
    for (const auto* space : {"account", "fleet", "personal", ""}) check(!workerDataOperation(role, "vault_recover", Json::Object{{"namespace", space}}));
    for (const auto* scope : {"account", "activation", "session", "prepare", "cache", "metadata", "acquisition", "Session", "unknown"}) {
      const bool expected = std::string_view(scope) == "session" ? role == Role::session :
        std::string_view(scope) == "acquisition" ? role == Role::personal :
        std::string_view(scope) == "prepare" || std::string_view(scope) == "cache" || std::string_view(scope) == "metadata";
      check(workerDataOperation(role, "acquire_mutex", Json::Object{{"scope", scope}}) == expected);
      check(workerDataOperation(role, "release_mutex", Json::Object{{"scope", scope}, {"nonce", secret}, {"identity", process}}) == expected);
    }
    check(workerDataOperation(role, "singleton_inspect", Json::Object{{"scope", "session"}}) == (role == Role::session));
    check(!workerDataOperation(role, "singleton_inspect", Json::Object{{"scope", "account"}}));
    for (const auto* key : {"personal_requests", "personal_acquisition", "youtube_guest"}) {
      check(workerDataOperation(role, "vault_get", vault("account", key)) == (role == Role::personal));
      check(workerDataOperation(role, "vault_put", vault("account", key, true)) == (role == Role::personal));
      check(!workerDataOperation(role, "vault_delete", vault("account", key)));
    }
    for (const auto* key : {"personal_ticket", "personal_admission_ticket", "personal_events_ticket"}) {
      check(workerDataOperation(role, "vault_get", vault("account", key)) == (role == Role::personal || role == Role::session));
      check(workerDataOperation(role, "vault_put", vault("account", key, true)) == (role == Role::personal));
    }
    for (const auto* key : {"gpu_broker_index", "gpu_broker_state", "gpu_broker_0123456789abcdef"})
      for (const auto* operation : {"vault_get", "vault_put", "vault_delete"})
        check(workerDataOperation(role, operation, vault("fleet", key, std::string_view(operation) == "vault_put")) == (role == Role::session));
    for (const auto* operation : {"vault_get", "vault_put", "vault_delete"}) {
      check(workerDataOperation(role, operation, vault("fleet", "store_active_runtime", std::string_view(operation) == "vault_put")) ==
        (std::string_view(operation) == "vault_get" && (role == Role::session || role == Role::fleet || role == Role::prepare)));
      check(!workerDataOperation(role, operation, vault("account", "store_active_runtime", std::string_view(operation) == "vault_put")));
      check(!workerDataOperation(role, operation, vault("fleet", "active_runtime", std::string_view(operation) == "vault_put")));
      check(!workerDataOperation(role, operation, vault("fleet", "store_active_runtime_extra", std::string_view(operation) == "vault_put")));
    }
    for (const auto& key : {"job_owner_" + secret.substr(0, 54), "job_exit_" + secret.substr(0, 55), std::string("latest_prepare_job")}) {
      check(workerDataOperation(role, "vault_get", vault("fleet", key)));
      check(!workerDataOperation(role, "vault_put", vault("fleet", key, true)));
      check(!workerDataOperation(role, "vault_delete", vault("fleet", key)));
    }
  }
  const auto inputKey = "personal_input_01234567-89ab-4cde-8fab-0123456789ab";
  for (const auto* operation : {"vault_get", "vault_put", "vault_delete"})
    check(workerDataOperation(Role::personal, operation, vault("account", inputKey, std::string_view(operation) == "vault_put")));
  for (const auto& key : {std::string(inputKey) + "_extra", "personal_input_" + secret.substr(0, 36),
      std::string("personal_input_01234567-89ab-1cde-8fab-0123456789ab"), std::string("personal_input_01234567-89ab-4cde-7fab-0123456789ab"),
      "job_owner_" + secret, "gpu_broker_" + secret, std::string("personal_input_../../credential")})
    check(!workerDataOperation(Role::personal, "vault_get", vault("account", key)));
  for (const auto* path : {"vault\\account\\credential", "VAULT\\Account\\credential", "runtime\\node\\node.exe", "prepare\\downloads\\runtime.part",
      "..\\credential", "a\\..\\b", "a\\\\b", "a/secret", "C:\\secret", "\\secret", "a\\", "NUL.txt", "COM1", "a.\\b", "a \\b"}) {
    auto args = admitted[6].args.object(); args["relative_path"] = path;
    // The legacy download scratch name is data but Store role code cannot
    // open it as resumable runtime or turn it into executable authority.
    if (std::string_view(path) == "prepare\\downloads\\runtime.part") { args["mode"] = "resume"; args["expected_birth"] = Json::Object{{"device", "1"}, {"file_id", "2"}, {"born_at", "3"}}; }
    check(!workerDataOperation(Role::prepare, "private_file_open", args));
  }
  for (const auto* invalid : {"", "YQ=", "YQ===", "Y Q==", "YR==", "YWJ=", "====", "e30=\n"})
    check(!workerDataOperation(Role::prepare, "vault_put", Json::Object{{"namespace", "account"}, {"key", "prepare_model_transfer"}, {"bytes_base64", invalid}}));
  auto oversized = admitted[9].args.object(); oversized["bytes_base64"] = std::string(32772, 'A');
  check(!workerDataOperation(Role::prepare, "private_file_write", oversized));
  auto resume = admitted[6].args.object(); resume["mode"] = "resume"; resume["expected_birth"] = Json::Object{{"device", "0"}, {"file_id", "18446744073709551615"}, {"born_at", "1"}};
  check(workerDataOperation(Role::prepare, "private_file_open", resume));
  check(!workerDataOperation(Role::personal, "private_file_open", resume));
  auto badBirth = resume; badBirth["expected_birth"] = Json::Object{{"device", "4294967296"}, {"file_id", "1"}, {"born_at", "1"}};
  check(!workerDataOperation(Role::prepare, "private_file_open", badBirth));
  auto entra = process.object(); entra["sid"] = "S-1-12-1-100-200-300-400";
  check(workerDataOperation(Role::session, "release_mutex", Json::Object{{"scope", "session"}, {"nonce", secret}, {"identity", entra}}));
  for (const auto* operation : {"", "Identity", "launch_owned", "stop_owned", "pipe_accept", "startup_register", "account_authority_launch", "installer_launch", "singleton_assert_publication", "runtime_repair_backup_remove"})
    check(!workerDataOperation(Role::session, operation, Json::Object{}));
  check(!workerDataOperation(static_cast<Role>(100), "identity", Json::Object{}));
}
void personalCleanupPolicy() {
  using namespace mmstorerole; using mm::Json;
  const std::string nonce(64, 'a'), id="12345678-1234-4234-8234-123456789012";
  const Json node = Json::Object{{"sid", "S-1-5-21-100-200-300-1001"}, {"session_id", 1}, {"pid", 42}, {"creation_time", "132000000000000001"}};
  const Json birth = Json::Object{{"device", "0"}, {"file_id", "123"}, {"born_at", "1230000000000000000"}};
  auto fingerprint = birth.object(); fingerprint.emplace("bytes", 0); fingerprint.emplace("written_at", "1230000000000000000"); fingerprint.emplace("changed_at", "1230000000000000000");
  const std::string relative="personal\\engine-session\\"+id;
  const Json owner = Json::Object{{"role", "personal"}, {"nonce", nonce}, {"identity", node}};
  const Json recovery = Json::Object{{"cache_nonce", nonce}}, acknowledgement=Json::Object{{"receipt_id", nonce}, {"nonce", nonce}, {"cache_nonce", nonce}};
  std::vector<std::pair<std::string, Json>> valid{
    {"cache_delete_begin", Json::Object{{"request_id", id}, {"relative_path", relative}, {"kind", "directory"}, {"expected", birth}, {"cache_nonce", nonce}}},
    {"cache_delete_begin", Json::Object{{"request_id", id}, {"relative_path", relative+"\\engine-config.json"}, {"kind", "file"}, {"expected", fingerprint}, {"cache_nonce", nonce}}},
    {"storage_partial_discard", Json::Object{{"request_id", id}, {"cache_nonce", nonce}}},
    {"library_artifact_discard", Json::Object{{"request_id", id}, {"relative_path", "library\\media\\audio.wav"}, {"expected", fingerprint}, {"cache_nonce", nonce}}},
    {"library_tree_discard", Json::Object{{"relative_path", "library\\media\\audio"}, {"birth", birth}, {"deletion_id", nullptr}, {"cache_nonce", nonce}}},
    {"library_tree_discard", Json::Object{{"relative_path", "personal\\results\\"+id+"."+id+".deleted"}, {"birth", birth}, {"deletion_id", id}, {"cache_nonce", nonce}}},
    {"storage_workspace_marker_retire", Json::Object{{"relative_path", relative}, {"owner", owner}, {"cache_nonce", nonce}}}
  };
  for (const auto* operation : {"cache_delete_commit", "cache_delete_release"}) valid.emplace_back(operation, Json::Object{{"request_id", id}, {"relative_path", relative}, {"kind", "directory"}, {"nonce", nonce}, {"cache_nonce", nonce}});
  for (const auto* operation : {"cache_delete_recover", "personal_cleanup_recover", "storage_cleanup_recover", "library_tree_cleanup_list"}) valid.emplace_back(operation, recovery);
  for (const auto* operation : {"storage_cleanup_ack", "library_tree_cleanup_ack"}) valid.emplace_back(operation, acknowledgement);
  for (const auto* direction : {"tombstone", "restore"}) valid.emplace_back("library_local_move", Json::Object{{"request_id", id}, {"direction", direction}, {"cache_nonce", nonce}});
  for (const auto* operation : {"library_artifact_publish", "library_artifact_publication_inspect"})
    for (const auto* component : {"media", "metadata"}) valid.emplace_back(operation, Json::Object{{"request_id", id}, {"component", component}, {"cache_nonce", nonce}});
  for (const auto& [operation, args] : valid) {
    for (const auto role : {Role::personal, Role::session, Role::fleet, Role::prepare, Role::login}) check(workerDataOperation(role, operation, args) == (role==Role::personal));
    auto extra=args.object(); extra.emplace("retired", true); check(!workerDataOperation(Role::personal, operation, extra));
    for (const auto& [key, unused] : args.object()) {
      (void)unused; auto absent=args.object(); absent.erase(key); check(!workerDataOperation(Role::personal, operation, absent));
      auto wrong=args.object(); wrong[key]=Json::Array{}; check(!workerDataOperation(Role::personal, operation, wrong));
    }
    auto forged=args.object(); forged["cache_nonce"]="not-held"; check(!workerDataOperation(Role::personal, operation, forged));
    if (args.object().contains("relative_path")) {
      for (const auto* path : {"..\\data", "runtime\\code.exe", "updates\\installer.exe", "vault\\account\\record.dpapi", "C:\\data", "\\\\host\\share", "personal\\jobs\\bad:stream"}) {
        auto wrong=args.object(); wrong["relative_path"]=path; check(!workerDataOperation(Role::personal, operation, wrong));
      }
    }
  }
  for (const auto* operation : {"share_workspace_discard", "diagnostic_report_remove", "runtime_repair_cleanup", "remove_tree", "vault_recover"}) check(!workerDataOperation(Role::personal, operation, recovery));
  auto wrong=valid[6].second.object(); auto stale=owner.object(); stale["role"]="prepare"; wrong["owner"]=stale; check(!workerDataOperation(Role::personal, "storage_workspace_marker_retire", wrong));
}
void fixtureDataPolicy() {
  using namespace mmstorerole; using mm::Json;
  const std::string path="prepare\\approved\\"+std::string(64,'a')+".wav";
  const Json birth=Json::Object{{"device","0"},{"file_id","123"},{"born_at","1230000000000000000"}};
  for (const auto mode : {"create-new","resume"}) {
    const Json args=Json::Object{{"root","personal"},{"relative_path",path},{"mode",mode},{"maximum_bytes",44},{"expected_birth",std::string_view(mode)=="resume"?birth:Json(nullptr)}};
    for (const auto role : {Role::prepare,Role::personal,Role::fleet,Role::session,Role::login}) check(workerDataOperation(role,"store_fixture_file_open",args)==(role==Role::prepare));
    for (const auto& [key,unused] : args.object()) { (void)unused; auto absent=args.object(); absent.erase(key); check(!workerDataOperation(Role::prepare,"store_fixture_file_open",absent)); auto wrong=args.object(); wrong[key]=Json::Array{}; check(!workerDataOperation(Role::prepare,"store_fixture_file_open",wrong)); }
    for (const auto maximum : {0,43,64*1024*1024+1}) { auto wrong=args.object(); wrong["maximum_bytes"]=maximum; check(!workerDataOperation(Role::prepare,"store_fixture_file_open",wrong)); }
    for (const auto* wrongPath : {"prepare\\approved\\bad.wav","prepare\\approved\\..\\file.wav","models\\Kim_Vocal_2.onnx","C:\\input.wav"}) { auto wrong=args.object(); wrong["relative_path"]=wrongPath; check(!workerDataOperation(Role::prepare,"store_fixture_file_open",wrong)); }
    auto wrong=args.object(); wrong["path"]="caller"; check(!workerDataOperation(Role::prepare,"store_fixture_file_open",wrong));
    if (std::string_view(mode)=="resume") check(!workerDataOperation(Role::prepare,"private_file_open",args));
  }
  for (const auto role : {Role::prepare,Role::personal,Role::fleet,Role::session,Role::login})
    for (const auto* operation : {"vault_get","vault_put","vault_delete"}) {
      Json::Object args{{"namespace","account"},{"key","prepare_fixture_"+std::string(48,'a')}};
      if (std::string_view(operation)=="vault_put") args.emplace("bytes_base64","e30=");
      check(workerDataOperation(role,operation,args)==(role==Role::prepare));
      args["key"]="prepare_fixture_"+std::string(47,'a'); check(!workerDataOperation(role,operation,args));
    }
}
void storeSharePolicy() {
  using mm::Json;using namespace mmstoresharepolicy;
  const std::string id="12345678-1234-4234-8234-123456789012",nonce(64,'a');
  const Json identity=Json::Object{{"sid","S-1-5-21-100-200-300-1001"},{"session_id",1},{"pid",42},{"creation_time","123"}};
  const Json args=Json::Object{{"request_id",id},{"window_handle","123"},{"window_owner",identity},{"relative_path","share\\requests\\"+id+"\\media.mp3"},{"sha256",nonce},{"bytes",44},{"title","Arabic صوت"},{"mime","audio/mpeg"}};
  std::vector<std::pair<std::string,Json>> cases{{"store_share_start",args},{"store_share_inspect",Json::Object{{"request_id",id}}},
    {"store_share_cancel",Json::Object{{"request_id",id},{"nonce",nonce}}},{"store_share_cleanup_acknowledge",Json::Object{{"request_id",id},{"nonce",nonce}}},{"store_share_cleanup_completed",Json::Object{}}};
  for(const auto& [name,value]:cases){
    check(operation(name));check(input(name,value));
    for(const auto& [field,unused]:value.object()){(void)unused;auto absent=value.object();absent.erase(field);check(!input(name,absent));auto wrong=value.object();wrong[field]=Json::Array{};check(!input(name,wrong));}
    for(const auto* field:{"app_sha256","publisher_sha256","file_identity","allow_unsigned","job","path","store"}){auto wrong=value.object();wrong[field]=true;check(!input(name,wrong));}
    check(!input(name,Json::Array{}));
  }
  for(const auto* name:{"share_start","STORE_SHARE_START","store_share_start ","store_share_launch","store_share_recover"}){check(!operation(name));check(!input(name,args));}
  for(const auto* path:{"C:\\media.mp3","share\\requests\\wrong\\media.mp3","share\\requests\\..\\media.mp3","runtime\\code.exe"}){auto wrong=args.object();wrong["relative_path"]=path;check(!input("store_share_start",wrong));}
  for(const auto* handle:{"0","0123","-1","1e3","18446744073709551616"}){auto wrong=args.object();wrong["window_handle"]=handle;check(!input("store_share_start",wrong));}
  for(const auto* mime:{"video/mp4","application/zip","audio/wav"}){auto wrong=args.object();wrong["mime"]=mime;check(!input("store_share_start",wrong));}
  auto wrong=args.object();wrong["title"]=std::string(181,'a');check(!input("store_share_start",wrong));wrong=args.object();wrong["title"]="line\nbreak";check(!input("store_share_start",wrong));
  wrong=args.object();wrong["bytes"]=256*1024*1024+1;check(!input("store_share_start",wrong));
}
void brokerPolicy() {
  using namespace mmstorerole;
  using mm::Json;
  const Json node = Json::Object{{"sid", "S-1-12-1-100-200-300-400"}, {"session_id", 1}, {"pid", 42}, {"creation_time", "123"}};
  for (const auto target : {Role::personal, Role::fleet, Role::prepare}) {
    const Json owner = Json::Object{{"role", std::string(roleName(target))}, {"nonce", std::string(64, 'c')}, {"identity", node}};
    const Json launch = Json::Object{{"role", std::string(roleName(target))}};
    const Json stop = Json::Object{{"owner", owner}};
    const Json peer = Json::Object{{"owner", owner}, {"identity", node}};
    for (const auto actor : {Role::session, Role::personal, Role::fleet, Role::prepare, Role::login}) {
      check(brokerOperation(actor, BrokerCommand::launch, launch) == (actor == Role::session));
      check(brokerOperation(actor, BrokerCommand::stop, stop) == (actor == Role::session));
      check(brokerOperation(actor, BrokerCommand::inspect, stop) == (actor == Role::session || actor == target));
      check(brokerOperation(actor, BrokerCommand::peer, peer) == (actor == Role::session || actor == target));
      check(brokerOperation(actor, BrokerCommand::cleanupState, stop) == (actor == Role::personal && target == Role::personal));
    }
    for (const auto command : {BrokerCommand::launch, BrokerCommand::stop, BrokerCommand::inspect, BrokerCommand::peer}) {
      const auto valid = command == BrokerCommand::launch ? launch : command == BrokerCommand::peer ? peer : stop;
      auto unknown = valid.object(); unknown.emplace("path", "C:\\private\\worker.exe");
      check(!brokerOperation(Role::session, command, unknown));
      for (const auto& [field, unused] : valid.object()) {
        (void)unused; auto missing = valid.object(); missing.erase(field);
        check(!brokerOperation(Role::session, command, missing));
        auto wrong = valid.object(); wrong[field] = nullptr;
        check(!brokerOperation(Role::session, command, wrong));
      }
      const auto frame = mm::dump(Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", std::string(64, 'a')},
        {"capability", std::string(64, 'b')}, {"command", std::string(brokerName(command))}, {"args", valid}}) + "\n";
      const auto request = parseRequest(frame);
      check(request.operation == "broker" && parseBrokerCommand(request.command) == command && mm::dump(request.args) == mm::dump(valid));
    }
    if (target == Role::personal) {
      check(parseBrokerCommand("personal-cleanup-state") == BrokerCommand::cleanupState);
      for (const auto& [field, unused] : owner.object()) { (void)unused; auto bad = owner.object(); bad.erase(field); check(!brokerOperation(Role::personal, BrokerCommand::cleanupState, Json::Object{{"owner", bad}})); }
      for (const auto* field : {"job", "retired", "tool_free", "receipt", "path"}) { auto bad = stop.object(); bad[field] = true; check(!brokerOperation(Role::personal, BrokerCommand::cleanupState, bad)); }
      check(!brokerOperation(Role::personal, BrokerCommand::cleanupState, Json::Object{}));
    }
    for (const auto* field : {"role", "nonce", "identity"}) {
      auto corrupt = owner.object(); corrupt[field] = Json::Array{};
      check(!brokerOperation(Role::session, BrokerCommand::inspect, Json::Object{{"owner", corrupt}}));
    }
  }
  for (const auto* role : {"session-agent", "login-worker", "worker-node", "native", "fleet ", "Fleet", "../../prepare"}) {
    check(!brokerOperation(Role::session, BrokerCommand::launch, Json::Object{{"role", role}}));
    const Json owner = Json::Object{{"role", role}, {"nonce", std::string(64, 'c')}, {"identity", node}};
    check(!brokerOperation(Role::session, BrokerCommand::inspect, Json::Object{{"owner", owner}}));
  }
  for (const auto* command : {"", "launch_owned", "shell", "role-launch ", "role-gpu", "ROLE-LAUNCH"}) {
    denied([&] { (void)parseBrokerCommand(command); });
    const auto frame = mm::dump(Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", std::string(64, 'a')},
      {"capability", std::string(64, 'b')}, {"command", command}, {"args", Json::Object{}}}) + "\n";
    denied([&] { (void)parseRequest(frame); });
  }
  const Json gpu = Json::Object{{"source", "DXGI EnumAdapters1/GetDesc1"}, {"deviceIndex", 3}, {"name", "Synthetic adapter"}, {"vendorId", 32902}, {"deviceId", 1234}, {"subsystemId", 5678}, {"revision", 1}, {"driverVersion", "32.0.1.1"}, {"luid", "0000000000000042"}, {"dedicatedVideoMemoryBytes", 0}, {"sharedSystemMemoryLimitBytes", 8000000000LL}};
  const Json acquire = Json::Object{{"gpu", gpu}}, capability = Json::Object{{"luid", "0000000000000042"}, {"nonce", std::string(64, 'a')}};
  for (const auto actor : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
    check(brokerOperation(actor, BrokerCommand::gpuAcquire, acquire) == gpuLeaseRole(actor));
    check(brokerOperation(actor, BrokerCommand::gpuRelease, capability) == gpuLeaseRole(actor));
    check(brokerOperation(actor, BrokerCommand::gpuInspect, capability) == gpuLeaseRole(actor));
  }
  for (const auto command : {BrokerCommand::gpuAcquire, BrokerCommand::gpuRelease, BrokerCommand::gpuInspect}) {
    const auto valid = command == BrokerCommand::gpuAcquire ? acquire : capability;
    const auto frame = mm::dump(Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", std::string(64, 'a')}, {"capability", std::string(64, 'b')}, {"command", std::string(brokerName(command))}, {"args", valid}}) + "\n";
    check(parseBrokerCommand(parseRequest(frame).command) == command);
    auto extra = valid.object(); extra.emplace("job", "caller selected"); check(!brokerOperation(Role::prepare, command, extra));
    for (const auto& [field, unused] : valid.object()) { (void)unused; auto absent = valid.object(); absent.erase(field); check(!brokerOperation(Role::personal, command, absent)); }
  }
  for (const auto& [field, unused] : gpu.object()) { (void)unused; auto absent = gpu.object(); absent.erase(field); check(!storeGpuIdentity(absent)); auto wrong = gpu.object(); wrong[field] = nullptr; check(!storeGpuIdentity(wrong)); }
  for (const auto* driver : {"", "32.0.1", "32.0.1.1.1", "65536.0.1.1", "1e1.0.1.1", "32.-1.1.1", "32.0.1.1\n"}) { auto bad = gpu.object(); bad["driverVersion"] = driver; check(!storeGpuIdentity(bad)); }
  for (const auto ordinal : {-1, 16}) { auto bad = gpu.object(); bad["deviceIndex"] = ordinal; check(!storeGpuIdentity(bad)); }
  for (const auto* luid : {"000000000000004A", "000000000000042", "../gpu", "0000000000000042 "}) { auto bad = capability.object(); bad["luid"] = luid; check(!storeGpuCapability(Role::prepare, bad)); }
  check(!brokerOperation(static_cast<Role>(100), BrokerCommand::launch, Json::Object{{"role", "personal"}}));
  check(!brokerOperation(Role::session, static_cast<BrokerCommand>(100), Json::Object{}));
}
}
int main() {
  try { policy(); dataPolicy(); personalCleanupPolicy(); fixtureDataPolicy(); storeSharePolicy(); storeModelPolicy(); brokerPolicy(); controlPolicy(); childPolicy(); std::cout << "Store role/data/broker receiving policy: " << checks << " checks passed; no OS authority fixture\n"; return 0; }
  catch (...) { std::cerr << "STORE_ROLE_TEST_FAILED check=" << checks << '\n'; return 2; }
}
