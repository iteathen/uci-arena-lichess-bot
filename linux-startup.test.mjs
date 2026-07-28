import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  SYSTEMD_UNIT_NAME,
  buildSystemdUnit,
  startupAction,
  startupUnitPath,
  systemdEscapeArgument,
} from "./linux-startup.mjs";

function options() {
  return {
    config: "deploy/lichess/config.uci_arena.template.yml",
    tokenFile: "secrets/lichess_bot_token.txt",
    expectedAccount: "operator-bot",
    runtimeDir: "runtime_state/lichess",
    profile: "runtime_state/model/single.json",
    timeProfile: "runtime_state/model/time.json",
    temporalCurve: "runtime_state/model/curve.json",
    capacityProfile: "runtime_state/model/capacity.json",
    modelRoot: "engine/runtime/models/model/engine",
  };
}

test("Linux startup action runs the foreground adapter with path-only credential input", () => {
  const action = startupAction(options());
  assert.equal(action.command, path.resolve(process.execPath));
  assert.equal(action.arguments[0].endsWith("lichess-adapter.mjs"), true);
  assert.equal(action.arguments.includes("--token-file"), true);
  assert.equal(action.arguments.includes("--temporal-curve-profile"), true);
  assert.equal(
    action.arguments[action.arguments.indexOf("--token-file") + 1],
    path.resolve("secrets/lichess_bot_token.txt"),
  );
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
