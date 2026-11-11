import {feedText} from './youtube-feed.mjs';
const channelId=value=>typeof value==='string'&&/^UC[\w-]{22}$/.test(value);
export function decodeYouTubeProfile(data){
 const accounts=[],headers=[];let count=0;
 function walk(value,depth=0){if(!value||typeof value!=='object'||depth>22||count++>4000)return;for(const[key,node]of Object.entries(value)){if(key==='accountItem'||key==='accountItemRenderer')accounts.push(node);else if(key==='activeAccountHeaderRenderer')headers.push(node);else walk(node,depth+1);}}
 walk(data);const account=accounts.find(a=>a.isSelected)||headers[0];if(!account)return null;
 let id='';count=0;function findId(value,depth=0){if(!value||typeof value!=='object'||depth>12||count++>500)return;for(const[key,v]of Object.entries(value)){if(['browseId','channelId','externalChannelId'].includes(key)&&channelId(v))id||=v;else if(typeof v==='object')findId(v,depth+1);}}findId(account);
 return {name:feedText(account.accountName)||'YouTube アカウント',email:'',picture:account.accountPhoto?.thumbnails?.at(-1)?.url||'',sub:id,handle:feedText(account.channelHandle)};
}
export async function readYouTubeProfile(yt,createPublicClient){
 let user=null;
 try{const r=await yt.actions.execute('/account/accounts_list',{client:'TV'});user=decodeYouTubeProfile(r.data);}catch{}
 if(!user){try{const info=await yt.account.getInfo(false);const list=info?.contents?.contents||[];const a=list.find(a=>a.is_selected);const header=info?.contents?.header;const v=a||header;if(v)user={name:feedText(v.account_name)||'YouTube アカウント',email:'',picture:v.account_photo?.at(-1)?.url||'',sub:channelId(v.endpoint?.payload?.browseId)?v.endpoint.payload.browseId:'',handle:feedText(v.channel_handle)};}catch{}}
 if(!user)throw Object.assign(new Error('YouTubeのプロフィールを取得できませんでした。時間をおいて更新してください。'),{status:502,code:'YOUTUBE_PROFILE_UNAVAILABLE'});
 // Resolve the user's public channel through the normal Web client. Never send
 // Google bearer tokens to Web endpoints, and never guess a channel identity.
 if(createPublicClient&&(user.sub||/^@[\w.\p{L}\p{N}-]+$/u.test(user.handle))){try{
  const publicYt=await createPublicClient();if(!user.sub){const resolved=await publicYt.resolveURL('https://www.youtube.com/'+user.handle);const id=resolved?.payload?.browseId;if(channelId(id))user.sub=id;}
  if(user.sub){const channel=await publicYt.getChannel(user.sub);const info=channel.metadata||{};user={...user,name:feedText(info.title)||user.name,picture:info.avatar?.at(-1)?.url||user.picture,description:feedText(info.description),channelUrl:'https://www.youtube.com/channel/'+user.sub};}
 }catch{}}
 return user;
}
