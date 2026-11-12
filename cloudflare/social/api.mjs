import {randomBytes,createHash} from 'node:crypto';
import {credentialVault} from '../../youtube-account.mjs';
import {privateIdentity} from '../api/private-api.mjs';
import {privateRateLimit} from '../api/private-rate-limit.mjs';
const services=['instagram','tiktok'];
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',...headers}});
export const socialCallback=path=>/^\/api\/(instagram|tiktok)\/oauth\/callback$/.test(path);
const error=(status,code,message)=>Object.assign(new Error(message),{status,code});
function configuration(env,service){const prefix=service.toUpperCase(),key=env[prefix+(service==='tiktok'?'_CLIENT_KEY':'_CLIENT_ID')],secret=env[prefix+'_CLIENT_SECRET'],redirect=env[prefix+'_REDIRECT_URI'];let valid=false;try{valid=new URL(redirect).protocol==='https:'&&new URL(redirect).pathname===`/api/${service}/oauth/callback`;}catch{}return {key,secret,redirect,ready:!!(key&&secret&&valid&&env[prefix+'_APPROVED']==='true')};}
function store(env){const vault=credentialVault(env.API_SHARED_SECRET);return {async read(key){const row=await env.DB.prepare('SELECT data FROM api_oauth_flows WHERE user_id=? AND expires_at>?').bind(key,Date.now()).first();return row?vault.open(JSON.parse(row.data).sealed,key):null;},async write(key,value,expires=Date.now()+90*86400000){await env.DB.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify({sealed:vault.seal(value,key)}),expires).run();},async remove(key){await env.DB.prepare('DELETE FROM api_oauth_flows WHERE user_id=?').bind(key).run();},async consume(key){const row=await env.DB.prepare('DELETE FROM api_oauth_flows WHERE user_id=? AND expires_at>? RETURNING data').bind(key,Date.now()).first();return row?vault.open(JSON.parse(row.data).sealed,key):null;}};}
async function provider(fetcher,url,init={}){const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(12000)});let data;try{data=await response.json();}catch{throw error(502,'PROVIDER_RESPONSE','サービスから正しい応答を取得できませんでした。');}if(!response.ok||data.error?.message||(data.error?.code&&data.error.code!=='ok')||data.error_type)throw error(response.status===401?401:502,'PROVIDER_REJECTED','サービスが取得を許可しませんでした。権限や連携状態を確認してください。');return data;}
const form=body=>({method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
function profile(service,data){if(service==='instagram')return {id:String(data.user_id||data.id||''),username:data.username||'',name:data.name||data.username||'Instagram',avatar:data.profile_picture_url||'',bio:data.biography||'',mediaCount:data.media_count};const user=data.data?.user||data.user||data;return {id:String(user.open_id||''),name:user.display_name||'TikTok',username:user.username||'',avatar:user.avatar_url||'',bio:user.bio_description||'',url:user.profile_deep_link||''};}
function publicUsername(value){try{const url=new URL(value);if(!['tiktok.com','www.tiktok.com'].includes(url.hostname))return '';return url.pathname.match(/^\/@([A-Za-z0-9._]{1,40})\//)?.[1]||'';}catch{return '';}}
async function readProfile(service,token,fetcher){return service==='instagram'?profile(service,await provider(fetcher,'https://graph.instagram.com/me?fields=user_id,username',{headers:{Authorization:'Bearer '+token}})):profile(service,await provider(fetcher,'https://open.tiktokapis.com/v2/user/info/?fields=open_id,avatar_url,display_name',{headers:{Authorization:'Bearer '+token}}));}
export function createSocialApi(fetcher=fetch){return async(request,env)=>{
 const url=new URL(request.url),parts=url.pathname.split('/'),service=parts[2],route=parts.slice(3).join('/');if(!services.includes(service))return json({error:'Not found'},404);
 const config=configuration(env,service),db=store(env),origin=request.headers.get('origin'),allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 try{
 if(route==='oauth/callback'){
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  const state=url.searchParams.get('state');if(!state||!/^[a-f0-9]{64}$/.test(state))throw error(400,'OAUTH_STATE','連携の確認情報が無効です。');
  const flow=await db.consume('social-state:'+state);if(!flow||flow.service!==service||!allowed.includes(flow.origin)||!config.ready)throw error(400,'OAUTH_STATE','連携の確認情報が期限切れです。');
  const redirect=(result)=>new Response(null,{status:303,headers:{Location:flow.origin+'/'+service+'?connection='+result,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  if(url.searchParams.has('error'))return redirect('cancelled');const code=url.searchParams.get('code');if(!code||code.length>4096)return redirect('failed');
  // Check the originating site session still exists before linking this account.
  const session=await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').bind(flow.session,Date.now()).first();if(session?.user_id!==flow.id)return redirect('expired');
  const tokens=service==='tiktok'?await provider(fetcher,'https://open.tiktokapis.com/v2/oauth/token/',form({client_key:config.key,client_secret:config.secret,code,grant_type:'authorization_code',redirect_uri:config.redirect})):await provider(fetcher,'https://api.instagram.com/oauth/access_token',form({client_id:config.key,client_secret:config.secret,code,grant_type:'authorization_code',redirect_uri:config.redirect}));
  if(typeof tokens.access_token!=='string')return redirect('failed');
  const user=await readProfile(service,tokens.access_token,fetcher);if(!user.id)return redirect('failed');
  await db.write(`social-link:${service}:${flow.id}`,{...tokens,expiresAt:Date.now()+(Number(tokens.expires_in)||3600)*1000,user});return redirect('linked');
 }
 if(!origin||!allowed.includes(origin))throw error(403,'ORIGIN_FORBIDDEN','このサイトからの接続は許可されていません。');
 const identity=await privateIdentity(request,env);if(!identity)throw error(401,'SITE_SESSION_REQUIRED','サイトにログインしてください。');
 const limited=await privateRateLimit(env.DB,identity.id,url.pathname,request.method);if(limited)return limited;
 if(Number(request.headers.get('content-length')||0)>32768)throw error(413,'PAYLOAD_TOO_LARGE','送信データが大きすぎます。');
 const key=`social-link:${service}:${identity.id}`,link=await db.read(key);
 if(route==='embed-info'&&request.method==='GET'&&service==='tiktok'){
  let target;try{target=new URL(url.searchParams.get('url'));}catch{throw error(400,'PUBLIC_LINK','公開投稿のURLが無効です。');}
  const match=target.pathname.match(/^\/@([A-Za-z0-9._]{1,40})\/(?:video|photo)\/(\d{10,25})\/?$/);if(target.protocol!=='https:'||target.username||target.password||target.port||!['www.tiktok.com','tiktok.com'].includes(target.hostname)||!match)throw error(400,'PUBLIC_LINK','公開投稿のURLが無効です。');
  const canonical=`https://www.tiktok.com/@${match[1]}/video/${match[2]}`;const result=await provider(fetcher,'https://www.tiktok.com/oembed?url='+encodeURIComponent(canonical));
  return json({title:typeof result.title==='string'?result.title.slice(0,1000):'',author:match[1],thumbnail:typeof result.thumbnail_url==='string'&&result.thumbnail_url.startsWith('https://')?result.thumbnail_url:''});
 }
 if(route==='status'&&request.method==='GET')return json({service,configured:config.ready,connected:!!link,user:link?.user||null,expired:!!link&&link.expiresAt<=Date.now(),capabilities:{ownMedia:config.ready,publicEmbeds:true,homeFeed:false,forYou:false,stories:false,messaging:false,search:false,platformActions:false},notice:service==='instagram'?'公式連携はプロアカウントの自分の投稿が対象です。一般アカウントのホーム・DMは公式サイトで利用できます。':'公式連携は自分のプロフィールと公開投稿が対象です。For You・フォロー中・DMは公式サイトで利用できます。'});
 if(route==='oauth/start'&&request.method==='POST'){
  if(!config.ready)throw error(503,'OAUTH_NOT_CONFIGURED','公式OAuthのキー・コールバックURL・審査設定が必要です。');
  await env.DB.prepare("DELETE FROM api_oauth_flows WHERE user_id LIKE 'social-state:%' AND expires_at<=?").bind(Date.now()).run();
  const state=randomBytes(32).toString('hex');await db.write('social-state:'+state,{service,id:identity.id,session:identity.hash,origin},Date.now()+600000);
  const authorize=new URL(service==='tiktok'?'https://www.tiktok.com/v2/auth/authorize/':'https://www.instagram.com/oauth/authorize');authorize.search=new URLSearchParams({[service==='tiktok'?'client_key':'client_id']:config.key,redirect_uri:config.redirect,response_type:'code',scope:service==='tiktok'?'user.info.basic,video.list':'instagram_business_basic',state}).toString();return json({url:authorize.href});
 }
 if(route==='disconnect'&&request.method==='POST'){
  let providerRevoked=true;try{
  if(link&&service==='tiktok')await provider(fetcher,'https://open.tiktokapis.com/v2/oauth/revoke/',form({client_key:config.key,client_secret:config.secret,token:link.access_token}));
  if(link&&service==='instagram')await provider(fetcher,'https://graph.instagram.com/'+encodeURIComponent(link.user.id)+'/permissions',{method:'DELETE',headers:{Authorization:'Bearer '+link.access_token}});
  }catch{providerRevoked=false;}await db.remove(key);return json({success:true,providerRevoked});
 }
 if(route==='preferences'){
  const prefKey=`social-preferences:${service}:${identity.id}`;if(request.method==='GET')return json(await db.read(prefKey)||{signals:{},crossService:false});
  if(request.method==='PUT'){if(!request.headers.get('content-type')?.startsWith('application/json'))throw error(415,'FORMAT','JSON形式で送信してください。');const text=await request.text();if(text.length>32000)throw error(413,'PAYLOAD_TOO_LARGE','設定が大きすぎます。');let body;try{body=JSON.parse(text);}catch{throw error(400,'FORMAT','設定が無効です。');}const signals=Object.fromEntries(Object.entries(body.signals||{}).slice(0,200).filter(([id,v])=>id.length<=120&&Number.isFinite(v?.weight)&&Number.isFinite(v?.at)).map(([id,v])=>[id,{weight:Math.max(-20,Math.min(20,v.weight)),at:v.at}]));await db.write(prefKey,{signals,crossService:false});return json({success:true});}
 }
 if(route==='media'&&request.method==='GET'){
  if(!link)throw error(401,'SOCIAL_NOT_LINKED','アカウントを連携してください。');let token=link.access_token;
  if(link.expiresAt<Date.now()+60000){
   if(service!=='tiktok'||!link.refresh_token)throw error(401,'SOCIAL_REAUTH_REQUIRED','連携の有効期限が切れました。再連携してください。');
   const tokens=await provider(fetcher,'https://open.tiktokapis.com/v2/oauth/token/',form({client_key:config.key,client_secret:config.secret,refresh_token:link.refresh_token,grant_type:'refresh_token'}));if(!tokens.access_token)throw error(401,'SOCIAL_REAUTH_REQUIRED','再連携が必要です。');const refreshed={...link,...tokens,expiresAt:Date.now()+Number(tokens.expires_in)*1000};await db.write(key,refreshed);token=refreshed.access_token;
  }
  const cursor=url.searchParams.get('cursor')||'';if(cursor.length>2000)throw error(400,'CURSOR','続きの情報が無効です。');
  if(service==='tiktok'){
   if(cursor&&!/^\d{1,16}$/.test(cursor))throw error(400,'CURSOR','続きの情報が無効です。');
   const data=await provider(fetcher,'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,duration,create_time',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({max_count:20,...(cursor?{cursor:Number(cursor)}:{})})});
   return json({items:(data.data?.videos||[]).map(v=>({id:'tt:'+v.id,service,kind:'video',title:v.title||v.video_description,author:publicUsername(v.share_url)||link.user.username||link.user.name,authorId:link.user.id,profileUsername:publicUsername(v.share_url)||link.user.username||'',thumbnail:v.cover_image_url,url:v.share_url,embed:`https://www.tiktok.com/player/v1/${v.id}`,timestamp:v.create_time*1000,duration:v.duration})),cursor:data.data?.has_more?String(data.data.cursor):'',source:'official-own-media'});
  }
  const target=new URL('https://graph.instagram.com/'+encodeURIComponent(link.user.id)+'/media');target.search=new URLSearchParams({fields:'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}',limit:'20',...(cursor?{after:cursor}:{})}).toString();const data=await provider(fetcher,target.href,{headers:{Authorization:'Bearer '+token}});
  return json({items:(data.data||[]).map(v=>({id:'ig:'+v.id,service,title:v.caption||'',author:link.user.username,authorId:link.user.id,profileUsername:link.user.username,kind:v.media_type==='VIDEO'?'video':v.media_type==='CAROUSEL_ALBUM'?'carousel':'image',media:v.media_url,thumbnail:v.thumbnail_url||v.media_url,url:v.permalink,timestamp:Date.parse(v.timestamp),children:v.children?.data?.map(c=>({kind:c.media_type==='VIDEO'?'video':'image',media:c.media_url}))||[]})),cursor:data.paging?.cursors?.after&&data.paging?.next?data.paging.cursors.after:'',source:'official-own-media'});
 }
 return json({error:'この機能は公式サービスで利用してください。',code:'CAPABILITY_UNAVAILABLE'},501);
 }catch(err){console.warn(JSON.stringify({event:'social_api_error',service,operation:route,status:err.status||502,code:err.code||'SOCIAL_UPSTREAM_FAILED'}));return json({error:err.code?err.message:'外部サービスとの通信に失敗しました。時間をおいて再試行してください。',code:err.code||'SOCIAL_UPSTREAM_FAILED'},err.status||502);}
 };}
export const handleSocialApi=createSocialApi();
