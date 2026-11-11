import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {registerYouTubeAccount,credentialVault} from '../youtube-account.mjs';
const secret='test-only-server-secret-0123456789';
test('Google credentials are authenticated-encrypted and cannot be read under another site account',()=>{
 const vault=credentialVault(secret),sealed=vault.seal({refresh_token:'private-token'},'alice');assert.ok(!JSON.stringify(sealed).includes('private-token'));assert.equal(vault.open(sealed,'alice').refresh_token,'private-token');assert.throws(()=>vault.open(sealed,'bob'));const modified={...sealed,tag:Buffer.alloc(16).toString('base64')};assert.throws(()=>vault.open(modified,'alice'));assert.throws(()=>credentialVault('short'));
});
test('device OAuth survives requests, respects polling interval, never sends tokens to browser and isolates user feeds',async()=>{
 const rows=new Map();const store={get:async key=>rows.get(key),set:async(k,v)=>rows.set(k,structuredClone(v)),delete:async key=>rows.delete(key)};
 let now=Date.now();const realNow=Date.now;Date.now=()=>now;let googleCalls=0,likes=0,clients=0,authUnavailable=false,comments=0;
 const credentials={access_token:'access-secret',refresh_token:'refresh-secret',expires_in:3600};
 const feed={videos:[{id:'abcdefghijk',title:'personal'}],memo:{getType:()=>[{endpoint:{payload:{token:'next-token'}}}]}};
 const createClient=async()=>{clients++;return {actions:{execute:async(path,args)=>{assert.equal(args.client,'TV');if(path==='/like/like'){assert.deepEqual(args.target,{videoId:'abcdefghijk'});likes++;return {success:true};}if(path==='/subscription/subscribe'){assert.deepEqual(args.channelIds,['UC'+'a'.repeat(22)]);return {success:true};}assert.equal(path,'/browse');return {data:{contents:[{videoRenderer:{videoId:'abcdefghijk',title:{simpleText:'personal'}}}],continuations:[{nextContinuationData:{continuation:'next-token'}}]}}}},session:{signIn:async value=>{if(authUnavailable)throw new Error('network unavailable');instance.session.oauth.oauth2_tokens=value;},oauth:{getClientID:async()=>({client_id:'device-client',client_secret:'public-tv-config'}),oauth2_tokens:null}},getHomeFeed:async()=>feed,getHistory:async()=>feed,interact:{comment:async(id,text)=>{assert.equal(id,'abcdefghijk');assert.equal(text,'コメントテスト');comments++;return {success:true};},like:async()=>{likes++;return {success:true};}},account:{getInfo:async all=>{assert.equal(all,false,'OAuth account info must use the TV client');return {contents:{contents:[{is_selected:true,account_name:'Test',account_photo:[{url:'https://image.test/avatar'}]}]}};}}};};
 // Each authenticated request owns its own instance.
 let instance;const factory=async()=>{instance=await createClient();return instance;};
 class FakeFeed{constructor(){Object.assign(this,feed);}}
 const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.siteAccountId=req.headers['x-test-user']||'alice';next();});
 registerYouTubeAccount(app,{store,secret,createClient:factory,formatVideo:v=>v.id?{videoId:v.id,title:v.title}:null,formatChannel:v=>v,ContinuationItem:class{},Feed:FakeFeed,fetcher:async(url,options)=>{googleCalls++;const data=JSON.parse(options.body);if(url.endsWith('device/code')){assert.equal(data.scope,'http://gdata.youtube.com');return Response.json({device_code:'private-device-code',user_code:'ABCD',verification_url:'https://www.google.com/device',expires_in:1800,interval:5});}return Response.json(credentials);}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  let r=await fetch(base+'/api/auth/status');assert.equal((await r.json()).connected,false);
  r=await fetch(base+'/api/auth/signin',{method:'POST'});const start=await r.json();assert.equal(start.userCode,'ABCD');assert.ok(!JSON.stringify(start).includes('device_code'));assert.ok(!JSON.stringify([...rows.values()]).includes('private-device-code'));
  r=await fetch(base+'/api/auth/poll');assert.equal((await r.json()).status,'pending');assert.equal(googleCalls,1);
  now+=6000;r=await fetch(base+'/api/auth/poll');const linked=await r.json();assert.equal(linked.success,true);assert.equal(linked.user.name,'Test');assert.ok(!JSON.stringify(linked).includes('access-secret'));assert.ok(!JSON.stringify([...rows.values()]).includes('refresh-secret'));
  r=await fetch(base+'/api/user/feed/home');const home=await r.json();assert.equal(home.videos[0].title,'personal');assert.equal(home.hasMore,false,'a repeated provider token must not loop');assert.match(r.headers.get('cache-control'),/private.*no-store/);
  authUnavailable=true;r=await fetch(base+'/api/user/feed/home');assert.equal(r.status,503);assert.equal((await (await fetch(base+'/api/auth/status')).json()).connected,true);authUnavailable=false;
  r=await fetch(base+'/api/user/feed/home',{headers:{'x-test-user':'bob'}});assert.equal(r.status,401);
  r=await fetch(base+'/api/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'like',videoId:'abcdefghijk'})});assert.equal(r.status,200);assert.equal(likes,1);
  r=await fetch(base+'/api/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'like',videoId:'bad'})});assert.equal(r.status,400);assert.equal(likes,1);
  r=await fetch(base+'/api/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'subscribe',channelId:'UC'+'a'.repeat(22)})});assert.equal(r.status,200);
  r=await fetch(base+'/api/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'comment',videoId:'abcdefghijk',text:' コメントテスト '})});assert.equal(r.status,200);assert.equal(comments,1);
  r=await fetch(base+'/api/user/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'comment',videoId:'abcdefghijk',text:'   '})});assert.equal(r.status,400);assert.equal(comments,1);
  await fetch(base+'/api/auth/logout',{method:'POST'});r=await fetch(base+'/api/auth/status');assert.equal((await r.json()).connected,false);r=await fetch(base+'/api/user/history');assert.equal(r.status,401);
 }finally{Date.now=realNow;await new Promise(resolve=>server.close(resolve));}
});
