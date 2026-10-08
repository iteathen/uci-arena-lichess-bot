import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  SYSTEMD_UNIT_NAME,
  buildSystemdUnit,
  classifyLinuxStartup,
  parseSystemdArguments,
  recoverLinuxStartup,
  reconcileSystemdUnit,
  retargetSystemdUnit,
  startupAction,
  startupUnitPath,
  systemdEscapeArgument,
} from "./linux-startup.mjs";

function options() {
  return {
    config: "config.uci_arena.template.yml",
    tokenFile: path.join(path.parse(path.resolve(".")).root, "operator-secrets", "lichess-bot.token"),
    expectedAccount: "operator-bot",
    runtimeDir: "runtime_state/lichess",
    profile: "runtime_state/model/single.json",
    timeProfile: "runtime_state/model/time.json",
    temporalCurve: "runtime_state/model/curve.json",
    capacityProfile: "runtime_state/model/capacity.json",
    modelRoot: "engine/runtime/models/model/engine",
  };
}

test("Linux startup recovery starts only the existing enabled user unit", async () => {
  const calls = [];
  let active = "inactive";
  const recovered = await recoverLinuxStartup({
    platform: "linux",
    query: async () => ({ installed: true, enabled: "enabled", active }),
    systemctlImpl: async (argumentsList) => {
      calls.push(argumentsList);
      active = "active";
    },
  });
  assert.deepEqual(calls, [["start", SYSTEMD_UNIT_NAME]]);
  assert.equal(recovered.active, "active");
  assert.equal(recovered.registrationMutated, false);
  await assert.rejects(recoverLinuxStartup({
    platform: "linux",
    query: async () => ({ installed: true, enabled: "disabled", active: "inactive" }),
    systemctlImpl: async () => calls.push("unexpected"),
  }), /disabled/);
  assert.equal(calls.length, 1);
});

test("Linux startup projection distinguishes active, pending, disabled, and absent supervision", () => {
  assert.equal(classifyLinuxStartup({ installed: false }).supervisionState, "unregistered");
  assert.equal(classifyLinuxStartup({
    installed: true, enabled: "enabled", active: "active",
  }).supervisionState, "active");
  const pending = classifyLinuxStartup({
    installed: true, enabled: "enabled", active: "activating",
  });
  assert.equal(pending.supervisionState, "restart_pending");
  assert.equal(pending.restartPending, true);
  assert.equal(classifyLinuxStartup({
    installed: true, enabled: "disabled", active: "inactive",
  }).supervisionState, "disabled");
});

test("Linux startup action runs the foreground adapter with path-only credential input", () => {
  const action = startupAction(options());
  assert.equal(action.command, path.resolve(process.execPath));
  assert.equal(action.arguments[0].endsWith("lichess-adapter.mjs"), true);
  assert.equal(action.arguments.includes("--token-file"), true);
  assert.equal(action.arguments.includes("--temporal-curve-profile"), true);
  assert.equal(
    action.arguments[action.arguments.indexOf("--token-file") + 1],
    path.resolve(options().tokenFile),
  );
});

test("systemd replacement retargets only the receipt-owned component root", () => {
  const previousRoot = path.resolve("test-components", "lichess.adapter", "1.0.9");
  const replacementRoot = path.resolve("test-components", "lichess.adapter", "1.0.10");
  const tokenFile = path.resolve("operator-private", "lichess.token");
  const original = `WorkingDirectory=${systemdEscapeArgument(previousRoot)}\nExecStart=${[
    "/usr/bin/node", path.join(previousRoot, "lichess-adapter.mjs"), "--token-file", tokenFile,
  ].map(systemdEscapeArgument).join(" ")}\n`;
  const updated = retargetSystemdUnit(original, previousRoot, replacementRoot);
  assert.equal(updated.includes(systemdEscapeArgument(previousRoot)), false);
  assert.equal(updated.includes(systemdEscapeArgument(replacementRoot)), true);
  assert.equal(updated.includes(systemdEscapeArgument(tokenFile)), true);
  assert.equal(retargetSystemdUnit(updated, replacementRoot, replacementRoot), updated);
});

test("systemd replacement rejects root lookalikes and preserves external sibling paths", () => {
  const previousRoot = path.resolve("components", "old");
  const replacementRoot = path.resolve("components", "old", "new");
  const token = path.resolve("components", "old-sibling", "operator.token");
  const unit = `WorkingDirectory=${systemdEscapeArgument(previousRoot)}\nExecStart=${[
    "/usr/bin/node", path.join(previousRoot, "lichess-adapter.mjs"), "--token-file", token,
  ].map(systemdEscapeArgument).join(" ")}\n`;
  const updated = retargetSystemdUnit(unit, previousRoot, replacementRoot);
  assert.equal(updated.includes(systemdEscapeArgument(token)), true);
  assert.throws(() => retargetSystemdUnit(updated, previousRoot, replacementRoot), /receipt-owned component root/);
  assert.equal(retargetSystemdUnit(updated, replacementRoot, replacementRoot), updated);
});

test("systemd user unit is network ordered, restartable, and non-root", () => {
  const unit = buildSystemdUnit(options());
  assert.match(unit, /^Description=UCI Arena Lichess Bot API adapter$/m);
  assert.match(unit, /^After=network-online\.target$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.doesNotMatch(unit, /^User=/m);
  assert.match(unit, /--expected-account/);
});

test("systemd path honors XDG_CONFIG_HOME and argument escaping is literal", () => {
  assert.equal(
    startupUnitPath({
      environment: { XDG_CONFIG_HOME: "/tmp/arena config" },
      homeDirectory: "/unused",
    }),
    path.resolve("/tmp/arena config", "systemd", "user", SYSTEMD_UNIT_NAME),
  );
  assert.equal(systemdEscapeArgument('a b"$%\\c'), '"a b\\"$$%%\\\\c"');
  assert.throws(() => systemdEscapeArgument("bad\nvalue"), /control characters/);
});

test("post-requalification systemd reconciliation replaces stale bindings and preserves credentials", () => {
  const stale = {
    ...options(),
    profile: "runtime_state/model/stale-single.json",
    capacityProfile: "runtime_state/model/stale-capacity.json",
    modelRoot: "engine/runtime/models/stale/engine",
  };
  const current = {
    ...options(),
    profile: "runtime_state/model/current-single.json",
    capacityProfile: "runtime_state/model/current-capacity.json",
    modelRoot: "engine/runtime/models/current/engine",
  };
  delete current.tokenFile;
  delete current.expectedAccount;
  const reconciled = reconcileSystemdUnit(buildSystemdUnit(stale), current);
  for (const stalePath of [stale.profile, stale.capacityProfile, stale.modelRoot]) {
    assert.equal(reconciled.includes(systemdEscapeArgument(path.resolve(stalePath))), false);
  }
  for (const currentPath of [current.profile, current.capacityProfile, current.modelRoot]) {
    assert.equal(reconciled.includes(systemdEscapeArgument(path.resolve(currentPath))), true);
  }
  assert.equal(
    reconciled.includes(systemdEscapeArgument(path.resolve(stale.tokenFile))),
    true,
  );
  assert.match(reconciled, /--expected-account/);
});

test("systemd startup argument parser is the inverse of canonical escaping", () => {
  const values = ["plain", "path with spaces\\", 'embedded"quote', "money$percent%"];
  assert.deepEqual(parseSystemdArguments(values.map(systemdEscapeArgument).join(" ")), values);
});
