import { execFileSync } from 'node:child_process';

// Reuse an operator's existing gh login. The GitHub credential is sent once to
// the configured fleet relay and never written to fleet storage or stdout.
export async function operatorClient() {
  const relay = new URL(process.env.RELAY_PUBLIC_URL || 'https://api.actions.spiritdevs.com');
  const dashboard = new URL(process.env.DASHBOARD_ORIGIN || 'https://actions.spiritdevs.com');
  for (const origin of [relay, dashboard]) {
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('Configure HTTPS origins for the dashboard and relay.');
    }
  }
  const githubCredential = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const login = await fetch(new URL('/auth/cli', relay), {
    method: 'POST', redirect: 'error',
    headers: { Origin: dashboard.origin, Authorization: `Bearer ${githubCredential}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!login.ok) throw new Error(`Fleet operator login failed (${login.status}).`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('fleet_session=')) throw new Error('Fleet login did not return a session.');
  return async function request(route, data) {
    const url = new URL(route, relay);
    if (url.origin !== relay.origin || !url.pathname.startsWith('/api/')) throw new Error('Only fleet API routes are supported.');
    const response = await fetch(url, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Cookie: cookie, Origin: dashboard.origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Fleet ${url.pathname} failed (${response.status}).`);
    return response.json();
  };
}
