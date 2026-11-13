import test from 'node:test';import assert from 'node:assert/strict';
import {privateAction,privateComments,privateSearch} from '../cloudflare/social/unofficial.mjs';
const link={cookies:{sessionid:'test-only',csrftoken:'csrf'},user:{id:'42'},uuid:'test-device'};
test('invalid identifiers, audiences and unsupported TikTok actions never send credentials',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({})};
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'https://evil.test',liked:true},fetcher),{code:'MEDIA_ID'});
 await assert.rejects(privateAction('instagram',link,'notes',{text:'test',audience:99},fetcher),{code:'AUDIENCE'});
 await assert.rejects(privateAction('tiktok',link,'notes',{text:'test',audience:0},fetcher),{code:'CAPABILITY_UNAVAILABLE'});
 await assert.rejects(privateSearch('instagram',link,'',fetcher),{code:'QUERY'});assert.equal(calls,0);
});
test('an acknowledgement is required for every account mutation; challenges and rate limits stop writes',async()=>{
 await assert.rejects(privateAction('instagram',link,'comments',{mediaId:'ig:123',text:'test',clientId:crypto.randomUUID()},async()=>Response.json({status:'ok'})),{code:'SEND_UNCERTAIN'});
 await assert.rejects(privateAction('instagram',link,'notes',{text:'test',audience:0},async()=>Response.json({status:'ok'})),{code:'SEND_UNCERTAIN'});
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'ig:123',liked:true},async()=>Response.json({challenge_required:true,status:'fail'})),{code:'SESSION_REJECTED'});
 await assert.rejects(privateAction('instagram',link,'likes',{mediaId:'ig:123',liked:true},async()=>new Response('',{status:429})),{code:'SOCIAL_THROTTLED'});
});
test('provider text remains text and cookies are sent only to the fixed HTTPS origin without redirects',async()=>{
 const data=await privateComments('instagram',link,'ig:123','https://evil.test',async(url,init)=>{assert.equal(new URL(url).origin,'https://www.instagram.com');assert.equal(init.redirect,'manual');assert.equal(new URL(url).searchParams.get('min_id'),'https://evil.test');return Response.json({comments:[{pk:5,text:'<script>test</script>',user:{username:'bob'}}]});});assert.equal(data.comments[0].text,'<script>test</script>');assert.equal(data.comments[0].id,'5');
 const result=await privateAction('instagram',link,'notes',{text:'hello',audience:1},async(url,init)=>{assert.equal(url,'https://www.instagram.com/api/v1/notes/create_note');assert.equal(new URLSearchParams(init.body).get('audience'),'1');return Response.json({status:'ok',id:'note-1'});});assert.equal(result.id,'note-1');
});

test('TikTok For You fresh batches, following pagination and video/user search keep their own shapes',async()=>{
 const {privateFeed,privateFollowing,privateSearch}=await import('../cloudflare/social/unofficial.mjs');
 const item=(id,time)=>({id,author:{uniqueId:'creator',id:'42'},desc:'caption',createTime:time,video:{cover:'https://image.test/p.jpg'}});
 const feed=await privateFeed('tiktok',link,'fyp:2',async(url)=>{assert.equal(new URL(url).pathname,'/api/recommend/item_list/');assert.equal(new URL(url).searchParams.get('from_page'),'fyp');assert.equal(new URL(url).searchParams.has('itemID'),false);return Response.json({itemList:[item('1234567890123',10)],hasMore:true});});assert.equal(feed.cursor,'fyp:3');
 const following=await privateFollowing('tiktok',link,'120',async(url)=>{const parsed=new URL(url);assert.equal(parsed.pathname,'/api/following/item_list/');assert.equal(parsed.searchParams.get('cursor'),'120');assert.equal(parsed.searchParams.get('pullType'),'1');assert.equal(parsed.searchParams.get('isResetCounterUsed'),'true');return Response.json({itemList:[item('1234567890124',30)],cursor:'121',hasMore:true});});assert.equal(following.cursor,'121');assert.equal(following.items[0].timestamp,30000);
 const results=await privateSearch('tiktok',link,'cat',async(url)=>{assert.equal(new URL(url).pathname,'/api/search/item/full/');return Response.json({item_list:[item('1234567890125',20)],cursor:12,has_more:1});},'videos');assert.equal(results.items.length,1);assert.equal(results.cursor,'12');
 const users=await privateSearch('tiktok',link,'cat',async(url)=>{assert.equal(new URL(url).pathname,'/api/search/user/full/');return Response.json({user_list:[{user_info:{user_id:'42',unique_id:'creator',nickname:'Creator',avatar_thumb:{url_list:['https://image.test/a.jpg']}}}],has_more:0});},'users');assert.equal(users.users[0].username,'creator');assert.deepEqual(users.items,[]);
});

test('TikTok reactions require the user session CSRF and an explicit provider acknowledgement',async()=>{
 const tt={...link,cookies:{sessionid:'test-only',tt_csrf_token:'own-csrf'}};
 await assert.rejects(privateAction('tiktok',link,'likes',{mediaId:'tt:1234567890123',liked:true},async()=>{throw Error('must not call')}),{code:'SESSION_CSRF'});
 const result=await privateAction('tiktok',tt,'likes',{mediaId:'tt:1234567890123',liked:true},async(url,init)=>{assert.equal(new URL(url).pathname,'/api/commit/item/digg/');assert.equal(new URL(url).searchParams.get('type'),'1');assert.equal(init.method,'POST');assert.equal(String(init.body),'');assert.equal(init.headers['tt-csrf-token'],'own-csrf');assert.equal(init.redirect,'manual');return Response.json({status_code:0});});assert.equal(result.liked,true);
 await assert.rejects(privateAction('tiktok',tt,'comments',{mediaId:'tt:1234567890123',text:'test'},async()=>Response.json({status_code:0})),{code:'SEND_UNCERTAIN'});
 await assert.rejects(privateAction('tiktok',tt,'likes',{mediaId:'tt:1234567890123',liked:true},async()=>Response.json({status_code:10402})),{code:'SESSION_REJECTED'});
});
