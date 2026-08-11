import { applyCommitPlan, clearOperationCancel, isOperationCancelled, writeOperationResult } from "./snapshot-engine.mjs";
import { generateCommitPlan } from "./message-engine.mjs";

const WORKER_TIMEOUT_MS = 5 * 60 * 1000;
const abortController = new AbortController();

let snapshot;
let settled = false;
let started = false;

function send(message, callback) {
  if (!process.send || !process.connected) {
    callback?.();
    return;
  }
  try {
    process.send(message, callback);
  } catch {
    callback?.();
  }
}

function sendProgress(phase, detail) {
  send({ type: "progress", phase, detail });
}

function resultShape(error, result) {
  if (error) {
    return {
      ok: false,
      commitCount: 0,
      commits: [],
      error: error?.message ?? String(error),
      code: error?.code,
    };
  }
  return { ok: true, ...result };
}

function finish(error, result) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);

  const payload = resultShape(error, result);
  if (snapshot) {
    try {
      writeOperationResult(snapshot, payload);
      clearOperationCancel(snapshot);
    } catch (journalError) {
      payload.journalError = journalError?.message ?? String(journalError);
    }
  }

  send({ type: "result", operationId: snapshot?.id, ...payload }, () => {
    try { process.disconnect?.(); } catch { /* no-op */ }
    process.exitCode = 0;
    setImmediate(() => process.exit());
  });
}

function cancel() {
  if (!abortController.signal.aborted) abortController.abort();
}

process.on("SIGTERM", cancel);
process.on("SIGHUP", cancel);
process.on("SIGINT", cancel);
process.on("uncaughtException", (error) => finish(error));
process.on("unhandledRejection", (error) => finish(error instanceof Error ? error : new Error(String(error))));

const timeout = setTimeout(() => {
  cancel();
  finish(Object.assign(new Error("Background commit timed out after 5 minutes"), { code: "TIMEOUT" }));
}, WORKER_TIMEOUT_MS);
timeout.unref?.();

async function run(params) {
  snapshot = params.snapshot;
  if (!snapshot?.id || snapshot.version !== 2) {
    throw new Error("Invalid or unsupported commit snapshot");
  }

  const shouldAbort = () =>
    abortController.signal.aborted || isOperationCancelled(snapshot);

  if (shouldAbort()) {
    throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });
  }

  sendProgress("planning", `Planning immutable snapshot ${snapshot.id}`);
  const plan = await generateCommitPlan({
    snapshot,
    config: params.config ?? {},
    model: params.model,
    context: params.context ?? "",
    request: params.request ?? {},
    signal: abortController.signal,
    onProgress: (progress) => send({ type: "progress", ...progress }),
  });

  if (shouldAbort()) {
    throw Object.assign(new Error("Commit cancelled"), { code: "CANCELLED" });
  }

  sendProgress("committing", `Creating ${plan.length} commit(s) from immutable Git objects`);
  const result = applyCommitPlan(snapshot, plan, { shouldAbort });

  sendProgress("done", `Created ${result.commitCount} commit(s)`);
  return result;
}

process.on("message", async (message) => {
  if (settled || started || message?.type !== "start") return;
  started = true;
  try {
    const result = await run(message.params ?? {});
    finish(null, result);
  } catch (error) {
    finish(error);
  }
});
