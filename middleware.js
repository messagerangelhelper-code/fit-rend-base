// Sends public addresses to the right handler:
//   /s/<site>/...            deployed sites
//   /db/<project>/rest/<t>   database REST API
//   /hooks/<token>           incoming deploy hooks
//   /in/leads                leads from LeadReplyRadar (signed)
//   /u/<token>               unsubscribe from campaign emails
import { NextResponse } from 'next/server';

export function middleware(req) {
  const { pathname } = req.nextUrl;
  const to = (k, a, b) => {
    const headers = new Headers(req.headers);
    headers.set('x-cc-k', k); headers.set('x-cc-a', a); headers.set('x-cc-b', encodeURIComponent(b || ''));
    return NextResponse.rewrite(new URL('/api/pub' + req.nextUrl.search, req.url), { request: { headers } });
  };
  let m = pathname.match(/^\/s\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    if (!m[2]) return NextResponse.redirect(new URL(pathname + '/' + req.nextUrl.search, req.url).toString(), 308);
    return to('site', m[1], m[2].slice(1));
  }
  m = pathname.match(/^\/db\/([a-z0-9_]+)\/rest\/([A-Za-z0-9_]+)\/?$/);
  if (m) return to('rest', m[1], m[2]);
  m = pathname.match(/^\/hooks\/([A-Za-z0-9_-]+)$/);
  if (m) return to('hook', m[1], '');
  if (pathname === '/in/leads') return to('leads', '', '');
  m = pathname.match(/^\/u\/([0-9]+\.[A-Za-z0-9_-]+)$/);
  if (m) return to('unsub', m[1], '');
  if (pathname.startsWith('/api/pub')) return new NextResponse('Not found', { status: 404 });
  return NextResponse.next();
}

export const config = { matcher: ['/s/:path*', '/db/:path*', '/hooks/:path*', '/in/:path*', '/u/:path*', '/api/pub'] };
