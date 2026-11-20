export function createD1Database(env) {
 const {CLOUDFLARE_ACCOUNT_ID:account,D1_DATABASE_ID:database,CLOUDFLARE_API_TOKEN:token}=env;
 if(!account||!database||!token)return null;
 if(!/^[a-f0-9]{32}$/i.test(account)||!/^[a-f0-9-]{32,36}$/i.test(database))throw new Error('Invalid D1 configuration');
 async function query(sql,params){const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(10000)});const result=await response.json().catch(()=>null);if(result?.errors?.some(e=>e.code===7500&&/daily row write limit/i.test(e.message))){const error=new Error('D1 daily write limit');error.code='D1_WRITE_LIMIT';throw error;}if(!response.ok||!result?.success||!result.result?.[0]?.success)throw new Error('D1 request failed');return result.result[0];}
 function statement(sql, params = []) {
  return {
   bind(...values) { return statement(sql, values); },
   async first(column) {
    const row = (await query(sql, params)).results?.[0];
    return column === undefined ? row ?? null : row?.[column] ?? null;
   },
   all() { return query(sql, params); },
   run() { return query(sql, params); },
  };
 }
 return { prepare: statement };
}

// The Express bridge runs in its own request context and starts with the raw Worker bindings.
export function withD1Bindings(env) {
 return {
  ...env,
  DB: env.DB ?? createD1Database(env),
  MANAGEMENT_DB: env.MANAGEMENT_DB ?? createD1Database({
   CLOUDFLARE_ACCOUNT_ID:env.MANAGEMENT_D1_ACCOUNT_ID,
   D1_DATABASE_ID:env.MANAGEMENT_D1_DATABASE_ID,
   CLOUDFLARE_API_TOKEN:env.MANAGEMENT_D1_TOKEN,
  }),
 };
}
