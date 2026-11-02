import appPromise from '../node-app';
export default async function handler(req,res){return (await appPromise)(req,res);}
