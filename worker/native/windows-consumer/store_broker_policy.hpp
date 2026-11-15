#pragma once
#include "store_data_policy.hpp"
#include "store_gpu_policy.hpp"
#include "store_session_policy.hpp"
#include "store_control_policy.hpp"
#include "store_child_policy.hpp"
#include "store_tool_policy.hpp"
#include "store_qualification_policy.hpp"
#include "store_cpu_policy.hpp"
#include "store_fleet_policy.hpp"

namespace mmstorerole {
enum class BrokerCommand { launch, stop, inspect, peer, gpuAcquire, gpuRelease, gpuInspect, sessionPublish, sessionRetire, prepareRequest, prepareResult, controlRequest, controlAccept, controlReply, controlAck, controlPeer, childStart, childRead, childWrite, childStop, cleanupState, toolStart, toolRead, toolStop, qualificationStart, qualificationRead, qualificationStop, cpuOpen, cpuRecover, cpuBindData, cpuInspect, cpuRetire, cpuForget, cpuRelease, cpuPrepareRequest, cpuPrepareReady, cpuPrepareStart, cpuPrepareResult, gpuAdmit, benchmarkRequest, benchmarkStart, benchmarkRead, benchmarkStop, benchmarkResult, fleetWorkspaceOpen, fleetWorkspaceRecover, fleetWorkspaceInspect, fleetWorkspaceRetire, transferStart, transferWrite, transferRead, transferStop, transferInspect };
inline std::string_view brokerName(BrokerCommand command) {
  switch (command) {
    case BrokerCommand::launch: return "role-launch";
    case BrokerCommand::stop: return "role-stop";
    case BrokerCommand::inspect: return "role-inspect";
    case BrokerCommand::peer: return "role-peer";
    case BrokerCommand::gpuAcquire: return "gpu-acquire";
    case BrokerCommand::gpuRelease: return "gpu-release";
    case BrokerCommand::gpuInspect: return "gpu-inspect";
    case BrokerCommand::sessionPublish: return "session-publish";
    case BrokerCommand::sessionRetire: return "session-retire-children";
    case BrokerCommand::prepareRequest: return "prepare-request";
    case BrokerCommand::prepareResult: return "prepare-result";
    case BrokerCommand::controlRequest: return "control-request";
    case BrokerCommand::controlAccept: return "control-accept";
    case BrokerCommand::controlReply: return "control-reply";
    case BrokerCommand::controlAck: return "control-ack";
    case BrokerCommand::controlPeer: return "control-peer";
    case BrokerCommand::childStart: return "child-start";
    case BrokerCommand::childRead: return "child-read";
    case BrokerCommand::childWrite: return "child-write";
    case BrokerCommand::childStop: return "child-stop";
    case BrokerCommand::cleanupState: return "personal-cleanup-state";
    case BrokerCommand::toolStart: return "tool-start";
    case BrokerCommand::toolRead: return "tool-read";
    case BrokerCommand::toolStop: return "tool-stop";
    case BrokerCommand::qualificationStart: return "qualification-start";
    case BrokerCommand::qualificationRead: return "qualification-read";
    case BrokerCommand::qualificationStop: return "qualification-stop";
    case BrokerCommand::cpuOpen: return "cpu-operation-open";
    case BrokerCommand::cpuRecover: return "cpu-operation-recover";
    case BrokerCommand::cpuBindData: return "cpu-operation-bind-data";
    case BrokerCommand::cpuInspect: return "cpu-operation-inspect";
    case BrokerCommand::cpuRetire: return "cpu-operation-retire";
    case BrokerCommand::cpuForget: return "cpu-operation-forget";
    case BrokerCommand::cpuRelease: return "cpu-operation-release";
    case BrokerCommand::cpuPrepareRequest: return "cpu-prepare-request";
    case BrokerCommand::cpuPrepareReady: return "cpu-prepare-ready";
    case BrokerCommand::cpuPrepareStart: return "cpu-prepare-start";
    case BrokerCommand::cpuPrepareResult: return "cpu-prepare-result";
    case BrokerCommand::gpuAdmit: return "gpu-admit";
    case BrokerCommand::fleetWorkspaceOpen: return "fleet-workspace-open";
    case BrokerCommand::fleetWorkspaceRecover: return "fleet-workspace-recover";
    case BrokerCommand::fleetWorkspaceInspect: return "fleet-workspace-inspect";
    case BrokerCommand::fleetWorkspaceRetire: return "fleet-workspace-retire";
    case BrokerCommand::transferStart: return "transfer-start";
    case BrokerCommand::transferWrite: return "transfer-write";
    case BrokerCommand::transferRead: return "transfer-read";
    case BrokerCommand::transferStop: return "transfer-stop";
    case BrokerCommand::transferInspect: return "transfer-inspect";
    case BrokerCommand::benchmarkRequest: return "benchmark-request";
    case BrokerCommand::benchmarkStart: return "benchmark-start";
    case BrokerCommand::benchmarkRead: return "benchmark-read";
    case BrokerCommand::benchmarkStop: return "benchmark-stop";
    case BrokerCommand::benchmarkResult: return "benchmark-result";
  }
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline BrokerCommand parseBrokerCommand(std::string_view command) {
  for (const auto value : {BrokerCommand::launch, BrokerCommand::stop, BrokerCommand::inspect, BrokerCommand::peer, BrokerCommand::gpuAcquire, BrokerCommand::gpuRelease, BrokerCommand::gpuInspect, BrokerCommand::sessionPublish, BrokerCommand::sessionRetire, BrokerCommand::prepareRequest, BrokerCommand::prepareResult, BrokerCommand::controlRequest, BrokerCommand::controlAccept, BrokerCommand::controlReply, BrokerCommand::controlAck, BrokerCommand::controlPeer, BrokerCommand::childStart, BrokerCommand::childRead, BrokerCommand::childWrite, BrokerCommand::childStop, BrokerCommand::cleanupState, BrokerCommand::toolStart, BrokerCommand::toolRead, BrokerCommand::toolStop, BrokerCommand::qualificationStart, BrokerCommand::qualificationRead, BrokerCommand::qualificationStop, BrokerCommand::cpuOpen, BrokerCommand::cpuRecover, BrokerCommand::cpuBindData, BrokerCommand::cpuInspect, BrokerCommand::cpuRetire, BrokerCommand::cpuForget, BrokerCommand::cpuRelease, BrokerCommand::cpuPrepareRequest, BrokerCommand::cpuPrepareReady, BrokerCommand::cpuPrepareStart, BrokerCommand::cpuPrepareResult, BrokerCommand::gpuAdmit, BrokerCommand::benchmarkRequest, BrokerCommand::benchmarkStart, BrokerCommand::benchmarkRead, BrokerCommand::benchmarkStop, BrokerCommand::benchmarkResult, BrokerCommand::fleetWorkspaceOpen, BrokerCommand::fleetWorkspaceRecover, BrokerCommand::fleetWorkspaceInspect, BrokerCommand::fleetWorkspaceRetire, BrokerCommand::transferStart, BrokerCommand::transferWrite, BrokerCommand::transferRead, BrokerCommand::transferStop, BrokerCommand::transferInspect})
    if (brokerName(value) == command) return value;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
inline bool processingRole(Role role) noexcept { return role == Role::personal || role == Role::fleet || role == Role::prepare; }
inline bool brokerOwner(const mm::Json& owner) {
  return data_policy::fields(owner, {"role", "nonce", "identity"}) && processingRole(parseRole(owner.at("role").string())) &&
    mmstore::validDigest(owner.at("nonce").string()) && data_policy::identity(owner.at("identity"));
}
// Fixed-role receiving policy only; all actual actor, owner, Job and generation
// claims are independently proven from the creator's private held tables.
inline bool brokerOperation(Role actor, BrokerCommand command, const mm::Json& args) noexcept {
  try {
    if (actor != Role::session && !processingRole(actor)) return false;
    if (command == BrokerCommand::fleetWorkspaceOpen || command == BrokerCommand::fleetWorkspaceRecover || command == BrokerCommand::fleetWorkspaceInspect || command == BrokerCommand::fleetWorkspaceRetire) return fleetWorkspaceOperation(actor,brokerName(command),args);
    if (command == BrokerCommand::transferStart || command == BrokerCommand::transferWrite || command == BrokerCommand::transferRead || command == BrokerCommand::transferStop || command == BrokerCommand::transferInspect) return fleetTransferOperation(actor,brokerName(command),args);
    if (command == BrokerCommand::benchmarkRequest) return actor == Role::prepare && data_policy::fields(args,{});
    if (command == BrokerCommand::benchmarkResult) return actor == Role::prepare && storeBenchmarkResult(args);
    if (command == BrokerCommand::benchmarkStart || (command==BrokerCommand::benchmarkStop && args.object().contains("incarnation"))) return actor == Role::prepare && data_policy::fields(args,{"incarnation"}) && data_policy::uuid(args.at("incarnation").string());
    if (command == BrokerCommand::benchmarkRead || command == BrokerCommand::benchmarkStop) return actor == Role::prepare && data_policy::fields(args,{"token"}) && mmstore::validDigest(args.at("token").string());
    if (command == BrokerCommand::gpuAdmit) return gpuLeaseRole(actor) && data_policy::fields(args, {});
    if (command == BrokerCommand::cpuOpen || command == BrokerCommand::cpuRecover || command == BrokerCommand::cpuBindData || command == BrokerCommand::cpuInspect || command == BrokerCommand::cpuRetire || command == BrokerCommand::cpuForget || command == BrokerCommand::cpuRelease) return cpuOperationPolicy(actor, brokerName(command), args);
    if (command == BrokerCommand::cpuPrepareRequest || command == BrokerCommand::cpuPrepareStart) return actor == Role::prepare && data_policy::fields(args, {});
    if (command == BrokerCommand::cpuPrepareReady) return actor == Role::prepare && storeCpuPrepareReady(args);
    if (command == BrokerCommand::cpuPrepareResult) return actor == Role::prepare && storeCpuPrepareResult(args);
    if (command == BrokerCommand::qualificationStart || command == BrokerCommand::qualificationRead || command == BrokerCommand::qualificationStop) return qualificationOperation(actor, brokerName(command), args);
    if (command == BrokerCommand::childStart || command == BrokerCommand::childRead || command == BrokerCommand::childWrite || command == BrokerCommand::childStop) return childOperation(actor, brokerName(command), args);
    if (command == BrokerCommand::toolStart || command == BrokerCommand::toolRead || command == BrokerCommand::toolStop) return fixedToolOperation(actor, brokerName(command), args);
    if (command == BrokerCommand::cleanupState) return actor == Role::personal && data_policy::fields(args, {"owner"}) && brokerOwner(args.at("owner")) && parseRole(args.at("owner").at("role").string()) == Role::personal;
    if (command == BrokerCommand::controlRequest) return controlRequest(actor, args);
    if (command == BrokerCommand::controlAck) return controlAck(actor, args);
    if (command == BrokerCommand::controlAccept) return controlRole(actor) && data_policy::fields(args, {});
    if (command == BrokerCommand::controlReply) return controlRole(actor) && controlResult(args);
    if (command == BrokerCommand::controlPeer) return controlRole(actor) && data_policy::fields(args, {"token", "kind", "identity"}) &&
      mmstore::validDigest(args.at("token").string()) && data_policy::identity(args.at("identity")) &&
      (args.at("kind").string() == "gui" || args.at("kind").string() == "chrome" || args.at("kind").string() == "session-agent" || args.at("kind").string() == "personal" || args.at("kind").string() == "fleet");
    if (command == BrokerCommand::sessionPublish || command == BrokerCommand::sessionRetire) return actor == Role::session && data_policy::fields(args, {});
    if (command == BrokerCommand::prepareRequest) return actor == Role::prepare && data_policy::fields(args, {});
    if (command == BrokerCommand::prepareResult) {
      if (actor != Role::prepare || !data_policy::uuid(args.at("requestId").string())) return false;
      if (data_policy::fields(args, {"requestId", "errorCode"})) {
        return storePrepareFailure(args.at("errorCode").string());
      }
      return data_policy::fields(args, {"requestId", "rawSha256", "rawBytes"}) && mmstore::validDigest(args.at("rawSha256").string()) && data_policy::integer(args.at("rawBytes"), 1, 16384);
    }
    if (command == BrokerCommand::gpuAcquire) return storeGpuAcquire(actor, args);
    if (command == BrokerCommand::gpuRelease || command == BrokerCommand::gpuInspect) return storeGpuCapability(actor, args);
    if (command == BrokerCommand::launch) return actor == Role::session && data_policy::fields(args, {"role"}) && processingRole(parseRole(args.at("role").string()));
    if (command == BrokerCommand::stop) return actor == Role::session && data_policy::fields(args, {"owner"}) && brokerOwner(args.at("owner"));
    if (command != BrokerCommand::inspect && command != BrokerCommand::peer) return false;
    if (!(command == BrokerCommand::inspect ? data_policy::fields(args, {"owner"}) : data_policy::fields(args, {"owner", "identity"})) ||
        !brokerOwner(args.at("owner")) || (actor != Role::session && parseRole(args.at("owner").at("role").string()) != actor)) return false;
    return command != BrokerCommand::peer || data_policy::identity(args.at("identity"));
  } catch (...) { return false; }
}
// This is a closed classification only. Actor/capability/owner/Job admission
// remains mandatory; it cannot be selected by caller booleans or receipt data.
inline bool cleanupBrokerName(std::string_view name) noexcept {
  return name == "role-stop" || name == "role-inspect" || name == "child-stop" || name == "tool-stop" || name == "qualification-stop" || name == "benchmark-stop" ||
    name == "fleet-workspace-recover" || name == "fleet-workspace-inspect" || name == "fleet-workspace-retire" || name == "transfer-stop" || name == "transfer-inspect" || name == "cpu-operation-retire" || name == "cpu-operation-inspect" || name == "cpu-operation-recover" || name == "cpu-operation-forget" || name == "cpu-operation-release" || name == "gpu-release" || name == "session-retire-children" || name == "control-ack";
}
inline bool cleanupBrokerOperation(Role actor, BrokerCommand command, const mm::Json& args) noexcept {
  return cleanupBrokerName(brokerName(command)) && brokerOperation(actor, command, args);
}
inline bool cleanupGuiCommand(const mm::Json& command) noexcept {
  try { return storeCpuForgetCommand(command) || (storeSessionCommand(command) && (command.at("action").string() == "prepare_cancel" || command.at("action").string() == "session_forward_ack" || command.at("action").string() == "cpu_operation_inspect" || command.at("action").string() == "cpu_recover" || command.at("action").string() == "cpu_cancel" || command.at("action").string() == "benchmark_cancel" || command.at("action").string() == "benchmark_recover")); }
  catch (...) { return false; }
}
} // namespace mmstorerole
