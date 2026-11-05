// GameBuddy backend: Node.js 18+, MongoDB for storage.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'gamebuddy';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_DEMO = /^(1|true|yes)$/i.test(process.env.SEED_DEMO || '');
const RESERVED_NAMES = ['admin', 'administrator', 'root', 'support', 'system'];

const META = {
  games: ['APEX Legends', 'Valorant', 'League of Legends', 'Overwatch 2', 'Fortnite', 'Minecraft', 'Genshin Impact', 'Among Us'],
  platforms: ['PC', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Mobile'],
  levels: ['เริ่มต้น', 'ปานกลาง', 'เก่ง', 'สายโปร'],
  avatars: ['🐰', '🐱', '🐼', '🦊', '🐸', '🐧', '🦉', '🐯'],
};

const db = {
  seq: 1, users: {}, sessions: {}, friendships: [], dms: [], reads: {},
  groups: [], notifications: [], queue: [], matchResults: {}, matches: [],
  ratings: [], visits: [], orders: {}, rooms: {}, roomMsgs: {},
};
const KEYS = Object.keys(db);
let stateCol = null;
let imageCol = null;

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(flush).catch((e) => console.error('บันทึกข้อมูลไม่สำเร็จ:', e.message));
  }, 300);
}
async function flush() {
  await stateCol.bulkWrite(KEYS.map((k) => ({
    replaceOne: { filter: { _id: k }, replacement: { _id: k, value: db[k] }, upsert: true },
  })));
}
async function loadDb() {
  const docs = await stateCol.find({}).toArray();
  for (const d of docs) if (KEYS.includes(d._id)) db[d._id] = d.value;
  if (!Array.isArray(db.rooms)) db.rooms = [];
}
const nextId = (prefix = '') => prefix + (db.seq++).toString(36) + crypto.randomBytes(3).toString('hex');

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(user, pw) {
  if (!user.hash) return false;
  const h = crypto.scryptSync(pw, user.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.hash));
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

function ratingOf(uid) {
  const rs = db.ratings.filter((r) => r.to === uid);
  const avg = rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : 0;
  return { avg: Math.round(avg * 10) / 10, count: rs.length };
}
function pub(u) {
  if (!u) return null;
  const { id, username, displayName, bio, avatar, cover, games, platform, level, schedule, createdAt } = u;
  return { id, username, displayName, bio, avatar, cover: cover || null, frame: u.frame || null, games, platform, level, schedule, createdAt, rating: ratingOf(id) };
}
const pubMini = (u) => (u ? { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, cover: u.cover || null, frame: u.frame || null } : null);

function findFriendship(a, b) {
  return db.friendships.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
}
function friendRel(me, other) {
  if (me === other) return 'self';
  const f = findFriendship(me, other);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.from === me ? 'outgoing' : 'incoming';
}
function friendIds(uid) {
  return db.friendships
    .filter((f) => f.status === 'accepted' && (f.from === uid || f.to === uid))
    .map((f) => (f.from === uid ? f.to : f.from));
}
function notify(userId, type, text, data = {}) {
  db.notifications.unshift({ id: nextId('n'), userId, type, text, data, at: Date.now(), read: false });
  if (db.notifications.length > 2000) db.notifications.length = 2000;
}
const dmKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

const attempts = new Map();
function rateLimit(ip, max = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || now > e.reset) { attempts.set(ip, { n: 1, reset: now + windowMs }); return; }
  if (++e.n > max) fail(429, 'ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of attempts) if (now > e.reset) attempts.delete(k);
}, 60 * 1000).unref();

const QUEUE_TTL = 10 * 60 * 1000;
const QUEUE_IDLE = 90 * 1000;
function pruneQueue() {
  const now = Date.now();
  db.queue = db.queue.filter((q) => now - q.at < QUEUE_TTL && now - (q.seen || q.at) < QUEUE_IDLE);
}

function createUser({ username, password, displayName }) {
  const id = nextId('u');
  const { salt, hash } = password ? hashPw(password) : { salt: '', hash: '' };
  
  // แปลงภาพปกตัว G สไตล์มินิมอลตามภาพต้นฉบับมาเป็นค่าเริ่มต้น
  const defaultCoverSVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='800' height='300' viewBox='0 0 800 300'><rect width='100%' height='100%' fill='%23ffffff'/><text x='50%' y='60%' font-family='Georgia, serif' font-size='180' font-weight='bold' fill='%23111111' text-anchor='middle' dominant-baseline='middle'>G</text></svg>";

  db.users[id] = {
    id, username, salt, hash, displayName: displayName || username, bio: '',
    avatar: META.avatars[Math.floor(Math.random() * META.avatars.length)],
    cover: defaultCoverSVG,
    games: [], platform: 'PC', level: 'ปานกลาง', schedule: '', createdAt: Date.now(),
    credits: 0, adFree: false,
  };
  return db.users[id];
}

const IMAGE_COST = 5;
const AD_FREE_COST = 30;
const PACKS = [
  { id: 's', label: '10 เครดิต', credits: 10, price: 10 },
  { id: 'm', label: '50 เครดิต', credits: 50, price: 45 },
  { id: 'l', label: '150 เครดิต', credits: 150, price: 120 },
];
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'live';

function parseImage(data) {
  if (!data) return null;
  const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(data));
  if (!m) fail(400, 'รองรับเฉพาะไฟล์รูป PNG, JPEG, GIF หรือ WebP');
  if (m[3].length > 2.2e6) fail(413, 'รูปใหญ่เกินไป (สูงสุดประมาณ 1.5 MB)');
  return { mime: m[1], buf: Buffer.from(m[3], 'base64') };
}
function ensureCredits(user, cost) {
  user.credits = user.credits || 0;
  if (user.credits < cost) fail(402, `เครดิตไม่พอ ส่งรูป 1 รูปใช้ ${cost} เครดิต`);
}
async function saveImage(parsed) {
  const id = nextId('i');
  await imageCol.insertOne({ _id: id, mime: parsed.mime, data: parsed.buf, at: Date.now() });
  return id;
}
async function storeImage(user, parsed) {
  ensureCredits(user, IMAGE_COST);
  user.credits -= IMAGE_COST;
  try { return await saveImage(parsed); }
  catch (e) { user.credits += IMAGE_COST; throw e; }
}
const imageUrl = (imageId, token) => (imageId ? `/api/images/${imageId}?t=${token}` : undefined);

const routes = [];
function compile(p) {
  const keys = [];
  const src = p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}
function on(method, p, handler, open = false) {
  const { re, keys } = compile(p);
  routes.push({ method, re, keys, handler, open });
}

on('POST', '/api/auth/register', async ({ body, ip }) => {
  rateLimit(ip);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9_]{3,16}$/.test(username)) fail(400, 'ชื่อผู้ใช้ต้องมี 3-16 ตัว (a-z, 0-9, _)');
  if (password.length < 6) fail(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
  if (RESERVED_NAMES.includes(username) || Object.values(db.users).some((u) => u.username === username)) fail(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const u = createUser({ username, password, displayName: String(body.displayName || '').trim().slice(0, 24) || username });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  return { token, user: pub(u) };
}, true);

on('POST', '/api/auth/login', async ({ body, ip }) => {
  rateLimit(ip);
  const username = String(body.username || '').trim().toLowerCase();
  const u = Object.values(db.users).find((x) => x.username === username);
  if (!u || !checkPw(u, String(body.password || ''))) fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  return { token, user: { ...pub(u), isAdmin: !!u.isAdmin } };
}, true);

on('POST', '/api/auth/logout', async ({ token }) => {
  delete db.sessions[token];
  save();
  return { ok: true };
});

on('GET', '/api/meta', async () => ({ ...META, demo: SEED_DEMO }), true);

on('GET', '/api/me', async ({ user }) => ({
  ...pub(user), isAdmin: !!user.isAdmin, credits: user.credits || 0, adFree: !!user.adFree,
}));

on('PUT', '/api/me', async ({ user, body }) => {
  if (body.displayName !== undefined) {
    const v = String(body.displayName).trim().slice(0, 24);
    if (!v) fail(400, 'กรุณาใส่ชื่อที่แสดง');
    user.displayName = v;
  }
  if (body.bio !== undefined) user.bio = String(body.bio).slice(0, 200);
  if (body.avatar !== undefined) {
    const img = typeof body.avatar === 'string' && body.avatar.startsWith('data:') ? parseImage(body.avatar) : null;
    if (img) user.avatar = await saveImage(img);
    else if (META.avatars.includes(body.avatar)) user.avatar = body.avatar;
  }
  if (body.cover !== undefined) {
    const img = typeof body.cover === 'string' && body.cover.startsWith('data:') ? parseImage(body.cover) : null;
    if (img) user.cover = await saveImage(img);
    else if (body.cover === null) user.cover = null;
  }
  if (body.frame !== undefined) {
    const img = typeof body.frame === 'string' && body.frame.startsWith('data:') ? parseImage(body.frame) : null;
    if (img) user.frame = await saveImage(img);
    else if (body.frame === null) user.frame = null;
  }
  if (body.games !== undefined) {
    user.games = (Array.isArray(body.games) ? body.games : []).filter((g) => META.games.includes(g)).slice(0, 6);
  }
  if (body.platform !== undefined && META.platforms.includes(body.platform)) user.platform = body.platform;
  if (body.level !== undefined && META.levels.includes(body.level)) user.level = body.level;
  if (body.schedule !== undefined) user.schedule = String(body.schedule).slice(0, 80);
  save();
  return { ...pub(user), isAdmin: !!user.isAdmin };
});

on('GET', '/api/users', async ({ user, query }) => {
  const q = (query.get('q') || '').trim().toLowerCase();
  const game = query.get('game') || '';
  return Object.values(db.users)
    .filter((u) => u.id !== user.id && !u.isAdmin)
    .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.includes(q))
    .filter((u) => !game || u.games.includes(game))
    .sort((a, b) => ratingOf(b.id).avg - ratingOf(a.id).avg)
    .slice(0, 50)
    .map((u) => ({ ...pub(u), rel: friendRel(user.id, u.id) }));
});

on('GET', '/api/users/:id', async ({ user, params }) => {
  const u = db.users[params.id];
  if (!u) fail(404, 'ไม่พบผู้ใช้');
  if (u.id !== user.id) {
    db.visits.push({ id: nextId('v'), viewer: user.id, target: u.id, at: Date.now() });
    if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
    save();
  }
  const ratings = db.ratings
    .filter((r) => r.to === u.id)
    .slice(-30)
    .reverse()
    .map((r) => ({ score: r.score, comment: r.comment, at: r.at, from: pubMini(db.users[r.from]) }));
  return { ...pub(u), rel: friendRel(user.id, u.id), ratings };
});

on('POST', '/api/users/:id/rate', async ({ user, params, body }) => {
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  if (target.id === user.id) fail(400, 'ให้คะแนนตัวเองไม่ได้');
  const score = Math.round(Number(body.score));
  if (!(score >= 1 && score <= 5)) fail(400, 'คะแนนต้องอยู่ระหว่าง 1-5');
  const comment = String(body.comment || '').slice(0, 200);
  const existing = db.ratings.find((r) => r.from === user.id && r.to === target.id);
  if (existing) Object.assign(existing, { score, comment, at: Date.now() });
  else db.ratings.push({ id: nextId('r'), from: user.id, to: target.id, score, comment, at: Date.now() });
  notify(target.id, 'rating', `${user.displayName} ให้คะแนน ${score} ดาวแก่คุณ`);
  save();
  return ratingOf(target.id);
});

on('GET', '/api/visitors', async ({ user }) =>
  db.visits
    .filter((v) => v.target === user.id)
    .slice(-100)
    .reverse()
    .map((v) => ({ at: v.at, viewer: pubMini(db.users[v.viewer]) }))
    .filter((x) => x.viewer));

on('GET', '/api/friends', async ({ user }) => {
  const list = db.friendships.filter((f) => f.from === user.id || f.to === user.id);
  const other = (f) => db.users[f.from === user.id ? f.to : f.from];
  return {
    friends: list.filter((f) => f.status === 'accepted' && other(f)).map((f) => ({ ...pub(other(f)), friendshipId: f.id })),
    incoming: list
      .filter((f) => f.status === 'pending' && f.to === user.id)
      .map((f) => ({ requestId: f.id, user: pubMini(db.users[f.from]), at: f.createdAt })),
    outgoing: list
      .filter((f) => f.status === 'pending' && f.from === user.id)
      .map((f) => ({ requestId: f.id, user: pubMini(other(f)) })),
  };
});

on('POST', '/api/friends/request', async ({ user, body }) => {
  const target = db.users[body.userId];
  if (!target || target.id === user.id) fail(400, 'ไม่สามารถส่งคำขอได้');
  const rel = friendRel(user.id, target.id);
  if (rel === 'friends') fail(409, 'เป็นเพื่อนกันอยู่แล้ว');
  if (rel === 'outgoing') fail(409, 'ส่งคำขอไปแล้ว');
  if (rel === 'incoming') {
    findFriendship(user.id, target.id).status = 'accepted';
    notify(target.id, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
    save();
    return { status: 'friends' };
  }
  const f = { id: nextId('f'), from: user.id, to: target.id, status: 'pending', createdAt: Date.now() };
  db.friendships.push(f);
  notify(target.id, 'friend_request', `${user.displayName} ส่งคำขอเป็นเพื่อนถึงคุณ`, { userId: user.id, requestId: f.id });
  save();
  return { status: 'pending' };
});

on('POST', '/api/friends/:id/accept', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && x.to === user.id && x.status === 'pending');
  if (!f) fail(404, 'ไม่พบคำขอ');
  f.status = 'accepted';
  notify(f.from, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
  save();
  return { ok: true };
});

on('DELETE', '/api/friends/:id', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && (x.from === user.id || x.to === user.id));
  if (!f) fail(404, 'ไม่พบรายการ');
  db.friendships = db.friendships.filter((x) => x !== f);
  save();
  return { ok: true };
});

on('GET', '/api/dm', async ({ user }) =>
  friendIds(user.id)
    .map((fid) => {
      const key = dmKey(user.id, fid);
      const msgs = db.dms.filter((m) => dmKey(m.from, m.to) === key);
      const last = msgs[msgs.length - 1];
      const lastRead = (db.reads[user.id] || {})[fid] || 0;
      const unread = msgs.filter((m) => m.from === fid && m.at > lastRead).length;
      return {
        user: pubMini(db.users[fid]),
        last: last ? { text: last.text || (last.image ? '📷 รูปภาพ' : ''), at: last.at, mine: last.from === user.id } : null,
        unread,
      };
    })
    .sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0)));

on('GET', '/api/dm/:userId', async ({ user, params, token }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  const key = dmKey(user.id, other.id);
  const messages = db.dms.filter((m) => dmKey(m.from, m.to) === key).slice(-200);
  db.reads[user.id] = db.reads[user.id] || {};
  db.reads[user.id][other.id] = Date.now();
  save();
  return {
    user: pub(other),
    rel: friendRel(user.id, other.id),
    messages: messages.map((m) => ({
      id: m.id, mine: m.from === user.id, text: m.text, image: imageUrl(m.image, token), at: m.at,
    })),
  };
});

on('POST', '/api/dm/:userId', async ({ user, params, body }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  if (friendRel(user.id, other.id) !== 'friends') fail(403, 'ต้องเป็นเพื่อนกันก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  const imageId = img ? await storeImage(user, img) : null;
  const m = { id: nextId('m'), from: user.id, to: other.id, text, image: imageId, at: Date.now() };
  db.dms.push(m);
  if (db.dms.length > 10000) db.dms = db.dms.slice(-10000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

on('GET', '/api/groups', async ({ user }) =>
  Object.values(db.groups).map((g) => ({
    id: g.id, name: g.name, game: g.game, description: g.description,
    members: g.members.length, joined: g.members.includes(user.id),
  })));

on('POST', '/api/groups', async ({ user, body }) => {
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) fail(400, 'กรุณาตั้งชื่อกลุ่ม');
  const g = {
    id: nextId('g'), name,
    game: META.games.includes(body.game) ? body.game : '',
    description: String(body.description || '').slice(0, 120),
    owner: user.id, members: [user.id], messages: [], createdAt: Date.now(),
  };
  db.groups[g.id] = g;
  save();
  return { id: g.id };
});

on('GET', '/api/groups/:id', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  return {
    id: g.id, name: g.name, game: g.game, description: g.description, owner: g.owner,
    joined: g.members.includes(user.id),
    members: g.members.map((id) => pubMini(db.users[id])).filter(Boolean),
  };
});

on('POST', '/api/groups/:id/join', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) g.members.push(user.id);
  save();
  return { ok: true };
});

on('POST', '/api/groups/:id/leave', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  g.members = g.members.filter((m) => m !== user.id);
  if (!g.members.length) delete db.groups[g.id];
  save();
  return { ok: true };
});

on('GET', '/api/groups/:id/messages', async ({ user, params, token }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะดูข้อความได้');
  return g.messages.slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]),
    text: m.text, image: imageUrl(m.image, token), at: m.at,
  }));
});

on('POST', '/api/groups/:id/messages', async ({ user, params, body }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  const imageId = img ? await storeImage(user, img) : null;
  const m = { id: nextId('m'), from: user.id, text, image: imageId, at: Date.now() };
  g.messages.push(m);
  if (g.messages.length > 2000) g.messages = g.messages.slice(-2000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

on('GET', '/api/images/:id', async ({ params }) => {
  const img = await imageCol.findOne({ _id: params.id });
  if (!img) fail(404, 'ไม่พบรูป');
  const b = img.data;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer).subarray(0, b.position);
  return { __raw: true, mime: img.mime, buf };
});

on('GET', '/api/wallet', async ({ user }) => {
  user.credits = user.credits || 0;
  return { credits: user.credits, adFree: !!user.adFree, imageCost: IMAGE_COST, adFreeCost: AD_FREE_COST, packs: PACKS, mode: PAYMENT_MODE };
});
on('POST', '/api/wallet/topup', async ({ user, body }) => {
  if (PAYMENT_MODE !== 'mock') fail(503, 'ระบบชำระเงินยังไม่เปิดให้บริการ ติดต่อผู้ดูแลระบบเพื่อซื้อเครดิต');
  const pack = PACKS.find((p) => p.id === body.pack);
  if (!pack) fail(400, 'ไม่พบแพ็กเกจ');
  const id = nextId('o');
  db.orders[id] = { id, userId: user.id, credits: pack.credits, price: pack.price, status: 'pending', at: Date.now() };
  save();
  return { orderId: id, amount: pack.price, mode: PAYMENT_MODE };
});
on('POST', '/api/wallet/confirm', async ({ user, body }) => {
  if (PAYMENT_MODE !== 'mock') fail(403, 'การชำระเงินจริงยืนยันผ่าน webhook เท่านั้น');
  const o = db.orders[body.orderId];
  if (!o || o.userId !== user.id) fail(404, 'ไม่พบออเดอร์');
  if (o.status !== 'pending') fail(409, 'ออเดอร์นี้ถูกใช้ไปแล้ว');
  o.status = 'paid';
  user.credits = (user.credits || 0) + o.credits;
  save();
  return { credits: user.credits };
});
on('POST', '/api/wallet/adfree', async ({ user }) => {
  user.credits = user.credits || 0;
  if (user.adFree) fail(409, 'ปิดโฆษณาไปแล้ว');
  if (user.credits < AD_FREE_COST) fail(402, `เครดิตไม่พอ ต้องใช้ ${AD_FREE_COST} เครดิต`);
  user.credits -= AD_FREE_COST;
  user.adFree = true;
  save();
  return { credits: user.credits, adFree: true };
});

on('GET', '/api/match', async ({ user }) => {
  pruneQueue();
  const q = db.queue.find((x) => x.userId === user.id);
  if (q) q.seen = Date.now();
  const result = db.matchResults[user.id] || null;
  if (result) { delete db.matchResults[user.id]; save(); }
  return { searching: !!q, game: q?.game || null, since: q?.at || null, result };
});

on('POST', '/api/match/start', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'กรุณาเลือกเกมก่อน');
  pruneQueue();
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  const partnerQ = db.queue.find((q) => q.game === game && q.userId !== user.id && db.users[q.userId]);
  if (!partnerQ) {
    db.queue.push({ userId: user.id, game, at: Date.now(), seen: Date.now() });
    save();
    return { searching: true, game, since: Date.now(), result: null };
  }
  db.queue = db.queue.filter((q) => q !== partnerQ);
  const match = { id: nextId('x'), game, players: [user.id, partnerQ.userId], at: Date.now() };
  db.matches.push(match);
  if (db.matches.length > 500) db.matches = db.matches.slice(-500);
  const partner = db.users[partnerQ.userId];
  db.matchResults[partner.id] = { match: { id: match.id, game, at: match.at }, partner: pubMini(user) };
  notify(partner.id, 'match', `พบคู่เล่น ${game} กับ ${user.displayName} แล้ว`);
  notify(user.id, 'match', `พบคู่เล่น ${game} กับ ${partner.displayName} แล้ว`);
  save();
  return { searching: false, game, result: { match: { id: match.id, game, at: match.at }, partner: pubMini(partner) } };
});

on('POST', '/api/match/stop', async ({ user }) => {
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  save();
  return { searching: false };
});

on('GET', '/api/matches', async ({ user }) =>
  db.matches
    .filter((m) => m.players.includes(user.id))
    .slice(-50)
    .reverse()
    .map((m) => ({
      id: m.id, game: m.game, at: m.at,
      partner: pubMini(db.users[m.players.find((p) => p !== user.id)]),
    })));

const ROOM_MAX = 10;
const ROOM_MIN_STAY = 60 * 1000;
const ROOM_SKIP_COST = 5;
const AD_WAIT = 15 * 1000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const oauthStates = new Map();

function unratedFor(r, uid) {
  const since = (r.joinedAt || {})[uid] || 0;
  return r.members.filter((m) => m !== uid && !db.ratings.some((x) => x.from === uid && x.to === m && x.at >= since));
}
function roomView(r, uid) {
  const joinedAt = (r.joinedAt || {})[uid] || null;
  const inRoom = r.members.includes(uid);
  return {
    id: r.id, game: r.game, title: r.title, note: r.note, size: r.size,
    count: r.members.length, slotsLeft: r.size - r.members.length,
    host: pubMini(db.users[r.hostId]), createdAt: r.createdAt,
    isHost: r.hostId === uid, joined: inRoom,
    myJoinedAt: joinedAt, canLeaveAt: joinedAt ? joinedAt + ROOM_MIN_STAY : 0,
    unrated: inRoom ? unratedFor(r, uid).map((id) => pubMini(db.users[id])).filter(Boolean) : [],
    members: r.members.map((id) => pubMini(db.users[id])).filter(Boolean),
  };
}
function deleteRoom(r) {
  delete db.rooms[r.id];
  delete db.roomMsgs[r.id];
  save();
}
function dissolveRoom(r) {
  for (const m of r.members) if (m !== r.hostId) notify(m, 'room', `ห้อง "${r.title}" ถูกปิดแล้ว`);
  deleteRoom(r);
}

const ROOM_SWEEP_MS = 30 * 60 * 1000;
function sweepRooms() {
  const solo = Object.values(db.rooms).filter((r) => r.members.length <= 1);
  if (!solo.length) return;
  for (const r of solo) deleteRoom(r);
  save();
}
setInterval(sweepRooms, ROOM_SWEEP_MS).unref();

on('GET', '/api/rooms', async ({ user, query }) => {
  const game = query.get('game') || '';
  if (!Array.isArray(db.rooms)) db.rooms = [];
  return Object.values(db.rooms)
    .filter((r) => !game || r.game === game)
    .sort((a, b) => (b.members.length < b.size) - (a.members.length < a.size) || b.createdAt - a.createdAt)
    .map((r) => roomView(r, user.id));
});

on('POST', '/api/rooms', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'กรุณาเลือกเกม');
  const size = Math.round(Number(body.size));
  if (!(size >= 2 && size <= ROOM_MAX)) fail(400, `จำนวนผู้เล่นต้องอยู่ระหว่าง 2-${ROOM_MAX} คน`);
  const r = {
    id: nextId('rm'), game, size, hostId: user.id, members: [user.id],
    title: String(body.title || '').trim().slice(0, 40) || `${game} ปาร์ตี้`,
    note: String(body.note || '').trim().slice(0, 80),
    createdAt: Date.now(), joinedAt: { [user.id]: Date.now() }, banned: [],
  };
  db.rooms[r.id] = r;
  db.roomMsgs[r.id] = [];
  save();
  return roomView(r, user.id);
});

on('POST', '/api/rooms/:id/join', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง');
  if (r.members.includes(user.id)) return roomView(r, user.id);
  if ((r.banned || []).includes(user.id)) fail(403, 'คุณออกจากห้องนี้ไปแล้ว เข้าใหม่ไม่ได้');
  if (r.members.length >= r.size) fail(409, 'ห้องเต็มแล้ว');
  r.members.push(user.id);
  r.joinedAt = r.joinedAt || {};
  r.joinedAt[user.id] = Date.now();
  notify(r.hostId, 'room', `${user.displayName} เข้าร่วมห้อง "${r.title}" แล้ว`);
  save();
  return roomView(r, user.id);
});

on('GET', '/api/rooms/:id', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r) fail(404, 'ไม่พบห้อง หรือห้องปิดไปแล้ว');
  return roomView(r, user.id);
});

on('POST', '/api/rooms/:id/ad-start', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(404, 'ไม่พบห้อง');
  r.adReady = r.adReady || {};
  const readyAt = Date.now() + AD_WAIT;
  r.adReady[user.id] = readyAt;
  return { readyAt };
});

on('POST', '/api/rooms/:id/leave', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(404, 'ไม่พบห้อง');
  const since = Date.now() - ((r.joinedAt || {})[user.id] || 0);
  if (since < ROOM_MIN_STAY) fail(403, `ต้องอยู่ในห้องอีก ${Math.ceil((ROOM_MIN_STAY - since) / 1000)} วินาทีก่อนออก`);
  if (body.mode === 'review') {
    if (unratedFor(r, user.id).length) fail(403, 'ต้องรีวิวผู้เล่นทุกคนในห้องก่อนออก');
  } else if (body.mode === 'pay') {
    if ((user.credits || 0) < ROOM_SKIP_COST) fail(402, `เครดิตไม่พอ ต้องใช้ ${ROOM_SKIP_COST} เครดิต`);
    user.credits -= ROOM_SKIP_COST;
  } else if (body.mode === 'ad') {
    const readyAt = (r.adReady || {})[user.id];
    if (!readyAt || Date.now() < readyAt) fail(403, 'ยังดูโฆษณาไม่ครบเวลา');
  } else {
    fail(400, 'รูปแบบการออกไม่ถูกต้อง');
  }
  if (r.adReady) delete r.adReady[user.id];
  if (r.hostId === user.id) {
    dissolveRoom(r);
    return { ok: true };
  }
  r.members = r.members.filter((m) => m !== user.id);
  r.banned = r.banned || [];
  r.banned.push(user.id);
  if (!r.members.length) deleteRoom(r);
  save();
  return { ok: true };
});

on('GET', '/api/rooms/:id/messages', async ({ user, params }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(403, 'ต้องอยู่ในห้องก่อนจึงจะดูข้อความได้');
  return (db.roomMsgs[r.id] || []).slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]), text: m.text, at: m.at,
  }));
});

on('POST', '/api/rooms/:id/messages', async ({ user, params, body }) => {
  const r = db.rooms[params.id];
  if (!r || !r.members.includes(user.id)) fail(403, 'ต้องอยู่ในห้องก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 300);
  if (!text) fail(400, 'ข้อความว่างเปล่า');
  const list = (db.roomMsgs[r.id] = db.roomMsgs[r.id] || []);
  list.push({ id: nextId('m'), from: user.id, text, at: Date.now() });
  if (list.length > 500) list.splice(0, list.length - 500);
  save();
  return { ok: true };
});

on('GET', '/api/notifications', async ({ user }) => {
  const mine = db.notifications.filter((n) => n.userId === user.id);
  return { items: mine.slice(0, 100), unread: mine.filter((n) => !n.read).length };
});

on('GET', '/api/notifications/count', async ({ user }) => ({
  unread: db.notifications.filter((n) => n.userId === user.id && !n.read).length,
}));

on('POST', '/api/notifications/read', async ({ user }) => {
  db.notifications.forEach((n) => { if (n.userId === user.id) n.read = true; });
  save();
  return { ok: true };
});

const requireAdmin = (user) => { if (!user?.isAdmin) fail(403, 'เฉพาะผู้ดูแลระบบ'); };

on('GET', '/api/admin/stats', async ({ user }) => {
  requireAdmin(user);
  const paid = Object.values(db.orders).filter((o) => o.status === 'paid');
  return {
    users: Object.keys(db.users).length,
    friendships: db.friendships.filter((f) => f.status === 'accepted').length,
    messages: db.dms.length + Object.values(db.groups).reduce((a, g) => a + g.messages.length, 0),
    groups: Object.keys(db.groups).length,
    paidOrders: paid.length,
    revenue: paid.reduce((a, o) => a + o.price, 0),
  };
});

on('GET', '/api/admin/users', async ({ user }) => {
  requireAdmin(user);
  return Object.values(db.users)
    .map((u) => ({
      id: u.id, username: u.username, displayName: u.displayName,
      credits: u.credits || 0, adFree: !!u.adFree, isAdmin: !!u.isAdmin, createdAt: u.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
});

on('POST', '/api/admin/users/:id/credits', async ({ user, params, body }) => {
  requireAdmin(user);
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount)) fail(400, 'จำนวนไม่ถูกต้อง');
  target.credits = Math.max(0, (target.credits || 0) + amount);
  save();
  return { credits: target.credits };
});

on('DELETE', '/api/admin/users/:id', async ({ user, params }) => {
  requireAdmin(user);
  if (params.id === user.id) fail(400, 'ลบบัญชีของตัวเองไม่ได้');
  if (!db.users[params.id]) fail(404, 'ไม่พบผู้ใช้');
  delete db.users[params.id];
  db.friendships = db.friendships.filter((f) => f.from !== params.id && f.to !== params.id);
  for (const t of Object.keys(db.sessions)) if (db.sessions[t] === params.id) delete db.sessions[t];
  for (const g of Object.values(db.groups)) g.members = g.members.filter((m) => m !== params.id);
  for (const r of Object.values(db.rooms)) {
    r.members = r.members.filter((m) => m !== params.id);
    if (r.hostId === params.id || !r.members.length) deleteRoom(r);