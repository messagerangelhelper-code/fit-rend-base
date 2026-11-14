// Buy a domain (DNS room), through your Dynadot reseller account.
// Search shows Dynadot's price plus your add-on. When a domain is bought it is registered at Dynadot,
// its A records (main and www) point to this server, and it is added to the DNS room with free https.
//   You (the owner) buy: Dynadot takes it from your Dynadot balance, after you confirm the price.
//   A customer buys: they pay you through Stripe first, then the domain is registered for them.
// Everything is off until you save your Dynadot API key and turn it on.
import { promises as dns } from 'dns';
import { q, fail, decrypt } from './core';

const DYNADOT = process.env.DYNADOT_API_URL || 'https://api.dynadot.com/api3.json';
export const STRIPE_API = process.env.STRIPE_API_URL || 'https://api.stripe.com';
export const TLDS = ['com', 'net', 'org', 'co', 'app', 'io'];
const NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/* ---------- settings ---------- */
const DEFAULTS = { on: false, customersOn: false, key_enc: '', addOnCents: 800, maxCostCents: 3000 };
export async function domainSettings() {
  const r = await q("select value from aio.settings where key = 'domains'");
  return { ...DEFAULTS, ...(r.rows[0]?.value || {}) };
}
export async function saveDomainSettings(patch) {
  const next = { ...(await domainSettings()), ...patch };
  await q("insert into aio.settings (key, value) values ('domains', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(next)]);
  return next;
}
export function cleanName(v) {
  const d = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!NAME.test(d) || d.split('.').length !== 2) fail(400, 'BAD', 'Type a domain like mysite.com.');
  return d;
}
// The address domains should point to: this server's own public IP.
export async function ipForHost(host) {
  if (process.env.SERVER_IP) return process.env.SERVER_IP;
  const m = String(host || '').match(/^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.(sslip|nip)\.io$/);
  if (m) return m.slice(1, 5).join('.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  try { return (await dns.lookup(host, { family: 4 })).address; } catch { return ''; }
}

/* ---------- Dynadot ---------- */
// Dynadot's API: one request at a time, 60 a minute on a regular account.
const lock = (globalThis.__frbDynadot = globalThis.__frbDynadot || { p: Promise.resolve() });
export async function dynadot(key, command, params = {}) {
  if (!key) fail(400, 'NO_KEY', 'Save your Dynadot API key first.');
  const run = async () => {
    const u = new URL(DYNADOT);
    u.search = new URLSearchParams({ key, command, ...params }).toString();
    let res;
    try { res = await fetch(u, { signal: AbortSignal.timeout(30000) }); }
    catch (e) { const err = new Error('Could not reach Dynadot: ' + e.message); err.code = 'NETWORK'; throw err; }
    let j = {};
    try { j = await res.json(); } catch { fail(502, 'DYNADOT', 'Dynadot sent an answer that could not be read (' + res.status + ').'); }
    const body = Object.values(j)[0] || {};
    const code = String(body.ResponseCode ?? body.SuccessCode ?? '');
    if (code !== '0' || String(body.Status || '').toLowerCase() === 'error') {
      fail(400, 'DYNADOT', 'Dynadot said: ' + String(body.Error || body.Status || 'no').slice(0, 200));
    }
    return body;
  };
  const p = lock.p.then(run, run);
  lock.p = p.catch(() => {});
  return p;
}
const cents = (price) => {
  const m = String(price || '').match(/([\d,]+(?:\.\d+)?)/);
  return m ? Math.round(Number(m[1].replace(/,/g, '')) * 100) : 0;
};
// One name, or a word to try with the usual endings.
export async function search(st, input) {
  const raw = String(input || '').trim().toLowerCase();
  const names = raw.includes('.') ? [cleanName(raw)] : TLDS.slice(0, 4).map((t) => cleanName(raw.replace(/[^a-z0-9-]/g, '') + '.' + t));
  const key = decrypt(st.key_enc);
  const out = [];
  for (const name of names) {
    const r = await dynadot(key, 'search', { domain0: name, show_price: '1', currency: 'USD' });
    const x = (r.SearchResults || [])[0] || {};
    const cost = cents(x.Price);
    const available = String(x.Available || '').toLowerCase() === 'yes';
    const tooMuch = available && (!cost || cost > st.maxCostCents);
    out.push({ name, available: available && !tooMuch, costCents: cost, priceCents: cost ? cost + st.addOnCents : 0, note: !available ? 'Taken' : tooMuch ? 'Premium price, not offered' : '' });
  }
  return out;
}
// Register, then point it here. Returns { expires }.
export async function registerAndPoint(st, name, ip) {
  const key = decrypt(st.key_enc);
  const r = await dynadot(key, 'register', { domain: name, duration: '1', currency: 'USD' });
  if (ip) {
    // Main record and www both go to this server.
    await dynadot(key, 'set_dns2', { domain: name, main_record_type0: 'a', main_record0: ip, subdomain0: 'www', sub_record_type0: 'a', sub_record0: ip });
  }
  return { expires: r.Expiration || '' };
}
export async function balance(st) {
  const r = await dynadot(decrypt(st.key_enc), 'get_account_balance');
  const list = r.BalanceList || r.Balance || r.balance_list || [];
  const usd = (Array.isArray(list) ? list : [list]).find((x) => !x.Currency || x.Currency === 'USD') || {};
  return usd.Amount ?? usd.amount ?? usd.Balance ?? JSON.stringify(list).slice(0, 80);
}

/* ---------- orders ---------- */
export async function finishOrder(order, ip, by) {
  const st = await domainSettings();
  try {
    const out = await registerAndPoint(st, order.name, ip);
    await q("update aio.domain_orders set status = 'registered', expires = $2, error = null, updated_at = now() where id = $1", [order.id, String(out.expires).slice(0, 40)]);
    await q('insert into aio.domains (name, site_id, created_by, user_id) values ($1, $2, $3, $4) on conflict (name) do nothing', [order.name, order.site_id || null, by, order.user_id || null]);
    return { ok: true, expires: out.expires };
  } catch (e) {
    await q("update aio.domain_orders set status = 'failed', error = $2, updated_at = now() where id = $1", [order.id, String(e.message).slice(0, 300)]);
    return { ok: false, error: e.message };
  }
}
// A customer's Stripe payment for a domain arrived (from the Stripe webhook).
export async function domainPaid(session, baseUrl) {
  const id = Number(session.metadata?.order);
  const r = await q("update aio.domain_orders set status = 'paid', stripe_session = $2, updated_at = now() where id = $1 and status = 'waiting' returning *", [id, String(session.id || '')]);
  const order = r.rows[0];
  if (!order) return 'domain order not found or already paid';
  if (session.amount_total != null && Number(session.amount_total) < order.price_cents) {
    await q("update aio.domain_orders set status = 'failed', error = 'Paid less than the price' where id = $1", [id]);
    return `${order.name}: paid less than the price, not registered`;
  }
  const ip = await ipForHost(new URL(baseUrl).hostname);
  const done = await finishOrder(order, ip, 'Stripe payment');
  return done.ok ? `${order.name} registered for a customer` : `${order.name} paid but Dynadot did not register it: ${done.error}. Refund or try again.`;
}
export async function stripeCheckout(stripeKey, { order, email, baseUrl }) {
  const form = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(order.price_cents),
    'line_items[0][price_data][product_data][name]': `Domain ${order.name} (1 year)`,
    'metadata[kind]': 'domain',
    'metadata[order]': String(order.id),
    success_url: `${baseUrl}/#/home`,
    cancel_url: `${baseUrl}/#/home`,
  };
  if (email) form.customer_email = email;
  const res = await fetch(STRIPE_API + '/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + stripeKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) fail(400, 'STRIPE', 'Stripe said: ' + (j.error?.message || res.status));
  return j;
}
