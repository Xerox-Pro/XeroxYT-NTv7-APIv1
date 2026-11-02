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
  return db.prepare('SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').bind(hash(token), Date.now()).first();
}
async function startSession(db, user) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(hash(token), user.id, Date.now() + MAX_AGE * 1000).run();
  return json({ user: { id: user.id, username: user.username } }, 200, { 'Set-Cookie': cookie(token) });
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
        return user ? json({ user }) : json({ error: 'ログインが必要です。' }, 401);
      }
      if (request.method === 'POST' && (path === '/register' || path === '/login')) {
        const body = await request.json();
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
          return startSession(env.DB, user);
        }
        const user = await env.DB.prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ?').bind(username).first();
        const actual = passHash(password, user?.password_salt || '00000000000000000000000000000000');
        const expected = user?.password_hash || '0'.repeat(64);
        if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')) || !user) return json({ error: 'ユーザー名またはパスワードが違います。' }, 401);
        return startSession(env.DB, user);
      }
      const user = await currentUser(request, env.DB);
      if (!user) return json({ error: 'ログインが必要です。' }, 401);
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
        const body = await request.json();
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
      console.error('account request failed', err);
      return json({ error: '処理に失敗しました。時間をおいてお試しください。' }, 500);
    }
  }
};
