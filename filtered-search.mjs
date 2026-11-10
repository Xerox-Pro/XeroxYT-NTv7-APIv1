import {normalizeSearchFilters,encodeSearchFilters} from './search-filters.mjs';
export function registerFilteredSearch(app,{getYt,formatVideoObject,formatSearchChannel,Search,ContinuationItem}){
 const sessions=new Map();
 app.get('/api/search',async(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,500);
  const page=Math.min(50,Math.max(1,Number.parseInt(req.query.page,10)||1));
  const filters=normalizeSearchFilters(req.query);
  const cursor=typeof req.query.continuation==='string'&&req.query.continuation.length<=20000?req.query.continuation:'';
  if(!q)return res.json({videos:[],channels:[],hasMore:false});
  // Do not reuse a continuation across different credentials or filter combinations.
  const key=JSON.stringify([q,filters,String(req.headers['x-youtube-credentials']||''),String(req.headers['x-client-id']||'')]);
  const now=Date.now();for(const [id,value] of sessions)if(now-value.at>10*60000)sessions.delete(id);
  if(sessions.size>100)sessions.delete(sessions.keys().next().value);
  let session=sessions.get(key);
  if(!session){session={at:now,feed:null,pages:new Map(),chain:Promise.resolve()};sessions.set(key,session);}
  const current=session;
  const work=async()=>{
   current.at=Date.now();
   if(current.pages.has(page))return current.pages.get(page);
   const yt=await getYt();
   if(!current.feed){const response=await yt.actions.execute('/search',page>1&&cursor?{continuation:cursor}:{query:q,params:encodeSearchFilters(filters)});current.feed=new Search(yt.actions,response);current.page=page>1&&cursor?page:1;}
   const serialize=feed=>{
    const raw=[...(feed.results||[])];
    const videos=[],channels=[],seen=new Set();
    for(const item of raw){
     if(/Channel/.test(item?.type||'')){const channel=formatSearchChannel(item);if(channel&&!seen.has(channel.id)){seen.add(channel.id);channels.push(channel);}continue;}
     const video=formatVideoObject(item);const id=video?.playlistId||video?.videoId;if(video&&id&&!seen.has(id)){seen.add(id);videos.push(filters.type==='shorts'?{...video,isShort:true}:video);}
    }
    const continuation=feed.memo.getType(ContinuationItem).find(item=>item.endpoint?.payload?.token)?.endpoint.payload.token||'';
    return {videos,channels,hasMore:Boolean(feed.has_continuation),continuation,filters};
   };
   if(!current.pages.has(current.page))current.pages.set(current.page,serialize(current.feed));
   while(current.page<page&&current.feed.has_continuation){current.feed=await current.feed.getContinuation();current.page++;current.pages.set(current.page,serialize(current.feed));}
   return current.pages.get(page)||{videos:[],channels:[],hasMore:false,filters};
  };
  const task=current.chain.then(work);current.chain=task.catch(()=>{});
  try{res.setHeader('Cache-Control','private, no-store');res.json(await task);}catch(error){if(!current.feed)sessions.delete(key);console.warn('[Search]',error?.message);res.status(502).json({error:'検索結果を取得できませんでした。再試行してください。'});}
 });
}
