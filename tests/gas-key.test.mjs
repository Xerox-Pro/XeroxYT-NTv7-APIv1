import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withGasKey} from '../cloudflare/api/gas-key.mjs';
import worker from '../cloudflare/api/worker.mjs';

test('the actual Worker entrypoint accepts the GAS key and retains key/origin rejection',async()=>{
 const env={API_SHARED_SECRET:'site-key',GAS_API_SHARED_SECRET:'gas-key',ALLOWED_ORIGINS:'https://site.test',REQUIRE_PROXY_SECRET:'true'};
 const request=(key,origin='https://script.google.com')=>new Request('https://api.test/api/account/session',{headers:{Origin:origin,Authorization:'Bearer '+key}});
 assert.equal((await worker.fetch(request('gas-key'),env,{})).status,401);
 assert.equal((await worker.fetch(request('wrong-key'),env,{})).status,403);
 assert.equal((await worker.fetch(request('gas-key','https://evil.test'),env,{})).status,403);
});

test('GAS-only key preserves existing credentials and rewrites only authenticated GAS traffic',async()=>{
 const calls=[];
 const wrapped=withGasKey({fetch:async(request,env)=>{calls.push({request,env});return new Response('ok');}});
 const env={API_SHARED_SECRET:'existing-site-key',GAS_API_SHARED_SECRET:'new-gas-key',ALLOWED_ORIGINS:'https://site.example.com'};
 const request=(key,origin='https://script.google.com')=>new Request('https://api.example.com/api/account/login',{method:'POST',headers:{Authorization:'Bearer '+key,Origin:origin,'Content-Type':'application/json',Cookie:'__Host-xy_session=abc'},body:'{"username":"test"}'});
 await wrapped.fetch(request('new-gas-key'),env,{});
 assert.equal(calls[0].request.headers.get('Authorization'),'Bearer existing-site-key');
 assert.equal(calls[0].request.headers.get('Origin'),'https://site.example.com');
 assert.equal(calls[0].request.headers.get('Cookie'),'__Host-xy_session=abc');
 assert.equal(await calls[0].request.text(),'{"username":"test"}');
 assert.equal(calls[0].env,env);
 const legacy=request('existing-site-key','https://site.example.com');
 await wrapped.fetch(legacy,env,{});assert.equal(calls[1].request,legacy);
 const wrong=request('wrong');await wrapped.fetch(wrong,env,{});assert.equal(calls[2].request,wrong);
 assert.equal((await wrapped.fetch(request('new-gas-key','https://other.example.com'),env,{})).status,403);
 assert.equal(calls.length,3);
 assert.equal(env.API_SHARED_SECRET,'existing-site-key');
});

test('valid GAS sessions renew server expiry and cookie; rejected sessions never renew',async()=>{
 const statements=[];let valid=true;
 const db={prepare(sql){return {bind(...args){return {first:async()=>({expires_at:Date.now()+1000}),run:async()=>{statements.push({sql,args});return {meta:{changes:1}};}};}};}};
 const env={API_SHARED_SECRET:'old',GAS_API_SHARED_SECRET:'gas',ALLOWED_ORIGINS:'https://site.example.com',DB:db};
 const wrapped=withGasKey({fetch:async()=>Response.json(valid?{user:{id:'one'}}:{error:'expired'},{status:valid?200:401})});
 const req=()=>new Request('https://api.example.com/api/account/session',{headers:{Authorization:'Bearer gas',Origin:'https://script.google.com',Cookie:'__Host-xy_session='+'a'.repeat(64)}});
 const response=await wrapped.fetch(req(),env,{});
 assert.match(response.headers.get('set-cookie'),/Max-Age=31536000/);assert.equal(statements.length,1);
 assert.ok(statements[0].args[0]>Date.now()+30000000000);assert.match(statements[0].args[1],/^[a-f0-9]{64}$/);
 valid=false;assert.equal((await wrapped.fetch(req(),env,{})).status,401);assert.equal(statements.length,1);
});
