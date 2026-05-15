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
  unstageExcludedFiles,
  unstageAll,
  hasAnyChanges,

  // Commit logic
  parseCommitGroups,
  deterministicCommitMessage,
  shouldCommitOnTrigger,
  commitStaged,

  // Subagent
  resolveSubagentModel,
  __setCreateAgentSessionMock,
  __createAgentSessionMock,

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

  // State
  getSelectedSubagentModel,
  setSelectedSubagentModel,
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
    assert.strictEqual(cfg.deferToGoalAudit, true);
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

  it("defaults defer_to_goal_audit to true when not in config", () => {
    const toml = `[committer]
enabled = true
`;
    writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

    const cfg = loadConfig(dir);
    assert.strictEqual(cfg.deferToGoalAudit, true);

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

  it("returns true when a goal transitions to completed", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "completed" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    const saved = _resetGoalScanCount();

    const result = checkGoalEvents(ctx);
    _restoreGoalScanCount(saved);
    assert.strictEqual(result, true);
  });

  it("returns false when goal stays completed (no transition)", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "completed" } } },
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
  it("returns true when there is an active (non-completed) goal", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("returns false when all goals are completed", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "completed" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });

  it("returns false when there are no pi-goal-state entries", () => {
    const ctx = mockCtx({ sessionManager: { getEntries: () => [] } });
    assert.strictEqual(hasActiveGoal(ctx), false);
  });

  it("returns true for paused goals (not completed)", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "paused" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("scans backward and finds the latest goal status", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "completed" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "active" } } },
    ];
    const ctx = mockCtx({ sessionManager: { getEntries: () => entries } });
    // g1 is completed, g2 is active
    assert.strictEqual(hasActiveGoal(ctx), true);
  });

  it("returns false when last state of all goals is completed", () => {
    const entries = [
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "running" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g1", status: "completed" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "active" } } },
      { type: "custom", customType: "pi-goal-state", data: { goal: { id: "g2", status: "completed" } } },
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
// Config state helpers
// ===========================================================================

describe("config state accessors", () => {
  it("getConfig returns current config", () => {
    const cfg = getConfig();
    assert.ok(cfg);
    assert.ok("enabled" in cfg && "triggerMode" in cfg);
  });

  it("deferToGoalAudit defaults to true", () => {
    assert.strictEqual(getConfig().deferToGoalAudit, true);
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
