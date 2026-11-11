import { authorizeSource } from './access-policy.mjs';
import accountWorker from './cloudflare/auth/worker.mjs';
import { createD1Database } from './d1-rest.mjs';
import express from 'express';
import { createApiApp } from './cloudflare/api/generated.ts';
const env=process.env;
const database=createD1Database(env);
const quota=new Map(),flows=new Map();
function accountFetch(input:RequestInfo|URL,init?:RequestInit){
 const original=new Request(input,init);
 if(database)return accountWorker.fetch(original,{...env,DB:database});
 const configured=env.ACCOUNT_API_URL;
 if(!configured)return Promise.resolve(Response.json({error:'ACCOUNT_API_URL must point to the primary Cloudflare API.'},{status:503}));
 const base=new URL(configured);if(base.protocol!=='https:')throw new Error('ACCOUNT_API_URL must use HTTPS');
 const path=new URL(original.url);const headers=new Headers(original.headers);if(env.API_SHARED_SECRET)headers.set('Authorization','Bearer '+env.API_SHARED_SECRET);if(!headers.has('Origin'))headers.set('Origin',(env.ALLOWED_ORIGINS||'').split(',')[0].trim());return fetch(new Request(base.origin+path.pathname+path.search,new Request(original,{headers})));
}
const app=express();
app.use((req,res,next)=>{const headers=new Headers();for(const name of ['origin','authorization']){const value=req.headers[name];if(typeof value==='string')headers.set(name,value);}const rejected=authorizeSource(new Request('https://api.internal'+req.originalUrl,{headers}),env);if(rejected){res.status(rejected.status);rejected.text().then(body=>res.type('application/json').send(body)).catch(next);return;}next();});
app.use((req,res,next)=>{
 const origin=req.headers.origin;
 const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim());
 if(origin&&allowed.includes(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range,X-Youtube-Credentials,X-Client-Id,X-Usage-Token,X-Client-Usage');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'){res.status(origin&&allowed.includes(origin)?204:403).end();return;}
 next();
});
app.get('/health',(_req,res)=>res.json({ok:true,runtime:'node',implementation:'XeroxYT-NTv7-APIv1'}));
app.use(async(req,res,next)=>{
 if(!(database ? /^\/api\/account(\/|$)/ : /^\/api\/(account|auth|user)(\/|$)/).test(req.path))return next();
 try{const headers=new Headers();for(const name of ['cookie','content-type','origin','referer']){const v=req.headers[name];if(typeof v==='string')headers.set(name,v);}
 const body=['GET','HEAD'].includes(req.method)?undefined:await new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>131072){reject(new Error('Payload too large'));req.destroy();}else chunks.push(chunk);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
 const response=await accountFetch('https://account.internal'+req.originalUrl,{method:req.method,headers,body});
 res.status(response.status);for(const [k,v] of response.headers)if(!['content-length','content-encoding','transfer-encoding'].includes(k))res.setHeader(k,v);
 if(!response.body)return res.end();const reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;if(!res.write(Buffer.from(value)))await new Promise(resolve=>res.once('drain',resolve));}res.end();
 }catch(error){next(error);}
});
const flowStore=database?{async get(key){const row=await database.prepare('SELECT data FROM api_oauth_flows WHERE user_id=? AND expires_at>?').bind(key,Date.now()).first();return row?JSON.parse(row.data):undefined;},async set(key,value){await database.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify(value),value.expires).run();},async delete(key){await database.prepare('DELETE FROM api_oauth_flows WHERE user_id=?').bind(key).run();}}:flows;
const appPromise=createApiApp({...env,ACCOUNT:{fetch:accountFetch}},flowStore,quota).then(api=>{app.use(api);return app;});
export default appPromise;
