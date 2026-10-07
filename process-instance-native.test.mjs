import assert from "node:assert/strict";
import test from "node:test";
import { currentProcessIdentity, probeProcessInstance, sameProcessInstance } from "./process-instance-identity.mjs";

test("native provider current-instance query succeeds under the existing identity deadline", {
  skip: process.platform !== "win32" ? "Windows component query helper" : false,
}, () => {
  const current = currentProcessIdentity();
  assert.equal(current.schema, "uci_arena_process_instance_identity_v1");
  assert.equal(current.pid, process.pid);
  assert.equal(current.platform, "win32");
  assert.equal(typeof current.start_token, "string");
  const queried = probeProcessInstance(process.pid);
  assert.equal(queried.state, "present");
  assert.equal(sameProcessInstance(current, queried.identity), true);
});
