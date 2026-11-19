import { timingSafeEqual } from 'node:crypto';
export function authorizeSource(request,env){
 const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 const origin=request.headers.get('origin');
 if(!origin||!allowed.includes(origin))return Response.json({error:'このサイトからのAPI接続は許可されていません。',code:'ORIGIN_FORBIDDEN'},{status:403,headers:{'Cache-Control':'no-store'}});
 if(env.REQUIRE_PROXY_SECRET!=='false'){
  const provided=(/^Bearer (.+)$/i.exec(request.headers.get('authorization')||'')?.[1]||'');
  // Keep the existing proxy credential valid. A separate credential may be
  // assigned to another Vercel project without rotating the original.
  const accepted=[env.API_SHARED_SECRET,env.VERCEL_PROXY_SHARED_SECRET].filter(value=>typeof value==='string'&&value.length>0);
  if(!accepted.length)return Response.json({error:'API側のアクセス制限が未設定です。',code:'API_GUARD_NOT_CONFIGURED'},{status:503});
  const providedBytes=Buffer.from(provided);
  const authorized=accepted.some(value=>{
   const expectedBytes=Buffer.from(value);
   return expectedBytes.length===providedBytes.length&&timingSafeEqual(expectedBytes,providedBytes);
  });
  if(!authorized)return Response.json({error:'許可されたサーバー経由で接続してください。',code:'PROXY_REQUIRED'},{status:403,headers:{'Cache-Control':'no-store'}});
 }
 return null;
}
