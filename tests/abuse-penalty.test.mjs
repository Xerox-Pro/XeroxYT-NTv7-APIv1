import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {privateRateLimit} from '../cloudflare/api/private-rate-limit.mjs';
test('excess traffic gets one timeout, blocked requests do not add strikes, recurrence bans',async()=>{
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 sql.prepare('INSERT INTO users(id,username,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)').run('alice','alice','hash','salt',1);
 const db={prepare(query){return{bind(...args){return{async first(){return sql.prepare(query).get(...args)||null;},async run(){return sql.prepare(query).run(...args);}};}};}};
 const now=100000000;let response;
 for(let i=0;i<361;i++)response=await privateRateLimit(db,'alice','/api/user/feed/home','GET',now);
 assert.equal((await response.json()).code,'ACCOUNT_TIMEOUT');
 for(let i=0;i<5;i++)assert.equal((await privateRateLimit(db,'alice','/api/user/feed/home','GET',now+1)).status,429);
 assert.equal(sql.prepare('SELECT count FROM login_attempts WHERE key=?').get('abuse-penalty:alice').count,1);
 for(let i=0;i<361;i++)response=await privateRateLimit(db,'alice','/api/user/feed/home','GET',now+600001);
 assert.equal((await response.json()).code,'ACCOUNT_BANNED');assert.equal(sql.prepare('SELECT banned FROM account_controls WHERE user_id=?').get('alice').banned,1);sql.close();
});
