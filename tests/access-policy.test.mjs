import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeSource} from '../access-policy.mjs';
const env={ALLOWED_ORIGINS:'https://allowed.example',API_SHARED_SECRET:'test-only-secret',REQUIRE_PROXY_SECRET:'true'};
const request=headers=>new Request('https://api.example/api/search',{headers});
test('all API routes require exact allowed Origin and server proof by default',()=>{
 assert.equal(authorizeSource(request({}),env).status,403);
 assert.equal(authorizeSource(request({Origin:'https://evil.example',Authorization:'Bearer test-only-secret'}),env).status,403);
 assert.equal(authorizeSource(request({Origin:'https://allowed.example.evil.example'}),env).status,403);
 assert.equal(authorizeSource(request({Origin:'https://allowed.example'}),env).status,403);
 assert.equal(authorizeSource(request({Origin:'https://allowed.example',Authorization:'Bearer wrong'}),env).status,403);
 assert.equal(authorizeSource(request({Origin:'https://allowed.example',Authorization:'Bearer test-only-secret'}),env),null);
 assert.equal(authorizeSource(request({Origin:'https://allowed.example'}),{ALLOWED_ORIGINS:'https://allowed.example'}).status,503);
});
test('direct mode still enforces allowed Origin, and never turns authentication off',()=>{
 const direct={...env,REQUIRE_PROXY_SECRET:'false'};
 assert.equal(authorizeSource(request({Origin:'https://allowed.example'}),direct),null);
 assert.equal(authorizeSource(request({Origin:'https://evil.example'}),direct).status,403);
});


test('separately authorized Vercel proxy credential respects the origin allowlist',()=>{
 const env={ALLOWED_ORIGINS:'https://old.vercel.app,https://xeroxyt-ntv7-xerox14.vercel.app',API_SHARED_SECRET:'existing-secret',VERCEL_PROXY_SHARED_SECRET:'dedicated-secret',REQUIRE_PROXY_SECRET:'true'};
 assert.equal(authorizeSource(new Request('https://worker.example/api/search',{headers:{Origin:'https://old.vercel.app',Authorization:'Bearer existing-secret'}}),env),null);
 assert.equal(authorizeSource(new Request('https://worker.example/api/search',{headers:{Origin:'https://xeroxyt-ntv7-xerox14.vercel.app',Authorization:'Bearer dedicated-secret'}}),env),null);
 const forbidden=authorizeSource(new Request('https://worker.example/api/search',{headers:{Origin:'https://unlisted.vercel.app',Authorization:'Bearer dedicated-secret'}}),env);
 assert.equal(forbidden.status,403);
 assert.equal(forbidden.headers.get('Cache-Control'),'no-store');
 const invalid=authorizeSource(new Request('https://worker.example/api/search',{headers:{Origin:'https://xeroxyt-ntv7-xerox14.vercel.app',Authorization:'Bearer invalid'}}),env);
 assert.equal(invalid.status,403);
});
