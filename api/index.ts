import appPromise from '../dist/node-app.mjs';
export default async function handler(req,res){return (await appPromise)(req,res);}
