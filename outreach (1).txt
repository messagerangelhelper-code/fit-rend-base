// Sequences and A/B Subject Lines. Both send from YOUR Gmail (MAIL1_USER / MAIL1_PASS),
// with no outside email service.
// Nothing starts until you press Start (or Send test) on the Tools page and confirm.
// After that, the app sends a few at a time every 5 minutes, so Gmail stays happy.
//   - Gmail allows about 500 emails a day. The app stops at OUTREACH_DAILY_LIMIT (default 300).
//   - Anyone who replies is taken off the sequence right away.
//   - Opens are counted with a tiny picture in the email (works only if their mail app shows pictures).
// Optional Render env vars: OUTREACH_DAILY_LIMIT, OUTREACH_PER_RUN (default 20), FROM_NAME.

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { mailboxes } from './imap';
import { flushStore, loadStore, markDirty, newId, store } from './store';

const DAY_MS = 24 * 3600 * 1000;
const DAILY = () => Math.max(1, Number(process.env.OUTREACH_DAILY_LIMIT || 300));
const PER_RUN = () => Math.max(1, Math.min(50, Number(process.env.OUTREACH_PER_RUN || 20)));
const MAX_PEOPLE = 300;
const DEFAULT_FOOTER = "If you'd rather not get these emails, just reply and let me know.";

const run = (globalThis.__lrrOutbox = globalThis.__lrrOutbox || { running: null, lastError: '', lastRun: '' });

// ---------- helpers ----------

function cleanEmail(a) {
  const s = String(a || '').trim().toLowerCase();
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/.test(s) ? s : '';
}

// One person per line: "jo@shop.com", "Jo Smith, jo@shop.com", "Jo Smith <jo@shop.com>" or "jo@shop.com, Jo".
export function parsePeople(text) {
  const out = [];
  const seen = new Set();
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
    const email = cleanEmail(m && m[0]);
    if (!email) {
      bad.push(line.slice(0, 60));
      continue;
    }
    if (/no-?reply|do-?not-?reply|mailer-daemon/i.test(email) || seen.has(email)) continue;
    seen.add(email);
    const name = line.replace(m[0], '').replace(/[<>,;"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    out.push({ email, name });
  }
  return { people: out, bad };
}

function firstName(p) {
  const n = String(p.name || '').trim().split(/\s+/)[0];
  return n || 'there';
}

function fill(text, p) {
  return String(text || '').replace(/\{\{\s*(first\s*name|firstname|first|name)\s*\}\}/gi, firstName(p));
}

function baseUrl() {
  return String(process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '').replace(/\/+$/, '');
}

function secret() {
  return crypto.createHash('sha256').update('lrr-track:' + String(process.env.DASHBOARD_PASSWORD || process.env.MAIL1_PASS || '')).digest();
}

export function signToken(payload) {
  const p = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(p).digest('base64url').slice(0, 16);
  return p + '.' + sig;
}

export function readToken(k) {
  const [p, sig] = String(k || '').split('.');
  if (!p || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(p).digest('base64url').slice(0, 16);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return Buffer.from(p, 'base64url').toString('utf8');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlFor(text, pixelPayload) {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => '<p style="margin:0 0 12px">' + para.replace(/\n/g, '<br>') + '</p>')
    .join('');
  const base = baseUrl();
  const pixel = base && pixelPayload ? '<img src="' + base + '/api/tools?k=' + signToken(pixelPayload) + '" width="1" height="1" alt="" style="display:block;border:0">' : '';
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' + body + pixel + '</div>';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sentToday(d) {
  if (d.sentDay.day !== today()) d.sentDay = { day: today(), count: 0 };
  return d.sentDay.count;
}

export function outreachIsSet() {
  return mailboxes().length > 0;
}

function transport() {
  const b = mailboxes()[0];
  const host = (process.env.MAIL1_SMTP_HOST || b.host.replace(/^imap\./i, 'smtp.')).trim();
  return nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 1,
    auth: { user: b.user, pass: b.pass },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
}

function fromHeader() {
  const b = mailboxes()[0];
  const name = String(process.env.FROM_NAME || process.env.AI_SIGN_NAME || '').trim().replace(/["<>]/g, '');
  return name ? '"' + name + '" <' + b.user + '>' : b.user;
}

// ---------- replies (checked in your inbox, read-only) ----------

async function withInbox(fn) {
  const b = mailboxes()[0];
  const client = new ImapFlow({
    host: b.host,
    port: 993,
    secure: true,
    auth: { user: b.user, pass: b.pass },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 40000,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function repliedSince(client, email, sinceIso) {
  const since = new Date(sinceIso);
  const uids = (await client.search({ from: email, since: new Date(since.getTime() - DAY_MS) }, { uid: true })) || [];
  if (!uids.length) return false;
  for await (const msg of client.fetch(uids.slice(-10), { uid: true, internalDate: true, envelope: true }, { uid: true })) {
    const from = ((msg.envelope && msg.envelope.from && msg.envelope.from[0]) || {}).address || '';
    if (from.toLowerCase() === email && new Date(msg.internalDate) > since) return true;
  }
  return false;
}

// ---------- start / stop (only from your button press) ----------

function checkSteps(steps) {
  const out = [];
  for (const s of (steps || []).slice(0, 5)) {
    const body = String(s.body || '').trim();
    if (!body) continue;
    out.push({ day: Math.max(0, Math.min(60, Math.round(Number(s.day) || 0))), subject: String(s.subject || '').trim().slice(0, 150), body: body.slice(0, 4000) });
  }
  if (!out.length) throw new Error('Write at least one email.');
  out[0].day = 0;
  if (!out[0].subject) throw new Error('The first email needs a subject.');
  for (let i = 1; i < out.length; i++) if (out[i].day <= out[i - 1].day) throw new Error('Each follow-up needs a later day than the one before.');
  return out;
}

export async function startSequence({ name, steps, people, footer }) {
  if (!outreachIsSet()) throw new Error('Add MAIL1_USER and MAIL1_PASS on Render first.');
  await loadStore();
  const d = store();
  const s = checkSteps(steps);
  const { people: list, bad } = parsePeople(people);
  if (!list.length) throw new Error('Add at least one email address.' + (bad.length ? ' Not an email: ' + bad[0] : ''));
  if (list.length > MAX_PEOPLE) throw new Error('At most ' + MAX_PEOPLE + ' people per sequence.');
  const seq = {
    id: newId('s'),
    name: String(name || '').trim().slice(0, 80) || 'Sequence ' + (d.sequences.length + 1),
    status: 'running',
    createdAt: new Date().toISOString(),
    footer: String(footer == null ? DEFAULT_FOOTER : footer).trim().slice(0, 400),
    steps: s,
    people: list.map((p) => ({ ...p, step: 0, firstAt: '', lastAt: '', stopped: '', opens: 0, mid: '' })),
  };
  d.sequences.unshift(seq);
  d.sequences = d.sequences.slice(0, 20);
  markDirty();
  kickOutbox();
  return { id: seq.id, people: list.length, skipped: bad.length };
}

export async function startAbTest({ name, subjectA, subjectB, body, people, footer }) {
  if (!outreachIsSet()) throw new Error('Add MAIL1_USER and MAIL1_PASS on Render first.');
  await loadStore();
  const d = store();
  const a = String(subjectA || '').trim().slice(0, 150);
  const b = String(subjectB || '').trim().slice(0, 150);
  const text = String(body || '').trim().slice(0, 4000);
  if (!a || !b) throw new Error('Write both subject lines.');
  if (a === b) throw new Error('The two subject lines are the same.');
  if (!text) throw new Error('Write the email.');
  const { people: list, bad } = parsePeople(people);
  if (list.length < 2) throw new Error('Add at least 2 email addresses.');
  if (list.length > MAX_PEOPLE) throw new Error('At most ' + MAX_PEOPLE + ' people per test.');
  const test = {
    id: newId('a'),
    name: String(name || '').trim().slice(0, 80) || 'Test ' + (d.tests.length + 1),
    status: 'sending',
    createdAt: new Date().toISOString(),
    subjectA: a,
    subjectB: b,
    body: text,
    footer: String(footer == null ? DEFAULT_FOOTER : footer).trim().slice(0, 400),
    people: list.map((p, i) => ({ ...p, v: i % 2 ? 'B' : 'A', sentAt: '', opened: '', replied: '', err: '' })),
    replyCheckAt: '',
  };
  d.tests.unshift(test);
  d.tests = d.tests.slice(0, 20);
  markDirty();
  kickOutbox();
  return { id: test.id, people: list.length, skipped: bad.length };
}

// pause, resume, stop or delete one sequence or test
export async function changeOutreach(kind, id, what) {
  await loadStore();
  const d = store();
  const listName = kind === 'test' ? 'tests' : 'sequences';
  const item = d[listName].find((x) => x.id === id);
  if (!item) throw new Error('Not found. Refresh the page.');
  if (what === 'delete') d[listName] = d[listName].filter((x) => x.id !== id);
  else if (what === 'pause') item.status = 'paused';
  else if (what === 'resume') item.status = kind === 'test' ? 'sending' : 'running';
  else if (what === 'stop') item.status = 'done';
  else throw new Error('Unknown change.');
  markDirty();
  if (what === 'resume') kickOutbox();
  return true;
}

// ---------- the sender (runs every 5 minutes, and right after you press Start) ----------

function dueList(d, now) {
  const due = [];
  for (const t of d.tests) {
    if (t.status !== 'sending') continue;
    t.people.forEach((p, i) => {
      if (!p.sentAt && !p.err) due.push({ kind: 'test', item: t, p, i });
    });
    if (t.people.every((p) => p.sentAt || p.err)) t.status = 'done';
  }
  for (const s of d.sequences) {
    if (s.status !== 'running') continue;
    let open = 0;
    s.people.forEach((p, i) => {
      if (p.stopped || p.step >= s.steps.length) return;
      open++;
      const when = p.step === 0 ? 0 : new Date(p.firstAt).getTime() + s.steps[p.step].day * DAY_MS;
      if (when <= now) due.push({ kind: 'seq', item: s, p, i });
    });
    if (!open) s.status = 'done';
  }
  return due;
}

async function sendOne(tx, job) {
  const { kind, item, p, i } = job;
  const isTest = kind === 'test';
  const step = isTest ? null : item.steps[p.step];
  let subject;
  if (isTest) subject = p.v === 'A' ? item.subjectA : item.subjectB;
  else subject = step.subject || 'Re: ' + item.steps[0].subject;
  subject = fill(subject, p);
  const text = fill(isTest ? item.body : step.body, p) + (item.footer ? '\n\n' + item.footer : '');
  const pixel = isTest ? 'a|' + item.id + '|' + i : 's|' + item.id + '|' + i;
  const b = mailboxes()[0];
  const info = await tx.sendMail({
    from: fromHeader(),
    to: p.name ? { name: p.name, address: p.email } : p.email,
    subject,
    text,
    html: htmlFor(text, pixel),
    headers: { 'List-Unsubscribe': '<mailto:' + b.user + '?subject=unsubscribe>' },
    ...(!isTest && p.step > 0 && !step.subject && p.mid ? { inReplyTo: p.mid, references: p.mid } : {}),
  });
  const at = new Date().toISOString();
  if (isTest) p.sentAt = at;
  else {
    if (p.step === 0) {
      p.firstAt = at;
      p.mid = (info && info.messageId) || '';
    }
    p.lastAt = at;
    p.step += 1;
  }
}

async function runOnce() {
  if (!outreachIsSet()) return 0;
  await loadStore();
  const d = store();
  const now = Date.now();
  const due = dueList(d, now);
  let budget = Math.min(PER_RUN(), DAILY() - sentToday(d));

  // Before any follow-up, check the inbox: anyone who replied is taken off the sequence.
  // Also count replies for A/B tests (every 30 minutes, for 14 days after sending).
  const allFollowUps = due.filter((j) => j.kind === 'seq' && j.p.step > 0);
  const followUps = allFollowUps.slice(0, Math.max(0, budget));
  allFollowUps.slice(followUps.length).forEach((j) => (j.skip = true)); // not checked yet: wait for the next run
  const testChecks = [];
  for (const t of d.tests) {
    if (t.replyCheckAt && now - new Date(t.replyCheckAt).getTime() < 30 * 60 * 1000) continue;
    const fresh = t.people.filter((p) => p.sentAt && !p.replied && now - new Date(p.sentAt).getTime() < 14 * DAY_MS);
    if (!fresh.length) continue;
    testChecks.push({ t, fresh: fresh.slice(0, 100) });
  }
  if (followUps.length || testChecks.length) {
    try {
      await withInbox(async (client) => {
        for (const j of followUps) {
          if (await repliedSince(client, j.p.email, j.p.firstAt)) {
            j.p.stopped = 'replied';
            j.skip = true;
            markDirty();
          }
        }
        for (const { t, fresh } of testChecks) {
          for (const p of fresh) {
            if (await repliedSince(client, p.email, p.sentAt)) {
              p.replied = new Date().toISOString();
              markDirty();
            }
          }
          t.replyCheckAt = new Date().toISOString();
          markDirty();
        }
      });
    } catch (e) {
      // If the inbox can't be checked, hold the follow-ups this time rather than risk emailing someone who replied.
      followUps.forEach((j) => (j.skip = true));
      run.lastError = 'Could not check replies: ' + String(e.message || e).slice(0, 150);
      console.error('LeadReplyRadar ' + run.lastError);
    }
  }

  const toSend = due.filter((j) => !j.skip);
  if (!toSend.length || budget <= 0) {
    await flushStore().catch(() => {});
    return 0;
  }
  const tx = transport();
  let n = 0;
  try {
    for (const j of toSend) {
      if (budget <= 0) break;
      try {
        await sendOne(tx, j);
        n++;
        budget--;
        d.sentDay.count = sentToday(d) + 1;
        markDirty();
      } catch (e) {
        const msg = String(e.message || e);
        if (/auth|535|534|credentials|421|454|daily|limit|quota/i.test(msg)) {
          run.lastError = /auth|535|534|credentials/i.test(msg)
            ? 'Gmail would not let the app send. Check MAIL1_PASS is your Gmail app password.'
            : 'Gmail is limiting sends right now: ' + msg.slice(0, 120);
          break; // try again on the next run
        }
        if (j.kind === 'test') j.p.err = msg.slice(0, 120);
        else j.p.stopped = 'error: ' + msg.slice(0, 100);
        markDirty();
      }
    }
    if (n) run.lastError = '';
  } finally {
    tx.close();
  }
  dueList(d, Date.now()); // marks finished ones as done
  await flushStore().catch(() => {});
  if (n) console.log('LeadReplyRadar outreach sent ' + n + ' email(s)');
  return n;
}

export function processOutbox() {
  if (run.running) return run.running;
  run.running = runOnce()
    .catch((e) => {
      run.lastError = String(e.message || e).slice(0, 200);
      console.error('LeadReplyRadar outreach error: ' + run.lastError);
      return 0;
    })
    .finally(() => {
      run.running = null;
      run.lastRun = new Date().toISOString();
    });
  return run.running;
}

function kickOutbox() {
  setTimeout(() => processOutbox(), 1000);
}

// A pixel was loaded: count the open.
export function recordOpen(payload) {
  const [kind, id, idx] = String(payload || '').split('|');
  const d = store();
  const i = Number(idx);
  if (kind === 'a') {
    const t = d.tests.find((x) => x.id === id);
    const p = t && t.people[i];
    if (p && !p.opened) {
      p.opened = new Date().toISOString();
      markDirty();
    }
  } else if (kind === 's') {
    const s = d.sequences.find((x) => x.id === id);
    const p = s && s.people[i];
    if (p) {
      p.opens = (p.opens || 0) + 1;
      markDirty();
    }
  }
}

// ---------- what the Tools page shows ----------

function pct(a, b) {
  return b ? Math.round((a / b) * 100) : 0;
}

export function testResults(t) {
  const side = (v) => {
    const ps = t.people.filter((p) => p.v === v);
    const sent = ps.filter((p) => p.sentAt).length;
    const opened = ps.filter((p) => p.opened).length;
    const replied = ps.filter((p) => p.replied).length;
    return { people: ps.length, sent, opened, replied, openRate: pct(opened, sent), replyRate: pct(replied, sent) };
  };
  const A = side('A');
  const B = side('B');
  let winner = '';
  if (A.sent >= 5 && B.sent >= 5) {
    const sa = A.replyRate * 3 + A.openRate;
    const sb = B.replyRate * 3 + B.openRate;
    if (sa !== sb) winner = sa > sb ? 'A' : 'B';
  }
  return { A, B, winner };
}

export function seqResults(s) {
  const ps = s.people;
  return {
    people: ps.length,
    started: ps.filter((p) => p.firstAt).length,
    sent: ps.reduce((n, p) => n + (p.step || 0), 0),
    replied: ps.filter((p) => p.stopped === 'replied').length,
    opened: ps.filter((p) => p.opens).length,
    finished: ps.filter((p) => !p.stopped && p.step >= s.steps.length).length,
    errors: ps.filter((p) => String(p.stopped).startsWith('error')).length,
  };
}

export async function outreachStatus() {
  await loadStore().catch(() => {});
  const d = store();
  return {
    on: outreachIsSet(),
    from: mailboxes()[0] ? mailboxes()[0].user : '',
    sentToday: sentToday(d),
    dailyLimit: DAILY(),
    tracking: Boolean(baseUrl()),
    error: run.lastError,
    sequences: d.sequences.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      createdAt: s.createdAt,
      steps: s.steps.map((x) => ({ day: x.day, subject: x.subject })),
      ...seqResults(s),
      replies: s.people.filter((p) => p.stopped === 'replied').slice(0, 20).map((p) => p.name || p.email),
    })),
    tests: d.tests.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      createdAt: t.createdAt,
      subjectA: t.subjectA,
      subjectB: t.subjectB,
      ...testResults(t),
    })),
  };
}

// ---------- Fit-Rend-Base campaigns ----------
// Fit-Rend-Base sends each campaign email here, one at a time, after you press Start there.
// It goes from CAMPAIGN_MAIL_USER (with its Gmail app password CAMPAIGN_MAIL_PASS) if set,
// otherwise from MAIL1_USER. Each email is sent only once, even if Fit-Rend-Base asks twice.
// Daily limit: CAMPAIGN_DAILY_LIMIT (default 300) for a separate campaign Gmail. When campaigns
// share MAIL1's Gmail, they count toward OUTREACH_DAILY_LIMIT with your sequences.

function campaignBox() {
  const user = String(process.env.CAMPAIGN_MAIL_USER || '').trim();
  const pass = String(process.env.CAMPAIGN_MAIL_PASS || '').replace(/\s+/g, '');
  const main = mailboxes()[0];
  if (user && pass) {
    const same = main && main.user.toLowerCase() === user.toLowerCase();
    const host = String(process.env.CAMPAIGN_SMTP_HOST || 'smtp.gmail.com').trim();
    return { user, pass, host, shared: same };
  }
  if (!main) return null;
  return { user: main.user, pass: main.pass, host: (process.env.MAIL1_SMTP_HOST || main.host.replace(/^imap\./i, 'smtp.')).trim(), shared: true };
}

function campaignCount(d, box) {
  if (box.shared) return { used: sentToday(d), limit: DAILY(), add: () => (d.sentDay.count = sentToday(d) + 1) };
  if (!d.campaignDay || d.campaignDay.day !== today()) d.campaignDay = { day: today(), count: 0 };
  const limit = Math.max(1, Number(process.env.CAMPAIGN_DAILY_LIMIT || 300));
  return { used: d.campaignDay.count, limit, add: () => (d.campaignDay.count += 1) };
}

const frbSending = (globalThis.__lrrFrbSending = globalThis.__lrrFrbSending || new Set());

export function campaignInfo() {
  const box = campaignBox();
  const d = store();
  if (!box) return { from: '', sentToday: 0, dailyLimit: 0 };
  const c = campaignCount(d, box);
  return { from: box.user, sentToday: c.used, dailyLimit: c.limit };
}

function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export async function sendForFrb({ key, to, name, subject, text, unsubscribeUrl, test }) {
  const box = campaignBox();
  if (!box) throw codedError('Add CAMPAIGN_MAIL_USER and CAMPAIGN_MAIL_PASS (or MAIL1_USER and MAIL1_PASS) on Render first.', 'NOLINK');
  try {
    await loadStore();
  } catch (e) {
    // Saved data can't be read right now; the count below still works until the next restart.
  }
  const d = store();
  d.frbKeys = Array.isArray(d.frbKeys) ? d.frbKeys : [];
  const k = String(key || '').slice(0, 80);
  if (!k) throw codedError('Missing key', 'BAD');
  if (d.frbKeys.includes(k)) return { ok: true, duplicate: true, from: box.user };
  if (frbSending.has(k)) throw codedError('This email is being sent right now.', 'GMAIL_BUSY');
  const email = cleanEmail(to);
  if (!email) throw codedError('Bad address: ' + String(to).slice(0, 80), 'BAD');
  if (/no-?reply|do-?not-?reply|mailer-daemon/i.test(email)) throw codedError('That address does not take email.', 'BAD');
  const subj = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const body = String(text || '').trim();
  if (!subj || !body) throw codedError('The subject or email is empty.', 'BAD');
  if (body.length > 25000) throw codedError('The email is too long.', 'BAD');
  const count = campaignCount(d, box);
  if (count.used >= count.limit) throw codedError('Today\'s limit of ' + count.limit + ' emails is used up. Sending goes on tomorrow.', 'DAILY');
  const unsub = /^https:\/\/[^\s<>]+$/.test(String(unsubscribeUrl || '')) ? String(unsubscribeUrl) : '';
  const fromName = String(process.env.FROM_NAME || process.env.AI_SIGN_NAME || '').trim().replace(/["<>]/g, '');
  const tx = nodemailer.createTransport({
    host: box.host,
    port: Number(process.env.CAMPAIGN_SMTP_PORT || 465),
    secure: true,
    auth: { user: box.user, pass: box.pass },
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
  frbSending.add(k);
  try {
    const info = await tx.sendMail({
      from: fromName ? '"' + fromName + '" <' + box.user + '>' : box.user,
      to: name ? { name: String(name).replace(/["<>\r\n]/g, '').slice(0, 80), address: email } : email,
      subject: subj,
      text: body,
      headers: unsub && !test
        ? { 'List-Unsubscribe': '<' + unsub + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : { 'List-Unsubscribe': '<mailto:' + box.user + '?subject=unsubscribe>' },
    });
    count.add();
    d.frbKeys.push(k);
    if (d.frbKeys.length > 3000) d.frbKeys = d.frbKeys.slice(-3000);
    markDirty();
    return { ok: true, from: box.user, messageId: (info && info.messageId) || '' };
  } catch (e) {
    const msg = String(e.message || e);
    if (/auth|535|534|credentials/i.test(msg)) throw codedError('Gmail would not let the app send. Check the Gmail app password on Render.', 'GMAIL_BUSY');
    if (/421|454|550 5\.4\.5|daily|limit|quota|rate/i.test(msg)) throw codedError('Gmail is limiting sends right now: ' + msg.slice(0, 120), 'DAILY');
    throw codedError(msg.slice(0, 200), 'FAILED');
  } finally {
    frbSending.delete(k);
    tx.close();
  }
}

export { DEFAULT_FOOTER };
