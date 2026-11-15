import {timingSafeEqual} from 'node:crypto';

async function matches(provided,expected){
 const encoder=new TextEncoder();
 const [a,b]=await Promise.all([provided,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
 return timingSafeEqual(new Uint8Array(a),new Uint8Array(b));
}

// Add a GAS-only credential without rotating the deployed site's signing key.
// Upload this module beside the original Worker and make entry.mjs the entrypoint:
// import worker from './worker.mjs'; import {withGasKey} from './gas-key.mjs';
// export default withGasKey(worker);
export function withGasKey(worker){
 return {...worker,async fetch(request,env,ctx){
  let gasAuthenticated=false;
  const supplied=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(typeof env.GAS_API_SHARED_SECRET==='string'&&env.GAS_API_SHARED_SECRET&&await matches(supplied,env.GAS_API_SHARED_SECRET)){
   const origin=String(env.ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).find(value=>/^https:\/\/[^/]+$/.test(value));
   if(request.headers.get('Origin')!=='https://script.google.com'||!origin||!env.API_SHARED_SECRET){
    return Response.json({error:'GAS access is not configured.'},{status:403});
   }
   const headers=new Headers(request.headers);
   headers.set('Authorization','Bearer '+env.API_SHARED_SECRET);
   headers.set('Origin',origin);
   request=new Request(request,{headers});
   gasAuthenticated=true;
  }
  const response=await worker.fetch(request,env,ctx);
  // Extend only an already valid GAS site session. Revoked/expired sessions stay invalid.
  if(gasAuthenticated&&response.ok&&new URL(request.url).pathname==='/api/account/session'&&env.DB){
   const token=/(?:^|;\s*)__Host-xy_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('Cookie')||'')?.[1];
   if(token){
    try{
     const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),v=>v.toString(16).padStart(2,'0')).join('');
     const now=Date.now(),expires=now+31536000000;
     const row=await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(hash,now).first();
     if(row&&row.expires_at<expires-604800000){
      const updated=await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?').bind(expires,hash,now).run();
      if(updated.meta?.changes){
       const headers=new Headers(response.headers);
       headers.append('Set-Cookie','__Host-xy_session='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000');
       return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      }
     }
    }catch{console.error('GAS_SESSION_RENEWAL_FAILED');}
   }
  }
  return response;
 }};
}
