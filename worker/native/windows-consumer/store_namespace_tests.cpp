#include "store_namespace.hpp"
#include "store_gui_issuer_policy.hpp"
#include <functional>
#include <iostream>
#include <type_traits>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("STORE_NAMESPACE_TEST_FAILED"); }
void operationPolicy() {
  for (const auto* operation : {"identity", "boot_identity", "process_identity", "ensure_private_directory", "validate_path",
      "private_file_open", "private_file_info", "private_file_read", "private_file_write", "private_file_truncate",
      "private_file_sync", "private_file_close", "vault_put", "vault_get", "vault_delete", "vault_recover",
      "acquire_mutex", "release_mutex", "gpu_inventory", "singleton_inspect", "cache_delete_begin", "cache_delete_commit",
      "cache_delete_release", "cache_delete_recover", "share_workspace_discard", "diagnostic_report_remove",
      "personal_cleanup_recover", "storage_partial_discard", "library_artifact_discard", "library_tree_discard",
      "library_tree_cleanup_ack", "library_tree_cleanup_list", "library_local_move", "library_artifact_publish",
      "library_artifact_publication_inspect", "storage_workspace_marker_retire", "storage_cleanup_ack",
      "storage_cleanup_recover"}) check(mmstorenamespace::guiDataOperation(operation));
  for (const auto* operation : {"", "Identity", "store_boot", "store_private_boot", "launch_owned", "stop_owned", "bind_role_job",
      "acquire_gpu_guard", "retained_engine_register", "pipe_connect", "account_peer_verify", "share_start",
      "created_export_discard", "runtime_repair_backup_remove", "installer_launch", "startup_register", "startup_retain",
      "protocol_register", "release_remove_unused", "browser_register", "worker_login_peer_verify"})
    check(!mmstorenamespace::guiDataOperation(operation));
  check(!mmstorenamespace::guiDataOperation(std::string_view("identity\0foreign", 16)));
}
void issuerPolicy() {
  const std::string nonce(64, 'a'), birth = "1337133713371337";
  const mm::Json valid = mm::Json::Object{{"version", 1}, {"accepted", true}, {"nonce", nonce}, {"pid", 1234}, {"creation_time", birth}};
  mmstoreguiissuer::validateReply(valid, nonce, 1234, birth); ++checks;
  const auto rejected = [&](const mm::Json& value) {
    bool denied = false;
    try { mmstoreguiissuer::validateReply(value, nonce, 1234, birth); }
    catch (const mmstore::Error& error) { denied = error.code() == mmstore::ErrorCode::processDenied; }
    check(denied);
  };
  for (const auto* key : {"version", "accepted", "nonce", "pid", "creation_time"}) {
    auto absent = valid.object(); absent.erase(key); rejected(absent);
    auto wrongType = valid.object(); wrongType[key] = nullptr; rejected(wrongType);
  }
  for (const auto& [key, value] : mm::Json::Object{{"version", 2}, {"accepted", false}, {"nonce", std::string(64, 'b')},
      {"pid", 1235}, {"creation_time", "1337133713371338"}}) {
    auto wrong = valid.object(); wrong[key] = value; rejected(wrong);
  }
  auto extra = valid.object(); extra["allowUnsigned"] = true; rejected(extra);
  rejected(nullptr); rejected(mm::Json::Array{});
}
#ifdef _WIN32
std::string manifest() {
  return R"xml(<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
 xmlns:d="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"
 xmlns:u="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
 xmlns:r="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
 <Properties><DisplayName>MusicMute</DisplayName><d:FileSystemWriteVirtualization>disabled</d:FileSystemWriteVirtualization>
 <d:RegistryWriteVirtualization>disabled</d:RegistryWriteVirtualization></Properties>
 <Applications><Application Id="MusicMute" Executable="app\MusicMute Local.exe" u:RuntimeBehavior="win32App" u:TrustLevel="mediumIL" /></Applications>
 <Capabilities><r:Capability Name="runFullTrust"/><r:Capability Name="unvirtualizedResources"/></Capabilities>
</Package>)xml";
}
std::string replace(std::string source, const std::string& from, const std::string& to) {
  const auto found = source.find(from); check(found != std::string::npos); source.replace(found, from.size(), to); return source;
}
void validate(const std::string& xml) {
  mmstorenamespace::validateManifestBytes(reinterpret_cast<const std::byte*>(xml.data()), xml.size());
}
void denied(const std::function<void()>& operation) {
  bool rejected = false;
  try { operation(); } catch (const mmstore::Error& error) { rejected = error.code() == mmstore::ErrorCode::packageDenied; }
  check(rejected);
}
void xmlPolicy() {
  static_assert(!std::is_default_constructible_v<mmstorenamespace::PrivateNamespaceAuthority>);
  static_assert(!std::is_copy_constructible_v<mmstorenamespace::PrivateNamespaceAuthority>);
  const auto xml = manifest(); validate(xml); ++checks;
  validate(replace(xml, "u:TrustLevel=\"mediumIL\" />", "u:TrustLevel=\"mediumIL\"></Application>")); ++checks;
  validate(replace(xml, ">disabled</d:FileSystem", "> \r\n disabled \t</d:FileSystem")); ++checks;
  validate(replace(xml, "MusicMute</DisplayName>", "MusicMute &#x645;</DisplayName>")); ++checks;
  const std::array invalid{
    replace(xml, "disabled</d:FileSystem", "enabled</d:FileSystem"),
    replace(xml, "disabled</d:Registry", "enabled</d:Registry"),
    replace(xml, "disabled</d:Registry", "disabled extra</d:Registry"),
    replace(xml, "disabled</d:Registry", "dis<Extra/>abled</d:Registry"),
    replace(xml, "disabled</d:Registry", "<![CDATA[disabled]]></d:Registry"),
    replace(xml, "<d:RegistryWriteVirtualization>disabled</d:RegistryWriteVirtualization>", "<d:RegistryWriteVirtualization/>"),
    replace(xml, "<d:FileSystemWriteVirtualization>disabled</d:FileSystemWriteVirtualization>", ""),
    replace(xml, "</Properties>", "<d:FileSystemWriteVirtualization>disabled</d:FileSystemWriteVirtualization></Properties>"),
    replace(xml, "xmlns:d=\"http://schemas.microsoft.com/appx/manifest/desktop/windows10/6\"", "xmlns:d=\"urn:foreign\""),
    replace(xml, "<Properties>", "<Properties xmlns=\"urn:foreign\">"),
    replace(xml, "<Properties>", "<Extra><Properties>").append("</Extra>"),
    replace(xml, "Name=\"unvirtualizedResources\"", "Name=\"runFullTrust\""),
    replace(xml, "<r:Capability Name=\"unvirtualizedResources\"/>", ""),
    replace(xml, "xmlns:r=\"http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities\"", "xmlns:r=\"urn:foreign\""),
    replace(xml, "</Capabilities>", "<r:Capability Name=\"unvirtualizedResources\"/></Capabilities>"),
    replace(xml, "<Capabilities>", "<Extra><Capabilities>"),
    replace(xml, "u:RuntimeBehavior=\"win32App\"", "u:RuntimeBehavior=\"packagedClassicApp\""),
    replace(xml, "u:TrustLevel=\"mediumIL\"", "u:TrustLevel=\"appContainer\""),
    replace(xml, "Id=\"MusicMute\"", "Id=\"MusicMute\" EntryPoint=\"Windows.FullTrustApplication\""),
    replace(xml, "<Applications>", "<Applications xmlns=\"urn:foreign\">"),
    replace(xml, "<Package xmlns=", "<!DOCTYPE Package [<!ENTITY hostile SYSTEM 'file:///C:/outside'>]><Package xmlns="),
    xml.substr(0, xml.size() - 5),
    std::string("<!--") + xml + "--><Package/>",
    std::string("<Package/>") + xml,
  };
  for (const auto& bad : invalid) denied([&] { validate(bad); });
  denied([] { mmstorenamespace::validateManifestBytes(nullptr, 0); });
  const std::string excessive(256 * 1024 + 1, ' ');
  denied([&] { validate(excessive); });
  auto nested = xml;
  for (unsigned n = 0; n < 33; ++n) nested = "<X>" + nested + "</X>";
  denied([&] { validate(nested); });
}
void xmlLiteDepthPolicy() {
  // Actual Win32 XmlLite behavior, independent of our manifest parser. End
  // nodes report pre-pop depth; .NET-style same-depth assumptions are wrong.
  constexpr char source[] = "<Parent><Child></Child></Parent>";
  winrt::com_ptr<IStream> stream;
  stream.attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(source), static_cast<UINT>(sizeof(source) - 1)));
  check(static_cast<bool>(stream));
  winrt::com_ptr<IXmlReader> reader;
  check(SUCCEEDED(CreateXmlReader(__uuidof(IXmlReader), reader.put_void(), nullptr)) && SUCCEEDED(reader->SetInput(stream.get())));
  const std::array expected{std::pair{XmlNodeType_Element, 0U}, std::pair{XmlNodeType_Element, 1U},
    std::pair{XmlNodeType_EndElement, 2U}, std::pair{XmlNodeType_EndElement, 1U}};
  for (const auto& [type, depth] : expected) {
    XmlNodeType node{}; UINT actual = 0;
    check(reader->Read(&node) == S_OK && node == type && reader->GetDepth(&actual) == S_OK && actual == depth);
  }
  XmlNodeType node{}; check(reader->Read(&node) == S_FALSE);
}
#endif
}
int main() {
  try {
    operationPolicy();
    issuerPolicy();
#ifdef _WIN32
    xmlLiteDepthPolicy();
    xmlPolicy();
#endif
    std::cout << "Store namespace checks passed: " << checks << '\n'; return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
