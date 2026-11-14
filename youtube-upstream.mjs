export function upstreamFailure(error){
 const status=Number(error?.status||error?.statusCode||/status code (\d{3})/.exec(error?.message||'')?.[1]);
 if([403,429].includes(status))return {status:503,error:status===429?'YouTubeのリクエスト制限に達しました。少し待って再試行してください。':'YouTubeがこの取得処理を拒否しました。連携情報は保持しています。時間をおいて再試行してください。',code:status===429?'YOUTUBE_UPSTREAM_RATE_LIMITED':'YOUTUBE_UPSTREAM_REJECTED',retryAfter:30};
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return {status:504,error:'YouTubeからの応答が時間内に届きませんでした。再試行してください。',code:'YOUTUBE_UPSTREAM_TIMEOUT',retryAfter:10};
 return null;
}
export function notificationItems(data){
 if(data?.error)throw Object.assign(new Error('YouTube notification request rejected'),{status:Number(data.error.code)||502});
 const result=[],seen=new WeakSet(),ids=new Set();let count=0;
 const text=value=>typeof value==='string'?value:value?.simpleText||value?.runs?.map(run=>run.text||'').join('')||'';
 function walk(node,depth=0){
  if(!node||typeof node!=='object'||depth>24||seen.has(node)||count++>5000)return;seen.add(node);
  if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return;}
  const item=node.notificationRenderer;
  if(item){
   const id=item.notificationId||item.notification_id;
   if(id&&!ids.has(id)){ids.add(id);result.push({id,message:text(item.shortMessage),sentTime:text(item.sentTimeText),read:!!item.read,avatar:item.thumbnail?.thumbnails?.[0]?.url||item.thumbnails?.[0]?.url||'',thumbnail:item.videoThumbnail?.thumbnails?.[0]?.url||'',videoId:item.navigationEndpoint?.watchEndpoint?.videoId||''});}
   return;
  }
  for(const [key,value]of Object.entries(node))if(!/tracking|responseContext|frameworkUpdates/i.test(key))walk(value,depth+1);
 }
 walk(data);return result;
}
export function homeCategoryItems(data){
 if(data?.error)throw Object.assign(new Error('YouTube home request rejected'),{status:Number(data.error.code)||502});
 const result=new Set(),seen=new WeakSet();let count=0;
 function walk(node,depth=0){
  if(!node||typeof node!=='object'||depth>24||seen.has(node)||count++>5000)return;seen.add(node);
  if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return;}
  const chip=node.chipCloudChipRenderer;
  if(chip){const value=chip.text?.simpleText||chip.text?.runs?.map(run=>run.text||'').join('');if(value&&!/^(すべて|all)$/i.test(value))result.add(value);return;}
  for(const [key,value]of Object.entries(node))if(!/videoRenderer|lockupViewModel|thumbnail|tracking|responseContext|frameworkUpdates/i.test(key))walk(value,depth+1);
 }
 walk(data);return [...result];
}
