import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import pg from 'pg';
import { WebSocketServer, WebSocket } from 'ws';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || join(process.cwd(), 'data', 'store.json');
const PUBLIC_DIR = join(process.cwd(), 'public');
const ADMIN_USER = process.env.ADMIN_USER || 'kunkunele';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '00a821a164d68268545bf0d7751a208d:786a1c96f67f6449c973326ee4c2352861881390bf4c79bcac0b777ab7a855c0d3c90ebf14f570bad50f19fdc63ee77ad3730348c5a6ae7819b552771d0db801';
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-me-kunkun';
const DATABASE_URL = process.env.DATABASE_URL || '';
const isProduction = process.env.NODE_ENV === 'production';

const initialCuisines = ['粤菜','北京菜','湘菜','川菜','东北菜','江浙菜','云南菜','日料','烤肉','烧烤','青岛菜','韩料','东南亚','火锅','包子生煎','海鲜'];
const initialBlessings = [
  '今天的快乐，就从这一口开始吧～','和喜欢的人一起吃，热量可以先不算！','命运已经选好啦，坤坤只负责开心吃～','这顿饭一定会有小惊喜 ✨',
  '好好吃饭，就是今天最温柔的小事～','幸运转盘说：这一口会超级满足！','吃饱饱，烦恼就会变得小小的～','今日份幸福正在热乎乎地赶来！',
  '愿这一餐有香气、有笑声，还有好心情～','被选中的美味，当然要认真享受啦！','今天也要和好吃的东西见面呀～','快乐无需理由，美食就是最好的答案 ♡'
];
const initialSiteCopy = {
  global: { brandTitle: '坤坤今天吃什么～' },
  home: { title: '坤坤今天吃什么～', subtitle: '选择困难先放一放，让幸运转盘替你做决定吧！', button: '帮坤坤选一选', hint: '轻轻一点，命运的齿轮开始转动～' },
  restaurant: { title: '这顿去哪家？', subtitle: '先选一个菜系，再转出今天的心动餐厅。', button: '看看去哪家' },
  directory: { title: '菜系餐厅总览', subtitle: '每个菜系里收藏了哪些餐厅，一眼就能找到。' },
  fitness: { title: '坤坤减脂ing 🏋️', subtitle: '坤坤的完美减脂美食～！', button: '今天健康吃什么' },
  night: { title: '半夜饿了，坤坤吃点什么呢？', subtitle: '半夜偷偷吃一点，想必也不会胖吧～', button: '偷偷吃一点' },
  history: { title: '今天的选择', subtitle: '每一次转动，都悄悄留在这台设备里。' },
  room: { title: '坤坤邀请你一起吃～', subtitle: '三颗小草莓，一起选出大家都喜欢的味道。' }
};
const now = () => new Date().toISOString();
const initialData = () => ({
  cuisines: initialCuisines.map((name, index) => ({ id: `c-${index + 1}`, name, enabled: true, weight: 1, order: index })),
  restaurants: [],
  fitnessMeals: [],
  nightSnacks: [],
  blessings: initialBlessings.map((text,index)=>({id:`b-${index+1}`,text,enabled:true,order:index})),
  siteCopy: structuredClone(initialSiteCopy),
  createdAt: now(),
  updatedAt: now()
});

let store;
let writeQueue = Promise.resolve();
let pool;
const loginAttempts = new Map();
const localRooms = new Map();
const roomClients = new Map();
const roomLocks = new Map();

async function loadStore() {
  if (DATABASE_URL) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    await pool.query('create table if not exists app_state (id bigint primary key check (id = 1), data jsonb not null, updated_at timestamptz not null default now())');
    await pool.query('create table if not exists shared_rooms (id text primary key, data jsonb not null, expires_at timestamptz not null, updated_at timestamptz not null default now())');
    const result = await pool.query('select data from app_state where id = 1');
    if (result.rows[0]?.data) store = { ...initialData(), ...result.rows[0].data, siteCopy: mergeSiteCopy(result.rows[0].data.siteCopy) };
    else {
      store = initialData();
      await pool.query('insert into app_state (id, data) values (1, $1::jsonb)', [JSON.stringify(store)]);
    }
    return;
  }
  await mkdir(join(DATA_FILE, '..'), { recursive: true });
  if (!existsSync(DATA_FILE)) {
    store = initialData();
    await saveStore();
    return;
  }
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    store = { ...initialData(), ...parsed, siteCopy: mergeSiteCopy(parsed.siteCopy) };
  } catch {
    store = initialData();
    await saveStore();
  }
}

function saveStore() {
  store.updatedAt = now();
  writeQueue = writeQueue.then(async () => {
    if (pool) {
      await pool.query('insert into app_state (id, data, updated_at) values (1, $1::jsonb, now()) on conflict (id) do update set data = excluded.data, updated_at = now()', [JSON.stringify(store)]);
      return;
    }
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2));
    await rename(tmp, DATA_FILE);
  });
  return writeQueue;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => {
    const i = v.indexOf('='); return [v.slice(0, i).trim(), decodeURIComponent(v.slice(i + 1))];
  }));
}

function sign(value) { return createHmac('sha256', SESSION_SECRET).update(value).digest('base64url'); }
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ user: ADMIN_USER, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function isAdmin(req) {
  const token = parseCookies(req).kunkun_session;
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || sign(payload) !== signature) return false;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url')); return data.user === ADMIN_USER && data.exp > Date.now(); } catch { return false; }
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2500000) throw new Error('图片或内容过大，请换一张更小的图片'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('内容格式不正确'); }
}
const clean = (value, max = 120) => String(value || '').trim().slice(0, max);
const mergeSiteCopy = value => Object.fromEntries(Object.entries(initialSiteCopy).map(([section,defaults])=>[section,{...defaults,...(value?.[section]||{})}]));
const publicState = () => ({
  cuisines: store.cuisines.slice().sort((a,b) => a.order - b.order),
  restaurants: store.restaurants.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  fitnessMeals: (store.fitnessMeals || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  nightSnacks: (store.nightSnacks || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  blessings: (store.blessings || []).filter(x=>x.enabled).slice().sort((a,b)=>a.order-b.order),
  siteCopy: mergeSiteCopy(store.siteCopy),
  updatedAt: store.updatedAt
});

const hashToken=value=>createHash('sha256').update(value).digest('hex');
const validRoomId=value=>/^[A-Za-z0-9_-]{20,40}$/.test(value||'');
const randomToken=bytes=>randomBytes(bytes).toString('base64url');
const newRoom=id=>({id,participants:[],stage:'cuisine',selectedCuisineId:null,finalRestaurantId:null,spin:null,revision:0,createdAt:now(),expiresAt:new Date(Date.now()+86400000).toISOString()});

async function loadRoom(id){
  if(!validRoomId(id))return null;
  let room;
  if(pool){const result=await pool.query('select data from shared_rooms where id=$1 and expires_at>now()',[id]);room=result.rows[0]?.data||null;}
  else{room=localRooms.get(id)||null;if(room&&new Date(room.expiresAt)<=new Date()){localRooms.delete(id);room=null;}}
  return room;
}
async function saveRoom(room){
  room.revision=(room.revision||0)+1;
  if(pool)await pool.query('insert into shared_rooms(id,data,expires_at,updated_at) values($1,$2::jsonb,$3,now()) on conflict(id) do update set data=excluded.data,expires_at=excluded.expires_at,updated_at=now()',[room.id,JSON.stringify(room),room.expiresAt]);
  else localRooms.set(room.id,structuredClone(room));
  return room;
}
function onlineParticipantIds(roomId){return new Set([...(roomClients.get(roomId)||[])].filter(ws=>ws.readyState===WebSocket.OPEN).map(ws=>ws.participantId));}
function publicRoom(room){
  const online=onlineParticipantIds(room.id);
  return {...room,participants:room.participants.map(({tokenHash,...p})=>({...p,online:online.has(p.id)})),onlineCount:online.size};
}
function withRoomLock(id,task){const previous=roomLocks.get(id)||Promise.resolve();const next=previous.catch(()=>{}).then(task);roomLocks.set(id,next);next.finally(()=>{if(roomLocks.get(id)===next)roomLocks.delete(id);});return next;}
function roomSend(ws,payload){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(payload));}
function broadcastRoom(room){for(const ws of roomClients.get(room.id)||[])roomSend(ws,{type:'state',room:publicRoom(room)});}
function roomError(ws,message){roomSend(ws,{type:'error',message});}
function activeBlessings(){return (store.blessings||[]).filter(x=>x.enabled).sort((a,b)=>a.order-b.order);}
function randomBlessing(){const items=activeBlessings();return items.length?items[Math.floor(Math.random()*items.length)].text:'';}

function progress() {
  const counts = {};
  const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  for (const r of store.restaurants) { const day = dayKey(new Date(r.createdAt)); counts[day] = (counts[day] || 0) + 1; }
  const today = dayKey(new Date());
  let streak = 0; const d = new Date(`${today}T12:00:00Z`);
  while (counts[dayKey(d)] >= 3) { streak++; d.setUTCDate(d.getUTCDate() - 1); }
  return { todayCount: counts[today] || 0, streak, completedDays: Object.values(counts).filter(n => n >= 3).length, targetDays: 20 };
}

function requireAdmin(req, res) { if (!isAdmin(req)) { json(res, 401, { error: '请先登录管理员账号' }); return false; } return true; }
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function api(req, res, url) {
  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, publicState());
  if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { admin: isAdmin(req) });
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const key = req.socket.remoteAddress || 'local'; const attempt = loginAttempts.get(key) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return json(res, 429, { error: '尝试次数太多，请稍后再试' });
    const data = await body(req); const [salt, expectedHex] = ADMIN_PASSWORD_HASH.split(':');
    const actual = scryptSync(clean(data.password, 200), salt, 64); const expected = Buffer.from(expectedHex, 'hex');
    const valid = clean(data.username, 80) === ADMIN_USER && expected.length === actual.length && timingSafeEqual(actual, expected);
    if (!valid) { attempt.count++; if (attempt.count >= 5) { attempt.until = Date.now() + 5 * 60000; attempt.count = 0; } loginAttempts.set(key, attempt); return json(res, 401, { error: '账号或密码不正确' }); }
    loginAttempts.delete(key);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `kunkun_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${isProduction ? '; Secure' : ''}` });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': 'kunkun_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  const roomMatch=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})$/);
  if(roomMatch&&req.method==='GET'){
    const room=await loadRoom(roomMatch[1]);
    if(!room)return json(res,410,{error:'这个邀请房间已经失效啦'});
    return json(res,200,publicRoom(room));
  }
  if (!sameOrigin(req)) return json(res, 403, { error: '请求来源无效' });
  if(url.pathname==='/api/rooms'&&req.method==='POST'){
    const room=newRoom(randomToken(18));await saveRoom(room);return json(res,201,{roomId:room.id,expiresAt:room.expiresAt});
  }
  const joinMatch=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/join$/);
  if(joinMatch&&req.method==='POST'){
    const data=await body(req),nickname=clean(data.nickname,10),provided=clean(data.participantToken,100);
    if(!nickname)return json(res,400,{error:'给自己起一个小昵称吧～'});
    return withRoomLock(joinMatch[1],async()=>{
      let room=await loadRoom(joinMatch[1]);if(!room)room=newRoom(joinMatch[1]);
      let participant=provided?room.participants.find(p=>p.tokenHash===hashToken(provided)):null,token=provided;
      if(participant){participant.nickname=nickname;}
      else{
        if(room.participants.length>=3)return json(res,409,{error:'三颗小草莓已经到齐啦，这个房间满员了'});
        token=randomToken(24);participant={id:randomUUID(),nickname,seat:room.participants.length+1,exclusions:[],tokenHash:hashToken(token),joinedAt:now()};room.participants.push(participant);
      }
      await saveRoom(room);broadcastRoom(room);return json(res,200,{participantId:participant.id,participantToken:token,room:publicRoom(room)});
    });
  }
  if (url.pathname === '/api/admin/progress' && req.method === 'GET') { if (!requireAdmin(req,res)) return; return json(res, 200, progress()); }
  if (url.pathname === '/api/admin/blessings' && req.method === 'GET') { if (!requireAdmin(req,res)) return; return json(res,200,(store.blessings||[]).slice().sort((a,b)=>a.order-b.order)); }
  if (url.pathname === '/api/admin/site-copy' && req.method === 'GET') { if (!requireAdmin(req,res)) return; return json(res,200,mergeSiteCopy(store.siteCopy)); }
  if (!requireAdmin(req, res)) return;

  const copyMatch=url.pathname.match(/^\/api\/site-copy\/([a-z]+)$/);
  if(copyMatch){
    const section=copyMatch[1],defaults=initialSiteCopy[section];
    if(!defaults)return json(res,404,{error:'没有找到这组页面文案'});
    if(req.method==='PUT'){
      const data=await body(req),next={};
      for(const key of Object.keys(defaults)){const value=clean(data[key],key==='subtitle'?160:80);if(!value)return json(res,400,{error:'每一项文案都要填写哦'});next[key]=value;}
      store.siteCopy=mergeSiteCopy(store.siteCopy);store.siteCopy[section]=next;await saveStore();return json(res,200,next);
    }
    if(req.method==='DELETE'){
      store.siteCopy=mergeSiteCopy(store.siteCopy);store.siteCopy[section]={...defaults};await saveStore();return json(res,200,store.siteCopy[section]);
    }
  }

  if (url.pathname === '/api/cuisines' && req.method === 'POST') {
    const data = await body(req); const name = clean(data.name, 20);
    if (!name) return json(res, 400, { error: '请输入菜系名称' });
    if (store.cuisines.some(c => c.name === name)) return json(res, 409, { error: '这个菜系已经存在啦' });
    const item = { id: randomUUID(), name, enabled: true, weight: 1, order: store.cuisines.length };
    store.cuisines.push(item); await saveStore(); return json(res, 201, item);
  }
  if (url.pathname === '/api/cuisines/reorder' && req.method === 'PUT') {
    const data = await body(req); const ids = Array.isArray(data.ids) ? data.ids : [];
    if (ids.length !== store.cuisines.length || new Set(ids).size !== ids.length || ids.some(id => !store.cuisines.some(c => c.id === id))) return json(res, 400, { error: '菜系顺序不完整' });
    ids.forEach((id, order) => { store.cuisines.find(c => c.id === id).order = order; });
    await saveStore(); return json(res, 200, { ok: true });
  }
  const cuisineMatch = url.pathname.match(/^\/api\/cuisines\/([^/]+)$/);
  if (cuisineMatch) {
    const item = store.cuisines.find(c => c.id === cuisineMatch[1]); if (!item) return json(res,404,{error:'菜系不存在'});
    if (req.method === 'PUT') { const data = await body(req); const name = clean(data.name,20); if (!name) return json(res,400,{error:'请输入菜系名称'}); if (store.cuisines.some(c=>c.id!==item.id&&c.name===name)) return json(res,409,{error:'这个菜系已经存在啦'}); Object.assign(item,{ name, enabled:Boolean(data.enabled), weight:Math.max(1,Math.min(10,Number(data.weight)||1)), order:Math.max(0,Number(data.order)||0) }); await saveStore(); return json(res,200,item); }
    if (req.method === 'DELETE') { if (store.restaurants.some(r=>r.cuisineId===item.id)) return json(res,409,{error:'请先删除这个菜系下的餐厅'}); store.cuisines=store.cuisines.filter(c=>c.id!==item.id); await saveStore(); return json(res,200,{ok:true}); }
  }
  if (url.pathname === '/api/restaurants' && req.method === 'POST') {
    const data = await body(req); const name=clean(data.name,40), cuisineId=clean(data.cuisineId,80);
    if (!name || !store.cuisines.some(c=>c.id===cuisineId)) return json(res,400,{error:'请填写餐厅名称并选择菜系'});
    if (store.restaurants.some(r=>r.name===name&&r.cuisineId===cuisineId)) return json(res,409,{error:'这个菜系下已有同名餐厅'});
    const item={id:randomUUID(),name,cuisineId,address:clean(data.address,120),note:clean(data.note,300),createdAt:now()}; store.restaurants.push(item); await saveStore(); return json(res,201,item);
  }
  const restaurantMatch=url.pathname.match(/^\/api\/restaurants\/([^/]+)$/);
  if (restaurantMatch) {
    const item=store.restaurants.find(r=>r.id===restaurantMatch[1]); if(!item)return json(res,404,{error:'餐厅不存在'});
    if(req.method==='PUT'){const data=await body(req);const name=clean(data.name,40),cuisineId=clean(data.cuisineId,80);if(!name||!store.cuisines.some(c=>c.id===cuisineId))return json(res,400,{error:'请填写餐厅名称并选择菜系'});if(store.restaurants.some(r=>r.id!==item.id&&r.name===name&&r.cuisineId===cuisineId))return json(res,409,{error:'这个菜系下已有同名餐厅'});Object.assign(item,{name,cuisineId,address:clean(data.address,120),note:clean(data.note,300)});await saveStore();return json(res,200,item);}
    if(req.method==='DELETE'){store.restaurants=store.restaurants.filter(r=>r.id!==item.id);await saveStore();return json(res,200,{ok:true});}
  }
  const menuCollectionMatch=url.pathname.match(/^\/api\/(fitness-meals|night-snacks)$/);
  if(menuCollectionMatch&&req.method==='POST'){
    const key=menuCollectionMatch[1]==='fitness-meals'?'fitnessMeals':'nightSnacks';
    const data=await body(req),name=clean(data.name,50),image=clean(data.image,1800000),calories=clean(data.calories,40),ingredients=clean(data.ingredients,500);
    if(!name)return json(res,400,{error:'请填写名称'});
    if(!image)return json(res,400,{error:'请上传一张图片'});
    if(key==='fitnessMeals'&&!ingredients)return json(res,400,{error:'请填写食材'});
    if(!calories)return json(res,400,{error:'请填写热量'});
    if((store[key]||[]).some(x=>x.name===name))return json(res,409,{error:'这个名称已经存在啦'});
    const item={id:randomUUID(),name,image,calories,ingredients:key==='fitnessMeals'?ingredients:'',createdAt:now()};
    store[key]=store[key]||[];store[key].push(item);await saveStore();return json(res,201,item);
  }
  const menuItemMatch=url.pathname.match(/^\/api\/(fitness-meals|night-snacks)\/([^/]+)$/);
  if(menuItemMatch){
    const key=menuItemMatch[1]==='fitness-meals'?'fitnessMeals':'nightSnacks',items=store[key]||[],item=items.find(x=>x.id===menuItemMatch[2]);
    if(!item)return json(res,404,{error:'内容不存在'});
    if(req.method==='PUT'){
      const data=await body(req),name=clean(data.name,50),image=clean(data.image,1800000),calories=clean(data.calories,40),ingredients=clean(data.ingredients,500);
      if(!name||!image||!calories||(key==='fitnessMeals'&&!ingredients))return json(res,400,{error:'请将资料填写完整'});
      if(items.some(x=>x.id!==item.id&&x.name===name))return json(res,409,{error:'这个名称已经存在啦'});
      Object.assign(item,{name,image,calories,ingredients:key==='fitnessMeals'?ingredients:''});await saveStore();return json(res,200,item);
    }
    if(req.method==='DELETE'){store[key]=items.filter(x=>x.id!==item.id);await saveStore();return json(res,200,{ok:true});}
  }
  if(url.pathname==='/api/blessings'&&req.method==='POST'){
    const data=await body(req),text=clean(data.text,120);if(!text)return json(res,400,{error:'请写一句祝福语'});
    if((store.blessings||[]).some(x=>x.text===text))return json(res,409,{error:'这句祝福已经存在啦'});
    const item={id:randomUUID(),text,enabled:true,order:(store.blessings||[]).length};store.blessings=store.blessings||[];store.blessings.push(item);await saveStore();return json(res,201,item);
  }
  if(url.pathname==='/api/blessings/reorder'&&req.method==='PUT'){
    const data=await body(req),ids=Array.isArray(data.ids)?data.ids:[],items=store.blessings||[];
    if(ids.length!==items.length||new Set(ids).size!==ids.length||ids.some(id=>!items.some(x=>x.id===id)))return json(res,400,{error:'祝福语顺序不完整'});
    ids.forEach((id,order)=>{items.find(x=>x.id===id).order=order;});await saveStore();return json(res,200,{ok:true});
  }
  const blessingMatch=url.pathname.match(/^\/api\/blessings\/([^/]+)$/);
  if(blessingMatch){
    const item=(store.blessings||[]).find(x=>x.id===blessingMatch[1]);if(!item)return json(res,404,{error:'祝福语不存在'});
    if(req.method==='PUT'){const data=await body(req),text=clean(data.text,120);if(!text)return json(res,400,{error:'请写一句祝福语'});if(store.blessings.some(x=>x.id!==item.id&&x.text===text))return json(res,409,{error:'这句祝福已经存在啦'});Object.assign(item,{text,enabled:Boolean(data.enabled),order:Math.max(0,Number(data.order)||0)});await saveStore();return json(res,200,item);}
    if(req.method==='DELETE'){store.blessings=store.blessings.filter(x=>x.id!==item.id);await saveStore();return json(res,200,{ok:true});}
  }
  return json(res, 404, { error: '没有找到这个功能' });
}

async function handleRoomMessage(ws,raw){
  let message;try{message=JSON.parse(raw.toString());}catch{return roomError(ws,'消息格式不正确');}
  await withRoomLock(ws.roomId,async()=>{
    const room=await loadRoom(ws.roomId);if(!room)return roomError(ws,'这个房间已经失效啦');
    const participant=room.participants.find(p=>p.id===ws.participantId&&p.tokenHash===ws.tokenHash);if(!participant)return roomError(ws,'参与身份已经失效');
    const spinning=room.spin&&room.spin.endsAt>Date.now();
    if(message.type==='exclude'){
      if(room.stage!=='cuisine'||spinning)return roomError(ws,'转盘进行中，暂时不能修改选择');
      const cuisine=store.cuisines.find(c=>c.id===message.cuisineId&&c.enabled);if(!cuisine)return roomError(ws,'这个菜系不可用');
      const set=new Set(participant.exclusions||[]);message.excluded?set.add(cuisine.id):set.delete(cuisine.id);participant.exclusions=[...set];room.spin=null;
    }else if(message.type==='spin'){
      if(spinning)return roomError(ws,'转盘已经开始啦，看看这次会抽到什么～');
      if(message.kind==='cuisine'){
        if(room.stage!=='cuisine')return roomError(ws,'先重新选择菜系再转哦');
        const excluded=new Set(room.participants.flatMap(p=>p.exclusions||[]));const choices=store.cuisines.filter(c=>c.enabled&&!excluded.has(c.id)).sort((a,b)=>a.order-b.order);
        if(!choices.length)return roomError(ws,'总得留点能吃的呀～');
        const weighted=choices.flatMap(item=>Array(Math.max(1,item.weight||1)).fill(item)),pick=weighted[Math.floor(Math.random()*weighted.length)];
        room.selectedCuisineId=pick.id;room.finalRestaurantId=null;room.stage='restaurant';room.spin={id:randomUUID(),kind:'cuisine',resultId:pick.id,blessing:randomBlessing(),startedAt:Date.now()+600,endsAt:Date.now()+4900};
      }else if(message.kind==='restaurant'){
        if(!room.selectedCuisineId)return roomError(ws,'请先抽出一个共同菜系');
        const choices=store.restaurants.filter(r=>r.cuisineId===room.selectedCuisineId);if(!choices.length)return roomError(ws,'这个菜系还没有餐厅，重新抽一个菜系吧～');
        const pick=choices[Math.floor(Math.random()*choices.length)];room.finalRestaurantId=pick.id;room.stage='done';room.spin={id:randomUUID(),kind:'restaurant',resultId:pick.id,blessing:randomBlessing(),startedAt:Date.now()+600,endsAt:Date.now()+4900};
      }else return roomError(ws,'未知的转盘类型');
    }else if(message.type==='resetCuisine'){
      if(spinning)return roomError(ws,'等转盘停下来再重新选择吧～');room.stage='cuisine';room.selectedCuisineId=null;room.finalRestaurantId=null;room.spin=null;
    }else if(message.type==='resetRestaurant'){
      if(spinning)return roomError(ws,'等转盘停下来再重抽吧～');if(!room.selectedCuisineId)return roomError(ws,'请先抽菜系');room.stage='restaurant';room.finalRestaurantId=null;room.spin=null;
    }else return roomError(ws,'没有找到这个房间操作');
    await saveRoom(room);broadcastRoom(room);
  }).catch(err=>{console.error(err);roomError(ws,'房间暂时开小差了，请稍后重试');});
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
async function serve(req,res,url){
  if(url.pathname.startsWith('/api/')) return api(req,res,url);
  const requested=url.pathname==='/'?'index.html':url.pathname.slice(1); const path=normalize(join(PUBLIC_DIR,requested));
  if(!path.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try { const file=await readFile(path); res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}); res.end(file); }
  catch { try { const file=await readFile(join(PUBLIC_DIR,'index.html')); res.writeHead(200,{'Content-Type':types['.html']});res.end(file); } catch { res.writeHead(404);res.end('Not found'); } }
}

await loadStore();
const server=http.createServer((req,res)=>{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);serve(req,res,url).catch(err=>{console.error(err);if(!res.headersSent)json(res,500,{error:'服务暂时开小差了，请稍后再试'});else res.end();});});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',async(req,socket,head)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname!=='/ws')return socket.destroy();
    const roomId=url.searchParams.get('room'),token=url.searchParams.get('token');if(!validRoomId(roomId)||!token)return socket.destroy();
    const room=await loadRoom(roomId),tokenHash=hashToken(token),participant=room?.participants.find(p=>p.tokenHash===tokenHash);if(!room||!participant)return socket.destroy();
    wss.handleUpgrade(req,socket,head,ws=>{ws.roomId=roomId;ws.participantId=participant.id;ws.tokenHash=tokenHash;ws.isAlive=true;wss.emit('connection',ws,req);});
  }catch{socket.destroy();}
});
wss.on('connection',async ws=>{
  if(!roomClients.has(ws.roomId))roomClients.set(ws.roomId,new Set());roomClients.get(ws.roomId).add(ws);
  ws.on('pong',()=>{ws.isAlive=true;});ws.on('message',data=>handleRoomMessage(ws,data));ws.on('error',()=>{});
  ws.on('close',async()=>{roomClients.get(ws.roomId)?.delete(ws);if(!roomClients.get(ws.roomId)?.size)roomClients.delete(ws.roomId);const room=await loadRoom(ws.roomId);if(room)broadcastRoom(room);});
  const room=await loadRoom(ws.roomId);if(room)broadcastRoom(room);
});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},25000);heartbeat.unref();
server.listen(PORT,HOST,()=>console.log(`坤坤今天吃什么～ http://${HOST}:${PORT}`));
export { server, initialCuisines };
