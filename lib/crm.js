// Contacts and Email Campaigns (your own Brevo).
// Leads come in from LeadReplyRadar on a signed address (/in/leads).
// Campaign emails go out through LeadReplyRadar, which sends them from your Gmail.
// Nothing sends until someone with Admin clearance presses Start, confirms the number of people
// and passes a clearance check. Every email has an unsubscribe link.
import crypto from 'crypto';
import { q, tx, fail, encrypt, decrypt, sign, same } from './core';

export const EMAIL = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[A-Za-z]{2,}$/;
export const cleanEmail = (e) => {
  const s = String(e || '').trim().toLowerCase();
  return s.length <= 254 && EMAIL.test(s) ? s : '';
};
export const cleanTags = (t) =>
  [...new Set((Array.isArray(t) ? t : String(t || '').split(/[,;|]/)).map((x) => String(x).trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 20);
const cut = (v, n) => String(v ?? '').trim().slice(0, n);

/* ---------- settings for the LeadReplyRadar link ---------- */
const DEFAULTS = { url: '', secret_enc: '', footer: '', dailyLimit: 300, lastPing: '', lastPingOk: false };
export async function crmSettings() {
  const r = await q("select value from aio.settings where key = 'crm'");
  return { ...DEFAULTS, ...(r.rows[0]?.value || {}) };
}
export async function saveCrmSettings(patch) {
  const cur = await crmSettings();
  const next = { ...cur, ...patch };
  await q("insert into aio.settings (key, value) values ('crm', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(next)]);
  return next;
}
export function checkLinkUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let x;
  try { x = new URL(s); } catch { fail(400, 'BAD', 'That is not a web address.'); }
  const local = ['localhost', '127.0.0.1'].includes(x.hostname);
  if (x.protocol !== 'https:' && !(local && x.protocol === 'http:')) fail(400, 'BAD', 'The LeadReplyRadar address must start with https://');
  if (x.username || x.password || x.search || x.hash) fail(400, 'BAD', 'Use just the address, like https://leadreplyradar.onrender.com');
  return x.origin + x.pathname.replace(/\/+$/, '');
}

/* ---------- signing between the two apps ---------- */
// Both apps share one secret. Each direction signs "direction.time.body" so a message can't be sent back.
export const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
export async function linkSecret() {
  const st = await crmSettings();
  return st.secret_enc ? decrypt(st.secret_enc) : '';
}
export async function verifyFromLrr(req, raw) {
  const secret = await linkSecret();
  if (!secret) return false;
  const ts = Number(req.headers.get('x-frb-timestamp') || 0);
  const sig = String(req.headers.get('x-frb-signature') || '');
  if (!ts || Math.abs(Date.now() - ts) > 5 * 60000) return false;
  return same(sig, hmac(secret, `lrr-to-frb.${ts}.${raw}`));
}
export async function callLrr(type, payload = {}, timeoutMs = 60000) {
  const st = await crmSettings();
  const secret = st.secret_enc ? decrypt(st.secret_enc) : '';
  if (!st.url || !secret) { const e = new Error('Connect LeadReplyRadar first (Contacts > Connection).'); e.code = 'NOLINK'; throw e; }
  const body = JSON.stringify({ type, ...payload });
  const ts = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(st.url + '/api/frb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FRB-Timestamp': String(ts), 'X-FRB-Signature': hmac(secret, `frb-to-lrr.${ts}.${body}`) },
      body,
      signal: ctl.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'LeadReplyRadar did not answer in time.' : 'Could not reach LeadReplyRadar: ' + e.message);
    err.code = 'NETWORK';
    throw err;
  } finally { clearTimeout(timer); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.error) {
    const err = new Error(data.error || 'LeadReplyRadar answered ' + res.status);
    err.code = data.code || (res.status === 401 ? 'SIGNATURE' : 'FAILED');
    throw err;
  }
  return data;
}

/* ---------- unsubscribe links ---------- */
export const unsubToken = (id) => `${id}.${sign('unsub:' + id).slice(0, 22)}`;
export function readUnsub(t) {
  const [id, sig] = String(t || '').split('.');
  if (!/^\d+$/.test(id || '') || !sig) return 0;
  return same(sig, sign('unsub:' + id).slice(0, 22)) ? Number(id) : 0;
}
export async function unsubscribe(id, how) {
  const r = await q("update aio.contacts set status = 'unsubscribed', updated_at = now() where id = $1 and status <> 'unsubscribed' returning id", [id]);
  if (r.rowCount) await q("insert into aio.contact_events (contact_id, kind, detail) values ($1, 'unsubscribed', $2)", [id, how]);
  await q("update aio.campaign_sends set status = 'skipped', error = 'Unsubscribed' where contact_id = $1 and status = 'queued'", [id]);
  await q("update aio.welcome_sends set status = 'skipped', error = 'Unsubscribed' where status = 'queued' and user_id in (select id from aio.users where contact_id = $1)", [id]);
}

/* ---------- contacts ---------- */
export async function event(contactId, kind, detail, ref = null) {
  await q('insert into aio.contact_events (contact_id, kind, detail, ref) values ($1,$2,$3,$4) on conflict do nothing', [contactId, kind, cut(detail, 1000), ref]);
}
// A lead from LeadReplyRadar. Never turns an unsubscribed person back on.
export async function saveLead(l) {
  const email = cleanEmail(l.email);
  if (!email) return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(l.score) || 0)));
  const tags = cleanTags(['lead', ...(Array.isArray(l.tags) ? l.tags : [])]);
  const r = await q(`insert into aio.contacts (email, name, score, source, tags, last_seen) values ($1, $2, $3, 'LeadReplyRadar', $4, now())
    on conflict (email) do update set
      name = case when aio.contacts.name = '' then excluded.name else aio.contacts.name end,
      score = greatest(aio.contacts.score, excluded.score),
      tags = array(select distinct unnest(aio.contacts.tags || excluded.tags)),
      last_seen = now(), updated_at = now()
    returning id`, [email, cut(l.name, 80), score, tags]);
  const id = r.rows[0].id;
  const level = score >= 80 ? 'Hot' : 'Needs a reply';
  await event(id, 'lead', `${level} email (score ${score}): ${cut(l.subject, 200)}`, l.ref ? cut(l.ref, 80) : null);
  return id;
}
export async function saveContact(c, by) {
  const email = cleanEmail(c.email);
  if (!email) fail(400, 'BAD', 'Type a real email address.');
  const vals = [email, cut(c.name, 80), cut(c.company, 80), cut(c.phone, 40), cleanTags(c.tags), Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))), cut(c.notes, 4000)];
  if (c.id) {
    const status = ['subscribed', 'unsubscribed'].includes(c.status) ? c.status : 'subscribed';
    const r = await q(`update aio.contacts set email=$2, name=$3, company=$4, phone=$5, tags=$6, score=$7, notes=$8, status=$9, updated_at=now() where id=$1 returning *`, [Number(c.id), ...vals, status]);
    if (!r.rows[0]) fail(404, 'NOTFOUND', 'Contact not found');
    await event(r.rows[0].id, 'edited', 'Edited by ' + by);
    return r.rows[0];
  }
  const r = await q(`insert into aio.contacts (email, name, company, phone, tags, score, notes, source) values ($1,$2,$3,$4,$5,$6,$7,'manual')
    on conflict (email) do nothing returning *`, vals);
  if (!r.rows[0]) fail(400, 'BAD', 'That email is already in your contacts.');
  await event(r.rows[0].id, 'added', 'Added by ' + by);
  return r.rows[0];
}
// CSV with a header row. Columns it knows: email, name (or first name + last name), company, phone, tags, score, notes.
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
export async function importCsv(text, by) {
  const rows = parseCsv(text);
  if (!rows.length) fail(400, 'BAD', 'The file is empty.');
  let head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  let start = 1;
  if (!head.some((h) => h.includes('email'))) {
    // No header: guess "email, name" per line.
    head = ['email', 'name'];
    start = 0;
  }
  const col = (names) => head.findIndex((h) => names.some((n) => h === n || (n === 'email' && h.includes('email'))));
  const ix = { email: col(['email']), name: col(['name', 'fullname']), first: col(['firstname', 'first']), last: col(['lastname', 'last']), company: col(['company', 'organization', 'business']), phone: col(['phone', 'mobile', 'sms']), tags: col(['tags', 'tag', 'lists', 'list']), score: col(['score']), notes: col(['notes', 'note']) };
  const body = rows.slice(start, start + 5000);
  let added = 0, updated = 0, bad = 0;
  await tx(async (c) => {
    for (const r of body) {
      const get = (k) => (ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '');
      const email = cleanEmail(get('email'));
      if (!email) { bad++; continue; }
      const name = cut(get('name') || [get('first'), get('last')].filter(Boolean).join(' '), 80);
      const res = await c.query(`insert into aio.contacts (email, name, company, phone, tags, score, notes, source) values ($1,$2,$3,$4,$5,$6,$7,'import')
        on conflict (email) do update set
          name = case when excluded.name <> '' then excluded.name else aio.contacts.name end,
          company = case when excluded.company <> '' then excluded.company else aio.contacts.company end,
          phone = case when excluded.phone <> '' then excluded.phone else aio.contacts.phone end,
          tags = array(select distinct unnest(aio.contacts.tags || excluded.tags)), updated_at = now()
        returning (xmax = 0) as fresh`, [email, name, cut(get('company'), 80), cut(get('phone'), 40), cleanTags(get('tags')), Math.max(0, Math.min(100, Math.round(Number(get('score')) || 0))), cut(get('notes'), 4000)]);
      if (res.rows[0].fresh) added++; else updated++;
    }
  });
  return { added, updated, bad, skipped: Math.max(0, rows.length - start - body.length) };
}
const csvCell = (v) => {
  let s = Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString() : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // so a spreadsheet never runs it as a formula
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export async function exportCsv() {
  const r = await q('select email, name, company, phone, tags, score, status, source, notes, created_at, last_seen from aio.contacts order by id');
  const cols = ['email', 'name', 'company', 'phone', 'tags', 'score', 'status', 'source', 'notes', 'created_at', 'last_seen'];
  return [cols.join(','), ...r.rows.map((x) => cols.map((k) => csvCell(x[k])).join(','))].join('\n');
}

/* ---------- campaigns ---------- */
export function audienceWhere(tag, minScore, start = 1) {
  return { sql: `status = 'subscribed' and ($${start}::text = '' or $${start}::text = any(tags)) and score >= $${start + 1}`, params: [String(tag || ''), Number(minScore) || 0] };
}
export async function audienceCount(tag, minScore) {
  const w = audienceWhere(tag, minScore);
  const r = await q(`select count(*)::int as n from aio.contacts where ${w.sql}`, w.params);
  return r.rows[0].n;
}
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
export function render(c, contact, baseUrl, footer) {
  const fill = (t) => String(t || '')
    .replace(/\{\{\s*(first[ _]?name|first)\s*\}\}/gi, firstName(contact.name))
    .replace(/\{\{\s*name\s*\}\}/gi, contact.name || 'there')
    .replace(/\{\{\s*company\s*\}\}/gi, contact.company || '');
  const unsubscribeUrl = `${baseUrl}/u/${unsubToken(contact.id)}`;
  const text = `${fill(c.body).trim()}\n\n--\n${String(footer || '').trim()}\nUnsubscribe: ${unsubscribeUrl}`;
  return { to: contact.email, name: contact.name, subject: fill(c.subject).slice(0, 200), text, unsubscribeUrl };
}
const nextUtcDay = () => { const d = new Date(); d.setUTCHours(24, 5, 0, 0); return d; };
export async function sentToday() {
  // Campaign emails and welcome emails share one daily limit, so Gmail never gets too many.
  const r = await q(`select (select count(*) from aio.campaign_sends where status = 'sent' and at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
    + (select count(*) from aio.welcome_sends where status = 'sent' and at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as n`);
  return Number(r.rows[0].n);
}

// The sending engine: every 15 seconds it sends up to 4 emails of the running campaign.
const eng = (globalThis.__frbEngine = globalThis.__frbEngine || { started: false, busy: false });
export function startEngine() {
  if (eng.started) return;
  eng.started = true;
  setInterval(() => {
    tick().catch((e) => console.error('campaign engine:', e.message));
    import('./pipeline').then((m) => m.welcomeTick()).catch((e) => console.error('welcome emails:', e.message));
  }, 15000).unref?.();
}
export async function tick() {
  if (eng.busy) return 0;
  eng.busy = true;
  let n = 0;
  try {
    // After a crash: an email left half-sent can't be checked, so it is never sent again.
    await q("update aio.campaign_sends set status = 'unclear', error = 'The server stopped while sending' where status = 'sending' and at < now() - interval '10 minutes'");
    const cr = await q("select * from aio.campaigns where status = 'sending' and (next_try is null or next_try <= now()) order by started_at limit 1");
    const c = cr.rows[0];
    if (!c) return 0;
    const st = await crmSettings();
    const room = Math.max(0, Number(st.dailyLimit || 300) - (await sentToday()));
    if (room <= 0) {
      await q("update aio.campaigns set next_try = $2, last_error = $3 where id = $1", [c.id, nextUtcDay(), 'Daily limit reached. Sending goes on tomorrow.']);
      return 0;
    }
    // Wake LeadReplyRadar first (Render's free plan can be asleep). If it can't be reached, nothing is marked.
    try { await callLrr('ping', {}, 75000); }
    catch (e) {
      await q('update aio.campaigns set next_try = $2, last_error = $3 where id = $1', [c.id, new Date(Date.now() + 10 * 60000), 'Could not reach LeadReplyRadar. Trying again in 10 minutes. (' + e.message.slice(0, 200) + ')']);
      return 0;
    }
    const batch = await q(`update aio.campaign_sends s set status = 'sending', at = now()
      from (select contact_id from aio.campaign_sends where campaign_id = $1 and status = 'queued' order by contact_id limit $2 for update skip locked) x
      where s.campaign_id = $1 and s.contact_id = x.contact_id
      returning s.contact_id`, [c.id, Math.min(4, room)]);
    if (!batch.rowCount) {
      const left = await q("select count(*)::int as n from aio.campaign_sends where campaign_id = $1 and status in ('queued','sending')", [c.id]);
      if (!left.rows[0].n) await q("update aio.campaigns set status = 'done', finished_at = now(), next_try = null where id = $1 and status = 'sending'", [c.id]);
      return 0;
    }
    const waiting = new Set(batch.rows.map((x) => x.contact_id));
    for (const row of batch.rows) {
      waiting.delete(row.contact_id);
      const pr = await q('select * from aio.contacts where id = $1', [row.contact_id]);
      const p = pr.rows[0];
      if (!p || p.status !== 'subscribed') {
        await q("update aio.campaign_sends set status = 'skipped', error = 'Not subscribed', at = now() where campaign_id = $1 and contact_id = $2", [c.id, row.contact_id]);
        continue;
      }
      const mail = render(c, p, c.base_url, st.footer);
      try {
        await callLrr('send', { key: `c${c.id}-p${p.id}`, ...mail }, 60000);
        await q("update aio.campaign_sends set status = 'sent', error = null, at = now() where campaign_id = $1 and contact_id = $2", [c.id, p.id]);
        await event(p.id, 'campaign', `Sent "${mail.subject}" (${c.name})`);
        n++;
      } catch (e) {
        if (['DAILY', 'GMAIL_BUSY', 'NOLINK', 'SIGNATURE'].includes(e.code)) {
          // Put it back and wait. Daily limit: tomorrow. Others: 10 minutes.
          await q("update aio.campaign_sends set status = 'queued' where campaign_id = $1 and contact_id = $2", [c.id, p.id]);
          const until = e.code === 'DAILY' ? nextUtcDay() : new Date(Date.now() + 10 * 60000);
          await q('update aio.campaigns set next_try = $2, last_error = $3 where id = $1', [c.id, until, e.message.slice(0, 300)]);
          break;
        }
        // No answer: we can't tell if it went, so it is never sent again (no double emails).
        const status = e.code === 'NETWORK' ? 'unclear' : 'failed';
        await q('update aio.campaign_sends set status = $3, error = $4, at = now() where campaign_id = $1 and contact_id = $2', [c.id, p.id, status, e.message.slice(0, 300)]);
        await q('update aio.campaigns set last_error = $2 where id = $1', [c.id, e.message.slice(0, 300)]);
      }
    }
    // Emails in this batch that were not tried yet go back in line.
    if (waiting.size) await q("update aio.campaign_sends set status = 'queued' where campaign_id = $1 and status = 'sending' and contact_id = any($2)", [c.id, [...waiting]]);
    if (n) await q('update aio.campaigns set last_error = null, next_try = null where id = $1', [c.id]);
    return n;
  } finally {
    eng.busy = false;
  }
}
export async function campaignCounts(id) {
  const r = await q('select status, count(*)::int as n from aio.campaign_sends where campaign_id = $1 group by status', [id]);
  const out = { queued: 0, sending: 0, sent: 0, failed: 0, unclear: 0, skipped: 0 };
  for (const x of r.rows) out[x.status] = x.n;
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
