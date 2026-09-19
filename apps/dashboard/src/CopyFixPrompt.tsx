import { useEffect, useRef, useState } from "react";
import type { FailureContext, Host, Job, LogLine } from "@actions-fleet/protocol";
import { api } from "./api";
import { copyFixPrompt, type CopiedFixPrompt } from "./fixPromptClipboard";

type PromptState = { key: string; loading: true } | ({ key: string; loading: false } & CopiedFixPrompt);

export function CopyFixPrompt({ job, host, visibleLines, logsTruncated }: {
  job: Job; host: Host | undefined; visibleLines: LogLine[]; logsTruncated: boolean;
}) {
  const key = `${job.id}:${job.runAttempt}:${job.headSha}`;
  const latestKey = useRef(key);
  latestKey.current = key;
  const active = useRef<{ key: string; controller: AbortController } | null>(null);
  const [state, setState] = useState<PromptState | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const current = state?.key === key ? state : null;
  useEffect(() => () => { if (active.current?.key === key) active.current.controller.abort(); }, [key]);
  useEffect(() => {
    if (current && !current.loading && !current.copied) { textarea.current?.focus(); textarea.current?.select(); }
  }, [current]);

  const copy = async () => {
    active.current?.controller.abort();
    const controller = new AbortController();
    active.current = { key, controller };
    setState({ key, loading: true });
    const dashboard = new URL(window.location.href);
    dashboard.search = new URLSearchParams({ view: "runs", job: job.id }).toString();
    dashboard.hash = "";
    const result = await copyFixPrompt({ job, host, lines: visibleLines, contextNotes: logsTruncated ? ["Earlier console output is no longer retained by the relay."] : [], dashboardUrl: dashboard.toString() }, {
      loadContext: () => api<FailureContext>(`/api/jobs/${encodeURIComponent(job.id)}/failure-context`, { signal: controller.signal }),
      writeClipboard: text => navigator.clipboard.writeText(text),
      isCurrent: () => !controller.signal.aborted && latestKey.current === key && active.current?.controller === controller,
    });
    if (result) setState({ key, loading: false, ...result });
  };

  return <section className="fix-prompt-section" aria-label="AI fix prompt">
    <button className="button" disabled={current?.loading} aria-busy={current?.loading || undefined} onClick={() => { void copy(); }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></svg>
      {current?.loading ? "Preparing fix prompt…" : "Copy AI fix prompt"}
    </button>
    <p className="fix-prompt-hint">Job details, failed steps, and a failure-focused log excerpt.</p>
    {current && !current.loading && <>
      <p className="fix-prompt-status" role="status">{current.copied ? current.usedLoadedLogs ? "Prompt copied with currently loaded logs only; older errors may be missing." : "Fix prompt copied. Paste it into your agent." : "Clipboard access is unavailable. Select and copy the prompt below."}</p>
      {!current.copied && <div className="fix-prompt-fallback">
        {current.usedLoadedLogs && <p>Retained failure context could not be loaded. This prompt uses only the loaded console window.</p>}
        <label htmlFor="fix-prompt-text">AI fix prompt</label>
        <textarea id="fix-prompt-text" ref={textarea} value={current.text} readOnly rows={12} spellCheck={false} />
        <button className="text-button" onClick={() => { textarea.current?.focus(); textarea.current?.select(); }}>Select prompt</button>
      </div>}
    </>}
  </section>;
}
