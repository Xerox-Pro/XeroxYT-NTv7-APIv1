import {issueRealtimeTicket,upgradeRealtime,notifyAdmin,readSystemMonitor,socketPath,ticketPath,receiveRealtimeRelay,relayPath} from './realtime.mjs';
import {secureApiResponse} from '../security/http.mjs';
import {privatePath,handlePrivateApi,issuePrivateTicket} from './private-api.mjs';
import {authorizeSource} from '../../access-policy.mjs';
import accountWorker,{bannedResponse,currentUser,currentUserByHash,isMaster,sessionHash} from '../auth/worker.mjs';
import {handleYouTubeStore} from '../../youtube-store-bridge.mjs';
import {withGasAccess} from './gas-access.mjs';
import {withD1Bindings} from '../../d1-rest.mjs';
const lastSeenWrites = new Map();
function trackLastCommunication(user, request, env, ctx) {
 if (!user?.id || !env.DB || !ctx?.waitUntil || request.method === 'OPTIONS') return;
 const path = new URL(request.url).pathname;
 if (!/^\/(?:api\/|stream\/|360\/|edu\/|scratch-edu\/)/.test(path) ||
  /^\/api\/account\/(?:presence|visual-mode|dm|admin)(?:\/|$)/.test(path)) return;
 const now = Date.now();
 if (now - (lastSeenWrites.get(user.id) ?? 0) < 300000) return;
 if (lastSeenWrites.size >= 2048) lastSeenWrites.delete(lastSeenWrites.keys().next().value);
 lastSeenWrites.set(user.id, now);
 const day = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
 ctx.waitUntil(Promise.resolve().then(() => env.DB.prepare(
  'INSERT INTO account_usage(user_id,day,requests,videos,searches,last_seen) VALUES(?,?,0,0,0,?) ' +
  'ON CONFLICT(user_id,day) DO UPDATE SET last_seen=MAX(account_usage.last_seen,excluded.last_seen)'
 ).bind(user.id, day, now).run()).then(()=>notifyAdmin(env,'accounts')).catch(() => {
  if (lastSeenWrites.get(user.id) === now) lastSeenWrites.delete(user.id);
 }));
}
async function handleRequest(request,env,ctx,monitor){
 const pathName=new URL(request.url).pathname;
 if(/^\/api\/(instagram|tiktok|x|x-public-post|social-browser)(?:\/|$)/i.test(pathName))return Response.json({error:'Not found'},{status:404});
 const direct=privatePath(pathName)&&/^XYT /.test(request.headers.get('Authorization')||'');
 const rejected=authorizeSource(request,direct||request.method==='OPTIONS'?{...env,REQUIRE_PROXY_SECRET:'false'}:env);if(rejected)return rejected;
 const url=new URL(request.url),path=url.pathname;
 const origin=request.headers.get('Origin'),allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 const cors=origin&&allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type,Authorization,Range,X-Client-Id,X-Usage-Token,X-Client-Usage','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Access-Control-Max-Age':'600','Access-Control-Expose-Headers':'X-Daily-Usage-Token,Retry-After,X-XeroxYT-Account-Id,X-XeroxYT-Account-Mode','Vary':'Origin'}:{};
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 let response;
 try{
  const user=await currentUser(request,env.DB,env);
  monitor.user=user;
  if(path===ticketPath&&request.method==='GET'){
   if(!user)return new Response(null,{status:401});
   return issueRealtimeTicket(request,env,user,sessionHash(request),isMaster(user,env));
  }
  trackLastCommunication(user,request,env,ctx);
  if(user?.banned)return bannedResponse();
  if(path==='/internal/youtube-store'){const denied=authorizeSource(request,{...env,REQUIRE_PROXY_SECRET:'true'});if(denied)return denied;return await handleYouTubeStore(request,env.DB);}
  if(path==='/api/account/cloudflare-session'&&request.method==='GET')response=await issuePrivateTicket(request,env);
  else if(privatePath(path))response=await handlePrivateApi(request,env);
  else if(path.startsWith('/api/account/'))response=await accountWorker.fetch(request,env,user);
  else if(path==='/health')response=Response.json({ok:true,runtime:'cloudflare-workers',implementation:'full-express-api'});
  else if(/^\/api\/download(?:-|\/|$)/.test(path))response=Response.json({error:'ダウンロード機能は削除されました。',code:'DOWNLOAD_REMOVED'},{status:410});
  else{
   const {publicHandler}=await import('./native-public.mjs');response=await publicHandler.fetch(request,env,ctx);
  }
 }catch(error){console.warn(JSON.stringify({event:'api_proxy_error',name:error.name||'Error',reason:/[\w.$]+ is not a function/.exec(error.message)?.[0]||(/I\/O/.test(error.message)?'request_context':'other'),frames:String(error.stack||'').split('\n').slice(1,3)}));response=Response.json({error:'サーバーとの通信に失敗しました。再試行してください。',code:'API_UPSTREAM_FAILED'},{status:502});}
 const headers=new Headers(response.headers);for(const[k,v]of Object.entries(cors))headers.set(k,v);headers.set('X-XeroxYT-Proxy','cloudflare');return new Response(response.body,{status:response.status,headers});
}
// Monitoring is OFF by default. Cache the setting briefly to avoid a D1 read
// for every video/API request; the switch propagates within a few seconds.
let monitorState={enabled:false,expires:0,pending:null};
async function systemMonitorEnabled(env){
 const now=Date.now();
 if(now<monitorState.expires)return monitorState.enabled;
 if(monitorState.pending)return monitorState.pending;
 monitorState.pending=readSystemMonitor(env)
  .then(enabled=>{
   monitorState.enabled=enabled;
   monitorState.expires=Date.now()+30000;
   return monitorState.enabled;
  })
  .catch(error=>{
   console.warn('system_monitor_state_failed',error instanceof Error?error.message:'unknown');
   monitorState.enabled=false;
   monitorState.expires=Date.now()+30000;
   return false;
  })
  .finally(()=>{monitorState.pending=null;});
 return monitorState.pending;
}
// Store operation-level API metadata only: never URLs, query strings, request bodies, or headers.
function safeOperation(pathname){
 const parts=pathname.split('/').filter(Boolean).slice(0,5);
 return '/'+parts.map((part,index)=>{
  if(index>=3||(index>=2&&(/^[a-zA-Z0-9_-]{11}$/.test(part)||part.length>24)))return ':id';
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(part)?part.toLowerCase():':id';
 }).join('/');
}
async function recordSystemRequest(request,env,route,status,durationMs,user){
 const now=Date.now();
 const duration=Math.max(0,Math.min(60000,durationMs));
 if(env.REALTIME){
  return env.REALTIME.getByName('admin').storeLogs([{id:crypto.randomUUID(),at:now,route,method:request.method,status,duration_ms:duration,user_id:user?.id??null,username:user?.username??null}],true);
 }
 await env.DB.prepare('INSERT INTO system_request_logs(user_id,at,route,method,status,duration_ms) VALUES(?,?,?,?,?,?)')
  .bind(user?.id??null,now,route,request.method,status,duration).run();
 if(Math.random()<0.005)await env.DB.prepare('DELETE FROM system_request_logs WHERE at<?').bind(now-7*86400000).run();
}
const worker={async fetch(request,env,ctx){
 const started=Date.now(),path=new URL(request.url).pathname;
 let response;
 const monitor={user:null};
 try{
  const upstream=await handleRequest(request,env,ctx,monitor);
  response=/^\/(api|internal)(\/|$)|^\/health$/.test(path)?secureApiResponse(upstream):upstream;
  // Only emit account metadata on authenticated API responses; do not add a separate
  // D1 query or request, and never weaken the existing BAN check.
  if(monitor.user?.id&&!monitor.user.banned&&/^\/api\//.test(path)&&request.method!=='OPTIONS'){
   const mode=monitor.user.mode??'off';
   const headers=new Headers(response.headers);
   if(['off','chaos','chaos2','jelly','spin','quake','zero','mirror','burning','cleaning'].includes(mode)){
    headers.set('X-XeroxYT-Account-Id',monitor.user.id);
    headers.set('X-XeroxYT-Account-Mode',mode);
    headers.set('Cache-Control','private, no-store');
    response=new Response(response.body,{status:response.status,statusText:response.statusText,headers});
   }
  }
  return response;
 }finally{
  // Cloudflare waitUntil writes the log without delaying API responses or video streaming.
  if(env.DB&&ctx?.waitUntil&&request.method!=='OPTIONS'&&path!==ticketPath
    &&/^\/(?:api(?:\/|$)|stream\/|360\/|edu\/|scratch-edu\/)/.test(path)
    &&!/^\/api\/account\/(?:telemetry|admin\/(?:logs|system-logs|system-monitor))(?:\/|$)/.test(path)){
   const route=safeOperation(path);
   const task=systemMonitorEnabled(env)
     .then(enabled=>enabled?recordSystemRequest(request,env,route,response?.status||500,Date.now()-started,monitor.user):undefined)
     .catch(error=>console.warn('system_request_log_failed',error instanceof Error?error.message:'unknown'));
   ctx.waitUntil(task);
  }
 }
}};
const gateway = withGasAccess(worker);
export default {
 fetch(request, env, ctx) {
  const bindings = withD1Bindings(env);
  const path=new URL(request.url).pathname;
  if(path===relayPath)return receiveRealtimeRelay(request,bindings);
  if(path===socketPath){
   const denied=authorizeSource(request,{...env,REQUIRE_PROXY_SECRET:'false'});
   if(denied)return denied;
   return upgradeRealtime(request,bindings,currentUserByHash,isMaster).catch(error=>{
    console.warn('realtime_upgrade_failed',error?.name);
    return new Response(null,{status:503});
   });
  }
  return gateway.fetch(request,bindings,ctx);
 },
};
