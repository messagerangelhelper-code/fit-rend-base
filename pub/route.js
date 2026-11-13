// Public doors: deployed sites (/s/name/), database REST API (/db/project/rest/table)
// and incoming deploy hooks (/hooks/token). The middleware sends those addresses here.
import { q, fail, HttpError, sha256, same, sign, decrypt, getBlob, loadSession, resourceLevel, isHttps, hostName, licensed, audit, deploySite, readCookie } from '../../../lib/core';
import * as P from '../../../lib/projects';
import * as CRM from '../../../lib/crm';

CRM.startEngine();

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', mp4: 'video/mp4',
  webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', xml: 'application/xml', webmanifest: 'application/manifest+json', wasm: 'application/wasm',
};
const SITE_HEADERS = {
  // The site runs in a sandbox, so its code can never act as a signed-in Fit-Rend-Base user.
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function page(status, title, text, extra = '') {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#0f1419;color:#e7ecf1;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<div style="max-width:420px;text-align:center"><div style="font-size:40px">🔒</div><h1 style="font-size:22px">${title}</h1><p style="color:#9fb0c0">${text}</p>${extra}</div></body>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

/* ---------------- deployed sites ---------------- */
function passValue(site, exp) { return sign(`site:${site.id}:${exp}:${sha256(site.key_enc || '').slice(0, 12)}:${site.visibility}`); }
function hasPass(req, site) {
  const v = readCookie(req, 'cc_site_' + site.id);
  if (!v) return false;
  const [exp, sig] = v.split('.');
  return Number(exp) > Date.now() && same(sig, passValue(site, exp));
}
function passCookie(req, site) {
  const exp = Date.now() + 3600000;
  const secure = isHttps(req);
  return `cc_site_${site.id}=${exp}.${passValue(site, exp)}; Path=/s/${site.slug}/; HttpOnly; Max-Age=3600; ${secure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`;
}
async function serveSite(req, slug, rawPath) {
  const r = await q('select s.*, c.tree from aio.sites s left join aio.commits c on c.id = s.commit_id where s.slug = $1', [slug]);
  const site = r.rows[0];
  if (!site) return page(404, 'Not found', 'There is no site at this link.');
  if (site.expires_at && new Date(site.expires_at) < new Date()) return page(410, 'This link has expired', 'Ask the person who shared it for a new link.');
  let setCookie = null;
  if (site.visibility !== 'public' && !hasPass(req, site)) {
    const url = new URL(req.url);
    if (site.visibility === 'key') {
      const k = url.searchParams.get('k');
      if (!k || !site.key_enc || !same(k, decrypt(site.key_enc))) return page(401, 'This link needs its key', 'Open the full link you were sent, including the part after ?k=');
    } else {
      const s = await loadSession(req);
      if (!s || s.pending_2fa || (await resourceLevel(s, 'site', site.id)) < 1) {
        return page(403, 'Clearance needed', 'Only people with clearance for this site can open it.', '<p><a style="color:#7cc4ff" href="/">Sign in to Fit-Rend-Base</a></p>');
      }
    }
    setCookie = passCookie(req, site);
  }
  if (!site.tree) return page(404, 'Not deployed yet', 'This site has no deploy yet.');
  const tree = site.tree;
  const folder = site.folder || '';
  let p = rawPath || '';
  try { p = decodeURIComponent(p); } catch {}
  if (p.includes('..')) return page(400, 'Bad address', 'That address is not allowed.');
  const tryPaths = [];
  if (p === '' || p.endsWith('/')) tryPaths.push(p + 'index.html');
  else tryPaths.push(p, p + '.html');
  let found = tryPaths.find((x) => tree[folder + x]);
  if (!found && p && !p.endsWith('/') && tree[folder + p + '/index.html']) {
    return new Response(null, { status: 308, headers: { Location: `/s/${slug}/${p}/` + new URL(req.url).search } });
  }
  if (!found && !/\.[a-z0-9]+$/i.test(p) && tree[folder + 'index.html']) found = 'index.html'; // single page apps
  if (!found) return page(404, 'Page not found', 'This site has no page at that address.');
  const ext = (found.split('.').pop() || '').toLowerCase();
  const headers = {
    ...SITE_HEADERS,
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': site.visibility === 'public' ? 'public, max-age=60' : 'private, no-store',
    ETag: '"' + tree[folder + found][0] + '"',
  };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  if (req.headers.get('if-none-match') === headers.ETag && !setCookie) return new Response(null, { status: 304, headers });
  return new Response(getBlob(tree[folder + found][0]), { status: 200, headers });
}

/* ---------------- database REST API ---------------- */
async function corsFor(req, slug) {
  const origin = req.headers.get('origin');
  const h = { 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
  if (!origin) return h;
  const r = await q('select cors from aio.projects where slug = $1', [slug]);
  const list = String(r.rows[0]?.cors || '').split(/\s+/);
  if (list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
async function serveRest(req, slug, table, params) {
  const cors = await corsFor(req, slug);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const key = req.headers.get('apikey') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const found = await P.findProjectByKey(slug, key);
    if (!found) fail(401, 'KEY', 'Missing or wrong API key. Send it in the apikey header.');
    let body = null;
    if (['POST', 'PATCH'].includes(req.method)) { try { body = await req.json(); } catch { fail(400, 'BAD', 'Send JSON in the body'); } }
    const rows = await P.rest(found.p, found.role, req.method, table, params, body);
    return json(rows, req.method === 'POST' ? 201 : 200, cors);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
    console.error(e);
    return json({ error: 'Server error' }, 500, cors);
  }
}

/* ---------------- incoming deploy hooks ---------------- */
async function serveHook(req, t) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const r = await q('select h.*, s.repo_id, s.slug, rp.head from aio.inhooks h join aio.sites s on s.id = h.site_id join aio.repos rp on rp.id = s.repo_id where h.token_hash = $1', [sha256(t || '')]);
  const h = r.rows[0];
  if (!h) return json({ error: 'Unknown hook' }, 404);
  if (!h.head) return json({ error: 'The repo has no files yet' }, 400);
  await deploySite({ id: h.site_id, slug: h.slug }, h.head, 'hook:' + h.name, 'Deploy hook');
  await q('update aio.inhooks set last_used = now() where id = $1', [h.id]);
  await audit(null, 'hook.in_deploy', `${h.name} -> ${h.slug} commit ${h.head}`, (req.headers.get('x-forwarded-for') || '').split(',')[0]);
  return json({ ok: true, site: h.slug, commit: h.head });
}

/* ---------------- leads from LeadReplyRadar ---------------- */
async function serveLeads(req) {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const raw = await req.text();
  if (raw.length > 200000) return json({ error: 'Too big' }, 413);
  if (!(await CRM.verifyFromLrr(req, raw))) return json({ error: 'Bad signature. Check FRB_SECRET on LeadReplyRadar.' }, 401);
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: 'Send JSON' }, 400); }
  const leads = (Array.isArray(data.leads) ? data.leads : []).slice(0, 50);
  const saved = [];
  for (const l of leads) { if (await CRM.saveLead(l)) saved.push(l.ref || l.email); }
  if (saved.length) await audit(null, 'crm.leads_in', `${saved.length} lead(s) from LeadReplyRadar`, (req.headers.get('x-forwarded-for') || '').split(',')[0]);
  return json({ ok: true, saved });
}

/* ---------------- unsubscribe ---------------- */
function unsubPage(title, text, form = '') {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#f6f7f9;color:#1b1f24;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px">
<div style="max-width:420px;text-align:center;background:#fff;border:1px solid #dde1e6;border-radius:14px;padding:24px"><h1 style="font-size:22px">${title}</h1><p style="color:#555">${text}</p>${form}</div></body>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } });
}
async function serveUnsub(req, t) {
  const id = CRM.readUnsub(t);
  if (!id) return unsubPage('Link not valid', 'This unsubscribe link is not complete. Reply to the email and ask to be taken off the list.');
  if (req.method === 'POST') {
    // A button press here, or a mail app's one-click unsubscribe.
    await CRM.unsubscribe(id, req.headers.get('content-type')?.includes('form') ? 'Unsubscribe link' : 'One-click unsubscribe');
    return unsubPage('You are unsubscribed', 'You will not get these emails anymore.');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'Use GET or POST' }, 405);
  return unsubPage('Unsubscribe?', 'Press the button to stop getting these emails.', `<form method="post"><button style="font-size:17px;padding:10px 20px;border-radius:10px;border:0;background:#1f6feb;color:#fff">Unsubscribe</button></form>`);
}

async function handle(req) {
  try {
    const url = new URL(req.url);
    const params = new URLSearchParams(url.search);
    const kind = req.headers.get('x-cc-k'); const a = req.headers.get('x-cc-a') || ''; const b = decodeURIComponent(req.headers.get('x-cc-b') || '');
    if (!(await licensed(hostName(req)))) return page(403, 'Not licensed', 'This copy of Fit-Rend-Base is not licensed for this address.');
    if (kind === 'site') return await serveSite(req, a, b);
    if (kind === 'rest') return await serveRest(req, a, b, params);
    if (kind === 'hook') return await serveHook(req, a);
    if (kind === 'leads') return await serveLeads(req);
    if (kind === 'unsub') return await serveUnsub(req, a);
    return page(404, 'Not found', 'Nothing here.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return page(500, 'Server error', 'Something went wrong.');
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const HEAD = handle;
