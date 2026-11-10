export const SEARCH_FILTER_GROUPS = [
 {key:'upload_date',label:'アップロード日',options:[['all','指定なし'],['hour','1時間以内'],['today','今日'],['week','今週'],['month','今月'],['year','今年']]},
 {key:'type',label:'種類',options:[['all','すべて'],['video','動画'],['shorts','ショート'],['channel','チャンネル'],['playlist','再生リスト'],['movie','映画']]},
 {key:'duration',label:'長さ',options:[['all','指定なし'],['under_three_mins','3分未満'],['three_to_twenty_mins','3〜20分'],['over_twenty_mins','20分超']]},
 {key:'sort',label:'並べ替え',options:[['relevance','関連度'],['upload_date','アップロード日'],['view_count','視聴回数'],['rating','評価']]},
];
export const SEARCH_FEATURES=[['live','ライブ'],['4k','4K'],['hd','HD'],['subtitles','字幕'],['creative_commons','クリエイティブ・コモンズ'],['360','360°'],['vr180','VR180'],['3d','3D'],['hdr','HDR'],['location','場所'],['purchased','購入済み']];
export function normalizeSearchFilters(input){
 const get=key=>typeof input?.get==='function'?input.get(key):input?.[key];
 const result={};
 for(const group of SEARCH_FILTER_GROUPS){const value=get(group.key);result[group.key]=group.options.some(([id])=>id===value)?value:group.options[0][0];}
 const raw=get('features');const features=Array.isArray(raw)?raw:String(raw||'').split(',');
 result.features=SEARCH_FEATURES.filter(([id])=>features.includes(id)).map(([id])=>id);
 return result;
}
export function searchFilterParams(filters){const normalized=normalizeSearchFilters(filters);const params=new URLSearchParams();for(const group of SEARCH_FILTER_GROUPS)if(normalized[group.key]!==group.options[0][0])params.set(group.key,normalized[group.key]);if(normalized.features.length)params.set('features',normalized.features.join(','));return params;}
// YouTube's search protobuf. Encode small integer/bool fields without a browser polyfill.
export function encodeSearchFilters(input){
 const f=normalizeSearchFilters(input);
 const sorts={relevance:0,rating:1,upload_date:2,view_count:3};
 const dates={all:0,hour:1,today:2,week:3,month:4,year:5};
 const types={all:0,video:1,channel:2,playlist:3,movie:4,shorts:9};
 const durations={all:0,under_three_mins:4,three_to_twenty_mins:5,over_twenty_mins:2};
 const fields={hd:4,subtitles:5,creative_commons:6,'3d':7,live:8,purchased:9,'4k':14,'360':15,location:23,hdr:25,vr180:26};
 const varint=value=>{const bytes=[];do{let b=value&127;value>>>=7;if(value)b|=128;bytes.push(b);}while(value);return bytes;};
 const pair=(field,value)=>[...varint(field*8),...varint(value)];
 const body=[...pair(1,dates[f.upload_date]),...pair(2,types[f.type]),...pair(3,durations[f.duration]),...f.features.flatMap(feature=>pair(fields[feature],1))];
 const bytes=[...pair(1,sorts[f.sort]),18,...varint(body.length),...body];
 return btoa(String.fromCharCode(...bytes));
}
