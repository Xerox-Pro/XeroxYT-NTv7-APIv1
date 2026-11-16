import test from 'node:test';
import assert from 'node:assert/strict';
import {withGasAccess} from '../cloudflare/api/gas-access.mjs';

test('GAS key is accepted only from Apps Script and translated server-side',async()=>{
 const seen=[];
 const worker=withGasAccess({async fetch(request){seen.push(request);return Response.json({ok:true});}});
 const env={GAS_API_SHARED_SECRET:'gas-only-key',API_SHARED_SECRET:'api-only-key',ALLOWED_ORIGINS:'https://xeroxapp044.vercel.app'};
 const accepted=await worker.fetch(new Request('https://api.test/api/account/session',{headers:{Authorization:'Bearer gas-only-key',Origin:'https://script.google.com'}}),env,{});
 assert.equal(accepted.status,200);
 assert.equal(seen[0].headers.get('authorization'),'Bearer api-only-key');
 assert.equal(seen[0].headers.get('origin'),'https://xeroxapp044.vercel.app');
 const rejected=await worker.fetch(new Request('https://api.test/api/account/session',{headers:{Authorization:'Bearer gas-only-key',Origin:'https://evil.test'}}),env,{});
 assert.equal(rejected.status,403);
 assert.equal(seen.length,1);
});
