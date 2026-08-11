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
const killV = $('killV'), scoreV = $('scoreV'), levelV = $('levelV'), onlineV = $('onlineV'), pingV = $('pingV');

const chatWrap = $('chatWrap');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const chatTag = $('chatTag');
const crosshair = $('crosshair');
const toastWrap = $('toastWrap');
const deathMask = $('deathMask');
const killerName = $('killerName');
const respawnCount = $('respawnCount');
const lbList = $('lbList');
const lbOnline = $('lbOnline');
const skillMissile = $('skillMissile');
const missileFill = $('missileFill');
const missileCd = $('missileCd');
const skillShield = $('skillShield');
const shieldFill = $('shieldFill');
const shieldCd = $('shieldCd');
const skillFlash = $('skillFlash');
const flashFill = $('flashFill');
const flashCd = $('flashCd');

const NAME_KEY = 'skyfight-name';
const lastSavedName = localStorage.getItem(NAME_KEY) || '';
const myName = () => (nameInput.value.trim() || lastSavedName).slice(0, 12);

function saveName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch {}
}

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
const WORLD = { w: 4800, h: 3600 };
const PLAYER_SIZE = 15;
const LEVEL_SCORE = 150;
const HP_BASE = 100, HP_PER_LEVEL = 30;
const SIZE_BASE = 15, SIZE_PER_LEVEL = 30;
const SPEED_BASE = 240, SPEED_PER_LEVEL = 40, SPEED_MAX = 600;
const maxHpOf = score => Math.round(HP_BASE + (score / LEVEL_SCORE) * HP_PER_LEVEL);
const sizeOf = score => SIZE_BASE + (score / LEVEL_SCORE) * SIZE_PER_LEVEL;
const speedOf = score => Math.min(SPEED_MAX, SPEED_BASE + (score / LEVEL_SCORE) * SPEED_PER_LEVEL);
const state = {
    phase: 'name',       // name | play | dead
    me: { pid: 0, name: '', color: '#fff',
          x: 0, y: 0, angle: 0, hp: 100, alive: true, score: 0, kills: 0, invincible: false, shielded: false, size: SIZE_BASE,
          prevX: 0, prevY: 0, prevAngle: 0, snapAt: 0 },
    keys: { W:false, A:false, S:false, D:false, Space:false },
    mouse: { x: 0, y: 0, angle: 0, down: false },
    players: new Map(),   // pid -> {name,x,y,angle,hp,color,alive,score,invincible}
    bullets: [],          // {x,y,angle,color,owner}
    missiles: [],         // {x,y,angle,color,owner}
    pickups: [],          // {x,y,type}
    missileReadyAt: 0,    // E 技能冷却结束时间
    shieldReadyAt: 0,     // Q 技能冷却结束时间
    flashReadyAt: 0,      // R 技能冷却结束时间
    chatMode: false,
    camera: { x: 0, y: 0 },
    shake: { t: 0, dur: 0, mag: 0 },   // 屏幕震动
    effects: [],          // 爆炸粒子/火花
    ping: 0,
    snapInterval: 33,     // 实测快照到达间隔 ms（滑动平均）
    snapAt: 0,            // 上次快照接收时间
};

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
        send('join', { name: myName() });
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
            onlineV.textContent = data.list.length;
            lbOnline.textContent = data.list.length + ' 在线';
            updateLeaderboard(data.list); break;
        case 'missile':
            onMissile(data); break;
        case 'missile_cooldown':
            state.missileReadyAt = performance.now() + data.cooldown; break;
        case 'shield_cooldown':
            state.shieldReadyAt = performance.now() + data.cooldown; break;
        case 'flash_cooldown':
            state.flashReadyAt = performance.now() + data.cooldown; break;
        case 'flash':
            onFlash(data); break;
        case 'pickup':
            toast(data.text, 'kill');
            playExplode(false);
            break;
        case 'pickup_effect':
            spawnExplosion(data.x, data.y, '#ffd24a', false);
            break;
        case 'boom':
            spawnExplosion(data.x, data.y, data.color || '#ffd24a', true);
            addShake(10, 0.45);
            playExplode(true);
            break;
        case 'shield':
            onShield(data); break;
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
    state.me.prevX = d.spawn.x; state.me.prevY = d.spawn.y;
    state.me.prevAngle = -Math.PI / 2;
    state.camera.x = d.spawn.x; state.camera.y = d.spawn.y;
    WORLD.w = d.world.w; WORLD.h = d.world.h;
    meName.textContent = d.name;
    // 回填历史聊天
    for (const m of (d.history || [])) appendChat(m, false);
    chatLog.scrollTop = chatLog.scrollHeight;
    showScreen(screenGame);
    crosshair.style.display = 'block';
}

function onMissile(d) {
    // 立即在本机预渲染（快照会随后同步）
    state.missiles.push({ x: d.x, y: d.y, angle: d.angle, color: d.color, owner: d.owner });
    playExplode(false);
}

function onShield(d) {
    // 护盾效果（光环由快照的 shielded 字段驱动，此处只响音效）
    playExplode(false);
}

function onFlash(d) {
    const color = d.color || '#5abfff';
    // 闪现：自己本地直接对准终点（快照插值会覆盖）
    if (d.pid === state.me.pid) {
        state.me.prevX = state.me.x = d.toX;
        state.me.prevY = state.me.y = d.toY;
    }
    // 出发处：蓝色残影消散
    spawnExplosion(d.fromX, d.fromY, color, false);
    state.effects.push({ kind: 'ghost', x: d.fromX, y: d.fromY, t: 0, life: 500, color, angle: 0 });
    // 到达处：能量爆裂（环形+粒子）
    spawnExplosion(d.toX, d.toY, color, true);
    state.effects.push({
        kind: 'ring', x: d.toX, y: d.toY, t: 0, life: 450,
        color, r0: 6, r1: 56,
    });
    // 轨迹：从出发到到达的拖尾
    state.effects.push({ kind: 'trail', x: d.fromX, y: d.fromY, t: 0, life: 380, color, toX: d.toX, toY: d.toY });
    addShake(5, 0.2);
    playExplode(false);
}

function onSnapshot(d) {
    // 实测快照到达间隔（滑动平均）——决定插值窗口和预测窗口
    const nowMs = performance.now();
    const interval = Math.min(300, nowMs - (state.snapAt || nowMs - 33));
    state.snapInterval = state.snapInterval * 0.7 + interval * 0.3;
    state.snapAt = nowMs;
    state.ping = Math.round(state.snapInterval);
    pingV.textContent = state.ping;

    // 玩家
    const pids = new Set();
    for (const p of d.players) {
        pids.add(p.pid);
        if (p.pid === state.me.pid) {
            // 我自己：记录 prev 用于插值；插值窗口=本次实测间隔（自适应，避免网络卡顿后爆跳）
            const nowMs = performance.now();
            const interval = Math.min(600, Math.max(33, nowMs - (state.me.snapAt || nowMs - 33)));
            state.me.interpMs = interval;
            state.me.prevX = state.me.x; state.me.prevY = state.me.y;
            state.me.prevAngle = state.me.angle;
            state.me.x = p.x; state.me.y = p.y;
            state.me.angle = p.angle;
            state.me.snapAt = nowMs;
            state.me.hp = p.hp; state.me.alive = p.alive; state.me.invincible = p.invincible;
            state.me.shielded = p.shielded;
            state.me.boosted = p.boosted;
            state.me.size = p.size;
            state.me.color = p.color;
            state.me.score = p.score; state.me.kills = d.players.find(q => q.pid === state.me.pid)?.kills ?? state.me.kills;
            // HUD
            meDot.style.background = p.color;
            meDot.style.boxShadow = `0 0 8px ${p.color}`;
            const hpPct = (p.hp / maxHpOf(p.score)) * 100;
            hpFill.style.width = Math.min(100, hpPct) + '%';
            hpFill.classList.toggle('low', hpPct <= 35);
            hpText.textContent = `${p.hp} / ${maxHpOf(p.score)}`;
            scoreV.textContent = p.score;
            levelV.textContent = Math.floor(p.score / LEVEL_SCORE) + 1;
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
                cur.snapAt = performance.now();
            } else {
                // 保留上一帧插值起点
                cur.interp = { x: cur.x, y: cur.y, angle: cur.angle };
                cur.snapAt = performance.now();
                Object.assign(cur, p);
            }
            state.players.set(p.pid, cur);
        }
    }
    // 清理掉已离开的
    for (const key of [...state.players.keys()]) if (!pids.has(key)) state.players.delete(key);

    state.bullets = d.bullets;
    state.missiles = d.missiles || [];
    state.pickups = d.pickups || [];
}

function onHit(d) {
    if (d.targetPid === state.me.pid) {
        // 我被命中：立即同步血条（不等快照）
        state.me.hp = d.newHp;
        const hpPct = (d.newHp / maxHpOf(state.me.score)) * 100;
        hpFill.style.width = Math.max(0, Math.min(100, hpPct)) + '%';
        hpFill.classList.toggle('low', hpPct <= 35);
        hpText.textContent = `${Math.max(0, d.newHp)} / ${maxHpOf(state.me.score)}`;
    }
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
    // 命中效果（火花 / 爆炸 + 震动 + 音效）
    const tp = d.targetPid === state.me.pid ? state.me : state.players.get(d.targetPid);
    if (tp) {
        if (d.killed) {
            spawnExplosion(tp.x, tp.y, tp.color || '#ffd24a', true);
            addShake(12, 0.5);
            playExplode(true);
        } else {
            state.effects.push({ kind: 'spark', x: tp.x, y: tp.y, t: 0, life: 180, size: 14 });
            addShake(3, 0.15);
            playExplode(false);
        }
    }
}

function spawnExplosion(x, y, color, big) {
    const n = big ? 26 : 10;
    const particles = [];
    for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = Math.random() * (big ? 330 : 170) + 90;
        particles.push({
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            size: Math.random() * (big ? 3.5 : 2) + 1.5,
            color: Math.random() < 0.5 ? color : (Math.random() < 0.5 ? '#ffd24a' : '#fff'),
        });
    }
    state.effects.push({ kind: 'boom', x, y, t: 0, life: big ? 750 : 400, particles });
}

function addShake(mag, dur) {
    state.shake.mag = Math.max(state.shake.mag, mag);
    state.shake.dur = dur;
    state.shake.t = 0;
}

function onRespawn(d) {
    if (d.pid === state.me.pid) {
        state.phase = 'play';
        deathMask.hidden = true;
        state.me.hp = maxHpOf(state.me.score);
        state.me.prevX = state.me.x = d.x;
        state.me.prevY = state.me.y = d.y;
    }
    const p = state.players.get(d.pid);
    if (p) { p.x = d.x; p.y = d.y; p.hp = maxHpOf(p.score || 0); p.alive = true; }
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
            playShoot();
            break;
        case 'KeyE':
            send('flash', {});
            break;
        case 'KeyQ':
            send('shield', {});
            break;
        case 'KeyR':
            send('missile', {});
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
    if (e.button === 0) { state.mouse.down = true; send('fire', { angle: state.mouse.angle }); playShoot(); }
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
//  排行榜
// =========================================================
function updateLeaderboard(list) {
    const sorted = [...list].sort((a, b) => (b.score - a.score) || (a.name.localeCompare(b.name)));
    const mePid = state.me.pid;
    lbList.innerHTML = '';
    if (!sorted.length) {
        const empty = document.createElement('div');
        empty.className = 'lb-row';
        empty.style.color = '#55678a';
        empty.textContent = '暂无玩家';
        lbList.appendChild(empty);
        return;
    }
    const frag = document.createDocumentFragment();
    sorted.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'lb-row' + (i === 0 ? ' top1' : i === 1 ? ' top2' : i === 2 ? ' top3' : '') + (p.pid === mePid ? ' me' : '');
        row.innerHTML =
            `<span class="lb-rank">${i + 1}</span>` +
            `<span class="lb-name"><span class="lb-dot" style="background:${escapeHtml(p.color || '#5a88ff')}"></span><span>${escapeHtml(p.name)}</span></span>` +
            `<span class="lb-lv">Lv.${Math.floor((p.score || 0) / LEVEL_SCORE) + 1}</span>` +
            `<span class="lb-score">${p.score}</span>`;
        frag.appendChild(row);
    });
    lbList.appendChild(frag);
    lbList.scrollTop = lbList.scrollHeight;
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
//  音效（WebAudio 合成，无素材文件）
// =========================================================
let audioCtx = null;
function ensureAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}
function playShoot() {
    const ac = ensureAudio(); if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 520;
    const g = ac.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + 0.1);
}
function playExplode(big) {
    const ac = ensureAudio(); if (!ac) return;
    const t = ac.currentTime;
    const len = big ? 0.6 : 0.35;
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(big ? 160 : 220, t);
    o.frequency.exponentialRampToValueAtTime(30, t + len);
    const g = ac.createGain(); g.gain.setValueAtTime(big ? 0.32 : 0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + len + 0.02);
    // 低频冲击
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.setValueAtTime(90, t); o2.frequency.exponentialRampToValueAtTime(24, t + len);
    const g2 = ac.createGain(); g2.gain.setValueAtTime(big ? 0.45 : 0.25, t); g2.gain.exponentialRampToValueAtTime(0.001, t + len);
    o2.connect(g2).connect(ac.destination);
    o2.start(t); o2.stop(t + len + 0.02);
}

// =========================================================
//  工具
// =========================================================
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
    saveName(name);
    setStatus('正在连接...', true);
    connectWs();
}
joinBtn.addEventListener('click', tryJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryJoin(); } });

// 之前保存过名字：跳过输入页，自动登录
if (lastSavedName) {
    nameInput.value = lastSavedName;
    joinBtn.disabled = true;
    setStatus('正在自动登录...', true);
    connectWs();
}

// 技能冷却 UI
const MISSILE_CD = 2000, SHIELD_CD = 8000, FLASH_CD = 5000;
function updateSkillUI() {
    const mRemain = state.missileReadyAt - performance.now();
    if (mRemain <= 0) {
        skillMissile.classList.add('ready');
        missileFill.style.transform = 'scaleX(0)';
        missileCd.textContent = '';
    } else {
        skillMissile.classList.remove('ready');
        missileFill.style.transform = `scaleX(${mRemain / MISSILE_CD})`;
        missileCd.textContent = Math.ceil(mRemain / 1000);
    }
    const sRemain = state.shieldReadyAt - performance.now();
    if (sRemain <= 0) {
        skillShield.classList.add('ready');
        shieldFill.style.transform = 'scaleX(0)';
        shieldCd.textContent = '';
    } else {
        skillShield.classList.remove('ready');
        shieldFill.style.transform = `scaleX(${sRemain / SHIELD_CD})`;
        shieldCd.textContent = Math.ceil(sRemain / 1000);
    }
    const fRemain = state.flashReadyAt - performance.now();
    if (fRemain <= 0) {
        skillFlash.classList.add('ready');
        flashFill.style.transform = 'scaleX(0)';
        flashCd.textContent = '';
    } else {
        skillFlash.classList.remove('ready');
        flashFill.style.transform = `scaleX(${fRemain / FLASH_CD})`;
        flashCd.textContent = Math.ceil(fRemain / 1000);
    }
}

// =========================================================
//  渲染
// =========================================================
const lastFrame = { t: performance.now() };
function draw(now) {
    const dt = Math.min(0.05, (now - lastFrame.t) / 1000);
    lastFrame.t = now;

    ctx.clearRect(0, 0, innerWidth, innerHeight);

    if (state.phase === 'name') { requestAnimationFrame(draw); return; }

    // 自己的位置：纯快照插值（prev → cur），窗口=本次实测间隔，绝对平滑无爆跳
    const meK = clamp((now - state.me.snapAt) / (state.me.interpMs || 33), 0, 1);
    const baseX = state.me.prevX + (state.me.x - state.me.prevX) * meK;
    const baseY = state.me.prevY + (state.me.y - state.me.prevY) * meK;
    const pK = state.keys;
    let offX = 0, offY = 0;
    if (state.me.alive && (pK.W || pK.A || pK.S || pK.D)) {
        let vx = 0, vy = 0;
        if (pK.W) vy -= 1;
        if (pK.S) vy += 1;
        if (pK.A) vx -= 1;
        if (pK.D) vx += 1;
        const len = Math.hypot(vx, vy);
        offX = (vx / len) * 12; offY = (vy / len) * 12;
    }
    const finX = baseX + offX, finY = baseY + offY;
    let dA = state.me.angle - state.me.prevAngle;
    while (dA > Math.PI) dA -= Math.PI * 2;
    while (dA < -Math.PI) dA += Math.PI * 2;
    const finA = state.me.prevAngle + dA * meK;

    // 摄像机平滑跟随（用预测后的位置）
    const lerp = Math.min(1, dt * 6);
    state.camera.x += (finX - state.camera.x) * lerp;
    state.camera.y += (finY - state.camera.y) * lerp;

    // 屏幕震动
    let shX = 0, shY = 0;
    if (state.shake.mag > 0.1 && state.shake.t < state.shake.dur) {
        state.shake.t += dt;
        const k = 1 - state.shake.t / state.shake.dur;
        const a = state.shake.mag * k * k;
        shX = (Math.random() * 2 - 1) * a;
        shY = (Math.random() * 2 - 1) * a;
        if (state.shake.t >= state.shake.dur) state.shake.mag = 0;
    }

    const camX = state.camera.x - innerWidth / 2 + shX;
    const camY = state.camera.y - innerHeight / 2 + shY;

    // 背景
    drawBackground(camX, camY);
    // 世界边界
    drawWorldBorder(camX, camY);
    // 道具
    for (const q of state.pickups) drawPickup(q, camX, camY);
    // 子弹
    for (const b of state.bullets) drawBullet(b, camX, camY);
    // 导弹
    for (const m of state.missiles) drawMissile(m, camX, camY);
    // 其他玩家（含屏幕外方向箭头）
    for (const p of state.players.values()) {
        if (!p.alive) continue;
        const k = clamp((now - (p.snapAt || 0)) / Math.max(33, state.snapInterval * 1.5), 0, 1);
        const ip = {
            ...p,
            x: p.interp.x + (p.x - p.interp.x) * k,
            y: p.interp.y + (p.y - p.interp.y) * k,
            angle: p.interp.angle + (p.angle - p.interp.angle) * k,
        };
        drawPlayer(ip, camX, camY);
    }
    // 我
    if (state.me.alive) drawPlayer({
        ...state.me,
        x: finX, y: finY, angle: finA,
        name: state.me.name, pid: state.me.pid,
        color: state.me.color, invincible: state.me.invincible,
    }, camX, camY, true);
    // 爆炸/火花
    tickEffects(dt);
    drawEffects(camX, camY);
    // 小地图
    drawMinimap();
    // 技能冷却
    updateSkillUI();

    requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

let bgGradient = null, bgGradientSize = 0;
function drawBackground(camX, camY) {
    // 深空渐变（缓存，仅窗口尺寸变化时重建）——纯色背景，无星星，性能最优
    const maxDim = Math.max(innerWidth, innerHeight);
    if (!bgGradient || bgGradientSize !== maxDim) {
        bgGradient = ctx.createRadialGradient(innerWidth / 2, innerHeight / 2, 50, innerWidth / 2, innerHeight / 2, maxDim);
        bgGradient.addColorStop(0, '#0a1530');
        bgGradient.addColorStop(1, '#020308');
        bgGradientSize = maxDim;
    }
    ctx.fillStyle = bgGradient; ctx.fillRect(0, 0, innerWidth, innerHeight);
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
    const size = p.size || PLAYER_SIZE;
    // 屏幕外就不画机体了，只画方向提示
    if (x < -80 || y < -80 || x > innerWidth + 80 || y > innerHeight + 80) {
        drawOffscreenIndicator(p, camX, camY, isMe);
        return;
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.angle);

    // 护盾：六边形能量罩 + 脉动光环 + 旋转光点
    if (p.shielded) {
        const nowMs = performance.now();
        const R = size + 14;
        ctx.save();
        // 内层半透明填充
        const fillGrad = ctx.createRadialGradient(0, 0, size * 0.4, 0, 0, R);
        fillGrad.addColorStop(0, 'rgba(90, 190, 255, 0.05)');
        fillGrad.addColorStop(0.8, 'rgba(90, 190, 255, 0.28)');
        fillGrad.addColorStop(1, 'rgba(90, 190, 255, 0.12)');
        ctx.fillStyle = fillGrad;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const a = Math.PI / 3 * i + Math.PI / 6 + nowMs * 0.0005;
            const px = Math.cos(a) * R, py = Math.sin(a) * R;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // 六边形描边（发光）
        ctx.strokeStyle = 'rgba(120, 210, 255, 0.9)';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 18;
        ctx.shadowColor = '#5abfff';
        ctx.stroke();
        ctx.shadowBlur = 0;
        // 六边形顶点光点
        for (let i = 0; i < 6; i++) {
            const a = Math.PI / 3 * i + Math.PI / 6 + nowMs * 0.0005;
            ctx.fillStyle = `rgba(160, 230, 255, ${0.7 + 0.3 * Math.sin(nowMs * 0.006 + i)})`;
            ctx.beginPath();
            ctx.arc(Math.cos(a) * R, Math.sin(a) * R, 2.6, 0, Math.PI * 2);
            ctx.fill();
        }
        // 外圈脉动光环
        const pulse = 1 + 0.08 * Math.sin(nowMs * 0.005);
        ctx.strokeStyle = `rgba(140, 215, 255, ${0.5 + 0.3 * Math.sin(nowMs * 0.005)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, (R + 5) * pulse, 0, Math.PI * 2);
        ctx.stroke();
        // 旋转光点（绕圈粒子）
        for (let i = 0; i < 4; i++) {
            const a = nowMs * 0.0025 + i * Math.PI / 2;
            ctx.fillStyle = 'rgba(200, 240, 255, 0.9)';
            ctx.beginPath();
            ctx.arc(Math.cos(a) * (R + 2), Math.sin(a) * (R + 2), 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    // 无敌闪烁
    const flicker = p.invincible && Math.floor(performance.now() / 90) % 2 === 0;
    ctx.globalAlpha = flicker ? 0.45 : 1;

    // 尾焰（加速时变蓝色长焰）
    const boosted = p.boosted;
    const flame = boosted ? 22 + Math.sin(performance.now() / 40) * 5 : 10 + Math.sin(performance.now() / 60) * 3;
    const flameG = ctx.createLinearGradient(-size - flame, 0, -size, 0);
    if (boosted) {
        flameG.addColorStop(0, 'rgba(80, 200, 255, 0)');
        flameG.addColorStop(1, 'rgba(90, 190, 255, 0.95)');
    } else {
        flameG.addColorStop(0, 'rgba(255, 180, 60, 0)');
        flameG.addColorStop(1, 'rgba(255, 110, 40, 0.85)');
    }
    ctx.fillStyle = flameG;
    ctx.beginPath();
    ctx.moveTo(-size - flame, 0);
    ctx.lineTo(-size, -5);
    ctx.lineTo(-size, 5);
    ctx.closePath();
    ctx.fill();

    // 飞机身（三角形+翼）
    ctx.fillStyle = p.color || '#5a88ff';
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.8, -size * 0.9);
    ctx.lineTo(-size * 0.35, 0);
    ctx.lineTo(-size * 0.8, size * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 座舱
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(size * 0.2, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // 自己的外描边
    if (isMe) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, size + 6, 0, Math.PI * 2);
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    // 名字 + 血条
    drawPlayerTag(p, x, y, isMe, size);
}

function drawPlayerTag(p, x, y, isMe, size = PLAYER_SIZE) {
    const hp = Math.max(0, p.hp);
    const maxHp = maxHpOf(p.score || 0);
    // 血条（随体型变宽）
    const w = Math.max(40, size * 2.4), h = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - w / 2, y - size - 16, w, h);
    const hpRatio = hp / maxHp;
    ctx.fillStyle = hpRatio > 0.35 ? '#4be27e' : '#ff6861';
    ctx.fillRect(x - w / 2, y - size - 16, w * hpRatio, h);
    // 名字
    ctx.font = isMe ? 'bold 12px "Microsoft YaHei", sans-serif' : '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(p.name, x + 1, y - size - 19);
    ctx.fillStyle = p.color || '#fff';
    ctx.fillText(p.name, x, y - size - 20);
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
    const sz = b.size || 4;
    if (x < -40 || y < -40 || x > innerWidth + 40 || y > innerHeight + 40) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.angle);
    // 拖尾（随子弹大小）
    const grad = ctx.createLinearGradient(-sz * 4, 0, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, b.color || '#ffe599');
    ctx.strokeStyle = grad;
    ctx.lineWidth = sz * 0.6;
    ctx.beginPath();
    ctx.moveTo(-sz * 4, 0);
    ctx.lineTo(0, 0);
    ctx.stroke();
    // 头部
    ctx.fillStyle = b.color || '#fff2b5';
    ctx.shadowBlur = 8;
    ctx.shadowColor = b.color || '#ffd24a';
    ctx.beginPath();
    ctx.arc(0, 0, sz * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawMissile(m, camX, camY) {
    const x = m.x - camX, y = m.y - camY;
    if (x < -40 || y < -40 || x > innerWidth + 40 || y > innerHeight + 40) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(m.angle);
    // 尾焰
    const fg = ctx.createLinearGradient(-22, 0, -6, 0);
    fg.addColorStop(0, 'rgba(255,120,40,0)');
    fg.addColorStop(1, 'rgba(255,150,50,0.9)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-22, 0);
    ctx.lineTo(-6, -3);
    ctx.lineTo(-6, 3);
    ctx.closePath();
    ctx.fill();
    // 弹体
    ctx.fillStyle = '#e8edf7';
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7, -3.5);
    ctx.lineTo(-7, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // 红点
    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.arc(8, 0, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawPickup(q, camX, camY) {
    const x = q.x - camX, y = q.y - camY;
    if (x < -60 || y < -60 || x > innerWidth + 60 || y > innerHeight + 60) return;
    const pulse = 1 + 0.12 * Math.sin(performance.now() * 0.004 + q.x);
    const colors = { boost: '#4dd8ff', heal: '#4be27e', invincible: '#ffd24a' };
    const icons = { boost: '▶', heal: '+', invincible: '✦' };
    const col = colors[q.type] || '#fff';
    ctx.save();
    ctx.translate(x, y);
    // 发光底圈
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(performance.now() * 0.004 + q.x);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(0, 0, 20 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 外环
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 12;
    ctx.shadowColor = col;
    ctx.beginPath();
    ctx.arc(0, 0, 14 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    // 图标
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icons[q.type], 0, 1);
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
        if (e.kind === 'boom') {
            // 爆炸：扩散冲击波 + 飞散粒子
            ctx.save();
            ctx.strokeStyle = `rgba(255, 200, 100, ${(1 - t) * 0.9})`;
            ctx.lineWidth = 3 * (1 - t) + 0.5;
            ctx.beginPath();
            ctx.arc(x, y, 6 + t * 46, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = `rgba(255, 230, 150, ${(1 - t) * 0.55})`;
            ctx.beginPath();
            ctx.arc(x, y, 6 + t * 30, 0, Math.PI * 2);
            ctx.fill();
            for (const p of e.particles) {
                const px = x + p.vx * t * e.life / 1000;
                const py = y + p.vy * t * e.life / 1000;
                ctx.globalAlpha = 1 - t;
                ctx.fillStyle = p.color;
                ctx.fillRect(px - p.size / 2, py - p.size / 2, p.size, p.size);
            }
            ctx.restore();
        } else if (e.kind === 'trail') {
            // 闪现轨迹：光带从起点划向终点
            const p = Math.min(1, t * 1.4);
            const x2 = e.x + (e.toX - e.x) * p;
            const y2 = e.y + (e.toY - e.y) * p;
            const x1 = e.x + (e.toX - e.x) * Math.max(0, p - 0.35);
            const y1 = e.y + (e.toY - e.y) * Math.max(0, p - 0.35);
            ctx.save();
            ctx.strokeStyle = `rgba(120, 200, 255, ${(1 - t) * 0.8})`;
            ctx.lineWidth = 6 * (1 - t) + 1;
            ctx.lineCap = 'round';
            ctx.shadowBlur = 18;
            ctx.shadowColor = '#5abfff';
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.restore();
        } else if (e.kind === 'ghost') {
            // 出发处残影：蓝色虚影收缩消散
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(0);
            ctx.globalAlpha = (1 - t) * 0.5;
            ctx.strokeStyle = e.color || '#5abfff';
            ctx.lineWidth = 2.5;
            ctx.shadowBlur = 12;
            ctx.shadowColor = '#5abfff';
            ctx.beginPath();
            ctx.arc(0, 0, (1 - t) * 16 + 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        } else if (e.kind === 'ring') {
            // 到达处能量环：扩散 + 收缩
            ctx.save();
            const r1 = e.r1 * (0.3 + t * 0.8);
            const r2 = e.r0 * (1 - t * 0.4);
            ctx.strokeStyle = `rgba(90, 190, 255, ${(1 - t) * 0.9})`;
            ctx.lineWidth = 3 * (1 - t) + 0.5;
            ctx.shadowBlur = 16;
            ctx.shadowColor = '#5abfff';
            ctx.beginPath();
            ctx.arc(x, y, r1, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = `rgba(140, 210, 255, ${(1 - t) * 0.35})`;
            ctx.beginPath();
            ctx.arc(x, y, r2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        } else if (e.kind === 'spark') {
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
        if (!p.alive) continue;
        miniCtx.fillStyle = p.color;
        miniCtx.fillRect(Math.max(0, p.x * sx - 1), Math.max(0, p.y * sy - 1), 3, 3);
    }
    // 我
    if (state.me.alive) {
        miniCtx.fillStyle = state.me.color || '#fff';
        miniCtx.beginPath();
        miniCtx.arc(state.me.x * sx, state.me.y * sy, 3, 0, Math.PI * 2);
        miniCtx.fill();
        miniCtx.strokeStyle = '#fff'; miniCtx.lineWidth = 1;
        miniCtx.stroke();
    }
}

})();
