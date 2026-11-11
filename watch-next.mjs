import {decodeYouTubeFeed} from './youtube-feed.mjs';
// Metadata/player requests may be blocked while /next still works. Fetch related
// videos independently through the ordinary anonymous Web client.
export async function fetchPublicWatchNext(yt,videoId,continuation=''){
 const response=await yt.actions.execute('/next',{videoId,...(continuation?{continuation}:{}),client:'WEB'});
 const page=decodeYouTubeFeed(response.data);const token=page.tokens[0]||'';
 return {watch_next_feed:[...page.videos,...page.playlists].filter(v=>v.videoId!==videoId),has_continuation:!!token,getWatchNextContinuation:token?()=>fetchPublicWatchNext(yt,videoId,token):undefined};
}
