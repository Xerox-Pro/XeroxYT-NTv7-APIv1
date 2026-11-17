import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../cloudflare/auth/worker.mjs';
import {TERMS_VERSION} from '../cloudflare/auth/terms.mjs';
test('announcement reads are authenticated, durable, idempotent and isolated per account',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../cloudflare/auth/schema.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return{results:sqlite.prepare(sql).all(...args)};},async run(){const result=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(result.changes)}};}};}};}};
 const send=(path,method='GET',data,cookie)=>worker.fetch(new Request('https://worker.test/api/account'+path,{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})}),{DB,ALLOWED_ORIGINS:'https://example.test'});
 try{
 assert.equal((await send('/announcements')).status,401);
 const register=async username=>{const res=await send('/register','POST',{username,password:'secure password 123',termsAccepted:true,termsVersion:TERMS_VERSION});assert.equal(res.status,200);return res.headers.get('set-cookie').split(';')[0];};
 const alice=await register('alice_notice'),bob=await register('bob_notice');
 const list=async cookie=>(await(await send('/announcements','GET',undefined,cookie)).json()).announcements;
 const initial=await list(alice);assert.ok(initial.length>=4);assert.ok(initial.every(item=>item.readAt===null));
 const id=initial[0].id;
 const res=await send('/announcements/read','POST',{id,user_id:'bob_notice'},alice);assert.equal(res.status,200);const {readAt}=await res.json();assert.ok(readAt>0);
 assert.equal((await list(alice))[0].readAt,readAt);assert.equal((await list(bob))[0].readAt,null);
 assert.equal((await(await send('/announcements/read','POST',{id},alice)).json()).readAt,readAt);
 assert.equal((await send('/announcements/read','POST',{id:'unknown'},alice)).status,404);
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM user_announcement_reads').get().n,1);
 }finally{sqlite.close();}
});
