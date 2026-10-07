# Background service runtime

This package owns product-neutral background resource leases, resource inspection,
and explicitly configured Windows native helpers. Consumers vendor a pinned package
snapshot and translate its public DTOs in their own adapters; they do not discover
sibling installations or import this package's private native implementation.

Version 1.2.0 adds the read-only `process_instance_query_v1` capability to the
existing `uci_arena_background_guard --probe` result. A consumer must qualify this
capability from its selected immutable helper closure before requiring the query.
`NativeResourceHelper.queryProcessInstanceSync(pid, { timeoutMs } = {})` invokes
only the configured absolute helper path. It has no discovery or PowerShell fallback.

## Exact process instance query

`uci_arena_background_guard --query-process-instance <pid>` accepts decimal PIDs
from 1 through 4294967295. Invalid requests exit 2 without a response. Valid
requests emit the closed `uci_arena_process_instance_query_v1` envelope with
`state` equal to `present`, `absent`, or `unverifiable`. Only a present result has
an `identity`:

```json
{
  "schema": "uci_arena_process_instance_query_v1",
  "state": "present",
  "identity": {
    "schema": "uci_arena_process_instance_identity_v1",
    "platform": "win32",
    "pid": 123,
    "start_token": "639111234567890123",
    "executable_path": "C:\\runtime\\service.exe",
    "boot_id": ""
  }
}
```

The public `./process-instance-query-contract` export declares the schema, fields,
admission domain, and bounds. Its `timeout_ms` is both the default and maximum
identity query deadline of 2000 ms. Callers may select a smaller `timeoutMs` to
fit their remaining lifecycle budget. A selected timeout must be a safe integer
from 1 through 2000 ms; invalid values throw `TypeError` before process creation.
The exact selected budget reaches the native invocation without expansion.
The synchronous JavaScript invocation limits output to 262144 bytes. This
accommodates a 32767 UTF-16-unit executable path, including UTF-8 and JSON escaping expansion,
with bounded envelope overhead. A fatal UTF-8 decoder consumes bounded raw bytes
without replacing malformed byte sequences. Parsing rejects oversized, malformed,
mismatched, or extra-field responses. Invocation failure or timeout yields `unverifiable`.

One read-only process handle owns the PID, creation time, and executable path
observations. Zero-time handle waits fence exit before and after observation.
The query closes that handle on every return and does not change priority,
affinity, resource policy, or process lifetime. Windows permits these queries with
limited query rights; failure to obtain those rights is not proof of absence.
An admitted PID with `ERROR_INVALID_PARAMETER`, or a signaled opened process
handle, is absent. Access denial and all other unknown observations are
unverifiable. See Microsoft's [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess),
[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes),
[QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew),
and [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject) contracts.

`start_token` stays a decimal 64-bit string and has the existing .NET UTC
`DateTime.Ticks` meaning: 100 ns units since 0001-01-01. Windows' UTC calendar
conversion and the original sub-millisecond remainder preserve that meaning
without JavaScript rounding. See [DateTime.Ticks](https://learn.microsoft.com/en-us/dotnet/api/system.datetime.ticks)
and [DateTime.FromFileTimeUtc](https://learn.microsoft.com/en-us/dotnet/api/system.datetime.fromfiletimeutc).
It is an instance comparison fact, not a PID-only termination authority. A consumer
must retain its existing complete identity comparison and fail-closed behavior.

## Validation

Run `npm test` for the portable lease, resource, and closed query contract tests.
On Windows, configure the existing native directory with `BUILD_TESTING=ON`,
build it, and run `ctest --test-dir <build> -C Release --output-on-failure` for UTC
conversion, owned-child access denial/exit, PID fencing, and handle-leak probes.
The denial fixture first proves its owned child is live and an independent
`OpenProcess` returns `ERROR_ACCESS_DENIED`. It uses a new test-owned restricted
token on the test thread because enabled debug privilege can bypass a process
DACL. It restores the exact prior thread context and closes token handles,
including injected failure unwinding; no normal process or machine token is
modified. Ambient and restricted observations report their actual states.
See [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
and [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess).
Set `UCI_ARENA_NATIVE_HELPER` to the absolute built guard path before `npm test`
to additionally run the native capability, cold query, and .NET identity
compatibility probes. Without that explicit path, these three native integration
tests are visibly skipped. The PowerShell oracle has a separate 15 s test bound;
it does not change or substitute for the 2 s native runtime deadline.
`UCI_ARENA_PROCESS_IDENTITY_TEST_ORACLE` may explicitly select another absolute
PowerShell executable for qualification, such as the workflow's own
`Join-Path $PSHOME 'pwsh.exe'`. Both runtimes use the same independent .NET
`Process.StartTime.ToUniversalTime().Ticks` and executable-path observations.
Without the variable, the existing absolute Windows PowerShell path under
`SystemRoot` remains the local default. Relative or malformed selections fail;
the tests perform no executable discovery or fallback. This variable is consumed
only by qualification tests, after the first native query has completed.
