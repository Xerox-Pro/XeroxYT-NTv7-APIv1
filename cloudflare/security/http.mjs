// Shared, streaming request limits: Content-Length alone is not trustworthy.
export async function boundedBytes(response,limit=131072){
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>limit)throw Object.assign(new Error('データが大きすぎます。'),{status:413,code:'PAYLOAD_TOO_LARGE'});
 const reader=response.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Object.assign(new Error('データが大きすぎます。'),{status:413,code:'PAYLOAD_TOO_LARGE'});chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
export async function requestJson(request,limit=131072){
 const text=new TextDecoder().decode(await boundedBytes(request,limit));
 try{const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw Object.assign(new Error('不正な形式です。'),{status:400,code:'INVALID_JSON'});}
}
export function secureApiResponse(response){
 const headers=new Headers(response.headers);
 headers.set('X-Content-Type-Options','nosniff');headers.set('X-Frame-Options','DENY');
 headers.set('Referrer-Policy','no-referrer');headers.set('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
