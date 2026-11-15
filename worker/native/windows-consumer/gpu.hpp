#pragma once

template <typename T> struct ComHandle {
  T* value = nullptr;
  ~ComHandle() { if (value) value->Release(); }
};
Json::Array gpuInventory() {
  ComHandle<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory.value)))) fail("GPU_INVENTORY_UNAVAILABLE");
  Json::Array result;
  for (UINT index = 0; index < 16; ++index) {
    ComHandle<IDXGIAdapter1> adapter;
    const auto enumerated = factory.value->EnumAdapters1(index, &adapter.value);
    if (enumerated == DXGI_ERROR_NOT_FOUND) break;
    if (FAILED(enumerated)) fail("GPU_INVENTORY_UNAVAILABLE");
    DXGI_ADAPTER_DESC1 descriptor{};
    if (FAILED(adapter.value->GetDesc1(&descriptor))) fail("GPU_INVENTORY_UNAVAILABLE");
    if (descriptor.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
    if (FAILED(D3D12CreateDevice(adapter.value, D3D_FEATURE_LEVEL_11_0, __uuidof(ID3D12Device), nullptr))) continue;
    LARGE_INTEGER version{};
    if (FAILED(adapter.value->CheckInterfaceSupport(__uuidof(IDXGIDevice), &version))) fail("GPU_INVENTORY_UNAVAILABLE");
    const auto driver = static_cast<std::uint64_t>(version.QuadPart);
    const auto driverText = std::to_string((driver >> 48) & 0xffff) + "." + std::to_string((driver >> 32) & 0xffff) + "." + std::to_string((driver >> 16) & 0xffff) + "." + std::to_string(driver & 0xffff);
    std::ostringstream luid;
    luid << std::hex << std::setfill('0') << std::setw(8) << static_cast<std::uint32_t>(descriptor.AdapterLuid.HighPart) << std::setw(8) << descriptor.AdapterLuid.LowPart;
    if (descriptor.DedicatedVideoMemory > 9007199254740991ULL || descriptor.SharedSystemMemory > 9007199254740991ULL) fail("GPU_INVENTORY_UNAVAILABLE");
    result.emplace_back(Json::Object{{"source", "DXGI EnumAdapters1/GetDesc1"}, {"deviceIndex", static_cast<std::int64_t>(index)}, {"name", utf8(descriptor.Description)}, {"vendorId", static_cast<std::int64_t>(descriptor.VendorId)}, {"deviceId", static_cast<std::int64_t>(descriptor.DeviceId)}, {"subsystemId", static_cast<std::int64_t>(descriptor.SubSysId)}, {"revision", static_cast<std::int64_t>(descriptor.Revision)}, {"driverVersion", driverText}, {"luid", luid.str()}, {"dedicatedVideoMemoryBytes", static_cast<std::int64_t>(descriptor.DedicatedVideoMemory)}, {"sharedSystemMemoryLimitBytes", static_cast<std::int64_t>(descriptor.SharedSystemMemory)}});
  }
  return result;
}
struct OwnedGpuGuard { Handle keeper; Handle release; Handle job; std::string nonce; Json identity; Json gpu; bool roleBound = false; bool abandoned = false; bool storeProxy = false; std::optional<mmstore::AttestedProcess> storeKeeper; };
std::map<std::string, OwnedGpuGuard> gpuGuards;
struct BoundGpuRole { Handle job; Handle process; Handle rootController; Json owner; };
std::unique_ptr<BoundGpuRole> boundGpuRole;
Json bindRoleJob(const Json& args) {
  if(boundGpuRole || !gpuGuards.empty()) fail("JOB_BUSY");
  const auto& owner=args.at("owner"); keys(owner,{"role","nonce","identity"});
  const auto role=owner.at("role").string(); if(role!="personal"&&role!="fleet")fail("BAD_REQUEST");
  const auto binding=parentBinding(processIdentity(GetCurrentProcessId()));
  if(mm::dump(binding.parent)!=mm::dump(owner.at("identity")))fail("JOB_NOT_OWNED");
  auto result=std::make_unique<BoundGpuRole>();
  result->job=Handle(OpenJobObjectW(JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE,FALSE,roleJobName(role,owner.at("nonce").string()).c_str()));
  if(!result->job.valid())fail("JOB_NOT_OWNED"); assertPrivateMutex(result->job.value);
  result->process=Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(owner.at("identity").at("pid").integer())));
  if(!result->process.valid()||creation(result->process.value)!=owner.at("identity").at("creation_time").string())fail("JOB_NOT_OWNED");
  BOOL child=FALSE,self=FALSE;check(IsProcessInJob(result->process.value,result->job.value,&child)&&child,"JOB_NOT_OWNED");check(IsProcessInJob(GetCurrentProcess(),result->job.value,&self)&&self,"JOB_NOT_OWNED");
  const auto protectedRecord=vault("vault_get",Json::Object{{"namespace","fleet"},{"key",ownershipRecordKey(owner)}});
  if(std::holds_alternative<std::nullptr_t>(protectedRecord.value))fail("JOB_NOT_OWNED");
  auto bytes=base64Decode(protectedRecord.at("bytes_base64").string(),4096);const auto record=mm::JsonParser(std::string(reinterpret_cast<const char*>(bytes.data()),bytes.size())).parse();SecureZeroMemory(bytes.data(),bytes.size());
  keys(record,{"version","owner","controller","guardian"});if(record.at("version").integer()!=1||mm::dump(record.at("owner"))!=mm::dump(owner))fail("JOB_NOT_OWNED");
  const auto& creator=record.at("controller");if(mm::dump(processIdentity(static_cast<DWORD>(creator.at("pid").integer())))!=mm::dump(creator))fail("JOB_NOT_OWNED");
  result->rootController=Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,static_cast<DWORD>(creator.at("pid").integer())));
  if(!result->rootController.valid()||creation(result->rootController.value)!=creator.at("creation_time").string())fail("JOB_NOT_OWNED");
  result->owner=owner;boundGpuRole=std::move(result);return Json::Object{{"bound",true}};
}
bool safePublicGpuMutex(HANDLE mutex) {
  PSID owner = nullptr; PACL acl = nullptr; PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (GetSecurityInfo(mutex, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
  LocalMemory memory{descriptor};
  if (!owner || !acl || acl->AceCount != 2) return false;
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision = 0;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) || !(control & SE_DACL_PROTECTED)) return false;
  const auto ownerSid = sidString(owner);
  if (ownerSid.rfind("S-1-5-21-", 0) != 0 && ownerSid.rfind("S-1-12-1-", 0) != 0 && ownerSid != "S-1-5-18") return false;
  bool authenticated = false, system = false;
  for (DWORD n = 0; n < acl->AceCount; ++n) {
    void* entry = nullptr; if (!GetAce(acl, n, &entry)) return false;
    const auto* header = static_cast<const ACE_HEADER*>(entry);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceFlags != 0) return false;
    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(entry);
    const auto sid = sidString(const_cast<DWORD*>(&ace->SidStart));
    if (sid == "S-1-5-11" && ace->Mask == 0x00120001 && !authenticated) authenticated = true;
    else if (sid == "S-1-5-18" && ace->Mask == 0x001f0001 && !system) system = true;
    else return false;
  }
  return authenticated && system;
}
#include "gpu_keeper.hpp"
void attachPreparingGpuJobs(HANDLE process) {
  for(const auto& [luid,guard]:gpuGuards){(void)luid;if(!guard.roleBound)check(AssignProcessToJobObject(guard.job.value,process),"GPU_GUARD_UNSAFE");}
}
Json acquireGpuGuard(const Json& args) {
  const auto luid = args.at("luid").string();
  if (luid.size() != 16 || luid.find_first_not_of("0123456789abcdef") != std::string::npos) fail("BAD_REQUEST");
  if (gpuGuards.contains(luid)) fail("BAD_REQUEST");
  Json selected;
  for (const auto& gpu : gpuInventory()) if (gpu.at("luid").string() == luid) { selected = gpu; break; }
  if (std::holds_alternative<std::nullptr_t>(selected.value)) fail("GPU_INVENTORY_UNAVAILABLE");
  OwnedGpuGuard guard;guard.nonce=randomHex();guard.identity=processIdentity(GetCurrentProcessId());guard.gpu=selected;guard.roleBound=boundGpuRole!=nullptr;
  if(boundGpuRole)guard.job=inheritedCopy(boundGpuRole->job.value,0,true);
  else {guard.job=Handle(CreateJobObjectW(nullptr,nullptr));if(!guard.job.valid())fail("GPU_GUARD_UNSAFE");JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;check(SetInformationJobObject(guard.job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"GPU_GUARD_UNSAFE");}
  guard.release=Handle(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!guard.release.valid())fail("GPU_GUARD_UNSAFE");
  if(!startIndependentGpuKeeper(guard,luid))return Json::Object{{"acquired",false}};
  const auto result = Json::Object{{"acquired", true}, {"luid", luid}, {"nonce", guard.nonce}, {"identity", guard.identity}, {"gpu", guard.gpu}, {"abandoned", guard.abandoned}};
  gpuGuards.emplace(luid, std::move(guard));
  return result;
}
Json releaseGpuGuard(const Json& args) {
  const auto item = gpuGuards.find(args.at("luid").string());
  if (item == gpuGuards.end() || !equalSecret(item->second.nonce, args.at("nonce").string()) || mm::dump(item->second.identity) != mm::dump(args.at("identity"))) fail("PEER_DENIED");
  if(item->second.storeProxy)fail("PEER_DENIED");
  // If this guardian owns processing trees, caller must finish their cleanup
  // before surrendering the physical GPU. A successful root PID wait alone
  // does not establish descendant exit.
  for (const auto& [role, job] : jobs) {
    (void)role;
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    check(QueryInformationJobObject(job.job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "GPU_GUARD_UNSAFE");
    if (accounting.ActiveProcesses != 0) fail("GPU_GUARD_UNSAFE");
  }
  if(item->second.roleBound){if(!boundGpuRole||!gpuRoleIdle(item->second.job.value,boundGpuRole->owner))fail("GPU_GUARD_UNSAFE");}
  else {JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};check(QueryInformationJobObject(item->second.job.value,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr),"GPU_GUARD_UNSAFE");if(info.ActiveProcesses!=0)fail("GPU_GUARD_UNSAFE");}
  check(SetEvent(item->second.release.value),"GPU_GUARD_UNSAFE");
  if(WaitForSingleObject(item->second.keeper.value,10000)!=WAIT_OBJECT_0)fail("GPU_GUARD_UNSAFE");
  DWORD exit=2;check(GetExitCodeProcess(item->second.keeper.value,&exit),"GPU_GUARD_UNSAFE");if(exit!=0)fail("GPU_GUARD_UNSAFE");
  gpuGuards.erase(item);
  return Json::Object{{"released", true}};
}
