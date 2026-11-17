import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloudflare/auth/worker.mjs';

test('registration, login, isolation, history and logout', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/auth/schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { return { async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; }, async all(){return {results:sqlite.prepare(sql).all(...args)};} }; } }; } };
  const env = { DB: db, ALLOWED_ORIGINS: 'https://example.test' };
  const send = (path, method = 'GET', data, session, origin = 'https://example.test') => worker.fetch(new Request(`https://worker.test/api/account${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  const credentials = { username: 'alice', password: 'a secure password' };
  let res = await send('/register', 'POST', credentials);
  assert.equal(res.status, 200);
  const session = res.headers.get('set-cookie').split(';')[0];
  assert.match(session, /^__Host-xy_session=/);
  assert.equal((await send('/history', 'GET')).status, 401);
  assert.equal((await send('/history', 'PUT', { history: [{videoId: 'one'}], version: 0 }, session)).status, 200);
  assert.equal((await send('/history', 'PUT', { history: [], version: 0 }, session)).status, 409);
  res = await send('/history', 'GET', undefined, session);
  assert.equal((await res.json()).history[0].videoId, 'one');
  res = await send('/register', 'POST', { username: 'bob', password: 'another password' });
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
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../cloudflare/auth/schema.sql',import.meta.url),'utf8'));
 const db={prepare(sql){return{bind(...args){return{async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){const r=sqlite.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async all(){return{results:sqlite.prepare(sql).all(...args)};}};}};}};
 const env={DB:db,ALLOWED_ORIGINS:'https://example.test',MASTER_USERNAME:'xerox0521'};
 const send=(path,method='GET',data,session,usagePath)=>worker.fetch(new Request(`https://worker.test/api/account${path}`,{method,headers:{Origin:'https://example.test','Content-Type':'application/json',...(session?{Cookie:session}:{}),...(usagePath?{'X-Account-Usage-Path':usagePath}:{})},...(data?{body:JSON.stringify(data)}:{})}),env);
 const register=async(username,password)=>{const response=await send('/register','POST',{username,password});return{response,session:response.headers.get('set-cookie')?.split(';')[0]};};
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
 await send('/admin/accounts/'+row.id,'POST',{action:'ban',enabled:false},master.session);assert.equal((await send('/admin/accounts/'+row.id,'POST',{action:'delete'},master.session)).status,200);assert.equal((await send('/login','POST',{username:'member_one',password:'replacement password 123'})).status,401);
 sqlite.close();
});
