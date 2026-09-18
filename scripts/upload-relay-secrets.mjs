#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = JSON.parse(await readFile(path.join(root, '.fleet/github-app.json'), 'utf8'));
const secrets = {
  GITHUB_APP_PRIVATE_KEY: app.pem,
  GITHUB_CLIENT_SECRET: app.client_secret,
  GITHUB_WEBHOOK_SECRET: app.webhook_secret,
};
if (Object.values(secrets).some(value => typeof value !== 'string' || value.length < 10)) {
  throw new Error('Incomplete local GitHub App credentials.');
}
const child = spawn(path.join(root, 'node_modules/.bin/wrangler'), ['secret', 'bulk', '--config', path.join(root, '.fleet/wrangler.json')], {
  cwd: root, stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(JSON.stringify(secrets));
child.on('error', () => { console.error('Could not start Wrangler. Install workspace dependencies first.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
