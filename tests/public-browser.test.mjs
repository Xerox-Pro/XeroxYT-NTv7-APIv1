import test from 'node:test';import assert from 'node:assert/strict';
import {publicBrowserData,normalizeBrowserPosts} from '../cloudflare/social/public-browser.mjs';
const row={url:'https://www.tiktok.com/@creator/video/7652308353334480135',title:'Real public caption',thumbnail:'https://p16.tiktokcdn.com/cover.jpg'};
test('public browser returns only canonical platform posts without accepting HTML or untrusted origins',()=>{
 const items=normalizeBrowserPosts([row,row,{...row,url:'https://evil.test/@creator/video/7652308353334480135'},{...row,url:'javascript:alert(1)'}],'tiktok');
 assert.equal(items.length,1);assert.equal(items[0].author,'creator');assert.equal(items[0].media,undefined);assert.equal(items[0].kind,'video');
});
test('anonymous browser reads the official explore page, closes the session, and does not invent continuation',async()=>{
 let closed=0,visited='';const page={setRequestInterception:async()=>{},on(){},goto:async url=>{visited=url;},waitForSelector:async()=>{},evaluate:async()=>[row]};
 const result=await publicBrowserData('tiktok','feed',new URLSearchParams(),{BROWSER:{},SOCIAL_PUBLIC_BROWSER_ENABLED:'true'},async()=>({newPage:async()=>page,close:async()=>{closed++;}}));
 assert.equal(visited,'https://www.tiktok.com/explore');assert.equal(closed,1);assert.equal(result.items.length,1);assert.equal(result.cursor,'');assert.equal(result.anonymous,true);
});
test('rejected and empty pages close the browser; arbitrary URL resolution never launches it',async()=>{
 let launches=0,closed=0;const launch=async()=>{launches++;return {newPage:async()=>({setRequestInterception:async()=>{},on(){},goto:async()=>{},waitForSelector:async()=>{},evaluate:async()=>[]}),close:async()=>{closed++;}}};
 const env={BROWSER:{},SOCIAL_PUBLIC_BROWSER_ENABLED:'true'};
 await assert.rejects(publicBrowserData('tiktok','resolve',new URLSearchParams({url:'https://localhost/private'}),env,launch),{code:'PUBLIC_URL'});assert.equal(launches,0);
 await assert.rejects(publicBrowserData('tiktok','feed',new URLSearchParams(),env,launch),{code:'PUBLIC_BROWSER_UNAVAILABLE'});assert.equal(closed,1);
});
