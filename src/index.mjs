import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.mjs";
import {
  applyCommitPlan,
  captureSnapshot,
  gitRoot,
  readOperationResults,
  removeOperationResult,
  requestOperationCancel,
} from "./snapshot-engine.mjs";
import { generateCommitPlan, serializableModel } from "./message-engine.mjs";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const inflight = new Map();
const toolSchema = Type.Object({
  message: Type.Optional(Type.String()),
  verbatim: Type.Optional(Type.String()),
});

let config;
let selectedModel;
let lastGoalStates = new Map();

function notify(ctx, text, level = "info") {
  try { ctx.ui?.notify?.(`[pi-committer] ${text}`, level); } catch { /* headless */ }
}

function contextTail(ctx) {
  if (!config?.contextEnabled) return "";
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const lines = [];
    for (const entry of entries.slice(-12)) {
      if (entry?.type !== "message") continue;
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = entry.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
      }
      if (text.trim()) lines.push(`[${role}] ${text.trim()}`);
    }
    return lines.join("\n").slice(-4000);
  } catch {
    return "";
  }
}

function resolveModel(ctx) {
  if (selectedModel) return selectedModel;
  const configured = config?.subagentModel;
  if (configured) {
    const slash = configured.indexOf("/");
    if (slash > 0) {
      const found = ctx.modelRegistry?.find?.(configured.slice(0, slash), configured.slice(slash + 1));
      if (found) return found;
    }
    const found = ctx.modelRegistry?.getAvailable?.().find((m) => m.id === configured || m.name === configured);
    if (found) return found;
  }
  return ctx.model;
}

function formatResult(result) {
  if (!result) return "no result";
  if (result.ok === false) return `failed: ${result.error ?? "unknown error"}`;
  const commits = result.commits ?? [];
  if (!commits.length) return "finished with no commits";
  return `${commits.length} commit(s): ${commits.map((c) => `${String(c.hash).slice(0, 7)} ${String(c.message).split("\n")[0]}`).join("; ")}`;
}

function recoverResults(ctx, repoDir) {
  try {
    for (const result of readOperationResults(repoDir, { consume: true })) {
      notify(ctx, `Recovered background commit ${formatResult(result)}`, result.ok === false ? "error" : "success");
    }
  } catch {
    // Recovery is best-effort and must never block the session.
  }
}

function recentTouchedRepos(ctx, primary) {
  const repos = new Set(primary ? [primary] : []);
  try {
    const entries = ctx.sessionManager?.getEntries?.().slice(-40) ?? [];
    for (const entry of entries) {
      if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
      for (const part of entry.message?.content ?? []) {
        if (part?.type !== "toolCall") continue;
        const candidate = part.arguments?.path ?? part.arguments?.file_path ?? part.arguments?.cwd;
        if (typeof candidate !== "string" || !candidate) continue;
        const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(ctx.cwd, candidate);
        const root = gitRoot(path.dirname(resolved)) ?? gitRoot(resolved);
        if (root) repos.add(root);
      }
    }
  } catch {
    // Primary repository is still enough.
  }
  return [...repos];
}

async function syncCommit(snapshot, ctx, request, signal) {
  const plan = await generateCommitPlan({
    snapshot,
    config,
    model: serializableModel(resolveModel(ctx)),
    context: contextTail(ctx),
    request,
    signal,
  });
  return applyCommitPlan(snapshot, plan, { shouldAbort: () => signal?.aborted ?? false });
}

function backgroundCommit(snapshot, ctx, request) {
  const repo = snapshot.repoDir;
  const child = fork(WORKER_PATH, [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });

  inflight.set(repo, { snapshot, child });
  let delivered = false;
  const finish = (result) => {
    if (delivered) return;
    delivered = true;
    inflight.delete(repo);
    if (result) {
      removeOperationResult(snapshot);
      notify(ctx, `Background commit ${formatResult(result)}`, result.ok === false ? "error" : "success");
    }
  };

  child.on("message", (message) => {
    if (message?.type === "result" && message.operationId === snapshot.id) finish(message);
  });
  child.on("error", (error) => {
    inflight.delete(repo);
    notify(ctx, `Background worker error: ${error.message}`, "error");
  });
  child.on("exit", () => {
    // A result may already be durably journaled even if IPC is gone. Leave it
    // for session recovery instead of fabricating a failure.
    inflight.delete(repo);
  });

  child.send({
    type: "start",
    params: {
      snapshot,
      config,
      model: serializableModel(resolveModel(ctx)),
      context: contextTail(ctx),
      request,
    },
  }, () => child.unref());

  return { async: true, operationId: snapshot.id, fileCount: snapshot.files.length };
}

async function commitRepo(repoDir, ctx, { force = false, request = {}, signal } = {}) {
  if (!repoDir) return { commitCount: 0 };
  if (inflight.has(repoDir)) {
    return { commitCount: 0, skipped: true, reason: "a commit is already running for this repository" };
  }

  recoverResults(ctx, repoDir);
  const snapshot = captureSnapshot(repoDir, { excludePatterns: config.excludePatterns });
  if (!snapshot) return { commitCount: 0, empty: true };
  if (!force && snapshot.files.length < config.minChanges) return { commitCount: 0, belowMinimum: true };

  if (force && config.asyncThreshold > 0 && snapshot.files.length >= config.asyncThreshold) {
    return backgroundCommit(snapshot, ctx, request);
  }

  return syncCommit(snapshot, ctx, request, signal);
}

async function commitAll(ctx, options = {}) {
  const primary = gitRoot(ctx.cwd);
  if (!primary) {
    if (options.force) notify(ctx, "Not a git repository", "warning");
    return { commitCount: 0 };
  }
  const repos = recentTouchedRepos(ctx, primary);
  let count = 0;
  let asyncCount = 0;
  const results = [];
  for (const repo of repos) {
    try {
      const result = await commitRepo(repo, ctx, options);
      results.push(result);
      count += result.commitCount ?? 0;
      if (result.async) asyncCount++;
    } catch (error) {
      notify(ctx, `Commit failed in ${path.basename(repo)}: ${error?.message ?? error}`, "error");
      results.push({ commitCount: 0, error: error?.message ?? String(error), code: error?.code });
    }
  }
  return { commitCount: count, asyncCount, results };
}

function scanGoalCompletion(ctx) {
  try {
    let completed = false;
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (const entry of entries.slice(-80)) {
      if (entry?.type !== "custom") continue;
      const data = entry.data ?? entry.details ?? {};
      const id = data.goalId ?? data.id;
      const status = data.status;
      if (!id || typeof status !== "string") continue;
      const before = lastGoalStates.get(id);
      lastGoalStates.set(id, status);
      if (status === "complete" && before && before !== "complete") completed = true;
    }
    return completed;
  } catch {
    return false;
  }
}

export default function piCommitter(pi) {
  config = loadConfig(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    selectedModel = undefined;
    lastGoalStates = new Map();
    const root = gitRoot(ctx.cwd);
    if (root) recoverResults(ctx, root);
    if (config.enabled) notify(ctx, `Active (${config.triggerMode}; immutable snapshot runtime)`, "info");
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!config.enabled) return;
    if (config.triggerMode === "agent_sensible") await commitAll(ctx);
    if (config.triggerMode === "on_goal" && scanGoalCompletion(ctx)) await commitAll(ctx);
  });

  pi.on("tool_result", async (_event, ctx) => {
    if (config.enabled && config.triggerMode === "after_tool") await commitAll(ctx);
  });

  pi.registerTool({
    name: "commit_changes",
    label: "Commit Changes",
    description: "Capture an immutable Git snapshot and create one or more conventional commits. Large snapshots run safely in a detached background worker.",
    promptSnippet: "Commit the current repository snapshot",
    promptGuidelines: [
      "Use commit_changes when the user asks to commit or checkpoint work.",
      "A background commit captures files immediately; later edits are excluded automatically.",
      "After an async result, continue working instead of polling git status/log; completion is delivered or journaled.",
    ],
    parameters: toolSchema,
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) return { content: [{ type: "text", text: "Commit cancelled." }], details: { cancelled: true } };
      const result = await commitAll(ctx, {
        force: true,
        signal,
        request: { message: params.message, verbatim: params.verbatim },
      });
      const asyncResult = result.results?.find((r) => r.async);
      if (asyncResult) {
        return {
          content: [{ type: "text", text: `Immutable snapshot ${asyncResult.operationId} is committing in the background. Continue working; later edits are not part of that snapshot.` }],
          details: { async: true, operationId: asyncResult.operationId, fileCount: asyncResult.fileCount },
        };
      }
      return {
        content: [{ type: "text", text: result.commitCount > 0 ? `${result.commitCount} commit(s) created.` : "Nothing to commit." }],
        details: result,
      };
    },
  });

  pi.registerCommand("commit", {
    description: "Commit the current immutable repository snapshot",
    handler: async (_args, ctx) => {
      const result = await commitAll(ctx, { force: true, request: {} });
      const asyncResult = result.results?.find((r) => r.async);
      if (asyncResult) notify(ctx, `Background snapshot ${asyncResult.operationId} started for ${asyncResult.fileCount} file(s)`, "info");
      else if (result.commitCount > 0) notify(ctx, `${result.commitCount} commit(s) created`, "success");
      else notify(ctx, "Nothing to commit", "info");
    },
  });

  pi.registerCommand("commit-cancel", {
    description: "Request cancellation of background commits started in this process",
    handler: async (_args, ctx) => {
      const root = gitRoot(ctx.cwd);
      let cancelled = 0;
      for (const [repo, state] of inflight) {
        if (!root || repo === root) {
          requestOperationCancel(state.snapshot);
          try { state.child.kill("SIGTERM"); } catch { /* worker also observes journal */ }
          cancelled++;
        }
      }
      notify(ctx, cancelled ? `Cancellation requested for ${cancelled} operation(s)` : "No background commit is running", cancelled ? "warning" : "info");
    },
  });

  pi.registerCommand("commit-config", {
    description: "Reload pi-committer configuration and recover background results",
    handler: async (_args, ctx) => {
      config = loadConfig(ctx.cwd);
      const root = gitRoot(ctx.cwd);
      if (root) recoverResults(ctx, root);
      notify(ctx, `Configuration reloaded (${config.triggerMode})`, "info");
    },
  });

  pi.registerCommand("commit-model", {
    description: "Select the model used for commit-message generation",
    handler: async (_args, ctx) => {
      const models = ctx.modelRegistry?.getAvailable?.() ?? [];
      if (!models.length) return notify(ctx, "No models available", "warning");
      const choices = ["(default)", ...models.map((m) => `${m.provider}/${m.id}`)];
      const choice = await ctx.ui.select("Commit message model", choices);
      if (!choice) return;
      if (choice === "(default)") selectedModel = undefined;
      else selectedModel = models[choices.indexOf(choice) - 1];
      notify(ctx, selectedModel ? `Using ${selectedModel.provider}/${selectedModel.id}` : "Using current agent model", "success");
    },
  });

  pi.on("session_shutdown", async () => {
    // Detached workers deliberately survive session shutdown. Their immutable
    // trees, CAS ref update, and durable result journal make this safe.
  });
}
