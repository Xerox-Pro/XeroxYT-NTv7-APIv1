import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import worker from '../cloudflare/auth/worker.mjs';

test('admins can set burning and monitoring independently for each account', async () => {
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT);
 CREATE TABLE account_master_grants (user_id TEXT PRIMARY KEY);
 CREATE TABLE account_visual_modes (user_id TEXT PRIMARY KEY, mode TEXT);
 CREATE TABLE user_terms_acceptances (user_id TEXT, version TEXT);
 INSERT INTO users VALUES ('11111111-1111-1111-1111-111111111111','alice'),('22222222-2222-2222-2222-222222222222','bob');
 INSERT INTO account_visual_modes VALUES ('11111111-1111-1111-1111-111111111111','mirror');
 INSERT INTO user_terms_acceptances VALUES ('admin','2026-11-17.1'),('11111111-1111-1111-1111-111111111111','2026-11-17.1'),('22222222-2222-2222-2222-222222222222','2026-11-17.1');`);
 sqlite.exec(readFileSync(new URL('../cloudflare/auth/migrations/2026-11-20-account-management.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){return {bind(...args){return {
  first:async()=>sqlite.prepare(sql).get(...args)??null,
  run:async()=>sqlite.prepare(sql).run(...args),
 };}};}};
 const env={DB,ALLOWED_ORIGINS:'https://app.example',MASTER_USERNAME:'xerox0521'};
 const admin={id:'admin',username:'xerox0521'};
 const alice={id:'11111111-1111-1111-1111-111111111111',username:'alice'};
 const bob={id:'22222222-2222-2222-2222-222222222222',username:'bob'};
 const call=(path,user,body)=>worker.fetch(new Request('https://app.example/api/account'+path,body?{
  method:'POST',headers:{Origin:'https://app.example','Content-Type':'application/json'},body:JSON.stringify(body),
 }:{}),env,user);
 const state=async user=>(await call('/visual-mode',user)).json();
 assert.deepEqual(await state(alice),{mode:'mirror',monitoring:false});
 assert.equal((await call('/admin/accounts/'+alice.id,bob,{action:'monitoring',enabled:true})).status,404);
 assert.equal((await call('/admin/accounts/'+alice.id,admin,{action:'visualMode',mode:'burning'})).status,200);
 assert.equal((await call('/admin/accounts/'+alice.id,admin,{action:'monitoring',enabled:true})).status,200);
 assert.deepEqual(await state(alice),{mode:'burning',monitoring:true});
 assert.deepEqual(await state(bob),{mode:'off',monitoring:false});
 await call('/admin/accounts/'+alice.id,admin,{action:'monitoring',enabled:false});
 assert.deepEqual(await state(alice),{mode:'burning',monitoring:false});
 sqlite.close();
});
