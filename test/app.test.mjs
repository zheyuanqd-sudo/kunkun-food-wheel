import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 32147;
let child, temp, cookie;

async function waitForServer() {
  for (let i=0;i<50;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/api/health`); if(r.ok)return; } catch {} await new Promise(r=>setTimeout(r,100)); }
  throw new Error('server did not start');
}

test.before(async()=>{
  temp=await mkdtemp(join(tmpdir(),'kunkun-test-'));
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),DATA_FILE:join(temp,'store.json'),SESSION_SECRET:'test-secret'},stdio:'ignore'});
  await waitForServer();
});
test.after(async()=>{child?.kill();await rm(temp,{recursive:true,force:true});});

test('初始16个菜系顺序正确且权重相同',async()=>{
  const data=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.deepEqual(data.cuisines.map(c=>c.name),['粤菜','北京菜','湘菜','川菜','东北菜','江浙菜','云南菜','日料','烤肉','烧烤','青岛菜','韩料','东南亚','火锅','包子生煎','海鲜']);
  assert.ok(data.cuisines.every(c=>c.enabled&&c.weight===1));
});

test('访客不能修改数据',async()=>{
  const r=await fetch(`http://127.0.0.1:${port}/api/cuisines`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'测试菜'})});
  assert.equal(r.status,401);
});

test('固定管理员可登录并维护餐厅',async()=>{
  const login=await fetch(`http://127.0.0.1:${port}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'kunkunele',password:'kunkunchishenme'})});
  assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  const state=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  const created=await fetch(`http://127.0.0.1:${port}/api/restaurants`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({name:'测试小馆',cuisineId:state.cuisines[0].id,address:'幸福路1号',note:'好吃'})});
  assert.equal(created.status,201);
  const after=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(after.restaurants[0].name,'测试小馆');
});

test('阻止同一菜系下的同名餐厅',async()=>{
  const state=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  const r=await fetch(`http://127.0.0.1:${port}/api/restaurants`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({name:'测试小馆',cuisineId:state.cuisines[0].id})});
  assert.equal(r.status,409);
});

test('管理员可以调整菜系顺序',async()=>{
  const state=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  const ids=state.cuisines.map(c=>c.id);[ids[0],ids[1]]=[ids[1],ids[0]];
  const changed=await fetch(`http://127.0.0.1:${port}/api/cuisines/reorder`,{method:'PUT',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({ids})});
  assert.equal(changed.status,200);
  const after=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(after.cuisines[0].name,'北京菜');
});

test('页面与静态资源可以打开',async()=>{
  const html=await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html,/坤坤今天吃什么～/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/styles.css`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/kunkun-stars-1.jpg`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/kunkun-stars-2.jpg`)).status,200);
});
