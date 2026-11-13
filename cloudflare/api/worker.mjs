import {secureApiResponse} from '../security/http.mjs';
import {handleSocialApi,socialCallback} from '../social/api.mjs';
import {privatePath,handlePrivateApi,issuePrivateTicket} from './private-api.mjs';
import {authorizeSource} from '../../access-policy.mjs';
import accountWorker from '../auth/worker.mjs';
import {handleYouTubeStore} from '../../youtube-store-bridge.mjs';
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
export default {async fetch(request,env,ctx){const response=await handleRequest(request,env,ctx);return /^\/(api|internal)(\/|$)|^\/health$/.test(new URL(request.url).pathname)?secureApiResponse(response):response;}};
