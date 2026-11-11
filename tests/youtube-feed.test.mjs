import test from 'node:test';import assert from 'node:assert/strict';
import {decodeYouTubeFeed,readYouTubeFeed} from '../youtube-feed.mjs';
const lockup=(id,type='VIDEO')=>({lockupViewModel:{contentId:id,contentType:'LOCKUP_CONTENT_TYPE_'+type,contentImage:{thumbnailViewModel:{image:{sources:[{url:'https://i.ytimg.com/vi/'+id+'/hqdefault.jpg',width:320,height:180}]},overlays:[{thumbnailBottomOverlayViewModel:{badges:[{thumbnailBadgeViewModel:{text:'3:06'}}]}}]}},metadata:{lockupMetadataViewModel:{title:{content:'BGMでも残す動画'},metadata:{contentMetadataViewModel:{metadataRows:[{metadataParts:[{text:{content:'アーティスト'}}]},{metadataParts:[{text:{content:'150万回視聴'}},{text:{content:'3 年前'}}]}]}}}}}});
test('TV shelves read video, playlist and channel lockups without treating menu commands or headers as videos',()=>{
 const data={contents:{tvBrowseRenderer:{content:{tvSurfaceContentRenderer:{content:{sectionListRenderer:{contents:[{searchBarRenderer:{title:{runs:[{text:'検索'}]}}},{shelfRenderer:{content:{horizontalListRenderer:{items:[lockup('abcdefghijk'),lockup('abcdefghijk'),lockup('PLtest123','PLAYLIST'),lockup('UC'+'a'.repeat(22),'CHANNEL'),lockup('bcdefghijkl','SHORT')],continuations:[{nextContinuationData:{continuation:'shelf-next'}}]}}}}]}}}}}},menuRenderer:{videoRenderer:{videoId:'fakevideo12',title:{simpleText:'not content'}}}};
 const decoded=decodeYouTubeFeed(data);assert.equal(decoded.videos.length,2);assert.equal(decoded.videos[0].title,'BGMでも残す動画');assert.equal(decoded.videos[0].lengthSeconds,186);assert.equal(decoded.videos[0].viewCount,1500000);assert.equal(decoded.videos[1].isShort,true);assert.equal(decoded.playlists[0].id,'PLtest123');assert.equal(decoded.channels.length,1);assert.deepEqual(decoded.tokens,['shelf-next']);
});
test('continuation-only TV shelves are hydrated and all remaining shelf tokens survive pagination',async()=>{
 const calls=[];const yt={actions:{execute:async(path,args)=>{calls.push(args);assert.equal(args.client,'TV');assert.equal(path,'/browse');if(args.browseId)return {data:{continuations:[{nextContinuationData:{continuation:'one'}},{nextContinuationData:{continuation:'two'}}]}};if(args.continuation==='one')return {data:{contents:[lockup('abcdefghijk')],continuations:[{nextContinuationData:{continuation:'three'}}]}};return {data:{contents:[lockup('bcdefghijkl')]}};}}};
 const first=await readYouTubeFeed(yt,'home');assert.equal(first.videos.length,2);assert.equal(calls.length,4);assert.equal(first.hasMore,false);
 const cursor=Buffer.from(JSON.stringify({kind:'home',tokens:['two']})).toString('base64url');const second=await readYouTubeFeed(yt,'home',cursor);assert.equal(second.videos[0].videoId,'bcdefghijkl');await assert.rejects(readYouTubeFeed(yt,'history',cursor),/続きの情報/);await assert.rejects(readYouTubeFeed(yt,'home','invalid'),/続きの情報/);
});
test('an empty shelf loop terminates and explicit YouTube errors are never disguised as empty success',async()=>{
 let calls=0;const yt={actions:{execute:async()=>{calls++;return {data:{continuations:[{nextContinuationData:{continuation:'same'}}]}};}}};assert.equal((await readYouTubeFeed(yt,'home')).videos.length,0);assert.equal(calls,2);await assert.rejects(readYouTubeFeed({actions:{execute:async()=>({data:{error:{code:403}}})}},'home'),/拒否/);
});
test('real YouTube.js sends the signed-in bearer token with TV client context to the server fetch',async()=>{
 const {Innertube,ClientType,Log}=await import('youtubei.js');Log.setLevel(Log.Level.NONE);let requests=0;
 const yt=await Innertube.create({client_type:ClientType.TV,generate_session_locally:true,retrieve_innertube_config:false,retrieve_player:false,fetch:async(input,init)=>{
  requests++;assert.equal(new URL(input.url||input).hostname,'www.youtube.com');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer test-private-access');const body=JSON.parse(init.body);assert.equal(body.context.client.clientName,'TVHTML5');assert.equal(body.browseId,'FEwhat_to_watch');return Response.json({contents:[lockup('abcdefghijk')]});
 }});
 await yt.session.signIn({access_token:'test-private-access',refresh_token:'test-private-refresh',expiry_date:new Date(Date.now()+3600000).toISOString()});
 const result=await readYouTubeFeed(yt,'home');assert.equal(requests,1);assert.equal(result.videos.length,1);assert.ok(!JSON.stringify(result).includes('test-private-access'));
});

test('a small personalized home page is filled from additional pages up to 36 unique videos',async()=>{
 let calls=0;const yt={actions:{execute:async()=>{const page=calls++;return {data:{contents:Array.from({length:8},(_,i)=>lockup(String(page*8+i).padStart(11,'a'))),continuations:[{nextContinuationData:{continuation:'page-'+calls}}]}};}}};
 const result=await readYouTubeFeed(yt,'home');assert.equal(result.videos.length,40);assert.equal(calls,5);assert.equal(result.hasMore,true);
});
test('a failure on an additional page preserves loaded videos and a cursor for retry',async()=>{
 let calls=0;const yt={actions:{execute:async()=>{if(calls++)throw new Error('offline');return {data:{contents:[lockup('abcdefghijk')],continuations:[{nextContinuationData:{continuation:'retry'}}]}};}}};const result=await readYouTubeFeed(yt,'home');assert.equal(result.videos.length,1);assert.equal(result.hasMore,true);assert.deepEqual(JSON.parse(Buffer.from(result.continuation,'base64url')).tokens,['retry']);
});
test('TV tile metadata provides titles, author, thumbnails and duration',()=>{
 const node={tileRenderer:{
  metadata:{tileMetadataRenderer:{title:{simpleText:'正しいホームのタイトル'},lines:[{lineRenderer:{items:[{lineItemRenderer:{text:{simpleText:'投稿者'}}}]}}]}},
  onSelectCommand:{watchEndpoint:{videoId:'abcdefghijk'}},
  header:{tileHeaderRenderer:{thumbnail:{thumbnails:[{url:'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'}]},thumbnailOverlays:[{thumbnailOverlayTimeStatusRenderer:{text:{simpleText:'12:34'}}}]}}
 }};
 const r=decodeYouTubeFeed(node);assert.equal(r.videos[0].title,'正しいホームのタイトル');assert.equal(r.videos[0].author,'投稿者');assert.equal(r.videos[0].lengthSeconds,754);
 const shelf=decodeYouTubeFeed({shelfRenderer:{title:{simpleText:'Shorts'},content:{items:[node]}}});assert.equal(shelf.videos[0].isShort,true);assert.equal(r.videos[0].isShort,undefined);
});
test('raw Shorts onTap is read even when the entity ID is not a video ID',()=>{
 const r=decodeYouTubeFeed({shortsLockupViewModel:{entityId:'opaque-entity-id',onTap:{innertubeCommand:{reelWatchEndpoint:{videoId:'abcdefghijk'}}},overlayMetadata:{primaryText:{content:'本来のショートタイトル'}}}});assert.equal(r.videos[0]?.videoId,'abcdefghijk');assert.equal(r.videos[0]?.title,'本来のショートタイトル');
});
