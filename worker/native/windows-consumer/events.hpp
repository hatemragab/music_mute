#pragma once

std::mutex outputMutex;
std::uint64_t eventSequence = 0;
void writeNativeMessage(const Json& message) {
  std::lock_guard lock(outputMutex);
  std::cout << mm::dump(message) << '\n' << std::flush;
}
void emitSessionEvent(const char* kind) {
  std::lock_guard lock(outputMutex);
  const auto event = Json::Object{{"kind", "session"}, {"event", kind}, {"sequence", static_cast<std::int64_t>(++eventSequence)}};
  std::cout << mm::dump(Json::Object{{"version", 1}, {"event", event}}) << '\n' << std::flush;
}
void watchOwnedProcess(HANDLE process, const Json& owner) {
  Handle watched;
  check(DuplicateHandle(GetCurrentProcess(), process, GetCurrentProcess(), &watched.value, SYNCHRONIZE, FALSE, 0), "JOB_UNAVAILABLE");
  std::thread([handle = std::move(watched), owner] {
    if (WaitForSingleObject(handle.value, INFINITE) != WAIT_OBJECT_0) return;
    std::lock_guard lock(outputMutex);
    const auto event = Json::Object{{"kind", "child_exit"}, {"owner", owner}, {"sequence", static_cast<std::int64_t>(++eventSequence)}};
    std::cout << mm::dump(Json::Object{{"version", 1}, {"event", event}}) << '\n' << std::flush;
  }).detach();
}
