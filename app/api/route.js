// Fit-Rend-Base API. Every call is POST /api with {action, ...}.
import QRCode from 'qrcode';
import {
  q, tx, fail, HttpError, token, sha256, same, hashPassword, checkPassword, encrypt, decrypt,
  b32encode, totpMatch, loadSession, getSettings, isHttps, ipOf, hostName, licensed, saveLicense,
  SECTIONS, OWNER_ONLY, LEVELS, rank, needRend, rendOpen, putHandover, sectionLevel, resourceLevel, anyGrant, needSection, needResource, needCleared, audit,
  putBlob, getBlob, isText, cleanPath, fireHooks, fireHook, deploySite,
} from '../../lib/core';
import * as P from '../../lib/projects';
import * as CRM from '../../lib/crm';
import * as PL from '../../lib/pipeline';
import crypto from 'crypto';
import { promises as dns } from 'dns';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const cookie = (req, value, maxAge) =>
  `cc_s=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
const MAX_FILE = 10 * 1024 * 1024;
const SITE_SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/;

function strongPassword(pw) {
  if (String(pw || '').length < 10) fail(400, 'BAD', 'Password must be at least 10 characters.');
}
async function newSession(req, userId, pending) {
  const t = token(32);
  await q('insert into aio.sessions (token_hash, user_id, pending_2fa, cleared_at, ip) values ($1,$2,$3,$4,$5)',
    [sha256(t), userId, pending, pending ? null : new Date(), ipOf(req)]);
  return t;
}
async function treeOf(repo) {
  if (!repo.head) return {};
  const r = await q('select tree from aio.commits where id = $1', [repo.head]);
  return r.rows[0]?.tree || {};
}
async function getRepo(id) {
  const r = await q('select * from aio.repos where id = $1', [id]);
  if (!r.rows[0]) fail(404, 'NOTFOUND', 'Repo not found');
  return r.rows[0];
}
/** changes: [{path, data: Buffer}] or [{path, remove: true}] */
async function writeCommit(repoId, author, message, changes) {
  return tx(async (c) => {
    const r = await c.query('select * from aio.repos where id = $1 for update', [repoId]);
    const repo = r.rows[0];
    if (!repo) fail(404, 'NOTFOUND', 'Repo not found');
    const t0 = repo.head ? (await c.query('select tree from aio.commits where id = $1', [repo.head])).rows[0].tree : {};
    const tree = { ...t0 }; const changed = [];
    for (const ch of changes) {
      const p = cleanPath(ch.path);
      if (ch.remove) {
        if (tree[p]) { changed.push({ path: p, op: 'delete', before: tree[p][0] }); delete tree[p]; }
        continue;
      }
      if (ch.data.length > MAX_FILE) fail(400, 'BAD', `${p} is over 10 MB`);
      const h = putBlob(ch.data);
      if (tree[p] && tree[p][0] === h) continue;
      changed.push({ path: p, op: tree[p] ? 'edit' : 'add', before: tree[p]?.[0] || null, after: h });
      tree[p] = [h, ch.data.length];
    }
    if (!changed.length) return { commit: repo.head, nothing: true };
    const ins = await c.query('insert into aio.commits (repo_id, parent, message, author, tree, changed) values ($1,$2,$3,$4,$5,$6) returning id',
      [repoId, repo.head, String(message || 'Update files').slice(0, 300), author, JSON.stringify(tree), JSON.stringify(changed)]);
    await c.query('update aio.repos set head = $2 where id = $1', [repoId, ins.rows[0].id]);
    return { commit: ins.rows[0].id, changed: changed.length };
  });
}
function decodeIncoming(f) {
  if (f.b64 != null) return Buffer.from(String(f.b64), 'base64');
  return Buffer.from(String(f.text ?? ''), 'utf8');
}
function fileOut(buf) {
  return isText(buf) ? { text: buf.toString('utf8') } : { b64: buf.toString('base64') };
}
async function siteLink(req, site) {
  const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
  let url = `${base}/s/${site.slug}/`;
  if (site.visibility === 'key' && site.key_enc) url += '?k=' + encodeURIComponent(decrypt(site.key_enc));
  return url;
}
async function secretsList(scope, id) {
  const r = await q('select key, updated_at, updated_by from aio.secrets where scope = $1 and scope_id = $2 order by key', [scope, id]);
  return r.rows;
}
async function scopeCheck(s, scope, id, level) {
  if (scope === 'repo') return needResource(s, 'repo', id, level);
  if (scope === 'project') return needResource(s, 'project', id, level);
  if (scope === 'global') return needSection(s, 'connectors', level);
  fail(400, 'BAD', 'Bad scope');
}
function cleanLevels(input, editor) {
  const out = {};
  for (const sec of SECTIONS) {
    if (OWNER_ONLY.includes(sec)) continue;
    const l = (input || {})[sec] || 'none';
    if (!['none', 'viewer', 'developer', 'admin'].includes(l)) fail(400, 'BAD', 'Bad level');
    if (rank(l) > sectionLevel(editor, 'admin') && rank(l) > sectionLevel(editor, sec)) fail(403, 'LEVEL', `You can't give ${l} in ${sec}.`);
    if (l !== 'none') out[sec] = l;
  }
  return out;
}

/* ---------------- AI access ---------------- */
// An AI key reaches only the Fit room (repos) and the Base room (database), and only these actions.
const AI_ROOMS = { repos: ['viewer', 'developer'], database: ['viewer', 'developer'] };
const AI_ACTIONS = new Set(['me', 'repoList', 'repoCreate', 'fileList', 'fileGet', 'commit', 'history', 'projectList', 'projectApi', 'dbTables', 'dbTable', 'dbQuery', 'dbPolicies']);
function cleanAiRooms(input) {
  const out = {};
  for (const [room, levels] of Object.entries(AI_ROOMS)) {
    const l = (input || {})[room];
    if (l && l !== 'none') { if (!levels.includes(l)) fail(400, 'BAD', 'Bad AI level'); out[room] = l; }
  }
  return out;
}
async function aiSession(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(frbai_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const r = await q('update aio.ai_keys set last_used = now() where key_hash = $1 and active returning id, name, rooms', [sha256(m[1])]);
  const k = r.rows[0];
  if (!k) fail(401, 'AI_KEY', 'This AI key is not valid or is turned off.');
  return {
    ai: true, ai_key_id: k.id, user_id: null, username: 'AI: ' + k.name, name: 'AI: ' + k.name, is_owner: false, disabled: false,
    levels: cleanAiRooms(k.rooms), totp_on: true, must_change: false, pending_2fa: false, cleared_at: null, rend_until: null,
    token_hash: null, settings: await getSettings(),
  };
}

/* ---------------- public actions (no sign-in) ---------------- */
const OPEN = {
  async status({ req, s }) {
    const users = await q('select count(*)::int as n from aio.users');
    const host = hostName(req);
    return {
      host, licensed: await licensed(host), setup: users.rows[0].n === 0,
      me: s && !s.pending_2fa ? await meOf(s) : null, pending2fa: !!(s && s.pending_2fa),
    };
  },
  async license({ req, body }) {
    await saveLicense(hostName(req), body.code);
    await audit(null, 'license.saved', hostName(req), ipOf(req));
    return { ok: true };
  },
  async setup({ req, body }) {
    const name = String(body.username || '').trim();
    if (!USERNAME.test(name)) fail(400, 'BAD', 'User name: 3 to 40 letters, numbers, dot, dash or underscore.');
    strongPassword(body.password);
    const made = await tx(async (c) => {
      await c.query('lock table aio.users in exclusive mode');
      const n = await c.query('select count(*)::int as n from aio.users');
      if (n.rows[0].n > 0) fail(400, 'BAD', 'Setup is already done.');
      const r = await c.query('insert into aio.users (username, name, pass_hash, is_owner) values ($1,$2,$3,true) returning id', [name, body.name || name, hashPassword(body.password)]);
      return r.rows[0].id;
    });
    const t = await newSession(req, made, false);
    await audit({ user_id: made, username: name }, 'setup.owner', 'Owner account made', ipOf(req));
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, t, 43200) });
  },
  async login({ req, body }) {
    // Customers sign in with their email. Everyone else signs in with their user name.
    const who = String(body.username || '').trim();
    const r = await q("select * from aio.users where username = $1 or (email <> '' and lower(email) = lower($1)) order by (username = $1) desc limit 1", [who]);
    const u = r.rows[0];
    if (u && u.locked_until && new Date(u.locked_until) > new Date()) fail(429, 'LOCKED', 'Too many wrong tries. This account is locked for 15 minutes.');
    const ok = u ? checkPassword(body.password, u.pass_hash) : checkPassword(body.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    if (!u || !ok || u.disabled) {
      if (u) {
        const failed = (u.failed || 0) + 1;
        await q('update aio.users set failed = $2, locked_until = $3 where id = $1', [u.id, failed >= 5 ? 0 : failed, failed >= 5 ? new Date(Date.now() + 15 * 60000) : null]);
        await audit({ user_id: u.id, username: u.username }, 'signin.failed', failed >= 5 ? 'Locked for 15 minutes' : `Wrong password (${failed})`, ipOf(req));
      }
      fail(401, 'BAD', 'Wrong user name or password.');
    }
    await q('update aio.users set failed = 0, locked_until = null where id = $1', [u.id]);
    const t = await newSession(req, u.id, u.totp_on);
    if (!u.totp_on) await audit({ user_id: u.id, username: u.username }, 'signin', 'Password only', ipOf(req));
    return json({ ok: true, need2fa: u.totp_on }, 200, { 'Set-Cookie': cookie(req, t, 43200) });
  },
  async login2fa({ req, body, s }) {
    if (!s || !s.pending_2fa) fail(401, 'SIGNED_OUT', 'Sign in again.');
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    const u = r.rows[0];
    if (!(await checkSecondStep(u, body.code))) {
      await audit(s, 'signin.2fa_failed', '', ipOf(req));
      const f = (u.failed || 0) + 1;
      await q('update aio.users set failed = $2, locked_until = $3 where id = $1', [u.id, f >= 5 ? 0 : f, f >= 5 ? new Date(Date.now() + 15 * 60000) : null]);
      if (f >= 5) await q('delete from aio.sessions where user_id = $1', [u.id]);
      fail(401, 'BAD', 'Wrong code.');
    }
    await q('update aio.users set failed = 0 where id = $1', [u.id]);
    await q('update aio.sessions set pending_2fa = false, cleared_at = now() where token_hash = $1', [s.token_hash]);
    await audit(s, 'signin', 'Password and 2-step code', ipOf(req));
    return { ok: true };
  },
  async logout({ req, s }) {
    if (s) { await q('delete from aio.sessions where token_hash = $1', [s.token_hash]); await audit(s, 'signout', '', ipOf(req)); }
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, '', 0) });
  },
};
async function checkSecondStep(u, code) {
  const c = String(code || '').trim();
  if (u.totp_on && u.totp_enc) {
    const step = totpMatch(decrypt(u.totp_enc), c, Number(u.totp_last || 0));
    if (step) { await q('update aio.users set totp_last = $2 where id = $1', [u.id, step]); return true; }
  }
  const rec = Array.isArray(u.recovery) ? u.recovery : [];
  const h = sha256(c.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (c.length >= 8 && rec.includes(h)) {
    await q('update aio.users set recovery = $2 where id = $1', [u.id, JSON.stringify(rec.filter((x) => x !== h))]);
    return true;
  }
  return false;
}
async function meOf(s) {
  const levels = {};
  for (const sec of SECTIONS) levels[sec] = LEVELS[sectionLevel(s, sec)];
  for (const [kind, sec] of [['repo', 'repos'], ['project', 'database']]) {
    if (levels[sec] === 'none' && (await anyGrant(s, kind))) levels[sec] = 'some';
  }
  const st = s.settings;
  return {
    id: s.user_id, username: s.username, name: s.name, owner: s.is_owner, levels,
    totpOn: s.totp_on, mustChange: s.must_change, needs2faSetup: st.require2fa && !s.totp_on,
    clearedUntil: s.cleared_at ? new Date(new Date(s.cleared_at).getTime() + st.clearanceMinutes * 60000).toISOString() : null,
    idleMinutes: st.idleMinutes, ai: Boolean(s.ai),
    rendUntil: rendOpen(s) ? new Date(s.rend_until).toISOString() : null,
    customer: Boolean(s.is_customer), plan: s.plan || '',
  };
}

/* ---------------- account actions (signed in, also during forced setup) ---------------- */
const ACCOUNT = {
  async me({ s }) { return { me: await meOf(s) }; },
  async changePassword({ req, s, body }) {
    const r = await q('select pass_hash from aio.users where id = $1', [s.user_id]);
    if (!checkPassword(body.old, r.rows[0].pass_hash)) fail(400, 'BAD', 'Your current password is wrong.');
    strongPassword(body.password);
    await q('update aio.users set pass_hash = $2, must_change = false where id = $1', [s.user_id, hashPassword(body.password)]);
    await q('delete from aio.sessions where user_id = $1 and token_hash <> $2', [s.user_id, s.token_hash]);
    await audit(s, 'account.password', 'Changed own password', ipOf(req));
    return { ok: true };
  },
  async totpBegin({ s }) {
    const secret = b32encode(crypto.randomBytes(20));
    await q('update aio.users set totp_enc = $2, totp_on = false where id = $1 and not totp_on', [s.user_id, encrypt(secret)]);
    const r = await q('select totp_on from aio.users where id = $1', [s.user_id]);
    if (r.rows[0].totp_on) fail(400, 'BAD', '2-step is already on.');
    const url = `otpauth://totp/${encodeURIComponent('Fit-Rend-Base:' + s.username)}?secret=${secret}&issuer=${encodeURIComponent('Fit-Rend-Base')}&digits=6&period=30`;
    return { secret, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  },
  async totpConfirm({ req, s, body }) {
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    const u = r.rows[0];
    if (u.totp_on || !u.totp_enc) fail(400, 'BAD', 'Start 2-step setup first.');
    const step = totpMatch(decrypt(u.totp_enc), body.code, 0);
    if (!step) fail(400, 'BAD', 'That code did not match. Check the time on your phone and try the newest code.');
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
    await q('update aio.users set totp_on = true, totp_last = $2, recovery = $3 where id = $1', [u.id, step, JSON.stringify(codes.map((c) => sha256(c)))]);
    await q('update aio.sessions set cleared_at = now() where token_hash = $1', [s.token_hash]);
    await audit(s, 'account.2fa_on', '', ipOf(req));
    return { codes: codes.map((c) => c.slice(0, 5) + '-' + c.slice(5)) };
  },
  async totpOff({ req, s, body }) {
    if (s.settings.require2fa) fail(400, 'BAD', '2-step is required for everyone here.');
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    if (!(await checkSecondStep(r.rows[0], body.code))) fail(400, 'BAD', 'Wrong code.');
    await q("update aio.users set totp_on = false, totp_enc = null, recovery = '[]' where id = $1", [s.user_id]);
    await audit(s, 'account.2fa_off', '', ipOf(req));
    return { ok: true };
  },
  async newRecovery({ req, s, body }) {
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    if (!(await checkSecondStep(r.rows[0], body.code))) fail(400, 'BAD', 'Wrong code.');
    const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
    await q('update aio.users set recovery = $2 where id = $1', [s.user_id, JSON.stringify(codes.map((c) => sha256(c)))]);
    await audit(s, 'account.recovery_codes', 'Made new backup codes', ipOf(req));
    return { codes: codes.map((c) => c.slice(0, 5) + '-' + c.slice(5)) };
  },
  // The Rend room door: owner only, a fresh 2-step code to go in. It locks again when the owner leaves.
  async rendOpen({ req, s, body }) {
    if (!s.is_owner) { await audit(s, 'rend.refused', 'Not the owner', ipOf(req)); fail(403, 'OWNER_ONLY', 'Only the owner can go into the Rend room.'); }
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    const u = r.rows[0];
    if (!u.totp_on) fail(403, 'NEED_2FA', 'Turn on 2-step sign-in first.');
    if (!(await checkSecondStep(u, body.code))) { await audit(s, 'rend.failed', 'Wrong code at the Rend room door', ipOf(req)); fail(400, 'BAD', 'Wrong code.'); }
    const mins = s.settings.clearanceMinutes || 15;
    await q(`update aio.sessions set rend_until = now() + ($2 || ' minutes')::interval, cleared_at = now() where token_hash = $1`, [s.token_hash, String(mins)]);
    await audit(s, 'rend.open', 'Opened the Rend room', ipOf(req));
    return { ok: true };
  },
  async rendClose({ req, s }) {
    if (s.rend_until) {
      await q('update aio.sessions set rend_until = null where token_hash = $1', [s.token_hash]);
      await audit(s, 'rend.close', 'Locked the Rend room', ipOf(req));
    }
    return { ok: true };
  },
  async clearance({ req, s, body }) {
    const r = await q('select * from aio.users where id = $1', [s.user_id]);
    const u = r.rows[0];
    const ok = u.totp_on ? await checkSecondStep(u, body.code) : checkPassword(body.code, u.pass_hash);
    if (!ok) { await audit(s, 'clearance.failed', '', ipOf(req)); fail(400, 'BAD', u.totp_on ? 'Wrong code.' : 'Wrong password.'); }
    await q('update aio.sessions set cleared_at = now() where token_hash = $1', [s.token_hash]);
    await audit(s, 'clearance', 'Passed clearance check', ipOf(req));
    return { ok: true };
  },
};

/* ---------------- main actions ---------------- */
const baseOf = (req) => (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
const needOwner = (s) => { if (!s.is_owner) fail(403, 'LEVEL', 'Only the owner can change the customer pipeline.'); };
const MAIN = {
  /* ---------- customer pipeline: a customer's own space ---------- */
  async myHome({ req, s }) {
    const u = (await q('select plan, ref_code, is_customer from aio.users where id = $1', [s.user_id])).rows[0];
    const st = await PL.pipeSettings();
    const t = await q('select id, room, message, status, reply, created_at, updated_at from aio.tickets where user_id = $1 order by id desc limit 20', [s.user_id]);
    const out = { customer: u.is_customer, plan: u.plan, planName: PL.PLAN_NAMES[u.plan] || '', tickets: t.rows };
    if (u.is_customer) {
      out.limits = PL.PLAN_LIMITS[u.plan] || PL.PLAN_LIMITS.starter;
      out.used = await PL.customerUse(s.user_id);
      const repos = await q("select r.id, r.name from aio.grants g join aio.repos r on r.id = g.resource_id where g.user_id = $1 and g.kind = 'repo' order by r.name", [s.user_id]);
      const projects = await q("select p.id, p.slug, p.name from aio.grants g join aio.projects p on p.id = g.resource_id where g.user_id = $1 and g.kind = 'project' order by p.slug", [s.user_id]);
      out.repos = repos.rows; out.projects = projects.rows;
      if (st.rewardsOn && u.ref_code) {
        const rr = await q("select count(*)::int as friends, count(*) filter (where status = 'given')::int as given from aio.referrals where referrer_id = $1", [s.user_id]);
        out.share = { link: `${baseOf(req)}/r/${u.ref_code}`, ...rr.rows[0] };
      }
    }
    return out;
  },
  async myRepoCreate({ req, s, body }) {
    if (!s.is_customer) fail(400, 'BAD', 'This button is for customer accounts.');
    const lim = PL.PLAN_LIMITS[s.plan] || PL.PLAN_LIMITS.starter;
    if ((await PL.customerUse(s.user_id)).repos >= lim.repos) fail(400, 'PLAN', `Your plan has room for ${lim.repos} code space${lim.repos === 1 ? '' : 's'}. Pick a bigger plan for more.`);
    const short = String(body.name || 'app').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'app';
    const name = `${s.username}-${short}`.slice(0, 60);
    const r = await q('insert into aio.repos (name, description, created_by) values ($1,$2,$3) on conflict do nothing returning id', [name, 'Code space for ' + s.username, s.username]);
    if (!r.rows[0]) fail(400, 'BAD', 'You already have a code space with that name.');
    await writeCommit(r.rows[0].id, s.username, 'First commit', [{ path: 'README.md', data: Buffer.from(`# ${short}\n\nPut your app's files here.\n`) }]);
    await q("insert into aio.grants (user_id, kind, resource_id, level) values ($1, 'repo', $2, 'admin') on conflict do nothing", [s.user_id, r.rows[0].id]);
    await audit(s, 'customer.repo', name, ipOf(req));
    return { id: r.rows[0].id, name };
  },
  async myProjectCreate({ req, s, body }) {
    if (!s.is_customer) fail(400, 'BAD', 'This button is for customer accounts.');
    needCleared(s);
    const lim = PL.PLAN_LIMITS[s.plan] || PL.PLAN_LIMITS.starter;
    if ((await PL.customerUse(s.user_id)).projects >= lim.projects) fail(400, 'PLAN', `Your plan has room for ${lim.projects} database${lim.projects === 1 ? '' : 's'}. Pick a bigger plan for more.`);
    const short = String(body.name || 'data').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 16) || 'data';
    const p = await P.createProject(`c${s.user_id}_${short}`.slice(0, 31), body.name || short, s.username);
    await q("insert into aio.grants (user_id, kind, resource_id, level) values ($1, 'project', $2, 'admin') on conflict do nothing", [s.user_id, p.id]);
    await audit(s, 'customer.project', p.slug, ipOf(req));
    return { id: p.id, slug: p.slug };
  },
  /* ---------- Get help ---------- */
  async ticketOpen({ req, s, body }) {
    const t = await PL.openTicket(s, body.room, body.message);
    await audit(s, 'help.open', `#${t.id} in ${t.room}`, ipOf(req));
    return { id: t.id };
  },
  async ticketList({ s, body }) {
    needSection(s, 'contacts', 'viewer');
    const status = body.status === 'closed' ? 'closed' : 'open';
    const r = await q(`select t.*, u.email, u.plan from aio.tickets t left join aio.users u on u.id = t.user_id where t.status = $1 order by t.id desc limit 200`, [status]);
    const n = await q("select count(*) filter (where status = 'open')::int as open from aio.tickets");
    return { tickets: r.rows, open: n.rows[0].open };
  },
  async ticketReply({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    const reply = String(body.reply || '').trim();
    if (!reply) fail(400, 'BAD', 'Type your answer first.');
    const t = await PL.closeTicket(Number(body.id), reply, s.username);
    await audit(s, 'help.answer', '#' + t.id, ipOf(req));
    return { ok: true };
  },
  /* ---------- pipeline board ---------- */
  async pipelineBoard({ s }) {
    needSection(s, 'contacts', 'viewer');
    return { columns: await PL.board() };
  },
  async contactStage({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    if (!PL.STAGES.includes(body.stage)) fail(400, 'BAD', 'Bad stage');
    await PL.setStage(Number(body.id), body.stage, 'Moved by ' + s.username);
    await audit(s, 'contact.stage', `${body.id} -> ${body.stage}`, ipOf(req));
    return { ok: true };
  },
  /* ---------- pipeline switches (owner only) ---------- */
  async pipelineGet({ req, s }) {
    needOwner(s);
    const st = await PL.pipeSettings();
    const ev = await q('select id, type, note, at from aio.stripe_events order by at desc limit 20');
    const ws = await q('select status, count(*)::int as n from aio.welcome_sends group by status');
    return {
      accountsOn: st.accountsOn, welcomeOn: st.welcomeOn, rewardsOn: st.rewardsOn, hasWhsec: Boolean(st.whsec_enc), hasStripeKey: Boolean(st.stripeKey_enc),
      rewardCoupon: st.rewardCoupon, welcome: st.welcome, webhookUrl: `${baseOf(req)}/in/stripe`, events: ev.rows,
      welcomeCounts: Object.fromEntries(ws.rows.map((x) => [x.status, x.n])),
    };
  },
  async pipelineSet({ req, s, body }) {
    needOwner(s); needCleared(s);
    const patch = { baseUrl: baseOf(req) };
    for (const k of ['accountsOn', 'welcomeOn', 'rewardsOn']) if (body[k] !== undefined) patch[k] = Boolean(body[k]);
    if (body.welcome !== undefined) patch.welcome = PL.cleanWelcome(body.welcome);
    if (body.whsec !== undefined) {
      const v = String(body.whsec || '').trim();
      if (v && !/^whsec_[A-Za-z0-9]{16,}$/.test(v)) fail(400, 'BAD', 'The signing secret starts with whsec_. Copy it from the webhook page in Stripe.');
      patch.whsec_enc = v ? encrypt(v) : '';
    }
    if (body.stripeKey !== undefined) {
      const v = String(body.stripeKey || '').trim();
      if (v && !/^(rk|sk)_(live|test)_[A-Za-z0-9]{16,}$/.test(v)) fail(400, 'BAD', 'That is not a Stripe key. It starts with rk_live_ (best: a restricted key).');
      patch.stripeKey_enc = v ? encrypt(v) : '';
    }
    if (body.rewardCoupon !== undefined) {
      const v = String(body.rewardCoupon || '').trim();
      if (v && !/^[A-Za-z0-9_-]{2,60}$/.test(v)) fail(400, 'BAD', 'Type the coupon ID from Stripe, like FREEMONTH.');
      patch.rewardCoupon = v;
    }
    if ((patch.accountsOn || patch.welcomeOn) && !(await PL.pipeSettings()).whsec_enc && !patch.whsec_enc) fail(400, 'BAD', 'Save the Stripe signing secret first.');
    await PL.savePipeSettings(patch);
    await audit(s, 'pipeline.settings', Object.keys(patch).filter((k) => k !== 'baseUrl').map((k) => (k.endsWith('_enc') ? k.replace('_enc', '') + (patch[k] ? ' saved' : ' removed') : typeof patch[k] === 'boolean' ? `${k}=${patch[k]}` : k)).join(', '), ipOf(req));
    return { ok: true };
  },
  async welcomeTest({ req, s, body }) {
    needOwner(s);
    const to = CRM.cleanEmail(body.to);
    if (!to) fail(400, 'BAD', 'Type the email address for the test.');
    const i = Math.max(0, Math.min(2, Number(body.step) || 0));
    const st = await PL.pipeSettings(); const crm = await CRM.crmSettings();
    const mail = PL.renderWelcome(st.welcome[i], { id: 0, email: to, name: s.name || s.username, plan: 'starter', ref_code: 'sample1234', contact_id: null }, baseOf(req), crm.footer || '(Your business name and mailing address go here)', 'test-link-does-not-work');
    try { await CRM.callLrr('send', { key: 'wtest-' + token(8), ...mail, subject: '[Test] ' + mail.subject, test: true }, 70000); }
    catch (e) { fail(400, 'LINK', e.message); }
    await audit(s, 'pipeline.welcome_test', `email ${i + 1} -> ${to}`, ipOf(req));
    return { ok: true };
  },
  async customerList({ s }) {
    needOwner(s);
    const r = await q(`select u.id, u.username, u.name, u.email, u.plan, u.disabled, u.created_at, u.ref_code, (u.claim_hash is null and not u.must_change) as claimed,
      (select count(*)::int from aio.tickets t where t.user_id = u.id and t.status = 'open') as open_tickets
      from aio.users u where u.is_customer order by u.id desc limit 500`);
    const ref = await q(`select f.id, f.friend_email, f.status, f.note, f.created_at, f.given_at, u.email as referrer_email, u.username as referrer
      from aio.referrals f join aio.users u on u.id = f.referrer_id order by f.id desc limit 200`);
    return { customers: r.rows, referrals: ref.rows };
  },
  async customerLink({ req, s, body }) {
    needOwner(s); needCleared(s);
    const r = await q('select id, email from aio.users where id = $1 and is_customer', [Number(body.userId)]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Customer not found');
    const t = await PL.newClaim(r.rows[0].id);
    await audit(s, 'customer.link', r.rows[0].email, ipOf(req));
    return { link: `${baseOf(req)}/welcome/${t}`, email: r.rows[0].email };
  },
  async referralMark({ req, s, body }) {
    needOwner(s);
    const r = await q("update aio.referrals set status = 'given', given_at = now(), note = 'Marked given by ' || $2 where id = $1 and status <> 'given' returning friend_email", [Number(body.id), s.username]);
    if (!r.rowCount) fail(404, 'NOTFOUND', 'Reward not found or already given');
    await audit(s, 'referral.given', r.rows[0].friend_email, ipOf(req));
    return { ok: true };
  },

  /* ---------- contacts and email campaigns ---------- */
  async contactList({ s, body }) {
    needSection(s, 'contacts', 'viewer');
    const where = ['true']; const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', '$' + params.length)); };
    const search = String(body.search || '').trim().slice(0, 80);
    if (search) add("(email ilike $? or name ilike $? or company ilike $?)".replace(/\$\?/g, '$' + (params.length + 1)), '%' + search.replace(/[%_\\]/g, '\\$&') + '%');
    if (body.tag) add('$? = any(tags)', String(body.tag));
    if (['subscribed', 'unsubscribed'].includes(body.status)) add('status = $?', body.status);
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50)); const offset = Math.max(0, Number(body.offset) || 0);
    const r = await q(`select id, email, name, company, phone, tags, score, status, source, created_at, last_seen, count(*) over()::int as total
      from aio.contacts where ${where.join(' and ')} order by coalesce(last_seen, created_at) desc, id desc limit ${limit} offset ${offset}`, params);
    const tags = await q('select t, count(*)::int as n from aio.contacts, unnest(tags) t group by t order by n desc, t limit 100');
    const counts = await q("select count(*)::int as all, count(*) filter (where status = 'subscribed')::int as subscribed from aio.contacts");
    return { contacts: r.rows.map(({ total, ...x }) => x), total: r.rows[0]?.total || 0, tags: tags.rows, counts: counts.rows[0] };
  },
  async contactGet({ s, body }) {
    needSection(s, 'contacts', 'viewer');
    const r = await q('select * from aio.contacts where id = $1', [Number(body.id)]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Contact not found');
    const ev = await q('select kind, detail, at from aio.contact_events where contact_id = $1 order by id desc limit 100', [Number(body.id)]);
    return { contact: r.rows[0], events: ev.rows };
  },
  async contactSave({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    const c = await CRM.saveContact(body, s.username);
    await audit(s, body.id ? 'contact.edit' : 'contact.add', c.email, ipOf(req));
    return { contact: c };
  },
  async contactDelete({ req, s, body }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter(Boolean).slice(0, 500);
    const r = await q('delete from aio.contacts where id = any($1) returning email', [ids]);
    await audit(s, 'contact.delete', r.rows.map((x) => x.email).join(', '), ipOf(req));
    return { deleted: r.rowCount };
  },
  async contactImport({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    if (String(body.csv || '').length > 5 * 1024 * 1024) fail(400, 'BAD', 'The file is too big (5 MB most).');
    const r = await CRM.importCsv(body.csv, s.username);
    await audit(s, 'contact.import', `${r.added} added, ${r.updated} updated, ${r.bad} bad`, ipOf(req));
    return r;
  },
  async contactExport({ req, s }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    await audit(s, 'contact.export', 'CSV download', ipOf(req));
    return { csv: await CRM.exportCsv() };
  },
  async crmGet({ s }) {
    needSection(s, 'contacts', 'viewer');
    const st = await CRM.crmSettings();
    return { url: st.url, linked: Boolean(st.url && st.secret_enc), hasSecret: Boolean(st.secret_enc), footer: st.footer, dailyLimit: st.dailyLimit, lastPing: st.lastPing, lastPingOk: st.lastPingOk, sentToday: await CRM.sentToday() };
  },
  async crmSet({ req, s, body }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    const patch = {};
    if (body.url !== undefined) patch.url = CRM.checkLinkUrl(body.url);
    if (body.footer !== undefined) patch.footer = String(body.footer || '').trim().slice(0, 500);
    if (body.dailyLimit !== undefined) patch.dailyLimit = Math.max(1, Math.min(2000, Math.round(Number(body.dailyLimit) || 300)));
    await CRM.saveCrmSettings(patch);
    await audit(s, 'crm.settings', Object.keys(patch).join(', '), ipOf(req));
    return { ok: true };
  },
  async crmNewSecret({ req, s }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    const secret = 'frb_' + token(32);
    await CRM.saveCrmSettings({ secret_enc: encrypt(secret), lastPing: '', lastPingOk: false });
    await audit(s, 'crm.secret', 'New LeadReplyRadar link secret', ipOf(req));
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    await putHandover('LeadReplyRadar', 'FRB_SECRET', secret, 'Put on Render: LeadReplyRadar > Environment.', 'contacts link', s.username);
    await putHandover('LeadReplyRadar', 'FRB_URL', base, 'Put on Render: LeadReplyRadar > Environment.', 'contacts link', s.username);
    return { secret, frbUrl: base, handover: true };
  },
  async crmPing({ s }) {
    needSection(s, 'contacts', 'developer');
    try {
      const r = await CRM.callLrr('ping', {}, 70000);
      await CRM.saveCrmSettings({ lastPing: new Date().toISOString(), lastPingOk: true });
      return { ok: true, from: r.from || '', sentToday: r.sentToday, dailyLimit: r.dailyLimit };
    } catch (e) {
      await CRM.saveCrmSettings({ lastPing: new Date().toISOString(), lastPingOk: false });
      fail(400, 'LINK', e.message);
    }
  },
  async campaignList({ s }) {
    needSection(s, 'contacts', 'viewer');
    const r = await q(`select c.id, c.name, c.subject, c.status, c.tag, c.min_score, c.created_at, c.started_at, c.finished_at, c.last_error, c.next_try,
      count(x.*) filter (where x.status = 'sent')::int as sent, count(x.*)::int as total
      from aio.campaigns c left join aio.campaign_sends x on x.campaign_id = c.id group by c.id order by c.id desc`);
    return { campaigns: r.rows };
  },
  async campaignGet({ s, body }) {
    needSection(s, 'contacts', 'viewer');
    const r = await q('select * from aio.campaigns where id = $1', [Number(body.id)]);
    const c = r.rows[0];
    if (!c) fail(404, 'NOTFOUND', 'Campaign not found');
    const recent = await q(`select p.email, x.status, x.error, x.at from aio.campaign_sends x join aio.contacts p on p.id = x.contact_id
      where x.campaign_id = $1 and x.status <> 'queued' order by x.at desc nulls last limit 100`, [c.id]);
    return { campaign: c, counts: await CRM.campaignCounts(c.id), audience: c.status === 'draft' ? await CRM.audienceCount(c.tag, c.min_score) : null, recent: recent.rows };
  },
  async campaignCount({ s, body }) {
    needSection(s, 'contacts', 'viewer');
    return { count: await CRM.audienceCount(body.tag, body.minScore) };
  },
  async campaignSave({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    const vals = [String(body.name || '').trim().slice(0, 100) || 'Campaign', String(body.subject || '').trim().slice(0, 200), String(body.body || '').slice(0, 20000), String(body.tag || '').trim().toLowerCase().slice(0, 30), Math.max(0, Math.min(100, Number(body.minScore) || 0))];
    let r;
    if (body.id) {
      r = await q("update aio.campaigns set name=$2, subject=$3, body=$4, tag=$5, min_score=$6 where id=$1 and status = 'draft' returning id", [Number(body.id), ...vals]);
      if (!r.rowCount) fail(400, 'BAD', 'Only a draft can be changed. Make a copy instead.');
    } else r = await q('insert into aio.campaigns (name, subject, body, tag, min_score, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [...vals, s.username]);
    await audit(s, 'campaign.save', vals[0], ipOf(req));
    return { id: r.rows[0].id };
  },
  async campaignCopy({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    const r = await q("insert into aio.campaigns (name, subject, body, tag, min_score, created_by) select name || ' (copy)', subject, body, tag, min_score, $2 from aio.campaigns where id = $1 returning id", [Number(body.id), s.username]);
    if (!r.rowCount) fail(404, 'NOTFOUND', 'Campaign not found');
    return { id: r.rows[0].id };
  },
  async campaignDelete({ req, s, body }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    const r = await q("delete from aio.campaigns where id = $1 and status in ('draft','done') returning name", [Number(body.id)]);
    if (!r.rowCount) fail(400, 'BAD', 'Stop the campaign before deleting it.');
    await audit(s, 'campaign.delete', r.rows[0].name, ipOf(req));
    return { ok: true };
  },
  async campaignTest({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    const to = CRM.cleanEmail(body.to);
    if (!to) fail(400, 'BAD', 'Type the email address for the test.');
    const r = await q('select * from aio.campaigns where id = $1', [Number(body.id)]);
    const c = r.rows[0];
    if (!c) fail(404, 'NOTFOUND', 'Campaign not found');
    if (!c.subject.trim() || !c.body.trim()) fail(400, 'BAD', 'Write the subject and the email first.');
    const st = await CRM.crmSettings();
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    const mail = CRM.render(c, { id: 0, email: to, name: s.name || s.username, company: '' }, base, st.footer || '(Your business name and mailing address go here)');
    try { await CRM.callLrr('send', { key: 'test-' + token(8), ...mail, subject: '[Test] ' + mail.subject, test: true }, 70000); }
    catch (e) { fail(400, 'LINK', e.message); }
    await audit(s, 'campaign.test', `${c.name} -> ${to}`, ipOf(req));
    return { ok: true };
  },
  async campaignStart({ req, s, body }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    const st = await CRM.crmSettings();
    if (!st.url || !st.secret_enc) fail(400, 'BAD', 'Connect LeadReplyRadar first (Contacts > Connection).');
    if (!String(st.footer || '').trim()) fail(400, 'BAD', 'Add your business name and mailing address in Contacts > Connection first. The law (CAN-SPAM) needs it in marketing emails.');
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    const out = await tx(async (cl) => {
      const r = await cl.query("select * from aio.campaigns where id = $1 and status = 'draft' for update", [Number(body.id)]);
      const c = r.rows[0];
      if (!c) fail(400, 'BAD', 'Only a draft can be started.');
      if (!c.subject.trim() || !c.body.trim()) fail(400, 'BAD', 'Write the subject and the email first.');
      const w = CRM.audienceWhere(c.tag, c.min_score, 2);
      const w1 = CRM.audienceWhere(c.tag, c.min_score, 1);
      const n = await cl.query(`select count(*)::int as n from aio.contacts where ${w1.sql}`, w1.params);
      const count = n.rows[0].n;
      if (!count) fail(400, 'BAD', 'Nobody matches who this campaign is for.');
      if (count > 2000) fail(400, 'BAD', `This would go to ${count} people. 2000 is the most for one campaign.`);
      if (Number(body.confirmCount) !== count) fail(409, 'COUNT', `The number of people changed to ${count}. Check and press Start again.`);
      await cl.query(`insert into aio.campaign_sends (campaign_id, contact_id) select $1, id from aio.contacts where ${w.sql}`, [c.id, ...w.params]);
      await cl.query("update aio.campaigns set status = 'sending', started_at = now(), base_url = $2, last_error = null, next_try = null where id = $1", [c.id, base]);
      return { name: c.name, count };
    });
    CRM.startEngine();
    await audit(s, 'campaign.start', `${out.name}: ${out.count} people`, ipOf(req));
    return { ok: true, count: out.count };
  },
  async campaignPause({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    await q("update aio.campaigns set status = 'paused' where id = $1 and status = 'sending'", [Number(body.id)]);
    await audit(s, 'campaign.pause', String(body.id), ipOf(req));
    return { ok: true };
  },
  async campaignResume({ req, s, body }) {
    needSection(s, 'contacts', 'admin'); needCleared(s);
    await q("update aio.campaigns set status = 'sending', next_try = null where id = $1 and status = 'paused'", [Number(body.id)]);
    CRM.startEngine();
    await audit(s, 'campaign.resume', String(body.id), ipOf(req));
    return { ok: true };
  },
  async campaignStop({ req, s, body }) {
    needSection(s, 'contacts', 'developer');
    await q("update aio.campaign_sends set status = 'skipped', error = 'Campaign stopped' where campaign_id = $1 and status = 'queued'", [Number(body.id)]);
    await q("update aio.campaigns set status = 'done', finished_at = now(), next_try = null where id = $1 and status in ('sending','paused')", [Number(body.id)]);
    await audit(s, 'campaign.stop', String(body.id), ipOf(req));
    return { ok: true };
  },
  /* ---- repos ---- */
  async repoList({ s }) {
    const r = await q('select r.id, r.name, r.description, r.created_at, c.at as updated_at, c.message as last_message from aio.repos r left join aio.commits c on c.id = r.head order by r.name');
    const out = [];
    for (const row of r.rows) { const l = await resourceLevel(s, 'repo', row.id); if (l >= 1) out.push({ ...row, level: LEVELS[l] }); }
    return { repos: out, canCreate: sectionLevel(s, 'repos') >= 2 };
  },
  async repoCreate({ req, s, body }) {
    needSection(s, 'repos', 'developer');
    const name = String(body.name || '').trim();
    if (!/^[A-Za-z0-9._-]{2,60}$/.test(name)) fail(400, 'BAD', 'Repo name: 2 to 60 letters, numbers, dot, dash or underscore.');
    const r = await q('insert into aio.repos (name, description, created_by) values ($1,$2,$3) on conflict do nothing returning id', [name, body.description || '', s.username]);
    if (!r.rows[0]) fail(400, 'BAD', 'That repo name is taken.');
    if (body.readme !== false) await writeCommit(r.rows[0].id, s.username, 'First commit', [{ path: 'README.md', data: Buffer.from(`# ${name}\n\n${body.description || ''}\n`) }]);
    await audit(s, 'repo.create', name, ipOf(req));
    return { id: r.rows[0].id };
  },
  async repoUpdate({ req, s, body }) {
    await needResource(s, 'repo', body.repoId, 'admin');
    await q('update aio.repos set description = $2 where id = $1', [body.repoId, String(body.description || '')]);
    await audit(s, 'repo.update', 'repo ' + body.repoId, ipOf(req));
    return { ok: true };
  },
  async repoDelete({ req, s, body }) {
    await needResource(s, 'repo', body.repoId, 'admin'); needCleared(s);
    const repo = await getRepo(body.repoId);
    if (body.confirm !== repo.name) fail(400, 'BAD', 'Type the repo name to delete it.');
    await q('delete from aio.repos where id = $1', [repo.id]);
    await q("delete from aio.secrets where scope = 'repo' and scope_id = $1", [repo.id]);
    await q("delete from aio.grants where kind = 'repo' and resource_id = $1", [repo.id]);
    await audit(s, 'repo.delete', repo.name, ipOf(req));
    return { ok: true };
  },
  async fileList({ s, body }) {
    await needResource(s, 'repo', body.repoId, 'viewer');
    const repo = await getRepo(body.repoId);
    const tree = body.commitId ? (await commitOf(repo.id, body.commitId)).tree : await treeOf(repo);
    return { files: Object.entries(tree).map(([path, [h, size]]) => ({ path, size, h })).sort((a, b) => a.path.localeCompare(b.path)), head: repo.head, level: LEVELS[await resourceLevel(s, 'repo', repo.id)] };
  },
  async fileGet({ s, body }) {
    await needResource(s, 'repo', body.repoId, 'viewer');
    const repo = await getRepo(body.repoId);
    if (body.h) return fileOut(getBlob(body.h));
    const tree = await treeOf(repo);
    const e = tree[cleanPath(body.path)];
    if (!e) fail(404, 'NOTFOUND', 'File not found');
    return { ...fileOut(getBlob(e[0])), h: e[0] };
  },
  async commit({ req, s, body }) {
    await needResource(s, 'repo', body.repoId, 'developer');
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) fail(400, 'BAD', 'Nothing to save');
    if (files.length > 500) fail(400, 'BAD', 'Up to 500 files at a time');
    const changes = files.map((f) => (f.remove ? { path: f.path, remove: true } : { path: f.path, data: decodeIncoming(f) }));
    const out = await writeCommit(body.repoId, s.username, body.message, changes);
    if (!out.nothing) {
      await audit(s, 'repo.commit', `repo ${body.repoId} commit ${out.commit}: ${String(body.message || '').slice(0, 100)}`, ipOf(req));
      fireHooks('commit', { repo: body.repoId, commit: out.commit, by: s.username, message: body.message || '' }).catch(() => {});
    }
    return out;
  },
  async history({ s, body }) {
    await needResource(s, 'repo', body.repoId, 'viewer');
    const r = await q('select id, parent, message, author, at, changed from aio.commits where repo_id = $1 order by id desc limit 200', [body.repoId]);
    return { commits: r.rows.map((c) => ({ ...c, changed: c.changed.map((x) => ({ path: x.path, op: x.op, before: x.before, after: x.after })) })) };
  },
  /* ---- keys and values (repo, project, global) ---- */
  async secretList({ s, body }) {
    await scopeCheck(s, body.scope, body.scopeId || 0, 'viewer');
    return { secrets: await secretsList(body.scope, body.scopeId || 0) };
  },
  async secretSet({ req, s, body }) {
    await scopeCheck(s, body.scope, body.scopeId || 0, 'developer');
    const key = String(body.key || '').trim();
    if (!SECRET_KEY.test(key)) fail(400, 'BAD', 'Key: letters, numbers, _ . - and it starts with a letter or _.');
    await q(`insert into aio.secrets (scope, scope_id, key, value_enc, updated_by) values ($1,$2,$3,$4,$5)
      on conflict (scope, scope_id, key) do update set value_enc = excluded.value_enc, updated_at = now(), updated_by = excluded.updated_by`,
    [body.scope, body.scopeId || 0, key, encrypt(String(body.value ?? '')), s.username]);
    await audit(s, 'secret.set', `${body.scope} ${body.scopeId || 0}: ${key}`, ipOf(req));
    return { ok: true };
  },
  async secretReveal({ req, s, body }) {
    await scopeCheck(s, body.scope, body.scopeId || 0, 'admin'); needCleared(s);
    const r = await q('select value_enc from aio.secrets where scope = $1 and scope_id = $2 and key = $3', [body.scope, body.scopeId || 0, body.key]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Not found');
    await audit(s, 'secret.reveal', `${body.scope} ${body.scopeId || 0}: ${body.key}`, ipOf(req));
    return { value: decrypt(r.rows[0].value_enc) };
  },
  async secretDelete({ req, s, body }) {
    await scopeCheck(s, body.scope, body.scopeId || 0, 'admin'); needCleared(s);
    await q('delete from aio.secrets where scope = $1 and scope_id = $2 and key = $3', [body.scope, body.scopeId || 0, body.key]);
    await audit(s, 'secret.delete', `${body.scope} ${body.scopeId || 0}: ${body.key}`, ipOf(req));
    return { ok: true };
  },
  /* ---- deploys ---- */
  async siteList({ req, s }) {
    needRend(s);
    const r = await q('select s.*, r.name as repo_name, r.head as repo_head from aio.sites s left join aio.repos r on r.id = s.repo_id order by s.slug');
    const out = [];
    for (const site of r.rows) {
      const l = await resourceLevel(s, 'site', site.id);
      if (l < 1) continue;
      out.push({
        id: site.id, slug: site.slug, repoId: site.repo_id, repoName: site.repo_name, folder: site.folder, visibility: site.visibility,
        expiresAt: site.expires_at, commitId: site.commit_id, behind: site.repo_head && site.repo_head !== site.commit_id,
        link: await siteLink(req, site), level: LEVELS[l],
      });
    }
    return { sites: out, canCreate: sectionLevel(s, 'deploys') >= 2 };
  },
  async siteCreate({ req, s, body }) {
    needRend(s);
    needSection(s, 'deploys', 'developer');
    await needResource(s, 'repo', body.repoId, 'viewer');
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SITE_SLUG.test(slug)) fail(400, 'BAD', 'Link name: 2 to 41 small letters, numbers or dashes.');
    const vis = ['public', 'key', 'clearance'].includes(body.visibility) ? body.visibility : 'clearance';
    const folder = body.folder ? cleanPath(body.folder) + '/' : '';
    const r = await q('insert into aio.sites (slug, repo_id, folder, visibility, key_enc, created_by) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id',
      [slug, body.repoId, folder, vis, encrypt(token(18)), s.username]);
    if (!r.rows[0]) fail(400, 'BAD', 'That link name is taken.');
    await audit(s, 'site.create', slug, ipOf(req));
    return { id: r.rows[0].id };
  },
  async siteDeploy({ req, s, body }) {
    needRend(s);
    await needResource(s, 'site', body.siteId, 'developer'); needCleared(s);
    const r = await q('select s.*, r.head from aio.sites s join aio.repos r on r.id = s.repo_id where s.id = $1', [body.siteId]);
    const site = r.rows[0];
    if (!site) fail(404, 'NOTFOUND', 'Site or its repo not found');
    const commitId = body.commitId ? (await commitOf(site.repo_id, body.commitId)).id : site.head;
    if (!commitId) fail(400, 'BAD', 'The repo has no files yet.');
    await deploySite(site, commitId, s.username, body.commitId ? 'Rollback' : 'Deploy');
    await audit(s, 'site.deploy', `${site.slug} commit ${commitId}`, ipOf(req));
    return { ok: true, commitId };
  },
  async siteDeploys({ s, body }) {
    needRend(s);
    await needResource(s, 'site', body.siteId, 'viewer');
    const r = await q('select d.*, c.message from aio.deploys d left join aio.commits c on c.id = d.commit_id where site_id = $1 order by d.id desc limit 50', [body.siteId]);
    return { deploys: r.rows };
  },
  async siteUpdate({ req, s, body }) {
    needRend(s);
    await needResource(s, 'site', body.siteId, 'admin'); needCleared(s);
    const vis = ['public', 'key', 'clearance'].includes(body.visibility) ? body.visibility : null;
    if (!vis) fail(400, 'BAD', 'Pick who can open the link');
    const exp = body.expiresAt ? new Date(body.expiresAt) : null;
    if (exp && isNaN(exp)) fail(400, 'BAD', 'Bad expiry date');
    await q('update aio.sites set visibility = $2, expires_at = $3, folder = $4 where id = $1', [body.siteId, vis, exp, body.folder ? cleanPath(body.folder) + '/' : '']);
    if (body.newKey) await q('update aio.sites set key_enc = $2 where id = $1', [body.siteId, encrypt(token(18))]);
    await audit(s, 'site.update', `site ${body.siteId}: ${vis}${exp ? ' until ' + exp.toISOString() : ''}${body.newKey ? ', new key' : ''}`, ipOf(req));
    return { ok: true };
  },
  async siteDelete({ req, s, body }) {
    needRend(s);
    await needResource(s, 'site', body.siteId, 'admin'); needCleared(s);
    await q('delete from aio.sites where id = $1', [body.siteId]);
    await q("delete from aio.grants where kind = 'site' and resource_id = $1", [body.siteId]);
    await audit(s, 'site.delete', 'site ' + body.siteId, ipOf(req));
    return { ok: true };
  },
  async siteQr({ req, s, body }) {
    needRend(s);
    await needResource(s, 'site', body.siteId, 'viewer');
    const r = await q('select * from aio.sites where id = $1', [body.siteId]);
    return { qr: await QRCode.toDataURL(await siteLink(req, r.rows[0]), { margin: 1, width: 240 }) };
  },
  /* ---- database projects ---- */
  async projectList({ req, s }) {
    const r = await q('select id, slug, name, cors, created_at from aio.projects order by slug');
    const out = [];
    for (const p of r.rows) { const l = await resourceLevel(s, 'project', p.id); if (l >= 1) out.push({ ...p, level: LEVELS[l] }); }
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    return { projects: out, base, canCreate: sectionLevel(s, 'database') >= 3 };
  },
  async projectCreate({ req, s, body }) {
    needSection(s, 'database', 'admin'); needCleared(s);
    const p = await P.createProject(String(body.slug || '').trim(), body.name, s.username);
    await audit(s, 'project.create', p.slug, ipOf(req));
    return { id: p.id };
  },
  async projectDelete({ req, s, body }) {
    await needResource(s, 'project', body.projectId, 'admin'); needCleared(s);
    const p = await P.getProject(body.projectId);
    if (body.confirm !== p.slug) fail(400, 'BAD', 'Type the project name to delete it.');
    await P.deleteProject(p);
    await q("delete from aio.secrets where scope = 'project' and scope_id = $1", [p.id]);
    await q("delete from aio.grants where kind = 'project' and resource_id = $1", [p.id]);
    await audit(s, 'project.delete', p.slug, ipOf(req));
    return { ok: true };
  },
  async dbTables({ s, body }) {
    await needResource(s, 'project', body.projectId, 'viewer');
    return { tables: await P.tables(await P.getProject(body.projectId)) };
  },
  async dbTable({ s, body }) {
    await needResource(s, 'project', body.projectId, 'viewer');
    const p = await P.getProject(body.projectId);
    return { columns: await P.columns(p, body.table), data: await P.rows(p, body.table, 100, body.offset || 0) };
  },
  async dbQuery({ req, s, body }) {
    const l = await resourceLevel(s, 'project', body.projectId);
    if (l < 2 && !(s.ai && l >= 1)) fail(403, 'LEVEL', 'You need developer clearance on this project to run SQL.');
    const aiWrite = s.ai && s.levels.database === 'developer';
    const readOnly = (l < 3 && !aiWrite) || body.readOnly;
    if (!readOnly && !s.ai) needCleared(s);
    const sql = String(body.sql || '').trim();
    if (!sql) fail(400, 'BAD', 'Type some SQL first');
    const p = await P.getProject(body.projectId);
    const t0 = Date.now();
    const results = await P.runSql(p, sql, readOnly);
    await audit(s, readOnly ? 'sql.read' : 'sql.run', `${p.slug}: ${sql.slice(0, 300)}`, ipOf(req));
    return { results, readOnly, ms: Date.now() - t0 };
  },
  async dbPolicies({ s, body }) {
    await needResource(s, 'project', body.projectId, 'viewer');
    return { policies: await P.policies(await P.getProject(body.projectId)) };
  },
  async dbChange({ req, s, body }) {
    // policy create/drop, row security on/off, public key access. Preview returns the SQL only.
    await needResource(s, 'project', body.projectId, 'admin');
    const p = await P.getProject(body.projectId);
    const t = body.table;
    if (!P.IDENT.test(t || '')) fail(400, 'BAD', 'Pick a table');
    let sql;
    if (body.kind === 'policy') sql = P.policySql(p, body);
    else if (body.kind === 'drop') sql = `drop policy ${'"' + String(body.name).replace(/"/g, '""') + '"'} on public."${t}"`;
    else if (body.kind === 'rls') sql = `alter table public."${t}" ${body.on ? 'enable' : 'disable'} row level security`;
    else if (body.kind === 'access') sql = P.publicAccessSql(p, t, body.access);
    else fail(400, 'BAD', 'Unknown change');
    if (body.preview) return { sql };
    needCleared(s);
    await P.runSql(p, sql, false);
    await audit(s, 'db.change', `${p.slug}: ${sql.slice(0, 300)}`, ipOf(req));
    return { ok: true, sql };
  },
  async projectApi({ req, s, body }) {
    await needResource(s, 'project', body.projectId, 'viewer');
    const p = await P.getProject(body.projectId);
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    return { url: `${base}/db/${p.slug}/rest`, cors: p.cors };
  },
  async projectKeys({ req, s, body }) {
    await needResource(s, 'project', body.projectId, 'admin'); needCleared(s);
    const p = await P.getProject(body.projectId);
    if (body.regenerate) { await P.newKeys(p, body.regenerate === 'service' ? 'service' : 'anon'); await audit(s, 'project.new_key', `${p.slug}: ${body.regenerate}`, ipOf(req)); }
    const fresh = await P.getProject(body.projectId);
    await audit(s, 'project.keys_shown', p.slug, ipOf(req));
    return { anon: decrypt(fresh.anon_enc), service: decrypt(fresh.service_enc) };
  },
  async projectCors({ req, s, body }) {
    await needResource(s, 'project', body.projectId, 'admin');
    const list = String(body.cors || '*').split(/[\s,]+/).filter(Boolean);
    for (const o of list) if (o !== '*' && !/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) fail(400, 'BAD', 'Bad address: ' + o);
    await q('update aio.projects set cors = $2 where id = $1', [body.projectId, list.join(' ') || '*']);
    await audit(s, 'project.cors', list.join(' '), ipOf(req));
    return { ok: true };
  },
  async projectHandover({ req, s, body }) {
    await needResource(s, 'project', body.projectId, 'admin'); needCleared(s);
    needSection(s, 'handover', 'developer');
    const p = await P.getProject(body.projectId);
    const which = body.which === 'service' ? 'service' : 'anon';
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    const app = String(body.app || p.slug).trim().slice(0, 60) || p.slug;
    await putHandover(app, which === 'service' ? 'DB_SECRET_KEY' : 'DB_PUBLIC_KEY', decrypt(which === 'service' ? p.service_enc : p.anon_enc),
      (which === 'service' ? 'Full access. Servers only. ' : 'Safe in web pages. ') + 'API: ' + `${base}/db/${p.slug}/rest`, 'database ' + p.slug, s.username);
    await putHandover(app, 'DB_URL', `${base}/db/${p.slug}/rest`, 'Base room API address for ' + p.slug, 'database ' + p.slug, s.username);
    await audit(s, 'handover.from_project', `${p.slug}: ${which} key to ${app}`, ipOf(req));
    return { ok: true, app };
  },
  /* ---- handover room: keys and values other apps need ---- */
  async handoverList({ s }) {
    needSection(s, 'handover', 'viewer');
    const r = await q('select id, app, name, note, source, updated_at, updated_by from aio.handover order by lower(app), lower(name)');
    return { items: r.rows, canEdit: sectionLevel(s, 'handover') >= 2, canAdmin: sectionLevel(s, 'handover') >= 3 };
  },
  async handoverSave({ req, s, body }) {
    needSection(s, 'handover', 'developer');
    const app = String(body.app || '').trim().slice(0, 60);
    const name = String(body.name || '').trim();
    if (!app) fail(400, 'BAD', 'Type the app this is for.');
    if (!SECRET_KEY.test(name)) fail(400, 'BAD', 'Name: letters, numbers, _ . - and it starts with a letter or _.');
    const note = String(body.note || '').trim().slice(0, 300);
    if (body.id) {
      const old = await q('select * from aio.handover where id = $1', [body.id]);
      if (!old.rows[0]) fail(404, 'NOTFOUND', 'Not found');
      if (body.value !== undefined && body.value !== null) {
        needCleared(s);
        await q('update aio.handover set app = $2, name = $3, note = $4, value_enc = $5, updated_at = now(), updated_by = $6 where id = $1', [body.id, app, name, note, encrypt(String(body.value)), s.username]);
      } else {
        await q('update aio.handover set app = $2, name = $3, note = $4, updated_at = now(), updated_by = $5 where id = $1', [body.id, app, name, note, s.username]);
      }
      await audit(s, 'handover.update', `${app}: ${name}${body.value != null ? ' (new value)' : ''}`, ipOf(req));
      return { ok: true };
    }
    if (body.value === undefined || body.value === null || body.value === '') fail(400, 'BAD', 'Type or make a value first.');
    const r = await q("insert into aio.handover (app, name, note, value_enc, source, updated_by) values ($1,$2,$3,$4,'manual',$5) on conflict do nothing returning id", [app, name, note, encrypt(String(body.value)), s.username]);
    if (!r.rows[0]) fail(400, 'BAD', `${app} already has ${name}. Change that one instead.`);
    await audit(s, 'handover.add', `${app}: ${name}`, ipOf(req));
    return { id: r.rows[0].id };
  },
  async handoverReveal({ req, s, body }) {
    needSection(s, 'handover', 'admin'); needCleared(s);
    const r = await q('select app, name, value_enc from aio.handover where id = $1', [body.id]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Not found');
    await audit(s, 'handover.reveal', `${r.rows[0].app}: ${r.rows[0].name}`, ipOf(req));
    return { value: decrypt(r.rows[0].value_enc) };
  },
  async handoverDelete({ req, s, body }) {
    needSection(s, 'handover', 'admin'); needCleared(s);
    const r = await q('delete from aio.handover where id = $1 returning app, name', [body.id]);
    if (r.rows[0]) await audit(s, 'handover.delete', `${r.rows[0].app}: ${r.rows[0].name}`, ipOf(req));
    return { ok: true };
  },
  /* ---- DNS room: your own domain for a Rend site, in 2 steps ---- */
  async dnsList({ req, s }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner goes into the DNS room.');
    const r = await q('select d.id, d.name, d.site_id, d.points_here, d.seen_ips, d.checked_at, d.created_at, s.slug, s.visibility from aio.domains d left join aio.sites s on s.id = d.site_id order by d.name');
    const sites = await q('select id, slug, visibility from aio.sites order by slug');
    return { items: r.rows, sites: sites.rows, serverIp: await serverIp(req) };
  },
  async dnsAdd({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner goes into the DNS room.');
    needCleared(s);
    const name = cleanDomain(body.name);
    const own = hostName(req);
    if (name === own || name.endsWith('.sslip.io') || name.endsWith('.nip.io')) fail(400, 'BAD', 'That is this server\'s own address. Type a domain you bought, like mysite.com.');
    const site = await q('select id, slug from aio.sites where id = $1', [body.siteId]);
    if (!site.rows[0]) fail(400, 'BAD', 'Pick which site this domain should show.');
    const r = await q('insert into aio.domains (name, site_id, created_by) values ($1,$2,$3) on conflict (name) do nothing returning id', [name, site.rows[0].id, s.username]);
    if (!r.rows[0]) fail(400, 'BAD', 'That domain is already in the DNS room.');
    await audit(s, 'dns.add', `${name} to ${site.rows[0].slug}`, ipOf(req));
    return { id: r.rows[0].id, name, record: dnsRecord(name, await serverIp(req)) };
  },
  async dnsCheck({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner goes into the DNS room.');
    const r = await q('select id, name from aio.domains where id = $1', [body.id]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Domain not found');
    const want = await serverIp(req);
    let ips = [];
    try { ips = await dns.resolve4(r.rows[0].name); } catch {}
    const ok = !!want && ips.includes(want);
    await q('update aio.domains set points_here = $2, seen_ips = $3, checked_at = now() where id = $1', [body.id, ok, ips.join(', ')]);
    return { ok, ips, serverIp: want };
  },
  async dnsDelete({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner goes into the DNS room.');
    needCleared(s);
    const r = await q('delete from aio.domains where id = $1 returning name', [body.id]);
    if (r.rows[0]) await audit(s, 'dns.delete', r.rows[0].name, ipOf(req));
    return { ok: true };
  },
  /* ---- AI access: keys that only reach the Fit room and the Base room ---- */
  async aiKeyList({ s }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner can manage AI access.');
    const r = await q('select id, name, rooms, active, created_by, created_at, last_used from aio.ai_keys order by id');
    return { keys: r.rows };
  },
  async aiKeyCreate({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner can manage AI access.');
    needCleared(s);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) fail(400, 'BAD', 'Give the AI key a name, like the app or assistant that uses it.');
    const rooms = cleanAiRooms(body.rooms);
    if (!Object.keys(rooms).length) fail(400, 'BAD', 'Pick at least one room.');
    const key = 'frbai_' + token(32);
    const r = await q('insert into aio.ai_keys (name, key_hash, rooms, created_by) values ($1,$2,$3,$4) returning id', [name, sha256(key), JSON.stringify(rooms), s.username]);
    await putHandover('AI: ' + name, 'FRB_AI_KEY', key, 'Send as the header Authorization: Bearer <key>, with X-CC: 1, to POST /api.', 'ai key', s.username);
    await audit(s, 'ai.key_create', `${name}: ${JSON.stringify(rooms)}`, ipOf(req));
    return { id: r.rows[0].id, key, handover: true };
  },
  async aiKeyUpdate({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner can manage AI access.');
    needCleared(s);
    const sets = []; const params = [body.id];
    if (body.rooms !== undefined) { const rooms = cleanAiRooms(body.rooms); if (!Object.keys(rooms).length) fail(400, 'BAD', 'Pick at least one room.'); params.push(JSON.stringify(rooms)); sets.push('rooms = $' + params.length); }
    if (body.active !== undefined) { params.push(!!body.active); sets.push('active = $' + params.length); }
    if (!sets.length) fail(400, 'BAD', 'Nothing to change');
    await q(`update aio.ai_keys set ${sets.join(', ')} where id = $1`, params);
    await audit(s, 'ai.key_update', `key ${body.id}`, ipOf(req));
    return { ok: true };
  },
  async aiKeyDelete({ req, s, body }) {
    if (!s.is_owner) fail(403, 'OWNER_ONLY', 'Only the owner can manage AI access.');
    needCleared(s);
    const r = await q('delete from aio.ai_keys where id = $1 returning name', [body.id]);
    if (r.rows[0]) {
      await q('delete from aio.handover where app = $1 and name = $2', ['AI: ' + r.rows[0].name, 'FRB_AI_KEY']);
      await audit(s, 'ai.key_delete', r.rows[0].name, ipOf(req));
    }
    return { ok: true };
  },
  /* ---- connectors: webhooks out and in ---- */
  async hookList({ req, s }) {
    needSection(s, 'connectors', 'viewer');
    const out = await q('select id, name, url, events, active, last_status from aio.webhooks order by id');
    const inn = await q('select h.id, h.name, h.site_id, s.slug, h.last_used from aio.inhooks h left join aio.sites s on s.id = h.site_id order by h.id');
    return { out: out.rows, in: inn.rows };
  },
  async hookCreate({ req, s, body }) {
    needSection(s, 'connectors', 'developer');
    if (!/^https:\/\//.test(body.url || '')) fail(400, 'BAD', 'The address must start with https://');
    const events = String(body.events || 'deploy').split(',').map((x) => x.trim()).filter((x) => ['deploy', 'commit', 'signin'].includes(x));
    const secret = token(24);
    await q('insert into aio.webhooks (name, url, events, secret_enc) values ($1,$2,$3,$4)', [body.name || 'Webhook', body.url, events.join(',') || 'deploy', encrypt(secret)]);
    await audit(s, 'hook.out_create', body.url, ipOf(req));
    await putHandover(String(body.name || 'Webhook').slice(0, 60), 'WEBHOOK_SECRET', secret, 'Checks the X-FitRendBase-Signature header on messages to ' + String(body.url).slice(0, 150), 'webhook', s.username);
    return { secret, handover: true };
  },
  async hookToggle({ req, s, body }) {
    needSection(s, 'connectors', 'admin');
    await q('update aio.webhooks set active = $2 where id = $1', [body.id, !!body.active]);
    await audit(s, 'hook.out_toggle', `${body.id}: ${body.active ? 'on' : 'off'}`, ipOf(req));
    return { ok: true };
  },
  async hookDelete({ req, s, body }) {
    needSection(s, 'connectors', 'admin'); needCleared(s);
    await q(body.incoming ? 'delete from aio.inhooks where id = $1' : 'delete from aio.webhooks where id = $1', [body.id]);
    await audit(s, 'hook.delete', `${body.incoming ? 'in' : 'out'} ${body.id}`, ipOf(req));
    return { ok: true };
  },
  async hookTest({ req, s, body }) {
    needSection(s, 'connectors', 'developer');
    const r = await q('select * from aio.webhooks where id = $1', [body.id]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Not found');
    return { status: await fireHook(r.rows[0], { event: 'test', test: true, by: s.username }) };
  },
  async inhookCreate({ req, s, body }) {
    needSection(s, 'connectors', 'admin'); needRend(s);
    await needResource(s, 'site', body.siteId, 'developer');
    const t = 'ih_' + token(24);
    await q('insert into aio.inhooks (name, token_hash, token_enc, site_id) values ($1,$2,$3,$4)', [body.name || 'Deploy hook', sha256(t), encrypt(t), body.siteId]);
    await audit(s, 'hook.in_create', 'site ' + body.siteId, ipOf(req));
    const base = (isHttps(req) ? 'https://' : 'http://') + (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    await putHandover(String(body.name || 'Deploy hook').slice(0, 60), 'DEPLOY_HOOK_URL', `${base}/hooks/${t}`, 'The other app POSTs here to deploy a site.', 'deploy hook', s.username);
    return { url: `${base}/hooks/${t}`, handover: true };
  },
  /* ---- admin ---- */
  async userList({ s }) {
    needSection(s, 'admin', 'viewer');
    const r = await q('select id, username, name, is_owner, disabled, levels, totp_on, locked_until, created_at, (select max(last_seen) from aio.sessions where user_id = u.id) as last_seen from aio.users u order by id');
    const g = await q('select g.*, coalesce(r.name, st.slug, p.slug) as resource_name from aio.grants g left join aio.repos r on g.kind = $1 and r.id = g.resource_id left join aio.sites st on g.kind = $2 and st.id = g.resource_id left join aio.projects p on g.kind = $3 and p.id = g.resource_id order by g.id', ['repo', 'site', 'project']);
    return { users: r.rows, grants: g.rows };
  },
  async userCreate({ req, s, body }) {
    needSection(s, 'admin', 'admin'); needCleared(s);
    const name = String(body.username || '').trim();
    if (!USERNAME.test(name)) fail(400, 'BAD', 'User name: 3 to 40 letters, numbers, dot, dash or underscore.');
    const temp = token(9);
    const r = await q('insert into aio.users (username, name, pass_hash, levels, must_change) values ($1,$2,$3,$4,true) on conflict do nothing returning id',
      [name, body.name || name, hashPassword(temp), JSON.stringify(cleanLevels(body.levels, s))]);
    if (!r.rows[0]) fail(400, 'BAD', 'That user name is taken.');
    await audit(s, 'user.create', name, ipOf(req));
    return { tempPassword: temp };
  },
  async userUpdate({ req, s, body }) {
    needSection(s, 'admin', 'admin'); needCleared(s);
    const r = await q('select * from aio.users where id = $1', [body.userId]);
    const u = r.rows[0];
    if (!u) fail(404, 'NOTFOUND', 'User not found');
    if (u.is_owner && !s.is_owner) fail(403, 'LEVEL', 'Only the owner can change the owner.');
    if (u.id === s.user_id && body.disabled) fail(400, 'BAD', "You can't turn yourself off.");
    if (body.levels) await q('update aio.users set levels = $2 where id = $1', [u.id, JSON.stringify(cleanLevels(body.levels, s))]);
    if (body.disabled !== undefined) {
      await q('update aio.users set disabled = $2 where id = $1', [u.id, !!body.disabled]);
      if (body.disabled) await q('delete from aio.sessions where user_id = $1', [u.id]);
    }
    let tempPassword;
    if (body.resetPassword) {
      tempPassword = token(9);
      await q('update aio.users set pass_hash = $2, must_change = true, failed = 0, locked_until = null where id = $1', [u.id, hashPassword(tempPassword)]);
      await q('delete from aio.sessions where user_id = $1', [u.id]);
    }
    if (body.reset2fa) {
      await q("update aio.users set totp_on = false, totp_enc = null, recovery = '[]' where id = $1", [u.id]);
      await q('delete from aio.sessions where user_id = $1', [u.id]);
    }
    if (body.unlock) await q('update aio.users set failed = 0, locked_until = null where id = $1', [u.id]);
    await audit(s, 'user.update', `${u.username}: ${Object.keys(body).filter((k) => !['action', 'userId'].includes(k)).join(', ')}`, ipOf(req));
    return { ok: true, tempPassword };
  },
  async grantSet({ req, s, body }) {
    needSection(s, 'admin', 'admin'); needCleared(s);
    if (body.kind === 'site') fail(400, 'BAD', 'The Rend room is for the owner only, so sites cannot be shared.');
    if (!['repo', 'project'].includes(body.kind)) fail(400, 'BAD', 'Bad kind');
    if (!['viewer', 'developer', 'admin'].includes(body.level)) fail(400, 'BAD', 'Bad level');
    await q('insert into aio.grants (user_id, kind, resource_id, level) values ($1,$2,$3,$4) on conflict (user_id, kind, resource_id) do update set level = excluded.level',
      [body.userId, body.kind, body.resourceId, body.level]);
    await audit(s, 'grant.set', `user ${body.userId}: ${body.kind} ${body.resourceId} = ${body.level}`, ipOf(req));
    return { ok: true };
  },
  async grantDelete({ req, s, body }) {
    needSection(s, 'admin', 'admin'); needCleared(s);
    await q('delete from aio.grants where id = $1', [body.id]);
    await audit(s, 'grant.delete', 'grant ' + body.id, ipOf(req));
    return { ok: true };
  },
  async auditList({ s, body }) {
    needSection(s, 'admin', 'viewer');
    const f = String(body.search || '').trim();
    const r = f
      ? await q('select * from aio.audit where username ilike $1 or action ilike $1 or detail ilike $1 order by id desc limit 300', ['%' + f + '%'])
      : await q('select * from aio.audit order by id desc limit 300');
    return { audit: r.rows };
  },
  async settingsSet({ req, s, body }) {
    if (!s.is_owner) fail(403, 'LEVEL', 'Only the owner can change settings.');
    needCleared(s);
    const v = {
      idleMinutes: Math.min(240, Math.max(5, parseInt(body.idleMinutes, 10) || 30)),
      clearanceMinutes: Math.min(60, Math.max(1, parseInt(body.clearanceMinutes, 10) || 15)),
      require2fa: !!body.require2fa,
    };
    for (const [k, val] of Object.entries(v)) await q('insert into aio.settings (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value', [k, JSON.stringify(val)]);
    await audit(s, 'settings', JSON.stringify(v), ipOf(req));
    return { ok: true, settings: v };
  },
  async settingsGet({ s }) {
    const st = await getSettings();
    let update = '';
    try { update = (await import('fs')).readFileSync((process.env.STATE_DIR || "/state") + "/update.txt", 'utf8').slice(0, 4000); } catch {}
    return { settings: { idleMinutes: st.idleMinutes, clearanceMinutes: st.clearanceMinutes, require2fa: st.require2fa }, update };
  },
  async backupList({ s }) {
    if (!s.is_owner) fail(403, 'LEVEL', 'Only the owner can see backups.');
    const fs = await import('fs');
    const dir = process.env.BACKUP_DIR || '/backups';
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.(gz)$/.test(f)).map((f) => ({ name: f, size: fs.statSync(dir + '/' + f).size })).sort((a, b) => b.name.localeCompare(a.name)); } catch {}
    return { files };
  },
  async backupNow({ req, s }) {
    if (!s.is_owner) fail(403, 'LEVEL', 'Only the owner can run a backup.');
    needCleared(s);
    const fs = await import('fs');
    try { fs.writeFileSync((process.env.BACKUP_DIR || '/backups') + '/.now', String(Date.now())); } catch { fail(500, 'BAD', 'The backup folder is not set up on this server.'); }
    await audit(s, 'backup.request', '', ipOf(req));
    return { ok: true };
  },
};

/* ---- DNS room helpers ---- */
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function cleanDomain(v) {
  const d = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!DOMAIN.test(d)) fail(400, 'BAD', 'Type just the domain, like mysite.com or shop.mysite.com.');
  return d;
}
// The address your domain should point to: this server's own public IP.
async function serverIp(req) {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  const host = hostName(req);
  const m = host.match(/^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.(sslip|nip)\.io$/);
  if (m) return m.slice(1, 5).join('.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  try { return (await dns.lookup(host, { family: 4 })).address; } catch { return ''; }
}
function dnsRecord(name, ip) {
  const parts = name.split('.');
  return { type: 'A', name: parts.length <= 2 ? '@' : parts.slice(0, -2).join('.'), value: ip };
}

async function commitOf(repoId, commitId) {
  const r = await q('select * from aio.commits where id = $1 and repo_id = $2', [commitId, repoId]);
  if (!r.rows[0]) fail(404, 'NOTFOUND', 'Commit not found');
  return r.rows[0];
}
export async function POST(req) {
  try {
    if (req.headers.get('x-cc') !== '1') fail(400, 'BAD', 'Bad request');
    const origin = req.headers.get('origin');
    if (origin) {
      const oh = new URL(origin).host;
      const h = req.headers.get('x-forwarded-host') || req.headers.get('host');
      if (oh !== h) fail(403, 'BAD', 'Bad origin');
    }
    const body = await req.json();
    const action = String(body.action || '');
    let s = await loadSession(req);
    if (!s && req.headers.get('authorization')) {
      s = await aiSession(req);
      if (s && !AI_ACTIONS.has(action)) { await audit(s, 'ai.refused', action, ipOf(req)); fail(403, 'AI_ROOM', 'AI keys can only work in the Fit room and the Base room.'); }
    }
    const host = hostName(req);
    if (!['status', 'license'].includes(action) && !(await licensed(host))) fail(403, 'LICENSE', 'This copy of Fit-Rend-Base is not licensed for this address.');
    const ctx = { req, body, s };
    let out;
    if (OPEN[action]) out = await OPEN[action](ctx);
    else {
      if (!s || s.pending_2fa) fail(401, 'SIGNED_OUT', 'Please sign in.');
      if (s.ai && action === 'me') out = { me: await meOf(s) };
      else if (ACCOUNT[action]) out = await ACCOUNT[action](ctx);
      else if (MAIN[action]) {
        if (s.must_change) fail(403, 'MUST_CHANGE', 'Set a new password first.');
        if (s.settings.require2fa && !s.totp_on) fail(403, 'NEED_2FA', 'Turn on 2-step sign-in first.');
        out = await MAIN[action](ctx);
      } else fail(400, 'BAD', 'Unknown action');
    }
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong on the server: ' + e.message, code: 'SERVER' }, 500);
  }
}
