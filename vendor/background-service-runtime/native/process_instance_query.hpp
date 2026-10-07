#pragma once

#include <windows.h>
#include <array>
#include <cstdint>
#include <string>
#include <utility>

namespace uci_arena::background_service_runtime {

enum class ProcessInstanceState { present, absent, unverifiable };

struct ProcessInstanceObservation {
    ProcessInstanceState state = ProcessInstanceState::unverifiable;
    std::uint64_t creation_utc_ticks = 0;
    std::string executable_path;
};

class ProcessHandle {
public:
    explicit ProcessHandle(HANDLE value) noexcept : value_(value) {}
    ProcessHandle(const ProcessHandle&) = delete;
    ProcessHandle& operator=(const ProcessHandle&) = delete;
    ~ProcessHandle() { if (value_ != nullptr) CloseHandle(value_); }
    HANDLE get() const noexcept { return value_; }
    bool close() noexcept {
        const auto value = value_;
        value_ = nullptr;
        return value == nullptr || CloseHandle(value) != FALSE;
    }
private:
    HANDLE value_ = nullptr;
};

// .NET UTC DateTime ticks are Gregorian 100 ns units since 0001-01-01.
// Use Windows' UTC conversion as .NET does on leap-second-aware systems,
// preserving the original FILETIME's sub-millisecond remainder exactly.
inline bool datetime_utc_ticks(const SYSTEMTIME& utc, std::uint64_t remainder, std::uint64_t& ticks) {
    constexpr std::array<unsigned int, 13> month_days{0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365};
    if (utc.wYear < 1601 || utc.wYear > 9999 || utc.wMonth == 0 || utc.wMonth > 12
        || utc.wDay == 0 || utc.wHour > 23 || utc.wMinute > 59 || utc.wSecond > 59
        || utc.wMilliseconds > 999 || remainder > 9999) return false;
    const bool leap = utc.wYear % 4 == 0 && (utc.wYear % 100 != 0 || utc.wYear % 400 == 0);
    const auto month = static_cast<std::size_t>(utc.wMonth);
    const auto days_in_month = month_days[month] - month_days[month - 1] + (month == 2 && leap ? 1U : 0U);
    if (utc.wDay > days_in_month) return false;
    const auto year = static_cast<std::uint64_t>(utc.wYear - 1);
    const auto days = year * 365 + year / 4 - year / 100 + year / 400
        + month_days[month - 1] + (leap && month > 2 ? 1U : 0U) + utc.wDay - 1;
    ticks = (((days * 24 + utc.wHour) * 60 + utc.wMinute) * 60 + utc.wSecond) * 10'000'000ULL
        + utc.wMilliseconds * 10'000ULL + remainder;
    return ticks <= 3'155'378'975'999'999'999ULL;
}

inline ProcessInstanceObservation inspect_process_handle(HANDLE process, DWORD process_id) {
    const auto before = WaitForSingleObject(process, 0);
    if (before == WAIT_OBJECT_0) return {ProcessInstanceState::absent, 0, {}};
    if (before != WAIT_TIMEOUT || GetProcessId(process) != process_id) return {};

    FILETIME creation{}, exited{}, kernel{}, user{};
    if (GetProcessTimes(process, &creation, &exited, &kernel, &user) == FALSE) return {};
    SYSTEMTIME utc{};
    if (FileTimeToSystemTime(&creation, &utc) == FALSE) return {};
    const auto file_ticks = (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
    std::uint64_t creation_ticks = 0;
    if (!datetime_utc_ticks(utc, file_ticks % 10'000, creation_ticks)) return {};

    // 32767 UTF-16 units plus the Windows API's terminating NUL.
    std::array<wchar_t, 32768> image{};
    auto length = static_cast<DWORD>(image.size());
    if (QueryFullProcessImageNameW(process, 0, image.data(), &length) == FALSE
        || length == 0 || length >= image.size()) return {};
    const auto bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, image.data(), static_cast<int>(length),
        nullptr, 0, nullptr, nullptr);
    if (bytes <= 0 || bytes > 4 * 32767) return {};
    std::string executable(static_cast<std::size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, image.data(), static_cast<int>(length),
        executable.data(), bytes, nullptr, nullptr) != bytes) return {};

    const auto after = WaitForSingleObject(process, 0);
    if (after == WAIT_OBJECT_0) return {ProcessInstanceState::absent, 0, {}};
    if (after != WAIT_TIMEOUT) return {};
    return {ProcessInstanceState::present, creation_ticks, std::move(executable)};
}

inline ProcessInstanceObservation query_process_instance(DWORD process_id) {
    if (process_id == 0) return {};
    ProcessHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id));
    if (process.get() == nullptr) {
        // PID zero is rejected by the public request parser. For an admitted
        // positive PID, ERROR_INVALID_PARAMETER means no process can be opened.
        return GetLastError() == ERROR_INVALID_PARAMETER
            ? ProcessInstanceObservation{ProcessInstanceState::absent, 0, {}}
            : ProcessInstanceObservation{};
    }
    auto observation = inspect_process_handle(process.get(), process_id);
    if (!process.close()) return {};
    return observation;
}

inline std::string json_string(const std::string& value) {
    constexpr char hex[] = "0123456789abcdef";
    std::string escaped;
    escaped.reserve(value.size() + 2);
    escaped.push_back('"');
    for (const unsigned char byte : value) {
        if (byte == '"' || byte == '\\') { escaped.push_back('\\'); escaped.push_back(static_cast<char>(byte)); }
        else if (byte < 32) {
            escaped += "\\u00";
            escaped.push_back(hex[byte >> 4]);
            escaped.push_back(hex[byte & 15]);
        } else escaped.push_back(static_cast<char>(byte));
    }
    escaped.push_back('"');
    return escaped;
}

} // namespace uci_arena::background_service_runtime
