import test from 'node:test';import assert from 'node:assert/strict';
import {publicCacheKey,readPublicCache,writePublicCache} from '../cloudflare/social/public-cache.mjs';
import {handlePublicSocial} from '../cloudflare/social/public.mjs';
test('anonymous cache keys ignore cache-busting extras, separate services and share no account data',async()=>{
 const request=new Request('https://worker.test/api/tiktok/public/feed?nonce=1&cursor=0',{headers:{Cookie:'private-session=secret'}}),key=publicCacheKey(request,'tiktok','feed');assert.equal(key,publicCacheKey(new Request('https://worker.test/api/tiktok/public/feed?cursor=0&nonce=2'),'tiktok','feed'));assert.ok(!key.includes('secret'));assert.notEqual(key,publicCacheKey(request,'instagram','feed'));
 const saved=new Map(),store={put:async(k,v)=>saved.set(k,v),match:async k=>saved.get(k)?.clone()};
 await writePublicCache(key,{items:[{id:'public-post'}]},'feed',store);assert.equal(saved.size,1);const entry=await readPublicCache(key,store);assert.equal(entry.value.items[0].id,'public-post');assert.ok(entry.expires>Date.now()+1700000);assert.match(saved.get(key).headers.get('cache-control'),/public,max-age=/);
 const staleKey=key+'&stale=1';saved.set(staleKey,Response.json({value:{items:[{id:'cached'}]},expires:Date.now()-1,staleUntil:Date.now()+10000}));assert.equal((await readPublicCache(staleKey,store)).value.items[0].id,'cached');
 const expiredKey=key+'&expired=1';saved.set(expiredKey,Response.json({value:{items:[]},expires:0,staleUntil:0}));assert.equal(await readPublicCache(expiredKey,store),null);
});
test('temporary upstream failure serves a marked previous public result, while access denial remains an error',async()=>{
 const request=new Request('https://cache-test.example/api/instagram/public/search?q=cache_creator');
 const first=await handlePublicSocial(request,{},'instagram','search',async()=>Response.json({data:{user:{id:'123',username:'cache_creator'}}}));assert.equal(first.status,200);
 const realNow=Date.now;Date.now=()=>realNow()+16*60000;
 try{
  const stale=await handlePublicSocial(request,{},'instagram','search',async()=>new Response('unavailable',{status:503}));assert.equal(stale.status,200);assert.equal(stale.headers.get('X-Social-Cache'),'STALE');assert.equal((await stale.json()).stale,true);
  const denied=await handlePublicSocial(request,{},'instagram','search',async()=>new Response('denied',{status:403}));assert.equal(denied.status,403);
 }finally{Date.now=realNow;}
});
