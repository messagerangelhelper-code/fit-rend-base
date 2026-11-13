// Checks your mail every 5 minutes, even when the page is closed. It texts you Hot
// emails and saves important senders to Fit-Rend-Base Contacts (or Brevo if Fit-Rend-Base isn't set up).
// It also has the AI assistant sort new emails (if ANTHROPIC_API_KEY is set).
// It also sends the Sequences and A/B tests you started, a few at a time.
// It also visits its own web address so Render's free plan doesn't put it to sleep.
import { mailboxes, readAllMail } from './imap';
import { alertHot, smsIsSet } from './sms';
import { brevoIsSet, syncToBrevo } from './brevo';
import { frbIsSet, syncToFrb } from './frb';
import { aiIsSet, sortWithAi } from './ai';
import { outreachIsSet, processOutbox } from './outreach';
import { flushStore, loadStore } from './store';

const EVERY_MS = 5 * 60 * 1000;
let started = false;

async function tick() {
  try {
    if (mailboxes().length && (smsIsSet() || frbIsSet() || brevoIsSet() || aiIsSet())) {
      const data = await readAllMail();
      const items = data.items || [];
      const n = await alertHot(items);
      if (n) console.log('LeadReplyRadar sent ' + n + ' text alert(s)');
      if (frbIsSet()) {
        const f = await syncToFrb(items);
        if (f) console.log('LeadReplyRadar saved ' + f + ' contact(s) to Fit-Rend-Base');
      } else {
        const b = await syncToBrevo(items);
        if (b) console.log('LeadReplyRadar saved ' + b + ' contact(s) to Brevo');
      }
      const a = await sortWithAi(items);
      if (a) console.log('LeadReplyRadar AI sorted ' + a + ' email(s)');
    }
  } catch (e) {
    console.error('LeadReplyRadar watcher error: ' + String(e.message || e));
  }
  // Sequences and A/B tests you started: send what is due, stop anyone who replied.
  try {
    if (outreachIsSet()) {
      await loadStore();
      await processOutbox();
      await flushStore();
    }
  } catch (e) {
    console.error('LeadReplyRadar outreach error: ' + String(e.message || e));
  }
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) fetch(url + '/').catch(() => {});
}

export function startWatcher() {
  if (started) return;
  started = true;
  setTimeout(tick, 30 * 1000);
  setInterval(tick, EVERY_MS);
  console.log('LeadReplyRadar watcher started' + (frbIsSet() ? ' (Fit-Rend-Base on)' : brevoIsSet() ? ' (Brevo on)' : '') + (aiIsSet() ? ' (AI on)' : ''));
}
