import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { AuditEvent, Host, HostMode, Job, Overview, Repository } from "@actions-fleet/protocol";
import { api, errorMessage, post } from "./api";
import { useFleet, useHistory, useJobLogs } from "./hooks";
import type { ConnectionState, SubscribeLogs } from "./hooks";
import { durationSeconds, formatDuration, hostAdmissionMessage, jobResult, LOG_WINDOW, matchesJob, percentile, stripAnsi } from "./model";
import type { JobFilter } from "./model";

type Page = "runs" | "hosts" | "connections" | "audit" | "settings";
type IconName = "runs" | "hosts" | "connections" | "audit" | "settings" | "arrow" | "github" | "refresh" | "plus" | "close" | "search" | "copy" | "download";
type JobAction = "cancel" | "force_cancel" | "rerun" | "rerun_failed" | "rerun_job" | "approve";
interface Confirmation { title: string; detail: string; button: string; danger?: boolean; run: () => Promise<void> }
interface Enrollment { token: string; expiresAt: string; relayUrl: string }
const pageNames: Record<Page, string> = { runs: "Job history", hosts: "Machines", connections: "Connections", audit: "Activity", settings: "Settings" };

function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    runs: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5m4-1v5l3 2" /></>,
    hosts: <><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8m-4-5v5m-5-9h2m2 0h6" /></>,
    connections: <><path d="m9 15 6-6m-7 9-1 1a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m2 6a4.2 4.2 0 0 0 6 0l4-4a4.2 4.2 0 0 0-6-6l-1 1" transform="translate(1 0) scale(.9 1)" /></>,
    audit: <><path d="M5 3h14v18H5zM9 7h6m-6 5h6m-6 5h4" /></>,
    settings: <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
    arrow: <><path d="M6 18 18 6H8m10 0v10" /></>,
    github: <><path d="M9 19c-4 1-4-2-6-2m14 5v-4a3.4 3.4 0 0 0-1-3c3 0 6-2 6-6a5 5 0 0 0-1-3 4.6 4.6 0 0 0 0-4s-1 0-4 2a12 12 0 0 0-6 0C8 2 7 2 7 2a4.6 4.6 0 0 0 0 4 5 5 0 0 0-1 3c0 4 3 6 6 6a3.4 3.4 0 0 0-1 3v4" transform="translate(-1 0)" /></>,
    refresh: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Brand() { return <div className="brand"><span className="brand-mark"><i /><i /><i /></span><span>Actions<span className="brand-light"> Fleet</span></span></div>; }
function timestamp(value: string): string { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function bytes(value: number): string { return `${(value / 1024 ** 3).toFixed(1)} GB`; }
function humanStatus(value: string): string { return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase()); }
function Status({ value }: { value: string }) { return <span className={`status status-${value}`}><span className="status-dot" />{humanStatus(value)}</span>; }
function Empty({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name={icon} size={28} /></span><h3>{title}</h3><div>{children}</div></div>; }
function ErrorNotice({ children }: { children: ReactNode }) { return <div className="notice notice-error" role="alert">{children}</div>; }

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close(); }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-label={title} className="modal">
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function useRoute() {
  const parse = () => {
    const query = new URLSearchParams(window.location.search);
    const candidate = query.get("view") as Page;
    return { page: Object.hasOwn(pageNames, candidate) ? candidate : "runs" as Page, jobId: query.get("job") };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => { const onPop = () => setRoute(parse()); window.addEventListener("popstate", onPop); return () => window.removeEventListener("popstate", onPop); }, []);
  const navigate = (page: Page, jobId: string | null = null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", page);
    if (jobId) url.searchParams.set("job", jobId); else url.searchParams.delete("job");
    window.history.pushState({}, "", url); setRoute({ page, jobId });
  };
  return { ...route, navigate };
}

export function App() {
  const fleet = useFleet();
  const { page, jobId, navigate } = useRoute();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [hostName, setHostName] = useState("");
  const [olderJob, setOlderJob] = useState<Job | null>(null);
  const [olderJobLoading, setOlderJobLoading] = useState(false);
  const currentJob = fleet.overview?.jobs.find((job) => job.id === jobId) ?? null;
  useEffect(() => {
    if (!jobId || currentJob) { setOlderJobLoading(false); return; }
    const controller = new AbortController();
    const fetchJob = async () => {
      setOlderJobLoading(true);
      try { setOlderJob(await api<Job>(`/api/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal })); }
      catch { if (!controller.signal.aborted) setOlderJob(null); }
      finally { if (!controller.signal.aborted) setOlderJobLoading(false); }
    };
    void fetchJob();
    const timer = window.setInterval(() => { void fetchJob(); }, 20_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [jobId, currentJob?.id]);

  useEffect(() => { document.title = `${pageNames[page]} · Actions Fleet`; }, [page]);

  const perform = async (run: () => Promise<unknown>, message: string, refreshAfter = true) => {
    setActionPending(true); setActionError(""); setNotice("");
    try { await run(); setNotice(message); if (refreshAfter) await fleet.refresh(); return true; }
    catch (cause) { setActionError(errorMessage(cause)); return false; }
    finally { setActionPending(false); }
  };

  const controlJob = (job: Job, action: JobAction) => {
    const details: Record<JobAction, { title: string; detail: string; button: string; danger?: boolean }> = {
      cancel: { title: "Cancel this workflow run?", detail: `GitHub will cancel run #${job.runId} in ${job.repository}, including its running and queued jobs. This affects more than the selected job.`, button: "Cancel workflow run", danger: true },
      force_cancel: { title: "Force cancel this workflow run?", detail: `Force cancellation interrupts run #${job.runId}, including steps that normally continue during cancellation. Use this if ordinary cancellation has not stopped the run.`, button: "Force cancel run", danger: true },
      rerun: { title: "Rerun this workflow?", detail: `GitHub will rerun all jobs in run #${job.runId} using the original commit. Release or deployment steps can execute again.`, button: "Rerun workflow" },
      rerun_failed: { title: "Rerun failed jobs?", detail: `GitHub will rerun failed jobs and their dependent jobs in run #${job.runId}.`, button: "Rerun failed jobs" },
      rerun_job: { title: "Rerun this job and dependents?", detail: `GitHub will rerun “${job.name}” and jobs that depend on it in run #${job.runId}.`, button: "Rerun job and dependents" },
      approve: { title: "Approve this contribution?", detail: `Allow the current revision ${job.headSha.slice(0, 7)} of run #${job.runId} to execute on your native fleet. Review the contribution before approval.`, button: "Approve workflow run" },
    };
    setActionError("");
    setConfirmation({ ...details[action], run: async () => {
      if (await perform(() => post(`/api/jobs/${encodeURIComponent(job.id)}/control`, { action }), "Request accepted by GitHub. Job status will update when GitHub confirms the change.")) setConfirmation(null);
    } });
  };

  if (fleet.loading && !fleet.session) return <div className="auth-shell"><Brand /><div className="auth-card"><span className="spinner" /><h1>Connecting to your fleet</h1><p>Checking your GitHub session…</p></div></div>;
  if (!fleet.session?.viewer) return <div className="auth-shell"><Brand /><div className="auth-card">
    <div className="eyebrow">YOUR HARDWARE. YOUR ACTIONS.</div>
    <h1>A home for your<br />build fleet.</h1>
    <p>GitHub Actions on your Macs and Linux machines, with one place to see every job.</p>
    {fleet.error && <ErrorNotice>{fleet.error}</ErrorNotice>}
    {fleet.session?.configured === false ? <div className="setup-panel"><h2>Connect the service first</h2><p>The relay is reachable. Configure your GitHub App, operator GitHub ID, and dashboard origin to enable sign-in.</p><a href="https://github.com/SpiritDevs/actions-fleet#setup" target="_blank" rel="noreferrer">Open setup guide <Icon name="arrow" size={15} /></a></div>
      : fleet.session ? <><a className="button button-primary login-button" href={fleet.session.loginUrl || "/auth/github"}><Icon name="github" />Continue with GitHub</a><p className="fine-print">Access is limited to the configured fleet operator.</p></>
        : <button className="button button-primary" onClick={() => { void fleet.refreshSession(); }}><Icon name="refresh" />Retry connection</button>}
  </div><div className="auth-footer">Native macOS + Linux · GitHub Actions compatible</div></div>;

  const overview = fleet.overview;
  const selectedJob = currentJob ?? (olderJob?.id === jobId ? olderJob : null);
  return <div className="app-shell">
    <a className="skip-link" href="#main">Skip to content</a>
    <aside className="sidebar"><Brand /><div className="workspace-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">{(Object.keys(pageNames) as Page[]).map((item) => <button key={item} className={`nav-item ${page === item ? "selected" : ""}`} aria-current={page === item ? "page" : undefined} onClick={() => navigate(item)}><Icon name={item === "hosts" ? "hosts" : item} /><span>{pageNames[item]}</span>{item === "runs" && Boolean(overview?.jobs.some((job) => job.status === "in_progress")) && <span className="nav-count">{overview?.jobs.filter((job) => job.status === "in_progress").length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="fleet-health"><span className={`connection-dot ${fleet.connection === "live" ? "connected" : ""}`} /><div>{fleet.connection === "live" ? "Relay connected" : "Reconnecting to relay"}<small>{overview ? `${overview.hosts.filter((host) => host.status !== "offline").length} of ${overview.hosts.length} machines online` : "Fetching fleet status"}</small></div></div>
        <div className="profile"><img src={fleet.session.viewer.avatarUrl} alt="" width="32" height="32" /><div><strong>{fleet.session.viewer.login}</strong><small>Fleet operator</small></div><button className="sign-out" onClick={() => { void perform(async () => { await post("/api/logout"); await fleet.refreshSession(); }, "Signed out.", false); }} disabled={actionPending}>Sign out</button></div>
      </div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{pageNames[page]}</strong></div><div className="topbar-end"><span className={`live-label ${fleet.connection === "live" ? "is-live" : ""}`}><span className="connection-dot" />{fleet.connection === "live" ? "Live" : "Polling"}</span><a href="https://github.com/SpiritDevs/actions-fleet" target="_blank" rel="noreferrer" aria-label="Actions Fleet on GitHub"><Icon name="github" /></a></div></header>
      <main id="main" tabIndex={-1}><div className="page-heading"><div><div className="eyebrow">ACTIONS FLEET</div><h1>{pageNames[page]}</h1><p>{({ runs: "Every build, across your connected repositories.", hosts: "Your build capacity, on your terms.", connections: "Choose which repositories can use your fleet.", audit: "A record of fleet changes and remote controls.", settings: "The policies behind your fleet." })[page]}</p></div><div className="heading-actions"><button className="button" onClick={() => { void fleet.refresh(); }}><Icon name="refresh" />Refresh</button>{page === "hosts" && <button className="button button-primary" onClick={() => { setEnrolling(true); setEnrollment(null); setHostName(""); setActionError(""); }}><Icon name="plus" />Add machine</button>}</div></div>
        {fleet.error && <ErrorNotice>{fleet.error}{overview && " Showing the last received fleet state."}</ErrorNotice>}
        {fleet.connection !== "live" && <div className="notice notice-neutral">Live connection {fleet.connection === "offline" ? "is offline" : "is reconnecting"}. Job history refreshes every 20 seconds; console history refreshes every 10 seconds.</div>}
        {actionError && !confirmation && !enrolling && <ErrorNotice>{actionError}</ErrorNotice>}
        {notice && <div className="notice notice-success" role="status"><span>{notice}</span><button className="icon-button" onClick={() => setNotice("")} aria-label="Dismiss notification"><Icon name="close" size={15} /></button></div>}
        {!overview ? <div className="panel"><Empty icon="refresh" title={fleet.error ? "Fleet data is unavailable" : "Loading your fleet"}><p>{fleet.error ? "Check the relay connection, then refresh." : "Fetching machines, repositories, and recent jobs…"}</p></Empty></div> : <>
          {page === "runs" && <JobsView overview={overview} onSelect={(id) => navigate("runs", id)} onConnect={() => navigate("connections")} />}
          {page === "hosts" && <HostsView hosts={overview.hosts} pending={actionPending} onSelectJob={(id) => navigate("runs", id)} onMode={(host, mode) => { void perform(() => post(`/api/hosts/${encodeURIComponent(host.id)}/mode`, { mode }), `${host.name}: ${humanStatus(mode)} mode requested. The host applies the mode when it next contacts the relay.`); }} onRevoke={(host) => { setActionError(""); setConfirmation({ title: `Remove ${host.name}?`, detail: "This revokes the machine’s fleet credentials. It must be enrolled again before it can accept new work.", button: "Revoke machine", danger: true, run: async () => { if (await perform(() => api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" }), "Machine credentials revoked.")) setConfirmation(null); } }); }} onEnroll={() => { setEnrolling(true); setActionError(""); setEnrollment(null); }} />}
          {page === "connections" && <ConnectionsView overview={overview} pending={actionPending} onInstall={() => { void perform(async () => { const result = await api<{ url: string }>("/api/connections/install"); window.location.assign(result.url); }, "Opening GitHub installation settings…"); }} onSync={() => { void perform(() => post("/api/connections/sync"), "GitHub connections synchronized."); }} onToggle={(repository) => { void perform(() => post(`/api/repositories/${repository.id}`, { enabled: !repository.enabled }), `${repository.fullName} ${repository.enabled ? "disabled" : "enabled"} for new fleet jobs.`); }} />}
          {page === "audit" && <AuditView events={overview.audit} />}
          {page === "settings" && <SettingsView login={fleet.session.viewer.login} pending={actionPending} onLogout={() => { void perform(async () => { await post("/api/logout"); await fleet.refreshSession(); }, "Signed out.", false); }} />}
        </>}
        <footer className="page-footer"><span>GitHub orchestrates. Your machines execute.</span><span>{fleet.updatedAt ? `Updated ${fleet.updatedAt.toLocaleTimeString()}` : "Waiting for fleet data"}</span></footer>
      </main>
    </div>
    {jobId && <JobDetail job={selectedJob} hosts={overview?.hosts ?? []} loading={!overview || olderJobLoading} onClose={() => navigate("runs")} subscribeLogs={fleet.subscribeLogs} connectionEpoch={fleet.connectionEpoch} connection={fleet.connection} pending={actionPending} onControl={controlJob} />}
    {confirmation && <Modal title={confirmation.title} onClose={() => { if (!actionPending) setConfirmation(null); }}><p>{confirmation.detail}</p>{actionError && <ErrorNotice>{actionError}</ErrorNotice>}<div className="modal-actions"><button className="button" disabled={actionPending} onClick={() => setConfirmation(null)}>Go back</button><button className={`button ${confirmation.danger ? "button-danger" : "button-primary"}`} disabled={actionPending} onClick={() => { void confirmation.run(); }}>{actionPending ? "Sending request…" : confirmation.button}</button></div></Modal>}
    {enrolling && <Modal title={enrollment ? "Connect your machine" : "Add a build machine"} onClose={() => { if (!actionPending) { setEnrolling(false); setEnrollment(null); } }}>
      {enrollment ? <EnrollmentDetails enrollment={enrollment} onDone={() => { setEnrolling(false); setEnrollment(null); }} /> : <form onSubmit={(event: FormEvent) => { event.preventDefault(); void perform(async () => { setEnrollment(await post<Enrollment>("/api/hosts/enrollment", { name: hostName.trim() })); }, "Enrollment token created."); }}><p>Install the host service on a Mac or Linux machine, then connect it using a one-use enrollment token.</p><label className="field-label" htmlFor="host-name">Machine name</label><input id="host-name" autoFocus value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="Studio Mac" maxLength={80} required /><div className="modal-actions"><button className="button button-primary" type="submit" disabled={actionPending || !hostName.trim()}>{actionPending ? "Creating token…" : "Create enrollment token"}</button></div></form>}
      {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
    </Modal>}
  </div>;
}

function JobsView({ overview, onSelect, onConnect }: { overview: Overview; onSelect: (id: string) => void; onConnect: () => void }) {
  const [search, setSearch] = useState("");
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState<JobFilter>("all");
  const [period, setPeriod] = useState("7");
  const history = useHistory<Job>("/api/jobs", overview.jobs, 500);
  const allJobs = history.items;
  const filtered = useMemo(() => allJobs.filter((job) => matchesJob(job, search, repository, status, period === "all" ? 0 : Date.now() - Number(period) * 86400_000)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [allJobs, search, repository, status, period]);
  const durations = filtered.filter((job) => job.status === "completed").map((job) => durationSeconds(job)).filter((value): value is number => value !== null);
  const finished = filtered.filter((job) => job.status === "completed" && !["skipped", "cancelled", "neutral"].includes(job.conclusion || ""));
  const passed = finished.filter((job) => job.conclusion === "success").length;
  const repositories = [...new Set([...overview.repositories.map((repo) => repo.fullName), ...allJobs.map((job) => job.repository)])].sort();
  return <>
    <div className="stat-grid"><Stat label="Jobs in view" value={String(filtered.length)} detail={`${overview.repositories.filter((repo) => repo.enabled).length} repositories enabled`} /><Stat label="Running now" value={String(overview.jobs.filter((job) => job.status === "in_progress").length)} detail={`${overview.jobs.filter((job) => job.status === "queued").length} jobs queued`} active /><Stat label="Success rate" value={finished.length ? `${Math.round(passed / finished.length * 100)}%` : "—"} detail="Completed, excluding skips and cancellations" /><Stat label="Median duration" value={formatDuration(percentile(durations, .5))} detail={`P95 ${formatDuration(percentile(durations, .95))} · completed jobs in view`} /></div>
    <section className="panel history-panel" aria-label="Job history"><div className="filterbar"><div className="search-field"><Icon name="search" size={18} /><input type="search" aria-label="Search jobs" placeholder="Search jobs, branches, commits…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Filter by repository" value={repository} onChange={(event) => setRepository(event.target.value)}><option value="">All repositories</option>{repositories.map((repo) => <option key={repo}>{repo}</option>)}</select><select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value as JobFilter)}><option value="all">All statuses</option><option value="active">Running</option><option value="queued">Queued</option><option value="waiting_approval">Needs approval</option><option value="success">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select><select aria-label="Time range" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="all">All loaded jobs</option></select></div>
      {filtered.length ? <><DurationChart jobs={filtered} /><div className="list-heading"><span>{filtered.length} job{filtered.length !== 1 ? "s" : ""}</span><span>Newest first · {allJobs.length} loaded</span></div><div className="job-list">{filtered.map((job) => <button className="job-row" key={job.id} onClick={() => onSelect(job.id)}><span className={`job-result-mark result-${jobResult(job)}`} aria-hidden="true">{job.conclusion === "success" ? "✓" : job.status === "in_progress" ? null : job.status === "waiting_approval" ? "!" : ["failure", "timed_out", "action_required", "startup_failure"].includes(job.conclusion || "") ? "×" : "·"}</span><span className="job-description"><span className="job-title"><span>{job.workflowName}</span><span className="chevron">›</span><strong>{job.name}</strong></span><span className="job-meta"><span>{job.actor || "GitHub"}</span><span className="mono">{job.headSha.slice(0, 7)}</span><time dateTime={job.createdAt} title={new Date(job.createdAt).toLocaleString()}>{timestamp(job.createdAt)}</time></span></span><span className="job-repository"><strong>{job.repository}</strong><span>{job.branch || "—"}</span></span><span className="job-row-status"><Status value={jobResult(job)} /><span className="job-duration">{formatDuration(durationSeconds(job))}</span></span><span className="row-arrow" aria-hidden="true">›</span></button>)}</div></>
        : allJobs.length ? <Empty icon="search" title="No jobs match these filters"><p>Try another repository, status, or time range.</p><button className="button" onClick={() => { setSearch(""); setRepository(""); setStatus("all"); setPeriod("all"); }}>Clear filters</button></Empty>
          : <Empty icon="runs" title="Your next build starts here"><p>Connect a repository and enroll a machine to bring GitHub Actions onto your hardware.</p><button className="button button-primary" onClick={onConnect}>Connect repositories <Icon name="arrow" size={16} /></button></Empty>}
      <div className="history-pagination">{history.error && <ErrorNotice>{history.error}</ErrorNotice>}<span>Browse retained history, up to 90 days.</span>{history.hasMore ? <button className="button" disabled={history.loading} onClick={() => { void history.loadMore(); }}>{history.loading ? "Loading history…" : "Load older jobs"}</button> : <span>All retained jobs loaded</span>}</div>
    </section>
  </>;
}

function Stat({ label, value, detail, active = false }: { label: string; value: string; detail: string; active?: boolean }) { return <div className={`stat ${active ? "stat-accent" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

function DurationChart({ jobs }: { jobs: Job[] }) {
  const points = jobs.filter((job) => job.status === "completed" && job.startedAt).slice(0, 100).reverse();
  if (points.length < 2) return null;
  const times = points.map((job) => new Date(job.createdAt).getTime());
  const minTime = Math.min(...times), maxTime = Math.max(...times);
  const maxDuration = Math.max(60, ...points.map((job) => durationSeconds(job) || 0));
  return <div className="chart"><div className="chart-heading"><strong>Build duration</strong><span><i className="chart-key success-key" />Successful<i className="chart-key failure-key" />Other outcomes</span></div><svg role="img" aria-label={`Duration of the latest ${points.length} completed jobs in this view. Median ${formatDuration(percentile(points.map((job) => durationSeconds(job) || 0), .5))}.`} viewBox="0 0 900 148" preserveAspectRatio="none"><line x1="0" y1="16" x2="846" y2="16" /><line x1="0" y1="66" x2="846" y2="66" /><line x1="0" y1="116" x2="846" y2="116" /><text x="860" y="20">{formatDuration(maxDuration)}</text><text x="860" y="70">{formatDuration(maxDuration / 2)}</text><text x="860" y="120">0s</text>{points.map((job, index) => <circle key={job.id} cx={12 + ((times[index]! - minTime) / Math.max(1, maxTime - minTime)) * 820} cy={116 - ((durationSeconds(job) || 0) / maxDuration) * 100} r="3.8" className={job.conclusion === "success" ? "point-success" : "point-failure"}><title>{job.name}: {formatDuration(durationSeconds(job))} · {timestamp(job.createdAt)}</title></circle>)}</svg><div className="chart-times"><span>{timestamp(new Date(minTime).toISOString())}</span><span>{timestamp(new Date(maxTime).toISOString())}</span></div></div>;
}

function HostsView({ hosts, pending, onMode, onRevoke, onEnroll, onSelectJob }: { hosts: Host[]; pending: boolean; onMode: (host: Host, mode: HostMode) => void; onRevoke: (host: Host) => void; onEnroll: () => void; onSelectJob: (id: string) => void }) {
  if (!hosts.length) return <div className="panel"><Empty icon="hosts" title="Put your first machine to work"><p>Connect a Mac or Linux host. One job runs on each machine at a time.</p><button className="button button-primary" onClick={onEnroll}><Icon name="plus" />Add machine</button></Empty></div>;
  return <><div className="mode-guide"><div><strong>Dedicated</strong><span>Available for build work.</span></div><div><strong>Shared</strong><span>Reserves room for your other work.</span></div><div><strong>Paused</strong><span>Finishes active work; accepts no new jobs.</span></div></div><div className="host-grid">{hosts.map((host) => <article className="panel host-card" key={host.id}><div className="host-card-heading"><div className="machine-icon"><Icon name="hosts" size={25} /></div><div><h2>{host.name}</h2><span>{host.platform === "darwin" ? "macOS" : "Linux"} · {host.architecture === "arm64" ? "ARM64" : "x64"}</span></div><Status value={host.status} /></div><div className="host-mode"><label htmlFor={`mode-${host.id}`}>Build mode</label><select id={`mode-${host.id}`} value={host.mode} disabled={pending} onChange={(event) => onMode(host, event.target.value as HostMode)}><option value="dedicated">Dedicated</option><option value="shared">Shared</option><option value="paused">Paused</option></select></div>{host.metrics ? <div className={`host-metrics ${host.status === "offline" ? "stale-metrics" : ""}`}><Meter label="CPU" value={host.metrics.cpuPercent} detail={`${host.metrics.cpuPercent.toFixed(0)}% · ${host.metrics.cpuCount} cores`} /><Meter label="Memory" value={100 * host.metrics.memoryUsedBytes / host.metrics.memoryTotalBytes} detail={`${bytes(host.metrics.memoryUsedBytes)} / ${bytes(host.metrics.memoryTotalBytes)}`} />{host.metrics.memoryAvailableBytes !== undefined && <div className="disk-metric"><span title="Estimated room for new work, including reclaimable cache.">Available memory</span><strong>{bytes(host.metrics.memoryAvailableBytes)}</strong></div>}<div className="disk-metric"><span>Free disk</span><strong>{bytes(host.metrics.diskFreeBytes)}</strong></div></div> : <div className="host-no-metrics">Waiting for the first health report.</div>}<div className="host-labels">{host.labels.map((label) => <span className="tag" key={label}>{label}</span>)}</div><div className="host-current">{host.currentJobId ? <button className="text-button" onClick={() => onSelectJob(host.currentJobId!)}>View current job <Icon name="arrow" size={14} /></button> : <span>{hostAdmissionMessage(host)}</span>}</div><div className="host-card-footer"><span title={new Date(host.lastSeenAt).toLocaleString()}>Last seen {timestamp(host.lastSeenAt)}<small>Agent {host.version}</small></span><button className="text-button danger-text" disabled={pending} onClick={() => onRevoke(host)}>Remove</button></div></article>)}</div><p className="section-note">Metrics describe the whole machine. Shared mode uses admission checks and supported tool limits; it does not impose a hard CPU or memory boundary.</p></>;
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) { return <div className="meter"><div><span>{label}</span><strong>{detail}</strong></div><div className="meter-track" role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div></div>; }

function ConnectionsView({ overview, pending, onInstall, onSync, onToggle }: { overview: Overview; pending: boolean; onInstall: () => void; onSync: () => void; onToggle: (repository: Repository) => void }) {
  return <><div className="connection-banner"><div className="connection-banner-icon"><Icon name="github" size={28} /></div><div><h2>Connect through GitHub</h2><p>Install the GitHub App on your personal account or organization, then choose repositories here.</p></div><button className="button button-primary" disabled={pending} onClick={onInstall}><Icon name="plus" />Configure GitHub App</button></div><div className="section-heading"><h2>Connected accounts <span>{overview.connections.length}</span></h2><button className="button" disabled={pending} onClick={onSync}><Icon name="refresh" />Sync from GitHub</button></div>{!overview.connections.length ? <div className="panel"><Empty icon="connections" title="No GitHub accounts connected"><p>Choose an account or organization in GitHub’s installation flow, then sync to find its selected repositories.</p></Empty></div> : overview.connections.map((connection) => <section className="panel connection-card" key={connection.id}><div className="connection-account"><span className="account-avatar">{connection.account.slice(0, 1).toUpperCase()}</span><div><h3>{connection.account}</h3><span>{connection.accountType} · installation #{connection.id}</span></div></div>{overview.repositories.filter((repo) => repo.installationId === connection.id).length ? <div className="repository-list">{overview.repositories.filter((repo) => repo.installationId === connection.id).map((repository) => <div className="repository-row" key={repository.id}><Icon name="github" /><div><strong>{repository.fullName}</strong><span>{repository.private ? "Private" : "Public"} · Outside contributions require approval</span></div><button className={`toggle ${repository.enabled ? "toggle-on" : ""}`} type="button" role="switch" aria-checked={repository.enabled} aria-label={`Allow fleet jobs for ${repository.fullName}`} disabled={pending} onClick={() => onToggle(repository)}><span /></button><span className="toggle-label">{repository.enabled ? "Enabled" : "Disabled"}</span></div>)}</div> : <p className="connection-empty">No selected repositories found. Update the App installation on GitHub, then sync.</p>}</section>)}<p className="section-note">Repository access and dashboard membership are separate. Connecting another GitHub account does not give its owner access to this dashboard. Enabling a repository verifies its outside-contributor approval policy.</p></>;
}

function AuditView({ events }: { events: AuditEvent[] }) {
  const [search, setSearch] = useState("");
  const history = useHistory<AuditEvent>("/api/audit", events, 100);
  const filtered = history.items.filter((event) => `${event.actor} ${event.action} ${event.target} ${event.detail}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <section className="panel"><div className="filterbar"><div className="search-field"><Icon name="search" /><input aria-label="Search activity" placeholder="Search actors, actions, machines…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><span className="muted">{filtered.length} events loaded</span></div>{filtered.length ? <div className="audit-list">{filtered.map((event) => <article key={event.id} className="audit-row"><span className="audit-icon"><Icon name="audit" size={17} /></span><div><h3>{humanStatus(event.action.replace(/\./g, " "))}</h3><p><strong>{event.actor}</strong><span> · </span>{event.target}</p>{event.detail && <p className="audit-detail">{event.detail}</p>}</div><time dateTime={event.createdAt}>{timestamp(event.createdAt)}</time></article>)}</div> : <Empty icon="audit" title={search ? "No matching activity" : "A clear record of changes"}><p>{search ? "Try a different search." : "Machine enrollment, mode changes, and job controls will appear here."}</p></Empty>}<div className="history-pagination">{history.error && <ErrorNotice>{history.error}</ErrorNotice>}<span>90-day audit history</span>{history.hasMore ? <button className="button" disabled={history.loading} onClick={() => { void history.loadMore(); }}>{history.loading ? "Loading history…" : "Load older events"}</button> : <span>All retained events loaded</span>}</div></section>;
}

function SettingsView({ login, pending, onLogout }: { login: string; pending: boolean; onLogout: () => void }) {
  return <div className="settings-grid"><section className="panel settings-panel"><h2>Access</h2><p>GitHub authentication with explicit operator access.</p><dl><div><dt>Current operator</dt><dd>{login}</dd></div><div><dt>Team access</dt><dd>Owner only</dd></div><div><dt>Outside contributions</dt><dd>Maintainer approval required</dd></div></dl><button className="text-button" disabled={pending} onClick={onLogout}>Sign out of GitHub session</button></section><section className="panel settings-panel"><h2>History policy</h2><p>Default retention. Deployment configuration controls storage bounds and retention.</p><dl><div><dt>Console logs</dt><dd>30 days</dd></div><div><dt>Job metadata</dt><dd>90 days</dd></div><div><dt>Control audit</dt><dd>90 days</dd></div></dl></section><section className="panel settings-panel"><h2>Execution</h2><p>Native runners on the machines you enroll.</p><dl><div><dt>Platforms</dt><dd>macOS and Linux</dd></div><div><dt>Concurrent jobs</dt><dd>1 per physical host</dd></div><div><dt>Unavailable capacity</dt><dd>Jobs remain queued</dd></div><div><dt>Hosted fallback</dt><dd>Manual workflow change</dd></div></dl></section><section className="panel settings-panel"><h2>Live connection</h2><p>Machines connect outbound to the relay. Reconnecting clients recover ordered console history.</p><dl><div><dt>Dashboard</dt><dd>Vercel</dd></div><div><dt>Relay</dt><dd>Cloudflare</dd></div><div><dt>Relay outage</dt><dd>Active jobs finish; admission pauses</dd></div></dl></section></div>;
}

function EnrollmentDetails({ enrollment, onDone }: { enrollment: Enrollment; onDone: () => void }) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const copy = async (value: string, label: string) => { try { await navigator.clipboard.writeText(value); setCopied(label); setCopyError(""); } catch { setCopyError("Clipboard access is unavailable. Select and copy the value manually."); } };
  return <><p>Run the host service’s enrollment command and paste this token at its prompt. This token is shown only in this dialog and can be used once.</p><label className="field-label" htmlFor="enrollment-relay">Relay URL</label><div className="copy-field"><input id="enrollment-relay" value={enrollment.relayUrl} readOnly /><button className="icon-button" aria-label="Copy relay URL" onClick={() => { void copy(enrollment.relayUrl, "Relay URL"); }}><Icon name="copy" /></button></div><label className="field-label" htmlFor="enrollment-token">Enrollment token</label><div className="copy-field"><input id="enrollment-token" className="mono" value={enrollment.token} readOnly autoComplete="off" /><button className="icon-button" aria-label="Copy enrollment token" onClick={() => { void copy(enrollment.token, "Token"); }}><Icon name="copy" /></button></div><p className="fine-print"><a href="https://github.com/SpiritDevs/actions-fleet/tree/main/apps/agent#enroll" target="_blank" rel="noreferrer">Open host installation guide</a></p><p className="fine-print">Expires {timestamp(enrollment.expiresAt)}. Treat the token as a password until it is used or expires.</p>{copied && <p className="copy-status" role="status">{copied} copied.</p>}{copyError && <ErrorNotice>{copyError}</ErrorNotice>}<div className="modal-actions"><button className="button button-primary" onClick={onDone}>Done — hide token</button></div></>;
}

function JobDetail({ job, hosts, loading, onClose, subscribeLogs, connectionEpoch, connection, pending, onControl }: { job: Job | null; hosts: Host[]; loading: boolean; onClose: () => void; subscribeLogs: SubscribeLogs; connectionEpoch: number; connection: ConnectionState; pending: boolean; onControl: (job: Job, action: JobAction) => void }) {
  const logs = useJobLogs(job?.id ?? null, subscribeLogs, connectionEpoch);
  const [search, setSearch] = useState("");
  const [step, setStep] = useState("");
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { drawerRef.current?.showModal(); return () => drawerRef.current?.close(); }, []);
  useEffect(() => { setSearch(""); setStep(""); setFollow(true); }, [job?.id]);
  useEffect(() => { if (follow && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight; }, [logs.lines, follow, search, step]);
  const filtered = logs.lines.filter((line) => (!step || line.stepId === step) && stripAnsi(line.line).toLowerCase().includes(search.toLowerCase()));
  const stepIds = [...new Set(logs.lines.map((line) => line.stepId))].filter(Boolean);
  const host = hosts.find((item) => item.id === job?.hostId);
  const download = () => {
    const blob = new Blob([filtered.map((line) => `${line.timestamp} [${line.stepId}] ${stripAnsi(line.line)}`).join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `job-${job?.id ?? "logs"}-visible.log`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <dialog className={`job-drawer ${expanded ? "drawer-expanded" : ""}`} ref={drawerRef} aria-label="Job details" onCancel={(event) => { event.preventDefault(); onClose(); }}><div className="drawer-heading"><span className="eyebrow">JOB DETAILS</span><div><button className="text-button expand-button" onClick={() => setExpanded(!expanded)}>{expanded ? "Compact view" : "Expand"}</button><button className="icon-button" aria-label="Close job details" onClick={onClose}><Icon name="close" /></button></div></div>{!job ? <Empty icon="runs" title={loading ? "Loading job…" : "Job is unavailable"}><p>{loading ? "Fetching job history." : "This job is outside the retained history, or has not been received by the relay."}</p></Empty> : <><div className="job-detail-title"><p>{job.workflowName}</p><h2>{job.name}</h2><Status value={jobResult(job)} /></div><dl className="job-facts"><div><dt>Repository</dt><dd>{job.repository}</dd></div><div><dt>Branch</dt><dd>{job.branch || "—"}</dd></div><div><dt>Commit</dt><dd className="mono">{job.headSha.slice(0, 12)}</dd></div><div><dt>Triggered by</dt><dd>{job.actor || "—"}</dd></div><div><dt>Machine</dt><dd>{host?.name || job.runnerName || "Not assigned"}</dd></div><div><dt>Duration</dt><dd>{formatDuration(durationSeconds(job))}</dd></div><div><dt>Run / attempt</dt><dd>#{job.runId} / {job.runAttempt}</dd></div><div><dt>Created</dt><dd>{timestamp(job.createdAt)}</dd></div></dl><div className="job-controls"><a className="button" href={job.htmlUrl} target="_blank" rel="noreferrer">Open in GitHub <Icon name="arrow" size={15} /></a>{job.status === "waiting_approval" && <button className="button button-primary" disabled={pending} onClick={() => onControl(job, "approve")}>Approve run</button>}{job.status !== "completed" ? <><button className="button" disabled={pending} onClick={() => onControl(job, "cancel")}>Cancel run</button>{job.status === "in_progress" && <button className="text-button danger-text" disabled={pending} onClick={() => onControl(job, "force_cancel")}>Force cancel run</button>}</> : <><button className="button" disabled={pending} onClick={() => onControl(job, "rerun_job")}>Rerun job + dependents</button><details className="more-controls"><summary>More</summary><div><button disabled={pending} onClick={() => onControl(job, "rerun")}>Rerun entire workflow</button><button disabled={pending} onClick={() => onControl(job, "rerun_failed")}>Rerun failed jobs</button></div></details></>}</div>
      {job.steps.length > 0 && <details className="steps-panel"><summary>Workflow steps <span>{job.steps.filter((item) => item.status === "completed").length} / {job.steps.length} completed</span></summary><ol>{job.steps.map((item) => <li key={item.number}><span>{item.number}</span><strong>{item.name}</strong><Status value={item.conclusion || item.status} /></li>)}</ol></details>}
      <section className="console-section" aria-label="Job console"><div className="console-heading"><h3>Console output</h3><span className={`console-connection ${connection === "live" ? "is-live" : ""}`}><span className="connection-dot" />{connection === "live" ? "Live connection" : "Reconnecting · polling history"}</span></div><div className="console-toolbar"><div className="search-field"><Icon name="search" size={16} /><input type="search" aria-label="Search console output" placeholder="Find in loaded output…" value={search} onChange={(event) => setSearch(event.target.value)} /></div><select aria-label="Filter console by step" value={step} onChange={(event) => setStep(event.target.value)}><option value="">All step output</option>{stepIds.map((id) => <option key={id} value={id}>Step {id}</option>)}</select><button className="icon-button" aria-label="Download visible console lines" title="Download visible console lines" disabled={!filtered.length} onClick={download}><Icon name="download" size={17} /></button></div>
        {logs.error && <ErrorNotice>{logs.error} <button className="text-button" onClick={logs.retry}>Retry</button></ErrorNotice>}{logs.truncated && <div className="notice notice-neutral">Earlier output is no longer retained by the relay. GitHub may still have the original logs.</div>}
        <div className="console-output" ref={consoleRef} tabIndex={0} aria-label="Console lines" onScroll={() => { const element = consoleRef.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight > 50 && follow) setFollow(false); }}>{filtered.length ? filtered.map((line) => <div className="console-line" key={line.sequence}><span className="console-line-number" aria-hidden="true">{line.sequence}</span><time title={line.timestamp}>{new Date(line.timestamp).toLocaleTimeString([], { hour12: false })}</time><span>{stripAnsi(line.line)}</span></div>) : <div className="console-empty">{logs.loading ? "Loading console history…" : search || step ? "No loaded lines match these filters." : job.status === "queued" || job.status === "waiting_approval" ? "Console output will appear when the job starts." : "No console output has been received. GitHub’s original logs remain available from the job link."}</div>}</div><div className="console-footer"><span>{filtered.length.toLocaleString()} lines shown{logs.lines.length >= LOG_WINDOW ? ` · latest ${LOG_WINDOW.toLocaleString()} loaded` : ""}{logs.loading ? " · syncing history" : ""}</span><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />Follow output</label></div><p className="console-caption">Output is escaped text. Downloads include the visible window and active filters; open GitHub for its retained full job logs.</p>
      </section>
    </>}</dialog>;
}
