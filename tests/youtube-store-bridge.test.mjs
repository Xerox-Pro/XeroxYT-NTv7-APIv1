import test from 'node:test';import assert from 'node:assert/strict';
import worker from '../cloudflare/api/worker.mjs';import {createRemoteYouTubeStore} from '../youtube-store-bridge.mjs';
test('the encrypted store bridge is server-only, persistent and isolates keys',async()=>{
 const rows=new Map();const DB={prepare(sql){return {bind(...args){return {first:async()=>{const row=rows.get(args[0]);return row&&row.expires>args[1]?{data:JSON.stringify(row)}:null;},run:async()=>{if(sql.startsWith('INSERT'))rows.set(args[0],JSON.parse(args[1]));else rows.delete(args[0]);}};}};}};
 const env={DB,ACCOUNT_API_URL:'https://worker.test',ALLOWED_ORIGINS:'https://site.test',API_SHARED_SECRET:'server-test-secret-12345',REQUIRE_PROXY_SECRET:'true'};
 const store=createRemoteYouTubeStore(env,(input,init)=>worker.fetch(new Request(input,init),env));
 const value={flow:{iv:'iv',data:'encrypted-only',tag:'tag'},expires:Date.now()+60000};await store.set('youtube:alice',value);assert.deepEqual(await store.get('youtube:alice'),value);assert.equal(await store.get('youtube:bob'),undefined);await store.delete('youtube:alice');assert.equal(await store.get('youtube:alice'),undefined);
 const request=(headers,body)=>new Request('https://worker.test/internal/youtube-store',{method:'POST',headers:{Origin:'https://site.test','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await worker.fetch(request({}, {operation:'get',key:'youtube:alice'}),env)).status,403);
 assert.equal((await worker.fetch(request({Authorization:'Bearer '+env.API_SHARED_SECRET},{operation:'get',key:'youtube:alice'}),env)).status,404);
 assert.equal((await worker.fetch(request({'X-XeroxYT-Internal':'youtube-store'},{operation:'get',key:'youtube:alice'}),{...env,REQUIRE_PROXY_SECRET:'false'})).status,403);
 await assert.rejects(store.set('youtube:alice',{flow:{access_token:'plaintext'},expires:Date.now()+60000}),/保存先/);
 await assert.rejects(store.get('users:alice'),/保存先/);
});
test('public API requests still stream to Node without replaying requests',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async request=>{calls++;assert.equal(new URL(request.url).hostname,'xeroxyt-ntv6-apiv1.vercel.app');assert.equal(request.method,'POST');assert.equal(await request.text(),'{"action":"like"}');return Response.json({success:true});};
 try{const response=await worker.fetch(new Request('https://worker.test/api/channels/batch',{method:'POST',headers:{Origin:'https://site.test',Authorization:'Bearer server-test-secret'},body:'{"action":"like"}'}),{ALLOWED_ORIGINS:'https://site.test',API_SHARED_SECRET:'server-test-secret'});assert.equal(response.status,200);assert.equal(response.headers.get('x-xeroxyt-proxy'),'cloudflare');assert.equal(calls,1);}finally{globalThis.fetch=old;}
});

test('Google endpoints never forward to Node, including mutations and failed auth',async()=>{const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not forward');};try{for(const path of ['/api/auth/status','/api/auth/signin','/api/user/feed/home','/api/user/action']){const r=await worker.fetch(new Request('https://worker.test'+path,{method:path.endsWith('signin')||path.endsWith('action')?'POST':'GET',headers:{Origin:'https://site.test',Authorization:'Bearer server-test-secret'}}),{ALLOWED_ORIGINS:'https://site.test',API_SHARED_SECRET:'server-test-secret'});assert.equal(r.status,401);}assert.equal(calls,0);}finally{globalThis.fetch=old;}});
