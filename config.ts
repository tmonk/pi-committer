import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriggerMode = "on_goal" | "agent_sensible" | "after_tool" | "manual";

export interface CommitterConfig {
  enabled: boolean;
  triggerMode: TriggerMode;
  detailedBody: boolean;
  minChanges: number;
  customTypes: string[];
  allowedScopes: string[];
  excludePatterns: string[];
  /** Optional lightweight model override for the commit-message subagent, e.g. "openai/gpt-4o-mini". */
  subagentModel?: string;
  /**
   * When true (default), group changed files by category and commit each group separately.
   * When false, commit all changes in a single monolithic commit.
   */
  stagedCommits: boolean;
  /**
   * When true and trigger_mode is "on_goal" with pi-goal present,
   * the commit_changes tool will skip committing if a goal is active and
   * defer to the automatic on_goal trigger (which runs after the goal audit passes).
   * This prevents premature commits before the pi-goal auditor has verified completion.
   *
   * Defaults to false — commit_changes always proceeds immediately unless the user
   * explicitly opts in to deferral by setting defer_to_goal_audit = true.
   */
  deferToGoalAudit: boolean;
  /**
   * Minimum number of changed files to trigger async (subprocess) mode.
   * When the changed file count >= this threshold, the commit is forked into a
   * detached child process so the conversation can continue immediately.
   * Set to 0 to disable async mode entirely (always synchronous).
   * Default: 10
   */
  asyncThreshold: number;
}

export const DEFAULT_CONFIG: CommitterConfig = {
  enabled: false,
  triggerMode: "on_goal",
  detailedBody: true,
  minChanges: 1,
  customTypes: [],
  allowedScopes: [],
  excludePatterns: [],
  subagentModel: undefined,
  stagedCommits: true,
  deferToGoalAudit: false,
  asyncThreshold: 5,
};

const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "style",
  "perf",
  "ci",
  "build",
  "revert",
];

// ---------------------------------------------------------------------------
// Config file helpers
// ---------------------------------------------------------------------------

/**
 * Find the config file by walking up directories from cwd.
 * Looks for `.pi-committer.toml` or `.pi-committer.json`.
 */
function findConfigFile(cwd: string): string | undefined {
  let dir = cwd;
  // Limit directory traversal to avoid infinite loops
  for (let i = 0; i < 20; i++) {
    const tomlPath = path.join(dir, ".pi-committer.toml");
    const jsonPath = path.join(dir, ".pi-committer.json");

    if (fs.existsSync(tomlPath)) return tomlPath;
    if (fs.existsSync(jsonPath)) return jsonPath;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Parse a config file's content (TOML or JSON) into raw key-value pairs.
 */
function parseConfigFile(filePath: string): Record<string, unknown> {
  const content = fs.readFileSync(filePath, "utf-8").trim();

  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(content);
    // Flatten committer section like TOML path does
    const raw: Record<string, unknown> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.committer && typeof obj.committer === "object") {
        const committer = obj.committer as Record<string, unknown>;
        for (const [key, value] of Object.entries(committer)) {
          raw[key] = value;
        }
      }
    }
    return raw;
  }

  // TOML parsing via smol-toml
  const parsed = parse(content);

  // The parsed structure is a nested object; we want to flatten from
  // a `[committer]` table or work with it directly
  const raw: Record<string, unknown> = {};

  // If there's a [committer] section, extract from there
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.committer && typeof obj.committer === "object") {
      const committer = obj.committer as Record<string, unknown>;
      for (const [key, value] of Object.entries(committer)) {
        raw[key] = value;
      }
    } else {
      // Fallback: read top-level keys
      for (const [key, value] of Object.entries(obj)) {
        raw[key] = value;
      }
    }
  }

  return raw;
}

/**
 * Apply raw config values over the defaults, with type coercion.
 */
function applyConfig(
  defaults: CommitterConfig,
  raw: Record<string, unknown>,
): CommitterConfig {
  const config = { ...defaults };

  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;

  if (typeof raw.trigger_mode === "string") {
    const mode = raw.trigger_mode as string;
    if (
      ["on_goal", "agent_sensible", "after_tool", "manual"].includes(mode)
    ) {
      config.triggerMode = mode as TriggerMode;
    }
  }

  if (typeof raw.detailed_body === "boolean") {
    config.detailedBody = raw.detailed_body;
  }

  if (typeof raw.min_changes === "number") {
    config.minChanges = raw.min_changes;
  }

  if (Array.isArray(raw.custom_types)) {
    config.customTypes = raw.custom_types.map(String);
  }

  if (Array.isArray(raw.allowed_scopes)) {
    config.allowedScopes = raw.allowed_scopes.map(String);
  }

  if (Array.isArray(raw.exclude_patterns)) {
    config.excludePatterns = raw.exclude_patterns.map(String);
  }

  if (typeof raw.subagent_model === "string" && raw.subagent_model.trim()) {
    config.subagentModel = raw.subagent_model.trim();
  }

  if (typeof raw.staged_commits === "boolean") {
    config.stagedCommits = raw.staged_commits;
  }

  if (typeof raw.defer_to_goal_audit === "boolean") {
    config.deferToGoalAudit = raw.defer_to_goal_audit;
  }

  if (typeof raw.async_threshold === "number") {
    config.asyncThreshold = raw.async_threshold;
  }

  return config;
}

/**
 * Load config from file, falling back to defaults.
 */
export function loadConfig(cwd: string): CommitterConfig {
  const filePath = findConfigFile(cwd);
  if (!filePath) return { ...DEFAULT_CONFIG };

  try {
    const raw = parseConfigFile(filePath);
    const merged = applyConfig(DEFAULT_CONFIG, raw);
    return merged;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pi-committer] Config error in ${filePath}: ${msg}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Check if a string is a valid conventional commit type (build-in or custom).
 */
export function isValidType(t: string, customTypes: string[]): boolean {
  return CONVENTIONAL_TYPES.includes(t) || customTypes.includes(t);
}
