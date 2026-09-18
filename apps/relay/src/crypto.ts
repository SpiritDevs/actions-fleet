const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
const url64 = (bytes: Uint8Array): string => base64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
export const randomToken = (): string => url64(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string): Promise<string> {
  return url64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
export async function verifySignature(secret: string, payload: ArrayBuffer, signature: string): Promise<boolean> {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, part => parseInt(part, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, bytes, payload);
}
function derLength(length: number): number[] {
  if (length < 128) return [length];
  const bytes: number[] = [];
  while (length) { bytes.unshift(length & 255); length >>>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function pkcs8(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const decoded = Uint8Array.from(atob(normalized.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
  if (!normalized.includes("BEGIN RSA PRIVATE KEY")) return decoded;
  const prefix = [2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0];
  const contents = [...prefix, 4, ...derLength(decoded.length), ...decoded];
  return new Uint8Array([48, ...derLength(contents.length), ...contents]);
}
export async function appJwt(appId: string, pem: string): Promise<string> {
  const current = Math.floor(Date.now() / 1000);
  const content = `${url64(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${url64(encoder.encode(JSON.stringify({ iat: current - 60, exp: current + 540, iss: appId })))}`;
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(content));
  return `${content}.${url64(new Uint8Array(signature))}`;
}

export function cookies(request: Request): Record<string, string> {
  return Object.fromEntries((request.headers.get("Cookie") ?? "").split(";").map(v => v.trim()).filter(Boolean).map(v => {
    const at = v.indexOf("="); return [v.slice(0, at), v.slice(at + 1)];
  }));
}
export const cookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
