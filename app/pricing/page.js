'use client';
import { useEffect, useState } from 'react';

/*
  Public pricing page: /pricing
  One plain question at a time, then the plan that fits and a Stripe button.
  The buttons are Stripe Payment Links on the CashCow Stripe account.
*/

// Black Friday banner shows only during the sale, Nov 20 to Dec 1 (Central time).
// Change these two dates if the sale dates change in Stripe.
const BF_START = Date.parse('2026-11-20T00:00:00-06:00');
const BF_END = Date.parse('2026-12-01T23:59:59-06:00');
const BF_CODE = 'BLACKFRIDAY';
const BF_TEXT = '30% off your first payment, until December 1';

const PLANS = {
  starter: { name: 'Starter', price: '$19', per: 'a month', link: 'https://buy.stripe.com/bJe5kF3I4h0B693a5Xak009', gets: ['1 app online', '1 person', 'Code, deploys and database in one place', 'Step-by-step guide'] },
  pro: { name: 'Pro', price: '$49', per: 'a month', link: 'https://buy.stripe.com/7sY9AV3I4bGh0OJ7XPak00a', gets: ['Up to 5 apps online', 'Up to 5 people', 'Contacts and email campaigns', 'Everything in Starter'] },
  business: { name: 'Business', price: '$99', per: 'a month', link: 'https://buy.stripe.com/4gM6oJ1zWdOpapj5PHak00b', gets: ['Unlimited apps', 'Up to 20 people', 'LeadReplyRadar connection', 'Priority help', 'Everything in Pro'] },
  own: { name: 'Own Server License', price: '$299', per: 'one time', link: 'https://buy.stripe.com/5kQ7sN0vS25H9lf4LDak00c', gets: ['Run it on your own AWS server', 'Yours to keep, no monthly fee to us', 'You pay your own server costs', 'Everything in Business'] },
};

const STEPS = {
  where: { q: 'Where do you want it to run?', choices: [['☁️ On our server, pay monthly', 'apps'], ['🖥️ On my own server, pay once', 'plan:own']] },
  apps: { q: 'How many apps will you put online?', choices: [['1️⃣ Just 1', 'plan:starter'], ['🔢 Up to 5', 'plan:pro'], ['♾️ More than 5', 'plan:business']] },
};

const css = `
.pr{max-width:560px;margin:0 auto;padding:16px 16px 60px}
.pr h1{font-size:24px;margin:14px 0 4px}.pr h2{font-size:21px;margin:6px 0 10px}
.pr .lead{color:var(--muted);margin:0 0 16px}
.pr .box{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:12px 0}
.pr .big{display:block;width:100%;padding:16px;font-size:16px;border-radius:12px;margin:8px 0;text-align:left}
.pr .price{font-size:34px;font-weight:700}.pr .per{color:var(--muted);margin-left:6px}
.pr ul{padding-left:20px;margin:10px 0 14px}.pr li{margin:4px 0}
.pr .bf{border:2px dashed var(--warn);border-radius:12px;padding:12px;margin:12px 0}
.pr .all{display:grid;gap:10px}.pr .mini{display:flex;justify-content:space-between;align-items:center;gap:10px}
.pr a.btn{text-decoration:none;display:block}
`;

export default function Pricing() {
  const [path, setPath] = useState(['where']);
  const [BLACK_FRIDAY, setBF] = useState(false);
  useEffect(() => { const now = Date.now(); setBF(now >= BF_START && now <= BF_END); }, []);
  const cur = path[path.length - 1];
  const go = (next) => setPath((p) => [...p, next]);
  const back = () => setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));
  const plan = cur.startsWith('plan:') ? PLANS[cur.slice(5)] : null;
  const step = STEPS[cur];

  return (
    <div className="pr">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <h1>🔐 Fit-Rend-Base</h1>
      <p className="lead">The all-in-one platform for your apps: your code, your deploys and your database in one place, behind clearance levels and 2-step sign-in.</p>
      {BLACK_FRIDAY && <div className="bf"><b>Black Friday:</b> type <b>{BF_CODE}</b> at checkout for {BF_TEXT}.</div>}

      <div className="box">
        {step && (
          <>
            <h2>{step.q}</h2>
            {step.choices.map(([label, next]) => <button key={label} className="big" onClick={() => go(next)}>{label}</button>)}
          </>
        )}
        {plan && (
          <>
            <div className="small muted">This plan fits you</div>
            <h2>{plan.name}</h2>
            <div><span className="price">{plan.price}</span><span className="per">{plan.per}</span></div>
            <ul>{plan.gets.map((g) => <li key={g}>{g}</li>)}</ul>
            <a className="btn" href={plan.link} target="_blank" rel="noopener noreferrer"><button className="big primary">💳 Pay {plan.price} with Stripe</button></a>
            <p className="small muted">Secure checkout by Stripe. {plan.per === 'a month' ? 'Cancel any time.' : 'One payment.'}{BLACK_FRIDAY ? ` Have a code? Type ${BF_CODE} at checkout.` : ''}</p>
          </>
        )}
        {cur === 'all' && (
          <>
            <h2>All plans</h2>
            <div className="all">
              {Object.entries(PLANS).map(([k, p]) => (
                <div key={k} className="mini"><span><b>{p.name}</b><br /><span className="small muted">{p.gets[0]}, {p.gets[1].toLowerCase()}</span></span><button onClick={() => go('plan:' + k)}>{p.price} {p.per === 'a month' ? '/mo' : 'once'}</button></div>
              ))}
            </div>
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          {path.length > 1 && <button onClick={back}>← Back</button>}
          {cur !== 'all' && <button onClick={() => go('all')}>See all plans</button>}
        </div>
      </div>
    </div>
  );
}
