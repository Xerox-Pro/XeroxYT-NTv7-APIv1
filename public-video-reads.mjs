// Install only on the anonymous client. Signed-in clients always fetch fresh feeds.
export function optimizePublicVideoReads(client,{now=Date.now,ttl=120000,max=32}={}){
 const pending=new Map(),basics=new Map();
 for(const name of ['getBasicInfo','getInfo']){
  if(typeof client[name]!=='function')continue;
  const original=client[name].bind(client);
  client[name]=(...args)=>{
   const key=name+':'+JSON.stringify(args),entry=basics.get(key);
   if(name==='getBasicInfo'&&entry&&entry.until>now())return Promise.resolve(entry.value);
   if(pending.has(key))return pending.get(key);
   const task=Promise.resolve().then(()=>original(...args)).then(value=>{
    if(name==='getBasicInfo'){basics.delete(key);while(basics.size>=max)basics.delete(basics.keys().next().value);basics.set(key,{value,until:now()+ttl});}
    return value;
   }).finally(()=>{if(pending.get(key)===task)pending.delete(key);});pending.set(key,task);return task;
  };
 }
 return client;
}
