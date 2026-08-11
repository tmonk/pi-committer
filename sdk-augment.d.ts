/**
 * SDK type augmentations for the pi runtime contract.
 *
 * The published @earendil-works/pi-coding-agent 0.84.1 type for
 * ExtensionUIContext.notify omits the "success" level, but the pi runtime
 * accepts it (renders a success toast) — the extension has always used it.
 * This augmentation documents the runtime contract without changing behavior.
 */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionUIContext {
    notify(
      message: string,
      type?: "info" | "warning" | "error" | "success",
    ): void;
  }
}

export {};
