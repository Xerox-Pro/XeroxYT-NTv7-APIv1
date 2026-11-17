import {requestJson} from '../security/http.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function handleGroups(request,env,user,admin,path,moderate){
 const db=env.DB,method=request.method,now=Date.now();
 const profile=await db.prepare('SELECT nickname FROM dm_profiles WHERE user_id=?').bind(user.id).first();
 if(path==='/profile'){
  if(method==='GET')return reply({nickname:profile?.nickname||null,uploadsAvailable:!!env.DM_MEDIA});
  if(method!=='POST')return reply({error:'未対応の操作です。'},405);
  const body=await requestJson(request),name=typeof body.nickname==='string'?body.nickname.normalize('NFKC').trim():'';
  if(name.length<2||name.length>24||name.toLowerCase()===user.username||/[<>@\r\n\u0000-\u001f]/.test(name)||moderate(name)||(!admin&&/管理者|administrator|moderator/i.test(name)))return reply({error:'IDとは別の表示名を2〜24文字で設定してください。管理者を装う名前や不適切な名前は使えません。'},400);
  await db.prepare('INSERT INTO dm_profiles(user_id,nickname,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname,updated_at=excluded.updated_at').bind(user.id,name,now).run();
  if(!user.banned&&!user.traffic_stopped){await db.prepare("INSERT OR IGNORE INTO dm_rooms(id,name,visibility,owner,created_at) VALUES('open','オープンDM','open','system',?)").bind(now).run();await db.prepare("INSERT OR IGNORE INTO dm_members(room_id,user_id,status) VALUES('open',?,'joined')").bind(user.id).run();}
  return reply({ok:true,nickname:name});
 }
 if(!path.startsWith('/rooms'))return null;
 if(!profile)return reply({error:'DM用の表示名を設定してください。',code:'DM_PROFILE_REQUIRED'},409);
 if(user.banned||user.traffic_stopped)return reply({error:'停止中は解除申請だけ利用できます。'},403);
 if(path==='/rooms'&&method==='GET'){
  await db.prepare("INSERT OR IGNORE INTO dm_rooms(id,name,visibility,owner,created_at) VALUES('open','オープンDM','open','system',?)").bind(now).run();await db.prepare("INSERT OR IGNORE INTO dm_members(room_id,user_id,status) VALUES('open',?,'joined')").bind(user.id).run();
  const rows=await db.prepare("SELECT r.id,r.name,r.visibility,m.status,(SELECT MAX(created_at) FROM dm_room_messages WHERE room_id=r.id) AS lastAt,(SELECT sender FROM dm_room_messages WHERE room_id=r.id ORDER BY created_at DESC,id DESC LIMIT 1)=? AS lastMine,CASE WHEN r.owner=? THEN 1 ELSE 0 END AS owned FROM dm_rooms r LEFT JOIN dm_members m ON m.room_id=r.id AND m.user_id=? WHERE r.visibility IN ('open','public') OR m.user_id=? ORDER BY r.created_at LIMIT 100").bind(user.id,user.id,user.id,user.id).all();return reply({rooms:rows.results||[]});
 }
 if(path==='/rooms'&&method==='POST'){
  const body=await requestJson(request),name=typeof body.name==='string'?body.name.trim():'';if(name.length<2||name.length>40||moderate(name)||!['public','private'].includes(body.visibility))return reply({error:'グループ名と公開範囲を確認してください。'},400);
  const count=await db.prepare('SELECT COUNT(*) AS count FROM dm_rooms WHERE owner=?').bind(user.id).first();if(count.count>=5)return reply({error:'作成できるグループは5個までです。'},429);
  const id=crypto.randomUUID();await db.prepare('INSERT INTO dm_rooms(id,name,visibility,owner,created_at) VALUES(?,?,?,?,?)').bind(id,name,body.visibility,user.id,now).run();await db.prepare("INSERT INTO dm_members(room_id,user_id,status) VALUES(?,?,'joined')").bind(id,user.id).run();return reply({ok:true,id});
 }
 const match=/^\/rooms\/(open|[a-f0-9-]{36})(?:\/(join|invite|send|leave|report|ban))?$/.exec(path);if(!match)return reply({error:'見つかりません。'},404);
 const room=await db.prepare('SELECT * FROM dm_rooms WHERE id=?').bind(match[1]).first(),member=await db.prepare('SELECT status FROM dm_members WHERE room_id=? AND user_id=?').bind(match[1],user.id).first();
 if(!room||(room.visibility==='private'&&!member))return reply({error:'見つかりません。'},404);
 const operation=match[2];
 if(method==='POST'&&operation==='join'){
  if(member?.status==='blocked'||(room.visibility==='private'&&member?.status!=='invited'&&member?.status!=='joined'))return reply({error:'参加できません。'},403);
  await db.prepare("INSERT INTO dm_members(room_id,user_id,status) VALUES(?,?,'joined') ON CONFLICT(room_id,user_id) DO UPDATE SET status='joined'").bind(room.id,user.id).run();return reply({ok:true});
 }
 if(member?.status!=='joined')return reply({error:'参加・招待承諾が必要です。'},403);
 if(method==='GET'&&!operation){const rows=await db.prepare('SELECT m.id,m.body,m.created_at,m.sender,p.nickname FROM dm_room_messages m JOIN dm_profiles p ON p.user_id=m.sender WHERE m.room_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT 100').bind(room.id).all();return reply({messages:(rows.results||[]).reverse().map(m=>({id:m.id,text:m.body,name:m.nickname,mine:m.sender===user.id,createdAt:m.created_at}))});}
 if(method!=='POST')return reply({error:'未対応の操作です。'},405);
 const body=await requestJson(request);
 if(operation==='invite'){
  if(room.owner!==user.id&&!admin)return reply({error:'管理権限がありません。'},403);
  const target=typeof body.target==='string'?body.target.trim().toLowerCase():'';const other=await db.prepare('SELECT id FROM users WHERE username=?').bind(target).first();if(other)await db.prepare("INSERT OR IGNORE INTO dm_members(room_id,user_id,status) VALUES(?,?,'invited')").bind(room.id,other.id).run();return reply({ok:true,message:'招待を受け付けました。'});
 }
 if(operation==='leave'){if(room.visibility==='open')return reply({error:'オープンDMは全利用者共通です。'},400);await db.prepare('DELETE FROM dm_members WHERE room_id=? AND user_id=?').bind(room.id,user.id).run();return reply({ok:true});}
 if(operation==='report'||operation==='ban'){
  const message=await db.prepare('SELECT id,sender FROM dm_room_messages WHERE id=? AND room_id=?').bind(String(body.messageId||''),room.id).first();if(!message)return reply({error:'対象メッセージがありません。'},404);
  if(operation==='ban'){if(!admin)return reply({error:'権限がありません。'},403);if(message.sender===user.id)return reply({error:'自分自身はBANできません。'},400);await db.prepare('INSERT INTO account_controls(user_id,banned,updated_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET banned=1,updated_at=excluded.updated_at').bind(message.sender,now).run();return reply({ok:true});}
  await db.prepare('INSERT INTO dm_room_reports(id,room_id,message_id,reporter,reason,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),room.id,message.id,user.id,String(body.reason||'不適切な発言').slice(0,500),now).run();return reply({ok:true});
 }
 if(operation==='send'){
  const text=typeof body.text==='string'?body.text.trim():'';if(!text||text.length>2000)return reply({error:'本文は1〜2000文字で入力してください。'},400);const warning=moderate(text);if(warning)return reply({error:warning,code:'DM_CONTENT_WARNING'},422);
  const recent=await db.prepare('SELECT COUNT(*) AS count FROM dm_room_messages WHERE sender=? AND created_at>?').bind(user.id,now-60000).first();if(recent.count>=15)return reply({error:'送信が速すぎます。'},429);
  await db.prepare('INSERT INTO dm_room_messages(id,room_id,sender,body,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),room.id,user.id,text,now).run();return reply({ok:true});
 }
 return reply({error:'見つかりません。'},404);
}
