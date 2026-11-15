export function shareUrl(value,service){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return false;
 return service==='tiktok'?(['vm.tiktok.com','vt.tiktok.com'].includes(u.hostname)&&/^\/[\w-]{3,100}\/?$/.test(u.pathname)||['www.tiktok.com','tiktok.com'].includes(u.hostname)&&/^\/t\/[\w-]{3,100}\/?$/.test(u.pathname)):service==='instagram'&&['www.instagram.com','instagram.com'].includes(u.hostname)&&/^\/share\/(?:p|reel|reels)\/[\w-]{3,100}\/?$/.test(u.pathname);
 }catch{return false;}
}
export async function expandShareUrl(value,service,canonical,fetcher=fetch){
 if(!shareUrl(value,service))return canonical(value,service);
 let current=new URL(value);
 for(let n=0;n<4;n++){
  const response=await fetcher(current.href,{headers:{'User-Agent':'Mozilla/5.0',Accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(5000)});
  const location=response.headers.get('location');await response.body?.cancel();
  if(response.status<300||response.status>=400||!location)break;
  const next=new URL(location,current),allowed=service==='tiktok'?['www.tiktok.com','tiktok.com','vm.tiktok.com','vt.tiktok.com']:['www.instagram.com','instagram.com'];
  if(next.protocol!=='https:'||next.username||next.password||next.port||!allowed.includes(next.hostname))break;
  try{return canonical(next.href,service);}catch{}
  if(!shareUrl(next.href,service))break;current=next;
 }
 throw Object.assign(new Error('共有リンクを展開できませんでした。公式で開き、投稿の完全なURLをコピーしてください。'),{code:'PUBLIC_URL',status:400});
}
