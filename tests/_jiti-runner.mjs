/**
 * Self-contained runner for testing the worker with jiti execArgv.
 * 
 * This is invoked as a separate process from worker-edge.test.ts
 * to avoid IPC issues with node:test's test runner.
 * 
 * Usage: node _jiti-runner.mjs <params.json>
 */

import { fork } from "node:child_process";
import { readFileSync } from "node:fs";

const paramsPath = process.argv[2];
if (!paramsPath) {
  console.error("Missing params file arg");
  process.exit(1);
}

const params = JSON.parse(readFileSync(paramsPath, "utf-8"));
const { dir, diffStat, diffContent, allFiles, workerPath, jitiRegister } = params;

const child = fork(workerPath, [], {
  execArgv: ["--import", jitiRegister],
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});

let done = false;

child.on("message", (msg) => {
  if (msg?.type === "result") {
    process.stdout.write(JSON.stringify(msg) + "\n");
    done = true;
    setTimeout(() => process.exit(0), 200);
  }
});

child.on("exit", (code) => {
  if (!done) {
    process.exit(code || 1);
  }
});

child.send({
  type: "start",
  params: {
    dir,
    diffStat,
    diffContent,
    allFiles,
    stagedCommits: false,
    excludePatterns: [],
    minChanges: 1,
    subagentModel: undefined,
    subagentGroupingMinFiles: 4,
    subagentMessageMinFiles: 3,
    subagentThinkingLevel: "off",
  },
});

// Safety timeout
setTimeout(() => {
  if (!done) {
    process.exit(2);
  }
}, 10_000);
