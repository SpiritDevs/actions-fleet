import type { FailureContext } from "@actions-fleet/protocol";
import { formatFixPrompt, type FixPromptInput } from "./fixPrompt";

export interface CopiedFixPrompt {
  text: string;
  copied: boolean;
  usedLoadedLogs: boolean;
}

/** Keep a late history/clipboard response from being applied to another selected job. */
export async function copyFixPrompt(input: FixPromptInput, options: {
  loadContext: () => Promise<FailureContext>;
  writeClipboard: (text: string) => Promise<void>;
  isCurrent: () => boolean;
}): Promise<CopiedFixPrompt | null> {
  let context: FailureContext;
  let usedLoadedLogs = false;
  try { context = await options.loadContext(); }
  catch {
    if (!options.isCurrent()) return null;
    usedLoadedLogs = true;
    context = { lines: [...input.lines], notes: [...input.contextNotes, "The retained failure-context request failed. This fallback includes only the currently loaded console window; older errors may be missing. Open the GitHub job for additional logs."] };
  }
  if (!options.isCurrent()) return null;
  const text = formatFixPrompt({ ...input, lines: context.lines, contextNotes: context.notes });
  let copied = false;
  try {
    if (!options.isCurrent()) return null;
    await options.writeClipboard(text); copied = true;
  } catch { /* A selectable prompt is returned when clipboard access is denied. */ }
  return options.isCurrent() ? { text, copied, usedLoadedLogs } : null;
}
