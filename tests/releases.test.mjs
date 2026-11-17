import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {latestRelease,clientRelease,releaseConfig} from '../cloudflare/auth/releases.mjs';
test('Cloudflare tracks canonical releases and per-account device application times',async()=>{
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const id of ['alice','bob'])sqlite.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,id,'hash','salt',1);
 const db={prepare(sql){return{bind(...args){return{first:async()=>sqlite.prepare(sql).get(...args)||null,run:async()=>sqlite.prepare(sql).run(...args)};}};}};
 const manifest={version:1,entry:'app-new.js',css:'style-new.css',revision:'a'.repeat(40),serverHash:'b'.repeat(64),publishedAt:1700000000000,source:'c'.repeat(40)};
 let calls=0;const fetcher=async()=>{calls++;return Response.json(manifest);};
 const release=await latestRelease({DB:db},fetcher);assert.equal(release.publishedAt,manifest.publishedAt);assert.ok(release.base.includes(manifest.revision));assert.equal(calls,1);
 await latestRelease({DB:db},fetcher);assert.equal(calls,1,'fresh registry is cached');
 const beforeFetch=globalThis.fetch,beforeNow=Date.now;let now=Date.now();Date.now=()=>now;globalThis.fetch=fetcher;
 try{
  const send=(user,version)=>clientRelease(new Request('https://worker.test/api/account/client-release',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId:'d'.repeat(64),version})}),{DB:db},user&&{id:user});
  assert.equal((await send(null,'old')).status,401);
  assert.equal((await send('alice','old')).status,200);const first=sqlite.prepare('SELECT * FROM device_releases WHERE user_id=?').get('alice');now+=5000;
  await send('alice','old');assert.equal(sqlite.prepare('SELECT applied_at FROM device_releases WHERE user_id=?').get('alice').applied_at,first.applied_at);
  await send('alice',release.version);assert.equal(sqlite.prepare('SELECT applied_at FROM device_releases WHERE user_id=?').get('alice').applied_at,now);
  await send('bob','old');assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM device_releases').get().count,2);
  now+=31000;const stale=await latestRelease({DB:db},async()=>{throw Error('offline');});assert.equal(stale.stale,true);assert.equal(stale.version,release.version);
 }finally{Date.now=beforeNow;globalThis.fetch=beforeFetch;sqlite.close();}
 assert.throws(()=>releaseConfig({...manifest,entry:'https://evil.test/app.js'},'example/app'));
});
