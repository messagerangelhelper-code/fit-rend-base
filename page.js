'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ToolsPanel from './tools-panel';

const POLL_MS = 60 * 1000;
const REPEAT_MS = 8 * 1000;
const TAG_CLASS = {
  Hot: 'tag-hot',
  Interested: 'tag-int',
  Question: 'tag-q',
  Meeting: 'tag-meet',
  Account: 'tag-acct',
  Unsubscribe: 'tag-unsub',
  'Check sender': 'tag-warn',
  'In Brevo': 'tag-int',
  'In Fit-Rend-Base': 'tag-int',
  'Needs your decision': 'tag-hot',
  'Routine': 'tag-int',
  'Noise': 'tag-unsub',
};
const AI_LABEL = { decision: 'Needs your decision', routine: 'Routine', noise: 'Noise' };
const AI_FILTER = { Decide: 'decision', Routine: 'routine', Noise: 'noise' };
// Filters the AI agent buttons on the Tools page use.
const TOPIC_FILTER = {
  'Invoices & bills': ['money'],
  'Support & new clients': ['support', 'new_client'],
  'Meeting requests': ['meeting'],
  'Waiting on you': ['follow_up'],
};
const DEFAULT_SETTINGS = { beepAll: true, repeatHot: true, popups: false };

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}
function initials(name) {
  return (name || '?')
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}
function scoreClass(s) {
  if (s >= 80) return 'score-hot';
  if (s >= 50) return 'score-mid';
  if (s >= 30) return 'score-low';
  return 'score-cold';
}

// ---------- sound ----------
let audioCtx = null;
function beep(times = 1) {
  if (!audioCtx) return false;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  for (let i = 0; i < times; i++) {
    const t = audioCtx.currentTime + i * 0.28;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = i % 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
  return true;
}

// ---------- pieces ----------
function Radar({ dots }) {
  return (
    <div className="radar">
      <svg viewBox="0 0 200 200" className="radar-grid">
        {[90, 65, 40, 15].map((r) => (
          <circle key={r} cx="100" cy="100" r={r} />
        ))}
        <line x1="10" y1="100" x2="190" y2="100" />
        <line x1="100" y1="10" x2="100" y2="190" />
      </svg>
      <div className="sweep" />
      {dots.map((d) => (
        <span
          key={d.id}
          className={'blip ' + (d.score >= 80 ? 'blip-hot' : 'blip-normal')}
          style={{ left: d.x + '%', top: d.y + '%' }}
          title={d.subject}
        />
      ))}
    </div>
  );
}

function Tags({ tags }) {
  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t} className={'tag ' + (TAG_CLASS[t] || 'tag-q')}>
          {t}
        </span>
      ))}
    </div>
  );
}

// Sign-in token kept on this device, sent with every request (needed inside the CashCow Mail dashboard).
function getToken() {
  try {
    return localStorage.getItem('lrr_token') || '';
  } catch (e) {
    return '';
  }
}
function setToken(t) {
  try {
    if (t) localStorage.setItem('lrr_token', t);
    else localStorage.removeItem('lrr_token');
  } catch (e) {}
}
function apiFetch(url, opts = {}) {
  const t = getToken();
  return fetch(url, { ...opts, credentials: 'same-origin', headers: { ...(opts.headers || {}), ...(t ? { 'x-lrr-auth': t } : {}) } });
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true);
  } catch (e) {}
  try {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
    return Promise.resolve(true);
  } catch (e) {
    return Promise.resolve(false);
  }
}

function AiBox({ m, aiOn, busy, onDraft }) {
  const [copied, setCopied] = useState('');
  const ai = m.ai;
  const aiDraft = (ai && ai.draft) || '';
  const [text, setText] = useState(aiDraft);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [sendErr, setSendErr] = useState('');
  useEffect(() => {
    setText(aiDraft);
  }, [aiDraft]);
  if (!aiOn && !ai) return null;
  const drafting = busy === 'draft:' + m.id;
  const scam = (m.tags || []).includes('Check sender');
  const toAddr = m.fromAddress || '';
  const fromAddr = m.account && m.account !== 'demo' ? m.account : 'your mailbox';
  const sendNow = async () => {
    if (sending || sentTo) return;
    const body = String(text || '').trim();
    if (!body) {
      setSendErr('The reply is empty.');
      return;
    }
    if (!window.confirm('Send this reply now?\n\nTo: ' + toAddr + '\nFrom: ' + fromAddr + '\n\nThis cannot be undone.')) return;
    setSending(true);
    setSendErr('');
    try {
      const res = await apiFetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send', id: m.id, text: body }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) setSendErr(j.error || 'Could not send. Try again.');
      else setSentTo(j.to || toAddr);
    } catch (e) {
      setSendErr('Could not reach the app. Try again.');
    } finally {
      setSending(false);
    }
  };
  const copyAndOpen = () =>
    copyText(text).then((ok) => {
      setCopied(ok ? 'open' : '');
      if (m.link) window.open(m.link, '_blank', 'noopener');
    });
  return (
    <div className="card note small" onClick={(e) => e.stopPropagation()} style={{ margin: '8px 0' }}>
      {ai ? (
        <>
          <b>AI: {AI_LABEL[ai.category]}</b>
          {ai.summary && <p style={{ margin: '6px 0' }}>{ai.summary}</p>}
          {ai.why && <p className="muted" style={{ margin: '6px 0' }}>Why: {ai.why}</p>}
        </>
      ) : (
        <b>AI has not read this email yet.</b>
      )}
      {ai && ai.draft && (
        <>
          <p className="muted" style={{ margin: '8px 0 4px' }}>{sentTo ? 'Sent to ' + sentTo + ':' : 'Draft reply (not sent yet, you can edit it):'}</p>
          <textarea
            readOnly={Boolean(sentTo)}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(12, text.split('\n').length + 2)}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 14, padding: 8, borderRadius: 8, background: 'transparent', color: 'inherit', border: '1px solid var(--border)' }}
          />
        </>
      )}
      {aiOn && !scam && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button className="btn btn-blue" disabled={Boolean(busy)} onClick={() => onDraft(m.id)}>
            {drafting ? 'Writing…' : ai && ai.draft ? 'Redo draft' : 'Draft reply'}
          </button>
          {ai && ai.draft && (
            <button className="btn btn-orange" disabled={sending || Boolean(sentTo)} onClick={sendNow}>
              {sentTo ? 'Sent' : sending ? 'Sending…' : 'Send'}
            </button>
          )}
          {ai && ai.draft && (
            <button className="btn btn-blue" onClick={() => copyText(text).then((ok) => setCopied(ok ? 'copy' : ''))}>
              {copied === 'copy' ? 'Copied' : 'Copy reply'}
            </button>
          )}
          {ai && ai.draft && m.link && (
            <button className="btn btn-orange" onClick={copyAndOpen}>
              {copied === 'open' ? 'Copied, Gmail opened' : 'Copy & open Gmail'}
            </button>
          )}
        </div>
      )}
      {sendErr && <p style={{ margin: '6px 0 0', color: '#d33' }}>{sendErr}</p>}
      {ai && ai.draft && !sentTo && !scam && (
        <p className="muted" style={{ margin: '6px 0 0' }}>Send asks you first, then sends from {fromAddr} to {toAddr}.</p>
      )}
    </div>
  );
}

function MailCard({ m, open, onOpen, aiOn, busy, onDraft }) {
  return (
    <div className={'card mail' + (m.score >= 80 ? ' mail-hot' : '')} onClick={() => onOpen(m.id)}>
      <div className="mail-top">
        <div className="avatar">{initials(m.fromName)}</div>
        <div className="mail-main">
          <div className="mail-name">
            {m.unread && <span className="dot-unread" />}
            {m.fromName}
            {m.company ? <span className="muted"> · {m.company}</span> : null}
          </div>
          <div className="mail-subj">{m.subject}</div>
          {!open && <div className="muted small clamp">{m.preview}</div>}
        </div>
        <div className="mail-side">
          <span className={'score ' + scoreClass(m.score)}>Score {m.score}</span>
          <span className="muted small">{ago(m.date)}</span>
        </div>
      </div>
      <Tags tags={[...(m.ai ? [AI_LABEL[m.ai.category]] : []), ...m.tags, ...(m.inFrb ? ['In Fit-Rend-Base'] : m.inBrevo ? ['In Brevo'] : [])]} />
      {open && (
        <div className="mail-open">
          <p className="small">{m.preview}{m.preview && m.preview.length >= 160 ? '…' : ''}</p>
          <AiBox m={m} aiOn={aiOn} busy={busy} onDraft={onDraft} />
          <p className="muted small">From: {m.fromAddress}{m.account && m.account !== 'demo' ? ' · To: ' + m.account : ''}</p>
          {m.reasons && m.reasons.length > 0 && (
            <ul className="reasons small">
              {m.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {m.link && (
            <a className="btn btn-orange" href={m.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              Open in Gmail
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function BarChart({ days }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const best = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);
  return (
    <div>
      <div className="bars">
        {days.map((d) => (
          <div key={d.key} className="bar-col">
            <span className="bar-num">{d.count}</span>
            <div className="bar-track">
              <div
                className={'bar ' + (d.key === best.key && best.count > 0 ? 'bar-best' : '')}
                style={{ height: (d.count / max) * 100 + '%' }}
              />
              {d.hot > 0 && <div className="bar-hot" style={{ height: (d.hot / max) * 100 + '%' }} />}
            </div>
            <span className="muted small">{d.label}</span>
          </div>
        ))}
      </div>
      {best.count > 0 && (
        <p className="insight">
          {best.label} was your busiest day with {best.count} emails.
        </p>
      )}
    </div>
  );
}

// ---------- page ----------
export default function Home() {
  const [tab, setTabState] = useState('radar');
  // Each tab is a step in the phone's history, so the back button goes to the last tab
  // instead of closing the app.
  const tabRef = useRef('radar');
  // True when the inbox was opened from one of the AI tool tiles, so it shows a Back button.
  const [fromTool, setFromTool] = useState(false);
  const setTab = useCallback((t) => {
    if (t !== 'inbox') setFromTool(false);
    if (tabRef.current !== t) {
      try {
        // Keep Next.js's own history data (__NA and the route tree) on every entry.
        // Without it, Next.js reloads the whole page when you press back.
        const st = { ...(window.history.state || {}), lrrTab: t };
        delete st.lrrTool;
        window.history.pushState(st, '');
      } catch (e) {}
    }
    tabRef.current = t;
    setTabState(t);
  }, []);
  useEffect(() => {
    const onPop = (e) => {
      const t = (e.state && e.state.lrrTab) || 'radar';
      if (t !== 'inbox') setFromTool(false);
      tabRef.current = t;
      setTabState(t);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // Pointer to the Tutorial button. Shows until the person opens the tutorial once.
  const [tutorialHint, setTutorialHint] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem('lrr-tutorial-seen')) setTutorialHint(true);
    } catch (e) {
      setTutorialHint(true);
    }
  }, []);
  const openedTutorial = () => {
    setTutorialHint(false);
    try {
      localStorage.setItem('lrr-tutorial-seen', '1');
    } catch (e) {}
  };
  const [data, setData] = useState(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [soundOn, setSoundOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [acked, setAcked] = useState([]);
  const [newHot, setNewHot] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiBusy, setAiBusy] = useState('');
  const [aiMsg, setAiMsg] = useState('');
  const [brief, setBrief] = useState(null);
  const known = useRef(null);

  useEffect(() => {
    setSettings({ ...DEFAULT_SETTINGS, ...load('lrr_settings', {}) });
    setAcked(load('lrr_acked', []));
    known.current = load('lrr_known', null);
  }, []);

  const updateSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    save('lrr_settings', next);
  };

  const fetchMail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/mail', { cache: 'no-store' });
      if (res.status === 401) {
        setNeedLogin(true);
        return;
      }
      const json = await res.json();
      setNeedLogin(false);
      setData(json);

      // Find emails we haven't seen before.
      const ids = (json.items || []).map((m) => m.id);
      if (known.current === null) {
        known.current = ids; // first visit: no beep for old mail
      } else {
        const fresh = (json.items || []).filter((m) => !known.current.includes(m.id));
        if (fresh.length) {
          const hot = fresh.filter((m) => m.score >= 80);
          if (hot.length) setNewHot((prev) => [...new Set([...prev, ...hot.map((m) => m.id)])]);
          if (settings.beepAll || hot.length) beep(hot.length ? 3 : 1);
          if (settings.popups && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const top = hot[0] || fresh[0];
            new Notification((hot.length ? 'Urgent email: ' : 'New email: ') + top.fromName, { body: top.subject });
          }
        }
        known.current = [...new Set([...known.current, ...ids])].slice(-1000);
      }
      save('lrr_known', known.current);
    } catch (e) {
      // Show the problem instead of staying on Loading.
      setData((prev) => prev || { mode: 'live', items: [], accounts: [], error: 'Could not reach your mail yet. Pull down to refresh in a minute.' });
    } finally {
      setLoading(false);
    }
  }, [settings.beepAll, settings.popups]);

  useEffect(() => {
    fetchMail();
  }, [fetchMail]);

  useEffect(() => {
    if (paused) return undefined;
    const t = setInterval(fetchMail, POLL_MS);
    return () => clearInterval(t);
  }, [fetchMail, paused]);

  // Keep beeping for urgent mail until you look at it.
  const waiting = newHot.filter((id) => !acked.includes(id));
  useEffect(() => {
    if (!soundOn || !settings.repeatHot || waiting.length === 0) return undefined;
    const t = setInterval(() => beep(3), REPEAT_MS);
    return () => clearInterval(t);
  }, [soundOn, settings.repeatHot, waiting.length]);

  const acknowledge = (ids) => {
    const next = [...new Set([...acked, ...ids])].slice(-1000);
    setAcked(next);
    save('lrr_acked', next);
  };

  const openMail = (id) => {
    setOpenId(openId === id ? null : id);
    acknowledge([id]);
  };

  const goInbox = () => {
    setTab('inbox');
    acknowledge(newHot);
  };

  const turnOnSound = () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
      setSoundOn(true);
      beep(1);
    } catch (e) {}
  };

  const askPopups = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    updateSettings({ popups: p === 'granted' });
  };

  const login = async (e) => {
    e.preventDefault();
    setLoginError('');
    const res = await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setToken(j.token || '');
      setPassword('');
      fetchMail();
    } else {
      const j = await res.json().catch(() => ({}));
      setLoginError(j.error || 'Could not sign in.');
    }
  };

  // One-click AI buttons. Sending happens only from the Send button on one email.
  const runAi = async (action, id) => {
    if (aiBusy) return;
    setAiBusy(action === 'draft' ? 'draft:' + id : action);
    setAiMsg('');
    try {
      const res = await apiFetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setNeedLogin(true);
        return;
      }
      if (!res.ok || !j.ok) {
        setAiMsg(j.error || 'The AI could not do that just now. Try again.');
        return;
      }
      if (action === 'draft') {
        setData((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === j.id ? { ...x, ai: j.ai } : x)) } : prev));
      }
      if (action === 'sort') {
        setAiMsg('Sorted ' + j.sorted + ' email' + (j.sorted === 1 ? '' : 's') + '.' + (j.left ? ' ' + j.left + ' left, tap again.' : ''));
        await fetchMail();
      }
      if (action === 'brief') setBrief(j.brief);
    } catch (e) {
      setAiMsg('Could not reach the app. Try again.');
    } finally {
      setAiBusy('');
    }
  };

  const showTopic = (name) => {
    setFilter(name);
    setOpenId(null);
    goInbox();
    setFromTool(true);
  };
  // Back from the inbox to the Tools page, the same as the phone's back button.
  const backToTools = () => {
    setFromTool(false);
    try {
      if (window.history.state && window.history.state.lrrTab === 'inbox') {
        window.history.back();
        return;
      }
    } catch (e) {}
    setTab('tools');
  };

  const logout = async () => {
    await apiFetch('/api/login', { method: 'DELETE' });
    setToken('');
    setData(null);
    setNeedLogin(true);
  };

  const items = (data && data.items) || [];
  const aiOn = Boolean(data && data.ai && data.ai.on);
  const todayPlan = brief || (data && data.brief) || null;

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        const au = a.tags.includes('Unsubscribe') || (a.ai && a.ai.category === 'noise') ? 1 : 0;
        const bu = b.tags.includes('Unsubscribe') || (b.ai && b.ai.category === 'noise') ? 1 : 0;
        if (au !== bu) return au - bu;
        return b.score - a.score || new Date(b.date) - new Date(a.date);
      }),
    [items]
  );

  const shown = sorted.filter((m) => {
    if (filter === 'Hot' && m.score < 80) return false;
    if (TOPIC_FILTER[filter]) {
      if (!m.ai || !TOPIC_FILTER[filter].includes(m.ai.topic)) return false;
    } else if (AI_FILTER[filter]) {
      if (!m.ai || m.ai.category !== AI_FILTER[filter]) return false;
    } else if (filter !== 'All' && filter !== 'Hot' && !m.tags.includes(filter)) return false;
    if (query) {
      const q = query.toLowerCase();
      return (m.fromName + ' ' + m.subject + ' ' + m.preview + ' ' + (m.company || '')).toLowerCase().includes(q);
    }
    return true;
  });

  const stats = useMemo(() => {
    const hot = items.filter((m) => m.score >= 80);
    return {
      total: items.length,
      hot: hot.length,
      meetings: items.filter((m) => m.tags.includes('Meeting')).length,
      needReply: items.filter((m) => m.score >= 80 || m.tags.includes('Question')).length,
      unread: items.filter((m) => m.unread).length,
      hotUnread: hot.filter((m) => m.unread).length,
      decide: items.filter((m) => m.ai && m.ai.category === 'decision').length,
      drafts: items.filter((m) => m.ai && m.ai.draft).length,
      noise: items.filter((m) => m.ai && m.ai.category === 'noise').length,
      aiSorted: items.filter((m) => m.ai).length,
    };
  }, [items]);

  const days = useMemo(() => {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      out.push({ key: d.toDateString(), label: d.toLocaleDateString('en-US', { weekday: 'short' }), count: 0, hot: 0 });
    }
    items.forEach((m) => {
      const day = out.find((x) => x.key === new Date(m.date).toDateString());
      if (day) {
        day.count++;
        if (m.score >= 80) day.hot++;
      }
    });
    return out;
  }, [items]);

  const dots = useMemo(
    () =>
      items.slice(0, 24).map((m, i) => {
        const angle = (i * 137.5 * Math.PI) / 180;
        const r = 12 + (100 - m.score) * 0.32;
        return { id: m.id, subject: m.subject, score: m.score, x: 50 + Math.cos(angle) * r, y: 50 + Math.sin(angle) * r };
      }),
    [items]
  );

  if (needLogin) {
    return (
      <main className="wrap center">
        <form className="card login" onSubmit={login}>
          <h1>LeadReplyRadar</h1>
          <p className="muted">Enter your dashboard password.</p>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus />
          {loginError && <p className="error small">{loginError}</p>}
          <button className="btn btn-orange" type="submit">Sign in</button>
        </form>
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <h1>LeadReplyRadar</h1>
          <span className="muted small">
            {data ? (data.mode === 'demo' ? 'Sample data' : 'Live') : 'Loading'}
            {data && data.checkedAt ? ' · checked ' + new Date(data.checkedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''}
            {paused ? ' · paused' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <style>{'@keyframes lrrPoint{0%,100%{transform:translateX(0)}50%{transform:translateX(6px)}}'}</style>
          {tutorialHint && (
            <span
              aria-hidden="true"
              style={{ color: '#D4A94D', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', display: 'inline-block', animation: 'lrrPoint 1s ease-in-out infinite' }}
            >
              New! 👉
            </span>
          )}
          <a
            href="/preview.html"
            target="_blank"
            rel="noopener noreferrer"
            onClick={openedTutorial}
            className="unread-pill"
            style={{
              background: 'rgba(212,169,77,.18)',
              color: '#D4A94D',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
              boxShadow: tutorialHint ? '0 0 0 2px #D4A94D' : 'none',
            }}
            title="Watch the tutorial: every feature, with Pause, Back and Next"
          >
            ▶ Tutorial
          </a>
          <span className="unread-pill">{stats.unread} unread</span>
        </div>
      </header>

      {!soundOn && (
        <button className="btn btn-orange full" onClick={turnOnSound}>
          🔔 Turn on sound alerts
        </button>
      )}

      {waiting.length > 0 && (
        <button className="alert-banner" onClick={goInbox}>
          {waiting.length} urgent email{waiting.length > 1 ? 's' : ''} need{waiting.length > 1 ? '' : 's'} you. Tap to view.
        </button>
      )}

      {data && data.mode === 'demo' && (
        <div className="card note small">
          Showing sample emails. {data.setup}
        </div>
      )}

      {aiMsg && (
        <button className="card note small" style={{ width: '100%', textAlign: 'left' }} onClick={() => setAiMsg('')}>
          {aiMsg} <span className="muted">(tap to close)</span>
        </button>
      )}

      {data && data.error && (
        <div className="card note error small">{data.error}</div>
      )}

      {data && data.accounts && data.accounts.some((a) => !a.ok) && (
        <div className="card note error small">
          {data.accounts
            .filter((a) => !a.ok)
            .map((a) => 'Could not read ' + a.user + ': ' + a.error)
            .join(' · ')}
        </div>
      )}

      {tab === 'radar' && (
        <section>
          <Radar dots={dots} />
          {aiOn && (
            <div className="card note small">
              <b>AI Inbox Assistant</b>
              <p style={{ margin: '6px 0 0' }}>
                {stats.aiSorted === 0
                  ? 'Sorting your emails now. Check back in a minute.'
                  : stats.decide + ' need your decision · ' + stats.drafts + ' reply drafts ready · ' + stats.noise + ' noise moved down'}
              </p>
              {stats.aiSorted > 0 && (
                <button className="link small" onClick={() => { setFilter('Decide'); goInbox(); }}>See what needs you</button>
              )}
            </div>
          )}
          <div className="grid2">
            <div className="card metric"><b>{stats.total}</b><span>Emails this week</span></div>
            <div className="card metric"><b className="orange">{stats.hot}</b><span>Hot, reply fast</span></div>
            <div className="card metric"><b>{stats.meetings}</b><span>Meetings asked</span></div>
            <div className="card metric"><b className="green">{stats.needReply}</b><span>Need a reply</span></div>
          </div>
          <div className="section-head">
            <h2>Top of the radar</h2>
            <button className="link" onClick={goInbox}>See all</button>
          </div>
          {sorted.slice(0, 3).map((m) => (
            <MailCard key={m.id} m={m} open={openId === m.id} onOpen={openMail} aiOn={aiOn} busy={aiBusy} onDraft={(id) => runAi('draft', id)} />
          ))}
        </section>
      )}

      {tab === 'inbox' && (
        <section>
          {fromTool && (
            <button className="btn btn-blue full" onClick={backToTools} style={{ marginBottom: 10 }}>
              ← Back to all tools
            </button>
          )}
          <div className="toolbar">
            <button className="icon-btn" onClick={fetchMail} title="Refresh">{loading ? '…' : '↻'}</button>
            <button className="icon-btn" onClick={() => setPaused(!paused)} title={paused ? 'Resume' : 'Pause'}>{paused ? '▶' : '❚❚'}</button>
            <input className="search" placeholder="Search emails" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {aiOn && (
            <button className="btn btn-orange full" disabled={Boolean(aiBusy)} onClick={() => runAi('sort')} style={{ marginBottom: 8 }}>
              {aiBusy === 'sort' ? 'Sorting…' : 'Sort my inbox with AI'}
            </button>
          )}
          <div className="filters">
            {TOPIC_FILTER[filter] && (
              <button className="chip chip-on" onClick={() => setFilter('All')}>{filter} ✕</button>
            )}
            {['All', ...(aiOn ? ['Decide', 'Routine', 'Noise'] : []), 'Hot', 'Account', 'Interested', 'Meeting', 'Question'].map((f) => (
              <button key={f} className={'chip' + (filter === f ? ' chip-on' : '')} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
          {shown.length === 0 && <p className="muted">No emails here.</p>}
          {shown.map((m) => (
            <MailCard key={m.id} m={m} open={openId === m.id} onOpen={openMail} aiOn={aiOn} busy={aiBusy} onDraft={(id) => runAi('draft', id)} />
          ))}
        </section>
      )}

      {tab === 'analytics' && (
        <section>
          <h2>Email activity</h2>
          <p className="muted small">Last 7 days · orange is hot mail</p>
          <div className="card">
            <BarChart days={days} />
          </div>
          <div className="grid2">
            <div className="card metric"><b>{stats.total ? Math.round((stats.hot / stats.total) * 100) : 0}%</b><span>Hot share</span></div>
            <div className="card metric"><b>{stats.hotUnread}</b><span>Hot still unread</span></div>
          </div>
        </section>
      )}

      {tab === 'alerts' && (
        <section>
          <h2>Alerts</h2>
          <div className="card">
            <Toggle label="Beep for every new email" on={settings.beepAll} onChange={(v) => updateSettings({ beepAll: v })} />
            <Toggle label="Keep beeping on urgent mail until I look" on={settings.repeatHot} onChange={(v) => updateSettings({ repeatHot: v })} />
            <Toggle
              label="Pop-up notifications"
              on={settings.popups}
              onChange={(v) => (v ? askPopups() : updateSettings({ popups: false }))}
            />
            <Toggle label="SMS alerts" soon />
            <Toggle label="Call alerts" soon />
          </div>
          <button className="btn btn-blue full" onClick={() => (soundOn ? beep(3) : turnOnSound())}>
            Send test alert
          </button>
          <p className="muted small">
            Hot means a score of 80 or more: deadlines, account notices, payment problems, or someone replying to you.
            Checks your inbox every minute while this page is open.
          </p>
          {data && data.mode === 'live' && (
            <button className="link small" onClick={logout}>Sign out</button>
          )}
        </section>
      )}

      {tab === 'tools' && (
        <section>
          <h2>More tools</h2>
          <AiAgent
            aiOn={aiOn}
            status={data && data.ai}
            busy={aiBusy}
            plan={todayPlan}
            items={items}
            run={runAi}
            showTopic={showTopic}
            openEmail={(id) => {
              setFilter('All');
              goInbox();
              setFromTool(true);
              setOpenId(id);
            }}
          />
          {data && data.frb && data.frb.on ? (
            <div className="card">
              <b>Fit-Rend-Base Contacts</b>
              <p className="small">
                On · <b className="green">{data.frb.saved}</b> saved to Fit-Rend-Base since the last restart. Important senders
                (score 50+) are saved there every 5 minutes. Email campaigns you start in Fit-Rend-Base send from your Gmail here.
              </p>
              {data.frb.error && <p className="error small">Last Fit-Rend-Base error: {data.frb.error}</p>}
            </div>
          ) : (
          <div className="card">
            <b>Brevo CRM Sync</b>
            {data && data.brevo && data.brevo.on ? (
              <p className="small">
                On · <b className="green">{data.brevo.saved}</b> saved to Brevo since the last restart. Important senders
                (score 50+) are saved with a note every 5 minutes.
              </p>
            ) : (
              <p className="muted small">Off. Add BREVO_API_KEY on Render to turn it on.</p>
            )}
            {data && data.brevo && data.brevo.error && <p className="error small">Last Brevo error: {data.brevo.error}</p>}
            <p className="muted small">To use your own Fit-Rend-Base instead, add FRB_URL and FRB_SECRET on Render.</p>
          </div>
          )}
          <ToolsPanel onSignIn={() => setNeedLogin(true)} />
        </section>
      )}

      <nav className="bottomnav">
        {[
          ['radar', 'Radar', '◎'],
          ['inbox', 'Inbox', '✉'],
          ['analytics', 'Analytics', '▥'],
          ['alerts', 'Alerts', '🔔'],
          ['tools', 'Tools', '▦'],
        ].map(([key, label, icon]) => (
          <button key={key} className={tab === key ? 'nav-on' : ''} onClick={() => (key === 'inbox' ? goInbox() : setTab(key))}>
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}

// The six AI tool buttons on the Tools page. Each one only reads and sorts; nothing is sent.
function AiAgent({ aiOn, status, busy, plan, items, run, showTopic, openEmail }) {
  const count = (topics) => items.filter((m) => m.ai && topics.includes(m.ai.topic)).length;
  const jobs = [
    {
      name: 'AI Project Coordinator',
      text: 'Today\'s to-do list from your mail, most urgent first.',
      button: busy === 'brief' ? 'Planning…' : 'Plan my day',
      onClick: () => run('brief'),
    },
    {
      name: 'AI Books & Invoices',
      text: 'Invoices, bills, receipts and payments. ' + count(['money']) + ' found.',
      button: 'Show',
      onClick: () => showTopic('Invoices & bills'),
      later: 'Full bookkeeping needs a books app.',
    },
    {
      name: 'AI Support & Onboarding',
      text: 'Customer problems and new clients. ' + count(['support', 'new_client']) + ' found.',
      button: 'Show',
      onClick: () => showTopic('Support & new clients'),
    },
    {
      name: 'AI Inbox Filter',
      text: 'Decision, routine or noise, with reply drafts.',
      button: busy === 'sort' ? 'Sorting…' : 'Sort my inbox',
      onClick: () => run('sort'),
    },
    {
      name: 'AI Focus Time',
      text: 'Meeting requests to accept or skip. ' + count(['meeting']) + ' found.',
      button: 'Show',
      onClick: () => showTopic('Meeting requests'),
      later: 'Blocking time needs a calendar.',
    },
    {
      name: 'AI Follow-ups',
      text: 'People waiting on you. ' + count(['follow_up']) + ' found.',
      button: 'Show',
      onClick: () => showTopic('Waiting on you'),
    },
  ];
  return (
    <div>
      <div className="card note small">
        {aiOn ? (
          <span>
            AI is on · <b className="green">{status.sorted}</b> emails sorted. Tap a tool to run it. Nothing is sent for you.
          </span>
        ) : (
          <span>AI is off. Add ANTHROPIC_API_KEY on Render to connect these tools.</span>
        )}
        {status && status.error && <p className="error small">Last AI error: {status.error}</p>}
      </div>
      <div className="grid2">
        {jobs.map((j) => (
          <button
            key={j.name}
            className="card tool"
            style={{ textAlign: 'left', color: 'inherit', opacity: aiOn ? 1 : 0.6 }}
            disabled={!aiOn || Boolean(busy)}
            onClick={j.onClick}
          >
            <b>{j.name}</b>
            <span className="muted small">{j.text}</span>
            {j.later && <span className="muted small">{j.later}</span>}
            <span className={aiOn ? 'tag tag-int' : 'badge-soon'}>{aiOn ? j.button : 'Off'}</span>
          </button>
        ))}
      </div>
      {plan && (
        <div className="card note small">
          <b>Today: {plan.headline}</b>
          {plan.todo.length > 0 && (
            <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {plan.todo.map((t, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {t.id ? (
                    <button className="link small" style={{ textAlign: 'left' }} onClick={() => openEmail(t.id)}>
                      {t.task}
                    </button>
                  ) : (
                    t.task
                  )}
                  {t.why ? <span className="muted"> · {t.why}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle({ label, on, onChange, soon }) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      {soon ? (
        <span className="badge-soon">Soon</span>
      ) : (
        <button className={'switch' + (on ? ' switch-on' : '')} onClick={() => onChange(!on)} aria-pressed={on}>
          <span />
        </button>
      )}
    </div>
  );
}
