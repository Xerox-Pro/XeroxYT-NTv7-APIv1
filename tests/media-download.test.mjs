import test from 'node:test';
import assert from 'node:assert/strict';
import {registerMediaDownload} from '../cloudflare/api/media-download.mjs';
test('downloads require the caller own Google link; invalid requests never launch a browser',async()=>{
 const routes=new Map();let calls=0;
 registerMediaDownload({post:(path,handler)=>routes.set(path,handler)},{run:async()=>{calls++;throw Object.assign(Error('Googleアカウントを連携してください。'),{status:401});},store:{},env:{},vault:{}});
 const send=async(path,body,id='user')=>{let status=200,data;const res={locals:{siteAccountId:id},setHeader(){},status(value){status=value;return this;},json(value){data=value;return this;}};await routes.get('/api/user/download/'+path)({body},res);return {status,data};};
 assert.equal((await send('formats',{videoId:'abcdefghijk',rightsConfirmed:true})).status,401);
 assert.equal((await send('formats',{videoId:'abcdefghijk'})).status,400);
 assert.equal((await send('formats',{videoId:'abcdefghijk',rightsConfirmed:true},'')).status,401);
 assert.equal(calls,1);
});
