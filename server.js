/**
 * Sky Fight - 多人联网开飞机  服务端
 * 协议: WebSocket (ws://host:8080/ws) + JSON
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 世界参数 ----------
const WORLD_W = 4800;
const WORLD_H = 3600;
const PLAYER_SPEED_BASE = 240;      // 基础移速 px / sec
const PLAYER_SPEED_PER_LEVEL = 40;  // 每级 +40 移速
const PLAYER_SPEED_MAX = 600;       // 上限（物理极限）
const PLAYER_SIZE = 18;
const LEVEL_SCORE = 150;       // 每 150 分升 1 级（升级飞快）
const HP_BASE = 100;           // 初始血量
const HP_PER_LEVEL = 30;
const DMG_BASE = 14;           // 初始子弹伤害（调低）
const DMG_PER_LEVEL = 5;
const SIZE_BASE = 15;          // 初始飞机大小
const SIZE_PER_LEVEL = 30;     // 每级 +30px（极其夸张）
const FIRE_COOLDOWN_BASE = 240;       // 基础射速
const FIRE_COOLDOWN_PER_LEVEL = 20;   // 每级射速提升（冷却-20ms）
const FIRE_COOLDOWN_MIN = 40;         // 最快 40ms（25发/秒）
const BULLET_SPEED = 640;
const BULLET_SIZE_BASE = 4;          // 基础子弹大小
const BULLET_SIZE_PER_LEVEL = 2;     // 每档 +2（随积分平滑）
const BULLET_LIFE_BASE = 2000;       // 基础射程时间 ms
const BULLET_LIFE_PER_LEVEL = 600;   // 每档 +600ms 射程
const MISSILE_SPEED = 300;      // 技能导弹速度
const MISSILE_TURN = 4.5;       // 追踪转向速率 rad/s
const MISSILE_RADIUS = 75;      // 爆炸范围
const MISSILE_DAMAGE = 40;      // 中心伤害
const MISSILE_COUNT_PER_LEVEL = 1;   // 每 150 分多发 1 颗导弹
const MISSILE_SPREAD = 0.35;    // 相邻导弹夹角 rad（约 20°）
const MISSILE_COOLDOWN = 2000;  // 冷却 ms
const MISSILE_LIFE = 4500;
const SHIELD_DURATION_MS = 3000;   // 护盾持续
const SHIELD_COOLDOWN_MS = 8000;   // 护盾冷却
const FLASH_DIST_BASE = 220;          // 基础闪现距离
const FLASH_DIST_PER_LEVEL = 120;     // 每 150 分闪现距离 +120
const FLASH_COOLDOWN_MS = 5000;    // 闪现冷却
const RESPAWN_MS = 3000;
// ---------- 道具 ----------
const PICKUP_COUNT = 10;           // 地图上同时存在的道具数
const PICKUP_RESPAWN_MS = 10000;   // 拾取后重生时间
const PICKUP_RADIUS = 26;          // 拾取半径
const BOOST_SPEED_MS = 4000;       // 加速持续时间
const HEAL_AMOUNT = 40;            // 治疗量
const INVINCIBLE_MS_ITEM = 3000;   // 无敌道具时长
const INVINCIBLE_MS = 2500;
const CHAT_MAX_LEN = 200;
const CHAT_RATELIMIT_MS = 1500;
const CHAT_HISTORY_MAX = 60;
const AFK_TIMEOUT_MS = 30000;   // 掉线角色保留时间，期间同名重连可恢复

// ---------- 游戏房间（全局单例） ----------
const room = {
  players: new Map(),   // pid -> Player
  bullets: [],
  missiles: [],
  chat: [],
  pickups: [],          // {x, y, type, bornAt, id}
  pickupSeq: 1,
  pidSeq: 1,
};

// ---------- 工具 ----------
function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function spawnPoint() {
  return { x: rand(200, WORLD_W - 200), y: rand(200, WORLD_H - 200) };
}
function colorFor(name) {
  // 稳定颜色：根据 name 哈希到 HSL
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 80% 55%)`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function levelOf(score) { return Math.floor(score / LEVEL_SCORE) + 1; }
// 按积分连续成长（每 LEVEL_SCORE 分获得一档，平滑无跳变）
function maxHpOf(score) { return Math.round(HP_BASE + (score / LEVEL_SCORE) * HP_PER_LEVEL); }
function dmgOf(score) { return Math.round(DMG_BASE + (score / LEVEL_SCORE) * DMG_PER_LEVEL); }
function sizeOf(score) { return SIZE_BASE + (score / LEVEL_SCORE) * SIZE_PER_LEVEL; }
function fireCdOf(score) { return Math.max(FIRE_COOLDOWN_MIN, FIRE_COOLDOWN_BASE - (score / LEVEL_SCORE) * FIRE_COOLDOWN_PER_LEVEL); }
function speedOf(score) { return Math.min(PLAYER_SPEED_MAX, PLAYER_SPEED_BASE + (score / LEVEL_SCORE) * PLAYER_SPEED_PER_LEVEL); }
function bulletSizeOf(score) { return BULLET_SIZE_BASE + (score / LEVEL_SCORE) * BULLET_SIZE_PER_LEVEL; }
function bulletLifeOf(score) { return BULLET_LIFE_BASE + (score / LEVEL_SCORE) * BULLET_LIFE_PER_LEVEL; }
function missileCountOf(score) { return 1 + Math.floor(score / LEVEL_SCORE) * MISSILE_COUNT_PER_LEVEL; }
function flashDistOf(score) { return FLASH_DIST_BASE + (score / LEVEL_SCORE) * FLASH_DIST_PER_LEVEL; }

// ---------- 广播 ----------
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) try { p.ws.send(s); } catch {}
  }
}
function unicast(p, obj) {
  if (p.ws && p.ws.readyState === 1) try { p.ws.send(JSON.stringify(obj)); } catch {}
}
function broadcastPlayers() {
  broadcast({
    op: 'players',
    data: { list: [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, score: p.score })) }
  });
}

// ---------- 加入 / 离开 ----------
function handleJoin(ws, data) {
  let name = String(data?.name ?? '').trim();
  if (!name) { unicast({ ws }, { op: 'error', data: '名字不能为空' }); return; }
  if (name.length > 12) name = name.slice(0, 12);
  name = escapeHtml(name);

  // 掉线保留期内同名重连：恢复原角色，不换位置
  const ghost = [...room.players.values()].find(p => p.name === name && (!p.ws || p.ws.readyState !== 1));
  if (ghost) {
    ghost.ws = ws;
    ghost.afkUntil = 0;
    const pid = ghost.pid;
    unicast(ghost, {
      op: 'joined',
      data: {
        pid, name: ghost.name,
        spawn: { x: ghost.x, y: ghost.y },
        world: { w: WORLD_W, h: WORLD_H },
        history: room.chat.slice(-30),
      }
    });
    broadcastPlayers();
    pushSystem(`${name} 重新连接了战场`);
    return;
  }

  // 名字去重
  let base = name, seq = 1;
  while ([...room.players.values()].some(p => p.name === name)) {
    seq += 1;
    name = `${base}${seq}`;
  }

  const pid = room.pidSeq++;
  const spawn = spawnPoint();
  const p = {
    pid, ws, name,
    x: spawn.x, y: spawn.y, angle: -Math.PI / 2,
    hp: maxHpOf(0), alive: true,
    score: 0, kills: 0, level: 1,
    color: colorFor(name),
    keys: { W:false, A:false, S:false, D:false, Space:false },
    mouseAngle: -Math.PI / 2,
    lastFireAt: 0,
    lastMissileAt: 0,
    lastShieldAt: 0,
    shieldUntil: 0,
    lastFlashAt: 0,
    boostUntil: 0,
    lastChatAt: 0,
    afkUntil: 0,
    invincibleUntil: Date.now() + INVINCIBLE_MS,
  };
  room.players.set(pid, p);
  console.log(`[JOIN] pid=${pid} name="${p.name}" (online=${room.players.size})`);

  // 告诉这个玩家：你加入成功，附带上聊天历史
  unicast(p, {
    op: 'joined',
    data: {
      pid, name: p.name,
      spawn: { x: p.x, y: p.y },
      world: { w: WORLD_W, h: WORLD_H },
      history: room.chat.slice(-30),
    }
  });
  // 通知所有人：玩家列表更新
  broadcastPlayers();
  // 系统公告
  pushSystem(`${p.name} 加入了战场`);
}

function handleLeave(pid) {
  const p = room.players.get(pid);
  if (!p) return;
  // 保留角色 30 秒等待重连，不立刻移除
  p.ws = null;
  p.afkUntil = Date.now() + AFK_TIMEOUT_MS;
  p.keys = { W:false, A:false, S:false, D:false, Space:false };
  console.log(`[LEAVE] pid=${pid} name="${p.name}" (waiting reconnect, online=${room.players.size})`);
  broadcastPlayers();
}

function removePlayer(pid, reason) {
  const p = room.players.get(pid);
  if (!p) return;
  room.players.delete(pid);
  console.log(`[REMOVE] pid=${pid} name="${p.name}" (${reason}, online=${room.players.size})`);
  pushSystem(`${p.name} 离开了战场`);
  broadcastPlayers();
}

// ---------- 聊天 ----------
function pushSystem(text) {
  const msg = { fromPid: 0, fromName: '系统', text, time: Date.now(), system: true };
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY_MAX) room.chat.shift();
  broadcast({ op: 'chat', data: msg });
}
function sendChat(p, data) {
  const now = Date.now();
  if (now - p.lastChatAt < CHAT_RATELIMIT_MS) return;
  let text = String(data?.text ?? '').trim();
  if (!text) return;
  if (text.length > CHAT_MAX_LEN) text = text.slice(0, CHAT_MAX_LEN);
  text = escapeHtml(text);
  p.lastChatAt = now;
  const msg = { fromPid: p.pid, fromName: p.name, color: p.color, text, time: now };
  room.chat.push(msg);
  if (room.chat.length > CHAT_HISTORY_MAX) room.chat.shift();
  broadcast({ op: 'chat', data: msg });
}

// ---------- 开火 ----------
function tryFire(p, data) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastFireAt < fireCdOf(p.score)) return;
  if (p.invincibleUntil > now) return;
  p.lastFireAt = now;
  const angle = typeof data?.angle === 'number' ? data.angle : p.mouseAngle;
  const s = sizeOf(p.score);
  const nx = p.x + Math.cos(angle) * (s + 4);
  const ny = p.y + Math.sin(angle) * (s + 4);
  room.bullets.push({
    x: nx, y: ny, angle, owner: p.pid, color: p.color,
    size: bulletSizeOf(p.score),
    life: bulletLifeOf(p.score),
    bornAt: now,
  });
}

// ---------- 技能导弹 ----------
function tryMissile(p) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastMissileAt < MISSILE_COOLDOWN) return;
  if (p.invincibleUntil > now) return;
  p.lastMissileAt = now;
  const count = missileCountOf(p.score);
  const base = p.angle - (count - 1) * MISSILE_SPREAD / 2;
  for (let i = 0; i < count; i++) {
    const a = base + i * MISSILE_SPREAD;
    room.missiles.push({
      x: p.x, y: p.y, angle: a, owner: p.pid, color: p.color,
      targetPid: 0,       // 锁定目标，0=未锁定（追踪最近的敌人）
      bornAt: now,
    });
    broadcast({ op: 'missile', data: { x: p.x, y: p.y, angle: a, owner: p.pid, color: p.color } });
  }
  unicast(p, { op: 'missile_cooldown', data: { cooldown: MISSILE_COOLDOWN } });
}

// ---------- 击杀 ----------
function killPlayer(target, killerPid) {
  const killer = room.players.get(killerPid);
  if (killer && killer !== target) { killer.score += 100; killer.kills += 1; broadcastPlayers(); }
  pushSystem(`${target.name} 被 ${killer && killer !== target ? killer.name : '某人'} 击落了`);
  target.alive = false;
  target.hp = 0;
  setTimeout(() => respawn(target.pid), RESPAWN_MS);
}

// ---------- 导弹爆炸（范围伤害） ----------
function missileBoom(m, now) {
  const hitList = [];
  for (const t of room.players.values()) {
    if (!t.alive || t.pid === m.owner) continue;
    if (t.invincibleUntil > now) continue;
    if (t.shieldUntil > now) continue; // 护盾抵挡导弹
    const d = Math.hypot(t.x - m.x, t.y - m.y);
    if (d < MISSILE_RADIUS) hitList.push({ t, d });
  }
  for (const { t, d } of hitList) {
    const dmg = Math.round(MISSILE_DAMAGE * (1 - d / MISSILE_RADIUS) * 0.7 + MISSILE_DAMAGE * 0.3);
    t.hp -= dmg;
    const killed = t.hp <= 0;
    broadcast({
      op: 'hit',
      data: {
        targetPid: t.pid, byPid: m.owner,
        damage: dmg, newHp: Math.max(0, t.hp),
        killed, missile: true,
      }
    });
    if (killed) killPlayer(t, m.owner);
  }
  broadcast({ op: 'boom', data: { x: m.x, y: m.y, color: m.color } });
}

// ---------- 护盾 ----------
function tryShield(p) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastShieldAt < SHIELD_COOLDOWN_MS) return;
  p.lastShieldAt = now;
  p.shieldUntil = now + SHIELD_DURATION_MS;
  unicast(p, { op: 'shield_cooldown', data: { cooldown: SHIELD_COOLDOWN_MS } });
  broadcast({ op: 'shield', data: { pid: p.pid, color: p.color, until: p.shieldUntil } });
}

// ---------- 闪现 ----------
function tryFlash(p) {
  if (!p.alive) return;
  const now = Date.now();
  if (now - p.lastFlashAt < FLASH_COOLDOWN_MS) return;
  p.lastFlashAt = now;
  const dist = flashDistOf(p.score);
  const nx = clamp(p.x + Math.cos(p.angle) * dist, 16, WORLD_W - 16);
  const ny = clamp(p.y + Math.sin(p.angle) * dist, 16, WORLD_H - 16);
  const from = { x: p.x, y: p.y };
  p.x = nx; p.y = ny;
  broadcast({
    op: 'flash',
    data: { pid: p.pid, fromX: from.x, fromY: from.y, toX: nx, toY: ny, color: p.color }
  });
  unicast(p, { op: 'flash_cooldown', data: { cooldown: FLASH_COOLDOWN_MS } });
}

// ---------- 道具系统 ----------
function spawnPickup(type) {
  const p = {
    id: room.pickupSeq++,
    x: rand(80, WORLD_W - 80), y: rand(80, WORLD_H - 80),
    type: type || ['boost', 'heal', 'invincible'][randInt(0, 2)],
    bornAt: Date.now(),
  };
  room.pickups.push(p);
  return p;
}
// 初始化道具
for (let i = 0; i < PICKUP_COUNT; i++) spawnPickup();

function handlePickup(p, item) {
  const now = Date.now();
  if (item.type === 'boost') {
    p.boostUntil = now + BOOST_SPEED_MS;
    unicast(p, { op: 'pickup', data: { type: 'boost', text: '加速燃料！移速大幅提升' } });
  } else if (item.type === 'heal') {
    p.hp = Math.min(maxHpOf(p.score), p.hp + HEAL_AMOUNT);
    unicast(p, { op: 'pickup', data: { type: 'heal', text: '修理包！+40 血量' } });
  } else if (item.type === 'invincible') {
    p.invincibleUntil = now + INVINCIBLE_MS_ITEM;
    unicast(p, { op: 'pickup', data: { type: 'invincible', text: '无敌护罩！3 秒免疫伤害' } });
  }
  broadcast({ op: 'pickup_effect', data: { x: item.x, y: item.y, type: item.type, color: p.color } });
}

// ---------- 复活 ----------
function respawn(pid) {
  const p = room.players.get(pid);
  if (!p) return;
  const s = spawnPoint();
  p.x = s.x; p.y = s.y; p.hp = maxHpOf(p.score);
  p.alive = true; p.invincibleUntil = Date.now() + INVINCIBLE_MS;
  broadcast({ op: 'respawn', data: { pid: p.pid, x: p.x, y: p.y, hp: p.hp } });
  unicast(p, { op: 'yourespawn', data: { x: p.x, y: p.y } });
}

// ---------- 主 tick（30fps） ----------
function tick(dt) {
  const now = Date.now();

  // 掉线超时清理
  for (const p of [...room.players.values()]) {
    if (p.afkUntil > 0 && now > p.afkUntil) removePlayer(p.pid, 'afk-timeout');
  }

  // 道具补充（低于数量上限时随机重生）
  while (room.pickups.length < PICKUP_COUNT) spawnPickup();

  // 玩家位移
  for (const p of room.players.values()) {
    if (!p.alive || !p.ws || p.ws.readyState !== 1) continue;
    const k = p.keys;
    let vx = 0, vy = 0;
    if (k.W) vy -= 1;
    if (k.S) vy += 1;
    if (k.A) vx -= 1;
    if (k.D) vx += 1;
    if (vx || vy) {
      const len = Math.hypot(vx, vy);
      const boosted = p.boostUntil > now;
      const spd = speedOf(p.score) * (boosted ? 2.2 : 1);
      p.x = clamp(p.x + (vx / len) * spd * dt, 16, WORLD_W - 16);
      p.y = clamp(p.y + (vy / len) * spd * dt, 16, WORLD_H - 16);
    }
  }

  // 道具拾取检测
  for (const p of room.players.values()) {
    if (!p.alive || !p.ws || p.ws.readyState !== 1) continue;
    for (let i = room.pickups.length - 1; i >= 0; i--) {
      const item = room.pickups[i];
      if (Math.hypot(p.x - item.x, p.y - item.y) < sizeOf(p.score) + PICKUP_RADIUS) {
        room.pickups.splice(i, 1);
        handlePickup(p, item);
        setTimeout(() => spawnPickup(item.type), PICKUP_RESPAWN_MS);
      }
    }
  }

  // 子弹移动 + 碰撞
  const survivors = [];
  for (const b of room.bullets) {
    b.x += Math.cos(b.angle) * BULLET_SPEED * dt;
    b.y += Math.sin(b.angle) * BULLET_SPEED * dt;

    // 寿命/出界
    if (b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H || now - b.bornAt > b.life) {
      continue;
    }

    // 命中检测（掉线保留期的角色不可被攻击）
    let hit = false;
    const shooter = room.players.get(b.owner);
    const dmg = shooter ? dmgOf(shooter.score) : DMG_BASE;
    for (const t of room.players.values()) {
      if (!t.alive || t.pid === b.owner) continue;
      if (t.invincibleUntil > now) continue;
      if (t.shieldUntil > now) continue; // 护盾抵挡子弹
      if (Math.hypot(t.x - b.x, t.y - b.y) < sizeOf(t.score) + (b.size ?? BULLET_SIZE_BASE)) {
        t.hp -= dmg;
        const killed = t.hp <= 0;
        broadcast({
          op: 'hit',
          data: {
            targetPid: t.pid, byPid: b.owner,
            damage: dmg, newHp: Math.max(0, t.hp),
            killed,
          }
        });
        if (killed) {
          killPlayer(t, b.owner);
        }
        hit = true;
        break;
      }
    }
    if (!hit) survivors.push(b);
  }
  room.bullets = survivors;

  // 导弹更新（追踪 + 范围爆炸）
  const missileSurvivors = [];
  for (const m of room.missiles) {
    if (now - m.bornAt > MISSILE_LIFE) continue;

    // 目标锁定：追踪最近的存活敌人（含掉线保留角色）
    if (!m.targetPid || !room.players.get(m.targetPid)?.alive) {
      let best = null, bestD = Infinity;
      for (const t of room.players.values()) {
        if (!t.alive || t.pid === m.owner) continue;
        if (t.invincibleUntil > now) continue;
        const d = Math.hypot(t.x - m.x, t.y - m.y);
        if (d < bestD) { bestD = d; best = t; }
      }
      m.targetPid = best ? best.pid : 0;
    }
    const target = m.targetPid ? room.players.get(m.targetPid) : null;
    if (target && target.alive) {
      // 转向目标
      const want = Math.atan2(target.y - m.y, target.x - m.x);
      let diff = want - m.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      m.angle += clamp(diff, -MISSILE_TURN * dt, MISSILE_TURN * dt);
    }
    m.x += Math.cos(m.angle) * MISSILE_SPEED * dt;
    m.y += Math.sin(m.angle) * MISSILE_SPEED * dt;

    // 直接命中
    if (target && target.alive && Math.hypot(target.x - m.x, target.y - m.y) < sizeOf(target.score) + 8) {
      missileBoom(m, now);
      continue;
    }
    // 出界
    if (m.x < 0 || m.x > WORLD_W || m.y < 0 || m.y > WORLD_H) continue;
    missileSurvivors.push(m);
  }
  room.missiles = missileSurvivors;

  // 快照广播（视野裁剪：只给每个玩家发其周围的数据，降低序列化开销）
  const VIEW_R = 1500; // 视野半径
  const playerSnaps = [...room.players.values()].map(p => ({
    pid: p.pid, name: p.name, color: p.color,
    x: p.x, y: p.y, angle: p.angle,
    hp: Math.max(0, p.hp), alive: p.alive, score: p.score,
    invincible: p.invincibleUntil > now,
    shielded: p.shieldUntil > now,
    boosted: p.boostUntil > now,
    level: levelOf(p.score), size: sizeOf(p.score),
  }));
  const allBullets = room.bullets.map(b => ({ x: b.x, y: b.y, angle: b.angle, color: b.color, owner: b.owner, size: b.size ?? BULLET_SIZE_BASE }));
  const allMissiles = room.missiles.map(m => ({ x: m.x, y: m.y, angle: m.angle, color: m.color, owner: m.owner }));
  const allPickups = room.pickups.map(q => ({ x: q.x, y: q.y, type: q.type }));
  for (const p of room.players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const inView = (x, y) => Math.abs(x - p.x) < VIEW_R && Math.abs(y - p.y) < VIEW_R;
    unicast(p, {
      op: 'snapshot',
      data: {
        tick: now,
        world: { w: WORLD_W, h: WORLD_H },
        players: playerSnaps,
        bullets: allBullets.filter(b => inView(b.x, b.y)),
        missiles: allMissiles.filter(m => inView(m.x, m.y)),
        pickups: allPickups.filter(q => inView(q.x, q.y)),
      }
    });
  }
}

// ---------- HTTP 静态服务器（public/） ----------
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
});

// ---------- WebSocket 绑定 ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString('utf-8'));
      const op = msg.op;
      const data = msg.data ?? {};
      const p = [...room.players.values()].find(x => x.ws === ws);

      switch (op) {
        case 'join':
          if (p) return; // 已加入
          handleJoin(ws, data);
          break;
        case 'input':
          if (!p) return;
          if (data?.keys) {
            p.keys.W = !!data.keys.W;
            p.keys.A = !!data.keys.A;
            p.keys.S = !!data.keys.S;
            p.keys.D = !!data.keys.D;
            p.keys.Space = !!data.keys.Space;
          }
          if (typeof data?.angle === 'number') {
            p.angle = data.angle;
            p.mouseAngle = data.angle;
          }
          if (data?.Space || data?.fire) tryFire(p, { angle: p.mouseAngle });
          break;
        case 'fire':
          if (p) tryFire(p, data);
          break;
        case 'missile':
          if (p) tryMissile(p);
          break;
        case 'shield':
          if (p) tryShield(p);
          break;
        case 'flash':
          if (p) tryFlash(p);
          break;
        case 'ping':
          // 回 pong 用于客户端 RTT 测量（未 join 也能测）
          if (ws.readyState === 1) try { ws.send(JSON.stringify({ op: 'pong', data: { t: data?.t } })); } catch {}
          break;
        case 'chat':
          if (p) sendChat(p, data);
          break;
      }
    } catch (e) { /* 忽略恶意/错误消息 */ }
  });

  ws.on('close', () => {
    const p = [...room.players.values()].find(x => x.ws === ws);
    if (p) handleLeave(p.pid);
  });
});

// ---------- 启动 ----------
server.listen(PORT, () => {
  console.log(`============================================`);
  console.log(` Sky Fight server ready!`);
  console.log(` HTTP  : http://localhost:${PORT}`);
  console.log(` WS    : ws://localhost:${PORT}/ws`);
  console.log(` World : ${WORLD_W} x ${WORLD_H}`);
  console.log(`============================================`);
});

// 30fps tick 循环
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  tick(Math.min(dt, 0.05));
}, 1000 / 30);
