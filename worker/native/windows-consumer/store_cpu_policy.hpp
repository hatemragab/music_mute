#pragma once
#include "store_tool_policy.hpp"
#include <map>
namespace mmstorerole {
inline bool cpuOperationName(std::string_view name) noexcept {
  return name == "cloud_prepare" || name == "cloud_probe" || name == "silence_analyze" ||
    name == "diagnostics_doctor" || name == "browser_check_youtube";
}
inline FixedToolKind cpuOperationRepresentative(std::string_view name) {
  if (name == "cloud_prepare" || name == "cloud_probe") return FixedToolKind::cloudProbeInput;
  if (name == "silence_analyze") return FixedToolKind::silenceProbe;
  if (name == "diagnostics_doctor") return FixedToolKind::doctorMetadata;
  if (name == "browser_check_youtube") return FixedToolKind::downloaderVersion;
  mmstore::fail(mmstore::ErrorCode::invalidInput);
}
// These fields describe an expectation. Only the live Creator's registered
// actor, held Node/Job, immutable code and private operation row grant rights.
inline bool cpuOperationExpectation(const mm::Json& value) noexcept;
// Internal native cleanup only. The public helper opcode/GUI command tables
// never expose forget; the compiled workspace ACK path invokes it after its
// durable original receipt and reservation fences have settled.
inline bool cpuForgetArguments(Role actor, const mm::Json& args) noexcept {
  try { return cpuToolRole(actor) && data_policy::fields(args, {"expectation", "request_id"}) && data_policy::uuid(args.at("request_id").string()) &&
    cpuOperationExpectation(args.at("expectation")) &&
    args.at("expectation").at("nodeOwner").at("role").string() == roleName(actor); }
  catch (...) { return false; }
}
inline bool cpuOperationPolicy(Role actor, std::string_view operation, const mm::Json& args) noexcept {
  try {
    if (!cpuToolRole(actor)) return false;
    if (operation == "cpu-operation-forget" || operation == "cpu-operation-release") return cpuForgetArguments(actor, args);
    if (operation == "cpu-operation-open" || operation == "cpu-operation-recover")
      return data_policy::fields(args, {"request_id", "incarnation", "operation", "configuration_sha256"}) &&
        data_policy::uuid(args.at("request_id").string()) && data_policy::uuid(args.at("incarnation").string()) &&
        cpuOperationName(args.at("operation").string()) && mmstore::validDigest(args.at("configuration_sha256").string());
    if (operation == "cpu-operation-inspect") return data_policy::fields(args, {"token", "expectation"}) && mmstore::validDigest(args.at("token").string()) && cpuOperationExpectation(args.at("expectation")) && args.at("token").string() == args.at("expectation").at("token").string();
    return (operation == "cpu-operation-bind-data" || operation == "cpu-operation-retire") &&
      data_policy::fields(args, {"token"}) && mmstore::validDigest(args.at("token").string());
  } catch (...) { return false; }
}
inline bool cpuOperationExpectation(const mm::Json& value) noexcept { return data_policy::cpuExpectation(value); }

// Bounded bookkeeping on one genuinely held actor. These records describe
// completion recovery only; native original-row/handle admission supplies the
// authority before finish. Absent release is never an exit/closure proof.
class CpuForgetCompletions final {
 public:
  bool completed(const mm::Json& expected, std::string_view request) const {
    const auto key = checkedKey(expected, request); const auto found = records_.find(key);
    if (found == records_.end()) return false;
    mmstore::require(found->second.request == request, mmstore::ErrorCode::processDenied); return found->second.complete;
  }
  void begin(const mm::Json& expected, std::string_view request) {
    const auto key = checkedKey(expected, request); const auto found = records_.find(key);
    if (found != records_.end()) { mmstore::require(found->second.request == request, mmstore::ErrorCode::processDenied); return; }
    mmstore::require(records_.size() < 256, mmstore::ErrorCode::processDenied);
    records_.emplace(key, Record{std::string(request), false});
  }
  void finish(const mm::Json& expected, std::string_view request) {
    const auto key = checkedKey(expected, request); const auto found = records_.find(key);
    mmstore::require(found != records_.end() && found->second.request == request, mmstore::ErrorCode::processDenied); found->second.complete = true;
  }
  void release(const mm::Json& expected, std::string_view request) {
    const auto key = checkedKey(expected, request); const auto found = records_.find(key);
    if (found == records_.end()) return;
    mmstore::require(found->second.request == request && found->second.complete, mmstore::ErrorCode::processDenied); records_.erase(found);
  }
 private:
  static std::string checkedKey(const mm::Json& expected, std::string_view request) {
    mmstore::require(cpuOperationExpectation(expected) && data_policy::uuid(request), mmstore::ErrorCode::processDenied); return mm::dump(expected);
  }
  struct Record { std::string request; bool complete; };
  std::map<std::string, Record> records_;
};

} // namespace mmstorerole
