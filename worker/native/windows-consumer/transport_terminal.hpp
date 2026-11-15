#pragma once

namespace mm {
// Normal helper has detached input/window/client threads with stack references.
// Self-termination avoids C++ stack unwinding and unknown DLL-detach lock state.
// It is not a child-tree certificate: independent guardians still query Job zero.
[[noreturn]] inline void terminateConsumerTransport(UINT exitCode) noexcept {
  TerminateProcess(GetCurrentProcess(), exitCode);
  // Successful self-termination cannot return. An unexpected API failure must
  // retain stack owners, not unwind/acknowledge cleanup. The owner may terminate
  // its exact helper process; it still cannot infer a child-tree exit from this.
  for (;;) Sleep(INFINITE);
}
} // namespace mm
