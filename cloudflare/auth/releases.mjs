import {requestJson} from '../security/http.mjs';
export function releaseConfig(manifest,repo){
 if(manifest.version!==1||!/^app-[\w-]+\.js$/.test(manifest.entry)||!/^style-[\w-]+\.css$/.test(manifest.css)||!/^[a-f0-9]{40}$/.test(manifest.revision)||!/^[a-f0-9]{64}$/.test(manifest.serverHash))throw Error('Invalid release manifest');
 const base='https://cdn.jsdelivr.net/gh/'+repo+'@'+manifest.revision+'/gas/web';
 return {base,js:base+'/'+manifest.entry,css:base+'/'+manifest.css,version:manifest.entry+':'+manifest.css+':'+manifest.serverHash,source:manifest.source,publishedAt:Number(manifest.publishedAt)||Number(manifest.builtAt)||0};
}
export async function latestRelease(env,fetcher=fetch){
 const now=Date.now(),db=env.DB,repo=env.GAS_ASSET_REPO||'Xerox-Pro/XeroxYT-NTv7-for-GAS';if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('Invalid repository');
 const previous=await db.prepare("SELECT * FROM client_releases WHERE channel='gas'").bind().first();
 if(previous&&now-previous.checked_at<30000)return {...JSON.parse(previous.manifest),checkedAt:previous.checked_at};
 try{
  const response=await fetcher('https://raw.githubusercontent.com/'+repo+'/gas-runtime/gas/web/release.json?t='+Math.floor(now/30000),{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Release unavailable');const text=await response.text();if(text.length>12000)throw Error('Manifest too large');
  const config=releaseConfig(JSON.parse(text),repo);config.publishedAt=config.publishedAt||(previous?.version===config.version?previous.published_at:now);
  await db.prepare("INSERT INTO client_releases(channel,version,manifest,published_at,checked_at) VALUES('gas',?,?,?,?) ON CONFLICT(channel) DO UPDATE SET version=excluded.version,manifest=excluded.manifest,published_at=excluded.published_at,checked_at=excluded.checked_at").bind(config.version,JSON.stringify(config),config.publishedAt,now).run();return {...config,checkedAt:now};
 }catch(error){if(previous)return {...JSON.parse(previous.manifest),checkedAt:previous.checked_at,stale:true};throw error;}
}
export async function clientRelease(request,env,user){
 const now=Date.now();
 if(request.method==='POST'){
  if(!user)return Response.json({error:'ログインが必要です。'},{status:401});const body=await requestJson(request);
  if(!/^[a-f0-9]{64}$/.test(body.deviceId||'')||typeof body.version!=='string'||body.version.length>250)return Response.json({error:'端末情報が無効です。'},{status:400});
  const known=await env.DB.prepare('SELECT version FROM device_releases WHERE user_id=? AND device_id=?').bind(user.id,body.deviceId).first();
  if(!known){const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM device_releases WHERE user_id=?').bind(user.id).first();if(count.count>=50)return Response.json({error:'登録できる端末数を超えています。'},{status:429});}
  const error=typeof body.error==='string'?body.error.replace(/https?:\/\/\S+/g,'[URL]').slice(0,250):'';
  await env.DB.prepare('INSERT INTO device_releases(user_id,device_id,version,applied_at,last_seen,last_error) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET applied_at=CASE WHEN version<>excluded.version THEN excluded.applied_at ELSE applied_at END,version=excluded.version,last_seen=excluded.last_seen,last_error=excluded.last_error').bind(user.id,body.deviceId,body.version,now,now,error).run();
 }
 if(!['GET','POST'].includes(request.method))return Response.json({error:'未対応の操作です。'},{status:405});
 try{return Response.json(await latestRelease(env),{headers:{'Cache-Control':'private, no-store'}});}catch{return Response.json({error:'最新バージョンを取得できません。再試行します。'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
