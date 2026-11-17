import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import worker from '../cloudflare/auth/worker.mjs';import {TERMS_VERSION} from '../cloudflare/auth/terms.mjs';
test('registration needs explicit current consent, and existing accounts must accept before use',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));const db={prepare(sql){return{bind(...args){return{first:async()=>sqlite.prepare(sql).get(...args)||null,run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}})};}};}};
 const env={DB:db,ALLOWED_ORIGINS:'https://site.test'},credentials={username:'member',password:'a long password 123'};let cookie='';
 const send=(path,body)=>worker.fetch(new Request('https://worker.test/api/account'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://site.test','Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
 assert.equal((await send('/register',credentials)).status,428);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
 const registered=await send('/register',{...credentials,termsAccepted:true,termsVersion:TERMS_VERSION});assert.equal(registered.status,200);cookie=registered.headers.get('set-cookie').split(';')[0];assert.equal((await send('/history')).status,200);
 sqlite.prepare('DELETE FROM user_terms_acceptances').run();assert.equal((await send('/history')).status,428);assert.equal((await send('/dm')).status,428);
 assert.equal((await (await send('/terms')).json()).accepted,false);assert.equal((await send('/terms',{version:'old',accepted:true})).status,400);
 assert.equal((await send('/terms',{version:TERMS_VERSION,accepted:false})).status,400);assert.equal((await send('/terms',{version:TERMS_VERSION,accepted:true})).status,200);
 assert.equal((await send('/history')).status,200);const row=sqlite.prepare('SELECT * FROM user_terms_acceptances').get();assert.equal(row.version,TERMS_VERSION);assert.ok(row.accepted_at>0);
 await send('/terms',{version:TERMS_VERSION,accepted:true});assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_terms_acceptances').get().n,1);sqlite.close();
});
