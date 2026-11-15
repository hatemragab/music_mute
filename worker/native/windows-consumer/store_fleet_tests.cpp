#include "store_broker_policy.hpp"
#include <iostream>
#include <stdexcept>
using mm::Json;
int main() {
  unsigned checks=0;auto check=[&](bool value){++checks;if(!value)throw std::runtime_error("Fleet receiving check "+std::to_string(checks));};
  try {
    const std::string id="12345678-1234-4123-8123-123456789abc", other="22345678-1234-4123-8123-123456789abc", hash(64,'a');
    // This is the unchanged Worker/Python SHA256_BASE64 protocol digest of
    // actual bytes "abc", compared to the native held-file SHA-256 format.
    const std::string digest="ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
    const auto input=Json::Object{{"path","C:\\MusicMuteWorker\\work\\"+other+"\\input.mp3"},{"bytes",3},{"sha256",digest}};
    check(mmstorerole::fleetInputDigestHex(input.at("sha256").string())=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    check(mmstorerole::fleetInputDigestHex("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")=="000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    check(mmstorerole::fleetInputDigestHex(std::string(43,'A')+"=")==std::string(64,'0'));
    check(mmstorerole::fleetInputDigestHex(std::string(42,'/')+"8=")==std::string(64,'f'));
    check(mmstorerole::fleetInputDigestHex(std::string(43,'A')+"=")!="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for(const auto& invalid:{hash,digest.substr(1),digest+"\n",digest.substr(0,42)+"1=",digest.substr(0,42)+"==",digest.substr(0,43)+"A",std::string(43,'A')+"_",std::string(42,'A')+"B=",std::string(44,'=')}) {
      bool denied=false;try{(void)mmstorerole::fleetInputDigestHex(invalid);}catch(const mmstore::Error&){denied=true;}check(denied);
    }
    auto original=Json::Object{{"incarnation",id},{"operation","upload"},{"attempt_id",other},{"relative_path","work\\"+other+"\\output\\vocals.mp3"},{"workspace_token",hash}};
    for(const auto role:{mmstorerole::Role::session,mmstorerole::Role::personal,mmstorerole::Role::fleet,mmstorerole::Role::prepare}) {
      check(mmstorerole::brokerOperation(role,mmstorerole::BrokerCommand::transferStart,original)==(role==mmstorerole::Role::fleet));
      check(mmstorerole::brokerOperation(role,mmstorerole::BrokerCommand::transferStop,original)==(role==mmstorerole::Role::fleet));
      check(mmstorerole::cleanupBrokerOperation(role,mmstorerole::BrokerCommand::transferStop,original)==(role==mmstorerole::Role::fleet));
      check(!mmstorerole::cleanupBrokerOperation(role,mmstorerole::BrokerCommand::transferStart,original));
      const auto open=Json::Object{{"attempt_id",other},{"extension","mp3"}};
      check(mmstorerole::brokerOperation(role,mmstorerole::BrokerCommand::fleetWorkspaceOpen,open)==(role==mmstorerole::Role::fleet));
      check(mmstorerole::cleanupBrokerOperation(role,mmstorerole::BrokerCommand::fleetWorkspaceRecover,open)==(role==mmstorerole::Role::fleet));
      check(!mmstorerole::cleanupBrokerOperation(role,mmstorerole::BrokerCommand::fleetWorkspaceOpen,open));
    }
    for(const auto& [name,value]:original){(void)value;auto missing=original;missing.erase(name);check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-stop",missing));}
    auto extra=original;extra["retired"]=true;check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-stop",extra));
    for(const auto& path:{std::string("work\\foreign\\output\\vocals.mp3"),"work\\"+other+"\\output\\other.mp3","work\\"+other+"\\output\\..\\vocals.mp3"}) {
      auto bad=original;bad["relative_path"]=path;check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-start",bad));
    }
    for(const auto extension:{"aac","flac","m4a","mp3","ogg","wav","webm","mp4","bin"}) {
      auto download=original;download["operation"]="download";download["relative_path"]="work\\"+other+"\\input."+extension;
      check(mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-start",download));
    }
    auto download=original;download["operation"]="download";download["relative_path"]="work\\"+other+"\\input.exe";check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-start",download));
    for(const auto op:{"transfer-read","transfer-inspect","transfer-stop"}){check(mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,op,Json::Object{{"token",hash}}));check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,op,Json::Object{{"token",hash},{"pid",42}}));}
    auto write=Json::Object{{"token",hash},{"bytes_base64","e30K"},{"end",true}};check(mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-write",write));
    for(const auto& value:{Json(nullptr),Json("true"),Json(1)}){write["end"]=value;check(!mmstorerole::fleetTransferOperation(mmstorerole::Role::fleet,"transfer-write",write));}
    const auto identity=Json::Object{{"sid","S-1-12-1-1-2-3-4"},{"sessionId",1},{"pid",42},{"creationTime","1234"}};
    auto expectation=Json::Object{{"version",1},{"distribution","microsoft-store"},{"kind","fleet-attempt"},{"attemptId",other},{"token",hash},{"inventorySha256",hash},{"runtimeManifestSha256",hash},
      {"nodeOwner",Json::Object{{"role","fleet"},{"nonce",hash},{"identity",identity}}},{"directoryBirth",Json::Object{{"device","1"},{"file_id","2"},{"born_at","3"}}}};
    check(mmstorerole::fleetAttemptExpectation(expectation));
    for(const auto op:{"fleet-workspace-inspect","fleet-workspace-retire"})check(mmstorerole::fleetWorkspaceOperation(mmstorerole::Role::fleet,op,Json::Object{{"expectation",expectation}}));
    for(const auto& [name,value]:expectation){(void)value;auto missing=expectation;missing.erase(name);check(!mmstorerole::fleetAttemptExpectation(missing));}
    auto bad=expectation;bad["directoryBirth"]=Json::Object{{"device","4294967296"},{"file_id","2"},{"born_at","3"}};check(!mmstorerole::fleetAttemptExpectation(bad));
    bad=expectation;bad["directoryBirth"]=Json::Object{{"device","1"},{"file_id","0"},{"born_at","3"}};check(!mmstorerole::fleetAttemptExpectation(bad));
    for(const auto name:{"fleet-workspace-open","fleet-workspace-recover","fleet-workspace-inspect","fleet-workspace-retire","transfer-start","transfer-write","transfer-read","transfer-stop","transfer-inspect"})check(mmstorerole::brokerName(mmstorerole::parseBrokerCommand(name))==name);
    // Cleanup accepts only the exact original fixed launch tuple. These
    // receiving checks do not stand in for the Creator's private tombstone.
    for(const auto actor:{mmstorerole::Role::personal,mmstorerole::Role::fleet}) {
      const auto config=std::string(actor==mmstorerole::Role::fleet?"fleet":"personal")+"\\engine-session\\"+other+"\\engine-config.json";
      const auto tuple=Json::Object{{"incarnation",id},{"config_relative",config}};
      check(mmstorerole::cleanupBrokerOperation(actor,mmstorerole::BrokerCommand::childStop,tuple));
      check(!mmstorerole::cleanupBrokerOperation(actor,mmstorerole::BrokerCommand::childStart,tuple));
      auto badTuple=tuple;badTuple["config_relative"]="C:\\caller\\engine.py";check(!mmstorerole::brokerOperation(actor,mmstorerole::BrokerCommand::childStop,badTuple));
    }
    for(const auto command:{mmstorerole::BrokerCommand::qualificationStop,mmstorerole::BrokerCommand::benchmarkStop}) {
      check(mmstorerole::cleanupBrokerOperation(mmstorerole::Role::prepare,command,Json::Object{{"incarnation",id}}));
      check(!mmstorerole::cleanupBrokerOperation(mmstorerole::Role::personal,command,Json::Object{{"incarnation",id}}));
      check(!mmstorerole::cleanupBrokerOperation(mmstorerole::Role::prepare,command,Json::Object{{"incarnation",id},{"token",hash}}));
    }
    const auto cpuTuple=Json::Object{{"kind","cloud-transcode"},{"request_id",other},{"incarnation",id},{"configuration_sha256",hash},{"operation_token",hash}};
    check(mmstorerole::cleanupBrokerOperation(mmstorerole::Role::personal,mmstorerole::BrokerCommand::toolStop,cpuTuple));
    for(const auto& [name,value]:cpuTuple){(void)value;auto missing=cpuTuple;missing.erase(name);check(!mmstorerole::cleanupBrokerOperation(mmstorerole::Role::personal,mmstorerole::BrokerCommand::toolStop,missing));}
    std::cout<<"Store Fleet closed receiving: "<<checks<<" checks passed; no OS/Job/launch authority fixture\n";return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<"\n";return 1;}
}
