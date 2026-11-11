import {decodeYouTubeFeed,feedText} from './youtube-feed.mjs';
export function playlistCard(node){
 const id=String(node?.playlist_id||node?.playlistId||node?.id||node?.content_id||'').replace(/^VL/,'');
 if(!id||!(['Playlist','CompactPlaylist','GridPlaylist','Mix','Radio','CompactRadio','playlist','mix'].includes(node.type)||['PLAYLIST','STATION','ALBUM','PODCAST'].includes(node.content_type)))return null;
 const first=node.videoId||node.first_video_id||node.endpoint?.payload?.videoId||node.renderer_context?.command_context?.on_tap?.payload?.videoId||(/^RD(?:AMVM)?([\w-]{11})$/.exec(id)?.[1]);
 const thumbs=node.videoThumbnails||node.thumbnails||node.content_image?.primary_thumbnail?.image||node.content_image?.image||[];
 const images=Array.isArray(thumbs)&&thumbs.length?thumbs:/^[\w-]{11}$/.test(first||'')?[{url:`https://i.ytimg.com/vi/${first}/hqdefault.jpg`}]:[];
 return {type:id.startsWith('RD')?'mix':'playlist',playlistId:id,videoId:/^[\w-]{11}$/.test(first||'')?first:undefined,title:feedText(node.metadata?.title)||feedText(node.title)||'再生リスト',author:feedText(node.author?.name)||feedText(node.short_byline)||'YouTube',authorId:node.author?.id,authorAvatar:node.author?.thumbnails?.[0]?.url,videoThumbnails:images,viewCount:0,lengthSeconds:0,publishedText:''};
}
export async function readYouTubeMix(yt,playlistId,videoId=''){
 if(!/^RD[\w-]{2,148}$/.test(playlistId)||videoId&&!/^[\w-]{11}$/.test(videoId))throw Object.assign(new Error('ミックスリストIDが無効です。'),{status:400});
 const response=await yt.actions.execute('/next',{playlistId,...(videoId?{videoId}:{}),client:yt.session?.logged_in?'TV':'WEB'});
 let panel=null,count=0;function find(value,depth=0){if(panel||!value||typeof value!=='object'||depth>30||count++>10000)return;for(const[key,node]of Object.entries(value)){if(key==='playlistPanelRenderer'||(key==='playlist'&&Array.isArray(node?.contents)&&node.contents.some(item=>item.playlistPanelVideoRenderer||item.playlistPanelVideoWrapperRenderer))){panel=node;return;}find(node,depth+1);}}find(response.data);
 if(!panel)throw Object.assign(new Error('このミックスリストを読み込めませんでした。時間をおいて再試行してください。'),{status:502});
 const data=decodeYouTubeFeed({contents:panel.contents});if(!data.videos.length)throw Object.assign(new Error('ミックスリストに再生できる動画がありません。'),{status:502});
 return {id:playlistId,title:feedText(panel.title)||'ミックスリスト',videos:data.videos};
}
