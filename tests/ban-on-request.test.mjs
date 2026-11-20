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
