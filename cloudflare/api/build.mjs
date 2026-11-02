import fs from 'node:fs/promises';
import { build } from 'esbuild';
let source = await fs.readFile('server.ts', 'utf8');
const imports = [];
source = source.replace(/^import .*?;\n/gm, value => { imports.push(value); return ''; });
source = source.slice(source.indexOf('let yt:'));
source = source.replaceAll('process.env.', 'env.');
source = source.replaceAll('new UniversalCache(false)', '{ get: async () => undefined, set: async () => {}, remove: async () => {} }');
source = source.replace(/  setInterval\(\(\) => \{[\s\S]*?\}, (?:10|5) \* 60 \* 1000\)(?:\.unref\?\.\(\))?;/g, '');
const staticStart = source.indexOf('  if (env.NODE_ENV !== "production")');
const staticEnd = source.indexOf('  app.listen(PORT', staticStart);
source = source.slice(0, staticStart) + source.slice(staticEnd);
source = source.replace(/  app.listen\(PORT,[\s\S]*?\n  \}\);/, '');
source = source.replace('const appPromise = startServer();\nexport default appPromise;', 'return startServer();');
source = source.replace('const dailyQuotaMap = new Map<string, ClientDailyRecord>();', 'const dailyQuotaMap = sharedQuota;');
source = source.replace('const authFlows = new Map<string, { flow: any; expires: number }>();', 'const authFlows = flowStore;');
source = source.replaceAll('authFlows.get(', 'await authFlows.get(').replaceAll('authFlows.set(', 'await authFlows.set(').replaceAll('authFlows.delete(', 'await authFlows.delete(');
source = source.replace("const session = await fetch('https://xeroxyt-account.2026-97th.workers.dev/api/account/session',", "const session = await env.ACCOUNT.fetch('https://account.internal/api/account/session',");
// Fail closed if a future server refactor leaves startup or bundled credentials behind.
if (/app\.listen\(|setInterval\(|export default|RAPIDAPI_KEY_[123] \|\|/.test(source)) throw new Error('Workers adaptation incomplete; inspect server.ts changes.');
if (staticStart < 0 || staticEnd < 0) throw new Error('Static server section was not found.');
const generated = imports.join('').replace('"youtubei.js"', '"youtubei.js/cf-worker"').replaceAll('"./', '"../../') + '\nexport async function createApiApp(env, flowStore, sharedQuota) {\n' + source + '\n}\n';
await fs.writeFile('cloudflare/api/generated.ts', generated);
await build({ entryPoints: ['cloudflare/api/worker.mjs'], bundle:true, minify:true, keepNames:true, format:'esm', platform:'node', conditions:['workerd','worker'], external:['cloudflare:*','node:*','path','crypto','stream','util','events','http','https','url','zlib','buffer','assert','tty','os','fs','net','querystring','string_decoder'], outfile:'cloudflare/api/bundle.mjs', define:{'process.env.NODE_ENV':'"production"'}, banner:{js: 'import { createRequire } from "node:module"; const require = createRequire("/worker.mjs"); const __dirname = "/"; const __filename = "/worker.mjs";'}, logLevel:'info' });

await build({entryPoints:['node-entry.ts'],bundle:true,format:'esm',platform:'node',packages:'external',outfile:'dist/node.mjs',logLevel:'info'});
