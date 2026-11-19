import {requestJson} from '../security/http.mjs';
import {handleDm} from './dm.mjs';
import {clientRelease} from './releases.mjs';
import {TERMS_VERSION,TERMS_SECTIONS,hasTerms,termsRequired} from './terms.mjs';
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
  return db.prepare('SELECT users.id, users.username, COALESCE(account_controls.banned,0) AS banned, COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped, CASE WHEN account_master_grants.user_id IS NULL THEN 0 ELSE 1 END AS master_granted FROM sessions JOIN users ON users.id = sessions.user_id LEFT JOIN account_controls ON account_controls.user_id=users.id LEFT JOIN account_master_grants ON account_master_grants.user_id=users.id WHERE token_hash = ? AND expires_at > ?').bind(hash(token), Date.now()).first();
}
const isOwner = user => user?.username?.toLowerCase() === 'xerox0521';
const isMaster = (user,env) => !!user&&typeof env.MASTER_USERNAME==='string'&&(isOwner(user)||user.username===env.MASTER_USERNAME.trim().toLowerCase()||user.master_granted===1);
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
      if(path==='/client-release')return clientRelease(request,env,await currentUser(request,env.DB));
      if(path==='/terms'){
        const user=await currentUser(request,env.DB);
        if(request.method==='GET')return json({version:TERMS_VERSION,sections:TERMS_SECTIONS,accepted:user?await hasTerms(env.DB,user.id):false});
        if(request.method!=='POST')return json({error:'未対応の操作です。'},405);
        if(!user)return json({error:'ログインが必要です。'},401);
        const body=await requestJson(request);if(body.accepted!==true||body.version!==TERMS_VERSION)return json({error:'現在の規約を確認し、同意してください。'},400);
        await env.DB.prepare('INSERT OR IGNORE INTO user_terms_acceptances(user_id,version,accepted_at) VALUES(?,?,?)').bind(user.id,TERMS_VERSION,Date.now()).run();return json({ok:true,version:TERMS_VERSION});
      }
      if (request.method === 'GET' && path === '/session') {
        const user = await currentUser(request, env.DB);
        if(!user)return json({ error: 'ログインが必要です。' }, 401);
        if(user.banned)return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403);
        if(user.traffic_stopped)return json({error:'このアカウントの通信は停止されています。'},423);
        // Checking an existing session must not depend on a D1 usage-statistics write.
        // D1 write-limit failures should not turn a valid login into HTTP 500.
        // Existing session checks refresh the current visible tab without a separate heartbeat.
        const tabId=url.searchParams.get('presence');
        if(tabId&&/^[a-f0-9]{32}$/.test(tabId)) {
          try { await env.DB.prepare('INSERT INTO account_presence(user_id,tab_id,last_seen) VALUES(?,?,?) ON CONFLICT(user_id,tab_id) DO UPDATE SET last_seen=excluded.last_seen').bind(user.id,tabId,Date.now()).run(); }
          catch { /* Presence is optional and must not prevent session verification. */ }
        }
        return json({ user:{...publicUser(user,env),termsAccepted:await hasTerms(env.DB,user.id)} });
      }
      if (request.method === 'POST' && (path === '/register' || path === '/login')) {
        const body = await requestJson(request);
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
        const password = body.password;
        if (!validUser(username) || !validPass(password)) return json({ error: 'ユーザー名は英小文字・数字・_で3〜32文字、パスワードは12文字以上です。' }, 400);
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (!(await limit(env.DB, `ip:${ip}`, 100)) || !(await limit(env.DB, `user:${username}`, 10))) return json({ error: '試行回数が多すぎます。しばらく待ってください。' }, 429);
        if (path === '/register') {
          if(body.termsAccepted!==true||body.termsVersion!==TERMS_VERSION)return termsRequired();
          const salt = randomBytes(16).toString('hex');
          const user = { id: crypto.randomUUID(), username };
          const result = await env.DB.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(user.id, username, passHash(password, salt), salt, Date.now()).run();
          if (!result.meta.changes) return json({ error: 'そのユーザー名は使用できません。' }, 409);
          await env.DB.prepare('INSERT INTO user_terms_acceptances(user_id,version,accepted_at) VALUES(?,?,?)').bind(user.id,TERMS_VERSION,Date.now()).run();
          return startSession(env.DB, user, env);
        }
        const user = await env.DB.prepare('SELECT users.id, users.username, users.password_hash, users.password_salt, COALESCE(account_controls.banned,0) AS banned, COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped, CASE WHEN account_master_grants.user_id IS NULL THEN 0 ELSE 1 END AS master_granted FROM users LEFT JOIN account_controls ON account_controls.user_id=users.id LEFT JOIN account_master_grants ON account_master_grants.user_id=users.id WHERE users.username = ?').bind(username).first();
        const actual = passHash(password, user?.password_salt || '00000000000000000000000000000000');
        const expected = user?.password_hash || '0'.repeat(64);
        if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')) || !user) return json({ error: 'ユーザー名またはパスワードが違います。' }, 401);
        if(body.termsAccepted===true&&body.termsVersion===TERMS_VERSION)await env.DB.prepare('INSERT OR IGNORE INTO user_terms_acceptances(user_id,version,accepted_at) VALUES(?,?,?)').bind(user.id,TERMS_VERSION,Date.now()).run();
        if(user.banned){const session=await startSession(env.DB,user,env);return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403,{'Set-Cookie':session.headers.get('Set-Cookie')});}
        if(user.traffic_stopped)return json({error:'このアカウントの通信は停止されています。'},423);
        return startSession(env.DB, user, env);
      }
      const user = await currentUser(request, env.DB);
      if (!user) return json({ error: 'ログインが必要です。' }, 401);
      if(path!=='/logout'&&!await hasTerms(env.DB,user.id))return termsRequired();
      if(path==='/dm'||path.startsWith('/dm/'))return handleDm(request,env,user,isMaster(user,env));
      if(user.banned)return json({error:'このアカウントはBANされています。',code:'ACCOUNT_BANNED',banned:true},403);
      if(user.traffic_stopped&&!isMaster(user,env))return json({error:'このアカウントの通信は停止されています。'},423);
      if(path==='/presence'&&request.method==='POST'){
        const body=await requestJson(request);
        if(typeof body.tabId!=='string'||!/^[a-f0-9]{32}$/.test(body.tabId)||typeof body.visible!=='boolean')return json({error:'閲覧状態の形式が不正です。'},400);
        if(body.visible){
          const page=typeof body.page==='string'?body.page.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,64):'';
          const title=typeof body.title==='string'?body.title.replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,120):'';
          await env.DB.prepare('INSERT INTO account_presence(user_id,tab_id,last_seen,page,title) VALUES(?,?,?,?,?) ON CONFLICT(user_id,tab_id) DO UPDATE SET last_seen=excluded.last_seen,page=excluded.page,title=excluded.title').bind(user.id,body.tabId,Date.now(),page,title).run();
          if(Math.random()<0.01)await env.DB.prepare('DELETE FROM account_presence WHERE last_seen<?').bind(Date.now()-86400000).run();
        }else await env.DB.prepare('DELETE FROM account_presence WHERE user_id=? AND tab_id=?').bind(user.id,body.tabId).run();
        return json({ok:true});
      }
      if(path==='/admin/releases'&&request.method==='GET'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const latest=await env.DB.prepare("SELECT version,published_at,checked_at FROM client_releases WHERE channel='gas'").bind().first();
        const devices=await env.DB.prepare('SELECT u.username,d.device_id,d.version,d.applied_at,d.last_seen,d.last_error FROM device_releases d JOIN users u ON u.id=d.user_id ORDER BY d.last_seen DESC LIMIT 200').bind().all();return json({latest,devices:devices.results||[]});
      }
      if(path==='/visual-mode'&&request.method==='GET'){
        const row=await env.DB.prepare('SELECT mode FROM account_visual_modes WHERE user_id=?').bind(user.id).first();
        return json({mode:row?.mode||'off'});
      }
      if(path==='/telemetry'&&request.method==='POST'){
        const auth=request.headers.get('authorization')||'';
        if(!env.API_SHARED_SECRET||auth!=='Bearer '+env.API_SHARED_SECRET)return json({error:'許可されていません。'},403);
        const body=await requestJson(request);
        const route=typeof body.route==='string'&&/^\/api\/[a-z0-9/:_-]{1,90}$/.test(body.route)?body.route:null;
        const method=typeof body.method==='string'&&['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(body.method)?body.method:null;
        if(!route||!method||!Number.isInteger(body.status)||body.status<100||body.status>599||!Number.isFinite(body.durationMs))return json({error:'ログ形式が不正です。'},400);
        const now=Date.now();
        await env.DB.prepare('INSERT INTO account_request_logs(user_id,at,route,method,status,duration_ms) VALUES(?,?,?,?,?,?)').bind(user.id,now,route,method,body.status,Math.max(0,Math.min(60000,Math.round(body.durationMs)))).run();
        if(Math.random()<0.02)await env.DB.prepare('DELETE FROM account_request_logs WHERE at<?').bind(now-7*86400000).run();
        return json({ok:true});
      }
      if(path==='/admin/system-monitor'&&(request.method==='GET'||request.method==='POST')){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        if(request.method==='GET'){
          const state=await env.DB.prepare('SELECT enabled,updated_at FROM system_monitor_settings WHERE id=1').first();
          return json({enabled:state?.enabled===1,updatedAt:state?.updated_at||0});
        }
        const body=await requestJson(request);
        if(typeof body.enabled!=='boolean')return json({error:'有効・無効の指定が不正です。'},400);
        const updatedAt=Date.now();
        await env.DB.prepare('INSERT INTO system_monitor_settings(id,enabled,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at')
          .bind(body.enabled?1:0,updatedAt).run();
        return json({ok:true,enabled:body.enabled,updatedAt});
      }
      if(path==='/admin/system-logs'&&request.method==='GET'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const userId=url.searchParams.get('userId')||'';
        if(userId&&!/^[0-9a-f-]{36}$/.test(userId))return json({error:'ユーザー指定が不正です。'},400);
        const rawAfter=url.searchParams.get('after')||'0';
        if(!/^\d{1,15}$/.test(rawAfter))return json({error:'ログ位置が不正です。'},400);
        const after=Math.max(0,Math.floor(Number(rawAfter)));
        const errorsOnly=url.searchParams.get('errors')==='1';
        const conditions=['logs.at>=?'],values=[Date.now()-7*86400000];
        if(after){conditions.push('logs.id>?');values.push(after);}
        if(userId){conditions.push('logs.user_id=?');values.push(userId);}
        if(errorsOnly)conditions.push('logs.status>=400');
        const direction=after?'ASC':'DESC';
        const sql='SELECT logs.id,logs.at,logs.route,logs.method,logs.status,logs.duration_ms,logs.user_id,users.username FROM system_request_logs logs LEFT JOIN users ON users.id=logs.user_id WHERE '+conditions.join(' AND ')+' ORDER BY logs.id '+direction+' LIMIT 150';
        const result=await env.DB.prepare(sql).bind(...values).all();
        const logs=result.results||[];
        if(!after)logs.reverse();
        return json({logs,nextAfter:logs.at(-1)?.id||after});
      }
      if(path==='/admin/logs'&&request.method==='GET'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const targetId=url.searchParams.get('userId')||'';
        if(!/^[0-9a-f-]{36}$/.test(targetId))return json({error:'ユーザー指定が不正です。'},400);
        const after=Math.max(0,Math.min(Number(url.searchParams.get('after')||0)||0,Date.now()));
        const result=await env.DB.prepare('SELECT id,at,route,method,status,duration_ms FROM account_request_logs WHERE user_id=? AND id>? ORDER BY id ASC LIMIT 150').bind(targetId,Math.floor(after)).all();
        return json({logs:result.results||[],nextAfter:result.results?.at(-1)?.id||Math.floor(after)});
      }
      if(path==='/admin/accounts'&&request.method==='GET'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const result=await env.DB.prepare("SELECT users.id,users.username,users.created_at,CASE WHEN account_master_grants.user_id IS NULL THEN 0 ELSE 1 END AS master_granted,COALESCE(account_controls.banned,0) AS banned,COALESCE(account_controls.traffic_stopped,0) AS traffic_stopped,COALESCE(SUM(account_usage.requests),0) AS requests,COALESCE(SUM(account_usage.videos),0) AS videos,COALESCE(SUM(account_usage.searches),0) AS searches,MAX(account_usage.last_seen) AS last_seen FROM users LEFT JOIN account_controls ON account_controls.user_id=users.id LEFT JOIN account_master_grants ON account_master_grants.user_id=users.id LEFT JOIN account_usage ON account_usage.user_id=users.id GROUP BY users.id ORDER BY users.created_at DESC").bind().all();
        const modes=await env.DB.prepare('SELECT user_id,mode FROM account_visual_modes').bind().all();
        const byId=new Map((modes.results||[]).map(row=>[row.user_id,row.mode]));
        // Only foreground tabs checked in within 90 seconds count as viewing.
        const active=await env.DB.prepare('SELECT user_id,page,title,last_seen FROM account_presence WHERE last_seen>=? ORDER BY last_seen DESC').bind(Date.now()-90000).all();
        const viewingByUser=new Map();
        for(const row of active.results||[])if(!viewingByUser.has(row.user_id))viewingByUser.set(row.user_id,row);
        return json({accounts:(result.results||[]).map(row=>({...row,is_master:isMaster(row,env),visual_mode:byId.get(row.id)||'off',viewing:viewingByUser.has(row.id),viewing_page:viewingByUser.get(row.id)?.page||'',viewing_title:viewingByUser.get(row.id)?.title||''}))});
      }
      const adminMatch=/^\/admin\/accounts\/([0-9a-f-]{36})$/.exec(path);
      if(adminMatch&&request.method==='POST'){
        if(!isMaster(user,env))return json({error:'見つかりません。'},404);
        const targetId=adminMatch[1],target=await env.DB.prepare('SELECT users.id,users.username,CASE WHEN account_master_grants.user_id IS NULL THEN 0 ELSE 1 END AS master_granted FROM users LEFT JOIN account_master_grants ON account_master_grants.user_id=users.id WHERE users.id=?').bind(targetId).first();
        if(!target)return json({error:'アカウントが見つかりません。'},404);
        const body=await requestJson(request),action=body.action;
        if(action==='visualMode'){
          if(isOwner(target))return json({error:'オーナーアカウントのモードは変更できません。'},403);
          if(!['off','chaos','chaos2','jelly','spin','quake','zero','mirror'].includes(body.mode))return json({error:'モードが無効です。'},400);
          await env.DB.prepare('INSERT INTO account_visual_modes(user_id,mode,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at').bind(targetId,body.mode,Date.now()).run();
          return json({ok:true,mode:body.mode});
        }
        if(action==='master'){
          // A delegated master may manage other accounts, but only Xerox0521 can create new masters.
          if(body.enabled===true&&!isOwner(user))return json({error:'マスター権限の付与はXerox0521のみ実行できます。'},403);
          if(target.id===user.id||isOwner(target))return json({error:'オーナーまたは自分自身の管理権限は変更できません。'},403);
          if(isOwner(target)||target.username===String(env.MASTER_USERNAME||'').trim().toLowerCase())return json({error:'初期マスターの権限は変更できません。'},400);
          if(body.enabled===true)await env.DB.prepare('INSERT OR IGNORE INTO account_master_grants(user_id,granted_by,granted_at) VALUES(?,?,?)').bind(targetId,user.id,Date.now()).run();
          else if(body.enabled===false)await env.DB.prepare('DELETE FROM account_master_grants WHERE user_id=?').bind(targetId).run();
          else return json({error:'権限設定が無効です。'},400);
          return json({ok:true,isMaster:body.enabled});
        }
        // Every master may lift an existing BAN/traffic stop regardless of who applied it.
        // Owner protection is absolute; other master accounts remain protected from new restrictions.
        const restoreOnly=(action==='ban'||action==='traffic')&&body.enabled===false;
        if(isOwner(target)||(isMaster(target,env)&&!restoreOnly))return json({error:'保護対象のアカウントは変更できません。'},403);
        if(action==='delete'){
          await env.DB.prepare('DELETE FROM account_visual_modes WHERE user_id=?').bind(targetId).run();
          await env.DB.prepare('DELETE FROM account_master_grants WHERE user_id=? OR granted_by=?').bind(targetId,targetId).run();
          for(const [sql,args] of [['DELETE FROM api_oauth_flows WHERE user_id LIKE ?',[`%:${targetId}%`]],['DELETE FROM account_usage WHERE user_id=?',[targetId]],['DELETE FROM account_presence WHERE user_id=?',[targetId]],['DELETE FROM account_controls WHERE user_id=?',[targetId]],['DELETE FROM history WHERE user_id=?',[targetId]],['DELETE FROM sessions WHERE user_id=?',[targetId]],['DELETE FROM users WHERE id=?',[targetId]]])await env.DB.prepare(sql).bind(...args).run();
          return json({ok:true});
        }
        if(action==='resetPassword'){
          if(!validPass(body.password))return json({error:'新しいパスワードは12文字以上にしてください。'},400);
          const salt=randomBytes(16).toString('hex');await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE id=?').bind(passHash(body.password,salt),salt,targetId).run();await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();return json({ok:true});
        }
        if(action==='ban'||action==='traffic'){
          const column=action==='ban'?'banned':'traffic_stopped',enabled=body.enabled?1:0;
          await env.DB.prepare(`INSERT INTO account_controls(user_id,${column},updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`).bind(targetId,enabled,Date.now()).run();
          if(action==='ban'&&!enabled){try{await env.DB.prepare('DELETE FROM login_attempts WHERE key=? OR key LIKE ?').bind('abuse-penalty:'+targetId,'youtube-rate:%:'+targetId).run();}catch(error){console.warn('Post-unban rate-limit cleanup failed:',error instanceof Error?error.message:'unknown');}}
          // Keep a banned account's session only so every device can receive the
          // explicit BAN response and persist its lock screen. All account data
          // routes remain blocked above. Traffic stops still revoke sessions.
          if(enabled&&action==='traffic'){try{await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(targetId).run();}catch(error){console.warn('Traffic session cleanup failed:',error instanceof Error?error.message:'unknown');}}
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
