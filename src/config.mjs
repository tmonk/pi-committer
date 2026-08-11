import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  triggerMode: "on_goal",
  minChanges: 1,
  excludePatterns: [],
  stagedCommits: true,
  asyncThreshold: 5,
  messageMode: "agent_with_fallback",
  deterministicFallback: true,
  subagentModel: undefined,
  subagentThinkingLevel: "off",
  notifyAsyncCompletion: true,
  contextEnabled: true,
});

const TRIGGER_MODES = new Set(["on_goal", "agent_sensible", "after_tool", "manual"]);
const MESSAGE_MODES = new Set(["agent_with_fallback", "agent", "deterministic"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function findConfigFile(cwd) {
  let current = path.resolve(cwd);
  for (let i = 0; i < 32; i++) {
    const toml = path.join(current, ".pi-committer.toml");
    const json = path.join(current, ".pi-committer.json");
    if (fs.existsSync(toml)) return toml;
    if (fs.existsSync(json)) return json;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function readRaw(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = file.endsWith(".json") ? JSON.parse(text) : parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  if (parsed.committer && typeof parsed.committer === "object" && !Array.isArray(parsed.committer)) {
    return parsed.committer;
  }
  return parsed;
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function normalizeConfig(raw = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    excludePatterns: [...DEFAULT_CONFIG.excludePatterns],
  };

  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  if (typeof raw.trigger_mode === "string" && TRIGGER_MODES.has(raw.trigger_mode)) {
    cfg.triggerMode = raw.trigger_mode;
  }
  cfg.minChanges = integer(raw.min_changes, cfg.minChanges, { min: 1, max: 100_000 });

  if (Array.isArray(raw.exclude_patterns)) {
    cfg.excludePatterns = raw.exclude_patterns
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
  }

  if (typeof raw.staged_commits === "boolean") cfg.stagedCommits = raw.staged_commits;
  cfg.asyncThreshold = integer(raw.async_threshold, cfg.asyncThreshold, { min: 0, max: 100_000 });

  if (typeof raw.message_mode === "string" && MESSAGE_MODES.has(raw.message_mode)) {
    cfg.messageMode = raw.message_mode;
  }
  if (typeof raw.deterministic_fallback === "boolean") {
    cfg.deterministicFallback = raw.deterministic_fallback;
  }
  if (cfg.messageMode === "agent") cfg.deterministicFallback = false;
  if (cfg.messageMode === "deterministic") cfg.deterministicFallback = true;

  if (typeof raw.subagent_model === "string" && raw.subagent_model.trim()) {
    cfg.subagentModel = raw.subagent_model.trim();
  }
  if (
    typeof raw.subagent_thinking_level === "string" &&
    THINKING_LEVELS.has(raw.subagent_thinking_level)
  ) {
    cfg.subagentThinkingLevel = raw.subagent_thinking_level;
  }

  if (typeof raw.notify_async_completion === "boolean") {
    cfg.notifyAsyncCompletion = raw.notify_async_completion;
  }
  if (typeof raw.context_enabled === "boolean") cfg.contextEnabled = raw.context_enabled;

  return cfg;
}

export function loadConfig(cwd) {
  const file = findConfigFile(cwd);
  if (!file) return { ...DEFAULT_CONFIG, excludePatterns: [] };
  try {
    return normalizeConfig(readRaw(file));
  } catch (error) {
    console.error(`[pi-committer] Invalid config ${file}: ${error?.message ?? error}`);
    return { ...DEFAULT_CONFIG, excludePatterns: [] };
  }
}
