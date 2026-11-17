import {requestJson} from '../security/http.mjs';
import {handleDm} from './dm.mjs';
import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';

const MAX_AGE = 60 * 60 * 24 * 30;
const hash = value => createHash('sha256').update(value).digest('hex');
const cookie = token => `__Host-xy_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${token ? MAX_AGE : 0}`;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const passHash = (password, salt) => scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
const validUser = name => typeof name === 'string' && /^[a-z0-9_]{3,32}$/.test(name);
const validPass = password => typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 256;

async function currentUser(request, db) {
  const token = /(?:^|;\s*)__Host-xy_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
  if (!token) return null;
  return db.prepare('SELECT users.id, users.username, COALESCE(account_controls.banned,0) AS banned, COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped FROM sessions JOIN users ON users.id = sessions.user_id LEFT JOIN account_controls ON account_controls.user_id=users.id WHERE token_hash = ? AND expires_at > ?').bind(hash(token), Date.now()).first();
}
const isMaster = (user,env) => !!user&&typeof env.MASTER_USERNAME==='string'&&user.username===env.MASTER_USERNAME.trim().toLowerCase();
const publicUser = (user,env) => ({id:user.id,username:user.username,...(isMaster(user,env)?{admin:true}:{})});
const usageDay = now => new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0,10);
async function recordUsage(db,user,request){
  const now=Date.now(),path=request.headers.get('x-account-usage-path')||'';
  const video=/^\/(?:api\/video\/|stream\/|360\/|edu\/|scratch-edu\/)/.test(path)?1:0;
  const search=/^\/api\/search(?:\/|$)/.test(path)?1:0;
  await db.prepare('INSERT INTO account_usage(user_id,day,requests,videos,searches,last_seen) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET requests=requests+1,videos=videos+excluded.videos,searches=searches+excluded.searches,last_seen=excluded.last_seen').bind(user.id,usageDay(now),1,video,search,now).run();
}
async function startSession(db, user, env) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(hash(token), user.id, Date.now() + MAX_AGE * 1000).run();
  return json({ user: publicUser(user,env) }, 200, { 'Set-Cookie': cookie(token) });
}
async function limit(db, key, max) {
  const now = Date.now();
  const row = await db.prepare('INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END RETURNING count').bind(key, now, now - 600000, now - 600000).first();
  return row.count <= max;
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/account/, '');
      if (request.method !== 'GET') {
        const origin = request.headers.get('Origin');
        const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
        if (!origin || !allowed.includes(origin)) return json({ error: '不正なリクエストです。' }, 403);
        if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: '不正な形式です。' }, 415);
      }
      if (Number(request.headers.get('content-length') || 0) > 131072) return json({ error: 'データが大きすぎます。' }, 413);
      if (request.method === 'GET' && path === '/session') {
        const user = await currentUser(request, env.DB);
        if(!user)return json({ error: 'ログインが必要です。' }, 401);
        if(user.banned)return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403);
        if(user.traffic_stopped)return json({error:'このアカウントの通信は停止されています。'},423);
        await recordUsage(env.DB,user,request);
        return json({ user:publicUser(user,env) });
      }
      if (request.method === 'POST' && (path === '/register' || path === '/login')) {
        const body = await requestJson(request);
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        const password = body.password;
        if (!validUser(username) || !validPass(password)) return json({ error: 'ユーザー名は英小文字・数字・_で3〜32文字、パスワードは12文字以上です。' }, 400);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!(await limit(env.DB, `ip:${ip}`, 100)) || !(await limit(env.DB, `user:${username}`, 10))) return json({ error: '試行回数が多すぎます。しばらく待ってください。' }, 429);
        if (path === '/register') {
          const salt = randomBytes(16).toString('hex');
          const user = { id: crypto.randomUUID(), username };
          const result = await env.DB.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(user.id, username, passHash(password, salt), salt, Date.now()).run();
          if (!result.meta.changes) return json({ error: 'そのユーザー名は使用できません。' }, 409);
          return startSession(env.DB, user, env);
        }
        const user = await env.DB.prepare('SELECT users.id, users.username, users.password_hash, users.password_salt, COALESCE(account_controls.banned,0) AS banned, COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped FROM users LEFT JOIN account_controls ON account_controls.user_id=users.id WHERE users.username = ?').bind(username).first();
        const actual = passHash(password, user?.password_salt || '00000000000000000000000000000000');
        const expected = user?.password_hash || '0'.repeat(64);
        if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')) || !user) return json({ error: 'ユーザー名またはパスワードが違います。' }, 401);
        if(user.banned){const session=await startSession(env.DB,user,env);return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403,{'Set-Cookie':session.headers.get('Set-Cookie')});}
        if(user.traffic_stopped)return json({error:'このアカウントの通信は停止されています。'},423);
        return startSession(env.DB, user, env);
      }
      const user = await currentUser(request, env.DB);
      if (!user) return json({ error: 'ログインが必要です。' }, 401);
      if(path==='/dm'||path.startsWith('/dm/'))return handleDm(request,env,user,isMaster(user,env));
      if(user.banned)return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403);
      if(user.traffic_stopped&&!isMaster(user,env))return json({error:'このアカウントの通信は停止されています。'},423);
      if(path==='/visual-mode'&&request.method==='GET'){
        const row=await env.DB.prepare('SELECT mode FROM account_visual_modes WHERE user_id=?').bind(user.id).first();
        return json({mode:row?.mode||'off'});
      }
      if(path==='/admin/accounts'&&request.method==='GET'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const result=await env.DB.prepare("SELECT users.id,users.username,users.created_at,COALESCE(account_controls.banned,0) AS banned,COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped,COALESCE(SUM(account_usage.requests),0) AS requests,COALESCE(SUM(account_usage.videos),0) AS videos,COALESCE(SUM(account_usage.searches),0) AS searches,MAX(account_usage.last_seen) AS last_seen FROM users LEFT JOIN account_controls ON account_controls.user_id=users.id LEFT JOIN account_usage ON account_usage.user_id=users.id GROUP BY users.id ORDER BY users.created_at DESC").bind().all();
        const modes=await env.DB.prepare('SELECT user_id,mode FROM account_visual_modes').bind().all();
        const byId=new Map((modes.results||[]).map(row=>[row.user_id,row.mode]));
        return json({accounts:(result.results||[]).map(row=>({...row,visual_mode:byId.get(row.id)||'off'}))});
      }
      const adminMatch=/^\/admin\/accounts\/([0-9a-f-]{36})$/.exec(path);
      if(adminMatch&&request.method==='POST'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const targetId=adminMatch[1],target=await env.DB.prepare('SELECT id,username FROM users WHERE id=?').bind(targetId).first();
        if(!target)return json({error:'アカウントが見つかりません。'},404);
        const body=await requestJson(request),action=body.action;
        if(action==='visualMode'){
          if(!['off','chaos','chaos2','jelly'].includes(body.mode))return json({error:'モードが無効です。'},400);
          await env.DB.prepare('INSERT INTO account_visual_modes(user_id,mode,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at').bind(targetId,body.mode,Date.now()).run();
          return json({ok:true,mode:body.mode});
        }
        if(isMaster(target,env))return json({error:'管理アカウント自身は変更できません。'},400);
        if(action==='delete'){
          await env.DB.prepare('DELETE FROM account_visual_modes WHERE user_id=?').bind(targetId).run();
          for(const [sql,args] of [['DELETE FROM api_oauth_flows WHERE user_id LIKE ?',[`%:${targetId}%`]],['DELETE FROM account_usage WHERE user_id=?',[targetId]],['DELETE FROM account_controls WHERE user_id=?',[targetId]],['DELETE FROM history WHERE user_id=?',[targetId]],['DELETE FROM sessions WHERE user_id=?',[targetId]],['DELETE FROM users WHERE id=?',[targetId]]])await env.DB.prepare(sql).bind(...args).run();
          return json({ok:true});
        }
        if(action==='resetPassword'){
          if(!validPass(body.password))return json({error:'新しいパスワードは12文字以上にしてください。'},400);
          const salt=randomBytes(16).toString('hex');await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').bind(passHash(body.password,salt),salt,targetId).run();await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();return json({ok:true});
        }
        if(action==='ban'||action==='traffic'){
          const column=action==='ban'?'banned':'traffic_stopped',enabled=body.enabled?1:0;
          await env.DB.prepare(`INSERT INTO account_controls(user_id,${column},updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`).bind(targetId,enabled,Date.now()).run();
          if(action==='ban'&&!enabled)await env.DB.prepare('DELETE FROM login_attempts WHERE key=? OR key LIKE ?').bind('abuse-penalty:'+targetId,'youtube-rate:%:'+targetId).run();
          // Keep a banned account's session only so every device can receive the
          // explicit BAN response and persist its lock screen. All account data
          // routes remain blocked above. Traffic stops still revoke sessions.
          if(enabled&&action==='traffic')await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();
          return json({ok:true});
        }
        return json({error:'操作が不正です。'},400);
      }
      if (request.method === 'POST' && path === '/logout') {
        const token = /(?:^|;\s*)__Host-xy_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie') || '')?.[1];
        if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash(token)).run();
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('') });
      }
      if (request.method === 'GET' && path === '/history') {
        const row = await env.DB.prepare('SELECT data, version FROM history WHERE user_id = ?').bind(user.id).first();
        return json({ history: row ? JSON.parse(row.data) : [], version: row?.version || 0 });
      }
      if (request.method === 'PUT' && path === '/history') {
        const body = await requestJson(request);
        if (!Array.isArray(body.history) || body.history.length > 100 || !Number.isSafeInteger(body.version) || body.version < 0) return json({ error: '履歴データが不正です。' }, 400);
        const data = JSON.stringify(body.history);
        if (Buffer.byteLength(data) > 100000) return json({ error: '履歴データが大きすぎます。' }, 413);
        await env.DB.prepare("INSERT OR IGNORE INTO history (user_id, data, version) VALUES (?, '[]', 0)").bind(user.id).run();
        const result = await env.DB.prepare('UPDATE history SET data = ?, version = version + 1 WHERE user_id = ? AND version = ?').bind(data, user.id, body.version).run();
        if (!result.meta.changes) return json({ error: '履歴が別の端末で更新されました。', conflict: true }, 409);
        return json({ version: body.version + 1 });
      }
      return json({ error: '見つかりません。' }, 404);
    } catch (err) {
      console.warn(JSON.stringify({event:'account_request_failed',status:err.status||500,code:err.code||'ACCOUNT_FAILED'}));
      if(err.status===400||err.status===413)return json({error:err.message},err.status);
      return json({ error: '処理に失敗しました。時間をおいてお試しください。' }, 500);
    }
  }
};
