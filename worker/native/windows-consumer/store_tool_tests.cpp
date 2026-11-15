#include "store_tool_policy.hpp"
#include "store_role.hpp"
#include "store_capability_policy.hpp"
#include "store_child_handle.hpp"
#include <iomanip>
#include <sstream>
#include <functional>
#include <iostream>
namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_TOOL_POLICY_TEST_FAILED"); }
void denied(const std::function<void()>& operation) { bool rejected = false; try { operation(); } catch (const mmstore::Error& e) { rejected = e.code() == mmstore::ErrorCode::processDenied; } check(rejected); }
std::string nonce(unsigned index) { std::ostringstream stream; stream << std::hex << std::setfill('0') << std::setw(64) << index; return stream.str(); }
void generation() {
  using namespace mmstorerole; using mm::Json;
  const std::string old(64, 'a'), next(64, 'b'), later(64, 'c'), changed(64, 'd');
  HelperCapabilityGeneration generation(old); generation.bind(nonce(1));
  const auto early = generation.rotate(old, nonce(2), next); check(!early.rotated && early.capability == old && early.remaining == 2047);
  denied([&] { (void)generation.rotate(changed, nonce(2), next); });
  for (unsigned index = 2; index <= 2047; ++index) { generation.enterBroker(old, nonce(index)); generation.finishBroker(); }
  generation.enterBroker(old, nonce(2048));
  denied([&] { (void)generation.rotate(old, nonce(2049), next); });
  denied([&] { generation.enterBroker(old, nonce(2050)); });
  generation.finishBroker();
  denied([&] { (void)generation.rotate(old, nonce(1), next); });
  denied([&] { (void)generation.rotate(old, nonce(2049), old); });
  const auto rotated = generation.rotate(old, nonce(2049), next); check(rotated.rotated && rotated.capability == next && rotated.remaining == 2048);
  // The exact lost ACK recovers one privately retained original generation.
  const auto retry = generation.rotate(old, nonce(2049), later); check(retry.capability == next && retry.rotated && generation.current() == next);
  denied([&] { (void)generation.rotate(old, nonce(2050), later); });
  denied([&] { generation.enterBroker(old, nonce(2051)); });
  generation.enterBroker(next, nonce(2051)); generation.finishBroker();
  denied([&] { (void)generation.rotate(old, nonce(2049), later); });
  denied([&] { generation.enterBroker(next, nonce(2051)); });
  check(generation.rotate(next, nonce(2052), later).remaining == 2047);
  for (unsigned index = 2052; index <= 4098; ++index) { generation.enterBroker(next, nonce(index)); generation.finishBroker(); }
  check(generation.rotate(next, nonce(4099), later).capability == later);
  const RotationPeer helper{11,"132000000000000001"}, node{12,"132000000000000002"}, creator{13,"132000000000000003"};
  Json::Object reply{{"version",1},{"accepted",true},{"request_nonce",nonce(2049)},{"rotated",true},{"capability",next},{"remaining",2048},
    {"pid",11},{"creation_time",helper.birth},{"node_pid",12},{"node_creation_time",node.birth},{"creator_pid",13},{"creator_creation_time",creator.birth}};
  const auto parse = [&](const Json& input) { return parseHelperRotationReply(mm::dump(input)+"\n",nonce(2049),old,helper,node,creator); };
  check(parse(reply).capability == next);
  for (const auto& [field, unused] : reply) { (void)unused; auto bad = reply; bad.erase(field); denied([&] { (void)parse(bad); });
    for (const auto& wrong : {Json(nullptr), Json(Json::Array{})}) { bad = reply; bad[field] = wrong; denied([&] { (void)parse(bad); }); } }
  for (const auto* field : {"pid","node_pid","creator_pid"}) { auto bad = reply; bad[field] = 99; denied([&] { (void)parse(bad); }); }
  for (const auto* field : {"creation_time","node_creation_time","creator_creation_time","request_nonce"}) { auto bad = reply; bad[field] = "changed"; denied([&] { (void)parse(bad); }); }
  for (const auto remaining : {-1,0,2047,2049}) { auto bad = reply; bad["remaining"] = remaining; denied([&] { (void)parse(bad); }); }
  auto unchanged = reply; unchanged["rotated"] = false; unchanged["capability"] = old; unchanged["remaining"] = 123; check(!parse(unchanged).rotated);
  auto fakeNext = unchanged; fakeNext["capability"] = next; denied([&] { (void)parse(fakeNext); });
  for (const auto* field : {"ready", "process", "job", "generation"}) { auto bad = reply; bad[field] = true; denied([&] { (void)parse(bad); }); }
  const auto frame = mm::dump(reply)+"\n";
  for (const auto& malformed : {frame+frame, std::string("\xef\xbb\xbf")+frame, frame.substr(0,frame.size()-1), frame.substr(0,frame.size()-1)+"\r\n"})
    denied([&] { (void)parseHelperRotationReply(malformed,nonce(2049),old,helper,node,creator); });
  const auto rotateRequest = mm::dump(Json::Object{{"version",1},{"operation","helper-rotate"},{"request_nonce",nonce(2049)},{"capability",old}})+"\n";
  check(parseRequest(rotateRequest).operation == "helper-rotate");
}
void nodeRotationGrammar() {
  using namespace mmstorerole; using mm::Json;
  const Json::Object request{{"version",1},{"operation","node-rotate"},{"request_nonce",std::string(64,'a')},{"capability",std::string(64,'b')}};
  const auto parsed=parseRequest(mm::dump(request)+"\n"); check(parsed.operation=="node-rotate" && parsed.child==0 && parsed.command.empty());
  for (const auto* extra : {"pid","role","creator_pid","ignore_watch","reset","remaining","owner"}) {
    auto changed=request; changed[extra]=true; bool rejected=false;
    try { (void)parseRequest(mm::dump(changed)+"\n"); } catch (const mmstore::Error& error) { rejected=error.code()==mmstore::ErrorCode::invalidInput; } check(rejected);
  }
}
void policy() {
  using namespace mmstorerole; using mm::Json;
  const std::string id = "12345678-1234-4234-8234-123456789012", incarnation = "22345678-1234-4234-8234-123456789012";
  const std::string sid = "S-1-12-1-100-200-300-400", inventory(64, 'a'), manifest(64, 'b'), helper(64, 'c');
  for (const auto kind : {FixedToolKind::cloudProbeInput, FixedToolKind::cloudTranscode, FixedToolKind::cloudProbeOutput,
      FixedToolKind::silenceProbe, FixedToolKind::silenceDecode, FixedToolKind::doctorMetadata, FixedToolKind::doctorMedia,
      FixedToolKind::downloaderVersion, FixedToolKind::downloaderHelp, FixedToolKind::downloaderEjs, FixedToolKind::denoVersion, FixedToolKind::denoProvider}) {
    const auto name = std::string(fixedToolName(kind)); check(parseFixedTool(name) == kind);
    const auto wire = mm::dump(Json::Object{{"version",1},{"operation","broker"},{"request_nonce",std::string(64,'d')},{"capability",inventory},{"command","tool-start"},{"args",Json::Object{{"kind",name},{"request_id",id},{"incarnation",incarnation},{"configuration_sha256",helper},{"operation_token",inventory}}}})+"\n";
    check(parseRequest(wire).command == "tool-start");
    const Json start = Json::Object{{"kind", name}, {"request_id", id}, {"incarnation", incarnation}, {"configuration_sha256", helper}, {"operation_token", inventory}}, token = Json::Object{{"token", inventory}};
    for (const auto role : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
      check(fixedToolOperation(role, "tool-start", start) == (role == Role::personal || role == Role::prepare));
      for (const auto* operation : {"tool-read", "tool-stop"}) check(fixedToolOperation(role, operation, token) == (role == Role::personal || role == Role::prepare));
    }
    for (const auto& [key, unused] : start.object()) {
      (void)unused; auto bad = start.object(); bad.erase(key); check(!fixedToolOperation(Role::prepare, "tool-start", bad));
      for (const auto& wrong : {Json(nullptr), Json(true), Json(1), Json(Json::Array{})}) { bad = start.object(); bad[key] = wrong; check(!fixedToolOperation(Role::personal, "tool-start", bad)); }
    }
    for (const auto* field : {"executable", "argv", "env", "cwd", "config_path", "owner", "gpu", "ready"}) { auto bad = start.object(); bad[field] = "caller selected"; check(!fixedToolOperation(Role::prepare, "tool-start", bad)); }
    for (const auto* operation : {"tool-write", "execute", "process_spawn", "tool-start ", "TOOL-READ"}) check(!fixedToolOperation(Role::personal, operation, start));
    const bool cloud = kind == FixedToolKind::cloudProbeInput || kind == FixedToolKind::cloudTranscode || kind == FixedToolKind::cloudProbeOutput;
    const bool doctor = kind == FixedToolKind::doctorMetadata || kind == FixedToolKind::doctorMedia;
    Json::Object config{{"version", 1}, {"operation", cloud ? "cloud_prepare" : silenceTool(kind) ? "silence_analyze" : doctor ? "diagnostics_doctor" : "browser_check_youtube"},
      {"requestId", id}, {"executionId", incarnation}, {"release", inventory}, {"sid", sid}, {"manifestSha256", manifest}, {"helperSha256", helper}};
    if (cloud || silenceTool(kind)) config["inputBytes"] = 256LL * 1024 * 1024;
    if (silenceTool(kind)) { config["inputSha256"] = std::string(64, 'd'); config["durationSeconds"] = Json::Decimal{"123.25"}; }
    check(fixedToolConfiguration(kind, config, id, sid, inventory, manifest, helper));
    check(fixedToolWork(kind, id) == std::string(silenceTool(kind) ? "prepare\\work\\" : "cloud\\work\\") + id);
    for (const auto& [key, unused] : config) {
      (void)unused; auto bad = config; bad.erase(key); check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper));
      for (const auto& wrong : {Json(nullptr), Json(true), Json(Json::Array{})}) { bad = config; bad[key] = wrong; check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper)); }
    }
    for (const auto* field : {"model", "gpu", "path", "command", "environment", "script", "receipt"}) { auto bad = config; bad[field] = "caller selected"; check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper)); }
    for (const auto* field : {"release", "manifestSha256", "helperSha256", "requestId", "executionId", "sid"}) { auto bad = config; bad[field] = "../replacement"; check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper)); }
    if (cloud || silenceTool(kind)) for (const auto count : {0LL, -1LL, 268435457LL}) { auto bad = config; bad["inputBytes"] = count; check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper)); }
    if (silenceTool(kind)) for (const auto* duration : {"0.0", "-1.5", "7200.001", "1e999", "NaN", "1.2junk"}) { auto bad = config; bad["durationSeconds"] = Json::Decimal{duration}; check(!fixedToolConfiguration(kind, bad, id, sid, inventory, manifest, helper)); }
    if (cloud) { auto probe = config; probe["operation"] = "cloud_probe"; check(fixedToolConfiguration(kind, probe, id, sid, inventory, manifest, helper) == (kind == FixedToolKind::cloudProbeInput)); }
    check(fixedToolLaunch(kind) != mmstoreruntime::LaunchKind::personalEngine && fixedToolLaunch(kind) != mmstoreruntime::LaunchKind::qualification);
  }
  for (const auto* name : {"", "ffmpeg", "shell", "cloud-transcode ", "DENO-PROVIDER", "downloader", "../tool"}) {
    bool rejected = false; try { (void)parseFixedTool(name); } catch (const mmstore::Error&) { rejected = true; } check(rejected);
  }
}
void qualificationPolicy() {
  using namespace mmstorerole; using mm::Json;
  const std::string id = "12345678-1234-4234-8234-123456789012", token(64, 'a');
  const Json start = Json::Object{{"incarnation", id}}, capability = Json::Object{{"token", token}};
  for (const auto actor : {Role::session, Role::login, Role::personal, Role::fleet, Role::prepare}) {
    check(qualificationOperation(actor, "qualification-start", start) == (actor == Role::prepare));
    check(brokerOperation(actor, BrokerCommand::qualificationStart, start) == (actor == Role::prepare));
    for (const auto command : {BrokerCommand::qualificationRead, BrokerCommand::qualificationStop}) {
      check(qualificationOperation(actor, brokerName(command), capability) == (actor == Role::prepare));
      check(brokerOperation(actor, command, capability) == (actor == Role::prepare));
    }
  }
  check(cleanupBrokerOperation(Role::prepare, BrokerCommand::qualificationStop, capability));
  check(!cleanupBrokerOperation(Role::prepare, BrokerCommand::qualificationRead, capability));
  check(!cleanupBrokerOperation(Role::prepare, BrokerCommand::qualificationStart, start));
  for (const auto command : {BrokerCommand::qualificationStart, BrokerCommand::qualificationRead, BrokerCommand::qualificationStop}) {
    const Json expected = command == BrokerCommand::qualificationStart ? start : capability;
    check(parseBrokerCommand(brokerName(command)) == command);
    const auto wire = mm::dump(Json::Object{{"version", 1}, {"operation", "broker"}, {"request_nonce", token}, {"capability", token}, {"command", std::string(brokerName(command))}, {"args", expected}}) + "\n";
    check(parseRequest(wire).command == brokerName(command));
    check(!brokerOperation(Role::prepare, command, Json::Object{}));
    for (const auto* extra : {"path", "argv", "gpu", "model", "fixture", "config", "recipe", "quality", "ready", "job", "ignore_watch"}) {
      auto bad = expected.object(); bad[extra] = true; check(!brokerOperation(Role::prepare, command, bad));
    }
    const auto key = command == BrokerCommand::qualificationStart ? "incarnation" : "token";
    for (const auto& invalid : {Json(nullptr), Json(true), Json(1), Json("../caller"), Json(Json::Array{})}) {
      auto bad = expected.object(); bad[key] = invalid; check(!brokerOperation(Role::prepare, command, bad));
    }
  }
  for (const auto* operation : {"qualification-write", "qualification_start", "qualification-start ", "QUALIFICATION-STOP", "process_spawn"}) check(!qualificationOperation(Role::prepare, operation, start));
  check(qualificationFixtureBytes == 1058444 && mmstore::validDigest(qualificationFixtureSha256));
}
void cpuOperationReceiving() {
  using namespace mmstorerole; using mm::Json;
  const std::string id="01234567-89ab-4def-8123-456789abcdef", incarnation="11234567-89ab-4def-8123-456789abcdef", digest(64,'a');
  const Json identity = Json::Object{{"sid","S-1-5-21-1-2-3-1001"},{"sessionId",1},{"pid",123},{"creationTime","132000000000000001"}};
  for (const auto* operation : {"cloud_prepare","cloud_probe","silence_analyze","diagnostics_doctor","browser_check_youtube"}) {
    for (const auto role : {Role::personal,Role::prepare}) {
      const Json expected=Json::Object{{"version",1},{"distribution","microsoft-store"},{"kind","cpu-tools"},{"requestId",id},{"incarnation",incarnation},{"operation",operation},
        {"configurationSha256",digest},{"inventorySha256",digest},{"runtimeManifestSha256",digest},{"nodeOwner",Json::Object{{"role",std::string(roleName(role))},{"nonce",digest},{"identity",identity}}},{"token",digest}};
      check(cpuOperationExpectation(expected));
      const Json open=Json::Object{{"request_id",id},{"incarnation",incarnation},{"operation",operation},{"configuration_sha256",digest}};
      const Json inspect=Json::Object{{"token",digest},{"expectation",expected}}, token=Json::Object{{"token",digest}};
      const Json forget=Json::Object{{"expectation",expected},{"request_id",id}};
      for (const auto actor : {Role::personal,Role::prepare,Role::session,Role::fleet,Role::login}) {
        const bool admitted=actor==Role::personal||actor==Role::prepare;
        for (const auto command : {BrokerCommand::cpuOpen,BrokerCommand::cpuRecover}) check(brokerOperation(actor,command,open)==admitted);
        for (const auto command : {BrokerCommand::cpuBindData,BrokerCommand::cpuRetire}) check(brokerOperation(actor,command,token)==admitted);
        check(brokerOperation(actor,BrokerCommand::cpuInspect,inspect)==admitted);
        check(brokerOperation(actor,BrokerCommand::cpuForget,forget)==(actor==role));
        check(brokerOperation(actor,BrokerCommand::cpuRelease,forget)==(actor==role));
      }
      // Exercise the actual Creator wire parser, not just dispatch grammar.
      // The former allowlist omitted the CPU names and denied every real call.
      for (const auto& [command,args] : std::vector<std::pair<BrokerCommand,Json>>{{BrokerCommand::cpuOpen,open},{BrokerCommand::cpuRecover,open},
          {BrokerCommand::cpuBindData,token},{BrokerCommand::cpuInspect,inspect},{BrokerCommand::cpuRetire,token},{BrokerCommand::cpuForget,forget},{BrokerCommand::cpuRelease,forget}}) {
        const auto wire=mm::dump(Json::Object{{"version",1},{"operation","broker"},{"request_nonce",std::string(64,'b')},{"capability",digest},
          {"command",std::string(brokerName(command))},{"args",args}})+"\n";
        check(parseRequest(wire).command==brokerName(command));
      }
      for (const auto& [key,unused] : expected.object()) { (void)unused; auto missing=expected.object(); missing.erase(key); check(!cpuOperationExpectation(missing));
        for (const auto& wrong : {Json(nullptr),Json(true),Json(Json::Array{})}) {auto bad=expected.object();bad[key]=wrong;check(!cpuOperationExpectation(bad));}}
      const auto relative=std::string(std::string_view(operation)=="silence_analyze"?"prepare\\work\\":"cloud\\work\\")+id;
      const Json cleanup=Json::Object{{"relative_path",relative},{"expectation",expected},{"cache_nonce",digest}};
      for (const auto actor : {Role::personal,Role::prepare,Role::session,Role::fleet,Role::login}) check(workerDataOperation(actor,"store_cpu_workspace_marker_retire",cleanup)==(actor==role));
      for (const auto* path : {"C:\\data","cloud\\work\\..\\file","personal\\engine-session\\01234567-89ab-4def-8123-456789abcdef"}) { auto bad=cleanup.object();bad["relative_path"]=path;check(!workerDataOperation(role,"store_cpu_workspace_marker_retire",bad)); }
      const Json observe=Json::Object{{"expectation",expected}}, ack=Json::Object{{"receipt_id",digest},{"nonce",digest},{"expectation",expected},{"cache_nonce",digest}};
      auto release=ack.object();release["ack_nonce"]=digest;
      for (const auto actor : {Role::personal,Role::prepare,Role::session,Role::fleet,Role::login}) {
        check(workerDataOperation(actor,"store_cpu_operation_cleanup_inspect",observe)==(actor==role));
        check(workerDataOperation(actor,"store_cpu_workspace_marker_acknowledge",ack)==(actor==role));
        check(workerDataOperation(actor,"store_cpu_workspace_marker_release",release)==(actor==role));
      }
      for (const auto& [opcode,input] : std::vector<std::pair<std::string,Json>>{{"store_cpu_operation_cleanup_inspect",observe},{"store_cpu_workspace_marker_acknowledge",ack},{"store_cpu_workspace_marker_release",release},{"store_cpu_workspace_marker_retire",cleanup}}) {
        for (const auto& [key,unused] : input.object()) { (void)unused; auto absent=input.object();absent.erase(key);check(!workerDataOperation(role,opcode,absent));auto malformed=input.object();malformed[key]=Json::Array{};check(!workerDataOperation(role,opcode,malformed)); }
        auto fake=input.object();fake["retired"]=true;check(!workerDataOperation(role,opcode,fake));
      }
      auto bad=cleanup.object();bad["retired"]=true;check(!workerDataOperation(role,"store_cpu_workspace_marker_retire",bad));
      bad=inspect.object();bad["token"]=std::string(64,'b');check(!brokerOperation(role,BrokerCommand::cpuInspect,bad));
      auto extra=expected.object();extra["ready"]=true;check(!cpuOperationExpectation(extra));
      const Json gui=Json::Object{{"version",1},{"requestId",id},{"action","cpu_operation_inspect"},{"expectation",expected}};check(storeSessionCommand(gui));
      auto forged=gui.object();forged["creator_pid"]=1;check(!storeSessionCommand(forged));
      auto internal=gui.object();internal["action"]="cpu_operation_forget";
      check(!storeSessionCommand(internal) && storeCpuForgetCommand(internal) && storeCreatorGuiCommand(internal) && cleanupGuiCommand(internal));
      auto released=internal;released["action"]="cpu_operation_release";
      check(!storeSessionCommand(released) && storeCpuForgetCommand(released) && storeCreatorGuiCommand(released) && cleanupGuiCommand(released));
      for (const auto* field : {"retired","reservation_removed","receipt","creator_pid","capability","token"}) {
        auto forgedField=internal;forgedField[field]=true;check(!storeCpuForgetCommand(forgedField));
        auto malformed=forget.object();malformed[field]=true;check(!brokerOperation(role,BrokerCommand::cpuForget,malformed));
      }
      for (const auto& [field,unused] : internal) { (void)unused;auto missingField=internal;missingField.erase(field);check(!storeCpuForgetCommand(missingField)); }
      check(!cleanupGuiCommand(Json::Object{{"version",1},{"requestId",id},{"action","cpu_operation_reset"},{"expectation",expected}}));
    }
  }
  for (const auto* operation : {"cpu-operation-open ","CPU-OPERATION-OPEN","process_spawn","execute","cpu-operation-reset"}) check(!cpuOperationPolicy(Role::personal,operation,Json::Object{}));
}

void cpuCompletionRecovery() {
  using namespace mmstorerole; using mm::Json;
  const std::string request="01234567-89ab-4def-8123-456789abcdef", other="11234567-89ab-4def-8123-456789abcdef", digest(64,'a');
  const Json identity=Json::Object{{"sid","S-1-12-1-1-2-3-4"},{"sessionId",1},{"pid",123},{"creationTime","132000000000000001"}};
  const Json base=Json::Object{{"version",1},{"distribution","microsoft-store"},{"kind","cpu-tools"},{"requestId",request},{"incarnation",other},
    {"operation","cloud_probe"},{"configurationSha256",digest},{"inventorySha256",digest},{"runtimeManifestSha256",digest},{"token",digest},
    {"nodeOwner",Json::Object{{"role","personal"},{"nonce",digest},{"identity",identity}}}};
  CpuForgetCompletions records;
  check(!records.completed(base,request)); records.begin(base,request); check(!records.completed(base,request));
  denied([&]{records.release(base,request);}); denied([&]{(void)records.completed(base,other);}); denied([&]{records.begin(base,other);});
  records.finish(base,request); check(records.completed(base,request));
  // B cannot overwrite the exact lost A response. Both original request IDs
  // remain independently recoverable until the actual SDK release handshake.
  auto second=base.object(); second["token"]=nonce(2); records.begin(second,other); records.finish(second,other);
  check(records.completed(base,request) && records.completed(second,other));
  denied([&]{records.release(second,request);}); records.release(second,other); check(!records.completed(second,other) && records.completed(base,request));
  records.release(second,other); check(!records.completed(second,other));
  for (unsigned index=2;index<=256;++index) {auto row=base.object();row["token"]=nonce(index);records.begin(row,request);records.finish(row,request);}
  auto extra=base.object();extra["token"]=nonce(257);denied([&]{records.begin(extra,request);});
  check(records.completed(base,request)); records.release(base,request); records.begin(extra,request); check(!records.completed(extra,request));
  denied([&]{records.release(extra,request);});
  for (const auto* field:{"retired","receipt","ack_nonce"}) {auto wrong=base.object();wrong[field]=true;denied([&]{records.begin(wrong,request);});}
  denied([&]{records.begin(base,"not-a-request");});
}

void ownedHandleClosure() {
#ifdef _WIN32
  HANDLE owned = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  check(owned && owned != INVALID_HANDLE_VALUE);
  const auto original = owned;
  check(SetHandleInformation(owned, HANDLE_FLAG_PROTECT_FROM_CLOSE, HANDLE_FLAG_PROTECT_FROM_CLOSE) != FALSE);
  denied([&] { mmstorechild::closeOwned(owned); });
  check(owned == original && WaitForSingleObject(owned, 0) == WAIT_TIMEOUT);
  check(SetHandleInformation(owned, HANDLE_FLAG_PROTECT_FROM_CLOSE, 0) != FALSE);
  mmstorechild::closeOwned(owned); check(owned == nullptr);
  mmstorechild::closeOwned(owned); check(owned == nullptr);
#endif
}

void guiCpuReceiving() {
  using namespace mmstorerole; using mm::Json;
  const std::string id="12345678-1234-4234-8234-123456789012", other="22345678-1234-4234-8234-123456789012", digest(64,'a'), sid="S-1-12-1-1-2-3-4";
  const Json binding=Json::Object{{"package",Json::Object{{"identityName","Worker"},{"publisher","CN=Publisher"},{"publisherId","publisher"},
    {"familyName","Worker_publisher"},{"fullName","Worker_1.0.0.0_x64__publisher"},{"packageVersion","1.0.0.0"},{"architecture","x64"},
    {"signatureKind",static_cast<std::int64_t>(mmstoreprofile::signatureKind)},{"healthy",true},{"current",true},{"installedLocation","C:\\Program Files\\WindowsApps\\Worker_1.0.0.0_x64__publisher"}}},
    {"inventorySha256",digest},{"runtimeManifestSha256",digest},{"sid",sid},{"bootIdentity",digest},
    {"recipeDigests",Json::Object{{"kim-vocals-v2",digest},{"kim-vocals-v2-trim",digest}}}};
  const Json owner=Json::Object{{"role","prepare"},{"nonce",digest},{"identity",Json::Object{{"sid",sid},{"sessionId",1},{"pid",123},{"creationTime","132000000000000001"}}}};
  const Json launch=Json::Object{{"version",1},{"requestId",id},{"owner",owner},{"inventorySha256",digest}};
  for (const auto* operation:{"cloud_prepare","cloud_probe","silence_analyze","diagnostics_doctor","browser_check_youtube"}) {
    Json::Object config{{"version",1},{"operation",operation},{"requestId",id},{"executionId",other},{"release",digest},{"sid",sid},{"manifestSha256",digest},{"helperSha256",digest}};
    if (std::string_view(operation)=="cloud_prepare" || std::string_view(operation)=="cloud_probe" || std::string_view(operation)=="silence_analyze") config.emplace("inputBytes",1024);
    if (std::string_view(operation)=="silence_analyze") { config.emplace("inputSha256",digest);config.emplace("durationSeconds",Json::Decimal{"12.5"}); }
    const Json request=Json::Object{{"version",1},{"requestId",id},{"binding",binding},{"configuration",config}};
    check(storeCpuMediaRequest(request));
    for (const auto* action:{"cpu_launch","cpu_recover","cpu_ready","cpu_start","cpu_wait","cpu_cancel"}) {
      const bool initial=std::string_view(action)=="cpu_launch" || std::string_view(action)=="cpu_recover";
      const Json command=Json::Object{{"version",1},{"requestId",id},{"action",action},{initial?"request":"launch",initial?encodeStoreCpuMediaRequest(request):launch}};
      check(storeGuiCpuCommand(command) && storeSessionCommand(command));
      check(storeGuiCpuLargeFrame(command)==initial);
      check(cleanupGuiCommand(command)==(std::string_view(action)=="cpu_recover" || std::string_view(action)=="cpu_cancel"));
      for (const auto& [field,unused]:command.object()) { (void)unused;auto bad=command.object();bad.erase(field);check(!storeGuiCpuCommand(bad));bad=command.object();bad[field]=Json::Array{};check(!storeGuiCpuCommand(bad)); }
      for (const auto* field:{"gpu","model","creator_pid","exe","args","env","receipt","ready","configuration"}) {auto bad=command.object();bad[field]=true;check(!storeGuiCpuCommand(bad));}
      auto wrong=command.object();wrong["requestId"]=other;check(!storeGuiCpuCommand(wrong));check(!storeGuiCpuLargeFrame(wrong));
    }
    const auto carrier=encodeStoreCpuMediaRequest(request);
    const auto strictOuter=mm::JsonParser(mm::dump(carrier)).parse();
    check(mm::dump(decodeStoreCpuMediaRequest(strictOuter))==mm::dump(request));
    check(!storeGuiCpuCommand(Json::Object{{"version",1},{"requestId",id},{"action","cpu_launch"},{"request",request}}));
    for (const auto* malformed:{"{}","{\"durationSeconds\":12.5,\"durationSeconds\":13}","{\"durationSeconds\":NaN}","[]","\xef\xbb\xbf{}"}) {
      auto bad=carrier.object();bad["configuration_json"]=malformed;
      check(!storeGuiCpuCommand(Json::Object{{"version",1},{"requestId",id},{"action","cpu_launch"},{"request",bad}}));
    }
    auto oversize=carrier.object();oversize["configuration_json"]=std::string(8193,' ');check(!storeGuiCpuCommand(Json::Object{{"version",1},{"requestId",id},{"action","cpu_launch"},{"request",oversize}}));
    for (const auto& [field,unused]:config) { (void)unused;auto bad=request.object();auto broken=config;broken.erase(field);bad["configuration"]=broken;check(!storeCpuMediaRequest(bad)); }
    for (const auto* field:{"exe","argv","env","codeRoot","model","gpu","ready"}) {auto bad=request.object();auto broken=config;broken[field]=true;bad["configuration"]=broken;check(!storeCpuMediaRequest(bad));}
    const Json expectation=Json::Object{{"version",1},{"distribution","microsoft-store"},{"kind","cpu-tools"},{"requestId",id},{"incarnation",other},{"operation",operation},
      {"configurationSha256",digest},{"inventorySha256",digest},{"runtimeManifestSha256",digest},{"nodeOwner",owner},{"token",digest}};
    const Json ready=Json::Object{{"requestId",id},{"expectation",expectation}}, success=Json::Object{{"requestId",id},{"bytes",1024},{"sha256",digest}}, empty=Json::Object{};
    for (const auto actor:{Role::session,Role::prepare,Role::personal,Role::fleet,Role::login}) {
      check(brokerOperation(actor,BrokerCommand::cpuPrepareRequest,empty)==(actor==Role::prepare));
      check(brokerOperation(actor,BrokerCommand::cpuPrepareReady,ready)==(actor==Role::prepare));
      check(brokerOperation(actor,BrokerCommand::cpuPrepareStart,empty)==(actor==Role::prepare));
      check(brokerOperation(actor,BrokerCommand::cpuPrepareResult,success)==(actor==Role::prepare));
    }
    for (const auto& [command,args]:std::vector<std::pair<BrokerCommand,Json>>{{BrokerCommand::cpuPrepareRequest,empty},{BrokerCommand::cpuPrepareReady,ready},{BrokerCommand::cpuPrepareStart,empty},{BrokerCommand::cpuPrepareResult,success}}) {
      const auto wire=mm::dump(Json::Object{{"version",1},{"operation","broker"},{"request_nonce",digest},{"capability",digest},{"command",std::string(brokerName(command))},{"args",args}})+"\n";
      check(parseRequest(wire).command==brokerName(command));
      auto extra=args.object();extra["ready"]=true;check(!brokerOperation(Role::prepare,command,extra));
    }
    for (const auto& [field,unused]:binding.object()) { (void)unused;auto bad=request.object();auto broken=binding.object();broken.erase(field);bad["binding"]=broken;check(!storeCpuMediaRequest(bad)); }
    for (const auto* sidValue:{"S-1-5-18","S-1-12-1-1-2-3","caller"}) {auto bad=request.object();auto broken=binding.object();broken["sid"]=sidValue;bad["binding"]=broken;check(!storeCpuMediaRequest(bad));}
    auto wrong=ready.object();wrong["requestId"]=other;check(!storeCpuPrepareReady(wrong));
    auto changed=expectation.object();auto unrelated=owner.object();unrelated["role"]="personal";changed["nodeOwner"]=unrelated;wrong=ready.object();wrong["expectation"]=changed;check(!storeCpuPrepareReady(wrong));
    for (const auto size:{0,1,1048577}) {auto bad=success.object();bad["bytes"]=size;check(!storeCpuPrepareResult(bad));}
    for (const auto* error:{"GPU_UNSUPPORTED","INTEGRITY_INVALID","PERMISSION_DENIED","BUSY","PREPARE_INTERRUPTED","OPERATION_FAILED","NATIVE_HELPER_UNAVAILABLE"}) check(storeCpuPrepareResult(Json::Object{{"requestId",id},{"errorCode",error}}));
    check(!storeCpuPrepareResult(Json::Object{{"requestId",id},{"errorCode","ready"}}));
  }
}
void guiBenchmarkFrames() {
  using namespace mmstorerole; using mm::Json;
  const std::string id="12345678-1234-4234-8234-123456789012", other="22345678-1234-4234-8234-123456789012", digest(64,'a'), sid="S-1-12-1-1-2-3-4";
  const Json binding=Json::Object{{"package",Json::Object{{"identityName","Worker"},{"publisher","CN=Publisher"},{"publisherId","publisher"},
    {"familyName","Worker_publisher"},{"fullName","Worker_1.0.0.0_x64__publisher"},{"packageVersion","1.0.0.0"},{"architecture","x64"},
    {"signatureKind",static_cast<std::int64_t>(mmstoreprofile::signatureKind)},{"healthy",true},{"current",true},{"installedLocation","C:\\Program Files\\WindowsApps\\"+std::string(4600,'x')}}},
    {"inventorySha256",digest},{"runtimeManifestSha256",digest},{"sid",sid},{"bootIdentity",digest},
    {"recipeDigests",Json::Object{{"kim-vocals-v2",digest},{"kim-vocals-v2-trim",digest}}}};
  const Json gpu=Json::Object{{"source","DXGI EnumAdapters1/GetDesc1"},{"deviceIndex",0},{"name","Synthetic adapter"},{"vendorId",4098},{"deviceId",1234},{"subsystemId",5678},{"revision",1},{"driverVersion","31.0.1.1"},{"luid","0000000000000042"},{"dedicatedVideoMemoryBytes",8000000000LL},{"sharedSystemMemoryLimitBytes",8000000000LL}};
  const Json owner=Json::Object{{"role","prepare"},{"nonce",digest},{"identity",Json::Object{{"sid",sid},{"sessionId",1},{"pid",123},{"creationTime","132000000000000001"}}}};
  const Json launch=Json::Object{{"version",1},{"requestId",id},{"owner",owner},{"inventorySha256",digest}};
  for (const auto* operation:{"benchmark_file","benchmark_capacity"}) {
    const bool capacity=std::string_view(operation)=="benchmark_capacity";
    const Json config=Json::Object{{"bootIdentity",digest},{"version",1},{"operation",operation},{"requestId",id},{"release",digest},{"sid",sid},
      {"manifestSha256",digest},{"helperSha256",digest},{"gpu",gpu},
      {"fixture",Json::Object{{"relativePath",capacity?"prepare\\approved\\"+digest+".wav":"prepare\\work\\"+id+"\\source.wav"},{"sha256",digest},{"bytes",64}}},
      {"recipe",capacity?"kim-vocals-v2":"kim-vocals-v2-trim"},{"warmupRuns",1},{"measuredRuns",3}};
    const Json request=Json::Object{{"version",1},{"requestId",id},{"operation",operation},{"binding",binding},{"configuration_json",mm::dump(config)}};
    for (const auto* action:{"benchmark_launch","benchmark_recover","benchmark_wait","benchmark_cancel"}) {
      const bool initial=std::string_view(action)=="benchmark_launch" || std::string_view(action)=="benchmark_recover";
      const Json command=Json::Object{{"version",1},{"requestId",id},{"action",action},{initial?"request":"launch",initial?request:launch}};
      check(storeGuiBenchmarkCommand(command) && storeSessionCommand(command));
      check(storeGuiBenchmarkLargeFrame(command)==initial);
      check(!storeGuiCpuLargeFrame(command));
      auto wrong=command.object();wrong["requestId"]=other;check(!storeGuiBenchmarkLargeFrame(wrong));
      for(const auto* extra:{"ready","executable","env","model","cpu"}) {auto bad=command.object();bad[extra]=true;check(!storeGuiBenchmarkLargeFrame(bad));}
      const auto wire=mm::dump(Json::Object{{"version",1},{"operation","gui-session"},{"request_nonce",digest},{"capability",digest},{"command",command}})+"\n";
      check(wire.size()<=32768);
      if(initial) check(wire.size()>4096);
      check(parseRequest(wire).operation=="gui-session");
    }
    for(const auto* broken:{"{}","[]","{\"version\":1,\"version\":1}","{\"warmupRuns\":NaN}"}) {
      auto bad=request.object();bad["configuration_json"]=broken;
      check(!storeGuiBenchmarkLargeFrame(Json::Object{{"version",1},{"requestId",id},{"action","benchmark_launch"},{"request",bad}}));
    }
    auto oversize=request.object();oversize["configuration_json"]=std::string(16385,' ');
    check(!storeGuiBenchmarkLargeFrame(Json::Object{{"version",1},{"requestId",id},{"action","benchmark_launch"},{"request",oversize}}));
  }
}
void guardianStartupExitPolicy() {
  using namespace mmstorerole;
  for (const auto kind:{GuardianKind::job,GuardianKind::gpu,GuardianKind::watchdog}) for (const bool unresumed:{false,true}) for (const bool aborted:{false,true}) {
    check(guardianRetirementExit(kind,unresumed,aborted,0));
    check(guardianRetirementExit(kind,unresumed,aborted,2)==(kind==GuardianKind::job && unresumed && aborted));
    for (const auto exit:{1u,3u,259u,0xffffffffu}) check(!guardianRetirementExit(kind,unresumed,aborted,exit));
  }
}
void fleetControlRouting() {
  using namespace mmstorerole; using mm::Json;
  const std::string id="12345678-1234-4234-8234-123456789012";
  const Json owner=Json::Object{{"role","fleet"},{"nonce",std::string(64,'a')},{"identity",Json::Object{{"sid","S-1-12-1-100-200-300-400"},{"session_id",1},{"pid",123},{"creation_time","132000000000000001"}}}};
  const Json request=Json::Object{{"requestId",id},{"target","fleet"},{"payload_base64","e30="},{"expected_target",owner}};
  for (const auto actor:{Role::session,Role::personal,Role::fleet,Role::prepare,Role::login}) check(controlRequest(actor,request)==(actor==Role::session));
  for (const auto* action:{"reconcile","stop","sleep","inference_proof","intent","admission_pending","guard_acquire","guard_release"}) {
    Json::Object payload{{"version",1},{"requestId",id},{"action",action}};
    if(std::string_view(action)=="intent") payload["intent"]="running";
    if(std::string_view(action)=="admission_pending") payload["pending"]=false;
    if(std::string_view(action)=="guard_acquire") payload["gpuLuid"]=std::string(16,'a');
    if(std::string_view(action)=="guard_release") payload["guardNonce"]=std::string(64,'a');
    check(controlPayload(Role::session,Role::fleet,false,payload));
    for(const auto actor:{Role::personal,Role::fleet,Role::prepare,Role::login}) check(!controlPayload(actor,Role::fleet,false,payload));
    check(!controlPayload(Role::session,Role::fleet,true,payload));
    for(const auto* extra:{"owner","path","argv","ready","reset"}) {auto bad=payload;bad[extra]=true;check(!controlPayload(Role::session,Role::fleet,false,bad));}
  }
  auto wrong=request.object();auto personal=owner.object();personal["role"]="personal";wrong["expected_target"]=personal;check(!controlRequest(Role::session,wrong));
  wrong=request.object();wrong.erase("expected_target");check(!controlRequest(Role::session,wrong));
  const Json publicIdentity=Json::Object{{"sid","S-1-12-1-100-200-300-400"},{"sessionId",1},{"pid",123},{"creationTime","132000000000000001"}};
  const Json publicOwner=Json::Object{{"role","fleet"},{"nonce",std::string(64,'a')},{"identity",publicIdentity}};
  for(const auto* action:{"fleet_owner","fleet_peer"}) {
    Json::Object command{{"version",1},{"requestId",id},{"action",action}};
    if(std::string_view(action)=="fleet_peer") {command["owner"]=publicOwner;command["identity"]=publicIdentity;}
    check(storeSessionCommand(command)); check(!cleanupGuiCommand(command));
    for(const auto& [key,unused]:command) {(void)unused;auto bad=command;bad.erase(key);check(!storeSessionCommand(bad));bad=command;bad[key]=true;check(!storeSessionCommand(bad));}
    auto extra=command;extra["ready"]=true;check(!storeSessionCommand(extra));
  }
}
void fleetEngineReceiving() {
  using namespace mmstorerole;using mm::Json;
  const std::string id="12345678-1234-4234-8234-123456789012", token(64,'a'), personal="C:\\Users\\fixture\\MusicMuteLocal", fleet="C:\\Users\\fixture\\MusicMuteWorker", worker="C:\\Program Files\\WindowsApps\\fixture\\worker",sid="S-1-12-1-100-200-300-400";
  const Json gpu=Json::Object{{"source","DXGI EnumAdapters1/GetDesc1"},{"deviceIndex",3},{"name","Synthetic adapter"},{"vendorId",32902},{"deviceId",1234},{"subsystemId",5678},{"revision",1},{"driverVersion","32.0.1.1"},{"luid","0000000000000042"},{"dedicatedVideoMemoryBytes",0},{"sharedSystemMemoryLimitBytes",8000000000LL}};
  const std::string relative="fleet\\engine-session\\"+id+"\\engine-config.json";
  const Json start=Json::Object{{"config_relative",relative},{"incarnation",id}}, config=Json::Object{{"version",1},{"sessionId",id},{"sessionRoot",personal+"\\fleet\\engine-session\\"+id},{"jobsRoot",fleet+"\\work"},{"releaseRoot",worker},{"modelPath",personal+"\\models\\Kim_Vocal_2.onnx"},{"sid",sid},{"gpuIdentity",gpu}};
  check(engineSessionId(relative,Role::fleet)==id);
  check(fleetEngineConfig(config,id,personal,fleet,worker,sid,gpu));
  for(const auto actor:{Role::session,Role::personal,Role::fleet,Role::prepare,Role::login}) check(childOperation(actor,"child-start",start)==(actor==Role::fleet));
  for(const auto& [key,unused]:config.object()) {(void)unused;auto bad=config.object();bad.erase(key);check(!fleetEngineConfig(bad,id,personal,fleet,worker,sid,gpu));bad=config.object();bad[key]=nullptr;check(!fleetEngineConfig(bad,id,personal,fleet,worker,sid,gpu));}
  for(const auto* key:{"sessionRoot","jobsRoot","releaseRoot","modelPath","sid","sessionId"}) {auto bad=config.object();bad[key]="C:\\caller";check(!fleetEngineConfig(bad,id,personal,fleet,worker,sid,gpu));}
  for(const auto* key:{"argv","environment","executable","ready","cpu","keeper"}) {auto bad=config.object();bad[key]=true;check(!fleetEngineConfig(bad,id,personal,fleet,worker,sid,gpu));}
  auto changed=gpu.object();changed["deviceIndex"]=2;check(!fleetEngineConfig(config,id,personal,fleet,worker,sid,changed));
  check(!personalEngineConfig(config,id,personal,worker,sid,gpu));
  check(childOperation(Role::fleet,"child-read",Json::Object{{"token",token}}));
}

}
int main() { try { policy(); generation(); nodeRotationGrammar(); qualificationPolicy(); cpuOperationReceiving(); cpuCompletionRecovery(); guiCpuReceiving(); guiBenchmarkFrames(); ownedHandleClosure(); guardianStartupExitPolicy(); fleetControlRouting(); fleetEngineReceiving(); std::cout << "Store fixed CPU/qualification receiving and own-handle cleanup: " << checks << " checks passed; no Store launch/GPU authority fixture\n"; return 0; }
  catch (...) { std::cerr << "STORE_TOOL_POLICY_TEST_FAILED\n"; return 1; } }
