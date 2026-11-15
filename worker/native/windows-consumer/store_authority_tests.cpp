#include "store_authority.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) {
  ++checks;
  if (!value) throw std::runtime_error("STORE_TEST_FAILED");
}
void denied(const std::function<void()>& operation, mmstore::ErrorCode expected) {
  bool rejected = false;
  try { operation(); }
  catch (const mmstore::Error& error) { rejected = error.code() == expected; }
  check(rejected);
}
mmstore::Observation policyFixture(mmstore::PackageKind kind) {
  const auto& expected = mmstore::expectedPackage(kind);
  return {std::wstring(expected.identityName), std::wstring(expected.publisher), std::wstring(expected.publisherId),
    std::wstring(expected.familyName), std::wstring(expected.identityName) + L"_1.2.3.0_x64__" + std::wstring(expected.publisherId),
    L"1.2.3.0", L"x64", L"C:\\Program Files\\WindowsApps\\policy-fixture", mmstoreprofile::signatureKind, true, true};
}
void portablePolicy() {
  using namespace mmstore;
  check(mmstoreprofile::validCertificatePin(std::string(64, 'a')));
  for (const auto& pin : {std::string{}, std::string(63, 'a'), std::string(65, 'a'), std::string(64, 'A'), std::string(64, 'g')})
    check(!mmstoreprofile::validCertificatePin(pin));
  check(mmstoreprofile::guiAumid == std::wstring(mmstoreprofile::guiFamily) + L"!MusicMute");
  check(mmstoreprofile::workerSessionAumid == std::wstring(mmstoreprofile::workerFamily) + L"!MusicMuteWorkerSession");
  if constexpr (mmstoreprofile::developmentTest) {
    check(mmstoreprofile::signatureKind == 1 && mmstoreprofile::validCertificatePin(mmstoreprofile::certificateSha256));
    check(mmstoreprofile::guiIdentity == L"MusicMute.Development" && mmstoreprofile::workerIdentity == L"MusicMute.WorkerDevelopment");
    check(mmstoreprofile::publisher == L"CN=MusicMute Z440 Development" && mmstoreprofile::publisherId == L"kthggmwhkdz4t");
    check(mmstoreprofile::personalDataLeaf == L"MusicMuteLocalDevelopment" && mmstoreprofile::fleetDataLeaf == L"MusicMuteWorkerDevelopment");
  } else {
    check(mmstoreprofile::signatureKind == 3 && mmstoreprofile::certificateSha256.empty());
    check(mmstoreprofile::guiIdentity == L"27120VCHATSDK.MusicMute" && mmstoreprofile::workerIdentity == L"27120VCHATSDK.MusicMuteWorker");
    check(mmstoreprofile::publisher == L"CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E" && mmstoreprofile::publisherId == L"5q1esjnkz8cve");
    check(mmstoreprofile::personalDataLeaf == L"MusicMuteLocal" && mmstoreprofile::fleetDataLeaf == L"MusicMuteWorker");
  }
  check(parseVersion(L"1.2.3.4") == PackageVersion{1, 2, 3, 4});
  check(parseVersion(L"65535.0.65535.65535") == PackageVersion{65535, 0, 65535, 65535});
  check(versionText({0, 1, 3, 0}) == L"0.1.3.0");
  for (const auto* value : {L"", L"0.0.0.0", L"1.2.3", L"1.2.3.4.5", L"01.2.3.4", L"1.2.3.-1", L"1.2.3.65536", L"1.2.3.4 ", L"1.2.3.4x"})
    denied([&] { (void)parseVersion(value); }, ErrorCode::invalidInput);
  check(validDigest(std::string(64, 'a')));
  for (const auto& value : {std::string(63, 'a'), std::string(65, 'a'), std::string(64, 'A'), std::string(64, 'g')}) check(!validDigest(value));
  for (const auto* path : {L"app/resources/native/manifest.json", L"app/MusicMute Local.exe", L"worker/runtime/python/python.exe", L"worker/app/engine/musicmute_engine/consumer_personal.py"}) check(validRelativePath(path));
  for (const auto* path : {L"", L"/app/a", L"app/", L"app//a", L"app/../a", L"app/./a", L"app\\a", L"C:/app/a", L"app/a:stream", L"app/a.", L"app/a ", L"app/CON.txt", L"app/lpt9", L"app/a*", L"app/a?", L"app/\nsecret"}) check(!validRelativePath(path));
  check(!validRelativePath(std::wstring(L"app/a\0hidden", 12)));
  check(!validRelativePath(L"app/\u202ehidden"));
  check(validInstalledLocation(L"D:\\WindowsApps\\registered-package"));
  check(!validInstalledLocation(L"\\\\server\\WindowsApps\\package"));
  check(!validInstalledLocation(L"C:\\WindowsApps\\..\\package"));
  check(!validInstalledLocation(L"C:\\WindowsApps\\package\\"));
  check(!validInstalledLocation(L"C:WindowsApps\\package"));
  validatePin({std::string(64, 'a'), maximumFileBytes}); ++checks;
  for (const auto bytes : {std::uint64_t{0}, maximumFileBytes + 1}) denied([&] { validatePin({std::string(64, 'a'), bytes}); }, ErrorCode::invalidInput);
  denied([] { validatePin({std::string(64, 'A'), 1}); }, ErrorCode::invalidInput);
  validateInventoryPin({std::string(emptySha256), 0}); ++checks;
  denied([] { validateInventoryPin({std::string(64, 'a'), 0}); }, ErrorCode::invalidInput);
  denied([] { validateInventoryPin({std::string(emptySha256), maximumFileBytes + 1}); }, ErrorCode::invalidInput);
  denied([] { validatePin({std::string(emptySha256), 0}); }, ErrorCode::invalidInput);
  for (const auto kind : {PackageKind::gui, PackageKind::worker}) {
    const auto good = policyFixture(kind);
    validateObservation(kind, good); ++checks;
    auto opposite = good;
    opposite.identityName = mmstoreprofile::developmentTest ? L"27120VCHATSDK.MusicMute" : L"MusicMute.Development";
    opposite.publisher = mmstoreprofile::developmentTest ? L"CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E" : L"CN=MusicMute Z440 Development";
    opposite.publisherId = mmstoreprofile::developmentTest ? L"5q1esjnkz8cve" : L"kthggmwhkdz4t";
    opposite.familyName = opposite.identityName + L"_" + opposite.publisherId;
    opposite.fullName = opposite.identityName + L"_1.2.3.0_x64__" + opposite.publisherId;
    opposite.signatureKind = mmstoreprofile::developmentTest ? 3 : 1;
    denied([&] { validateObservation(kind, opposite); }, ErrorCode::packageDenied);
    const auto other = kind == PackageKind::gui ? PackageKind::worker : PackageKind::gui;
    denied([&] { validateObservation(other, good); }, ErrorCode::packageDenied);
    for (unsigned field = 0; field < 11; ++field) {
      auto bad = good;
      switch (field) {
        case 0: bad.identityName += L"Other"; break;
        case 1: bad.publisher = L"CN=Foreign"; break;
        case 2: bad.publisherId = L"foreign"; break;
        case 3: bad.familyName += L"Other"; break;
        case 4: bad.fullName += L"staged"; break;
        case 5: bad.packageVersion = L"1.2.03.0"; break;
        case 6: bad.architecture = L"arm64"; break;
        case 7: bad.installedLocation = L"\\\\server\\package"; break;
        case 8: bad.signatureKind = mmstoreprofile::signatureKind == 1 ? 3 : 1; break;
        case 9: bad.healthy = false; break;
        case 10: bad.current = false; break;
      }
      denied([&] { validateObservation(kind, bad); }, ErrorCode::packageDenied);
    }
    for (const auto signature : {0U, 1U, 2U, 3U, 4U}) {
      if (signature == mmstoreprofile::signatureKind) continue;
      auto bad = good; bad.signatureKind = signature;
      denied([&] { validateObservation(kind, bad); }, ErrorCode::packageDenied);
    }
  }
  const std::array roles{CodeRole::guiApplication, CodeRole::guiNative, CodeRole::guiSession, CodeRole::guiChromeHost, CodeRole::guiBrowserEntry,
    CodeRole::workerControls, CodeRole::workerSession, CodeRole::workerNative, CodeRole::workerNode, CodeRole::workerPython,
    CodeRole::workerLoginAgent, CodeRole::workerSessionAgent, CodeRole::workerPersonalAgent, CodeRole::workerFleetAgent,
    CodeRole::workerPrepareAgent, CodeRole::workerFfmpeg, CodeRole::workerFfprobe, CodeRole::workerDeno};
  for (const auto role : roles) check(validRelativePath(codeSpec(role).relativePath));
  check(codeSpec(CodeRole::guiApplication).relativePath == L"app/MusicMute Local.exe");
  check(codeSpec(CodeRole::workerNative).relativePath == L"worker/runtime/native/musicmute-native.exe");
  check(codeSpec(CodeRole::workerSession).relativePath == L"worker/MusicMuteSession.exe");
  check(codeSpec(CodeRole::workerControls).kind == PackageKind::worker);
  denied([] { (void)expectedPackage(static_cast<PackageKind>(99)); }, ErrorCode::invalidInput);
  denied([] { (void)codeSpec(static_cast<CodeRole>(99)); }, ErrorCode::invalidInput);
}

#ifdef _WIN32
void actualHashLifecycle() {
  using namespace mmstore;
  wchar_t temporary[32768]{};
  const auto count = GetTempPathW(32768, temporary);
  check(count > 0 && count < 32768);
  std::array<BYTE, 16> random{};
  check(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring path(temporary, count); path += L"MusicMuteHashLifecycle-";
  for (const auto byte : random) { path += hex[byte >> 4U]; path += hex[byte & 15U]; }
  // This exclusive, random scratch file is removed by its own held handle on
  // every return or exception. No installed package or user data is modified.
  detail::Handle file(CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE | DELETE, 0, nullptr, CREATE_NEW,
    FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr));
  check(file.valid());
  const auto replace = [&](const std::string& bytes) {
    check(SetFilePointerEx(file.get(), {}, nullptr, FILE_BEGIN) != FALSE && SetEndOfFile(file.get()) != FALSE);
    DWORD written = 0;
    if (!bytes.empty()) check(WriteFile(file.get(), bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != FALSE && written == bytes.size());
  };
  replace("");
  check(detail::hashFile(file.get(), 0) == emptySha256);
  replace(std::string(65537, 'a'));
  check(detail::hashFile(file.get(), 65537) == "008ffc88d3c96a9f307524eb361e47c5222a887fc45fa0c1fb8d429c5c23b430");
  replace("abc");
  constexpr std::string_view abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  // Repeat real CNG create/finish/destroy and both post-create error paths.
  // Every rejection must unwind safely and permit another complete hash.
  for (unsigned attempt = 0; attempt < 16; ++attempt) {
    check(detail::hashFile(file.get(), 3) == abc);
    denied([&] { (void)detail::hashFile(file.get(), 2); }, ErrorCode::fileDenied);
    denied([&] { (void)detail::hashFile(file.get(), 4); }, ErrorCode::fileDenied);
    denied([] { (void)detail::hashFile(INVALID_HANDLE_VALUE, 1); }, ErrorCode::fileDenied);
    check(detail::hashFile(file.get(), 3) == abc);
  }
}
void actualImmutableAcl() {
  wchar_t directory[32768]{};
  const auto count = GetSystemDirectoryW(directory, 32768);
  check(count > 0 && count < 32768);
  // Read only an existing OS-owned file. This exercises the complete security
  // descriptor/AccessCheck path without granting Store package authority.
  auto file = mmstore::detail::openEntry(std::wstring(directory, count) + L"\\kernel32.dll", false, true);
  mmstore::detail::assertImmutableAcl(file.get(), false); ++checks;
}
void actualLogon() {
  const auto observed = mmstore::detail::logon(GetCurrentProcess());
  DWORD session = 0;
  check(ProcessIdToSessionId(GetCurrentProcessId(), &session) != FALSE && session > 0 && session == observed.session);
  check(!observed.sid.empty() && observed.logonSid.starts_with(L"S-1-5-5-"));
  mmstore::detail::Handle token;
  HANDLE raw = nullptr;
  check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE);
  token = mmstore::detail::Handle(raw);
  check(mmstore::detail::fixedTokenValue<TOKEN_ELEVATION>(token.get(), TokenElevation).TokenIsElevated == 0);
  check(mmstore::detail::fixedTokenValue<DWORD>(token.get(), TokenUIAccess) == 0);
  denied([] { (void)mmstore::detail::fixedTokenValue<TOKEN_ELEVATION>(INVALID_HANDLE_VALUE, TokenElevation); }, mmstore::ErrorCode::standardLogonRequired);
}
// These checks never install or activate a package or change files, ACLs,
// registry, policy, logon state or trust. Only genuine installed Store code can
// provide a positive OS observation; policy fixtures never create authority.
bool actualStore(mmstore::PackageKind kind) {
  using namespace mmstore;
  RegisteredPackage package = resolveRegisteredPackage(kind);
  const auto& observed = package.observation();
  check(observed.signatureKind == mmstoreprofile::signatureKind && observed.healthy && observed.current);
  package.revalidate(); ++checks;
  // A standard user can open their exact registered package while its parent
  // WindowsApps container may deny even metadata-only handles. Exercise the
  // actual immutable root anchor, not a caller-provided ancestor exception.
  auto root = detail::rootHandles(observed.installedLocation);
  check(!root.empty() && detail::samePath(detail::canonical(root.back().get()), observed.installedLocation));
  detail::assertImmutableAcl(root.back().get(), true); ++checks;
  denied([&] { (void)detail::rootHandles(observed.installedLocation + L"\\.."); }, ErrorCode::pathDenied);
  const auto role = kind == PackageKind::gui ? CodeRole::guiApplication : CodeRole::workerControls;
  const auto path = detail::joinedPath(observed.installedLocation, codeSpec(role).relativePath);
  auto actual = detail::openEntry(path, false, true);
  const auto bytes = detail::fileBytes(detail::information(actual.get(), false));
  const FilePin pin{detail::hashFile(actual.get(), bytes), bytes};
  auto held = package.openCode(role, pin);
  check(held.handle() != nullptr && held.pin().sha256 == pin.sha256 && held.pin().bytes == pin.bytes);
  held.revalidate(); ++checks;
  auto wrong = pin; wrong.sha256[0] = wrong.sha256[0] == 'a' ? 'b' : 'a';
  denied([&] { (void)package.openCode(role, wrong); }, ErrorCode::digestMismatch);
  wrong = pin; ++wrong.bytes;
  denied([&] { (void)package.openCode(role, wrong); }, ErrorCode::digestMismatch);
  denied([&] { (void)package.openResource(L"../outside.exe", pin); }, ErrorCode::invalidInput);
  const auto foreign = kind == PackageKind::gui ? CodeRole::workerNode : CodeRole::guiApplication;
  denied([&] { (void)package.openCode(foreign, pin); }, ErrorCode::invalidInput);
  // The standalone test executable is not the package's fixed production role.
  denied([&] { (void)attestProcess(GetCurrentProcessId(), role, pin); }, ErrorCode::processDenied);
  return true;
}
#endif
}  // namespace

int main(int argc, char** argv) {
  try {
    const bool policyOnly = argc == 2 && std::string_view(argv[1]) == "--policy-only";
    const bool logonOnly = argc == 2 && std::string_view(argv[1]) == "--logon-only";
    const bool aclOnly = argc == 2 && std::string_view(argv[1]) == "--immutable-acl-only";
    mmstore::require(argc == 1 || policyOnly || logonOnly || aclOnly, mmstore::ErrorCode::invalidInput);
    portablePolicy();
    std::cout << "Store portable policy checks passed: " << checks << '\n';
    if (policyOnly) return 0;
#ifdef _WIN32
    if (!logonOnly && !aclOnly) {
      actualHashLifecycle();
      std::cout << "Actual CNG hash known-vector and failure-unwind checks passed.\n";
    }
    actualLogon();
    if (aclOnly) {
      actualImmutableAcl();
      std::cout << "Actual OS-owned immutable ACL check passed. No Store package authority was established.\n";
      return 0;
    }
    if (logonOnly) {
      std::cout << "Actual standard interactive logon checks passed. No Store package authority was established.\n";
      return 0;
    }
    unsigned positives = 0, unavailable = 0;
    for (const auto kind : {mmstore::PackageKind::gui, mmstore::PackageKind::worker}) {
      try { if (actualStore(kind)) ++positives; }
      catch (const mmstore::Error& error) {
        if (error.code() != mmstore::ErrorCode::packageNotRegistered && error.code() != mmstore::ErrorCode::unsupportedHost) throw;
        ++unavailable;
      }
    }
    if (!positives) {
      std::cout << "Store OS checks skipped: unsupported host or no expected registered Store package. No positive Store authority was established.\n";
      return 77;
    }
    std::cout << "Store actual registered package checks passed: " << positives << "; unavailable: " << unavailable << '\n';
#else
    if (logonOnly || aclOnly) return 77;
    std::cout << "Store OS checks unavailable on this platform. No positive Store authority was established.\n";
#endif
    return 0;
  } catch (const std::exception& error) {
    // Module errors are static public codes; no private/code path or OS detail
    // is printed on failure.
    std::cerr << "Store authority test failed: " << error.what() << '\n';
    return 1;
  }
}
