import {privatePath,handlePrivateApi,issuePrivateTicket} from './private-api.mjs';
import {authorizeSource} from '../../access-policy.mjs';
import accountWorker from '../auth/worker.mjs';
import {handleYouTubeStore} from '../../youtube-store-bridge.mjs';
export default {async fetch(request,env){
 const pathName=new URL(request.url).pathname;
 const direct=privatePath(pathName)&&/^XYT /.test(request.headers.get('Authorization')||'');
 const rejected=authorizeSource(request,direct||request.method==='OPTIONS'?{...env,REQUIRE_PROXY_SECRET:'false'}:env);if(rejected)return rejected;
 const url=new URL(request.url),path=url.pathname;
 const origin=request.headers.get('Origin'),allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 const cors=origin&&allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type,Authorization,Range,X-Client-Id,X-Usage-Token,X-Client-Usage','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS','Access-Control-Expose-Headers':'X-Daily-Usage-Token','Vary':'Origin'}:{};
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 let response;
 try{
  if(path==='/internal/youtube-store'){const denied=authorizeSource(request,{...env,REQUIRE_PROXY_SECRET:'true'});if(denied)return denied;return await handleYouTubeStore(request,env.DB);}
  if(path==='/api/account/cloudflare-session'&&request.method==='GET')response=await issuePrivateTicket(request,env);
  else if(privatePath(path))response=await handlePrivateApi(request,env);
  else if(path.startsWith('/api/account/'))response=await accountWorker.fetch(request,env);
  else if(path==='/health')response=Response.json({ok:true,runtime:'cloudflare-proxy',implementation:'node-youtube-d1-accounts'});
  else if(/^\/api\/download(?:-|\/|$)/.test(path))response=Response.json({error:'ダウンロード機能は削除されました。',code:'DOWNLOAD_REMOVED'},{status:410});
  else{
   // Keep Cloudflare as the entry proxy. YouTube parsing runs on Node rather
   // than exhausting the Worker's CPU limit; stream all response bodies.
   const upstream=new URL('https://xeroxyt-ntv6-apiv1.vercel.app');upstream.pathname=path;upstream.search=url.search;
   response=await fetch(new Request(upstream,request),{redirect:'manual'});
   if(response.status>=300&&response.status<400){await response.body?.cancel();response=Response.json({error:'API接続先が予期しない応答を返しました。',code:'UPSTREAM_REDIRECT'},{status:502});}
  }
 }catch(error){console.warn(JSON.stringify({event:'api_proxy_error',name:error.name||'Error'}));response=Response.json({error:'サーバーとの通信に失敗しました。再試行してください。',code:'API_UPSTREAM_FAILED'},{status:502});}
 const headers=new Headers(response.headers);for(const[k,v]of Object.entries(cors))headers.set(k,v);headers.set('X-XeroxYT-Proxy','cloudflare');return new Response(response.body,{status:response.status,headers});
}};
