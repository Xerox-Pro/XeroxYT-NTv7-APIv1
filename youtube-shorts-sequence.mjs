import {readYouTubeFeed} from './youtube-feed.mjs';
const validId=id=>/^[\w-]{11}$/.test(id||'');
// Same ReelSequence protobuf fields used by YouTube.js getShortsVideoInfo.
export function shortsSequenceParams(id){
 if(!validId(id))throw Object.assign(new Error('ショート動画IDが無効です。'),{status:400});
 return encodeURIComponent(Buffer.concat([Buffer.from([10,11]),Buffer.from(id),Buffer.from([42,2,24,5,80,25])]).toString('base64'));
}
export async function readShortsSequence(yt,seed='',cursor=''){
 let sequenceParams;
 if(cursor){try{if(cursor.length>24000)throw Error();const data=JSON.parse(Buffer.from(cursor,'base64url').toString());if(data.kind!=='shorts-sequence'||typeof data.token!=='string'||!data.token||data.token.length>16000)throw Error();sequenceParams=data.token;}catch{throw Object.assign(new Error('ショートの続きの情報が無効です。開き直してください。'),{status:400});}}
 else{
  if(!seed){const first=await readYouTubeFeed(yt,'shorts');seed=first.videos.find(v=>v.isShort)?.videoId;}
  if(!validId(seed))throw Object.assign(new Error('YouTubeからショートの開始動画を取得できませんでした。再試行してください。'),{status:502,code:'YOUTUBE_SHORTS_SEED_UNAVAILABLE'});
  sequenceParams=shortsSequenceParams(seed);
 }
 const response=await yt.actions.execute('/reel/reel_watch_sequence',{sequenceParams,client:'TV'});
 if(response.data?.error)throw Object.assign(new Error('YouTubeのショート取得に失敗しました。再試行してください。'),{status:502,code:'YOUTUBE_SHORTS_SEQUENCE_REJECTED'});
 const videos=[],seen=new Set();
 for(const entry of response.data?.entries||[]){
  const node=entry.command?.reelWatchEndpoint,id=node?.videoId;
  if(!validId(id)||seen.has(id))continue;seen.add(id);
  videos.push({videoId:id,title:'ショート動画',author:'チャンネル',isShort:true,shortSource:'youtube',viewCount:0,publishedText:'',lengthSeconds:0,videoThumbnails:node.thumbnail?.thumbnails||[{url:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}]});
 }
 const token=response.data?.continuation;
 const continuation=typeof token==='string'&&token&&token.length<=16000&&token!==sequenceParams?Buffer.from(JSON.stringify({kind:'shorts-sequence',token})).toString('base64url'):'';
 if(!videos.length&&!continuation)throw Object.assign(new Error('YouTubeから次のショートを取得できませんでした。再試行してください。'),{status:502,code:'YOUTUBE_SHORTS_SEQUENCE_EMPTY'});
 return {videos,continuation,hasMore:!!continuation,source:'youtube-shorts',personalized:true};
}
