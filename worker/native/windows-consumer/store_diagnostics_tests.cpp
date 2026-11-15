#include "store_diagnostics.hpp"
#include <iostream>

namespace {
unsigned checks = 0;
void check(bool value) { ++checks; if (!value) throw std::runtime_error("DIAGNOSTIC_TEST_FAILED"); }
void denied(std::string value) { check(!mmstorediagnostic::parse(value)); }
}
int main() {
  using namespace mmstorediagnostic;
  try {
    for (std::uint32_t code = 1; code <= 11; ++code) {
      const auto mapped = mappedError(code, 0x80070005U);
      check(mapped.code == (enabled ? code : 0) && mapped.win32 == (enabled ? 0x80070005U : 0));
      Record denial; denial.phase = Phase::storeStartup; denial.code = mapped.code; denial.win32 = mapped.win32;
      const auto decoded = parse(line(denial));
      check(decoded && decoded->code == mapped.code && decoded->win32 == mapped.win32);
    }
    for (const auto code : {0U, 12U, unobserved}) {
      const auto rejected = mappedError(code, unobserved);
      check(rejected.code == 0 && rejected.win32 == 0);
    }
    for (std::size_t n = 0; n < phases.size(); ++n) {
      Record record; record.phase = static_cast<Phase>(n); record.code = 11;
      record.win32 = unobserved;
      const auto encoded = line(record); const auto actual = parse(encoded);
      check(encoded.size() <= 256 && encoded.ends_with('\n'));
      check(actual && actual->phase == record.phase && actual->code == 11 && actual->win32 == unobserved && actual->wait == unobserved);
      for (const unsigned char value : encoded) check(value == 10 || (value >= 32 && value <= 126));
    }
    Record record; record.phase = Phase::entrySelf;
    const auto good = line(record);
    denied(good.substr(0, good.size() - 1)); denied(good + "extra");
    denied("MMDEV1 phase=caller-value code=0 win32=0 wait=0 exit=0 active=0 assigned=0 listed=0\n");
    for (const auto& number : {"-1", "+1", "01", "4294967296", "1.0", "1e2", "NaN", ""})
      denied("MMDEV1 phase=authority code=0 win32=" + std::string(number) + " wait=0 exit=0 active=0 assigned=0 listed=0\n");
    denied("MMDEV1 phase=authority code=12 win32=0 wait=0 exit=0 active=0 assigned=0 listed=0\n");
    denied("MMDEV1 phase=authority win32=0 code=0 wait=0 exit=0 active=0 assigned=0 listed=0\n");
    denied("MMDEV1 phase=authority code=0 win32=0 wait=0 exit=0 active=0 assigned=0 listed=0 path=x\n");
    denied(good.substr(0, good.size()-1) + "\r\n"); denied(std::string(257, 'x'));
    Lines lines;
    for (const char byte : good) lines.append(std::span<const char>(&byte, 1));
    check(lines.size() == 1 && lines.latest()->phase == Phase::entrySelf);
    const auto invalid = std::string(4096, 'x') + '\n' + good;
    lines.append(std::span<const char>(invalid.data(), invalid.size()));
    check(lines.size() == 2);
    for (unsigned n=0;n<8;++n) lines.append(std::span<const char>(good.data(), good.size()));
    check(lines.size() == 4);
    bool failed = false; record.code = 12; try { (void)line(record); } catch (...) { failed = true; } check(failed);
    failed = false; record.code = 0; record.phase = static_cast<Phase>(999);
    try { (void)line(record); } catch (...) { failed = true; } check(failed);
#ifdef MUSICMUTE_DEVELOPMENT_TEST_PACKAGE
    check(enabled);
#else
    check(!enabled);
#endif
    std::cout << "Closed Store diagnostics checks: " << checks << '\n'; return 0;
  } catch (...) { return 1; }
}
