// Customer pipeline: what happens after someone pays.
//   1. Account after payment: a Stripe payment makes the customer's own sign-in (switch: accountsOn).
//   2. Welcome emails: 3 emails from your Gmail (through LeadReplyRadar) walk them through setup (switch: welcomeOn).
//   3. Pipeline board: each person in Contacts moves by themselves: New lead > Talking > Paid > Needs help > Left.
//   4. Get help: a customer's problem becomes a ticket that says which room they were in.
//   5. Share link rewards: a friend who pays through a customer's share link earns that customer a free month (switch: rewardsOn).
// Every switch starts OFF. Nothing reaches Stripe or a customer's inbox until the owner turns it on.
import crypto from 'crypto';
import { q, tx, fail, encrypt, decrypt, sha256, token, hashPassword, same } from './core';
import * as CRM from './crm';

export const STAGES = ['lead', 'talking', 'paid', 'needs_help', 'cancelled'];
export const STAGE_NAMES = { lead: 'New lead', talking: 'Talking', paid: 'Paid', needs_help: 'Needs help', cancelled: 'Left' };
// What each plan's customer can make in their own space.
export const PLAN_LIMITS = {
  starter: { repos: 1, projects: 1 }, pro: { repos: 5, projects: 5 }, business: { repos: 50, projects: 20 },
  own: { repos: 1, projects: 1 }, cancelled: { repos: 0, projects: 0 },
};
export const PLAN_NAMES = { starter: 'Starter', pro: 'Pro', business: 'Business', own: 'Own Server License', cancelled: 'Cancelled' };
// Stripe sends the price before any discount code, so a Black Friday payment still shows the right plan.
const PLAN_BY_CENTS = { 1900: 'starter', 4900: 'pro', 9900: 'business', 29900: 'own' };
const REF = /^[a-z0-9]{6,16}$/;

/* ---------- settings ---------- */
const WELCOME = [
  {
    delayDays: 0,
    subject: 'Your Fit-Rend-Base account is ready',
    body: `Hi {{first_name}},

Thanks for picking the {{plan}} plan. Your account is ready in 3 steps:

1. Set your password (this link works for 7 days): {{set_password_link}}
2. Sign in with your email here: {{signin_link}}
3. Turn on 2-step sign-in with an authenticator app on your phone. It keeps your code and data locked.

Stuck? Press Get help at the top of any screen and tell us what happened.`,
  },
  {
    delayDays: 1,
    subject: 'Make your first code space',
    body: `Hi {{first_name}},

Here is the fastest way to get going:

1. Sign in: {{signin_link}}
2. On My space, press Make my code space. That is where your app's files live.
3. Press Make my database when your app needs to save things.

Press Guide any time and it walks you to the right screen.`,
  },
  {
    delayDays: 3,
    subject: 'Get a free month',
    body: `Hi {{first_name}},

Know someone who would like this? Send them your share link:
{{share_link}}

When they pay for a plan through it, you get a free month.

If anything is not working, press Get help in the app and we will fix it.`,
  },
];
const DEFAULTS = { accountsOn: false, welcomeOn: false, rewardsOn: false, whsec_enc: '', stripeKey_enc: '', rewardCoupon: '', welcome: WELCOME };
export async function pipeSettings() {
  const r = await q("select value from aio.settings where key = 'pipeline'");
  const v = { ...DEFAULTS, ...(r.rows[0]?.value || {}) };
  if (!Array.isArray(v.welcome) || v.welcome.length !== 3) v.welcome = WELCOME;
  return v;
}
export async function savePipeSettings(patch) {
  const next = { ...(await pipeSettings()), ...patch };
  await q("insert into aio.settings (key, value) values ('pipeline', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(next)]);
  return next;
}
export function cleanWelcome(list) {
  if (!Array.isArray(list) || list.length !== 3) fail(400, 'BAD', 'There must be 3 welcome emails.');
  return list.map((w, i) => {
    const subject = String(w.subject || '').trim().slice(0, 200);
    const body = String(w.body || '').trim().slice(0, 8000);
    if (!subject || !body) fail(400, 'BAD', `Welcome email ${i + 1} needs a subject and words.`);
    if (i === 0 && !body.includes('{{set_password_link}}')) fail(400, 'BAD', 'Welcome email 1 must keep {{set_password_link}}, or new customers can\'t get in.');
    return { delayDays: Math.max(0, Math.min(30, Math.round(Number(w.delayDays) || 0))), subject, body };
  });
}

/* ---------- pipeline stages ---------- */
export async function setStage(contactId, stage, why) {
  if (!contactId || !STAGES.includes(stage)) return;
  const r = await q('update aio.contacts set stage = $2, stage_before = case when $2 = \'needs_help\' and stage <> \'needs_help\' then stage else stage_before end, updated_at = now() where id = $1 and stage <> $2 returning id', [contactId, stage]);
  if (r.rowCount) await CRM.event(contactId, 'stage', `Moved to ${STAGE_NAMES[stage]}${why ? ': ' + why : ''}`);
}
export async function board() {
  const r = await q(`select id, email, name, company, stage, score, updated_at from aio.contacts order by updated_at desc nulls last, id desc limit 2000`);
  const cols = Object.fromEntries(STAGES.map((st) => [st, []]));
  for (const c of r.rows) (cols[c.stage] || cols.lead).push(c);
  return STAGES.map((st) => ({ stage: st, name: STAGE_NAMES[st], count: cols[st].length, people: cols[st].slice(0, 100) }));
}
// A customer's own contact, made or found by email. An unsubscribed person stays unsubscribed.
async function contactFor(email, name, source) {
  const r = await q(`insert into aio.contacts (email, name, source, tags, last_seen) values ($1, $2, $3, '{customer}', now())
    on conflict (email) do update set name = case when aio.contacts.name = '' then excluded.name else aio.contacts.name end,
      tags = array(select distinct unnest(aio.contacts.tags || excluded.tags)), last_seen = now(), updated_at = now()
    returning id`, [email, String(name || '').slice(0, 80), source]);
  return r.rows[0].id;
}

/* ---------- customer accounts ---------- */
function usernameFrom(email) {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'customer';
  return (base.length < 3 ? base + 'xx' : base) + '-' + crypto.randomBytes(2).toString('hex');
}
export const newRef = () => crypto.randomBytes(5).toString('hex');
export async function newClaim(userId) {
  const t = token(24);
  await q("update aio.users set claim_hash = $2, claim_enc = $3, claim_until = now() + interval '7 days' where id = $1", [userId, sha256(t), encrypt(t)]);
  return t;
}
export async function makeCustomer({ email, name, plan, stripeCustomer, stripeSubscription }) {
  const found = await q('select * from aio.users where lower(email) = $1', [email]);
  if (found.rows[0]) {
    const u = found.rows[0];
    await q('update aio.users set plan = $2, stripe_customer = coalesce($3, stripe_customer), stripe_subscription = coalesce($4, stripe_subscription) where id = $1', [u.id, plan, stripeCustomer || null, stripeSubscription || null]);
    return { user: u, isNew: false };
  }
  const contactId = await contactFor(email, name, 'Stripe');
  for (let i = 0; i < 5; i++) {
    const r = await q(`insert into aio.users (username, name, email, pass_hash, levels, must_change, is_customer, plan, contact_id, ref_code, stripe_customer, stripe_subscription)
      values ($1,$2,$3,$4,'{}',true,true,$5,$6,$7,$8,$9) on conflict do nothing returning *`,
    [usernameFrom(email), String(name || '').slice(0, 80) || email.split('@')[0], email, hashPassword(token(24)), plan, contactId, newRef(), stripeCustomer || null, stripeSubscription || null]);
    if (r.rows[0]) return { user: r.rows[0], isNew: true };
  }
  fail(500, 'BAD', 'Could not make a user name for this customer.');
}
// The set-password link from welcome email 1. It works once, for 7 days.
export async function claim(t, password) {
  const r = await q('select id from aio.users where claim_hash = $1 and claim_until > now() and not disabled', [sha256(String(t || ''))]);
  const u = r.rows[0];
  if (!u) return null;
  await q('update aio.users set pass_hash = $2, must_change = false, claim_hash = null, claim_enc = null, claim_until = null, failed = 0, locked_until = null where id = $1', [u.id, hashPassword(password)]);
  await q('delete from aio.sessions where user_id = $1', [u.id]);
  const out = await q('select username, email from aio.users where id = $1', [u.id]);
  return out.rows[0];
}
export async function customerUse(userId) {
  const r = await q("select kind, count(*)::int as n from aio.grants where user_id = $1 and level = 'admin' group by kind", [userId]);
  const out = { repos: 0, projects: 0 };
  for (const x of r.rows) { if (x.kind === 'repo') out.repos = x.n; if (x.kind === 'project') out.projects = x.n; }
  return out;
}

/* ---------- Stripe webhook ---------- */
// Stripe signs each message with your webhook signing secret (whsec_...). Anything not signed is thrown away.
export function verifyStripe(raw, header, secret, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter((x) => x.trim().startsWith('v1=')).map((x) => x.trim().slice(3));
  const t = Number(parts.t || 0);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec || !sigs.length) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => same(s, want));
}
export async function handleStripe(evt, baseUrl) {
  const seen = await q('insert into aio.stripe_events (id, type) values ($1, $2) on conflict do nothing returning id', [String(evt.id), String(evt.type)]);
  if (!seen.rowCount) return 'already handled';
  const note = await stripeEvent(evt, baseUrl).catch(async (e) => { await q('delete from aio.stripe_events where id = $1', [String(evt.id)]); throw e; });
  await q('update aio.stripe_events set note = $2 where id = $1', [String(evt.id), String(note).slice(0, 500)]);
  return note;
}
async function stripeEvent(evt, baseUrl) {
  const o = evt.data?.object || {};
  const st = await pipeSettings();
  if (evt.type === 'checkout.session.completed') {
    if (!['paid', 'no_payment_required'].includes(o.payment_status)) return 'not paid yet';
    const email = CRM.cleanEmail(o.customer_details?.email || o.customer_email);
    if (!email) return 'no email on the payment';
    const name = o.customer_details?.name || '';
    const plan = PLAN_BY_CENTS[o.amount_subtotal] || (PLAN_LIMITS[o.metadata?.plan] ? o.metadata.plan : 'starter');
    const contactId = await contactFor(email, name, 'Stripe');
    await CRM.event(contactId, 'payment', `Paid for ${PLAN_NAMES[plan]} (${((o.amount_total || 0) / 100).toFixed(2)} ${String(o.currency || 'usd').toUpperCase()})`, 'pay-' + String(o.id).slice(0, 70));
    await setStage(contactId, 'paid', PLAN_NAMES[plan]);
    const notes = [`${email} paid for ${PLAN_NAMES[plan]}`];
    let user = null;
    if (st.accountsOn) {
      const made = await makeCustomer({ email, name, plan, stripeCustomer: o.customer, stripeSubscription: o.subscription });
      user = made.user;
      await q('update aio.users set contact_id = coalesce(contact_id, $2) where id = $1', [user.id, contactId]);
      if (made.isNew) {
        await newClaim(user.id);
        notes.push('account made');
        if (st.welcomeOn) {
          for (let i = 0; i < 3; i++) {
            await q("insert into aio.welcome_sends (user_id, step, due_at) values ($1, $2, now() + ($3 || ' days')::interval) on conflict do nothing", [user.id, i, String(st.welcome[i].delayDays)]);
          }
          notes.push('welcome emails queued');
        }
      } else notes.push('account already there, plan updated');
    } else notes.push('accounts after payment is off, so no account was made');
    // Share link reward: the friend paid through someone's link.
    const ref = String(o.client_reference_id || '').toLowerCase();
    if (st.rewardsOn && REF.test(ref)) notes.push(await reward(ref, email, user, st));
    return notes.join('; ');
  }
  if (evt.type === 'customer.subscription.deleted') {
    const r = await q("update aio.users set plan = 'cancelled' where stripe_subscription = $1 returning id, email, contact_id", [String(o.id)]);
    const u = r.rows[0];
    if (!u) return 'no customer has this subscription';
    await setStage(u.contact_id, 'cancelled', 'Subscription ended in Stripe');
    return `${u.email} cancelled`;
  }
  return 'not used';
}
async function reward(ref, friendEmail, friend, st) {
  const r = await q('select id, email, stripe_subscription from aio.users where ref_code = $1', [ref]);
  const referrer = r.rows[0];
  if (!referrer) return 'share link not found';
  if (referrer.email && referrer.email.toLowerCase() === friendEmail) return 'paid through their own share link, no reward';
  const ins = await q('insert into aio.referrals (referrer_id, friend_email, friend_user_id) values ($1, $2, $3) on conflict (friend_email) do nothing returning id', [referrer.id, friendEmail, friend?.id || null]);
  if (!ins.rowCount) return 'this friend was already counted';
  const id = ins.rows[0].id;
  // Give the free month in Stripe by itself, only when you saved a Stripe key and a free-month coupon.
  if (st.stripeKey_enc && st.rewardCoupon && referrer.stripe_subscription) {
    try {
      await stripeApi(decrypt(st.stripeKey_enc), 'POST', `/v1/subscriptions/${encodeURIComponent(referrer.stripe_subscription)}`, { 'discounts[0][coupon]': st.rewardCoupon });
      await q("update aio.referrals set status = 'given', given_at = now(), note = 'Free month added in Stripe' where id = $1", [id]);
      return 'free month given to ' + referrer.email;
    } catch (e) {
      await q('update aio.referrals set note = $2 where id = $1', [id, ('Stripe said: ' + e.message).slice(0, 300)]);
      return 'free month owed to ' + referrer.email + ' (Stripe did not take it)';
    }
  }
  return 'free month owed to ' + referrer.email;
}
export async function stripeApi(key, method, path, form) {
  const res = await fetch('https://api.stripe.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'Stripe answered ' + res.status);
  return j;
}

/* ---------- help tickets ---------- */
export async function openTicket(s, room, message) {
  const m = String(message || '').trim().slice(0, 2000);
  if (m.length < 3) fail(400, 'BAD', 'Tell us what went wrong in a few words.');
  const open = await q("select count(*)::int as n from aio.tickets where user_id = $1 and status = 'open'", [s.user_id]);
  if (open.rows[0].n >= 10) fail(400, 'BAD', 'You have 10 open requests already. We will answer those first.');
  const u = await q('select contact_id from aio.users where id = $1', [s.user_id]);
  const contactId = u.rows[0]?.contact_id || null;
  const r = await q('insert into aio.tickets (user_id, username, contact_id, room, message) values ($1,$2,$3,$4,$5) returning *', [s.user_id, s.username, contactId, String(room || '').slice(0, 60), m]);
  if (contactId) {
    await CRM.event(contactId, 'ticket', `Asked for help in ${room || 'the app'}: ${m.slice(0, 200)}`);
    await setStage(contactId, 'needs_help', 'Pressed Get help');
  }
  return r.rows[0];
}
export async function closeTicket(id, reply, by) {
  const r = await q("update aio.tickets set status = 'closed', reply = case when $2 = '' then reply else $2 end, replied_by = $3, updated_at = now() where id = $1 returning *", [id, String(reply || '').trim().slice(0, 4000), by]);
  const t = r.rows[0];
  if (!t) fail(404, 'NOTFOUND', 'Request not found');
  if (t.contact_id) {
    const left = await q("select count(*)::int as n from aio.tickets where contact_id = $1 and status = 'open'", [t.contact_id]);
    if (!left.rows[0].n) {
      const c = await q('select stage, stage_before from aio.contacts where id = $1', [t.contact_id]);
      if (c.rows[0]?.stage === 'needs_help') await setStage(t.contact_id, STAGES.includes(c.rows[0].stage_before) && c.rows[0].stage_before !== 'needs_help' ? c.rows[0].stage_before : 'paid', 'Help request answered');
    }
  }
  return t;
}

/* ---------- welcome emails ---------- */
export function renderWelcome(w, u, baseUrl, footer, claimToken) {
  const first = String(u.name || '').trim().split(/\s+/)[0] || 'there';
  const fill = (t) => String(t || '')
    .replace(/\{\{\s*(first[ _]?name|first)\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, u.name || 'there')
    .replace(/\{\{\s*plan\s*\}\}/gi, PLAN_NAMES[u.plan] || 'your')
    .replace(/\{\{\s*signin_link\s*\}\}/gi, baseUrl + '/')
    .replace(/\{\{\s*share_link\s*\}\}/gi, u.ref_code ? `${baseUrl}/r/${u.ref_code}` : baseUrl + '/pricing')
    .replace(/\{\{\s*set_password_link\s*\}\}/gi, claimToken ? `${baseUrl}/welcome/${claimToken}` : baseUrl + '/');
  const unsubscribeUrl = u.contact_id ? `${baseUrl}/u/${CRM.unsubToken(u.contact_id)}` : '';
  const text = `${fill(w.body).trim()}\n\n--\n${String(footer || '').trim()}${unsubscribeUrl ? '\nUnsubscribe: ' + unsubscribeUrl : ''}`;
  return { to: u.email, name: u.name, subject: fill(w.subject).slice(0, 200), text, unsubscribeUrl };
}
export function baseUrlFromEnv() {
  const d = String(process.env.DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return d ? 'https://' + d : '';
}
const wEng = (globalThis.__frbWelcome = globalThis.__frbWelcome || { busy: false });
// Runs with the campaign sender every 15 seconds: sends up to 4 welcome emails that are due.
export async function welcomeTick() {
  if (wEng.busy) return 0;
  wEng.busy = true;
  let n = 0;
  try {
    const st = await pipeSettings();
    if (!st.welcomeOn) return 0;
    await q("update aio.welcome_sends set status = 'unclear', error = 'The server stopped while sending' where status = 'sending' and at < now() - interval '10 minutes'");
    const crm = await CRM.crmSettings();
    const room = Math.max(0, Number(crm.dailyLimit || 300) - (await CRM.sentToday()));
    if (!room) return 0;
    const due = await q(`update aio.welcome_sends w set status = 'sending', at = now()
      from (select user_id, step from aio.welcome_sends where status = 'queued' and due_at <= now() order by due_at limit $1 for update skip locked) x
      where w.user_id = x.user_id and w.step = x.step returning w.user_id, w.step`, [Math.min(4, room)]);
    if (!due.rowCount) return 0;
    const base = st.baseUrl || baseUrlFromEnv();
    const waiting = new Set(due.rows.map((x) => x.user_id + ':' + x.step));
    for (const row of due.rows) {
      waiting.delete(row.user_id + ':' + row.step);
      const ur = await q('select u.*, c.status as contact_status from aio.users u left join aio.contacts c on c.id = u.contact_id where u.id = $1', [row.user_id]);
      const u = ur.rows[0];
      const done = (status, error) => q('update aio.welcome_sends set status = $3, error = $4, at = now() where user_id = $1 and step = $2', [row.user_id, row.step, status, error || null]);
      if (!u || u.disabled || !u.email || u.contact_status === 'unsubscribed') { await done('skipped', 'Unsubscribed or no account'); continue; }
      if (!base) { await done('queued', 'Waiting for the web address of this server'); break; }
      const claimToken = row.step === 0 && u.claim_enc && u.claim_until && new Date(u.claim_until) > new Date() ? decrypt(u.claim_enc) : '';
      const mail = renderWelcome(st.welcome[row.step], u, base, crm.footer, claimToken);
      try {
        await CRM.callLrr('send', { key: `w${u.id}-${row.step}`, ...mail }, 60000);
        await done('sent');
        if (u.contact_id) await CRM.event(u.contact_id, 'welcome', `Welcome email ${row.step + 1} sent: "${mail.subject}"`);
        n++;
      } catch (e) {
        if (['DAILY', 'GMAIL_BUSY', 'NOLINK', 'SIGNATURE'].includes(e.code)) {
          await q("update aio.welcome_sends set status = 'queued', due_at = now() + interval '10 minutes', error = $3 where user_id = $1 and step = $2", [row.user_id, row.step, e.message.slice(0, 300)]);
          break;
        }
        await done(e.code === 'NETWORK' ? 'unclear' : 'failed', e.message.slice(0, 300));
      }
    }
    // Emails in this batch that were not tried yet go back in line.
    for (const k of waiting) {
      const [uid, step] = k.split(':').map(Number);
      await q("update aio.welcome_sends set status = 'queued' where user_id = $1 and step = $2 and status = 'sending'", [uid, step]);
    }
    return n;
  } finally {
    wEng.busy = false;
  }
}
