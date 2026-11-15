#pragma once

// Include at global scope. This module proves fixed Worker code authority only;
// it neither creates a process nor substitutes for the guardian's Job/GPU lease.
#include "store_inventory.hpp"
#include "store_code_watch.hpp"
#include <algorithm>
#include <array>
#include <map>
#include <mutex>
#include <memory>
#include <set>

namespace mmstoreruntime {
using mmstore::CodeRole;
using mmstore::ErrorCode;
using mmstore::PackageKind;
using mmstore::require;

inline constexpr std::size_t maximumEntries = 65536;
inline constexpr std::uint64_t maximumPayloadBytes = 64ULL * 1024 * 1024 * 1024;
inline constexpr std::array workerRoles{
  CodeRole::workerControls, CodeRole::workerSession, CodeRole::workerNative,
  CodeRole::workerNode, CodeRole::workerPython, CodeRole::workerLoginAgent,
  CodeRole::workerSessionAgent, CodeRole::workerPersonalAgent, CodeRole::workerFleetAgent,
  CodeRole::workerPrepareAgent, CodeRole::workerFfmpeg, CodeRole::workerFfprobe, CodeRole::workerDeno
};
inline constexpr std::array<std::wstring_view, 30> engineFiles{
  L"__init__.py", L"__main__.py", L"artifacts.py", L"benchmark_coordinator.py",
  L"benchmark_file.py", L"capacity_benchmark.py", L"store_benchmark_file.py", L"store_benchmark_capacity.py", L"store_benchmark_context.py", L"child.py", L"consumer_personal.py",
  L"ipc.py", L"limits.py", L"local_run.py", L"media.py", L"model_tool.py", L"pipeline.py",
  L"provider_adapter.py", L"qualification.py", L"recipes.py", L"sentry_monitoring.py",
  L"separator.py", L"service_doctor.py", L"store_code_reader.py", L"store_consumer_personal.py", L"store_qualification.py", L"trimmer.py", L"windows_gpu.py",
  L"windows_guardian.py", L"windows_service_task.py"
};
inline constexpr std::array<std::wstring_view, 3> ortLibraries{
  L"worker/runtime/python/python312.dll",
  L"worker/runtime/python/Lib/site-packages/onnxruntime/capi/DirectML.dll",
  L"worker/runtime/python/Lib/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.pyd"
};
inline std::wstring foldedPath(std::wstring_view path) {
  std::wstring result(path);
  std::transform(result.begin(), result.end(), result.begin(), mmstore::asciiUpper);
  return result;
}
inline const mmstoreinventory::Entry& requiredEntry(const mmstoreinventory::Inventory& inventory, std::wstring_view path) {
  const auto found = std::find_if(inventory.entries.begin(), inventory.entries.end(), [&](const auto& entry) { return entry.path == path; });
  require(found != inventory.entries.end(), ErrorCode::fileDenied); return *found;
}
// These are policy checks, not constructors for OS authority. A policy fixture
// can exercise denial rules but cannot create WorkerCodeAuthority/LaunchPlan.
inline void validateWorkerInventory(const mmstoreinventory::Inventory& inventory, const mmstore::Observation& observed) {
  mmstore::validateObservation(PackageKind::worker, observed);
  require(inventory.kind == PackageKind::worker, ErrorCode::packageDenied);
  const auto submitted = mmstore::parseVersion(inventory.packageVersion);
  const auto installed = mmstore::parseVersion(observed.packageVersion);
  // Store may assign the installed revision. The submitted semantic version is
  // fixed; the actual fullName, including revision, remains the held authority.
  require(submitted[3] == 0 && std::equal(submitted.begin(), submitted.begin() + 3, installed.begin()), ErrorCode::stalePackage);
  require(!inventory.entries.empty() && inventory.entries.size() <= maximumEntries, ErrorCode::invalidInput);
  std::set<std::wstring> unique; std::wstring previous; std::uint64_t total = 0;
  for (const auto& entry : inventory.entries) {
    require(mmstore::validRelativePath(entry.path) && entry.path.starts_with(L"worker/") &&
      (previous.empty() || previous < entry.path) && unique.insert(foldedPath(entry.path)).second, ErrorCode::invalidInput);
    mmstore::validateInventoryPin(entry.pin);
    require(entry.pin.bytes <= maximumPayloadBytes - total, ErrorCode::fileDenied);
    total += entry.pin.bytes; previous = entry.path;
  }
  for (const auto role : workerRoles) (void)mmstoreinventory::codePin(inventory, role);
  for (const auto file : engineFiles) (void)requiredEntry(inventory, std::wstring(L"worker/app/engine/musicmute_engine/") + std::wstring(file));
  for (const auto* file : {L"worker/app/package.json", L"worker/app/dist/package.json",
    L"worker/runtime/requirements-directml.lock.txt", L"worker/tools/downloader/store_downloader_bootstrap.py", L"worker/app/dist/src/runtime/store-transfer-process.js"}) (void)requiredEntry(inventory, file);
  // The ONNX backend is bound to these exact module-local paths, never to a
  // same-named DLL elsewhere. Torch DirectML legitimately ships its own distinct
  // DirectML.dll. Both remain fully inventoried/held; the existing private PE
  // import audit resolves each consumer's adjacent dependency independently.
  for (const auto path : ortLibraries) (void)requiredEntry(inventory, path);
}

enum class LaunchKind {
  controls, session, nativeHelper, loginAgent, sessionAgent, personalAgent, fleetAgent,
  prepareAgent, personalEngine, fleetEngine, qualification, pythonGuardian,
  benchmarkFile, benchmarkCapacity, fleetTransfer, modelTool, ffmpeg, ffprobe, deno, downloader, doctorMetadata, doctorMedia
};
struct LaunchSpec { CodeRole executable; std::wstring_view entry; bool pythonModule; };
inline LaunchSpec launchSpec(LaunchKind kind) {
  switch (kind) {
    case LaunchKind::controls: return {CodeRole::workerControls, L"", false};
    case LaunchKind::session: return {CodeRole::workerSession, L"", false};
    case LaunchKind::nativeHelper: return {CodeRole::workerNative, L"", false};
    case LaunchKind::loginAgent: return {CodeRole::workerNode, mmstore::codeSpec(CodeRole::workerLoginAgent).relativePath, false};
    case LaunchKind::sessionAgent: return {CodeRole::workerNode, mmstore::codeSpec(CodeRole::workerSessionAgent).relativePath, false};
    case LaunchKind::personalAgent: return {CodeRole::workerNode, mmstore::codeSpec(CodeRole::workerPersonalAgent).relativePath, false};
    case LaunchKind::fleetAgent: return {CodeRole::workerNode, mmstore::codeSpec(CodeRole::workerFleetAgent).relativePath, false};
    case LaunchKind::prepareAgent: return {CodeRole::workerNode, mmstore::codeSpec(CodeRole::workerPrepareAgent).relativePath, false};
    case LaunchKind::personalEngine: return {CodeRole::workerPython, L"store_consumer_personal", true};
    case LaunchKind::fleetTransfer: return {CodeRole::workerNode,L"worker/app/dist/src/runtime/store-transfer-process.js",false};
    case LaunchKind::fleetEngine: return {CodeRole::workerPython, L"child", true};
    case LaunchKind::qualification: return {CodeRole::workerPython, L"store_qualification", true};
    case LaunchKind::pythonGuardian: return {CodeRole::workerPython, L"windows_guardian", true};
    case LaunchKind::benchmarkFile: return {CodeRole::workerPython, L"store_benchmark_file", true};
    case LaunchKind::benchmarkCapacity: return {CodeRole::workerPython, L"store_benchmark_capacity", true};
    case LaunchKind::modelTool: return {CodeRole::workerPython, L"model_tool", true};
    case LaunchKind::ffmpeg: return {CodeRole::workerFfmpeg, L"", false};
    case LaunchKind::ffprobe: return {CodeRole::workerFfprobe, L"", false};
    case LaunchKind::deno: return {CodeRole::workerDeno, L"", false};
    case LaunchKind::downloader: return {CodeRole::workerPython, L"worker/tools/downloader/store_downloader_bootstrap.py", false};
    case LaunchKind::doctorMetadata: case LaunchKind::doctorMedia: return {CodeRole::workerPython, L"service_doctor", true};
  }
  mmstore::fail(ErrorCode::invalidInput);
}
inline bool processRole(CodeRole role) {
  return role == CodeRole::workerControls || role == CodeRole::workerSession || role == CodeRole::workerNative ||
    role == CodeRole::workerNode || role == CodeRole::workerPython || role == CodeRole::workerFfmpeg ||
    role == CodeRole::workerFfprobe || role == CodeRole::workerDeno;
}

#ifdef _WIN32
inline bool sameProcessIdentity(const mmstore::ProcessIdentity& first, const mmstore::ProcessIdentity& second) {
  return first.pid == second.pid && first.creationTime == second.creationTime && first.sid == second.sid &&
    first.logonSid == second.logonSid && first.sessionId == second.sessionId;
}
namespace detail {
class FindHandle {
 public:
  explicit FindHandle(HANDLE handle) noexcept : handle_(handle) {}
  ~FindHandle() { if (handle_ != INVALID_HANDLE_VALUE) FindClose(handle_); }
  FindHandle(const FindHandle&) = delete;
  FindHandle& operator=(const FindHandle&) = delete;
 private:
  HANDLE handle_;
};
struct CodeState {
  mmstore::RegisteredPackage package;
  mmstore::ImmutableFile protectedInventory;
  mmstoreinventory::Inventory inventory;
  struct HeldCodeFile {
    std::wstring relative, absolute;
    mmstore::FilePin expected;
    mmstore::detail::Handle handle;
    BY_HANDLE_FILE_INFORMATION birth{};
    std::shared_ptr<std::mutex> digestMutex = std::make_shared<std::mutex>();
    const std::wstring& relativePath() const noexcept { return relative; }
    const mmstore::FilePin& pin() const noexcept { return expected; }
    void revalidate(bool digest = true) const {
      require(mmstore::detail::sameFile(birth, mmstore::detail::information(handle.get(), false)) &&
        mmstore::detail::samePath(mmstore::detail::canonical(handle.get()), absolute), ErrorCode::pathDenied);
      mmstore::detail::assertImmutableAcl(handle.get(), false);
      if (digest) { std::lock_guard lock(*digestMutex); require(mmstore::detail::hashFile(handle.get(), expected.bytes) == expected.sha256, ErrorCode::digestMismatch); }
      require(mmstore::detail::sameFile(birth, mmstore::detail::information(handle.get(), false)), ErrorCode::pathDenied);
    }
    std::wstring absolutePath() const { revalidate(); return absolute; }
  };
  std::vector<HeldCodeFile> files;
  struct HeldCodeDirectory {
    std::wstring relative, absolute; mmstore::detail::Handle handle; BY_HANDLE_FILE_INFORMATION birth{};
    void revalidate() const {
      require(mmstore::detail::sameFile(birth, mmstore::detail::information(handle.get(), true)) &&
        mmstore::detail::samePath(mmstore::detail::canonical(handle.get()), absolute), ErrorCode::pathDenied);
      mmstore::detail::assertImmutableAcl(handle.get(), true);
    }
  };
  std::vector<HeldCodeDirectory> directories;
  std::map<std::wstring, std::size_t, std::less<>> fileSlots, directorySlots;
  mutable HeldCodeChangeWatch changeWatch;
  bool admitted = false;
  mutable std::mutex admissionMutex;
  explicit CodeState(mmstore::RegisteredPackage registration, mmstore::ImmutableFile source, mmstoreinventory::Inventory parsed)
    : package(std::move(registration)), protectedInventory(std::move(source)), inventory(std::move(parsed)),
      changeWatch(mmstore::detail::joinedPath(package.observation().installedLocation, L"worker")) {}
  const HeldCodeFile& file(std::wstring_view path) const {
    const auto found = fileSlots.find(path); require(found != fileSlots.end() && found->second < files.size(), ErrorCode::fileDenied);
    return files[found->second];
  }
  void selectedIdentity(std::wstring_view path) const {
    const auto& held = file(path); held.revalidate(false);
    for (std::size_t at = 0;;) {
      const auto slash = path.find(L'/', at); if (slash == std::wstring_view::npos) break;
      const auto directory = directorySlots.find(path.substr(0, slash));
      require(directory != directorySlots.end() && directory->second < directories.size(), ErrorCode::pathDenied);
      directories[directory->second].revalidate(); at = slash + 1;
    }
    held.revalidate(false);
  }
  // Explicit bounded operation fence. Initial/new launch admission keeps the
  // complete digest/ACL closure; every original handle remains held here.
  void revalidateCriticalIdentity() const {
    require(admitted, ErrorCode::fileDenied); package.revalidate(); protectedInventory.revalidateIdentity();
    for (const auto role : {CodeRole::workerNative, CodeRole::workerSession, CodeRole::workerNode}) selectedIdentity(mmstore::codeSpec(role).relativePath);
    selectedIdentity(L"worker/release-manifest.json");
    protectedInventory.revalidateIdentity(); package.revalidate();
  }
  void revalidateOperationIdentity() const {
    changeWatch.requireLive(); revalidateCriticalIdentity(); changeWatch.requireLive();
  }
  void revalidateCleanupIdentity() const {
    // This never authorizes execution/IO/new work. Original creator-owned
    // retirement alone may retain identity proof after a watch invalidation.
    revalidateCriticalIdentity();
  }
  void revalidate(bool digest = true) const {
    std::lock_guard lock(admissionMutex);
    if (admitted) changeWatch.requireLive(); else changeWatch.requirePending();
    package.revalidate();
    if (digest) protectedInventory.revalidate(); else protectedInventory.revalidateIdentity();
    validateWorkerInventory(inventory, package.observation());
    for (const auto& directory : directories) {
      directory.revalidate();
    }
    // One registered-generation check brackets the whole held-file census.
    // Per-file checks use actual immutable handles, never cached success or a
    // caller supplied root. This avoids thousands of PackageManager queries.
    for (const auto& held : files) held.revalidate(digest);
    package.revalidate();
    if (admitted) changeWatch.requireLive(); else changeWatch.requirePending();
    // A previously admitted lease must stay tied to its original watch. The
    // initial census marks admission separately only after this full check.
  }
};
inline void enumerate(CodeState& state, std::wstring_view relative, unsigned depth, std::set<std::wstring>& seen) {
  require(depth <= 32 && state.directories.size() < maximumEntries, ErrorCode::pathDenied);
  const auto absolute = mmstore::detail::joinedPath(state.package.observation().installedLocation, relative);
  auto directory = mmstore::detail::openEntry(absolute, true, true);
  const auto directoryBirth = mmstore::detail::information(directory.get(), true);
  require(state.directorySlots.emplace(std::wstring(relative), state.directories.size()).second, ErrorCode::pathDenied);
  state.directories.push_back({std::wstring(relative), absolute, std::move(directory), directoryBirth});
  WIN32_FIND_DATAW data{};
  const auto raw = FindFirstFileExW((absolute + L"\\*").c_str(), FindExInfoBasic, &data, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
  if (raw == INVALID_HANDLE_VALUE) {
    require(GetLastError() == ERROR_FILE_NOT_FOUND, ErrorCode::fileDenied); return;
  }
  FindHandle search(raw); unsigned children = 0;
  do {
    require(++children <= maximumEntries, ErrorCode::fileDenied);
    const std::wstring leaf(data.cFileName);
    if (leaf == L"." || leaf == L"..") continue;
    require((data.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE)) == 0, ErrorCode::pathDenied);
    const auto path = std::wstring(relative) + L"/" + leaf;
    require(mmstore::validRelativePath(path), ErrorCode::pathDenied);
    if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) enumerate(state, path, depth + 1, seen);
    else {
      require(seen.size() < maximumEntries && seen.insert(foldedPath(path)).second, ErrorCode::fileDenied);
      // Actual casing must match the package-produced canonical inventory.
      const auto& entry = requiredEntry(state.inventory, path);
      const auto filePath = mmstore::detail::joinedPath(state.package.observation().installedLocation, entry.path);
      auto file = mmstore::detail::openEntry(filePath, false, true);
      const auto birth = mmstore::detail::information(file.get(), false);
      require(mmstore::detail::fileBytes(birth) == entry.pin.bytes, ErrorCode::digestMismatch);
      CodeState::HeldCodeFile held{entry.path, filePath, entry.pin, std::move(file), birth};
      held.revalidate(); require(state.fileSlots.emplace(entry.path, state.files.size()).second, ErrorCode::fileDenied); state.files.push_back(std::move(held));
    }
  } while (FindNextFileW(raw, &data));
  require(GetLastError() == ERROR_NO_MORE_FILES, ErrorCode::fileDenied);
}
} // namespace detail

class WorkerCodeAuthority;
class FixedLaunchPlan {
 public:
  FixedLaunchPlan(const FixedLaunchPlan&) = default;
  FixedLaunchPlan& operator=(const FixedLaunchPlan&) = default;
  LaunchKind kind() const noexcept { return kind_; }
  CodeRole executableRole() const { return launchSpec(kind_).executable; }
  const mmstore::Observation& observation() const noexcept { return state_->package.observation(); }
  std::wstring executablePath() const { return executableFile().absolutePath(); }
  const mmstore::FilePin& executablePin() const { return executableFile().pin(); }
  std::wstring engineRoot() const { return state_->package.absoluteResourcePath(L"worker/app/engine"); }
  std::wstring mediaRoot() const { return state_->package.absoluteResourcePath(L"worker/runtime/bin"); }
  std::wstring downloaderRoot() const { return state_->package.absoluteResourcePath(L"worker/tools/downloader"); }
  std::wstring downloaderCache() const { return state_->package.absoluteResourcePath(L"worker/tools/youtube/deno-cache"); }
  std::wstring downloaderProviderRoot() const { return state_->package.absoluteResourcePath(L"worker/tools/youtube/provider"); }
  std::wstring workingDirectory() const {
    if (kind_ == LaunchKind::downloader) return downloaderRoot();
    return launchSpec(kind_).pythonModule ? engineRoot() : state_->package.absoluteResourcePath(L"worker");
  }
  // Only the fixed interpreter/module or agent prefix is authorized here.
  // Root's operation-specific dispatcher must validate any appended data args,
  // filtered environment, inherited handles and suspended guardian-owned launch.
  std::vector<std::wstring> argumentPrefix() const {
    const auto spec = launchSpec(kind_);
    if (kind_ == LaunchKind::nativeHelper) return {L"--store-stdio"};
    if (kind_ == LaunchKind::downloader) return {L"-I", L"-B", L"-S", state_->file(spec.entry).absolutePath()};
    if (kind_ == LaunchKind::doctorMetadata) return {L"-I", L"-B", L"-c",
      L"import json,sys,importlib.metadata as m;sys.path.insert(0,sys.argv[1]);from musicmute_engine import CHILD_PROTOCOL_VERSION;import onnxruntime as ort;print(json.dumps({'pythonAccepted':sys.version_info[:2]==(3,12) and m.version('onnxruntime-directml')=='1.24.4' and m.version('audio-separator')=='0.47.0','directmlAvailable':'DmlExecutionProvider' in ort.get_available_providers(),'engineProtocolAccepted':CHILD_PROTOCOL_VERSION==1}))", engineRoot()};
    if (kind_ == LaunchKind::doctorMedia) return {L"-I", L"-B", L"-c",
      L"import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from musicmute_engine.service_doctor import validate_media_runtime;validate_media_runtime(Path(sys.argv[2]),Path(sys.argv[3]));print(json.dumps({'mediaToolsAccepted':True}))",
      engineRoot(), state_->package.absoluteResourcePath(L"worker/runtime/bin/ffmpeg.exe"), state_->package.absoluteResourcePath(L"worker/runtime/bin/ffprobe.exe")};
    if (spec.pythonModule) return {L"-I", L"-B", L"-c",
      L"import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine." + std::wstring(spec.entry) + L"',run_name='__main__')", engineRoot()};
    if (kind_ == LaunchKind::fleetTransfer) return {state_->file(spec.entry).absolutePath(),L"--store-transfer"};
    if (!spec.entry.empty()) return {state_->file(spec.entry).absolutePath()};
    return {};
  }
  void revalidate() const { state_->revalidate(); }
  // Available only on a plan backed by the initial complete hashed/held census.
  // It never substitutes for initial admission or a new executable/JS digest.
  void revalidateHeldIdentity() const { state_->revalidate(false); }
  void revalidateOperationIdentity() const {
    state_->revalidateOperationIdentity(); state_->selectedIdentity(mmstore::codeSpec(launchSpec(kind_).executable).relativePath);
    const auto spec = launchSpec(kind_);
    if (!spec.entry.empty()) state_->selectedIdentity(spec.pythonModule ? L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry));
    state_->revalidateOperationIdentity();
  }
  void revalidateCleanupIdentity() const {
    state_->revalidateCleanupIdentity(); state_->selectedIdentity(mmstore::codeSpec(launchSpec(kind_).executable).relativePath);
    const auto spec = launchSpec(kind_);
    if (!spec.entry.empty()) state_->selectedIdentity(spec.pythonModule ? L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry));
    state_->revalidateCleanupIdentity();
  }
  void revalidateFixedAdmission() const {
    state_->revalidate(); executableFile().revalidate();
    const auto spec = launchSpec(kind_);
    if (!spec.entry.empty()) state_->file(spec.pythonModule ?
      L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry)).revalidate();
    state_->revalidate(false);
  }
 private:
  FixedLaunchPlan(std::shared_ptr<detail::CodeState> state, LaunchKind kind) : state_(std::move(state)), kind_(kind) {}
  const detail::CodeState::HeldCodeFile& executableFile() const { return state_->file(mmstore::codeSpec(launchSpec(kind_).executable).relativePath); }
  std::shared_ptr<detail::CodeState> state_; LaunchKind kind_;
  friend class WorkerCodeAuthority;
};

class WorkerCodeAuthority {
 public:
  WorkerCodeAuthority(const WorkerCodeAuthority&) = default;
  WorkerCodeAuthority& operator=(const WorkerCodeAuthority&) = default;
  const mmstore::Observation& observation() const noexcept { return state_->package.observation(); }
  std::string inventorySha256() const {
    state_->revalidateOperationIdentity(); return state_->protectedInventory.pin().sha256;
  }
  mmstore::FilePin nativeHelperPin() const {
    state_->revalidateOperationIdentity(); return state_->file(mmstore::codeSpec(CodeRole::workerNative).relativePath).pin();
  }
  std::wstring cleanupNativeHelperPath() const {
    state_->revalidateCleanupIdentity(); return state_->file(mmstore::codeSpec(CodeRole::workerNative).relativePath).absolutePath();
  }
  std::size_t retainedFileCount() const noexcept { return state_->files.size(); }
  mmstore::FilePin runtimeManifestPin() const {
    state_->revalidateOperationIdentity(); const auto& manifest = state_->file(L"worker/release-manifest.json");
    manifest.revalidate(); const auto pin = manifest.pin(); state_->revalidateOperationIdentity(); return pin;
  }
  std::string engineDigest() const {
    state_->revalidateOperationIdentity();
    struct Digest {
      BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;std::vector<BYTE> object;
      ~Digest(){if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);}
    } digest;
    require(BCryptOpenAlgorithmProvider(&digest.algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)>=0,ErrorCode::fileDenied);
    DWORD objectBytes=0,received=0;require(BCryptGetProperty(digest.algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objectBytes),sizeof(objectBytes),&received,0)>=0 && received==sizeof(objectBytes),ErrorCode::fileDenied);
    digest.object.resize(objectBytes);require(BCryptCreateHash(digest.algorithm,&digest.hash,digest.object.data(),objectBytes,nullptr,0,0)>=0,ErrorCode::fileDenied);
    const auto feed=[&](const BYTE* bytes,std::size_t size){require(size<=UINT32_MAX && BCryptHashData(digest.hash,const_cast<PUCHAR>(bytes),static_cast<ULONG>(size),0)>=0,ErrorCode::fileDenied);};
    const BYTE zero=0;std::size_t count=0;std::uint64_t total=0;
    constexpr std::wstring_view engine=L"worker/app/engine/",package=L"worker/app/engine/musicmute_engine/";
    for(const auto& [path,slot]:state_->fileSlots){(void)slot;if(!path.starts_with(package) || !path.ends_with(L".py"))continue;
      const auto& held=state_->file(path);require(++count<=200 && held.pin().bytes<=10ULL*1024*1024-total,ErrorCode::fileDenied);total+=held.pin().bytes;
      state_->selectedIdentity(path);std::string relative;for(const auto value:std::wstring_view(path).substr(engine.size())){require(value>=32 && value<=126,ErrorCode::pathDenied);relative.push_back(value==L'/'?'\\':static_cast<char>(value));}
      feed(reinterpret_cast<const BYTE*>(relative.data()),relative.size());feed(&zero,1);
      {std::lock_guard lock(*held.digestMutex);require(mmstore::detail::hashFile(held.handle.get(),held.pin().bytes)==held.pin().sha256,ErrorCode::digestMismatch);
        require(SetFilePointerEx(held.handle.get(),{},nullptr,FILE_BEGIN),ErrorCode::fileDenied);std::array<BYTE,65536> bytes{};std::uint64_t read=0;
        while(read<held.pin().bytes){DWORD size=0;const auto wanted=static_cast<DWORD>((std::min)(held.pin().bytes-read,static_cast<std::uint64_t>(bytes.size())));require(ReadFile(held.handle.get(),bytes.data(),wanted,&size,nullptr) && size>0 && size<=wanted,ErrorCode::fileDenied);read+=size;feed(bytes.data(),size);}
        BYTE extra=0;DWORD size=0;require(ReadFile(held.handle.get(),&extra,1,&size,nullptr) && size==0,ErrorCode::fileDenied);
        require(mmstore::detail::hashFile(held.handle.get(),held.pin().bytes)==held.pin().sha256,ErrorCode::digestMismatch);
      }
      feed(&zero,1);state_->selectedIdentity(path);
    }
    require(count>0 && total>0,ErrorCode::fileDenied);std::array<BYTE,32> value{};require(BCryptFinishHash(digest.hash,value.data(),static_cast<ULONG>(value.size()),0)>=0,ErrorCode::fileDenied);
    std::string result;result.reserve(64);constexpr char hex[]="0123456789abcdef";for(const auto byte:value){result.push_back(hex[byte>>4]);result.push_back(hex[byte&15]);}
    state_->revalidateOperationIdentity();return result;
  }
  FixedLaunchPlan launchPlan(LaunchKind kind) const {
    const auto spec = launchSpec(kind); revalidate();
    (void)state_->file(mmstore::codeSpec(spec.executable).relativePath);
    if (!spec.entry.empty()) (void)state_->file(spec.pythonModule ?
      L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry));
    return FixedLaunchPlan(state_, kind);
  }
  FixedLaunchPlan heldLaunchPlan(LaunchKind kind) const {
    state_->revalidate(); const auto spec = launchSpec(kind);
    (void)state_->file(mmstore::codeSpec(spec.executable).relativePath);
    if (!spec.entry.empty()) (void)state_->file(spec.pythonModule ?
      L"worker/app/engine/musicmute_engine/" + std::wstring(spec.entry) + L".py" : std::wstring(spec.entry));
    FixedLaunchPlan plan(state_, kind); plan.revalidateFixedAdmission(); return plan;
  }
  mmstore::AttestedProcess attestMember(CodeRole role, const mmstore::ProcessIdentity& expected) const {
    require(processRole(role) && expected.pid > 0 && !expected.creationTime.empty(), ErrorCode::invalidInput);
    revalidate(); const auto& pin = state_->file(mmstore::codeSpec(role).relativePath).pin();
    auto member = mmstore::attestProcess(expected.pid, role, pin);
    require(sameProcessIdentity(expected, member.identity()) && member.observation().fullName == observation().fullName, ErrorCode::processDenied);
    revalidate(); member.revalidate(); return member;
  }
  mmstore::AttestedProcess attestChild(CodeRole role, const mmstore::ProcessIdentity& expected, const mmstore::AttestedProcess& parent) const {
    parent.revalidate();
    require(processRole(parent.role()) && parent.observation().fullName == observation().fullName, ErrorCode::processDenied);
    auto child = attestMember(role, expected);
    require(child.identity().pid != parent.identity().pid &&
      child.identity().sid == parent.identity().sid && child.identity().logonSid == parent.identity().logonSid &&
      child.identity().sessionId == parent.identity().sessionId &&
      mmstore::detail::creation(parent.handle()) <= mmstore::detail::creation(child.handle()) &&
      mmstore::detail::parentPid(child.identity().pid) == parent.identity().pid, ErrorCode::processDenied);
    parent.revalidate(); child.revalidate(); return child;
  }
  mmstore::AttestedProcess attestHeldMember(CodeRole role, const mmstore::ProcessIdentity& expected) const {
    require(processRole(role) && expected.pid > 0 && !expected.creationTime.empty(), ErrorCode::invalidInput);
    state_->revalidate(false); const auto& pin = state_->file(mmstore::codeSpec(role).relativePath).pin();
    auto member = mmstore::attestProcess(expected.pid, role, pin);
    require(sameProcessIdentity(expected, member.identity()) && member.observation().fullName == observation().fullName, ErrorCode::processDenied);
    state_->revalidate(false); member.revalidate(); return member;
  }
  mmstore::AttestedProcess attestHeldChild(CodeRole role, const mmstore::ProcessIdentity& expected, const mmstore::AttestedProcess& parent) const {
    parent.revalidate(); require(processRole(parent.role()) && parent.observation().fullName == observation().fullName, ErrorCode::processDenied);
    auto child = attestHeldMember(role, expected);
    require(child.identity().pid != parent.identity().pid && child.identity().sid == parent.identity().sid &&
      child.identity().logonSid == parent.identity().logonSid && child.identity().sessionId == parent.identity().sessionId &&
      mmstore::detail::creation(parent.handle()) <= mmstore::detail::creation(child.handle()) &&
      mmstore::detail::parentPid(child.identity().pid) == parent.identity().pid, ErrorCode::processDenied);
    parent.revalidate(); child.revalidate(); return child;
  }
  void revalidate() const { state_->revalidate(); }
  void revalidateHeldIdentity() const { state_->revalidate(false); }
  void revalidateOperationIdentity() const { state_->revalidateOperationIdentity(); }
  void revalidateCleanupIdentity() const { state_->revalidateCleanupIdentity(); }
 private:
  explicit WorkerCodeAuthority(std::shared_ptr<detail::CodeState> state) : state_(std::move(state)) {}
  std::shared_ptr<detail::CodeState> state_;
  friend WorkerCodeAuthority resolveWorkerCode();
};
inline WorkerCodeAuthority resolveWorkerCode() {
  auto package = mmstore::resolveRegisteredPackage(PackageKind::worker);
  auto inventoryFile = package.openInventory();
  const auto bytes = inventoryFile.read(8 * 1024 * 1024);
  const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  mmstoreinventory::Inventory inventory;
  try { inventory = mmstoreinventory::parse(PackageKind::worker, mm::JsonParser::storeCodeInventory(text)); }
  catch (const mmstore::Error&) { throw; }
  catch (...) { mmstore::fail(ErrorCode::invalidInput); }
  validateWorkerInventory(inventory, package.observation());
  auto state = std::make_shared<detail::CodeState>(std::move(package), std::move(inventoryFile), std::move(inventory));
  state->files.reserve(state->inventory.entries.size()); std::set<std::wstring> seen;
  detail::enumerate(*state, L"worker", 0, seen);
  require(seen.size() == state->inventory.entries.size(), ErrorCode::fileDenied);
  // Each file was just fully hashed with no write/delete sharing and remains
  // held. Repeat canonical/birth/ACL checks and the genuine package query after
  // the complete tree is acquired, without reading every dependency twice.
  state->revalidate(false); state->changeWatch.completedInitialCensus(); state->admitted = true; return WorkerCodeAuthority(std::move(state));
}
#endif // _WIN32: no synthetic registration or portable runtime substitute.
} // namespace mmstoreruntime
