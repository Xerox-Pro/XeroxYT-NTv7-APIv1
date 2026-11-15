export function decodeEntities(value='') {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
    if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
    const n=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));
    return Number.isInteger(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
  });
}
export function metadata(html) {
  const result={};
  for(const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs={};for(const m of tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[m[1].toLowerCase()]=decodeEntities(m[2]??m[3]);
    if(attrs.property||attrs.name)result[attrs.property||attrs.name]=attrs.content||'';
  }
  return result;
}
export function pageObjects(html) {
  const objects=[];
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { objects.push(JSON.parse(script[1])); } catch {}
  }
  return objects;
}
export function profileFromPage(html,username) {
  const meta=metadata(html),title=meta['og:title']||'';
  // A generic login page must never become a successful empty profile.
  if(!title.toLowerCase().includes('(@'+username.toLowerCase()+')'))return null;
  return {id:username,username,full_name:title.split('(@')[0].trim(),profile_pic_url:meta['og:image']||'',pageObjects:pageObjects(html)};
}
