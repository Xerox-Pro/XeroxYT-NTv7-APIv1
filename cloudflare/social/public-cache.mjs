const memory=new Map();
export function publicCacheKey(request,service,route){
 const input=new URL(request.url),url=new URL('/__public-social-cache/v2/'+service+'/'+route,input.origin);
 for(const name of ['url','q','username','kind','cursor'])if(input.searchParams.has(name))url.searchParams.set(name,input.searchParams.get(name));
 url.searchParams.sort();return url.href;
}
export async function readPublicCache(key,store=globalThis.caches?.default){
 let entry=memory.get(key);
 if(!entry&&store){try{entry=await (await store.match(key))?.json();}catch{}}
 if(!entry||entry.staleUntil<=Date.now()){memory.delete(key);return null;}
 return entry;
}
export async function writePublicCache(key,value,route,store=globalThis.caches?.default){
 const fresh=route==='feed'?1800000:route==='resolve'?300000:900000;
 const entry={value,expires:Date.now()+fresh,staleUntil:Date.now()+(route==='resolve'?900000:21600000)};
 if(memory.size>=150)memory.delete(memory.keys().next().value);memory.set(key,entry);
 if(store){try{await store.put(key,Response.json(entry,{headers:{'Cache-Control':'public,max-age='+Math.ceil((entry.staleUntil-Date.now())/1000)}}));}catch{}}
 return entry;
}
