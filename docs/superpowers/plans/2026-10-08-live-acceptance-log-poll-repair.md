# Live acceptance mutable log observation repair

The signed 1.0.33 live harness stopped its owned adapter when an append changed
`adapter.ndjson` during exact read admission. The strict immutable-file reader
is correct; the harness owns retrying a mutable diagnostic observation.

1. Reproduce append between admission/open and fstat/read through the actual
   exact-file boundary, including the initial pre-spawn offset.
2. Defer only typed append-compatible changes while a fresh exact classification
   proves the same bounded regular object with nondecreasing size. During-read
   truncation or shrink must reject before it can replay an old completion.
   Preserve unread offset and partial
   record. Retain the original deadline and cleanup lifecycle.
3. Prove later completed-event delivery, partial-record preservation, pre-attempt
   exclusion, repeated mutation/deadline, substitution, quota, unknown error and
   descriptor-close failure behavior. Do not change `exact-file.mjs`.
4. Reconcile the owning harness specification and candidate version 1.0.34;
   run focused tests, the complete Node24 suite and all four owning checks.
5. Freeze a reviewable PR. Merge and official release are separate guarded
   operations. No live API, token read, installation or engine change is needed.
