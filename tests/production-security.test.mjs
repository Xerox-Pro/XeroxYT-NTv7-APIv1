import test from 'node:test';import assert from 'node:assert/strict';import {createHmac}from'node:crypto';
import {privateIdentity}from'../cloudflare/api/private-api.mjs';import worker from'../cloudflare/api/worker.mjs';
import {requestJson}from'../cloudflare/security/http.mjs';import {privateRateLimit}from'../cloudflare/api/private-rate-limit.mjs';
const secret='test-only-production-hardening-key',origin='https://site.test';
test('even valid signatures cannot authorize malformed ticket expiry or session identities',async()=>{
 let queries=0;const env={API_SHARED_SECRET:secret,DB:{prepare(){queries++;throw Error('invalid ticket reached database');}}};
 for(const value of [{session:'a'.repeat(64),origin},{session:'a'.repeat(64),origin,exp:'tomorrow'},{session:'not-a-hash',origin,exp:Date.now()+10000}]){
  const body=Buffer.from(JSON.stringify(value)).toString('base64url'),mac=createHmac('sha256',secret).update('cf-private-v1:'+body).digest('base64url');
  assert.equal(await privateIdentity(new Request('https://api.test/api/auth/status',{headers:{origin,authorization:'XYT '+body+'.'+mac}}),env),null);
 }assert.equal(queries,0);
});
test('request parsing rejects invalid JSON, arrays and chunked oversize bodies',async()=>{
 for(const body of ['{','null','[]'])await assert.rejects(requestJson(new Request('https://api.test',{method:'POST',body})),{status:400});
 const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(20));c.close();}});await assert.rejects(requestJson(new Request('https://api.test',{method:'POST',body,duplex:'half'}),10),{status:413});
});
test('rejected API requests still carry security headers and never reflect an untrusted origin',async()=>{
 const response=await worker.fetch(new Request('https://api.test/api/instagram/status',{headers:{Origin:'https://attacker.test'}}),{ALLOWED_ORIGINS:origin});
 assert.equal(response.status,403);assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.match(response.headers.get('Content-Security-Policy'),/default-src 'none'/);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
});
test('session import attempts have their own stricter atomic rate limit',async()=>{
 let count=0;const db={prepare(){return{bind(key){assert.match(key,/social-connect/);return{async first(){return{count:++count,window_start:Date.now()};}};}};}};
 for(let i=0;i<3;i++)assert.equal(await privateRateLimit(db,'alice','/api/instagram/unofficial/connect','POST'),null);
 assert.equal((await privateRateLimit(db,'alice','/api/instagram/unofficial/connect','POST')).status,429);
});
