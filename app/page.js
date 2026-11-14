'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Guide } from './guide';

/* ================= helpers ================= */
let clearanceAsk = null;
let signedOut = null;
let toastFn = null;
function toast(msg, bad = false) { if (toastFn) toastFn({ msg, bad }); }

async function api(action, data = {}, retried = false) {
  const r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CC': '1' }, body: JSON.stringify({ action, ...data }) });
  const j = await r.json().catch(() => ({ error: 'The server sent a bad answer (' + r.status + ')' }));
  if (j.code === 'CLEARANCE' && clearanceAsk && !retried) {
    const ok = await clearanceAsk();
    if (ok) return api(action, data, true);
    throw new Error('Clearance check cancelled');
  }
  if (['SIGNED_OUT', 'MUST_CHANGE', 'NEED_2FA', 'REND_DOOR'].includes(j.code) && signedOut && action !== 'status') signedOut();
  if (!r.ok || j.error) throw new Error(j.error || 'Error ' + r.status);
  return j;
}
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try { setErr(null); setData(await fn()); } catch (e) { setErr(e.message); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [data, load, err];
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const when = (d) => (d ? new Date(d).toLocaleString() : '');
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');
const copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Could not copy', true));
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToText(b64) { try { return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { return ''; } }
const LEVEL_NAMES = { none: 'No access', viewer: 'Viewer', developer: 'Developer', admin: 'Admin', owner: 'Owner', some: 'Some items' };
const SECTION_NAMES = { repos: 'Fit room', deploys: 'Rend room', dns: 'DNS room', database: 'Base room', contacts: 'Contacts', handover: 'Handover room', connectors: 'Connectors', admin: 'Admin' };
const OWNER_ONLY = ['deploys', 'dns'];

/* A box for a key or value.
   Double tap: bigger. One more tap: small again. The eye shows or hides it. Generate puts a strong new key in the box. */
function newKey(prefix = '') {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function KeyBox({ value, onChange, reveal, readOnly, generate = true, prefix = '', placeholder = 'value' }) {
  const [open, setOpen] = useState(false); const [show, setShow] = useState(false); const last = useRef(0);
  const tap = () => {
    const now = Date.now();
    if (open) { setOpen(false); last.current = 0; return; }
    if (now - last.current < 400) { setOpen(true); last.current = 0; } else last.current = now;
  };
  const eye = run(async () => {
    if (show) { setShow(false); return; }
    if (reveal && !value) { const v = await reveal(); if (v == null) return; if (onChange) onChange(v, true); }
    setShow(true);
  });
  const gen = () => {
    if (value && !confirm('Put a new key in the box? What is in the box now is replaced.')) return;
    onChange(newKey(prefix)); setShow(true);
  };
  const edit = (e) => { if (onChange && !readOnly) onChange(e.target.value); };
  const common = { onClick: tap, style: { touchAction: 'manipulation' }, title: open ? 'Tap to make it small' : 'Double tap to make it bigger', spellCheck: false, autoCapitalize: 'none', autoComplete: 'off', placeholder };
  return (
    <div className="keybox">
      {open
        ? (show || !value
          ? <textarea {...common} className="keyarea" value={value || ''} onChange={edit} readOnly={readOnly} rows={5} />
          : <textarea {...common} className="keyarea" value={'•'.repeat(Math.min(Math.max(value.length, 8), 400))} readOnly rows={5} />)
        : <input {...common} className="keyline" type={show ? 'text' : 'password'} value={value || ''} onChange={edit} readOnly={readOnly} />}
      <button type="button" className="icon" onClick={eye} title={show ? 'Hide' : 'Show'} aria-label={show ? 'Hide' : 'Show'}>{show ? '🙈' : '👁'}</button>
      {generate && !readOnly && <button type="button" onClick={gen}>Generate</button>}
      {value ? <button type="button" onClick={() => copy(value)}>Copy</button> : null}
    </div>
  );
}
const atLeast = (lvl, need) => ['none', 'viewer', 'developer', 'admin', 'owner'].indexOf(lvl) >= ['none', 'viewer', 'developer', 'admin', 'owner'].indexOf(need);

function Modal({ children, onClose }) {
  return <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}><div className="card">{children}</div></div>;
}
function Field({ label, children }) { return <div><label>{label}</label>{children}</div>; }
function Grid({ fields, rows }) {
  if (!fields || !fields.length) return <div className="muted small">No rows.</div>;
  return (
    <div className="tbl"><table><thead><tr>{fields.map((f, i) => <th key={i}>{f}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} title={typeof c === 'object' ? JSON.stringify(c) : String(c)}>{c === null ? <span className="muted">null</span> : typeof c === 'object' ? JSON.stringify(c) : String(c)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
function lineDiff(a, b) {
  const x = a.split('\n'); const y = b.split('\n');
  if (x.length * y.length > 2500000) return null;
  const m = x.length, n = y.length; const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < m && j < n) { if (x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', x[i++]]); else out.push(['+', y[j++]]); }
  while (i < m) out.push(['-', x[i++]]); while (j < n) out.push(['+', y[j++]]);
  return out;
}

/* ================= app shell ================= */
export default function Page() {
  const [st, setSt] = useState(null);
  const [t, setT] = useState(null);
  const [clr, setClr] = useState(null);
  const load = useCallback(async () => { try { setSt(await api('status')); } catch (e) { setSt({ error: e.message }); } }, []);
  useEffect(() => {
    toastFn = (x) => { setT(x); setTimeout(() => setT(null), 4500); };
    clearanceAsk = () => new Promise((resolve) => setClr({ resolve }));
    signedOut = () => load();
    load();
  }, [load]);
  // sign out after the idle time with no taps or typing
  const last = useRef(Date.now());
  useEffect(() => {
    if (!st?.me) return undefined;
    const bump = () => { last.current = Date.now(); };
    ['mousemove', 'keydown', 'touchstart', 'click', 'scroll'].forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(async () => {
      if (Date.now() - last.current > st.me.idleMinutes * 60000) { await api('logout').catch(() => {}); toast('Signed out after being idle'); load(); }
    }, 20000);
    return () => { clearInterval(timer); ['mousemove', 'keydown', 'touchstart', 'click', 'scroll'].forEach((e) => window.removeEventListener(e, bump)); };
  }, [st, load]);

  let body;
  if (!st) body = <div className="center muted">Loading…</div>;
  else if (st.error) body = <div className="center card">Could not reach the server: {st.error} <button onClick={load}>Try again</button></div>;
  else if (!st.licensed) body = <License host={st.host} done={load} />;
  else if (st.setup) body = <Setup done={load} />;
  else if (st.pending2fa) body = <Code2fa done={load} />;
  else if (!st.me) body = <Login done={load} />;
  else if (st.me.mustChange) body = <div className="center card"><h2>Set your own password</h2><p className="muted small">You signed in with a temporary password. Pick a new one to go on.</p><ChangePassword done={load} /></div>;
  else if (st.me.needs2faSetup) body = <div className="center card"><h2>Turn on 2-step sign-in</h2><p className="muted small">Every account here needs a code from an authenticator app (like Google Authenticator, Microsoft Authenticator or Authy) on your phone.</p><Setup2fa done={load} /></div>;
  else body = <Main me={st.me} reload={load} />;

  return (
    <>
      {body}
      {clr && <Clearance onDone={(ok) => { clr.resolve(ok); setClr(null); if (ok) load(); }} />}
      {t && <div className={'toast' + (t.bad ? ' bad' : '')}>{t.msg}</div>}
    </>
  );
}

function License({ host, done }) {
  const [code, setCode] = useState('');
  return (
    <div className="center card">
      <div className="lock">🔐</div>
      <h2>License needed</h2>
      <p className="muted small">This copy of Fit-Rend-Base needs a license code for this address:</p>
      <p className="mono">{host}</p>
      <Field label="License code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code here" /></Field>
      <p><button className="primary" onClick={run(async () => { await api('license', { code }); toast('License saved'); done(); })}>Save license</button></p>
    </div>
  );
}
function Setup({ done }) {
  const [f, setF] = useState({ username: '', name: '', password: '', password2: '' });
  const go = run(async () => {
    if (f.password !== f.password2) throw new Error('The two passwords are not the same.');
    await api('setup', f); done();
  });
  return (
    <div className="center card">
      <h2>Welcome to Fit-Rend-Base</h2>
      <p className="muted small">Make the Owner account. The Owner has full clearance everywhere.</p>
      <Field label="User name"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" /></Field>
      <Field label="Your name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Password (10 or more characters)"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <Field label="Password again"><input type="password" value={f.password2} onChange={(e) => setF({ ...f, password2: e.target.value })} /></Field>
      <p><button className="primary" onClick={go}>Make Owner account</button></p>
    </div>
  );
}
function Login({ done }) {
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const go = run(async () => { await api('login', { username: u, password: p }); done(); });
  return (
    <form className="center card" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <div className="lock">🐄</div>
      <h2 style={{ textAlign: 'center' }}>Fit-Rend-Base</h2>
      <Field label="User name"><input value={u} onChange={(e) => setU(e.target.value)} autoCapitalize="none" autoComplete="username" /></Field>
      <Field label="Password"><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></Field>
      <p><button className="primary" type="submit">Sign in</button></p>
    </form>
  );
}
function Code2fa({ done }) {
  const [c, setC] = useState('');
  const go = run(async () => { await api('login2fa', { code: c }); done(); });
  return (
    <form className="center card" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <h2>2-step code</h2>
      <p className="muted small">Open your authenticator app and type the 6-digit code for Fit-Rend-Base. You can also use one of your backup codes.</p>
      <input value={c} onChange={(e) => setC(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456" />
      <p className="row"><button className="primary" type="submit">Go on</button><button type="button" onClick={run(async () => { await api('logout'); done(); })}>Cancel</button></p>
    </form>
  );
}
function Clearance({ onDone }) {
  const [c, setC] = useState('');
  const go = run(async () => { await api('clearance', { code: c }); onDone(true); });
  return (
    <Modal onClose={() => onDone(false)}>
      <form onSubmit={(e) => { e.preventDefault(); go(); }}>
        <h2>🔐 Clearance check</h2>
        <p className="muted small">This step needs fresh clearance. Type your 6-digit code from your authenticator app (or your password if 2-step is off).</p>
        <input value={c} onChange={(e) => setC(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" type="password" />
        <p className="row"><button className="primary" type="submit">Check</button><button type="button" onClick={() => onDone(false)}>Cancel</button></p>
      </form>
    </Modal>
  );
}
function ChangePassword({ done }) {
  const [f, setF] = useState({ old: '', password: '', password2: '' });
  const go = run(async () => {
    if (f.password !== f.password2) throw new Error('The two new passwords are not the same.');
    await api('changePassword', f); toast('Password changed'); done && done();
  });
  return (
    <div>
      <Field label="Current password"><input type="password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} /></Field>
      <Field label="New password (10 or more characters)"><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <Field label="New password again"><input type="password" value={f.password2} onChange={(e) => setF({ ...f, password2: e.target.value })} /></Field>
      <p><button className="primary" onClick={go}>Change password</button></p>
    </div>
  );
}
function Codes({ codes, done }) {
  return (
    <div>
      <h3>Your backup codes</h3>
      <p className="muted small">Each one works once if you lose your phone. Save them somewhere safe now. They won't be shown again.</p>
      <div className="card mono">{codes.join('  ')}</div>
      <p className="row"><button onClick={() => copy(codes.join('\n'))}>Copy codes</button><button className="primary" onClick={done}>I saved them</button></p>
    </div>
  );
}
function Setup2fa({ done }) {
  const [d, setD] = useState(null); const [c, setC] = useState(''); const [codes, setCodes] = useState(null);
  useEffect(() => { api('totpBegin').then(setD, (e) => toast(e.message, true)); }, []);
  if (codes) return <Codes codes={codes} done={done} />;
  if (!d) return <p className="muted">Getting your code…</p>;
  return (
    <div>
      <p className="small">1. In your authenticator app, add an account and scan this:</p>
      <img src={d.qr} alt="2-step QR code" style={{ background: '#fff', padding: 6, borderRadius: 8 }} />
      <p className="small muted">Can't scan? Type this key: <span className="mono">{d.secret}</span> <button className="link" onClick={() => copy(d.secret)}>copy</button></p>
      <p className="small">2. Type the 6-digit code the app shows:</p>
      <input value={c} onChange={(e) => setC(e.target.value)} inputMode="numeric" placeholder="123456" />
      <p><button className="primary" onClick={run(async () => { const r = await api('totpConfirm', { code: c }); setCodes(r.codes); })}>Turn on 2-step</button></p>
    </div>
  );
}
function Account({ me, close, reload, start = null }) {
  const [mode, setMode] = useState(start === '2fa' && !me.totpOn ? '2fa' : start === 'rec' && me.totpOn ? 'rec' : null); const [c, setC] = useState(''); const [codes, setCodes] = useState(null);
  return (
    <Modal onClose={close}>
      <h2>My account</h2>
      <p className="small muted">Signed in as <b>{me.username}</b>{me.owner ? ' (Owner)' : ''}. 2-step is {me.totpOn ? 'on' : 'off'}.</p>
      {codes ? <Codes codes={codes} done={() => { setCodes(null); setMode(null); }} />
        : mode === 'pw' ? <ChangePassword done={() => setMode(null)} />
          : mode === '2fa' ? <Setup2fa done={() => { setMode(null); reload(); }} />
            : mode === 'off' || mode === 'rec' ? (
              <div>
                <Field label="Your 6-digit code"><input value={c} onChange={(e) => setC(e.target.value)} inputMode="numeric" /></Field>
                <p><button className="primary" onClick={run(async () => {
                  if (mode === 'off') { await api('totpOff', { code: c }); toast('2-step turned off'); setMode(null); reload(); } else { const r = await api('newRecovery', { code: c }); setCodes(r.codes); }
                })}>{mode === 'off' ? 'Turn off 2-step' : 'Make new backup codes'}</button></p>
              </div>
            ) : (
              <div className="row">
                <button onClick={() => setMode('pw')}>Change password</button>
                {!me.totpOn && <button className="primary" onClick={() => setMode('2fa')}>Turn on 2-step</button>}
                {me.totpOn && <button onClick={() => setMode('rec')}>New backup codes</button>}
                {me.totpOn && <button className="danger" onClick={() => setMode('off')}>Turn off 2-step</button>}
              </div>
            )}
      <p><button onClick={close}>Close</button></p>
    </Modal>
  );
}

function Main({ me, reload }) {
  // A customer sees only their own space: My space, their code (Fit room) and their database (Base room).
  const tabs = me.customer ? ['home', 'repos', 'database'] : Object.keys(SECTION_NAMES);
  const tabName = (x) => (x === 'home' ? 'My space' : SECTION_NAMES[x]);
  // nav: which room, which part of it, and a form to open. Links like /#/contacts/link or /#/repos//new open it too.
  const [nav, setNav] = useState(() => ({ tab: me.customer ? 'home' : tabs.find((x) => me.levels[x] !== 'none') || 'repos', n: 0 }));
  const [help, setHelp] = useState(false);
  const tab = nav.tab;
  const setTab = (x) => setNav((v) => ({ tab: x, n: v.n + 1 }));
  const [acct, setAcct] = useState(false);
  const guideKey = 'frb-guide-seen-' + me.username;
  const [guide, setGuide] = useState(() => { try { return !localStorage.getItem(guideKey); } catch { return false; } });
  const go = (g) => {
    if (!g) return;
    if (g.tab === 'account') { setAcct(g.open || true); return; }
    setAcct(false);
    if (tabs.includes(g.tab)) setNav((v) => ({ tab: g.tab, sub: g.sub, open: g.open, n: v.n + 1 }));
  };
  useEffect(() => {
    const fromHash = () => {
      const m = (window.location.hash || '').match(/^#\/([a-z]+)(?:\/([a-z0-9]*))?(?:\/([a-z0-9]+))?/);
      if (!m) return;
      if (m[1] === 'guide') setGuide(Date.now()); else go({ tab: m[1], sub: m[2] || undefined, open: m[3] || undefined });
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const closeGuide = () => { setGuide(false); try { localStorage.setItem(guideKey, '1'); } catch { /* private window */ } };
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(i); }, []);
  const cleared = me.clearedUntil && new Date(me.clearedUntil) > new Date();
  const mins = cleared ? Math.ceil((new Date(me.clearedUntil) - new Date()) / 60000) : 0;
  const lvl = tab === 'home' ? 'owner' : me.levels[tab];
  const rendIn = me.rendUntil && new Date(me.rendUntil) > new Date();
  const rmins = rendIn ? Math.ceil((new Date(me.rendUntil) - new Date()) / 60000) : 0;
  // The Rend room door locks behind you when you leave it.
  const prevTab = useRef(tab);
  useEffect(() => {
    if (prevTab.current === 'deploys' && tab !== 'deploys' && me.rendUntil) api('rendClose').then(reload).catch(() => {});
    prevTab.current = tab;
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">🔐 Fit-Rend-Base</div>
        {cleared ? <span className="pill ok">Cleared · {mins} min</span> : <button className="pill warn" onClick={run(async () => { if (await clearanceAsk()) reload(); })}>🔐 Clearance check</button>}
        <button className="pill ok" onClick={() => setGuide(Date.now())}>🧭 Guide</button>
        <button className="pill warn" onClick={() => setHelp(true)}>🆘 Get help</button>
        <button className="pill" onClick={() => setAcct(true)}>{me.name || me.username}</button>
        <button className="pill" onClick={run(async () => { await api('logout'); reload(); })}>Sign out</button>
      </div>
      <div className="tabs">
        {tabs.map((x) => <button key={x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>{x !== 'home' && (me.levels[x] === 'none' || (x === 'deploys' && !rendIn)) ? '🔒 ' : ''}{tabName(x)}</button>)}
      </div>
      {tab !== 'home' && <div className="small muted">Your clearance in {SECTION_NAMES[tab]}: <b>{LEVEL_NAMES[lvl]}</b></div>}
      {tab === 'home' ? <MyHome key={nav.n} me={me} go={go} reload={reload} /> : lvl === 'none' ? (
        <div className="card center" style={{ textAlign: 'center' }}><div className="lock">🔒</div><h2>{OWNER_ONLY.includes(tab) ? 'Owner only' : 'No clearance'}</h2><p className="muted">{OWNER_ONLY.includes(tab) ? `Only the owner goes into the ${SECTION_NAMES[tab]}.` : `You don't have clearance for ${SECTION_NAMES[tab]}. Ask an Admin to give you access.`}</p></div>
      ) : tab === 'repos' ? <Repos key={nav.n} startNew={nav.open === 'new'} /> : tab === 'deploys' ? (!rendIn ? <RendDoor reload={reload} /> : (
        <>
          <div className="row" style={{ marginTop: 8 }}><span className="pill ok">🚪 Rend room open · {rmins} min</span><button className="pill" onClick={run(async () => { await api('rendClose'); reload(); })}>Lock the door</button></div>
          <Deploys key={nav.n} startNew={nav.open === 'new'} />
        </>
      )) : tab === 'dns' ? <DnsRoom key={nav.n} startNew={nav.open === 'new'} /> : tab === 'handover' ? <Handover key={nav.n} startNew={nav.open === 'new'} /> : tab === 'database' ? <Database key={nav.n} startNew={nav.open === 'new'} /> : tab === 'contacts' ? <Contacts key={nav.n} me={me} start={nav.sub} /> : tab === 'connectors' ? <Connectors me={me} /> : <Admin key={nav.n} me={me} start={nav.sub} />}
      {acct && <Account me={me} close={() => setAcct(false)} reload={reload} start={typeof acct === 'string' ? acct : null} />}
      <Guide me={me} open={guide} onClose={closeGuide} go={go} />
      {help && <GetHelp room={tabName(tab)} close={() => setHelp(false)} />}
    </div>
  );
}

/* ================= customer pipeline ================= */
// Get help: the problem becomes a request that says which room the person was in.
function GetHelp({ room, close }) {
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(false);
  const [d, load] = useLoad(() => api('myHome'), []);
  return (
    <Modal onClose={close}>
      <h2>🆘 Get help</h2>
      {sent ? <p>Got it. Your request is in, and the answer shows up right here and on My space.</p> : (
        <>
          <p className="small muted">You are in: <b>{room}</b>. We send that with your request, so you don't have to explain where you were.</p>
          <label>What went wrong, or what are you trying to do?</label>
          <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Example: I pressed Save and nothing happened" style={{ minHeight: 110 }} />
          <p className="small muted">Tip: tap the 🎤 on your phone's keyboard to say it out loud.</p>
        </>
      )}
      <div className="row">
        {!sent && <button className="primary" disabled={msg.trim().length < 3} onClick={run(async () => { await api('ticketOpen', { room, message: msg }); setSent(true); setMsg(''); load(); })}>Send my request</button>}
        <button onClick={close}>Close</button>
      </div>
      {d && d.tickets.length > 0 && <MyTickets tickets={d.tickets} />}
    </Modal>
  );
}
function MyTickets({ tickets }) {
  return (
    <div>
      <h3>Your requests</h3>
      <div className="list">
        {tickets.map((t) => (
          <div key={t.id}><span className="grow"><b>{t.message.slice(0, 120)}</b><br /><span className="small muted">{t.room} · {when(t.created_at)}</span>
            {t.reply && <><br /><span className="small">💬 {t.reply}</span></>}</span>
          <span className={'pill ' + (t.status === 'open' ? 'warn' : 'ok')}>{t.status === 'open' ? 'Waiting' : 'Answered'}</span></div>
        ))}
      </div>
    </div>
  );
}
// A customer's home screen: their plan, their code spaces and databases, their share link and their help requests.
function MyHome({ me, go, reload }) {
  const [d, load] = useLoad(() => api('myHome'), []);
  const [name, setName] = useState('');
  if (!d) return <div className="muted">Loading…</div>;
  if (!d.customer) return <div className="card">This screen is for customer accounts. Use the rooms above.</div>;
  const room = (n, used, lim) => `${used} of ${lim} ${n}`;
  return (
    <div>
      <div className="card">
        <h2>Welcome{me.name ? ', ' + me.name.split(' ')[0] : ''} 👋</h2>
        <p className="muted small">Your plan: <b>{d.planName || 'None'}</b>{d.plan === 'cancelled' ? '. Your plan ended, so you can open your things but not make new ones.' : ''}</p>
        {d.plan === 'own' && <p className="small">Your Own Server License code is on its way from us. Your code space here is for trying it out.</p>}
      </div>
      <div className="card">
        <h3>1. Your code ({room('code spaces', d.used.repos, d.limits.repos)})</h3>
        <div className="list">{d.repos.map((r) => <div key={r.id} className="click" onClick={() => go({ tab: 'repos' })}><span className="grow"><b>{r.name}</b></span><span className="pill">Open</span></div>)}</div>
        {d.used.repos < d.limits.repos && (
          <div className="row"><input className="grow" placeholder="Name it, like shop" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="primary" onClick={run(async () => { await api('myRepoCreate', { name: name || 'app' }); setName(''); toast('Your code space is ready'); load(); })}>Make my code space</button></div>
        )}
      </div>
      <div className="card">
        <h3>2. Your database ({room('databases', d.used.projects, d.limits.projects)})</h3>
        <div className="list">{d.projects.map((p) => <div key={p.id} className="click" onClick={() => go({ tab: 'database' })}><span className="grow"><b>{p.name || p.slug}</b></span><span className="pill">Open</span></div>)}</div>
        {d.used.projects < d.limits.projects && <div className="row"><button className="primary" onClick={run(async () => { await api('myProjectCreate', { name: 'data' }); toast('Your database is ready'); load(); reload(); })}>Make my database</button></div>}
      </div>
      {d.share && (
        <div className="card">
          <h3>🎁 Get a free month</h3>
          <p className="small muted">Send your link to a friend. When they pay for a plan through it, you get a free month.</p>
          <div className="row"><input className="grow" readOnly value={d.share.link} /><button onClick={() => copy(d.share.link)}>Copy my link</button></div>
          <p className="small muted">{d.share.friends} friend{d.share.friends === 1 ? '' : 's'} joined · {d.share.given} free month{d.share.given === 1 ? '' : 's'} given</p>
        </div>
      )}
      {d.tickets.length > 0 && <div className="card"><MyTickets tickets={d.tickets} /></div>}
    </div>
  );
}
// Contacts > Pipeline: everyone moves from left to right by themselves. You can also move someone by hand.
function Pipeline({ lvl }) {
  const canDev = atLeast(lvl, 'developer');
  const [d, load] = useLoad(() => api('pipelineBoard'), []);
  const [open, setOpen] = useState(null);
  const move = (id, stage) => run(async () => { await api('contactStage', { id, stage }); load(); })();
  if (!d) return <div className="muted">Loading…</div>;
  const names = Object.fromEntries(d.columns.map((c) => [c.stage, c.name]));
  return (
    <div>
      <h2>Pipeline</h2>
      <p className="small muted">People move by themselves: a lead comes in, a payment makes them Paid, Get help makes them Needs help, and an answer moves them back.</p>
      <div className="board">
        {d.columns.map((c) => (
          <div key={c.stage} className="col">
            <div className="row"><b className="grow">{c.name}</b><span className="pill">{c.count}</span></div>
            {c.people.map((p) => (
              <div key={p.id} className="card click" onClick={() => setOpen(p.id)}>
                <b>{p.name || p.email}</b>{p.name && <div className="small muted">{p.email}</div>}
                {canDev && <select value={p.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => move(p.id, e.target.value)} style={{ marginTop: 6 }}>{Object.entries(names).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>}
              </div>
            ))}
            {!c.count && <div className="small muted">Nobody here.</div>}
          </div>
        ))}
      </div>
      {open && <ContactView id={open} canDev={canDev} canAdmin={atLeast(lvl, 'admin')} close={() => { setOpen(null); load(); }} />}
    </div>
  );
}
// Contacts > Help requests: answer one and it closes.
function HelpRequests({ lvl }) {
  const canDev = atLeast(lvl, 'developer');
  const [status, setStatus] = useState('open');
  const [d, load] = useLoad(() => api('ticketList', { status }), [status]);
  const [reply, setReply] = useState({});
  return (
    <div>
      <div className="row"><h2 className="grow">Help requests {d && <span className="small muted">· {d.open} waiting</span>}</h2>
        <button className={status === 'open' ? 'primary' : ''} onClick={() => setStatus('open')}>Waiting</button>
        <button className={status === 'closed' ? 'primary' : ''} onClick={() => setStatus('closed')}>Answered</button></div>
      {(d?.tickets || []).map((t) => (
        <div key={t.id} className="card">
          <div className="small muted">#{t.id} · {t.username}{t.email ? ' · ' + t.email : ''}{t.plan ? ' · ' + t.plan : ''} · {when(t.created_at)}</div>
          <div className="small">Was in: <b>{t.room || 'unknown'}</b></div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{t.message}</p>
          {t.status === 'closed' ? <p className="small">💬 {t.reply} <span className="muted">· {t.replied_by}</span></p> : canDev && (
            <>
              <textarea placeholder="Your answer. They see it in the app." value={reply[t.id] || ''} onChange={(e) => setReply({ ...reply, [t.id]: e.target.value })} />
              <div className="row"><button className="primary" onClick={run(async () => { await api('ticketReply', { id: t.id, reply: reply[t.id] || '' }); toast('Answered'); load(); })}>Answer and close</button></div>
            </>
          )}
        </div>
      ))}
      {d && !d.tickets.length && <div className="muted small">{status === 'open' ? 'No one is waiting for help.' : 'No answered requests yet.'}</div>}
    </div>
  );
}
// Admin > Customer pipeline (owner only): the switches. Everything starts off.
function PipelineSettings() {
  const [d, load] = useLoad(() => api('pipelineGet'), []);
  const [c, loadC] = useLoad(() => api('customerList'), []);
  const [whsec, setWhsec] = useState(''); const [key, setKey] = useState(''); const [coupon, setCoupon] = useState(null);
  const [mails, setMails] = useState(null); const [testTo, setTestTo] = useState(''); const [link, setLink] = useState(null);
  useEffect(() => { if (d && !mails) setMails(d.welcome); if (d && coupon === null) setCoupon(d.rewardCoupon || ''); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="muted">Loading…</div>;
  const set = (patch, msg) => run(async () => { await api('pipelineSet', patch); toast(msg || 'Saved'); load(); })();
  const Switch = ({ k, title, text }) => (
    <div className="row" style={{ alignItems: 'flex-start', margin: '10px 0' }}>
      <span className="grow"><b>{title}</b><br /><span className="small muted">{text}</span></span>
      <button className={d[k] ? 'primary' : ''} onClick={() => set({ [k]: !d[k] }, d[k] ? 'Turned off' : 'Turned on')}>{d[k] ? 'On' : 'Off'}</button>
    </div>
  );
  return (
    <div>
      <div className="card">
        <h2>Step 1. Connect Stripe</h2>
        <p className="small">In Stripe, add a webhook to this address, for the events <b>checkout.session.completed</b> and <b>customer.subscription.deleted</b>:</p>
        <div className="row"><input className="grow" readOnly value={d.webhookUrl} /><button onClick={() => copy(d.webhookUrl)}>Copy</button></div>
        <p className="small muted">Stripe then shows a signing secret that starts with whsec_. Paste it here. {d.hasWhsec ? '✅ Saved.' : 'Not saved yet.'}</p>
        <div className="row"><input className="grow" type="password" placeholder="whsec_…" value={whsec} onChange={(e) => setWhsec(e.target.value)} /><button className="primary" disabled={!whsec} onClick={() => { set({ whsec }, 'Signing secret saved'); setWhsec(''); }}>Save</button></div>
      </div>
      <div className="card">
        <h2>Step 2. Turn on what you want</h2>
        <Switch k="accountsOn" title="Account after payment" text="A payment makes the customer's own sign-in. They sign in with their email and see only their own space." />
        <Switch k="welcomeOn" title="Welcome emails" text="3 emails from your Gmail walk new customers through setup. Needs Contacts > Connection to LeadReplyRadar." />
        <Switch k="rewardsOn" title="Share link rewards" text="Each customer gets a share link. A friend who pays through it earns them a free month." />
        <p className="small muted">Payments from Stripe always move people to Paid on the pipeline board.</p>
      </div>
      {mails && (
        <div className="card">
          <h2>Welcome emails</h2>
          <p className="small muted">You can use {'{{first_name}}'}, {'{{plan}}'}, {'{{signin_link}}'}, {'{{set_password_link}}'} and {'{{share_link}}'}. Every email gets your footer and an unsubscribe link.</p>
          {mails.map((m, i) => (
            <div key={i} className="box" style={{ marginBottom: 10 }}>
              <div className="row"><b className="grow">Email {i + 1}</b><span className="small muted">Send</span><input type="number" min="0" max="30" value={m.delayDays} onChange={(e) => setMails(mails.map((x, j) => (j === i ? { ...x, delayDays: e.target.value } : x)))} style={{ width: 70 }} /><span className="small muted">days after payment</span></div>
              <input value={m.subject} onChange={(e) => setMails(mails.map((x, j) => (j === i ? { ...x, subject: e.target.value } : x)))} />
              <textarea value={m.body} onChange={(e) => setMails(mails.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} style={{ minHeight: 160 }} />
              <div className="row"><input className="grow" placeholder="Your own email, for a test" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <button onClick={run(async () => { await api('welcomeTest', { to: testTo, step: i }); toast('Test sent to ' + testTo); })}>Send me a test</button></div>
            </div>
          ))}
          <div className="row"><button className="primary" onClick={() => set({ welcome: mails }, 'Welcome emails saved')}>Save the emails</button></div>
          {Object.keys(d.welcomeCounts).length > 0 && <p className="small muted">So far: {Object.entries(d.welcomeCounts).map(([k, n]) => `${n} ${k}`).join(', ')}</p>}
        </div>
      )}
      <div className="card">
        <h2>Free months</h2>
        <p className="small muted">Leave these empty and you give free months by hand in Stripe, then press Mark given below. To have it happen by itself, make a 100% off, once coupon in Stripe and a restricted key that can change subscriptions. {d.hasStripeKey ? '✅ Key saved.' : ''}</p>
        <div className="row"><input className="grow" placeholder="Coupon ID, like FREEMONTH" value={coupon || ''} onChange={(e) => setCoupon(e.target.value)} /><button onClick={() => set({ rewardCoupon: coupon })}>Save coupon</button></div>
        <div className="row"><input className="grow" type="password" placeholder="rk_live_…" value={key} onChange={(e) => setKey(e.target.value)} /><button className="primary" disabled={!key} onClick={() => { set({ stripeKey: key }, 'Key saved'); setKey(''); }}>Save key</button>{d.hasStripeKey && <button className="danger" onClick={() => set({ stripeKey: '' }, 'Key removed')}>Remove key</button>}</div>
      </div>
      <div className="card">
        <h2>Customers {c && <span className="small muted">· {c.customers.length}</span>}</h2>
        <div className="list">
          {(c?.customers || []).map((u) => (
            <div key={u.id}><span className="grow"><b>{u.name || u.email}</b> <span className="small muted">· {u.email} · {u.plan}{u.open_tickets ? ` · ${u.open_tickets} help waiting` : ''}</span><br />
              <span className="small muted">{u.claimed ? 'Password set' : 'Has not set a password yet'} · since {when(u.created_at)}</span></span>
              {!u.claimed && <button onClick={run(async () => { setLink(await api('customerLink', { userId: u.id })); })}>Get password link</button>}</div>
          ))}
          {c && !c.customers.length && <div className="small muted">No customers yet. They show up here after a payment, once Account after payment is on.</div>}
        </div>
        {link && <div className="box"><p className="small">Send this to {link.email}. It works once, for 7 days.</p><div className="row"><input className="grow" readOnly value={link.link} /><button onClick={() => copy(link.link)}>Copy</button></div></div>}
      </div>
      <div className="card">
        <h2>Share link rewards {c && <span className="small muted">· {c.referrals.filter((r) => r.status !== 'given').length} owed</span>}</h2>
        <div className="list">
          {(c?.referrals || []).map((r) => (
            <div key={r.id}><span className="grow"><b>{r.referrer_email || r.referrer}</b> <span className="small muted">brought {r.friend_email} · {when(r.created_at)}{r.note ? ' · ' + r.note : ''}</span></span>
              {r.status === 'given' ? <span className="pill ok">Given</span> : <button onClick={run(async () => { await api('referralMark', { id: r.id }); loadC(); })}>Mark given</button>}</div>
          ))}
          {c && !c.referrals.length && <div className="small muted">No rewards yet.</div>}
        </div>
      </div>
      {d.events.length > 0 && (
        <div className="card"><h3>Latest from Stripe</h3><div className="list">{d.events.map((e) => <div key={e.id}><span className="grow small"><b>{e.type}</b> · {when(e.at)}<br /><span className="muted">{e.note}</span></span></div>)}</div></div>
      )}
    </div>
  );
}

function RendDoor({ reload }) {
  const [c, setC] = useState('');
  const go = run(async () => { await api('rendOpen', { code: c }); setC(''); reload(); });
  return (
    <form className="card center" style={{ textAlign: 'center' }} onSubmit={(e) => { e.preventDefault(); go(); }}>
      <div className="lock">🚪🔒</div>
      <h2>Rend room door</h2>
      <p className="muted small">Only the owner goes in here. Type your 6-digit code to open the door. It locks again when you leave the Rend room, or after your clearance time runs out.</p>
      <input value={c} onChange={(e) => setC(e.target.value)} type="password" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus />
      <p><button className="primary" type="submit">Open the door</button></p>
    </form>
  );
}

/* ================= keys and values (shared) ================= */
function Secrets({ scope, scopeId, title, canEdit, canAdmin }) {
  const [d, load, err] = useLoad(() => api('secretList', { scope, scopeId }), [scope, scopeId]);
  const [k, setK] = useState(''); const [v, setV] = useState('');
  return (
    <div>
      <h3>{title || 'Keys and values'}</h3>
      <p className="small muted">Values are locked (encrypted) on the server. Showing a value needs Admin clearance and a fresh clearance check. Double tap a box to make it bigger, tap again to make it small. Keys another app needs go in the Handover room.</p>
      {err && <p className="muted">{err}</p>}
      <div className="list">
        {(d?.secrets || []).map((x) => <SecretRow key={x.key} x={x} scope={scope} scopeId={scopeId} canEdit={canEdit} canAdmin={canAdmin} reload={load} />)}
        {d && !d.secrets.length && <div className="muted small">No keys yet.</div>}
      </div>
      {canEdit && (
        <div className="card">
          <Field label="Key name"><input placeholder="KEY_NAME" value={k} onChange={(e) => setK(e.target.value)} autoCapitalize="none" /></Field>
          <Field label="Value"><KeyBox value={v} onChange={setV} /></Field>
          <p><button className="primary" onClick={run(async () => { await api('secretSet', { scope, scopeId, key: k, value: v }); setK(''); setV(''); toast('Saved'); load(); })}>Save key</button></p>
        </div>
      )}
    </div>
  );
}
function SecretRow({ x, scope, scopeId, canEdit, canAdmin, reload }) {
  const [val, setVal] = useState(''); const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: 'block' }}>
      <div className="row">
        <span className="mono grow">{x.key}</span>
        <span className="small muted">{x.updated_by} · {when(x.updated_at)}</span>
        {canAdmin && <button className="danger" onClick={run(async () => { if (!confirm('Delete ' + x.key + '?')) return; await api('secretDelete', { scope, scopeId, key: x.key }); reload(); })}>Delete</button>}
      </div>
      <KeyBox value={val} placeholder="•••••••• (saved)" readOnly={!canEdit} generate={canEdit}
        reveal={canAdmin ? async () => (await api('secretReveal', { scope, scopeId, key: x.key })).value : null}
        onChange={(nv, fromServer) => { setVal(nv); setDirty(!fromServer); }} />
      {dirty && <p className="row"><button className="primary" onClick={run(async () => { await api('secretSet', { scope, scopeId, key: x.key, value: val }); setDirty(false); toast('Saved'); reload(); })}>Save new value</button><button onClick={() => { setVal(''); setDirty(false); }}>Cancel</button></p>}
    </div>
  );
}

/* ================= repos ================= */
function Repos({ startNew }) {
  const [d, load] = useLoad(() => api('repoList'), []);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(startNew ? { name: '', description: '' } : null);
  if (sel) return <Repo repo={sel} back={() => { setSel(null); load(); }} />;
  return (
    <div>
      <div className="row"><h2 className="grow">Repos</h2>{d?.canCreate && <button className="primary" onClick={() => setForm({ name: '', description: '' })}>New repo</button>}</div>
      {form && (
        <div className="card">
          <Field label="Repo name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoCapitalize="none" /></Field>
          <Field label="What it is (optional)"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <p className="row"><button className="primary" onClick={run(async () => { await api('repoCreate', form); setForm(null); load(); })}>Make repo</button><button onClick={() => setForm(null)}>Cancel</button></p>
        </div>
      )}
      <div className="list">
        {(d?.repos || []).map((r) => (
          <div key={r.id} className="click" onClick={() => setSel(r)}>
            <b className="grow">📁 {r.name}</b><span className="small muted">{r.description}</span>
            <span className="small muted">{r.last_message ? `${r.last_message} · ${when(r.updated_at)}` : 'empty'}</span><span className="pill">{LEVEL_NAMES[r.level]}</span>
          </div>
        ))}
        {d && !d.repos.length && <div className="muted">No repos yet.</div>}
      </div>
    </div>
  );
}
function Repo({ repo, back }) {
  const [view, setView] = useState('files');
  const [d, load] = useLoad(() => api('fileList', { repoId: repo.id }), [repo.id]);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const fileIn = useRef(); const dirIn = useRef();
  const lvl = d?.level || repo.level;
  const canEdit = atLeast(lvl, 'developer'); const canAdmin = atLeast(lvl, 'admin');
  const openFile = run(async (p) => { const r = await api('fileGet', { repoId: repo.id, path: p }); setOpen({ path: p, ...r, draft: r.text ?? null }); });
  const save = run(async () => {
    const msg = prompt('What did you change?', 'Update ' + open.path);
    if (msg === null) return;
    const r = await api('commit', { repoId: repo.id, message: msg, files: [{ path: open.path, text: open.draft }] });
    toast(r.nothing ? 'No changes to save' : 'Saved as commit #' + r.commit); setOpen({ ...open, text: open.draft }); load();
  });
  const upload = run(async (list, folder) => {
    const files = Array.from(list || []); if (!files.length) return;
    const base = prompt('Put the files in which folder? Leave empty for the top of the repo.', '');
    if (base === null) return;
    const pre = base.trim() ? base.trim().replace(/^\/+|\/+$/g, '') + '/' : '';
    let batch = []; let bytes = 0; let done = 0;
    const send = async () => {
      if (!batch.length) return;
      await api('commit', { repoId: repo.id, message: `Upload ${files.length} file${files.length > 1 ? 's' : ''}`, files: batch });
      batch = []; bytes = 0;
    };
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { toast(f.name + ' is over 10 MB and was skipped', true); continue; }
      let p = folder && f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
      if (/(^|\/)(node_modules|\.git|\.next)\//.test(p + '/')) continue;
      batch.push({ path: pre + p, b64: bufToB64(await f.arrayBuffer()) }); bytes += f.size; done++;
      setBusy(`Uploading ${done} of ${files.length}…`);
      if (bytes > 6 * 1024 * 1024 || batch.length >= 200) await send();
    }
    await send(); setBusy(''); toast('Uploaded ' + done + ' files'); load();
  });
  return (
    <div>
      <div className="row"><button onClick={back}>← Repos</button><h2 className="grow">📁 {repo.name}</h2><span className="pill">{LEVEL_NAMES[lvl]}</span></div>
      <div className="tabs">{['files', 'history', 'keys', 'settings'].map((v) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{{ files: 'Files', history: 'History', keys: 'Keys and values', settings: 'Settings' }[v]}</button>)}</div>
      {view === 'files' && (
        <div className="grid2">
          <div>
            <div className="row" style={{ marginBottom: 8 }}>
              {canEdit && <button onClick={run(async () => { const p = prompt('New file path, like index.html or css/style.css'); if (!p) return; await api('commit', { repoId: repo.id, message: 'Add ' + p, files: [{ path: p, text: '' }] }); await load(); openFile(p); })}>New file</button>}
              {canEdit && <button onClick={() => fileIn.current.click()}>Upload files</button>}
              {canEdit && <button onClick={() => dirIn.current.click()}>Upload folder</button>}
              <a href={`/api/get?what=zip&repo=${repo.id}`}><button>Download zip</button></a>
              <input ref={fileIn} type="file" multiple hidden onChange={(e) => { upload(e.target.files, false); e.target.value = ''; }} />
              <input ref={dirIn} type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => { upload(e.target.files, true); e.target.value = ''; }} />
            </div>
            {busy && <p className="small muted">{busy}</p>}
            <div className="list">
              {(d?.files || []).map((f) => (
                <div key={f.path} className={'click' + (open?.path === f.path ? ' sel' : '')} onClick={() => openFile(f.path)}>
                  <span className="mono grow">{f.path}</span><span className="small muted">{size(f.size)}</span>
                </div>
              ))}
              {d && !d.files.length && <div className="muted small">No files yet.</div>}
            </div>
          </div>
          <div>
            {!open ? <p className="muted">Pick a file to see it.</p> : (
              <div className="card">
                <div className="row"><b className="mono grow">{open.path}</b>
                  <a href={`/api/get?what=file&repo=${repo.id}&path=${encodeURIComponent(open.path)}`}><button>Download</button></a>
                  {canEdit && <button className="danger" onClick={run(async () => { if (!confirm('Delete ' + open.path + '?')) return; await api('commit', { repoId: repo.id, message: 'Delete ' + open.path, files: [{ path: open.path, remove: true }] }); setOpen(null); load(); })}>Delete</button>}
                </div>
                {open.b64 != null ? (
                  /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(open.path) ? <img src={`data:image/${open.path.split('.').pop().replace('svg', 'svg+xml').replace('jpg', 'jpeg')};base64,${open.b64}`} alt="" style={{ maxWidth: '100%', marginTop: 10 }} /> : <p className="muted">This is not a text file. Use Download to get it.</p>
                ) : (
                  <>
                    <textarea value={open.draft} onChange={(e) => setOpen({ ...open, draft: e.target.value })} readOnly={!canEdit} spellCheck={false} style={{ minHeight: '50vh', marginTop: 10 }} />
                    {canEdit && <p className="row"><button className="primary" disabled={open.draft === open.text} onClick={save}>Save change</button>{open.draft !== open.text && <span className="small muted">Not saved yet</span>}</p>}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {view === 'history' && <History repo={repo} canEdit={canEdit} reload={load} />}
      {view === 'keys' && <Secrets scope="repo" scopeId={repo.id} canEdit={canEdit} canAdmin={canAdmin} />}
      {view === 'settings' && <RepoSettings repo={repo} canAdmin={canAdmin} back={back} />}
    </div>
  );
}
function History({ repo, canEdit, reload }) {
  const [d] = useLoad(() => api('history', { repoId: repo.id }), [repo.id]);
  const [diff, setDiff] = useState(null);
  const show = run(async (c, ch) => {
    const a = ch.before ? await api('fileGet', { repoId: repo.id, h: ch.before }) : { text: '' };
    const b = ch.after ? await api('fileGet', { repoId: repo.id, h: ch.after }) : { text: '' };
    setDiff({ c, ch, a, b });
  });
  return (
    <div>
      {diff && (
        <Modal onClose={() => setDiff(null)}>
          <h3 className="mono">{diff.ch.path}</h3>
          <p className="small muted">Commit #{diff.c.id} · {diff.c.message} · {diff.c.author} · {when(diff.c.at)}</p>
          {diff.a.b64 != null || diff.b.b64 != null ? <p className="muted">Not a text file.</p> : (() => {
            const lines = lineDiff(diff.a.text, diff.b.text);
            return lines ? <div className="diff card">{lines.map(([k, l], i) => <div key={i} className={k === '+' ? 'add' : k === '-' ? 'del' : ''}>{k} {l}</div>)}</div> : <p className="muted">File too big to compare.</p>;
          })()}
          <p className="row">
            {canEdit && <button onClick={run(async () => {
              const keep = diff.ch.after ? diff.b : diff.a; const label = diff.ch.after ? 'this version' : 'the file before it was deleted';
              if (!confirm('Bring back ' + label + ' of ' + diff.ch.path + '?')) return;
              await api('commit', { repoId: repo.id, message: `Restore ${diff.ch.path} from #${diff.c.id}`, files: [{ path: diff.ch.path, ...(keep.b64 != null ? { b64: keep.b64 } : { text: keep.text }) }] });
              toast('Restored'); setDiff(null); reload();
            })}>Bring back this version</button>}
            <button onClick={() => setDiff(null)}>Close</button>
          </p>
        </Modal>
      )}
      <div className="list">
        {(d?.commits || []).map((c) => (
          <div key={c.id} style={{ display: 'block' }}>
            <div className="row"><b className="grow">#{c.id} {c.message}</b><span className="small muted">{c.author} · {when(c.at)}</span>
              <a href={`/api/get?what=zip&repo=${repo.id}&commit=${c.id}`}><button>Zip at this point</button></a></div>
            <div className="small">{c.changed.slice(0, 30).map((ch) => <div key={ch.path}><button className="link" onClick={() => show(c, ch)}>{{ add: '＋', edit: '✎', delete: '✕' }[ch.op]} {ch.path}</button></div>)}
              {c.changed.length > 30 && <span className="muted">and {c.changed.length - 30} more</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
function RepoSettings({ repo, canAdmin, back }) {
  const [desc, setDesc] = useState(repo.description || ''); const [conf, setConf] = useState('');
  if (!canAdmin) return <p className="muted">You need Admin clearance on this repo for settings.</p>;
  return (
    <div className="card">
      <Field label="What it is"><input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <p><button onClick={run(async () => { await api('repoUpdate', { repoId: repo.id, description: desc }); toast('Saved'); })}>Save</button></p>
      <h3>Delete repo</h3>
      <p className="small muted">This deletes every file and its history. Type <b>{repo.name}</b> to confirm.</p>
      <div className="row"><input className="grow" value={conf} onChange={(e) => setConf(e.target.value)} /><button className="danger" onClick={run(async () => { await api('repoDelete', { repoId: repo.id, confirm: conf }); toast('Repo deleted'); back(); })}>Delete repo</button></div>
    </div>
  );
}

/* ================= deploys ================= */
const VIS = { public: 'Anyone with the link', key: 'Only people with the key link', clearance: 'Only you (the owner, signed in)' };
function Deploys({ startNew }) {
  const [d, load] = useLoad(() => api('siteList'), []);
  const [repos] = useLoad(() => api('repoList').catch(() => ({ repos: [] })), []);
  const [form, setForm] = useState(startNew ? { slug: '', repoId: '', folder: '', visibility: 'clearance' } : null);
  useEffect(() => { if (form && !form.repoId && repos?.repos?.[0]) setForm((f) => ({ ...f, repoId: repos.repos[0].id })); }, [repos, form]);
  const [open, setOpen] = useState(null);
  return (
    <div>
      <div className="row"><h2 className="grow">Rend room · Deploys</h2>{d?.canCreate && <button className="primary" onClick={() => setForm({ slug: '', repoId: repos?.repos?.[0]?.id || '', folder: '', visibility: 'clearance' })}>New site</button>}</div>
      <p className="small muted">A site shows the files of a repo at its own link. Deploy again to publish new changes. Sites are plain web files (HTML, CSS, JavaScript, pictures).</p>
      {form && (
        <div className="card">
          <Field label="Link name (the link will end in /s/this-name/)"><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} autoCapitalize="none" /></Field>
          <Field label="Repo"><select value={form.repoId} onChange={(e) => setForm({ ...form, repoId: e.target.value })}>{(repos?.repos || []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Folder in the repo to publish (empty = whole repo, or like out or dist)"><input value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} autoCapitalize="none" /></Field>
          <Field label="Who can open it"><select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>{Object.entries(VIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <p className="row"><button className="primary" onClick={run(async () => { await api('siteCreate', { ...form, repoId: Number(form.repoId) }); setForm(null); load(); })}>Make site</button><button onClick={() => setForm(null)}>Cancel</button></p>
        </div>
      )}
      <div className="list">
        {(d?.sites || []).map((x) => <Site key={x.id} site={x} reload={load} open={open === x.id} toggle={() => setOpen(open === x.id ? null : x.id)} />)}
        {d && !d.sites.length && <div className="muted">No sites yet.</div>}
      </div>
    </div>
  );
}
function Site({ site, reload, open, toggle }) {
  const [qr, setQr] = useState(null); const [deps, setDeps] = useState(null);
  const [f, setF] = useState({ visibility: site.visibility, expiresAt: site.expiresAt ? site.expiresAt.slice(0, 10) : '', folder: (site.folder || '').replace(/\/$/, '') });
  const canDev = atLeast(site.level, 'developer'); const canAdmin = atLeast(site.level, 'admin');
  return (
    <div style={{ display: 'block' }}>
      <div className="row">
        <b className="grow">🌐 {site.slug}</b>
        <span className="pill">{VIS[site.visibility]}</span>
        {site.expiresAt && <span className={'pill ' + (new Date(site.expiresAt) < new Date() ? 'bad' : '')}>Ends {new Date(site.expiresAt).toLocaleDateString()}</span>}
        {!site.commitId ? <span className="pill warn">Not deployed</span> : site.behind ? <span className="pill warn">New changes waiting</span> : <span className="pill ok">Live</span>}
      </div>
      <div className="small muted">From repo {site.repoName || '(deleted)'}{site.folder ? ' / ' + site.folder : ''}{site.commitId ? ' · commit #' + site.commitId : ''}</div>
      <div className="row" style={{ marginTop: 6 }}>
        <span className="mono grow small">{site.link}</span>
        <button onClick={() => copy(site.link)}>Copy link</button>
        <a href={site.link} target="_blank" rel="noreferrer"><button>Open</button></a>
        <button onClick={run(async () => setQr((await api('siteQr', { siteId: site.id })).qr))}>QR code</button>
        {canDev && <button className="primary" onClick={run(async () => { await api('siteDeploy', { siteId: site.id }); toast('Deployed'); reload(); })}>Deploy now</button>}
        <button onClick={toggle}>{open ? 'Less' : 'More'}</button>
      </div>
      {qr && <Modal onClose={() => setQr(null)}><img src={qr} alt="QR code" style={{ background: '#fff', padding: 8, borderRadius: 8, width: '100%' }} /><p><button onClick={() => setQr(null)}>Close</button></p></Modal>}
      {open && (
        <div className="card">
          <h3>Deploy history</h3>
          {!deps ? <button onClick={run(async () => setDeps((await api('siteDeploys', { siteId: site.id })).deploys))}>Show deploys</button> : (
            <div className="list">{deps.map((x) => (
              <div key={x.id}><span className="grow small">#{x.commit_id} {x.message} · {x.note} by {x.by_user} · {when(x.at)}</span>
                {canDev && x.commit_id !== site.commitId && <button onClick={run(async () => { if (!confirm('Go back to commit #' + x.commit_id + '?')) return; await api('siteDeploy', { siteId: site.id, commitId: x.commit_id }); toast('Rolled back'); reload(); })}>Roll back to this</button>}
              </div>))}{!deps.length && <div className="muted small">No deploys yet.</div>}</div>
          )}
          {canAdmin && (
            <>
              <h3>Link settings</h3>
              <Field label="Who can open it"><select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>{Object.entries(VIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Link stops working after (optional)"><input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
              <Field label="Folder to publish"><input value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} /></Field>
              <p className="row">
                <button className="primary" onClick={run(async () => { await api('siteUpdate', { siteId: site.id, ...f, expiresAt: f.expiresAt ? f.expiresAt + 'T23:59:59' : null }); toast('Saved'); reload(); })}>Save</button>
                {site.visibility === 'key' && <button onClick={run(async () => { if (!confirm('Make a new key? The old link stops working.')) return; await api('siteUpdate', { siteId: site.id, ...f, expiresAt: f.expiresAt ? f.expiresAt + 'T23:59:59' : null, newKey: true }); toast('New key made'); reload(); })}>New key</button>}
                <button className="danger" onClick={run(async () => { if (!confirm('Delete site ' + site.slug + '? The link stops working.')) return; await api('siteDelete', { siteId: site.id }); reload(); })}>Delete site</button>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= database ================= */
function Database({ startNew }) {
  const [d, load] = useLoad(() => api('projectList'), []);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(startNew ? { slug: '', name: '' } : null);
  if (sel) return <Project p={sel} base={d.base} back={() => { setSel(null); load(); }} />;
  return (
    <div>
      <div className="row"><h2 className="grow">Database projects</h2>{d?.canCreate && <button className="primary" onClick={() => setForm({ slug: '', name: '' })}>New project</button>}</div>
      <p className="small muted">Each project is its own database with tables, SQL, row policies, an API address and keys.</p>
      {form && (
        <div className="card">
          <Field label="Project name (small letters, numbers, _)"><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} autoCapitalize="none" /></Field>
          <Field label="Label (optional)"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <p className="row"><button className="primary" onClick={run(async () => { await api('projectCreate', form); setForm(null); load(); })}>Make project</button><button onClick={() => setForm(null)}>Cancel</button></p>
        </div>
      )}
      <div className="list">
        {(d?.projects || []).map((p) => <div key={p.id} className="click" onClick={() => setSel(p)}><b className="grow">🗄️ {p.slug}</b><span className="small muted">{p.name}</span><span className="pill">{LEVEL_NAMES[p.level]}</span></div>)}
        {d && !d.projects.length && <div className="muted">No projects yet.</div>}
      </div>
    </div>
  );
}
function Project({ p, back }) {
  const [view, setView] = useState('tables');
  const canDev = atLeast(p.level, 'developer'); const canAdmin = atLeast(p.level, 'admin');
  return (
    <div>
      <div className="row"><button onClick={back}>← Projects</button><h2 className="grow">🗄️ {p.slug}</h2><span className="pill">{LEVEL_NAMES[p.level]}</span></div>
      <div className="tabs">{[['tables', 'Tables'], ['sql', 'SQL'], ['policies', 'Row policies'], ['api', 'API and URLs'], ['keys', 'Keys and values'], ['settings', 'Settings']].map(([v, n]) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{n}</button>)}</div>
      {view === 'tables' && <Tables p={p} canAdmin={canAdmin} />}
      {view === 'sql' && <Sql p={p} canDev={canDev} canAdmin={canAdmin} />}
      {view === 'policies' && <Policies p={p} canAdmin={canAdmin} />}
      {view === 'api' && <ProjectApi p={p} canAdmin={canAdmin} />}
      {view === 'keys' && <Secrets scope="project" scopeId={p.id} canEdit={canDev} canAdmin={canAdmin} />}
      {view === 'settings' && <ProjectSettings p={p} canAdmin={canAdmin} back={back} />}
    </div>
  );
}
function Tables({ p, canAdmin }) {
  const [d, load] = useLoad(() => api('dbTables', { projectId: p.id }), [p.id]);
  const [t, setT] = useState(null); const [td, setTd] = useState(null); const [off, setOff] = useState(0);
  const openT = run(async (name, o = 0) => { setT(name); setOff(o); setTd(await api('dbTable', { projectId: p.id, table: name, offset: o })); });
  const change = run(async (body) => {
    const pre = await api('dbChange', { projectId: p.id, ...body, preview: true });
    if (!confirm('This will run:\n\n' + pre.sql)) return;
    await api('dbChange', { projectId: p.id, ...body }); toast('Done'); load();
  });
  return (
    <div>
      <p className="small muted">Make tables in the SQL tab. Row security (RLS) on means row policies decide what the public key can see.</p>
      <div className="list">
        {(d?.tables || []).map((x) => (
          <div key={x.name}>
            <button className="link grow" style={{ textAlign: 'left' }} onClick={() => openT(x.name)}>📋 {x.name}</button>
            <span className="small muted">~{x.rows} rows</span>
            <span className={'pill ' + (x.rls ? 'ok' : 'warn')}>RLS {x.rls ? 'on' : 'off'}</span>
            <span className="pill">Public key: {x.anon_write ? 'read + write' : x.anon_read ? 'read' : 'none'}</span>
            {canAdmin && <button onClick={() => change({ kind: 'rls', table: x.name, on: !x.rls })}>{x.rls ? 'Turn RLS off' : 'Turn RLS on'}</button>}
            {canAdmin && <select value={x.anon_write ? 'write' : x.anon_read ? 'read' : 'none'} onChange={(e) => change({ kind: 'access', table: x.name, access: e.target.value })} style={{ width: 'auto' }}>
              <option value="none">Public key: none</option><option value="read">Public key: read</option><option value="write">Public key: read + write</option></select>}
          </div>
        ))}
        {d && !d.tables.length && <div className="muted small">No tables yet. Make one in the SQL tab.</div>}
      </div>
      {td && (
        <div className="card">
          <div className="row"><h3 className="grow">{t}</h3><button disabled={off === 0} onClick={() => openT(t, Math.max(0, off - 100))}>← Back</button><button disabled={td.data.rows.length < 100} onClick={() => openT(t, off + 100)}>Next →</button></div>
          <p className="small muted">{td.columns.map((c) => `${c.name} (${c.type})`).join(' · ')}</p>
          <Grid fields={td.data.fields} rows={td.data.rows} />
        </div>
      )}
    </div>
  );
}
const SQL_STARTERS = {
  'Make a table': 'create table notes (\n  id bigserial primary key,\n  title text not null,\n  done boolean default false,\n  created_at timestamptz default now()\n);',
  'Add a row': "insert into notes (title) values ('My first note') returning *;",
  'See rows': 'select * from notes order by id desc limit 50;',
  'List tables': "select table_name from information_schema.tables where table_schema = 'public';",
};
function Sql({ p, canDev, canAdmin }) {
  const [sql, setSql] = useState('select now();'); const [res, setRes] = useState(null); const [ro, setRo] = useState(!canAdmin); const [busy, setBusy] = useState(false);
  if (!canDev) return <p className="muted">You need Developer clearance on this project to run SQL.</p>;
  return (
    <div>
      <div className="row">{Object.keys(SQL_STARTERS).map((k) => <button key={k} onClick={() => setSql(SQL_STARTERS[k])}>{k}</button>)}</div>
      <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} style={{ marginTop: 8 }} />
      <div className="row">
        <button className="primary" disabled={busy} onClick={run(async () => { setBusy(true); try { setRes(await api('dbQuery', { projectId: p.id, sql, readOnly: ro })); } finally { setBusy(false); } })}>{busy ? 'Running…' : 'Run'}</button>
        {canAdmin ? <label className="row" style={{ margin: 0 }}><input type="checkbox" checked={ro} onChange={(e) => setRo(e.target.checked)} style={{ width: 'auto' }} /> Read only (safe test, nothing is saved)</label>
          : <span className="small muted">Developer clearance runs one read-only statement. Admins can change data.</span>}
      </div>
      {res && (
        <div>
          <p className="small muted">{res.readOnly ? 'Read only. ' : ''}{res.ms} ms</p>
          {res.results.map((r, i) => (
            <div key={i} className="card">
              <div className="small muted">{r.command} {r.rowCount ?? ''}{r.more ? ' (showing first 500)' : ''}</div>
              {r.fields.length > 0 && <Grid fields={r.fields} rows={r.rows} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Policies({ p, canAdmin }) {
  const [d, load] = useLoad(() => api('dbPolicies', { projectId: p.id }), [p.id]);
  const [tables] = useLoad(() => api('dbTables', { projectId: p.id }), [p.id]);
  const [f, setF] = useState({ table: '', name: '', cmd: 'SELECT', who: 'public', using: 'true', check: '' });
  const [pre, setPre] = useState('');
  return (
    <div>
      <p className="small muted">Row policies decide which rows the public key can read or change. They work when RLS is on for the table.</p>
      <div className="list">
        {(d?.policies || []).map((x) => (
          <div key={x.table + x.name}>
            <span className="grow"><b>{x.table}</b> · {x.name} · {x.cmd} · {String(x.roles)}<br /><span className="mono small muted">using: {x.using || '-'} check: {x.check || '-'}</span></span>
            {canAdmin && <button className="danger" onClick={run(async () => { if (!confirm('Delete policy ' + x.name + '?')) return; await api('dbChange', { projectId: p.id, kind: 'drop', table: x.table, name: x.name }); load(); })}>Delete</button>}
          </div>
        ))}
        {d && !d.policies.length && <div className="muted small">No policies yet.</div>}
      </div>
      {canAdmin && (
        <div className="card">
          <h3>New policy</h3>
          <Field label="Table"><select value={f.table} onChange={(e) => setF({ ...f, table: e.target.value })}><option value="">Pick a table</option>{(tables?.tables || []).map((t) => <option key={t.name}>{t.name}</option>)}</select></Field>
          <Field label="Policy name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="anyone can read" /></Field>
          <Field label="Action"><select value={f.cmd} onChange={(e) => setF({ ...f, cmd: e.target.value })}>{['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="For"><select value={f.who} onChange={(e) => setF({ ...f, who: e.target.value })}><option value="public">Public key</option><option value="service">Secret key</option><option value="everyone">Everyone</option></select></Field>
          <Field label="Which rows (USING), like true or done = false"><input className="mono" value={f.using} onChange={(e) => setF({ ...f, using: e.target.value })} /></Field>
          <Field label="New rows must match (WITH CHECK), optional"><input className="mono" value={f.check} onChange={(e) => setF({ ...f, check: e.target.value })} /></Field>
          <p className="row">
            <button onClick={run(async () => setPre((await api('dbChange', { projectId: p.id, kind: 'policy', ...f, preview: true })).sql))}>Show SQL</button>
            <button className="primary" onClick={run(async () => { await api('dbChange', { projectId: p.id, kind: 'policy', ...f }); toast('Policy made'); setPre(''); load(); })}>Make policy</button>
          </p>
          {pre && <pre className="card mono">{pre}</pre>}
        </div>
      )}
    </div>
  );
}
function ProjectApi({ p, canAdmin }) {
  const [d, load] = useLoad(() => api('projectApi', { projectId: p.id }), [p.id]);
  const [keys, setKeys] = useState(null); const [cors, setCors] = useState(null);
  useEffect(() => { if (d) setCors(d.cors); }, [d]);
  if (!d) return null;
  const ex = `${d.url}/notes?select=*&order=id.desc`;
  return (
    <div>
      <div className="card">
        <h3>API address</h3>
        <div className="row"><span className="mono grow">{d.url}</span><button onClick={() => copy(d.url)}>Copy</button></div>
        <p className="small muted">Send the key in an <code>apikey</code> header. Read: <code>GET /table?col=eq.value&order=id.desc&limit=50</code>. Add: <code>POST /table</code> with JSON. Change: <code>PATCH /table?id=eq.5</code>. Delete: <code>DELETE /table?id=eq.5</code>. Filters: eq, neq, gt, gte, lt, lte, like, ilike, in, is.</p>
        <pre className="card mono small" style={{ whiteSpace: 'pre-wrap' }}>{`fetch('${ex}', { headers: { apikey: 'YOUR_PUBLIC_KEY' } })`}</pre>
      </div>
      <div className="card">
        <h3>Keys</h3>
        <p className="small muted">Public key: safe in web pages, limited by row policies and table access. Secret key: full access, keep it on servers only.</p>
        {!canAdmin ? <p className="muted small">Admin clearance is needed to see keys.</p> : !keys ? <button onClick={run(async () => setKeys(await api('projectKeys', { projectId: p.id })))}>Show keys</button> : (
          <div>
            {[['anon', 'Public key'], ['service', 'Secret key']].map(([w, label]) => (
              <Field key={w} label={label}>
                <KeyBox value={keys[w]} readOnly generate={false} />
                <p className="row">
                  <button onClick={run(async () => { if (confirm(`Make a new ${label.toLowerCase()}? The old one stops working.`)) setKeys(await api('projectKeys', { projectId: p.id, regenerate: w })); })}>Generate new</button>
                  <button onClick={run(async () => { const app = prompt('Which app gets this key? (It goes to the Handover room)', p.slug); if (!app) return; await api('projectHandover', { projectId: p.id, which: w, app }); toast('Sent to the Handover room for ' + app); })}>Send to Handover room</button>
                </p>
              </Field>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h3>URL configuration</h3>
        <p className="small muted">Web addresses allowed to call this API from a browser. Use * for any, or list addresses like https://myapp.com separated by spaces.</p>
        <input value={cors || ''} onChange={(e) => setCors(e.target.value)} readOnly={!canAdmin} />
        {canAdmin && <p><button onClick={run(async () => { await api('projectCors', { projectId: p.id, cors }); toast('Saved'); load(); })}>Save addresses</button></p>}
      </div>
    </div>
  );
}
function ProjectSettings({ p, canAdmin, back }) {
  const [conf, setConf] = useState('');
  if (!canAdmin) return <p className="muted">You need Admin clearance on this project for settings.</p>;
  return (
    <div className="card">
      <h3>Delete project</h3>
      <p className="small muted">This deletes the whole database and all its data. Type <b>{p.slug}</b> to confirm.</p>
      <div className="row"><input className="grow" value={conf} onChange={(e) => setConf(e.target.value)} /><button className="danger" onClick={run(async () => { await api('projectDelete', { projectId: p.id, confirm: conf }); toast('Project deleted'); back(); })}>Delete project</button></div>
    </div>
  );
}

/* ================= connectors ================= */
function Connectors({ me }) {
  const lvl = me.levels.connectors;
  const rendIn = me.owner && me.rendUntil && new Date(me.rendUntil) > new Date();
  const canDev = atLeast(lvl, 'developer'); const canAdmin = atLeast(lvl, 'admin');
  const [d, load] = useLoad(() => api('hookList'), []);
  const [sites] = useLoad(() => (rendIn ? api('siteList') : Promise.resolve({ sites: [] })).catch(() => ({ sites: [] })), [rendIn]);
  const [f, setF] = useState(null); const [inF, setInF] = useState(null); const [shown, setShown] = useState(null);
  return (
    <div>
      <h2>Connectors</h2>
      <div className="card"><Secrets scope="global" scopeId={0} title="Saved API keys" canEdit={canDev} canAdmin={canAdmin} /></div>
      <div className="card">
        <div className="row"><h3 className="grow">Webhooks out</h3>{canDev && <button onClick={() => setF({ name: '', url: '', events: 'deploy' })}>Add webhook</button>}</div>
        <p className="small muted">Fit-Rend-Base tells another app when something happens. Each message is signed with a secret in the X-FitRendBase-Signature header.</p>
        {f && (
          <div className="card">
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Address (https://…)"><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} autoCapitalize="none" /></Field>
            <Field label="When"><select value={f.events} onChange={(e) => setF({ ...f, events: e.target.value })}><option value="deploy">A site is deployed</option><option value="commit">Files are saved in a repo</option><option value="deploy,commit">Both</option></select></Field>
            <p className="row"><button className="primary" onClick={run(async () => { const r = await api('hookCreate', f); setShown({ title: 'Signing secret', value: r.secret }); setF(null); load(); })}>Save</button><button onClick={() => setF(null)}>Cancel</button></p>
          </div>
        )}
        <div className="list">
          {(d?.out || []).map((h) => (
            <div key={h.id}><span className="grow"><b>{h.name}</b> · {h.events}<br /><span className="mono small muted">{h.url}</span><br /><span className="small muted">Last: {h.last_status || 'not sent yet'}</span></span>
              {canDev && <button onClick={run(async () => { const r = await api('hookTest', { id: h.id }); toast('Test sent: ' + r.status); load(); })}>Send test</button>}
              {canAdmin && <button onClick={run(async () => { await api('hookToggle', { id: h.id, active: !h.active }); load(); })}>{h.active ? 'Turn off' : 'Turn on'}</button>}
              {canAdmin && <button className="danger" onClick={run(async () => { if (confirm('Delete this webhook?')) { await api('hookDelete', { id: h.id }); load(); } })}>Delete</button>}
            </div>
          ))}
          {d && !d.out.length && <div className="muted small">None yet.</div>}
        </div>
      </div>
      <div className="card">
        <div className="row"><h3 className="grow">Deploy hooks in</h3>{canAdmin && me.owner && rendIn && <button onClick={() => setInF({ name: '', siteId: sites?.sites?.[0]?.id || '' })}>Add deploy hook</button>}</div>
        <p className="small muted">A secret address another app can POST to, to deploy a site with the newest files. {me.owner ? (rendIn ? '' : 'Open the Rend room door first to add one.') : 'Only the owner can add these.'}</p>
        {inF && (
          <div className="card">
            <Field label="Name"><input value={inF.name} onChange={(e) => setInF({ ...inF, name: e.target.value })} /></Field>
            <Field label="Site"><select value={inF.siteId} onChange={(e) => setInF({ ...inF, siteId: e.target.value })}>{(sites?.sites || []).map((x) => <option key={x.id} value={x.id}>{x.slug}</option>)}</select></Field>
            <p className="row"><button className="primary" onClick={run(async () => { const r = await api('inhookCreate', { ...inF, siteId: Number(inF.siteId) }); setShown({ title: 'Deploy hook address', value: r.url }); setInF(null); load(); })}>Make hook</button><button onClick={() => setInF(null)}>Cancel</button></p>
          </div>
        )}
        <div className="list">
          {(d?.in || []).map((h) => (
            <div key={h.id}><span className="grow"><b>{h.name}</b> → {h.slug}<br /><span className="small muted">Last used: {h.last_used ? when(h.last_used) : 'never'}</span></span>
              {canAdmin && <button className="danger" onClick={run(async () => { if (confirm('Delete this hook?')) { await api('hookDelete', { id: h.id, incoming: true }); load(); } })}>Delete</button>}
            </div>
          ))}
          {d && !d.in.length && <div className="muted small">None yet.</div>}
        </div>
      </div>
      {shown && <Modal onClose={() => setShown(null)}><h3>{shown.title}</h3><KeyBox value={shown.value} readOnly generate={false} /><p className="small muted">It is also saved in the Handover room, so you can copy it there later.</p><p className="row"><button className="primary" onClick={() => setShown(null)}>Done</button></p></Modal>}
    </div>
  );
}

/* ================= contacts and email campaigns ================= */
function Contacts({ me, start }) {
  const [view, setView] = useState(['people', 'pipeline', 'help', 'campaigns', 'link'].includes(start) ? start : 'people');
  const lvl = me.levels.contacts;
  return (
    <div>
      <div className="tabs">{[['people', 'People'], ['pipeline', 'Pipeline'], ['help', 'Help requests'], ['campaigns', 'Email campaigns'], ['link', 'Connection']].map(([v, n]) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{n}</button>)}</div>
      {view === 'people' && <People lvl={lvl} />}
      {view === 'pipeline' && <Pipeline lvl={lvl} />}
      {view === 'help' && <HelpRequests lvl={lvl} />}
      {view === 'campaigns' && <Campaigns lvl={lvl} me={me} />}
      {view === 'link' && <CrmLink lvl={lvl} />}
    </div>
  );
}
const STATUS_PILL = { subscribed: 'ok', unsubscribed: 'bad' };
function People({ lvl }) {
  const canDev = atLeast(lvl, 'developer'); const canAdmin = atLeast(lvl, 'admin');
  const [search, setSearch] = useState(''); const [tag, setTag] = useState(''); const [page, setPage] = useState(0);
  const [d, load] = useLoad(() => api('contactList', { search, tag, offset: page * 50 }), [search, tag, page]);
  const [edit, setEdit] = useState(null); const [open, setOpen] = useState(null); const [imp, setImp] = useState(null);
  const fileRef = useRef(null);
  const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); };
  return (
    <div>
      <div className="row"><h2 className="grow">People {d && <span className="small muted">· {d.counts.all} total, {d.counts.subscribed} subscribed</span>}</h2>
        {canDev && <button className="primary" onClick={() => setEdit({ email: '', name: '', company: '', phone: '', tags: '', score: 0, notes: '' })}>Add person</button>}
        {canDev && <button onClick={() => setImp('')}>Import CSV</button>}
        {canAdmin && <button onClick={run(async () => { const r = await api('contactExport'); download('contacts.csv', r.csv); })}>Export CSV</button>}</div>
      <div className="row" style={{ margin: '8px 0' }}>
        <input className="grow" placeholder="Search name, email or company" value={search} onChange={(e) => { setPage(0); setSearch(e.target.value); }} />
        <select value={tag} onChange={(e) => { setPage(0); setTag(e.target.value); }} style={{ width: 'auto' }}><option value="">All tags</option>{(d?.tags || []).map((t) => <option key={t.t} value={t.t}>{t.t} ({t.n})</option>)}</select>
      </div>
      {imp !== null && (
        <div className="card">
          <h3>Import people</h3>
          <p className="small muted">Pick a CSV file, or paste lines. The first row should name the columns: email, name, company, phone, tags. People already in your list are updated, never doubled.</p>
          <input type="file" accept=".csv,text/csv,text/plain" ref={fileRef} onChange={async (e) => { const f = e.target.files[0]; if (f) setImp(await f.text()); }} />
          <textarea value={imp} onChange={(e) => setImp(e.target.value)} placeholder={'email,name,tags\njo@shop.com,Jo Smith,customer'} style={{ minHeight: 120, marginTop: 8 }} />
          <p className="row"><button className="primary" onClick={run(async () => { const r = await api('contactImport', { csv: imp }); toast(`${r.added} added, ${r.updated} updated${r.bad ? ', ' + r.bad + ' lines had no good email' : ''}`); setImp(null); load(); })}>Import</button><button onClick={() => setImp(null)}>Cancel</button></p>
        </div>
      )}
      {edit && <ContactForm c={edit} done={() => { setEdit(null); load(); }} />}
      <div className="list">
        {(d?.contacts || []).map((c) => (
          <div key={c.id} className="click" onClick={() => setOpen(c.id)}>
            <span className="grow"><b>{c.name || c.email}</b>{c.name && <span className="small muted"> · {c.email}</span>}<br />
              <span className="small muted">{c.company && c.company + ' · '}{c.tags.join(', ') || 'no tags'}{c.score ? ' · score ' + c.score : ''} · from {c.source}</span></span>
            <span className={'pill ' + (STATUS_PILL[c.status] || '')}>{c.status}</span>
          </div>
        ))}
        {d && !d.contacts.length && <div className="muted small">Nobody here yet. Leads from LeadReplyRadar show up here by themselves once it's connected.</div>}
      </div>
      {d && d.total > 50 && <p className="row"><button disabled={!page} onClick={() => setPage(page - 1)}>Back</button><span className="small muted">Page {page + 1} of {Math.ceil(d.total / 50)}</span><button disabled={(page + 1) * 50 >= d.total} onClick={() => setPage(page + 1)}>Next</button></p>}
      {open && <ContactView id={open} canDev={canDev} canAdmin={canAdmin} close={() => { setOpen(null); load(); }} />}
    </div>
  );
}
function ContactForm({ c, done }) {
  const [f, setF] = useState({ ...c, tags: Array.isArray(c.tags) ? c.tags.join(', ') : c.tags || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <h3>{f.id ? 'Edit person' : 'Add person'}</h3>
      <Field label="Email"><input value={f.email} onChange={set('email')} autoCapitalize="none" type="email" /></Field>
      <Field label="Name"><input value={f.name} onChange={set('name')} /></Field>
      <div className="row"><div className="grow"><Field label="Company"><input value={f.company} onChange={set('company')} /></Field></div><div className="grow"><Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field></div></div>
      <Field label="Tags (comma between them)"><input value={f.tags} onChange={set('tags')} autoCapitalize="none" /></Field>
      <div className="row"><div><Field label="Score (0 to 100)"><input type="number" value={f.score} onChange={set('score')} style={{ width: 110 }} /></Field></div>
        {f.id && <div><Field label="Emails"><select value={f.status} onChange={set('status')} style={{ width: 'auto' }}><option value="subscribed">Subscribed</option><option value="unsubscribed">Unsubscribed</option></select></Field></div>}</div>
      <Field label="Notes"><textarea value={f.notes} onChange={set('notes')} style={{ minHeight: 80, fontFamily: 'inherit' }} /></Field>
      <p className="row"><button className="primary" onClick={run(async () => { await api('contactSave', f); toast('Saved'); done(); })}>Save</button><button onClick={done}>Cancel</button></p>
    </div>
  );
}
function ContactView({ id, canDev, canAdmin, close }) {
  const [d, load] = useLoad(() => api('contactGet', { id }), [id]);
  const [edit, setEdit] = useState(false);
  if (!d) return null;
  const c = d.contact;
  return (
    <Modal onClose={close}>
      {edit ? <ContactForm c={c} done={() => { setEdit(false); load(); }} /> : (
        <div>
          <h3>{c.name || c.email}</h3>
          <p className="small"><span className="mono">{c.email}</span><br />{c.company}{c.phone && ' · ' + c.phone}<br /><span className="muted">Tags: {c.tags.join(', ') || 'none'} · score {c.score} · from {c.source} · <b>{c.status}</b></span></p>
          {c.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</p>}
          <h3>History</h3>
          <div className="list">{d.events.map((e, i) => <div key={i} className="small"><span className="grow">{e.detail || e.kind}</span><span className="muted">{when(e.at)}</span></div>)}{!d.events.length && <div className="muted small">Nothing yet.</div>}</div>
          <p className="row">{canDev && <button onClick={() => setEdit(true)}>Edit</button>}
            {canAdmin && <button className="danger" onClick={run(async () => { if (!confirm('Delete ' + c.email + ' and their history?')) return; await api('contactDelete', { id: c.id }); close(); })}>Delete</button>}
            <button onClick={close}>Close</button></p>
        </div>
      )}
    </Modal>
  );
}
const CAMPAIGN_STATUS = { draft: 'Draft', sending: 'Sending', paused: 'Paused', done: 'Finished' };
function Campaigns({ lvl, me }) {
  const canDev = atLeast(lvl, 'developer');
  const [d, load] = useLoad(() => api('campaignList'), []);
  const [open, setOpen] = useState(null);
  if (open) return <Campaign id={open} lvl={lvl} me={me} back={() => { setOpen(null); load(); }} />;
  return (
    <div>
      <div className="row"><h2 className="grow">Email campaigns</h2>{canDev && <button className="primary" onClick={run(async () => { const r = await api('campaignSave', { name: 'New campaign', subject: '', body: 'Hi {{first_name}},\n\n' }); setOpen(r.id); })}>New campaign</button>}<button onClick={load}>Refresh</button></div>
      <p className="small muted">Campaigns go out from your Gmail through LeadReplyRadar, a few at a time. Gmail allows about 500 emails a day, so the app stops at your daily limit and goes on the next day.</p>
      <div className="list">
        {(d?.campaigns || []).map((c) => (
          <div key={c.id} className="click" onClick={() => setOpen(c.id)}>
            <span className="grow"><b>{c.name}</b><br /><span className="small muted">{c.subject || 'No subject yet'}{c.total ? ` · ${c.sent} of ${c.total} sent` : ''}</span>{c.last_error && <><br /><span className="small" style={{ color: '#ffb3ae' }}>{c.last_error}</span></>}</span>
            <span className={'pill ' + (c.status === 'sending' ? 'ok' : c.status === 'paused' ? 'warn' : '')}>{CAMPAIGN_STATUS[c.status]}</span>
          </div>
        ))}
        {d && !d.campaigns.length && <div className="muted small">No campaigns yet.</div>}
      </div>
    </div>
  );
}
function Campaign({ id, lvl, me, back }) {
  const canDev = atLeast(lvl, 'developer'); const canAdmin = atLeast(lvl, 'admin');
  const [d, load] = useLoad(() => api('campaignGet', { id }), [id]);
  const [tags] = useLoad(() => api('contactList', { limit: 1 }), []);
  const [f, setF] = useState(null); const [count, setCount] = useState(null);
  const [testTo, setTestTo] = useState(''); const [ask, setAsk] = useState(null);
  useEffect(() => { if (d) setF({ id, name: d.campaign.name, subject: d.campaign.subject, body: d.campaign.body, tag: d.campaign.tag, minScore: d.campaign.min_score }); }, [d]); // eslint-disable-line
  useEffect(() => { if (!f) return; const t = setTimeout(() => api('campaignCount', { tag: f.tag, minScore: f.minScore }).then((r) => setCount(r.count), () => {}), 300); return () => clearTimeout(t); }, [f?.tag, f?.minScore]); // eslint-disable-line
  useEffect(() => { if (d?.campaign.status !== 'sending') return; const i = setInterval(load, 15000); return () => clearInterval(i); }, [d?.campaign.status]); // eslint-disable-line
  if (!d || !f) return null;
  const c = d.campaign; const draft = c.status === 'draft'; const edit = draft && canDev;
  const save = async () => { await api('campaignSave', f); await load(); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      <p><button className="link" onClick={back}>← All campaigns</button></p>
      <div className="row"><h2 className="grow">{c.name}</h2><span className="pill">{CAMPAIGN_STATUS[c.status]}</span></div>
      {!draft && (
        <div className="card">
          <div className="row"><b className="grow">{d.counts.sent} of {d.counts.total} sent</b>
            {c.status === 'sending' && canDev && <button onClick={run(async () => { await api('campaignPause', { id }); load(); })}>Pause</button>}
            {c.status === 'paused' && canAdmin && <button className="primary" onClick={run(async () => { await api('campaignResume', { id }); load(); })}>Go on sending</button>}
            {['sending', 'paused'].includes(c.status) && canDev && <button className="danger" onClick={run(async () => { if (confirm('Stop this campaign for good? Nobody else on the list gets it.')) { await api('campaignStop', { id }); load(); } })}>Stop</button>}
            {canDev && <button onClick={run(async () => { const r = await api('campaignCopy', { id }); toast('Copy made'); back(); })}>Make a copy</button>}</div>
          <p className="small muted">Waiting {d.counts.queued + d.counts.sending} · failed {d.counts.failed} · not sure it went {d.counts.unclear} · skipped {d.counts.skipped}{c.next_try ? ' · next try ' + when(c.next_try) : ''}</p>
          {c.last_error && <p className="small" style={{ color: '#ffb3ae' }}>{c.last_error}</p>}
          <div className="list">{d.recent.map((x, i) => <div key={i} className="small"><span className="mono grow">{x.email}</span><span>{x.status}</span>{x.error && <span className="muted">{x.error}</span>}<span className="muted">{when(x.at)}</span></div>)}</div>
        </div>
      )}
      <div className="card">
        <Field label="Campaign name (only you see it)"><input value={f.name} onChange={set('name')} disabled={!edit} /></Field>
        <Field label="Subject"><input value={f.subject} onChange={set('subject')} disabled={!edit} /></Field>
        <Field label="Email (plain text). {{first_name}}, {{name}} and {{company}} fill in for each person."><textarea value={f.body} onChange={set('body')} disabled={!edit} style={{ fontFamily: 'inherit', fontSize: 15 }} /></Field>
        <p className="small muted">Your business name, mailing address and an unsubscribe link are added at the bottom of every email.</p>
        <div className="row">
          <div><Field label="Send to people with tag"><select value={f.tag} onChange={set('tag')} disabled={!edit} style={{ width: 'auto' }}><option value="">Everyone subscribed</option>{(tags?.tags || []).map((t) => <option key={t.t} value={t.t}>{t.t}</option>)}</select></Field></div>
          <div><Field label="And score at least"><input type="number" value={f.minScore} onChange={set('minScore')} disabled={!edit} style={{ width: 110 }} /></Field></div>
        </div>
        {draft && <p><b>{count ?? '…'}</b> people match right now.</p>}
        {edit && <p className="row"><button onClick={run(async () => { await save(); toast('Saved'); })}>Save draft</button>
          {canAdmin && <button className="danger" onClick={run(async () => { if (confirm('Delete this draft?')) { await api('campaignDelete', { id }); back(); } })}>Delete draft</button>}</p>}
      </div>
      {draft && canDev && (
        <div className="card">
          <h3>Send a test</h3>
          <div className="row"><input className="grow" type="email" placeholder="Your own email address" value={testTo} onChange={(e) => setTestTo(e.target.value)} autoCapitalize="none" />
            <button onClick={run(async () => { if (!confirm('Send one test email to ' + testTo + '?')) return; await save(); await api('campaignTest', { id, to: testTo }); toast('Test sent to ' + testTo); })}>Send test</button></div>
        </div>
      )}
      {draft && canAdmin && (
        <div className="card">
          <h3>Start sending</h3>
          <p className="small muted">Emails go out from your Gmail, about 16 a minute, until your daily limit. Gmail allows about 500 emails a day in total, and that includes your own emails, LeadReplyRadar's sequences and its replies. Going over can block your Gmail sending for up to a day.</p>
          <button className="primary" onClick={run(async () => { await save(); const r = await api('campaignCount', { tag: f.tag, minScore: f.minScore }); setAsk(r.count); })}>Start campaign…</button>
        </div>
      )}
      {ask !== null && (
        <Modal onClose={() => setAsk(null)}>
          <h3>Send "{f.subject}" to {ask} people?</h3>
          <p className="small">It goes out from your Gmail through LeadReplyRadar. Emails that are sent can't be taken back. You can pause or stop the rest at any time.</p>
          <p className="row"><button className="primary" disabled={!ask} onClick={run(async () => { await api('campaignStart', { id, confirmCount: ask }); setAsk(null); toast('Sending started'); load(); })}>Yes, send to {ask} people</button><button onClick={() => setAsk(null)}>Cancel</button></p>
        </Modal>
      )}
    </div>
  );
}
function CrmLink({ lvl }) {
  const canDev = atLeast(lvl, 'developer'); const canAdmin = atLeast(lvl, 'admin');
  const [d, load] = useLoad(() => api('crmGet'), []);
  const [f, setF] = useState(null); const [shown, setShown] = useState(null);
  useEffect(() => { if (d) setF({ url: d.url, footer: d.footer, dailyLimit: d.dailyLimit }); }, [d]);
  if (!d || !f) return null;
  return (
    <div>
      <div className="card">
        <h2>LeadReplyRadar connection</h2>
        <p className="small">Status: {d.linked ? (d.lastPing ? (d.lastPingOk ? <b style={{ color: '#9be9a8' }}>Connected (checked {when(d.lastPing)})</b> : <b style={{ color: '#ffb3ae' }}>Last check failed {when(d.lastPing)}</b>) : 'Set up, not checked yet') : 'Not connected'}</p>
        <p className="small muted">LeadReplyRadar saves important senders (score 50 and up) here as people with the tag "lead". Campaign emails go out through it from your Gmail. The two apps prove who they are with a shared secret.</p>
        <Field label="LeadReplyRadar address"><input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} disabled={!canAdmin} autoCapitalize="none" placeholder="https://leadreplyradar.onrender.com" /></Field>
        <Field label="Your business name and mailing address (the law needs it in marketing emails)"><textarea value={f.footer} onChange={(e) => setF({ ...f, footer: e.target.value })} disabled={!canAdmin} style={{ minHeight: 70, fontFamily: 'inherit' }} placeholder={'CashCow\n123 Main St, Dallas, TX 75201'} /></Field>
        <Field label="Most campaign emails a day (Gmail allows about 500 in total)"><input type="number" value={f.dailyLimit} onChange={(e) => setF({ ...f, dailyLimit: e.target.value })} disabled={!canAdmin} style={{ width: 120 }} /></Field>
        <p className="small muted">Sent today: {d.sentToday}</p>
        <p className="row">
          {canAdmin && <button className="primary" onClick={run(async () => { await api('crmSet', f); toast('Saved'); load(); })}>Save</button>}
          {canAdmin && <button onClick={run(async () => { if (d.hasSecret && !confirm('Make a new secret? LeadReplyRadar stops working with this app until you put the new one on Render.')) return; const r = await api('crmNewSecret'); setShown(r); load(); })}>{d.hasSecret ? 'New secret' : 'Make secret'}</button>}
          {canDev && d.linked && <button onClick={run(async () => { const r = await api('crmPing'); toast('Connected. Sends from ' + r.from); load(); })}>Check connection</button>}
        </p>
      </div>
      {shown && (
        <Modal onClose={() => setShown(null)}>
          <h3>Put these 2 values on Render</h3>
          <p className="small">On Render, open LeadReplyRadar, then Environment, and add:</p>
          <Field label="FRB_URL"><KeyBox value={shown.frbUrl} readOnly generate={false} /></Field>
          <Field label="FRB_SECRET"><KeyBox value={shown.secret} readOnly generate={false} /></Field>
          <p className="small muted">Both are also saved in the Handover room under LeadReplyRadar.</p>
          <p className="row"><button className="primary" onClick={() => setShown(null)}>Done</button></p>
        </Modal>
      )}
    </div>
  );
}

/* ================= handover room ================= */
/* DNS room: show a Rend site on your own domain, in 2 steps.
   1. Type your domain and pick the site.  2. Copy one record to your domain company, then Check it. */
const DOMAIN_COMPANIES = [
  ['GoDaddy', 'https://dcc.godaddy.com/control/portfolio'],
  ['Namecheap', 'https://ap.www.namecheap.com/domains/list/'],
  ['Cloudflare', 'https://dash.cloudflare.com/'],
  ['Squarespace', 'https://account.squarespace.com/domains'],
];
function recordFor(name, ip) {
  const parts = String(name).split('.');
  return { type: 'A', name: parts.length <= 2 ? '@' : parts.slice(0, -2).join('.'), value: ip };
}
function DnsRecord({ name, ip }) {
  const rec = recordFor(name, ip);
  return (
    <div className="list">
      {[['Type', rec.type], ['Name (Host)', rec.name], ['Value (Points to)', rec.value || 'unknown']].map(([k, v]) => (
        <div className="item" key={k}><span className="grow"><span className="small muted">{k}</span><br /><b style={{ fontSize: 18 }}>{v}</b></span><button onClick={() => copy(v)}>Copy</button></div>
      ))}
    </div>
  );
}
function DnsRoom({ startNew }) {
  const [d, load] = useLoad(() => api('dnsList'), []);
  const [step, setStep] = useState(startNew ? 1 : 0);
  const [f, setF] = useState({ name: '', siteId: '' });
  const [added, setAdded] = useState(null);
  const [res, setRes] = useState({});
  const sites = d?.sites || [];
  const check = (x) => run(async () => { const o = await api('dnsCheck', { id: x.id }); setRes((v) => ({ ...v, [x.id]: o })); load(); })();
  const start = () => { setF({ name: '', siteId: sites.length === 1 ? sites[0].id : '' }); setAdded(null); setStep(1); };
  const picked = sites.find((x) => String(x.id) === String(f.siteId));
  const cur = added && (res[added.id] || null);
  return (
    <div>
      <div className="row"><h2 className="grow">DNS room · Your own domain</h2>{step === 0 && <button className="primary" onClick={start}>Use my own domain</button>}</div>
      <p className="small muted">Show a site from the Rend room on a domain you bought, like mysite.com. Free https is set up for you. Two steps.</p>

      {step === 1 && (
        <div className="card">
          <div className="small muted">Step 1 of 2</div>
          <h3>What is your domain, and which site should it show?</h3>
          <Field label="Your domain"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="mysite.com" autoCapitalize="none" inputMode="url" /></Field>
          {!sites.length ? <p className="muted">You have no sites yet. Make one in the Rend room first.</p> : (
            <div>
              <label>Which site</label>
              {sites.map((x) => <button key={x.id} className={'big' + (String(f.siteId) === String(x.id) ? ' primary' : '')} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '6px 0', padding: '12px' }} onClick={() => setF({ ...f, siteId: x.id })}>🌐 {x.slug}<span className="small muted"> · {VIS[x.visibility] || x.visibility}</span></button>)}
            </div>
          )}
          {picked && picked.visibility !== 'public' && <p className="small" style={{ color: 'var(--warn)' }}>This site is set to "{VIS[picked.visibility]}". Only sites set to "Anyone with the link" show on your own domain. You can change it in the Rend room.</p>}
          <p className="row"><button className="primary" disabled={!f.name || !f.siteId} onClick={run(async () => { const o = await api('dnsAdd', f); setAdded({ id: o.id, name: o.name }); setStep(2); load(); })}>Next</button><button onClick={() => setStep(0)}>Cancel</button></p>
        </div>
      )}

      {step === 2 && added && (
        <div className="card">
          <div className="small muted">Step 2 of 2</div>
          <h3>Add this one record where you bought {added.name}</h3>
          <p className="small muted">Open your domain company, go to DNS for {added.name}, and add a record with these 3 boxes. If there is already an A record with the same name, change it to this value.</p>
          <DnsRecord name={added.name} ip={d?.serverIp} />
          <div className="row" style={{ flexWrap: 'wrap', margin: '10px 0' }}>{DOMAIN_COMPANIES.map(([n, u]) => <a key={n} href={u} target="_blank" rel="noopener noreferrer"><button>{n}</button></a>)}</div>
          <p className="small muted">On Cloudflare, set the cloud to grey (DNS only).</p>
          <p className="row"><button className="primary" onClick={() => check(added)}>Check it</button><button onClick={() => { setStep(0); setAdded(null); }}>Done for now</button></p>
          {cur && (cur.ok
            ? <p>✅ {added.name} points here. Open <a href={'https://' + added.name} target="_blank" rel="noopener noreferrer">https://{added.name}</a>. The first visit can take a minute while https is set up.</p>
            : <p>⏳ Not yet. {cur.ips?.length ? `It points to ${cur.ips.join(', ')} now.` : 'No record found yet.'} Changes can take a few minutes, sometimes a few hours. Tap Check it again later.</p>)}
        </div>
      )}

      {(d?.items || []).length > 0 && (
        <div className="card">
          <h3>Your domains</h3>
          <div className="list">
            {d.items.map((x) => (
              <div className="item" key={x.id}>
                <span className="grow"><b>{x.points_here ? '✅' : '⏳'} {x.name}</b><br /><span className="small muted">shows {x.slug || 'a deleted site'}{x.visibility && x.visibility !== 'public' ? ' (private, set it to Anyone with the link)' : ''} · {x.checked_at ? 'checked ' + when(x.checked_at) : 'not checked yet'}</span>
                  {res[x.id] && !res[x.id].ok && <><br /><span className="small muted">Add this record: A, {recordFor(x.name, d.serverIp).name}, {d.serverIp}</span></>}
                </span>
                {x.points_here && <a href={'https://' + x.name} target="_blank" rel="noopener noreferrer"><button>Open</button></a>}
                <button onClick={() => check(x)}>Check it</button>
                <button className="danger" onClick={run(async () => { if (!confirm(`Remove ${x.name}? The domain stops showing your site.`)) return; await api('dnsDelete', { id: x.id }); load(); })}>Remove</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {d && !d.items.length && step === 0 && <div className="muted">No domains yet. Tap Use my own domain to start.</div>}
    </div>
  );
}
function Handover({ startNew }) {
  const [d, load] = useLoad(() => api('handoverList'), []);
  const [f, setF] = useState(startNew ? { app: '', name: '', note: '', value: '' } : null);
  const groups = {};
  (d?.items || []).forEach((x) => { (groups[x.app] = groups[x.app] || []).push(x); });
  return (
    <div>
      <div className="row"><h2 className="grow">Handover room</h2>{d?.canEdit && <button className="primary" onClick={() => setF({ app: '', name: '', note: '', value: '' })}>Add a key</button>}</div>
      <p className="small muted">Keys and values that other apps need to connect to Fit-Rend-Base are handed over from here. New link secrets, webhook secrets, deploy hook addresses, database keys you send here and AI keys land here for you. Showing a value needs Admin clearance in this room and a fresh clearance check, and each look goes in the Activity log.</p>
      {f && (
        <div className="card">
          <Field label="Which app gets it (like LeadReplyRadar)"><input value={f.app} onChange={(e) => setF({ ...f, app: e.target.value })} /></Field>
          <Field label="Name (like FRB_SECRET)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoCapitalize="none" /></Field>
          <Field label="Note (where it goes)"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <Field label="Value"><KeyBox value={f.value} onChange={(value) => setF({ ...f, value })} /></Field>
          <p className="row"><button className="primary" onClick={run(async () => { await api('handoverSave', f); setF(null); toast('Saved'); load(); })}>Save</button><button onClick={() => setF(null)}>Cancel</button></p>
        </div>
      )}
      {Object.entries(groups).map(([app, items]) => (
        <div className="card" key={app}>
          <h3>{app}</h3>
          <div className="list">{items.map((x) => <HandoverRow key={x.id} x={x} canEdit={d.canEdit} canAdmin={d.canAdmin} reload={load} />)}</div>
        </div>
      ))}
      {d && !d.items.length && <div className="muted">Nothing here yet.</div>}
    </div>
  );
}
function HandoverRow({ x, canEdit, canAdmin, reload }) {
  const [val, setVal] = useState(''); const [dirty, setDirty] = useState(false);
  return (
    <div style={{ display: 'block' }}>
      <div className="row">
        <span className="mono grow">{x.name}</span>
        <span className="small muted">{x.source !== 'manual' ? 'From ' + x.source + ' · ' : ''}{x.updated_by} · {when(x.updated_at)}</span>
        {canAdmin && <button className="danger" onClick={run(async () => { if (!confirm(`Delete ${x.name} for ${x.app}? Copies already put in the other app keep working until you change them there.`)) return; await api('handoverDelete', { id: x.id }); reload(); })}>Delete</button>}
      </div>
      {x.note && <div className="small muted">{x.note}</div>}
      <KeyBox value={val} placeholder="•••••••• (saved)" readOnly={!canEdit} generate={canEdit}
        reveal={canAdmin ? async () => (await api('handoverReveal', { id: x.id })).value : null}
        onChange={(nv, fromServer) => { setVal(nv); setDirty(!fromServer); }} />
      {dirty && <p className="row"><button className="primary" onClick={run(async () => { await api('handoverSave', { id: x.id, app: x.app, name: x.name, note: x.note, value: val }); setDirty(false); toast('Saved. Put the new value in ' + x.app + ' too.'); reload(); })}>Save new value</button><button onClick={() => { setVal(''); setDirty(false); }}>Cancel</button></p>}
    </div>
  );
}

/* ================= AI access ================= */
const AI_LEVELS = {
  repos: { none: 'No access', viewer: 'Read files', developer: 'Read and save files' },
  database: { none: 'No access', viewer: 'Read data', developer: 'Read and change data' },
};
function AiRooms({ rooms, onChange }) {
  return (
    <div className="row">
      {Object.entries(AI_LEVELS).map(([room, names]) => (
        <div key={room}><label>{SECTION_NAMES[room]}</label>
          <select value={rooms[room] || 'none'} onChange={(e) => onChange({ ...rooms, [room]: e.target.value })} style={{ width: 'auto' }}>
            {Object.entries(names).map(([l, n]) => <option key={l} value={l}>{n}</option>)}
          </select></div>
      ))}
    </div>
  );
}
function AiAccess() {
  const [d, load] = useLoad(() => api('aiKeyList'), []);
  const [f, setF] = useState(null); const [shown, setShown] = useState(null); const [edit, setEdit] = useState(null);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const roomText = (r) => Object.entries(AI_LEVELS).map(([room, names]) => `${SECTION_NAMES[room]}: ${names[r?.[room] || 'none']}`).join(' · ');
  return (
    <div>
      <div className="row"><h2 className="grow">AI access</h2><button className="primary" onClick={() => setF({ name: '', rooms: { repos: 'developer', database: 'viewer' } })}>New AI key</button></div>
      <p className="small muted">An AI key lets an AI assistant or app work in the Fit room and the Base room only. It can never open the Rend room, the Handover room, Contacts, Connectors, Admin or any saved keys, and it can't do steps that need a clearance check, like deleting. Everything it does goes in the Activity log as "AI: name".</p>
      {f && (
        <div className="card">
          <Field label="Name (the assistant or app that uses it)"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <AiRooms rooms={f.rooms} onChange={(rooms) => setF({ ...f, rooms })} />
          <p className="row"><button className="primary" onClick={run(async () => { const r = await api('aiKeyCreate', f); setShown({ name: f.name, key: r.key }); setF(null); load(); })}>Make key</button><button onClick={() => setF(null)}>Cancel</button></p>
        </div>
      )}
      <div className="list">
        {(d?.keys || []).map((k) => (
          <div key={k.id} style={{ display: 'block' }}>
            <div className="row"><b className="grow">🤖 {k.name}</b><span className={'pill ' + (k.active ? 'ok' : 'bad')}>{k.active ? 'On' : 'Off'}</span>
              <button onClick={() => setEdit(edit?.id === k.id ? null : { id: k.id, rooms: k.rooms || {} })}>Change rooms</button>
              <button onClick={run(async () => { await api('aiKeyUpdate', { id: k.id, active: !k.active }); load(); })}>{k.active ? 'Turn off' : 'Turn on'}</button>
              <button className="danger" onClick={run(async () => { if (!confirm('Delete the AI key ' + k.name + '? It stops working right away.')) return; await api('aiKeyDelete', { id: k.id }); load(); })}>Delete</button></div>
            <div className="small muted">{roomText(k.rooms)} · last used {k.last_used ? when(k.last_used) : 'never'}</div>
            {edit?.id === k.id && <div className="card"><AiRooms rooms={edit.rooms} onChange={(rooms) => setEdit({ ...edit, rooms })} /><p><button className="primary" onClick={run(async () => { await api('aiKeyUpdate', { id: k.id, rooms: edit.rooms }); setEdit(null); toast('Saved'); load(); })}>Save rooms</button></p></div>}
          </div>
        ))}
        {d && !d.keys.length && <div className="muted small">No AI keys yet.</div>}
      </div>
      {shown && (
        <Modal onClose={() => setShown(null)}>
          <h3>AI key for {shown.name}</h3>
          <KeyBox value={shown.key} readOnly generate={false} />
          <p className="small muted">It is also saved in the Handover room under "AI: {shown.name}". The AI sends it like this:</p>
          <pre className="card mono small" style={{ whiteSpace: 'pre-wrap' }}>{`curl -X POST ${origin}/api \\
  -H 'X-CC: 1' -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer THE_AI_KEY' \\
  -d '{"action":"repoList"}'`}</pre>
          <p className="small muted">Actions it can use: repoList, repoCreate, fileList, fileGet, commit, history, projectList, projectApi, dbTables, dbTable, dbQuery, dbPolicies, me.</p>
          <p className="row"><button className="primary" onClick={() => setShown(null)}>Done</button></p>
        </Modal>
      )}
    </div>
  );
}

/* ================= admin ================= */
function Admin({ me, start }) {
  const views = [['users', 'Users'], ['grants', 'Access to one item'], ['audit', 'Activity log'], ...(me.owner ? [['pipeline', 'Customer pipeline'], ['ai', 'AI access'], ['settings', 'Settings'], ['backups', 'Backups']] : [])];
  const [view, setView] = useState(views.some(([v]) => v === start) ? start : 'users');
  return (
    <div>
      <div className="tabs">{views.map(([v, n]) => <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{n}</button>)}</div>
      {view === 'users' && <Users me={me} />}
      {view === 'grants' && <Grants me={me} />}
      {view === 'audit' && <Audit />}
      {view === 'pipeline' && <PipelineSettings />}
      {view === 'ai' && <AiAccess />}
      {view === 'settings' && <Settings />}
      {view === 'backups' && <Backups />}
    </div>
  );
}
function LevelPicker({ levels, onChange }) {
  return (
    <div className="row">
      {Object.keys(SECTION_NAMES).filter((sec) => !OWNER_ONLY.includes(sec)).map((sec) => (
        <div key={sec}><label>{SECTION_NAMES[sec]}</label>
          <select value={levels[sec] || 'none'} onChange={(e) => onChange({ ...levels, [sec]: e.target.value })} style={{ width: 'auto' }}>
            {['none', 'viewer', 'developer', 'admin'].map((l) => <option key={l} value={l}>{LEVEL_NAMES[l]}</option>)}
          </select></div>
      ))}
    </div>
  );
}
function Users({ me }) {
  const [d, load] = useLoad(() => api('userList'), []);
  const [f, setF] = useState(null); const [edit, setEdit] = useState(null); const [temp, setTemp] = useState(null);
  const canAdmin = atLeast(me.levels.admin, 'admin');
  return (
    <div>
      <div className="row"><h2 className="grow">Users</h2>{canAdmin && <button className="primary" onClick={() => setF({ username: '', name: '', levels: { repos: 'viewer' } })}>Add user</button>}</div>
      <p className="small muted">Viewer can look. Developer can change files, deploy and run safe SQL. Admin can see secrets, change policies and manage people. The Owner can do everything.</p>
      {f && (
        <div className="card">
          <Field label="User name"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoCapitalize="none" /></Field>
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <LevelPicker levels={f.levels} onChange={(levels) => setF({ ...f, levels })} />
          <p className="row"><button className="primary" onClick={run(async () => { const r = await api('userCreate', f); setTemp({ user: f.username, pw: r.tempPassword }); setF(null); load(); })}>Add user</button><button onClick={() => setF(null)}>Cancel</button></p>
        </div>
      )}
      {temp && <Modal onClose={() => setTemp(null)}><h3>Temporary password for {temp.user}</h3><p className="mono card">{temp.pw}</p><p className="small muted">Give it to them in person or by a safe way. They must pick a new one and turn on 2-step when they sign in.</p><p className="row"><button onClick={() => copy(temp.pw)}>Copy</button><button className="primary" onClick={() => setTemp(null)}>Done</button></p></Modal>}
      <div className="list">
        {(d?.users || []).map((u) => (
          <div key={u.id} style={{ display: 'block' }}>
            <div className="row"><b className="grow">{u.username}</b>{u.is_owner && <span className="pill ok">Owner</span>}{u.disabled && <span className="pill bad">Off</span>}
              {u.locked_until && new Date(u.locked_until) > new Date() && <span className="pill bad">Locked</span>}
              <span className={'pill ' + (u.totp_on ? 'ok' : 'warn')}>2-step {u.totp_on ? 'on' : 'off'}</span>
              {canAdmin && !u.is_owner && <button onClick={() => setEdit(edit?.id === u.id ? null : { id: u.id, levels: u.levels || {} })}>Edit</button>}</div>
            <div className="small muted">{u.is_owner ? 'Everything' : Object.entries(u.levels || {}).filter(([k]) => !OWNER_ONLY.includes(k)).map(([k, v]) => `${SECTION_NAMES[k]}: ${LEVEL_NAMES[v]}`).join(' · ') || 'No section access'} · last active {u.last_seen ? when(u.last_seen) : 'never'}</div>
            {edit?.id === u.id && (
              <div className="card">
                <LevelPicker levels={edit.levels} onChange={(levels) => setEdit({ ...edit, levels })} />
                <p className="row">
                  <button className="primary" onClick={run(async () => { await api('userUpdate', { userId: u.id, levels: edit.levels }); toast('Saved'); setEdit(null); load(); })}>Save levels</button>
                  <button onClick={run(async () => { const r = await api('userUpdate', { userId: u.id, resetPassword: true }); setTemp({ user: u.username, pw: r.tempPassword }); load(); })}>New temp password</button>
                  {u.totp_on && <button onClick={run(async () => { if (confirm('Reset 2-step for ' + u.username + '? They set it up again.')) { await api('userUpdate', { userId: u.id, reset2fa: true }); load(); } })}>Reset 2-step</button>}
                  {u.locked_until && <button onClick={run(async () => { await api('userUpdate', { userId: u.id, unlock: true }); load(); })}>Unlock</button>}
                  <button className="danger" onClick={run(async () => { await api('userUpdate', { userId: u.id, disabled: !u.disabled }); load(); })}>{u.disabled ? 'Turn on' : 'Turn off'}</button>
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
function Grants({ me }) {
  const [d, load] = useLoad(() => api('userList'), []);
  const [items] = useLoad(async () => {
    const [r, p] = await Promise.all([api('repoList').catch(() => ({ repos: [] })), api('projectList').catch(() => ({ projects: [] }))]);
    return { repo: r.repos.map((x) => [x.id, x.name]), project: p.projects.map((x) => [x.id, x.slug]) };
  }, []);
  const [f, setF] = useState({ userId: '', kind: 'repo', resourceId: '', level: 'viewer' });
  const canAdmin = atLeast(me.levels.admin, 'admin');
  return (
    <div>
      <h2>Access to one item</h2>
      <p className="small muted">Give someone clearance on one repo or database project without opening the whole room. The Rend room stays owner-only.</p>
      {canAdmin && (
        <div className="card row">
          <select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} style={{ width: 'auto' }}><option value="">Person</option>{(d?.users || []).filter((u) => !u.is_owner).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</select>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, resourceId: '' })} style={{ width: 'auto' }}><option value="repo">Repo (Fit room)</option><option value="project">Database project (Base room)</option></select>
          <select value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })} style={{ width: 'auto' }}><option value="">Item</option>{(items?.[f.kind] || []).map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
          <select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} style={{ width: 'auto' }}>{['viewer', 'developer', 'admin'].map((l) => <option key={l} value={l}>{LEVEL_NAMES[l]}</option>)}</select>
          <button className="primary" onClick={run(async () => { await api('grantSet', { ...f, userId: Number(f.userId), resourceId: Number(f.resourceId) }); toast('Saved'); load(); })}>Give access</button>
        </div>
      )}
      <div className="list">
        {(d?.grants || []).map((g) => {
          const u = (d.users || []).find((x) => x.id === Number(g.user_id));
          return <div key={g.id}><span className="grow">{u?.username} · {g.kind} <b>{g.resource_name || '#' + g.resource_id}</b> · {LEVEL_NAMES[g.level]}</span>
            {canAdmin && <button className="danger" onClick={run(async () => { await api('grantDelete', { id: g.id }); load(); })}>Remove</button>}</div>;
        })}
        {d && !d.grants.length && <div className="muted small">None yet.</div>}
      </div>
    </div>
  );
}
function Audit() {
  const [search, setSearch] = useState('');
  const [d, load] = useLoad(() => api('auditList', { search }), [search]);
  return (
    <div>
      <div className="row"><h2 className="grow">Activity log</h2><input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} /><button onClick={load}>Refresh</button></div>
      <div className="tbl"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>From</th></tr></thead>
        <tbody>{(d?.audit || []).map((a) => <tr key={a.id}><td>{when(a.at)}</td><td>{a.username}</td><td>{a.action}</td><td title={a.detail}>{a.detail}</td><td>{a.ip}</td></tr>)}</tbody></table></div>
    </div>
  );
}
function Settings() {
  const [d] = useLoad(() => api('settingsGet'), []);
  const [f, setF] = useState(null);
  useEffect(() => { if (d) setF(d.settings); }, [d]);
  if (!f) return null;
  return (
    <div className="card">
      <h2>Settings</h2>
      <Field label="Sign out after this many idle minutes (5 to 240)"><input type="number" value={f.idleMinutes} onChange={(e) => setF({ ...f, idleMinutes: e.target.value })} /></Field>
      <Field label="A clearance check lasts this many minutes (1 to 60)"><input type="number" value={f.clearanceMinutes} onChange={(e) => setF({ ...f, clearanceMinutes: e.target.value })} /></Field>
      <label className="row"><input type="checkbox" checked={f.require2fa} onChange={(e) => setF({ ...f, require2fa: e.target.checked })} style={{ width: 'auto' }} /> Everyone must use 2-step sign-in</label>
      <p><button className="primary" onClick={run(async () => { await api('settingsSet', f); toast('Saved'); })}>Save settings</button></p>
      <h3>Last app update</h3>
      <p className="small muted">The server checks your GitHub repo every 5 minutes and updates itself when you upload new files.</p>
      <div className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{d.update || 'No update has run yet.'}</div>
    </div>
  );
}
function Backups() {
  const [d, load] = useLoad(() => api('backupList'), []);
  return (
    <div>
      <div className="row"><h2 className="grow">Backups</h2><button className="primary" onClick={run(async () => { await api('backupNow'); toast('Backup starts within a minute'); setTimeout(load, 70000); })}>Back up now</button><button onClick={load}>Refresh</button></div>
      <p className="small muted">The server makes a backup every day and keeps the last 7. Download copies to keep them somewhere else too. db files are all databases, files are all repo files.</p>
      <div className="list">
        {(d?.files || []).map((f) => <div key={f.name}><span className="mono grow">{f.name}</span><span className="small muted">{size(f.size)}</span><a href={`/api/get?what=backup&file=${encodeURIComponent(f.name)}`}><button>Download</button></a></div>)}
        {d && !d.files.length && <div className="muted small">No backups yet.</div>}
      </div>
    </div>
  );
}
