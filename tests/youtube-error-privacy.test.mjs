import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {youtubePublicError,registerYouTubeAccount}from'../youtube-account.mjs';
test('provider errors with status, names and codes never expose OAuth data',()=>{
 const error={status:403,name:'refresh_token=secret',message:'access_token=secret refresh_token=secret',code:'YOUTUBE_SECRET'};const safe=youtubePublicError(error);assert.equal(safe.status,403);assert.equal(safe.code,'YOUTUBE_REQUEST_FAILED');assert.ok(!JSON.stringify(safe).includes('secret'));assert.equal(youtubePublicError({message:'動画IDが無効です。',status:400}).error,'動画IDが無効です。');
});
test('private routes reject missing site identities before reading any OAuth record',async()=>{
 const app=express();let reads=0;registerYouTubeAccount(app,{store:{get:async()=>{reads++;}},secret:'test-secret-for-isolation',createClient:async()=>{throw Error('must not run')}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/status');assert.equal(r.status,401);assert.equal(reads,0);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('cache-control'),/no-store/);}finally{await new Promise(r=>server.close(r));}
});
