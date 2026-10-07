#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr DWORD launcher_error = 70;
constexpr DWORD initial_restart_delay_ms = 5'000;
constexpr DWORD maximum_restart_delay_ms = 300'000;
constexpr std::uint64_t healthy_runtime_ms = 300'000;

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
            continue;
        }
        if (character == L'"') {
            quoted.append(backslashes * 2 + 1, L'\\');
            quoted.push_back(L'"');
        } else {
            quoted.append(backslashes, L'\\');
            quoted.push_back(character);
        }
        backslashes = 0;
    }
    quoted.append(backslashes * 2, L'\\');
    quoted.push_back(L'"');
    return quoted;
}

std::wstring child_command_line(const std::vector<std::wstring>& arguments, std::size_t executable_index) {
    std::wstring command_line;
    for (std::size_t index = executable_index; index < arguments.size(); ++index) {
        if (!command_line.empty()) command_line.push_back(L' ');
        command_line.append(quote_argument(arguments[index]));
    }
    return command_line;
}

void write_probe() {
    constexpr std::string_view message =
        "{\"schema\":\"uci_arena_service_launcher_probe_v1\","
        "\"windows_gui_subsystem\":true,\"create_no_window\":true,"
        "\"persistent_restart\":true,\"initial_restart_delay_ms\":5000,"
        "\"maximum_restart_delay_ms\":300000}\n";
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == nullptr || output == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    WriteFile(output, message.data(), static_cast<DWORD>(message.size()), &written, nullptr);
}

HANDLE open_null(DWORD access, SECURITY_ATTRIBUTES* security) {
    return CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, security, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
}

struct LaunchResult {
    int exit_code = launcher_error;
    std::uint64_t runtime_ms = 0;
};

LaunchResult launch_hidden(const std::vector<std::wstring>& arguments, std::size_t executable_index) {
    if (arguments.size() <= executable_index || arguments[executable_index].empty()) {
        return {ERROR_INVALID_PARAMETER, 0};
    }

    SECURITY_ATTRIBUTES security{};
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    const auto null_input = open_null(GENERIC_READ, &security);
    const auto null_output = open_null(GENERIC_WRITE, &security);
    if (null_input == INVALID_HANDLE_VALUE || null_output == INVALID_HANDLE_VALUE) {
        if (null_input != INVALID_HANDLE_VALUE) CloseHandle(null_input);
        if (null_output != INVALID_HANDLE_VALUE) CloseHandle(null_output);
        return {launcher_error, 0};
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = null_input;
    startup.hStdOutput = null_output;
    startup.hStdError = null_output;

    PROCESS_INFORMATION process{};
    auto command_line = child_command_line(arguments, executable_index);
    const auto started_at = GetTickCount64();
    const auto created = CreateProcessW(
        arguments[executable_index].c_str(), command_line.data(), nullptr, nullptr, TRUE,
        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
        nullptr, nullptr, &startup, &process
    );
    const auto create_error = created == FALSE ? GetLastError() : ERROR_SUCCESS;
    CloseHandle(null_input);
    CloseHandle(null_output);
    if (created == FALSE) {
        return {static_cast<int>(create_error == ERROR_SUCCESS ? launcher_error : create_error), 0};
    }

    const auto job = CreateJobObjectW(nullptr, nullptr);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == nullptr ||
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) == FALSE ||
        AssignProcessToJobObject(job, process.hProcess) == FALSE || ResumeThread(process.hThread) == static_cast<DWORD>(-1)) {
        if (job != nullptr) TerminateJobObject(job, launcher_error);
        else TerminateProcess(process.hProcess, launcher_error);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        if (job != nullptr) CloseHandle(job);
        return {launcher_error, GetTickCount64() - started_at};
    }
    CloseHandle(process.hThread);

    const auto wait = WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exit_code = launcher_error;
    if (wait != WAIT_OBJECT_0 || GetExitCodeProcess(process.hProcess, &exit_code) == FALSE) {
        TerminateJobObject(job, launcher_error);
        exit_code = launcher_error;
    }
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return {static_cast<int>(exit_code), GetTickCount64() - started_at};
}

int supervise_hidden(const std::vector<std::wstring>& arguments) {
    DWORD restart_delay_ms = initial_restart_delay_ms;
    for (;;) {
        const auto result = launch_hidden(arguments, 2);
        if (result.runtime_ms >= healthy_runtime_ms) restart_delay_ms = initial_restart_delay_ms;
        Sleep(restart_delay_ms);
        restart_delay_ms = std::min(maximum_restart_delay_ms, restart_delay_ms * 2);
    }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    const auto arguments = command_line_arguments();
    if (arguments.size() == 2 && arguments[1] == L"--probe") {
        write_probe();
        return 0;
    }
    if (arguments.size() >= 4 && arguments[1] == L"--restart") return supervise_hidden(arguments);
    return launch_hidden(arguments, 1).exit_code;
}
