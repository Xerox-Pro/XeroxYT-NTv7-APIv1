export async function privateRateLimit(db,id,path,method,now=Date.now()){
 const penaltyKey='abuse-penalty:'+id;
 const penalty=id.startsWith('public:')?null:await db.prepare('SELECT count,window_start FROM login_attempts WHERE key=?').bind(penaltyKey).first();
 if(penalty&&Number(penalty.window_start)>now){const retry=Math.ceil((Number(penalty.window_start)-now)/1000);return Response.json({error:'警告：過剰なリクエストのため10分間停止しています。解除後に再度過剰アクセスするとBANされます。',code:'ACCOUNT_TIMEOUT',retryAfter:retry,suspendedUntil:Number(penalty.window_start)},{status:429,headers:{'Cache-Control':'private, no-store','Retry-After':String(retry)}});}
 const policy=path==='/api/account/cloudflare-session'?['ticket',60000,12]:path==='/api/auth/signin'?['signin',60000,3]:method==='GET'?['read',60000,120]:['write',10000,10];
 const [kind,window,limit]=policy,key='youtube-rate:'+kind+':'+id;
 const row=await db.prepare('INSERT INTO login_attempts (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING count,window_start').bind(key,now,now-window,now-window).first();
 if(!id.startsWith('public:')&&row?.count===Math.max(limit*3,120)+1){
  const strike=await db.prepare('INSERT INTO login_attempts(key,count,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,window_start=excluded.window_start WHERE window_start<=? RETURNING count,window_start').bind(penaltyKey,now+600000,now-86400000,now).first();
  if(strike?.count>=2){await db.prepare('INSERT INTO account_controls(user_id,banned,updated_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET banned=1,updated_at=excluded.updated_at').bind(id,now).run();return Response.json({error:'過剰アクセスを繰り返したため、このアカウントはBANされました。',code:'ACCOUNT_BANNED',banned:true},{status:403,headers:{'Cache-Control':'private, no-store'}});}
  if(strike)return Response.json({error:'警告：過剰なリクエストのため10分間停止しました。再発するとBANされます。',code:'ACCOUNT_TIMEOUT',retryAfter:600,suspendedUntil:now+600000},{status:429,headers:{'Cache-Control':'private, no-store','Retry-After':'600'}});
 }
 if(row?.count>limit){const retry=Math.max(1,Math.ceil((Number(row.window_start)+window-now)/1000));return Response.json({error:'リクエストが集中しています。少し待ってから再試行してください。',code:'YOUTUBE_RATE_LIMITED',retryAfter:retry},{status:429,headers:{'Cache-Control':'private, no-store','Retry-After':String(retry)}});}
 return null;
}
