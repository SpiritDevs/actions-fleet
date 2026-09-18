import { useCallback, useEffect, useRef, useState } from "react";
import type { FleetEvent, LogLine, Overview, Viewer } from "@actions-fleet/protocol";
import { api, ApiError, errorMessage, post } from "./api";
import { mergeLogLines } from "./model";

export interface Session { viewer: Viewer | null; configured: boolean; loginUrl: string }
export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";
type LogListener = (jobId: string, lines: LogLine[]) => void;
export type SubscribeLogs = (listener: LogListener) => () => void;

export function useFleet() {
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const listeners = useRef(new Set<LogListener>());
  const refreshing = useRef(false);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try { setSession(await api<Session>("/api/session")); setError(""); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const result = await api<Overview>("/api/overview");
      setOverview(result); setError(""); setUpdatedAt(new Date());
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status === 401) {
        setOverview(null);
        setSession((current) => current ? { ...current, viewer: null } : null);
      }
    } finally { refreshing.current = false; }
  }, []);

  const subscribeLogs = useCallback<SubscribeLogs>((listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useEffect(() => { void refreshSession(); }, [refreshSession]);

  const authenticated = Boolean(session?.viewer);
  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 20_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [authenticated, refresh]);

  useEffect(() => {
    if (!authenticated) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let refreshTimer = 0;
    let failures = 0;
    const queueRefresh = () => {
      if (!refreshTimer) refreshTimer = window.setTimeout(() => { refreshTimer = 0; void refresh(); }, 250);
    };
    const connect = async () => {
      if (stopped) return;
      setConnection(failures ? "reconnecting" : "connecting");
      try {
        const ticket = await post<{ url: string; expiresAt: string }>("/api/live-ticket");
        if (stopped) return;
        socket = new WebSocket(ticket.url);
        socket.onopen = () => {
          failures = 0; setConnection("live"); setConnectionEpoch((value) => value + 1); queueRefresh();
        };
        socket.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as FleetEvent;
            if (event.type === "logs" && Array.isArray(event.lines)) {
              for (const listener of listeners.current) listener(event.jobId, event.lines);
            } else if (event.type === "error") setError(event.message);
            else if (event.type === "refresh" || event.type === "host_mode") queueRefresh();
          } catch { setError("An unreadable live update was received. History will recover on the next refresh."); }
        };
        socket.onclose = reconnect;
        socket.onerror = () => { socket?.close(); };
      } catch { reconnect(); }
    };
    const reconnect = () => {
      if (stopped) return;
      failures += 1;
      setConnection(navigator.onLine ? "reconnecting" : "offline");
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => { void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) + Math.random() * 500);
    };
    const onOnline = () => { window.clearTimeout(reconnectTimer); if (socket?.readyState !== WebSocket.OPEN) void connect(); };
    window.addEventListener("online", onOnline);
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer); window.clearTimeout(refreshTimer);
      window.removeEventListener("online", onOnline);
      if (socket) { socket.onclose = null; socket.close(); }
    };
  }, [authenticated, refresh]);

  return { session, overview, error, loading, connection, connectionEpoch, updatedAt, refresh, refreshSession, subscribeLogs };
}

interface LogPage { lines: LogLine[]; nextCursor: number; truncated: boolean; hasMore?: boolean }

export function useJobLogs(jobId: string | null, subscribe: SubscribeLogs, connectionEpoch: number) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const catchUpRef = useRef<() => void>(() => {});

  useEffect(() => {
    setLines([]); setError(""); setTruncated(false);
    if (!jobId) return;
    let stopped = false;
    let cursor = 0;
    let fetching = false;
    const controller = new AbortController();
    const catchUp = async () => {
      if (fetching || stopped) return;
      fetching = true;
      setLoading(true);
      try {
        let hasMore = true;
        // A bounded batch keeps very large jobs responsive; the next tick continues.
        for (let page = 0; hasMore && page < 40 && !stopped; page += 1) {
          const result = await api<LogPage>(`/api/jobs/${encodeURIComponent(jobId)}/logs?after=${cursor}`, { signal: controller.signal });
          if (stopped) return;
          if (result.truncated) setTruncated(true);
          setLines((current) => mergeLogLines(current, result.lines));
          hasMore = (result.hasMore ?? result.lines.length > 0) && result.nextCursor > cursor;
          cursor = Math.max(cursor, result.nextCursor);
        }
        setError("");
      } catch (cause) { if (!stopped) setError(errorMessage(cause)); }
      finally { fetching = false; if (!stopped) setLoading(false); }
    };
    catchUpRef.current = () => { void catchUp(); };
    const unsubscribe = subscribe((eventJobId, incoming) => {
      if (eventJobId === jobId) setLines((current) => mergeLogLines(current, incoming));
    });
    void catchUp();
    const timer = window.setInterval(() => { void catchUp(); }, 10_000);
    return () => {
      stopped = true; controller.abort(); unsubscribe(); window.clearInterval(timer); catchUpRef.current = () => {};
    };
  }, [jobId, subscribe]);

  useEffect(() => { catchUpRef.current(); }, [connectionEpoch]);
  return { lines, error, loading, truncated, retry: () => catchUpRef.current() };
}

interface HistoryItem { id: string; createdAt: string }
interface HistoryPage<T> { items: T[]; nextCursor: string | null }

export function useHistory<T extends HistoryItem>(path: string, current: T[], limit: number) {
  const [older, setOlder] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const combined = new Map(older.map((item) => [item.id, item]));
  for (const item of current) combined.set(item.id, item);
  const items = [...combined.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const loadMore = async () => {
    if (loading || cursor === null) return;
    setLoading(true); setError("");
    try {
      let next: string | null | undefined = cursor;
      const batch: T[] = [];
      // First establish the cursor past the already-visible overview window.
      // A second page on the initial click makes "Load older" useful immediately.
      for (let page = 0; page < (cursor === undefined ? 2 : 1); page += 1) {
        const query = new URLSearchParams({ limit: String(limit) });
        if (next) query.set("cursor", next);
        const result = await api<HistoryPage<T>>(`${path}?${query}`);
        batch.push(...result.items); next = result.nextCursor;
        if (!next || result.items.some((item) => !combined.has(item.id))) break;
      }
      setOlder((previous) => [...new Map([...previous, ...batch].map((item) => [item.id, item])).values()]);
      setCursor(next);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  };
  return { items, loading, error, hasMore: cursor !== null, loadMore };
}
