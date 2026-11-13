import test from 'node:test';import assert from 'node:assert/strict';
import {privateAction,privateComments,privateSearch} from '../cloudflare/social/unofficial.mjs';
const link={cookies:{sessionid:'test-only',csrftoken:'csrf'},user:{id:'42'},uuid:'test-device'};
test('invalid identifiers, audiences and unsupported TikTok actions never send credentials',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({})};
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'https://evil.test',liked:true},fetcher),{code:'MEDIA_ID'});
 await assert.rejects(privateAction('instagram',link,'notes',{text:'test',audience:99},fetcher),{code:'AUDIENCE'});
 await assert.rejects(privateAction('tiktok',link,'likes',{mediaId:'tt:123',liked:true},fetcher),{code:'CAPABILITY_UNAVAILABLE'});
 await assert.rejects(privateSearch('instagram',link,'',fetcher),{code:'QUERY'});assert.equal(calls,0);
});
test('an acknowledgement is required for every account mutation; challenges and rate limits stop writes',async()=>{
 await assert.rejects(privateAction('instagram',link,'comments',{mediaId:'ig:123',text:'test',clientId:crypto.randomUUID()},async()=>Response.json({status:'ok'})),{code:'SEND_UNCERTAIN'});
 await assert.rejects(privateAction('instagram',link,'notes',{text:'test',audience:0},async()=>Response.json({status:'ok'})),{code:'SEND_UNCERTAIN'});
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'ig:123',liked:true},async()=>Response.json({challenge_required:true,status:'fail'})),{code:'SESSION_REJECTED'});
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'ig:123',liked:true},async()=>new Response('',{status:429})),{code:'SOCIAL_THROTTLED'});
});
test('provider text remains text and cookies are sent only to the fixed HTTPS origin without redirects',async()=>{
 const data=await privateComments('instagram',link,'ig:123','https://evil.test',async(url,init)=>{assert.equal(new URL(url).origin,'https://www.instagram.com');assert.equal(init.redirect,'error');assert.equal(new URL(url).searchParams.get('min_id'),'https://evil.test');return Response.json({comments:[{pk:5,text:'<script>test</script>',user:{username:'bob'}}]});});assert.equal(data.comments[0].text,'<script>test</script>');assert.equal(data.comments[0].id,'5');
 const result=await privateAction('instagram',link,'notes',{text:'hello',audience:1},async(url,init)=>{assert.equal(url,'https://www.instagram.com/api/v1/notes/create_note');assert.equal(new URLSearchParams(init.body).get('audience'),'1');return Response.json({status:'ok',id:'note-1'});});assert.equal(result.id,'note-1');
});
