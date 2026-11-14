import {test} from 'node:test';
import assert from 'node:assert/strict';
import {upstreamFailure,notificationItems,homeCategoryItems} from '../youtube-upstream.mjs';
import {readYouTubeFeed} from '../youtube-feed.mjs';
test('upstream denial, rate limits and timeouts have bounded retry instructions without leaking URLs or tokens',()=>{
 for(const status of [403,429]){const result=upstreamFailure(new Error('Request to https://secret.example/?token=private failed with status code '+status));assert.equal(result.status,503);assert.equal(result.retryAfter,30);assert.ok(!JSON.stringify(result).includes('private'));}
 assert.equal(upstreamFailure({name:'TimeoutError'}).status,504);assert.equal(upstreamFailure(new Error('unknown')),null);
});
test('raw notification and category readers avoid parsed feeds and do not fabricate success on provider error',()=>{
 const item={notificationRenderer:{notificationId:'one',shortMessage:{runs:[{text:'新しい動画'}]},navigationEndpoint:{watchEndpoint:{videoId:'abcdefghijk'}},sentTimeText:{simpleText:'1分前'}}};
 const cyclic={items:[item,item]};cyclic.self=cyclic;
 assert.deepEqual(notificationItems(cyclic).map(n=>[n.id,n.message,n.videoId]),[['one','新しい動画','abcdefghijk']]);
 assert.throws(()=>notificationItems({error:{code:403}}),{status:403});
 const chip=text=>({chipCloudChipRenderer:{text:{simpleText:text}}});assert.deepEqual(homeCategoryItems({header:{chips:[chip('すべて'),chip('音楽'),chip('音楽')]}}),['音楽']);
});
test('Workers feed budget leaves continuation intact and lists stop after the first populated page',async()=>{
 let calls=0;const yt={actions:{execute:async()=>({data:{contents:[{videoRenderer:{videoId:String(++calls).padStart(11,'a'),title:{simpleText:'動画'}}}],continuations:[{nextContinuationData:{continuation:'next-'+calls}}]}})}};
 const home=await readYouTubeFeed(yt,'home','',{maxRequests:2});assert.equal(calls,2);assert.equal(home.hasMore,true);assert.ok(home.continuation);
 calls=0;const liked=await readYouTubeFeed(yt,'liked','',{maxRequests:2,firstPageOnly:true});assert.equal(calls,1);assert.equal(liked.videos.length,1);assert.equal(liked.hasMore,true);
});
test('local TV session initialization performs no network/config retrieval',async()=>{
 const {Innertube,ClientType}=await import('youtubei.js/cf-worker');let calls=0;
 const yt=await Innertube.create({client_type:ClientType.TV,generate_session_locally:true,retrieve_innertube_config:false,retrieve_player:false,fetch:async()=>{calls++;throw new Error('unexpected startup fetch');}});
 assert.ok(yt.actions);assert.equal(calls,0);
});
