import { NextResponse } from 'next/server';
import { isAuthed, passwordIsSet } from '../../../lib/auth';
import { mailboxes, readAllMail } from '../../../lib/imap';
import { demoEmails } from '../../../lib/demo';
import { brevoStatus, inBrevo } from '../../../lib/brevo';
import { frbIsSet, frbStatus, inFrb } from '../../../lib/frb';
import { aiFor, aiStatus, lastBrief, sortWithAi } from '../../../lib/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  // No mailbox or no dashboard password yet: show sample data only.
  if (!mailboxes().length || !passwordIsSet()) {
    return NextResponse.json({
      mode: 'demo',
      items: demoEmails(),
      accounts: [],
      checkedAt: new Date().toISOString(),
      setup: !passwordIsSet() ? 'Add DASHBOARD_PASSWORD on Render.' : 'Add MAIL1_USER and MAIL1_PASS on Render.',
    });
  }
  if (!isAuthed(request)) {
    return NextResponse.json({ error: 'login' }, { status: 401 });
  }
  try {
    const data = await readAllMail();
    // Start sorting new emails in the background; results show on the next refresh.
    sortWithAi(data.items || []).catch(() => {});
    const items = (data.items || []).map(({ body, ...m }) => {
      const out = inFrb(m.id) ? { ...m, inFrb: true } : inBrevo(m.id) ? { ...m, inBrevo: true } : m;
      const ai = aiFor(m.id);
      return ai ? { ...out, ai } : out;
    });
    return NextResponse.json({ mode: 'live', ...data, items, brevo: brevoStatus(), frb: frbStatus(), ai: aiStatus(), brief: lastBrief() });
  } catch (e) {
    console.error('LeadReplyRadar mail error: ' + String(e.message || e));
    return NextResponse.json({ mode: 'live', items: [], accounts: [], error: String(e.message || e) }, { status: 500 });
  }
}
