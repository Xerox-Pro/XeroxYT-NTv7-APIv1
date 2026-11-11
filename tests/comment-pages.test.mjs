import test from 'node:test';import assert from 'node:assert/strict';import{createCommentPages,readCommentPage}from'../comment-pages.mjs';
const comments=(n,start=0)=>Array.from({length:n},(_,i)=>({id:String(start+i)}));
test('large provider batches return twenty at a time and do not prefetch continuations',async()=>{
 let requests=0;const next={contents:comments(20,120),has_continuation:false};const feed={contents:comments(120),has_continuation:true,getContinuation:async()=>{requests++;return next;}};const session=createCommentPages(feed,x=>x);
 for(let page=1;page<=6;page++){const r=await readCommentPage(session,page,x=>x);assert.equal(r.comments.length,20);assert.equal(r.comments[0].id,String((page-1)*20));assert.equal(requests,0);assert.equal(r.hasMore,true);}
 const last=await readCommentPage(session,7,x=>x);assert.equal(requests,1);assert.equal(last.comments.length,20);assert.equal(last.hasMore,false);
});
test('concurrent requests for the same next page share one provider request and keep all comments',async()=>{
 let requests=0;const feed={contents:comments(20),has_continuation:true,getContinuation:async()=>{requests++;return {contents:comments(22,18),has_continuation:false};}};const session=createCommentPages(feed,x=>x);await readCommentPage(session,1,x=>x);const [a,b]=await Promise.all([readCommentPage(session,2,x=>x),readCommentPage(session,2,x=>x)]);assert.deepEqual(a,b);assert.equal(requests,1);assert.equal(a.comments.length,20);assert.equal(a.comments[0].id,'20');assert.equal(a.hasMore,false);
});
