// TikTok QR login based on the public request contract documented by
// etrnkz/tiktok-unofficial-api (MIT). QR approval must happen in TikTok itself.
// No CAPTCHA or security check bypass; this integration may be rejected upstream.
import {randomBytes} from 'node:crypto';
import {probeSession,sessionCookies,fail} from './unofficial.mjs';
import {registerTikTokAccount} from './account-vault.mjs';

const TTL=180000;
const origin='https://www.tiktok.com';
const headers=cookies=>({'Accept':'application/json','Accept-Language':'ja-JP,ja;q=0.9','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36','Referer':origin+'/','Origin':origin,...(Object.keys(cookies).length?{Cookie:Object.entries(cookies).map(([k,v])=>k+'='+v).join('; ')}:{})});
const cookieNames=new Set(['sessionid','sessionid_ss','sid_tt','sid_guard','uid_tt','uid_tt_ss','ttwid','msToken','tt_webid','tt_webid_v2','passport_csrf_token','tt_csrf_token','store-idc','store-country-code']);
function cookieUpdates(response,old){
 const jar={...old};
 for(const line of response.headers.getSetCookie?.()||[response.headers.get('set-cookie')].filter(Boolean)){
  const found=/^([^=;\s]+)=([^;\s]*)/.exec(line);
  if(found&&cookieNames.has(found[1])&&found[2].length<4096)jar[found[1]]=found[2];
 }
 return jar;
}
async function getJson(fetcher,route,params,cookies){
 const url=new URL(route,origin);
 for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
 const response=await fetcher(url.href,{method:'GET',headers:headers(cookies),redirect:'manual',signal:AbortSignal.timeout(11000)});
 if(!response.ok||response.status>=300&&response.status<400)throw fail('QR_PROVIDER_REJECTED','TikTokがQRログインの要求を受け付けませんでした。公式ログインを利用してください。',response.status===429?429:502);
 if(Number(response.headers.get('content-length')||0)>100000)throw fail('QR_RESPONSE','QR情報が大きすぎます。',502);
 let payload;try{payload=await response.json();}catch{throw fail('QR_RESPONSE','QRログインの応答形式が無効です。',502);}
 if(payload.status_code!==undefined&&Number(payload.status_code)!==0)throw fail('QR_PROVIDER_REJECTED','TikTokがQRログインを許可しませんでした。',403);
 return {data:payload.data||{},cookies:cookieUpdates(response,cookies)};
}
const key=id=>'social-qr:tiktok:'+id;
export async function tiktokQrFlow({route,request,identity,db,fetcher}){
 if(request.method!=='POST'||!request.headers.get('content-type')?.startsWith('application/json'))throw fail('QR_FORMAT','QRログインの送信形式が無効です。',415);
 if(route==='qr/start'){
  const body=await request.json().catch(()=>({}));
  if(body.consent!==true)throw fail('QR_CONSENT','非公式連携の注意事項への同意が必要です。',400);
  const result=await getJson(fetcher,'/passport/web/qr/get_code/',{aid:1988,service:origin},{}),data=result.data;
  const token=data.token,qr=data.qrcode_index_url||data.scan_url;
  if(typeof token!=='string'||!token||token.length>512)throw fail('QR_UNAVAILABLE','QR認証トークンを取得できませんでした。',502);
  let safe;try{const url=new URL(qr);if(url.protocol!=='https:'||!['www.tiktok.com','tiktok.com','m.tiktok.com'].includes(url.hostname))throw Error('host');safe=url.href;}catch{throw fail('QR_UNAVAILABLE','TikTokのQRログインURLを確認できませんでした。',502);}
  const flowId=randomBytes(16).toString('hex'),expiresAt=Date.now()+TTL;
  const deviceId=String(BigInt('0x'+randomBytes(8).toString('hex'))%9000000000000000000n+1000000000000000000n);
  const img=typeof data.qrcode==='string'&&data.qrcode.length<150000?data.qrcode:'';
  const qrImage=/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img)?img:/^[A-Za-z0-9+/=]+$/.test(img)?'data:image/png;base64,'+img:'';
  await db.write(key(identity.id),{flowId,expiresAt,token,cookies:result.cookies,deviceId},expiresAt);
  return {flowId,expiresAt,qrCodeUrl:safe,qrImage,status:'waiting'};
 }
 if(route==='qr/check'){
  if(Number(request.headers.get('content-length')||0)>1024)throw fail('QR_FORMAT','確認情報が大きすぎます。',413);
  const body=await request.json().catch(()=>({}));
  const flow=await db.read(key(identity.id));
  if(!flow||flow.expiresAt<Date.now()||typeof body.flowId!=='string'||body.flowId!==flow.flowId)return {status:'expired'};
  const result=await getJson(fetcher,'/passport/web/qr/check_status/',{aid:1988,service:origin,token:flow.token},flow.cookies);
  const data=result.data,answer=String(data.status||'').toLowerCase();
  if(answer==='expired'||answer==='timeout'){await db.remove(key(identity.id));return {status:'expired'};}
  if(answer==='scanned')return {status:'scanned'};
  if(!['success','confirmed'].includes(answer)&&data.is_confirmed!==true)return {status:'waiting'};
  const jar={...result.cookies};
  if(data.session_key||data.sessionid){jar.sessionid=String(data.session_key||data.sessionid);jar.sessionid_ss=jar.sessionid;}
  // Never mark the QR as completed without validating the resulting session.
  const candidate={cookies:sessionCookies(jar,'tiktok'),deviceId:flow.deviceId||'',region:'JP',uuid:crypto.randomUUID(),userAgent:headers({})['User-Agent']};
  const verified=await probeSession('tiktok',candidate,fetcher);
  await registerTikTokAccount(db,identity.id,{...candidate,...verified,connectedAt:Date.now()});
  await db.remove(key(identity.id));
  return {status:'confirmed',connected:true,user:verified.user,capabilities:verified.capabilities};
 }
 throw fail('QR_ROUTE','QR認証操作が不正です。',404);
}
