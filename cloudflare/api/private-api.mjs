import {privateRateLimit} from './private-rate-limit.mjs';
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import {Innertube,ClientType,Log} from 'youtubei.js/cf-worker';
import {registerYouTubeAccount} from '../../youtube-account.mjs';
const privatePath=path=>/^\/api\/(auth|user)(\/|$)/.test(path);
export {privatePath};
const signature=(value,secret)=>createHmac('sha256',secret).update('cf-private-v1:'+value).digest('base64url');
const cookieHash=request=>{const cookie=/(?:^|;\s*)__Host-xy_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'')?.[1];return cookie?createHash('sha256').update(cookie).digest('hex'):null;};
export async function privateIdentity(request,env){
 const token=/^XYT (.+)$/.exec(request.headers.get('authorization')||'')?.[1];
 let hash=cookieHash(request);
 if(token){try{const [body,mac,...extra]=token.split('.');if(extra.length||!body||!mac||body.length>2048)return null;const expected=Buffer.from(signature(body,env.API_SHARED_SECRET)),provided=Buffer.from(mac);if(expected.length!==provided.length||!timingSafeEqual(expected,provided))return null;const value=JSON.parse(Buffer.from(body,'base64url').toString());if(value.exp<=Date.now()||value.exp>Date.now()+310000||value.origin!==request.headers.get('origin'))return null;hash=value.session;}catch{return null;}}
 if(!hash)return null;
 const row=await env.DB.prepare('SELECT users.id FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').bind(hash,Date.now()).first();
 return row?{id:row.id,hash}:null;
}
export async function issuePrivateTicket(request,env){
 const identity=await privateIdentity(request,env);if(!identity)return Response.json({error:'ログインが必要です。'},{status:401,headers:{'Cache-Control':'no-store'}});
 const limited=await privateRateLimit(env.DB,identity.id,'/api/account/cloudflare-session','GET');if(limited)return limited;
 const expiresAt=Date.now()+300000,body=Buffer.from(JSON.stringify({session:identity.hash,origin:request.headers.get('origin'),exp:expiresAt})).toString('base64url');
 return Response.json({token:body+'.'+signature(body,env.API_SHARED_SECRET),expiresAt,origin:new URL(request.url).origin},{headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
}
export function createPrivateRouter(register=registerYouTubeAccount){
 return async function(request,env){
 const identity=await privateIdentity(request,env);if(!identity)return Response.json({error:'ログインが必要です。',code:'SITE_SESSION_REQUIRED'},{status:401,headers:{'Cache-Control':'private, no-store'}});
 const url=new URL(request.url),routes=[];
 const limited=await privateRateLimit(env.DB,identity.id,url.pathname,request.method);if(limited)return limited;
 const app=Object.fromEntries(['get','post'].map(method=>[method,(path,handler)=>routes.push({method:method.toUpperCase(),parts:path.split('/'),handler})]));
 const store={async get(key){const row=await env.DB.prepare('SELECT data FROM api_oauth_flows WHERE user_id=? AND expires_at>?').bind(key,Date.now()).first();return row?JSON.parse(row.data):undefined;},async set(key,value){await env.DB.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify(value),value.expires).run();},async delete(key){await env.DB.prepare('DELETE FROM api_oauth_flows WHERE user_id=?').bind(key).run();}};
 const createClient=()=>{Log.setLevel(Log.Level.NONE);return Innertube.create({client_type:ClientType.TV,location:'JP',lang:'ja',retrieve_player:false,cache:{get:async()=>undefined,set:async()=>{},remove:async()=>{}}});};
 register(app,{store,secret:env.API_SHARED_SECRET,createClient,createPublicClient:()=>Innertube.create({location:'JP',lang:'ja',retrieve_player:false,cache:{get:async()=>undefined,set:async()=>{},remove:async()=>{}}})});
 const parts=url.pathname.split('/');
 for(const route of routes){if(route.method!==request.method||route.parts.length!==parts.length)continue;const params={};if(!route.parts.every((p,i)=>p.startsWith(':')?(params[p.slice(1)]=decodeURIComponent(parts[i]),true):p===parts[i]))continue;
 let body;if(!['GET','HEAD'].includes(request.method)){const input=await request.text();if(input&&!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'不正な形式です。'},{status:415});if(Buffer.byteLength(input)>131072)return Response.json({error:'データが大きすぎます。'},{status:413});try{body=input?JSON.parse(input):undefined;}catch{return Response.json({error:'不正な形式です。'},{status:400});}}
 let response,status=200;const headers=new Headers({'Cache-Control':'private, no-store'});const res={locals:{siteAccountId:identity.id},headersSent:false,setHeader(k,v){headers.set(k,v);},status(value){status=value;return this;},json(value){this.headersSent=true;response=Response.json(value,{status,headers});return this;}};
 await route.handler({params,query:Object.fromEntries(url.searchParams),body},res);return response||new Response(null,{status:204,headers});
 }
 return Response.json({error:'Not found'},{status:404});
 };
}
export const handlePrivateApi=createPrivateRouter();
