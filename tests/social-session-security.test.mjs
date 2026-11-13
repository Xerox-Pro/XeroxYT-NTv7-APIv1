import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionCookies,privateProfile,privateFeed,privateSend,boundedBytes,probeSession} from '../cloudflare/social/unofficial.mjs';
import {credentialVault} from '../youtube-account.mjs';
const link={cookies:{sessionid:'test-session',csrftoken:'test-csrf'},userAgent:'test-browser'};
test('only service cookies are accepted; control characters and other service names fail',()=>{
 assert.deepEqual(sessionCookies('sessionid=test; csrftoken=csrf; google_secret=never','instagram'),{sessionid:'test',csrftoken:'csrf'});
 assert.throws(()=>sessionCookies({sessionid:'test\r\nInjected: x',csrftoken:'csrf'},'instagram'));
 assert.throws(()=>sessionCookies({sessionid:'test'},'unknown'));
});
test('authenticated reads use fixed HTTPS destinations and cannot follow redirects with cookies',async()=>{
 await privateProfile('instagram',link,async(url,init)=>{assert.equal(url,'https://www.instagram.com/api/v1/accounts/current_user/?edit=true');assert.equal(init.redirect,'manual');assert.equal(init.headers.Cookie,'sessionid=test-session; csrftoken=test-csrf');return Response.json({user:{pk:1,username:'test'}});});
 await privateFeed('instagram',link,'https://attacker.test/',async(url,init)=>{assert.equal(new URL(url).hostname,'www.instagram.com');assert.equal(new URLSearchParams(init.body).get('max_id'),'https://attacker.test/');return Response.json({items:[]});});
});
test('stream bounds cancel oversized bodies even without Content-Length',async()=>{
 let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(12));},cancel(){cancelled=true;}});
 await assert.rejects(boundedBytes(new Response(body),10),{code:'PAYLOAD_TOO_LARGE'});assert.equal(cancelled,true);
});
test('sealed credentials resist tampering and cannot be opened for another site account/service',()=>{
 const vault=credentialVault('test-only-security-secret-value'),sealed=vault.seal(link,'social-private:instagram:alice');
 assert.ok(!JSON.stringify(sealed).includes('test-session'));assert.deepEqual(vault.open(sealed,'social-private:instagram:alice'),link);
 assert.throws(()=>vault.open(sealed,'social-private:instagram:bob'));assert.throws(()=>vault.open(sealed,'social-private:tiktok:alice'));
 assert.throws(()=>vault.open({...sealed,tag:Buffer.alloc(16).toString('base64')},'social-private:instagram:alice'));
});
test('authentication challenges never silently enable private features',async()=>{
 await assert.rejects(probeSession('instagram',link,async(url)=>url.includes('/accounts/')?Response.json({user:{pk:1,username:'test'}}):Response.json({status:'fail',challenge_required:true})),{code:'SESSION_UNSUPPORTED'});
});
test('DM send rejects invalid data before network and never fabricates an acknowledgement',async()=>{
 let calls=0;await assert.rejects(privateSend('instagram',link,{id:'../../evil'},'text','11111111-1111-1111-1111-111111111111',async()=>{calls++;}),{code:'MESSAGE'});assert.equal(calls,0);
 await assert.rejects(privateSend('instagram',link,{id:'123'},'text','11111111-1111-1111-1111-111111111111',async()=>Response.json({status:'ok'})),{code:'SEND_UNCERTAIN'});
});

test('Cloudflare-compatible redirect mode rejects redirects instead of forwarding private cookies',async()=>{
 let calls=0;const fetcher=async(url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://attacker.test/'}});};
 await assert.rejects(privateProfile('instagram',link,fetcher),{code:'SESSION_REDIRECT'});assert.equal(calls,1);
});
