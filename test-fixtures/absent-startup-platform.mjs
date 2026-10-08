import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// This subprocess fixture forbids platform mutations and models only an absent task.
childProcess.execFile = (file, args, options, callback) => {
  if (file !== "schtasks.exe" || args[0] !== "/Query") {
    throw new Error(`Forbidden platform operation in absent-startup fixture: ${file}`);
  }
  if (process.env.UCI_ARENA_FIXTURE_TASK_STATE) {
    const active = process.env.UCI_ARENA_FIXTURE_TASK_STATE === "active";
    callback(null, `Status: ${active ? "Running" : "Ready"}\nScheduled Task State: ${active ? "Enabled" : "Disabled"}\nLast Result: 0\n`, "");
    return;
  }
  const error = Object.assign(new Error("The system cannot find the file specified"), {
    code: 1, stderr: "ERROR: The system cannot find the file specified.",
  });
  callback(error, "", error.stderr);
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file, args, options) =>
  new Promise((resolve, reject) => childProcess.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
syncBuiltinESMExports();
