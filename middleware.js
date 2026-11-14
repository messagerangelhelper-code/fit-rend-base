// Sends public addresses to the right handler:
//   /s/<site>/...            deployed sites
//   /db/<project>/rest/<t>   database REST API
//   /hooks/<token>           incoming deploy hooks
//   /in/leads                leads from LeadReplyRadar (signed)
//   /u/<token>               unsubscribe from campaign emails
//   /in/stripe               payments from Stripe (signed), makes customer accounts
//   /welcome/<token>         a new customer sets their password
//   /r/<code>                a customer's share link, goes to the pricing page
//   any path on your own domain (DNS room) shows that domain's site
import { NextResponse } from 'next/server';

export function middleware(req) {
  const { pathname } = req.nextUrl;
  const to = (k, a, b) => {
    const headers = new Headers(req.headers);
    headers.delete('x-frb-custom-host');
    headers.set('x-cc-k', k); headers.set('x-cc-a', a); headers.set('x-cc-b', encodeURIComponent(b || ''));
    return NextResponse.rewrite(new URL('/api/pub' + req.nextUrl.search, req.url), { request: { headers } });
  };
  // Your own domain (set up in the DNS room): Caddy marks it, and the whole domain shows one site.
  const custom = String(req.headers.get('x-frb-custom-host') || '').trim().toLowerCase();
  if (custom) return to('dsite', custom, pathname.slice(1));
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
  if (pathname === '/in/stripe') return to('stripe', '', '');
  m = pathname.match(/^\/welcome\/([A-Za-z0-9_-]{20,60})$/);
  if (m) return to('claim', m[1], '');
  m = pathname.match(/^\/r\/([a-z0-9]{6,16})$/);
  if (m) return to('ref', m[1], '');
  m = pathname.match(/^\/u\/([0-9]+\.[A-Za-z0-9_-]+)$/);
  if (m) return to('unsub', m[1], '');
  if (pathname.startsWith('/api/pub')) return new NextResponse('Not found', { status: 404 });
  return NextResponse.next();
}

// Every address goes through here, so a custom domain can never reach the sign-in or the rooms.
export const config = { matcher: ['/:path*'] };
