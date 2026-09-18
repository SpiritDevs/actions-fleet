#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseAppFile, releaseRepository, validateReleaseApp, validateReleasePermissions } from './setup-release-app.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function releaseAppJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: String(app.id), iat: now - 60, exp: now + 540 })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(app.pem)).toString('base64url')}`;
}

async function github(endpoint, credential, method = 'GET', data, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com${endpoint}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${credential}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'pathway-release-setup', 'X-GitHub-Api-Version': '2026-03-10' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub release App verification failed (${method} ${endpoint}, HTTP ${response.status}).`);
  return response.status === 204 ? undefined : response.json();
}

export async function verifyReleaseInstallation(app, fetcher = fetch) {
  const jwt = releaseAppJwt(app);
  const verified = await github('/app', jwt, 'GET', undefined, fetcher);
  if (verified.id !== app.id || verified.owner?.login?.toLowerCase() !== 'spiritdevs' || verified.owner?.type !== 'Organization') throw new Error('Release App identity or owner does not match the saved configuration.');
  validateReleasePermissions(verified.permissions);
  if (!Array.isArray(verified.events) || verified.events.length) throw new Error('Remove event subscriptions from the API-only release App.');
  const installations = await github('/app/installations?per_page=100', jwt, 'GET', undefined, fetcher);
  if (!Array.isArray(installations) || installations.length !== 1) throw new Error('The release App must have exactly one installation, on SpiritDevs.');
  const installation = await github(`/repos/${releaseRepository}/installation`, jwt, 'GET', undefined, fetcher);
  if (installation.id !== installations[0].id || installation.app_id !== app.id || installation.account?.login?.toLowerCase() !== 'spiritdevs' || installation.suspended_at || installation.repository_selection !== 'selected') throw new Error('Install the unsuspended release App on SpiritDevs using Only select repositories → pathway.');
  validateReleasePermissions(installation.permissions);
  // A temporary READ-ONLY token exposes the installation's actual repository
  // selection. Do not restrict it to Pathway here: that would hide excess scope.
  const temporary = await github(`/app/installations/${installation.id}/access_tokens`, jwt, 'POST', { permissions: { contents: 'read' } }, fetcher);
  if (typeof temporary.token !== 'string' || !temporary.token) throw new Error('GitHub did not issue an installation verification token.');
  try {
    if (temporary.permissions?.contents !== 'read' || Object.entries(temporary.permissions || {}).some(([name, level]) => !['contents', 'metadata'].includes(name) && level !== 'none')) throw new Error('GitHub did not issue the requested read-only verification scope.');
    const selected = await github('/installation/repositories?per_page=100', temporary.token, 'GET', undefined, fetcher);
    if (selected.total_count !== 1 || selected.repositories?.length !== 1 || selected.repositories[0].full_name?.toLowerCase() !== releaseRepository.toLowerCase()) throw new Error('The release App must be installed on SpiritDevs/pathway only. Remove every other selected repository.');
  } finally {
    // Revocation failure fails this preflight too; no repository secrets have
    // been changed at this point. The temporary token otherwise expires at GitHub.
    await github('/installation/token', temporary.token, 'DELETE', undefined, fetcher);
  }
  return { appId: app.id, slug: verified.slug, installationId: installation.id, repository: releaseRepository };
}

async function loadReleaseApp() {
  const handle = await open(releaseAppFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 131072 || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('The release credential file must be a regular owner-only file (chmod 600).');
    let parsed;
    try { parsed = JSON.parse(await handle.readFile('utf8')); } catch { throw new Error('The local release App configuration is invalid JSON.'); }
    return validateReleaseApp(parsed);
  } finally { await handle.close(); }
}

function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    // Suppress subprocess output: even unexpected tool errors must not expose a
    // key supplied through stdin. Report the operation and status ourselves.
    child.stdout.resume(); child.stderr.resume();
    child.on('error', () => reject(new Error('Could not start GitHub CLI. Install gh and authenticate with repository administration access.')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`GitHub CLI could not complete ${args.slice(0, 2).join(' ')} (exit ${code ?? 'unknown'}). Check authentication and repository administration access.`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function installReleaseSecrets({ checkOnly = false } = {}) {
  const app = await loadReleaseApp();
  try {
    const fleet = JSON.parse(await readFile(path.join(root, '.fleet/github-app.json'), 'utf8'));
    if (fleet.id === app.id) throw new Error('Refusing to put the fleet management App key into release workflows. Create the separate Pathway Release App.');
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The local fleet App configuration is invalid JSON; release credentials were not installed.');
    if (error.code !== 'ENOENT') throw error;
  }
  const verified = await verifyReleaseInstallation(app);
  console.log(`Verified release App ${verified.slug}: Contents write, only ${releaseRepository}.`);
  if (checkOnly) { console.log('Check complete. No repository secrets changed.'); return; }
  await gh(['auth', 'status', '--hostname', 'github.com']);
  const installed = [];
  try {
    for (const [name, value] of [['RELEASE_APP_PRIVATE_KEY', app.pem], ['RELEASE_APP_ID', String(app.id)]]) {
      await gh(['secret', 'set', name, '--repo', releaseRepository, '--app', 'actions'], value);
      installed.push(name);
    }
  } catch (error) {
    if (installed.length) console.error(`Only ${installed.join(', ')} was updated. Keep stable release finalization paused and rerun after fixing the CLI access failure.`);
    throw error;
  }
  for (const name of installed) await gh(['api', `/repos/${releaseRepository}/actions/secrets/${name}`]);
  console.log(`Installed and verified the existence of RELEASE_APP_ID and RELEASE_APP_PRIVATE_KEY on ${releaseRepository}. No secret values printed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    console.error('Usage: node scripts/install-release-secrets.mjs [--check]'); process.exitCode = 1;
  } else {
    installReleaseSecrets({ checkOnly: args.includes('--check') }).catch(error => {
      console.error(error instanceof SyntaxError ? 'GitHub returned invalid verification JSON; no credential values were printed.' : ['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code) ? 'Cannot read the secure local release App configuration; complete setup first.' : error.message);
      process.exitCode = 1;
    });
  }
}
