#include "process_instance_query.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>

namespace runtime = uci_arena::background_service_runtime;

namespace {
void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

const char* state_name(runtime::ProcessInstanceState state) {
    if (state == runtime::ProcessInstanceState::present) return "present";
    if (state == runtime::ProcessInstanceState::absent) return "absent";
    return "unverifiable";
}

struct TokenHandle {
    HANDLE value = nullptr;
    TokenHandle() = default;
    TokenHandle(const TokenHandle&) = delete;
    TokenHandle& operator=(const TokenHandle&) = delete;
    ~TokenHandle() {
        if (!close()) {
            const auto error = GetLastError();
            std::cerr << "fixture token close failed: " << error << '\n';
        }
    }
    bool close() noexcept {
        const auto owned = value;
        value = nullptr;
        return owned == nullptr || CloseHandle(owned) != FALSE;
    }
};

class RestrictedQueryScope {
public:
    RestrictedQueryScope() {
        if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
            TRUE, &prior_.value) == FALSE) {
            require(GetLastError() == ERROR_NO_TOKEN, "cannot capture fixture's prior thread token");
            require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &source_.value) != FALSE,
                "cannot open fixture's process token for restricted duplication");
        }
        const auto source = prior_.value != nullptr ? prior_.value : source_.value;
        require(CreateRestrictedToken(source, DISABLE_MAX_PRIVILEGE, 0, nullptr, 0, nullptr,
            0, nullptr, &restricted_.value) != FALSE, "cannot create owned restricted query token");
        require(ImpersonateLoggedOnUser(restricted_.value) != FALSE, "cannot apply owned restricted query token");
        impersonating_ = true;
    }
    RestrictedQueryScope(const RestrictedQueryScope&) = delete;
    RestrictedQueryScope& operator=(const RestrictedQueryScope&) = delete;
    ~RestrictedQueryScope() {
        if (!restore()) {
            const auto error = GetLastError();
            std::cerr << "fixture impersonation restore failed: " << error << '\n';
        }
    }
    void finish() {
        require(restore(), "cannot restore fixture's original thread context");
        TokenHandle restored;
        const auto opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &restored.value);
        const auto error = opened != FALSE ? ERROR_SUCCESS : GetLastError();
        if (prior_.value == nullptr) {
            require(opened == FALSE && error == ERROR_NO_TOKEN, "restricted thread token remained installed");
        } else {
            TOKEN_STATISTICS prior{}, current{};
            DWORD size = 0;
            require(opened != FALSE
                && GetTokenInformation(prior_.value, TokenStatistics, &prior, sizeof(prior), &size) != FALSE
                && GetTokenInformation(restored.value, TokenStatistics, &current, sizeof(current), &size) != FALSE
                && prior.TokenId.LowPart == current.TokenId.LowPart && prior.TokenId.HighPart == current.TokenId.HighPart,
                "fixture restored a different prior thread token");
        }
        require(restored.close() && restricted_.close() && source_.close() && prior_.close(),
            "cannot close fixture-owned token handles");
    }
private:
    bool restore() noexcept {
        if (!impersonating_) return true;
        const auto restored = prior_.value != nullptr ? SetThreadToken(nullptr, prior_.value) : RevertToSelf();
        if (restored != FALSE) impersonating_ = false;
        return restored != FALSE;
    }
    TokenHandle prior_, source_, restricted_;
    bool impersonating_ = false;
};

struct OwnedChild {
    PROCESS_INFORMATION process{};
    ~OwnedChild() {
        if (process.hProcess != nullptr) {
            TerminateProcess(process.hProcess, 0);
            WaitForSingleObject(process.hProcess, 2000);
            CloseHandle(process.hProcess);
        }
        if (process.hThread != nullptr) CloseHandle(process.hThread);
    }
};

void restricted_token_cleanup() {
    DWORD before = 0, after = 0;
    require(GetProcessHandleCount(GetCurrentProcess(), &before) != FALSE, "cannot count scope cleanup handles");
    {
        RestrictedQueryScope outer;
        TokenHandle expected;
        TOKEN_STATISTICS original{}, restored{};
        DWORD size = 0;
        require(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &expected.value) != FALSE
            && GetTokenInformation(expected.value, TokenStatistics, &original, sizeof(original), &size) != FALSE,
            "cannot capture outer fixture token identity");
        struct FixtureFailure {};
        try {
            RestrictedQueryScope inner;
            throw FixtureFailure{};
        } catch (const FixtureFailure&) {}
        TokenHandle current;
        require(OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &current.value) != FALSE
            && GetTokenInformation(current.value, TokenStatistics, &restored, sizeof(restored), &size) != FALSE
            && original.TokenId.LowPart == restored.TokenId.LowPart && original.TokenId.HighPart == restored.TokenId.HighPart,
            "failure unwinding did not restore the exact prior fixture token");
        require(expected.close() && current.close(), "cannot close fixture token identity observation handles");
        outer.finish();
    }
    require(GetProcessHandleCount(GetCurrentProcess(), &after) != FALSE && before == after,
        "failure unwinding leaked a fixture token handle");
}

void dates_and_encoding() {
    SYSTEMTIME time{};
    time.wYear = 1601; time.wMonth = 1; time.wDay = 1;
    std::uint64_t ticks = 0;
    require(runtime::datetime_utc_ticks(time, 0, ticks) && ticks == 504'911'232'000'000'000ULL, "FILETIME epoch mismatch");
    time.wYear = 1970;
    require(runtime::datetime_utc_ticks(time, 1234, ticks) && ticks == 621'355'968'000'001'234ULL, "UTC epoch or 100 ns precision mismatch");
    time.wYear = 2000; time.wMonth = 2; time.wDay = 29;
    require(runtime::datetime_utc_ticks(time, 0, ticks) && ticks == 630'873'792'000'000'000ULL, "Gregorian leap day mismatch");
    time.wYear = 1900;
    require(!runtime::datetime_utc_ticks(time, 0, ticks), "invalid century leap day admitted");
    time.wYear = 9999; time.wMonth = 12; time.wDay = 31;
    time.wHour = 23; time.wMinute = 59; time.wSecond = 59; time.wMilliseconds = 999;
    require(runtime::datetime_utc_ticks(time, 9999, ticks) && ticks == 3'155'378'975'999'999'999ULL, "DateTime maximum mismatch");
    require(!runtime::datetime_utc_ticks(time, 10000, ticks), "invalid sub-millisecond remainder admitted");
    require(runtime::json_string("a\"\\\n") == "\"a\\\"\\\\\\u000a\"", "JSON control escaping mismatch");
    const std::string unicode = "\xe7\x95\x8c";
    require(runtime::json_string(unicode) == "\"" + unicode + "\"", "UTF-8 was changed by JSON encoding");
    const std::string maximum_path(32767 * 3, 'x');
    require(runtime::json_string(maximum_path).size() == maximum_path.size() + 2, "domain-size path truncated");
}

void handles_and_denial() {
    const auto pid = GetCurrentProcessId();
    const auto current = runtime::query_process_instance(pid);
    require(current.state == runtime::ProcessInstanceState::present && !current.executable_path.empty(), "current identity unavailable");
    DWORD handles_before = 0, handles_after = 0;
    require(GetProcessHandleCount(GetCurrentProcess(), &handles_before) != FALSE, "cannot count handles");
    for (int i = 0; i < 256; ++i) {
        const auto repeated = runtime::query_process_instance(pid);
        require(repeated.state == runtime::ProcessInstanceState::present
            && repeated.creation_utc_ticks == current.creation_utc_ticks
            && repeated.executable_path == current.executable_path, "identity changed between exact queries");
    }
    require(GetProcessHandleCount(GetCurrentProcess(), &handles_after) != FALSE && handles_before == handles_after, "query leaked a handle");
    require(runtime::query_process_instance(0).state == runtime::ProcessInstanceState::unverifiable, "PID zero reported absent");
    require(runtime::inspect_process_handle(nullptr, pid).state == runtime::ProcessInstanceState::unverifiable, "invalid handle reported absent");

    std::array<wchar_t, 32768> executable{};
    require(GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size())) != 0, "cannot locate test executable");
    std::wstring command = L"\"" + std::wstring(executable.data()) + L"\"";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    OwnedChild child;
    require(CreateProcessW(executable.data(), command.data(), nullptr, nullptr, FALSE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child.process) != FALSE, "cannot create owned suspended child");
    const auto child_identity = runtime::query_process_instance(child.process.dwProcessId);
    require(child_identity.state == runtime::ProcessInstanceState::present, "owned child identity unavailable");
    require(runtime::inspect_process_handle(child.process.hProcess, pid).state == runtime::ProcessInstanceState::unverifiable, "wrong PID accepted for held handle");

    alignas(DWORD) std::array<BYTE, SECURITY_MAX_SID_SIZE> sid{};
    DWORD sid_size = static_cast<DWORD>(sid.size());
    require(CreateWellKnownSid(WinWorldSid, nullptr, sid.data(), &sid_size) != FALSE, "cannot create denied fixture SID");
    const auto acl_size = sizeof(ACL) + sizeof(ACCESS_DENIED_ACE) - sizeof(DWORD) + sid_size;
    std::vector<BYTE> acl_bytes(acl_size);
    auto* acl = reinterpret_cast<ACL*>(acl_bytes.data());
    SECURITY_DESCRIPTOR descriptor{};
    require(InitializeAcl(acl, static_cast<DWORD>(acl_bytes.size()), ACL_REVISION) != FALSE
        && AddAccessDeniedAce(acl, ACL_REVISION, PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, sid.data()) != FALSE
        && InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) != FALSE
        && SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) != FALSE
        && SetKernelObjectSecurity(child.process.hProcess, DACL_SECURITY_INFORMATION, &descriptor) != FALSE,
        "cannot deny new query handles to owned child");
    constexpr DWORD query_rights = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
    runtime::ProcessHandle ambient(OpenProcess(query_rights, FALSE, child.process.dwProcessId));
    const auto ambient_error = ambient.get() != nullptr ? ERROR_SUCCESS : GetLastError();
    require(ambient.close(), "cannot close ambient denial-fixture observation handle");
    const auto ambient_state = runtime::query_process_instance(child.process.dwProcessId).state;
    std::cout << "denial fixture ambient: open_error=" << ambient_error
        << " query_state=" << state_name(ambient_state) << '\n';

    DWORD before_tokens = 0, after_tokens = 0;
    require(GetProcessHandleCount(GetCurrentProcess(), &before_tokens) != FALSE, "cannot count pre-token handles");
    {
        // Restrict only a new test-owned token: enabled SeDebugPrivilege can
        // bypass a process DACL, so ambient privilege is not denial evidence.
        RestrictedQueryScope restricted;
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "denial fixture child is no longer live");
        runtime::ProcessHandle denied(OpenProcess(query_rights, FALSE, child.process.dwProcessId));
        const auto denied_error = denied.get() != nullptr ? ERROR_SUCCESS : GetLastError();
        require(denied.get() == nullptr && denied_error == ERROR_ACCESS_DENIED,
            "denial fixture did not prove ERROR_ACCESS_DENIED; actual_error=" + std::to_string(denied_error));
        require(denied.close(), "cannot close restricted denial-fixture observation handle");
        require(WaitForSingleObject(child.process.hProcess, 0) == WAIT_TIMEOUT, "denied child exited before public query");
        const auto observed = runtime::query_process_instance(child.process.dwProcessId).state;
        std::cout << "denial fixture restricted: live=true open_error=" << denied_error
            << " query_state=" << state_name(observed) << '\n';
        require(observed == runtime::ProcessInstanceState::unverifiable,
            std::string("proven access-denied query returned state=") + state_name(observed));
        restricted.finish();
    }
    require(GetProcessHandleCount(GetCurrentProcess(), &after_tokens) != FALSE && before_tokens == after_tokens,
        "restricted query fixture leaked a handle");
    require(TerminateProcess(child.process.hProcess, 0) != FALSE
        && WaitForSingleObject(child.process.hProcess, 2000) == WAIT_OBJECT_0, "owned child did not exit within cleanup bound");
    require(runtime::inspect_process_handle(child.process.hProcess, child.process.dwProcessId).state == runtime::ProcessInstanceState::absent, "exited held process reported present");
}
} // namespace

int main() {
    try {
        dates_and_encoding();
        restricted_token_cleanup();
        handles_and_denial();
        std::cout << "process instance native tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
