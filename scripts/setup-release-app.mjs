#!/usr/bin/env node
import http from 'node:http';
import { createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { access, chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const releaseRepository = 'SpiritDevs/pathway';
export const releaseAppFile = path.join(root, '.fleet/pathway-release-app.json');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function releaseManifest(callbackUrl) {
  return {
    name: 'Pathway Release',
    url: `https://github.com/${releaseRepository}`,
    description: 'Finalize Pathway stable releases by committing package version updates.',
    // hook_attributes.url is required when the object is supplied. This is an
    // inactive placeholder, not a webhook receiver; no events are subscribed.
    hook_attributes: { url: `https://github.com/${releaseRepository}`, active: false },
    redirect_url: callbackUrl,
    public: false,
    request_oauth_on_install: false,
    default_permissions: { contents: 'write', metadata: 'read' },
    default_events: [],
  };
}

export function validateReleaseApp(app) {
  if (!app || !Number.isSafeInteger(app.id) || app.id < 1 || typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug) || typeof app.pem !== 'string' || app.pem.length > 32768) throw new Error('GitHub returned incomplete release App credentials.');
  if (app.owner?.login?.toLowerCase() !== 'spiritdevs' || app.owner?.type !== 'Organization') throw new Error('The release App must belong to the SpiritDevs organization.');
  validateReleasePermissions(app.permissions);
  if (app.events && (!Array.isArray(app.events) || app.events.length)) throw new Error('The release App must have no subscribed events.');
  try {
    if (createPrivateKey(app.pem).asymmetricKeyType !== 'rsa') throw new Error();
  } catch { throw new Error('GitHub returned an invalid RSA release App key.'); }
  // An API-only App does not need an OAuth client secret or webhook secret.
  // Retain only the credential and metadata used by release finalization.
  return { id: app.id, slug: app.slug, name: app.name, owner: { login: app.owner.login, type: app.owner.type }, permissions: app.permissions, events: [], pem: app.pem };
}

export function validateReleasePermissions(permissions) {
  if (!permissions || permissions.contents !== 'write' || (permissions.metadata !== undefined && permissions.metadata !== 'read') || Object.entries(permissions).some(([name, level]) => !['contents', 'metadata'].includes(name) && level !== 'none')) {
    throw new Error('The release App requires Contents: write and Metadata: read only.');
  }
}

export async function startReleaseSetup() {
  const port = Number(process.env.PATHWAY_RELEASE_SETUP_PORT || 63156);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PATHWAY_RELEASE_SETUP_PORT must be a port between 1 and 65535.');
  try { await access(releaseAppFile); throw new Error('A saved Pathway release App already exists. Reuse it instead of overwriting its credentials.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = randomBytes(32).toString('hex');
  let used = false;
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${port}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'");
    if (request.headers.host !== `127.0.0.1:${port}`) { response.writeHead(400); response.end('Invalid Host'); return; }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url, origin);
    if (url.pathname === '/' && !used) {
      const manifest = releaseManifest(`${origin}/callback`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Pathway Release</title><meta name="viewport" content="width=device-width"><style>body{font:17px system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#172339}button{font:inherit;background:#2563eb;color:white;padding:12px 20px;border:0;border-radius:8px;cursor:pointer}p{line-height:1.6}</style><h1>Set up Pathway Release</h1><p>Create a separate private App under <strong>SpiritDevs</strong> with <strong>Contents: write</strong> and GitHub's required Metadata: read permission. After creation, install it on <strong>Only select repositories → pathway</strong>.</p><p>The release key stays separate from fleet management credentials. It will be saved locally with owner-only permissions and never displayed.</p><form method="post" action="https://github.com/organizations/SpiritDevs/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Pathway Release</button></form>`);
      return;
    }
    if (url.pathname === '/callback' && !used) {
      const incoming = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      if (!/^[a-f0-9]{64}$/.test(incoming) || !timingSafeEqual(Buffer.from(incoming), Buffer.from(state)) || !/^[a-zA-Z0-9_-]{10,200}$/.test(code)) { response.writeHead(400); response.end('Invalid setup callback.'); return; }
      used = true;
      try {
        const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: 'POST', redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pathway-release-setup', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(30000) });
        if (!conversion.ok) throw new Error(`GitHub manifest conversion failed (${conversion.status}).`);
        const app = validateReleaseApp(await conversion.json());
        const directory = path.dirname(releaseAppFile);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryInfo = await lstat(directory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('The local credentials directory must be a regular directory.');
        await chmod(directory, 0o700);
        await writeFile(releaseAppFile, JSON.stringify(app, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><title>Pathway Release created</title><h1>Pathway Release created</h1><p>Credentials were saved locally. Install this App on SpiritDevs, choose <strong>Only select repositories</strong>, and select <strong>pathway</strong> only.</p><p><a href="https://github.com/apps/${escape(app.slug)}/installations/new">Install Pathway Release</a></p><p>After installation, the local credential installer will verify its scope before setting the release secrets.</p>`);
        console.log('Pathway release App saved in .fleet/pathway-release-app.json with owner-only permissions. No secrets printed.');
      } catch (error) {
        response.writeHead(502); response.end('Release App setup failed. Check the local terminal.');
        // Never print conversion response bodies or credential-bearing errors.
        console.error(error instanceof SyntaxError ? 'GitHub returned invalid App configuration JSON.' : ['EEXIST', 'EACCES', 'EPERM'].includes(error.code) ? 'Could not safely save the release App credential file.' : error.message);
        process.exitCode = 1;
      } finally { server.close(); }
      return;
    }
    response.writeHead(404); response.end('Not found');
  });
  server.on('error', () => { console.error('Could not start release setup on the configured loopback port.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${port}/ on this Mac to create Pathway Release.`));
  const deadline = setTimeout(() => { console.error('Release App setup expired after one hour.'); process.exitCode = 1; server.close(); }, 60 * 60 * 1000);
  deadline.unref();
  server.on('close', () => clearTimeout(deadline));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startReleaseSetup().catch(error => { console.error(error.message); process.exitCode = 1; });
}
