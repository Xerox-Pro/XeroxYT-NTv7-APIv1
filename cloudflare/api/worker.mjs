import {secureApiResponse} from '../security/http.mjs';
import {handleSocialApi,socialCallback} from '../social/api.mjs';
import {privatePath,handlePrivateApi,issuePrivateTicket} from './private-api.mjs';
import {authorizeSource} from '../../access-policy.mjs';
import accountWorker from '../auth/worker.mjs';
import {handleYouTubeStore} from '../../youtube-store-bridge.mjs';
import {withGasAccess} from './gas-access.mjs';
async function handleRequest(request,env,ctx){
 const pathName=new URL(request.url).pathname;
 if(socialCallback(pathName))return handleSocialApi(request,env);
 const direct=(privatePath(pathName)||/^\/api\/(instagram|tiktok)(\/|$)/.test(pathName))&&/^XYT /.test(request.headers.get('Authorization')||'');
 const publicSocial=/^\/api\/(instagram|tiktok)\/public\/(feed|search|resolve|stories)$/.test(pathName)&&request.method==='GET';
 const rejected=authorizeSource(request,publicSocial||direct||request.method==='OPTIONS'?{...env,REQUIRE_PROXY_SECRET:'false'}:env);if(rejected)return rejected;
 const url=new URL(request.url),path=url.pathname;
 const origin=request.headers.get('Origin'),allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 const cors=origin&&allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type,Authorization,Range,X-Client-Id,X-Usage-Token,X-Client-Usage','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Access-Control-Max-Age':'600','Access-Control-Expose-Headers':'X-Daily-Usage-Token,Retry-After','Vary':'Origin'}:{};
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 let response;
 try{
  if(path==='/internal/youtube-store'){const denied=authorizeSource(request,{...env,REQUIRE_PROXY_SECRET:'true'});if(denied)return denied;return await handleYouTubeStore(request,env.DB);}
  if(path==='/api/account/cloudflare-session'&&request.method==='GET')response=await issuePrivateTicket(request,env);
  else if(/^\/api\/(instagram|tiktok)(\/|$)/.test(path))response=await handleSocialApi(request,env);
  else if(privatePath(path))response=await handlePrivateApi(request,env);
  else if(path.startsWith('/api/account/'))response=await accountWorker.fetch(request,env);
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
async function systemMonitorEnabled(db){
 const now=Date.now();
 if(now<monitorState.expires)return monitorState.enabled;
 if(monitorState.pending)return monitorState.pending;
 monitorState.pending=db.prepare('SELECT enabled FROM system_monitor_settings WHERE id=1').first()
  .then(row=>{
   monitorState.enabled=row?.enabled===1;
   monitorState.expires=Date.now()+3000;
   return monitorState.enabled;
  })
  .catch(error=>{
   console.warn('system_monitor_state_failed',error instanceof Error?error.message:'unknown');
   monitorState.enabled=false;
   monitorState.expires=Date.now()+3000;
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
async function recordSystemRequest(request,env,route,status,durationMs){
 let userId=null;
 const token=/(?:^|;\s*)__Host-xy_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1];
 if(token){
  try{
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
   const tokenHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
   const session=await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').bind(tokenHash,Date.now()).first();
   userId=session?.user_id||null;
  }catch(error){console.warn('system_log_session_lookup_failed',error instanceof Error?error.message:'unknown');}
 }
 const now=Date.now();
 await env.DB.prepare('INSERT INTO system_request_logs(user_id,at,route,method,status,duration_ms) VALUES(?,?,?,?,?,?)')
  .bind(userId,now,route,request.method,status,Math.max(0,Math.min(60000,durationMs))).run();
 if(Math.random()<0.005){
  try{await env.DB.prepare('DELETE FROM system_request_logs WHERE at<?').bind(now-7*86400000).run();}
  catch(error){console.warn('system_log_cleanup_failed',error instanceof Error?error.message:'unknown');}
 }
}
const worker={async fetch(request,env,ctx){
 const started=Date.now(),path=new URL(request.url).pathname;
 let response;
 try{
  const upstream=await handleRequest(request,env,ctx);
  response=/^\/(api|internal)(\/|$)|^\/health$/.test(path)?secureApiResponse(upstream):upstream;
  return response;
 }finally{
  // Cloudflare waitUntil writes the log without delaying API responses or video streaming.
  if(env.DB&&ctx?.waitUntil&&request.method!=='OPTIONS'
    &&/^\/(?:api(?:\/|$)|stream\/|360\/|edu\/|scratch-edu\/)/.test(path)
    &&!/^\/api\/account\/(?:telemetry|admin\/(?:logs|system-logs|system-monitor))(?:\/|$)/.test(path)){
   const route=safeOperation(path);
   const task=systemMonitorEnabled(env.DB)
     .then(enabled=>enabled?recordSystemRequest(request,env,route,response?.status||500,Date.now()-started):undefined)
     .catch(error=>console.warn('system_request_log_failed',error instanceof Error?error.message:'unknown'));
   ctx.waitUntil(task);
  }
 }
}};
export default withGasAccess(worker);
