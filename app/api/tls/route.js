// Caddy asks here before it gets a free https certificate for a domain.
// It only gets one for domains the owner added in the DNS room.
import { q } from '../../../lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const name = String(new URL(req.url).searchParams.get('domain') || '').trim().toLowerCase();
  if (!name) return new Response('no', { status: 400 });
  const r = await q('select 1 from aio.domains where name = $1', [name]);
  return new Response(r.rowCount ? 'ok' : 'no', { status: r.rowCount ? 200 : 404 });
}
