import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSearchFilters,encodeSearchFilters,searchFilterParams,SEARCH_FEATURES} from '../search-filters.mjs';
test('every search option survives URL serialization and unsafe values are discarded',()=>{
 const f=normalizeSearchFilters({upload_date:'hour',type:'playlist',duration:'over_twenty_mins',sort:'view_count',features:SEARCH_FEATURES.map(([id])=>id)});
 assert.deepEqual(normalizeSearchFilters(searchFilterParams(f)),f);
 assert.deepEqual(normalizeSearchFilters({type:'bad',sort:'bad',features:'secret,hd,hd'}),{upload_date:'all',type:'all',duration:'all',sort:'relevance',features:['hd']});
});
test('encoded search fields match the actual YouTube protobuf layout',()=>{
 const bytes=Array.from(Buffer.from(encodeSearchFilters({upload_date:'hour',type:'shorts',duration:'under_three_mins',sort:'upload_date',features:['4k','hdr','vr180']}),'base64'));
 assert.deepEqual(bytes,[8,2,18,14,8,1,16,9,24,4,112,1,208,1,1,200,1,1]);
});
