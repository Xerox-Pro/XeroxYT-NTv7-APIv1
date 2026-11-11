import test from 'node:test';import assert from 'node:assert/strict';import {decodeYouTubeFeed} from '../youtube-feed.mjs';import {playlistCard,readYouTubeMix} from '../youtube-mix.mjs';
test('personalized mix cards retain playlist identity, seed and collection artwork',()=>{
 const result=decodeYouTubeFeed({lockupViewModel:{contentId:'RDabcdefghijk',contentType:'LOCKUP_CONTENT_TYPE_STATION',metadata:{lockupMetadataViewModel:{title:{content:'ミックスリスト'}}},contentImage:{collectionThumbnailViewModel:{primaryThumbnail:{thumbnailViewModel:{image:{sources:[{url:'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'}]}}}}},rendererContext:{commandContext:{onTap:{innertubeCommand:{watchEndpoint:{playlistId:'RDabcdefghijk',videoId:'abcdefghijk'}}}}}}});assert.equal(result.playlists[0].type,'mix');assert.equal(result.playlists[0].videoId,'abcdefghijk');assert.ok(result.playlists[0].thumbnail.includes('abcdefghijk'));const card=playlistCard(result.playlists[0]);assert.equal(card.playlistId,'RDabcdefghijk');assert.equal(card.type,'mix');assert.equal(card.title,'ミックスリスト');
});
test('playlist videos are videos rather than nested playlist cards',()=>{
 const result=decodeYouTubeFeed({playlistVideoRenderer:{videoId:'abcdefghijk',title:{simpleText:'プレイリスト内の動画'},navigationEndpoint:{watchEndpoint:{videoId:'abcdefghijk',playlistId:'PLabc'}}}});assert.equal(result.videos.length,1);assert.equal(result.playlists.length,0);
});
test('a mix uses the authenticated TV playlist panel and excludes unrelated suggestions',async()=>{
 const panel={title:'ミックス',contents:[{playlistPanelVideoRenderer:{videoId:'abcdefghijk',title:{simpleText:'収録曲'}}}]};
 const data={contents:{playlist:{playlistPanelRenderer:panel},secondary:{compactVideoRenderer:{videoId:'bcdefghijkl',title:{simpleText:'関連動画'}}}}};
 const execute=async(path,args)=>{assert.equal(path,'/next');assert.equal(args.client,'TV');assert.equal(args.playlistId,'RDabcdefghijk');return {data};};
 const mix=await readYouTubeMix({session:{logged_in:true},actions:{execute}},'RDabcdefghijk','abcdefghijk');
 assert.deepEqual(mix.videos.map(v=>v.videoId),['abcdefghijk']);await assert.rejects(readYouTubeMix({actions:{execute}},'not-a-mix'),/無効/);
});
test('Web mix panels without a renderer wrapper are supported',async()=>{
 const data={contents:{twoColumnWatchNextResults:{playlist:{playlist:{title:'Mix',contents:[{playlistPanelVideoRenderer:{videoId:'abcdefghijk',title:{simpleText:'曲'}}}]}}}}};const mix=await readYouTubeMix({actions:{execute:async()=>({data})}},'RDabcdefghijk','abcdefghijk');assert.equal(mix.videos.length,1);
});
test('infinite mixes continue with the provider playlist index and parameters',async()=>{
 const execute=async(path,args)=>{if(args.playlistIndex!==undefined){assert.equal(args.playlistIndex,24);assert.equal(args.videoId,'abcdefghijk');assert.equal(args.params,'OAE%3D');}return {data:{playlist:{title:'Mix',isInfinite:true,contents:[{playlistPanelVideoRenderer:{videoId:args.playlistIndex?'bcdefghijkl':'abcdefghijk',title:{simpleText:'曲'},navigationEndpoint:{watchEndpoint:{videoId:'abcdefghijk',index:24,params:'OAE%3D'}}}}]}}};};
 const yt={actions:{execute}};const first=await readYouTubeMix(yt,'RDabcdefghijk','abcdefghijk');assert.equal(first.hasMore,true);const next=await readYouTubeMix(yt,first.id,'',first.continuation);assert.equal(next.videos[0].videoId,'bcdefghijkl');await assert.rejects(readYouTubeMix(yt,first.id,'','bad-cursor'),/無効/);
});
