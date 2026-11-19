// Multiple TikTok accounts are isolated by the authenticated XeroxYT user.
// Secrets stay sealed in the existing credential vault; only profile summaries
// are returned to the browser. All mutations require the site's session.
const indexKey=siteId=>'social-accounts:tiktok:'+siteId;
const credentialKey=(siteId,accountId)=>'social-private:tiktok:'+siteId+':account:'+accountId;
const activeKey=siteId=>'social-active:tiktok:'+siteId;
const currentKey=siteId=>'social-private:tiktok:'+siteId;
const profile=link=>({
 id:String(link?.user?.id||''),
 username:String(link?.user?.username||''),
 name:String(link?.user?.name||link?.user?.username||'TikTok'),
 avatar:String(link?.user?.avatar||''),
});
const cleanIndex=raw=>Array.isArray(raw?.accounts)?raw.accounts.filter(x=>typeof x?.id==='string'&&/^\d{1,35}$/.test(x.id)).slice(0,30):[];
export async function registerTikTokAccount(db,siteId,link){
 const account=profile(link);
 if(!/^\d{1,35}$/.test(account.id))throw Error('TikTokアカウントIDが正しくありません。');
 const accounts=cleanIndex(await db.read(indexKey(siteId)));
 const updated=[...accounts.filter(x=>x.id!==account.id),account];
 if(updated.length>30)throw Error('保存できるTikTokアカウント数の上限に達しました。');
 await db.write(credentialKey(siteId,account.id),link,Date.now()+30*86400000);
 await db.write(indexKey(siteId),{accounts:updated});
 await db.write(activeKey(siteId),{id:account.id});
 await db.write(currentKey(siteId),link,Date.now()+30*86400000);
 return {accounts:updated,activeId:account.id};
}
export async function listTikTokAccounts(db,siteId){
 const accounts=cleanIndex(await db.read(indexKey(siteId)));
 const active=await db.read(activeKey(siteId));
 return {accounts,activeId:typeof active?.id==='string'?active.id:null};
}
export async function activateTikTokAccount(db,siteId,accountId){
 if(!/^\d{1,35}$/.test(accountId||''))return null;
 const accounts=cleanIndex(await db.read(indexKey(siteId)));
 if(!accounts.some(row=>row.id===accountId))return null;
 const link=await db.read(credentialKey(siteId,accountId));
 if(!link?.user?.id||String(link.user.id)!==accountId)return null;
 await db.write(activeKey(siteId),{id:accountId});
 await db.write(currentKey(siteId),link,Date.now()+30*86400000);
 return {activeId:accountId,account:profile(link),accounts};
}
export async function removeTikTokAccount(db,siteId,accountId){
 const accounts=cleanIndex(await db.read(indexKey(siteId)));
 if(!accounts.some(row=>row.id===accountId))return null;
 await db.remove(credentialKey(siteId,accountId));
 const remaining=accounts.filter(row=>row.id!==accountId);
 await db.write(indexKey(siteId),{accounts:remaining});
 const current=await db.read(activeKey(siteId));
 if(current?.id===accountId){
  await db.remove(activeKey(siteId));
  await db.remove(currentKey(siteId));
  if(remaining.length){
   const next=await activateTikTokAccount(db,siteId,remaining[0].id);
   return {accounts:remaining,activeId:next?.activeId||null};
  }
 }
 return {accounts:remaining,activeId:current?.id===accountId?null:current?.id||null};
}
