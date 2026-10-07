import { rm } from "node:fs/promises";

// Test-only lifecycle owner: one cleanup failure cannot strand the fixture's
// other resources or replace the test body's primary failure.
export function registerProviderFixtureCleanup(t, fixture) {
  t.after(async () => {
    const failures = [];
    if (fixture.child) {
      let timer;
      try {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill("SIGKILL");
        await Promise.race([
          fixture.exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Provider fixture child did not terminate")), 5_000);
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    const outcomes = await Promise.allSettled([
      fixture.api.close(),
      rm(fixture.root, { recursive: true, force: true }),
      fixture.token.close(),
    ]);
    failures.push(...outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Provider fixture cleanup failed");
  });
}
