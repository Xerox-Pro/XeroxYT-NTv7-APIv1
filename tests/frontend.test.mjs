import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendRequest} from '../cloudflare/api/frontend.mjs';
test('asset-origin gateway serves the SPA and forwards only local API requests with server credentials',async()=>{
  const env={API_SHARED_SECRET:'server-only',ALLOWED_ORIGINS:'https://legacy.test',ASSETS:{fetch:async()=>new Response('app')}};
  assert.equal(await (await frontendRequest(new Request('https://api.test/instagram'),env).response).text(),'app');
  const local=frontendRequest(new Request('https://api.test/api/auth/status',{headers:{Referer:'https://api.test/instagram',Cookie:'session=test'}}),env);
  assert.equal(local.request.headers.get('Authorization'),'Bearer server-only');
  assert.equal(local.request.headers.get('Cookie'),'session=test');
  assert.ok(local.env.ALLOWED_ORIGINS.includes('https://api.test'));
  assert.equal(env.ALLOWED_ORIGINS,'https://legacy.test');
  for(const path of ['/internal/youtube-store','/api/auth/status'])assert.equal(frontendRequest(new Request('https://api.test'+path,{headers:{Origin:'https://evil.test',Referer:'https://api.test/'}}),env),null);
  const config=await frontendRequest(new Request('https://api.test/api/transport-config',{headers:{Referer:'https://api.test/'}}),env).response;
  assert.deepEqual(await config.json(),{origins:['https://api.test']});
  assert.equal(frontendRequest(new Request('https://api.test/'),{}),null);
});
