#pragma once
#include "manifest.hpp"

void assertSignedPeArchitecture(HANDLE locked,bool installerBootstrapper) {
  LARGE_INTEGER zero{},original{},size{};
  check(SetFilePointerEx(locked,zero,&original,FILE_CURRENT)&&GetFileSizeEx(locked,&size),"HELPER_INTEGRITY_INVALID");
  struct Position{HANDLE file;LARGE_INTEGER value;~Position(){(void)SetFilePointerEx(file,value,nullptr,FILE_BEGIN);}} position{locked,original};
  BYTE dos[64]{};DWORD read=0;check(SetFilePointerEx(locked,zero,nullptr,FILE_BEGIN)&&ReadFile(locked,dos,64,&read,nullptr)&&read==64,"HELPER_INTEGRITY_INVALID");
  if(dos[0]!='M'||dos[1]!='Z')fail("HELPER_INTEGRITY_INVALID");DWORD offset=0;std::memcpy(&offset,dos+60,4);
  if(offset<64||offset>1048576||static_cast<std::int64_t>(offset)+26>size.QuadPart)fail("HELPER_INTEGRITY_INVALID");
  LARGE_INTEGER at{};at.QuadPart=offset;BYTE pe[26]{};check(SetFilePointerEx(locked,at,nullptr,FILE_BEGIN)&&ReadFile(locked,pe,26,&read,nullptr)&&read==26,"HELPER_INTEGRITY_INVALID");
  WORD machine=0,magic=0;std::memcpy(&machine,pe+4,2);std::memcpy(&magic,pe+24,2);
  if(pe[0]!='P'||pe[1]!='E'||pe[2]!=0||pe[3]!=0||!((machine==IMAGE_FILE_MACHINE_AMD64&&magic==IMAGE_NT_OPTIONAL_HDR64_MAGIC)||(installerBootstrapper&&machine==IMAGE_FILE_MACHINE_I386&&magic==IMAGE_NT_OPTIONAL_HDR32_MAGIC)))fail("HELPER_INTEGRITY_INVALID");
}
enum class PeTrustPolicy { FreshApproval, ApprovedInstalledCache };
DWORD peTrustFlags(PeTrustPolicy policy) {
  const DWORD required=WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT|WTD_DISABLE_MD2_MD4;
  // Cache-only controls network retrieval, never skips revocation or treats an
  // unavailable/stale cache as success. New artifact approval keeps retrieval.
  return required|(policy==PeTrustPolicy::ApprovedInstalledCache?WTD_CACHE_ONLY_URL_RETRIEVAL:0);
}
std::string trustedPePublisher(const std::wstring& path,HANDLE locked,bool installerBootstrapper,PeTrustPolicy trustPolicy,const wchar_t* requiredOrganization=nullptr) {
  assertSignedPeArchitecture(locked,installerBootstrapper);
  WINTRUST_FILE_INFO file{};file.cbStruct=sizeof(file);file.pcwszFilePath=path.c_str();file.hFile=locked;
  WINTRUST_DATA trust{};trust.cbStruct=sizeof(trust);trust.dwUIChoice=WTD_UI_NONE;trust.fdwRevocationChecks=WTD_REVOKE_WHOLECHAIN;trust.dwUnionChoice=WTD_CHOICE_FILE;trust.pFile=&file;trust.dwStateAction=WTD_STATEACTION_VERIFY;trust.dwProvFlags=peTrustFlags(trustPolicy);
  GUID policy=WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const auto result=WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE),&policy,&trust);
  struct State{GUID& policy;WINTRUST_DATA& trust;~State(){trust.dwStateAction=WTD_STATEACTION_CLOSE;(void)WinVerifyTrust(reinterpret_cast<HWND>(INVALID_HANDLE_VALUE),&policy,&trust);}} close{policy,trust};
  if(result!=ERROR_SUCCESS)fail("HELPER_INTEGRITY_INVALID");
  const auto provider=WTHelperProvDataFromStateData(trust.hWVTStateData);if(!provider)fail("HELPER_INTEGRITY_INVALID");const auto signer=WTHelperGetProvSignerFromChain(provider,0,FALSE,0);if(!signer)fail("HELPER_INTEGRITY_INVALID");const auto leaf=WTHelperGetProvCertFromChain(signer,0);if(!leaf||!leaf->pCert)fail("HELPER_INTEGRITY_INVALID");
  if(requiredOrganization){wchar_t organization[256]{};const auto count=CertGetNameStringW(leaf->pCert,CERT_NAME_ATTR_TYPE,0,const_cast<char*>(szOID_ORGANIZATION_NAME),organization,256);if(count<2||count>256||wcscmp(organization,requiredOrganization)!=0)fail("HELPER_INTEGRITY_INVALID");}
  BYTE hash[32]{};DWORD size=32;check(CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM,0,nullptr,leaf->pCert->pbCertEncoded,leaf->pCert->cbCertEncoded,hash,&size)&&size==32,"HELPER_INTEGRITY_INVALID");
  constexpr char digits[]="0123456789abcdef";std::string actual;for(const auto byte:hash){actual+=digits[byte>>4];actual+=digits[byte&15];}
  // Resource-only loading never executes an untrusted DLL entry point.
  const auto module=LoadLibraryExW(path.c_str(),nullptr,LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE|LOAD_LIBRARY_AS_IMAGE_RESOURCE);if(!module)fail("HELPER_INTEGRITY_INVALID");
  try {const auto resource=FindResourceW(module,MAKEINTRESOURCEW(1),RT_MANIFEST);if(!resource)fail("HELPER_INTEGRITY_INVALID");const auto count=SizeofResource(module,resource);const auto loaded=LoadResource(module,resource);const auto bytes=static_cast<const BYTE*>(LockResource(loaded));
    assertAsInvokerManifest(bytes,count);
  }catch(...){FreeLibrary(module);throw;}FreeLibrary(module);return actual;
}
void verifyInstallerPublisher(const std::wstring& path,HANDLE locked,const std::string& publisher,bool installerBootstrapper=false,PeTrustPolicy trustPolicy=PeTrustPolicy::FreshApproval) {
  if(publisher.size()!=64||publisher.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");
  if(trustedPePublisher(path,locked,installerBootstrapper,trustPolicy)!=publisher)fail("HELPER_INTEGRITY_INVALID");
}
#include "installer_launch.hpp"
Json installerOperation(const Json& args,bool launch) {
  const auto id=args.at("identity").string();if(id.size()!=64||id.find_first_not_of("0123456789abcdef")!=std::string::npos)fail("BAD_REQUEST");
  const auto path=rootPath("personal")+L"\\updates\\staging\\"+wide(id)+L"\\installer.exe";auto ancestors=lockAncestors(path,false,false,rootPath("personal"));auto executable=lockHashedFile(path,args.at("sha256").string(),false,2ULL*1024*1024*1024);LARGE_INTEGER size{};check(GetFileSizeEx(executable.value,&size),"HELPER_INTEGRITY_INVALID");if(size.QuadPart!=args.at("bytes").integer()||size.QuadPart<1||size.QuadPart>2LL*1024*1024*1024)fail("HELPER_INTEGRITY_INVALID");
  verifyInstallerPublisher(path,executable.value,args.at("publisher_sha256").string(),true);if(!launch)return Json::Object{{"verified",true}};
  return launchInstallerCertified(args);
}
