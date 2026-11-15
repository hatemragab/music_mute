#pragma once
#include "store_role_policy.hpp"
#include "store_inventory.hpp"
#include "store_browser_attachment_policy.hpp"
namespace mmstorerole {
#ifdef _WIN32
// Minted only after the actual GUI-owned pipe challenge. The receiving
// attachment reflects the original native Host's kernel-STDIO admission;
// independently held source/Host/Chrome peers and the fresh live creator
// relationship remain mandatory throughout every browser command.
class StoreGuiBrowserScope final {
 public:
  StoreGuiBrowserScope(StoreGuiBrowserScope&&) noexcept = default;
  StoreGuiBrowserScope& operator=(StoreGuiBrowserScope&&) noexcept = default;
  StoreGuiBrowserScope(const StoreGuiBrowserScope&) = delete;
  static StoreGuiBrowserScope open(const mm::Json& proof, const mmstoreinventory::Inventory& inventory, mmstore::AttestedProcess& helper, mmstore::AttestedProcess& gui) {
    using mmstore::require; constexpr auto denied = mmstore::ErrorCode::processDenied;
    try {
      const auto& attached = proof.at("browser_attachment");
      const auto wire = [](const mmstore::ProcessIdentity& identity) { return mm::Json(mm::Json::Object{{"sid", ascii(identity.sid)}, {"session_id", static_cast<std::int64_t>(identity.sessionId)}, {"pid", static_cast<std::int64_t>(identity.pid)}, {"creation_time", ascii(identity.creationTime)}}); };
      mmstorebrowserattachment::attachment(attached, wire(gui.identity()), ascii(gui.observation().fullName));
      const auto& original = proof.at("source_helper");
      auto source = mmstore::attestProcess(pid(original.at("pid")), mmstore::CodeRole::guiNative, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiNative));
      auto host = mmstore::attestProcess(pid(attached.at("host").at("pid")), mmstore::CodeRole::guiChromeHost, mmstoreinventory::codePin(inventory, mmstore::CodeRole::guiChromeHost));
      require(source.observation().fullName == gui.observation().fullName && host.observation().fullName == gui.observation().fullName &&
        source.identity().creationTime == wide(original.at("creation_time").string()) && mm::dump(wire(host.identity())) == mm::dump(attached.at("host")) &&
        source.identity().sid == gui.identity().sid && source.identity().logonSid == gui.identity().logonSid && source.identity().sessionId == gui.identity().sessionId &&
        host.identity().sid == gui.identity().sid && host.identity().logonSid == gui.identity().logonSid && host.identity().sessionId == gui.identity().sessionId &&
        mmstore::detail::parentPid(source.identity().pid) == gui.identity().pid && mmstore::detail::parentPid(gui.identity().pid) == host.identity().pid &&
        mmstore::detail::creation(gui.handle()) <= mmstore::detail::creation(source.handle()), denied);
      const auto chromePid = pid(attached.at("chrome").at("pid"));
      mmstore::detail::Handle chrome(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, chromePid)); require(chrome.valid(), denied);
      const auto chromeIdentity = mmstore::detail::processIdentity(chrome.get());
      require(chromePid != source.identity().pid && chromePid != helper.identity().pid && chromePid != gui.identity().pid && chromePid != host.identity().pid &&
        mm::dump(wire(chromeIdentity)) == mm::dump(attached.at("chrome")) && chromeIdentity.logonSid == gui.identity().logonSid, denied);
      const auto path = mmstore::detail::processImage(chrome.get()); require(mmstore::validInstalledLocation(path), denied);
      auto code = mmstore::detail::openEntry(path, false, false); const auto birth = mmstore::detail::information(code.get(), false);
      require(birth.nNumberOfLinks == 1 && mmstore::detail::fileBytes(birth) > 0, denied);
      const auto digest = mmstore::detail::hashFile(code.get(), mmstore::detail::fileBytes(birth));
      auto result = StoreGuiBrowserScope(std::move(source), std::move(host), std::move(chrome), chromeIdentity, std::move(code), path, birth, digest, attached);
      result.revalidate(); helper.revalidate(); gui.revalidate(); return result;
    } catch (...) { mmstore::fail(denied); }
  }
  const mmstore::ProcessIdentity& peer() const noexcept { return source_.identity(); }
  bool retired() const {
    const auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::gui);
    mmstore::require(package.observation().fullName == source_.observation().fullName && package.observation().fullName == host_.observation().fullName, mmstore::ErrorCode::stalePackage);
    bool ended = false;
    for (const auto process : {source_.handle(), host_.handle(), chrome_.get()}) {
      const auto state = WaitForSingleObject(process, 0); mmstore::require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, mmstore::ErrorCode::processDenied); ended = ended || state == WAIT_OBJECT_0;
    }
    return ended;
  }
  void revalidate() const {
    mmstore::require(!retired(), mmstore::ErrorCode::processDenied); source_.revalidate(); host_.revalidate();
    const auto current = mmstore::detail::processIdentity(chrome_.get());
    mmstore::require(mmstore::detail::sameIdentity(current, chromeIdentity_) && mmstore::detail::samePath(mmstore::detail::processImage(chrome_.get()), chromePath_) &&
      mmstore::detail::sameFile(chromeBirth_, mmstore::detail::information(chromeCode_.get(), false)) && mmstore::detail::samePath(mmstore::detail::canonical(chromeCode_.get()), chromePath_), mmstore::ErrorCode::processDenied);
  }
  void revalidateCleanup() const {
    // The captured, already-admitted scope remains the cleanup owner when the
    // original registry starts closing its derived helpers. No fresh browser
    // rights are minted. Positive original peer death permits only cleanup;
    // living peers, current registration and retained code still revalidate.
    (void)retired();
    for (const auto* process : {&source_, &host_}) {
      const auto state = WaitForSingleObject(process->handle(), 0);
      mmstore::require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, mmstore::ErrorCode::processDenied);
      if (state == WAIT_TIMEOUT) process->revalidate();
    }
    const auto state = WaitForSingleObject(chrome_.get(), 0);
    mmstore::require(state == WAIT_OBJECT_0 || state == WAIT_TIMEOUT, mmstore::ErrorCode::processDenied);
    if (state == WAIT_TIMEOUT) mmstore::require(mmstore::detail::sameIdentity(mmstore::detail::processIdentity(chrome_.get()), chromeIdentity_) &&
      mmstore::detail::samePath(mmstore::detail::processImage(chrome_.get()), chromePath_), mmstore::ErrorCode::processDenied);
    mmstore::require(mmstore::detail::sameFile(chromeBirth_, mmstore::detail::information(chromeCode_.get(), false)) &&
      mmstore::detail::samePath(mmstore::detail::canonical(chromeCode_.get()), chromePath_), mmstore::ErrorCode::processDenied);
  }
  void confirm(const mm::Json& proof, bool cleanupOnly) const {
    if (cleanupOnly && retired()) return;
    revalidate();
    mmstore::require(mm::dump(proof.at("browser_attachment")) == mm::dump(attachment_) && proof.at("source_helper").at("pid").integer() == source_.identity().pid &&
      proof.at("source_helper").at("creation_time").string() == ascii(source_.identity().creationTime), mmstore::ErrorCode::processDenied);
  }
 private:
  static std::string ascii(std::wstring_view value) { std::string result; for (const auto c : value) { mmstore::require(c > 0 && c < 128, mmstore::ErrorCode::processDenied); result.push_back(static_cast<char>(c)); } return result; }
  static std::wstring wide(std::string_view value) { std::wstring result; for (const auto c : value) { mmstore::require(c > 0 && static_cast<unsigned char>(c) < 128, mmstore::ErrorCode::processDenied); result.push_back(static_cast<wchar_t>(c)); } return result; }
  StoreGuiBrowserScope(mmstore::AttestedProcess source, mmstore::AttestedProcess host, mmstore::detail::Handle chrome, mmstore::ProcessIdentity identity,
      mmstore::detail::Handle code, std::wstring path, BY_HANDLE_FILE_INFORMATION birth, std::string digest, mm::Json attachment)
    : source_(std::move(source)), host_(std::move(host)), chrome_(std::move(chrome)), chromeIdentity_(std::move(identity)), chromeCode_(std::move(code)), chromePath_(std::move(path)), chromeBirth_(birth), chromeDigest_(std::move(digest)), attachment_(std::move(attachment)) {}
  mmstore::AttestedProcess source_, host_; mmstore::detail::Handle chrome_; mmstore::ProcessIdentity chromeIdentity_;
  mmstore::detail::Handle chromeCode_; std::wstring chromePath_; BY_HANDLE_FILE_INFORMATION chromeBirth_{}; std::string chromeDigest_; mm::Json attachment_;
};
#endif
} // namespace mmstorerole
