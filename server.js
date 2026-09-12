'use strict';
/* =====================================================================
   BloxTube — zero-dependency Node backend
   Real accounts, sessions, REST API, role-based admin. No npm install.
   Run:  node server.js       (optionally PORT=8080 node server.js)
   Data: ./data/db.json  (created automatically)
   ===================================================================== */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const INDEX_FILE = path.join(ROOT, 'index.html');
function ensureMediaDir(){ try{ if(!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR,{recursive:true}); }catch(e){} }

/* uploaded media: allowed types + extensions */
const MEDIA_TYPES = {
  'video/mp4':'mp4','video/webm':'webm','video/ogg':'ogv','video/quicktime':'mov','video/x-matroska':'mkv',
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif',
  'audio/mpeg':'mp3','audio/mp4':'m4a','audio/ogg':'oga','audio/wav':'wav','audio/webm':'weba'
};
const EXT_TYPES = { mp4:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mkv:'video/x-matroska',
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',avif:'image/avif',
  mp3:'audio/mpeg',m4a:'audio/mp4',oga:'audio/ogg',wav:'audio/wav',weba:'audio/webm' };
const MAX_UPLOAD = { video:200*1024*1024, audio:60*1024*1024, image:12*1024*1024 };
function mediaKind(mime){ if(mime.startsWith('video/'))return 'video'; if(mime.startsWith('image/'))return 'image'; if(mime.startsWith('audio/'))return 'audio'; return null; }
function unlinkMedia(url){ if(typeof url==='string'&&/^\/media\/[A-Za-z0-9_\-]+\.[a-z0-9]+$/.test(url)){ try{ fs.unlinkSync(path.join(MEDIA_DIR,path.basename(url))); }catch(e){} } }

/* ---------- data store ---------- */
const EMPTY_DB = () => ({
  users: [], videos: [], comments: [], subscriptions: [], likes: [],
  playlists: [], reports: [], notifications: [], sessions: [],
  history: {}, progress: {},
  flags: { bloxclips:true, uploads:true, comments:true, live:true, podcasts:true, ai_features:true, signups:true },
  announcements: [], audit: [],
  maintenance: false, maintenanceMsg: '',
  meta: { createdAt: Date.now() }
});
// Storage: local JSON file by default. If Upstash Redis env vars are set
// (e.g. on Render), persist to Upstash instead so accounts survive restarts.
const REDIS_URL=process.env.UPSTASH_REDIS_REST_URL, REDIS_TOKEN=process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS=!!(REDIS_URL&&REDIS_TOKEN);
const REDIS_KEY='bloxtube:db';
async function redisCmd(cmd){ const r=await fetch(REDIS_URL,{method:'POST',headers:{Authorization:'Bearer '+REDIS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(cmd)}); if(!r.ok)throw new Error('Upstash HTTP '+r.status); return r.json(); }
let DB;
async function loadDB(){
  if(USE_REDIS){ try{ const {result}=await redisCmd(['GET',REDIS_KEY]); DB=result?Object.assign(EMPTY_DB(),JSON.parse(result)):EMPTY_DB(); if(!result)await persistNow(); console.log('      storage: Upstash Redis (persistent, hosted)'); return; }catch(e){ console.error('Redis load failed — running from memory this boot:',e.message); DB=EMPTY_DB(); return; } }
  try { if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
    if(fs.existsSync(DB_FILE)){ DB=Object.assign(EMPTY_DB(),JSON.parse(fs.readFileSync(DB_FILE,'utf8'))); } else { DB=EMPTY_DB(); persistNow(); }
    console.log('      storage: local file ./data/db.json');
  } catch(e){ console.error('DB load failed, starting fresh:',e.message); DB=EMPTY_DB(); }
}
async function persistNow(){ if(USE_REDIS){ try{ await redisCmd(['SET',REDIS_KEY,JSON.stringify(DB)]); }catch(e){ console.error('Redis save failed:',e.message); } }
  else { try{ const tmp=DB_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(DB)); fs.renameSync(tmp,DB_FILE); }catch(e){ console.error('DB save failed:',e.message); } } }
let _saveTimer=null, _dirty=false;
function saveDB(){ _dirty=true; if(_saveTimer)return; _saveTimer=setTimeout(()=>{ _saveTimer=null; if(!_dirty)return; _dirty=false; persistNow(); },200); }
function flushDB(){ if(!USE_REDIS){ try{ fs.writeFileSync(DB_FILE,JSON.stringify(DB)); }catch(e){} } }

/* ---------- helpers ---------- */
const uid = (p='') => p + crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();
function hashPw(pw, salt){ return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function makeSalt(){ return crypto.randomBytes(16).toString('hex'); }
function verifyPw(pw, salt, hash){ try{ const a=Buffer.from(hashPw(pw,salt),'hex'), b=Buffer.from(hash,'hex'); return a.length===b.length && crypto.timingSafeEqual(a,b); }catch(e){ return false; } }
function newToken(){ return crypto.randomBytes(32).toString('hex'); }
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accept only our own uploaded media paths or https:// URLs (never javascript:, data:, etc.)
function safeMediaUrl(s){ s=String(s||'').trim(); if(!s)return ''; if(/^\/media\/[A-Za-z0-9_\-]+\.[a-z0-9]+$/.test(s))return s; if(/^https:\/\/[^\s'"<>]+$/i.test(s)&&s.length<=500)return s; return ''; }
const VERIFY_TIERS = ['official','artist','identity','business'];
// Parse a YouTube/Vimeo URL into an embeddable descriptor.
function parseEmbed(url){ url=String(url||'').trim(); let m;
  if(m=url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_\-]{6,20})/)) return {provider:'youtube',id:m[1]};
  if(m=url.match(/vimeo\.com\/(?:video\/)?(\d{5,12})/)) return {provider:'vimeo',id:m[1]};
  return null; }

class HttpError extends Error{ constructor(status,msg){ super(msg); this.status=status; } }
const bad = (m)=>{ throw new HttpError(400,m); };
const need = (v,m)=>{ if(v==null||v==='') bad(m); return v; };

/* ---------- serialization (never leak secrets) ---------- */
function pubUser(u){ if(!u)return null; const subs=DB.subscriptions.filter(s=>s.channelId===u.id).length; const vids=DB.videos.filter(v=>v.ownerId===u.id&&v.status==='published').length;
  return { id:u.id, handle:u.handle, displayName:u.displayName, avatarSeed:u.avatarSeed, bannerSeed:u.bannerSeed, avatarUrl:u.avatarUrl||'', bannerUrl:u.bannerUrl||'', bio:u.bio||'', role:u.role, verified:u.verified||null, status:u.status, createdAt:u.createdAt, location:u.location||'', pronouns:u.pronouns||'', links:u.links||[], subscribers:subs, videoCount:vids, plus:!!u.plus }; }
function meUser(u){ return Object.assign(pubUser(u), { email:u.email, coins:u.coins||0 }); }
function pubVideo(v){ const owner=DB.users.find(x=>x.id===v.ownerId);
  return { id:v.id, ownerId:v.ownerId, owner:owner?{id:owner.id,handle:owner.handle,displayName:owner.displayName,avatarSeed:owner.avatarSeed,avatarUrl:owner.avatarUrl||'',verified:owner.verified||null}:null,
    title:v.title, desc:v.desc||'', kind:v.kind, dur:v.dur||0, createdAt:v.createdAt, visibility:v.visibility, category:v.category||'',
    tags:v.tags||[], hashtags:v.hashtags||[], thumbSeed:v.thumbSeed, poster:v.poster||'', views:v.views||0, status:v.status, captions:!!v.captions,
    src:v.src||'', srcType:v.srcType||'', embed:v.embed||null,
    resolution:v.resolution||'1080p', likes:DB.likes.filter(l=>l.targetId===v.id&&l.type==='like').length,
    dislikes:DB.likes.filter(l=>l.targetId===v.id&&l.type==='dislike').length,
    commentCount:DB.comments.filter(c=>c.videoId===v.id).length,
    chapters:v.chapters||[], isLive:v.kind==='live', allowRemix:v.allowRemix!==false, allowComments:v.allowComments!==false }; }
function pubComment(c){ const u=DB.users.find(x=>x.id===c.userId);
  return { id:c.id, videoId:c.videoId, text:c.text, createdAt:c.createdAt, parentId:c.parentId||null, pinned:!!c.pinned, hearted:!!c.hearted, edited:!!c.edited,
    likes:c.likes||0, author:u?{id:u.id,handle:u.handle,displayName:u.displayName,avatarSeed:u.avatarSeed,avatarUrl:u.avatarUrl||'',verified:u.verified||null,role:u.role}:null }; }

/* ---------- notifications ---------- */
function notify(userId, type, text, link){ if(!userId)return; DB.notifications.unshift({ id:uid('n_'), userId, type, text, link:link||'', read:false, createdAt:now() }); if(DB.notifications.length>5000)DB.notifications.length=5000; }

/* ---------- audit ---------- */
function audit(actorId, action, target){ DB.audit.unshift({ id:uid('a_'), actorId, action, target:target||'', createdAt:now() }); if(DB.audit.length>5000)DB.audit.length=5000; saveDB(); }

/* ---------- rate limit (in-memory) ---------- */
const rl = new Map();
function rateLimit(key, max, windowMs){ const t=now(); const arr=(rl.get(key)||[]).filter(x=>t-x<windowMs); arr.push(t); rl.set(key,arr); if(arr.length>max) throw new HttpError(429,'Too many attempts — slow down a moment.'); }

/* ---------- auth ---------- */
function sessionFrom(req){ const h=req.headers['authorization']||''; const m=h.match(/^Bearer\s+(.+)$/i); if(!m)return null; const s=DB.sessions.find(s=>s.token===m[1]); if(!s)return null; s.lastSeen=now(); return s; }
function userFrom(req){ const s=sessionFrom(req); if(!s)return null; return DB.users.find(u=>u.id===s.userId)||null; }
function requireUser(ctx){ if(!ctx.user) throw new HttpError(401,'Please sign in.'); if(ctx.user.status==='banned') throw new HttpError(403,'This account is banned.'); return ctx.user; }
function requireAdmin(ctx){ requireUser(ctx); if(ctx.user.role!=='admin'&&ctx.user.role!=='owner') throw new HttpError(403,'Admin access required.'); return ctx.user; }

/* ===================================================================== ROUTES ===================================================================== */
const routes = [];
function route(method, pattern, handler){ const keys=[]; const rx=new RegExp('^'+pattern.replace(/:[^/]+/g,m=>{keys.push(m.slice(1));return '([^/]+)';})+'$'); routes.push({method,rx,keys,handler}); }

/* ---- config / public ---- */
route('GET','/api/config',(ctx)=>({ appName:'BloxTube', signupsOpen:DB.flags.signups!==false, userCount:DB.users.length,
  announcement:(DB.announcements.find(a=>a.active)||null), flags:DB.flags,
  maintenance:DB.maintenance===true, maintenanceMsg:DB.maintenanceMsg||'' }));

/* ---- auth ---- */
route('POST','/api/auth/signup',(ctx)=>{
  rateLimit('signup:'+ctx.ip, 8, 60000);
  if(DB.flags.signups===false) throw new HttpError(403,'Sign-ups are currently closed.');
  const {handle,email,password,displayName}=ctx.body||{};
  if(!HANDLE_RE.test(handle||'')) bad('Handle must be 3–20 letters, numbers or underscores.');
  if(!EMAIL_RE.test(email||'')) bad('Enter a valid email address.');
  if(!password||password.length<6) bad('Password must be at least 6 characters.');
  if(DB.users.some(u=>u.handle.toLowerCase()===handle.toLowerCase())) bad('That handle is taken.');
  if(DB.users.some(u=>u.email.toLowerCase()===email.toLowerCase())) bad('That email is already registered.');
  const salt=makeSalt();
  const first=DB.users.length===0;
  const u={ id:uid('u_'), handle, email:email.toLowerCase(), displayName:(displayName||handle).slice(0,40), salt, passHash:hashPw(password,salt),
    role:first?'owner':'user', verified:first?'official':null, status:'active', createdAt:now(),
    avatarSeed:handle+'~'+crypto.randomBytes(2).toString('hex'), bannerSeed:handle+'#b', bio:'', links:[], location:'', pronouns:'', coins:0, plus:false };
  DB.users.push(u);
  // starter playlists
  DB.playlists.push({id:uid('pl_'),ownerId:u.id,name:'Watch later',visibility:'private',system:'watchlater',items:[],createdAt:now()});
  DB.playlists.push({id:uid('pl_'),ownerId:u.id,name:'Liked videos',visibility:'private',system:'liked',items:[],createdAt:now()});
  const token=newToken(); DB.sessions.push({token,userId:u.id,createdAt:now(),lastSeen:now(),ua:ctx.ua,ip:ctx.ip});
  audit(u.id, first?'created owner account':'created account', u.handle);
  saveDB();
  return { token, user:meUser(u), first };
});
route('POST','/api/auth/login',(ctx)=>{
  rateLimit('login:'+ctx.ip, 12, 60000);
  const {id,password}=ctx.body||{}; const key=(id||'').toLowerCase();
  const u=DB.users.find(u=>u.handle.toLowerCase()===key||u.email.toLowerCase()===key);
  if(!u||!verifyPw(password||'',u.salt,u.passHash)) throw new HttpError(401,'Incorrect handle/email or password.');
  if(u.status==='banned') throw new HttpError(403,'This account is banned.');
  const token=newToken(); DB.sessions.push({token,userId:u.id,createdAt:now(),lastSeen:now(),ua:ctx.ua,ip:ctx.ip}); saveDB();
  return { token, user:meUser(u) };
});
route('POST','/api/auth/logout',(ctx)=>{ const s=sessionFrom(ctx.req); if(s){ DB.sessions=DB.sessions.filter(x=>x.token!==s.token); saveDB(); } return {ok:true}; });
route('POST','/api/auth/logout-all',(ctx)=>{ const u=requireUser(ctx); DB.sessions=DB.sessions.filter(s=>s.userId!==u.id); saveDB(); return {ok:true}; });
route('GET','/api/auth/me',(ctx)=>{ if(!ctx.user)return {user:null}; return {user:meUser(ctx.user)}; });
route('GET','/api/auth/sessions',(ctx)=>{ const u=requireUser(ctx); const cur=sessionFrom(ctx.req); return { sessions:DB.sessions.filter(s=>s.userId===u.id).map(s=>({token:s.token===cur.token?'current':s.token.slice(0,8),current:s.token===cur.token,ua:s.ua,ip:s.ip,createdAt:s.createdAt,lastSeen:s.lastSeen})) }; });

/* ---- me / profile ---- */
route('PATCH','/api/me',(ctx)=>{ const u=requireUser(ctx); const b=ctx.body||{};
  if(b.displayName!=null)u.displayName=String(b.displayName).slice(0,40);
  if(b.bio!=null)u.bio=String(b.bio).slice(0,500);
  if(b.location!=null)u.location=String(b.location).slice(0,60);
  if(b.pronouns!=null)u.pronouns=String(b.pronouns).slice(0,30);
  if(b.avatarUrl!=null)u.avatarUrl=safeMediaUrl(b.avatarUrl);
  if(b.bannerUrl!=null)u.bannerUrl=safeMediaUrl(b.bannerUrl);
  if(Array.isArray(b.links))u.links=b.links.slice(0,5).map(l=>({t:String(l.t||'').slice(0,30),u:String(l.u||'').slice(0,200)}));
  saveDB(); return {user:meUser(u)}; });
route('GET','/api/channels/:id',(ctx)=>{ const u=DB.users.find(x=>x.id===ctx.params.id||x.handle.toLowerCase()===ctx.params.id.toLowerCase()); if(!u)throw new HttpError(404,'Channel not found.');
  const subbed=ctx.user?DB.subscriptions.some(s=>s.subscriberId===ctx.user.id&&s.channelId===u.id):false;
  return { channel:pubUser(u), subscribed:subbed, videos:DB.videos.filter(v=>v.ownerId===u.id&&v.status==='published').map(pubVideo) }; });
route('POST','/api/channels/:id/subscribe',(ctx)=>{ const u=requireUser(ctx); const ch=DB.users.find(x=>x.id===ctx.params.id); if(!ch)throw new HttpError(404,'Channel not found.'); if(ch.id===u.id)bad("You can't subscribe to yourself.");
  const ex=DB.subscriptions.find(s=>s.subscriberId===u.id&&s.channelId===ch.id);
  if(ex){ DB.subscriptions=DB.subscriptions.filter(s=>s!==ex); saveDB(); return {subscribed:false,subscribers:DB.subscriptions.filter(s=>s.channelId===ch.id).length}; }
  DB.subscriptions.push({subscriberId:u.id,channelId:ch.id,createdAt:now()}); notify(ch.id,'subscription',`${u.displayName} subscribed to your channel`,'/channel/'+u.id); saveDB();
  return {subscribed:true,subscribers:DB.subscriptions.filter(s=>s.channelId===ch.id).length}; });
route('GET','/api/me/subscriptions',(ctx)=>{ const u=requireUser(ctx); const ids=DB.subscriptions.filter(s=>s.subscriberId===u.id).map(s=>s.channelId); return {channels:DB.users.filter(x=>ids.includes(x.id)).map(pubUser)}; });
route('GET','/api/me/feed',(ctx)=>{ const u=requireUser(ctx); const ids=DB.subscriptions.filter(s=>s.subscriberId===u.id).map(s=>s.channelId); return {videos:DB.videos.filter(v=>ids.includes(v.ownerId)&&v.status==='published').sort((a,b)=>b.createdAt-a.createdAt).map(pubVideo)}; });

/* ---- videos ---- */
route('GET','/api/videos',(ctx)=>{ const q=ctx.query; let v=DB.videos.filter(x=>x.status==='published'&&x.visibility!=='private');
  if(q.kind)v=v.filter(x=>x.kind===q.kind);
  if(q.ownerId)v=v.filter(x=>x.ownerId===q.ownerId);
  if(q.category&&q.category!=='All')v=v.filter(x=>x.category===q.category);
  if(q.q){ const s=q.q.toLowerCase(); v=v.filter(x=>(x.title+' '+(x.desc||'')+' '+(x.tags||[]).join(' ')).toLowerCase().includes(s)); }
  if(q.sort==='views')v=v.slice().sort((a,b)=>(b.views||0)-(a.views||0));
  else v=v.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const limit=Math.min(+q.limit||60,200);
  return { videos:v.slice(0,limit).map(pubVideo), total:v.length }; });
route('GET','/api/videos/:id',(ctx)=>{ const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v||v.status==='removed')throw new HttpError(404,'Video not found.');
  let liked=null,saved=false; if(ctx.user){ const l=DB.likes.find(l=>l.userId===ctx.user.id&&l.targetId===v.id); liked=l?l.type:null; saved=DB.playlists.some(p=>p.ownerId===ctx.user.id&&p.items.includes(v.id)); }
  const rel=DB.videos.filter(x=>x.id!==v.id&&x.status==='published'&&(x.category===v.category||x.ownerId===v.ownerId)).slice(0,20).map(pubVideo);
  return { video:pubVideo(v), liked, saved, related:rel, progress:(ctx.user&&(DB.progress[ctx.user.id]||{})[v.id])||null }; });
route('POST','/api/videos',(ctx)=>{ const u=requireUser(ctx); if(DB.flags.uploads===false)throw new HttpError(403,'Uploads are temporarily disabled.'); const b=ctx.body||{};
  need(b.title,'A title is required.');
  // resolve the real video source: uploaded file, direct URL, or a YouTube/Vimeo embed
  let src='', srcType='', embed=null;
  if(b.embedUrl){ embed=parseEmbed(b.embedUrl); if(embed){ srcType='embed'; } else { const su=safeMediaUrl(b.embedUrl); if(su){ src=su; srcType='url'; } } }
  if(!srcType && b.src){ const su=safeMediaUrl(b.src); if(su){ src=su; srcType=(su.indexOf('/media/')===0?'file':'url'); } }
  const v={ id:uid('v_'), ownerId:u.id, title:String(b.title).slice(0,140), desc:String(b.desc||'').slice(0,5000),
    kind:['video','clip','live','podcast'].includes(b.kind)?b.kind:'video', dur:Math.max(0,Math.min(+b.dur||0,86400)),
    createdAt:now(), visibility:['public','unlisted','private'].includes(b.visibility)?b.visibility:'public',
    category:String(b.category||'Gaming').slice(0,30), tags:(b.tags||[]).slice(0,20).map(t=>String(t).slice(0,30)),
    hashtags:(b.hashtags||[]).slice(0,10), thumbSeed:b.thumbSeed||uid('t_'), poster:safeMediaUrl(b.poster), views:0, status:'published',
    src, srcType, embed,
    captions:!!b.captions, resolution:b.resolution||'1080p', chapters:Array.isArray(b.chapters)?b.chapters.slice(0,30):[],
    allowRemix:b.allowRemix!==false, allowComments:b.allowComments!==false };
  DB.videos.unshift(v);
  // notify subscribers
  DB.subscriptions.filter(s=>s.channelId===u.id).forEach(s=>notify(s.subscriberId,'upload',`${u.displayName} uploaded: ${v.title}`,'/watch/'+v.id));
  saveDB(); return { video:pubVideo(v) }; });
route('PATCH','/api/videos/:id',(ctx)=>{ const u=requireUser(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); if(v.ownerId!==u.id&&u.role==='user')throw new HttpError(403,'Not your video.');
  const b=ctx.body||{}; ['title','desc','category','visibility'].forEach(k=>{ if(b[k]!=null)v[k]=String(b[k]).slice(0,5000); }); if(b.tags)v.tags=b.tags.slice(0,20); saveDB(); return {video:pubVideo(v)}; });
route('DELETE','/api/videos/:id',(ctx)=>{ const u=requireUser(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); if(v.ownerId!==u.id&&u.role==='user')throw new HttpError(403,'Not your video.');
  unlinkMedia(v.src); unlinkMedia(v.poster); DB.videos=DB.videos.filter(x=>x!==v); DB.comments=DB.comments.filter(c=>c.videoId!==v.id); DB.playlists.forEach(p=>p.items=p.items.filter(i=>i!==v.id)); saveDB(); return {ok:true}; });
route('POST','/api/videos/:id/view',(ctx)=>{ const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); v.views=(v.views||0)+1;
  if(ctx.user){ const h=DB.history[ctx.user.id]=DB.history[ctx.user.id]||[]; const i=h.indexOf(v.id); if(i>=0)h.splice(i,1); h.unshift(v.id); if(h.length>500)h.length=500; } saveDB(); return {views:v.views}; });
route('POST','/api/videos/:id/end-live',(ctx)=>{ const u=requireUser(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.');
  if(v.ownerId!==u.id&&u.role!=='admin'&&u.role!=='owner')throw new HttpError(403,'Only the streamer can end this stream.');
  if(v.kind!=='live')throw new HttpError(400,'This is not a live stream.');
  v.kind='video'; v.wasLive=true; v.endedAt=now(); if(!v.dur)v.dur=Math.max(1,Math.round((now()-v.createdAt)/1000)); saveDB(); return {video:pubVideo(v)}; });
route('POST','/api/videos/:id/like',(ctx)=>{ const u=requireUser(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); const type=ctx.body.type==='dislike'?'dislike':'like';
  const ex=DB.likes.find(l=>l.userId===u.id&&l.targetId===v.id);
  if(ex&&ex.type===type){ DB.likes=DB.likes.filter(l=>l!==ex); }
  else if(ex){ ex.type=type; } else { DB.likes.push({userId:u.id,targetId:v.id,targetKind:'video',type}); }
  // sync liked playlist
  const lp=DB.playlists.find(p=>p.ownerId===u.id&&p.system==='liked'); if(lp){ const isLiked=DB.likes.some(l=>l.userId===u.id&&l.targetId===v.id&&l.type==='like'); const i=lp.items.indexOf(v.id); if(isLiked&&i<0)lp.items.unshift(v.id); else if(!isLiked&&i>=0)lp.items.splice(i,1); }
  saveDB(); const my=DB.likes.find(l=>l.userId===u.id&&l.targetId===v.id);
  return { liked:my?my.type:null, likes:DB.likes.filter(l=>l.targetId===v.id&&l.type==='like').length, dislikes:DB.likes.filter(l=>l.targetId===v.id&&l.type==='dislike').length }; });

/* ---- comments ---- */
route('GET','/api/videos/:id/comments',(ctx)=>{ const cs=DB.comments.filter(c=>c.videoId===ctx.params.id).sort((a,b)=>(b.pinned?1e15:0)-(a.pinned?1e15:0)+(b.likes||0)-(a.likes||0)); return {comments:cs.map(pubComment)}; });
route('POST','/api/videos/:id/comments',(ctx)=>{ const u=requireUser(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); if(v.allowComments===false)throw new HttpError(403,'Comments are turned off.'); if(DB.flags.comments===false)throw new HttpError(403,'Comments are disabled platform-wide.');
  const text=need((ctx.body||{}).text,'Write something first.'); const c={ id:uid('c_'), videoId:v.id, userId:u.id, text:String(text).slice(0,2000), createdAt:now(), likes:0, parentId:ctx.body.parentId||null };
  DB.comments.push(c); if(v.ownerId!==u.id)notify(v.ownerId,'comment',`${u.displayName} commented on ${v.title}`,'/watch/'+v.id); saveDB(); return {comment:pubComment(c)}; });
route('POST','/api/comments/:id/like',(ctx)=>{ requireUser(ctx); const c=DB.comments.find(x=>x.id===ctx.params.id); if(!c)throw new HttpError(404,'Not found.'); c._likers=c._likers||[]; const i=c._likers.indexOf(ctx.user.id); if(i>=0){c._likers.splice(i,1);c.likes=Math.max(0,(c.likes||0)-1);}else{c._likers.push(ctx.user.id);c.likes=(c.likes||0)+1;} saveDB(); return {likes:c.likes}; });
route('POST','/api/comments/:id/pin',(ctx)=>{ const u=requireUser(ctx); const c=DB.comments.find(x=>x.id===ctx.params.id); if(!c)throw new HttpError(404,'Not found.'); const v=DB.videos.find(x=>x.id===c.videoId); if(!v||(v.ownerId!==u.id&&u.role==='user'))throw new HttpError(403,'Only the creator can pin.'); c.pinned=!c.pinned; saveDB(); return {pinned:c.pinned}; });
route('DELETE','/api/comments/:id',(ctx)=>{ const u=requireUser(ctx); const c=DB.comments.find(x=>x.id===ctx.params.id); if(!c)throw new HttpError(404,'Not found.'); const v=DB.videos.find(x=>x.id===c.videoId); if(c.userId!==u.id&&(!v||v.ownerId!==u.id)&&u.role==='user')throw new HttpError(403,'Not allowed.'); DB.comments=DB.comments.filter(x=>x!==c); saveDB(); return {ok:true}; });

/* ---- playlists / library ---- */
route('GET','/api/me/playlists',(ctx)=>{ const u=requireUser(ctx); return {playlists:DB.playlists.filter(p=>p.ownerId===u.id)}; });
route('POST','/api/playlists',(ctx)=>{ const u=requireUser(ctx); const name=need((ctx.body||{}).name,'Name required.'); const p={id:uid('pl_'),ownerId:u.id,name:String(name).slice(0,80),visibility:ctx.body.visibility||'private',items:ctx.body.videoId?[ctx.body.videoId]:[],createdAt:now()}; DB.playlists.push(p); saveDB(); return {playlist:p}; });
route('GET','/api/playlists/:id',(ctx)=>{ const p=DB.playlists.find(x=>x.id===ctx.params.id); if(!p)throw new HttpError(404,'Not found.'); if(p.visibility==='private'&&(!ctx.user||ctx.user.id!==p.ownerId))throw new HttpError(403,'Private playlist.'); return {playlist:p, videos:p.items.map(id=>DB.videos.find(v=>v.id===id)).filter(v=>v&&v.status!=='removed').map(pubVideo), owner:pubUser(DB.users.find(u=>u.id===p.ownerId))}; });
route('POST','/api/playlists/:id/items',(ctx)=>{ const u=requireUser(ctx); const p=DB.playlists.find(x=>x.id===ctx.params.id&&x.ownerId===u.id); if(!p)throw new HttpError(404,'Not found.'); const vid=need(ctx.body.videoId,'videoId required'); const i=p.items.indexOf(vid); if(i>=0)p.items.splice(i,1); else p.items.unshift(vid); saveDB(); return {playlist:p,inPlaylist:i<0}; });
route('DELETE','/api/playlists/:id',(ctx)=>{ const u=requireUser(ctx); const p=DB.playlists.find(x=>x.id===ctx.params.id&&x.ownerId===u.id); if(!p)throw new HttpError(404,'Not found.'); if(p.system)bad('System playlists cannot be deleted.'); DB.playlists=DB.playlists.filter(x=>x!==p); saveDB(); return {ok:true}; });
route('GET','/api/me/history',(ctx)=>{ const u=requireUser(ctx); const ids=DB.history[u.id]||[]; return {videos:ids.map(id=>DB.videos.find(v=>v.id===id)).filter(v=>v&&v.status!=='removed').map(pubVideo)}; });
route('DELETE','/api/me/history',(ctx)=>{ const u=requireUser(ctx); DB.history[u.id]=[]; saveDB(); return {ok:true}; });
route('POST','/api/me/progress',(ctx)=>{ const u=requireUser(ctx); const {videoId,t,pct}=ctx.body||{}; if(videoId){ (DB.progress[u.id]=DB.progress[u.id]||{})[videoId]={t:+t||0,pct:+pct||0,at:now()}; saveDB(); } return {ok:true}; });

/* ---- notifications ---- */
route('GET','/api/me/notifications',(ctx)=>{ const u=requireUser(ctx); return {notifications:DB.notifications.filter(n=>n.userId===u.id).slice(0,100)}; });
route('POST','/api/me/notifications/read',(ctx)=>{ const u=requireUser(ctx); const b=ctx.body||{}; DB.notifications.filter(n=>n.userId===u.id&&(b.all||n.id===b.id)).forEach(n=>n.read=true); saveDB(); return {ok:true}; });

/* ---- reports ---- */
route('POST','/api/reports',(ctx)=>{ const u=requireUser(ctx); const b=ctx.body||{}; const r={id:uid('r_'),reporterId:u.id,targetKind:b.targetKind||'video',targetId:b.targetId||'',reason:String(b.reason||'').slice(0,120),details:String(b.details||'').slice(0,1000),status:'pending',createdAt:now()}; DB.reports.unshift(r); saveDB(); return {ok:true,id:r.id}; });

/* ---- search ---- */
route('GET','/api/search',(ctx)=>{ const s=(ctx.query.q||'').toLowerCase(); const m=(t)=>t.toLowerCase().includes(s);
  return { videos:DB.videos.filter(v=>v.status==='published'&&v.kind!=='clip'&&m(v.title+' '+(v.tags||[]).join(' '))).map(pubVideo),
    clips:DB.videos.filter(v=>v.status==='published'&&v.kind==='clip'&&m(v.title)).map(pubVideo),
    channels:DB.users.filter(u=>m(u.handle+' '+u.displayName+' '+(u.bio||''))).map(pubUser) }; });

/* ===================================================================== ADMIN ===================================================================== */
route('GET','/api/admin/overview',(ctx)=>{ requireAdmin(ctx);
  let mediaFiles=0, mediaBytes=0; try{ ensureMediaDir(); for(const f of fs.readdirSync(MEDIA_DIR)){ try{ const st=fs.statSync(path.join(MEDIA_DIR,f)); if(st.isFile()){ mediaFiles++; mediaBytes+=st.size; } }catch(e){} } }catch(e){}
  return { stats:{ users:DB.users.length, videos:DB.videos.filter(v=>v.status==='published').length, clips:DB.videos.filter(v=>v.kind==='clip').length,
    comments:DB.comments.length, reports:DB.reports.filter(r=>r.status==='pending').length, sessions:DB.sessions.length,
    subscriptions:DB.subscriptions.length, views:DB.videos.reduce((a,v)=>a+(v.views||0),0), suspended:DB.users.filter(u=>u.status!=='active').length,
    live:DB.videos.filter(v=>v.kind==='live').length, mediaFiles, mediaBytes, maintenance:DB.maintenance===true },
    recentUsers:DB.users.slice(-6).reverse().map(pubUser), recentReports:DB.reports.slice(0,6) }; });
route('GET','/api/admin/users',(ctx)=>{ requireAdmin(ctx); const q=(ctx.query.q||'').toLowerCase(); return {users:DB.users.filter(u=>!q||(u.handle+u.displayName+u.email).toLowerCase().includes(q)).map(u=>Object.assign(pubUser(u),{email:u.email})).reverse()}; });
route('PATCH','/api/admin/users/:id',(ctx)=>{ const admin=requireAdmin(ctx); const u=DB.users.find(x=>x.id===ctx.params.id); if(!u)throw new HttpError(404,'User not found.'); const b=ctx.body||{};
  if(u.role==='owner'&&admin.role!=='owner')throw new HttpError(403,'Only the owner can modify the owner.');
  if(b.role&&['user','admin','owner'].includes(b.role)){ if(b.role==='owner'&&admin.role!=='owner')throw new HttpError(403,'Only an owner can grant ownership.'); u.role=b.role; audit(admin.id,'set role '+b.role,u.handle); }
  if(b.status&&['active','suspended','banned'].includes(b.status)){ u.status=b.status; if(b.status!=='active')DB.sessions=DB.sessions.filter(s=>s.userId!==u.id); audit(admin.id,'set status '+b.status,u.handle); }
  if(b.verified!==undefined){ u.verified=VERIFY_TIERS.includes(b.verified)?b.verified:null; audit(admin.id,'verified '+(u.verified||'none'),u.handle); }
  saveDB(); return {user:Object.assign(pubUser(u),{email:u.email})}; });
route('DELETE','/api/admin/users/:id',(ctx)=>{ const admin=requireAdmin(ctx); const u=DB.users.find(x=>x.id===ctx.params.id); if(!u)throw new HttpError(404,'Not found.'); if(u.role==='owner')throw new HttpError(403,'The owner account cannot be deleted.');
  DB.users=DB.users.filter(x=>x!==u); DB.videos=DB.videos.filter(v=>v.ownerId!==u.id); DB.sessions=DB.sessions.filter(s=>s.userId!==u.id); DB.comments=DB.comments.filter(c=>c.userId!==u.id); audit(admin.id,'deleted account',u.handle); saveDB(); return {ok:true}; });
route('GET','/api/admin/content',(ctx)=>{ requireAdmin(ctx); return {videos:DB.videos.map(pubVideo)}; });
route('PATCH','/api/admin/videos/:id',(ctx)=>{ const admin=requireAdmin(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); const b=ctx.body||{}; if(b.status)v.status=b.status; audit(admin.id,'content '+(b.status||'edit'),v.title); saveDB(); return {video:pubVideo(v)}; });
route('DELETE','/api/admin/videos/:id',(ctx)=>{ const admin=requireAdmin(ctx); const v=DB.videos.find(x=>x.id===ctx.params.id); if(!v)throw new HttpError(404,'Not found.'); DB.videos=DB.videos.filter(x=>x!==v); DB.comments=DB.comments.filter(c=>c.videoId!==v.id); audit(admin.id,'removed content',v.title); saveDB(); return {ok:true}; });
route('GET','/api/admin/reports',(ctx)=>{ requireAdmin(ctx); return {reports:DB.reports.map(r=>Object.assign({},r,{reporter:pubUser(DB.users.find(u=>u.id===r.reporterId))}))}; });
route('PATCH','/api/admin/reports/:id',(ctx)=>{ const admin=requireAdmin(ctx); const r=DB.reports.find(x=>x.id===ctx.params.id); if(!r)throw new HttpError(404,'Not found.'); const b=ctx.body||{}; if(b.status)r.status=b.status; if(b.resolution)r.resolution=b.resolution;
  if(b.action==='remove'&&r.targetKind==='video'){ const v=DB.videos.find(x=>x.id===r.targetId); if(v)v.status='removed'; } audit(admin.id,'report '+(b.action||b.status||'update'),r.targetId); saveDB(); return {report:r}; });
route('GET','/api/admin/flags',(ctx)=>{ requireAdmin(ctx); return {flags:DB.flags}; });
route('PATCH','/api/admin/flags',(ctx)=>{ const admin=requireAdmin(ctx); Object.assign(DB.flags,ctx.body||{}); audit(admin.id,'updated feature flags',Object.keys(ctx.body||{}).join(',')); saveDB(); return {flags:DB.flags}; });
route('GET','/api/admin/maintenance',(ctx)=>{ requireAdmin(ctx); return {maintenance:DB.maintenance===true, maintenanceMsg:DB.maintenanceMsg||''}; });
route('PATCH','/api/admin/maintenance',(ctx)=>{ const admin=requireAdmin(ctx); const b=ctx.body||{}; if(b.on!==undefined)DB.maintenance=!!b.on; if(b.message!==undefined)DB.maintenanceMsg=String(b.message).slice(0,300); audit(admin.id,'maintenance '+(DB.maintenance?'ON':'OFF'),DB.maintenanceMsg); saveDB(); return {maintenance:DB.maintenance===true, maintenanceMsg:DB.maintenanceMsg||''}; });
route('GET','/api/admin/announcements',(ctx)=>{ requireAdmin(ctx); return {announcements:DB.announcements}; });
route('POST','/api/admin/announcements',(ctx)=>{ const admin=requireAdmin(ctx); DB.announcements.forEach(a=>a.active=false); const a={id:uid('an_'),text:String((ctx.body||{}).text||'').slice(0,300),active:true,createdAt:now()}; DB.announcements.unshift(a); audit(admin.id,'broadcast announcement',a.text); saveDB(); return {announcement:a}; });
route('DELETE','/api/admin/announcements/:id',(ctx)=>{ requireAdmin(ctx); DB.announcements=DB.announcements.filter(a=>a.id!==ctx.params.id); saveDB(); return {ok:true}; });
route('GET','/api/admin/sessions',(ctx)=>{ requireAdmin(ctx); return {sessions:DB.sessions.slice(-200).reverse().map(s=>({user:pubUser(DB.users.find(u=>u.id===s.userId)),ua:s.ua,ip:s.ip,createdAt:s.createdAt,lastSeen:s.lastSeen}))}; });
route('GET','/api/admin/audit',(ctx)=>{ requireAdmin(ctx); return {audit:DB.audit.slice(0,300).map(a=>Object.assign({},a,{actor:pubUser(DB.users.find(u=>u.id===a.actorId))}))}; });

/* ---- Plus (simulated) ---- */
route('POST','/api/me/plus',(ctx)=>{ const u=requireUser(ctx); u.plus=!!(ctx.body||{}).on; saveDB(); return {plus:u.plus}; });

/* ===================================================================== HTTP SERVER ===================================================================== */
function readBody(req){ return new Promise((resolve)=>{ let data=''; let tooBig=false; req.on('data',c=>{ data+=c; if(data.length>2e6){tooBig=true;req.destroy();} }); req.on('end',()=>{ if(tooBig)return resolve({}); if(!data)return resolve({}); try{ resolve(JSON.parse(data)); }catch(e){ resolve({}); } }); req.on('error',()=>resolve({})); }); }
function send(res,status,obj){ const body=JSON.stringify(obj); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(body); }
const SECURITY_HEADERS={ 'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin',
  'Content-Security-Policy':"default-src 'self'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' blob:; media-src 'self' https: blob: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; font-src 'self' data:; base-uri 'self'; form-action 'self'" };

let INDEX_HTML=null;
function serveIndex(res){ try{ if(INDEX_HTML===null)INDEX_HTML=fs.readFileSync(INDEX_FILE); res.writeHead(200,Object.assign({'Content-Type':'text/html; charset=utf-8'},SECURITY_HEADERS)); res.end(INDEX_HTML); }catch(e){ res.writeHead(500); res.end('index.html not found next to server.js'); } }

/* ---------- media upload (binary, streamed straight to the volume) ---------- */
function handleUpload(req,res){
  const user=userFrom(req);
  if(!user) return send(res,401,{error:'Please sign in to upload.'});
  if(user.status==='banned') return send(res,403,{error:'This account is banned.'});
  const u=new URL(req.url,'http://x');
  const declared=(u.searchParams.get('type')||req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  let ext=MEDIA_TYPES[declared];
  if(!ext){ const fn=(u.searchParams.get('name')||'').toLowerCase(); const m=fn.match(/\.([a-z0-9]+)$/); if(m&&EXT_TYPES[m[1]])ext=m[1]; }
  if(!ext) return send(res,415,{error:'Unsupported file type — use a common video, image or audio format.'});
  const mime=EXT_TYPES[ext]||declared; const kind=mediaKind(mime);
  if(!kind) return send(res,415,{error:'Unsupported file type.'});
  const cap=MAX_UPLOAD[kind]||MAX_UPLOAD.image;
  ensureMediaDir();
  const fname=uid('')+'.'+ext; const fpath=path.join(MEDIA_DIR,fname);
  const ws=fs.createWriteStream(fpath); let size=0, done=false;
  const fail=(status,msg)=>{ if(done)return; done=true; try{ws.destroy();}catch(e){} try{fs.unlinkSync(fpath);}catch(e){} try{req.destroy();}catch(e){} try{send(res,status,{error:msg});}catch(e){} };
  req.on('data',c=>{ size+=c.length; if(size>cap) fail(413,'File too large (max '+Math.round(cap/1048576)+'MB for '+kind+').'); });
  req.on('error',()=>fail(400,'Upload interrupted.'));
  ws.on('error',()=>fail(500,'Could not save the file.'));
  ws.on('finish',()=>{ if(done)return; done=true; if(size===0){ try{fs.unlinkSync(fpath);}catch(e){} return send(res,400,{error:'The file was empty.'}); }
    send(res,200,{ src:'/media/'+fname, kind, mime, bytes:size }); });
  req.pipe(ws);
}
/* ---------- media streaming (HTTP Range for seeking) ---------- */
function serveMedia(req,res,pathname){
  const name=path.basename(pathname);
  if(!/^[A-Za-z0-9_\-]+\.[a-z0-9]+$/.test(name)){ res.writeHead(404); return res.end('Not found'); }
  const fpath=path.join(MEDIA_DIR,name);
  if(!fpath.startsWith(MEDIA_DIR+path.sep)){ res.writeHead(404); return res.end('Not found'); }
  let stat; try{ stat=fs.statSync(fpath); if(!stat.isFile())throw 0; }catch(e){ res.writeHead(404); return res.end('Not found'); }
  const ext=(name.split('.').pop()||'').toLowerCase(); const type=EXT_TYPES[ext]||'application/octet-stream';
  const base={ 'Content-Type':type, 'Accept-Ranges':'bytes', 'Cache-Control':'public, max-age=31536000, immutable' };
  const range=req.headers.range;
  if(range){ const m=range.match(/bytes=(\d*)-(\d*)/); let start=m&&m[1]!==''?parseInt(m[1]):0; let end=m&&m[2]!==''?parseInt(m[2]):stat.size-1;
    if(isNaN(start)||isNaN(end)||start>end||end>=stat.size){ res.writeHead(416,{'Content-Range':'bytes */'+stat.size}); return res.end(); }
    res.writeHead(206,Object.assign({},base,{ 'Content-Range':`bytes ${start}-${end}/${stat.size}`, 'Content-Length':end-start+1 }));
    if(req.method==='HEAD')return res.end();
    return fs.createReadStream(fpath,{start,end}).pipe(res); }
  res.writeHead(200,Object.assign({},base,{ 'Content-Length':stat.size }));
  if(req.method==='HEAD')return res.end();
  fs.createReadStream(fpath).pipe(res);
}

const server=http.createServer(async (req,res)=>{
  for(const k in SECURITY_HEADERS)res.setHeader(k,SECURITY_HEADERS[k]);
  const u=new URL(req.url,'http://x'); const pathname=decodeURIComponent(u.pathname);
  // uploaded media (binary, streamed)
  if(pathname.startsWith('/media/')){ if(req.method!=='GET'&&req.method!=='HEAD'){ res.writeHead(405); return res.end('Method not allowed'); } return serveMedia(req,res,pathname); }
  // API
  if(pathname.startsWith('/api/')){
    // binary upload is handled specially (streamed to disk, not parsed as JSON)
    if(pathname==='/api/upload'){ if(req.method!=='POST'){ return send(res,405,{error:'Use POST to upload.'}); } return handleUpload(req,res); }
    try{
      const match=routes.find(r=>r.method===req.method&&r.rx.test(pathname));
      if(!match) return send(res,404,{error:'Unknown endpoint.'});
      const m=pathname.match(match.rx); const params={}; match.keys.forEach((k,i)=>params[k]=m[i+1]);
      const query=Object.fromEntries(u.searchParams);
      const body=(req.method==='POST'||req.method==='PATCH'||req.method==='PUT')?await readBody(req):{};
      const ctx={ req,res,params,query,body, user:userFrom(req), ip:(req.headers['x-forwarded-for']||req.socket.remoteAddress||'?').split(',')[0].trim(), ua:(req.headers['user-agent']||'').slice(0,160) };
      // maintenance mode: block non-admin writes (auth + admin routes always allowed)
      if(DB.maintenance && (req.method==='POST'||req.method==='PATCH'||req.method==='PUT'||req.method==='DELETE') && !pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/admin/')){
        const isAdmin=ctx.user&&(ctx.user.role==='admin'||ctx.user.role==='owner');
        if(!isAdmin) throw new HttpError(503,'BloxTube is down for maintenance — please check back soon.');
      }
      const out=await match.handler(ctx);
      send(res,200,out==null?{ok:true}:out);
    }catch(e){ if(e instanceof HttpError)send(res,e.status,{error:e.message}); else { console.error(e); send(res,500,{error:'Server error.'}); } }
    return;
  }
  // block sensitive files, serve SPA for everything else
  if(pathname==='/server.js'||pathname.startsWith('/data')||pathname.includes('..')) { res.writeHead(404); return res.end('Not found'); }
  serveIndex(res);
});

process.on('SIGINT',()=>{ flushDB(); process.exit(0); });
process.on('SIGTERM',()=>{ flushDB(); process.exit(0); });
(async()=>{ await loadDB(); ensureMediaDir(); server.listen(PORT,()=>{ console.log(`\n  🎬  BloxTube backend running →  http://localhost:${PORT}`); console.log(`      ${DB.users.length} account(s) · ${DB.videos.length} video(s)`); if(DB.users.length===0)console.log(`      First account you create becomes the OWNER (full admin).\n`); }); })();
