#include "store_code_watch.hpp"
#include "store_broker_policy.hpp"
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#ifdef _WIN32
#include <filesystem>
#include <fstream>
#include <iterator>
#endif
namespace {
unsigned checks = 0;
void check(bool condition) { if (!condition) throw std::runtime_error("watch check " + std::to_string(checks + 1)); ++checks; }
template<class F> void denied(F operation) {
  bool rejected = false; try { operation(); } catch (const mmstore::Error& error) { rejected = error.code() == mmstore::ErrorCode::fileDenied; }
  check(rejected);
}
void policy() {
  using namespace mmstoreruntime;
  CodeWatchPolicy unarmed; denied([&] { unarmed.requireLive(CodeWatchObservation::pending); });
  for (const auto bad : {CodeWatchObservation::changed, CodeWatchObservation::overflow, CodeWatchObservation::error, static_cast<CodeWatchObservation>(99)}) {
    CodeWatchPolicy before; denied([&] { before.armed(bad); }); denied([&] { before.armed(CodeWatchObservation::pending); });
    CodeWatchPolicy initial; initial.armed(CodeWatchObservation::pending); denied([&] { initial.completedInitialCensus(bad); });
    denied([&] { initial.completedInitialCensus(CodeWatchObservation::pending); });
    CodeWatchPolicy after; after.armed(CodeWatchObservation::pending); after.completedInitialCensus(CodeWatchObservation::pending);
    denied([&] { after.requireLive(bad); }); denied([&] { after.requireLive(CodeWatchObservation::pending); });
  }
  CodeWatchPolicy original; original.armed(CodeWatchObservation::pending);
  original.requirePending(CodeWatchObservation::pending); ++checks;
  denied([&] { original.requireLive(CodeWatchObservation::pending); });
  original.completedInitialCensus(CodeWatchObservation::pending); ++checks;
  for (unsigned n = 0; n < 64; ++n) { original.requireLive(CodeWatchObservation::pending); ++checks; }
  denied([&] { original.armed(CodeWatchObservation::pending); });
  denied([&] { original.completedInitialCensus(CodeWatchObservation::pending); });
}
void cleanupPolicy() {
  using namespace mmstorerole;
  for (const auto* name : {"role-stop", "role-inspect", "child-stop", "tool-stop", "qualification-stop", "gpu-release", "session-retire-children", "control-ack"}) check(cleanupBrokerName(name));
  for (const auto* name : {"role-launch", "role-peer", "gpu-acquire", "gpu-inspect", "session-publish", "prepare-request", "prepare-result", "control-request", "control-reply", "control-accept", "control-peer", "child-start", "child-read", "child-write", "tool-start", "tool-read", "qualification-start", "qualification-read", "personal-cleanup-state", "execute", "", "role-stop-extra"}) check(!cleanupBrokerName(name));
  const mm::Json empty = mm::Json::Object{};
  check(cleanupBrokerOperation(Role::session, BrokerCommand::sessionRetire, empty));
  for (const auto role : {Role::login, Role::personal, Role::fleet, Role::prepare}) check(!cleanupBrokerOperation(role, BrokerCommand::sessionRetire, empty));
  check(!cleanupBrokerOperation(Role::session, BrokerCommand::sessionRetire, mm::Json::Object{{"ignore_watch", true}}));
  const std::string id = "12345678-1234-4234-8234-123456789012";
  const mm::Json stop = mm::Json::Object{{"token", std::string(64, 'a')}};
  check(cleanupBrokerOperation(Role::personal, BrokerCommand::childStop, stop));
  check(cleanupBrokerOperation(Role::fleet, BrokerCommand::childStop, stop));
  for (const auto role : {Role::login, Role::session, Role::prepare}) check(!cleanupBrokerOperation(role, BrokerCommand::childStop, stop));
  for (const auto role : {Role::personal, Role::fleet}) {
    check(!cleanupBrokerOperation(role, BrokerCommand::childStop, mm::Json::Object{{"token", std::string(63, 'a')}}));
    check(!cleanupBrokerOperation(role, BrokerCommand::childStop, mm::Json::Object{{"token", std::string(64, 'a')}, {"ignore_watch", true}}));
  }
  check(cleanupBrokerOperation(Role::prepare, BrokerCommand::toolStop, stop));
  check(!cleanupBrokerOperation(Role::session, BrokerCommand::toolStop, stop));
  const mm::Json ack = mm::Json::Object{{"version", 1}, {"requestId", id}, {"action", "session_forward_ack"}};
  check(cleanupGuiCommand(ack));
  check(!cleanupGuiCommand(mm::Json::Object{{"version", 1}, {"requestId", id}, {"action", "session_forward"}, {"payload_base64", "e30="}}));
  check(!cleanupGuiCommand(mm::Json::Object{{"version", 1}, {"requestId", id}, {"action", "session_forward_ack"}, {"ignore_watch", true}}));
}

#ifdef _WIN32
void write(const std::filesystem::path& path) { std::ofstream file(path, std::ios::binary | std::ios::trunc); file << "fixed scratch fixture"; file.close(); check(!file.fail()); }
std::string read(const std::filesystem::path& path) { std::ifstream file(path, std::ios::binary); const std::string bytes{std::istreambuf_iterator<char>{file}, {}}; check(!file.bad() && bytes.size() <= 64); return bytes; }
void mutation(BOOL result, DWORD error, unsigned kind, const char* operation) {
  if (result == FALSE) throw std::runtime_error("watch mutation kind=" + std::to_string(kind) + " operation=" + operation + " win32_error=" + std::to_string(error));
  check(true);
}
void windowsScratch() {
  using mmstoreruntime::detail::HeldCodeChangeWatch;
  std::array<unsigned char, 16> random{};
  check(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0);
  constexpr char alphabet[] = "0123456789abcdef"; std::wstring name = L"musicmute-store-watch-";
  for (const auto byte : random) { name += static_cast<wchar_t>(alphabet[byte >> 4]); name += static_cast<wchar_t>(alphabet[byte & 15]); }
  const auto root = std::filesystem::temp_directory_path() / name;
  check(std::filesystem::create_directory(root));
  struct Scratch { std::filesystem::path root; ~Scratch() { std::error_code error; std::filesystem::remove_all(root, error); } } scratch{root};
  for (unsigned kind = 0; kind < 6; ++kind) {
    const auto directory = root / std::to_wstring(kind); check(std::filesystem::create_directory(directory));
    const auto leaf = directory / L"original.txt"; write(leaf);
    const auto destination = directory / L"renamed.txt";
    if (kind == 2) {
      const auto away = MoveFileW(leaf.c_str(), destination.c_str()); const auto awayError = away ? ERROR_SUCCESS : GetLastError(); mutation(away, awayError, kind, "baseline-rename-away");
      const auto back = MoveFileW(destination.c_str(), leaf.c_str()); const auto backError = back ? ERROR_SUCCESS : GetLastError(); mutation(back, backError, kind, "baseline-rename-back");
    } else if (kind == 3) {
      const auto result = DeleteFileW(leaf.c_str()); const auto error = result ? ERROR_SUCCESS : GetLastError(); mutation(result, error, kind, "baseline-delete"); write(leaf);
    }
    const auto expectedBytes = read(leaf); check(expectedBytes == "fixed scratch fixture");
    // This read-only scratch identity probe deliberately shares all accesses;
    // it cannot cause the later sharing-denial negative control itself.
    mmstore::detail::Handle original(CreateFileW(leaf.c_str(), GENERIC_READ | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    check(original.valid()); const auto originalBirth = mmstore::detail::information(original.get(), false);
    {
      HeldCodeChangeWatch watch(directory.wstring()); watch.completedInitialCensus(); watch.requireLive(); ++checks;
      bool mutationBlocked = false;
      if (kind == 0) write(directory / L"inserted.txt");
      else if (kind == 1) write(leaf);
      else if (kind == 2) {
        // The fixed parent directory is held with the production sharing policy.
        // The actual Z440 diagnostic established ERROR_SHARING_VIOLATION here.
        // A positively blocked rename is protection, not notification evidence.
        const auto result = MoveFileW(leaf.c_str(), destination.c_str());
        const auto error = result ? ERROR_SUCCESS : GetLastError();
        if (result == FALSE && error == ERROR_SHARING_VIOLATION) {
          check(std::filesystem::is_regular_file(leaf) && !std::filesystem::exists(destination));
          check(mmstore::detail::sameFile(originalBirth, mmstore::detail::information(original.get(), false)) && mmstore::detail::samePath(mmstore::detail::canonical(original.get()), leaf.wstring()) && read(leaf) == expectedBytes);
          check(!watch.waitForChange(0)); watch.requireLive(); ++checks; watch.requireLive(); ++checks;
          mutationBlocked = true;
        } else mutation(result, error, kind, "rename");
      }
      else if (kind == 3) {
        const auto result = DeleteFileW(leaf.c_str()); const auto error = result ? ERROR_SUCCESS : GetLastError();
        if (result == FALSE && error == ERROR_SHARING_VIOLATION) {
          check(std::filesystem::is_regular_file(leaf));
          check(mmstore::detail::sameFile(originalBirth, mmstore::detail::information(original.get(), false)) && mmstore::detail::samePath(mmstore::detail::canonical(original.get()), leaf.wstring()) && read(leaf) == expectedBytes);
          check(!watch.waitForChange(0)); watch.requireLive(); ++checks; watch.requireLive(); ++checks; mutationBlocked = true;
        } else mutation(result, error, kind, "delete");
      }
      else if (kind == 4) { const auto result = SetFileAttributesW(leaf.c_str(), FILE_ATTRIBUTE_READONLY); const auto error = result ? ERROR_SUCCESS : GetLastError(); mutation(result, error, kind, "attributes"); }
      else {
        mmstore::detail::Handle file(CreateFileW(leaf.c_str(), READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr)); const auto error = file.valid() ? ERROR_SUCCESS : GetLastError(); mutation(file.valid() ? TRUE : FALSE, error, kind, "open-security");
        PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
        const auto readError = GetSecurityInfo(file.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &dacl, nullptr, &raw); mutation(readError == ERROR_SUCCESS ? TRUE : FALSE, readError, kind, "read-security");
        struct Descriptor { PSECURITY_DESCRIPTOR raw; ~Descriptor() { if (raw) LocalFree(raw); } } descriptor{raw};
        const auto writeError = SetSecurityInfo(file.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr); mutation(writeError == ERROR_SUCCESS ? TRUE : FALSE, writeError, kind, "protect-security");
      }
      if (!mutationBlocked) { check(watch.waitForChange(5000)); denied([&] { watch.requireLive(); }); denied([&] { watch.requireLive(); }); }
    }
    // Only this test's exclusive owned scratch tree is changed/removed.
    if (kind == 4) check(SetFileAttributesW(leaf.c_str(), FILE_ATTRIBUTE_NORMAL) != FALSE);
  }
  // Watch is posted before initial census. A mutation during that acquisition
  // cannot be hidden by marking the resulting snapshot complete later.
  const auto directory = root / L"during-census"; check(std::filesystem::create_directory(directory));
  HeldCodeChangeWatch watch(directory.wstring()); write(directory / L"late.txt"); check(watch.waitForChange(5000));
  denied([&] { watch.completedInitialCensus(); }); denied([&] { watch.requireLive(); });
  std::cout << "Actual Windows scratch watch: insertion/write/attributes/security + acquisition change denied; baseline rename/delete succeed, then each is either positively sharing-blocked with unchanged actual identity/bytes or permanently invalidates the actual watch. No Store registration/signature authority fixture.\n";
}
#endif
}
int main(int argc, char** argv) {
  try {
    const bool pure = argc == 2 && std::string_view(argv[1]) == "--policy-only";
    if (argc != 1 && !pure) return 2;
    policy(); cleanupPolicy();
#ifdef _WIN32
    if (!pure) windowsScratch();
#endif
    std::cout << checks << " Store code-watch checks passed\n"; return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
