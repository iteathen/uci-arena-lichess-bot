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

Version 1.3.0 adds a bounded Windows Task Scheduler COM adapter. Existing native
helper sources and bytes are unchanged. This platform adapter does not replace
the native process-incarnation query or grant PID termination authority.

## Exact Windows task observation and control

```js
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
const scheduler = new WindowsTaskScheduler();
const result = await scheduler.perform({ operation: 'inspect', task_path: '\\Owned Task' },
  { timeoutMs: 5000, signal });
```

The public `./windows-task-scheduler-contract` JSON export declares closed
schemas and bounds. `perform` snapshots data-property requests before any await;
unknown fields, getters, symbol keys, XML byte-bound/DTD violations, mismatched before-image
hashes, duplicate instance IDs, and invalid deadlines throw `TypeError` before
invocation. The task is one named task in the Scheduler root folder. Each platform
invocation runs the package's fixed static `.ps1` file under the absolute system
Windows PowerShell executable, with JSON on stdin, bounded stdout, and discarded
stderr. `powershellExecutable` can explicitly select another absolute executable;
`platform` and `invoke` are explicit qualification transport substitutions.
Cancellation requires an actual unproxied `AbortSignal`; options with accessors
or invalid signals are rejected before invocation. The adapter uses stable
platform event methods instead of caller-overridden subscription properties,
and installs the child join before further setup. Any post-spawn setup failure
stops and joins that owned child before a failed result can return.

Request fields depend on the operation:

| Operation | Fields in addition to `operation` and `task_path` |
| --- | --- |
| `inspect` | none |
| `set_enabled` | `expected_definition_xml`, `expected_xml_sha256`, `enabled` |
| `stop_instances` | `expected_definition_xml`, `expected_xml_sha256`, `instance_guids` |
| `register` | `expected_definition_xml`, `expected_xml_sha256`, `definition_xml` |
| `delete`, `run` | `expected_definition_xml`, `expected_xml_sha256` |

Before-image hashes are lowercase SHA256 of the exact UTF-8 observed XML text.
Only `register` and `delete` permit both before-image fields to be null, meaning
expected absence. A registered observation returns its full bounded XML and
digest, enabled bit, exact running-instance GUIDs, and principal facts. An absent
observation has null XML/digest/enabled/principal/action and no instances. A registered
observation also carries the closed typed Exec tuple
`action: { command, arguments, working_directory }`. These are the exact strings
captured once from `IExecAction`, without interpretation or requoting, each at
most 32767 UTF-16 units and well-formed Unicode; command is nonempty. All
definition-owned XML, enabled, principal and action facts come from one captured
TaskDefinition. Consumers admit their own action/root grammar rather than parsing
XML or assuming a private Task Scheduler formatter. No native process commandline
is queried. Before-state action data remains provider-owned and must not be
copied into arbitrary public logs.
Successful
observations admit one Exec action under the current Windows SID,
InteractiveToken (3), and LeastPrivilege (0). Windows account aliases are resolved
to a SID through the OS. This matters because
[GetInstances](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-iregisteredtask-getinstances)
can omit instances above the caller's security context. Unknown identity or
unsupported privilege fails, rather than reporting an empty owned task.

Before mutation, the actual task must match its admitted before-image. Registration
and enabled-state retries also recognize the complete already-satisfied target.
Canonical comparison keeps every task field and attribute, action leaf text,
and declared setting; it normalizes account naming and inter-element XML
formatting only. Task Scheduler is not an atomic compare-and-swap store: providers
must serialize their own intent and observe ambiguous completion. The SDK owns
neither provider root selection nor the before-state transaction. Providers must
validate exact public component actions and persist their own restoration record
before gate/task changes. Equal roots or task names alone convey no rollback meaning.

`stop_instances` rejects a running instance not in the supplied admitted GUID set;
already-ended supplied instances are harmless. `delete` requires an empty task.
Registration uses `TASK_CREATE_OR_UPDATE | TASK_IGNORE_REGISTRATION_TRIGGERS`
(38); registration triggers cannot implicitly start a preserved inactive task.
Other scheduled triggers remain in the definition, so provider gate/intent
sequencing remains required.
`run` requires an enabled admitted task and avoids starting another instance when
one is already present; after-observation must retain the exact admitted definition.
Its completed result is not daemon readiness. The result
is a closed completed/failed envelope. Failed output carries only a category and
optional unsigned HRESULT; no arbitrary PowerShell/exception bytes are copied.
A timeout or cancellation stops and joins only the owned platform helper, and
does not imply no task effect. The provider must inspect and converge afterward.

Task definition defaults need actual readback qualification. On the current
Windows fixture host, registration rewrites explicit
`UseUnifiedSchedulingEngine=false` to `true`; strict verification reports that
as an identity mismatch. New fixtures select `true` explicitly. A saved prior
definition with different effective settings cannot be claimed restored without
matching readback. This is a scoped platform observation, not a new semantic
default; Microsoft's [schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-useunifiedschedulingengine-settingstype-element)
continues to declare false as the default.

Set `UCI_ARENA_TASK_SCHEDULER_FIXTURE=1` on Windows to run the guarded actual COM
tests. The child-running cycle additionally requires the explicitly configured
`UCI_ARENA_NATIVE_HELPER`; it independently observes the exact owned child
incarnation gone after cleanup. Tests operate only on fresh
`UCI Arena SDK Fixture <UUID>` tasks, with an
owned temporary Node child and exact-action cleanup. Registration-trigger suppression/retry, changed
definition rejection, enabled retries, run/gate/drain/delete, helper timeout and
cancellation are tested. These fixtures grant no installed-service replacement
claim. Other platforms and normal package tests explicitly skip these cases.

Version 1.3.1 corrects explicit logon-trigger user comparison. Windows may
rewrite a declared SID as an account name on registration. The SDK translates
each nonempty `LogonTrigger.UserId` through Windows SID resolution, just like
the principal, before semantic comparison. Empty UserId remains any-user;
different identities, trigger enabled state and delay remain different. Unknown
accounts fail closed. No trigger is removed, defaulted or broadened. The request,
result and contract wire versions stay at v1; version 1.3.0 source snapshots
remain historical. The actual owned UUID fixture covers SID/account readback,
retry, distinct/empty users and trigger-setting rejection without touching
installed provider tasks. See Microsoft's
[LogonTrigger.UserId contract](https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger-userid).

Version 1.3.2 corrects running-instance visibility for Hidden tasks. The owned
Windows fixture reproduced a live current-user Hidden Node task for which
`GetInstances(0)` returned no instances. The SDK now uses
[GetRunningTasks(1)](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskservice-getrunningtasks),
whose explicit flag includes Hidden tasks, then filters the captured admitted
`Task.Path` with ordinal case-insensitive comparison. The selected principal is
verified first. Only foreign entries' paths are read for this filter; their
definitions, actions, principals and instance GUIDs are not read or returned.
The 4096-entry scan and 16-selected-instance bounds fail closed on overflow,
without reporting absence. Duplicate/empty selected GUIDs also fail. Definition
and exact-instance mutation guards remain unchanged. The v1 wire schemas stay
unchanged; the contract adds the explicit scan bound. Historical 1.3.1 snapshots
remain distinct. Guarded fixtures cover both the existing plain task and two
self-expiring Hidden tasks, rejecting another task's GUID set before stopping
the selected task and positively joining both owned children and task deletion.

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
