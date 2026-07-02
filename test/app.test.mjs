import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const root = new URL('..', import.meta.url).pathname;
const port = 32147;
let child, temp, cookie;

function connectRoom(roomId,token){return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}/ws?room=${roomId}&token=${token}`);ws.messages=[];ws.on('message',raw=>{try{ws.messages.push(JSON.parse(raw.toString()));}catch{}});ws.once('open',()=>resolve(ws));ws.once('error',reject);});}
function waitRoomMessage(ws,predicate,timeout=7000){const existing=ws.messages.find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off('message',handler);reject(new Error('room message timeout'));},timeout);const handler=raw=>{let data;try{data=JSON.parse(raw.toString());}catch{return;}if(predicate(data)){clearTimeout(timer);ws.off('message',handler);resolve(data);}};ws.on('message',handler);});}

async function waitForServer() {
  for (let i=0;i<50;i++) { try { const r=await fetch(`http://127.0.0.1:${port}/api/health`); if(r.ok)return; } catch {} await new Promise(r=>setTimeout(r,100)); }
  throw new Error('server did not start');
}

test.before(async()=>{
  temp=await mkdtemp(join(tmpdir(),'kunkun-test-'));
  child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_FILE:join(temp,'store.json'),SESSION_SECRET:'test-secret'},stdio:'ignore'});
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

test('管理员可维护减脂餐和夜宵转盘内容',async()=>{
  const image='data:image/jpeg;base64,dGVzdA==';
  const fitness=await fetch(`http://127.0.0.1:${port}/api/fitness-meals`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({name:'鸡胸糙米碗',image,ingredients:'鸡胸肉、糙米、西兰花',calories:'420 千卡'})});
  assert.equal(fitness.status,201);
  const snack=await fetch(`http://127.0.0.1:${port}/api/night-snacks`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({name:'温牛奶',image,calories:'130 千卡'})});
  assert.equal(snack.status,201);
  const data=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(data.fitnessMeals[0].ingredients,'鸡胸肉、糙米、西兰花');
  assert.equal(data.nightSnacks[0].name,'温牛奶');
});

test('默认祝福语可展示且管理员可维护',async()=>{
  const state=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(state.blessings.length,12);
  const created=await fetch(`http://127.0.0.1:${port}/api/blessings`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({text:'测试祝福语～'})});
  assert.equal(created.status,201);const item=await created.json();
  const disabled=await fetch(`http://127.0.0.1:${port}/api/blessings/${item.id}`,{method:'PUT',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({...item,enabled:false})});
  assert.equal(disabled.status,200);
  const publicAfter=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();assert.equal(publicAfter.blessings.some(x=>x.id===item.id),false);
  const removed=await fetch(`http://127.0.0.1:${port}/api/blessings/${item.id}`,{method:'DELETE',headers:{'Cookie':cookie}});assert.equal(removed.status,200);
});

test('三人房间同步在线、排除和两级转盘',async()=>{
  const created=await fetch(`http://127.0.0.1:${port}/api/rooms`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(created.status,201);const room=await created.json();assert.ok(new Date(room.expiresAt)-Date.now()<=86400000);
  const joiner=async nickname=>{const r=await fetch(`http://127.0.0.1:${port}/api/rooms/${room.roomId}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname})});assert.equal(r.status,200);return r.json();};
  const [a,b,c]=await Promise.all(['坤坤','朋友一','朋友二'].map(joiner));
  const fourth=await fetch(`http://127.0.0.1:${port}/api/rooms/${room.roomId}/join`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nickname:'第四人'})});assert.equal(fourth.status,409);
  const [wa,wb,wc]=await Promise.all([a,b,c].map(x=>connectRoom(room.roomId,x.participantToken)));
  const online=await waitRoomMessage(wa,m=>m.type==='state'&&m.room.onlineCount===3);assert.equal(online.room.participants.length,3);
  const cuisineState=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  wa.send(JSON.stringify({type:'exclude',cuisineId:cuisineState.cuisines[0].id,excluded:true}));await waitRoomMessage(wb,m=>m.type==='state'&&m.room.participants.some(p=>p.nickname==='坤坤'&&p.exclusions.length===1));
  wb.send(JSON.stringify({type:'exclude',cuisineId:cuisineState.cuisines[1].id,excluded:true}));await waitRoomMessage(wc,m=>m.type==='state'&&m.room.participants.flatMap(p=>p.exclusions).length===2);
  wa.send(JSON.stringify({type:'spin',kind:'cuisine'}));wb.send(JSON.stringify({type:'spin',kind:'cuisine'}));wc.send(JSON.stringify({type:'spin',kind:'cuisine'}));
  const [sa,sb,sc]=await Promise.all([wa,wb,wc].map(ws=>waitRoomMessage(ws,m=>m.type==='state'&&m.room.spin?.kind==='cuisine')));assert.equal(sa.room.spin.id,sb.room.spin.id);assert.equal(sb.room.spin.id,sc.room.spin.id);assert.equal(sa.room.spin.resultId,sb.room.spin.resultId);
  const selected=sa.room.selectedCuisineId;await fetch(`http://127.0.0.1:${port}/api/restaurants`,{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie},body:JSON.stringify({name:`房间测试餐厅-${selected}`,cuisineId:selected})});
  await new Promise(r=>setTimeout(r,5000));wa.send(JSON.stringify({type:'spin',kind:'restaurant'}));const final=await waitRoomMessage(wb,m=>m.type==='state'&&m.room.spin?.kind==='restaurant');assert.equal(final.room.stage,'done');assert.ok(final.room.finalRestaurantId);assert.ok(final.room.spin.blessing);
  wb.close();await waitRoomMessage(wa,m=>m.type==='state'&&m.room.onlineCount===2);const wb2=await connectRoom(room.roomId,b.participantToken);await waitRoomMessage(wa,m=>m.type==='state'&&m.room.onlineCount===3);
  const restored=await (await fetch(`http://127.0.0.1:${port}/api/rooms/${room.roomId}`)).json();assert.equal(restored.finalRestaurantId,final.room.finalRestaurantId);
  wa.close();wb2.close();wc.close();
});

test('页面与静态资源可以打开',async()=>{
  const html=await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html,/坤坤今天吃什么～/);
  assert.match(html,/菜系餐厅总览/);
  assert.match(html,/坤坤减脂ing/);
  assert.match(html,/半夜饿了/);
  assert.match(html,/坤坤想跟谁吃/);
  assert.match(html,/坤坤邀请你一起吃/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/app.js`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/styles.css`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/kunkun-stars-1.jpg`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/assets/kunkun-stars-2.jpg`)).status,200);
});
