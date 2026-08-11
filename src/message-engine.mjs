import path from "node:path";
import { readSnapshotDiff } from "./snapshot-engine.mjs";

const CONVENTIONAL_TYPES = new Set([
  "feat", "fix", "chore", "docs", "refactor", "test",
  "style", "perf", "ci", "build", "revert",
]);

let cachedRuntime;
let sdkPromise;

async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import("@earendil-works/pi-coding-agent").catch(() => null);
  }
  return sdkPromise;
}

function resourceLoader(sdk) {
  if (!cachedRuntime) cachedRuntime = sdk.createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: cachedRuntime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      "Write precise conventional git commit messages. Only describe changes proven by the supplied immutable git diff.",
    getAppendSystemPrompt: () => [],
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function isValidCommitMessage(message) {
  if (typeof message !== "string") return false;
  const trimmed = message.trim();
  if (trimmed.length < 8 || trimmed.length > 20_000) return false;
  const header = trimmed.split("\n", 1)[0];
  if (header.length > 100) return false;
  const match = /^([a-z]+)(\([^)]+\))?: ([^\n]+)$/.exec(header);
  if (!match || !CONVENTIONAL_TYPES.has(match[1])) return false;
  const description = match[3].trim();
  if (description.length < 3) return false;
  if (/^(update|change|misc|stuff|things|various)(\s+\d+)?\s+(files?|things?|stuff)?$/i.test(description)) {
    return false;
  }
  if (/^diff --git |^@@ |^index [0-9a-f]+\.\.[0-9a-f]+/m.test(trimmed)) return false;
  return true;
}

function categoryFor(file) {
  const f = file.toLowerCase();
  if (f.startsWith(".github/") || f.includes("/.github/")) return "ci";
  if (
    f.startsWith("docs/") ||
    f.endsWith(".md") ||
    f.endsWith(".mdx") ||
    path.basename(f).startsWith("readme")
  ) return "docs";
  if (
    f.startsWith("test/") ||
    f.startsWith("tests/") ||
    f.includes("/test/") ||
    f.includes("/tests/") ||
    /\.(test|spec)\.[^.]+$/.test(f)
  ) return "test";
  if (
    /(^|\/)(package(-lock)?\.json|tsconfig\.json|eslint|prettier|vite\.config|webpack\.config)/.test(f) ||
    f.endsWith(".toml") ||
    f.endsWith(".yaml") ||
    f.endsWith(".yml")
  ) return "chore";
  return "code";
}

export function buildFileGroups(files, stagedCommits = true) {
  if (!stagedCommits || files.length < 2) return [{ category: "code", files: [...files] }];

  const buckets = new Map();
  for (const file of files) {
    const category = categoryFor(file);
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(file);
  }

  if (buckets.size <= 1) return [{ category: [...buckets.keys()][0] ?? "code", files: [...files] }];

  const order = ["code", "test", "docs", "ci", "chore"];
  return order
    .filter((category) => buckets.has(category))
    .map((category) => ({ category, files: buckets.get(category) }));
}

function changedLineSummary(diff) {
  const candidates = [];
  for (const raw of diff.split("\n")) {
    if (!raw.startsWith("+") || raw.startsWith("+++") || raw.startsWith("+@@")) continue;
    const value = raw.slice(1).trim();
    if (
      value.length < 5 ||
      value.length > 100 ||
      /^(import|export \{|\/\/|#|\/\*|\*|[{}()[\],;]+$)/.test(value)
    ) continue;
    candidates.push(value.replace(/\s+/g, " "));
    if (candidates.length >= 3) break;
  }
  return candidates;
}

function fileStem(file) {
  const base = path.basename(file).replace(/\.(test|spec)(?=\.)/i, "");
  return base
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function commonScope(files) {
  if (!files.length) return "";
  const dirs = files.map((f) => path.dirname(f).split("/").filter(Boolean));
  if (dirs.some((parts) => parts.length === 0)) return "";
  const first = dirs[0];
  let end = first.length;
  for (const parts of dirs.slice(1)) {
    let i = 0;
    while (i < end && i < parts.length && first[i] === parts[i]) i++;
    end = i;
  }
  if (!end) return "";
  return first[end - 1].replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
}

export function deterministicMessage({ category, files, diff }) {
  const lines = changedLineSummary(diff);
  const stems = [...new Set(files.map(fileStem).filter(Boolean))].slice(0, 3);
  const scope = commonScope(files);
  const scopePart = scope ? `(${scope})` : "";

  let type = "refactor";
  if (category === "docs") type = "docs";
  else if (category === "test") type = "test";
  else if (category === "ci") type = "ci";
  else if (category === "chore") type = "chore";
  else if (/^\+.*\b(fix|retry|error|race|cancel|guard|prevent|reject|validate)\b/im.test(diff)) type = "fix";
  else if (/^new file mode /m.test(diff) || /^\+.*\b(add|create|register|support|enable)\b/im.test(diff)) type = "feat";

  let description;
  if (category === "docs") description = `document ${stems.join(" and ") || "changes"}`;
  else if (category === "test") description = `cover ${stems.join(" and ") || "commit behavior"}`;
  else if (category === "ci") description = `validate ${stems.join(" and ") || "build and tests"}`;
  else if (category === "chore") description = `configure ${stems.join(" and ") || "project tooling"}`;
  else if (lines.length) {
    const first = lines[0]
      .replace(/^(const|let|var|function|class|return|await|async)\s+/i, "")
      .replace(/[{};]+$/g, "")
      .trim();
    description = first.length >= 8 ? first : `improve ${stems.join(" and ") || "commit flow"}`;
  } else {
    description = `improve ${stems.join(" and ") || "commit flow"}`;
  }

  description = description
    .replace(/\s+/g, " ")
    .replace(/^([A-Z])/, (m) => m.toLowerCase())
    .slice(0, 72 - type.length - scopePart.length - 2)
    .trim();

  const header = `${type}${scopePart}: ${description}`;
  const bodyLines = [
    `Commit ${files.length} file(s) from the captured immutable snapshot.`,
  ];
  if (lines.length) {
    bodyLines.push("", "Notable diff evidence:", ...lines.map((line) => `- ${line}`));
  } else {
    bodyLines.push("", `Files: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`);
  }

  return `${header}\n\n${bodyLines.join("\n")}`;
}

function buildAgentPrompt({ files, diff, request, context }) {
  const clippedDiff = diff.length > 24_000
    ? `${diff.slice(0, 24_000)}\n... [diff truncated for message generation]`
    : diff;
  const parts = [
    "Write ONE conventional commit message for exactly the supplied immutable Git diff.",
    "",
    "Required format:",
    "<type>(<optional-scope>): <specific imperative description>",
    "",
    "<short body explaining what changed and why>",
    "",
    "Rules:",
    "- Allowed types: feat, fix, chore, docs, refactor, test, style, perf, ci, build, revert.",
    "- The header must be specific and evidence-based; never say only 'update files' or 'misc changes'.",
    "- Do not invent files, behavior, reasons, or symbols that are absent from the diff.",
    "- Output only the commit message.",
    "",
    `Files (${files.length}):`,
    ...files.map((file) => `- ${file}`),
  ];
  if (request?.message?.trim()) {
    parts.push("", "User guidance (apply only when supported by the diff):", request.message.trim());
  }
  if (context?.trim()) {
    parts.push("", "Session context (intent only; diff remains source of truth):", context.trim().slice(0, 4000));
  }
  parts.push("", "Immutable diff:", clippedDiff);
  return parts.join("\n");
}

function sanitizeModel(model) {
  if (!model || typeof model !== "object") return undefined;
  try {
    return JSON.parse(JSON.stringify(model));
  } catch {
    const copy = {};
    for (const key of [
      "provider", "id", "name", "api", "baseUrl", "reasoning",
      "input", "cost", "contextWindow", "maxTokens",
    ]) {
      const value = model[key];
      if (value !== undefined && typeof value !== "function") copy[key] = value;
    }
    return copy.provider && copy.id ? copy : undefined;
  }
}

export function serializableModel(model) {
  const safe = sanitizeModel(model);
  return safe?.provider && safe?.id ? safe : undefined;
}

async function runAgentMessage({ cwd, model, thinkingLevel, prompt, signal, onProgress }) {
  if (!model || signal?.aborted) return "";

  const sdk = await loadSdk();
  if (!sdk) {
    onProgress?.({ phase: "message", detail: "commit-message SDK unavailable; using fallback" });
    return "";
  }

  let result;
  try {
    result = await sdk.createAgentSession({
      cwd,
      model,
      thinkingLevel: thinkingLevel ?? "off",
      resourceLoader: resourceLoader(sdk),
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }),
      tools: [],
    });
  } catch (error) {
    onProgress?.({ phase: "message", detail: `agent session unavailable: ${error?.message ?? error}` });
    return "";
  }

  const session = result.session;
  const output = [];
  const unsubscribe = session.subscribe((event) => {
    if (event?.type !== "message_end" || event?.message?.role !== "assistant") return;
    for (const part of event.message.content ?? []) {
      if (part?.type === "text" && typeof part.text === "string") output.push(part.text);
    }
  });

  const abort = () => {
    try { session.abort(); } catch { /* no-op */ }
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(prompt);
  } catch {
    return "";
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
  }

  return output.join("\n\n").trim();
}

async function messageForGroup({
  snapshot,
  group,
  config,
  model,
  context,
  request,
  signal,
  onProgress,
}) {
  const diff = readSnapshotDiff(snapshot, group.files);

  if (request?.verbatim?.trim()) {
    const exact = request.verbatim;
    if (!isValidCommitMessage(exact)) {
      throw new Error("The verbatim commit message is not a valid conventional commit");
    }
    return exact;
  }

  const deterministic = () => deterministicMessage({
    category: group.category,
    files: group.files,
    diff,
  });

  if (config.messageMode === "deterministic") return deterministic();

  if (model && !signal?.aborted) {
    onProgress?.({ phase: "message", detail: `generating message for ${group.files.length} file(s)` });
    const prompt = buildAgentPrompt({ files: group.files, diff, request, context });
    const generated = await runAgentMessage({
      cwd: snapshot.repoDir,
      model,
      thinkingLevel: config.subagentThinkingLevel,
      prompt,
      signal,
      onProgress,
    });
    if (isValidCommitMessage(generated)) return generated;

    if (generated && !signal?.aborted) {
      const retry = await runAgentMessage({
        cwd: snapshot.repoDir,
        model,
        thinkingLevel: config.subagentThinkingLevel,
        prompt: `${prompt}\n\nYour previous answer was rejected. Return only a valid, specific conventional commit message.`,
        signal,
        onProgress,
      });
      if (isValidCommitMessage(retry)) return retry;
    }
  }

  if (config.deterministicFallback !== false) return deterministic();
  throw new Error("Commit message agent failed and deterministic fallback is disabled");
}

export async function generateCommitPlan({
  snapshot,
  config,
  model,
  context = "",
  request = {},
  signal,
  onProgress,
}) {
  const groups = request?.verbatim?.trim()
    ? [{ category: "code", files: [...snapshot.files] }]
    : buildFileGroups(snapshot.files, config.stagedCommits);

  const plan = [];
  for (const group of groups) {
    if (signal?.aborted) throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });
    const message = await messageForGroup({
      snapshot,
      group,
      config,
      model: serializableModel(model),
      context,
      request,
      signal,
      onProgress,
    });
    if (!isValidCommitMessage(message)) {
      throw new Error("Generated commit message failed validation");
    }
    plan.push({ files: [...group.files], message });
  }
  return plan;
}
