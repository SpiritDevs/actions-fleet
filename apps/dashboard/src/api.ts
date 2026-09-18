export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ApiError"; }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status}).`, response.status);
  if (data === null) throw new ApiError("The service returned an invalid response. Check the dashboard proxy configuration.", response.status);
  return data as T;
}

export function post<T = { ok: true }>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}
