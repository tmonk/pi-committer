import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, "../src/index.mjs");
const e2e = process.env.PI_COMMITTER_E2E === "1" ? test : test.skip;
const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-committer-v2-e2e-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Pi Committer E2E"]);
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "initial"]);
  return dir;
}

function configure(dir, asyncThreshold) {
  // staged_commits=false keeps /commit deterministic here: the fixture's own
  // .pi-committer.toml is an untracked repo file (the engine commits untracked
  // files like the legacy runtime did), so grouping would split it into a
  // second chore commit. A single group makes the commit count exact.
  writeFileSync(path.join(dir, ".pi-committer.toml"), [
    "[committer]",
    "enabled = true",
    'trigger_mode = "manual"',
    'message_mode = "deterministic"',
    "deterministic_fallback = true",
    "staged_commits = false",
    `async_threshold = ${asyncThreshold}`,
    "",
  ].join("\n"));
}

function runPi(dir, input) {
  return execFileSync("pi", ["-p", "-e", EXT_PATH], {
    cwd: dir,
    input,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

e2e("new extension entry commits synchronously", () => {
  const dir = repo();
  try {
    configure(dir, 0);
    writeFileSync(path.join(dir, "feature.ts"), "export const value = 1;\n");
    const before = Number(git(dir, ["rev-list", "--count", "HEAD"]));
    runPi(dir, "/commit\n");
    assert.equal(Number(git(dir, ["rev-list", "--count", "HEAD"])), before + 1);
    assert.equal(git(dir, ["status", "--porcelain"]), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

e2e("new extension entry completes a background immutable snapshot", async () => {
  const dir = repo();
  try {
    configure(dir, 2);
    writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
    const before = Number(git(dir, ["rev-list", "--count", "HEAD"]));
    runPi(dir, "/commit\n");
    const deadline = Date.now() + 30000;
    let count = before;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      count = Number(git(dir, ["rev-list", "--count", "HEAD"]));
      if (count > before) break;
    }
    assert.ok(count > before, `expected background commit after ${before}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
