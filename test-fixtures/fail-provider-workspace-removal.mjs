import fs from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const roots = [];
const originalTemporaryDirectory = filesystem.mkdtemp;
filesystem.mkdtemp = async (...args) => {
  const root = await originalTemporaryDirectory(...args);
  roots.push(root);
  fs.writeFileSync(process.env.UCI_ARENA_FIXTURE_ROOT_JOURNAL, JSON.stringify(roots));
  return root;
};
const originalRemoval = filesystem.rm;
filesystem.rm = async (target, ...args) => {
  if (/^uci-arena-(?:provider-probe|startup-cooldown)-/u.test(path.basename(String(target)))) {
    throw Object.assign(new Error("injected provider workspace removal failure"), { code: "EBUSY" });
  }
  return originalRemoval(target, ...args);
};
syncBuiltinESMExports();
