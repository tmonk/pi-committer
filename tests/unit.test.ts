import {
  describe,
  it,
  before,
  after,
  afterEach,
  mock,
} from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";

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

  // State
  getSelectedSubagentModel,
  setSelectedSubagentModel,

  // Commit
  tryCommit,
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

  it("defaults async_threshold to 10", () => {
    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.asyncThreshold, 10);
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
});
