// Only server-to-server requests reach this non-/api path. The public gateway
// cannot route it or forward the required internal marker. Values stay encrypted.
export async function handleYouTubeStore(request,db){
 if(request.method!=='POST'||request.headers.get('x-xeroxyt-internal')!=='youtube-store')return Response.json({error:'Not found'},{status:404});
 const raw=await request.text();if(raw.length>65536)return Response.json({error:'Payload too large'},{status:413});
 let body;try{body=JSON.parse(raw);}catch{return Response.json({error:'Invalid JSON'},{status:400});}
 const {operation,key,value}=body;if(!/^youtube(?:-flow)?:[\w-]{1,100}$/.test(key||'')||!['get','set','delete'].includes(operation))return Response.json({error:'Invalid operation'},{status:400});
 if(operation==='get'){const row=await db.prepare('SELECT data FROM api_oauth_flows WHERE user_id = ? AND expires_at > ?').bind(key,Date.now()).first();return Response.json({value:row?JSON.parse(row.data):null},{headers:{'Cache-Control':'private, no-store'}});}
 if(operation==='delete')await db.prepare('DELETE FROM api_oauth_flows WHERE user_id = ?').bind(key).run();
 else{if(!value||!Number.isFinite(value.expires)||!value.flow||['iv','data','tag'].some(k=>typeof value.flow[k]!=='string'))return Response.json({error:'Encrypted value required'},{status:400});await db.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify(value),value.expires).run();}
 return Response.json({success:true},{headers:{'Cache-Control':'private, no-store'}});
}
export function createRemoteYouTubeStore(env,fetcher=fetch){
 const call=async(operation,key,value)=>{
  const base=new URL(env.ACCOUNT_API_URL);if(base.protocol!=='https:'||!env.API_SHARED_SECRET)throw new Error('YouTube store is not configured');
  const response=await fetcher(new URL('/internal/youtube-store',base),{method:'POST',headers:{'Content-Type':'application/json',Origin:(env.ALLOWED_ORIGINS||'').split(',')[0].trim(),Authorization:'Bearer '+env.API_SHARED_SECRET,'X-XeroxYT-Internal':'youtube-store'},body:JSON.stringify({operation,key,...(value?{value}:{})}),signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw Object.assign(new Error('連携情報の保存先に接続できません。再試行してください。'),{status:503,code:'YOUTUBE_STORE_UNAVAILABLE'});
  return response.json();
 };
 return {get:async key=>(await call('get',key)).value||undefined,set:async(key,value)=>{await call('set',key,value);},delete:async key=>{await call('delete',key);}};
}
