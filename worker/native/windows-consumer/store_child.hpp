#pragma once
#include "store_child_policy.hpp"
#include "store_tool_policy.hpp"
#include "store_qualification_policy.hpp"
#include "store_child_handle.hpp"
// Included by the genuine Store Creator after main.cpp's private filesystem,
// environment and process primitives. No JSON can construct this owner.
namespace mmstorerole {
#ifdef _WIN32
class StoreSessionCreator;
class StoreEngineChild final {
 public:
  ~StoreEngineChild() {
    if (job_.valid() && jobCreated_) (void)TerminateJobObject(job_.value, 2);
    if (toolStopped_.valid()) (void)SetEvent(toolStopped_.value);
    if (toolDeadline_.joinable()) toolDeadline_.join();
    { std::lock_guard lock(ioMutex_); stopping_ = true; ioChanged_.notify_all(); }
    cancelReader(stdoutThread_); cancelReader(stderrThread_);
    if (write_) { cancelReader(write_->thread); if (write_->thread.joinable()) write_->thread.join(); }
    if (stdoutThread_.joinable()) stdoutThread_.join();
    if (stderrThread_.joinable()) stderrThread_.join();
    // The Creator retains this object until its actual child Job is zero.
    auto tokens = inputTokens_; tokens.insert(tokens.end(), {configToken_, modelToken_});
    for (const auto& token : tokens) if (!token.empty()) {
      try { (void)closePrivateFile(Json::Object{{"token", token}}); } catch (...) {}
    }
  }
  StoreEngineChild(const StoreEngineChild&) = delete;
  StoreEngineChild& operator=(const StoreEngineChild&) = delete;
 private:
  StoreEngineChild(mmstoreruntime::WorkerCodeAuthority code, mmstoreruntime::FixedLaunchPlan guardian,
      mmstoreruntime::FixedLaunchPlan engine, mmstore::ProcessIdentity owner, std::string ownerNonce)
    : code_(std::move(code)), guardian_(std::move(guardian)), engine_(std::move(engine)), owner_(std::move(owner)), ownerNonce_(std::move(ownerNonce)), token_(detail::secret()) {}
  void retainGpuKeeper(HANDLE keeper, HANDLE release) {
    require(!cpuTool_ && !keeper_.valid() && !gpuRelease_.valid(), ErrorCode::processDenied);
    const auto copiedKeeper = DuplicateHandle(GetCurrentProcess(), keeper, GetCurrentProcess(), &keeper_.value, SYNCHRONIZE, FALSE, 0);
    require(copiedKeeper != FALSE && keeper_.valid(), ErrorCode::processDenied);
    const auto copiedRelease = DuplicateHandle(GetCurrentProcess(), release, GetCurrentProcess(), &gpuRelease_.value, SYNCHRONIZE, FALSE, 0);
    require(copiedRelease != FALSE && gpuRelease_.valid(), ErrorCode::processDenied);
  }
  StoreEngineChild(mmstoreruntime::WorkerCodeAuthority code, mmstoreruntime::FixedLaunchPlan executable,
      mmstore::ProcessIdentity owner, std::string ownerNonce)
    : code_(std::move(code)), guardian_(executable), engine_(std::move(executable)), owner_(std::move(owner)),
      ownerNonce_(std::move(ownerNonce)), token_(detail::secret()), cpuTool_(true) {}
  void revalidate(HANDLE nodeJob, const mmstore::AttestedProcess& node, const mmstoreruntime::FixedLaunchPlan& nodePlan) {
    code_.revalidateOperationIdentity(); node.revalidate(); nodePlan.revalidateOperationIdentity();
    require(mmstore::detail::sameIdentity(node.identity(), owner_) && node.role() == mmstore::CodeRole::workerNode &&
      (nodePlan.kind() == mmstoreruntime::LaunchKind::personalAgent || ((engine_.kind() == mmstoreruntime::LaunchKind::fleetEngine || engine_.kind() == mmstoreruntime::LaunchKind::fleetTransfer) && nodePlan.kind() == mmstoreruntime::LaunchKind::fleetAgent) || ((cpuTool_ || qualification_) && nodePlan.kind() == mmstoreruntime::LaunchKind::prepareAgent)) && node.observation().fullName == code_.observation().fullName,
      ErrorCode::processDenied);
    detail::requireKillJob(nodeJob); detail::requireMember(node.handle(), nodeJob); detail::requireMember(GetCurrentProcess(), nodeJob, false);
    if (!cpuTool_) require(keeper_.valid() && gpuRelease_.valid() && WaitForSingleObject(keeper_.value, 0) == WAIT_TIMEOUT &&
      WaitForSingleObject(gpuRelease_.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
    if (!configToken_.empty()) (void)validatePrivateFileCapability(privateFileCapability(Json::Object{{"token", configToken_}}));
    if (!modelToken_.empty()) (void)validatePrivateFileCapability(privateFileCapability(Json::Object{{"token", modelToken_}}));
    for (const auto& token : inputTokens_) (void)validatePrivateFileCapability(privateFileCapability(Json::Object{{"token", token}}));
    if (!reportDirectory_.ancestors.empty()) validatePrivateFileAncestors(reportDirectory_);
    if (!workDirectory_.ancestors.empty())validatePrivateFileAncestors(workDirectory_);
    if (!savedDirectory_.ancestors.empty())validatePrivateFileAncestors(savedDirectory_);
  }
  static void holdDirectory(PrivateFileCapability& retained,const std::wstring& path,const std::wstring& root) {
    require(retained.ancestors.empty(),ErrorCode::pathDenied);retained.path=path;retained.root=root;
    holdStorePrivateDirectories(path,root,retained.ancestors);
    for(const auto& handle:retained.ancestors){retained.ancestorPaths.push_back(nativeCanonical(handle.value));retained.ancestorBirths.push_back(nativeEntryInformation(handle.value,NativeChildKind::directory));}
    validatePrivateFileAncestors(retained);require(_wcsicmp(retained.ancestorPaths.back().c_str(),path.c_str())==0,ErrorCode::pathDenied);
  }
  static std::string holdFile(const std::string& relative, std::uint64_t maximum, std::string* originalToken) {
    require(originalToken && originalToken->empty(), ErrorCode::processDenied);
    const auto opened = openPrivateFile(Json::Object{{"root", "personal"}, {"relative_path", relative}, {"mode", "read"},
      {"maximum_bytes", static_cast<std::int64_t>(maximum)}, {"expected_birth", nullptr}}, false, false, true, originalToken);
    require(opened.at("state").string() == "opened" && !originalToken->empty() && opened.at("token").string() == *originalToken, ErrorCode::fileDenied);
    return *originalToken;
  }
  void startTransfer(const std::wstring& work, const std::string& operation, const std::string& attempt, const std::string& incarnation, const std::wstring& target, HANDLE heldParent,
      HANDLE nodeJob, const mmstore::AttestedProcess& node, const mmstoreruntime::FixedLaunchPlan& nodePlan) {
    require(cpuTool_ && engine_.kind()==mmstoreruntime::LaunchKind::fleetTransfer && nodePlan.kind()==mmstoreruntime::LaunchKind::fleetAgent && !process_.valid(),ErrorCode::processDenied);
    transfer_=true; transferOperation_=operation; transferAttempt_=attempt; transferIncarnation_=incarnation; transferRoot_=work; transferPath_=target;
    if(operation=="upload") {
      const auto opened=openNativeChild(heldParent,L"vocals.mp3",GENERIC_READ|READ_CONTROL|FILE_READ_ATTRIBUTES,FILE_SHARE_READ,NativeChildKind::file,NativeChildDisposition::open,nullptr,false,&transferFile_);
      require(opened.status==0 && transferFile_.valid(),ErrorCode::pathDenied); assertPrivateHandle(transferFile_.value);
      require(_wcsicmp(nativeCanonical(transferFile_.value).c_str(),target.c_str())==0,ErrorCode::pathDenied); transferBirth_=cacheHandleBirth(transferFile_.value);
    }
    std::vector<wchar_t> windowsBuffer(32768);const auto count=GetWindowsDirectoryW(windowsBuffer.data(),static_cast<UINT>(windowsBuffer.size()));require(count>0 && count<windowsBuffer.size(),ErrorCode::processDenied);
    const std::wstring windows(windowsBuffer.data(),count); ConsumerEnvironmentEntries environment;
    environment.emplace(L"SystemRoot",windows);environment.emplace(L"WINDIR",windows);environment.emplace(L"PATH",engine_.executablePath().substr(0,engine_.executablePath().find_last_of(L'\\'))+L";"+windows+L"\\System32");
    engine_.revalidateFixedAdmission();revalidate(nodeJob,node,nodePlan);
    toolStopped_=::Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));require(toolStopped_.valid(),ErrorCode::processDenied);
    startProcess(engine_,engine_.argumentPrefix(),encodeConsumerEnvironment(environment),work,nodeJob,node,nodePlan);
    toolDeadline_=std::thread([this]{if(WaitForSingleObject(toolStopped_.value,7200000)!=WAIT_OBJECT_0){(void)TerminateJobObject(job_.value,2);std::lock_guard lock(ioMutex_);ioFailed_=true;ioChanged_.notify_all();}});
  }
  Json writeTransfer(const Json& args) {
    const auto bytes=base64Decode(args.at("bytes_base64").string(),24576);const auto end=std::get<bool>(args.at("end").value);
    std::lock_guard transferLock(transferMutex_);
    { require(transfer_ && !transferInputClosed_ && transferBytes_.size()+bytes.size()<=65536,ErrorCode::processDenied);
      transferBytes_.insert(transferBytes_.end(),bytes.begin(),bytes.end());
      if(end){require(!transferBytes_.empty() && transferBytes_.back()==10 && std::find(transferBytes_.begin(),transferBytes_.end()-1,BYTE{10})==transferBytes_.end()-1 &&
        std::find(transferBytes_.begin(),transferBytes_.end(),BYTE{13})==transferBytes_.end(),ErrorCode::invalidInput);
        const auto request=mm::JsonParser(std::string(transferBytes_.begin(),transferBytes_.end()-1)).parse();
        require(data_policy::fields(request,{"version","requestId","operation","attemptId","workspace","path","grant","expected","options"}) && request.at("version").integer()==1 &&
          request.at("requestId").string()==transferIncarnation_ && request.at("operation").string()==transferOperation_ && request.at("attemptId").string()==transferAttempt_ &&
          request.at("workspace").string()==utf8(transferRoot_) && request.at("path").string()==utf8(transferPath_),ErrorCode::processDenied);
        if(transferFile_.valid()){nativeEntryInformation(transferFile_.value,NativeChildKind::file);assertPrivateHandle(transferFile_.value);require(mm::dump(cacheHandleBirth(transferFile_.value))==mm::dump(transferBirth_),ErrorCode::pathDenied);}
      }
    }
    const auto result=write(Json::Object{{"bytes_base64",args.at("bytes_base64")}});
    if(end){std::lock_guard lock(ioMutex_);closeOwned(input_);transferInputClosed_=true;std::fill(transferBytes_.begin(),transferBytes_.end(),BYTE{});transferBytes_.clear();}
    return result;
  }
  void startQualification(const Json& request, HANDLE nodeJob, const mmstore::AttestedProcess& node,
      const mmstoreruntime::FixedLaunchPlan& nodePlan, const Json& gpu) {
    qualification_ = true;
    require(!cpuTool_ && storePrepareRequest(request) && request.at("operation").string() == "qualify" &&
      engine_.kind() == mmstoreruntime::LaunchKind::qualification && guardian_.kind() == mmstoreruntime::LaunchKind::pythonGuardian &&
      mm::dump(request.at("gpu")) == mm::dump(gpu) && !process_.valid(), ErrorCode::processDenied);
    revalidate(nodeJob, node, nodePlan);
    const auto id = request.at("requestId").string(), relative = "prepare\\work\\" + id;
    (void)holdFile(relative + "\\store-qualification-request.json", 8192, &configToken_);
    auto& config = privateFileCapability(Json::Object{{"token", configToken_}}); const auto before = validatePrivateFileCapability(config);
    const auto size = before.at("bytes").integer(); require(size > 1 && size <= 8192, ErrorCode::fileDenied);
    const auto read = readPrivateFile(Json::Object{{"token", configToken_}, {"position", 0}, {"length", size}});
    const auto bytes = base64Decode(read.at("bytes_base64").string(), 8192);
    require(read.at("bytes_read").integer() == size && bytes.size() == static_cast<std::size_t>(size) &&
      mm::dump(validatePrivateFileCapability(config)) == mm::dump(before) &&
      mm::dump(mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse()) == mm::dump(request), ErrorCode::processDenied);
    const auto root = rootPath("personal"), work = root + L"\\" + wide(relative);
    require(!config.ancestors.empty() && _wcsicmp(nativeCanonical(config.ancestors.back().value).c_str(), work.c_str()) == 0, ErrorCode::pathDenied);
    (void)holdFile("models\\Kim_Vocal_2.onnx", 66759214, &modelToken_);
    auto& model = privateFileCapability(Json::Object{{"token", modelToken_}});
    require(validatePrivateFileCapability(model).at("bytes").integer() == 66759214 &&
      hashFile(model.file.value, 66759214) == "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b", ErrorCode::digestMismatch);
    const auto& fixture = request.at("fixture"); const bool fixed = fixture.at("kind").string() == "fixed";
    const auto fixtureRelative = fixed ? std::string("fixtures\\prepare-fixture.wav") : fixture.at("relativePath").string();
    const auto fixtureDigest = fixed ? std::string(qualificationFixtureSha256) : fixture.at("sha256").string();
    const auto fixtureBytes = fixed ? qualificationFixtureBytes : static_cast<std::uint64_t>(fixture.at("bytes").integer());
    inputTokens_.emplace_back(); auto& fixtureToken = inputTokens_.back(); (void)holdFile(fixtureRelative, fixtureBytes, &fixtureToken);
    auto& heldFixture = privateFileCapability(Json::Object{{"token", fixtureToken}});
    require(validatePrivateFileCapability(heldFixture).at("bytes").integer() == static_cast<std::int64_t>(fixtureBytes) &&
      hashFile(heldFixture.file.value, fixtureBytes) == fixtureDigest, ErrorCode::digestMismatch);
    const auto report = root + L"\\prepare\\results\\" + wide(id) + L".raw.json";
    reportDirectory_.root = root; reportDirectory_.path = report;
    holdStorePrivateDirectories(root+L"\\prepare\\results",root,reportDirectory_.ancestors);
    for (const auto& ancestor : reportDirectory_.ancestors) { reportDirectory_.ancestorPaths.push_back(nativeCanonical(ancestor.value)); reportDirectory_.ancestorBirths.push_back(nativeEntryInformation(ancestor.value, NativeChildKind::directory)); }
    validatePrivateFileAncestors(reportDirectory_);
    require(!reportDirectory_.ancestors.empty() && nativeChildMissing(reportDirectory_.ancestors.back().value, wide(id) + L".raw.json"), ErrorCode::pathDenied);
    auto arguments = guardian_.argumentPrefix(); arguments.insert(arguments.end(), {L"--parent-pid", std::to_wstring(owner_.pid), L"--detached-console", L"--"});
    const auto prefix = engine_.argumentPrefix(); arguments.insert(arguments.end(), prefix.begin(), prefix.end());
    arguments.insert(arguments.end(), {L"--provider", L"directml", L"--fixture", heldFixture.path, L"--fixture-sha256", wide(fixtureDigest),
      L"--work-root", work, L"--release-root", code_.observation().installedLocation + L"\\worker", L"--model-cache", root + L"\\models",
      L"--ffmpeg", engine_.mediaRoot() + L"\\ffmpeg.exe", L"--ffprobe", engine_.mediaRoot() + L"\\ffprobe.exe", L"--runtime-profile", L"windows-user",
      L"--expected-user-sid", owner_.sid, L"--directml-device-id", std::to_wstring(gpu.at("deviceIndex").integer()), L"--report", report});
    std::vector<wchar_t> windowsBuffer(32768); const auto count = GetWindowsDirectoryW(windowsBuffer.data(), static_cast<UINT>(windowsBuffer.size()));
    require(count > 0 && count < windowsBuffer.size(), ErrorCode::processDenied); const std::wstring windows(windowsBuffer.data(), count);
    ConsumerEnvironmentEntries environment; environment.emplace(L"SystemRoot", windows); environment.emplace(L"WINDIR", windows);
    environment.emplace(L"PATH", engine_.mediaRoot() + L";" + windows + L"\\System32");
    for (const auto* key : {L"TEMP", L"TMP", L"MPLCONFIGDIR", L"NUMBA_CACHE_DIR", L"XDG_CACHE_HOME"}) environment.emplace(key, work);
    environment.emplace(L"PYTHONDONTWRITEBYTECODE", L"1"); environment.emplace(L"PYTHONNOUSERSITE", L"1"); environment.emplace(L"PYTHONUNBUFFERED", L"1"); environment.emplace(L"MUSICMUTE_SENTRY_ENGINE_ENABLED", L"0");
    guardian_.revalidateFixedAdmission(); engine_.revalidateFixedAdmission(); revalidate(nodeJob, node, nodePlan);
    toolStopped_ = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(toolStopped_.valid(), ErrorCode::processDenied);
    startProcess(guardian_, arguments, encodeConsumerEnvironment(environment), work, nodeJob, node, nodePlan);
    closeOwned(input_);
    toolDeadline_ = std::thread([this] { if (WaitForSingleObject(toolStopped_.value, 840000) != WAIT_OBJECT_0) { (void)TerminateJobObject(job_.value, 2); std::lock_guard lock(ioMutex_); ioFailed_ = true; ioChanged_.notify_all(); } });
  }
  void startBenchmark(const Json& request,const std::string& canonicalConfiguration, HANDLE nodeJob, const mmstore::AttestedProcess& node,
      const mmstoreruntime::FixedLaunchPlan& nodePlan, const Json& gpu) {
    qualification_ = true;benchmark_=true;
    const auto& configuration=request.at("configuration");const auto& binding=request.at("binding");
    require(!cpuTool_ && storeBenchmarkConfiguration(configuration,binding,request.at("requestId").string(),request.at("operation").string()) &&
      engine_.kind()==(request.at("operation").string()=="benchmark_file"?mmstoreruntime::LaunchKind::benchmarkFile:mmstoreruntime::LaunchKind::benchmarkCapacity) &&
      guardian_.kind()==mmstoreruntime::LaunchKind::pythonGuardian && mm::dump(configuration.at("gpu"))==mm::dump(gpu) && !process_.valid(),ErrorCode::processDenied);
    revalidate(nodeJob, node, nodePlan);
    const auto id = request.at("requestId").string(), relative = "prepare\\work\\" + id;
    (void)holdFile(relative + "\\store-benchmark-config.json", 16384, &configToken_);
    auto& config = privateFileCapability(Json::Object{{"token", configToken_}}); const auto before = validatePrivateFileCapability(config);
    const auto size = before.at("bytes").integer(); require(size > 1 && size <= 16384, ErrorCode::fileDenied);
    const auto read = readPrivateFile(Json::Object{{"token", configToken_}, {"position", 0}, {"length", size}});
    const auto bytes = base64Decode(read.at("bytes_base64").string(), 16384);
    require(read.at("bytes_read").integer() == size && bytes.size() == static_cast<std::size_t>(size) &&
      mm::dump(validatePrivateFileCapability(config)) == mm::dump(before) &&
      std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size())==canonicalConfiguration &&
      mm::dump(mm::JsonParser(canonicalConfiguration,true).parse())==mm::dump(configuration), ErrorCode::processDenied);
    benchmarkConfigurationSha_=hashFile(config.file.value,16384);

    const auto root = rootPath("personal"), work = root + L"\\" + wide(relative) + L"\\engine";
    require(!config.ancestors.empty() && _wcsicmp(nativeCanonical(config.ancestors.back().value).c_str(), (root+L"\\"+wide(relative)).c_str()) == 0, ErrorCode::pathDenied);
    holdDirectory(workDirectory_,work,root);
    if(configuration.object().contains("saveAudio") && std::get<bool>(configuration.at("saveAudio").value))holdDirectory(savedDirectory_,root+L"\\"+wide(relative)+L"\\saved-audio",root);
    (void)holdFile("models\\Kim_Vocal_2.onnx", 66759214, &modelToken_);
    auto& model = privateFileCapability(Json::Object{{"token", modelToken_}});
    require(validatePrivateFileCapability(model).at("bytes").integer() == 66759214 &&
      hashFile(model.file.value, 66759214) == "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b", ErrorCode::digestMismatch);
    const auto& fixture=configuration.at("fixture");
    const auto fixtureRelative=fixture.at("relativePath").string(),fixtureDigest=fixture.at("sha256").string();
    const auto fixtureBytes=static_cast<std::uint64_t>(fixture.at("bytes").integer());
    inputTokens_.emplace_back(); auto& fixtureToken = inputTokens_.back(); (void)holdFile(fixtureRelative, fixtureBytes, &fixtureToken);
    auto& heldFixture = privateFileCapability(Json::Object{{"token", fixtureToken}});
    require(validatePrivateFileCapability(heldFixture).at("bytes").integer() == static_cast<std::int64_t>(fixtureBytes) &&
      hashFile(heldFixture.file.value, fixtureBytes) == fixtureDigest, ErrorCode::digestMismatch);
    const auto report = root + L"\\prepare\\results\\" + wide(id) + L".benchmark.raw.json";
    reportDirectory_.root = root; reportDirectory_.path = report;
    holdStorePrivateDirectories(root+L"\\prepare\\results",root,reportDirectory_.ancestors);
    for (const auto& ancestor : reportDirectory_.ancestors) { reportDirectory_.ancestorPaths.push_back(nativeCanonical(ancestor.value)); reportDirectory_.ancestorBirths.push_back(nativeEntryInformation(ancestor.value, NativeChildKind::directory)); }
    validatePrivateFileAncestors(reportDirectory_);
    require(!reportDirectory_.ancestors.empty() && nativeChildMissing(reportDirectory_.ancestors.back().value, wide(id) + L".benchmark.raw.json"), ErrorCode::pathDenied);
    auto arguments = guardian_.argumentPrefix(); arguments.insert(arguments.end(), {L"--parent-pid", std::to_wstring(owner_.pid), L"--detached-console", L"--"});
    const auto prefix = engine_.argumentPrefix(); arguments.insert(arguments.end(), prefix.begin(), prefix.end());
    arguments.insert(arguments.end(), {L"--provider", L"directml", L"--fixture", heldFixture.path, L"--fixture-sha256", wide(fixtureDigest),
      L"--work-root", work, L"--release-root", code_.observation().installedLocation + L"\\worker", L"--model-cache", root + L"\\models",
      L"--ffmpeg", engine_.mediaRoot() + L"\\ffmpeg.exe", L"--ffprobe", engine_.mediaRoot() + L"\\ffprobe.exe", L"--runtime-profile", L"windows-user",
      L"--expected-user-sid", owner_.sid, L"--directml-device-id", std::to_wstring(gpu.at("deviceIndex").integer()),
      L"--warmup-runs",std::to_wstring(configuration.at("warmupRuns").integer()),L"--measured-runs",std::to_wstring(configuration.at("measuredRuns").integer()),L"--group-size",L"1",L"--report", report});
    if(request.at("operation").string()=="benchmark_file")arguments.insert(arguments.end(),{L"--recipe-id",wide(configuration.at("recipe").string())});
    if(configuration.object().contains("candidate"))arguments.insert(arguments.end(),{L"--candidate-engine-root",engine_.engineRoot()});
    if(configuration.object().contains("saveAudio") && std::get<bool>(configuration.at("saveAudio").value))arguments.insert(arguments.end(),{L"--save-audio-dir",root+L"\\"+wide(relative)+L"\\saved-audio"});
    std::vector<wchar_t> windowsBuffer(32768); const auto count = GetWindowsDirectoryW(windowsBuffer.data(), static_cast<UINT>(windowsBuffer.size()));
    require(count > 0 && count < windowsBuffer.size(), ErrorCode::processDenied); const std::wstring windows(windowsBuffer.data(), count);
    ConsumerEnvironmentEntries environment; environment.emplace(L"SystemRoot", windows); environment.emplace(L"WINDIR", windows);
    environment.emplace(L"PATH", engine_.mediaRoot() + L";" + windows + L"\\System32");
    for (const auto* key : {L"TEMP", L"TMP", L"MPLCONFIGDIR", L"NUMBA_CACHE_DIR", L"XDG_CACHE_HOME"}) environment.emplace(key, work);
    environment.emplace(L"PYTHONDONTWRITEBYTECODE", L"1"); environment.emplace(L"PYTHONNOUSERSITE", L"1"); environment.emplace(L"PYTHONUNBUFFERED", L"1"); environment.emplace(L"MUSICMUTE_SENTRY_ENGINE_ENABLED", L"0");
    guardian_.revalidateFixedAdmission(); engine_.revalidateFixedAdmission(); revalidate(nodeJob, node, nodePlan);
    toolStopped_ = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(toolStopped_.valid(), ErrorCode::processDenied);
    startProcess(guardian_, arguments, encodeConsumerEnvironment(environment), work, nodeJob, node, nodePlan);
    closeOwned(input_);
    toolDeadline_ = std::thread([this] { if (WaitForSingleObject(toolStopped_.value, 7140000) != WAIT_OBJECT_0) { (void)TerminateJobObject(job_.value, 2); std::lock_guard lock(ioMutex_); ioFailed_ = true; ioChanged_.notify_all(); } });
  }
  void start(const std::string& relative, const std::string& incarnation, HANDLE nodeJob, const mmstore::AttestedProcess& node,
      const mmstoreruntime::FixedLaunchPlan& nodePlan, const Json& gpu) {
    require(!cpuTool_ && data_policy::uuid(incarnation) && !process_.valid(), ErrorCode::invalidInput);
    const bool fleet = engine_.kind() == mmstoreruntime::LaunchKind::fleetEngine;
    engineIncarnation_=incarnation;
    require(fleet || engine_.kind() == mmstoreruntime::LaunchKind::personalEngine, ErrorCode::processDenied);
    const auto session = engineSessionId(relative, fleet ? Role::fleet : Role::personal); revalidate(nodeJob, node, nodePlan);
    (void)holdFile(relative, 16384, &configToken_);
    auto& config = privateFileCapability(Json::Object{{"token", configToken_}}); const auto before = validatePrivateFileCapability(config);
    const auto length = before.at("bytes").integer(); require(length > 1 && length <= 16384, ErrorCode::fileDenied);
    const auto read = readPrivateFile(Json::Object{{"token", configToken_}, {"position", 0}, {"length", length}});
    const auto bytes = base64Decode(read.at("bytes_base64").string(), 16384);
    require(read.at("bytes_read").integer() == length && bytes.size() == static_cast<std::size_t>(length) &&
      mm::dump(validatePrivateFileCapability(config)) == mm::dump(before), ErrorCode::fileDenied);
    const auto configuration = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())).parse();
    require(fleet ? fleetEngineConfig(configuration, session, utf8(rootPath("personal")), utf8(rootPath("fleet")), utf8(engine_.observation().installedLocation + L"\\worker"), utf8(owner_.sid), gpu) :
      personalEngineConfig(configuration, session, utf8(rootPath("personal")), utf8(engine_.observation().installedLocation + L"\\worker"), utf8(owner_.sid), gpu), ErrorCode::processDenied);
    (void)holdFile("models\\Kim_Vocal_2.onnx", 66759214, &modelToken_);
    auto& model = privateFileCapability(Json::Object{{"token", modelToken_}});
    require(validatePrivateFileCapability(model).at("bytes").integer() == 66759214 &&
      hashFile(model.file.value, 66759214) == "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b", ErrorCode::digestMismatch);
    const auto work = rootPath("personal") + (fleet ? L"\\fleet\\engine-session\\" : L"\\personal\\engine-session\\") + wide(session);
    require(!config.ancestors.empty() && _wcsicmp(nativeCanonical(config.ancestors.back().value).c_str(), work.c_str()) == 0, ErrorCode::pathDenied);
    std::vector<wchar_t> windowsBuffer(32768); const auto windowsSize = GetWindowsDirectoryW(windowsBuffer.data(), static_cast<UINT>(windowsBuffer.size()));
    require(windowsSize > 0 && windowsSize < windowsBuffer.size(), ErrorCode::processDenied); const std::wstring windows(windowsBuffer.data(), windowsSize);
    ConsumerEnvironmentEntries environment;
    environment.emplace(L"SystemRoot", windows); environment.emplace(L"WINDIR", windows);
    environment.emplace(L"PATH", guardian_.executablePath().substr(0, guardian_.executablePath().find_last_of(L'\\')) + L";" + engine_.mediaRoot() + L";" + windows + L"\\System32");
    for (const auto* key : {L"TEMP", L"TMP", L"MPLCONFIGDIR", L"NUMBA_CACHE_DIR", L"XDG_CACHE_HOME"}) environment.emplace(key, work);
    environment.emplace(L"PYTHONDONTWRITEBYTECODE", L"1"); environment.emplace(L"PYTHONNOUSERSITE", L"1"); environment.emplace(L"PYTHONUNBUFFERED", L"1");
    environment.emplace(L"MUSICMUTE_SENTRY_ENGINE_ENABLED", L"0"); auto block = encodeConsumerEnvironment(environment);
    guardian_.revalidateFixedAdmission(); engine_.revalidateFixedAdmission();
    auto arguments = guardian_.argumentPrefix(); arguments.push_back(L"--parent-pid"); arguments.push_back(std::to_wstring(owner_.pid)); arguments.push_back(L"--detached-console"); arguments.push_back(L"--");
    const auto engineArguments = engine_.argumentPrefix(); arguments.insert(arguments.end(), engineArguments.begin(), engineArguments.end());
    if (fleet) arguments.insert(arguments.end(), {L"--model-cache-root", rootPath("personal") + L"\\models", L"--provider", L"directml", L"--directml-device-id", std::to_wstring(gpu.at("deviceIndex").integer())});
    else { arguments.push_back(L"--consumer-config"); arguments.push_back(config.path); }
    arguments.push_back(L"--incarnation"); arguments.push_back(wide(incarnation));
    startProcess(guardian_, arguments, block, guardian_.workingDirectory(), nodeJob, node, nodePlan);
  }
  void startTool(FixedToolKind kind, const std::string& request, const std::string& configurationSha256, HANDLE nodeJob, const mmstore::AttestedProcess& node,
      const mmstoreruntime::FixedLaunchPlan& nodePlan) {
    require(cpuTool_ && data_policy::uuid(request) && !process_.valid() && guardian_.kind() == fixedToolLaunch(kind), ErrorCode::invalidInput);
    revalidate(nodeJob, node, nodePlan);
    const auto relative = fixedToolWork(kind, request), configRelative = relative + "\\store-tool-config.json";
    (void)holdFile(configRelative, 16384, &configToken_);
    auto& configFile = privateFileCapability(Json::Object{{"token", configToken_}}); const auto before = validatePrivateFileCapability(configFile);
    const auto length = before.at("bytes").integer(); require(length > 1 && length <= 16384, ErrorCode::fileDenied);
    const auto read = readPrivateFile(Json::Object{{"token", configToken_}, {"position", 0}, {"length", length}});
    const auto bytes = base64Decode(read.at("bytes_base64").string(), 16384);
    require(read.at("bytes_read").integer() == length && bytes.size() == static_cast<std::size_t>(length) &&
      mm::dump(validatePrivateFileCapability(configFile)) == mm::dump(before), ErrorCode::fileDenied);
    require(mmstore::validDigest(configurationSha256) && hashFile(configFile.file.value, 16384) == configurationSha256, ErrorCode::digestMismatch);
    const auto config = mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()), true).parse();
    require(fixedToolConfiguration(kind, config, request, utf8(owner_.sid), code_.inventorySha256(), code_.runtimeManifestPin().sha256,
      code_.nativeHelperPin().sha256), ErrorCode::processDenied);
    const auto work = rootPath("personal") + L"\\" + wide(relative);
    require(!configFile.ancestors.empty() && _wcsicmp(nativeCanonical(configFile.ancestors.back().value).c_str(), work.c_str()) == 0, ErrorCode::pathDenied);
    auto arguments = guardian_.argumentPrefix(); std::wstring input;
    const auto holdInput = [&](const std::string& leaf, std::uint64_t maximum, bool expectedBytes) {
      inputTokens_.emplace_back(); auto& token = inputTokens_.back(); (void)holdFile(relative + "\\" + leaf, maximum, &token);
      auto& held = privateFileCapability(Json::Object{{"token", token}}); const auto size = validatePrivateFileCapability(held).at("bytes").integer();
      require(size >= 1 && static_cast<std::uint64_t>(size) <= maximum && (!expectedBytes || size == config.at("inputBytes").integer()), ErrorCode::fileDenied);
      if (silenceTool(kind)) require(hashFile(held.file.value, maximum) == config.at("inputSha256").string(), ErrorCode::digestMismatch);
      return held.path;
    };
    if (kind == FixedToolKind::cloudProbeInput || kind == FixedToolKind::cloudTranscode)
      input = holdInput(config.at("operation").string() == "cloud_prepare" ? "original-media.bin" : "result.mp3", 256ULL * 1024 * 1024, true);
    else if (kind == FixedToolKind::cloudProbeOutput) input = holdInput("source.m4a", 100000000, false);
    else if (silenceTool(kind)) input = holdInput("voice.bin", 256ULL * 1024 * 1024, true);
    const std::wstring formats = L"mov,mp3,matroska,webm,ogg,aac,wav,flac";
    if (kind == FixedToolKind::cloudProbeInput || kind == FixedToolKind::cloudProbeOutput) {
      const auto whitelist = config.at("operation").string() == "cloud_probe" ? std::wstring(L"mp3") : formats;
      arguments.insert(arguments.end(), {L"-v", L"error", L"-protocol_whitelist", L"file", L"-format_whitelist", whitelist,
        L"-show_entries", L"format=duration:stream=codec_type,codec_name,profile,sample_rate,channels", L"-of", L"json", input});
    } else if (kind == FixedToolKind::cloudTranscode) {
      require(nativeChildMissing(configFile.ancestors.back().value, L"source.m4a"), ErrorCode::pathDenied);
      arguments.insert(arguments.end(), {L"-nostdin", L"-v", L"error", L"-protocol_whitelist", L"file", L"-format_whitelist", formats,
        L"-i", input, L"-map", L"0:a:0", L"-vn", L"-sn", L"-dn", L"-map_metadata", L"-1", L"-map_chapters", L"-1",
        L"-c:a", L"aac", L"-profile:a", L"aac_low", L"-b:a", L"160k", L"-ar", L"44100", L"-ac", L"2", L"-movflags", L"+faststart", L"-n", work + L"\\source.m4a"});
    } else if (kind == FixedToolKind::silenceProbe) arguments.insert(arguments.end(), {L"-v", L"error", L"-protocol_whitelist", L"file", L"-format_whitelist", formats,
      L"-show_entries", L"format=duration:stream=codec_type,sample_rate,channels", L"-of", L"json", input});
    else if (kind == FixedToolKind::silenceDecode) arguments.insert(arguments.end(), {L"-nostdin", L"-v", L"error", L"-threads", L"2", L"-protocol_whitelist", L"file,pipe",
      L"-format_whitelist", formats, L"-i", input, L"-map", L"0:a:0", L"-vn", L"-sn", L"-dn", L"-ar", L"44100", L"-ac", L"2", L"-f", L"f32le", L"pipe:1"});
    else if (kind == FixedToolKind::downloaderVersion || kind == FixedToolKind::downloaderHelp)
      arguments.insert(arguments.end(), {L"--ignore-config", L"--no-plugin-dirs", kind == FixedToolKind::downloaderVersion ? L"--version" : L"--help"});
    else if (kind == FixedToolKind::downloaderEjs) arguments.push_back(L"--musicmute-check-ejs");
    else if (kind == FixedToolKind::denoVersion) arguments.push_back(L"--version");
    else if (kind == FixedToolKind::denoProvider) {
      const auto youtube = guardian_.observation().installedLocation + L"\\worker\\tools\\youtube";
      const auto escapeComma = [](const std::wstring& text) { std::wstring escaped; for (const auto c : text) { escaped += c; if (c == L',') escaped += c; } return escaped; };
      arguments.insert(arguments.end(), {L"run", L"--cached-only", L"--frozen", L"--no-check", L"--deny-net", L"--allow-env",
        L"--allow-read=" + escapeComma(youtube) + L"," + escapeComma(work), L"--allow-ffi=" + escapeComma(youtube + L"\\provider\\node_modules"),
        L"--allow-write=" + escapeComma(work), L"--config", youtube + L"\\provider\\deno.json", youtube + L"\\provider\\src\\generate_once.ts", L"--musicmute-check"});
    }
    std::vector<wchar_t> windowsBuffer(32768); const auto count = GetWindowsDirectoryW(windowsBuffer.data(), static_cast<UINT>(windowsBuffer.size()));
    require(count > 0 && count < windowsBuffer.size(), ErrorCode::processDenied); const std::wstring windows(windowsBuffer.data(), count);
    ConsumerEnvironmentEntries environment;
    environment.emplace(L"SystemRoot", windows); environment.emplace(L"WINDIR", windows);
    environment.emplace(L"PATH", guardian_.executablePath().substr(0, guardian_.executablePath().find_last_of(L'\\')) + L";" + guardian_.mediaRoot() + L";" + windows + L"\\System32");
    for (const auto* key : {L"TEMP", L"TMP", L"HOME", L"USERPROFILE", L"XDG_CACHE_HOME", L"MPLCONFIGDIR", L"NUMBA_CACHE_DIR"}) environment.emplace(key, work);
    environment.emplace(L"PYTHONDONTWRITEBYTECODE", L"1"); environment.emplace(L"PYTHONNOUSERSITE", L"1"); environment.emplace(L"PYTHONUNBUFFERED", L"1");
    environment.emplace(L"MUSICMUTE_SENTRY_ENGINE_ENABLED", L"0"); environment.emplace(L"DENO_DIR", guardian_.downloaderCache());
    environment.emplace(L"DENO_DISABLE_NODE_SHIM", L"1");
    toolStopped_ = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(toolStopped_.valid(), ErrorCode::processDenied);
    startProcess(guardian_, arguments, encodeConsumerEnvironment(environment), work, nodeJob, node, nodePlan);
    toolDeadline_ = std::thread([this] {
      const auto waited = WaitForSingleObject(toolStopped_.value, 300000);
      if (waited != WAIT_OBJECT_0) { (void)TerminateJobObject(job_.value, 2); std::lock_guard lock(ioMutex_); ioFailed_ = true; ioChanged_.notify_all(); }
    });
    closeOwned(input_); // Every fixed CPU utility has no incoming stdin contract.
  }
  void startProcess(const mmstoreruntime::FixedLaunchPlan& executable, const std::vector<std::wstring>& arguments,
      std::wstring environment, const std::wstring& work, HANDLE nodeJob, const mmstore::AttestedProcess& node,
      const mmstoreruntime::FixedLaunchPlan& nodePlan) {
    Security security(L"O:" + owner_.sid + L"D:P(A;;GA;;;" + owner_.sid + L")(A;;GA;;;SY)");
    const auto name = L"Local\\MusicMuteStoreEngine-v1-" + owner_.sid + L"-" + std::to_wstring(owner_.sessionId) + L"-" + wide(ownerNonce_) + L"-" + wide(token_);
    job_.value=CreateJobObjectW(&security.attributes,name.c_str());const auto jobError=GetLastError();jobCreated_=job_.valid() && jobError!=ERROR_ALREADY_EXISTS;require(jobCreated_,ErrorCode::processDenied);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job_.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), ErrorCode::processDenied);
    SECURITY_ATTRIBUTES pipeSecurity{sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE}; auto& childIn = startupInput_; auto& childOut = startupOutput_; auto& childError = startupError_;
    require(CreatePipe(&childIn.value, &input_.value, &pipeSecurity, 4096) && CreatePipe(&output_.value, &childOut.value, &pipeSecurity, 4096) &&
      CreatePipe(&error_.value, &childError.value, &pipeSecurity, 4096), ErrorCode::processDenied);
    for (const auto pipe : {input_.value, output_.value, error_.value}) require(SetHandleInformation(pipe, HANDLE_FLAG_INHERIT, 0), ErrorCode::processDenied);
    parent_ = ::Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_CREATE_PROCESS | PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, owner_.pid)); auto& parent = parent_;
    require(parent.valid() && mmstore::detail::sameIdentity(mmstore::detail::processIdentity(parent.value), owner_), ErrorCode::processDenied);
    struct RemoteHandles {
      StoreEngineChild* child; HANDLE parent; std::vector<HANDLE> handles; std::size_t closed = 0;
      // Keep the complete borrowed HANDLE_LIST array alive until its process
      // attribute list is destroyed, even after removing the temporary handles.
      void closeChecked() { while (closed < handles.size()) { HANDLE removed = nullptr; const auto source = handles[closed++];
        require(source && source!=INVALID_HANDLE_VALUE,ErrorCode::processDenied);
        // DUPLICATE_CLOSE_SOURCE consumes the remote handle even when the call
        // fails. Never retry a numeric value the real Node could already reuse.
        const auto duplicated = DuplicateHandle(parent, source, GetCurrentProcess(), &removed, 0, FALSE, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS);
        if (removed && removed != INVALID_HANDLE_VALUE) { child->remoteCopies_.emplace_back(removed); closeOwned(child->remoteCopies_.back()); } require(duplicated && removed && removed != INVALID_HANDLE_VALUE, ErrorCode::processDenied); } }
      ~RemoteHandles() { while (closed < handles.size()) { HANDLE removed = nullptr; const auto source = handles[closed++];
        if(!source || source==INVALID_HANDLE_VALUE)continue;
        (void)DuplicateHandle(parent, source, GetCurrentProcess(), &removed, 0, FALSE, DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS); if (removed && removed != INVALID_HANDLE_VALUE) { child->remoteCopies_.emplace_back(removed); if (CloseHandle(removed)) child->remoteCopies_.back().value = nullptr; } } }
    } remote{this, parent.value, {}, 0};
    remoteCopies_.reserve(3);remote.handles.reserve(3);
    for (const auto pipe : {childIn.value, childOut.value, childError.value}) {
      remote.handles.push_back(nullptr);const auto copied=DuplicateHandle(GetCurrentProcess(),pipe,parent.value,&remote.handles.back(),0,TRUE,DUPLICATE_SAME_ACCESS);require(copied && remote.handles.back() && remote.handles.back()!=INVALID_HANDLE_VALUE,ErrorCode::processDenied);
    }
    SIZE_T attributeBytes = 0; (void)InitializeProcThreadAttributeList(nullptr, 3, 0, &attributeBytes); require(attributeBytes > 0, ErrorCode::processDenied);
    std::vector<BYTE> attributesStorage(attributeBytes); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributesStorage.data());
    require(InitializeProcThreadAttributeList(attributes, 3, 0, &attributeBytes), ErrorCode::processDenied);
    DWORD desktopPolicy = 0;
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } attributesLifetime{attributes};
    HANDLE selectedParent = parent.value;
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, &selectedParent, sizeof(selectedParent), nullptr, nullptr) &&
      UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, remote.handles.data(), remote.handles.size() * sizeof(HANDLE), nullptr, nullptr), ErrorCode::processDenied);
    require(mmstoredesktop::apply(attributes, desktopPolicy), ErrorCode::processDenied);
    auto command = quote(executable.executablePath()); for (const auto& argument : arguments) command += L" " + quote(argument);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = remote.handles[0]; startup.StartupInfo.hStdOutput = remote.handles[1]; startup.StartupInfo.hStdError = remote.handles[2];
    PROCESS_INFORMATION created{}; executable.revalidateFixedAdmission(); revalidate(nodeJob, node, nodePlan);
    require(CreateProcessW(executable.executablePath().c_str(), command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
      environment.data(), work.c_str(), &startup.StartupInfo, &created), ErrorCode::processDenied);
    process_ = ::Handle(created.hProcess); startupThread_ = ::Handle(created.hThread); auto& thread = startupThread_;
    struct Suspended { StoreEngineChild* child; bool running = false; ~Suspended() { if (!running) { if (child->job_.valid() && child->jobCreated_) (void)TerminateJobObject(child->job_.value, 2); if (child->process_.valid()) { (void)TerminateProcess(child->process_.value, 2); (void)WaitForSingleObject(child->process_.value, 5000); } } } } suspended{this};
    BOOL member = FALSE; require(IsProcessInJob(process_.value, nodeJob, &member), ErrorCode::processDenied);
    if (!member) require(AssignProcessToJobObject(nodeJob, process_.value), ErrorCode::processDenied);
    require(AssignProcessToJobObject(job_.value, process_.value), ErrorCode::processDenied); detail::requireMember(process_.value, nodeJob); detail::requireMember(process_.value, job_.value);
    identity_ = mmstore::detail::processIdentity(process_.value);
    auto admitted = code_.attestHeldChild(executable.executableRole(), identity_, node); admitted.revalidate();
    // Child inheritance is complete while it is still suspended. Remove every
    // temporary copy in the real Node before any Python instruction executes.
    remote.closeChecked();
    executable.revalidateFixedAdmission(); revalidate(nodeJob, node, nodePlan);
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1), ErrorCode::processDenied); suspended.running = true; processResumed_=true;
    closeOwned(childIn); closeOwned(childOut); closeOwned(childError);
    stdoutThread_ = std::thread([this] { drain(output_.value, false); }); stderrThread_ = std::thread([this] { drain(error_.value, true); });
    closeOwned(startupThread_); closeOwned(parent_);
  }
  void observeFleetResponse(const BYTE* bytes,std::size_t length) {
    if(engine_.kind()!=mmstoreruntime::LaunchKind::fleetEngine)return;
    require(fleetResponseBytes_.size()+length<=69636,ErrorCode::processDenied);fleetResponseBytes_.insert(fleetResponseBytes_.end(),bytes,bytes+length);
    while(fleetResponseBytes_.size()>=4){const std::uint32_t size=(static_cast<std::uint32_t>(fleetResponseBytes_[0])<<24)|(static_cast<std::uint32_t>(fleetResponseBytes_[1])<<16)|(static_cast<std::uint32_t>(fleetResponseBytes_[2])<<8)|fleetResponseBytes_[3];
      require(size>0 && size<=65536,ErrorCode::processDenied);if(fleetResponseBytes_.size()<size+4)break;
      const auto value=mm::JsonParser(std::string(fleetResponseBytes_.begin()+4,fleetResponseBytes_.begin()+4+size),true).parse();
      require(data_policy::fields(value,{"protocolVersion","type","requestId","incarnation","sentAt","payload"}) && value.at("protocolVersion").integer()==1 &&
        value.at("incarnation").string()==engineIncarnation_ && data_policy::uuid(value.at("requestId").string()),ErrorCode::processDenied);
      const auto type=value.at("type").string();if(type=="result" || type=="error") {const auto expected=fleetExpected_.find(value.at("requestId").string());if(expected!=fleetExpected_.end())expected->second=true;}
      fleetResponseBytes_.erase(fleetResponseBytes_.begin(),fleetResponseBytes_.begin()+4+size);
    }
  }
  void registerFleetRequest(const std::string& request) {std::lock_guard lock(ioMutex_);require(!ioFailed_ && !protocolFailed_ && fleetExpected_.size()<2 && !fleetExpected_.contains(request),ErrorCode::processDenied);fleetExpected_.emplace(request,false);}
  bool completedFleetRequest(const std::string& request) {std::lock_guard lock(ioMutex_);require(!ioFailed_ && !protocolFailed_,ErrorCode::processDenied);const auto found=fleetExpected_.find(request);require(found!=fleetExpected_.end(),ErrorCode::processDenied);return found->second;}
  void forgetCompletedFleetRequest(const std::string& request) {std::lock_guard lock(ioMutex_);const auto found=fleetExpected_.find(request);require(found!=fleetExpected_.end() && found->second,ErrorCode::processDenied);fleetExpected_.erase(found);}
  void drain(HANDLE pipe, bool diagnostic) noexcept {
    bool eof=false;
    try {
      for (;;) {
        { std::lock_guard lock(ioMutex_); if (stopping_ && !draining_) break; }
        std::array<BYTE, 4096> chunk{}; DWORD read = 0;
        const auto successful=ReadFile(pipe,chunk.data(),static_cast<DWORD>(chunk.size()),&read,nullptr);const auto error=successful?ERROR_SUCCESS:GetLastError();
        if(!successful){require(error==ERROR_BROKEN_PIPE,ErrorCode::processDenied);eof=true;break;}if(read==0){eof=true;break;}
        std::unique_lock lock(ioMutex_); auto& bytes = diagnostic ? stderrBytes_ : stdoutBytes_;
        if(stopping_ && draining_){ioChanged_.notify_all();continue;}
        if (stopping_) break;
        if (diagnostic) {
          bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + read);
          if (bytes.size() > 16384) bytes.erase(bytes.begin(), bytes.begin() + static_cast<std::ptrdiff_t>(bytes.size() - 16384));
        } else {
          if(!protocolFailed_)try{observeFleetResponse(chunk.data(),read);}catch(...){protocolFailed_=true;fleetResponseBytes_.clear();}
          // A malformed business frame permanently denies warm reuse. Keep
          // the original reader draining, so later exact Job retirement can
          // still establish actual pipe EOF independently of that poison.
          if(protocolFailed_){ioChanged_.notify_all();continue;}
          ioChanged_.wait(lock, [&] { return stopping_ || bytes.size() + read <= 65536; }); if (stopping_) {if(draining_)continue;break;}
          bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + read);
        }
        ioChanged_.notify_all();
      }
    } catch (...) { std::lock_guard lock(ioMutex_); ioFailed_ = true; }
    std::lock_guard lock(ioMutex_); if (diagnostic) stderrEnded_ = eof; else stdoutEnded_ = eof; ioChanged_.notify_all();
  }
  Json read() {
    std::unique_lock lock(ioMutex_);
    ioChanged_.wait_for(lock, std::chrono::seconds(25), [&] { return ioFailed_ || protocolFailed_ || !stdoutBytes_.empty() || stdoutEnded_ || stopping_; });
    require(!ioFailed_ && !protocolFailed_ && !stopping_, ErrorCode::processDenied);
    const auto size = std::min<std::size_t>(24576, stdoutBytes_.size()); std::vector<BYTE> bytes(stdoutBytes_.begin(), stdoutBytes_.begin() + static_cast<std::ptrdiff_t>(size));
    stdoutBytes_.erase(stdoutBytes_.begin(), stdoutBytes_.begin() + static_cast<std::ptrdiff_t>(size));
    const auto diagnostics = base64Encode(stderrBytes_.data(), static_cast<DWORD>(stderrBytes_.size())); stderrBytes_.clear(); ioChanged_.notify_all();
    return Json::Object{{"bytes_base64", base64Encode(bytes.data(), static_cast<DWORD>(bytes.size()))}, {"stderr_base64", diagnostics}, {"eof", stdoutEnded_ && stdoutBytes_.empty()}};
  }
  struct ReadObservation { ::Handle process; bool waiting = false; };
  Json readTool() {
    require(cpuTool_ || qualification_, ErrorCode::processDenied); auto row = read().object();
    if(transfer_ && std::get<bool>(row.at("eof").value)){std::unique_lock lock(ioMutex_);ioChanged_.wait_for(lock,std::chrono::seconds(25),[&]{return stderrEnded_ || ioFailed_ || stopping_;});require(!ioFailed_ && !stopping_,ErrorCode::processDenied);row["eof"]=stdoutEnded_ && stderrEnded_ && stdoutBytes_.empty();} Json exit = nullptr;
    if (std::get<bool>(row.at("eof").value)) {
      auto observation = std::make_shared<ReadObservation>();
      { std::lock_guard lock(ioMutex_); require(!stopping_ && process_.valid() && observations_.size() < 8, ErrorCode::processDenied);
        observations_.push_back(observation); const auto copied=DuplicateHandle(GetCurrentProcess(),process_.value,GetCurrentProcess(),&observation->process.value,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,0);require(copied && observation->process.valid(),ErrorCode::processDenied); observation->waiting = true; }
      struct Complete { StoreEngineChild* actual; std::shared_ptr<ReadObservation> observation;
        ~Complete() { std::lock_guard lock(actual->ioMutex_); observation->waiting = false; actual->ioChanged_.notify_all(); } } complete{this, observation};
      const auto waited = WaitForSingleObject(observation->process.value, 25000); require(waited == WAIT_OBJECT_0 || waited == WAIT_TIMEOUT, ErrorCode::processDenied);
      if (waited == WAIT_OBJECT_0) { DWORD code = 2; require(GetExitCodeProcess(observation->process.value, &code) && code != STILL_ACTIVE, ErrorCode::processDenied); exit = static_cast<std::int64_t>(code); }
      else row["eof"] = false;
      // Keep a failed reader-copy close in this actual child. Stop cannot
      // close a handle while another registered connection is waiting on it.
      { std::lock_guard lock(ioMutex_); closeOwned(observation->process); observations_.erase(std::remove(observations_.begin(), observations_.end(), observation), observations_.end()); }
    }
    row["exit_code"] = exit; return row;
  }
  Json write(const Json& args) {
    auto bytes = base64Decode(args.at("bytes_base64").string(), 24576); require(!bytes.empty(), ErrorCode::invalidInput);
    std::lock_guard writeLock(writeMutex_); require(!write_, ErrorCode::processDenied);
    auto operation = std::make_shared<WriteOperation>(); operation->bytes = std::move(bytes); write_ = operation;
    { std::lock_guard lock(ioMutex_); require(!stopping_ && input_.valid() && process_.valid() && job_.valid(), ErrorCode::processDenied);
      require(DuplicateHandle(GetCurrentProcess(),input_.value,GetCurrentProcess(),&operation->pipe.value,0,FALSE,DUPLICATE_SAME_ACCESS) && operation->pipe.valid(),ErrorCode::processDenied);
      require(DuplicateHandle(GetCurrentProcess(),process_.value,GetCurrentProcess(),&operation->process.value,SYNCHRONIZE,FALSE,0) && operation->process.valid(),ErrorCode::processDenied);
      require(DuplicateHandle(GetCurrentProcess(),job_.value,GetCurrentProcess(),&operation->job.value,JOB_OBJECT_TERMINATE,FALSE,0) && operation->job.valid(),ErrorCode::processDenied); }
    require(WaitForSingleObject(operation->process.value, 0) == WAIT_TIMEOUT, ErrorCode::processDenied);
    operation->done = ::Handle(CreateEventW(nullptr, TRUE, FALSE, nullptr)); require(operation->pipe.valid() && operation->done.valid(), ErrorCode::processDenied);
    // Retain all buffers/handles and this original writer before it can block.
    // A failed cancellation never destroys a still-running local thread.
    operation->thread = std::thread([operation] { operation->successful = WriteFile(operation->pipe.value, operation->bytes.data(), static_cast<DWORD>(operation->bytes.size()), &operation->written, nullptr); (void)SetEvent(operation->done.value); });
    if (WaitForSingleObject(operation->done.value, 5000) != WAIT_OBJECT_0) {
      cancelReader(operation->thread); require(TerminateJobObject(operation->job.value, 2), ErrorCode::processDenied);
    }
    joinReader(operation->thread, GetTickCount64() + 5000);
    closeWrite(operation); write_.reset(); require(operation->successful && operation->written == operation->bytes.size(), ErrorCode::processDenied);
    return Json::Object{{"written", static_cast<std::int64_t>(operation->written)}};
  }
  static void cancelReader(std::thread& reader) noexcept {
    if (reader.joinable()) (void)CancelSynchronousIo(reader.native_handle());
  }
  static void joinReader(std::thread& reader, ULONGLONG deadline,bool cancel=true) {
    if (!reader.joinable()) return;
    for (;;) {
      const auto waited = WaitForSingleObject(reader.native_handle(), 0);
      if (waited == WAIT_OBJECT_0) break;
      require(waited == WAIT_TIMEOUT && GetTickCount64() < deadline, ErrorCode::processDenied);
      if(cancel)cancelReader(reader); Sleep(10);
    }
    reader.join();
  }
  struct WriteOperation {
    ::Handle pipe, process, job, done; std::vector<BYTE> bytes; DWORD written = 0; BOOL successful = FALSE; std::thread thread;
    ~WriteOperation() { if (thread.joinable()) thread.join(); std::fill(bytes.begin(), bytes.end(), BYTE{}); }
  };
  static void closeOwned(::Handle& handle) {
    mmstorechild::closeOwned(handle.value);
  }
  static void closeWrite(const std::shared_ptr<WriteOperation>& operation) {
    closeOwned(operation->pipe); closeOwned(operation->process); closeOwned(operation->job); closeOwned(operation->done);
  }
  void stop() {
    require(jobCreated_ || !process_.valid(),ErrorCode::processDenied);
    if (job_.valid() && jobCreated_) require(TerminateJobObject(job_.value, 2), ErrorCode::processDenied);
    if (process_.valid() && WaitForSingleObject(process_.value, 0) != WAIT_OBJECT_0) require(TerminateProcess(process_.value, 2), ErrorCode::processDenied);
    { std::lock_guard lock(ioMutex_); draining_=true; stopping_ = true;stdoutBytes_.clear();stderrBytes_.clear(); ioChanged_.notify_all(); }
    const auto deadline = GetTickCount64() + 10000;
    while (job_.valid() && jobCreated_) { JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state{}; require(QueryInformationJobObject(job_.value, JobObjectBasicAccountingInformation, &state, sizeof(state), nullptr), ErrorCode::processDenied);
      if (state.ActiveProcesses == 0) break; require(GetTickCount64() < deadline, ErrorCode::processDenied); Sleep(10); }
    require(!process_.valid() || WaitForSingleObject(process_.value, 10000) == WAIT_OBJECT_0, ErrorCode::processDenied);
    if (toolStopped_.valid()) require(SetEvent(toolStopped_.value), ErrorCode::processDenied);
    joinReader(toolDeadline_, GetTickCount64() + 5000);
    // With the exact original child tree gone, remove our remaining startup
    // writer copies before waiting for real pipe EOF. Cancellation is never
    // substituted for EOF on a resumed Store child.
    closeOwned(startupInput_);closeOwned(startupOutput_);closeOwned(startupError_);
    for(auto& copy:remoteCopies_)closeOwned(copy);
    // Join the original readers after the original Job reaches zero. A prior
    // read error is not EOF; retry only the same retained pipe during stop.
    const auto originalReadersDeadline=GetTickCount64()+5000;
    joinReader(stdoutThread_,originalReadersDeadline,false);joinReader(stderrThread_,originalReadersDeadline,false);
    if(processResumed_) {
      std::lock_guard lock(ioMutex_);
      if(!stdoutEnded_ && !stdoutThread_.joinable())stdoutThread_=std::thread([this]{drain(output_.value,false);});
      if(!stderrEnded_ && !stderrThread_.joinable())stderrThread_=std::thread([this]{drain(error_.value,true);});
    }
    const auto readersDeadline = GetTickCount64() + 5000;
    joinReader(stdoutThread_, readersDeadline,false); joinReader(stderrThread_, readersDeadline,false);
    {std::lock_guard lock(ioMutex_);require(!processResumed_ || (stdoutEnded_ && stderrEnded_),ErrorCode::processDenied);}
    { std::lock_guard writeLock(writeMutex_); if (write_) { cancelReader(write_->thread); joinReader(write_->thread, GetTickCount64() + 5000); closeWrite(write_); write_.reset(); } }
    for (;;) { bool waiting = false;
      { std::lock_guard lock(ioMutex_); for (const auto& observation : observations_) if (observation->waiting) waiting = true; }
      if (!waiting) break; require(GetTickCount64() < deadline, ErrorCode::processDenied); Sleep(10);
    }
    { std::lock_guard lock(ioMutex_); for (auto& observation : observations_) closeOwned(observation->process); observations_.clear(); closeOwned(input_); closeOwned(output_); closeOwned(error_); closeOwned(process_); closeOwned(job_);
      closeOwned(keeper_); closeOwned(gpuRelease_); closeOwned(transferFile_); closeOwned(toolStopped_); closeOwned(startupInput_); closeOwned(startupOutput_); closeOwned(startupError_); closeOwned(startupThread_); closeOwned(parent_);
      for (auto& copy : remoteCopies_) closeOwned(copy); remoteCopies_.clear(); std::fill(stdoutBytes_.begin(), stdoutBytes_.end(), BYTE{}); std::fill(stderrBytes_.begin(), stderrBytes_.end(), BYTE{}); stdoutBytes_.clear(); stderrBytes_.clear(); }
    for (auto& token : inputTokens_) if (!token.empty()) { (void)closePrivateFile(Json::Object{{"token", token}}); token.clear(); }
    for (auto* token : {&configToken_, &modelToken_}) if (!token->empty()) { (void)closePrivateFile(Json::Object{{"token", *token}}); token->clear(); }
    for(auto* directory:{&reportDirectory_,&workDirectory_,&savedDirectory_})for(auto& ancestor:directory->ancestors)mmstorechild::closeOwned(ancestor.value);
  }
  mmstoreruntime::WorkerCodeAuthority code_; mmstoreruntime::FixedLaunchPlan guardian_, engine_; mmstore::ProcessIdentity owner_, identity_;
  std::string ownerNonce_, token_, configToken_, modelToken_; ::Handle job_, process_, input_, output_, error_, keeper_, gpuRelease_, startupInput_, startupOutput_, startupError_, startupThread_, parent_;
  std::vector<::Handle> remoteCopies_;
  std::vector<std::shared_ptr<ReadObservation>> observations_;
  std::mutex ioMutex_; std::condition_variable ioChanged_; std::vector<BYTE> stdoutBytes_, stderrBytes_;
  std::mutex brokerWriteMutex_,writeMutex_; std::shared_ptr<WriteOperation> write_;
  ::Handle toolStopped_; std::thread toolDeadline_;
  std::vector<std::string> inputTokens_; bool cpuTool_ = false, qualification_ = false,benchmark_=false;std::string benchmarkConfigurationSha_;
  std::string engineIncarnation_;std::vector<BYTE> fleetResponseBytes_;std::map<std::string,bool> fleetExpected_;
  bool transfer_=false,transferInputClosed_=false;std::string transferOperation_,transferAttempt_,transferIncarnation_;std::wstring transferRoot_,transferPath_;Json transferBirth_=nullptr;::Handle transferFile_;std::vector<BYTE> transferBytes_;std::mutex transferMutex_;
  PrivateFileCapability reportDirectory_,workDirectory_,savedDirectory_;
  bool stopping_ = false, draining_=false,processResumed_=false,jobCreated_=false,ioFailed_ = false,protocolFailed_=false, stdoutEnded_ = false, stderrEnded_ = false;
  std::thread stdoutThread_, stderrThread_; friend class StoreSessionCreator;
};
#endif
} // namespace mmstorerole
