export function createD1Database(env) {
 const {CLOUDFLARE_ACCOUNT_ID:account,D1_DATABASE_ID:database,CLOUDFLARE_API_TOKEN:token}=env;
 if(!account||!database||!token)return null;
 if(!/^[a-f0-9]{32}$/i.test(account)||!/^[a-f0-9-]{32,36}$/i.test(database))throw new Error('Invalid D1 configuration');
 async function query(sql,params){const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(10000)});const result=await response.json();if(!response.ok||!result.success||!result.result?.[0]?.success)throw new Error('D1 request failed');return result.result[0];}
 return {prepare(sql){return {bind(...params){return {async first(){return (await query(sql,params)).results?.[0]||null;},async run(){return query(sql,params);}};}};}};
}
