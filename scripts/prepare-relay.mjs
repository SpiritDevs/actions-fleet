#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const ownerId = process.env.OWNER_GITHUB_ID;
if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID.');
if (!/^[1-9][0-9]*$/.test(ownerId || '')) throw new Error('Set OWNER_GITHUB_ID to the operator’s numeric GitHub ID.');
const dashboard = new URL(process.env.DASHBOARD_ORIGIN || 'https://actions.spiritdevs.com');
const relay = new URL(process.env.RELAY_PUBLIC_URL || 'https://api.actions.spiritdevs.com');
for (const url of [dashboard, relay]) {
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Dashboard and relay addresses must be HTTPS origins.');
  }
}
const app = JSON.parse(await readFile(path.join(root, '.fleet/github-app.json'), 'utf8'));
if (!app.id || !app.slug || !app.client_id || !app.pem || !app.client_secret || !app.webhook_secret) {
  throw new Error('Complete the GitHub App manifest setup first.');
}
const template = JSON.parse(await readFile(path.join(root, 'apps/relay/wrangler.jsonc'), 'utf8'));
const config = {
  ...template,
  main: path.join(root, 'apps/relay/src/index.ts'),
  account_id: accountId,
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: relay.hostname, custom_domain: true }],
  vars: {
    ...template.vars,
    OWNER_GITHUB_ID: ownerId,
    DASHBOARD_ORIGIN: dashboard.origin,
    RELAY_PUBLIC_URL: relay.origin,
    GITHUB_APP_ID: String(app.id),
    GITHUB_APP_SLUG: app.slug,
    GITHUB_CLIENT_ID: app.client_id,
  },
};
await mkdir(path.join(root, '.fleet'), { recursive: true, mode: 0o700 });
await writeFile(path.join(root, '.fleet/wrangler.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log('Prepared .fleet/wrangler.json (no secret values). Deploy it, then run scripts/upload-relay-secrets.mjs.');
