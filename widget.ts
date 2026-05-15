import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Progress state types
// ---------------------------------------------------------------------------

export interface SubagentProgress {
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  recentOutput: string[];
}

export type CommitterPhase = "idle" | "analyzing" | "committing" | "done";

export interface CommitterProgress {
  phase: CommitterPhase;
  /** Number of files being analyzed */
  fileCount?: number;
  /** Status message for current phase */
  statusMessage?: string;
  /** Subagent progress during analysis or message generation */
  subagent?: SubagentProgress;
  /** Total commits to make */
  totalCommits?: number;
  /** Commits completed so far */
  completedCommits?: number;
  /** Log of commits made */
  commitLog: Array<{ hash: string; message: string; success: boolean }>;
  /** When the operation started (epoch ms) */
  startedAt: number;
  /** Optional error message */
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function truncateText(value: string, max = 120): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function fit(value: string, width: number): string {
  return visibleWidth(value) > width
    ? truncateToWidth(value, width, "…")
    : value;
}

function heading(
  theme: Theme,
  width: number,
  left: string,
  right = "",
): string {
  if (!right) return fit(left, width);
  const rightPart = ` ${right}`;
  const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
  return fit(
    `${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`,
    width,
  );
}

function branchLine(
  theme: Theme,
  width: number,
  isLast: boolean,
  content: string,
): string {
  const prefix = isLast ? "└─" : "├─";
  return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

// ---------------------------------------------------------------------------
// Widget rendering
// ---------------------------------------------------------------------------

export function renderCommitterWidgetLines(
  progress: CommitterProgress,
  theme: Theme,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);

  if (progress.phase === "idle") return [];

  const isActive = progress.phase !== "done";

  let icon: string;
  let color: ThemeColor;
  let label: string;

  switch (progress.phase) {
    case "analyzing":
      icon = theme.fg("accent", spinnerFrame());
      color = "accent";
      label = `analyzing${progress.fileCount ? `  ${progress.fileCount} files` : ""}`;
      break;
    case "committing":
      icon = theme.fg("accent", "◆");
      color = "accent";
      label = `committing${progress.totalCommits ? `  ${progress.completedCommits ?? 0}/${progress.totalCommits}` : ""}`;
      break;
    case "done":
      icon = theme.fg("success", "✓");
      color = "success";
      const commitWord = progress.totalCommits === 1 ? "commit" : "commits";
      label = `complete  ${progress.totalCommits ?? 0} ${commitWord}`;
      break;
    default:
      icon = theme.fg("accent", spinnerFrame());
      color = "accent";
      label = "";
  }

  const elapsed = formatDuration(
    Math.floor((Date.now() - progress.startedAt) / 1000),
  );

  const lines: string[] = [
    heading(
      theme,
      safeWidth,
      `${icon} ${theme.fg(color, theme.bold("pi-committer"))} ${theme.fg("muted", label)}`,
      theme.fg("muted", elapsed),
    ),
  ];

  // Phase-specific content
  if (progress.phase === "analyzing") {
    if (progress.statusMessage) {
      lines.push(
        branchLine(
          theme,
          safeWidth,
          !progress.subagent?.currentTool && (!progress.subagent?.recentOutput || progress.subagent.recentOutput.length === 0) && isActive,
          `${theme.fg("muted", "○")} ${theme.fg("dim", progress.statusMessage)}`,
        ),
      );
    }

    // Subagent tool info
    if (isActive && progress.subagent?.currentTool) {
      const argText = progress.subagent.currentToolArgs
        ? truncateText(progress.subagent.currentToolArgs, Math.max(10, safeWidth - 24))
        : "";
      const toolDuration = progress.subagent.currentToolStartedAt
        ? ` ${theme.fg("dim", formatDuration(Math.floor((Date.now() - progress.subagent.currentToolStartedAt) / 1000)))}`
        : "";
      lines.push(
        branchLine(
          theme,
          safeWidth,
          false,
          `${theme.fg("accent", "tool")} ${theme.fg("text", progress.subagent.currentTool)}${argText ? ` ${theme.fg("dim", argText)}` : ""}${toolDuration}`,
        ),
      );
    }

    // Subagent recent output
    if (progress.subagent?.recentOutput && progress.subagent.recentOutput.length > 0) {
      const separatorShown = progress.subagent.currentTool !== undefined;
      if (separatorShown) {
        lines.push(
          branchLine(
            theme,
            safeWidth,
            false,
            theme.fg("dim", "─".repeat(Math.max(4, safeWidth - 6))),
          ),
        );
      }
      for (const [index, line] of progress.subagent.recentOutput.entries()) {
        const isLastOutput =
          index === progress.subagent.recentOutput.length - 1 && isActive;
        lines.push(
          branchLine(
            theme,
            safeWidth,
            isLastOutput,
            theme.fg("dim", truncateText(line, Math.max(8, safeWidth - 6))),
          ),
        );
      }
    }

    // Esc hint when active
    if (isActive) {
      lines.push(
        branchLine(
          theme,
          safeWidth,
          true,
          `${theme.fg("warning", "Esc to cancel")}${theme.fg("dim", " — cancel commit operation")}`,
        ),
      );
    }
  }

  if (progress.phase === "committing") {
    // Show commit log
    if (progress.commitLog.length > 0) {
      for (const [index, entry] of progress.commitLog.entries()) {
        const isLast = index === progress.commitLog.length - 1 && !isActive;
        const icon = entry.success
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
        const hash = theme.fg("dim", entry.hash.slice(0, 7));
        const summary = entry.message.split("\n")[0];
        lines.push(
          branchLine(
            theme,
            safeWidth,
            isLast,
            `${icon} ${hash} ${theme.fg("text", truncateText(summary, Math.max(10, safeWidth - 20)))}`,
          ),
        );
      }
    }

    // Show committing progress
    if (isActive && progress.statusMessage) {
      lines.push(
        branchLine(
          theme,
          safeWidth,
          false,
          `${theme.fg("muted", "○")} ${theme.fg("dim", progress.statusMessage)}`,
        ),
      );
    }

    // Esc hint during committing phase too
    if (isActive) {
      lines.push(
        branchLine(
          theme,
          safeWidth,
          true,
          `${theme.fg("warning", "Esc to cancel")}${theme.fg("dim", " — cancel commit operation")}`,
        ),
      );
    }
  }

  if (progress.phase === "done") {
    // Show commit log
    if (progress.commitLog.length > 0) {
      for (const [index, entry] of progress.commitLog.entries()) {
        const isLast = index === progress.commitLog.length - 1;
        const icon = entry.success
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
        const hash = theme.fg("dim", entry.hash.slice(0, 7));
        const summary = entry.message.split("\n")[0];
        lines.push(
          branchLine(
            theme,
            safeWidth,
            isLast,
            `${icon} ${hash} ${theme.fg("text", truncateText(summary, Math.max(10, safeWidth - 20)))}`,
          ),
        );
      }
    }

    // Error message
    if (progress.error) {
      lines.push(
        branchLine(
          theme,
          safeWidth,
          true,
          `${theme.fg("error", "✗")} ${theme.fg("error", truncateText(progress.error, Math.max(10, safeWidth - 8)))}`,
        ),
      );
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

export interface CommitterWidgetOptions {
  theme: Theme;
  tui: TUI;
  getProgress: () => CommitterProgress | null;
}

export class CommitterWidgetComponent implements Component {
  private theme: Theme;
  private tui: TUI;
  private getProgress: () => CommitterProgress | null;

  constructor(options: CommitterWidgetOptions) {
    this.theme = options.theme;
    this.tui = options.tui;
    this.getProgress = options.getProgress;
  }

  update(): void {
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const progress = this.getProgress();
    if (!progress || progress.phase === "idle") return [];
    return renderCommitterWidgetLines(progress, this.theme, width);
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}
