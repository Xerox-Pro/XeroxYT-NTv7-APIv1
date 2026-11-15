import test from 'node:test';import assert from 'node:assert/strict';
import {readInstagramPublicPost} from '../cloudflare/social/instagram-public.mjs';
import {publicData,canonicalPost} from '../cloudflare/social/public.mjs';
import {expandShareUrl} from '../cloudflare/social/public-links.mjs';
const url='https://www.instagram.com/reel/PublicCode/';
const media={code:'PublicCode',pk:'123',media_type:8,user:{username:'creator',is_private:false},carousel_media:[{media_type:1,image_versions2:{candidates:[{url:'https://cdn.example/photo.jpg'}]}},{media_type:2,video_versions:[{url:'https://cdn.example/movie.mp4'}]}]};
function fetcher(privateUser=false){let calls=0;return async(input,options)=>{
 assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);
 if(calls++===0){assert.equal(input,'https://www.instagram.com/');assert.equal(options.headers.Cookie,undefined);return new Response('"LSD",[],{"token":"page-issued"} "IG_USER_EIMU":"0"',{headers:{'Set-Cookie':'csrftoken=anonymous-page; Path=/; Secure'}});}
 assert.equal(input,'https://www.instagram.com/api/graphql');assert.equal(options.headers.Cookie,'csrftoken=anonymous-page');assert.equal(options.headers['X-FB-LSD'],'page-issued');assert.equal(new URLSearchParams(options.body).get('doc_id'),'27128499623469141');
 return Response.json({data:{xdt_api__v1__media__shortcode__web_info:{items:[{...media,user:{...media.user,is_private:privateUser}}]}}});
};}
test('Instagram uses only fresh anonymous page tokens and normalizes public carousel media',async()=>{
 const result=await publicData('instagram','resolve',new URLSearchParams({url}),fetcher());assert.equal(result.items[0].kind,'carousel');assert.equal(result.items[0].children.length,2);assert.equal(result.source,'Instagram anonymous web API');assert.equal(result.items[0].author,'creator');
});
test('Instagram private metadata and foreign destinations fail',async()=>{
 await assert.rejects(readInstagramPublicPost(url,fetcher(true)),{code:'PUBLIC_INSTAGRAM_UNAVAILABLE'});
 await assert.rejects(readInstagramPublicPost('https://evil.test/reel/PublicCode/',()=>{throw Error('network')}),{status:400});
});
test('official share links expand with bounded fixed-platform redirects and no credentials',async()=>{
 let calls=0;const resolved=await expandShareUrl('https://vt.tiktok.com/Public123/','tiktok',canonicalPost,async(input,options)=>{calls++;assert.equal(options.headers.Cookie,undefined);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://www.tiktok.com/@creator/video/7652308353334480135?share=1'}});});
 assert.equal(resolved,'https://www.tiktok.com/@creator/video/7652308353334480135');assert.equal(calls,1);
 await assert.rejects(expandShareUrl('https://vt.tiktok.com/Public123/','tiktok',canonicalPost,async()=>new Response(null,{status:302,headers:{Location:'https://localhost/private'}})),{code:'PUBLIC_URL'});
});
