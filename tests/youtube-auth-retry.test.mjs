import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {registerYouTubeAccount,credentialVault} from '../youtube-account.mjs';

test('a forbidden read refreshes credentials once, persists them, and never retries mutations',async()=>{
 const secret='test-forbidden-retry-secret-0123456789',vault=credentialVault(secret),rows=new Map();
 const initial={access_token:'old-access',refresh_token:'refresh-private',expiry_date:new Date(Date.now()+3600000).toISOString()};
 rows.set('youtube:alice',{expires:Date.now()+3600000,flow:vault.seal({credentials:initial,user:{name:'Test'}},'alice')});
 const store={get:async key=>rows.get(key),set:async(key,value)=>rows.set(key,structuredClone(value)),delete:async key=>rows.delete(key)};
 let refreshes=0,reads=0,writes=0,alwaysForbidden=false;
 const createClient=async()=>{
  const oauth={oauth2_tokens:null,async refreshAccessToken(){refreshes++;this.oauth2_tokens={...this.oauth2_tokens,access_token:'new-access'};}};
  return {session:{oauth,async signIn(credentials){oauth.oauth2_tokens=structuredClone(credentials);}},actions:{async execute(path){
   if(path==='/like/like'){writes++;throw new Error('failed with status code 403');}
   reads++;if(alwaysForbidden||oauth.oauth2_tokens.access_token==='old-access')throw new Error('Request to https://private.test?token=secret failed with status code 403');
   return {data:{contents:[{videoRenderer:{videoId:'abcdefghijk',title:{simpleText:'Recovered'}}}]}};
  }}};
 };
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.siteAccountId='alice';next();});
 registerYouTubeAccount(app,{store,secret,createClient});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  let response=await fetch(base+'/api/user/liked-videos');assert.equal(response.status,200);const result=await response.text();assert.ok(result.includes('Recovered'));assert.ok(!result.includes('new-access'));assert.equal(refreshes,1);assert.equal(reads,2);
  assert.equal(vault.open(rows.get('youtube:alice').flow,'alice').credentials.access_token,'new-access');
  alwaysForbidden=true;response=await fetch(base+'/api/user/watch-later');assert.equal(response.status,503);assert.equal(refreshes,2);assert.equal(reads,4,'persistent rejection must stop after one retry');
  response=await fetch(base+'/api/user/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'like',videoId:'abcdefghijk'})});assert.equal(response.status,503);assert.equal(writes,1);assert.equal(refreshes,2);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('TV user-agent matches the authenticated request body and headers',async()=>{
 const {Innertube,ClientType,Constants}=await import('youtubei.js/cf-worker');let calls=0;
 const yt=await Innertube.create({client_type:ClientType.TV,user_agent:Constants.CLIENTS.TV.USER_AGENT,generate_session_locally:true,retrieve_innertube_config:false,retrieve_player:false,fetch:async(input,init)=>{
  calls++;const body=JSON.parse(init.body),headers=new Headers(init.headers);
  assert.equal(body.context.client.clientName,'TVHTML5');assert.equal(body.context.client.userAgent,headers.get('User-Agent'));assert.equal(headers.get('User-Agent'),Constants.CLIENTS.TV.USER_AGENT);assert.equal(headers.get('Authorization'),'Bearer access-private');
  return Response.json({contents:[]});
 }});
 await yt.session.signIn({access_token:'access-private',refresh_token:'refresh-private',expiry_date:new Date(Date.now()+3600000).toISOString()});
 await yt.actions.execute('/browse',{browseId:'VLLL',client:'TV'});assert.equal(calls,1);
});
