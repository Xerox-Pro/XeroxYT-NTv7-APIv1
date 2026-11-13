export async function privateRateLimit(db,id,path,method,now=Date.now()){
 const policy=method==='GET'&&/^\/api\/(instagram|tiktok)\/(feed|stories|threads|messages|search|comments)$/.test(path)?['social-read',60000,30]:/^\/api\/(instagram|tiktok)\/unofficial\/connect$/.test(path)?['social-connect',60000,3]:method==='POST'&&/^\/api\/(instagram|tiktok)\/(likes|comments|notes|messages\/send)$/.test(path)?['social-write',60000,10]:path==='/api/account/cloudflare-session'?['ticket',60000,12]:path==='/api/auth/signin'?['signin',60000,3]:method==='GET'?['read',60000,120]:['write',10000,10];
 const [kind,window,limit]=policy,key='youtube-rate:'+kind+':'+id;
 const row=await db.prepare('INSERT INTO login_attempts (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING count,window_start').bind(key,now,now-window,now-window).first();
 if(row?.count>limit){const retry=Math.max(1,Math.ceil((Number(row.window_start)+window-now)/1000));return Response.json({error:'リクエストが集中しています。少し待ってから再試行してください。',code:'YOUTUBE_RATE_LIMITED',retryAfter:retry},{status:429,headers:{'Cache-Control':'private, no-store','Retry-After':String(retry)}});}
 return null;
}
