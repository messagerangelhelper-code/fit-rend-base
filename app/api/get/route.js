// Downloads: a repo as a zip, one file, or a backup file (owner only).
import fs from 'fs';
import path from 'path';
import { q, fail, HttpError, loadSession, needResource, needCleared, getBlob, makeZip, audit, ipOf, hostName, licensed } from '../../../lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const err = (status, msg) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

export async function GET(req) {
  try {
    if (!(await licensed(hostName(req)))) fail(403, 'LICENSE', 'Not licensed');
    const s = await loadSession(req);
    if (!s || s.pending_2fa) fail(401, 'SIGNED_OUT', 'Please sign in first.');
    const u = new URL(req.url).searchParams;
    const what = u.get('what');
    if (what === 'zip' || what === 'file') {
      const repoId = Number(u.get('repo'));
      await needResource(s, 'repo', repoId, 'viewer');
      const r = await q('select r.name, c.tree from aio.repos r left join aio.commits c on c.id = coalesce($2, r.head) and c.repo_id = r.id where r.id = $1', [repoId, u.get('commit') ? Number(u.get('commit')) : null]);
      const repo = r.rows[0];
      if (!repo) fail(404, 'NOTFOUND', 'Repo not found');
      const tree = repo.tree || {};
      if (what === 'file') {
        const p = u.get('path');
        if (!tree[p]) fail(404, 'NOTFOUND', 'File not found');
        return new Response(getBlob(tree[p][0]), { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName(path.basename(p))}"`, 'X-Content-Type-Options': 'nosniff' } });
      }
      const zip = makeZip(Object.entries(tree).map(([name, [h]]) => ({ name: repo.name + '/' + name, data: getBlob(h) })));
      await audit(s, 'repo.download', repo.name, ipOf(req));
      return new Response(zip, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName(repo.name)}.zip"` } });
    }
    if (what === 'backup') {
      if (!s.is_owner) fail(403, 'LEVEL', 'Only the owner can download backups.');
      needCleared(s);
      const name = path.basename(u.get('file') || '');
      if (!/^[A-Za-z0-9._-]+\.gz$/.test(name)) fail(400, 'BAD', 'Bad file name');
      const file = path.join(process.env.BACKUP_DIR || '/backups', name);
      if (!fs.existsSync(file)) fail(404, 'NOTFOUND', 'Backup not found');
      await audit(s, 'backup.download', name, ipOf(req));
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"` } });
    }
    fail(400, 'BAD', 'Unknown download');
  } catch (e) {
    if (e instanceof HttpError) return err(e.status, e.code === 'CLEARANCE' ? 'Clearance check needed. Go back, press Clearance check, then try again.' : e.message);
    console.error(e);
    return err(500, 'Server error');
  }
}
