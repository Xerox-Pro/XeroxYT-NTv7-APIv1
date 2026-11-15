import {boundedBytes} from '../security/http.mjs';

// Reference: Instaloader's logged-out web_api query (structures.py and
// instaloadercontext.py). Use tokens issued by a fresh anonymous start page;
// never accept a user's Instagram credentials or reuse account-session cookies.
const UA='Mozilla/5.0';
const fail=(message,status=403)=>Object.assign(new Error(message),{code:'PUBLIC_INSTAGRAM_UNAVAILABLE',status});
async function text(response){if(!response.ok)throw fail('Instagramが公開データの取得を拒否しました。',response.status===429?429:403);return new TextDecoder().decode(await boundedBytes(response,3000000));}
export async function readInstagramPublicPost(url,fetcher=fetch){
 const target=new URL(url),match=target.pathname.match(/^\/(?:p|reel|reels|tv)\/([\w-]{4,80})\/?$/);
 if(target.protocol!=='https:'||target.hostname!=='www.instagram.com'||target.username||target.password||target.port||!match)throw fail('公開投稿URLが無効です。',400);
 const home=await fetcher('https://www.instagram.com/',{headers:{'User-Agent':UA,Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(6000)});
 const html=await text(home),lsd=html.match(/"LSD",\[\],\{[^{}]*"token":"([^"]+)"/)?.[1],av=html.match(/"IG_USER_EIMU":"?(\d+)/)?.[1];
 if(!lsd||lsd.length>500)throw fail('Instagramの公開ページ形式が変更されたか、取得が制限されています。');
 const cookies=typeof home.headers.getSetCookie==='function'?home.headers.getSetCookie().join(';'):home.headers.get('set-cookie')||'';
 const csrf=/(?:^|[;,]\s*)csrftoken=([^;,\s]+)/.exec(cookies)?.[1];
 const body=new URLSearchParams({doc_id:'27128499623469141',variables:JSON.stringify({shortcode:match[1],__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider:false}),server_timestamps:'true',lsd,...(av?{av}:{})});
 const response=await fetcher('https://www.instagram.com/api/graphql',{method:'POST',headers:{'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded','X-FB-LSD':lsd,Referer:'https://www.instagram.com/',...(csrf?{Cookie:'csrftoken='+csrf,'X-CSRFToken':csrf}:{})},body,redirect:'manual',signal:AbortSignal.timeout(6000)});
 let data;try{data=JSON.parse((await text(response)).replace(/^for \(;;\);/,''));}catch(error){if(error.code)throw error;throw fail('Instagramから投稿データを取得できませんでした。');}
 const items=data.data?.xdt_api__v1__media__shortcode__web_info?.items;
 if(!Array.isArray(items)||!items.length)throw fail('この公開投稿は現在取得できません。削除・閲覧制限の可能性があります。');
 if(items.some(item=>item.user?.is_private===true||item.is_private===true))throw fail('非公開投稿は取得できません。');
 return items.filter(item=>item.code===match[1]).slice(0,1);
}
