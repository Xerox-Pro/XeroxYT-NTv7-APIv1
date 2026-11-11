export const COMMENT_PAGE_SIZE=20;
export function createCommentPages(feed,parse){
 const buffer=[],seen=new Set();for(const item of parse(feed?.contents||[])){if(!seen.has(item.id)){seen.add(item.id);buffer.push(item);}}
 return {feed,buffer,seen,pages:new Map(),currentPage:0,hasMore:buffer.length>0||!!feed?.has_continuation};
}
export function readCommentPage(session,page,parse){
 const task=(session.pending||Promise.resolve()).then(async()=>{
  while(session.currentPage<page){
   let emptyPages=0;
   while(session.buffer.length<COMMENT_PAGE_SIZE&&session.feed?.has_continuation&&emptyPages<3){
    // Do not prefetch another provider batch while any unread comments remain.
    if(session.buffer.length)break;
    session.feed=await session.feed.getContinuation();emptyPages++;
    for(const item of parse(session.feed?.contents||[]))if(!session.seen.has(item.id)){session.seen.add(item.id);session.buffer.push(item);}
   }
   const items=session.buffer.splice(0,COMMENT_PAGE_SIZE);
   session.hasMore=session.buffer.length>0||!!session.feed?.has_continuation;
   if(!items.length){session.hasMore=false;break;}
   session.pages.set(++session.currentPage,items);
  }
  return {page,comments:session.pages.get(page)||[],hasMore:page<session.currentPage||session.hasMore};
 });
 session.pending=task.catch(()=>{});return task;
}
