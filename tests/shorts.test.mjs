import test from 'node:test';
import assert from 'node:assert/strict';
import { isShortAspect, normalizeShort, collectShorts, shortDetails, registerShortsRoutes } from '../shorts.mjs';
const short = (id='abcdefghijk', dimensions={width:405,height:720}) => ({ type:'ShortsLockupView', on_tap_endpoint:{payload:{videoId:id}}, thumbnail:[{url:'https://i.ytimg.com/x',...dimensions}], overlay_metadata:{primary_text:{text:'A short'}, secondary_text:{text:'1万回視聴'}} });
test('accepts 9:16 and rejects landscape, square, missing and misleading title-only videos', () => {
 assert.equal(isShortAspect(1080,1920),true);
 for(const [w,h] of [[1920,1080],[720,720],[0,720],[NaN,720]]) assert.equal(isShortAspect(w,h),false);
 assert.equal(normalizeShort({type:'Video',id:'abcdefghijk',title:'short clip',duration:{seconds:15},thumbnails:[{width:405,height:720}]}),null);
 assert.ok(normalizeShort(short('abcdefghijk',{width:720,height:720})));
 assert.equal(normalizeShort(short()).videoId,'abcdefghijk');
 const emptyThumbnail=short();emptyThumbnail.thumbnail=[];emptyThumbnail.on_tap_endpoint.payload.thumbnail={thumbnails:[{url:'x',width:1080,height:1920}],isOriginalAspectRatio:true};
 assert.equal(normalizeShort(emptyThumbnail).videoId,'abcdefghijk');
});
test('extracts nested shelves and continuation memos without duplicates or circular recursion', () => {
 const root={contents:[{type:'ReelShelf',items:[short(),short()]}]}; root.self=root;
 assert.equal(collectShorts(root).length,1);
 assert.equal(collectShorts({page:{on_response_received_commands_memo:new Map([['ShortsLockupView',[short()]]])}}).length,1);
});
test('playback accepts unknown and landscape dimensions without inventing aspect verification', () => {
 const info={basic_info:{title:'x',duration:40,thumbnail:[{width:405,height:720}]},streaming_data:{adaptive_formats:[{width:1920,height:1080}]}};
 assert.equal(shortDetails(info,'abcdefghijk').video.shortEligible,true);
 info.streaming_data.adaptive_formats=[{width:1080,height:1920}];
 assert.equal(shortDetails(info,'abcdefghijk').video.aspectVerified,true);
 assert.equal(shortDetails({...info,streaming_data:{}},'abcdefghijk').video.shortEligible,true);
 assert.equal(shortDetails({...info,streaming_data:{}},'abcdefghijk',{width:1080,height:1920}).video.aspectVerified,true);
 assert.equal(shortDetails({...info,basic_info:{duration:900}},'abcdefghijk').video.shortEligible,true);
});
function harness(youtube) {
 const routes={}; registerShortsRoutes({get:(path,handler)=>routes[path]=handler},async()=>youtube);
 return async(path,query={},params={})=>{const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}}; await routes[path]({query,params},res); return res;};
}
test('search pagination follows actual continuation and short refinement, preserves query', async()=>{
 let searched=[];let refined=0;let continued=0;
 const next={videos:[short('lmnopqrstuv')],has_continuation:false};
 const first={videos:[short()],refinement_filters:['すべて','ショート'],has_continuation:true,async applyRefinement(){refined++;return this;},async getContinuation(){continued++;return next;}};
 const call=harness({search:async q=>{searched.push(q);return first;}});
 const one=await call('/api/shorts',{source:'search',q:'猫'});
 assert.equal(one.body.videos[0].videoId,'abcdefghijk'); assert.equal(one.body.hasMore,true);
 const two=await call('/api/shorts',{source:'search',q:'猫',page:'2'});
 assert.equal(two.body.videos[0].videoId,'lmnopqrstuv');assert.equal(two.body.hasMore,false);
 assert.deepEqual(searched,['猫']);assert.equal(refined,1);assert.equal(continued,1);
});
test('rejects unbounded/invalid inputs before calling YouTube; errors are retryable',async()=>{
 const call=harness({search:async()=>{throw new Error('upstream');}});
 for(const query of [{page:999},{source:'bad'},{source:'search'},{source:'related',videoId:'bad'}]) assert.equal((await call('/api/shorts',query)).code,400);
 assert.equal((await call('/api/shorts/:id',{}, {id:'bad'})).code,400);
 assert.equal((await call('/api/shorts',{source:'search',q:'猫'})).code,502);
});
test('cold serverless instance permits unknown aspect without trusting client dimensions',async()=>{
 const item=short();item.thumbnail=[];item.on_tap_endpoint.payload.thumbnail={isOriginalAspectRatio:true,thumbnails:[{url:'original',width:1080,height:1920}]};
 const call=harness({getInfo:async()=>({basic_info:{title:'A short',duration:30},primary_info:{}}),search:async()=>({videos:[item]})});
 const response=await call('/api/shorts/:id',{title:'A short',width:1080,height:1920},{id:'abcdefghijk'});
 assert.equal(response.code,200); assert.equal(response.body.aspectVerified,false); assert.equal(response.body.shortEligible,true);
 const mismatch=await call('/api/shorts/:id',{title:'A short',width:1080,height:1920},{id:'lmnopqrstuv'});
 assert.equal(mismatch.code,200);
});

test('Shorts playback accepts missing tags and missing dimensions',()=>{
 for(const basic_info of [{title:'clip #shorts'},{title:'clip',short_description:'Watch #SHORTS now'}]){
  const result=shortDetails({basic_info},'abcdefghijk');assert.equal(result.video.shortEligible,true);assert.equal(result.video.aspectVerified,false);
 }
 assert.equal(shortDetails({basic_info:{title:'clip without a tag'}},'abcdefghijk').video.shortEligible,true);
 assert.ok(normalizeShort({type:'Video',id:'abcdefghijk',title:'#shorts',thumbnails:[]}));
});
test('personalized search adds only a small portion and failures preserve general discovery', async () => {
 const ids = Array.from({length:24}, (_,i)=>`general${String(i).padStart(4,'0')}`);
 const searched=[];
 const call=harness({search:async q=>{searched.push(q); return {videos:q.startsWith('ギター ') ? [short('personal001'),short('personal002')] : ids.map(id=>short(id))};}});
 const response=await call('/api/shorts',{source:'home',session:'test',interest:'ギター',exclude:'personal002'});
 assert.ok(searched.includes('ギター #shorts'));
 assert.ok(response.body.videos.some(v=>v.videoId==='personal001'));
 assert.ok(!response.body.videos.some(v=>v.videoId==='personal002'));
 assert.equal(response.body.videos.filter(v=>v.videoId.startsWith('personal')).length,1);
 const fallback=harness({search:async q=>{if(q.startsWith('ギター '))throw Error('offline');return {videos:ids.map(id=>short(id))};}});
 assert.ok((await fallback('/api/shorts',{source:'home',session:'test',interest:'ギター'})).body.videos.length>0);
});
test('personalized clips target 30 percent of the final ranking-alternated feed', async () => {
 const general=Array.from({length:30},(_,i)=>short(`general${String(i).padStart(4,'0')}`));
 const personal=Array.from({length:24},(_,i)=>short(`personal${String(i).padStart(3,'0')}`));
 const call=harness({search:async q=>({videos:q.startsWith('ギター ')?personal:q.startsWith('#音楽 ')?personal.map((v,i)=>short(`music${String(i).padStart(6,'0')}`)):q.startsWith('#演奏 ')?personal.map((v,i)=>short(`stage${String(i).padStart(6,'0')}`)):general})});
 const res=await call('/api/shorts',{source:'home',session:'ratio',interest:'ギター',interests:JSON.stringify(['#音楽','#演奏'])});
 assert.equal(res.body.videos.length,30);
 assert.equal(res.body.videos.filter(v=>!v.videoId.startsWith('general')).length,18);
});
test('search Shorts use only the exact search context, ignoring personalization and unrelated topics',async()=>{
 const queries=[];
 const call=harness({search:async q=>{queries.push(q);return {videos:[short()]};}});
 const res=await call('/api/shorts',{source:'search',q:'ピアノ',session:'search-only',interest:'ゲーム',interests:JSON.stringify(['#料理'])});
 assert.equal(res.code,200); assert.deepEqual(queries,['ピアノ']);
});
test('at most five hashtags each fetch ten clips, deduplicate, and reject oversized tag lists',async()=>{
 const queries=[];
 const call=harness({search:async q=>{queries.push(q);return {videos:Array.from({length:20},(_,i)=>short(`${q.startsWith('#猫')?'cats':'dogs'}${String(i).padStart(7,'0')}`))};}});
 const res=await call('/api/shorts',{source:'home',session:'tag-pools',interests:JSON.stringify(['#猫','#犬'])});
 assert.equal(res.body.videos.filter(v=>v.videoId.startsWith('cats')).length<=10,true);
 assert.ok(queries.includes('#猫 #shorts'));assert.ok(queries.includes('#犬 #shorts'));
 assert.equal((await call('/api/shorts',{session:'invalid',interests:JSON.stringify(Array(6).fill('#猫'))})).code,400);
});

test('Shorts descriptions support secondary text, basic descriptions and structured body text',()=>{
 assert.equal(shortDetails({secondary_info:{description:{text:'Full description'}},basic_info:{short_description:'preview'}},'abcdefghijk').video.description,'Full description');
 assert.equal(shortDetails({basic_info:{description:'Basic description'}},'abcdefghijk').video.description,'Basic description');
 assert.equal(shortDetails({page:[{type:'ExpandableVideoDescriptionBody',description:{runs:[{text:'line1'},{text:'\nline2'}]}}]},'abcdefghijk').video.description,'line1\nline2');
});

test('simultaneous details share upstream work and failed work is retried', async () => {
 let calls=0, release;
 const call=harness({getInfo:async()=>{calls++; if(calls===1) await new Promise(resolve=>{release=resolve}); return {basic_info:{title:'clip',duration:30}};}});
 const first=call('/api/shorts/:id',{}, {id:'abcdefghijk'});
 const second=call('/api/shorts/:id',{}, {id:'abcdefghijk'});
 await new Promise(resolve=>setImmediate(resolve)); release();
 const results=await Promise.all([first,second]); assert.deepEqual(results.map(r=>r.code),[200,200]); assert.equal(calls,1);
 let attempts=0;
 const retry=harness({getInfo:async()=>{if(++attempts===1)throw Error('temporary');return {basic_info:{title:'clip'}};}});
 assert.equal((await retry('/api/shorts/:id',{}, {id:'abcdefghijk'})).code,502);
 assert.equal((await retry('/api/shorts/:id',{}, {id:'abcdefghijk'})).code,200);
 assert.equal(attempts,2);
});
