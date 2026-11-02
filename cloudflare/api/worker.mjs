import { authorizeSource } from '../../access-policy.mjs';
import express from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { env } from 'cloudflare:workers';
import accountWorker from '../auth/worker.mjs';
import { createApiApp } from './generated.ts';

const quota = new Map(); // Plain counters only; signed client tokens retain existing quota semantics.
const flowStore = {
  async get(key) { const row = await env.DB.prepare('SELECT data FROM api_oauth_flows WHERE user_id = ? AND expires_at > ?').bind(key,Date.now()).first(); return row ? JSON.parse(row.data) : undefined; },
  async set(key, value) { await env.DB.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify(value),value.expires).run(); },
  async delete(key) { await env.DB.prepare('DELETE FROM api_oauth_flows WHERE user_id = ?').bind(key).run(); }
};
const app = express();
app.disable('x-powered-by');
app.use(async (req,res,next) => {
  try { const api = await createApiApp({...env,ACCOUNT:{fetch:(input,init)=>accountWorker.fetch(new Request(input,init),env)}}, flowStore, quota); api(req,res,next); } catch(e) { next(e); }
});
app.use((_req,res) => res.status(404).json({error:'API not found'}));
app.use((error,_req,res,_next) => { console.error(JSON.stringify({message:'API failed',error:String(error)})); if(!res.headersSent) res.status(500).json({error:'API internal error'}); });
app.listen(3000);
const handler = httpServerHandler({port:3000});
async function handle(request, bindings, ctx) {
  const path = new URL(request.url).pathname;
  if (/^\/api\/download(?:-|\/|$)/.test(path)) return Response.json({error:'ダウンロード機能は削除されました。',code:'DOWNLOAD_REMOVED'},{status:410});
  if (path.startsWith('/api/account/')) return accountWorker.fetch(request, bindings);
  if (path === '/health') return Response.json({ok:true, runtime:'cloudflare-workers', implementation:'full-express-api'});
  // Client and OAuth objects are created inside each request, never reused across accounts/requests.
  if(quota.size > 10000) for(const [key,value] of quota) if(Date.now()-value.lastSeen > 86400000) quota.delete(key);
  return handler.fetch(request,bindings,ctx);
}
export default {async fetch(request,bindings,ctx){
 const rejected=authorizeSource(request,bindings);if(rejected)return rejected;
 const origin=request.headers.get('Origin');const allowed=(bindings.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 const cors=origin&&allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type,Range,X-Youtube-Credentials,X-Client-Id,X-Usage-Token,X-Client-Usage','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Access-Control-Expose-Headers':'X-Daily-Usage-Token','Vary':'Origin'}:{};
 if(request.method==='OPTIONS')return new Response(null,{status:origin&&allowed.includes(origin)?204:403,headers:cors});
 const response=await handle(request,bindings,ctx);if(!origin||!allowed.includes(origin))return response;
 const headers=new Headers(response.headers);for(const [key,value]of Object.entries(cors))headers.set(key,value);return new Response(response.body,{status:response.status,headers});
}};
