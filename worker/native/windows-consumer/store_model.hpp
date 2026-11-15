#pragma once
// Included in main.cpp's implementation namespace after private file helpers.
// Only the Store dispatcher can expose this fixed mutable-data transaction.
constexpr auto storeModelActiveLeaf = L"Kim_Vocal_2.onnx";
constexpr auto storeModelStageLeaf = L"Kim_Vocal_2.onnx.part";
constexpr auto storeModelJournalKey = "prepare_model_publication";
constexpr std::uint64_t storeModelPreviousMaximum = 128ULL * 1024 * 1024;
struct StoreModelClosure {
  Handle active, stage, backup;
  std::vector<Handle> ancestors;
  std::string sourceToken;
  Json intent;
  bool completed = false;
  bool sourceClosed = false;
};
// Register before acquiring local objects. Exceptions retain their original
// owners here; only positively confirmed closes retire an entry.
std::vector<std::shared_ptr<StoreModelClosure>> storeModelClosures;
std::shared_ptr<StoreModelClosure> newStoreModelClosure() {
  if (storeModelClosures.size() >= 16) fail("VAULT_RECOVERY_REQUIRED");
  auto owner = std::make_shared<StoreModelClosure>(); storeModelClosures.push_back(owner); return owner;
}
void holdStorePrivateDirectories(const std::wstring& path, const std::wstring& privateRoot, std::vector<Handle>& retained) {
  const auto parts = nativePathComponents(path);
  if (retained.size() > parts.size()) fail("PATH_UNSAFE");
  retained.reserve(parts.size());
  constexpr DWORD sharing = FILE_SHARE_READ | FILE_SHARE_WRITE;
  constexpr ACCESS_MASK access = READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE;
  if (retained.empty()) retained.emplace_back();
  if (!retained.front().valid()) retained.front().value = CreateFileW(parts.front().c_str(), access, sharing, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (!retained.front().valid()) fail("PATH_UNSAFE");
  nativeEntryInformation(retained.front().value, NativeChildKind::directory);
  if (_wcsicmp(nativeCanonical(retained.front().value).c_str(), parts.front().c_str())) fail("PATH_UNSAFE");
  std::wstring component = parts.front();
  for (std::size_t index = 1; index < parts.size(); ++index) {
    if (component.size() > 3) component += L'\\'; component += parts[index];
    if (retained.size() == index) retained.emplace_back();
    auto& child = retained[index];
    if (!child.valid()) {
      const auto opened = openNativeChild(retained[index-1].value, parts[index], access, sharing, NativeChildKind::directory,
        NativeChildDisposition::open, nullptr, false, &child);
      if (opened.status != 0 || !child.valid()) fail("PATH_UNSAFE");
    }
    nativeEntryInformation(child.value, NativeChildKind::directory);
    if (_wcsicmp(nativeCanonical(child.value).c_str(), component.c_str())) fail("PATH_UNSAFE");
    if (nativeWithinRoot(component, privateRoot)) assertPrivateHandle(child.value, _wcsicmp(component.c_str(), privateRoot.c_str()) == 0);
  }
}

void assertStoreModelPrepare() {
  if (!authorizeStoreGuiPrivateDataCaller()) fail("PEER_DENIED");
  const auto held = ownedMutexes.find("prepare");
  if (held == ownedMutexes.end() || !held->second.handle.valid() ||
      mm::dump(held->second.identity) != mm::dump(processIdentity(GetCurrentProcessId()))) fail("PEER_DENIED");
  assertPrivateMutex(held->second.handle.value);
}
Json storeModelPin(HANDLE file) {
  nativeEntryInformation(file, NativeChildKind::file); assertPrivateHandle(file);
  const auto info = cacheHandleIdentity(file, false);
  if (info.at("bytes").integer() < 0 || static_cast<std::uint64_t>(info.at("bytes").integer()) > storeModelPreviousMaximum) fail("PATH_UNSAFE");
  return Json::Object{{"birth", cacheHandleBirth(file)}, {"bytes", info.at("bytes")}, {"sha256", hashFile(file, storeModelPreviousMaximum)}};
}
void validateStoreModelPin(const Json& pin, bool desired) {
  keys(pin, {"birth", "bytes", "sha256"}); validatePrivateFileBirth(pin.at("birth"));
  const auto size = privateFileNumber(pin.at("bytes"), storeModelPreviousMaximum);
  if (!mmstore::validDigest(pin.at("sha256").string()) ||
      (desired && (size != mmstoremodelpolicy::bytes || pin.at("sha256").string() != mmstoremodelpolicy::sha256))) fail("VAULT_RECOVERY_REQUIRED");
}
bool sameStoreModelPin(HANDLE file, const Json& pin) { return mm::dump(storeModelPin(file)) == mm::dump(pin); }
void openStoreModelLeaf(HANDLE parent, const std::wstring& directory, const std::wstring& leaf, bool mutate, bool& missing, Handle& retained) {
  auto opened = openNativeChild(parent, leaf, GENERIC_READ | READ_CONTROL | (mutate ? DELETE | FILE_WRITE_ATTRIBUTES : 0),
    mutate ? 0 : FILE_SHARE_READ, NativeChildKind::file, NativeChildDisposition::open, nullptr, false, &retained);
  missing = false;
  if (opened.status != 0 || !retained.valid()) {
    if (static_cast<ULONG>(opened.status) == nativeNameMissing) { missing = true; return; }
    fail("PATH_UNSAFE");
  }
  assertPrivateHandle(retained.value);
  if (_wcsicmp(nativeCanonical(retained.value).c_str(), (directory + L"\\" + leaf).c_str())) fail("PATH_UNSAFE");
}
Json storeModelAncestors(const std::vector<Handle>& ancestors) {
  Json::Array result;
  for (const auto& handle : ancestors) result.emplace_back(Json::Object{{"path", utf8(nativeCanonical(handle.value))}, {"birth", cacheHandleBirth(handle.value)}});
  return result;
}
void validateStoreModelAncestors(const std::vector<Handle>& ancestors, const Json& expected) {
  if (mm::dump(storeModelAncestors(ancestors)) != mm::dump(expected)) fail("PATH_UNSAFE");
}
void closeStoreModelHandle(Handle& handle) {
  if (!handle.valid()) return;
  const auto raw = handle.value;
  if (!CloseHandle(raw)) fail("PATH_UNSAFE");
  handle.value = nullptr;
}
void closeStoreModelClosure(const std::shared_ptr<StoreModelClosure>& owner) {
  closeStoreModelHandle(owner->active); closeStoreModelHandle(owner->stage); closeStoreModelHandle(owner->backup);
  for (auto it = owner->ancestors.rbegin(); it != owner->ancestors.rend(); ++it) closeStoreModelHandle(*it);
}
void forgetStoreModelClosure(std::shared_ptr<StoreModelClosure> owner) {
  storeModelClosures.erase(std::remove(storeModelClosures.begin(), storeModelClosures.end(), owner), storeModelClosures.end());
}
Json storeModelReceipt(HANDLE active, const std::string& state, const Json& intent) {
  const auto pin = storeModelPin(active); validateStoreModelPin(pin, true);
  const auto backup = std::holds_alternative<std::nullptr_t>(intent.at("old").value)
    ? Json(nullptr) : Json("models\\Kim_Vocal_2.onnx.previous-" + intent.at("nonce").string());
  return Json::Object{{"version", 1}, {"state", state}, {"identity", cacheHandleIdentity(active, false)},
    {"sha256", std::string(mmstoremodelpolicy::sha256)}, {"bytes", static_cast<std::int64_t>(mmstoremodelpolicy::bytes)}, {"backup_relative_path", backup}};
}
Json readStoreModelIntent() {
  const auto text = repairProtectedBytes(storeModelJournalKey);
  if (text.empty()) return nullptr;
  const auto intent = mm::JsonParser(text).parse();
  keys(intent, {"version", "nonce", "helper", "ancestors", "old", "new"});
  if (intent.at("version").integer() != 1 || !mmstore::validDigest(intent.at("nonce").string())) fail("VAULT_RECOVERY_REQUIRED");
  const auto& helper = intent.at("helper"); keys(helper, {"sid", "session_id", "pid", "creation_time"});
  if (helper.at("sid").string() != currentIdentity().sid || !mmstorerole::data_policy::identity(helper)) fail("VAULT_RECOVERY_REQUIRED");
  validateStoreModelPin(intent.at("new"), true);
  if (!std::holds_alternative<std::nullptr_t>(intent.at("old").value)) {
    validateStoreModelPin(intent.at("old"), false);
    if (mm::dump(intent.at("old").at("birth")) == mm::dump(intent.at("new").at("birth"))) fail("VAULT_RECOVERY_REQUIRED");
  }
  const auto& ancestors = intent.at("ancestors").array();
  if (ancestors.empty() || ancestors.size() > 40) fail("VAULT_RECOVERY_REQUIRED");
  for (const auto& row : ancestors) { keys(row, {"path", "birth"}); if (row.at("path").string().empty() || row.at("path").string().size() > 32768) fail("VAULT_RECOVERY_REQUIRED"); validatePrivateFileBirth(row.at("birth")); }
  return intent;
}
void clearClosedStoreModelIntent(std::shared_ptr<StoreModelClosure> owner) {
  closeStoreModelClosure(owner);
  const bool filesClosed = !owner->active.valid() && !owner->stage.valid() && !owner->backup.valid();
  const bool parentsClosed = std::all_of(owner->ancestors.begin(), owner->ancestors.end(), [](const auto& handle) { return !handle.valid(); });
  if (!mmstoremodelpolicy::canRetire(owner->completed, !owner->sourceToken.empty(), owner->sourceClosed, filesClosed, parentsClosed)) fail("VAULT_RECOVERY_REQUIRED");
  const auto current = readStoreModelIntent();
  if (!std::holds_alternative<std::nullptr_t>(current.value)) {
    if (mm::dump(current) != mm::dump(owner->intent)) fail("VAULT_RECOVERY_REQUIRED");
    (void)vault("vault_delete", Json::Object{{"namespace", "account"}, {"key", storeModelJournalKey}});
  }
  forgetStoreModelClosure(owner);
}
void retireClosedStoreModelPublication(const std::string& token) {
  const auto found = std::find_if(storeModelClosures.begin(), storeModelClosures.end(), [&](const auto& owner) {
    return owner->completed && owner->sourceToken == token;
  });
  if (found == storeModelClosures.end()) return;
  const auto source = privateFileCapabilities.find(token);
  if (source == privateFileCapabilities.end() || source->second.file.valid()) fail("VAULT_RECOVERY_REQUIRED");
  for (const auto& handle : source->second.ancestors) if (handle.valid()) fail("VAULT_RECOVERY_REQUIRED");
  (*found)->sourceClosed = true;
  clearClosedStoreModelIntent(*found);
}
void settleStoreModelClosures() {
  const auto pending = storeModelClosures;
  for (const auto& owner : pending) {
    closeStoreModelClosure(owner);
    if (owner->completed && !owner->sourceToken.empty()) {
      const auto source = privateFileCapabilities.find(owner->sourceToken);
      if (source != privateFileCapabilities.end()) {
        if (source->second.file.valid()) fail("VAULT_RECOVERY_REQUIRED");
        for (const auto& handle : source->second.ancestors) if (handle.valid()) fail("VAULT_RECOVERY_REQUIRED");
        owner->sourceClosed = true;
        clearClosedStoreModelIntent(owner);
        privateFileCapabilities.erase(source);
      } else clearClosedStoreModelIntent(owner);
    } else if (owner->completed) clearClosedStoreModelIntent(owner);
    else forgetStoreModelClosure(owner); // Disk intent remains for exact recovery.
  }
}
void assertStoreModelOriginalHelper(const Json& intent) {
  const auto actual = processIdentity(static_cast<DWORD>(intent.at("helper").at("pid").integer()), true);
  if (!std::holds_alternative<std::nullptr_t>(actual.value) && mm::dump(actual) == mm::dump(intent.at("helper")) &&
      mm::dump(actual) != mm::dump(processIdentity(GetCurrentProcessId()))) fail("JOB_BUSY");
}
void normalizeMovedStoreModel(HANDLE moved, const Json& expected) {
  const auto actual = cacheHandleBirth(moved), birth = expected.at("birth");
  if (actual.at("device").string() != birth.at("device").string() || actual.at("file_id").string() != birth.at("file_id").string()) fail("PATH_UNSAFE");
  const auto pin = storeModelPin(moved);
  if (pin.at("bytes").integer() != expected.at("bytes").integer() || pin.at("sha256").string() != expected.at("sha256").string()) fail("PATH_UNSAFE");
  if (actual.at("born_at").string() != birth.at("born_at").string()) {
    const auto stamp = std::stoull(birth.at("born_at").string()); const FILETIME time{static_cast<DWORD>(stamp), static_cast<DWORD>(stamp >> 32)};
    check(SetFileTime(moved, &time, nullptr, nullptr), "PATH_UNSAFE");
  }
  if (!sameStoreModelPin(moved, expected)) fail("PATH_UNSAFE");
}
// Immutable intent infers progress solely from exact held generations. No
// backup/model data is deleted; unexpected objects or unknown close stay open.
Json completeStoreModelPublication(const Json& intent, std::vector<Handle>& ancestors, PrivateFileCapability* source,
    const std::shared_ptr<StoreModelClosure>& closure, bool originalActive = false) {
  assertStoreModelPrepare(); assertStoreModelOriginalHelper(intent);
  validateStoreModelAncestors(ancestors, intent.at("ancestors"));
  const auto parent = ancestors.back().value;
  const auto directory = nativeCanonical(parent);
  const auto backupLeaf = L"Kim_Vocal_2.onnx.previous-" + wide(intent.at("nonce").string());
  bool activeMissing = false, stageMissing = false, backupMissing = false;
  auto& active = closure->active; auto& stage = closure->stage; auto& backup = closure->backup;
  if (originalActive) activeMissing = !active.valid();
  else openStoreModelLeaf(parent, directory, storeModelActiveLeaf, true, activeMissing, active);
  HANDLE stageHandle = nullptr;
  if (source) {
    validatePrivateFileCapability(*source);
    if (!source->storeModelStage || source->path != directory + L"\\" + storeModelStageLeaf || !sameStoreModelPin(source->file.value, intent.at("new"))) fail("PATH_UNSAFE");
    stageHandle = source->file.value;
  } else {
    openStoreModelLeaf(parent, directory, storeModelStageLeaf, true, stageMissing, stage); stageHandle = stage.value;
  }
  openStoreModelLeaf(parent, directory, backupLeaf, true, backupMissing, backup);
  const bool hadOld = !std::holds_alternative<std::nullptr_t>(intent.at("old").value);
  const bool newActive = !activeMissing && sameStoreModelPin(active.value, intent.at("new"));
  const bool oldActive = hadOld && !activeMissing && sameStoreModelPin(active.value, intent.at("old"));
  using mmstoremodelpolicy::ObjectState;
  const auto activeState = activeMissing ? ObjectState::missing : newActive ? ObjectState::desired : oldActive ? ObjectState::previous : ObjectState::foreign;
  const auto stageState = stageMissing ? ObjectState::missing : sameStoreModelPin(stageHandle, intent.at("new")) ? ObjectState::desired : ObjectState::foreign;
  const auto backupState = backupMissing ? ObjectState::missing : hadOld && sameStoreModelPin(backup.value, intent.at("old")) ? ObjectState::previous : ObjectState::foreign;
  const auto decision = mmstoremodelpolicy::layout(activeState, stageState, backupState, hadOld);
  if (decision == mmstoremodelpolicy::Layout::invalid) fail("PATH_UNSAFE");
  if (decision != mmstoremodelpolicy::Layout::published) {
    if (decision == mmstoremodelpolicy::Layout::backupPrevious) {
      assertStoreModelPrepare(); validateStoreModelAncestors(ancestors, intent.at("ancestors"));
      if (!nativeChildMissing(parent, backupLeaf)) fail("PATH_UNSAFE");
      const auto renamed = renameNativeChild(active.value, parent, backupLeaf);
      if (renamed.status != 0) fail("PATH_UNSAFE");
      normalizeMovedStoreModel(active.value, intent.at("old")); backup = std::move(active); activeMissing = true;
    }
    assertStoreModelPrepare(); validateStoreModelAncestors(ancestors, intent.at("ancestors"));
    if (!nativeChildMissing(parent, storeModelActiveLeaf)) fail("PATH_UNSAFE");
    const auto renamed = renameNativeChild(stageHandle, parent, storeModelActiveLeaf);
    if (renamed.status != 0) {
      if (backup.valid() && nativeChildMissing(parent, storeModelActiveLeaf)) {
        const auto restored = renameNativeChild(backup.value, parent, storeModelActiveLeaf);
        if (restored.status == 0) normalizeMovedStoreModel(backup.value, intent.at("old"));
      }
      fail("PATH_UNSAFE");
    }
    normalizeMovedStoreModel(stageHandle, intent.at("new"));
    if (source) { source->path = directory + L"\\" + storeModelActiveLeaf; source->writable = false; }
    else active = std::move(stage);
  }
  const auto published = source ? source->file.value : active.value;
  if (_wcsicmp(nativeCanonical(published).c_str(), (directory + L"\\" + storeModelActiveLeaf).c_str()) ||
      !nativeChildMissing(parent, storeModelStageLeaf)) fail("PATH_UNSAFE");
  if (source) validatePrivateFileCapability(*source);
  if (!sameStoreModelPin(published, intent.at("new"))) fail("PATH_UNSAFE");
  validateStoreModelAncestors(ancestors, intent.at("ancestors")); assertStoreModelPrepare();
  const auto receipt = storeModelReceipt(published, "published", intent);
  closure->completed = true;
  closeStoreModelClosure(closure);
  if (!source) clearClosedStoreModelIntent(closure);
  // With a source capability the intent remains until private_file_close has
  // positively closed that original file AND all of its retained ancestors.
  return receipt;
}
Json recoverStoreModelPublication() {
  assertStoreModelPrepare(); settleStoreModelClosures(); const auto intent = readStoreModelIntent();
  // Even a reused valid final cannot hide an uncertain original partial/parent
  // close in this same actual helper. Imported receipts do not settle it.
  for (const auto& [token, capability] : privateFileCapabilities) {
    (void)token;
    if (!capability.storeModelStage) continue;
    if (capability.file.valid()) fail("VAULT_RECOVERY_REQUIRED");
    for (const auto& handle : capability.ancestors) if (handle.valid()) fail("VAULT_RECOVERY_REQUIRED");
  }
  if (std::holds_alternative<std::nullptr_t>(intent.value)) return nullptr;
  const auto directory = rootPath("personal") + L"\\models";
  auto closure = newStoreModelClosure(); closure->intent = intent;
  holdStorePrivateDirectories(directory, rootPath("personal"), closure->ancestors);
  return completeStoreModelPublication(intent, closure->ancestors, nullptr, closure);
}
Json openStoreModelFile(const Json& args) {
  assertStoreModelPrepare();
  if (!std::holds_alternative<std::nullptr_t>(readStoreModelIntent().value)) fail("VAULT_RECOVERY_REQUIRED");
  return openPrivateFile(Json::Object{{"root", "personal"}, {"relative_path", "models\\Kim_Vocal_2.onnx.part"},
    {"mode", args.at("mode")}, {"maximum_bytes", static_cast<std::int64_t>(mmstoremodelpolicy::bytes)}, {"expected_birth", args.at("expected_birth")}}, false, true);
}
Json publishStoreModel(const Json& args) {
  assertStoreModelPrepare(); auto& source = privateFileCapability(args);
  if (!source.storeModelStage || !source.writable || source.path != source.root + L"\\models\\" + storeModelStageLeaf) fail("PEER_DENIED");
  source.writable = false; validatePrivateFileCapability(source); check(FlushFileBuffers(source.file.value), "PATH_UNSAFE");
  const auto desired = storeModelPin(source.file.value); validateStoreModelPin(desired, true);
  if (!std::holds_alternative<std::nullptr_t>(readStoreModelIntent().value)) fail("VAULT_RECOVERY_REQUIRED");
  const auto parent = source.ancestors.back().value;
  const auto directory = nativeCanonical(parent);
  bool activeMissing = false;
  auto closure = newStoreModelClosure(); closure->sourceToken = privateFileString(args.at("token"));
  auto& active = closure->active;
  openStoreModelLeaf(parent, directory, storeModelActiveLeaf, true, activeMissing, active);
  const auto old = activeMissing ? Json(nullptr) : storeModelPin(active.value);
  const auto nonce = randomHex();
  const auto intent = Json::Object{{"version", 1}, {"nonce", nonce}, {"helper", processIdentity(GetCurrentProcessId())},
    {"ancestors", storeModelAncestors(source.ancestors)}, {"old", old}, {"new", desired}};
  if (!activeMissing && old.at("bytes").integer() == static_cast<std::int64_t>(mmstoremodelpolicy::bytes) && old.at("sha256").string() == mmstoremodelpolicy::sha256) {
    auto reuseIntent = intent; reuseIntent["old"] = nullptr;
    const auto receipt = storeModelReceipt(active.value, "reused", reuseIntent);
    closure->completed = true; closeStoreModelClosure(closure);
    // Keep this genuine source-token owner pending until the original partial
    // and every retained parent have positively closed, including reuse.
    return receipt;
  }
  unsigned previous = 0;
  for (const auto& row : enumerateNativeDirectory(parent)) {
    if (row.name.starts_with(L"Kim_Vocal_2.onnx.previous-")) {
      if (row.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) fail("PATH_UNSAFE");
      if (++previous >= 8) fail("VAULT_RECOVERY_REQUIRED");
    }
  }
  validatePrivateFileCapability(source); assertStoreModelPrepare();
  closure->intent = intent;
  repairProtectedWrite(storeModelJournalKey, intent);
  return completeStoreModelPublication(intent, source.ancestors, &source, closure, true);
}
