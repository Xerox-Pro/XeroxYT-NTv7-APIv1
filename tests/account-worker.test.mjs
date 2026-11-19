import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloudflare/auth/worker.mjs';
import {TERMS_VERSION} from '../cloudflare/auth/terms.mjs';

function createTestDb(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../cloudflare/auth/schema.sql',import.meta.url),'utf8'));
 for(const name of ['2026-11-17-visual-modes.sql','2026-11-19-master-grants.sql','2026-11-19-request-logs.sql','2026-11-19-account-presence.sql']){
  sqlite.exec(readFileSync(new URL('../cloudflare/auth/migrations/'+name,import.meta.url),'utf8'));
 }
 sqlite.exec(`
  CREATE TABLE IF NOT EXISTS account_controls(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,banned INTEGER NOT NULL DEFAULT 0,traffic_stopped INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS account_usage(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,day TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,videos INTEGER NOT NULL DEFAULT 0,searches INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,PRIMARY KEY(user_id,day));
 `);
 return sqlite;
}

test('registration, login, isolation, history and logout', async () => {
  const sqlite = createTestDb();
  const db = { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, async all(){return {results:sqlite.prepare(sql).all(...args)};} }; } }; } };
  const env = { DB: db, ALLOWED_ORIGINS: 'https://example.test' };
  const send = (path, method = 'GET', data, session, origin = 'https://example.test') => worker.fetch(new Request(`https://worker.test/api/account${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  const credentials = { username: 'alice', password: 'a secure password',termsAccepted:true,termsVersion:TERMS_VERSION };
  let res = await send('/register', 'POST', credentials);
  assert.equal(res.status, 200);
  const session = res.headers.get('set-cookie').split(';')[0];
  assert.match(session, /^__Host-xy_session=/);
  assert.equal((await send('/history', 'GET')).status, 401);
  assert.equal((await send('/history', 'PUT', { history: [{videoId: 'one'}], version: 0 }, session)).status, 200);
  assert.equal((await send('/history', 'PUT', { history: [], version: 0 }, session)).status, 409);
  res = await send('/history', 'GET', undefined, session);
  assert.equal((await res.json()).history[0].videoId, 'one');
  res = await send('/register', 'POST', { username: 'bob', password: 'another password',termsAccepted:true,termsVersion:TERMS_VERSION });
  const bob = res.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await (await send('/history', 'GET', undefined, bob)).json()).history, []);
  assert.equal((await send('/logout', 'POST', {}, session, 'https://evil.test')).status, 403);
  assert.equal((await send('/logout', 'POST', {}, session)).status, 200);
  assert.equal((await send('/session', 'GET', undefined, session)).status, 401);
  assert.equal((await send('/login', 'POST', { ...credentials, password: 'incorrect password' })).status, 401);
  assert.equal((await send('/login', 'POST', credentials)).status, 200);
  sqlite.close();
});

test('only Xerox0521 can manage unique accounts, usage, passwords, traffic and bans',async()=>{
 const sqlite=createTestDb();
 const db={prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const r=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:sqlite.prepare(sql).all(...args)};}};}};}};
 const env={DB:db,ALLOWED_ORIGINS:'https://example.test',MASTER_USERNAME:'xerox0521'};
 const send=(path,method='GET',data,session,usagePath)=>worker.fetch(new Request(`https://worker.test/api/account${path}`,{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...(session?{Cookie:session}:{}),...(usagePath?{'X-Account-Usage-Path':usagePath}:{})},...(data?{body:JSON.stringify(data)}:{})}),env);
 const register=async(username,password)=>{const response=await send('/register','POST',{username,password,termsAccepted:true,termsVersion:TERMS_VERSION});return{response,session:response.headers.get('set-cookie')?.split(';')[0]};};
 const master=await register('Xerox0521','master password 123');assert.equal(master.response.status,200);assert.equal((await master.response.clone().json()).user.admin,true);
 const member=await register('Member_One','member password 123');assert.equal(member.response.status,200);
 assert.equal((await register('MEMBER_ONE','different password 123')).response.status,409,'case variants must not create a duplicate identity');
 await send('/session','GET',undefined,member.session,'/api/video/abcdefghijk');
 let list=await (await send('/admin/accounts','GET',undefined,master.session)).json();const row=list.accounts.find(item=>item.username==='member_one');assert.equal(row.requests,1);assert.equal(row.videos,1);
 assert.equal((await send('/admin/accounts','GET',undefined,member.session)).status,404);
 assert.equal((await (await send('/visual-mode','GET',undefined,member.session)).json()).mode,'off');
 assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'visualMode',mode:'chaos'},member.session)).status,404);
 assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'visualMode',mode:'invalid'},master.session)).status,400);
 for(const mode of ['chaos','chaos2','jelly','off']){
  assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'visualMode',mode},master.session)).status,200);
  assert.equal((await (await send('/visual-mode','GET',undefined,member.session)).json()).mode,mode);
  assert.equal((await (await send('/visual-mode','GET',undefined,master.session)).json()).mode,'off','mode changes must be isolated to the selected user');
  const updated=await (await send('/admin/accounts','GET',undefined,master.session)).json();assert.equal(updated.accounts.find(item=>item.id===row.id).visual_mode,mode);
 }
 assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'traffic',enabled:true},master.session)).status,200);assert.equal((await send('/login','POST',{username:'member_one',password:'member password 123'})).status,423);
 await send('/admin/accounts/'+row.id,'POST',{action:'traffic',enabled:false},master.session);
 await send('/admin/accounts/'+row.id,'POST',{action:'resetPassword',password:'replacement password 123'},master.session);assert.equal((await send('/login','POST',{username:'member_one',password:'member password 123'})).status,401);const activeLogin=await send('/login','POST',{username:'member_one',password:'replacement password 123'});assert.equal(activeLogin.status,200);const activeSession=activeLogin.headers.get('set-cookie').split(';')[0];
 await send('/admin/accounts/'+row.id,'POST',{action:'ban',enabled:true},master.session);const bannedLogin=await send('/login','POST',{username:'member_one',password:'replacement password 123'});assert.equal(bannedLogin.status,403);assert.equal((await bannedLogin.json()).code,'ACCOUNT_BANNED');const bannedSession=await send('/session','GET',undefined,activeSession);assert.equal(bannedSession.status,403);assert.equal((await bannedSession.json()).code,'ACCOUNT_BANNED');
 assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'ban',enabled:false},master.session)).status,200,'unban write must succeed');assert.equal((await send('/session','GET',undefined,activeSession)).status,200,'existing session must recover after BAN removal');const restored=await (await send('/admin/accounts','GET',undefined,master.session)).json();assert.equal(restored.accounts.find(item=>item.id===row.id).banned,0,'admin listing must reflect BAN removal');assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'delete'},master.session)).status,200);assert.equal((await send('/login','POST',{username:'member_one',password:'replacement password 123'})).status,401);
 sqlite.close();
});

test('only Xerox0521 may grant master access, even when caller is already a master',async()=>{
 const sqlite=createTestDb();
 const db={prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const r=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:sqlite.prepare(sql).all(...args)};}};}};}};
 const env={DB:db,ALLOWED_ORIGINS:'https://example.test',MASTER_USERNAME:'xerox0521'};
 const send=(path,method='GET',data,session)=>worker.fetch(new Request('https://worker.test/api/account'+path,{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...(session?{Cookie:session}:{})},...(data?{body:JSON.stringify(data)}:{})}),env);
 const register=async(username)=>{const response=await send('/register','POST',{username,password:'secure test password 123',termsAccepted:true,termsVersion:TERMS_VERSION});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
 const owner=await register('Xerox0521'),delegate=await register('delegated_master'),member=await register('regular_member');
 const list=await (await send('/admin/accounts','GET',undefined,owner)).json();
 const delegateId=list.accounts.find(row=>row.username==='delegated_master').id;
 const memberId=list.accounts.find(row=>row.username==='regular_member').id;
 const path=id=>'/admin/accounts/'+id;
 assert.equal((await send(path(delegateId),'POST',{action:'master',enabled:true},owner)).status,200);
 assert.equal((await (await send('/session','GET',undefined,delegate)).json()).user.admin,true);
 assert.equal((await send('/admin/accounts','GET',undefined,delegate)).status,200,'delegated master can list accounts');
 assert.equal((await send(path(memberId),'POST',{action:'visualMode',mode:'chaos'},delegate)).status,200,'delegated master can set visual mode');
 assert.equal((await (await send('/visual-mode','GET',undefined,member)).json()).mode,'chaos');
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:true},delegate)).status,200,'delegated master can ban regular accounts');
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:false},delegate)).status,200,'delegated master can unban regular accounts');
 assert.equal((await send(path(memberId),'POST',{action:'traffic',enabled:true},delegate)).status,200,'delegated master can stop traffic');
 assert.equal((await send(path(memberId),'POST',{action:'traffic',enabled:false},delegate)).status,200,'delegated master can restore traffic');
 const denied=await send(path(memberId),'POST',{action:'master',enabled:true},delegate);
 assert.equal(denied.status,403,'delegated master must not grant another master');
 assert.match((await denied.json()).error,/Xerox0521/);
 let accounts=await (await send('/admin/accounts','GET',undefined,owner)).json();
 assert.equal(accounts.accounts.find(row=>row.id===memberId).is_master,false);
 // Cross-master recovery: the actor who imposed the restriction is irrelevant.
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:true},delegate)).status,200);
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:false},owner)).status,200,'owner can undo a delegated master BAN');
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:true},owner)).status,200);
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:false},delegate)).status,200,'delegated master can undo owner BAN');
 // Even if a previously banned user later becomes master, recovery must remain possible.
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:true},delegate)).status,200);
 assert.equal((await send(path(memberId),'POST',{action:'traffic',enabled:true},delegate)).status,200);
 assert.equal((await send(path(memberId),'POST',{action:'master',enabled:true},owner)).status,200);
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:false},delegate)).status,200,'any master can unban a master account');
 assert.equal((await send(path(memberId),'POST',{action:'traffic',enabled:false},delegate)).status,200,'any master can restore a master account');
 assert.equal((await send(path(memberId),'POST',{action:'ban',enabled:true},delegate)).status,403,'other masters remain protected from new bans');
 accounts=await (await send('/admin/accounts','GET',undefined,owner)).json();
 assert.equal(accounts.accounts.find(row=>row.id===memberId).is_master,true);
 assert.equal((await send(path(memberId),'POST',{action:'master',enabled:false},delegate)).status,200,'existing delegated revoke permissions remain unchanged');
 assert.equal((await send(path(memberId),'POST',{action:'master',enabled:true},member)).status,404,'regular member cannot grant');
 assert.notEqual((await send(path(list.accounts.find(row=>row.username==='xerox0521').id),'POST',{action:'master',enabled:false},delegate)).status,200,'owner cannot be revoked');
 sqlite.close();
});

test('presence tracks visible tabs separately and admins can see current viewers',async()=>{
 const sqlite=createTestDb();
 const db={prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const r=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:sqlite.prepare(sql).all(...args)};}};}};}};
 const env={DB:db,ALLOWED_ORIGINS:'https://example.test',MASTER_USERNAME:'xerox0521'};
 const send=(path,method='GET',data,session)=>worker.fetch(new Request('https://worker.test/api/account'+path,{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...(session?{Cookie:session}:{})},...(data?{body:JSON.stringify(data)}:{})}),env);
 const register=async(username)=>{const response=await send('/register','POST',{username,password:'secure test password 123',termsAccepted:true,termsVersion:TERMS_VERSION});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];};
 const owner=await register('Xerox0521'),member=await register('viewer_member');
 const tabA='a'.repeat(32),tabB='b'.repeat(32);
 const viewing=async()=>{const response=await send('/admin/accounts','GET',undefined,owner);assert.equal(response.status,200);return (await response.json()).accounts.find(row=>row.username==='viewer_member').viewing;};
 assert.equal(await viewing(),false);
 assert.equal((await send('/presence','POST',{tabId:tabA,visible:true},member)).status,200);
 assert.equal(await viewing(),true);
 assert.equal((await send('/presence','POST',{tabId:tabB,visible:true},member)).status,200);
 assert.equal((await send('/presence','POST',{tabId:tabA,visible:false},member)).status,200);
 assert.equal(await viewing(),true,'closing one tab must not hide another visible tab');
 assert.equal((await send('/presence','POST',{tabId:tabB,visible:false},member)).status,200);
 assert.equal(await viewing(),false);
 assert.equal((await send('/session?presence='+tabA,'GET',undefined,member)).status,200);
 assert.equal(await viewing(),true,'session verification refreshes presence');
 assert.equal((await send('/presence','POST',{tabId:'invalid',visible:true},member)).status,400);
 sqlite.close();
});
