#!/usr/bin/env node
import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Build Output API: Vercel serves the locally built dashboard without a remote build.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relay = new URL(process.env.RELAY_PUBLIC_URL || 'https://api.actions.spiritdevs.com');
if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/') {
  throw new Error('RELAY_PUBLIC_URL must be an HTTPS origin.');
}
const source = path.join(root, 'apps/dashboard/dist');
await access(path.join(source, 'index.html'));
const output = path.join(root, '.vercel/output');
await mkdir(output, { recursive: true });
await rm(path.join(output, 'static'), { recursive: true, force: true });
await cp(source, path.join(output, 'static'), { recursive: true });
const config = {
  version: 3,
  routes: [
    { src: '/(api|auth)(/.*)?', dest: `${relay.origin}/$1$2`, headers: { 'Cache-Control': 'no-store' } },
    { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, continue: true },
    { handle: 'filesystem' },
    { src: '/.*', dest: '/index.html' },
  ],
};
await writeFile(path.join(output, 'config.json'), JSON.stringify(config, null, 2) + '\n');
console.log('Prepared .vercel/output from the local dashboard build. Deploy with vercel deploy --prebuilt --prod.');
