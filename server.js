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
const WORLD_W = 3200;
const WORLD_H = 2400;
const PLAYER_SPEED = 240;      // px / sec
const PLAYER_SIZE = 18;
const PLAYER_MAX_HP = 100;
const BULLET_SPEED = 640;
const BULLET_SIZE = 4;
const BULLET_LIFE = 2000;
const FIRE_COOLDOWN = 240;
const BULLET_DAMAGE = 18;
const RESPAWN_MS = 3000;
const INVINCIBLE_MS = 2500;
const CHAT_MAX_LEN = 200;
const CHAT_RATELIMIT_MS = 1500;
const CHAT_HISTORY_MAX = 60;

// ---------- 游戏房间（全局单例） ----------
const room = {
  players: new Map(),   // pid -> Player
  bullets: [],
  chat: [],
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

// ---------- 广播 ----------
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) try { p.ws.send(s); } catch {}
  }
}
function unicast(p, obj) {
  if (p.ws.readyState === 1) try { p.ws.send(JSON.stringify(obj)); } catch {}
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
    hp: PLAYER_MAX_HP, alive: true,
    score: 0, kills: 0,
    color: colorFor(name),
    keys: { W:false, A:false, S:false, D:false, Space:false },
    mouseAngle: -Math.PI / 2,
    lastFireAt: 0,
    lastChatAt: 0,
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
  room.players.delete(pid);
  console.log(`[LEAVE] pid=${pid} name="${p.name}" (online=${room.players.size})`);
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
  if (now - p.lastFireAt < FIRE_COOLDOWN) return;
  if (p.invincibleUntil > now) return;
  p.lastFireAt = now;
  const angle = typeof data?.angle === 'number' ? data.angle : p.mouseAngle;
  const nx = p.x + Math.cos(angle) * (PLAYER_SIZE + 4);
  const ny = p.y + Math.sin(angle) * (PLAYER_SIZE + 4);
  room.bullets.push({
    x: nx, y: ny, angle, owner: p.pid, color: p.color,
    bornAt: now,
  });
}

// ---------- 复活 ----------
function respawn(pid) {
  const p = room.players.get(pid);
  if (!p) return;
  const s = spawnPoint();
  p.x = s.x; p.y = s.y; p.hp = PLAYER_MAX_HP;
  p.alive = true; p.invincibleUntil = Date.now() + INVINCIBLE_MS;
  broadcast({ op: 'respawn', data: { pid: p.pid, x: p.x, y: p.y, hp: p.hp } });
  unicast(p, { op: 'yourespawn', data: { x: p.x, y: p.y } });
}

// ---------- 主 tick（30fps） ----------
function tick(dt) {
  const now = Date.now();

  // 玩家位移
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const k = p.keys;
    let vx = 0, vy = 0;
    if (k.W) vy -= 1;
    if (k.S) vy += 1;
    if (k.A) vx -= 1;
    if (k.D) vx += 1;
    if (vx || vy) {
      const len = Math.hypot(vx, vy);
      p.x = clamp(p.x + (vx / len) * PLAYER_SPEED * dt, 16, WORLD_W - 16);
      p.y = clamp(p.y + (vy / len) * PLAYER_SPEED * dt, 16, WORLD_H - 16);
    }
  }

  // 子弹移动 + 碰撞
  const survivors = [];
  for (const b of room.bullets) {
    b.x += Math.cos(b.angle) * BULLET_SPEED * dt;
    b.y += Math.sin(b.angle) * BULLET_SPEED * dt;

    // 寿命/出界
    if (b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H || now - b.bornAt > BULLET_LIFE) {
      continue;
    }

    // 命中检测
    let hit = false;
    for (const t of room.players.values()) {
      if (!t.alive || t.pid === b.owner) continue;
      if (t.invincibleUntil > now) continue;
      if (Math.hypot(t.x - b.x, t.y - b.y) < PLAYER_SIZE + BULLET_SIZE) {
        t.hp -= BULLET_DAMAGE;
        const killed = t.hp <= 0;
        broadcast({
          op: 'hit',
          data: {
            targetPid: t.pid, byPid: b.owner,
            damage: BULLET_DAMAGE, newHp: Math.max(0, t.hp),
            killed,
          }
        });
        if (killed) {
          const killer = room.players.get(b.owner);
          if (killer) { killer.score += 100; killer.kills += 1; broadcastPlayers(); }
          pushSystem(`${t.name} 被 ${killer ? killer.name : '某人'} 击落了`);
          t.alive = false;
          t.hp = 0;
          setTimeout(() => respawn(t.pid), RESPAWN_MS);
        }
        hit = true;
        break;
      }
    }
    if (!hit) survivors.push(b);
  }
  room.bullets = survivors;

  // 快照广播
  broadcast({
    op: 'snapshot',
    data: {
      tick: now,
      world: { w: WORLD_W, h: WORLD_H },
      players: [...room.players.values()].map(p => ({
        pid: p.pid, name: p.name, color: p.color,
        x: p.x, y: p.y, angle: p.angle,
        hp: Math.max(0, p.hp), alive: p.alive, score: p.score,
        invincible: p.invincibleUntil > now,
      })),
      bullets: room.bullets.map(b => ({ x: b.x, y: b.y, angle: b.angle, color: b.color, owner: b.owner })),
    }
  });
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
