// Child process for the lock tests: takes the skills lock N times with the identity (owner line) given on the command
// line, checks that its own line stays in the owner file while it holds the lock, and logs the events to a file.
// Usage: bun run skills-lock-contender.ts <factory dir> <key> <owner line> <rounds> <log file>
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "../../hub/features/factory-skills";

const [dir, key, line, rounds, log] = process.argv.slice(2);
const owner = join(dir, "agents", `${key}.skills-lock`, "owner");
for (let i = 0; i < Number(rounds); i++) {
  const release = await takeLock(dir, key, 30000, "hub", line);
  appendFileSync(log, `acquire ${line}\n`);
  for (let k = 0; k < 3; k++) {
    let now = "";
    try {
      now = readFileSync(owner, "utf8").trim();
    } catch {}
    if (now !== line) appendFileSync(log, `VIOLATION ${line} saw [${now}]\n`);
    await new Promise((r) => setTimeout(r, 5));
  }
  appendFileSync(log, `release ${line}\n`);
  release();
}
