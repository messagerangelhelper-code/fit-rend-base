// Fit-Rend-Base core: database, security, sign-in sessions, clearance levels,
// file storage, webhooks and license check. Everything runs on your own server.
import pg from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/* ---------------- errors ---------------- */
export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };

/* ---------------- database ---------------- */
let pool;
let ready;
export function db() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  }
  return pool;
}
export function migrate() {
  if (!ready) ready = db().query(SCHEMA).catch((e) => { ready = null; throw e; });
  return ready;
}
export async function q(text, params) { await migrate(); return db().query(text, params); }
export async function tx(fn) {
  await migrate();
  const c = await db().connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}
export const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
export const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const SCHEMA = `
do $$ begin execute format('revoke connect on database %I from public', current_database()); end $$;
do $$ begin if exists (select 1 from pg_database where datname = 'postgres') then revoke connect on database postgres from public; end if; end $$;
create schema if not exists aio;
create table if not exists aio.users (
  id bigserial primary key, username text unique not null, name text default '',
  pass_hash text not null, is_owner boolean default false, disabled boolean default false,
  levels jsonb default '{}', totp_enc text, totp_on boolean default false, totp_last bigint default 0,
  recovery jsonb default '[]', failed int default 0, locked_until timestamptz,
  must_change boolean default false, created_at timestamptz default now());
create table if not exists aio.sessions (
  token_hash text primary key, user_id bigint references aio.users(id) on delete cascade,
  created_at timestamptz default now(), last_seen timestamptz default now(),
  pending_2fa boolean default false, cleared_at timestamptz, ip text);
create table if not exists aio.grants (
  id bigserial primary key, user_id bigint references aio.users(id) on delete cascade,
  kind text not null, resource_id bigint not null, level text not null,
  unique (user_id, kind, resource_id));
create table if not exists aio.audit (
  id bigserial primary key, at timestamptz default now(), user_id bigint, username text,
  action text, detail text, ip text);
create table if not exists aio.settings (key text primary key, value jsonb);
create table if not exists aio.repos (
  id bigserial primary key, name text unique not null, description text default '',
  head bigint, created_by text, created_at timestamptz default now());
create table if not exists aio.commits (
  id bigserial primary key, repo_id bigint references aio.repos(id) on delete cascade,
  parent bigint, message text, author text, at timestamptz default now(),
  tree jsonb not null default '{}', changed jsonb not null default '[]');
create index if not exists commits_repo on aio.commits(repo_id, id desc);
create table if not exists aio.secrets (
  id bigserial primary key, scope text not null, scope_id bigint not null default 0,
  key text not null, value_enc text not null, updated_at timestamptz default now(), updated_by text,
  unique (scope, scope_id, key));
create table if not exists aio.sites (
  id bigserial primary key, slug text unique not null, repo_id bigint references aio.repos(id) on delete set null,
  folder text default '', visibility text default 'clearance', key_enc text, expires_at timestamptz,
  commit_id bigint, created_by text, created_at timestamptz default now());
create table if not exists aio.deploys (
  id bigserial primary key, site_id bigint references aio.sites(id) on delete cascade,
  commit_id bigint, by_user text, at timestamptz default now(), note text);
create table if not exists aio.projects (
  id bigserial primary key, slug text unique not null, name text default '',
  owner_pw_enc text not null, anon_enc text not null, anon_hash text not null,
  service_enc text not null, service_hash text not null, cors text default '*',
  created_by text, created_at timestamptz default now());
create table if not exists aio.webhooks (
  id bigserial primary key, name text not null, url text not null, events text not null default 'deploy',
  secret_enc text not null, active boolean default true, last_status text, created_at timestamptz default now());
create table if not exists aio.inhooks (
  id bigserial primary key, name text not null, token_hash text unique not null, token_enc text not null,
  site_id bigint references aio.sites(id) on delete cascade, last_used timestamptz, created_at timestamptz default now());
create table if not exists aio.contacts (
  id bigserial primary key, email text unique not null, name text not null default '', company text not null default '',
  phone text not null default '', tags text[] not null default '{}', score int not null default 0,
  source text not null default 'manual', notes text not null default '', status text not null default 'subscribed',
  created_at timestamptz default now(), updated_at timestamptz default now(), last_seen timestamptz);
create index if not exists contacts_tags on aio.contacts using gin (tags);
create table if not exists aio.contact_events (
  id bigserial primary key, contact_id bigint references aio.contacts(id) on delete cascade,
  kind text not null, detail text not null default '', ref text, at timestamptz default now());
create unique index if not exists contact_events_ref on aio.contact_events(contact_id, ref) where ref is not null;
create index if not exists contact_events_c on aio.contact_events(contact_id, id desc);
create table if not exists aio.campaigns (
  id bigserial primary key, name text not null, subject text not null default '', body text not null default '',
  tag text not null default '', min_score int not null default 0, status text not null default 'draft',
  base_url text, next_try timestamptz, last_error text, created_by text, created_at timestamptz default now(),
  started_at timestamptz, finished_at timestamptz);
create table if not exists aio.campaign_sends (
  campaign_id bigint references aio.campaigns(id) on delete cascade, contact_id bigint references aio.contacts(id) on delete cascade,
  status text not null default 'queued', error text, at timestamptz, primary key (campaign_id, contact_id));
alter table aio.sessions add column if not exists rend_until timestamptz;
create table if not exists aio.handover (
  id bigserial primary key, app text not null default '', name text not null, note text not null default '',
  value_enc text not null, source text not null default 'manual', updated_at timestamptz default now(), updated_by text,
  unique (app, name));
create table if not exists aio.domains (
  id bigserial primary key, name text unique not null, site_id bigint references aio.sites(id) on delete cascade,
  points_here boolean not null default false, seen_ips text not null default '', checked_at timestamptz,
  created_by text, created_at timestamptz default now());
create table if not exists aio.ai_keys (
  id bigserial primary key, name text not null, key_hash text unique not null, rooms jsonb not null default '{}',
  active boolean not null default true, created_by text, created_at timestamptz default now(), last_used timestamptz);
`;
/* ---------------- security helpers ---------------- */
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
export function same(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
export function checkPassword(pw, stored) {
  try {
    const [, s, h] = String(stored).split('$');
    const hb = Buffer.from(h, 'base64');
    const t = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), hb.length);
    return crypto.timingSafeEqual(hb, t);
  } catch { return false; }
}
function masterKey() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 24) throw new Error('APP_SECRET is missing or too short');
  return crypto.createHash('sha256').update(s).digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function decrypt(b64) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
export function sign(text) { return crypto.createHmac('sha256', masterKey()).update(text).digest('base64url'); }
/* 2-step codes (authenticator app, RFC 6238), no outside service */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = ((val << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = ((val << 5) | B32.indexOf(ch)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
/** returns the matched time step, or 0 when the code is wrong */
export function totpMatch(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return 0;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const step = now + d;
    if (step > lastStep && same(totpAt(secret, step), c)) return step;
  }
  return 0;
}
/* ---------------- license (stops copies on other servers) ---------------- */
// Each server address needs a license code signed by the owner's private key.
// Only the public half is here, so a copy can't make its own code.
const LICENSE_PUBLIC = 'MCowBQYDK2VwAyEAQTe+3PC8q+zefU5cNyRSfxZcUHgg2Wbj3OZa8oiruLs=';
const licenseCache = new Map();
export function hostName(req) { return String(req.headers.get('x-forwarded-host') || req.headers.get('host') || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, ''); }
export function checkLicenseCode(host, code) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(LICENSE_PUBLIC, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from('fit-rend-base:' + host), key, Buffer.from(String(code).trim(), 'base64url'));
  } catch { return false; }
}
export async function licensed(host) {
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (licenseCache.get(host)) return true;
  const r = await q("select value from aio.settings where key = 'license'");
  const codes = r.rows[0]?.value || {};
  const ok = !!codes[host] && checkLicenseCode(host, codes[host]);
  if (ok) licenseCache.set(host, true);
  return ok;
}
// For your own domains: this copy is licensed if any saved license code is good.
export async function licensedAny() {
  if (licenseCache.get('*')) return true;
  const r = await q("select value from aio.settings where key = 'license'");
  const ok = Object.entries(r.rows[0]?.value || {}).some(([h, c]) => checkLicenseCode(h, c));
  if (ok) licenseCache.set('*', true);
  return ok;
}
export async function saveLicense(host, code) {
  if (!checkLicenseCode(host, code)) fail(400, 'LICENSE', 'That license code is not for this address.');
  const r = await q("select value from aio.settings where key = 'license'");
  const codes = { ...(r.rows[0]?.value || {}), [host]: String(code).trim() };
  await q("insert into aio.settings (key, value) values ('license', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(codes)]);
  licenseCache.set(host, true);
}
/* ---------------- levels and sessions ---------------- */
export const SECTIONS = ['repos', 'deploys', 'dns', 'database', 'contacts', 'handover', 'connectors', 'admin'];
// The Rend room (deploys) and the DNS room are for the owner only. The Rend room door needs a fresh 2-step code.
export const OWNER_ONLY = ['deploys', 'dns'];
export const LEVELS = ['none', 'viewer', 'developer', 'admin', 'owner'];
export const KIND_SECTION = { repo: 'repos', site: 'deploys', project: 'database' };
export const rank = (l) => Math.max(0, LEVELS.indexOf(l));
export async function getSettings() {
  const r = await q('select key, value from aio.settings');
  const s = { idleMinutes: 30, clearanceMinutes: 15, require2fa: true };
  for (const row of r.rows) s[row.key] = row.value;
  return s;
}
export function readCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export function isHttps(req) {
  return (req.headers.get('x-forwarded-proto') || '').includes('https') || new URL(req.url).protocol === 'https:';
}
export function ipOf(req) { return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim(); }
export async function loadSession(req) {
  const t = readCookie(req, 'cc_s');
  if (!t) return null;
  const r = await q(`select s.token_hash, s.created_at, s.last_seen, s.pending_2fa, s.cleared_at,
      s.rend_until, u.id as user_id, u.username, u.name, u.is_owner, u.disabled, u.levels, u.totp_on, u.must_change
      from aio.sessions s join aio.users u on u.id = s.user_id where s.token_hash = $1`, [sha256(t)]);
  const s = r.rows[0];
  if (!s) return null;
  const st = await getSettings();
  const now = Date.now();
  const tooOld = now - new Date(s.created_at) > (s.pending_2fa ? 10 * 60000 : 12 * 3600000);
  const idle = now - new Date(s.last_seen) > st.idleMinutes * 60000;
  if (s.disabled || tooOld || idle) {
    await q('delete from aio.sessions where token_hash = $1', [s.token_hash]);
    return null;
  }
  await q('update aio.sessions set last_seen = now() where token_hash = $1', [s.token_hash]);
  s.settings = st;
  return s;
}
export function sectionLevel(u, section) {
  if (u.is_owner) return 4;
  if (OWNER_ONLY.includes(section)) return 0;
  return rank((u.levels || {})[section]);
}
export async function resourceLevel(u, kind, id) {
  if (OWNER_ONLY.includes(KIND_SECTION[kind]) && !u.is_owner) return 0;
  const base = sectionLevel(u, KIND_SECTION[kind]);
  if (base >= 4) return 4;
  const r = await q('select level from aio.grants where user_id = $1 and kind = $2 and resource_id = $3', [u.user_id, kind, id]);
  return Math.max(base, r.rows[0] ? rank(r.rows[0].level) : 0);
}
export async function anyGrant(u, kind) {
  const r = await q('select 1 from aio.grants where user_id = $1 and kind = $2 limit 1', [u.user_id, kind]);
  return r.rowCount > 0;
}
export function needSection(u, section, level) {
  if (sectionLevel(u, section) < rank(level)) fail(403, 'LEVEL', `You need ${level} clearance in ${section} for this.`);
}
export async function needResource(u, kind, id, level) {
  if ((await resourceLevel(u, kind, id)) < rank(level)) fail(403, 'LEVEL', `You need ${level} clearance on this ${kind} for this.`);
}
export function needCleared(s) {
  const mins = s.settings?.clearanceMinutes || 15;
  if (!s.cleared_at || Date.now() - new Date(s.cleared_at) > mins * 60000) fail(403, 'CLEARANCE', 'Clearance check needed.');
}
export function rendOpen(s) {
  return Boolean(s.is_owner && s.rend_until && Date.now() < new Date(s.rend_until).getTime());
}
export function needRend(s) {
  if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner can go into the Rend room.');
  if (!rendOpen(s)) fail(403, 'REND_DOOR', 'The Rend room door is locked. Type your 2-step code to open it.');
}
export async function putHandover(app, name, value, note, source, by) {
  await q(`insert into aio.handover (app, name, note, value_enc, source, updated_by) values ($1,$2,$3,$4,$5,$6)
    on conflict (app, name) do update set value_enc = excluded.value_enc, note = excluded.note, source = excluded.source, updated_at = now(), updated_by = excluded.updated_by`,
  [String(app).slice(0, 60), String(name).slice(0, 80), String(note || '').slice(0, 300), encrypt(String(value)), source, by]);
}
export async function audit(s, action, detail = '', ip = '') {
  await q('insert into aio.audit (user_id, username, action, detail, ip) values ($1,$2,$3,$4,$5)',
    [s?.user_id || null, s?.username || '', action, String(detail).slice(0, 2000), ip]);
}
/* ---------------- file storage on disk (like git objects) ---------------- */
const DATA = process.env.DATA_DIR || path.join(process.cwd(), '.data');
export function putBlob(buf) {
  const h = sha256(buf);
  const dir = path.join(DATA, 'blobs', h.slice(0, 2));
  const file = path.join(dir, h.slice(2));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + token(6);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return h;
}
export function getBlob(h) {
  if (!/^[a-f0-9]{64}$/.test(h)) fail(400, 'BAD', 'Bad file id');
  return fs.readFileSync(path.join(DATA, 'blobs', h.slice(0, 2), h.slice(2)));
}
export function isText(buf) {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return false;
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}
export function cleanPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
  if (!s || s.length > 300 || s.split('/').some((x) => x === '..' || x === '.' || x === '') || /[\u0000-\u001f]/.test(s)) fail(400, 'BAD', 'Bad file path: ' + p);
  return s;
}
/* ---------------- zip writer (no compression, for downloads) ---------------- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
export function makeZip(entries) {
  const parts = []; const central = []; let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
/* ---------------- outgoing webhooks and deploys ---------------- */
export async function fireHook(h, payload) {
  const body = JSON.stringify({ at: new Date().toISOString(), ...payload });
  let status;
  try {
    const sig = crypto.createHmac('sha256', decrypt(h.secret_enc)).update(body).digest('hex');
    const res = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FitRendBase-Signature': sig }, body, signal: AbortSignal.timeout(8000) });
    status = String(res.status);
  } catch (e) { status = 'failed: ' + e.message; }
  await q('update aio.webhooks set last_status = $2 where id = $1', [h.id, status + ' at ' + new Date().toISOString()]);
  return status;
}
export async function fireHooks(event, payload) {
  const r = await q("select id, url, secret_enc from aio.webhooks where active and (',' || events || ',') like $1", ['%,' + event + ',%']);
  for (const h of r.rows) await fireHook(h, { event, ...payload });
}
export async function deploySite(site, commitId, by, note) {
  await q('update aio.sites set commit_id = $2 where id = $1', [site.id, commitId]);
  await q('insert into aio.deploys (site_id, commit_id, by_user, note) values ($1,$2,$3,$4)', [site.id, commitId, by, note]);
  fireHooks('deploy', { site: site.slug, commit: commitId, by, note }).catch(() => {});
}
