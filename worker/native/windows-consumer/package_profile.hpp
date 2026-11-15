#pragma once
#include <cstdint>
#include <string_view>

// CMake is the sole supported selector. There is no process environment,
// command-line or mutable-file switch that can widen an installed authority.
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
#include "musicmute_development_certificate.generated.hpp"
#endif

namespace mmstoreprofile {
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
inline constexpr bool developmentTest = true;
inline constexpr std::uint32_t signatureKind = 1; // PackageSignatureKind::Developer
inline constexpr std::wstring_view guiIdentity = L"MusicMute.Development";
inline constexpr std::wstring_view workerIdentity = L"MusicMute.WorkerDevelopment";
inline constexpr std::wstring_view publisher = L"CN=MusicMute Z440 Development";
inline constexpr std::wstring_view publisherId = L"kthggmwhkdz4t";
inline constexpr std::wstring_view guiFamily = L"MusicMute.Development_kthggmwhkdz4t";
inline constexpr std::wstring_view workerFamily = L"MusicMute.WorkerDevelopment_kthggmwhkdz4t";
inline constexpr std::wstring_view guiAumid = L"MusicMute.Development_kthggmwhkdz4t!MusicMute";
inline constexpr std::wstring_view workerSessionAumid = L"MusicMute.WorkerDevelopment_kthggmwhkdz4t!MusicMuteWorkerSession";
inline constexpr std::wstring_view personalDataLeaf = L"MusicMuteLocalDevelopment";
inline constexpr std::wstring_view fleetDataLeaf = L"MusicMuteWorkerDevelopment";
inline constexpr std::string_view certificateSha256 = MUSICMUTE_DEVELOPMENT_CERT_SHA256;
#else
inline constexpr bool developmentTest = false;
inline constexpr std::uint32_t signatureKind = 3; // PackageSignatureKind::Store
inline constexpr std::wstring_view guiIdentity = L"27120VCHATSDK.MusicMute";
inline constexpr std::wstring_view workerIdentity = L"27120VCHATSDK.MusicMuteWorker";
inline constexpr std::wstring_view publisher = L"CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E";
inline constexpr std::wstring_view publisherId = L"5q1esjnkz8cve";
inline constexpr std::wstring_view guiFamily = L"27120VCHATSDK.MusicMute_5q1esjnkz8cve";
inline constexpr std::wstring_view workerFamily = L"27120VCHATSDK.MusicMuteWorker_5q1esjnkz8cve";
inline constexpr std::wstring_view guiAumid = L"27120VCHATSDK.MusicMute_5q1esjnkz8cve!MusicMute";
inline constexpr std::wstring_view workerSessionAumid = L"27120VCHATSDK.MusicMuteWorker_5q1esjnkz8cve!MusicMuteWorkerSession";
inline constexpr std::wstring_view personalDataLeaf = L"MusicMuteLocal";
inline constexpr std::wstring_view fleetDataLeaf = L"MusicMuteWorker";
inline constexpr std::string_view certificateSha256{};
#endif
inline constexpr bool validCertificatePin(std::string_view pin) noexcept {
  return pin.size() == 64 && pin.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}
static_assert(!developmentTest || validCertificatePin(certificateSha256), "Development package requires an exact SHA256 certificate pin");
} // namespace mmstoreprofile
