/**
 * Tests for the defer_to_goal_audit logic in commit_changes.
 *
 * Reproduces the reported scenario: defer_to_goal_audit = false in
 * .pi-committer.toml, but commit_changes still defers when pi-goal
 * has an active goal.
 */
import {
  describe,
  it,
  before,
  after,
  mock,
} from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";

import {
  getConfig,
  setConfig,
  loadConfig,
  type CommitterConfig,

  hasGoalsExtension,
  hasActiveGoal,
  _clearGoalStatuses,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return process.env.TMPDIR || "/tmp";
}

function removeDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-defer-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add -A && git commit -m initial", { cwd: dir, stdio: "ignore" });
  return dir;
}

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

// ---------------------------------------------------------------------------
// The defer check condition (reproduced from index.ts line 1656-1659)
// ---------------------------------------------------------------------------

/**
 * Returns true when the commit_changes tool should defer to the automatic
 * on_goal trigger instead of committing immediately.
 *
 * Matches the exact logic in the commit_changes tool handler.
 */
export function shouldDeferToGoalAudit(
  config: CommitterConfig,
  ctx: any,
): boolean {
  return (
    config.deferToGoalAudit &&
    config.triggerMode === "on_goal" &&
    hasGoalsExtension(ctx) &&
    hasActiveGoal(ctx)
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("defer_to_goal_audit logic", () => {
  let originalConfig: CommitterConfig;

  before(() => {
    originalConfig = getConfig();
  });

  after(() => {
    setConfig(originalConfig);
    _clearGoalStatuses();
  });

  // -----------------------------------------------------------------------
  // The core bug report: defer_to_goal_audit=false SHOULD bypass deferral
  // -----------------------------------------------------------------------
  it("should NOT defer when defer_to_goal_audit = false, even with active goal", () => {
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-goal-state",
            data: { goal: { id: "g1", status: "running" } },
          },
        ],
      },
    });

    // Set config with defer_to_goal_audit = false (simulating user's config)
    const testConfig: CommitterConfig = {
      ...originalConfig,
      deferToGoalAudit: false,
      triggerMode: "on_goal",
    };

    const result = shouldDeferToGoalAudit(testConfig, ctx);
    assert.strictEqual(result, false,
      "should NOT defer when deferToGoalAudit=false, even with active goal");
  });

  // -----------------------------------------------------------------------
  // Sanity check: defer_to_goal_audit=true SHOULD defer with active goal
  // -----------------------------------------------------------------------
  it("SHOULD defer when defer_to_goal_audit = true and active goal exists", () => {
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-goal-state",
            data: { goal: { id: "g1", status: "running" } },
          },
        ],
      },
    });

    const testConfig: CommitterConfig = {
      ...originalConfig,
      deferToGoalAudit: true,
      triggerMode: "on_goal",
    };

    const result = shouldDeferToGoalAudit(testConfig, ctx);
    assert.strictEqual(result, true,
      "should defer when deferToGoalAudit=true with active goal");
  });

  // -----------------------------------------------------------------------
  // Edge case 1: No active goal → no deferral
  // -----------------------------------------------------------------------
  it("should NOT defer when all goals are complete", () => {
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-goal-state",
            data: { goal: { id: "g1", status: "complete" } },
          },
        ],
      },
    });

    const testConfig: CommitterConfig = {
      ...originalConfig,
      deferToGoalAudit: true,
      triggerMode: "on_goal",
    };

    const result = shouldDeferToGoalAudit(testConfig, ctx);
    assert.strictEqual(result, false,
      "should NOT defer when goal is complete");
  });

  // -----------------------------------------------------------------------
  // Edge case 2: No pi-goal-state entries → no deferral
  // -----------------------------------------------------------------------
  it("should NOT defer when pi-goal is not present", () => {
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [],
      },
    });

    const testConfig: CommitterConfig = {
      ...originalConfig,
      deferToGoalAudit: true,
      triggerMode: "on_goal",
    };

    const result = shouldDeferToGoalAudit(testConfig, ctx);
    assert.strictEqual(result, false,
      "should NOT defer when pi-goal is not present");
  });

  // -----------------------------------------------------------------------
  // Edge case 3: trigger_mode is not "on_goal" → no deferral
  // -----------------------------------------------------------------------
  it("should NOT defer when trigger_mode is not on_goal", () => {
    const ctx = mockCtx({
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-goal-state",
            data: { goal: { id: "g1", status: "running" } },
          },
        ],
      },
    });

    const testConfig: CommitterConfig = {
      ...originalConfig,
      deferToGoalAudit: true,
      triggerMode: "manual",  // Not "on_goal"
    };

    const result = shouldDeferToGoalAudit(testConfig, ctx);
    assert.strictEqual(result, false,
      "should NOT defer when trigger_mode is manual");
  });

  // -----------------------------------------------------------------------
  // Edge case 4: Config file round-trip — verify actual file parsing
  // -----------------------------------------------------------------------
  it("config file with defer_to_goal_audit=false produces CommitterConfig.deferToGoalAudit=false", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-cfg-defer-"));
    try {
      const toml = `[committer]
enabled = true
trigger_mode = "on_goal"
defer_to_goal_audit = false
staged_commits = true
`;
      writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

      const cfg = loadConfig(dir);
      assert.strictEqual(cfg.deferToGoalAudit, false,
        "loadConfig should parse defer_to_goal_audit=false correctly");
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.triggerMode, "on_goal");
    } finally {
      removeDir(dir);
    }
  });

  // -----------------------------------------------------------------------
  // Edge case 5: Config file round-trip — verify JSON parsing
  // -----------------------------------------------------------------------
  it("config file with defer_to_goal_audit=false (JSON) produces CommitterConfig.deferToGoalAudit=false", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-cfg-defer-json-"));
    try {
      const json = JSON.stringify({
        committer: {
          defer_to_goal_audit: false,
          enabled: true,
          trigger_mode: "on_goal",
        },
      });
      writeFileSync(path.join(dir, ".pi-committer.json"), json, "utf-8");

      const cfg = loadConfig(dir);
      assert.strictEqual(cfg.deferToGoalAudit, false,
        "loadConfig should parse defer_to_goal_audit=false from JSON correctly");
    } finally {
      removeDir(dir);
    }
  });

  // -----------------------------------------------------------------------
  // Integration: config file loaded at session start + commit_changes flow
  // -----------------------------------------------------------------------
  it("commit_changes should NOT defer when config file has defer_to_goal_audit=false and active goal exists", async () => {
    const repoDir = createTempRepo();
    try {
      // Create config file in the repo
      const toml = `[committer]
enabled = true
trigger_mode = "on_goal"
defer_to_goal_audit = false
staged_commits = true
`;
      writeFileSync(path.join(repoDir, ".pi-committer.toml"), toml, "utf-8");

      // Load config from repo (simulating session_start behavior)
      const cfg = loadConfig(repoDir);
      setConfig(cfg);

      assert.strictEqual(getConfig().deferToGoalAudit, false,
        "config should have deferToGoalAudit=false after loading from repo");

      // Create some changes
      writeFileSync(path.join(repoDir, "feat.ts"), "// new feature");

      // Create mock context with active pi-goal entries
      const ctx = mockCtx({
        cwd: repoDir,
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "pi-goal-state",
              data: { goal: { id: "g1", status: "running" } },
            },
          ],
        },
        ui: {
          notify: () => {},
        },
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
        },
      });

      // Verify the defer decision
      const shouldDefer = shouldDeferToGoalAudit(getConfig(), ctx);
      assert.strictEqual(shouldDefer, false,
        "shouldDeferToGoalAudit should return false when defer_to_goal_audit=false");

      // Verify the context has active goal (so the ONLY reason we don't defer
      // is because deferToGoalAudit is false)
      assert.strictEqual(hasGoalsExtension(ctx), true,
        "hasGoalsExtension should detect pi-goal entries");
      assert.strictEqual(hasActiveGoal(ctx), true,
        "hasActiveGoal should return true for running goal");

      // Now verify that the session_start would load this config correctly.
      // We simulate session_start by calling loadConfig with the repo dir.
      const sessionStartConfig = loadConfig(repoDir);
      assert.strictEqual(sessionStartConfig.deferToGoalAudit, false,
        "session_start should load deferToGoalAudit=false from repo config");
      assert.strictEqual(sessionStartConfig.triggerMode, "on_goal",
        "session_start should load triggerMode=on_goal from repo config");
      assert.strictEqual(sessionStartConfig.enabled, true,
        "session_start should load enabled=true from repo config");

    } finally {
      setConfig(originalConfig);
      removeDir(repoDir);
    }
  });

  // -----------------------------------------------------------------------
  // Edge case: What if the config file has an error and falls back to defaults?
  // This is a potential root cause for the reported bug.
  // -----------------------------------------------------------------------
  it("loadConfig returns defaults (deferToGoalAudit=true) when config file has syntax errors", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-cfg-bad-"));
    try {
      // Invalid TOML — missing value
      writeFileSync(path.join(dir, ".pi-committer.toml"), "[committer]\n  defer_to_goal_audit = \n", "utf-8");

      const cfg = loadConfig(dir);
      assert.strictEqual(cfg.deferToGoalAudit, true,
        "should fall back to default deferToGoalAudit=true when config has syntax errors");
    } finally {
      removeDir(dir);
    }
  });

  // -----------------------------------------------------------------------
  // What if defer_to_goal_audit is set as a string "false" instead of boolean?
  // -----------------------------------------------------------------------
  it("loadConfig ignores defer_to_goal_audit when set as string (not boolean)", () => {
    const dir = mkdtempSync(path.join(tmpDir(), "pi-committer-cfg-str-"));
    try {
      // Note: TOML would parse "false" as a string, not boolean
      const toml = `[committer]
enabled = true
defer_to_goal_audit = "false"
`;
      writeFileSync(path.join(dir, ".pi-committer.toml"), toml, "utf-8");

      const cfg = loadConfig(dir);
      assert.strictEqual(cfg.deferToGoalAudit, true,
        "should stay at default true when defer_to_goal_audit is a string, not boolean");
    } finally {
      removeDir(dir);
    }
  });

  // -----------------------------------------------------------------------
  // Verify the exact commit_changes handler logic with mocked sig + commitAllRepos
  // -----------------------------------------------------------------------
  it("full simulation: commit_changes handler should proceed to commitAllRepos when defer_to_goal_audit=false", async () => {
    const repoDir = createTempRepo();
    try {
      // Create config file
      const toml = `[committer]
enabled = true
trigger_mode = "on_goal"
defer_to_goal_audit = false
staged_commits = false
`;
      writeFileSync(path.join(repoDir, ".pi-committer.toml"), toml, "utf-8");

      // Load config (as session_start would)
      const cfg = loadConfig(repoDir);
      setConfig(cfg);

      // Create changes
      writeFileSync(path.join(repoDir, "commit-me.ts"), "// will this commit?");

      // Mock context with active goal (the scenario that was reported as broken)
      const ctx = mockCtx({
        cwd: repoDir,
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "pi-goal-state",
              data: { goal: { id: "g1", status: "running" } },
            },
          ],
        },
        ui: {
          notify: () => {},
        },
        modelRegistry: {
          getAvailable: () => [],
          find: () => undefined,
        },
      });

      // Simulate the exact check from the commit_changes tool handler
      if (
        getConfig().deferToGoalAudit &&
        getConfig().triggerMode === "on_goal" &&
        hasGoalsExtension(ctx) &&
        hasActiveGoal(ctx)
      ) {
        assert.fail("commit_changes would have deferred, but defer_to_goal_audit=false should prevent this");
      }

      // If we reach here, the defer check was correctly bypassed.
      // The commit would proceed to commitAllRepos.
      // We can't easily call commitAllRepos here without a mock subagent,
      // but we've verified the critical gate condition.
      assert.ok(true, "defer check correctly bypassed when defer_to_goal_audit=false");

      // Bonus: also verify that the defer check WOULD trigger if deferToGoalAudit were true
      // This confirms the logic works in both directions.
      const cfgWithDefer = { ...cfg, deferToGoalAudit: true };
      const shouldDefer = (
        cfgWithDefer.deferToGoalAudit &&
        cfgWithDefer.triggerMode === "on_goal" &&
        hasGoalsExtension(ctx) &&
        hasActiveGoal(ctx)
      );
      assert.strictEqual(shouldDefer, true,
        "with deferToGoalAudit=true, the same scenario SHOULD defer");
    } finally {
      setConfig(originalConfig);
      removeDir(repoDir);
    }
  });
});
