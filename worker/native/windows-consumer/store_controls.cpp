// Independent, visible Microsoft Store Worker startup controls. This program
// controls only the package's StartupTask; it never claims processing readiness
// or creates Prepare, session, fleet, personal, or retained launcher state.
#include "store_controls_policy.hpp"
#include "store_inventory.hpp"
#include "store_diagnostics.hpp"
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>

#ifdef _WIN32
namespace {
using mmstore::detail::Handle;
using Intent = mmstorestartup::Intent;
using State = mmstorestartup::State;
constexpr UINT finishedMessage = WM_APP + 17;
constexpr int enableId = 101, disableId = 102, inspectId = 103, closeId = 104;
void require(bool value) { mmstore::require(value, mmstore::ErrorCode::processDenied); }
mmstorecontrols::WireProcess wire(const mmstore::ProcessIdentity& identity) {
  return {mmstorecontrols::ascii(identity.sid), mmstorecontrols::ascii(identity.creationTime), identity.sessionId, identity.pid};
}
struct Authority {
  mmstore::RegisteredPackage package;
  mmstore::ImmutableFile inventoryFile, nativeFile;
  mmstore::AttestedProcess self;
  mmstore::FilePin nativePin;
  static std::shared_ptr<Authority> open() {
    auto package = mmstore::resolveRegisteredPackage(mmstore::PackageKind::worker);
    auto inventoryFile = package.openInventory();
    const auto bytes = inventoryFile.read(8 * 1024 * 1024);
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const auto inventory = mmstoreinventory::parse(mmstore::PackageKind::worker, mm::JsonParser::storeCodeInventory(text));
    const auto actual = mmstore::parseVersion(package.observation().packageVersion);
    const auto sealed = mmstore::parseVersion(inventory.packageVersion);
    require(actual[0] == sealed[0] && actual[1] == sealed[1] && actual[2] == sealed[2]);
    auto self = mmstore::attestProcess(GetCurrentProcessId(), mmstore::CodeRole::workerControls,
      mmstoreinventory::codePin(inventory, mmstore::CodeRole::workerControls));
    auto nativePin = mmstoreinventory::codePin(inventory, mmstore::CodeRole::workerNative);
    auto nativeFile = package.openCode(mmstore::CodeRole::workerNative, nativePin);
    require(self.observation().fullName == package.observation().fullName && mmstore::currentPackageFullName() == package.observation().fullName);
    auto result = std::make_shared<Authority>(Authority{std::move(package), std::move(inventoryFile), std::move(nativeFile), std::move(self), std::move(nativePin)});
    result->revalidate(); return result;
  }
  void revalidate() const {
    package.revalidate(); inventoryFile.revalidate(); nativeFile.revalidate(); self.revalidate();
    require(mmstore::currentPackageFullName() == package.observation().fullName && self.observation().fullName == package.observation().fullName);
  }
};
std::wstring environment(const std::wstring& executable) {
  // Actual Windows directory and held package paths only. No ambient COMSPEC,
  // startup injection, renderer arguments, runtime lookup or shell is inherited.
  std::vector<wchar_t> buffer(32768); const auto length = GetWindowsDirectoryW(buffer.data(), static_cast<UINT>(buffer.size()));
  require(length > 0 && length < buffer.size()); const std::wstring windows(buffer.data(), length);
  require(mmstore::validInstalledLocation(windows));
  std::wstring result;
  for (const auto& pair : std::array<std::pair<std::wstring, std::wstring>, 3>{{
    {L"PATH", executable.substr(0, executable.find_last_of(L'\\')) + L";" + windows + L"\\System32"},
    {L"SystemRoot", windows}, {L"WINDIR", windows}}}) {
    result += pair.first; result += L'='; result += pair.second; result += L'\0';
  }
  result += L'\0'; require(result.size() <= 32767); return result;
}
class Helper {
 public:
  Helper(std::shared_ptr<Authority> authority, const std::atomic<bool>& cancelled)
    : authority_(std::move(authority)), cancelled_(cancelled) {}
  ~Helper() { if (!retired_) (void)shutdown(); }
  Helper(const Helper&) = delete;
  Helper& operator=(const Helper&) = delete;
  void start() {
    stage(mmstorediagnostic::Phase::authority);
    authority_->revalidate(); require(!cancelled_.load());
    const auto sid = authority_->self.identity().sid;
    const auto sddl = L"O:" + sid + L"D:P(A;;GA;;;" + sid + L")(A;;GA;;;SY)";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE);
    mmstore::detail::Local descriptorLifetime{descriptor};
    SECURITY_ATTRIBUTES jobSecurity{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
    stage(mmstorediagnostic::Phase::jobCreate);
    job_ = Handle(CreateJobObjectW(&jobSecurity, nullptr)); require(job_.valid());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    stage(mmstorediagnostic::Phase::jobLimits);
    require(SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE);
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE inputRead = nullptr, inputWrite = nullptr, outputRead = nullptr, outputWrite = nullptr, errorRead = nullptr, errorWrite = nullptr;
    stage(mmstorediagnostic::Phase::pipeCreate);
    require(CreatePipe(&inputRead, &inputWrite, &security, 8192) != FALSE);
    Handle childInput(inputRead); input_ = Handle(inputWrite);
    require(CreatePipe(&outputRead, &outputWrite, &security, 8192) != FALSE);
    output_ = Handle(outputRead); Handle childOutput(outputWrite);
    require(CreatePipe(&errorRead, &errorWrite, &security, 8192) != FALSE);
    error_ = Handle(errorRead); Handle childError(errorWrite);
    stage(mmstorediagnostic::Phase::pipeFlags);
    for (const auto handle : {input_.get(), output_.get(), error_.get()}) require(SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) != FALSE);
    stage(mmstorediagnostic::Phase::attributeList);
    SIZE_T attributeSize = 0;
    (void)InitializeProcThreadAttributeList(nullptr, 2, 0, &attributeSize); require(attributeSize > 0);
    std::vector<BYTE> storage(attributeSize); auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(attributes, 2, 0, &attributeSize) != FALSE);
    DWORD desktopPolicy = 0;
    struct Attributes { LPPROC_THREAD_ATTRIBUTE_LIST value; ~Attributes() { DeleteProcThreadAttributeList(value); } } lifetime{attributes};
    HANDLE inherited[]{childInput.get(), childOutput.get(), childError.get()};
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) != FALSE);
    require(mmstoredesktop::apply(attributes, desktopPolicy));
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = childInput.get();
    startup.StartupInfo.hStdOutput = childOutput.get(); startup.StartupInfo.hStdError = childError.get();
    const auto executable = authority_->nativeFile.absolutePath();
    require(executable.find(L'"') == std::wstring::npos);
    auto command = L"\"" + executable + L"\" --store-stdio"; auto block = environment(executable);
    const auto directory = executable.substr(0, executable.find_last_of(L'\\'));
    PROCESS_INFORMATION launched{};
    stage(mmstorediagnostic::Phase::childCreate);
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
      block.data(), directory.c_str(), &startup.StartupInfo, &launched) != FALSE);
    process_ = Handle(launched.hProcess); Handle thread(launched.hThread);
    // start() is separate from construction: an assignment/attestation failure
    // still leaves this RAII instance responsible for its exact suspended child.
    stage(mmstorediagnostic::Phase::childAssign);
    require(AssignProcessToJobObject(job_.get(), process_.get()) != FALSE); assigned_ = true;
    stage(mmstorediagnostic::Phase::childAttest);
    child_ = std::make_unique<mmstore::AttestedProcess>(mmstore::attestProcess(launched.dwProcessId,
      mmstore::CodeRole::workerNative, authority_->nativePin));
    stage(mmstorediagnostic::Phase::childCheck);
    require(child_->observation().fullName == authority_->package.observation().fullName &&
      child_->identity().sid == authority_->self.identity().sid && child_->identity().logonSid == authority_->self.identity().logonSid &&
      child_->identity().sessionId == authority_->self.identity().sessionId &&
      mmstore::detail::parentPid(launched.dwProcessId) == GetCurrentProcessId() &&
      mmstore::detail::creation(authority_->self.handle()) <= mmstore::detail::creation(process_.get()));
    revalidate(); require(!cancelled_.load());
    stage(mmstorediagnostic::Phase::childResume);
    require(ResumeThread(thread.get()) != static_cast<DWORD>(-1));
  }
  void authenticate() {
    stage(mmstorediagnostic::Phase::storeBoot);
    const auto receipt = request("store_boot", mm::Json::Object{{"role", "worker"}, {"parent_role", "worker-controls"}});
    mmstorecontrols::boot(receipt, authority_->package.observation(), wire(authority_->self.identity()),
      wire(child_->identity()), mmstorecontrols::ascii(authority_->self.identity().logonSid));
    revalidate();
  }
  mmstorestartup::Result startup(Intent intent) {
    stage(mmstorediagnostic::Phase::storeStartup);
    const char* name = intent == Intent::inspect ? "inspect" : intent == Intent::requestEnable ? "request-enable" : "disable";
    const auto result = mmstorecontrols::startup(request("store_startup", mm::Json::Object{{"intent", name}}), intent);
    revalidate(); return result;
  }
  bool shutdown() noexcept {
    if (retired_) return true;
    stage(mmstorediagnostic::Phase::shutdownInput);
    input_ = Handle{};
    if (!process_.valid()) { retired_ = true; return true; }
    if (!assigned_) {
      stage(mmstorediagnostic::Phase::shutdownUnassigned);
      if (WaitForSingleObject(process_.get(), 0) != WAIT_OBJECT_0 && !TerminateProcess(process_.get(), 2)) return cleanupFailure();
      diagnostic_.wait = WaitForSingleObject(process_.get(), 5000);
      retired_ = diagnostic_.wait == WAIT_OBJECT_0; if (!retired_) return cleanupFailure(); return true;
    }
    stage(mmstorediagnostic::Phase::shutdownRoot);
    diagnostic_.wait = WaitForSingleObject(process_.get(), 500);
    if (diagnostic_.wait != WAIT_OBJECT_0) {
      stage(mmstorediagnostic::Phase::shutdownKill);
      if (!TerminateJobObject(job_.get(), 2)) return cleanupFailure();
    }
    const auto until = GetTickCount64() + 5000;
    do {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      struct Census { DWORD assigned, listed; ULONG_PTR pid[1]; } census{};
      stage(mmstorediagnostic::Phase::shutdownAccounting);
      if (!QueryInformationJobObject(job_.get(), JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return cleanupFailure();
      diagnostic_.active = accounting.ActiveProcesses;
      if (accounting.ActiveProcesses == 0) {
        stage(mmstorediagnostic::Phase::shutdownCensus);
        if (!QueryInformationJobObject(job_.get(), JobObjectBasicProcessIdList, &census, sizeof(census), nullptr)) return cleanupFailure();
        diagnostic_.assigned = census.assigned; diagnostic_.listed = census.listed;
        stage(mmstorediagnostic::Phase::shutdownConfirm);
        if (census.assigned != 0 || census.listed != 0 || WaitForSingleObject(process_.get(), 0) != WAIT_OBJECT_0) return cleanupFailure();
        retired_ = true; return true;
      }
      Sleep(10);
    } while (GetTickCount64() < until);
    stage(mmstorediagnostic::Phase::shutdownTimeout); return cleanupFailure();
  }
  void failure(std::uint32_t code) noexcept { diagnostic_.code = code; if (!diagnostic_.win32) diagnostic_.win32 = GetLastError(); }
  mmstorediagnostic::Record observation() noexcept {
    auto value = diagnostic_;
    if (process_.valid()) {
      value.wait = WaitForSingleObject(process_.get(), 0);
      DWORD code = 0; if (GetExitCodeProcess(process_.get(), &code)) value.exit = code;
    }
    if (job_.valid()) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (QueryInformationJobObject(job_.get(), JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) value.active = accounting.ActiveProcesses;
      struct Census { DWORD assigned, listed; ULONG_PTR pid[1]; } census{};
      if (QueryInformationJobObject(job_.get(), JobObjectBasicProcessIdList, &census, sizeof(census), nullptr)) { value.assigned = census.assigned; value.listed = census.listed; }
    }
    collectClosedError(); return value;
  }
  std::optional<mmstorediagnostic::Record> childDiagnostic() const { return childDiagnostics_.latest(); }
 private:
  void stage(mmstorediagnostic::Phase value) noexcept { diagnostic_.phase = value; diagnostic_.win32 = 0; }
  void require(bool value) const {
    if (!value) diagnostic_.win32 = GetLastError();
    mmstore::require(value, mmstore::ErrorCode::processDenied);
  }
  bool cleanupFailure() noexcept { diagnostic_.win32 = GetLastError(); return false; }
  void collectClosedError() noexcept {
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
    if (!error_.valid()) return;
    DWORD available = 0;
    while (stderrBytes_ < 16384 && PeekNamedPipe(error_.get(), nullptr, 0, nullptr, &available, nullptr) && available) {
      std::array<char, 4096> buffer{}; DWORD read = 0;
      const auto wanted = (std::min)({available, static_cast<DWORD>(buffer.size()), static_cast<DWORD>(16384 - stderrBytes_)});
      if (!ReadFile(error_.get(), buffer.data(), wanted, &read, nullptr) || !read) break;
      stderrBytes_ += read;
      try { childDiagnostics_.append(std::span<const char>(buffer.data(), read)); } catch (...) { return; }
    }
#endif
  }
  void revalidate() const {
    authority_->revalidate(); require(child_ != nullptr); child_->revalidate();
    require(mmstore::detail::sameIdentity(child_->identity(), mmstore::detail::processIdentity(process_.get())));
    BOOL assigned = FALSE; require(IsProcessInJob(process_.get(), job_.get(), &assigned) != FALSE && assigned);
  }
  void drainErrors() {
    DWORD available = 0; require(PeekNamedPipe(error_.get(), nullptr, 0, nullptr, &available, nullptr) != FALSE);
    while (available) {
      std::array<char, 4096> buffer{}; DWORD read = 0;
      require(ReadFile(error_.get(), buffer.data(), (std::min)(available, static_cast<DWORD>(buffer.size())), &read, nullptr) != FALSE && read > 0);
      stderrBytes_ += read; require(stderrBytes_ <= 16384);
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
      childDiagnostics_.append(std::span<const char>(buffer.data(), read));
#endif
      require(PeekNamedPipe(error_.get(), nullptr, 0, nullptr, &available, nullptr) != FALSE);
    }
  }
  mm::Json request(const char* operation, const mm::Json& arguments) {
    revalidate(); require(!cancelled_.load() && sequence_ < 2);
    const auto id = ++sequence_;
    auto payload = mm::dump(mm::Json::Object{{"version", 1}, {"id", id}, {"operation", operation}, {"args", arguments}}) + '\n';
    require(payload.size() < 1024); DWORD wrote = 0;
    require(WriteFile(input_.get(), payload.data(), static_cast<DWORD>(payload.size()), &wrote, nullptr) != FALSE && wrote == payload.size());
    const auto until = GetTickCount64() + 30000; unsigned events = 0;
    for (;;) {
      require(!cancelled_.load() && GetTickCount64() < until && WaitForSingleObject(process_.get(), 0) == WAIT_TIMEOUT);
      drainErrors();
      while (auto row = frames_.take()) {
        if (mmstorecontrols::sessionEvent(*row, eventSequence_)) { require(++events <= 32); continue; }
        auto result = mmstorecontrols::response(*row, id);
        require(!frames_.pending()); revalidate(); return result;
      }
      DWORD available = 0; require(PeekNamedPipe(output_.get(), nullptr, 0, nullptr, &available, nullptr) != FALSE);
      if (available) {
        std::array<char, 4096> buffer{}; DWORD read = 0;
        require(ReadFile(output_.get(), buffer.data(), (std::min)(available, static_cast<DWORD>(buffer.size())), &read, nullptr) != FALSE && read > 0);
        frames_.append(std::span<const char>(buffer.data(), read));
      } else Sleep(10);
    }
  }
  std::shared_ptr<Authority> authority_; const std::atomic<bool>& cancelled_;
  Handle job_, process_, input_, output_, error_;
  std::unique_ptr<mmstore::AttestedProcess> child_;
  bool assigned_ = false, retired_ = false;
  std::int64_t sequence_ = 0, eventSequence_ = 0; std::size_t stderrBytes_ = 0;
  mmstorecontrols::Frames frames_;
  mutable mmstorediagnostic::Record diagnostic_;
  mmstorediagnostic::Lines childDiagnostics_;
};
struct Report {
  bool succeeded = false, cleanupConfirmed = false;
  std::optional<mmstorestartup::Result> observed;
  mmstorediagnostic::Record operation, cleanup;
  std::optional<mmstorediagnostic::Record> child;
};
struct Window {
  std::shared_ptr<Authority> authority;
  HWND handle = nullptr, explanation = nullptr, status = nullptr, enable = nullptr, disable = nullptr, inspect = nullptr, close = nullptr;
  HFONT font = nullptr; bool arabic = false, busy = false, closing = false, cleanupUncertain = false;
  std::optional<State> observed; std::atomic<bool> cancel{false}; std::thread operation;
  std::mutex reportMutex; std::optional<Report> completed;
  const wchar_t* localized(const wchar_t* english, const wchar_t* translated) const { return arabic ? translated : english; }
  ~Window() { cancel = true; if (operation.joinable()) operation.join(); if (font) DeleteObject(font); }
  int scale(int value) const { return MulDiv(value, static_cast<int>(GetDpiForWindow(handle)), 96); }
  SIZE outerSize(bool minimum) const {
    const auto dpi = GetDpiForWindow(handle);
    const auto client = mmstorecontrols::clientSize(dpi, minimum);
    RECT area{0, 0, client.width, client.height};
    const DWORD direction = arabic ? WS_EX_LAYOUTRTL | WS_EX_NOINHERITLAYOUT : 0;
    require(AdjustWindowRectExForDpi(&area, WS_OVERLAPPEDWINDOW, FALSE, direction, dpi) != FALSE);
    return {area.right - area.left, area.bottom - area.top};
  }
  void text(const wchar_t* value) {
    SetWindowTextW(status, value); NotifyWinEvent(EVENT_OBJECT_NAMECHANGE, status, OBJID_CLIENT, CHILDID_SELF);
  }
  void buttons() const {
    EnableWindow(enable, !busy && !closing && !cleanupUncertain && observed && mmstorecontrols::enableAvailable(*observed));
    EnableWindow(disable, !busy && !closing && !cleanupUncertain && observed && mmstorecontrols::disableAvailable(*observed));
    EnableWindow(inspect, !busy && !closing && !cleanupUncertain);
    EnableWindow(close, !closing);
  }
  void stateText(State state) {
    switch (state) {
      case State::disabled: text(localized(L"Startup is off. Enable it to allow MusicMute Worker to run when you sign in.", L"التشغيل عند تسجيل الدخول متوقف. يمكنك تفعيله للسماح بتشغيل MusicMute Worker عند تسجيل الدخول.")); break;
      case State::enabled: text(localized(L"Startup is on. MusicMute Worker may run while you are signed in.", L"التشغيل عند تسجيل الدخول مفعّل. يمكن تشغيل MusicMute Worker أثناء تسجيل دخولك.")); break;
      case State::disabledByUser: text(localized(L"Windows has disabled startup by your choice. Enable MusicMute Worker in Windows Settings > Apps > Startup if you want it to start at sign-in.", L"تم إيقاف التشغيل عند تسجيل الدخول باختيارك في Windows. يمكنك تفعيله من إعدادات Windows، التطبيقات، بدء التشغيل.")); break;
      case State::disabledByPolicy: text(localized(L"Windows policy has disabled startup. This app respects that setting.", L"تم إيقاف التشغيل عند تسجيل الدخول بواسطة سياسة Windows. يحترم التطبيق هذا الإعداد.")); break;
      case State::enabledByPolicy: text(localized(L"Windows policy has enabled startup. This app respects that setting.", L"تم تفعيل التشغيل عند تسجيل الدخول بواسطة سياسة Windows. يحترم التطبيق هذا الإعداد.")); break;
    }
  }
  void begin(Intent intent) {
    if (busy || closing || cleanupUncertain) return;
    if (intent != Intent::inspect && (GetForegroundWindow() != handle || !IsWindowVisible(handle) || IsIconic(handle))) return;
    if (intent == Intent::requestEnable && (!observed || !mmstorecontrols::enableAvailable(*observed))) return;
    if (intent == Intent::disable && (!observed || !mmstorecontrols::disableAvailable(*observed))) return;
    if (operation.joinable()) operation.join();
    busy = true; cancel = false; buttons(); text(localized(L"Reading Windows startup settings…", L"جارٍ قراءة إعدادات بدء التشغيل في Windows…"));
    try { operation = std::thread([this, intent] {
      Report report;
      {
        Helper helper(authority, cancel);
        try {
          helper.start(); helper.authenticate(); report.observed = helper.startup(intent); report.succeeded = true;
        } catch (const mmstore::Error& error) {
          helper.failure(static_cast<std::uint32_t>(error.code()) + 1); report.succeeded = false; report.observed.reset();
        } catch (...) { helper.failure(0); report.succeeded = false; report.observed.reset(); }
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
        report.operation = helper.observation(); report.child = helper.childDiagnostic();
#endif
        report.cleanupConfirmed = helper.shutdown();
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
        report.cleanup = helper.observation(); if (!report.child) report.child = helper.childDiagnostic();
#endif
        if (!report.cleanupConfirmed) { report.succeeded = false; report.observed.reset(); }
      }
      { std::lock_guard lock(reportMutex); completed = std::move(report); }
      // A window message carries no result pointer or caller-supplied receipt.
      // Only this process's completed operation can publish an observation.
      (void)PostMessageW(handle, finishedMessage, 0, 0);
    }); } catch (...) { busy = false; buttons(); throw; }
  }
  void finished(Report& report) {
    if (operation.joinable()) operation.join(); busy = false;
    cleanupUncertain = !report.cleanupConfirmed;
    if (report.succeeded && report.observed) { observed = report.observed->after; stateText(*observed); }
    else {
      observed.reset();
      text(cleanupUncertain ? localized(L"Could not confirm startup helper cleanup. Close these controls.", L"تعذر تأكيد إغلاق مساعد بدء التشغيل. أغلق هذه النافذة.") :
        localized(L"Could not read or change startup settings. The outcome is unconfirmed. Check status to read Windows settings again.", L"تعذر قراءة إعدادات بدء التشغيل أو تغييرها. لم يتم تأكيد النتيجة. افحص الحالة لقراءة إعدادات Windows مجددًا."));
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
      std::wstring detail = L"Development diagnostic\r\n";
      const auto append = [&](const mmstorediagnostic::Record& value) { for (const unsigned char c : mmstorediagnostic::line(value)) detail += static_cast<wchar_t>(c); };
      append(report.operation); append(report.cleanup); if (report.child) append(*report.child);
      text(detail.c_str());
#endif
    }
    buttons(); if (closing) DestroyWindow(handle);
  }
  void layout() {
    RECT area{}; GetClientRect(handle, &area);
    const int clientWidth = static_cast<int>(area.right), clientHeight = static_cast<int>(area.bottom);
    const int margin = scale(24), width = (std::max)(scale(100), clientWidth - margin * 2);
    MoveWindow(explanation, margin, margin, width, scale(65), TRUE);
    MoveWindow(status, margin, scale(105), width, (std::max)(scale(75), clientHeight - scale(195)), TRUE);
    const int bottom = (std::max)(scale(220), clientHeight - scale(65));
    const int gap = scale(10), button = (width - gap * 3) / 4;
    for (const auto& pair : std::array<std::pair<HWND, int>, 4>{{{enable, 0}, {disable, 1}, {inspect, 2}, {close, 3}}})
      MoveWindow(pair.first, margin + pair.second * (button + gap), bottom, button, scale(36), TRUE);
  }
  void setFont() {
    if (font) DeleteObject(font);
    font = CreateFontW(-scale(16), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
      OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
    require(font != nullptr);
    for (const auto child : {explanation, status, enable, disable, inspect, close}) SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  }
  void create() {
    const auto instance = GetModuleHandleW(nullptr);
    const DWORD reading = arabic ? WS_EX_RTLREADING : 0;
    explanation = CreateWindowExW(reading, L"STATIC", localized(
      L"MusicMute Worker\r\nChoose whether the worker starts when you sign in. Turning startup off does not stop a worker that is already running.",
      L"MusicMute Worker\r\nاختر ما إذا كان العامل يبدأ عند تسجيل الدخول. إيقاف بدء التشغيل لا يوقف العامل الذي يعمل بالفعل."),
      WS_CHILD | WS_VISIBLE | (arabic ? SS_RIGHT : SS_LEFT), 0, 0, 0, 0, handle, nullptr, instance, nullptr);
    status = CreateWindowExW(reading, L"STATIC", L"", WS_CHILD | WS_VISIBLE | (arabic ? SS_RIGHT : SS_LEFT), 0, 0, 0, 0, handle, nullptr, instance, nullptr);
    const auto button = [&](const wchar_t* label, int id) {
      return CreateWindowExW(reading, L"BUTTON", label, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
        0, 0, 0, 0, handle, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance, nullptr);
    };
    enable = button(localized(L"&Enable at sign-in", L"&تفعيل عند الدخول"), enableId);
    disable = button(localized(L"&Turn startup off", L"&إيقاف بدء التشغيل"), disableId);
    inspect = button(localized(L"&Check status", L"&فحص الحالة"), inspectId);
    close = button(localized(L"&Close", L"&إغلاق"), closeId);
    require(explanation && status && enable && disable && inspect && close); setFont(); layout(); begin(Intent::inspect);
  }
};
LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* state = reinterpret_cast<Window*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    state = static_cast<Window*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams); state->handle = window;
    SetLastError(ERROR_SUCCESS);
    const auto previous = SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    if (previous == 0 && GetLastError() != ERROR_SUCCESS) return FALSE;
  }
  if (!state) return DefWindowProcW(window, message, wparam, lparam);
  try {
    if (message == WM_CREATE) { state->create(); return 0; }
    if (message == WM_SIZE) { state->layout(); return 0; }
    if (message == WM_DPICHANGED) {
      const auto* rectangle = reinterpret_cast<RECT*>(lparam);
      SetWindowPos(window, nullptr, rectangle->left, rectangle->top, rectangle->right - rectangle->left,
        rectangle->bottom - rectangle->top, SWP_NOZORDER | SWP_NOACTIVATE);
      state->setFont(); state->layout(); return 0;
    }
    if (message == WM_GETMINMAXINFO) {
      auto* sizing = reinterpret_cast<MINMAXINFO*>(lparam); const auto minimum = state->outerSize(true);
      sizing->ptMinTrackSize = {minimum.cx, minimum.cy}; return 0;
    }
    if (message == WM_COMMAND && HIWORD(wparam) == BN_CLICKED) {
      switch (LOWORD(wparam)) {
        case enableId: if (reinterpret_cast<HWND>(lparam) == state->enable) state->begin(Intent::requestEnable); return 0;
        case disableId: if (reinterpret_cast<HWND>(lparam) == state->disable) state->begin(Intent::disable); return 0;
        case inspectId: if (reinterpret_cast<HWND>(lparam) == state->inspect) state->begin(Intent::inspect); return 0;
        case closeId: if (reinterpret_cast<HWND>(lparam) == state->close) SendMessageW(window, WM_CLOSE, 0, 0); return 0;
      }
    }
    if (message == finishedMessage) {
      if (wparam || lparam) return 0;
      std::optional<Report> report;
      { std::lock_guard lock(state->reportMutex); report = std::move(state->completed); state->completed.reset(); }
      if (report) state->finished(*report); return 0;
    }
    if (message == WM_CLOSE) {
      if (state->busy) { state->closing = true; state->cancel = true; state->buttons(); state->text(state->localized(L"Closing startup helper…", L"جارٍ إغلاق مساعد بدء التشغيل…")); }
      else DestroyWindow(window);
      return 0;
    }
    if (message == WM_QUERYENDSESSION) { state->cancel = true; return TRUE; }
    if (message == WM_ENDSESSION && wparam) { state->cancel = true; PostMessageW(window, WM_CLOSE, 0, 0); return 0; }
    if (message == WM_DESTROY) { state->cancel = true; PostQuitMessage(0); return 0; }
  } catch (...) {
    state->cancel = true;
    if (message == WM_CREATE) return -1;
    PostMessageW(window, WM_CLOSE, 0, 0); return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR arguments, int show) {
  // No URL, action, code path, package selector or processing mode is accepted.
  if (arguments && *arguments) return 2;
  try {
    Window state; state.authority = Authority::open();
    state.arabic = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_ARABIC;
    (void)SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW type{}; type.lpfnWndProc = procedure; type.hInstance = instance;
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.hbrBackground = reinterpret_cast<HBRUSH>(static_cast<INT_PTR>(COLOR_WINDOW + 1));
    type.lpszClassName = L"MusicMuteStoreWorkerControls"; require(RegisterClassW(&type) != 0);
    const DWORD direction = state.arabic ? WS_EX_LAYOUTRTL | WS_EX_NOINHERITLAYOUT : 0;
    const auto window = CreateWindowExW(direction, type.lpszClassName, L"MusicMute Worker", WS_OVERLAPPEDWINDOW,
      CW_USEDEFAULT, CW_USEDEFAULT, 740, 370, nullptr, nullptr, instance, &state);
    require(window != nullptr);
    // The invisible HWND identifies its actual initial monitor DPI. Resize the
    // client and frame together before exposing any scaled controls.
    const auto initial = state.outerSize(false);
    require(SetWindowPos(window, nullptr, 0, 0, initial.cx, initial.cy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) != FALSE);
    ShowWindow(window, show == SW_HIDE ? SW_SHOWNORMAL : show); UpdateWindow(window);
    MSG message{}; int received = 0;
    while ((received = static_cast<int>(GetMessageW(&message, nullptr, 0, 0))) > 0)
      if (!IsDialogMessageW(window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    require(received == 0); return state.cleanupUncertain ? 2 : 0;
  } catch (...) {
    // Unsigned/unregistered/foreign/stale/elevated executions have no UI or
    // helper launch, and no fallback package/private path is attempted.
    return 2;
  }
}
#else
int main() { return 2; }
#endif
