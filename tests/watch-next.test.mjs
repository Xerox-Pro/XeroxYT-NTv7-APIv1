import test from 'node:test';import assert from 'node:assert/strict';import {fetchPublicWatchNext} from '../watch-next.mjs';
test('public related videos and continuations are fetched independently of player metadata',async()=>{
 const calls=[];const yt={actions:{execute:async(path,args)=>{calls.push(args);assert.equal(path,'/next');assert.equal(args.client,'WEB');return {data:{contents:[{compactVideoRenderer:{videoId:args.continuation?'bcdefghijkl':'abcdefghijk',title:{simpleText:'関連動画'}}}],continuations:args.continuation?[]:[{nextContinuationData:{continuation:'next-page'}}]}};}}};
 const first=await fetchPublicWatchNext(yt,'12345678901');assert.equal(first.watch_next_feed[0].title,'関連動画');const second=await first.getWatchNextContinuation();assert.equal(second.watch_next_feed[0].videoId,'bcdefghijkl');assert.equal(second.has_continuation,false);assert.equal(calls[1].continuation,'next-page');
});
