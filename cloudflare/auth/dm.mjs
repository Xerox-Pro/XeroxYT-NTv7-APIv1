import {requestJson} from '../security/http.mjs';
import {handleGroups} from './groups.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export function moderateMessage(text){
 const normalized=text.normalize('NFKC').replace(/[\s\u200b-\u200f]/g,'').toLowerCase();
 if(/(?:死ね|しね|殺すぞ|ころすぞ|自殺しろ|消えろ|裸の写真|ヌード|セックス|せっくす|エッチし|おっぱい|ちんこ|まんこ|fuckyou|sendnudes|kill yourself)/i.test(normalized))return '嫌がらせ・性的な誘いなどの表現を検知したため送信できません。内容を見直してください。';
 return null;
}
export async function handleDm(request,env,user,admin){
 const db=env.DB,path=new URL(request.url).pathname.replace('/api/account/dm',''),method=request.method,now=Date.now();
 const limited=async(kind,maximum,window)=>{const row=await db.prepare('INSERT INTO login_attempts(key,count,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start<? THEN 1 ELSE count+1 END,window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING count').bind('dm:'+kind+':'+user.id,now,now-window,now-window).first();return row.count>maximum;};
 if(await limited('all',90,60000))return reply({error:'しばらく待ってから操作してください。'},429);
 const groupResponse=await handleGroups(request,env,user,admin,path,moderateMessage);if(groupResponse)return groupResponse;
 const profile=await db.prepare('SELECT nickname FROM dm_profiles WHERE user_id=?').bind(user.id).first();
 if(!profile&&path==='')return reply({threads:[],needsProfile:true});
 if(!profile)return reply({error:'先にDM用の表示名を設定してください。',code:'DM_PROFILE_REQUIRED'},409);
 if(path==='/reports'&&method==='GET'&&admin){const rows=await db.prepare('SELECT r.id,r.reason,r.created_at,m.body FROM dm_reports r LEFT JOIN dm_messages m ON m.id=r.message_id UNION ALL SELECT r.id,r.reason,r.created_at,m.body FROM dm_room_reports r JOIN dm_room_messages m ON m.id=r.message_id ORDER BY 3 DESC LIMIT 100').bind().all();return reply({reports:rows.results||[]});}
 const reported=/^\/reports\/([0-9a-f-]{36})\/ban$/.exec(path);
 if(reported&&method==='POST'&&admin){let row=await db.prepare('SELECT m.sender FROM dm_reports r JOIN dm_messages m ON m.id=r.message_id WHERE r.id=?').bind(reported[1]).first();if(!row)row=await db.prepare('SELECT m.sender FROM dm_room_reports r JOIN dm_room_messages m ON m.id=r.message_id WHERE r.id=?').bind(reported[1]).first();if(!row)return reply({error:'対象のメッセージがありません。'},404);const target=await db.prepare('SELECT username FROM users WHERE id=?').bind(row.sender).first();if(target?.username===String(env.MASTER_USERNAME||'').trim().toLowerCase())return reply({error:'管理者はこの操作の対象外です。'},400);await db.prepare('INSERT INTO account_controls(user_id,banned,updated_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET banned=1,updated_at=excluded.updated_at').bind(row.sender,now).run();return reply({ok:true});}
 const allowed=thread=>admin||thread.kind==='appeal'||(!user.banned&&!user.traffic_stopped);
 if(method==='GET'&&path===''){
  const result=await db.prepare('SELECT t.id,t.initiator,t.status,t.kind,t.updated_at,p.nickname FROM dm_threads t LEFT JOIN dm_profiles p ON p.user_id=CASE WHEN t.a=? THEN t.b ELSE t.a END WHERE t.a=? OR t.b=? ORDER BY t.updated_at DESC LIMIT 100').bind(user.id,user.id,user.id).all();
  return reply({threads:(result.results||[]).filter(t=>(t.status!=='pending'||t.initiator!==user.id)&&(admin||t.kind==='appeal'||(!user.banned&&!user.traffic_stopped))).map(t=>({id:t.id,status:t.status,kind:t.kind,incoming:t.initiator!==user.id,updatedAt:t.updated_at,label:t.kind==='appeal'?'BAN解除申請':t.status==='accepted'?(t.nickname||'匿名の会話'):'匿名の申請'}))});
 }
 if(method==='POST'&&path==='/request'){
  if(user.banned||user.traffic_stopped)return reply({error:'解除申請だけ利用できます。'},403);
  const body=await requestJson(request);
  if(await limited('invite',5,3600000))return reply({error:'申請回数の上限です。時間をおいてください。'},429);
  const target=typeof body.target==='string'?body.target.trim().toLowerCase():'';
  // Same response for nonexistent, blocked, duplicate and valid targets.
  const other=await db.prepare('SELECT id FROM users WHERE username=?').bind(target).first();
  if(other&&other.id!==user.id){const [a,b]=[user.id,other.id].sort();await db.prepare('INSERT OR IGNORE INTO dm_threads(id,a,b,initiator,status,kind,updated_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),a,b,user.id,admin?'accepted':'pending','normal',now).run();if(admin){const thread=await db.prepare("SELECT id FROM dm_threads WHERE a=? AND b=? AND kind='normal'").bind(a,b).first();return reply({ok:true,threadId:thread.id});}}
  return reply({ok:true,message:'申請を受け付けました。相手が承諾すると会話できます。'});
 }
 if(method==='POST'&&path==='/appeal'){
  const master=await db.prepare('SELECT id FROM users WHERE username=?').bind(String(env.MASTER_USERNAME||'').trim().toLowerCase()).first();
  if(!master||master.id===user.id)return reply({error:'解除申請を開始できません。'},400);
  const [a,b]=[user.id,master.id].sort();await db.prepare('INSERT OR IGNORE INTO dm_threads(id,a,b,initiator,status,kind,updated_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),a,b,user.id,'accepted','appeal',now).run();return reply({ok:true});
 }
 const match=/^\/([0-9a-f-]{36})(?:\/(accept|block|report|unban))?$/.exec(path);if(!match)return reply({error:'見つかりません。'},404);
 const thread=await db.prepare('SELECT * FROM dm_threads WHERE id=? AND (a=? OR b=?)').bind(match[1],user.id,user.id).first();
 if(!thread||!allowed(thread))return reply({error:'見つかりません。'},404);
 if(method==='GET'&&!match[2]){
  if(thread.status!=='accepted')return reply({messages:[]});
  const rows=await db.prepare('SELECT id,sender,body,created_at FROM (SELECT id,sender,body,created_at FROM dm_messages WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 100) ORDER BY created_at,id').bind(thread.id).all();
  return reply({messages:(rows.results||[]).map(row=>({id:row.id,mine:row.sender===user.id,text:row.body,createdAt:row.created_at}))});
 }
 if(method!=='POST')return reply({error:'未対応の操作です。'},405);
 if(match[2]==='unban'&&admin){const target=thread.a===user.id?thread.b:thread.a;await db.prepare('UPDATE account_controls SET banned=0,updated_at=? WHERE user_id=?').bind(now,target).run();await db.prepare('DELETE FROM login_attempts WHERE key=? OR key LIKE ?').bind('abuse-penalty:'+target,'youtube-rate:%:'+target).run();return reply({ok:true});}
 if(match[2]==='accept'){
  if(thread.status!=='pending'||thread.initiator===user.id)return reply({error:'承諾できません。'},409);
  await db.prepare("UPDATE dm_threads SET status='accepted',updated_at=? WHERE id=? AND status='pending'").bind(now,thread.id).run();return reply({ok:true});
 }
 if(match[2]==='block'){
  if(thread.kind==='appeal')return reply({error:'解除申請の会話はブロックできません。'},400);
  await db.prepare("UPDATE dm_threads SET status='blocked',updated_at=? WHERE id=?").bind(now,thread.id).run();return reply({ok:true});
 }
 const body=await requestJson(request);
 if(match[2]==='report'){
  const reason=typeof body.reason==='string'?body.reason.trim().slice(0,500):'';if(!reason)return reply({error:'通報理由を入力してください。'},400);
  if(await limited('report',5,3600000))return reply({error:'通報回数の上限です。'},429);
  const message=await db.prepare('SELECT id FROM dm_messages WHERE thread_id=? AND sender<>? ORDER BY created_at DESC LIMIT 1').bind(thread.id,user.id).first();
  await db.prepare('INSERT INTO dm_reports(id,thread_id,message_id,reporter,reason,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),thread.id,message?.id||null,user.id,reason,now).run();return reply({ok:true});
 }
 if(thread.status!=='accepted')return reply({error:'相手の承諾が必要です。'},403);
 if(await limited('send',15,60000))return reply({error:'送信が速すぎます。少し待ってください。'},429);
 const text=typeof body.text==='string'?body.text.trim():'';if(!text||text.length>2000)return reply({error:'本文は1〜2000文字で入力してください。'},400);
 const warning=moderateMessage(text);if(warning)return reply({error:warning,code:'DM_CONTENT_WARNING'},422);
 await db.prepare("INSERT INTO dm_messages(id,thread_id,sender,body,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM dm_threads WHERE id=? AND status='accepted')").bind(crypto.randomUUID(),thread.id,user.id,text,now,thread.id).run();await db.prepare('UPDATE dm_threads SET updated_at=? WHERE id=?').bind(now,thread.id).run();return reply({ok:true});
}
