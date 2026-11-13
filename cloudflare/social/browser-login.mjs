import {sessionCookies,probeSession,privateProfile,fail} from './unofficial.mjs';
const LOGIN_URLS={instagram:'https://www.instagram.com/accounts/login/',tiktok:'https://www.tiktok.com/login'};
export function cdpCommand(socket,method,params={}){return new Promise((resolve,reject)=>{const id=1;const done=()=>{clearTimeout(timer);socket.removeEventListener('message',receive);socket.removeEventListener('close',closed);};const closed=()=>{done();reject(fail('LOGIN_BROWSER_CLOSED','ログイン画面が閉じられました。もう一度開始してください。',409));};const receive=event=>{let data;try{data=JSON.parse(event.data);}catch{return;}if(data.id!==id)return;done();if(data.error)reject(fail('LOGIN_BROWSER_FAILED','ログイン画面との通信に失敗しました。',502));else resolve(data.result);};const timer=setTimeout(()=>{done();reject(fail('LOGIN_BROWSER_TIMEOUT','ログイン画面の応答がありません。',504));},10000);socket.addEventListener('message',receive);socket.addEventListener('close',closed);try{socket.send(JSON.stringify({id,method,params}));}catch{closed();}});}
async function command(binding,flow,method,params){const connection=await binding.connectSession(flow.sessionId,{targetId:flow.targetId});const response=await connection.webSocket.fetch('https://browser-binding.invalid',{headers:{Upgrade:'websocket'}});const socket=response.webSocket;if(!socket)throw fail('LOGIN_BROWSER_FAILED','ブラウザに接続できません。',502);socket.accept();try{return await cdpCommand(socket,method,params);}finally{socket.close();}}
function safeView(value){const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='live.browser.run')throw fail('LOGIN_VIEW_INVALID','ログイン画面の接続先が無効です。',502);return url.href;}
export async function browserLogin({route,service,request,env,db,identity,fetcher}){
 if(!env.BROWSER)throw fail('LOGIN_NOT_CONFIGURED','ログイン用ブラウザが未設定です。',503);
 const key=`social-browser-login:${service}:${identity.id}`,privateKey=`social-private:${service}:${identity.id}`;
 const old=await db.read(key);
 const close=async flow=>{if(flow)try{await env.BROWSER.closeSession(flow.sessionId);}catch{}};
 if(route==='login/cancel'){await db.remove(key);await close(old);return {success:true};}
 if(route==='login/start'){
  const body=await request.json();if(body.consent!==true)throw fail('CONSENT','サーバー上のログイン画面の利用に同意してください。',400);
  let flow=old;if(!flow){let session;try{session=await env.BROWSER.acquire({keepAlive:600000,recording:false});const target=await env.BROWSER.devtools.newTarget(session.sessionId,LOGIN_URLS[service]);flow={sessionId:session.sessionId,targetId:target.id,expiresAt:Date.now()+600000};await db.write(key,flow,flow.expiresAt);}catch{await close(session);throw fail('LOGIN_BROWSER_UNAVAILABLE','ログイン用ブラウザを開始できませんでした。利用上限またはブラウザの設定を確認してください。',503);}}
  if(flow.expiresAt<=Date.now())throw fail('LOGIN_EXPIRED','ログイン画面の期限が切れました。閉じてから再度開始してください。',409);
  const view=await env.BROWSER.getLiveView(flow.sessionId,{targetId:flow.targetId,mode:'tab',expiresInMs:60000});return {url:safeView(view.devtoolsFrontendUrl),expiresAt:flow.expiresAt};
 }
 if(route!=='login/finish')throw fail('LOGIN_ROUTE','未対応の操作です。',404);
 if(!old||old.expiresAt<=Date.now())throw fail('LOGIN_EXPIRED','ログイン画面の期限が切れました。もう一度開始してください。',409);
 const result=await command(env.BROWSER,old,'Network.getCookies',{urls:service==='instagram'?['https://www.instagram.com/']:['https://www.tiktok.com/']});
 let cookies;try{cookies=sessionCookies(result.cookies,service);}catch{throw fail('LOGIN_INCOMPLETE','まだログインが完了していません。ログイン画面で本人確認を完了してください。',409);}
 const agent=await command(env.BROWSER,old,'Runtime.evaluate',{expression:'navigator.userAgent',returnByValue:true});
 const candidate={cookies,userAgent:String(agent.result?.value||'').slice(0,300),deviceId:cookies.tt_webid_v2||cookies.tt_webid||'',region:'JP',uuid:crypto.randomUUID()};
 let verified;try{verified=await probeSession(service,candidate,fetcher);}catch(error){if(error.code!=='SESSION_UNSUPPORTED')throw error;verified={user:await privateProfile(service,candidate,fetcher),capabilities:{homeFeed:false,forYou:false,following:false,stories:false,messaging:false,search:false,likes:false,comments:false,notes:false}};}
 const current=await db.consume(key);if(current?.sessionId!==old.sessionId)throw fail('LOGIN_CANCELLED','このログイン操作は取り消されました。',409);
 try{await db.write(privateKey,{...candidate,...verified,connectedAt:Date.now()},Date.now()+30*86400000);}finally{await close(old);}
 return {connected:true,user:verified.user,capabilities:verified.capabilities};
}
