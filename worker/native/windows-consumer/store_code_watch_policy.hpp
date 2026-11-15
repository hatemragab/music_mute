#pragma once
#include "store_authority.hpp"
// Pure lifecycle policy only. This class cannot construct code or Store
// authority; production observations come from a retained kernel watch.
namespace mmstoreruntime {
enum class CodeWatchObservation { pending, changed, overflow, error };
class CodeWatchPolicy final {
 public:
  void armed(CodeWatchObservation observation) {
    mmstore::require(!armed_ && !admitted_ && !invalid_, mmstore::ErrorCode::fileDenied);
    armed_ = true; observe(observation);
  }
  void requirePending(CodeWatchObservation observation) { observe(observation); }
  void completedInitialCensus(CodeWatchObservation observation) {
    mmstore::require(armed_ && !admitted_, mmstore::ErrorCode::fileDenied);
    observe(observation); admitted_ = true;
  }
  void requireLive(CodeWatchObservation observation) {
    observe(observation);
    mmstore::require(armed_ && admitted_ && !invalid_, mmstore::ErrorCode::fileDenied);
  }
 private:
  void observe(CodeWatchObservation observation) {
    if (observation != CodeWatchObservation::pending) invalid_ = true;
    mmstore::require(armed_ && !invalid_, mmstore::ErrorCode::fileDenied);
  }
  bool armed_ = false, admitted_ = false, invalid_ = false;
};
} // namespace mmstoreruntime
