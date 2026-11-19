import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../server.ts',import.meta.url),'utf8');
test('recommendations bound concurrent YouTube upstream requests',()=>{
 assert.match(source,/const sampleHistory = historyIds\.slice\(0, 4\)/);
 assert.match(source,/sampledHistoryIds = hCopy\.slice\(0, 3\)/);
 assert.match(source,/const deepSample = candidateDeepIds\.slice\(0, 1\)/);
 const recs=source.slice(source.indexOf('app.get("/api/recommendations"'),source.indexOf('// YouTube 検索サジェスト API'));
 assert.match(recs,/generalQueries\s*\.slice\(0, 2\)/);
});
test('cold-start returns the optimized upstream client',()=>{
 const section=source.slice(source.indexOf('async function getYt()'),source.indexOf('// Subscription'));
 assert.match(section,/yt = optimizePublicVideoReads\(instance\)/);
 assert.match(section,/return yt;/);
});
