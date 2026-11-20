import express from 'express';
import { httpServerHandler } from 'cloudflare:node';
import { env as workerEnv } from 'cloudflare:workers';
import accountWorker from '../auth/worker.mjs';
import { createApiApp } from './generated.ts';
import { withD1Bindings } from '../../d1-rest.mjs';
const quota = new Map();
const publicApp=express();
publicApp.disable('x-powered-by');
publicApp.use(async(req,res,next)=>{
 try{
  const env=withD1Bindings(workerEnv);
  const flowStore={
   async get(key){
    const row=await env.DB.prepare('SELECT data FROM api_oauth_flows WHERE user_id=? AND expires_at>?').bind(key,Date.now()).first();
    return row?JSON.parse(row.data):undefined;
   },
   async set(key,value){
    await env.DB.prepare('INSERT INTO api_oauth_flows(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at').bind(key,JSON.stringify(value),value.expires).run();
   },
   async delete(key){
    await env.DB.prepare('DELETE FROM api_oauth_flows WHERE user_id=?').bind(key).run();
   },
  };
  const ACCOUNT={fetch:(input,init)=>accountWorker.fetch(new Request(input,init),env)};
  const app=await createApiApp({...env,ACCOUNT},flowStore,quota);
  app(req,res,next);
 }catch{
  if(!res.headersSent)res.status(502).json({error:'YouTube API failed',code:'CLOUDFLARE_API_FAILED'});
 }
});
publicApp.listen(3000);
export const publicHandler=httpServerHandler({port:3000});
