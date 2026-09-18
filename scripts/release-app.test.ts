// All network calls in this suite use an in-memory GitHub boundary.
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { releaseManifest, validateReleaseApp, validateReleasePermissions } from './setup-release-app.mjs';
import { releaseAppJwt, verifyReleaseInstallation } from './install-release-secrets.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = { id: 42, slug: 'pathway-release-test', name: 'Pathway Release', owner: { login: 'SpiritDevs', type: 'Organization' }, permissions: { contents: 'write', metadata: 'read' }, events: [], pem: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };

function upstream({ appOverride = {}, installationOverride = {}, repositories = [{ full_name: 'SpiritDevs/pathway' }] } = {}) {
  const calls = [];
  const installation = { id: 43, app_id: app.id, account: { login: 'SpiritDevs' }, suspended_at: null, repository_selection: 'selected', permissions: app.permissions, ...installationOverride };
  return {
    calls,
    fetch: async (url, options) => {
      const endpoint = new URL(url).pathname;
      calls.push({ endpoint, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      if (endpoint === '/installation/token') return new Response(null, { status: 204 });
      const responses = {
        '/app': { ...app, pem: undefined, ...appOverride },
        '/app/installations': [installation],
        '/repos/SpiritDevs/pathway/installation': installation,
        '/app/installations/43/access_tokens': { token: 'test-verification-token', permissions: { contents: 'read', metadata: 'read' } },
        '/installation/repositories': { total_count: repositories.length, repositories },
      };
      if (!(endpoint in responses)) throw new Error('Unexpected test endpoint');
      return new Response(JSON.stringify(responses[endpoint]), { headers: { 'Content-Type': 'application/json' } });
    },
  };
}

describe('separate Pathway release App setup', () => {
  it('requests only API contents access with a private App and inactive webhook', () => {
    const manifest = releaseManifest('http://127.0.0.1:63156/callback');
    expect(manifest.name).toBe('Pathway Release');
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({ contents: 'write', metadata: 'read' });
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.default_events).toEqual([]);
    expect(manifest).not.toHaveProperty('callback_urls');
  });
  it('accepts a conversion without OAuth/webhook secrets and does not retain unused credentials', () => {
    expect(validateReleaseApp(app)).toEqual(app);
    const saved = validateReleaseApp({ ...app, client_secret: 'unused', webhook_secret: 'unused' });
    expect(saved).not.toHaveProperty('client_secret');
    expect(saved).not.toHaveProperty('webhook_secret');
  });
  it('rejects other owners, invalid keys, read-only contents and management permissions', () => {
    expect(() => validateReleaseApp({ ...app, owner: { login: 'someone-else', type: 'Organization' } })).toThrow('SpiritDevs');
    expect(() => validateReleaseApp({ ...app, pem: 'not a private key' })).toThrow('RSA');
    expect(() => validateReleasePermissions({ contents: 'read', metadata: 'read' })).toThrow('Contents');
    expect(() => validateReleasePermissions({ ...app.permissions, administration: 'write' })).toThrow('Contents');
    expect(() => validateReleasePermissions({ ...app.permissions, actions: 'read' })).toThrow('Contents');
  });
  it('uses a short-lived valid App JWT without exposing its key in claims', () => {
    const jwt = releaseAppJwt(app);
    const [header, payload, signature] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'iss']);
    expect(claims.iss).toBe(String(app.id));
    expect(claims.exp - claims.iat).toBe(600);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
  it('verifies the unfiltered installed repository set and revokes its read-only token', async () => {
    const mock = upstream();
    expect(await verifyReleaseInstallation(app, mock.fetch)).toMatchObject({ appId: app.id, repository: 'SpiritDevs/pathway' });
    expect(mock.calls.find(call => call.endpoint.endsWith('/access_tokens')).body).toEqual({ permissions: { contents: 'read' } });
    expect(mock.calls.at(-1)).toEqual({ endpoint: '/installation/token', method: 'DELETE', body: undefined });
    expect(mock.calls.some(call => call.endpoint.includes('/actions/secrets'))).toBe(false);
  });
  it('rejects broader installation scope and revokes even when repository validation fails', async () => {
    const mock = upstream({ repositories: [{ full_name: 'SpiritDevs/pathway' }, { full_name: 'SpiritDevs/other' }] });
    await expect(verifyReleaseInstallation(app, mock.fetch)).rejects.toThrow('pathway only');
    expect(mock.calls.at(-1).endpoint).toBe('/installation/token');
    const all = upstream({ installationOverride: { repository_selection: 'all' } });
    await expect(verifyReleaseInstallation(app, all.fetch)).rejects.toThrow('Only select repositories');
    expect(all.calls.some(call => call.endpoint.endsWith('/access_tokens'))).toBe(false);
  });
  it('rejects a suspended installation or expanded App permissions before minting a token', async () => {
    for (const options of [{ installationOverride: { suspended_at: new Date().toISOString() } }, { appOverride: { permissions: { ...app.permissions, administration: 'write' } } }]) {
      const mock = upstream(options);
      await expect(verifyReleaseInstallation(app, mock.fetch)).rejects.toThrow();
      expect(mock.calls.some(call => call.endpoint.endsWith('/access_tokens'))).toBe(false);
    }
  });
});
