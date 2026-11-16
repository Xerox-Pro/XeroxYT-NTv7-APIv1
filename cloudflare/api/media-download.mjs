import puppeteer from '@cloudflare/puppeteer';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Platform,Player} from 'youtubei.js/cf-worker';
const context=new AsyncLocalStorage();
Platform.shim.eval=async data=>{const browser=context.getStore();if(!browser)throw Error('Evaluator unavailable');const page=await browser.newPage();try{return await page.evaluate(code=>(0,eval)(code),data.output);}finally{await page.close();}};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const chunkSize=524288,maxSize=268435456;
export function registerMediaDownload(app,{run,store,env,vault}){
 const route=(path,work)=>app.post(path,async(req,res)=>{res.setHeader('Cache-Control','private, no-store');try{if(!res.locals.siteAccountId)throw fail('ログインが必要です。',401);res.json(await work(req.body||{},res.locals.siteAccountId));}catch(error){console.warn(JSON.stringify({event:'media_download_failed',status:error.status||502}));res.status(error.status||502).json({error:error.status?error.message:'動画を取得できませんでした。配信制限された動画には対応していません。'});}});
 route('/api/user/download/formats',async(body,id)=>{
  if(body.rightsConfirmed!==true||!/^[\w-]{11}$/.test(body.videoId||''))throw fail('動画IDとダウンロード許可を確認してください。');
  return run(id,async yt=>{
   const browser=await puppeteer.launch(env.BROWSER);
   try{return await context.run(browser,async()=>{
    const player=await Player.create(undefined);yt.session.player=player;
    const info=await yt.getBasicInfo(body.videoId);if(info.basic_info?.is_live)throw fail('ライブ動画は保存できません。');
    const formats=[];
    for(const f of [...(info.streaming_data?.formats||[]),...(info.streaming_data?.adaptive_formats||[])]){
     if(f.drm_families?.length||f.is_type_otf||!(Number(f.content_length)>0&&Number(f.content_length)<=maxSize))continue;
     let url;try{url=await f.decipher(player);}catch{continue;}
     const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.googlevideo.com'))continue;
     formats.push({token:String(formats.length),url,itag:f.itag,mime:f.mime_type,size:Number(f.content_length),quality:f.quality_label||f.audio_quality||'',fps:f.fps,bitrate:f.bitrate,audio:f.has_audio,video:f.has_video,language:f.audio_track?.display_name||f.language||''});
    }
    if(!formats.length)throw fail('保存可能な形式がありません。配信制限またはサイズ上限を確認してください。',422);
    return {title:info.basic_info?.title||body.videoId,formats,chunkSize,maxSize};
   });}finally{await browser.close();}
  });
 });
}
