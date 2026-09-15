// Enlil HLS Relay - Cloudflare Module Worker
const ALLOWED_HOSTS = new Set([
  "www.manar2.shop","manar2.shop",
  "www.maziikaaaaaa.shop","maziikaaaaaa.shop",
  "tmaxapp.site","www.tmaxapp.site","line.tvdsz.cc",
  "play.redroidiptv.com","212.102.60.39"
]);

const REDLINE = { host:"play.redroidiptv.com", ua:"Rediptv 2.0.74" };

function cors(h=new Headers()){
  h.set("Access-Control-Allow-Origin","*");
  h.set("Access-Control-Allow-Methods","GET,HEAD,OPTIONS");
  h.set("Access-Control-Allow-Headers","Range,Accept,Content-Type,Origin,Referer,User-Agent");
  h.set("Access-Control-Expose-Headers","Content-Length,Content-Range,Accept-Ranges,Content-Type");
  return h;
}
function json(x,s=200){return new Response(JSON.stringify(x,null,2),{status:s,headers:cors(new Headers({"content-type":"application/json; charset=utf-8","cache-control":"no-store"}))});}
function allowed(u){return (u.protocol==="http:"||u.protocol==="https:")&&ALLOWED_HOSTS.has(u.hostname);}
function relay(origin,u){let x=new URL(origin+"/relay");x.searchParams.set("url",u);return x.toString();}
function normalize(t){return t.replace(/(RESOLUTION=\d+)[×X](\d+)/gi,"$1x$2");}

function rewriteManifest(text,base,req){
  text=normalize(text);
  return text.split(/\r?\n/).map(line=>{
    if(!line)return line;
    if(line.startsWith("#")){
      return line.replace(/URI=(["'])(.*?)\1/gi,(m,q,v)=>{
        try{let a=new URL(v,base);return allowed(a)?`URI=${q}${relay(req.origin,a.toString())}${q}`:m;}catch{return m;}
      });
    }
    try{let a=new URL(line.trim(),base);return allowed(a)?relay(req.origin,a.toString()):line;}catch{return line;}
  }).join("\n");
}

function findTs(d){
  let lim=Math.min(d.length,256*1024);
  for(let o=0;o<lim;o++){
    if(d[o]!==0x47)continue;
    if(o+564<d.length&&d[o+188]===0x47&&d[o+376]===0x47&&d[o+564]===0x47)return o;
  }
  return -1;
}
function maybeSegment(u,ct){
  let p=u.pathname.toLowerCase(),c=(ct||"").toLowerCase();
  return /\.(ts|php|pdf|js)$/.test(p)||c.includes("video/mp2t")||c.includes("octet-stream")||c.includes("image/png")||c.includes("application/pdf");
}
function maybeM3u8(u,ct,t=""){
  c=(ct||"").toLowerCase();
  return u.pathname.toLowerCase().endsWith(".m3u8")||c.includes("mpegurl")||t.trimStart().startsWith("#EXTM3U");
}

// Insert YOUR authorized Redline R-Auth generator here.
// The supplied documentation specifies that R-Auth is dynamic but does not
// contain its generation algorithm, so this package does not guess one.
async function getRedlineAuth(_url){ return null; }

async function headersFor(req,u){
  let h=new Headers({"Accept":"*/*"});
  let range=req.headers.get("Range"); if(range)h.set("Range",range);
  if(u.hostname===REDLINE.host){
    h.set("User-Agent",REDLINE.ua);
    h.set("Accept-Encoding","identity");
    h.set("Connection","Keep-Alive");
    let a=await getRedlineAuth(u); if(a)h.set("R-Auth",a);
  }
  return h;
}
async function fetchRedirects(u,init){
  let cur=new URL(u);
  for(let i=0;i<6;i++){
    if(!allowed(cur))throw new Error("Blocked upstream host: "+cur.hostname);
    let r=await fetch(cur,{...init,redirect:"manual"});
    if(![301,302,303,307,308].includes(r.status))return [r,cur];
    let loc=r.headers.get("location"); if(!loc)return [r,cur];
    cur=new URL(loc,cur);
  }
  throw new Error("Too many redirects");
}

async function handle(req){
  let ru=new URL(req.url),raw=ru.searchParams.get("url");
  if(!raw)return json({ok:false,error:"Missing ?url=",usage:"/relay?url=<encoded-hls-url>"},400);
  let up; try{up=new URL(raw)}catch{return json({ok:false,error:"Invalid URL"},400)}
  if(!allowed(up))return json({ok:false,error:"Host not allowed",host:up.hostname},403);

  let pair;
  try{pair=await fetchRedirects(up,{method:req.method==="HEAD"?"HEAD":"GET",headers:await headersFor(req,up)})}
  catch(e){return json({ok:false,error:String(e.message||e)},502)}
  let [r,finalUrl]=pair, ct=r.headers.get("content-type")||"";

  if(req.method==="HEAD")return new Response(null,{status:r.status,headers:cors(new Headers(r.headers))});

  if(maybeM3u8(finalUrl,ct)){
    let t=await r.text();
    if(maybeM3u8(finalUrl,ct,t)){
      let h=cors(new Headers({"content-type":"application/vnd.apple.mpegurl; charset=utf-8","cache-control":"no-store"}));
      return new Response(rewriteManifest(t,finalUrl,ru),{status:r.status,headers:h});
    }
  }

  if(maybeSegment(finalUrl,ct)){
    let b=new Uint8Array(await r.arrayBuffer()),o=findTs(b);
    if(o>=0){
      let body=o?b.slice(o):b,h=cors(new Headers(r.headers));
      ["content-length","content-range","accept-ranges","content-encoding"].forEach(x=>h.delete(x));
      h.set("content-type","video/mp2t");h.set("cache-control","no-store");
      return new Response(body,{status:(r.status===206&&o>0)?200:r.status,headers:h});
    }
  }

  let h=cors(new Headers(r.headers));h.delete("content-encoding");
  return new Response(r.body,{status:r.status,statusText:r.statusText,headers:h});
}

export default {
  async fetch(req){
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
    let u=new URL(req.url);
    if(u.pathname==="/"||u.pathname==="/health")return json({
      ok:true,name:"Enlil HLS Relay",version:"1.0.0",
      usage:"/relay?url=<encoded-hls-url>",
      features:["HLS rewrite","multi-quality preservation","RESOLUTION normalization","PNG/JUNK MPEG-TS repair","Range","CORS","Redline adapter hook"]
    });
    if(u.pathname==="/relay")return handle(req);
    return json({ok:false,error:"Not found"},404);
  }
};
