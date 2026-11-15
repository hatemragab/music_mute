#pragma once
#include "store_data_policy.hpp"

namespace mmstoremodelpolicy {
inline constexpr std::uint64_t bytes = 66759214;
inline constexpr std::string_view sha256 = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
enum class ObjectState { missing, previous, desired, foreign };
enum class Layout { invalid, backupPrevious, publishStage, published };
// Receiving decisions only. Production derives these states from the exact
// held object birth/bytes/hash; booleans or observations mint no authority.
inline Layout layout(ObjectState active, ObjectState stage, ObjectState backup, bool hadPrevious) noexcept {
  if (active == ObjectState::desired && stage == ObjectState::missing &&
      backup == (hadPrevious ? ObjectState::previous : ObjectState::missing)) return Layout::published;
  if (stage != ObjectState::desired) return Layout::invalid;
  if (hadPrevious && active == ObjectState::previous && backup == ObjectState::missing) return Layout::backupPrevious;
  if (active == ObjectState::missing && backup == (hadPrevious ? ObjectState::previous : ObjectState::missing)) return Layout::publishStage;
  return Layout::invalid;
}
inline bool canRetire(bool completed, bool sourceRequired, bool sourceClosed,
    bool transactionFilesClosed, bool transactionParentsClosed) noexcept {
  return completed && (!sourceRequired || sourceClosed) && transactionFilesClosed && transactionParentsClosed;
}
inline bool operation(std::string_view name) noexcept {
  return name == "store_model_file_open" || name == "store_model_publish" || name == "store_model_recover";
}
// Receiving policy only. Actual GUI code, namespace, original Prepare mutex
// and held file generations remain mandatory at the native mutation boundary.
inline bool input(std::string_view name, const mm::Json& args) noexcept {
  try {
    using namespace mmstorerole::data_policy;
    if(name == "store_model_file_open") return fields(args,{"mode","expected_birth"}) &&
      ((args.at("mode").string() == "create-new" && std::holds_alternative<std::nullptr_t>(args.at("expected_birth").value)) ||
       (args.at("mode").string() == "resume" && birth(args.at("expected_birth"))));
    if(name == "store_model_publish") return fields(args,{"token"}) && mmstore::validDigest(args.at("token").string());
    return name == "store_model_recover" && fields(args,{});
  } catch (...) { return false; }
}
} // namespace mmstoremodelpolicy
