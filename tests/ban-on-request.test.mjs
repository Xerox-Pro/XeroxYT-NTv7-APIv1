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

test('registration is disabled before reading or writing account data', async () => {
 const request = makeRequest('/api/account/register', {
  method:'POST', headers:{'Content-Type':'application/json'}, body:'{}',
 });
 const response = await worker.fetch(request, env);
 assert.equal(response.status,403);
 assert.equal((await response.json()).code,'REGISTRATION_DISABLED');
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
