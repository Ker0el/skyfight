/**
 * Sky Fight - 客户端
 * Canvas 渲染 + WebSocket 同步 + 聊天 UI
 */

(() => {
'use strict';

// =========================================================
//  DOM 引用
// =========================================================
const $ = id => document.getElementById(id);
const screenName = $('screen-name');
const screenGame = $('screen-game');
const nameInput = $('nameInput');
const joinBtn  = $('joinBtn');
const nameStatus = $('nameStatus');

const canvas = $('game');
const ctx = canvas.getContext('2d');
const miniCanvas = $('minimap');
const miniCtx = miniCanvas.getContext('2d');

const meName = $('meName');
const meDot  = $('meDot');
const hpFill = $('hpFill');
const hpText = $('hpText');
const killV = $('killV'), scoreV = $('scoreV'), onlineV = $('onlineV'), pingV = $('pingV');

const chatWrap = $('chatWrap');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const chatTag = $('chatTag');
const crosshair = $('crosshair');
const toastWrap = $('toastWrap');
const deathMask = $('deathMask');
const killerName = $('killerName');
const respawnCount = $('respawnCount');

const showScreen = (el) => {
    [screenName, screenGame].forEach(s => s.classList.toggle('active', s === el));
};

// =========================================================
//  Canvas 尺寸
// =========================================================
function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
addEventListener('resize', resize);

// =========================================================
//  全局状态
// =========================================================
const WORLD = { w: 3200, h: 2400 };
const PLAYER_SIZE = 18;
const state = {
    phase: 'name',       // name | play | dead
    me: { pid: 0, name: '', color: '#fff',
          x: 0, y: 0, angle: 0, hp: 100, alive: true, score: 0, kills: 0, invincible: false },
    keys: { W:false, A:false, S:false, D:false, Space:false },
    mouse: { x: 0, y: 0, angle: 0, down: false },
    players: new Map(),   // pid -> {name,x,y,angle,hp,color,alive,score,invincible}
    bullets: [],          // {x,y,angle,color,owner}
    chatMode: false,
    camera: { x: 0, y: 0 },
    effects: [],          // explosion particles
    stars: [],            // 视差星空
    ping: 0,
    pings: [],
};

// 初始化视差星空
for (let i = 0; i < 180; i++) {
    state.stars.push({
        x: Math.random(), y: Math.random(),
        size: Math.random() * 1.8 + 0.3,
        layer: Math.random() < 0.4 ? 1 : Math.random() < 0.7 ? 2 : 3,
    });
}

// =========================================================
//  WebSocket
// =========================================================
let ws = null;
let reconnectTimer = null;

function send(op, data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ op, data: data ?? {} }));
    }
}
function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
        setStatus('连接成功，正在加入...', true);
        send('join', { name: nameInput.value.trim() });
    };
    ws.onmessage = (ev) => {
        try { handleMessage(JSON.parse(ev.data)); } catch {}
    };
    ws.onclose = () => {
        setStatus('连接断开，3 秒后重试...');
        reconnectTimer = setTimeout(connectWs, 3000);
    };
    ws.onerror = () => {};
}

function setStatus(msg, ok = false) {
    nameStatus.textContent = msg;
    nameStatus.classList.toggle('ok', !!ok);
}

// =========================================================
//  协议处理
// =========================================================
function handleMessage({ op, data }) {
    switch (op) {
        case 'joined':
            onJoined(data); break;
        case 'snapshot':
            onSnapshot(data); break;
        case 'players':
            onlineV.textContent = data.list.length; break;
        case 'hit':
            onHit(data); break;
        case 'respawn':
        case 'yourespawn':
            onRespawn(data); break;
        case 'chat':
            onChat(data); break;
        case 'error':
            setStatus('错误: ' + (data || '未知')); break;
    }
}

function onJoined(d) {
    state.phase = 'play';
    state.me.pid = d.pid;
    state.me.name = d.name;
    state.me.x = d.spawn.x; state.me.y = d.spawn.y;
    state.camera.x = d.spawn.x; state.camera.y = d.spawn.y;
    WORLD.w = d.world.w; WORLD.h = d.world.h;
    meName.textContent = d.name;
    // 回填历史聊天
    for (const m of (d.history || [])) appendChat(m, false);
    chatLog.scrollTop = chatLog.scrollHeight;
    showScreen(screenGame);
    crosshair.style.display = 'block';
}

function onSnapshot(d) {
    // ping 估算
    state.pings.push(performance.now());
    if (state.pings.length > 5) state.pings.shift();
    // 这里用 1000/30 近似，简单用"已接收消息平均间隔"做个宽松值
    if (state.pings.length >= 2) {
        const avg = state.pings[state.pings.length - 1] - state.pings[0];
        state.ping = Math.round((avg / state.pings.length) * 2) + 4;
    }
    pingV.textContent = state.ping;

    // 玩家
    const pids = new Set();
    for (const p of d.players) {
        pids.add(p.pid);
        if (p.pid === state.me.pid) {
            // 我自己：以权威值对齐，但平滑（服务端算，客户端直接用）
            state.me.x = p.x; state.me.y = p.y; state.me.angle = p.angle;
            state.me.hp = p.hp; state.me.alive = p.alive; state.me.invincible = p.invincible;
            state.me.color = p.color;
            state.me.score = p.score; state.me.kills = d.players.find(q => q.pid === state.me.pid)?.kills ?? state.me.kills;
            // HUD
            meDot.style.background = p.color;
            meDot.style.boxShadow = `0 0 8px ${p.color}`;
            const hpPct = (p.hp / 100) * 100;
            hpFill.style.width = hpPct + '%';
            hpFill.classList.toggle('low', hpPct <= 35);
            hpText.textContent = `${p.hp} / 100`;
            scoreV.textContent = p.score;
            // 击杀数从玩家列表同步
            for (const q of d.players) if (q.pid === state.me.pid) killV.textContent = q.kills || 0;

            // 死亡判断
            if (state.phase === 'play' && !p.alive) {
                state.phase = 'dead';
                deathMask.hidden = false;
                respawnCount.textContent = '3';
            } else if (state.phase === 'dead' && p.alive) {
                state.phase = 'play';
                deathMask.hidden = true;
            }
        } else {
            let cur = state.players.get(p.pid);
            if (!cur) {
                cur = { ...p };
                cur.interp = { x: p.x, y: p.y, angle: p.angle };
            } else {
                // 保留上一帧插值起点
                cur.interp = { x: cur.x, y: cur.y, angle: cur.angle };
                Object.assign(cur, p);
            }
            state.players.set(p.pid, cur);
        }
    }
    // 清理掉已离开的
    for (const key of [...state.players.keys()]) if (!pids.has(key)) state.players.delete(key);

    state.bullets = d.bullets;
}

function onHit(d) {
    if (d.killed) {
        const killerP = state.players.get(d.byPid);
        const targetP = d.targetPid === state.me.pid ? state.me : state.players.get(d.targetPid);
        const killerNameTxt = killerP ? killerP.name : '某人';
        const targetNameTxt = targetP ? targetP.name : '某人';
        if (d.targetPid === state.me.pid) {
            // 我被打死了
            killerName.textContent = killerNameTxt;
            let remain = 3;
            respawnCount.textContent = remain;
            const iv = setInterval(() => {
                remain -= 1;
                respawnCount.textContent = Math.max(0, remain);
                if (remain <= 0) clearInterval(iv);
            }, 1000);
            toast(`你被 ${killerNameTxt} 击落了！`, 'die');
        } else if (d.byPid === state.me.pid) {
            toast(`你击落了 ${targetNameTxt}！ +100 分`, 'kill');
        }
    }
    // 命中火花（在撞击点画 1 次效果）
    const tp = d.targetPid === state.me.pid ? state.me : state.players.get(d.targetPid);
    if (tp) state.effects.push({ kind: 'spark', x: tp.x, y: tp.y, t: 0, life: 180, size: d.killed ? 32 : 14 });
}

function onRespawn(d) {
    if (d.pid === state.me.pid) {
        state.phase = 'play';
        deathMask.hidden = true;
    }
    const p = state.players.get(d.pid);
    if (p) { p.x = d.x; p.y = d.y; p.hp = 100; p.alive = true; }
    if (d.pid === state.me.pid) {
        state.me.x = d.x; state.me.y = d.y;
        state.camera.x = d.x; state.camera.y = d.y;
    }
}

function onChat(d) { appendChat(d, true); }

function appendChat(m, animate) {
    const div = document.createElement('div');
    div.className = 'chat-line' + (m.system ? ' system' : '') + (animate ? ' new' : '');
    const nameColor = m.color || (m.system ? '#f5c067' : '#8fa1c9');
    div.innerHTML = `<span class="u" style="color:${nameColor}">${escapeHtml(m.fromName)}:</span><span class="t">${escapeHtml(m.text)}</span>`;
    chatLog.appendChild(div);
    // 限制行数
    while (chatLog.childElementCount > 120) chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop = chatLog.scrollHeight;
}

// =========================================================
//  输入
// =========================================================
addEventListener('keydown', (e) => {
    if (state.phase === 'name') {
        if (e.key === 'Enter') tryJoin();
        return;
    }
    // Enter 切换聊天
    if (e.key === 'Enter') {
        e.preventDefault();
        if (state.chatMode) sendChat(); else enterChatMode();
        return;
    }
    if (e.key === 'Escape') { if (state.chatMode) exitChatMode(); return; }

    if (state.chatMode) return; // 聊天输入模式下，不处理战斗键

    if (e.repeat) return;
    switch (e.code) {
        case 'KeyW': case 'ArrowUp':    state.keys.W = true; break;
        case 'KeyS': case 'ArrowDown':  state.keys.S = true; break;
        case 'KeyA': case 'ArrowLeft':  state.keys.A = true; break;
        case 'KeyD': case 'ArrowRight': state.keys.D = true; break;
        case 'Space':
            state.keys.Space = true;
            send('input', { keys: state.keys, angle: state.mouse.angle, Space: true });
            break;
    }
});
addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': case 'ArrowUp':    state.keys.W = false; break;
        case 'KeyS': case 'ArrowDown':  state.keys.S = false; break;
        case 'KeyA': case 'ArrowLeft':  state.keys.A = false; break;
        case 'KeyD': case 'ArrowRight': state.keys.D = false; break;
        case 'Space':                   state.keys.Space = false; break;
    }
});

addEventListener('mousemove', (e) => {
    state.mouse.x = e.clientX; state.mouse.y = e.clientY;
    crosshair.style.left = e.clientX + 'px';
    crosshair.style.top = e.clientY + 'px';

    // 鼠标角度（世界系：摄像机中心 + 鼠标相对屏幕中心的偏移）
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    state.mouse.angle = Math.atan2(dy, dx);
});

addEventListener('mousedown', (e) => {
    if (state.phase !== 'play' || state.chatMode) return;
    if (e.button === 0) { state.mouse.down = true; send('fire', { angle: state.mouse.angle }); }
});
addEventListener('mouseup', (e) => { if (e.button === 0) state.mouse.down = false; });

// 30fps 输入上报（包含持续开火）
setInterval(() => {
    if (state.phase === 'play' && !state.chatMode) {
        send('input', {
            keys: state.keys, angle: state.mouse.angle,
            fire: state.mouse.down || state.keys.Space ? 1 : 0,
        });
    }
}, 1000 / 30);

// =========================================================
//  聊天
// =========================================================
function enterChatMode() {
    state.chatMode = true;
    chatInput.disabled = false;
    chatInput.value = '';
    chatInput.focus();
    chatTag.textContent = '发送中…';
    chatWrap.querySelector('.chat-input-line').classList.add('active');
}
function exitChatMode() {
    state.chatMode = false;
    chatInput.disabled = true;
    chatInput.blur();
    chatTag.textContent = 'Enter 说话';
    chatWrap.querySelector('.chat-input-line').classList.remove('active');
}
function sendChat() {
    const text = chatInput.value.trim();
    if (text) send('chat', { text });
    exitChatMode();
}

// =========================================================
//  Toast（通知）
// =========================================================
function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    toastWrap.appendChild(el);
    setTimeout(() => { el.remove(); }, 3600);
}

// =========================================================
//  工具
// =========================================================
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// =========================================================
//  加入
// =========================================================
async function tryJoin() {
    const name = nameInput.value.trim();
    if (name.length < 2 || name.length > 12) {
        setStatus('名字长度必须 2-12 字');
        nameInput.focus();
        return;
    }
    joinBtn.disabled = true;
    setStatus('正在连接...', true);
    connectWs();
}
joinBtn.addEventListener('click', tryJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryJoin(); } });

// =========================================================
//  渲染
// =========================================================
const lastFrame = { t: performance.now() };
function draw(now) {
    const dt = Math.min(0.05, (now - lastFrame.t) / 1000);
    lastFrame.t = now;

    ctx.clearRect(0, 0, innerWidth, innerHeight);

    if (state.phase === 'name') { requestAnimationFrame(draw); return; }

    // 摄像机平滑跟随
    const lerp = Math.min(1, dt * 6);
    state.camera.x += (state.me.x - state.camera.x) * lerp;
    state.camera.y += (state.me.y - state.camera.y) * lerp;

    const camX = state.camera.x - innerWidth / 2;
    const camY = state.camera.y - innerHeight / 2;

    // 背景
    drawBackground(camX, camY);
    // 世界边界
    drawWorldBorder(camX, camY);
    // 子弹
    for (const b of state.bullets) drawBullet(b, camX, camY);
    // 其他玩家
    for (const p of state.players.values()) drawPlayer(p, camX, camY);
    // 我
    drawPlayer({
        ...state.me,
        name: state.me.name, pid: state.me.pid,
        color: state.me.color, invincible: state.me.invincible,
    }, camX, camY, true);
    // 爆炸/火花
    tickEffects(dt);
    drawEffects(camX, camY);
    // 小地图
    drawMinimap();

    requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function drawBackground(camX, camY) {
    // 深空渐变
    const g = ctx.createRadialGradient(innerWidth / 2, innerHeight / 2, 50, innerWidth / 2, innerHeight / 2, Math.max(innerWidth, innerHeight));
    g.addColorStop(0, '#0a1530');
    g.addColorStop(1, '#020308');
    ctx.fillStyle = g; ctx.fillRect(0, 0, innerWidth, innerHeight);

    // 多层视差星
    for (const s of state.stars) {
        const factor = 0.05 * (4 - s.layer);
        const sx = ((s.x - camX * factor) % 1 + 1) % 1 * innerWidth;
        const sy = ((s.y - camY * factor) % 1 + 1) % 1 * innerHeight;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + s.layer * 0.18})`;
        ctx.fillRect(sx, sy, s.size, s.size);
    }
}

function drawWorldBorder(camX, camY) {
    const x = -camX, y = -camY;
    ctx.save();
    ctx.strokeStyle = 'rgba(100, 150, 255, 0.35)';
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, WORLD.w, WORLD.h);
    ctx.setLineDash([]);
    // 四角标记
    ctx.fillStyle = 'rgba(130, 170, 255, 0.6)';
    ctx.font = '12px monospace';
    ctx.fillText('(0, 0)', x + 6, y + 14);
    ctx.fillText(`(${WORLD.w}, ${WORLD.h})`, x + WORLD.w - 80, y + WORLD.h - 6);
    ctx.restore();
}

function drawPlayer(p, camX, camY, isMe = false) {
    const x = p.x - camX, y = p.y - camY;
    // 屏幕外就不画机体了，只画方向提示
    if (x < -80 || y < -80 || x > innerWidth + 80 || y > innerHeight + 80) {
        drawOffscreenIndicator(p, camX, camY, isMe);
        return;
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.angle);

    // 无敌闪烁
    const flicker = p.invincible && Math.floor(performance.now() / 90) % 2 === 0;
    ctx.globalAlpha = flicker ? 0.45 : 1;

    // 尾焰
    const flame = 10 + Math.sin(performance.now() / 60) * 3;
    const flameG = ctx.createLinearGradient(-PLAYER_SIZE - flame, 0, -PLAYER_SIZE, 0);
    flameG.addColorStop(0, 'rgba(255, 180, 60, 0)');
    flameG.addColorStop(1, 'rgba(255, 110, 40, 0.85)');
    ctx.fillStyle = flameG;
    ctx.beginPath();
    ctx.moveTo(-PLAYER_SIZE - flame, 0);
    ctx.lineTo(-PLAYER_SIZE, -5);
    ctx.lineTo(-PLAYER_SIZE, 5);
    ctx.closePath();
    ctx.fill();

    // 飞机身（三角形+翼）
    ctx.fillStyle = p.color || '#5a88ff';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PLAYER_SIZE, 0);
    ctx.lineTo(-PLAYER_SIZE * 0.8, -PLAYER_SIZE * 0.9);
    ctx.lineTo(-PLAYER_SIZE * 0.35, 0);
    ctx.lineTo(-PLAYER_SIZE * 0.8, PLAYER_SIZE * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 座舱
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(PLAYER_SIZE * 0.2, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // 自己的外描边
    if (isMe) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_SIZE + 6, 0, Math.PI * 2);
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    // 名字 + 血条
    drawPlayerTag(p, x, y, isMe);
}

function drawPlayerTag(p, x, y, isMe) {
    const hp = Math.max(0, p.hp);
    // 血条
    const w = 44, h = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - w / 2, y - PLAYER_SIZE - 16, w, h);
    const hpRatio = hp / 100;
    ctx.fillStyle = hpRatio > 0.35 ? '#4be27e' : '#ff6861';
    ctx.fillRect(x - w / 2, y - PLAYER_SIZE - 16, w * hpRatio, h);
    // 名字
    ctx.font = isMe ? 'bold 12px "Microsoft YaHei", sans-serif' : '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(p.name, x + 1, y - PLAYER_SIZE - 19);
    ctx.fillStyle = p.color || '#fff';
    ctx.fillText(p.name, x, y - PLAYER_SIZE - 20);
}

function drawOffscreenIndicator(p, camX, camY) {
    // 屏幕边缘画一个箭头，指向该玩家
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const dx = p.x - state.camera.x, dy = p.y - state.camera.y;
    const ang = Math.atan2(dy, dx);
    const pad = 40;
    const t = Math.min(
        (cx - pad) / Math.max(0.001, Math.abs(Math.cos(ang))),
        (cy - pad) / Math.max(0.001, Math.abs(Math.sin(ang)))
    );
    const ex = cx + Math.cos(ang) * t;
    const ey = cy + Math.sin(ang) * t;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.fillStyle = p.color || '#fff';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, -5);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawBullet(b, camX, camY) {
    const x = b.x - camX, y = b.y - camY;
    if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    // 拖尾
    const grad = ctx.createLinearGradient(-16, 0, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, b.color || '#ffe599');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-16, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();
    // 头部
    ctx.fillStyle = b.color || '#fff2b5';
    ctx.shadowBlur = 8;
    ctx.shadowColor = b.color || '#ffd24a';
    ctx.beginPath();
    ctx.arc(0, 0, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

// 特效
function tickEffects(dt) {
    for (let i = state.effects.length - 1; i >= 0; i--) {
        const e = state.effects[i];
        e.t += dt * 1000;
        if (e.t >= e.life) state.effects.splice(i, 1);
    }
}
function drawEffects(camX, camY) {
    for (const e of state.effects) {
        const t = e.t / e.life;
        const x = e.x - camX, y = e.y - camY;
        if (e.kind === 'spark') {
            const r = e.size * (0.3 + t * 1.2);
            ctx.save();
            ctx.strokeStyle = `rgba(255, 210, 120, ${1 - t})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            // 内爆闪光
            ctx.fillStyle = `rgba(255, 230, 150, ${(1 - t) * 0.5})`;
            ctx.beginPath();
            ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
}

// 小地图
function drawMinimap() {
    const W = miniCanvas.width, H = miniCanvas.height;
    miniCtx.clearRect(0, 0, W, H);
    // 背景
    miniCtx.fillStyle = 'rgba(5, 10, 25, 0.8)';
    miniCtx.fillRect(0, 0, W, H);
    miniCtx.strokeStyle = 'rgba(120, 150, 220, 0.5)';
    miniCtx.strokeRect(0.5, 0.5, W - 1, H - 1);
    // 可视区框
    const sx = W / WORLD.w, sy = H / WORLD.h;
    const viewX = (state.camera.x - innerWidth / 2) * sx;
    const viewY = (state.camera.y - innerHeight / 2) * sy;
    const viewW = innerWidth * sx, viewH = innerHeight * sy;
    miniCtx.strokeStyle = 'rgba(180, 200, 255, 0.7)';
    miniCtx.setLineDash([2, 2]);
    miniCtx.strokeRect(viewX, viewY, viewW, viewH);
    miniCtx.setLineDash([]);
    // 玩家
    for (const p of state.players.values()) {
        miniCtx.fillStyle = p.color;
        miniCtx.fillRect(Math.max(0, p.x * sx - 1), Math.max(0, p.y * sy - 1), 3, 3);
    }
    // 我
    miniCtx.fillStyle = state.me.color || '#fff';
    miniCtx.beginPath();
    miniCtx.arc(state.me.x * sx, state.me.y * sy, 3, 0, Math.PI * 2);
    miniCtx.fill();
    miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1;
    miniCtx.stroke();
}

})();
