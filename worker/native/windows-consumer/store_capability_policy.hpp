#pragma once
#include "store_role_policy.hpp"
#include <algorithm>
namespace mmstorerole {
// Pure receiving/generation state, not a constructor of process authority.
// Only the actual Creator's held helper/Node/Job admission may call it.
class HelperCapabilityGeneration {
 public:
  static constexpr std::size_t rotationThreshold = 2048;
  struct Rotation { bool rotated; std::string capability; std::size_t remaining; };
  explicit HelperCapabilityGeneration(std::string initial) : capability_(std::move(initial)) {
    mmstore::require(mmstore::validDigest(capability_), mmstore::ErrorCode::processDenied);
  }
  HelperCapabilityGeneration(const HelperCapabilityGeneration&) = delete;
  HelperCapabilityGeneration& operator=(const HelperCapabilityGeneration&) = delete;
  HelperCapabilityGeneration(HelperCapabilityGeneration&&) noexcept = default;
  HelperCapabilityGeneration& operator=(HelperCapabilityGeneration&&) noexcept = default;
  ~HelperCapabilityGeneration() { scrub(); }
  const std::string& current() const noexcept { return capability_; }
  void bind(std::string_view nonce) { replay_.consume(nonce); }
  bool active() const noexcept { return active_ != 0; }
  void enterBroker(std::string_view capability, std::string_view nonce) {
    mmstore::require(active_ == 0 && sameSecret(capability, capability_), mmstore::ErrorCode::processDenied);
    replay_.consume(nonce); clearRecovery(); active_ = 1;
  }
  void finishBroker() {
    mmstore::require(active_ == 1, mmstore::ErrorCode::processDenied); active_ = 0;
  }
  Rotation rotate(std::string_view previous, std::string_view nonce, std::string fresh) {
    mmstore::require(active_ == 0 && mmstore::validDigest(nonce), mmstore::ErrorCode::processDenied);
    if (!old_.empty()) {
      mmstore::require(sameSecret(previous, old_) && sameSecret(nonce, rotationNonce_), mmstore::ErrorCode::processDenied);
      return {true, capability_, rotationThreshold};
    }
    mmstore::require(sameSecret(previous, capability_), mmstore::ErrorCode::processDenied);
    if (replay_.usedCount() < rotationThreshold)
      return {false, capability_, rotationThreshold - replay_.usedCount()};
    mmstore::require(mmstore::validDigest(fresh) && !sameSecret(fresh, capability_), mmstore::ErrorCode::processDenied);
    // The old nonce is consumed before replacement; there is no public clear.
    replay_.consume(nonce); old_ = capability_; rotationNonce_ = nonce;
    capability_ = std::move(fresh); replay_ = ReplayFence{};
    return {true, capability_, rotationThreshold};
  }
  void scrub() noexcept { clearRecovery(); std::fill(capability_.begin(), capability_.end(), '\0'); }
 private:
  void clearRecovery() noexcept {
    std::fill(old_.begin(), old_.end(), '\0'); old_.clear();
    std::fill(rotationNonce_.begin(), rotationNonce_.end(), '\0'); rotationNonce_.clear();
  }
  std::string capability_, old_, rotationNonce_; ReplayFence replay_; unsigned active_ = 0;
};
struct RotationPeer { std::uint32_t pid; std::string birth; };
inline HelperCapabilityGeneration::Rotation parseHelperRotationReply(std::string_view frame, std::string_view nonce,
    std::string_view previous, const RotationPeer& helper, const RotationPeer& node, const RotationPeer& creator) {
  using mmstore::require; constexpr auto error = mmstore::ErrorCode::processDenied;
  try {
    require(mmstore::validDigest(nonce) && mmstore::validDigest(previous) && helper.pid > 0 && node.pid > 0 && creator.pid > 0 &&
      validBirth(helper.birth) && validBirth(node.birth) && validBirth(creator.birth) && frame.size() >= 2 && frame.size() <= 4096 &&
      frame.back() == '\n' && frame.find('\n') == frame.size() - 1 && frame.find('\r') == std::string_view::npos &&
      !frame.starts_with("\xef\xbb\xbf"), error);
    const auto reply = mm::JsonParser(frame.substr(0, frame.size() - 1)).parse();
    exactFields(reply, {"version", "accepted", "request_nonce", "rotated", "capability", "remaining", "pid", "creation_time", "node_pid", "node_creation_time", "creator_pid", "creator_creation_time"});
    require(reply.at("version").integer() == 1 && std::get<bool>(reply.at("accepted").value) && sameSecret(reply.at("request_nonce").string(), nonce) &&
      pid(reply.at("pid")) == helper.pid && reply.at("creation_time").string() == helper.birth &&
      pid(reply.at("node_pid")) == node.pid && reply.at("node_creation_time").string() == node.birth &&
      pid(reply.at("creator_pid")) == creator.pid && reply.at("creator_creation_time").string() == creator.birth && mmstore::validDigest(reply.at("capability").string()), error);
    const auto remaining = reply.at("remaining").integer(); const bool rotated = std::get<bool>(reply.at("rotated").value);
    require(remaining >= 0 && remaining <= static_cast<std::int64_t>(HelperCapabilityGeneration::rotationThreshold) &&
      (rotated ? remaining == static_cast<std::int64_t>(HelperCapabilityGeneration::rotationThreshold) && !sameSecret(reply.at("capability").string(), previous) :
        remaining > 0 && sameSecret(reply.at("capability").string(), previous)), error);
    return {rotated, reply.at("capability").string(), static_cast<std::size_t>(remaining)};
  } catch (...) { mmstore::fail(error); }
}
} // namespace mmstorerole
