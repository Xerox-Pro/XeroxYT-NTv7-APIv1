import {sessionCookies,probeSession,privateProfile,fail} from './unofficial.mjs';
const LOGIN_URLS={instagram:'https://www.instagram.com/accounts/login/',tiktok:'https://www.tiktok.com/login'};
export function cdpCommand(socket,method,params={}){return new Promise((resolve,reject)=>{const id=1;const done=()=>{clearTimeout(timer);socket.removeEventListener('message',receive);socket.removeEventListener('close',closed);};const closed=()=>{done();reject(fail('LOGIN_BROWSER_CLOSED','ログイン画面が閉じられました。もう一度開始してください。',409));};const receive=event=>{let data;try{data=JSON.parse(event.data);}catch{return;}if(data.id!==id)return;done();if(data.error)reject(fail('LOGIN_BROWSER_FAILED','ログイン画面との通信に失敗しました。',502));else resolve(data.result);};const timer=setTimeout(()=>{done();reject(fail('LOGIN_BROWSER_TIMEOUT','ログイン画面の応答がありません。',504));},10000);socket.addEventListener('message',receive);socket.addEventListener('close',closed);try{socket.send(JSON.stringify({id,method,params}));}catch{closed();}});}
async function vercelBrowser(env,body){
 const response=await fetch('https://xeroxapp044.vercel.app/api/social-browser',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.API_SHARED_SECRET},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw fail('LOGIN_BROWSER_UNAVAILABLE','Vercelのログイン用ブラウザに接続できません。',503);
 return response.json();
}
async function command(env,flow,method,params){if(flow.provider==='vercel')return vercelBrowser(env,{operation:'command',sessionId:flow.sessionId,method,params});const binding=env.BROWSER;const connection=await binding.connectSession(flow.sessionId,{targetId:flow.targetId});const response=await connection.webSocket.fetch('https://browser-binding.invalid',{headers:{Upgrade:'websocket'}});const socket=response.webSocket;if(!socket)throw fail('LOGIN_BROWSER_FAILED','ブラウザに接続できません。',502);socket.accept();try{return await cdpCommand(socket,method,params);}finally{socket.close();}}
export async function browserLogin({route,service,request,env,db,identity,fetcher}){
 if(!env.BROWSER&&env.SOCIAL_BROWSER_PROVIDER!=='vercel')throw fail('LOGIN_NOT_CONFIGURED','ログイン用ブラウザが未設定です。',503);
 const key=`social-browser-login:${service}:${identity.id}`,privateKey=`social-private:${service}:${identity.id}`;
 const old=await db.read(key);
 const close=async flow=>{if(flow)try{if(flow.provider==='vercel')await vercelBrowser(env,{operation:'close',sessionId:flow.sessionId});else await env.BROWSER.closeSession(flow.sessionId);}catch{}};
 if(route==='login/cancel'){await db.remove(key);await close(old);return {success:true};}
 if(route==='login/start'){
  const body=await request.json();if(body.consent!==true)throw fail('CONSENT','サーバー上のログイン画面の利用に同意してください。',400);
  let flow=old;if(!flow){let session;try{if(env.SOCIAL_BROWSER_PROVIDER==='vercel'){session=await vercelBrowser(env,{operation:'create',service});flow={...session,provider:'vercel',expiresAt:Date.now()+600000};}else{session=await env.BROWSER.acquire({keepAlive:600000,recording:false});const target=await env.BROWSER.devtools.newTarget(session.sessionId,LOGIN_URLS[service]);flow={sessionId:session.sessionId,targetId:target.id,expiresAt:Date.now()+600000};}await db.write(key,flow,flow.expiresAt);}catch{await close(session);throw fail('LOGIN_BROWSER_UNAVAILABLE','ログイン用ブラウザを開始できませんでした。利用上限またはブラウザの設定を確認してください。',503);}}
  if(flow.expiresAt<=Date.now())throw fail('LOGIN_EXPIRED','ログイン画面の期限が切れました。閉じてから再度開始してください。',409);
  await command(env,flow,'Emulation.setDeviceMetricsOverride',{width:390,height:780,deviceScaleFactor:1,mobile:false});return {ready:true,expiresAt:flow.expiresAt};
 }
 if(!['login/finish','login/view','login/input'].includes(route))throw fail('LOGIN_ROUTE','未対応の操作です。',404);
 if(!old||old.expiresAt<=Date.now())throw fail('LOGIN_EXPIRED','ログイン画面の期限が切れました。もう一度開始してください。',409);
 if(route==='login/input'){
  const body=await request.json();
  if(body.action==='click'){
   if(!Number.isFinite(body.x)||!Number.isFinite(body.y)||body.x<0||body.x>390||body.y<0||body.y>780)throw fail('LOGIN_INPUT','画面の座標が無効です。',400);
   await command(env,old,'Input.dispatchMouseEvent',{type:'mousePressed',x:body.x,y:body.y,button:'left',clickCount:1});
   await command(env,old,'Input.dispatchMouseEvent',{type:'mouseReleased',x:body.x,y:body.y,button:'left',clickCount:1});
  }else if(body.action==='text'){
   if(typeof body.text!=='string'||!body.text||body.text.length>500)throw fail('LOGIN_INPUT','入力文字数が無効です。',400);
   await command(env,old,'Input.insertText',{text:body.text});
  }else if(body.action==='key'){
   const keys={Tab:9,Enter:13,Backspace:8,Escape:27};if(!Object.hasOwn(keys,body.key))throw fail('LOGIN_INPUT','未対応のキーです。',400);
   await command(env,old,'Input.dispatchKeyEvent',{type:'keyDown',key:body.key,windowsVirtualKeyCode:keys[body.key]});
   await command(env,old,'Input.dispatchKeyEvent',{type:'keyUp',key:body.key,windowsVirtualKeyCode:keys[body.key]});
  }else if(body.action==='scroll'){
   if(![-500,500].includes(body.delta))throw fail('LOGIN_INPUT','スクロールが無効です。',400);
   await command(env,old,'Input.dispatchMouseEvent',{type:'mouseWheel',x:195,y:390,deltaX:0,deltaY:body.delta});
  }else throw fail('LOGIN_INPUT','未対応の操作です。',400);
  return {success:true};
 }
 if(route==='login/view'){
  const frame=await command(env,old,'Page.captureScreenshot',{format:'jpeg',quality:65,captureBeyondViewport:false});
  if(typeof frame.data!=='string'||frame.data.length>2000000)throw fail('LOGIN_FRAME','画面を取得できません。',502);
  return {image:frame.data,width:390,height:780};
 }
 const result=await command(env,old,'Network.getCookies',{urls:service==='instagram'?['https://www.instagram.com/']:['https://www.tiktok.com/']});
 let cookies;try{cookies=sessionCookies(result.cookies,service);}catch{throw fail('LOGIN_INCOMPLETE','まだログインが完了していません。ログイン画面で本人確認を完了してください。',409);}
 const agent=await command(env,old,'Runtime.evaluate',{expression:'navigator.userAgent',returnByValue:true});
 const candidate={cookies,userAgent:String(agent.result?.value||'').slice(0,300),deviceId:cookies.tt_webid_v2||cookies.tt_webid||'',region:'JP',uuid:crypto.randomUUID()};
 let verified;try{verified=await probeSession(service,candidate,fetcher);}catch(error){if(error.code!=='SESSION_UNSUPPORTED')throw error;verified={user:await privateProfile(service,candidate,fetcher),capabilities:{homeFeed:false,forYou:false,following:false,stories:false,messaging:false,search:false,likes:false,comments:false,notes:false}};}
 const current=await db.consume(key);if(current?.sessionId!==old.sessionId)throw fail('LOGIN_CANCELLED','このログイン操作は取り消されました。',409);
 try{await db.write(privateKey,{...candidate,...verified,connectedAt:Date.now()},Date.now()+30*86400000);}finally{await close(old);}
 return {connected:true,user:verified.user,capabilities:verified.capabilities};
}
