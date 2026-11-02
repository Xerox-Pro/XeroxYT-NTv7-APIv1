import { timingSafeEqual } from 'node:crypto';
export function authorizeSource(request,env){
 const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 const origin=request.headers.get('origin');
 if(!origin||!allowed.includes(origin))return Response.json({error:'このサイトからのAPI接続は許可されていません。',code:'ORIGIN_FORBIDDEN'},{status:403,headers:{'Cache-Control':'no-store'}});
 if(env.REQUIRE_PROXY_SECRET!=='false'){
  const expected=env.API_SHARED_SECRET,provided=(/^Bearer (.+)$/i.exec(request.headers.get('authorization')||'')?.[1]||'');
  if(!expected)return Response.json({error:'API側のアクセス制限が未設定です。',code:'API_GUARD_NOT_CONFIGURED'},{status:503});
  const a=Buffer.from(expected),b=Buffer.from(provided);
  if(a.length!==b.length||!timingSafeEqual(a,b))return Response.json({error:'許可されたサーバー経由で接続してください。',code:'PROXY_REQUIRED'},{status:403,headers:{'Cache-Control':'no-store'}});
 }
 return null;
}
