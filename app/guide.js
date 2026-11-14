'use client';
import { useEffect, useState } from 'react';

/*
  Guide: "What do you want to do?"
  One plain question at a time, big tap choices, a Back button, and a
  "Take me there" button that opens the exact screen. It stays at the
  bottom of the screen while you do the step. Runs on your own server,
  no outside service.

  A step can have:
    text    what to do, in plain words
    go      { tab, sub, open } screen in Fit-Rend-Base to open
    link    { href, label } outside page that opens to the exact spot
    choices [{ label, next }] a question; next is a step id, 'end',
            or 'flow:<id>' to start another guide
  Steps run in order unless a choice says where to go.
*/

// Your LeadReplyRadar service on Render, Environment page. Change it here if the service changes.
export const LRR_RENDER_ENV = 'https://dashboard.render.com/web/srv-dbnqqt2jnfac73d4fsd0/env';
const owner = (me) => me.owner;
const lvl = (me, room, need) => me.owner || ['none', 'viewer', 'developer', 'admin'].indexOf(me.levels[room]) >= ['none', 'viewer', 'developer', 'admin'].indexOf(need);
export const FLOWS = [
  {
    id: 'signin', icon: '🔐', title: 'Keep my sign-in safe', sub: '2-step sign-in and backup codes', words: '2fa 2-step two step code authenticator backup phone safe login sign in password',
    show: () => true,
    steps: (me) => (me.totpOn ? [
      { id: 'on', title: '2-step sign-in is already on', text: 'Good. If you lost your backup codes, make new ones. Type your 6-digit code, then write the new codes on paper.', go: { tab: 'account', open: 'rec' } },
      { id: 'paper', title: 'Keep the codes on paper', text: 'Each backup code works once, if your phone is lost. Keep the paper somewhere safe, not in your phone.' },
    ] : [
      { id: 'phone', title: 'What phone do you have?', choices: [{ label: '🍎 iPhone', next: 'ios' }, { label: '🤖 Android', next: 'android' }] },
      { id: 'ios', title: 'Get the code app', text: 'Install Google Authenticator. It is free. Come back here when it is installed.', link: { href: 'https://apps.apple.com/app/google-authenticator/id388497605', label: 'Open the App Store page' }, after: 'turnon' },
      { id: 'android', title: 'Get the code app', text: 'Install Google Authenticator. It is free. Come back here when it is installed.', link: { href: 'https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2', label: 'Open the Play Store page' } },
      { id: 'turnon', title: 'Turn on 2-step', text: 'Tap Take me there. In Google Authenticator tap +, then Scan a QR code, and scan the square. Type the 6 numbers it shows.', go: { tab: 'account', open: '2fa' } },
      { id: 'paper', title: 'Keep the codes on paper', text: 'You will see backup codes. Write them on paper. Each one works once, if your phone is lost.' },
    ]),
  },
  {
    id: 'code', icon: '📦', title: "Put my app's code here", sub: 'Fit room, like GitHub', words: 'repo code files upload fit github folder project app',
    show: (me) => lvl(me, 'repos', 'developer'),
    steps: () => [
      { id: 'new', title: 'Make a repo', text: 'Tap Take me there. Type a short name with no spaces, like my-shop. Tap Make repo.', go: { tab: 'repos', open: 'new' } },
      { id: 'up', title: 'Add your files', text: 'Tap your new repo. Tap Upload folder to add the whole app, or Upload files for a few files.', go: { tab: 'repos' } },
      { id: 'next', title: 'Do you want it online?', choices: [{ label: '🚀 Yes, put it online', next: 'flow:online' }, { label: '✅ No, I am done', next: 'end' }] },
    ],
  },
  {
    id: 'online', icon: '🚀', title: 'Put my app online', sub: 'Rend room, like Render', words: 'deploy site online publish website link rend render live host',
    show: owner,
    steps: () => [
      { id: 'have', title: "Is your app's code in the Fit room?", choices: [{ label: '✅ Yes', next: 'door' }, { label: '📦 Not yet', next: 'flow:code' }] },
      { id: 'door', title: 'Open the Rend room door', text: 'Tap Take me there. Type your 6-digit code from Google Authenticator. Tap Open the door.', go: { tab: 'deploys' } },
      { id: 'site', title: 'Make the site', text: 'Type a link name, like shop. Pick your repo. Leave Folder empty, unless your web files are in a folder like out. Tap Make site.', go: { tab: 'deploys', open: 'new' } },
      { id: 'deploy', title: 'Go live', text: 'Tap Deploy now on your site. When it says Live, tap Copy link or Open to see it. Sites are plain web files (HTML, CSS, JavaScript, pictures).', go: { tab: 'deploys' } },
    ],
  },
  {
    id: 'domain', icon: '🌐', title: 'Use my own domain', sub: 'DNS room, 2 steps', words: 'dns domain name custom url address www com godaddy namecheap cloudflare squarespace a record',
    show: owner,
    steps: () => [
      { id: 'have', title: 'Is your site online in the Rend room?', choices: [{ label: '✅ Yes', next: 'add' }, { label: '🚀 Not yet', next: 'flow:online' }] },
      { id: 'add', title: 'Step 1: your domain and your site', text: 'Tap Take me there. Type your domain, like mysite.com. Tap the site it should show. Tap Next.', go: { tab: 'dns', open: 'new' } },
      { id: 'record', title: 'Step 2: copy one record, then check', text: 'Copy the 3 boxes (Type A, Name, Value) into DNS where you bought your domain. Come back and tap Check it. When it shows ✅, your site is on your domain with free https.', go: { tab: 'dns' } },
    ],
  },
  {
    id: 'database', icon: '🗄️', title: 'Make a database', sub: 'Base room, like Supabase', words: 'database db table sql data base supabase project keys',
    show: (me) => lvl(me, 'database', 'admin'),
    steps: () => [
      { id: 'new', title: 'Make a database project', text: 'Tap Take me there. Type a name with small letters, like shop. Tap Make project.', go: { tab: 'database', open: 'new' } },
      { id: 'keys', title: 'Get the keys', text: 'Tap your project, then API and URLs. Tap Show keys, then Send to Handover room, and type the app that will use it.', go: { tab: 'database' } },
      { id: 'next', title: 'Does another app need these keys now?', choices: [{ label: '🔑 Yes, give them to it', next: 'flow:handover' }, { label: '✅ No, I am done', next: 'end' }] },
    ],
  },
  {
    id: 'handover', icon: '🔑', title: 'Give a key to another app', sub: 'Handover room', words: 'key secret value env environment variable handover give copy token connect',
    show: (me) => lvl(me, 'handover', 'admin'),
    steps: () => [
      { id: 'copy', title: 'Copy the key', text: 'Tap Take me there. Find the app by name. Tap the eye 👁 to show the key (it asks for your code), then tap Copy.', go: { tab: 'handover' } },
      { id: 'where', title: 'Where does the other app live?', choices: [{ label: '☁️ On Render', next: 'render' }, { label: '🧩 Somewhere else', next: 'else' }] },
      { id: 'render', title: 'Paste it on Render', text: 'Open Render, tap your app, then Environment. Tap Add, paste the name and the key, then Save, rebuild, and deploy.', link: { href: 'https://dashboard.render.com/', label: 'Open Render' }, after: 'end' },
      { id: 'else', title: 'Paste it in that app', text: "Open that app's settings for keys or environment, and paste the name and the key. Save it there." },
    ],
  },
  {
    id: 'lrr', icon: '📬', title: 'Connect LeadReplyRadar', sub: 'Send email campaigns from your Gmail', words: 'leadreplyradar lead email campaign gmail mail send newsletter contacts brevo',
    show: (me) => lvl(me, 'contacts', 'admin'),
    steps: () => [
      { id: 'secret', title: 'Make the link secret', text: 'Tap Take me there, then Make secret (or New secret). FRB_URL and FRB_SECRET are saved in the Handover room for you.', go: { tab: 'contacts', sub: 'link' } },
      { id: 'twostep', title: 'Turn on 2-step for your campaign Gmail', text: 'Sign in as the Gmail you send campaigns from. Turn on 2-Step Verification. Skip this if it is already on.', link: { href: 'https://myaccount.google.com/signinoptions/twosv', label: 'Open Gmail 2-Step page' } },
      { id: 'apppw', title: 'Make a Gmail app password', text: 'Type the name LeadReplyRadar and tap Create. Copy the 16 letters it shows. You only see them once.', link: { href: 'https://myaccount.google.com/apppasswords', label: 'Open Gmail app passwords' } },
      { id: 'render', title: 'Add 4 settings on Render', text: 'Tap Add for each: CAMPAIGN_MAIL_USER = your campaign Gmail. CAMPAIGN_MAIL_PASS = the 16 letters. FRB_URL and FRB_SECRET = copy them from the Handover room. Then tap Save, rebuild, and deploy.', link: { href: LRR_RENDER_ENV, label: 'Open LeadReplyRadar settings on Render' }, go: { tab: 'handover' }, goLabel: 'Open Handover room' },
      { id: 'check', title: 'Check it works', text: 'Wait 2 or 3 minutes for LeadReplyRadar to restart. Then tap Check connection. It shows the Gmail it sends from.', go: { tab: 'contacts', sub: 'link' } },
    ],
  },
  {
    id: 'person', icon: '👤', title: 'Add a person', sub: 'Give someone their own sign-in', words: 'user person people add team member employee invite access clearance',
    show: (me) => lvl(me, 'admin', 'admin'),
    steps: () => [
      { id: 'add', title: 'Add them', text: 'Tap Take me there, then Add user. Type a user name and their name. Pick what they can do in each room. Tap Add user.', go: { tab: 'admin', sub: 'users' } },
      { id: 'tell', title: 'Give them the password', text: 'Copy the temporary password and give it to them yourself. They make their own password and set up 2-step the first time they sign in.' },
    ],
  },
  {
    id: 'ai', icon: '🤖', title: 'Let an AI help', sub: 'Fit room and Base room only', words: 'ai assistant bot claude chatgpt robot agent help key',
    show: owner,
    steps: () => [
      { id: 'key', title: 'Make an AI key', text: 'Tap Take me there, then New AI key. Name it after the AI, like Claude. Pick what it can do in the Fit room and the Base room. Tap Make key.', go: { tab: 'admin', sub: 'ai' } },
      { id: 'give', title: 'Give the key to the AI', text: 'The key is also saved in the Handover room as AI: and the name. Paste it in your AI tool. It can never go into the Rend room or other rooms.', go: { tab: 'handover' }, goLabel: 'Open Handover room' },
    ],
  },
  {
    id: 'backup', icon: '💾', title: 'Keep a copy of my data', sub: 'Backups', words: 'backup copy save download restore data safe',
    show: owner,
    steps: () => [
      { id: 'now', title: 'Make a backup', text: 'Tap Take me there, then Back up now. Wait a minute and tap Refresh. Tap Download on the newest files to keep a copy on your phone or computer.', go: { tab: 'admin', sub: 'backups' } },
    ],
  },
];
const css = `
.gd-wrap{position:fixed;inset:0;background:#000b;z-index:45;overflow:auto;padding:16px}
.gd{max-width:560px;margin:4vh auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}
.gd h2{font-size:21px;margin:4px 0 6px}.gd p{margin:6px 0 12px}
.gd-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:480px){.gd-tiles{grid-template-columns:1fr}}
.gd-tile{display:flex;gap:10px;align-items:center;text-align:left;padding:14px;border-radius:12px;min-height:72px;background:var(--panel2)}
.gd-tile .ic{font-size:26px}.gd-tile b{display:block;font-size:15px}.gd-tile span.s{font-size:12px;color:var(--muted)}
.gd-big{display:block;width:100%;padding:16px;font-size:16px;border-radius:12px;margin:8px 0;text-align:left}
.gd-step{font-size:12px;color:var(--muted);letter-spacing:.03em;text-transform:uppercase}
.gd-dots{display:flex;gap:5px;margin:6px 0 2px}.gd-dots i{width:22px;height:5px;border-radius:3px;background:var(--line)}.gd-dots i.on{background:var(--accent)}
.gd-nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.gd-nav button{flex:1 1 120px;padding:12px}
.gd-bar{position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--panel);border-top:2px solid var(--accent);padding:10px 14px calc(10px + env(safe-area-inset-bottom))}
.gd-bar .in{max-width:1100px;margin:0 auto}.gd-bar p{margin:4px 0 8px;font-size:14px}.gd-bar .gd-nav{margin-top:4px}.gd-bar .gd-nav button{padding:9px;flex:1 1 90px}
.gd-pad{height:170px}
a.gd-link{display:block;text-decoration:none}
`;
function findFlow(id) { return FLOWS.find((f) => f.id === id); }
export function Guide({ me, open, onClose, go }) {
  // path: list of { flow, step } so Back can go one step at a time
  const [path, setPath] = useState([]);
  const [docked, setDocked] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { if (open) setDocked(false); }, [open]);
  const flows = FLOWS.filter((f) => f.show(me));
  const cur = path[path.length - 1];
  const flow = cur && findFlow(cur.flow);
  const steps = flow ? flow.steps(me) : [];
  const idx = cur ? steps.findIndex((s) => s.id === cur.step) : -1;
  const step = idx >= 0 ? steps[idx] : null;
  const isLast = step && !step.choices && (step.after === 'end' || idx === steps.length - 1);
  const start = (id) => { const f = findFlow(id); if (!f) return; setPath((p) => [...p, { flow: id, step: f.steps(me)[0].id }]); setDocked(false); };
  const jump = (next) => {
    if (next === 'end') { finish(); return; }
    if (next.startsWith('flow:')) { start(next.slice(5)); return; }
    setPath((p) => [...p, { flow: cur.flow, step: next }]);
  };
  const nextStep = () => { if (step.after) jump(step.after); else if (idx < steps.length - 1) jump(steps[idx + 1].id); else finish(); };
  const back = () => { setPath((p) => p.slice(0, -1)); setDocked(false); };
  const finish = () => { setPath([]); setDocked(false); onClose(true); };
  const takeMe = () => { go(step.go); setDocked(true); };
  if (!open) return null;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? flows.filter((f) => words.some((w) => (f.title + ' ' + f.sub + ' ' + f.words).toLowerCase().includes(w))) : flows;
  const linkBtn = step?.link && (
    <a className="gd-link" href={step.link.href} target="_blank" rel="noopener noreferrer"><button className={'gd-big' + (step.go ? '' : ' primary')}>↗ {step.link.label}</button></a>
  );
  const goBtn = step?.go && <button className="gd-big primary" onClick={takeMe}>👉 {step.goLabel || 'Take me there'}</button>;
  const dots = flow && steps.length > 1 && <div className="gd-dots">{steps.map((s, i) => <i key={s.id} className={i <= idx ? 'on' : ''} />)}</div>;
  // Docked: a small bar at the bottom so you can do the step and still read it.
  if (docked && step) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className="gd-pad" />
        <div className="gd-bar"><div className="in">
          <div className="gd-step">{flow.icon} {flow.title} · step {idx + 1}</div>
          <p><b>{step.title}.</b> {step.text}</p>
          <div className="gd-nav">
            <button onClick={back}>← Back</button>
            <button onClick={() => setDocked(false)}>Show guide</button>
            <button className="primary" onClick={() => { setDocked(false); nextStep(); }}>{isLast ? '✅ Done' : 'Done, next →'}</button>
          </div>
        </div></div>
      </>
    );
  }
  return (
    <div className="gd-wrap" onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="gd">
        {!step ? (
          <>
            <div className="gd-step">Guide</div>
            <h2>What do you want to do?</h2>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or type it, like: put my app online" style={{ margin: '4px 0 12px' }} />
            <div className="gd-tiles">
              {shown.map((f) => <button key={f.id} className="gd-tile" onClick={() => start(f.id)}><span className="ic">{f.icon}</span><span><b>{f.title}</b><span className="s">{f.sub}</span></span></button>)}
            </div>
            {!shown.length && <p className="muted">Nothing matches. Try other words, or tap Clear.</p>}
            <div className="gd-nav">{q && <button onClick={() => setQ('')}>Clear</button>}<button onClick={() => onClose(false)}>Close the guide</button></div>
          </>
        ) : (
          <>
            <div className="gd-step">{flow.icon} {flow.title}{steps.length > 1 ? ` · step ${idx + 1}` : ''}</div>
            {dots}
            <h2>{step.title}</h2>
            {step.text && <p>{step.text}</p>}
            {step.choices && step.choices.map((c) => <button key={c.label} className="gd-big" onClick={() => jump(c.next)}>{c.label}</button>)}
            {linkBtn}
            {goBtn}
            <div className="gd-nav">
              <button onClick={back}>← Back</button>
              {!step.choices && <button className={step.go || step.link ? '' : 'primary'} onClick={nextStep}>{isLast ? '✅ Done' : 'Done, next →'}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
