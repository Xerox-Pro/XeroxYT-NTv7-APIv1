import {readShortsSequence} from './youtube-shorts-sequence.mjs';
import {readYouTubeMix} from './youtube-mix.mjs';
import {readYouTubeProfile} from './youtube-profile.mjs';
import {readYouTubeFeed} from './youtube-feed.mjs';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {collectShorts} from './shorts.mjs';
const publicMessages=new Set(["Googleアカウントを連携してください。", "Google認証コードを取得できませんでした。", "YouTubeからショートの開始動画を取得できませんでした。再試行してください。", "YouTubeから次のショートを取得できませんでした。再試行してください。", "YouTubeが一覧の取得を拒否しました。", "YouTubeのショート取得に失敗しました。再試行してください。", "YouTubeの認証確認に一時的に失敗しました。連携は保持しています。再試行してください。", "YouTubeの連携状態が変わりました。開き直してください。", "YouTube連携が無効になりました。再連携してください。", "YouTube連携のサーバー設定が不足しています。", "このミックスリストを読み込めませんでした。時間をおいて再試行してください。", "コメントが無効です。", "ショートの続きの情報が無効です。開き直してください。", "ショート動画IDが無効です。", "チャンネルIDが無効です。", "ミックスリストIDが無効です。", "ミックスリストに再生できる動画がありません。", "ミックスリストの続きの情報が無効です。", "ログインが必要です。", "不明なフィードです。", "再生リストIDが無効です。", "再生リスト名が無効です。", "動画IDが無効です。", "動画一覧が無効です。", "未対応の操作です。", "続きの情報が無効です。", "続きの情報が無効です。ページを開き直してください。", "認証コードが期限切れです。もう一度連携してください。", "連携状態が変わりました。"]);
export function youtubePublicError(error){
 const known=publicMessages.has(error?.message);
 const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:502;
 const code=known&&['YOUTUBE_NOT_LINKED','YOUTUBE_REAUTH_REQUIRED','YOUTUBE_AUTH_TEMPORARY','YOUTUBE_FEED_REJECTED','YOUTUBE_SHORTS_SEED_UNAVAILABLE','YOUTUBE_SHORTS_SEQUENCE_REJECTED','YOUTUBE_SHORTS_SEQUENCE_EMPTY'].includes(error?.code)?error.code:'YOUTUBE_REQUEST_FAILED';
 return {status,error:known?error.message:'YouTubeとの通信に失敗しました。時間をおいて再試行してください。',code};
}
const lifetime=90*86400000;
export function credentialVault(secret){
 if(!secret||secret.length<16)throw new Error('YouTube連携のサーバー設定が不足しています。');
 const key=createHash('sha256').update('xerox-youtube-link-v1\0'+secret).digest();
 return {seal(value,user){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(user));const data=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value),'utf8')),cipher.final()]);return {iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')};},open(value,user){const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));cipher.setAAD(Buffer.from(user));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString());}};
}
const text=value=>typeof value==='string'?value:value?.text||value?.toString?.()||'';
export function registerYouTubeAccount(app,{store,secret,createClient,createPublicClient,formatVideo,formatChannel,Search,ContinuationItem,Feed,fetcher=fetch}){
 let vault;const getVault=()=>vault||(vault=credentialVault(secret));
 const read=async id=>{const row=await store.get('youtube:'+id);return row&&row.expires>Date.now()?getVault().open(row.flow,id):null;};
 const save=async(id,value)=>store.set('youtube:'+id,{flow:getVault().seal(value,id),expires:Date.now()+lifetime});
 const run=async(id,work)=>{
  const session=await read(id);if(!session)throw Object.assign(new Error('Googleアカウントを連携してください。'),{status:401,code:'YOUTUBE_NOT_LINKED'});
  const yt=await createClient();let saved=JSON.stringify(session.credentials);
  const persist=async()=>{const credentials=yt.session.oauth.oauth2_tokens;if(!credentials||JSON.stringify(credentials)===saved)return;const current=await read(id);if(current?.credentials?.refresh_token!==session.credentials.refresh_token)throw Object.assign(new Error('YouTubeの連携状態が変わりました。開き直してください。'),{status:409});await save(id,{...session,credentials});saved=JSON.stringify(credentials);};
  try{await yt.session.signIn(session.credentials);}catch(error){const permanent=/Invalid tokens provided|Failed to refresh access token: (400|401)\b/.test(error.message||'');throw Object.assign(new Error(permanent?'YouTube連携が無効になりました。再連携してください。':'YouTubeの認証確認に一時的に失敗しました。連携は保持しています。再試行してください。'),{status:permanent?401:503,code:permanent?'YOUTUBE_REAUTH_REQUIRED':'YOUTUBE_AUTH_TEMPORARY'});}
  await persist();try{return await work(yt,{...session,siteId:id});}finally{await persist();}
 };
 const sendError=(res,error)=>{
  const safe=youtubePublicError(error);
  console.warn(JSON.stringify({event:'youtube_account_error',code:safe.code,status:safe.status}));
  return res.status(safe.status).json({error:safe.error,code:safe.code});
 };
 const route=(method,path,work)=>app[method](path,async(req,res)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');try{if(typeof res.locals.siteAccountId!=='string'||!res.locals.siteAccountId)throw Object.assign(new Error('ログインが必要です。'),{status:401});const result=await work(req,res,res.locals.siteAccountId);if(!res.headersSent)res.json(result);}catch(error){sendError(res,error);}});
 const google=async(path,body)=>{const response=await fetcher('https://oauth2.googleapis.com/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json();return {ok:response.ok,data};};
 route('get','/api/auth/status',async(req,res,id)=>{const link=await read(id);return {connected:!!link,user:link?.user||null,client:'TV',limitations:'Google OAuthはTVクライアントに対応しています。YouTube側の対応状況によって利用できない機能があります。'};});
 route('post','/api/auth/signin',async(req,res,id)=>{
  getVault();const existing=await store.get('youtube-flow:'+id);if(existing&&existing.expires>Date.now()){const previous=getVault().open(existing.flow,id);if(previous.userCode&&previous.verificationUrl)return {userCode:previous.userCode,verificationUrl:previous.verificationUrl,expiresAt:existing.expires,interval:previous.interval};}
  const yt=await createClient();const client=await yt.session.oauth.getClientID();if(!client?.client_id||!client?.client_secret)throw new Error('OAuth client unavailable');
  const {ok,data}=await google('device/code',{client_id:client.client_id,scope:'http://gdata.youtube.com',device_id:randomUUID(),device_model:'ytlr::'});if(!ok||!data.device_code)throw new Error('Google認証コードを取得できませんでした。');
  const verification=new URL(data.verification_url||data.verification_uri);if(verification.protocol!=='https:'||!['www.google.com','google.com','accounts.google.com','youtube.com','www.youtube.com'].includes(verification.hostname))throw new Error('Invalid verification URL');
  const expires=Date.now()+Math.min(1800,Math.max(30,Number(data.expires_in)||1800))*1000;const interval=Math.max(5,Number(data.interval)||5);
  await store.set('youtube-flow:'+id,{flow:getVault().seal({device_code:data.device_code,userCode:data.user_code,verificationUrl:verification.href,client,interval,next:Date.now()+interval*1000},id),expires});
  return {userCode:data.user_code,verificationUrl:verification.href,expiresAt:expires,interval};
 });
 route('get','/api/auth/poll',async(req,res,id)=>{
  const key='youtube-flow:'+id,row=await store.get(key);if(!row||row.expires<Date.now()){await store.delete(key);throw Object.assign(new Error('認証コードが期限切れです。もう一度連携してください。'),{status:400});}
  const flow=getVault().open(row.flow,id);if(Date.now()<flow.next)return {status:'pending',interval:Math.ceil((flow.next-Date.now())/1000)};
  // Reserve the next poll before requesting Google; reloads cannot flood the token endpoint.
  flow.next=Date.now()+flow.interval*1000;await store.set(key,{...row,flow:getVault().seal(flow,id)});
  const {ok,data}=await google('token',{client_id:flow.client.client_id,client_secret:flow.client.client_secret,code:flow.device_code,grant_type:'http://oauth.net/grant_type/device/1.0'});
  if(!ok||data.error){if(['authorization_pending','slow_down'].includes(data.error)){if(data.error==='slow_down'){flow.interval+=5;flow.next=Date.now()+flow.interval*1000;await store.set(key,{...row,flow:getVault().seal(flow,id)});}return {status:'pending',interval:flow.interval};}await store.delete(key);return {status:'error',error:data.error==='access_denied'?'Googleでの認証がキャンセルされました。':'Google認証が失敗または期限切れになりました。'};}
  if(!data.access_token||!data.refresh_token)throw new Error('Incomplete Google credentials');
  const credentials={access_token:data.access_token,refresh_token:data.refresh_token,expiry_date:new Date(Date.now()+data.expires_in*1000).toISOString(),client:flow.client};
  const yt=await createClient();await yt.session.signIn(credentials);let user={name:'YouTube アカウント',email:'',picture:''};try{user=await readYouTubeProfile(yt,createPublicClient);}catch{}
  const active=await store.get(key);if(!active||getVault().open(active.flow,id).device_code!==flow.device_code)return {status:'error',error:'この連携操作はキャンセルされました。'};
  await save(id,{credentials:yt.session.oauth.oauth2_tokens||credentials,user});await store.delete(key);return {success:true,status:'connected',user};
 });
 route('post','/api/auth/cancel',async(req,res,id)=>{await store.delete('youtube-flow:'+id);return {success:true};});
 route('post','/api/auth/logout',async(req,res,id)=>{await store.delete('youtube:'+id);await store.delete('youtube-flow:'+id);return {success:true};});
 route('get','/api/user/feed/:kind',async(req,res,id)=>run(id,async yt=>{
  const kind=req.params.kind,result=await readYouTubeFeed(yt,kind,String(req.query.continuation||''));
  return {...result,videos:kind==='shorts'?result.videos.filter(v=>v.isShort):kind==='home'?[...result.videos,...result.playlists]:result.videos,...(kind==='shorts'?{sourceDescription:'GoogleアカウントのホームにあるShorts'}:{})};
 }));
 route('get','/api/user/shorts-sequence',async(req,res,id)=>run(id,yt=>readShortsSequence(yt,String(req.query.videoId||''),String(req.query.continuation||''))));
 route('get','/api/user/mix/:id',async(req,res,id)=>run(id,yt=>readYouTubeMix(yt,req.params.id,String(req.query.videoId||''),String(req.query.continuation||''))));
 route('get','/api/user/playlist/:id',async(req,res,id)=>run(id,async yt=>{
  if(!/^[\w-]{2,150}$/.test(req.params.id))throw Object.assign(new Error('再生リストIDが無効です。'),{status:400});
  const result=await readYouTubeFeed(yt,'playlist:'+req.params.id,String(req.query.continuation||''));return {...result,id:req.params.id,title:'YouTubeの再生リスト'};
 }));
 const reads={history:async yt=>(await readYouTubeFeed(yt,'history')).videos,'liked-videos':async yt=>(await readYouTubeFeed(yt,'liked')).videos,'watch-later':async yt=>(await readYouTubeFeed(yt,'watch-later')).videos,playlists:async yt=>(await readYouTubeFeed(yt,'playlists')).playlists,subscriptions:async yt=>(await readYouTubeFeed(yt,'channels')).channels,'channel-info':async(yt,session)=>{const user=await readYouTubeProfile(yt,createPublicClient);const current=await read(session.siteId);if(current?.credentials?.refresh_token!==session.credentials.refresh_token)throw Object.assign(new Error('連携状態が変わりました。'),{status:409});await save(session.siteId,{credentials:yt.session.oauth.oauth2_tokens||session.credentials,user});return user;},'notifications/unread-count':async yt=>({count:await yt.getUnseenNotificationsCount()}),notifications:async yt=>(await yt.getNotifications()).contents.map(n=>({id:n.notification_id,message:text(n.short_message),sentTime:text(n.sent_time),read:!!n.read,avatar:n.thumbnails?.[0]?.url||'',thumbnail:n.video_thumbnails?.[0]?.url||'',videoId:n.endpoint?.payload?.videoId||''}))};
 for(const [path,work]of Object.entries(reads))route('get','/api/user/'+path,async(req,res,id)=>run(id,work));
 route('post','/api/user/action',async(req,res,id)=>{
  const {action,videoId,channelId,text:comment,playlistId,title,videoIds}=req.body||{};
  const video=()=>{if(!/^[\w-]{11}$/.test(videoId||''))throw Object.assign(new Error('動画IDが無効です。'),{status:400});return videoId;};
  const channel=()=>{if(!/^UC[\w-]{22}$/.test(channelId||''))throw Object.assign(new Error('チャンネルIDが無効です。'),{status:400});return channelId;};
  const playlist=()=>{if(!/^[\w-]{2,150}$/.test(playlistId||''))throw Object.assign(new Error('再生リストIDが無効です。'),{status:400});return playlistId;};
  const ids=()=>{if(!Array.isArray(videoIds)||videoIds.length>100||videoIds.some(v=>!/^[\w-]{11}$/.test(v)))throw Object.assign(new Error('動画一覧が無効です。'),{status:400});return videoIds;};
  const actions={recordHistory:async yt=>{const info=await yt.getBasicInfo(video());return info.addToWatchHistory();},like:yt=>yt.actions.execute('/like/like',{target:{videoId:video()},client:'TV'}),dislike:yt=>yt.actions.execute('/like/dislike',{target:{videoId:video()},client:'TV'}),removeRating:yt=>yt.actions.execute('/like/removelike',{target:{videoId:video()},client:'TV'}),subscribe:yt=>yt.actions.execute('/subscription/subscribe',{channelIds:[channel()],params:'EgIIAhgA',client:'TV'}),unsubscribe:yt=>yt.actions.execute('/subscription/unsubscribe',{channelIds:[channel()],params:'CgIIAhgA',client:'TV'}),comment:yt=>{if(typeof comment!=='string'||!comment.trim()||comment.length>10000)throw Object.assign(new Error('コメントが無効です。'),{status:400});return yt.interact.comment(video(),comment.trim());},watchLater:yt=>yt.playlist.addVideos('WL',[video()]),playlistAdd:yt=>yt.playlist.addVideos(playlist(),ids()),playlistRemove:yt=>yt.playlist.removeVideos(playlist(),ids()),playlistCreate:yt=>{if(typeof title!=='string'||!title.trim()||title.length>150)throw Object.assign(new Error('再生リスト名が無効です。'),{status:400});return yt.playlist.create(title,ids());}};
  if(!Object.hasOwn(actions,action))throw Object.assign(new Error('未対応の操作です。'),{status:400});
  return run(id,async yt=>{const result=await actions[action](yt);if(result?.success===false||result?.ok===false||result?.data?.error)throw new Error('YouTube operation rejected');return {success:true,playlistId:result?.playlist_id};});
 });
 return {run,read};
}
