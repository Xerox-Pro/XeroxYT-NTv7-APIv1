import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {TERMS_VERSION} from '../cloudflare/auth/terms.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/api/worker.mjs';

const origin = 'https://app.example';
const apiKey = 'test-proxy-key';
const env = {ALLOWED_ORIGINS:origin, API_SHARED_SECRET:apiKey};
const makeRequest = (path, options = {}) => new Request('https://worker.example' + path, {
 ...options,
 headers:{Origin:origin, Authorization:'Bearer ' + apiKey, ...options.headers},
});

test('a banned session receives only the BAN error on its next data or account request', async () => {
 const db = {prepare(sql) {
  assert.match(sql, /FROM sessions JOIN users/);
  return {bind(){ return {first:async()=>({id:'banned-id',banned:1})}; }};
 }};
 for (const path of ['/api/recommendations','/api/user/feed/home','/api/account/session','/api/account/dm','/stream/abc123']) {
  const request = makeRequest(path, {headers:{Cookie:'__Host-xy_session=' + 'a'.repeat(64)}});
  const response = await worker.fetch(request, {...env,DB:db});
  assert.equal(response.status,403);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['banned','code','error']);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }
});

test('first registration succeeds, repeat and banned browsers cannot register', async () => {
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../cloudflare/auth/schema.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../cloudflare/auth/migrations/2026-11-20-registration-device.sql',import.meta.url),'utf8'));
 const db = {prepare(sql){return {bind(...args){return {
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>({meta:{changes:sqlite.prepare(sql).run(...args).changes}}),
 };}};}};
 const register = (username, device) => worker.fetch(makeRequest('/api/account/register',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({username,device,password:'test password 123',termsAccepted:true,termsVersion:TERMS_VERSION}),
 }),{...env,DB:db});
 const device = 'f'.repeat(32);
 const first = await register('fresh_member',device);
 assert.equal(first.status,200);
 assert.equal((await (await register('second_member',device)).json()).code,'DEVICE_ALREADY_REGISTERED');
 const user = (await first.json()).user;
 sqlite.prepare('INSERT INTO account_controls(user_id,banned,updated_at) VALUES(?,1,0)').run(user.id);
 assert.equal((await (await register('third_member',device)).json()).code,'ACCOUNT_BANNED');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM users').get().total,1);
 sqlite.close();
});

test('ordinary session requests update last communication without client polling', async () => {
 const writes = [], pending = [];
 const db = {prepare(sql) {
  if (sql.includes("FROM system_monitor_settings")) return {first:async()=>null};
  return {bind(...args){return {
   first:async()=>sql.includes('FROM sessions JOIN users')?{id:'active-user',username:'alice'}:null,
   run:async()=>writes.push({sql,args}),
  }; }};
 }};
 const ctx = {waitUntil(promise){pending.push(promise);}};
 for (let i = 0; i < 2; i++) {
  const response = await worker.fetch(makeRequest('/api/account/session', {
   headers:{Cookie:'__Host-xy_session=' + 'b'.repeat(64)},
  }), {...env, DB:db}, ctx);
  assert.equal(response.status,200);
 }
 await Promise.all(pending);
 assert.equal(writes.length,1);
 assert.match(writes[0].sql,/UPDATE SET last_seen=MAX/);
 assert.equal(writes[0].args[0],'active-user');
 assert.ok(Number.isFinite(writes[0].args[2]));
});
