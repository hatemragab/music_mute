#define MUSICMUTE_CONSUMER_NATIVE_LIBRARY
#include "main.cpp"
#include <shellapi.h>
#include "store_session.hpp"
#include "store_gui_launch_policy.hpp"

namespace {
int launchStoreGui(std::span<const std::wstring_view> arguments) {
  using mmstore::require; using mmstore::ErrorCode;
  const auto argument = mmstoreguilaunch::activation(arguments);
  auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui);
  auto inventoryFile = package.openInventory(); const auto bytes = inventoryFile.read(8 * 1024 * 1024);
  const auto inventory = mmstoreinventory::parse(mmstore::PackageKind::gui,
    mm::JsonParser::storeCodeInventory(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
  const auto deployed = mmstore::parseVersion(package.observation().packageVersion), sealed = mmstore::parseVersion(inventory.packageVersion);
  require(deployed[0] == sealed[0] && deployed[1] == sealed[1] && deployed[2] == sealed[2], ErrorCode::packageDenied);
  auto self = mmstore::attestProcess(GetCurrentProcessId(), mmstore::CodeRole::guiSession,
    mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiSession));
  auto application = package.openCode(mmstore::CodeRole::guiApplication,
    mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiApplication));
  const auto revalidate = [&] {
    package.revalidate(); inventoryFile.revalidate(); application.revalidateIdentity(); self.revalidate();
    require(mmstore::currentPackageFullName() == package.observation().fullName &&
      self.observation().fullName == package.observation().fullName, ErrorCode::packageDenied);
  };
  revalidate();
  const auto app = application.absolutePath(), directory = app.substr(0, app.find_last_of(L'\\'));
  auto command = quote(app) + (argument.empty() ? L"" : L" " + quote(argument));
  auto environment = consumerEnvironment(directory);
  DWORD desktopPolicy = 0; // Must outlive the attribute-list RAII owner.
  SIZE_T attributeBytes = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  require(attributeBytes > 0, ErrorCode::processDenied);
  std::vector<BYTE> storage(attributeBytes); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  require(InitializeProcThreadAttributeList(attributes, 1, 0, &attributeBytes) != FALSE, ErrorCode::processDenied);
  struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } lifetime{attributes};
  require(mmstoredesktop::apply(attributes, desktopPolicy), ErrorCode::processDenied);
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
  PROCESS_INFORMATION created{};
  revalidate();
  // No selected parent, inherited handles, breakaway flag, or UI-owned Job.
  // The original package/Job relationship survives this transient launcher.
  require(CreateProcessW(app.c_str(), command.data(), nullptr, nullptr, FALSE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(), directory.c_str(), &startup.StartupInfo, &created) != FALSE, ErrorCode::processDenied);
  Handle process(created.hProcess), thread(created.hThread);
  try {
    auto child = mmstore::attestProcess(created.dwProcessId, mmstore::CodeRole::guiApplication, application.pin());
    require(mmstore::detail::sameIdentity(child.identity(), mmstore::detail::processIdentity(process.value)) &&
      child.observation().fullName == self.observation().fullName && child.identity().pid != self.identity().pid &&
      child.identity().sid == self.identity().sid && child.identity().logonSid == self.identity().logonSid &&
      child.identity().sessionId == self.identity().sessionId &&
      mmstore::detail::parentPid(child.identity().pid) == self.identity().pid &&
      mmstore::detail::creation(self.handle()) <= mmstore::detail::creation(process.value), ErrorCode::processDenied);
    child.revalidate(); revalidate();
    require(ResumeThread(thread.value) == 1, ErrorCode::processDenied);
    // A forwarded second-instance activation can exit immediately. Recheck
    // authority/code after resume without requiring that GUI to remain alive.
    revalidate();
  } catch (...) {
    const auto ended = WaitForSingleObject(process.value, 0);
    require(ended == WAIT_OBJECT_0 || (ended == WAIT_TIMEOUT && TerminateProcess(process.value, 2) != FALSE &&
      WaitForSingleObject(process.value, 5000) == WAIT_OBJECT_0), ErrorCode::processDenied);
    throw;
  }
  return 0;
}
} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  try {
    int count = 0; LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments) return 2;
    LocalMemory argumentMemory{arguments};
    const auto currentPackage = mmstore::currentPackageFullName();
    if (!currentPackage.empty()) {
      const auto kind = mmstoreguilaunch::packageKind(currentPackage);
      if (kind == mmstore::PackageKind::gui) {
        if (count < 1 || count > 2) return 2;
        std::vector<std::wstring_view> activation;
        for (int n = 1; n < count; ++n) activation.emplace_back(arguments[n]);
        return launchStoreGui(activation);
      }
      if (count != 1) return 2;
      // The fixed hidden Worker Session application is activated by Windows,
      // independently of the GUI's transient Job and without administrator use.
      return mmstorerole::StoreSessionCreator::run();
    }
    if (count != 2 || (std::wstring(arguments[1]) != L"--startup" && std::wstring(arguments[1]) != L"--on-demand")) return 2;
    const auto host = identityReport();
    if (host.at("native_arch").string() != "x64" || host.at("process_arch").string() != "x64" || host.at("os_major").integer() != 10 || host.at("os_build").integer() < 19045) return 2;
    const auto singleton = inspectSingletonOwner(Json::Object{{"scope", "session"}});
    const auto account = inspectSingletonOwner(Json::Object{{"scope", "account"}});
    if ((singleton.at("state").string() == "active" && !std::get<bool>(singleton.at("same_session").value)) ||
        (account.at("state").string()=="active"&&!std::get<bool>(account.at("same_session").value))) {
      MessageBoxW(nullptr, L"MusicMute is already active in another login for this Windows account. Sign out of that login before starting MusicMute here.", L"MusicMute", MB_OK | MB_ICONINFORMATION);
      return 2;
    }
    if(singleton.at("state").string()=="active")return 0;
    std::vector<wchar_t> image(32768);
    const DWORD size = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
    if (size == 0 || size >= image.size() || _wcsicmp(std::wstring(image.data(), size).c_str(), fixedWorkerLauncherPath().c_str()) != 0) return 2;
    if(std::wstring(arguments[1])==L"--startup")return launchLoginWorker();
    const auto encrypted = vault("vault_get", Json::Object{{"namespace", "fleet"}, {"key", "agent_bootstrap"}});
    if (std::holds_alternative<std::nullptr_t>(encrypted.value)) return 2;
    auto plain = base64Decode(encrypted.at("bytes_base64").string(), 16384);
    const auto receipt = mm::JsonParser(std::string(reinterpret_cast<const char*>(plain.data()), plain.size())).parse();
    SecureZeroMemory(plain.data(), plain.size());
    keys(receipt, {"version", "installationProfile", "sid", "release", "configSha256", "nodeSha256", "agentSha256", "nativeSha256", "launcherSha256"});
    const auto release = receipt.at("release").string();
    if (receipt.at("version").integer() != 1 || receipt.at("installationProfile").string() != "windows-user" || receipt.at("sid").string() != currentIdentity().sid || release.size() != 64 || release.find_first_not_of("0123456789abcdef") != std::string::npos) return 2;
    const auto root = rootPath("personal"), runtime = root + L"\\runtime\\releases\\" + wide(release);
    const auto node = runtime + L"\\runtime\\node\\node.exe", entry = runtime + L"\\agent\\session-agent.cjs", config = root + L"\\consumer-config.json";
    auto ancestors = lockAncestors(runtime + L"\\runtime\\native", false, true, root);
    auto agentAncestors = lockAncestors(runtime + L"\\agent", false, true, root);
    const auto appRoot = fixedWorkerLauncherPath().substr(0, fixedWorkerLauncherPath().find_last_of(L'\\'));
    auto launcherAncestors=lockAncestors(appRoot,false,true,rootPath("fleet"));
    const auto appDirectory = launcherAncestors.back().value;
    nativeEntryInformation(appDirectory, NativeChildKind::directory);
    assertPrivateHandle(appDirectory);
    auto launcherFile = lockHashedFile(fixedWorkerLauncherPath(), receipt.at("launcherSha256").string());
    auto configFile = lockHashedFile(config, receipt.at("configSha256").string());
    auto nodeFile = lockHashedFile(node, receipt.at("nodeSha256").string());
    auto entryFile = lockHashedFile(entry, receipt.at("agentSha256").string());
    auto helperFile = lockHashedFile(runtime + L"\\runtime\\native\\musicmute-native.exe", receipt.at("nativeSha256").string());
    auto environment=consumerEnvironment(runtime+L"\\runtime\\node");
    std::wstring command = quote(node) + L" " + quote(entry) + L" --consumer-config " + quote(config);
    BOOL inJob = FALSE; check(IsProcessInJob(GetCurrentProcess(), nullptr, &inJob), "JOB_UNAVAILABLE");
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
    const DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | (inJob ? CREATE_BREAKAWAY_FROM_JOB : 0);
    check(CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, FALSE, flags, environment.data(), root.c_str(), &startup, &child), "JOB_UNAVAILABLE");
    Handle process(child.hProcess), thread(child.hThread);
    // The Node session agent's SID-wide singleton determines which launch wins.
    // No UI-owned Job Object or inherited handle determines its lifetime.
    return 0;
  } catch (...) { return 2; }
}
