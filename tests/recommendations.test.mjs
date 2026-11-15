import test from 'node:test';import assert from 'node:assert/strict';
import {registerRecommendations} from '../recommendations.mjs';
function harness(yt){let handler;registerRecommendations({get:(_,h)=>handler=h},async()=>yt,x=>x,()=>false);return async query=>{const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({query},res);return res;};}
test('home keeps successful sources when another fails and avoids history metadata fanout',async()=>{
 let searches=0,history=0;const call=harness({search:async()=>{if(++searches===1)throw Error('source unavailable');return {videos:[{videoId:'abcdefghijk'}]};},getBasicInfo:async()=>{history++;return {watch_next_feed:[{videoId:'lmnopqrstuv'}]};}});
 const result=await call({historyIds:'abcdefghijk,lmnopqrstuv,12345678901'});assert.equal(result.code,200);assert.equal(result.body.videos.length,2);assert.equal(searches,2);assert.equal(history,1);
});
test('home returns retryable errors instead of a successful empty response',async()=>{
 const call=harness({search:async()=>({videos:[]})});assert.equal((await call({})).code,502);assert.equal((await call({page:'999'})).code,400);
});
