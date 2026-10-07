#include <windows.h>
#include <powrprof.h>
#include "process_instance_query.hpp"

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace {

int probe() {
    LASTINPUTINFO input{};
    input.cbSize = sizeof(input);
    const bool have_input = GetLastInputInfo(&input) != FALSE;
    const auto input_idle_ms = have_input
        ? static_cast<std::uint32_t>(GetTickCount() - input.dwTime)
        : 0U;

    SYSTEM_POWER_STATUS power{};
    const bool have_power = GetSystemPowerStatus(&power) != FALSE;
    const bool on_battery = have_power && power.ACLineStatus == 0;
    const bool battery_saver = have_power && power.SystemStatusFlag != 0;

    struct SystemPowerInfoData {
        ULONG max_idleness_allowed;
        ULONG idleness;
        ULONG time_remaining;
        UCHAR cooling_mode;
    } system_power{};
    const auto power_status = CallNtPowerInformation(
        SystemPowerInformation,
        nullptr,
        0,
        &system_power,
        static_cast<ULONG>(sizeof(system_power))
    );
    const auto cooling_mode = power_status == ERROR_SUCCESS
        ? static_cast<unsigned long>(system_power.cooling_mode)
        : 0UL;

    struct ProcessorPowerInfo {
        ULONG number;
        ULONG max_mhz;
        ULONG current_mhz;
        ULONG mhz_limit;
        ULONG max_idle_state;
        ULONG current_idle_state;
    };
    const auto processor_count = GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    std::vector<ProcessorPowerInfo> processor_power(processor_count);
    unsigned long processor_limit_percent = 100;
    if (!processor_power.empty() && CallNtPowerInformation(
            ProcessorInformation,
            nullptr,
            0,
            processor_power.data(),
            static_cast<ULONG>(processor_power.size() * sizeof(ProcessorPowerInfo))) == ERROR_SUCCESS) {
        for (const auto& processor : processor_power) {
            if (processor.max_mhz > 0) {
                processor_limit_percent = std::min(
                    processor_limit_percent,
                    static_cast<unsigned long>(100ULL * processor.mhz_limit / processor.max_mhz)
                );
            }
        }
    }

    std::cout
        << "{\"schema\":\"uci_arena_background_service_native_probe_v1\""
        << ",\"on_battery\":" << (on_battery ? "true" : "false")
        << ",\"battery_saver\":" << (battery_saver ? "true" : "false")
        << ",\"input_idle_ms\":" << input_idle_ms
        << ",\"cooling_mode\":" << cooling_mode
        << ",\"processor_limit_percent\":" << processor_limit_percent
        << ",\"capabilities\":[\"process_instance_query_v1\"]"
        << "}\n";
    return 0;
}

int query_process_instance(DWORD process_id) {
    using namespace uci_arena::background_service_runtime;
    const auto observation = uci_arena::background_service_runtime::query_process_instance(process_id);
    std::cout << "{\"schema\":\"uci_arena_process_instance_query_v1\",\"state\":";
    if (observation.state == ProcessInstanceState::present) {
        std::cout << "\"present\",\"identity\":{\"schema\":\"uci_arena_process_instance_identity_v1\""
            << ",\"platform\":\"win32\",\"pid\":" << process_id
            << ",\"start_token\":\"" << observation.creation_utc_ticks << "\""
            << ",\"executable_path\":" << json_string(observation.executable_path)
            << ",\"boot_id\":\"\"}";
    } else std::cout << (observation.state == ProcessInstanceState::absent ? "\"absent\"" : "\"unverifiable\"");
    std::cout << "}\n";
    return std::cout.good() ? 0 : 2;
}

struct CourtesyResult {
    bool idle_priority = false;
    bool eco_qos = false;
};

CourtesyResult apply_process_courtesy(HANDLE process) {
    CourtesyResult result{};
    result.idle_priority = SetPriorityClass(process, IDLE_PRIORITY_CLASS) != FALSE;

#if defined(PROCESS_POWER_THROTTLING_CURRENT_VERSION) && defined(PROCESS_POWER_THROTTLING_EXECUTION_SPEED)
    PROCESS_POWER_THROTTLING_STATE throttling{};
    throttling.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    throttling.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    throttling.StateMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    result.eco_qos = SetProcessInformation(
        process, ProcessPowerThrottling, &throttling, sizeof(throttling)) != FALSE;
#endif

    using NtSetInformationProcess = LONG(NTAPI*)(HANDLE, ULONG, PVOID, ULONG);
    const auto ntdll = GetModuleHandleW(L"ntdll.dll");
    const auto set_information = reinterpret_cast<NtSetInformationProcess>(
        ntdll == nullptr ? nullptr : GetProcAddress(ntdll, "NtSetInformationProcess")
    );
    if (set_information != nullptr) {
        ULONG very_low_io_priority = 0;
        constexpr ULONG process_io_priority = 33;
        set_information(process, process_io_priority, &very_low_io_priority, sizeof(very_low_io_priority));
    }
    return result;
}

struct CpuSetCandidate {
    ULONG id = 0;
    WORD group = 0;
    BYTE core = 0;
    BYTE logical = 0;
    BYTE efficiency = 0;
};

struct CpuSetResult {
    bool available = false;
    bool heterogeneous = false;
    bool applied = false;
    unsigned int eligible = 0;
    unsigned int selected = 0;
    unsigned int minimum_efficiency_class = 0;
    unsigned int maximum_efficiency_class = 0;
};

CpuSetResult apply_efficiency_cpu_sets(HANDLE process, unsigned int maximum_cores) {
    CpuSetResult result{};
    if (maximum_cores == 0) return result;

    ULONG required = 0;
    GetSystemCpuSetInformation(nullptr, 0, &required, process, 0);
    if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) return result;
    std::vector<unsigned char> buffer(required);
    if (GetSystemCpuSetInformation(
            reinterpret_cast<PSYSTEM_CPU_SET_INFORMATION>(buffer.data()), required,
            &required, process, 0) == FALSE) return result;

    std::vector<CpuSetCandidate> candidates;
    BYTE minimum_class = std::numeric_limits<BYTE>::max();
    BYTE maximum_class = 0;
    for (ULONG offset = 0; offset + sizeof(SYSTEM_CPU_SET_INFORMATION) <= required;) {
        const auto* information = reinterpret_cast<const SYSTEM_CPU_SET_INFORMATION*>(buffer.data() + offset);
        if (information->Size == 0 || offset + information->Size > required) break;
        if (information->Type == CpuSetInformation) {
            const auto flags = information->CpuSet.AllFlags;
            const bool parked = (flags & SYSTEM_CPU_SET_INFORMATION_PARKED) != 0;
            const bool allocated_elsewhere = (flags & SYSTEM_CPU_SET_INFORMATION_ALLOCATED) != 0 &&
                (flags & SYSTEM_CPU_SET_INFORMATION_ALLOCATED_TO_TARGET_PROCESS) == 0;
            if (!parked && !allocated_elsewhere) {
                candidates.push_back({
                    information->CpuSet.Id, information->CpuSet.Group, information->CpuSet.CoreIndex,
                    information->CpuSet.LogicalProcessorIndex, information->CpuSet.EfficiencyClass,
                });
                minimum_class = std::min(minimum_class, information->CpuSet.EfficiencyClass);
                maximum_class = std::max(maximum_class, information->CpuSet.EfficiencyClass);
            }
        }
        offset += information->Size;
    }
    if (candidates.empty()) return result;
    result.available = true;
    result.eligible = static_cast<unsigned int>(candidates.size());
    result.minimum_efficiency_class = minimum_class;
    result.maximum_efficiency_class = maximum_class;
    result.heterogeneous = minimum_class < maximum_class;
    if (!result.heterogeneous) return result;

    std::sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
        return std::tie(left.efficiency, left.group, left.core, left.logical, left.id) <
            std::tie(right.efficiency, right.group, right.core, right.logical, right.id);
    });
    std::vector<ULONG> selected;
    WORD previous_group = std::numeric_limits<WORD>::max();
    BYTE previous_core = std::numeric_limits<BYTE>::max();
    for (const auto& candidate : candidates) {
        if (candidate.efficiency != minimum_class) break;
        if (candidate.group == previous_group && candidate.core == previous_core) continue;
        selected.push_back(candidate.id);
        previous_group = candidate.group;
        previous_core = candidate.core;
        if (selected.size() >= maximum_cores) break;
    }
    if (selected.empty()) return result;
    result.applied = SetProcessDefaultCpuSets(
        process, selected.data(), static_cast<ULONG>(selected.size())) != FALSE;
    result.selected = result.applied ? static_cast<unsigned int>(selected.size()) : 0;
    return result;
}

int apply_process_profile(DWORD process_id, unsigned int efficiency_cores) {
    const auto process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_SET_LIMITED_INFORMATION,
        FALSE,
        process_id
    );
    if (process == nullptr) return 2;
    const auto courtesy = apply_process_courtesy(process);
    const auto cpu_sets = apply_efficiency_cpu_sets(process, efficiency_cores);
    CloseHandle(process);
    std::cout
        << "{\"schema\":\"uci_arena_background_service_process_profile_v1\""
        << ",\"applied\":" << (courtesy.idle_priority ? "true" : "false")
        << ",\"idle_priority\":" << (courtesy.idle_priority ? "true" : "false")
        << ",\"eco_qos\":" << (courtesy.eco_qos ? "true" : "false")
        << ",\"cpu_sets_available\":" << (cpu_sets.available ? "true" : "false")
        << ",\"heterogeneous\":" << (cpu_sets.heterogeneous ? "true" : "false")
        << ",\"cpu_set_applied\":" << (cpu_sets.applied ? "true" : "false")
        << ",\"eligible_cpu_sets\":" << cpu_sets.eligible
        << ",\"selected_cpu_sets\":" << cpu_sets.selected
        << ",\"minimum_efficiency_class\":" << cpu_sets.minimum_efficiency_class
        << ",\"maximum_efficiency_class\":" << cpu_sets.maximum_efficiency_class
        << "}\n";
    return courtesy.idle_priority ? 0 : 2;
}

bool heartbeat_stale(const std::string& filename, std::uint64_t stale_seconds) {
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (GetFileAttributesExA(filename.c_str(), GetFileExInfoStandard, &attributes) == FALSE) return true;
    FILETIME now_file_time{};
    GetSystemTimeAsFileTime(&now_file_time);
    ULARGE_INTEGER now{};
    now.LowPart = now_file_time.dwLowDateTime;
    now.HighPart = now_file_time.dwHighDateTime;
    ULARGE_INTEGER written{};
    written.LowPart = attributes.ftLastWriteTime.dwLowDateTime;
    written.HighPart = attributes.ftLastWriteTime.dwHighDateTime;
    const auto maximum_age = stale_seconds * 10'000'000ULL;
    return now.QuadPart > written.QuadPart && now.QuadPart - written.QuadPart > maximum_age;
}

int supervise(DWORD process_id, const std::string& heartbeat_file, std::uint64_t stale_seconds) {
    const auto process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE,
        FALSE,
        process_id
    );
    if (process == nullptr) {
        std::cerr << "Could not open UCI Arena service process " << process_id << "\n";
        return 2;
    }

    apply_process_courtesy(process);

    const auto job = CreateJobObjectW(nullptr, nullptr);
    if (job != nullptr) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE) {
            AssignProcessToJobObject(job, process);
        }
    }

    for (;;) {
        const auto wait = WaitForSingleObject(process, 15'000);
        if (wait == WAIT_OBJECT_0) break;
        if (wait != WAIT_TIMEOUT) break;
        if (heartbeat_stale(heartbeat_file, stale_seconds)) {
            std::cerr << "UCI Arena service heartbeat is stale; terminating process " << process_id << "\n";
            TerminateProcess(process, 70);
            WaitForSingleObject(process, 10'000);
            break;
        }
    }
    if (job != nullptr) CloseHandle(job);
    CloseHandle(process);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--probe") return probe();
    if (argc == 3 && std::string_view(argv[1]) == "--query-process-instance") {
        const std::string_view input(argv[2]);
        DWORD process_id = 0;
        const auto parsed = std::from_chars(input.data(), input.data() + input.size(), process_id);
        if (parsed.ec != std::errc{} || parsed.ptr != input.data() + input.size() || process_id == 0) return 2;
        return query_process_instance(process_id);
    }
    if (argc == 5 && std::string_view(argv[1]) == "--apply-process-profile" &&
        std::string_view(argv[3]) == "--efficiency-cores") {
        try {
            const auto process_id = static_cast<DWORD>(std::stoul(argv[2]));
            const auto efficiency_cores = static_cast<unsigned int>(std::stoul(argv[4]));
            return process_id == 0 || efficiency_cores > 2 ? 2 :
                apply_process_profile(process_id, efficiency_cores);
        } catch (...) {
            return 2;
        }
    }
    if (argc == 7 && std::string_view(argv[1]) == "--supervise" &&
        std::string_view(argv[3]) == "--heartbeat" && std::string_view(argv[5]) == "--stale-seconds") {
        try {
            const auto process_id = static_cast<DWORD>(std::stoul(argv[2]));
            const auto stale_seconds = std::stoull(argv[6]);
            return process_id == 0 || stale_seconds == 0 ? 2 : supervise(process_id, argv[4], stale_seconds);
        } catch (...) {
            return 2;
        }
    }
    std::cerr << "Usage: uci_arena_background_guard --probe | --query-process-instance <pid> | --apply-process-profile <pid> --efficiency-cores <0..2> | "
        "--supervise <pid> --heartbeat <path> --stale-seconds <seconds>\n";
    return 2;
}
