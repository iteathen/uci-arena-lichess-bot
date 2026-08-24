#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <iomanip>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace {

constexpr DWORD launcher_error = 70;
constexpr DWORD receipt_error = 71;
constexpr DWORD owned_tree_exit = ERROR_CANCELLED;

struct process_record {
    DWORD process_id;
    DWORD parent_process_id;
};

std::optional<std::wstring> normalized_path(std::wstring_view value);
bool same_path(std::wstring_view left, std::wstring_view right);

std::vector<std::wstring> command_line_arguments() {
    int count = 0;
    auto** values = CommandLineToArgvW(GetCommandLineW(), &count);
    if (values == nullptr) return {};
    std::vector<std::wstring> arguments;
    arguments.reserve(static_cast<std::size_t>(count));
    for (int index = 0; index < count; ++index) arguments.emplace_back(values[index]);
    LocalFree(values);
    return arguments;
}

std::wstring quote_argument(std::wstring_view value) {
    if (!value.empty() && value.find_first_of(L" \t\n\v\"") == std::wstring_view::npos) return std::wstring(value);
    std::wstring quoted(1, L'"');
    std::size_t backslashes = 0;
    for (const auto character : value) {
        if (character == L'\\') {
            ++backslashes;
        } else if (character == L'"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(L'"');
            backslashes = 0;
        } else {
            quoted.append(backslashes, L'\\');
            quoted.push_back(character);
            backslashes = 0;
        }
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'"');
    return quoted;
}

std::wstring child_command_line(const std::vector<std::wstring>& arguments) {
    std::wstring command_line;
    for (std::size_t index = 1; index < arguments.size(); ++index) {
        if (!command_line.empty()) command_line.push_back(L' ');
        command_line.append(quote_argument(arguments[index]));
    }
    return command_line;
}

void write_probe() {
    constexpr std::string_view message =
        "{\"schema\":\"uci_arena_lichess_launcher_probe_v1\","
        "\"windows_gui_subsystem\":true,\"create_no_window\":true,"
        "\"atomic_exit_receipt\":true,"
        "\"exit_receipt_schema\":\"uci_arena_lichess_exit_receipt_v1\"}\n";
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(output, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
}

std::optional<std::wstring> runtime_directory(const std::vector<std::wstring>& arguments) {
    std::optional<std::wstring> result;
    for (std::size_t index = 1; index < arguments.size(); ++index) {
        if (arguments[index] != L"--runtime-dir") continue;
        if (result.has_value() || index + 1 >= arguments.size()) return std::nullopt;
        result = normalized_path(arguments[index + 1]);
        ++index;
    }
    return result;
}

bool exact_directory(std::wstring_view directory) {
    if (directory.empty()) return false;
    std::wstring volume(MAX_PATH + 1, L'\0');
    if (GetVolumePathNameW(std::wstring(directory).c_str(), volume.data(),
                           static_cast<DWORD>(volume.size())) == FALSE) {
        return false;
    }
    volume.resize(wcslen(volume.c_str()));
    if (volume.empty() || directory.size() < volume.size()
        || !same_path(directory.substr(0, volume.size()), volume)) {
        return false;
    }
    auto safe_directory = [](const std::wstring& candidate) {
        const DWORD attributes = GetFileAttributesW(candidate.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES
            && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0
            && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
    };
    if (!safe_directory(volume)) return false;
    for (std::size_t index = volume.size(); index <= directory.size(); ++index) {
        if (index != directory.size() && directory[index] != L'\\') continue;
        const auto candidate = std::wstring(directory.substr(0, index));
        if (!candidate.empty() && !safe_directory(candidate)) return false;
    }
    return true;
}

std::string utc_timestamp(const FILETIME& timestamp) {
    SYSTEMTIME value{};
    if (FileTimeToSystemTime(&timestamp, &value) == FALSE) return {};
    std::ostringstream stream;
    stream << std::setfill('0') << std::setw(4) << value.wYear << '-'
           << std::setw(2) << value.wMonth << '-' << std::setw(2) << value.wDay << 'T'
           << std::setw(2) << value.wHour << ':' << std::setw(2) << value.wMinute << ':'
           << std::setw(2) << value.wSecond << '.' << std::setw(3) << value.wMilliseconds << 'Z';
    return stream.str();
}

std::string filetime_ticks(const FILETIME& timestamp) {
    ULARGE_INTEGER value{};
    value.LowPart = timestamp.dwLowDateTime;
    value.HighPart = timestamp.dwHighDateTime;
    return std::to_string(value.QuadPart);
}

bool safe_receipt_target(std::wstring_view target) {
    const DWORD attributes = GetFileAttributesW(std::wstring(target).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND;
    return (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

std::optional<std::wstring> private_temporary_path(std::wstring_view directory) {
    std::array<unsigned char, 16> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        return std::nullopt;
    }
    constexpr wchar_t hex[] = L"0123456789abcdef";
    std::wstring result(directory);
    result.append(L"\\.launcher-exit.json.");
    for (const auto byte : random) {
        result.push_back(hex[byte >> 4]);
        result.push_back(hex[byte & 0x0f]);
    }
    result.append(L".tmp");
    return result;
}

bool publish_exit_receipt(std::wstring_view directory, std::string_view payload) {
    if (payload.empty() || payload.size() > 4096 || !exact_directory(directory)) return false;
    const std::wstring target = std::wstring(directory) + L"\\launcher-exit.json";
    if (!safe_receipt_target(target)) return false;
    const auto temporary = private_temporary_path(directory);
    if (!temporary.has_value()) return false;
    const HANDLE file = CreateFileW(
        temporary->c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    bool success = true;
    std::size_t offset = 0;
    while (offset < payload.size()) {
        DWORD written = 0;
        const DWORD count = static_cast<DWORD>(payload.size() - offset);
        if (WriteFile(file, payload.data() + offset, count, &written, nullptr) == FALSE
            || written == 0) {
            success = false;
            break;
        }
        offset += written;
    }
    if (success && FlushFileBuffers(file) == FALSE) success = false;
    if (CloseHandle(file) == FALSE) success = false;
    if (success && (!exact_directory(directory) || !safe_receipt_target(target))) success = false;
    if (success && MoveFileExW(temporary->c_str(), target.c_str(),
                              MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == FALSE) {
        success = false;
    }
    if (!success) DeleteFileW(temporary->c_str());
    return success;
}

std::string exit_receipt(DWORD process_id, const FILETIME& creation_time,
                         const FILETIME& started_at, const FILETIME& exited_at,
                         DWORD exit_code) {
    const bool clean = exit_code == 0;
    std::ostringstream json;
    json << "{\"schema\":\"uci_arena_lichess_exit_receipt_v1\","
         << "\"process_instance\":{\"schema\":\"uci_arena_process_instance_receipt_v1\","
         << "\"platform\":\"win32\",\"pid\":" << process_id
         << ",\"creation_time_100ns\":\"" << filetime_ticks(creation_time) << "\"},"
         << "\"started_at\":\"" << utc_timestamp(started_at) << "\","
         << "\"exited_at\":\"" << utc_timestamp(exited_at) << "\","
         << "\"child_exit_code\":" << exit_code << ','
         << "\"clean\":" << (clean ? "true" : "false") << ','
         << "\"expected\":" << (clean ? "true" : "false") << ','
         << "\"disposition\":\"" << (clean ? "clean_exit" : "unexpected_exit") << "\","
         << "\"restart_eligible\":" << (clean ? "false" : "true") << '}';
    return json.str();
}

std::optional<std::wstring> normalized_path(std::wstring_view value) {
    if (value.empty()) return std::nullopt;
    const DWORD required = GetFullPathNameW(std::wstring(value).c_str(), 0, nullptr, nullptr);
    if (required == 0) return std::nullopt;
    std::wstring result(required, L'\0');
    const DWORD written =
        GetFullPathNameW(std::wstring(value).c_str(), required, result.data(), nullptr);
    if (written == 0 || written >= required) return std::nullopt;
    result.resize(written);
    std::replace(result.begin(), result.end(), L'/', L'\\');
    while (result.size() > 3 && result.back() == L'\\') result.pop_back();
    return result;
}

bool same_path(std::wstring_view left, std::wstring_view right) {
    return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                                static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

std::optional<std::wstring> process_image_path(HANDLE process) {
    std::wstring value(32768, L'\0');
    DWORD size = static_cast<DWORD>(value.size());
    if (QueryFullProcessImageNameW(process, 0, value.data(), &size) == FALSE) {
        return std::nullopt;
    }
    value.resize(size);
    return normalized_path(value);
}

std::vector<process_record> process_snapshot() {
    std::vector<process_record> records;
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return records;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry) != FALSE) {
        do {
            records.push_back({entry.th32ProcessID, entry.th32ParentProcessID});
        } while (Process32NextW(snapshot, &entry) != FALSE);
    }
    CloseHandle(snapshot);
    return records;
}

bool exited(HANDLE process) {
    return WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
}

int terminate_owned_process_tree(std::wstring_view launcher_path,
                                 const DWORD timeout_milliseconds) {
    const auto expected = normalized_path(launcher_path);
    if (!expected.has_value() || timeout_milliseconds < 100 || timeout_milliseconds > 60000) {
        return ERROR_INVALID_PARAMETER;
    }
    const auto separator = expected->find_last_of(L"\\/");
    const std::wstring_view filename =
        separator == std::wstring::npos ? std::wstring_view(*expected)
                                        : std::wstring_view(*expected).substr(separator + 1);
    if (!same_path(filename, L"lichess_adapter_launcher.exe")) {
        return ERROR_INVALID_PARAMETER;
    }
    const auto records = process_snapshot();
    if (records.empty()) return launcher_error;

    std::unordered_set<DWORD> owned;
    for (const auto& record : records) {
        if (record.process_id == GetCurrentProcessId()) continue;
        const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE,
                                           record.process_id);
        if (process == nullptr) continue;
        const auto image = process_image_path(process);
        CloseHandle(process);
        if (image.has_value() && same_path(*image, *expected)) owned.insert(record.process_id);
    }
    if (owned.empty()) return 0;

    bool changed = true;
    while (changed) {
        changed = false;
        for (const auto& record : records) {
            if (!owned.contains(record.process_id) && owned.contains(record.parent_process_id)) {
                owned.insert(record.process_id);
                changed = true;
            }
        }
    }

    struct owned_handle {
        DWORD process_id;
        bool root;
        HANDLE handle;
    };
    std::vector<owned_handle> handles;
    handles.reserve(owned.size());
    for (const DWORD process_id : owned) {
        const HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION |
                                               SYNCHRONIZE,
                                           FALSE, process_id);
        if (process == nullptr) {
            if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
            for (const auto& item : handles) CloseHandle(item.handle);
            return launcher_error;
        }
        const auto image = process_image_path(process);
        const bool root = image.has_value() && same_path(*image, *expected);
        handles.push_back({process_id, root, process});
    }

    const auto terminate = [](owned_handle& item) {
        if (exited(item.handle)) return true;
        if (TerminateProcess(item.handle, owned_tree_exit) != FALSE) return true;
        return GetLastError() == ERROR_ACCESS_DENIED && exited(item.handle);
    };
    for (auto& item : handles) {
        if (item.root && !terminate(item)) {
            for (const auto& current : handles) CloseHandle(current.handle);
            return launcher_error;
        }
    }
    for (auto& item : handles) {
        if (!item.root && !terminate(item)) {
            for (const auto& current : handles) CloseHandle(current.handle);
            return launcher_error;
        }
    }

    const ULONGLONG deadline = GetTickCount64() + timeout_milliseconds;
    int result = 0;
    for (const auto& item : handles) {
        const ULONGLONG now = GetTickCount64();
        const DWORD remaining = now >= deadline ? 0 : static_cast<DWORD>(deadline - now);
        if (WaitForSingleObject(item.handle, remaining) != WAIT_OBJECT_0) {
            result = ERROR_TIMEOUT;
            break;
        }
    }
    for (const auto& item : handles) CloseHandle(item.handle);
    return result;
}

HANDLE open_null(DWORD access, SECURITY_ATTRIBUTES* security) {
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, security, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
}

int launch_hidden(const std::vector<std::wstring>& arguments) {
    if (arguments.size() < 3 || arguments[1].empty()) return ERROR_INVALID_PARAMETER;
    const auto receipt_directory = runtime_directory(arguments);
    if (!receipt_directory.has_value() || !exact_directory(*receipt_directory)) {
        return ERROR_INVALID_PARAMETER;
    }
    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    const auto null_input = open_null(GENERIC_READ, &security);
    const auto null_output = open_null(GENERIC_WRITE, &security);
    if (null_input == INVALID_HANDLE_VALUE || null_output == INVALID_HANDLE_VALUE) {
        if (null_input != INVALID_HANDLE_VALUE) CloseHandle(null_input);
        if (null_output != INVALID_HANDLE_VALUE) CloseHandle(null_output);
        return launcher_error;
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = null_input;
    startup.hStdOutput = null_output;
    startup.hStdError = null_output;

    PROCESS_INFORMATION process{};
    auto command_line = child_command_line(arguments);
    const auto created = CreateProcessW(arguments[1].c_str(), command_line.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED, nullptr, nullptr, &startup, &process);
    CloseHandle(null_input);
    CloseHandle(null_output);
    if (created == FALSE) return static_cast<int>(GetLastError());

    FILETIME creation_time{};
    FILETIME exit_time_unused{};
    FILETIME kernel_time{};
    FILETIME user_time{};
    if (GetProcessTimes(process.hProcess, &creation_time, &exit_time_unused,
                        &kernel_time, &user_time) == FALSE) {
        TerminateProcess(process.hProcess, launcher_error);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return launcher_error;
    }

    const auto job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == nullptr ||
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) == FALSE ||
        AssignProcessToJobObject(job, process.hProcess) == FALSE ||
        ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
        if (job != nullptr) TerminateJobObject(job, launcher_error);
        else TerminateProcess(process.hProcess, launcher_error);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        if (job != nullptr) CloseHandle(job);
        return launcher_error;
    }
    CloseHandle(process.hThread);
    const auto wait = WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = launcher_error;
    if (wait != WAIT_OBJECT_0 || GetExitCodeProcess(process.hProcess, &exit_code) == FALSE) {
        TerminateJobObject(job, launcher_error);
        exit_code = launcher_error;
    }
    FILETIME exited_at{};
    GetSystemTimeAsFileTime(&exited_at);
    const DWORD child_process_id = process.dwProcessId;
    CloseHandle(process.hProcess);
    CloseHandle(job);
    const auto receipt = exit_receipt(
        child_process_id, creation_time, creation_time, exited_at, exit_code);
    if (!publish_exit_receipt(*receipt_directory, receipt)) return receipt_error;
    return static_cast<int>(exit_code);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    const auto arguments = command_line_arguments();
    if (arguments.size() == 2 && arguments[1] == L"--probe") {
        write_probe();
        return 0;
    }
    if (arguments.size() == 5 && arguments[1] == L"--terminate-owned-tree" &&
        arguments[3] == L"--timeout-ms") {
        try {
            const auto timeout = std::stoul(arguments[4]);
            if (timeout > MAXDWORD) return ERROR_INVALID_PARAMETER;
            return terminate_owned_process_tree(arguments[2], static_cast<DWORD>(timeout));
        } catch (...) {
            return ERROR_INVALID_PARAMETER;
        }
    }
    return launch_hidden(arguments);
}
