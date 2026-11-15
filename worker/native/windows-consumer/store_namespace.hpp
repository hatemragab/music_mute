#pragma once
#include "store_authority.hpp"
#include <array>
#include <string_view>

#ifdef _WIN32
#include <xmllite.h>
#include <shlwapi.h>
#endif

namespace mmstorenamespace {
// Shared data primitives retain their existing private-handle/owner/link/birth
// checks. This list grants no launch, registry registration, peer, updater,
// release-root or role/GPU ownership authority. Closed data-retirement commands
// retain their own mutex, durable intent, birth and held-object checks.
inline bool guiDataOperation(std::string_view operation) noexcept {
  static constexpr std::array operations{
    "identity", "boot_identity", "process_identity", "ensure_private_directory",
    "validate_path", "private_file_open", "private_file_info", "private_file_read",
    "private_file_write", "private_file_truncate", "private_file_sync", "private_file_close",
    "vault_put", "vault_get", "vault_delete", "vault_recover", "acquire_mutex",
    "release_mutex", "gpu_inventory", "singleton_inspect", "cache_delete_begin", "cache_delete_commit",
    "cache_delete_release", "cache_delete_recover", "share_workspace_discard",
    "diagnostic_report_remove", "personal_cleanup_recover", "storage_partial_discard",
    "library_artifact_discard", "library_tree_discard", "library_tree_cleanup_ack",
    "library_tree_cleanup_list", "library_local_move", "library_artifact_publish",
    "library_artifact_publication_inspect", "store_cpu_operation_cleanup_inspect", "store_cpu_workspace_marker_retire", "store_cpu_workspace_marker_acknowledge", "store_cpu_workspace_marker_release", "storage_workspace_marker_retire",
    "storage_cleanup_ack", "storage_cleanup_recover"
  };
  return std::find(operations.begin(), operations.end(), operation) != operations.end();
}

#ifdef _WIN32
inline constexpr std::wstring_view foundation = L"http://schemas.microsoft.com/appx/manifest/foundation/windows10";
inline constexpr std::wstring_view desktop6 = L"http://schemas.microsoft.com/appx/manifest/desktop/windows10/6";
inline constexpr std::wstring_view uap10 = L"http://schemas.microsoft.com/appx/manifest/uap/windows10/10";
inline constexpr std::wstring_view restricted = L"http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities";

// Parse the complete, bounded deployment manifest with the project's existing
// XmlLite approach. This validation function alone is not OS/package authority.
inline void validateManifestBytes(const std::byte* bytes, std::size_t size) {
  using mmstore::require;
  constexpr auto error = mmstore::ErrorCode::packageDenied;
  require(bytes && size > 0 && size <= 256 * 1024, error);
  winrt::com_ptr<IStream> stream;
  stream.attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(bytes), static_cast<UINT>(size)));
  require(static_cast<bool>(stream), error);
  winrt::com_ptr<IXmlReader> reader;
  require(SUCCEEDED(CreateXmlReader(__uuidof(IXmlReader), reader.put_void(), nullptr)) &&
    SUCCEEDED(reader->SetProperty(XmlReaderProperty_DtdProcessing, DtdProcessing_Prohibit)) &&
    SUCCEEDED(reader->SetProperty(XmlReaderProperty_MaxElementDepth, 32)) &&
    SUCCEEDED(reader->SetInput(stream.get())), error);
  enum class Scope { none, properties, capabilities, applications };
  Scope scope = Scope::none;
  unsigned roots = 0, properties = 0, capabilities = 0, applications = 0;
  unsigned files = 0, registry = 0, unvirtualized = 0, fullTrust = 0, appCount = 0, nodes = 0;
  std::wstring captureName, captureValue;
  const auto attributeEquals = [&](const wchar_t* name, const wchar_t* space, std::wstring_view expected) {
    require(reader->MoveToAttributeByName(name, space) == S_OK, error);
    const wchar_t* value = nullptr; UINT length = 0;
    require(SUCCEEDED(reader->GetValue(&value, &length)) && value && std::wstring_view(value, length) == expected, error);
    require(SUCCEEDED(reader->MoveToElement()), error);
  };
  XmlNodeType node{}; HRESULT result = S_OK;
  while ((result = reader->Read(&node)) == S_OK) {
    require(++nodes <= 8192, error);
    UINT depth = 0; require(SUCCEEDED(reader->GetDepth(&depth)) && depth <= 32, error);
    if (node == XmlNodeType_Element || node == XmlNodeType_EndElement) {
      // XmlLite reports the depth BEFORE processing an end node: a child
      // start is 1, its end is 2. Normalize to the owning element's depth.
      // https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms752815(v=vs.85)
      if (node == XmlNodeType_EndElement) { require(depth > 0, error); --depth; }
      const wchar_t* name = nullptr; const wchar_t* space = nullptr; UINT nameLength = 0, spaceLength = 0;
      require(SUCCEEDED(reader->GetLocalName(&name, &nameLength)) && name && nameLength <= 256 &&
        SUCCEEDED(reader->GetNamespaceUri(&space, &spaceLength)) && spaceLength <= 512, error);
      // Attribute navigation can reuse the reader's string buffers. Preserve
      // these names before MoveToAttributeByName/MoveToElement invalidates them.
      const std::wstring local(name, nameLength), ns(space ? space : L"", spaceLength);
      if (node == XmlNodeType_EndElement) {
        if (!captureName.empty()) {
          require(depth == 2 && ns == desktop6 && local == captureName, error);
          const auto first = captureValue.find_first_not_of(L" \t\r\n");
          const auto last = captureValue.find_last_not_of(L" \t\r\n");
          require(first != std::wstring::npos && captureValue.substr(first, last - first + 1) == L"disabled", error);
          captureName.clear(); captureValue.clear();
        }
        if (depth == 1) scope = Scope::none;
        continue;
      }
      require(captureName.empty(), error);
      if (depth == 0) require(ns == foundation && local == L"Package" && ++roots == 1, error);
      if (depth == 1 && ns == foundation) {
        if (local == L"Properties") { require(++properties == 1, error); scope = Scope::properties; }
        else if (local == L"Capabilities") { require(++capabilities == 1, error); scope = Scope::capabilities; }
        else if (local == L"Applications") { require(++applications == 1, error); scope = Scope::applications; }
        else scope = Scope::none;
      }
      if (ns == desktop6 && (local == L"FileSystemWriteVirtualization" || local == L"RegistryWriteVirtualization")) {
        require(depth == 2 && scope == Scope::properties && !reader->IsEmptyElement(), error);
        if (local == L"FileSystemWriteVirtualization") require(++files == 1, error);
        else require(++registry == 1, error);
        captureName = local;
      }
      if (ns == restricted && local == L"Capability") {
        require(depth == 2 && scope == Scope::capabilities, error);
        require(reader->MoveToAttributeByName(L"Name", nullptr) == S_OK, error);
        const wchar_t* value = nullptr; UINT length = 0;
        require(SUCCEEDED(reader->GetValue(&value, &length)) && value && length <= 256, error);
        const std::wstring_view capability(value, length);
        if (capability == L"unvirtualizedResources") require(++unvirtualized == 1, error);
        if (capability == L"runFullTrust") require(++fullTrust == 1, error);
        require(SUCCEEDED(reader->MoveToElement()), error);
      }
      if (ns == foundation && local == L"Application") {
        require(depth == 2 && scope == Scope::applications && ++appCount <= 32, error);
        attributeEquals(L"RuntimeBehavior", uap10.data(), L"win32App");
        attributeEquals(L"TrustLevel", uap10.data(), L"mediumIL");
        require(reader->MoveToAttributeByName(L"EntryPoint", nullptr) == S_FALSE, error);
        require(SUCCEEDED(reader->MoveToElement()), error);
      }
      if (depth == 1 && reader->IsEmptyElement()) scope = Scope::none;
    } else if (!captureName.empty()) {
      require(node == XmlNodeType_Text || node == XmlNodeType_Whitespace, error);
      const wchar_t* value = nullptr; UINT length = 0;
      require(SUCCEEDED(reader->GetValue(&value, &length)) && value && captureValue.size() + length <= 32, error);
      captureValue.append(value, length);
    }
  }
  require(result == S_FALSE && roots == 1 && properties == 1 && capabilities == 1 && applications == 1 &&
    files == 1 && registry == 1 && unvirtualized == 1 && fullTrust == 1 && appCount > 0 && captureName.empty(), error);
}

class PrivateNamespaceAuthority {
 public:
  PrivateNamespaceAuthority(PrivateNamespaceAuthority&&) noexcept = default;
  PrivateNamespaceAuthority& operator=(PrivateNamespaceAuthority&&) noexcept = default;
  PrivateNamespaceAuthority(const PrivateNamespaceAuthority&) = delete;
  PrivateNamespaceAuthority& operator=(const PrivateNamespaceAuthority&) = delete;
  static PrivateNamespaceAuthority open(const mmstore::RegisteredPackage& package) {
    auto manifest = package.openManifest();
    const auto bytes = manifest.read(256 * 1024);
    validateManifestBytes(bytes.data(), bytes.size());
    manifest.revalidate(); package.revalidate();
    return PrivateNamespaceAuthority(std::move(manifest));
  }
  void revalidate() const { manifest_.revalidate(); }
 private:
  explicit PrivateNamespaceAuthority(mmstore::ImmutableFile manifest) : manifest_(std::move(manifest)) {}
  mmstore::ImmutableFile manifest_;
};
#endif
} // namespace mmstorenamespace
