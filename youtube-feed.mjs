// OAuth uses TV responses. Read their content renderers rather than Web-only
// HomeFeed/Playlist wrappers, or unrelated nodes from the parser's global memo.
const videoId = value => typeof value === 'string' && /^[\w-]{11}$/.test(value);
const channelId = value => typeof value === 'string' && /^UC[\w-]{22}$/.test(value);
export const feedText = value => {if(typeof value==='string')return value;for(const key of ['text','content','simpleText'])if(typeof value?.[key]==='string')return value[key];return Array.isArray(value?.runs)?value.runs.map(run=>typeof run.text==='string'?run.text:'').join(''):'';};
const images=value=>{const list=Array.isArray(value)?value:value?.sources||value?.thumbnails;return Array.isArray(list)?list:[];};
function endpoint(node) { return node?.rendererContext?.commandContext?.onTap?.innertubeCommand || node?.onTap?.innertubeCommand || node?.onTap || node?.onSelectCommand || node?.navigationEndpoint || node?.endpoint || {}; }
function count(value) { const match=feedText(value).replace(/,/g,'').match(/([\d.]+)\s*([万億KMB])?/i); return match ? Math.round(Number(match[1])*({万:1e4,億:1e8,K:1e3,M:1e6,B:1e9}[match[2]?.toUpperCase()]||1)) : 0; }
function duration(value) { const match=feedText(value).match(/\b\d+(?::\d{2}){1,2}\b/); return match ? match[0].split(':').reduce((n,p)=>n*60+Number(p),0) : 0; }
export function decodeYouTubeFeed(data) {
 const videos=new Map(),playlists=new Map(),channels=new Map(),tokens=[];const seen=new WeakSet();let nodes=0;
 function render(node,kind,inShortsShelf=false) {
  if(!node||typeof node!=='object')return;
  const tap=endpoint(node),lock=node.metadata?.lockupMetadataViewModel,tile=node.metadata?.tileMetadataRenderer;
  const title=[lock?.title,tile?.title,node.title,node.header?.tileHeaderRenderer?.title,node.headline,node.overlayMetadata?.primaryText].map(feedText).find(Boolean)||'';
  const parts=lock?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(row=>row.metadataParts||[])||[];
  const byline=node.shortBylineText||node.longBylineText||node.ownerText;
  const tileItems=tile?.lines?.flatMap(line=>line.lineRenderer?.items||[])||[];
  const texts=[...parts.map(part=>feedText(part.text)),...tileItems.map(item=>feedText(item.lineItemRenderer?.text))].filter(Boolean);
  const thumbnails=images(node.contentImage?.thumbnailViewModel?.image||node.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image||node.header?.tileHeaderRenderer?.thumbnail||node.thumbnail||node.thumbnails);
  const id=node.contentId||node.videoId||node.playlistId||node.channelId||tap.watchEndpoint?.videoId||tap.reelWatchEndpoint?.videoId||tap.browseEndpoint?.browseId||(typeof node.entityId==='string'?node.entityId.replace(/^shorts-shelf-item-/,''):'');
  const contentType=node.contentType||'';
  if(channelId(id)||/CHANNEL/.test(contentType)||kind==='channelRenderer') {if(channelId(id))channels.set(id,{id,title,avatar:thumbnails[0]?.url||'',subCountText:texts.join(' · ')});return;}
  const playlistId=String(node.playlistId||tap.watchEndpoint?.playlistId||tap.watchPlaylistEndpoint?.playlistId||((/PLAYLIST|ALBUM|PODCAST|SHOW|COURSE|STATION/.test(contentType)||['playlistRenderer','gridPlaylistRenderer','compactPlaylistRenderer','radioRenderer','compactRadioRenderer','mixRenderer'].includes(kind))?id:'')||'').replace(/^VL/,'');
  const playlistCard=!!playlistId&&(/PLAYLIST|ALBUM|PODCAST|SHOW|COURSE|STATION/.test(contentType)||['playlistRenderer','gridPlaylistRenderer','compactPlaylistRenderer','radioRenderer','compactRadioRenderer','mixRenderer'].includes(kind)||(kind==='tileRenderer'&&!/VIDEO/.test(contentType)));
  if(playlistCard){
   if(!/^[\w-]{2,150}$/.test(playlistId))return;
   const first=tap.watchEndpoint?.videoId||node.firstVideoId||node.videos?.[0]?.childVideoRenderer?.videoId||(/^RD(?:AMVM)?([\w-]{11})$/.exec(playlistId)?.[1]);
   const cover=thumbnails[0]?.url||(videoId(first)?`https://i.ytimg.com/vi/${first}/hqdefault.jpg`:'');
   playlists.set(playlistId,{id:playlistId,playlistId,videoId:videoId(first)?first:undefined,type:playlistId.startsWith('RD')?'mix':'playlist',title,author:feedText(byline)||texts.join(' · ')||'YouTube',videoCount:count(node.videoCount||node.videoCountText||texts.find(t=>/videos|本の動画/.test(t))),thumbnails:cover,thumbnail:cover,videoThumbnails:cover?[{url:cover}]:[],viewCount:0,publishedText:'',lengthSeconds:0});return;
  }
  if(!videoId(id))return;
  const short=inShortsShelf||/SHORT/.test(node.style||'')||/SHORT/.test(contentType)||/shorts|reelItem/i.test(kind)||!!tap.reelWatchEndpoint;
  const overlays=node.header?.tileHeaderRenderer?.thumbnailOverlays||node.thumbnailOverlays||[];
  const badges=[...(node.contentImage?.thumbnailViewModel?.overlays?.flatMap(o=>o.thumbnailBottomOverlayViewModel?.badges||[]).map(b=>b.thumbnailBadgeViewModel?.text)||[]),...overlays.map(o=>feedText(o.thumbnailOverlayTimeStatusRenderer?.text))].filter(Boolean);
  const author=feedText(byline)||feedText(node.subtitle)||texts.find(t=>!/[\d,]+.*(?:視聴|views)|前$|ago$/.test(t))||'チャンネル';
  const authorEndpoint=byline?.runs?.find(r=>r.navigationEndpoint?.browseEndpoint)?.navigationEndpoint?.browseEndpoint;
  const viewText=feedText(node.viewCountText)||texts.find(t=>/視聴|views/i.test(t))||'';
  videos.set(id,{videoId:id,type:'video',title:title||'動画',author,authorId:authorEndpoint?.browseId,viewCount:count(viewText),viewCountText:viewText,publishedText:feedText(node.publishedTimeText)||texts.find(t=>/前$|ago$/.test(t))||'',lengthSeconds:duration(node.lengthText||badges.join(' ')),videoThumbnails:thumbnails.length?thumbnails:[{url:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}],isLive:badges.some(b=>/LIVE|ライブ/.test(b)),...(short?{isShort:true,shortSource:'youtube'}:{})});
 }
 function walk(value,depth=0,inShortsShelf=false) {
  if(!value||typeof value!=='object'||depth>40||nodes++>30000||seen.has(value))return;seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,depth+1,inShortsShelf);return;}
  for(const [key,node] of Object.entries(value)) {
   if(['lockupViewModel','videoRenderer','gridVideoRenderer','compactVideoRenderer','playlistVideoRenderer','playlistPanelVideoRenderer','tileRenderer','reelItemRenderer','shortsLockupViewModel','playlistRenderer','gridPlaylistRenderer','compactPlaylistRenderer','radioRenderer','compactRadioRenderer','mixRenderer','channelRenderer','gridChannelRenderer'].includes(key)){render(node,key,inShortsShelf);continue;}
   if(['nextContinuationData','reloadContinuationData','timedContinuationData','continuationCommand'].includes(key)){const token=node?.continuation||node?.token;if(typeof token==='string'&&token.length<=16000&&!tokens.includes(token))tokens.push(token);continue;}
   // Menu commands and player responses are not additional feed entries.
   if(/menu|tracking|responseContext|playerResponse|frameworkUpdates|adSlot|adPlacement/i.test(key))continue;
   walk(node,depth+1,inShortsShelf||key==='reelShelfRenderer'||(key==='shelfRenderer'&&/^(shorts|ショート(?:動画)?)$/i.test(feedText(node?.title))));
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
 const uniqueVideos=()=>new Set(result.videos.filter(v=>kind!=='shorts'||v.isShort).map(v=>v.videoId)).size;
 const hasItems=()=>kind==='playlists'?result.playlists.length>=24:kind==='channels'?result.channels.length>=24:uniqueVideos()>=(kind==='shorts'?24:36);
 do {
  const token=queue.shift();if(token&&visited.has(token))continue;if(token)visited.add(token);
  let response;try{response=await yt.actions.execute('/browse',{...(token?{continuation:token}:{browseId}),client:'TV'});}catch(error){if(!token||!(result.videos.length||result.playlists.length||result.channels.length))throw error;queue.unshift(token);break;}requests++;
  if(response.data?.error&&token&&(result.videos.length||result.playlists.length||result.channels.length)){queue.unshift(token);break;}
  if(response.data?.error)throw Object.assign(new Error('YouTubeが一覧の取得を拒否しました。'),{status:502,code:'YOUTUBE_FEED_REJECTED'});
  const page=decodeYouTubeFeed(response.data);for(const key of ['videos','playlists','channels'])result[key].push(...page[key]);
  queue.push(...page.tokens.filter(t=>!visited.has(t)&&!queue.includes(t)));queue=queue.slice(0,30);
  // TV shelves may start with continuation-only placeholders. Hydrate these
  // before returning an empty page, with bounded request count and latency.
 }while(queue.length&&requests<(kind==='shorts'?8:6)&&Date.now()-start<6500&&!hasItems());
 for(const key of ['videos','playlists','channels'])result[key]=[...new Map(result[key].map(item=>[item.videoId||item.id,item])).values()];
 while(queue.length&&Buffer.byteLength(JSON.stringify({kind,tokens:queue}))>42000)queue.pop();
 const continuation=queue.length?Buffer.from(JSON.stringify({kind,tokens:queue})).toString('base64url'):'';
 console.info(JSON.stringify({event:'youtube_feed',kind:kind.startsWith('playlist:')?'playlist':kind,videos:result.videos.length,playlists:result.playlists.length,channels:result.channels.length,hasMore:!!continuation,requests}));
 return {...result,continuation,hasMore:!!continuation,source:'youtube',personalized:['home','shorts','subscriptions'].includes(kind)};
}
