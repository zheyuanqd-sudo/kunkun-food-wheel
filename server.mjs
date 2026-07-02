import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createHmac, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import pg from 'pg';

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
const now = () => new Date().toISOString();
const initialData = () => ({
  cuisines: initialCuisines.map((name, index) => ({ id: `c-${index + 1}`, name, enabled: true, weight: 1, order: index })),
  restaurants: [],
  fitnessMeals: [],
  nightSnacks: [],
  createdAt: now(),
  updatedAt: now()
});

let store;
let writeQueue = Promise.resolve();
let pool;
const loginAttempts = new Map();

async function loadStore() {
  if (DATABASE_URL) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    await pool.query('create table if not exists app_state (id bigint primary key check (id = 1), data jsonb not null, updated_at timestamptz not null default now())');
    const result = await pool.query('select data from app_state where id = 1');
    if (result.rows[0]?.data) store = { ...initialData(), ...result.rows[0].data };
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
    store = { ...initialData(), ...parsed };
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
const publicState = () => ({
  cuisines: store.cuisines.slice().sort((a,b) => a.order - b.order),
  restaurants: store.restaurants.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  fitnessMeals: (store.fitnessMeals || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  nightSnacks: (store.nightSnacks || []).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
  updatedAt: store.updatedAt
});

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
  if (!sameOrigin(req)) return json(res, 403, { error: '请求来源无效' });
  if (url.pathname === '/api/admin/progress' && req.method === 'GET') { if (!requireAdmin(req,res)) return; return json(res, 200, progress()); }
  if (!requireAdmin(req, res)) return;

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
  return json(res, 404, { error: '没有找到这个功能' });
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
async function serve(req,res,url){
  if(url.pathname.startsWith('/api/')) return api(req,res,url);
  const requested=url.pathname==='/'?'index.html':url.pathname.slice(1); const path=normalize(join(PUBLIC_DIR,requested));
  if(!path.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try { const file=await readFile(path); res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':isProduction?'public, max-age=3600':'no-store'}); res.end(file); }
  catch { try { const file=await readFile(join(PUBLIC_DIR,'index.html')); res.writeHead(200,{'Content-Type':types['.html']});res.end(file); } catch { res.writeHead(404);res.end('Not found'); } }
}

await loadStore();
const server=http.createServer((req,res)=>{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);serve(req,res,url).catch(err=>{console.error(err);if(!res.headersSent)json(res,500,{error:'服务暂时开小差了，请稍后再试'});else res.end();});});
server.listen(PORT,HOST,()=>console.log(`坤坤今天吃什么～ http://${HOST}:${PORT}`));
export { server, initialCuisines };
