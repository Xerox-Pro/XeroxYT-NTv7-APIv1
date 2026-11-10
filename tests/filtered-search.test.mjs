import test from 'node:test';import assert from 'node:assert/strict';
import express from 'express';
import {YT,YTNodes} from 'youtubei.js';
import {registerFilteredSearch} from '../filtered-search.mjs';
import {encodeSearchFilters} from '../search-filters.mjs';
const fixture=(id)=>({success:true,status_code:200,data:{contents:{twoColumnSearchResultsRenderer:{primaryContents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[{videoRenderer:{videoId:id,title:{runs:[{text:'result'}]},thumbnail:{thumbnails:[]}}}]}}]}}}}}});
test('search sends the selected filters to YouTube, keeps cache combinations separate, and reports exhaustion',async()=>{
 const requests=[];const app=express();let fail=false;
 registerFilteredSearch(app,{Search:YT.Search,ContinuationItem:YTNodes.ContinuationItem,getYt:async()=>({actions:{execute:async(path,payload)=>{requests.push({path,...payload});if(fail)throw new Error('offline');return fixture('abcdefghijk');}}}),formatVideoObject:item=>item.id?{videoId:item.id,title:item.title?.text}:null,formatSearchChannel:()=>null});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{let response=await fetch(base+'/api/search?q=miku&type=video&features=4k,hdr&sort=upload_date');let data=await response.json();assert.equal(response.status,200);assert.equal(data.videos.length,1);assert.equal(data.hasMore,false);assert.equal(requests[0].query,'miku');assert.equal(requests[0].params,encodeSearchFilters({type:'video',features:['4k','hdr'],sort:'upload_date'}));response=await fetch(base+'/api/search?q=miku&type=video&features=4k,hdr&sort=upload_date&page=2');data=await response.json();assert.equal(data.videos.length,0);assert.equal(requests.length,1,'an exhausted continuation never changes the query to miku 2');await fetch(base+'/api/search?q=miku&type=shorts');assert.equal(requests.length,2);fail=true;response=await fetch(base+'/api/search?q=fail');assert.equal(response.status,502);assert.ok((await response.json()).error);}finally{await new Promise(resolve=>server.close(resolve));}
});
