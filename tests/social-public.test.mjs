import test from 'node:test';import assert from 'node:assert/strict';
import {publicData,canonicalPost,normalizeTikwm,handlePublicSocial} from '../cloudflare/social/public.mjs';
const video={video_id:'7652308353334480135',title:'公開動画',author:{id:'10',unique_id:'creator'},play:'https://cdn.example/public.mp4',cover:'https://cdn.example/cover.jpg'};
test('public feed has no site/provider credential requirement and never sends cookies or authorization',async()=>{
 const result=await publicData('tiktok','feed',new URLSearchParams(),async(url,options)=>{assert.equal(new URL(url).hostname,'www.tikwm.com');assert.equal(new URL(url).searchParams.get('region'),'JP');assert.equal(options.redirect,'manual');assert.equal(Object.keys(options.headers).some(key=>/cookie|authorization/i.test(key)),false);return Response.json({code:0,data:[video]});});assert.equal(result.items.length,1);assert.equal(result.items[0].kind,'video');assert.equal(result.items[0].media,video.play);assert.equal(result.anonymous,true);assert.match(result.notice,/個人のFor Youとは異なります/);
});
test('public search and stories use fixed provider routes and reject login walls instead of empty success',async()=>{
 let calls=0;const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://www.tikwm.com/api/feed/search');assert.equal(new URLSearchParams(options.body).get('keywords'),'猫');return new Response('forbidden',{status:403});};await assert.rejects(publicData('tiktok','search',new URLSearchParams({q:'猫'}),fetcher),{code:'PUBLIC_UNAVAILABLE'});assert.equal(calls,1);
 const story=await publicData('tiktok','stories',new URLSearchParams({username:'@creator'}),async(url,options)=>{assert.equal(url,'https://www.tikwm.com/api/user/story');assert.equal(new URLSearchParams(options.body).get('unique_id'),'creator');return Response.json({code:0,data:{videos:[video]}});});assert.equal(story.items.length,1);
 await assert.rejects(publicData('instagram','stories',new URLSearchParams({username:'private'}),async()=>Response.json({data:{user:{id:'1',is_private:true}}})),{code:'PUBLIC_PRIVATE'});
});
test('public resolvers reject arbitrary/internal URLs, short redirects and unsafe media protocols',async()=>{
 for(const url of ['http://www.tiktok.com/@creator/video/7652308353334480135','https://localhost/private','https://user:pass@www.tiktok.com/@creator/video/7652308353334480135','https://evil.test/video/123','https://vm.tiktok.com/short'])assert.throws(()=>canonicalPost(url,'tiktok'),{code:'PUBLIC_URL'});
 assert.equal(normalizeTikwm([{...video,play:'javascript:alert(1)',cover:'https://127.0.0.1/'}])[0].media,'');
 const result=await handlePublicSocial(new Request('https://worker.test/api/tiktok/public/feed',{method:'POST'}),{},'tiktok','feed',()=>{throw Error('must not fetch')});assert.equal(result.status,405);
});
test('public Instagram HTML exposes only parsed public video URLs and rejects missing media',async()=>{
 const url='https://www.instagram.com/reel/PublicTest/';const result=await publicData('instagram','resolve',new URLSearchParams({url}),async(input,options)=>{assert.equal(input,url);assert.equal(options.headers.Cookie,undefined);return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'VideoObject',contentUrl:'https://cdn.example/movie.mp4'})+'</script>');});assert.equal(result.items[0].media,'https://cdn.example/movie.mp4');await assert.rejects(publicData('instagram','resolve',new URLSearchParams({url}),async()=>new Response('<h1>Log in</h1>')),{code:'PUBLIC_LOGIN_REQUIRED'});
});

test('public router accepts logged-out reads without accessing account sessions or linked credentials',async()=>{
 const {createSocialApi}=await import('../cloudflare/social/api.mjs');let queries=0;
 const env={API_SHARED_SECRET:'test-public-secret',ALLOWED_ORIGINS:'https://site.test',DB:{prepare(sql){queries++;assert.ok(sql.includes('login_attempts'));return {bind(){return {first:async()=>({count:1,window_start:Date.now()})}}};}}};
 const handler=createSocialApi(async(url,options)=>{assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);return Response.json({code:0,data:[video]});});
 const r=await handler(new Request('https://worker.test/api/tiktok/public/feed?cursor=1',{headers:{Origin:'https://site.test'}}),env);assert.equal(r.status,200);assert.equal((await r.json()).anonymous,true);assert.equal(queries,1);
});

test('provider daily quota failures are unavailable responses, not successful empty feeds',async()=>{
 let calls=0;await assert.rejects(publicData('tiktok','feed',new URLSearchParams(),async()=>{calls++;return Response.json({code:-1,msg:'Free Api Limit: 10000 request/ 1 day.'});}),{code:'PUBLIC_UPSTREAM_LIMIT',status:503});await assert.rejects(publicData('tiktok','stories',new URLSearchParams({username:'creator'}),async()=>{calls++;throw Error('must respect provider cooldown')}),{code:'PUBLIC_UPSTREAM_LIMIT'});assert.equal(calls,1);
});
