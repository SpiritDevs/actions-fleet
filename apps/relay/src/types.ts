export interface Env {
  FLEET: DurableObjectNamespace;
  OWNER_GITHUB_ID: string;
  DASHBOARD_ORIGIN: string;
  RELAY_PUBLIC_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  MAX_LOG_BYTES?: string;
  MAX_JOB_LOG_BYTES?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const json = (value: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
export const nowIso = (): string => new Date().toISOString();
export const after = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();
export const id = (): string => crypto.randomUUID();

export function configured(env: Env): boolean {
  return !!(env.OWNER_GITHUB_ID && env.DASHBOARD_ORIGIN && env.RELAY_PUBLIC_URL &&
    env.GITHUB_APP_ID && env.GITHUB_APP_SLUG && env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_WEBHOOK_SECRET);
}

export async function body(request: Request, maxBytes = 1048576): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, "Request exceeds the upload limit"); }
    parts.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, "Invalid JSON body"); }
}
