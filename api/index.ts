import appPromise from '../node-app.js';
export default async function handler(req,res){return (await appPromise)(req,res);}
