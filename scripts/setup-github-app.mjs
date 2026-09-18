#!/usr/bin/env node
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dashboard=new URL(process.env.DASHBOARD_ORIGIN || 'https://actions.spiritdevs.com');
const relay=new URL(process.env.RELAY_PUBLIC_URL || 'https://api.actions.spiritdevs.com');
const organization=process.env.GITHUB_APP_ORGANIZATION || 'SpiritDevs';
if (!/^[a-zA-Z0-9-]+$/.test(organization)) throw new Error('Invalid GitHub organization.');
if ([dashboard,relay].some(url=>url.protocol!=='https:' || url.username || url.password)) throw new Error('Use HTTPS public origins.');
const state=randomBytes(32).toString('hex');
const output=path.join(root,'.fleet/github-app.json');
try { await access(output); throw new Error('A saved App configuration already exists. Reuse it; do not overwrite live credentials.'); }
catch(error) { if(error.code!=='ENOENT') throw error; }
let used=false;
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const server=http.createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.host!==`127.0.0.1:${server.address().port}`) {res.writeHead(400);res.end('Invalid Host');return;}
  const url=new URL(req.url,origin);
  if(req.method!=='GET') {res.writeHead(405);res.end();return;}
  if(url.pathname==='/' && !used) {
    const manifest={
      name:'SpiritDevs Actions Fleet',url:dashboard.origin,
      description:'Native Mac/Linux GitHub Actions fleet with live logs and remote controls.',
      hook_attributes:{url:new URL('/webhooks/github',relay).href,active:true},
      redirect_url:`${origin}/callback`,callback_urls:[new URL('/auth/github/callback',dashboard).href],
      setup_url:dashboard.origin,setup_on_update:true,request_oauth_on_install:false,public:true,
      default_permissions:{administration:'write',actions:'write',contents:'read',metadata:'read',pull_requests:'read'},
      // GitHub sends installation lifecycle events automatically; requesting
      // them explicitly makes an otherwise valid App manifest fail validation.
      default_events:['workflow_job','workflow_run'],
    };
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'");
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><title>Set up Actions Fleet</title><meta name="viewport" content="width=device-width"><style>body{font:17px system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#172339}button{font:inherit;background:#2563eb;color:white;padding:12px 20px;border:0;border-radius:8px;cursor:pointer}p{line-height:1.6}</style><h1>Connect Actions Fleet to GitHub</h1><p>Create the App under <strong>${escape(organization)}</strong>. GitHub will show the requested repository permissions. Choose which repositories to install it on afterward.</p><p>App keys will be saved locally with owner-only permissions. No keys are displayed here or sent to another service.</p><form method="post" action="https://github.com/organizations/${organization}/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Create GitHub App</button></form>`);
    return;
  }
  if(url.pathname==='/callback' && !used) {
    const incoming=url.searchParams.get('state') || '';
    const code=url.searchParams.get('code') || '';
    if(incoming.length!==state.length || !timingSafeEqual(Buffer.from(incoming),Buffer.from(state)) || !/^[a-zA-Z0-9_-]{10,200}$/.test(code)) {res.writeHead(400);res.end('Invalid setup callback.');return;}
    used=true;
    try {
      const response=await fetch(`https://api.github.com/app-manifests/${code}/conversions`,{method:'POST',headers:{Accept:'application/vnd.github+json','User-Agent':'actions-fleet-setup','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new Error(`GitHub manifest conversion failed (${response.status}).`);
      const app=await response.json();
      if(!app.id || !app.pem || !app.client_id || !app.client_secret || !app.webhook_secret) throw new Error('GitHub returned incomplete App credentials.');
      await mkdir(path.dirname(output),{recursive:true,mode:0o700});
      await writeFile(output,JSON.stringify(app,null,2)+'\n',{mode:0o600,flag:'wx'});
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><title>App created</title><h1>GitHub App created</h1><p>Credentials were saved locally. You can close this window.</p><p><a href="https://github.com/apps/${escape(app.slug)}/installations/new">Select repositories for this App</a></p>`);
      console.log(`GitHub App ${app.slug} saved securely in .fleet/github-app.json. No secrets printed.`);
      server.close();
    }catch(error){res.writeHead(502);res.end('App setup failed. See the local terminal.');console.error(error.message);server.close();process.exitCode=1;}
    return;
  }
  res.writeHead(404);res.end('Not found');
});
const port=Number(process.env.FLEET_SETUP_PORT || 0);
if(!Number.isInteger(port) || port<0 || port>65535) throw new Error('Invalid setup port.');
server.listen(port,'127.0.0.1',()=>console.log(`Open http://127.0.0.1:${server.address().port}/ on this Mac to create the GitHub App.`));
const deadline=setTimeout(()=>{console.error('App setup expired after one hour.');server.close();},60*60*1000);
deadline.unref();
