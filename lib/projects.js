// Database projects: each project is its own Postgres database on this server,
// with three roles: owner (your SQL), anon (public key) and service (secret key, skips row policies).
import pg from 'pg';
import { q, db, qi, ql, encrypt, decrypt, token, sha256, fail } from './core';

const pools = new Map();
export const SLUG = /^[a-z][a-z0-9_]{2,30}$/;
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const roleNames = (slug) => ({ owner: 'p_' + slug, anon: 'p_' + slug + '_anon', service: 'p_' + slug + '_service', dbname: 'p_' + slug });

function projectUrl(slug, password) {
  const u = new URL(process.env.DATABASE_URL);
  u.username = roleNames(slug).owner; u.password = password; u.pathname = '/' + roleNames(slug).dbname;
  return u.toString();
}
export async function getProject(id) {
  const r = await q('select * from aio.projects where id = $1', [id]);
  if (!r.rows[0]) fail(404, 'NOTFOUND', 'Project not found');
  return r.rows[0];
}
export function projectPool(p) {
  let pool = pools.get(p.slug);
  if (!pool) {
    pool = new pg.Pool({ connectionString: projectUrl(p.slug, decrypt(p.owner_pw_enc)), max: 3, idleTimeoutMillis: 30000 });
    pools.set(p.slug, pool);
  }
  return pool;
}
export async function createProject(slug, name, by) {
  if (!SLUG.test(slug)) fail(400, 'BAD', 'Project name: 3 to 31 small letters, numbers or _, starting with a letter.');
  const exists = await q('select 1 from aio.projects where slug = $1', [slug]);
  if (exists.rowCount) fail(400, 'BAD', 'That project name is taken.');
  const n = roleNames(slug);
  const pw = token(24);
  const sql = db();
  await sql.query(`create role ${qi(n.owner)} login password ${ql(pw)}`);
  await sql.query(`create role ${qi(n.anon)} nologin`);
  await sql.query(`create role ${qi(n.service)} nologin bypassrls`);
  await sql.query(`grant ${qi(n.anon)}, ${qi(n.service)} to ${qi(n.owner)}`);
  await sql.query(`create database ${qi(n.dbname)} owner ${qi(n.owner)}`);
  await sql.query(`revoke all on database ${qi(n.dbname)} from public`);
  await sql.query(`grant connect on database ${qi(n.dbname)} to ${qi(n.owner)}`);
  const anon = 'pk_' + token(24); const service = 'sk_' + token(32);
  const r = await q(`insert into aio.projects (slug, name, owner_pw_enc, anon_enc, anon_hash, service_enc, service_hash, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [slug, name || slug, encrypt(pw), encrypt(anon), sha256(anon), encrypt(service), sha256(service), by]);
  const c = await projectPool(r.rows[0]).connect();
  try {
    await c.query(`grant usage on schema public to ${qi(n.anon)}, ${qi(n.service)}`);
    await c.query(`alter default privileges in schema public grant all on tables to ${qi(n.service)}`);
    await c.query(`alter default privileges in schema public grant all on sequences to ${qi(n.service)}`);
    await c.query(`alter default privileges in schema public grant execute on functions to ${qi(n.service)}`);
  } finally { c.release(); }
  return r.rows[0];
}
export async function deleteProject(p) {
  const n = roleNames(p.slug);
  const pool = pools.get(p.slug);
  if (pool) { pools.delete(p.slug); await pool.end().catch(() => {}); }
  await db().query(`drop database if exists ${qi(n.dbname)} with (force)`);
  for (const role of [n.anon, n.service, n.owner]) await db().query(`drop role if exists ${qi(role)}`);
  await q('delete from aio.projects where id = $1', [p.id]);
}
export async function newKeys(p, which) {
  const v = which === 'service' ? 'sk_' + token(32) : 'pk_' + token(24);
  if (which === 'service') await q('update aio.projects set service_enc = $2, service_hash = $3 where id = $1', [p.id, encrypt(v), sha256(v)]);
  else await q('update aio.projects set anon_enc = $2, anon_hash = $3 where id = $1', [p.id, encrypt(v), sha256(v)]);
}

function cell(v) {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  return v;
}
function shape(r) {
  return {
    command: r.command, rowCount: r.rowCount,
    fields: (r.fields || []).map((f) => f.name),
    rows: (r.rows || []).slice(0, 500).map((row) => (r.fields || []).map((f) => cell(row[f.name]))),
    more: (r.rows || []).length > 500,
  };
}
/** readOnly: one statement only, read-only transaction, always rolled back */
export async function runSql(p, sql, readOnly) {
  const c = await projectPool(p).connect();
  try {
    await c.query(readOnly ? 'begin read only' : 'begin');
    await c.query('set local statement_timeout = 15000');
    let res;
    if (readOnly) res = [await c.query({ text: sql, queryMode: 'extended' })];
    else { const r = await c.query(sql); res = Array.isArray(r) ? r : [r]; }
    await c.query(readOnly ? 'rollback' : 'commit');
    return res.map(shape);
  } catch (e) {
    await c.query('rollback').catch(() => {});
    fail(400, 'SQL', e.message);
  } finally { c.release(); }
}
export async function readQuery(p, text, params = []) {
  const c = await projectPool(p).connect();
  try {
    await c.query('begin read only');
    await c.query('set local statement_timeout = 15000');
    const r = await c.query(text, params);
    await c.query('rollback');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); fail(400, 'SQL', e.message); } finally { c.release(); }
}
export async function tables(p) {
  const r = await readQuery(p, `select c.relname as name, c.relkind as kind, c.relrowsecurity as rls,
      greatest(c.reltuples, 0)::bigint as rows,
      has_table_privilege($1, c.oid, 'select') as anon_read,
      has_table_privilege($1, c.oid, 'insert') as anon_write
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m') order by 1`, [roleNames(p.slug).anon]);
  return r.rows;
}
export async function columns(p, table) {
  const r = await readQuery(p, `select column_name as name, data_type as type, is_nullable as nullable, column_default as "default"
    from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table]);
  return r.rows;
}
export async function rows(p, table, limit = 100, offset = 0) {
  if (!IDENT.test(table)) fail(400, 'BAD', 'Bad table name');
  const r = await readQuery(p, `select * from public.${qi(table)} limit ${Math.min(500, limit | 0)} offset ${Math.max(0, offset | 0)}`);
  return shape(r);
}
export async function policies(p) {
  const r = await readQuery(p, `select tablename as table, policyname as name, permissive, roles, cmd, qual as using, with_check as check
    from pg_policies where schemaname = 'public' order by 1, 2`);
  return r.rows;
}
const CMDS = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];
export function policySql(p, { table, name, cmd, who, using, check, restrictive }) {
  if (!IDENT.test(table || '')) fail(400, 'BAD', 'Pick a table');
  if (!name || name.length > 60) fail(400, 'BAD', 'Give the policy a name');
  const c = String(cmd || 'ALL').toUpperCase();
  if (!CMDS.includes(c)) fail(400, 'BAD', 'Bad action');
  const n = roleNames(p.slug);
  const roles = { public: qi(n.anon), service: qi(n.service), everyone: 'public' }[who || 'public'] || 'public';
  let s = `create policy ${qi(name)} on public.${qi(table)} as ${restrictive ? 'restrictive' : 'permissive'} for ${c} to ${roles}`;
  if (using && c !== 'INSERT') s += ` using (${using})`;
  if (check && ['ALL', 'INSERT', 'UPDATE'].includes(c)) s += ` with check (${check})`;
  return s;
}
export function publicAccessSql(p, table, access) {
  if (!IDENT.test(table || '')) fail(400, 'BAD', 'Bad table name');
  const a = qi(roleNames(p.slug).anon);
  const t = `public.${qi(table)}`;
  const out = [`revoke all on ${t} from ${a}`];
  if (access === 'read' || access === 'write') out.push(`grant select on ${t} to ${a}`);
  if (access === 'write') out.push(`grant insert, update, delete on ${t} to ${a}`, `grant usage, select on all sequences in schema public to ${a}`);
  return out.join(';\n');
}

/* ---------------- REST API: /db/<project>/rest/<table> ---------------- */
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' };
function where(params, startAt) {
  const parts = []; const vals = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    if (!IDENT.test(k)) fail(400, 'BAD', 'Bad column ' + k);
    const m = String(v).match(/^(\w+)\.(.*)$/s);
    if (!m) fail(400, 'BAD', `Filter ${k} needs a form like eq.value`);
    const [, op, val] = m;
    if (op === 'is') {
      const w = { null: 'null', true: 'true', false: 'false' }[val.toLowerCase()];
      if (!w) fail(400, 'BAD', 'is. takes null, true or false');
      parts.push(`${qi(k)} is ${w}`);
    } else if (op === 'in') {
      vals.push(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim()));
      parts.push(`${qi(k)}::text = any($${startAt + vals.length})`);
    } else if (OPS[op]) {
      vals.push(val);
      parts.push(`${qi(k)} ${OPS[op]} $${startAt + vals.length}`);
    } else fail(400, 'BAD', 'Unknown filter ' + op);
  }
  return { sql: parts.length ? ' where ' + parts.join(' and ') : '', vals };
}
export async function findProjectByKey(slug, key) {
  if (!SLUG.test(slug || '') || !key) return null;
  const r = await q('select * from aio.projects where slug = $1', [slug]);
  const p = r.rows[0];
  if (!p) return null;
  const h = sha256(key);
  if (h === p.service_hash) return { p, role: 'service' };
  if (h === p.anon_hash) return { p, role: 'anon' };
  return null;
}
export async function rest(p, role, method, table, params, body) {
  if (!IDENT.test(table || '')) fail(400, 'BAD', 'Bad table name');
  const n = roleNames(p.slug);
  const t = `public.${qi(table)}`;
  let text; let vals = [];
  if (method === 'GET') {
    const sel = params.get('select') || '*';
    const cols = sel === '*' ? '*' : sel.split(',').map((c) => { if (!IDENT.test(c.trim())) fail(400, 'BAD', 'Bad column ' + c); return qi(c.trim()); }).join(', ');
    const w = where(params, 0); vals = w.vals;
    let order = '';
    if (params.get('order')) {
      const [col, dir] = params.get('order').split('.');
      if (!IDENT.test(col)) fail(400, 'BAD', 'Bad order column');
      order = ` order by ${qi(col)} ${dir === 'desc' ? 'desc' : 'asc'}`;
    }
    const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '100', 10) || 100));
    const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);
    text = `select ${cols} from ${t}${w.sql}${order} limit ${limit} offset ${offset}`;
  } else if (method === 'POST') {
    const list = Array.isArray(body) ? body : [body];
    if (!list.length || typeof list[0] !== 'object' || !list[0]) fail(400, 'BAD', 'Send a JSON object or a list of objects');
    const cols = Object.keys(list[0]);
    cols.forEach((c) => { if (!IDENT.test(c)) fail(400, 'BAD', 'Bad column ' + c); });
    const rowsSql = list.map((row) => '(' + cols.map((c) => { vals.push(row[c] === undefined ? null : row[c]); return '$' + vals.length; }).join(', ') + ')');
    text = `insert into ${t} (${cols.map(qi).join(', ')}) values ${rowsSql.join(', ')} returning *`;
  } else if (method === 'PATCH') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'BAD', 'Send a JSON object of new values');
    const cols = Object.keys(body);
    if (!cols.length) fail(400, 'BAD', 'Nothing to change');
    const sets = cols.map((c) => { if (!IDENT.test(c)) fail(400, 'BAD', 'Bad column ' + c); vals.push(body[c]); return `${qi(c)} = $${vals.length}`; });
    const w = where(params, vals.length);
    if (!w.sql) fail(400, 'BAD', 'Add a filter, like ?id=eq.5, so you do not change every row');
    vals.push(...w.vals);
    text = `update ${t} set ${sets.join(', ')}${w.sql} returning *`;
  } else if (method === 'DELETE') {
    const w = where(params, 0); vals = w.vals;
    if (!w.sql) fail(400, 'BAD', 'Add a filter, like ?id=eq.5, so you do not delete every row');
    text = `delete from ${t}${w.sql} returning *`;
  } else fail(405, 'BAD', 'Method not allowed');
  const c = await projectPool(p).connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${qi(role === 'service' ? n.service : n.anon)}`);
    await c.query('set local statement_timeout = 10000');
    const r = await c.query(text, vals.map((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v)));
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    if (e instanceof Error && e.status) throw e;
    fail(400, 'SQL', e.message);
  } finally { c.release(); }
}
