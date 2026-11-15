#include "store_gui_launch_policy.hpp"
#include <functional>
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_GUI_LAUNCH_POLICY_FAILED"); }
void denied(const std::function<void()>& operation) {
  bool refused = false; try { operation(); } catch (const mmstore::Error&) { refused = true; } check(refused);
}
std::wstring package(mmstore::PackageKind kind, std::wstring_view version = L"0.1.0.1") {
  const auto& value = mmstore::expectedPackage(kind);
  return std::wstring(value.identityName) + L"_" + std::wstring(version) + L"_x64__" + std::wstring(value.publisherId);
}
std::wstring argument(std::wstring_view value) {
  const std::array<std::wstring_view, 1> arguments{value};
  return mmstoreguilaunch::activation(arguments);
}
}
int main() {
  try {
    using namespace mmstoreguilaunch;
    check(packageKind(package(mmstore::PackageKind::gui)) == mmstore::PackageKind::gui);
    check(packageKind(package(mmstore::PackageKind::worker, L"0.1.3.9")) == mmstore::PackageKind::worker);
    for (const auto* version : {L"01.1.0.1", L"0.1.0", L"0.1.0.65536", L"0.0.0.0", L"0.1.0.1_"})
      denied([&] { (void)packageKind(package(mmstore::PackageKind::gui, version)); });
    for (const auto& value : std::array<std::wstring, 5>{std::wstring{}, package(mmstore::PackageKind::gui) + L".evil",
        L"Other_" + package(mmstore::PackageKind::gui), L"MusicMute.Development_0.1.0.1_x64__wrong",
        L"MusicMute.Development_0.1.0.1_arm64__kthggmwhkdz4t"}) denied([&] { (void)packageKind(value); });
    check(activation({}).empty()); check(argument(L"--headless-account") == L"--headless-account");
    check(argument(L"musicmute-local://setup") == L"musicmute-local://setup");
    check(argument(L"musicmute-local://setup/") == L"musicmute-local://setup");
    constexpr std::wstring_view cloud = L"musicmute-local://cloud?video_id=bZxrIoCPsOc";
    check(argument(cloud) == cloud);
    check(argument(L"musicmute-local://cloud/?video_id=bZxrIoCPsOc&duration_seconds=1200") == std::wstring(cloud) + L"&duration_seconds=1200");
    check(argument(L"musicmute-local://cloud?duration_seconds=61&video_id=bZxrIoCPsOc") == std::wstring(cloud) + L"&duration_seconds=61");
    check(argument(L"musicmute-local://cloud?%76ideo_id=%62ZxrIoCPsOc&duration%5fseconds=%36%31") == std::wstring(cloud) + L"&duration_seconds=61");
    check(argument(L" MUSICMUTE-LOCAL://cloud?&video_id=bZxrIoCPsOc&&\r\n") == cloud);
    check(argument(L"musicmute-local://cloud?video_id=ABCdef12_-9&duration_seconds=1") == L"musicmute-local://cloud?video_id=ABCdef12_-9&duration_seconds=1");
    for (const auto* value : {L"", L"--no-sandbox", L"--inspect=9222", L"--native-browser-stdio", L"--installer-maintenance",
        L"--headless-account=1", L"C:\\caller.exe", L"https://example.test", L"musicmute-local://setup?execute=cmd",
        L"musicmute-local://setup#extra", L"musicmute-local://cloud/private?video_id=bZxrIoCPsOc",
        L"musicmute-local://user:password@cloud?video_id=bZxrIoCPsOc", L"musicmute-local://cloud:80?video_id=bZxrIoCPsOc",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc#fragment", L"musicmute-local://cloud?video_id=bZxrIoCPsOc&id_token=secret",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc&rights_confirmed=true", L"musicmute-local://cloud?video_id=bZxrIoCPsOc&video_id=abcdefghijk",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc&%76ideo_id=abcdefghijk", L"musicmute-local://cloud?video_id=short",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc&duration_seconds=0", L"musicmute-local://cloud?video_id=bZxrIoCPsOc&duration_seconds=012",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc&duration_seconds=1201", L"musicmute-local://cloud?video_id=bZxrIoCPsOc&duration_seconds=1.5",
        L"musicmute-local://cloud?video_id=bZxrIoCPsOc&duration_seconds=1&duration_seconds=2", L"musicmute-local://cloud?duration_seconds=10",
        L"musicmute-local://cloud?video_id=%00ZxrIoCPsOc", L"musicmute-local://cloud?video_id=%GGxrIoCPsOc",
        L"musicmute-local://cloud?video_id=bZxrIoCPsO%", L"musicmute-local://cloud?video_id=bZxrIoCPsO+",
        L"musicmute-local://cloud?video_id=bZxrIoCPsO%22", L"musicmute-local://cloud?video_id=bZxrIoCPsO%5c"})
      denied([&] { (void)argument(value); });
    const std::array<std::wstring_view, 2> extra{L"musicmute-local://setup", L"--no-sandbox"};
    denied([&] { (void)activation(extra); });
    denied([&] { (void)argument(std::wstring(2049, L'a')); });
    std::cout << "STORE_GUI_LAUNCH_POLICY_PASS checks=" << checks << '\n'; return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
