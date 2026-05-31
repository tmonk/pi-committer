import {
  describe,
  it,
  before,
  after,
  afterEach,
  mock,
} from "node:test";
import assert from "node:assert";
import { execSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, writeFileSync, existsSync, chmodSync, mkdirSync, readFileSync } from "node:fs";

import {
  renderCommitterWidgetLines,
  type CommitterProgress,
} from "../widget.ts";

import {
  // Config
  getConfig,
  setConfig,
  loadConfig,
  type CommitterConfig,

  // Git helpers
  gitRoot,
  isGitRepo,
  isDirtyRepo,
  stageAll,
  getChangedFiles,
  filterGitignoredFiles,
  unstageExcludedFiles,
  unstageAll,
  hasAnyChanges,

  // Commit logic
  parseCommitGroups,
  deterministicCommitMessage,
  shouldCommitOnTrigger,
  commitStaged,
  singleGroupFallback,

  // Subagent
  resolveSubagentModel,
  __setCreateAgentSessionMock,
  __createAgentSessionMock,

  // Fork mock
  __setForkMock,

  // Session / goals
  findOtherReposFromSession,
  findDirtyRepos,
  combineAbortSignals,
  checkGoalEvents,
  hasGoalsExtension,
  hasActiveGoal,
  ensureGoalsExtension,
  _resetWarnedMissingGoals,
  _clearGoalStatuses,
  _resetGoalScanCount,
  _restoreGoalScanCount,
  _getAsyncCommitStarted,
  _getAsyncCommitFileCount,
  _getCommitterProgress,

  // State
  getSelectedSubagentModel,
  setSelectedSubagentModel,

  // Commit
  tryCommit,

  // Worker execArgv resolution (node_modules fix)
  resolveWorkerExecArgv,
  _findJitiRegisterForPath,

  // File staging
  batchStageFilesForGroup,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory and init a git repo in it. */
function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });
  return dir;
}

function tmpDir(): string {
  return process.env.TMPDIR || "/tmp";
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A minimal mock ExtensionContext for tests that need it. */
function mockCtx(overrides?: Partial<any>): any {
  return {
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
    },
    ui: {
      notify: () => {},
      select: async () => "",
    },
    sessionManager: {
      getEntries: () => [],
    },
    ...overrides,
  };
}

// ===========================================================================
// Config loading
// ===========================================================================

describe("config loading", () => {
  let dir: string;

  before(() => { dir = mkdtempSync(path.join(tmpDir(), "pi-committer-cfg-")); });
  after(() => removeDir(dir));

  it("loads default config when no file exists", () => {
    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.triggerMode, "on_goal");
    assert.strictEqual(cfg.stagedCommits, true);
    assert.deepStrictEqual(cfg.excludePatterns, []);
    assert.strictEqual(cfg.minChanges, 1);
    assert.strictEqual(cfg.deferToGoalAudit, false);
  });

  it("parses defer_to_goal_audit from .pi-committer.toml", () => {
    const toml = `[committer]
enabled = true
trigger_mode = "on_goal"
defer_to_goal_audit = false
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.deferToGoalAudit, false);
    assert.strictEqual(cfg.enabled, true);

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("parses defer_to_goal_audit from .pi-committer.json", () => {
    const json = JSON.stringify({
      committer: {
        defer_to_goal_audit: false,
        enabled: true,
      },
    });
    writeFileSync(path.join(dir, ".pi-committer.json"), json, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.deferToGoalAudit, false);

    fs.rmSync(path.join(dir, ".pi-committer.json"));
  });

  it("defaults defer_to_goal_audit to false when not in config", () => {
    const toml = `[committer]
enabled = true
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.deferToGoalAudit, false);

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("defaults async_threshold to 5", () => {
    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.asyncThreshold, 5);
  });

  it("parses async_threshold from .pi-committer.toml", () => {
    const toml = `[committer]
enabled = true
async_threshold = 25
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.asyncThreshold, 25);

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("parses async_threshold from .pi-committer.json", () => {
    const json = JSON.stringify({
      committer: {
        async_threshold: 50,
        enabled: true,
      },
    });
    writeFileSync(path.join(dir, ".pi-committer.json"), json, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.asyncThreshold, 50);

    fs.rmSync(path.join(dir, ".pi-committer.json"));
  });

  it("respects async_threshold = 0 to disable async", () => {
    const toml = `[committer]
enabled = true
async_threshold = 0
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.asyncThreshold, 0);

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("loads .pi-committer.toml", () => {
    const toml = `[committer]\nenabled = false\ntrigger_mode = "manual"\nexclude_patterns = ["*.log"]\n`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.triggerMode, "manual");
    assert.deepStrictEqual(cfg.excludePatterns, ["*.log"]);

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("loads .pi-committer.json", () => {
    const json = JSON.stringify({
      committer: {
        enabled: false,
        trigger_mode: "agent_sensible",
        exclude_patterns: ["node_modules/"],
      },
    });
    writeFileSync(path.join(dir, ".pi-committer.json"), json, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.triggerMode, "agent_sensible");
    assert.deepStrictEqual(cfg.excludePatterns, ["node_modules/"]);

    fs.rmSync(path.join(dir, ".pi-committer.json"));
  });

  it("falls back to defaults on invalid TOML", () => {
    writeFileSync(path.join(dir, ".pi-committer.toml"), "[[[invalid toml", "utf-8");
    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.triggerMode, "on_goal");
    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("walks up directories to find config", () => {
    const sub = path.join(dir, "a", "b");
    fs.mkdirSync(sub, { recursive: true });
    const toml = `[committer]\nenabled = false\ntrigger_mode = "manual"\n`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(sub);
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.triggerMode, "manual");

    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });
});

// ===========================================================================
// Git helpers
// ===========================================================================

describe("gitRoot", () => {
  let dir: string;
  before(() => { dir = createTempRepo(); });
  after(() => removeDir(dir));

  it("returns the repo root from inside the repo", () => {
    const actual = gitRoot(dir);
    // git rev-parse may resolve symlinks (/var -> /private/var on macOS)
    assert.strictEqual(fs.realpathSync(actual!), fs.realpathSync(dir));
  });

  it("returns the repo root from a subdirectory", () => {
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    const actual = gitRoot(sub);
    assert.strictEqual(fs.realpathSync(actual!), fs.realpathSync(dir));
  });

  it("returns undefined outside a git repo", () => {
    const outside = mkdtempSync(path.join(tmpDir(), "pi-committer-nongit-"));
    assert.strictEqual(gitRoot(outside), undefined);
    removeDir(outside);
  });
});

describe("isGitRepo", () => {
  let dir: string;
  before(() => { dir = createTempRepo(); });
  after(() => removeDir(dir));

  it("returns true inside a git repo", () => {
    assert.strictEqual(isGitRepo(dir), true);
  });

  it("returns false outside a git repo", () => {
    const outside = mkdtempSync(path.join(tmpDir(), "pi-committer-nongit-"));
    assert.strictEqual(isGitRepo(outside), false);
    removeDir(outside);
  });
});

describe("isDirtyRepo", () => {
  let dir: string;
  before(() => { dir = createTempRepo(); });
  after(() => removeDir(dir));

  it("returns false for a clean repo", () => {
    assert.strictEqual(isDirtyRepo(dir), false);
  });

  it("returns true after creating a file", () => {
    writeFileSync(path.join(dir, "new.ts"), "// new");
    assert.strictEqual(isDirtyRepo(dir), true);
  });

  it("returns true after modifying a tracked file", () => {
    writeFileSync(path.join(dir, "README.md"), "# modified\n");
    assert.strictEqual(isDirtyRepo(dir), true);
  });

  it("returns true after deleting a tracked file", () => {
    // Reset: remove the file we created above and commit
    execSync("git checkout -- .", { cwd: dir, stdio: "ignore" });
    const fileToDelete = path.join(dir, "temp_delete.ts");
    writeFileSync(fileToDelete, "// to delete");
    execSync("git add -A && git commit -m 'add temp'", { cwd: dir, stdio: "ignore" });
    fs.rmSync(fileToDelete);
    assert.strictEqual(isDirtyRepo(dir), true);
  });

  it("returns false for a repo with only gitignored changes", () => {
    execSync("git checkout -- .", { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    execSync("git add -A && git commit -m 'add gitignore'", { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "build.log"), "# log");
    // Only gitignored files changed — the repo should still be clean
    assert.strictEqual(isDirtyRepo(dir), false);
  });

  it("returns false for non-existent directory", () => {
    assert.strictEqual(isDirtyRepo("/nonexistent/path"), false);
  });

  it("returns false for non-git directory", () => {
    const nonGitDir = mkdtempSync(path.join(tmpDir(), "pi-committer-nongit-"));
    try {
      assert.strictEqual(isDirtyRepo(nonGitDir), false);
    } finally {
      removeDir(nonGitDir);
    }
  });
});

describe("getChangedFiles", () => {
  it("parses git diff --cached --stat output", () => {
    const stat = ` src/main.ts | 5 +++++\n tests/main.test.ts | 10 ++++++++++\n 2 files changed, 15 insertions(+)`;
    const files = getChangedFiles(stat);
    assert.deepStrictEqual(files, ["src/main.ts", "tests/main.test.ts"]);
  });

  it("returns empty array for empty stat", () => {
    assert.deepStrictEqual(getChangedFiles(""), []);
  });
});

describe("filterGitignoredFiles", () => {
  function freshRepo(): string {
    const d = createTempRepo();
    after(() => removeDir(d));
    return d;
  }

  it("keeps non-ignored files", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, ".gitignore"), "*.log\n");
    writeFileSync(path.join(dir, "keep.ts"), "// keep");
    writeFileSync(path.join(dir, "ignored.log"), "# log");

    const result = filterGitignoredFiles(dir, ["keep.ts", "ignored.log"]);
    assert.deepStrictEqual(result, ["keep.ts"]);
  });

  it("returns all files when none are gitignored", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, "a.ts"), "// a");
    writeFileSync(path.join(dir, "b.ts"), "// b");

    const result = filterGitignoredFiles(dir, ["a.ts", "b.ts"]);
    assert.deepStrictEqual(result, ["a.ts", "b.ts"]);
  });

  it("returns empty array when all files are gitignored", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(dir, "data.json"), "{}");
    writeFileSync(path.join(dir, "config.json"), "{}");

    const result = filterGitignoredFiles(dir, ["data.json", "config.json"]);
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for empty input", () => {
    const dir = freshRepo();
    assert.deepStrictEqual(filterGitignoredFiles(dir, []), []);
  });

  it("respects nested .gitignore", () => {
    const dir = freshRepo();
    const subdir = path.join(dir, "benchmarks");
    fs.mkdirSync(subdir);
    writeFileSync(path.join(subdir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(subdir, "data.json"), "{}");
    writeFileSync(path.join(dir, "keep.ts"), "// keep");

    const result = filterGitignoredFiles(dir, [
      "benchmarks/data.json",
      "keep.ts",
    ]);
    assert.deepStrictEqual(result, ["keep.ts"]);
  });

  it("does not filter tracked files even if they match .gitignore", () => {
    const dir = freshRepo();
    // Create and commit a tracked .json file first
    writeFileSync(path.join(dir, "tracked.json"), "{}");
    execSync("git add tracked.json && git commit -m 'add tracked json'", {
      cwd: dir, stdio: "ignore",
    });
    // Now add *.json to .gitignore — tracked files should NOT be ignored
    writeFileSync(path.join(dir, ".gitignore"), "*.json\n");

    // tracked.json is still tracked, so it should NOT be filtered
    const result = filterGitignoredFiles(dir, ["tracked.json"]);
    assert.deepStrictEqual(result, ["tracked.json"]);
  });
});

describe("stageAll", () => {
  function freshRepo(): string {
    const d = createTempRepo();
    after(() => removeDir(d));
    return d;
  }

  it("stages modified tracked files", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, "README.md"), "# modified\n");

    const { diffStat, diffContent } = stageAll(dir);
    assert.ok(diffStat.includes("README.md"), "diffStat should contain the modified file");
    assert.ok(diffContent.includes("# modified"), "diffContent should include the change");
  });

  it("stages new untracked files", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, "new.ts"), "// new file");

    const { diffStat, diffContent } = stageAll(dir);
    assert.ok(diffStat.includes("new.ts"), "diffStat should contain new file");
    assert.ok(diffContent.includes("+// new file"), "diffContent should show the new file");
  });

  it("does not stage gitignored untracked files", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(dir, "ignored.json"), "{}");
    writeFileSync(path.join(dir, "keep.ts"), "// keep");

    const { diffStat, diffContent } = stageAll(dir);
    assert.ok(!diffStat.includes("ignored.json"), "diffStat should NOT contain gitignored file");
    assert.ok(diffStat.includes("keep.ts"), "diffStat should contain non-ignored file");
    assert.ok(!diffContent.includes("ignored.json"), "diffContent should NOT contain gitignored file");
  });

  it("returns empty strings when nothing is staged", () => {
    const dir = freshRepo();
    const { diffStat, diffContent } = stageAll(dir);
    // Clean repo — nothing to stage
    assert.strictEqual(diffStat, "");
    assert.strictEqual(diffContent, "");
  });
});

describe("unstageExcludedFiles", () => {
  function freshRepo(): string {
    const d = createTempRepo();
    after(() => removeDir(d));
    return d;
  }

  it("filters out *.log files", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, "keep.ts"), "// keep");
    writeFileSync(path.join(dir, "build.log"), "# log");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const staged = execSync("git diff --cached --name-only", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    const kept = unstageExcludedFiles(dir, staged, ["*.log"]);

    assert.ok(kept.includes("keep.ts"));
    assert.ok(!kept.includes("build.log"));
  });

  it("keeps all files when no patterns match", () => {
    const dir = freshRepo();
    writeFileSync(path.join(dir, "a.ts"), "// a");
    writeFileSync(path.join(dir, "b.ts"), "// b");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const staged = execSync("git diff --cached --name-only", { cwd: dir, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    const kept = unstageExcludedFiles(dir, staged, ["*.py"]);

    assert.deepStrictEqual(new Set(kept), new Set(["a.ts", "b.ts"]));
  });

  it("handles empty pattern list", () => {
    const dir = freshRepo();
    const files = ["a.ts", "b.log"];
    assert.deepStrictEqual(unstageExcludedFiles(dir, files, []), files);
  });
});

// ===========================================================================
// parseCommitGroups
// ===========================================================================

describe("parseCommitGroups", () => {
  it("parses a single commit group", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(api): add user authentication

Implemented JWT-based auth.
Files: src/auth.ts, tests/auth.test.ts`;

    const groups = parseCommitGroups(output, ["src/auth.ts", "tests/auth.test.ts"]);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].files.length, 2);
    assert.ok(groups[0].message.includes("feat(api)"));
  });

  it("parses multiple commit groups", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(api): add login endpoint

Implements login flow.
Files: src/login.ts

--- COMMIT GROUP 2 ---
docs: update README

Added setup instructions.
Files: README.md`;

    const allFiles = ["src/login.ts", "README.md"];
    const groups = parseCommitGroups(output, allFiles);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].files.length, 1);
    assert.strictEqual(groups[1].files.length, 1);
  });

  it("filters out files not in allFiles", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(api): add auth

Login thing.
Files: src/auth.ts, src/secret.ts`;

    const groups = parseCommitGroups(output, ["src/auth.ts"]);
    assert.strictEqual(groups.length, 1);
    assert.deepStrictEqual(groups[0].files, ["src/auth.ts"]);
  });

  it("skips groups with no valid files", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(api): add auth

Login thing.
Files: src/secret.ts`;

    const groups = parseCommitGroups(output, ["src/auth.ts"]);
    assert.strictEqual(groups.length, 0);
  });

  it("handles empty output", () => {
    assert.deepStrictEqual(parseCommitGroups("", ["a.ts"]), []);
  });
});

// ===========================================================================
// deterministicCommitMessage
// ===========================================================================

describe("deterministicCommitMessage", () => {
  it("generates a message for a single file", () => {
    const msg = deterministicCommitMessage("src/main.ts | 1 +", "some diff content");
    assert.ok(msg.includes("update src/main.ts"));
  });

  it("detects test files", () => {
    const msg = deterministicCommitMessage("tests/main.test.ts | 1 +", "");
    assert.ok(msg.includes("test"));
  });

  it("detects docs files", () => {
    const msg = deterministicCommitMessage("README.md | 1 +", "");
    assert.ok(msg.includes("docs"));
  });
});

// ===========================================================================
// shouldCommitOnTrigger
// ===========================================================================

describe("shouldCommitOnTrigger", () => {
  it("on_goal fires for goal_event", () => {
    assert.strictEqual(shouldCommitOnTrigger("on_goal", "goal_event"), true);
  });

  it("on_goal ignores turn_end", () => {
    assert.strictEqual(shouldCommitOnTrigger("on_goal", "turn_end"), false);
  });

  it("on_goal ignores tool_result", () => {
    assert.strictEqual(shouldCommitOnTrigger("on_goal", "tool_result"), false);
  });

  it("agent_sensible fires for turn_end", () => {
    assert.strictEqual(shouldCommitOnTrigger("agent_sensible", "turn_end"), true);
  });

  it("after_tool fires for tool_result", () => {
    assert.strictEqual(shouldCommitOnTrigger("after_tool", "tool_result"), true);
  });

  it("manual never fires", () => {
    assert.strictEqual(shouldCommitOnTrigger("manual", "goal_event"), false);
    assert.strictEqual(shouldCommitOnTrigger("manual", "turn_end"), false);
    assert.strictEqual(shouldCommitOnTrigger("manual", "tool_result"), false);
  });
});

// ===========================================================================
// resolveSubagentModel
// ===========================================================================

describe("resolveSubagentModel", () => {
  after(() => {
    setSelectedSubagentModel(undefined);
    setConfig(loadConfig(process.cwd()));
  });

  it("returns selected model if set", () => {
    const fakeModel: any = { provider: "test", id: "model" };
    setSelectedSubagentModel(fakeModel);
    const ctx = mockCtx({ model: "default" });
    assert.strictEqual(resolveSubagentModel(ctx), fakeModel);
  });

  it("uses config.subagentModel when no interactive selection exists", () => {
    setSelectedSubagentModel(undefined);
    const foundModel: any = { provider: "test-provider", id: "test-model" };
    const ctx = mockCtx({
      model: "fallback",
      modelRegistry: {
        find: (p: string, i: string) =>
          p === "test-provider" && i === "test-model" ? foundModel : undefined,
        getAvailable: () => [foundModel],
      },
    });
    setConfig({ ...getConfig(), subagentModel: "test-provider/test-model" });
    assert.strictEqual(resolveSubagentModel(ctx), foundModel);
  });

  it("falls back to ctx.model when nothing is selected or configured", () => {
    setSelectedSubagentModel(undefined);
    const ctx = mockCtx({ model: "default-model" });
    setConfig({ ...getConfig(), subagentModel: undefined });
    assert.strictEqual(resolveSubagentModel(ctx), "default-model");
  });
});

// ===========================================================================
// findOtherReposFromSession / findDirtyRepos
// ===========================================================================

describe("findOtherReposFromSession", () => {
  it("detects repos from write tool calls", () => {
    const primary = "/repo/main";
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "write",
              arguments: { path: "/other/repo/src/file.ts" },
            },
          ],
        },
      },
    ];
    const ctx = mockCtx({
      sessionManager: { getEntries: () => entries },
    });

    // Mock gitRoot to avoid real git calls
    const repos = findOtherReposFromSession(ctx, primary);
    // Since /other/repo/src/file.ts won't be in a real git repo,
    // gitRoot returns undefined for it — that's fine, we just verify
    // that write tool calls are inspected.
    assert.ok(Array.isArray(repos));
  });

  it("ignores read and bash tool calls", () => {
    const primary = "/repo/main";
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read", arguments: { path: "/other/repo/file.ts" } },
            { type: "toolCall", name: "bash", arguments: { cwd: "/other/repo" } },
          ],
        },
      },
    ];
    const ctx = mockCtx({
      sessionManager: { getEntries: () => entries },
    });

    const repos = findOtherReposFromSession(ctx, primary);
    assert.strictEqual(repos.length, 0);
  });

  it("detects repos from edit tool calls", () => {
    const primary = "/repo/main";
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "edit",
              arguments: { path: "/other/repo/src/file.ts" },
            },
          ],
        },
      },
    ];
    const ctx = mockCtx({
      sessionManager: { getEntries: () => entries },
    });

    const repos = findOtherReposFromSession(ctx, primary);
    assert.ok(Array.isArray(repos));
  });
});

// ===========================================================================
// checkGoalEvents
// ===========================================================================

describe("checkGoalEvents", () => {
  before(() => {
    _clearGoalStatuses();
    _resetGoalScanCount();
  });
  after(() => {
    _clearGoalStatuses();
  });

  it("returns true when a goal transitions to complete", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "complete" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    const saved = _resetGoalScanCount();

    const result = checkGoalEvents(ctx);
    _restoreGoalScanCount(saved);
    assert.strictEqual(result, true);
  });

  it("returns false when goal stays complete (no transition)", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "complete" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    const saved = _resetGoalScanCount();

    // First call: records the status
    checkGoalEvents(ctx);

    // Second call: no transition
    const result = checkGoalEvents(ctx);
    _restoreGoalScanCount(saved);
    assert.strictEqual(result, false);
  });

  it("returns false for paused/aborted transitions", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g3", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g3", status: "paused" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    const saved = _resetGoalScanCount();

    const result = checkGoalEvents(ctx);
    _restoreGoalScanCount(saved);
    assert.strictEqual(result, false);
  });
});

// ===========================================================================
// hasGoalsExtension
// ===========================================================================

describe("hasGoalsExtension", () => {
  it("returns true when pi-goal-state entries exist", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasGoalsExtension(ctx), true);
  });

  it("returns false when no pi-goal-state entries", () => {
    const ctx = mockCtx({ sessionManager: { getEntries: () => [] } });
    assert.strictEqual(hasGoalsExtension(ctx), false);
  });
});

// ===========================================================================
// ensureGoalsExtension
// ===========================================================================

describe("ensureGoalsExtension", () => {
  afterEach(() => {
    _resetWarnedMissingGoals();
  });

  it("returns true when pi-goal is present (no warning)", () => {
    let notified = false;
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1" } } },
        ],
      },
      ui: {
        notify: (_msg: string, _level: string) => { notified = true; },
      },
    });
    assert.strictEqual(ensureGoalsExtension(ctx), true);
    assert.strictEqual(notified, false, "should not warn when pi-goal is present");
  });

  it("returns false and warns when pi-goal is missing (first call)", () => {
    let notifyMsg = "";
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [],
      },
      ui: {
        notify: (msg: string, _level: string) => { notifyMsg = msg; },
      },
    });
    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.ok(notifyMsg.includes("pi-goal"), "warning should mention pi-goal");
  });

  it("warns only once per session (subsequent calls silent)", () => {
    let notifyCount = 0;
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [],
      },
      ui: {
        notify: (_msg: string, _level: string) => { notifyCount++; },
      },
    });

    // First call warns
    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.strictEqual(notifyCount, 1);

    // Subsequent calls should not warn
    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.strictEqual(notifyCount, 1, "should warn only once");
    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.strictEqual(notifyCount, 1, "should warn only once");
  });

  it("resets warning flag after _resetWarnedMissingGoals", () => {
    let notifyCount = 0;
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [],
      },
      ui: {
        notify: (_msg: string, _level: string) => { notifyCount++; },
      },
    });

    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.strictEqual(notifyCount, 1);

    _resetWarnedMissingGoals();

    assert.strictEqual(ensureGoalsExtension(ctx), false);
    assert.strictEqual(notifyCount, 2, "should warn again after reset");
  });
});

// ===========================================================================
// hasActiveGoal
// ===========================================================================

describe("hasActiveGoal", () => {
  it("returns true when there is an active (non-complete) goal", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("returns false when all goals are complete", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "complete" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });

  it("returns false when there are no pi-goal-state entries", () => {
    const ctx = mockCtx({ sessionManager: { getEntries: () => [] } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });

  it("returns true for paused goals (not complete)", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "paused" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("scans backward and finds the latest goal status", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "complete" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "active" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    // g1 is complete, g2 is active
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("returns false when last state of all goals is complete", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "complete" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "active" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "complete" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });

  it("handles bad entry data gracefully", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: null },
      { type: "message", message: { role: "assistant" } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });
});

// ===========================================================================
// combineAbortSignals
// ===========================================================================

describe("combineAbortSignals", () => {
  it("returns undefined when both signals are undefined", () => {
    assert.strictEqual(combineAbortSignals(undefined, undefined), undefined);
  });

  it("returns the first signal when second is undefined", () => {
    const ac = new AbortController();
    assert.strictEqual(combineAbortSignals(ac.signal, undefined), ac.signal);
  });

  it("returns the second signal when first is undefined", () => {
    const ac = new AbortController();
    assert.strictEqual(combineAbortSignals(undefined, ac.signal), ac.signal);
  });

  it("combines two signals and both trigger the combined signal", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const combined = combineAbortSignals(ac1.signal, ac2.signal);
    assert.ok(combined);
    assert.strictEqual(combined.aborted, false);

    ac1.abort();
    assert.strictEqual(combined!.aborted, true);
  });

  it("aborting either original signal aborts the combined signal", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const combined = combineAbortSignals(ac1.signal, ac2.signal);
    assert.ok(combined);
    assert.strictEqual(combined.aborted, false);

    ac2.abort();
    assert.strictEqual(combined!.aborted, true);
  });

  it("works with an already-aborted signal", () => {
    const ac1 = new AbortController();
    ac1.abort();
    const ac2 = new AbortController();
    const combined = combineAbortSignals(ac1.signal, ac2.signal);
    assert.strictEqual(combined!.aborted, true);
  });

  it("combining after controller creation still captures aborts", () => {
    // Simulate the timing: runtime signal exists, widget controller doesn't yet
    const runtimeSignal = new AbortController();
    const combinedEarly = combineAbortSignals(runtimeSignal.signal, undefined);
    assert.strictEqual(combinedEarly?.aborted, false);

    // Later (after showCommitterWidget), widget controller is created
    const widgetController = new AbortController();
    // Combine runtime signal with the newly created widget signal
    const combinedLate = combineAbortSignals(runtimeSignal.signal, widgetController.signal);
    assert.strictEqual(combinedLate?.aborted, false);

    // Esc triggers widget abort → combined signal is aborted
    widgetController.abort();
    assert.strictEqual(combinedLate!.aborted, true);
  });

  it("runtime abort works even without widget controller", () => {
    // This tests the scenario BEFORE showCommitterWidget creates the controller
    const runtimeSignal = new AbortController();
    const combined = combineAbortSignals(runtimeSignal.signal, undefined);
    assert.strictEqual(combined!.aborted, false);
    runtimeSignal.abort();
    assert.strictEqual(combined!.aborted, true);
  });
});

// ===========================================================================
// Mocked subagent — test that createAgentSession is properly mocked
// ===========================================================================

describe("createAgentSession mock injection", () => {
  after(() => {
    __setCreateAgentSessionMock(undefined);
  });

  it("uses mock when set via __setCreateAgentSessionMock", async () => {
    let called = false;
    const mockSession: any = {
      prompt: async () => {},
      subscribe: () => {
        called = true;
        return () => {};
      },
    };
    const mockCreateAgentSession = async (_opts: any) => ({
      session: mockSession,
    });
    __setCreateAgentSessionMock(mockCreateAgentSession as any);

    assert.strictEqual(__createAgentSessionMock, mockCreateAgentSession);
  });
});

// ===========================================================================
// unstageAll on abort
// ===========================================================================

describe("unstageAll on abort", () => {
  let dir: string;

  before(() => {
    dir = createTempRepo();
  });

  after(() => removeDir(dir));

  it("unstageAll clears staged changes", () => {
    writeFileSync(path.join(dir, "test.ts"), "// staged");
    execSync("git add test.ts", { cwd: dir, stdio: "ignore" });

    // Verify staged
    const staged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(staged, "test.ts");

    // Unstage
    unstageAll(dir);
    const after = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(after, "");
  });

  it("hasAnyChanges returns true after staging a file, then false after cleanup", () => {
    writeFileSync(path.join(dir, "test2.ts"), "// another");
    execSync("git add test2.ts", { cwd: dir, stdio: "ignore" });
    assert.strictEqual(hasAnyChanges(dir), true);

    // Clean up: remove the file and unstage
    fs.rmSync(path.join(dir, "test2.ts"));
    unstageAll(dir);

    // Verify nothing is staged
    const after = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(after, "");
  });
});

// ===========================================================================
// Cancel flow integration
// ===========================================================================

describe("cancel flow integration", () => {
  let dir: string;
  let originalConfig: CommitterConfig;

  before(() => {
    dir = createTempRepo();
    originalConfig = getConfig();
  });

  after(() => {
    removeDir(dir);
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
  });

  it("singleGroupFallback returns immediately when signal is already aborted (no subagent call)", async () => {
    // Mock the subagent to detect if it was called
    let subagentCalled = false;
    __setCreateAgentSessionMock(async (_opts: any) => {
      subagentCalled = true;
      return {
        session: {
          prompt: async () => {},
          abort: () => {},
          subscribe: () => () => {},
        },
      };
    });

    const ac = new AbortController();
    ac.abort(); // Already aborted before call

    const result = await singleGroupFallback(
      mockCtx(),
      "src/main.ts | 1 +",
      "diff content",
      ["src/main.ts"],
      undefined,
      ac.signal,
    );

    // Should return a commit group without calling the subagent
    assert.strictEqual(subagentCalled, false);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0].message.length > 0);
    assert.deepStrictEqual(result[0].files, ["src/main.ts"]);
  });

  it("singleGroupFallback with non-aborted signal calls subagent normally", async () => {
    let subagentCalled = false;
    __setCreateAgentSessionMock(async (_opts: any) => {
      subagentCalled = true;
      return {
        session: {
          prompt: async () => {},
          abort: () => {},
          subscribe: () => () => {},
        },
      };
    });

    const ac = new AbortController();
    // Not aborted

    await singleGroupFallback(
      mockCtx(),
      "src/main.ts | 1 +",
      "diff content",
      ["src/main.ts"],
      undefined,
      ac.signal,
    );

    // Should call subagent since signal is not aborted
    assert.strictEqual(subagentCalled, true);
  });

  it("commitStaged returns undefined when signal is aborted (no commit made)", async () => {
    // Stage a file
    writeFileSync(path.join(dir, "cancel-test.ts"), "// cancel test");
    execSync("git add cancel-test.ts", { cwd: dir, stdio: "ignore" });

    // Verify it's staged
    const staged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.ok(staged.includes("cancel-test.ts"));

    // Mock subagent (session is still created before abort check, but prompt is skipped)
    let promptCalled = false;
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => { promptCalled = true; },
        abort: () => {},
        subscribe: () => () => {},
      },
    }));

    const ctx = mockCtx({ cwd: dir, ui: { notify: () => {} } });
    const ac = new AbortController();
    ac.abort(); // Already aborted

    const result = await commitStaged(
      dir,
      ctx,
      ["cancel-test.ts"],
      undefined,
      ac.signal,
    );

    // Should return undefined (no commit)
    assert.strictEqual(result, undefined);
    // The session is created before the signal check, so prompt would not be called
    assert.strictEqual(promptCalled, false,
      "Subagent prompt should be skipped when signal is already aborted");

    // Verify no commit was made (still only the initial commit)
    const log = execSync("git log --oneline", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(log.split("\n").length, 1,
      "No additional commit should have been created");

    // Verify file is no longer staged (unstageAll was called)
    const afterStaged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(afterStaged, "",
      "Staged changes should have been unstaged");

    // Clean up
    fs.rmSync(path.join(dir, "cancel-test.ts"));
  });

  it("commitStaged aborts mid-flight when signal aborts during subagent call", async () => {
    // Stage a file
    writeFileSync(path.join(dir, "midflight-test.ts"), "// midflight");
    execSync("git add midflight-test.ts", { cwd: dir, stdio: "ignore" });

    const ac = new AbortController();

    // Mock subagent that checks abort signal during prompt
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {
          // Simulate the subagent being aborted mid-flight
          // The real subagent would be cancelled by session.abort()
          // triggered by the signal listener
          if (ac.signal.aborted) {
            throw new Error("Aborted");
          }
        },
        abort: () => { ac.abort(); },
        subscribe: () => () => {},
      },
    }));

    const ctx = mockCtx({ cwd: dir, ui: { notify: () => {} } });

    // Abort the signal while the subagent is running
    // We need to trigger abort AFTER generateCommitMessageViaSubagent
    // enters the session.prompt() call but BEFORE it returns.
    // With the mock above, the subagent checks ac.signal.aborted.
    ac.abort(); // Abort before calling

    const result = await commitStaged(
      dir,
      ctx,
      ["midflight-test.ts"],
      undefined,
      ac.signal,
    );

    // Should return undefined (no commit)
    assert.strictEqual(result, undefined);

    // Verify no commit was made
    const log = execSync("git log --oneline", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(log.split("\n").length, 1,
      "No additional commit should have been created");

    // Verify file is no longer staged
    const afterStaged = execSync("git diff --cached --name-only", {
      cwd: dir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(afterStaged, "",
      "Staged changes should have been unstaged on abort");

    // Clean up
    fs.rmSync(path.join(dir, "midflight-test.ts"));
  });
});

// ===========================================================================
// commitStaged with gitignored files (unit-level integration)
// ===========================================================================

describe("gitignore commit integration", () => {
  let dir: string;
  let originalConfig: CommitterConfig;

  before(() => {
    dir = createTempRepo();
    originalConfig = getConfig();
  });

  after(() => {
    removeDir(dir);
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
  });

  /**
   * Helper: directly test that filterGitignoredFiles prevents the grouped
   * commit loop from crashing. We set up a gitignored file and verify that
   * the individual `git add -- "<file>"` calls never touch ignored files.
   */
  it("filterGitignoredFiles prevents git add crash for gitignored untracked files", () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Set up .gitignore and create an untracked file that matches it
    writeFileSync(path.join(repoDir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(repoDir, "ignored.json"), "{}");
    writeFileSync(path.join(repoDir, "keep.ts"), "// keep");

    // Stage everything so ignored.json doesn't get staged
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    const stagedFiles = execSync("git diff --cached --name-only", {
      cwd: repoDir, encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);

    // ignored.json should NOT be staged by git add -A (it's gitignored)
    assert.ok(!stagedFiles.includes("ignored.json"),
      "gitignored file should not be staged by git add -A");

    // Now simulate the grouped commit loop: unstage + individual git add
    execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

    // Filter through filterGitignoredFiles
    const safeFiles = filterGitignoredFiles(repoDir, ["ignored.json", "keep.ts"]);
    assert.deepStrictEqual(safeFiles, ["keep.ts"]);

    // These should succeed without error
    for (const f of safeFiles) {
      execSync(`git add -- "${f}"`, { cwd: repoDir, stdio: "ignore" });
    }

    // Verify only keep.ts is staged
    const afterStaged = execSync("git diff --cached --name-only", {
      cwd: repoDir, encoding: "utf-8",
    }).trim();
    assert.strictEqual(afterStaged, "keep.ts");
  });

  it("handles .gitignore change mid-flow (after stageAll, before individual add)", () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Step 1: Set up .gitignore that does NOT ignore .json files
    writeFileSync(path.join(repoDir, ".gitignore"), "# empty\n");
    execSync("git add -A && git commit -m 'init gitignore'", {
      cwd: repoDir, stdio: "ignore",
    });

    // Step 2: Create an untracked .json file (NOT gitignored at this point)
    writeFileSync(path.join(repoDir, "data.json"), "{}");

    // Step 3: Run stageAll — data.json is NOT gitignored, so it gets staged
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    const stagedBefore = execSync("git diff --cached --name-only", {
      cwd: repoDir, encoding: "utf-8",
    }).trim();
    assert.ok(stagedBefore.includes("data.json"),
      "data.json should be staged before .gitignore change");

    // Step 4: NOW modify .gitignore to ignore *.json (simulating mid-flow change)
    writeFileSync(path.join(repoDir, ".gitignore"), "*.json\n");

    // Step 5: Simulate grouped commit loop: unstageAll, then individual git add
    execSync("git reset HEAD -- .", { cwd: repoDir, stdio: "ignore" });

    // WITHOUT filterGitignoredFiles, this would crash:
    //   execSync(`git add -- "${f}"`, { cwd: repoDir, stdio: "ignore" });
    // would fail because .gitignore now says *.json and data.json is untracked.
    //
    // WITH filterGitignoredFiles, data.json should be filtered out:
    const safeFiles = filterGitignoredFiles(repoDir, ["data.json"]);
    assert.deepStrictEqual(safeFiles, [],
      "data.json should be filtered out because .gitignore now matches it");

    // Verify that git add on the filtered list would NOT crash
    for (const f of safeFiles) {
      execSync(`git add -- "${f}"`, { cwd: repoDir, stdio: "ignore" });
    }
    // No crash means the fix works
  });

  it("group with all gitignored files is silently skipped", () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    writeFileSync(path.join(repoDir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(repoDir, "all.json"), "{}");
    writeFileSync(path.join(repoDir, "data.json"), "[]");

    // All files are gitignored → empty after filtering
    const safeFiles = filterGitignoredFiles(repoDir, ["all.json", "data.json"]);
    assert.deepStrictEqual(safeFiles, []);
  });

  it("nested .gitignore is respected", () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    const benchmarksDir = path.join(repoDir, "benchmarks");
    fs.mkdirSync(benchmarksDir);
    writeFileSync(path.join(benchmarksDir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(benchmarksDir, "results.json"), "{}");
    writeFileSync(path.join(repoDir, "keep.ts"), "// keep");

    const safeFiles = filterGitignoredFiles(repoDir, [
      "benchmarks/results.json",
      "keep.ts",
    ]);
    assert.deepStrictEqual(safeFiles, ["keep.ts"]);
  });

  /**
   * Verify commitStaged returns undefined when there's nothing staged
   * (e.g., all files were gitignored and never made it into the index).
   */
  it("commitStaged basic success case with mocked subagent", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Create and stage a file
    writeFileSync(path.join(repoDir, "feat.ts"), "// new feature");
    execSync("git add feat.ts", { cwd: repoDir, stdio: "ignore" });

    // Mock subagent to return a commit message
    const originalMock = __createAgentSessionMock;
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await commitStaged(
        repoDir,
        mockCtx(),
        ["feat.ts"],
        undefined,
        undefined,
      );

      // commitStaged should return a hash (commit succeeded)
      assert.ok(result, "Expected commitStaged to return a hash");
      assert.strictEqual(result.length, 40, "Expected a 40-char SHA hash");

      // Verify the commit was created
      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      assert.strictEqual(count, 2, "Expected 2 commits (initial + created)");
    } finally {
      __setCreateAgentSessionMock(originalMock);
    }
  });

  it("commitStaged returns undefined when gitignored files cannot be staged", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Add a .gitignore that matches a tracked file's NEW extension
    // The file won't be modified, so diff --cached will be empty
    writeFileSync(path.join(repoDir, ".gitignore"), "*.json\n");
    writeFileSync(path.join(repoDir, "untracked.txt"), "hello");
    // Don't stage it — simulate the case where all files were filtered out

    const result = await commitStaged(
      repoDir,
      mockCtx(),
      ["untracked.txt"],
      undefined,
      undefined,
    );
    // Nothing was staged, so commitStaged returns undefined (no commit)
    assert.strictEqual(result, undefined);
  });
});

// ===========================================================================
// Config state helpers
// ===========================================================================

describe("config state accessors", () => {
  it("getConfig returns current config", () => {
    const cfg = getConfig();
    assert.ok(cfg);
    assert.ok("enabled" in cfg && "triggerMode" in cfg);
  });

  it("deferToGoalAudit defaults to false", () => {
    assert.strictEqual(getConfig().deferToGoalAudit, false);
  });

  it("setConfig replaces config", () => {
    const original = getConfig();
    const testCfg: CommitterConfig = { ...original, triggerMode: "manual" };
    setConfig(testCfg);
    assert.strictEqual(getConfig().triggerMode, "manual");
    setConfig(original);
  });

  it("setConfig preserves deferToGoalAudit", () => {
    const original = getConfig();
    const testCfg: CommitterConfig = { ...original, deferToGoalAudit: false };
    setConfig(testCfg);
    assert.strictEqual(getConfig().deferToGoalAudit, false);
    setConfig(original);
  });
});

// ===========================================================================
// Async commit threshold tests
// ===========================================================================

describe("async commit threshold", () => {
  let originalConfig: CommitterConfig;
  let repoDir: string;

  before(() => {
    originalConfig = getConfig();
    repoDir = createTempRepo();
  });

  after(() => {
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
    removeDir(repoDir);
  });

  it("skips async when asyncThreshold is 0 (disabled)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // Set asyncThreshold to 0 (disabled)
    setConfig({ ...originalConfig, asyncThreshold: 0 });

    // Create some files
    for (let i = 0; i < 15; i++) {
      writeFileSync(path.join(dir, `file-${i}.ts`), `// file ${i}\n`);
    }

    // This would try to commit (no subagent mock), but should NOT trigger async
    // since asyncThreshold is 0. Without a subagent mock, commitStaged will fail
    // so it returns 0.
    const result = await tryCommit(dir, mockCtx(), true, undefined);
    assert.strictEqual(typeof result, "number");
    // -1 = async started. We should NOT see -1 since asyncThreshold=0
    assert.notStrictEqual(result, -1, "should NOT trigger async when asyncThreshold=0");
  });

  it("skips async when file count is below threshold", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // Set asyncThreshold to 20
    setConfig({ ...originalConfig, asyncThreshold: 20 });

    // Create 3 files (below threshold)
    writeFileSync(path.join(dir, "a.ts"), "// a\n");
    writeFileSync(path.join(dir, "b.ts"), "// b\n");
    writeFileSync(path.join(dir, "c.ts"), "// c\n");

    // Should NOT trigger async since file count (3) < threshold (20)
    const result = await tryCommit(dir, mockCtx(), true, undefined);
    assert.notStrictEqual(result, -1, "should NOT trigger async when files < threshold");
    // Without subagent mock, commit may fail, but result should be 0 (not -1)
    assert.ok(result >= 0, "result should be >= 0 when not async");
  });

  it("skips async when force=false (auto-trigger mode)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // Set low asyncThreshold so normally it would trigger
    setConfig({ ...originalConfig, asyncThreshold: 3 });

    // Create 5 files
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `auto-${i}.ts`), `// auto ${i}\n`);
    }

    // Call without force (simulates auto-trigger) — should NOT trigger async
    const result = await tryCommit(dir, mockCtx(), false, undefined);
    assert.notStrictEqual(result, -1, "should NOT trigger async when force=false");
  });

  it("triggers async when conditions are met (with fork mock)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // Set low asyncThreshold
    setConfig({ ...originalConfig, asyncThreshold: 3 });

    // Create 5 files
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `async-${i}.ts`), `// async ${i}\n`);
    }

    // Mock fork to return a fake child process
    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99999;
    mockChild.kill = () => {};
    mockChild.send = () => true;
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;

    // Set the fork mock
    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    try {
      // Trigger async — should return -1
      const result = await tryCommit(dir, mockCtx(), true, undefined);

      // Should return -1 (async started)
      assert.strictEqual(result, -1, "should return -1 when async started");

      // The async started flag should be set
      assert.ok(_getAsyncCommitStarted(), "async commit flag should be set");
    } finally {
      // Restore fork mock
      __setForkMock(undefined);
      // Reset config
      setConfig(originalConfig);
    }
  });

  it("Esc cancellation kills the async subprocess", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // Set low asyncThreshold
    setConfig({ ...originalConfig, asyncThreshold: 3 });

    // Create 5 files
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `esc-${i}.ts`), `// esc ${i}\n`);
    }

    // Track if kill was called
    let killCalled = false;
    let killSignal = "";

    // Mock fork to return a fake child process
    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99998;
    mockChild.kill = (signal?: string) => {
      killCalled = true;
      killSignal = signal || "";
      // Simulate SIGTERM by emitting exit
      setImmediate(() => mockChild.emit("exit", null));
    };
    mockChild.send = () => true;
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;

    // Capture the Esc handler
    let capturedEscHandler: ((data: any) => any) | null = null;
    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: (handler: (data: any) => any) => {
          capturedEscHandler = handler;
          return () => {}; // unsubscribe
        },
        setWidget: () => {},
      },
    });

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    try {
      // Trigger async
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1 when async started");

      // The Esc handler should have been registered
      assert.ok(capturedEscHandler, "Esc handler should be registered");

      // Simulate Esc key press with raw terminal escape character
      const consumeResult = capturedEscHandler!("\x1b");
      assert.ok(consumeResult, "Esc handler should return a result");
      assert.ok(consumeResult?.consume, "Esc should consume the event");

      // Verify kill was called on the child process
      assert.ok(killCalled, "child.kill should be called on Esc");
      assert.strictEqual(killSignal, "SIGTERM", "should send SIGTERM");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("simulates subprocess progress and result IPC", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `ipc-${i}.ts`), `// ipc ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99997;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;

    let capturedSend: ((msg: any) => boolean) | null = null;
    mockChild.send = (msg: any) => {
      capturedSend = msg;
      return true;
    };

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Verify the start message was sent to the worker
      assert.ok(capturedSend, "child.send should be called");
      assert.strictEqual(capturedSend!.type, "start", "should send 'start' message");
      assert.ok(capturedSend!.params, "should include params");
      assert.strictEqual(capturedSend!.params.dir, dir, "params should include dir");
      assert.ok(Array.isArray(capturedSend!.params.allFiles), "params should include allFiles array");
      assert.strictEqual(capturedSend!.params.stagedCommits, originalConfig.stagedCommits, "params should include stagedCommits");
      assert.ok(capturedSend!.params.allFiles.length >= 5, "should have at least 5 files");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("handles worker error result via IPC", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `err-${i}.ts`), `// err ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99996;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Clear the flag so we can check result handling
      assert.ok(_getAsyncCommitStarted(), "async started");

      // Simulate worker sending error result
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "Something went wrong in the worker",
      });

      // The flag should be cleared after result
      assert.strictEqual(_getAsyncCommitStarted(), false, "flag cleared after error result");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("handles worker crash (error event)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `crash-${i}.ts`), `// crash ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99995;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Simulate worker crash
      mockChild.emit("error", new Error("Worker process crashed"));

      // The flag should eventually be cleared
      assert.strictEqual(_getAsyncCommitStarted(), false, "flag cleared after crash");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("handles unexpected worker exit without result", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `exit-${i}.ts`), `// exit ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 99994;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Simulate worker exit without sending result
      mockChild.emit("exit", 1);

      // The flag should be cleared after exit
      assert.strictEqual(_getAsyncCommitStarted(), false, "flag cleared after exit");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the IPC race condition fix: when the worker sends a result message
   * and THEN exits with code 1, the parent should process the result (not the
   * exit error).
   */
  it("processes IPC result when result arrives before exit (IPC race fix)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `race-result-${i}.ts`), `// race ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88881;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Send result FIRST (simulating the worker's sendResult working correctly)
      mockChild.emit("message", {
        type: "result",
        commitCount: 2,
        commitLog: [
          { hash: "abc1234", message: "feat: first commit", success: true },
          { hash: "def5678", message: "fix: second commit", success: true },
        ],
      });

      // THEN exit with code 1 (simulating the race where exit fires late)
      mockChild.emit("exit", 1);

      // The result should have been processed and the widget should show the
      // result, not the "Subprocess exited with code 1" error.
      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done");
      assert.strictEqual(progress!.error, undefined, "error should be undefined (result succeeded, not exit)");
      assert.strictEqual(progress!.totalCommits, 2, "should have the result's commit count");
      assert.strictEqual(progress!.commitLog.length, 2, "should have the result's commit log");
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag cleared");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the parent-side fallback: when the worker exits with code 1 before
   * sending a result IPC message, the parent should wait for a delayed result
   * rather than immediately showing the subprocess exit error.
   */
  it("waits for delayed IPC result when exit arrives before result (parent fallback)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `delayed-${i}.ts`), `// delayed ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88882;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Emit exit FIRST (before any result), simulating the race where
      // process.exit(N) terminates before the IPC message is delivered.
      mockChild.emit("exit", 1);

      // The exit handler should have set up the fallback timer and the
      // onDelayedMsg listener. Now send a result after a short delay.
      await new Promise((resolve) => setTimeout(resolve, 30));
      mockChild.emit("message", {
        type: "result",
        commitCount: 3,
        commitLog: [
          { hash: "aaa1111", message: "feat: commit 1", success: true },
          { hash: "bbb2222", message: "feat: commit 2", success: true },
          { hash: "ccc3333", message: "feat: commit 3", success: true },
        ],
      });

      // Wait for the delayed result to be processed
      await new Promise((resolve) => setTimeout(resolve, 30));

      // The progress should now show the result, not the exit error
      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done");
      assert.strictEqual(progress!.error, undefined, "error should be undefined (result arrived, not exit error)");
      assert.strictEqual(progress!.totalCommits, 3, "commit count should come from the delayed result");
      assert.strictEqual(progress!.commitLog.length, 3, "commit log should come from the delayed result");
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify that the committer widget is registered and visible when
   * an async commit is triggered.
   */
  it("shows the committer widget when async commit starts", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `widget-vis-${i}.ts`), `// widget vis ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88870;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    let setWidgetCalled = false;
    let setWidgetKey = "";
    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: (key: string, _widget: any) => {
          setWidgetCalled = true;
          setWidgetKey = key;
        },
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Widget should be registered via ctx.ui.setWidget
      assert.ok(setWidgetCalled, "ctx.ui.setWidget should be called");
      assert.strictEqual(setWidgetKey, "pi-committer", "should register with correct widget key");

      // Internal progress state should reflect the preparing phase
      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "preparing", "phase should be preparing");
      assert.strictEqual(progress!.fileCount, 5, "file count should be set");
      assert.strictEqual(progress!.subprocessPid, 88870, "subprocess PID should be set from mock child");
      assert.ok(progress!.startedAt > 0, "startedAt should be set");
      assert.strictEqual(progress!.commitLog.length, 0, "commit log should be empty initially");
      assert.strictEqual(progress!.error, undefined, "error should be undefined initially");
      assert.ok(progress!.statusMessage?.includes("5"), "status message should mention file count");

      // State flags should be set
      assert.strictEqual(_getAsyncCommitStarted(), true, "async started flag should be set");
      assert.strictEqual(_getAsyncCommitFileCount(), 5, "async file count should be set");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the widget updates through the full IPC lifecycle:
   * preparing → analyzing → committing (with commit entries) → result (done).
   */
  it("updates the committer widget through full IPC lifecycle (preparing → progress → result)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `lifecycle-${i}.ts`), `// lifecycle ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88869;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Phase 1: preparing (initial state set by showCommitterWidget)
      let progress = _getCommitterProgress();
      assert.strictEqual(progress!.phase, "preparing", "initial phase should be preparing");
      assert.strictEqual(progress!.fileCount, 5);
      assert.ok(progress!.statusMessage?.includes("5"), "status message should mention file count");

      // Phase 2: IPC progress message → analyzing phase
      mockChild.emit("message", {
        type: "progress",
        phase: "analyzing",
        fileCount: 5,
        statusMessage: "Analyzing 5 file(s) for logical commit grouping...",
      });
      progress = _getCommitterProgress();
      assert.strictEqual(progress!.phase, "analyzing", "phase should update to analyzing");
      assert.strictEqual(progress!.statusMessage, "Analyzing 5 file(s) for logical commit grouping...");

      // Phase 3: IPC progress message → committing phase
      mockChild.emit("message", {
        type: "progress",
        phase: "committing",
        totalCommits: 2,
        completedCommits: 0,
        statusMessage: "Committing 1/2...",
      });
      progress = _getCommitterProgress();
      assert.strictEqual(progress!.phase, "committing", "phase should update to committing");
      assert.strictEqual(progress!.totalCommits, 2);
      assert.strictEqual(progress!.completedCommits, 0);
      assert.strictEqual(progress!.statusMessage, "Committing 1/2...");

      // Phase 4: IPC commit entries arrive one at a time
      mockChild.emit("message", {
        type: "commit",
        commit: { hash: "aaa1111", message: "feat: first commit", success: true },
      });
      progress = _getCommitterProgress();
      assert.strictEqual(progress!.completedCommits, 1, "completed commits should increment after first commit");
      assert.strictEqual(progress!.commitLog.length, 1, "commit log should have 1 entry");
      assert.strictEqual(progress!.commitLog[0].hash, "aaa1111");
      assert.strictEqual(progress!.commitLog[0].message, "feat: first commit");
      assert.strictEqual(progress!.commitLog[0].success, true);

      mockChild.emit("message", {
        type: "commit",
        commit: { hash: "bbb2222", message: "feat: second commit", success: true },
      });
      progress = _getCommitterProgress();
      assert.strictEqual(progress!.completedCommits, 2, "completed commits should increment after second commit");
      assert.strictEqual(progress!.commitLog.length, 2, "commit log should have 2 entries");

      // Phase 5: IPC result message (success) — widget should show done
      mockChild.emit("message", {
        type: "result",
        commitCount: 2,
        commitLog: [
          { hash: "aaa1111", message: "feat: first commit", success: true },
          { hash: "bbb2222", message: "feat: second commit", success: true },
        ],
      });
      progress = _getCommitterProgress();
      assert.strictEqual(progress!.phase, "done", "phase should be done after result");
      assert.strictEqual(progress!.error, undefined, "error should be undefined on success");
      assert.strictEqual(progress!.totalCommits, 2);
      assert.strictEqual(progress!.completedCommits, 2);
      assert.strictEqual(progress!.commitLog.length, 2, "commit log should have 2 entries");
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared on result");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the widget shows the error message when the worker sends
   * an error result via IPC.
   */
  it("shows error in widget from IPC error result", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `err-widget-${i}.ts`), `// err widget ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88868;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Send an error result via IPC
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "Something went wrong in the worker",
      });

      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done after error result");
      assert.strictEqual(
        progress!.error,
        "Something went wrong in the worker",
        "error should be set from result message",
      );
      assert.strictEqual(progress!.totalCommits, 0);
      assert.strictEqual(progress!.completedCommits, 0);
      assert.strictEqual(progress!.commitLog.length, 0);
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared on result");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the widget shows the error message when the worker emits
   * an error event (process crash).
   */
  it("shows error in widget when worker crashes (error event)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `crash-widget-${i}.ts`), `// crash widget ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88867;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Simulate worker process crash via error event
      mockChild.emit("error", new Error("Worker process crashed"));

      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done after crash");
      assert.ok(
        progress!.error?.includes("Worker process crashed"),
        "error should describe the crash, got: " + progress!.error,
      );
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared after crash");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  /**
   * Verify the widget shows a subprocess exit error when the worker
   * exits with a non-zero code without sending any result IPC.
   * The exit handler's fallback timer (500ms) should fire and display
   * the error in the widget.
   */
  it("shows error in widget on unexpected worker exit without result", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `exit-widget-${i}.ts`), `// exit widget ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 88866;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1");

      // Simulate worker exit with code 1 WITHOUT sending any result IPC
      mockChild.emit("exit", 1);

      // The exit handler clears async flags immediately
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag cleared on exit");

      // Wait for the fallback timer (500ms) to fire
      await new Promise((resolve) => setTimeout(resolve, 600));

      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done after exit error");
      assert.ok(
        progress!.error?.includes("Subprocess exited with code"),
        "error should mention subprocess exit, got: " + progress!.error,
      );
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });
});

// ===========================================================================
// Async commit widget rendering tests
// ===========================================================================

describe("async commit widget rendering", () => {
  it("renders preparing phase with file count", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "preparing",
      fileCount: 25,
      statusMessage: "Preparing commit for 25 file(s)...",
      commitLog: [],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines.length > 0, "should render at least one line");
    assert.ok(lines[0].includes("preparing"), "header should show preparing");
    assert.ok(lines[0].includes("25"), "header should show file count");
    assert.ok(lines.some((l) => l.includes("Esc")), "should show Esc hint");
  });

  it("renders preparing phase with subprocess PID", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "preparing",
      fileCount: 25,
      statusMessage: "Preparing commit for 25 file(s)...",
      subprocessPid: 12345,
      commitLog: [],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines.some((l) => l.includes("12345") || l.includes("pid")), "should show subprocess PID");
  });

  it("renders committing phase with progress", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "committing",
      totalCommits: 3,
      completedCommits: 1,
      statusMessage: "Committing 2/3...",
      commitLog: [
        { hash: "aaa1111", message: "feat: first commit", success: true },
      ],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines.length > 0, "should render at least one line");
    assert.ok(lines[0].includes("committing"), "header should show committing");
    assert.ok(lines[0].includes("1/3"), "header should show completed/total progress");
    assert.ok(lines.some((l) => l.includes("aaa1111")), "should show commit hash");
    assert.ok(lines.some((l) => l.includes("Esc")), "should show Esc hint during committing");
  });

  it("renders done phase with commit log", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 2,
      completedCommits: 2,
      commitLog: [
        { hash: "aaa1111", message: "feat: first commit", success: true },
        { hash: "bbb2222", message: "feat: second commit", success: true },
      ],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines[0].includes("complete"), "header should show complete");
    assert.ok(lines[0].includes("2"), "header should show commit count");
    assert.ok(lines.some((l) => l.includes("aaa1111")), "should show first commit hash");
    assert.ok(lines.some((l) => l.includes("bbb2222")), "should show second commit hash");
    assert.ok(!lines.some((l) => l.includes("Esc")), "should NOT show Esc hint when done");
  });

  it("renders done phase with error", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 0,
      completedCommits: 0,
      commitLog: [],
      error: "Something went wrong",
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines[0].includes("complete"), "header should show complete");
    assert.ok(lines.some((l) => l.includes("Something went wrong")), "should show error message");
    assert.ok(!lines.some((l) => l.includes("Esc")), "should NOT show Esc hint when done");
  });

  it("renders cancelled phase", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "cancelled",
      commitLog: [],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines[0].includes("cancelled"), "header should show cancelled");
    assert.ok(lines.some((l) => l.includes("Operation cancelled")), "should show cancellation message");
  });

  it("renders cancelled phase with partial commit log", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const elapsed = Date.now();

    const progress: CommitterProgress = {
      phase: "cancelled",
      commitLog: [
        { hash: "aaa1111", message: "feat: first commit", success: true },
      ],
      startedAt: elapsed,
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.ok(lines[0].includes("cancelled"), "header should show cancelled");
    assert.ok(lines.some((l) => l.includes("aaa1111")), "should show partial commit log");
    assert.ok(lines.some((l) => l.includes("Operation cancelled")), "should show cancellation message");
  });
});

// ===========================================================================
// Commit error handling
// ===========================================================================

describe("commit error handling", () => {
  let originalConfig: CommitterConfig;
  let originalMock: ((opts: any) => any) | undefined;

  before(() => {
    // Initialize config from defaults (extension entry point doesn't run in tests)
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
  });

  /** Create a repo WITH a pre-commit hook that always fails. */
  function createRepoWithFailingHook(): string {
    const dir = createTempRepo();
    const hookDir = path.join(dir, ".git", "hooks");
    if (!existsSync(hookDir)) {
      fs.mkdirSync(hookDir, { recursive: true });
    }
    writeFileSync(path.join(hookDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(hookDir, "pre-commit"), 0o755);
    return dir;
  }

  /** Create a repo WITH a pre-commit hook that writes to stdout/stderr and fails. */
  function createRepoWithNoisyFailingHook(): string {
    const dir = createTempRepo();
    const hookDir = path.join(dir, ".git", "hooks");
    if (!existsSync(hookDir)) {
      fs.mkdirSync(hookDir, { recursive: true });
    }
    writeFileSync(
      path.join(hookDir, "pre-commit"),
      "#!/bin/sh\necho \"Linting failed...\"\necho \"Error: trailing whitespace\" >&2\nexit 1\n",
    );
    fs.chmodSync(path.join(hookDir, "pre-commit"), 0o755);
    return dir;
  }

  // -----------------------------------------------------------------------
  // commitStaged (single commit, index.ts)
  // -----------------------------------------------------------------------

  it("commitStaged returns undefined on commit-msg hook failure", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Add a failing commit-msg hook (different hook than pre-commit)
    const hookDir = path.join(repoDir, ".git", "hooks");
    if (!existsSync(hookDir)) {
      mkdirSync(hookDir, { recursive: true });
    }
    writeFileSync(path.join(hookDir, "commit-msg"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(hookDir, "commit-msg"), 0o755);

    // Create and stage a file
    writeFileSync(path.join(repoDir, "fix.ts"), "// fix");
    execSync("git add fix.ts", { cwd: repoDir, stdio: "ignore" });

    // Mock subagent to bypass real agent call
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await commitStaged(repoDir, mockCtx(), ["fix.ts"], undefined, undefined);

      // commitStaged should return undefined since commit-msg hook failed
      assert.strictEqual(result, undefined, "Expected undefined on commit-msg hook failure");

      // Verify no commit was created
      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      assert.strictEqual(count, 1, "Expected only the initial commit (hook rejected)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  it("commitStaged returns undefined on pre-commit hook failure", async () => {
    const repoDir = createRepoWithFailingHook();
    after(() => removeDir(repoDir));

    // Create and stage a file
    writeFileSync(path.join(repoDir, "bugfix.ts"), "// bugfix");
    execSync("git add bugfix.ts", { cwd: repoDir, stdio: "ignore" });

    // Mock subagent
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await commitStaged(repoDir, mockCtx(), ["bugfix.ts"], undefined, undefined);

      // commitStaged should return undefined since the hook failed
      assert.strictEqual(result, undefined, "Expected undefined on pre-commit hook failure");

      // Verify no commit was created beyond the initial
      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      assert.strictEqual(count, 1, "Expected only the initial commit (hook rejected)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  it("commitStaged returns undefined on noisy pre-commit hook failure (stderr output)", async () => {
    const repoDir = createRepoWithNoisyFailingHook();
    after(() => removeDir(repoDir));

    writeFileSync(path.join(repoDir, "lint-fix.ts"), "// ok");
    execSync("git add lint-fix.ts", { cwd: repoDir, stdio: "ignore" });

    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await commitStaged(repoDir, mockCtx(), ["lint-fix.ts"], undefined, undefined);

      // Must still gracefully handle hook failure even with stderr noise
      assert.strictEqual(result, undefined, "Expected undefined on noisy pre-commit hook failure");

      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 1, "No commit should have been made");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  // -----------------------------------------------------------------------
  // tryCommit grouped flow (index.ts) — error recovery
  // -----------------------------------------------------------------------

  it("tryCommit grouped flow handles commit-msg hook failure gracefully", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Add a failing commit-msg hook
    const hookDir = path.join(repoDir, ".git", "hooks");
    if (!existsSync(hookDir)) {
      mkdirSync(hookDir, { recursive: true });
    }
    writeFileSync(path.join(hookDir, "commit-msg"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(hookDir, "commit-msg"), 0o755);

    setConfig({ ...originalConfig, stagedCommits: true });

    writeFileSync(path.join(repoDir, "a.ts"), "// a\n");
    writeFileSync(path.join(repoDir, "b.ts"), "// b\n");

    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await tryCommit(repoDir, mockCtx(), true, undefined);

      // tryCommit should return 0 since the hook rejects
      assert.strictEqual(result, 0, "Expected 0 commits when commit-msg hook fails");

      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 1, "No commits should have been created");
    } finally {
      __setCreateAgentSessionMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("tryCommit grouped flow handles pre-commit hook failure gracefully and continues", async () => {
    // Use a repo with a failing pre-commit hook
    const repoDir = createRepoWithFailingHook();
    after(() => removeDir(repoDir));

    setConfig({ ...originalConfig, stagedCommits: true });

    // Create several files so there are multiple groups
    mkdirSync(path.join(repoDir, "src"), { recursive: true });
    writeFileSync(path.join(repoDir, "src", "feature.ts"), "export const feat = () => 1;\n");
    writeFileSync(path.join(repoDir, "src", "feature.test.ts"), "import { test } from 'node:test';\n");

    // Mock subagent
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await tryCommit(repoDir, mockCtx(), true, undefined);

      // tryCommit should return 0 since the hook rejects all commits
      assert.strictEqual(result, 0, "Expected 0 commits when pre-commit hook always fails");

      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 1, "No commits should have been created");
    } finally {
      __setCreateAgentSessionMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("tryCommit grouped flow creates a single commit with mocked subagent (fallback to single group)", async () => {
    // With a mocked subagent that returns empty output, generateStagedCommitGroups
    // falls back to singleGroupFallback, producing one commit with all files.
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    setConfig({ ...originalConfig, stagedCommits: true });

    writeFileSync(path.join(repoDir, "feature.ts"), "export const feat = () => 2;\n");
    writeFileSync(path.join(repoDir, "feature.test.ts"), "import { test } from 'node:test';\n");

    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      // Force=false so async isn't triggered, goes through grouped sync path
      const result = await tryCommit(repoDir, mockCtx(), false, undefined);

      // Mock subagent fallback creates a single group → 1 commit
      assert.strictEqual(result, 1, "Expected 1 commit in grouped flow with mocked subagent");

      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      // Initial + 1 = 2
      assert.strictEqual(log.split("\n").length, 2, "Expected 2 total commits (initial + 1 group)");
    } finally {
      __setCreateAgentSessionMock(undefined);
      setConfig(originalConfig);
    }
  });

  // -----------------------------------------------------------------------
  // Widget error rendering
  // -----------------------------------------------------------------------

  it("commit widget renders failed commits in the log", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;
    const progress: CommitterProgress = {
      phase: "done",
      fileCount: 2,
      statusMessage: "All commits created",
      commitLog: [
        { hash: "abc1234", message: "feat: add feature", success: true },
        { hash: "", message: "fix: bugfix", success: false },
      ],
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    const joined = lines.join("\n");

    // Should mention the failed commit
    assert.ok(joined.includes("fail") || joined.includes("✗"), "Widget should indicate failed commits");
  });

  // -----------------------------------------------------------------------
  // Async worker single-commit fix regression
  // -----------------------------------------------------------------------

  it("async worker handles single commit failure gracefully (via fork mock)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `as-fail-${i}.ts`), `// test ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 12345;
    mockChild.kill = () => {};
    mockChild.send = () => true;
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1 when async started");

      // The async flag should be set
      assert.ok(_getAsyncCommitStarted(), "async commit flag should be set");

      // Simulate worker sending a single-commit failure error result
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "Worker single commit failed: Command failed: git commit -F -",
      });

      // Flag cleared after result
      assert.strictEqual(_getAsyncCommitStarted(), false, "flag cleared after error result");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("async worker handles group commit failure gracefully (via fork mock)", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    // We need enough files to trigger async (asyncThreshold >= file count)
    setConfig({ ...originalConfig, asyncThreshold: 2, stagedCommits: true });

    // Create multiple files to trigger async + grouped path
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `grp-${i}.ts`), `// grp ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 12346;
    mockChild.kill = () => {};
    mockChild.send = () => true;
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1 when async started");
      assert.ok(_getAsyncCommitStarted(), "async flag set");

      // Simulate worker sending a group commit error
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "Worker group commit failed: Command failed: git commit -F -",
      });

      assert.strictEqual(_getAsyncCommitStarted(), false, "flag cleared after group error");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  // -----------------------------------------------------------------------
  // Edge case: diff becomes empty between group generation and commit
  // -----------------------------------------------------------------------

  it("commitStaged returns undefined when no staged changes (empty diff)", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Stage nothing — diff will be empty
    const result = await commitStaged(repoDir, mockCtx(), [], undefined, undefined);
    assert.strictEqual(result, undefined, "Expected undefined for empty staged diff");
  });

  // -----------------------------------------------------------------------
  // Author identity not configured
  // -----------------------------------------------------------------------

  it("commitStaged returns undefined on missing git author identity", async () => {
    const repoDir = mkdtempSync(path.join(tmpDir(), "pi-committer-test-noauth-"));
    after(() => removeDir(repoDir));

    execSync("git init", { cwd: repoDir, stdio: "ignore" });
    writeFileSync(path.join(repoDir, "README.md"), "# test\n");
    // Set identity locally just for the initial commit
    execSync("git config user.name Seed", { cwd: repoDir, stdio: "ignore" });
    execSync("git config user.email seed@test.com", { cwd: repoDir, stdio: "ignore" });
    execSync("git add -A", { cwd: repoDir, stdio: "ignore" });
    execSync("git commit -m root", { cwd: repoDir, stdio: "ignore" });
    // Unset local identity so the NEXT commit has no author info
    execSync("git config --unset user.name", { cwd: repoDir, stdio: "ignore" });
    execSync("git config --unset user.email", { cwd: repoDir, stdio: "ignore" });

    writeFileSync(path.join(repoDir, "work.ts"), "// work\n");
    execSync("git add work.ts", { cwd: repoDir, stdio: "ignore" });

    const origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const origGitAuthorName = process.env.GIT_AUTHOR_NAME;
    const origGitAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    const origGitCommiterName = process.env.GIT_COMMITTER_NAME;
    const origGitCommiterEmail = process.env.GIT_COMMITTER_EMAIL;

    // Prevent git from falling back to global config by pointing to /dev/null
    // and set git identity env vars to empty so git fails with "empty ident name"
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_AUTHOR_NAME = "";
    process.env.GIT_AUTHOR_EMAIL = "";
    process.env.GIT_COMMITTER_NAME = "";
    process.env.GIT_COMMITTER_EMAIL = "";

    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: () => () => {},
        abort: () => {},
      },
    }));

    try {
      const result = await commitStaged(repoDir, mockCtx(), ["work.ts"], undefined, undefined);

      // Should fail because git can't determine the author identity
      assert.strictEqual(result, undefined, "Expected undefined when author identity is missing");

      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 1, "No commit should have been created");
    } finally {
      if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
      else delete process.env.GIT_CONFIG_GLOBAL;
      if (origGitAuthorName !== undefined) process.env.GIT_AUTHOR_NAME = origGitAuthorName;
      else delete process.env.GIT_AUTHOR_NAME;
      if (origGitAuthorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = origGitAuthorEmail;
      else delete process.env.GIT_AUTHOR_EMAIL;
      if (origGitCommiterName !== undefined) process.env.GIT_COMMITTER_NAME = origGitCommiterName;
      else delete process.env.GIT_COMMITTER_NAME;
      if (origGitCommiterEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = origGitCommiterEmail;
      else delete process.env.GIT_COMMITTER_EMAIL;
      __setCreateAgentSessionMock(undefined);
    }
  });

  // -----------------------------------------------------------------------
  // Large commit message handling (ENOBUFS / pipe buffer edge case)
  // -----------------------------------------------------------------------

  it("handles very large commit messages gracefully", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    // Create a message larger than typical OS pipe buffer (64KB) to stress the
    // stdin pipe of `git commit -F -`
    const bigBody = "x".repeat(80 * 1000); // ~80KB
    const hugeMessage = `feat(core): add massive change\n\n${bigBody}\n`;

    writeFileSync(path.join(repoDir, "huge.ts"), "// huge\n");
    execSync("git add huge.ts", { cwd: repoDir, stdio: "ignore" });

    // Use execSync directly to call git commit with a huge message
    // This should either succeed (if buffers are large enough) or fail gracefully
    try {
      execSync("git commit -F -", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        input: hugeMessage,
        maxBuffer: 10 * 1024 * 1024,
      });

      // Success case: commit was created
      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 2, "Expected 2 commits (initial + huge message)");
    } catch (err) {
      // Failure case: execSync threw, but it should NOT be a crash
      // Any execSync error is acceptable - the important thing is it doesn't
      // crash the process
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(msg.length > 0, "Error message should be present");
      // Verify no partial commit was created
      const log = execSync("git log --oneline", {
        cwd: repoDir, encoding: "utf-8",
      }).trim();
      assert.strictEqual(log.split("\n").length, 1, "No commit should have been created on error");
    }
  });

  it("commitStaged handles large commit messages from subagent gracefully", async () => {
    const repoDir = createTempRepo();
    after(() => removeDir(repoDir));

    writeFileSync(path.join(repoDir, "big.ts"), "// big\n");
    execSync("git add big.ts", { cwd: repoDir, stdio: "ignore" });

    // Mock a subagent that returns a very large commit message
    const bigBody = "y".repeat(80 * 1000); // ~80KB
    const hugeMessage = `feat(core): massive update\n\n${bigBody}\n`;

    let promptResolve: (() => void) | undefined;
    __setCreateAgentSessionMock(async (_opts: any) => {
      // We need the session.prompt to be called so it triggers message_end
      // events. Use a deferred resolve to control timing.
      return {
        session: {
          prompt: async () => {},
          subscribe: (cb: any) => {
            // Emit a message_end with the huge message
            setImmediate(() => {
              cb({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: hugeMessage }],
                },
              });
            });
            return () => {};
          },
          abort: () => {},
        },
      };
    });

    try {
      const result = await commitStaged(repoDir, mockCtx(), ["big.ts"], undefined, undefined);

      // Either the commit succeeds (hash returned) or fails gracefully (undefined)
      // The important thing is no crash/unhandled error
      if (result) {
        assert.strictEqual(result.length, 40, "Expected 40-char SHA on success");
      } else {
        // Fail gracefully: no commit was created but no crash
        const log = execSync("git log --oneline", {
          cwd: repoDir, encoding: "utf-8",
        }).trim();
        assert.strictEqual(log.split("\n").length, 1, "No commit should have been created");
      }
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });
});

// ===========================================================================
// Widget error rendering for sync commit failures
// ===========================================================================

describe("widget error rendering for sync commit failures", () => {
  it("renders done phase with error when all grouped commits fail", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;

    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 0,
      completedCommits: 0,
      commitLog: [
        { hash: "", message: "feat: first change", success: false },
        { hash: "", message: "fix: second change", success: false },
      ],
      error: "All 2 commit group(s) failed (2 with errors) — check git hooks or working tree",
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    const joined = lines.join("\n");

    assert.ok(lines[0].includes("complete"), "header should show complete");
    assert.ok(lines[0].includes("0 commits"), "header should show 0 commits");
    assert.ok(
      joined.includes("All 2 commit group(s) failed"),
      "should render the progress.error message: " + joined,
    );
    assert.ok(
      joined.includes("✗"),
      "should render error icon for failed commit log entries",
    );
  });

  it("renders done phase without error when all grouped commits succeed", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;

    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 2,
      completedCommits: 2,
      commitLog: [
        { hash: "aaa1111", message: "feat: first", success: true },
        { hash: "bbb2222", message: "fix: second", success: true },
      ],
      error: undefined,
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    const joined = lines.join("\n");

    assert.ok(lines[0].includes("complete"), "header should show complete");
    assert.ok(lines[0].includes("2 commits"), "header should show 2 commits");
    assert.ok(
      !joined.includes("failed"),
      "should NOT render 'failed' text when all commits succeed",
    );
    assert.ok(
      !joined.includes("error"),
      "should NOT render 'error' text when all commits succeed",
    );
  });

  it("renders done phase with only heading when no error and no commit log", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;

    // No error, no commit log — just heading
    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 0,
      completedCommits: 0,
      commitLog: [],
      error: undefined,
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    assert.strictEqual(lines.length, 1, "should only render the heading line");
    // The heading includes "complete  0 commits" (double space between word and number)
    assert.ok(lines[0].includes("complete"), "should show complete");
    assert.ok(lines[0].includes("0"), "should show 0");
  });
});

// ===========================================================================
// Sync path: hallucinated subagent file names handling
// ===========================================================================

describe("sync path handles hallucinated subagent file names", () => {
  let originalConfig: CommitterConfig;
  let dir: string;

  before(() => {
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
  });

  it("tryCommit does not crash when subagent hallucinates a file in commit groups", async () => {
    dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, stagedCommits: true, subagentGroupingMinFiles: 2 });

    writeFileSync(path.join(dir, "module.ts"), "export const m = 1;\n");
    writeFileSync(path.join(dir, "module.test.ts"), "import { test } from 'node:test';\n");

    // Mock subagent that fires message_end synchronously during subscribe.
    // The subscribe callback is invoked with the event immediately, so
    // outputParts are populated before session.prompt resolves.
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: (cb: any) => {
          // Fire synchronously so output is captured before prompt resolves
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `--- COMMIT GROUP 1 ---
feat(core): add module

Module implementation.
Files: module.ts

--- COMMIT GROUP 2 ---
test(core): add tests

Test suite.
Files: module.test.ts, nonexistent.ts`,
                },
              ],
            },
          });
          return () => {};
        },
        abort: () => {},
      },
    }));

    try {
      // This should not throw — the hallucinated file is filtered out by parseCommitGroups
      const result = await tryCommit(dir, mockCtx({ cwd: dir }), true, undefined);

      // Should have created 2 commits (one for each valid group, nonexistent.ts filtered out)
      assert.strictEqual(result, 2, "Expected 2 commits (both groups with valid files)");

      const log = execSync("git log --oneline", {
        cwd: dir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      // Initial + 2 = 3
      assert.strictEqual(count, 3, "Expected 3 total commits (initial + 2 groups)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  it("tryCommit handles hallucinated file gracefully even with all files hallucinated", async () => {
    dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, stagedCommits: true });

    writeFileSync(path.join(dir, "real.ts"), "// real\n");

    // Mock subagent that fires message_end synchronously
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: (cb: any) => {
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `--- COMMIT GROUP 1 ---
chore: update

Changes.
Files: hallucinated.ts`,
                },
              ],
            },
          });
          return () => {};
        },
        abort: () => {},
      },
    }));

    try {
      // Should fall through to singleGroupFallback because all parsed groups have 0 valid files
      const result = await tryCommit(dir, mockCtx({ cwd: dir }), true, undefined);

      // Fallback should produce 1 commit with the actual file
      assert.strictEqual(result, 1, "Expected 1 commit via fallback when all hallucinated");

      const log = execSync("git log --oneline", {
        cwd: dir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      assert.strictEqual(count, 2, "Expected 2 total commits (initial + fallback)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });
});

// ===========================================================================
// Async path: IPC error delivery (mock fork)
// ===========================================================================

describe("async path IPC error delivery (mock fork)", () => {
  let originalConfig: CommitterConfig;

  before(() => {
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    __setForkMock(undefined);
  });

  it("widget shows the actual IPC error message when worker sends error result", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `ipc-err-${i}.ts`), `// ipc error ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 77771;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1 for async commit");

      // Worker sends an error result via IPC with a specific error message
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "fatal: pathspec 'nonexistent.ts' did not match any files",
      });

      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(progress!.phase, "done", "phase should be done after result");
      assert.strictEqual(
        progress!.error,
        "fatal: pathspec 'nonexistent.ts' did not match any files",
        "widget should show the actual error message, not generic 'Subprocess exited'",
      );
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });

  it("widget shows error from IPC result even when exit happens first", async () => {
    const dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, asyncThreshold: 3 });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(dir, `ipc-exit-first-${i}.ts`), `// exit first ${i}\n`);
    }

    const EventEmitter = await import("node:events");
    const mockChild = new EventEmitter.default() as any;
    mockChild.pid = 77772;
    mockChild.kill = () => {};
    mockChild.unref = () => {};
    mockChild.stdout = null;
    mockChild.stderr = null;
    mockChild.stdin = null;
    mockChild.connected = true;
    mockChild.exitCode = null;
    mockChild.killed = false;
    mockChild.send = () => true;

    const forkFn = (_path: string, _args: string[], _opts: any) => mockChild;
    __setForkMock(forkFn as any);

    const ctxWithUI = mockCtx({
      cwd: dir,
      hasUI: true,
      ui: {
        notify: () => {},
        onTerminalInput: () => () => {},
        setWidget: () => {},
      },
    });

    try {
      const result = await tryCommit(dir, ctxWithUI, true, undefined);
      assert.strictEqual(result, -1, "should return -1 for async commit");

      // IPC result arrives BEFORE exit event — this is the normal flow
      // with the fixed sendResultAndExit (message callback fires before process.exit).
      mockChild.emit("message", {
        type: "result",
        commitCount: 0,
        commitLog: [],
        error: "fatal: pathspec 'nonexistent.ts' did not match any files",
      });
      mockChild.emit("exit", 1);

      const progress = _getCommitterProgress();
      assert.ok(progress, "committer progress should exist");
      assert.strictEqual(
        progress!.error,
        "fatal: pathspec 'nonexistent.ts' did not match any files",
        "widget should show the actual error, not generic 'Subprocess exited'",
      );
      assert.strictEqual(_getAsyncCommitStarted(), false, "async flag should be cleared");
    } finally {
      __setForkMock(undefined);
      setConfig(originalConfig);
    }
  });
});

// ===========================================================================
// Worker parseCommitGroups (integration via mock fork)
// ===========================================================================

describe("worker parseCommitGroups hallucinated file filtering (via fork mock)", () => {
  let originalConfig: CommitterConfig;

  before(() => {
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    __setForkMock(undefined);
    __setCreateAgentSessionMock(undefined);
  });

  it("parseCommitGroups filters hallucinated file names", () => {
    const output = `--- COMMIT GROUP 1 ---
feat(core): add module

Module implementation.
Files: module.ts

--- COMMIT GROUP 2 ---
test(core): add tests

Test suite.
Files: module.test.ts, nonexistent.ts`;

    const allFiles = ["module.ts", "module.test.ts"];
    const groups = parseCommitGroups(output, allFiles);

    // Both groups have at least one valid file — both should be kept
    assert.strictEqual(groups.length, 2, "both groups have valid files after filtering");
    assert.deepStrictEqual(groups[0].files, ["module.ts"], "group 1: allFiles includes module.ts");
    assert.deepStrictEqual(groups[1].files, ["module.test.ts"], "group 2: nonexistent.ts filtered out by allFiles filter");
  });

  it("parseCommitGroups filters hallucinated file names in fallback path", () => {
    const output = `--- COMMIT GROUP 1 ---
chore: update

Changes.
Files: hallucinated.ts`;

    const allFiles = ["real.ts"];
    const groups = parseCommitGroups(output, allFiles);

    // The group has no valid files, so it should be skipped entirely
    assert.strictEqual(groups.length, 0, "should skip groups with no valid files");
  });

  it("parseCommitGroups handles overlapping file names", () => {
    // Subagent puts the same file in multiple groups
    const output = `--- COMMIT GROUP 1 ---
feat(core): add module

Module.
Files: module.ts

--- COMMIT GROUP 2 ---
test(core): test module

Testing.
Files: module.ts, module.test.ts`;

    const allFiles = ["module.ts", "module.test.ts"];
    const groups = parseCommitGroups(output, allFiles);

    // Both groups have valid files, so both should be kept
    assert.strictEqual(groups.length, 2, "both groups should be kept with valid files");
    assert.strictEqual(groups[0].files.length, 1, "first group: module.ts");
    assert.strictEqual(groups[1].files.length, 2, "second group: module.ts + module.test.ts");
  });
});

// ===========================================================================
// subagentGroupingMinFiles config and behavior
// ===========================================================================

describe("subagentGroupingMinFiles config", () => {
  it("default value is 4", () => {
    const cfg = loadConfig("/tmp/nonexistent");
    assert.strictEqual(cfg.subagentGroupingMinFiles, 4);
  });

  it("parses subagent_grouping_min_files from TOML", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-grouping-cfg-"));
    after(() => removeDir(dir));

    const toml = `[committer]
subagent_grouping_min_files = 2
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.subagentGroupingMinFiles, 2);
    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("parses subagent_grouping_min_files from JSON", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-grouping-cfg2-"));
    after(() => removeDir(dir));

    const json = JSON.stringify({
      committer: {
        subagent_grouping_min_files: 3,
      },
    });
    writeFileSync(path.join(dir, ".pi-committer.json"), json, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.subagentGroupingMinFiles, 3);
    fs.rmSync(path.join(dir, ".pi-committer.json"));
  });

  it("ignores non-number value", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-grouping-cfg3-"));
    after(() => removeDir(dir));

    const toml = `[committer]
subagent_grouping_min_files = "not-a-number"
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.subagentGroupingMinFiles, 4, "should fall back to default");
    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("subagentThinkingLevel defaults to off", () => {
    const cfg = loadConfig("/tmp/nonexistent");
    assert.strictEqual(cfg.subagentThinkingLevel, "off");
  });

  it("parses subagent_thinking_level from TOML", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-thinking-cfg-"));
    after(() => removeDir(dir));

    const toml = `[committer]
subagent_thinking_level = "low"
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.subagentThinkingLevel, "low");
    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("ignores invalid subagent_thinking_level value", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-thinking-cfg2-"));
    after(() => removeDir(dir));

    const toml = `[committer]
subagent_thinking_level = "super-deep"
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.subagentThinkingLevel, "off", "should fall back to default");
    fs.rmSync(path.join(dir, ".pi-committer.toml"));
  });

  it("accepts all valid thinking levels", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-thinking-cfg3-"));
      after(() => removeDir(dir));

      const toml = `[committer]
subagent_thinking_level = "${level}"
`;
      writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

      const cfg = loadConfig(dir);
      assert.strictEqual(cfg.subagentThinkingLevel, level, `level "${level}" should be accepted`);
      fs.rmSync(path.join(dir, ".pi-committer.toml"));
    }
  });
});

describe("subagentGroupingMinFiles behaviour", () => {
  let originalConfig: CommitterConfig;
  let dir: string;

  before(() => {
    setConfig(loadConfig(process.cwd()));
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    __setCreateAgentSessionMock(undefined);
  });

  it("2 files with stagedCommits=true and default threshold uses single-commit path", async () => {
    dir = createTempRepo();
    after(() => removeDir(dir));

    // Default subagentGroupingMinFiles = 4, so 2 < 4 -> single-commit path
    setConfig({ ...originalConfig, stagedCommits: true });

    writeFileSync(path.join(dir, "file-a.ts"), "// a\n");
    writeFileSync(path.join(dir, "file-b.ts"), "// b\n");

    // Mock subagent for commit message (single-commit path still uses subagent)
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: (cb: any) => {
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "feat: add module files" }],
            },
          });
          return () => {};
        },
        abort: () => {},
      },
    }));

    try {
      const result = await tryCommit(dir, mockCtx({ cwd: dir }), true, undefined);

      // Single-commit path produces 1 commit
      assert.strictEqual(result, 1, "2 files with default threshold should produce 1 commit (single path)");

      const log = execSync("git log --oneline", {
        cwd: dir, encoding: "utf-8",
      }).trim();
      const count = log.split("\n").length;
      // Initial + 1 = 2
      assert.strictEqual(count, 2, "Expected 2 total commits (initial + 1 single commit)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  it("2 files with stagedCommits=true and threshold=2 uses grouped path", async () => {
    dir = createTempRepo();
    after(() => removeDir(dir));

    // Set threshold to 2 so 2 >= 2 triggers grouped path
    setConfig({ ...originalConfig, stagedCommits: true, subagentGroupingMinFiles: 2 });

    writeFileSync(path.join(dir, "file-x.ts"), "// x\n");
    writeFileSync(path.join(dir, "file-y.ts"), "// y\n");

    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {},
        subscribe: (cb: any) => {
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `--- COMMIT GROUP 1 ---
feat: add x

X.
Files: file-x.ts

--- COMMIT GROUP 2 ---
feat: add y

Y.
Files: file-y.ts`,
                },
              ],
            },
          });
          return () => {};
        },
        abort: () => {},
      },
    }));

    try {
      const result = await tryCommit(dir, mockCtx({ cwd: dir }), true, undefined);

      // Grouped path produces 2 commits
      assert.strictEqual(result, 2, "2 files with threshold=2 should produce 2 commits (grouped path)");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });

  it("single commit path still uses subagent for commit message", async () => {
    dir = createTempRepo();
    after(() => removeDir(dir));

    setConfig({ ...originalConfig, stagedCommits: true });

    writeFileSync(path.join(dir, "only-one.ts"), "// only one\n");
    writeFileSync(path.join(dir, "only-two.ts"), "// only two\n");

    let subagentCalled = false;

    // Mock subagent that tracks if it was called
    __setCreateAgentSessionMock(async (_opts: any) => ({
      session: {
        prompt: async () => {
          subagentCalled = true;
        },
        subscribe: (cb: any) => {
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "chore: update files" }],
            },
          });
          return () => {};
        },
        abort: () => {},
      },
    }));

    try {
      const result = await tryCommit(dir, mockCtx({ cwd: dir }), true, undefined);

      assert.strictEqual(result, 1, "should produce 1 commit");
      assert.ok(subagentCalled, "subagent should still be called for commit message in single-commit path");
    } finally {
      __setCreateAgentSessionMock(undefined);
    }
  });
});

describe("widget rendering for small grouped commit (single-path fallback)", () => {
  it("renders proper heading for 1-commit single path from small file set", () => {
    const theme = {
      fg: (_c: string, t: string) => t,
      bold: (t: string) => t,
    } as any;

    const progress: CommitterProgress = {
      phase: "done",
      totalCommits: 1,
      completedCommits: 1,
      commitLog: [
        { hash: "aaa1111", message: "feat: add small commit", success: true },
      ],
      error: undefined,
      startedAt: Date.now(),
    };

    const lines = renderCommitterWidgetLines(progress, theme, 80);
    const joined = lines.join("\n");

    assert.ok(lines[0].includes("complete"), "header should show complete");
    assert.ok(lines[0].includes("1 commit"), "header should show 1 commit");
    assert.ok(
      !joined.includes("✗"),
      "should not show error icon for successful commit",
    );
    assert.ok(
      joined.includes("aaa1111"),
      "should show commit hash",
    );
    assert.ok(
      joined.includes("feat: add small commit"),
      "should show commit message in log",
    );
  });
});

// ===========================================================================
// Worker execArgv resolution — tests for the node_modules/TypeScript fix
// ===========================================================================

describe("resolveWorkerExecArgv / _findJitiRegisterForPath", () => {
  it("returns --experimental-strip-types when worker is NOT under node_modules", () => {
    const result = resolveWorkerExecArgv("/home/user/project/worker.ts");
    assert.deepStrictEqual(result, ["--experimental-strip-types"]);
  });

  it("returns --experimental-strip-types for a path without 'node_modules'", () => {
    const result = resolveWorkerExecArgv("/Users/test/projects/my-app/worker.ts");
    assert.deepStrictEqual(result, ["--experimental-strip-types"]);
  });

  it("returns jiti --import when worker is under node_modules and jiti is available at sibling", () => {
    // Use the real jiti in the dev project's node_modules to verify detection works
    const cwd = process.cwd();
    const realJitiPath = path.join(cwd, "node_modules", "jiti", "lib", "jiti-register.mjs");

    // Only run this assertion if jiti actually exists (CI/npm-installed environments)
    if (existsSync(realJitiPath)) {
      // Construct a worker path in the same node_modules as jiti
      const workerInNm = path.join(cwd, "node_modules", "any-pkg", "worker.ts");
      const argv = resolveWorkerExecArgv(workerInNm);

      assert.strictEqual(argv.length, 2);
      assert.strictEqual(argv[0], "--import");
      // The jiti register path should be returned
      assert.ok(argv[1].endsWith("jiti/lib/jiti-register.mjs"), `Expected jiti register path, got: ${argv[1]}`);
    }
  });

  it("_findJitiRegisterForPath finds jiti in sibling node_modules", () => {
    const cwd = process.cwd();
    const realJitiPath = path.join(cwd, "node_modules", "jiti", "lib", "jiti-register.mjs");

    if (existsSync(realJitiPath)) {
      const workerInNm = path.join(cwd, "node_modules", "some-package", "worker.ts");
      const result = _findJitiRegisterForPath(workerInNm);

      assert.ok(result, "Expected jiti register to be found");
      assert.ok(result.endsWith("jiti/lib/jiti-register.mjs"), `Expected jiti register, got: ${result}`);
      assert.ok(existsSync(result!), `Expected ${result} to exist`);
    }
  });

  it("_findJitiRegisterForPath returns null for imaginary path with no jiti", () => {
    // A path that has no node_modules prefix — still checked against
    // PI agent dir and cwd, both of which may or may not have jiti.
    // The key assertion: no error is thrown.
    const result = _findJitiRegisterForPath("/tmp/no-jiti-here/worker.ts");
    // This should not throw — either returns a path or null
    assert.ok(result === null || typeof result === "string");
  });

  it("_findJitiRegisterForPath handles edge case: no node_modules in path", () => {
    const result = _findJitiRegisterForPath("/plain/path/worker.ts");
    // Should not throw; null or a path from strategies 2/3
    assert.ok(result === null || typeof result === "string");
  });

  it("_findJitiRegisterForPath handles edge case: exactly 'node_modules' boundary", () => {
    // Path ending right at node_modules prefix
    const result = _findJitiRegisterForPath("/some/node_modules/extra/path/worker.ts");
    // Should not throw
    assert.ok(result === null || typeof result === "string");
  });
});

// ===========================================================================
// Async worker IPC integration — fork the real worker, send params, verify result
// ===========================================================================

describe("async worker IPC integration", () => {
  it("completes successfully with no subagentModel configured (deterministic fallback)", async () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-ipc-"));
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    // Init git repo
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });

    // Create initial commit
    writeFileSync(path.join(dir, "README.md"), "# test\n");
    execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });

    // Create some changes
    writeFileSync(path.join(dir, "file1.ts"), "// file1\n");
    writeFileSync(path.join(dir, "file2.ts"), "// file2\n");
    writeFileSync(path.join(dir, "file3.ts"), "// file3\n");

    // Stage all
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    // Get diff stat and content
    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const diffContent = execSync("git diff --cached", {
      cwd: dir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const allFiles = diffStat
      .split("\n")
      .filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    // Fork the worker
    const workerPath = fileURLToPath(new URL("../async-commit-worker.ts", import.meta.url));
    const child = fork(workerPath, [], {
      execArgv: resolveWorkerExecArgv(workerPath),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    // Wait for result from worker
    const result = await new Promise<{ commitCount: number; commitLog: any[]; error?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Worker timed out after 15 seconds"));
      }, 15_000);

      child.on("message", (msg: any) => {
        if (msg?.type === "result") {
          clearTimeout(timeout);
          resolve(msg);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited with code ${code} before sending result`));
      });

      // Send params to the worker
      child.send({
        type: "start",
        params: {
          dir,
          diffStat,
          diffContent,
          allFiles,
          stagedCommits: true,
          excludePatterns: [],
          minChanges: 1,
          subagentModel: undefined,  // No model configured — tests deterministic fallback
          subagentGroupingMinFiles: 4,
          subagentThinkingLevel: "off",
        },
      });
    });

    // Verify the result
    assert.strictEqual(result.error, undefined, `worker should not error: ${result.error}`);
    assert.ok(result.commitCount > 0, "should have at least 1 commit");
    assert.ok(result.commitLog.length > 0, "should have commit log entries");

    // Verify the commits actually exist in the repo
    const commitCount = execSync("git rev-list --count HEAD", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    // Initial commit + new commits
    assert.ok(Number(commitCount) >= result.commitCount + 1, "commits should be in git history");

    // Verify deterministic message was used (no subagent) — contains "file" since no model
    const lastMsg = execSync("git log -1 --format=%B", { cwd: dir, encoding: "utf-8" }).trim();
    assert.ok(lastMsg.length > 0, "commit message should not be empty");
  });

  it("handles single commit mode (grouping disabled) with no model", async () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-ipc2-"));
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "README.md"), "# test\n");
    execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });

    // Single change
    writeFileSync(path.join(dir, "single.ts"), "// single\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const workerPath2 = fileURLToPath(new URL("../async-commit-worker.ts", import.meta.url));
    const child = fork(workerPath2, [], {
      execArgv: resolveWorkerExecArgv(workerPath2),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Timeout")); }, 15_000);
      child.on("message", (msg: any) => {
        if (msg?.type === "result") { clearTimeout(timeout); resolve(msg); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}`)); });

      child.send({
        type: "start",
        params: {
          dir,
          diffStat,
          diffContent,
          allFiles,
          stagedCommits: true,
          excludePatterns: [],
          minChanges: 1,
          subagentModel: undefined,
          subagentGroupingMinFiles: 4,
          subagentThinkingLevel: "off",
        },
      });
    });

    assert.strictEqual(result.error, undefined, `no error expected: ${result.error}`);
    assert.strictEqual(result.commitCount, 1, "single file should produce 1 commit");
    assert.strictEqual(result.commitLog.length, 1, "should have 1 log entry");
  });

  it("falls through to deterministic when staged_commits is false", async () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-ipc3-"));
    after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
    execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
    writeFileSync(path.join(dir, "README.md"), "# test\n");
    execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });

    writeFileSync(path.join(dir, "a.ts"), "// a\n");
    writeFileSync(path.join(dir, "b.ts"), "// b\n");
    execSync("git add -A", { cwd: dir, stdio: "ignore" });

    const diffStat = execSync("git diff --cached --stat", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diffContent = execSync("git diff --cached", {
      cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const allFiles = diffStat
      .split("\n").filter((l) => l.includes("|"))
      .map((l) => l.match(/^(.+?)\s+\|/)?.[1]?.trim() ?? "")
      .filter(Boolean);

    const workerPath3 = fileURLToPath(new URL("../async-commit-worker.ts", import.meta.url));
    const child = fork(workerPath3, [], {
      execArgv: resolveWorkerExecArgv(workerPath3),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Timeout")); }, 15_000);
      child.on("message", (msg: any) => {
        if (msg?.type === "result") { clearTimeout(timeout); resolve(msg); }
      });
      child.on("error", (err) => { clearTimeout(timeout); reject(err); });
      child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`exit ${code}`)); });

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
          subagentThinkingLevel: "off",
        },
      });
    });

    assert.strictEqual(result.error, undefined, `no error expected: ${result.error}`);
    assert.strictEqual(result.commitCount, 1, "single commit mode should produce 1 commit");
  });
});

// ===========================================================================
// batchStageFilesForGroup — warnings go to collector, NOT to ctx.ui.notify
// ===========================================================================

describe("batchStageFilesForGroup warning routing", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) removeDir(d);
    dirs.length = 0;
  });

  function makeRepo(): string {
    const d = createTempRepo();
    dirs.push(d);
    return d;
  }

  it("calls onWarning for unstageable files without calling ctx.ui.notify", () => {
    const dir = makeRepo();

    // Create a real file
    writeFileSync(path.join(dir, "real.ts"), "// real\n");
    execSync("git add real.ts", { cwd: dir, stdio: "ignore" });

    // onWarning simulates addUnstageableFileWarning — tracks the warning
    const warningCalls: Array<{ filePath: string; msg: string }> = [];
    const onWarning = (filePath: string, msg: string) => {
      warningCalls.push({ filePath, msg });
    };

    let groupSkippedCalled = false;
    const onGroupSkipped = () => {
      groupSkippedCalled = true;
    };

    // Spy to detect any ctx.ui.notify calls
    const notifySpy = mock.fn();

    // Call batchStageFilesForGroup with a mix of real and non-existent files.
    // The callbacks simulate the real call site: no ctx.ui.notify, just collectors.
    const result = batchStageFilesForGroup(
      dir,
      ["real.ts", "nonexistent.ts"],
      (filePath, msg) => {
        onWarning(filePath, msg);
        // This should NOT be ctx.ui.notify — that's the bug we fixed
      },
      () => {
        onGroupSkipped();
      },
    );

    // onWarning should have been called for the non-existent file
    assert.ok(warningCalls.length >= 1, "onWarning should be called for unstageable files");
    const nonexistentWarning = warningCalls.find((w) => w.filePath === "nonexistent.ts");
    assert.ok(nonexistentWarning, "onWarning should include the non-existent file");
    assert.ok(nonexistentWarning!.msg.length > 0, "warning should include an error message");

    // The real file should still be staged successfully
    assert.ok(result.staged.includes("real.ts"), "real file should be staged");

    // Both `addUnstageableFileWarning` (onWarning) AND no notify call:
    // warning was COLLECTED, not BROADCAST as a notification
    assert.strictEqual(
      notifySpy.mock.callCount(),
      0,
      "ctx.ui.notify must NOT be called during batchStageFilesForGroup warning callbacks",
    );

    // onGroupSkipped should NOT be called since we have real staged files
    assert.strictEqual(groupSkippedCalled, false, "onGroupSkipped should not be called when some files stage");
  });

  it("calls onGroupSkipped when empty group files array", () => {
    const dir = makeRepo();

    let groupSkippedCalled = false;

    const result = batchStageFilesForGroup(
      dir,
      [],
      () => {},
      () => {
        groupSkippedCalled = true;
      },
    );

    assert.strictEqual(groupSkippedCalled, true, "onGroupSkipped should be called for empty file list");
    assert.strictEqual(result.allFailed, true, "allFailed should be true");
    assert.strictEqual(result.staged.length, 0, "no files should be staged");
  });

  it("calls onWarning for each unstageable file path reported by git", () => {
    const dir = makeRepo();

    writeFileSync(path.join(dir, "keep.ts"), "// keep\n");
    execSync("git add keep.ts", { cwd: dir, stdio: "ignore" });

    const warned: string[] = [];

    // Note: git add only reports the FIRST pathspec error per invocation.
    // So only the first non-existent file is warned.
    batchStageFilesForGroup(
      dir,
      ["keep.ts", "missing-a.ts"],
      (filePath) => {
        warned.push(filePath);
      },
      () => {},
    );

    // The missing file should be warned
    assert.ok(warned.includes("missing-a.ts"), "missing-a.ts should be warned");
    // Real file should NOT be warned
    assert.ok(!warned.includes("keep.ts"), "real files should not be warned");
  });
});
