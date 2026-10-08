import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { hashExactFileSync } from "./exact-file.mjs";
import { safePublicPath } from "./continuous-game-qualification.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const selectedHelper = process.env.UCI_ARENA_NATIVE_HELPER?.trim();

test("declared component closure imports continuous adapters and captures a real child through the explicit public helper", {
  skip: process.platform === "win32" && !selectedHelper ? "explicit qualified native helper path was not supplied" : false,
  timeout: 15000,
}, (t) => {
  const staged = mkdtempSync(path.join(os.tmpdir(), "uci-bot-component-conformance-"));
  t.after(() => {
    assert.equal(path.dirname(staged), path.resolve(os.tmpdir()));
    rmSync(staged, { recursive: true, force: true });
  });
  const definition = JSON.parse(readFileSync(path.join(here, "packaging/component-definition.json")));
  for (const mapping of definition.include) {
    const target = path.join(staged, mapping.target);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(here, mapping.source), target, { recursive: true });
  }
  for (const name of ["background-service-runtime", "time-profile-contract"]) {
    const target = path.join(staged, "node_modules", "@uci-arena", name);
    mkdirSync(target, { recursive: true });
    copyFileSync(path.join(here, "vendor", name, "package.json"), path.join(target, "package.json"));
    cpSync(path.join(here, "vendor", name, "src"), path.join(target, "src"), { recursive: true });
  }
  cpSync(path.join(here, "node_modules", "chess.js"), path.join(staged, "node_modules", "chess.js"), { recursive: true });
  let helperSha = null;
  if (process.platform === "win32") {
    safePublicPath(selectedHelper, "explicit conformance helper");
    helperSha = hashExactFileSync(selectedHelper, { maximumBytes: 16 * 1024 * 1024, label: "Explicit public helper" }).sha256;
    mkdirSync(path.join(staged, "native"));
    copyFileSync(selectedHelper, path.join(staged, "native", "uci_arena_background_guard.exe"));
    assert.equal(hashExactFileSync(path.join(staged, "native", "uci_arena_background_guard.exe"),
      { maximumBytes: 16 * 1024 * 1024, label: "Staged public helper" }).sha256, helperSha);
  }
  const source = `import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {UciEngine} from ${JSON.stringify(pathToFileURL(path.join(staged, "lichess-adapter.mjs")).href)};
const engine=new UciEngine({executable:process.execPath,uci_options:{},shutdown_grace_ms:1000});
engine.child=spawn(process.execPath,['--eval',"process.stdin.once('data',()=>process.stdin.destroy())"],
 {windowsHide:true,stdio:['pipe','pipe','pipe']});
await once(engine.child,'spawn');
try {
 const identity=engine.captureContinuousChildIdentity();
 const close=await engine.close({requireCleanExit:true});
 process.stdout.write(JSON.stringify({identity,close}));
} finally { if(engine.child) await engine.close(); }`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: staged, windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: "utf8",
  }));
  assert.equal(result.identity.schema, "uci_arena_process_instance_identity_v1");
  assert.ok(result.identity.start_token);
  assert.equal(result.close.clean_exit, true);
  assert.equal(result.close.close_observed, true);
  if (helperSha) t.diagnostic(`explicit staged public helper ${helperSha}`);
});
