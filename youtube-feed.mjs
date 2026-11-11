// OAuth uses TV responses. Read their content renderers rather than Web-only
// HomeFeed/Playlist wrappers, or unrelated nodes from the parser's global memo.
const videoId = value => typeof value === 'string' && /^[\w-]{11}$/.test(value);
const channelId = value => typeof value === 'string' && /^UC[\w-]{22}$/.test(value);
export const feedText = value => typeof value === 'string' ? value : typeof value?.text === 'string' ? value.text : value?.content || value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '';
const images = value => Array.isArray(value) ? value : value?.sources || value?.thumbnails || [];
function endpoint(node) { return node?.rendererContext?.commandContext?.onTap?.innertubeCommand || node?.onSelectCommand || node?.navigationEndpoint || node?.endpoint || {}; }
function count(value) { const match=feedText(value).replace(/,/g,'').match(/([\d.]+)\s*([万億KMB])?/i); return match ? Math.round(Number(match[1])*({万:1e4,億:1e8,K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]||1)) : 0; }
function duration(value) { const match=feedText(value).match(/\b\d+(?::\d{2}){1,2}\b/); return match ? match[0].split(':').reduce((n,p)=>n*60+Number(p),0) : 0; }
export function decodeYouTubeFeed(data) {
 const videos=new Map(),playlists=new Map(),channels=new Map(),tokens=[];const seen=new WeakSet();let nodes=0;
 function render(node,kind) {
  const tap=endpoint(node),lock=node.metadata?.lockupMetadataViewModel;
  const title=feedText(lock?.title||node.title||node.header?.tileHeaderRenderer?.title||node.headline||node.overlayMetadata?.primaryText);
  const parts=lock?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(row=>row.metadataParts||[])||[];
  const byline=node.shortBylineText||node.longBylineText||node.ownerText;
  const texts=parts.map(part=>feedText(part.text));
  const thumbnails=images(node.contentImage?.thumbnailViewModel?.image||node.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image||node.thumbnail||node.thumbnails);
  const id=node.contentId||node.entityId?.replace(/^shorts-shelf-item-/,'')||node.videoId||node.playlistId||node.channelId||tap.watchEndpoint?.videoId||tap.reelWatchEndpoint?.videoId||tap.browseEndpoint?.browseId;
  const contentType=node.contentType||'';
  if(channelId(id)||/CHANNEL/.test(contentType)||kind==='channelRenderer') {if(channelId(id))channels.set(id,{id,title,avatar:thumbnails[0]?.url||'',subCountText:texts.join(' · ')});return;}
  if(/PLAYLIST|ALBUM|PODCAST|SHOW|COURSE/.test(contentType)||/playlist/i.test(kind)) {
   const playlistId=String(node.playlistId||id||'').replace(/^VL/,'');if(!/^[\w-]{2,150}$/.test(playlistId)||videoId(playlistId))return;
   playlists.set(playlistId,{id:playlistId,title,videoCount:count(node.videoCount||node.videoCountText||texts.find(t=>/videos|本の動画/.test(t))),thumbnails:thumbnails[0]?.url||'',thumbnail:thumbnails[0]?.url||''});return;
  }
  if(!videoId(id))return;
  const short=/SHORT/.test(contentType)||/shorts|reelItem/i.test(kind)||!!tap.reelWatchEndpoint;
  const badges=node.contentImage?.thumbnailViewModel?.overlays?.flatMap(o=>o.thumbnailBottomOverlayViewModel?.badges||[]).map(b=>b.thumbnailBadgeViewModel?.text)||[];
  const author=feedText(byline)||feedText(node.subtitle)||texts.find(t=>!/[\d,]+.*(?:視聴|views)|前$|ago$/.test(t))||'チャンネル';
  const authorEndpoint=byline?.runs?.find(r=>r.navigationEndpoint?.browseEndpoint)?.navigationEndpoint?.browseEndpoint;
  const viewText=feedText(node.viewCountText)||texts.find(t=>/視聴|views/i.test(t))||'';
  videos.set(id,{videoId:id,type:'video',title:title||'動画',author,authorId:authorEndpoint?.browseId,viewCount:count(viewText),viewCountText:viewText,publishedText:feedText(node.publishedTimeText)||texts.find(t=>/前$|ago$/.test(t))||'',lengthSeconds:duration(node.lengthText||badges.join(' ')),videoThumbnails:thumbnails.length?thumbnails:[{url:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}],isLive:badges.some(b=>/LIVE|ライブ/.test(b)),...(short?{isShort:true,shortSource:'youtube'}:{})});
 }
 function walk(value,depth=0) {
  if(!value||typeof value!=='object'||depth>40||nodes++>30000||seen.has(value))return;seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
  for(const [key,node] of Object.entries(value)) {
   if(['lockupViewModel','videoRenderer','gridVideoRenderer','compactVideoRenderer','playlistVideoRenderer','playlistPanelVideoRenderer','tileRenderer','reelItemRenderer','shortsLockupViewModel','playlistRenderer','gridPlaylistRenderer','channelRenderer','gridChannelRenderer'].includes(key)){render(node,key);continue;}
   if(['nextContinuationData','reloadContinuationData','timedContinuationData','continuationCommand'].includes(key)){const token=node?.continuation||node?.token;if(typeof token==='string'&&token.length<=16000&&!tokens.includes(token))tokens.push(token);continue;}
   // Menu commands and player responses are not additional feed entries.
   if(/menu|tracking|responseContext|playerResponse|frameworkUpdates|adSlot|adPlacement/i.test(key))continue;
   walk(node,depth+1);
  }
 }
 walk(data);return {videos:[...videos.values()],playlists:[...playlists.values()],channels:[...channels.values()],tokens};
}
const browseIds={home:'FEwhat_to_watch',shorts:'FEwhat_to_watch',history:'FEhistory',subscriptions:'FEsubscriptions',channels:'FEchannels',liked:'VLLL','watch-later':'VLWL',playlists:'FEplaylist_aggregation'};
export async function readYouTubeFeed(yt,kind,cursor='') {
 if(typeof cursor!=='string'||cursor.length>60000)throw Object.assign(new Error('続きの情報が無効です。'),{status:400});
 let queue=[];
 if(cursor){try{const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());if(parsed.kind!==kind||!Array.isArray(parsed.tokens)||parsed.tokens.length>30||parsed.tokens.some(t=>typeof t!=='string'||!t||t.length>16000))throw Error();queue=parsed.tokens;}catch{throw Object.assign(new Error('続きの情報が無効です。ページを開き直してください。'),{status:400});}}
 const browseId=browseIds[kind]||(kind.startsWith('playlist:')?'VL'+kind.slice(9).replace(/^VL/,''):null);
 if(!browseId)throw Object.assign(new Error('不明なフィードです。'),{status:400});
 const result={videos:[],playlists:[],channels:[]};const visited=new Set();let requests=0;const start=Date.now();
 const hasItems=()=>kind==='shorts'?result.videos.some(v=>v.isShort):kind==='playlists'?result.playlists.length:kind==='channels'?result.channels.length:result.videos.length;
 do {
  const token=queue.shift();if(token&&visited.has(token))continue;if(token)visited.add(token);
  const response=await yt.actions.execute('/browse',{...(token?{continuation:token}:{browseId}),client:'TV'});requests++;
  if(response.data?.error)throw Object.assign(new Error('YouTubeが一覧の取得を拒否しました。'),{status:502,code:'YOUTUBE_FEED_REJECTED'});
  const page=decodeYouTubeFeed(response.data);for(const key of ['videos','playlists','channels'])result[key].push(...page[key]);
  queue.push(...page.tokens.filter(t=>!visited.has(t)&&!queue.includes(t)));queue=queue.slice(0,30);
  // TV shelves may start with continuation-only placeholders. Hydrate these
  // before returning an empty page, with bounded request count and latency.
 }while(queue.length&&requests<4&&Date.now()-start<4500&&!hasItems());
 for(const key of ['videos','playlists','channels'])result[key]=[...new Map(result[key].map(item=>[item.videoId||item.id,item])).values()];
 while(queue.length&&Buffer.byteLength(JSON.stringify({kind,tokens:queue}))>42000)queue.pop();
 const continuation=queue.length?Buffer.from(JSON.stringify({kind,tokens:queue})).toString('base64url'):'';
 console.info(JSON.stringify({event:'youtube_feed',kind:kind.startsWith('playlist:')?'playlist':kind,videos:result.videos.length,playlists:result.playlists.length,channels:result.channels.length,hasMore:!!continuation,requests}));
 return {...result,continuation,hasMore:!!continuation,source:'youtube',personalized:['home','shorts','subscriptions'].includes(kind)};
}
