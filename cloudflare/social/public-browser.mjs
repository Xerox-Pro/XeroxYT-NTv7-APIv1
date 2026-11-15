import puppeteer from '@cloudflare/puppeteer';

const fail=(code,message,status=503)=>Object.assign(new Error(message),{code,status});
const safe=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!/^\d+(?:\.\d+){3}$|^\[|localhost$/i.test(u.hostname)?u.href:'';}catch{return '';}};
export function normalizeBrowserPosts(rows,service){
 const result=[];
 for(const row of rows){
  const url=safe(row.url);if(!url)continue;const u=new URL(url);
  const match=service==='tiktok'&&u.hostname==='www.tiktok.com'?u.pathname.match(/^\/@([\w.]{1,40})\/(?:video|photo)\/(\d{10,25})\/?$/):service==='instagram'&&u.hostname==='www.instagram.com'?u.pathname.match(/^\/(p|reel|reels)\/([\w-]{4,80})\/?$/):null;
  if(!match)continue;
  const author=service==='tiktok'?match[1]:String(row.author||'').slice(0,40),id=match[2];
  result.push({id:(service==='tiktok'?'tt:':'ig:')+id,service,kind:service==='tiktok'||match[1]!=='p'?'video':'post',url:u.origin+u.pathname,title:String(row.title||'公開投稿').slice(0,1500),author,profileUsername:author,thumbnail:safe(row.thumbnail)});
 }
 return [...new Map(result.map(row=>[row.id,row])).values()].slice(0,24);
}

export async function publicBrowserData(service,route,params,env,launch=puppeteer.launch){
 if(!env.BROWSER||env.SOCIAL_PUBLIC_BROWSER_ENABLED!=='true')throw fail('PUBLIC_BROWSER_DISABLED','公開ブラウザは未設定です。');
 let target;
 if(route==='resolve')target=params.get('url');
 else if(service==='tiktok'&&route==='feed')target='https://www.tiktok.com/explore';
 else if(service==='tiktok'&&route==='search'){
  const q=params.get('q')||'';
  target=/^@[\w.]{1,40}$/.test(q)?'https://www.tiktok.com/@'+encodeURIComponent(q.slice(1)):'https://www.tiktok.com/search?'+new URLSearchParams({q});
 }else throw fail('PUBLIC_BROWSER_UNSUPPORTED','この公開データには対応していません。');
 const host=service==='tiktok'?'www.tiktok.com':'www.instagram.com';
 const u=new URL(target);if(u.protocol!=='https:'||u.hostname!==host||u.username||u.password||u.port)throw fail('PUBLIC_URL','公開投稿URLが無効です。',400);
 let browser;
 try{
  browser=await launch(env.BROWSER);
  const page=await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request',request=>{
   let blocked=['image','media','font'].includes(request.resourceType());
   if(request.isNavigationRequest()&&request.frame()===page.mainFrame()){
    try{const url=new URL(request.url());blocked||=url.protocol!=='https:'||url.hostname!==host;}catch{blocked=true;}
   }
   void (blocked?request.abort():request.continue()).catch(()=>{});
  });
  await page.goto(target,{waitUntil:'domcontentloaded',timeout:10000});
  const selector=service==='tiktok'?'a[href*="/video/"]':'a[href*="/p/"],a[href*="/reel/"]';
  await page.waitForSelector(selector,{timeout:5000}).catch(()=>{});
  const rows=await page.evaluate((service)=>{
   const rows=[];
   for(const a of document.querySelectorAll(service==='tiktok'?'a[href*="/video/"]':'a[href*="/p/"],a[href*="/reel/"]')){
    const img=a.querySelector('img')||a.parentElement?.querySelector('img');
    rows.push({url:a.href,title:img?.alt||a.getAttribute('title')||a.textContent?.trim(),thumbnail:img?.currentSrc||img?.src});
   }
   // Post pages may expose their own canonical URL without a card link.
   if(service==='instagram'){
    const canonical=document.querySelector('link[rel="canonical"]')?.href;
    const description=document.querySelector('meta[property="og:description"]')?.content;
    if(canonical&&description)rows.push({url:canonical,title:description,thumbnail:document.querySelector('meta[property="og:image"]')?.content});
   }
   return rows;
  },service);
  let items=normalizeBrowserPosts(rows,service);
  if(route==='resolve')items=items.filter(row=>row.url.replace(/\/$/,'')===target.replace(/\/$/,''));
  if(!items.length)throw fail('PUBLIC_BROWSER_UNAVAILABLE','この公開ページから投稿を取得できませんでした。ログイン要求・閲覧制限の可能性があります。',403);
  const source=service+' public web · Cloudflare Browser Run';
  if(route==='search'&&params.get('kind')==='users')return {items:[],users:[...new Map(items.map(row=>[row.author,{id:row.author,username:row.author,name:row.author,avatar:''}])).values()],source,anonymous:true,cursor:'',notice:'取得できた公開投稿の投稿者です。'};
  return {items,source,anonymous:true,cursor:'',notice:'公式の公開ページから取得し、公式プレイヤーで表示します。個人向けFor Youではありません。'};
 }catch(error){if(typeof error.code==='string'&&error.code.startsWith('PUBLIC_'))throw error;throw fail('PUBLIC_BROWSER_UNAVAILABLE','公開ページの取得が混み合っているか、サービス側が取得を制限しています。');}
 finally{if(browser)await browser.close().catch(()=>{});}
}
