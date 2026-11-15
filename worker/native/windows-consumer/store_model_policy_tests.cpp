#include "store_model_policy.hpp"
#include <array>
#include <iostream>
#include <stdexcept>

namespace {
unsigned checks = 0;
void check(bool value, const char* label) {
  ++checks;
  if (!value) throw std::runtime_error(label);
}
using State = mmstoremodelpolicy::ObjectState;
using Decision = mmstoremodelpolicy::Layout;
struct Scenario {
  State active, stage, backup;
  bool previous;
  Decision expected;
};
// These five allowed on-disk generations come from the model transaction
// contract. Tests call the actual production policy; they create no file,
// package, mutex, Store actor or trusted birth observation.
constexpr std::array valid{
  Scenario{State::missing, State::desired, State::missing, false, Decision::publishStage},
  Scenario{State::desired, State::missing, State::missing, false, Decision::published},
  Scenario{State::previous, State::desired, State::missing, true, Decision::backupPrevious},
  Scenario{State::missing, State::desired, State::previous, true, Decision::publishStage},
  Scenario{State::desired, State::missing, State::previous, true, Decision::published}
};
void allLayouts() {
  constexpr std::array states{State::missing, State::previous, State::desired, State::foreign};
  unsigned accepted = 0;
  for (const auto active : states)
    for (const auto stage : states)
      for (const auto backup : states)
        for (const bool previous : {false, true}) {
          auto expected = Decision::invalid;
          for (const auto& allowed : valid) {
            if (allowed.active == active && allowed.stage == stage &&
                allowed.backup == backup && allowed.previous == previous)
              expected = allowed.expected;
          }
          const auto actual = mmstoremodelpolicy::layout(active, stage, backup, previous);
          check(actual == expected, "MODEL_LAYOUT_TABLE_FAILED");
          if (actual != Decision::invalid) ++accepted;
        }
  check(accepted == valid.size(), "MODEL_LAYOUT_ADMITTED_UNEXPECTED_GENERATION");
}
void unknownGenerationAndRollback() {
  // A matching-content clone or an unnormalized re-opened birth is foreign,
  // as determined by production's held full-birth/bytes/SHA checks.
  for (const auto& allowed : valid) {
    for (unsigned leaf = 0; leaf < 3; ++leaf) {
      auto changed = allowed;
      auto& target = leaf == 0 ? changed.active : leaf == 1 ? changed.stage : changed.backup;
      target = State::foreign;
      check(mmstoremodelpolicy::layout(changed.active, changed.stage, changed.backup, changed.previous) ==
        Decision::invalid, "MODEL_LAYOUT_ACCEPTED_FOREIGN_GENERATION");
    }
  }
  check(mmstoremodelpolicy::layout(State::desired, State::missing, State::missing, true) ==
    Decision::invalid, "MODEL_COMPLETED_REPLACEMENT_LOST_BACKUP");
  check(mmstoremodelpolicy::layout(State::missing, State::desired, State::missing, true) ==
    Decision::invalid, "MODEL_REPLACEMENT_LOST_OLD_GENERATION");
  check(mmstoremodelpolicy::layout(State::previous, State::desired, State::previous, true) ==
    Decision::invalid, "MODEL_DUPLICATED_OLD_GENERATION");
  check(mmstoremodelpolicy::layout(State::desired, State::desired, State::previous, true) ==
    Decision::invalid, "MODEL_PUBLISHED_WITH_UNEXPECTED_STAGE");
  // A rollback cannot claim a vacant destination from an occupied, foreign or
  // separately desired active slot. The Native no-replace rename remains
  // independently mandatory, even when an allowed layout was observed earlier.
  for (const auto active : {State::foreign, State::desired})
    check(mmstoremodelpolicy::layout(active, State::desired, State::previous, true) ==
      Decision::invalid, "MODEL_ROLLBACK_DESTINATION_OCCUPIED");
  for (const auto unknown : {static_cast<State>(-1), static_cast<State>(100)}) {
    check(mmstoremodelpolicy::layout(unknown, State::desired, State::missing, false) ==
      Decision::invalid, "MODEL_UNKNOWN_ACTIVE_ENUM");
    check(mmstoremodelpolicy::layout(State::missing, unknown, State::missing, false) ==
      Decision::invalid, "MODEL_UNKNOWN_STAGE_ENUM");
    check(mmstoremodelpolicy::layout(State::missing, State::desired, unknown, false) ==
      Decision::invalid, "MODEL_UNKNOWN_BACKUP_ENUM");
  }
}
void allClosures() {
  unsigned retired = 0;
  for (unsigned bits = 0; bits < 32; ++bits) {
    const bool completed = (bits & 1U) != 0,
      sourceRequired = (bits & 2U) != 0,
      sourceClosed = (bits & 4U) != 0,
      filesClosed = (bits & 8U) != 0,
      parentsClosed = (bits & 16U) != 0;
    // Only these three exact evidence combinations settle a completed owner.
    // Recovery has no original source; publication and reuse both have one.
    const bool expected = bits == 25U || bits == 29U || bits == 31U;
    const bool actual = mmstoremodelpolicy::canRetire(completed, sourceRequired,
      sourceClosed, filesClosed, parentsClosed);
    check(actual == expected, "MODEL_CLOSE_EVIDENCE_TABLE_FAILED");
    if (actual) ++retired;
  }
  check(retired == 3, "MODEL_CLOSE_ADMITTED_UNEXPECTED_EVIDENCE");
  check(!mmstoremodelpolicy::canRetire(true, true, false, true, true),
    "MODEL_REUSED_SOURCE_CLOSE_UNCONFIRMED");
  check(!mmstoremodelpolicy::canRetire(true, true, true, false, true),
    "MODEL_BACKUP_OR_STAGE_CLOSE_UNCONFIRMED");
  check(!mmstoremodelpolicy::canRetire(true, true, true, true, false),
    "MODEL_RECOVERY_PARENT_CLOSE_UNCONFIRMED");
  check(!mmstoremodelpolicy::canRetire(false, false, true, true, true),
    "MODEL_UNCOMPLETED_INTENT_RETIRED");
  check(mmstoremodelpolicy::canRetire(true, false, false, true, true),
    "MODEL_FULLY_CLOSED_RECOVERY_REJECTED");
}
}
int main() {
  try {
    allLayouts(); unknownGenerationAndRollback(); allClosures();
    std::cout << "Store model production layout/close policy: " << checks
      << " checks passed; no OS/Store authority fixture\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 2;
  }
}
