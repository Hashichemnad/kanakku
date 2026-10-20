import {
  store, emptyData, newId, acc, catOf, personOf, kuriOf, assetOf, projectOf, TYPES, rate, toAED, side,
  accountBalances, peopleBalances, personAED, personLedger, kuriSummary, assetSummary, netWorth, periodTotals,
  projectSummary, kuriTotals, CURS, zero, addTo, isZero, multi, personLoans, PERSON_TYPES,
  money, todayISO, fmtDate, fmtMonth, evalAmount, addMonths, dueRecurring, addDays, effectOn, MONTH_NAMES,
} from './store.js';
import { icon } from './icons.js';
import { zakatView, yearState, lockYear, unlockYear, ensureZakatCat, zakatCats, paymentYear } from './zakat.js';

// ======================================================================
// UI state
// ======================================================================
const ui = {
  zakatYear: null,
  tab: 'home',
  stack: [],            // detail pages: {v, id}
  sheets: [],           // open sheets (top = last)
  hide: false,          // hide amounts
  act: { q: '', type: 'all', month: '', acc: '', cat: '', person: '', project: '', limit: 150 },
  people: { filter: 'owed', q: '' },
  report: { mode: 'month', ym: todayISO().slice(0, 7), y: todayISO().slice(0, 4) },
  wealth: {},
};
const app = document.getElementById('app');
const layer = document.getElementById('layer');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const D = () => store.data;
const isNative = () => typeof window.KanakkuNative !== 'undefined';

function toast(msg, action) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.remove(); action.fn(); };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), action ? 5000 : 2400);
}

// ======================================================================
// Rendering helpers
// ======================================================================
const amtCls = (t) => ({ in: 'c-in', out: 'c-out', lend: 'c-lend', borrow: 'c-borrow', kuri: 'c-kuri', invest: 'c-invest', move: 'c-move' }[TYPES[t.type]?.color] || '');
const bgCls = (t) => 'bg-' + (TYPES[t.type]?.color || 'move');
const initials = (n) => (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const m = (n, cur, o) => `<span class="num">${money(n, cur, o)}</span>`;

function describe(t, ctx = {}) {
  const a = acc(t.acc);
  const out = { icon: '', title: '', sub: [], amt: '', cls: amtCls(t), bg: bgCls(t) };
  const c = catOf(t.cat);
  switch (t.type) {
    case 'expense': case 'income':
      out.icon = c?.icon || '🏷️';
      out.title = t.sub || c?.name || TYPES[t.type].label;
      if (t.sub && c) out.sub.push(c.name);
      if (t.person) out.sub.push(personOf(t.person)?.name);
      if (t.project && !ctx.inProject && projectOf(t.project)?.name !== c?.name) out.sub.push((projectOf(t.project)?.icon || '') + ' ' + (projectOf(t.project)?.name || ''));
      out.bg = t.type === 'income' ? 'bg-in' : '';
      break;
    case 'transfer': {
      const to = acc(t.to);
      out.icon = icon('swap');
      out.title = `${a?.name || '?'} → ${to?.name || '?'}`;
      if (t.cur !== (to?.cur || t.cur)) out.sub.push(`${money(t.amt2, to.cur)} received`);
      break;
    }
    case 'lend': case 'collect': case 'borrow': case 'repay': case 'waive': case 'waived': case 'person_adjust': {
      const p = personOf(t.person);
      out.icon = `<b style="font-size:14px">${esc(initials(p?.name))}</b>`;
      out.title = ctx.inPerson ? TYPES[t.type].label : `${TYPES[t.type].label} · ${p?.name || '?'}`;
      break;
    }
    case 'kuri_pay': case 'kuri_get':
      out.icon = '🪙'; out.title = `${kuriOf(t.kuri)?.name || 'Kuri'} · ${t.type === 'kuri_pay' ? 'instalment' : 'received'}`; break;
    case 'invest': case 'asset_in':
      out.icon = icon('trend'); out.title = `${assetOf(t.asset)?.name || 'Investment'}${t.sub ? ' · ' + t.sub : ''}`;
      out.sub.push(TYPES[t.type].label); break;
    case 'adjust':
      out.icon = icon('sliders'); out.title = 'Balance correction'; break;
  }
  if (a && t.type !== 'transfer' && !ctx.inAccount) out.sub.push(a.name);
  if (t.note && !ctx.noNote) out.sub.push(t.note.split('\n')[0]);
  // amount sign from the point of view of the context
  let signed;
  if (ctx.inAccount) signed = effectOn(t, ctx.inAccount);
  else if (t.type === 'transfer' || t.type === 'person_adjust' || t.type === 'waive' || t.type === 'waived') signed = null;
  else if (t.type === 'adjust') signed = t.amt;
  else signed = TYPES[t.type].dir * t.amt;
  const cur = ctx.inAccount && t.to === ctx.inAccount && t.type === 'transfer' ? acc(t.to).cur : t.cur;
  if (ctx.inPerson) {
    const s = side(t);
    out.amt = money(s.amt, s.cur, { plus: false });
  } else {
    out.amt = signed == null ? money(t.amt, t.cur) : money(signed, cur, { plus: true });
  }
  return out;
}

function txnRow(t, ctx = {}) {
  const d = describe(t, ctx);
  return `<button class="row tap" data-a="editTxn" data-id="${t.id}">
    <div class="ic ${d.bg}">${d.icon}</div>
    <div class="mid"><div class="t">${esc(d.title)}</div><div class="d">${esc(d.sub.filter(Boolean).join(' · ') || fmtDate(t.date))}</div></div>
    <div class="amt num ${d.cls}">${d.amt}${ctx.extra ? `<small>${ctx.extra(t)}</small>` : ''}</div>
  </button>`;
}

function groupedTxns(list, ctx = {}) {
  if (!list.length) return `<div class="list"><div class="empty"><span class="big">🧾</span>No entries yet</div></div>`;
  let html = '', day = null, buf = [];
  const flush = () => {
    if (!buf.length) return;
    const net = zero();
    for (const t of buf) if (t.type === 'expense') net[t.cur] -= t.amt; else if (t.type === 'income') net[t.cur] += t.amt;
    html += `<div class="day-head"><span>${fmtDate(day)}</span><span class="num">${isZero(net) ? '' : multi(net, { plus: true })}</span></div><div class="list">${buf.map(t => txnRow(t, ctx)).join('')}</div>`;
    buf = [];
  };
  for (const t of list) { if (t.date !== day) { flush(); day = t.date; } buf.push(t); }
  flush();
  return html;
}

const sorted = (list) => [...list].sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : (b.created || 0) - (a.created || 0)));

function topbar(title, opts = {}) {
  return `<div class="topbar">
    ${opts.back ? `<button class="icon-btn plain" data-a="back">${icon('back')}</button>` : ''}
    <div class="grow"><h1>${esc(title)}</h1>${opts.sub ? `<div class="sub">${opts.sub}</div>` : ''}</div>
    ${opts.right || ''}
  </div>`;
}

// ======================================================================
// Screens
// ======================================================================
function viewHome() {
  const nw = netWorth();
  const ym = todayISO().slice(0, 7);
  const prevYm = addMonths(ym + '-01', -1, 1).slice(0, 7);
  const cur = periodTotals(ym), prev = periodTotals(prevYm);
  const bal = accountBalances();
  const accs = D().accounts.filter(a => !a.closed).sort((x, y) => (x.cur === y.cur ? 0 : x.cur === 'AED' ? -1 : 1) || Math.abs(bal[y.id]) - Math.abs(bal[x.id]));
  const due = dueRecurring();
  const recent = sorted(D().txns).slice(0, 6);
  const cats = [...cur.AED.byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxCat = cats[0]?.[1] || 1;
  const diff = prev.AED.spent ? Math.round((cur.AED.spent - prev.AED.spent) / prev.AED.spent * 100) : null;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const pick = (k) => ({ AED: nw.AED[k], INR: nw.INR[k] });
  const owedPeople = [...peopleBalances().values()].filter(e => (e.AED || 0) > 0.5 || (e.INR || 0) > 0.5).length;
  const mon = MONTH_NAMES[+ym.slice(5) - 1];
  const zy = String(+ym.slice(0, 4) - (+ym.slice(5) < 12 ? 1 : 0));
  const zv = zakatView(zy);
  const zakatLeft = !isZero(zv.left) && (zv.left.AED > 0.5 || zv.left.INR > 0.5);

  return `<div class="screen">
  ${topbar('Kanakku', { sub: hello, right: `<button class="icon-btn" data-a="go" data-v="reports">${icon('pie')}</button><button class="icon-btn" data-a="go" data-v="settings">${icon('settings')}</button>` })}
  <div class="hero ${ui.hide ? 'blur' : ''}">
    <div class="label">Net worth <button class="eye" data-a="toggleHide" style="color:inherit">${icon(ui.hide ? 'eyeoff' : 'eye')}</button></div>
    <div class="value num">${money(nw.AED.total, 'AED')}</div>
    ${Math.abs(nw.INR.total) >= 0.005 ? `<div class="value2 num">${money(nw.INR.total, 'INR')}</div>` : ''}
    <div class="split">
      <div><span>Bank & cash</span><b>${dual({ AED: nw.AED.cash + nw.AED.cards, INR: nw.INR.cash + nw.INR.cards }, { short: true })}</b></div>
      <div><span>Owed to you</span><b>${dual({ AED: nw.AED.owed - nw.AED.owe, INR: nw.INR.owed - nw.INR.owe }, { short: true })}</b></div>
      <div><span>Investments</span><b>${dual(pick('assets'), { short: true })}</b></div>
    </div>
  </div>
  <div class="shortcuts">
    <button data-a="go" data-v="zakat"><span class="sc bg-in">🤲</span>Zakat</button>
    <button data-a="go" data-v="kuris"><span class="sc bg-kuri">🪙</span>Kuri</button>
    <button data-a="go" data-v="projects"><span class="sc bg-invest">🏗️</span>Projects</button>
    <button data-a="go" data-v="recurring"><span class="sc bg-lend">🔁</span>Recurring</button>
    <button data-a="go" data-v="reports"><span class="sc bg-move">${icon('pie')}</span>Reports</button>
  </div>
  ${due.map(r => {
    const late = r.next < todayISO();
    return `<div class="due"><div class="ic" style="font-size:22px">🔁</div><div class="mid"><b>${esc(r.title)}</b><span class="small muted">${late ? 'Was due' : 'Due'} ${fmtDate(r.next)} · ${money(r.amt, acc(r.acc)?.cur || 'AED')}</span></div>
      <button class="btn ghost" data-a="skipRec" data-id="${r.id}">Skip</button><button class="btn primary" style="flex:none" data-a="doRec" data-id="${r.id}">Record</button></div>`;
  }).join('')}
  ${zakatLeft ? `<button class="due" style="width:100%;text-align:left" data-a="go" data-v="zakat" data-id="${zy}"><div class="ic" style="font-size:22px">🤲</div><div class="mid"><b>Zakat ${zy} still to give</b><span class="small muted num">${multi({ AED: Math.max(0, zv.left.AED), INR: Math.max(0, zv.left.INR) })}</span></div>${icon('chevron', 'chev')}</button>` : ''}
  <div class="section tiles">
    <button class="tile" data-a="goAct" data-type="expense" data-month="${ym}"><div class="k"><span class="dot" style="background:var(--out)"></span>Spent in ${mon}</div><div class="v num">${money(cur.AED.spent)}</div><div class="s">${cur.INR.spent ? money(cur.INR.spent, 'INR') + ' · ' : ''}${diff == null ? '' : `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}%`}</div></button>
    <button class="tile" data-a="goAct" data-type="income" data-month="${ym}"><div class="k"><span class="dot" style="background:var(--in)"></span>Earned in ${mon}</div><div class="v num">${money(cur.AED.earned)}</div><div class="s">${cur.INR.earned ? money(cur.INR.earned, 'INR') + ' · ' : ''}Saved ${money(cur.AED.earned - cur.AED.spent)}</div></button>
    <button class="tile" data-a="tab" data-tab="people"><div class="k"><span class="dot" style="background:var(--lend)"></span>Owed to you</div><div class="v num">${money(nw.AED.owed)}</div><div class="s">${nw.INR.owed ? money(nw.INR.owed, 'INR') + ' · ' : ''}${owedPeople} people</div></button>
    <button class="tile" data-a="tab" data-tab="people" data-filter="owe"><div class="k"><span class="dot" style="background:var(--borrow)"></span>You owe</div><div class="v num">${money(nw.AED.owe)}</div><div class="s">${nw.INR.owe ? money(nw.INR.owe, 'INR') : '&nbsp;'}</div></button>
  </div>
  <div class="section">
    <div class="section-head"><h2>Accounts</h2><button data-a="go" data-v="accounts">See all</button></div>
    <div class="strip ${ui.hide ? 'blur-amt' : ''}">
      ${accs.map(a => `<button class="acc-card" data-a="go" data-v="account" data-id="${a.id}">
        <div class="flex"><span class="n grow">${esc(a.name)}</span>${a.cur === 'INR' ? '<span class="badge inr">INR</span>' : ''}</div>
        <div class="b num amt ${bal[a.id] < 0 ? 'c-out' : ''}">${money(bal[a.id], a.cur, { short: true })}</div>
      </button>`).join('')}
    </div>
  </div>
  ${cats.length ? `<div class="section">
    <div class="section-head"><h2>Where it went · ${mon}</h2><button data-a="go" data-v="reports">Reports</button></div>
    <div class="card">${cats.map(([cid, v]) => { const c = catOf(cid); return `<button class="legend-row" style="width:100%;text-align:left" data-a="goAct" data-cat="${cid}" data-month="${ym}" data-type="expense">
      <span style="font-size:20px">${c?.icon || '🏷️'}</span><div class="grow"><div class="flex"><b class="grow">${esc(c?.name || 'Other')}</b><b class="num">${money(v)}</b></div><div class="bar"><i style="width:${Math.max(3, v / maxCat * 100)}%"></i></div></div></button>`; }).join('')}</div>
  </div>` : ''}
  <div class="section">
    <div class="section-head"><h2>Recent</h2><button data-a="tab" data-tab="activity">See all</button></div>
    <div class="list ${ui.hide ? 'blur-amt' : ''}">${recent.map(t => txnRow(t)).join('') || '<div class="empty">Tap + to add your first entry</div>'}</div>
  </div>
  </div>`;
}

function filteredTxns() {
  const f = ui.act;
  const q = f.q.trim().toLowerCase();
  const typeGroups = { expense: ['expense'], income: ['income'], transfer: ['transfer', 'adjust'], loans: ['lend', 'collect', 'borrow', 'repay', 'person_adjust'], kuri: ['kuri_pay', 'kuri_get'], invest: ['invest', 'asset_in'] };
  return sorted(D().txns.filter(t => {
    if (f.type !== 'all' && !typeGroups[f.type].includes(t.type)) return false;
    if (f.month && !t.date.startsWith(f.month)) return false;
    if (f.acc && t.acc !== f.acc && t.to !== f.acc) return false;
    if (f.cat && t.cat !== f.cat) return false;
    if (f.person && t.person !== f.person) return false;
    if (f.project && t.project !== f.project) return false;
    if (q) {
      const hay = [t.note, t.sub, catOf(t.cat)?.name, personOf(t.person)?.name, acc(t.acc)?.name, acc(t.to)?.name, kuriOf(t.kuri)?.name, assetOf(t.asset)?.name, String(t.amt)].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }));
}

function viewActivity() {
  const f = ui.act;
  const list = filteredTxns();
  const inn = zero(), out = zero();
  for (const t of list) { if (t.type === 'income') inn[t.cur] += t.amt; if (t.type === 'expense') out[t.cur] += t.amt; }
  const types = [['all', 'All'], ['expense', 'Expenses'], ['income', 'Income'], ['transfer', 'Transfers'], ['loans', 'Loans'], ['kuri', 'Kuri'], ['invest', 'Investments']];
  const active = [
    f.month && `<button class="chip on" data-a="clearF" data-k="month">${fmtMonth(f.month)} ✕</button>`,
    f.acc && `<button class="chip on" data-a="clearF" data-k="acc">${esc(acc(f.acc)?.name)} ✕</button>`,
    f.cat && `<button class="chip on" data-a="clearF" data-k="cat">${esc(catOf(f.cat)?.name)} ✕</button>`,
    f.person && `<button class="chip on" data-a="clearF" data-k="person">${esc(personOf(f.person)?.name)} ✕</button>`,
    f.project && `<button class="chip on" data-a="clearF" data-k="project">${esc(projectOf(f.project)?.name)} ✕</button>`,
  ].filter(Boolean).join('');
  return `<div class="screen">
    ${topbar('Activity', { right: `<button class="icon-btn" data-a="filterSheet">${icon('sliders')}</button>` })}
    <label class="search">${icon('search')}<input id="actq" placeholder="Search notes, names, categories…" value="${esc(f.q)}" data-in="actq"></label>
    <div class="sp"></div>
    <div class="chips">${types.map(([k, l]) => `<button class="chip ${f.type === k ? 'on' : ''}" data-a="actType" data-k="${k}">${l}</button>`).join('')}</div>
    ${active ? `<div class="chips">${active}</div>` : ''}
    <div class="tiles" style="margin-top:8px">
      <div class="tile"><div class="k">Money out</div><div class="v">${dual(out, { cls: 'c-out' })}</div></div>
      <div class="tile"><div class="k">Money in</div><div class="v">${dual(inn, { cls: 'c-in' })}</div></div>
    </div>
    <div class="small muted" style="margin:10px 4px 0">${list.length} entries</div>
    ${groupedTxns(list.slice(0, f.limit))}
    ${list.length > f.limit ? `<div class="sp"></div><button class="btn ghost block" data-a="more">Show more</button>` : ''}
  </div>`;
}

function viewPeople() {
  const pb = peopleBalances();
  const f = ui.people;
  const owed = zero(), owe = zero();
  const rows = D().people.filter(p => !p.hidden).map(p => {
    const e = pb.get(p.id) || zero();
    for (const c of CURS) { const x = e[c] || 0; if (x > 0) owed[c] += x; else owe[c] -= x; }
    return { p, e, v: personAED(e) };
  });
  const q = f.q.trim().toLowerCase();
  const show = rows.filter(r => {
    if (q && !r.p.name.toLowerCase().includes(q)) return false;
    if (f.filter === 'owed') return r.v > 0.5;
    if (f.filter === 'owe') return r.v < -0.5;
    if (f.filter === 'settled') return Math.abs(r.v) <= 0.5;
    return true;
  }).sort((a, b) => f.filter === 'owe' ? a.v - b.v : f.filter === 'settled' || f.filter === 'all' ? a.p.name.localeCompare(b.p.name) : b.v - a.v);

  const balText = (e) => {
    const parts = [];
    if (Math.abs(e.AED) > 0.004) parts.push(money(Math.abs(e.AED), 'AED'));
    if (Math.abs(e.INR) > 0.004) parts.push(money(Math.abs(e.INR), 'INR'));
    return parts.join(' + ') || 'Settled';
  };
  return `<div class="screen">
    ${topbar('People', { sub: 'Money you lent & borrowed', right: `<button class="icon-btn" data-a="newPerson">${icon('plus')}</button>` })}
    <div class="tiles">
      <button class="tile" data-a="pf" data-k="owed"><div class="k"><span class="dot" style="background:var(--lend)"></span>They owe you</div><div class="v">${dual(owed, { cls: 'c-lend' })}</div></button>
      <button class="tile" data-a="pf" data-k="owe"><div class="k"><span class="dot" style="background:var(--borrow)"></span>You owe</div><div class="v">${dual(owe, { cls: 'c-borrow' })}</div></button>
    </div>
    <div class="sp"></div>
    <div class="seg">${[['owed', 'Owe you'], ['owe', 'You owe'], ['settled', 'Settled'], ['all', 'All']].map(([k, l]) => `<button class="${f.filter === k ? 'on' : ''}" data-a="pf" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="sp"></div>
    <label class="search">${icon('search')}<input placeholder="Search people" value="${esc(f.q)}" data-in="pq"></label>
    <div class="sp"></div>
    <div class="list">${show.map(r => `<button class="row tap" data-a="go" data-v="person" data-id="${r.p.id}">
      <div class="ic ${r.v > 0.5 ? 'bg-lend' : r.v < -0.5 ? 'bg-borrow' : ''}"><b style="font-size:14px">${esc(initials(r.p.name))}</b></div>
      <div class="mid"><div class="t">${esc(r.p.name)}</div><div class="d">${r.v > 0.5 ? 'Owes you' : r.v < -0.5 ? 'You owe' : 'All settled'}</div></div>
      <div class="amt num ${r.v > 0.5 ? 'c-lend' : r.v < -0.5 ? 'c-borrow' : 'muted'}">${balText(r.e)}</div>
    </button>`).join('') || `<div class="empty"><span class="big">🤝</span>Nobody here</div>`}</div>
  </div>`;
}

function viewWealth() {
  const nw = netWorth();
  const bal = accountBalances();
  const groups = [['bank', 'Bank accounts'], ['cash', 'Cash & wallets'], ['card', 'Credit cards']];
  const ns = { nosym: true };
  const row = (label, k, cls = '', neg = false) => `<div class="kv3"><span>${label}</span><span class="num ${cls}">${money(neg ? -nw.AED[k] : nw.AED[k], 'AED', ns)}</span><span class="num ${cls}">${money(neg ? -nw.INR[k] : nw.INR[k], 'INR', ns)}</span></div>`;
  return `<div class="screen">
    ${topbar('Wealth', { sub: 'What you own and owe', right: `<button class="icon-btn" data-a="go" data-v="settings">${icon('settings')}</button>` })}
    <div class="card">
      <div class="kv3 head"><span></span><span>AED</span><span>INR</span></div>
      ${row('Bank & cash', 'cash')}
      ${row('Credit cards', 'cards', 'c-out')}
      ${row('Owed to you', 'owed', 'c-lend')}
      ${row('You owe', 'owe', 'c-borrow', true)}
      ${row('Investments & property', 'assets', 'c-invest')}
      <div class="kv3 total"><span>Net worth</span><span class="num">${money(nw.AED.total, 'AED', ns)}</span><span class="num">${money(nw.INR.total, 'INR', ns)}</span></div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Accounts</h2><button data-a="editAccount">+ Add</button></div>
      ${groups.map(([k, l]) => {
        const list = D().accounts.filter(a => a.kind === k && !a.closed);
        if (!list.length) return '';
        return `<div class="lbl" style="margin-top:12px">${l}</div><div class="list">${list.map(a => accountRow(a, bal)).join('')}</div>`;
      }).join('')}
      ${D().accounts.some(a => a.closed) ? `<div class="sp"></div><button class="btn ghost block" data-a="go" data-v="accounts">Closed accounts</button>` : ''}
    </div>
    <div class="section">
      <div class="section-head"><h2>Investments & property</h2><button data-a="editAsset">+ Add</button></div>
      <div class="list">${D().assets.map(s => { const x = assetSummary(s.id); const anyVal = CURS.some(c => x.hasValue[c]); return `<button class="row tap" data-a="go" data-v="asset" data-id="${s.id}">
        <div class="ic bg-invest">${assetIcon(s)}</div>
        <div class="mid"><div class="t">${esc(s.name)}</div><div class="d">${anyVal ? 'Current value' : 'Amount invested'}</div></div>
        <div class="amt c-invest">${dual(x.value, { short: true })}</div></button>`; }).join('') || '<div class="empty">No investments yet</div>'}</div>
    </div>
  </div>`;
}

function accountRow(a, bal) {
  const b = bal[a.id];
  return `<button class="row tap" data-a="go" data-v="account" data-id="${a.id}">
    <div class="ic">${icon(a.kind === 'card' ? 'card' : a.kind === 'cash' ? 'cash' : 'bank')}</div>
    <div class="mid"><div class="t">${esc(a.name)}</div><div class="d">${a.kind === 'card' ? (b < -0.01 ? 'Outstanding' : 'Paid up') : a.cur}${a.closed ? ' · closed' : ''}</div></div>
    <div class="amt num ${b < -0.01 ? 'c-out' : ''}">${money(b, a.cur)}</div></button>`;
}
function kuriRow(k) {
  const s = kuriSummary(k.id);
  return `<button class="row tap" data-a="go" data-v="kuri" data-id="${k.id}">
    <div class="ic bg-kuri">🪙</div>
    <div class="mid"><div class="t">${esc(k.name)}</div><div class="d">${s.count} instalment${s.count === 1 ? '' : 's'} paid${k.months ? ` of ${k.months}` : ''}${isZero(s.got) ? '' : ` · received ${multi(s.got)}`}</div></div>
    <div class="amt c-kuri">${dual(s.paid)}<small>paid in</small></div></button>`;
}

// ---------- Detail pages
function viewAccounts() {
  const bal = accountBalances();
  const closed = D().accounts.filter(a => a.closed);
  return `<div class="screen">${topbar('Accounts', { back: true, right: `<button class="icon-btn" data-a="editAccount">${icon('plus')}</button>` })}
    <div class="list">${D().accounts.filter(a => !a.closed).map(a => accountRow(a, bal)).join('')}</div>
    ${closed.length ? `<div class="lbl" style="margin-top:18px">Closed</div><div class="list">${closed.map(a => accountRow(a, bal)).join('')}</div>` : ''}
  </div>`;
}

function viewAccount(id) {
  const a = acc(id);
  if (!a) return viewAccounts();
  const bal = accountBalances()[id];
  const list = sorted(D().txns.filter(t => t.acc === id || t.to === id));
  let run = bal; const runMap = new Map();
  for (const t of list) { runMap.set(t.id, run); run -= effectOn(t, id); }
  const lim = ui.wealth.accLimit || 150;
  return `<div class="screen">${topbar(a.name, { back: true, right: `<button class="icon-btn" data-a="editAccount" data-id="${id}">${icon('edit')}</button>` })}
    <div class="detail-hero">
      <div class="ic-big">${icon(a.kind === 'card' ? 'card' : a.kind === 'cash' ? 'cash' : 'bank')}</div>
      <div class="big num ${bal < 0 ? 'c-out' : ''}">${money(bal, a.cur)}</div>
      <div class="cap">${{ bank: 'Bank account', cash: 'Cash', card: 'Credit card' }[a.kind]} · ${a.cur}${a.closed ? ' · closed' : ''}</div>
    </div>
    <div class="actions">
      <button data-a="newTxn" data-type="expense" data-acc="${id}"><span class="ai bg-out">${icon('out')}</span>Spend</button>
      <button data-a="newTxn" data-type="income" data-acc="${id}"><span class="ai bg-in">${icon('in')}</span>Receive</button>
      <button data-a="newTxn" data-type="transfer" data-acc="${id}"><span class="ai bg-move">${icon('swap')}</span>Transfer</button>
      <button data-a="adjustBal" data-id="${id}"><span class="ai bg-move">${icon('sliders')}</span>Fix balance</button>
    </div>
    <div class="section">${groupedTxns(list.slice(0, lim), { inAccount: id, extra: (t) => money(runMap.get(t.id), a.cur) })}</div>
    ${list.length > lim ? `<div class="sp"></div><button class="btn ghost block" data-a="moreAcc">Show more</button>` : ''}
  </div>`;
}

function viewPerson(id) {
  const p = personOf(id);
  if (!p) return viewPeople();
  const e = peopleBalances().get(id) || zero();
  const v = personAED(e);
  const books = personLoans(id);
  const pendG = books.given.filter(l => l.pending > 0.004).reverse();
  const pendB = books.borrowed.filter(l => l.pending > 0.004).reverse();
  const doneN = books.given.length + books.borrowed.length - pendG.length - pendB.length;
  const showAll = ui.personAll === id;
  const list = sorted(personLedger(id));
  return `<div class="screen">${topbar(p.name, { back: true, right: `<button class="icon-btn" data-a="editPerson" data-id="${id}">${icon('edit')}</button>` })}
    <div class="detail-hero">
      <div class="ic-big ${v > 0.5 ? 'bg-lend' : v < -0.5 ? 'bg-borrow' : ''}"><b style="font-size:22px">${esc(initials(p.name))}</b></div>
      <div class="big num ${v > 0.5 ? 'c-lend' : v < -0.5 ? 'c-borrow' : ''}">${isZero(e) ? 'Settled' : multi(e, { abs: true, sep: ' + ' })}</div>
      <div class="cap">${v > 0.5 ? `${esc(p.name)} owes you` : v < -0.5 ? `You owe ${esc(p.name)}` : 'Nothing pending'}${p.phone ? ' · ' + esc(p.phone) : ''}</div>
    </div>
    <div class="actions">
      <button data-a="newTxn" data-type="lend" data-person="${id}"><span class="ai bg-lend">${icon('out')}</span>Gave</button>
      <button data-a="newTxn" data-type="collect" data-person="${id}"><span class="ai bg-in">${icon('in')}</span>Got back</button>
      <button data-a="newTxn" data-type="${v < -0.5 ? 'waived' : 'waive'}" data-person="${id}"><span class="ai bg-kuri">%</span>Discount</button>
      <button data-a="newTxn" data-type="borrow" data-person="${id}"><span class="ai bg-borrow">${icon('in')}</span>Borrowed</button>
      <button data-a="newTxn" data-type="repay" data-person="${id}"><span class="ai bg-borrow">${icon('out')}</span>Repaid</button>
    </div>
    ${!isZero(e) ? `<button class="btn primary block" style="margin-top:12px" data-a="sharePerson" data-id="${id}">${icon('share')} Send statement to ${esc(p.name)}</button>` : ''}
    ${pendG.length ? `<div class="section"><div class="section-head"><h2>Pending – ${esc(p.name)} has to give</h2></div>${pendG.map(l => loanCard(l, 'given')).join('')}</div>` : ''}
    ${pendB.length ? `<div class="section"><div class="section-head"><h2>Pending – you have to give</h2></div>${pendB.map(l => loanCard(l, 'borrowed')).join('')}</div>` : ''}
    ${books.givenExtra?.length || books.borrowedExtra?.length ? `<p class="small muted" style="margin:10px 4px">Some repayments were more than the loans recorded; the extra is counted in the balance above.</p>` : ''}
    <div class="section"><div class="section-head"><h2>${showAll ? 'All entries' : `Settled loans${doneN ? ` (${doneN})` : ''}`}</h2><button data-a="personAll" data-id="${id}">${showAll ? 'Show loans' : 'All entries'}</button></div>
      ${showAll ? groupedTxns(list, { inPerson: id }) : [...books.given, ...books.borrowed].filter(l => l.pending <= 0.004).sort((a, b) => b.t.date.localeCompare(a.t.date)).map(l => loanCard(l, books.given.includes(l) ? 'given' : 'borrowed')).join('') || '<div class="list"><div class="empty">No settled loans yet</div></div>'}
    </div>
  </div>`;
}

function viewKuris() {
  const tot = kuriTotals();
  return `<div class="screen">${topbar('Kuri', { back: true, right: `<button class="icon-btn" data-a="editKuri">${icon('plus')}</button>` })}
    <div class="card"><div class="kv"><span>Paid in, not yet received</span><span class="num c-kuri">${multi(tot)}</span></div></div>
    <div class="lbl" style="margin-top:18px">Active</div><div class="list">${D().kuris.filter(k => k.status !== 'closed').map(kuriRow).join('') || '<div class="empty">None</div>'}</div>
    <div class="lbl" style="margin-top:18px">Closed</div><div class="list">${D().kuris.filter(k => k.status === 'closed').map(kuriRow).join('') || '<div class="empty">None</div>'}</div>
  </div>`;
}

function viewKuri(id) {
  const k = kuriOf(id);
  if (!k) return viewKuris();
  const s = kuriSummary(id);
  const left = k.months ? Math.max(0, k.months - s.count) : null;
  return `<div class="screen">${topbar(k.name, { back: true, sub: 'Kuri', right: `<button class="icon-btn" data-a="editKuri" data-id="${id}">${icon('edit')}</button>` })}
    <div class="detail-hero"><div class="ic-big bg-kuri">🪙</div>
      <div class="big c-kuri">${dual(s.paid)}</div><div class="cap">paid in over ${s.count} instalment${s.count === 1 ? '' : 's'}</div></div>
    <div class="actions">
      <button data-a="newTxn" data-type="kuri_pay" data-kuri="${id}"><span class="ai bg-kuri">${icon('out')}</span>Pay instalment</button>
      <button data-a="newTxn" data-type="kuri_get" data-kuri="${id}"><span class="ai bg-in">${icon('in')}</span>Got payout</button>
    </div>
    <div class="section card">
      ${k.instalment ? `<div class="kv"><span>Instalment</span><span class="num">${money(k.instalment, k.cur)}</span></div>` : ''}
      ${k.months ? `<div class="kv"><span>Instalments left</span><span class="num">${left} of ${k.months}</span></div>` : ''}
      ${k.total ? `<div class="kv"><span>Kuri value</span><span class="num">${money(k.total, k.cur)}</span></div>` : ''}
      <div class="kv"><span>Received</span><span class="num c-in">${multi(s.got)}</span></div>
      <div class="kv"><span>Paid in minus received</span><span class="num">${multi(s.net)}</span></div>
    </div>
    <div class="section">${groupedTxns(sorted(s.list))}</div>
  </div>`;
}

function viewAsset(id) {
  const a = assetOf(id);
  if (!a) return viewWealth();
  const s = assetSummary(id);
  const anyVal = CURS.some(c => s.hasValue[c]);
  return `<div class="screen">${topbar(a.name, { back: true, sub: 'Investment', right: `<button class="icon-btn" data-a="editAsset" data-id="${id}">${icon('edit')}</button>` })}
    <div class="detail-hero"><div class="ic-big bg-invest">${assetIcon(a)}</div>
      <div class="big c-invest">${dual(s.value)}</div><div class="cap">${anyVal ? 'current value' : 'invested · tap “Update value” to track gain'}</div></div>
    <div class="actions">
      <button data-a="newTxn" data-type="invest" data-asset="${id}"><span class="ai bg-invest">${icon('out')}</span>Invest more</button>
      <button data-a="newTxn" data-type="asset_in" data-asset="${id}"><span class="ai bg-in">${icon('in')}</span>Got return</button>
      <button data-a="setValue" data-id="${id}"><span class="ai bg-move">${icon('trend')}</span>Update value</button>
    </div>
    <div class="section card">
      <div class="kv"><span>Total invested</span><span class="num">${multi(s.invested)}</span></div>
      <div class="kv"><span>Returns / withdrawn</span><span class="num c-in">${multi(s.returned)}</span></div>
      <div class="kv"><span>Net invested</span><span class="num">${multi(s.net)}</span></div>
      ${anyVal ? `<div class="kv"><span>Gain</span><span class="num">${multi(s.gain, { plus: true })}</span></div>` : ''}
      ${a.note ? `<div class="small muted" style="padding-top:8px">${esc(a.note)}</div>` : ''}
    </div>
    <div class="section">${groupedTxns(sorted(s.list))}</div>
  </div>`;
}

function viewReports() {
  const r = ui.report;
  r.cur ||= 'AED';
  const C = r.cur;
  const isMonth = r.mode === 'month';
  const period = isMonth ? r.ym : r.y;
  const tot = periodTotals(period)[C];
  const months = [];
  if (isMonth) { for (let i = 11; i >= 0; i--) months.push(addMonths(r.ym + '-01', -i, 1).slice(0, 7)); }
  else for (let i = 1; i <= 12; i++) months.push(`${r.y}-${String(i).padStart(2, '0')}`);
  const series = months.map(ym => ({ ym, ...periodTotals(ym)[C] }));
  const max = Math.max(1, ...series.map(s => Math.max(s.spent, s.earned)));
  const W = 340, H = 150, bw = W / 12;
  const bars = series.map((s, i) => {
    const x = i * bw;
    const hs = s.spent / max * (H - 22), he = s.earned / max * (H - 22);
    const sel = s.ym === r.ym && isMonth;
    return `<g data-a="repMonth" data-ym="${s.ym}" style="cursor:pointer"><rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent"/>
      <rect x="${x + bw * 0.16}" y="${H - 16 - he}" width="${bw * 0.32}" height="${Math.max(he, 1)}" rx="3" fill="var(--in)" opacity="${sel || !isMonth ? 1 : .45}"/>
      <rect x="${x + bw * 0.52}" y="${H - 16 - hs}" width="${bw * 0.32}" height="${Math.max(hs, 1)}" rx="3" fill="var(--out)" opacity="${sel || !isMonth ? 1 : .45}"/>
      <text x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" ${sel ? 'style="fill:var(--ink)"' : ''}>${MONTH_NAMES[+s.ym.slice(5) - 1][0]}</text></g>`;
  }).join('');
  const cats = [...tot.byCat.entries()].sort((a, b) => b[1] - a[1]);
  const incs = [...tot.incCat.entries()].sort((a, b) => b[1] - a[1]);
  const catRows = (arr, total, type) => arr.map(([cid, v]) => { const c = catOf(cid); return `<button class="legend-row" style="width:100%;text-align:left" data-a="goAct" data-cat="${cid}" data-type="${type}" data-month="${isMonth ? period : ''}">
    <span style="font-size:20px;width:26px;text-align:center">${c?.icon || '🏷️'}</span><div class="grow"><div class="flex"><b class="grow">${esc(c?.name || 'Other')}</b><span class="small muted">${Math.round(v / total * 100)}%</span><b class="num" style="min-width:90px;text-align:right">${money(v, C)}</b></div>
    <div class="bar"><i style="width:${Math.max(2, v / arr[0][1] * 100)}%;background:${type === 'income' ? 'var(--in)' : 'var(--brand)'}"></i></div></div></button>`; }).join('');

  return `<div class="screen">${topbar('Reports', { back: true })}
    <div class="row2"><div class="seg"><button class="${isMonth ? 'on' : ''}" data-a="repMode" data-k="month">Month</button><button class="${!isMonth ? 'on' : ''}" data-a="repMode" data-k="year">Year</button></div>
    <div class="seg">${CURS.map(c => `<button class="${C === c ? 'on' : ''}" data-a="repCur" data-k="${c}">${c}</button>`).join('')}</div></div>
    <div class="flex" style="margin:14px 0 6px">
      <button class="icon-btn" data-a="repNav" data-d="-1">${icon('back')}</button>
      <div class="grow" style="text-align:center;font-weight:800;font-size:17px">${isMonth ? fmtMonth(period) : period}</div>
      <button class="icon-btn" data-a="repNav" data-d="1" style="transform:scaleX(-1)">${icon('back')}</button>
    </div>
    <div class="tiles" style="grid-template-columns:repeat(3,1fr)">
      <div class="tile"><div class="k">Earned</div><div class="v num c-in" style="font-size:15px">${money(tot.earned, C, { short: true })}</div></div>
      <div class="tile"><div class="k">Spent</div><div class="v num c-out" style="font-size:15px">${money(tot.spent, C, { short: true })}</div></div>
      <div class="tile"><div class="k">Saved</div><div class="v num" style="font-size:15px">${money(tot.earned - tot.spent, C, { short: true })}</div></div>
    </div>
    <div class="section card">
      <div class="flex small" style="margin-bottom:8px;font-weight:700"><span class="dot" style="background:var(--in)"></span>Earned <span class="dot" style="background:var(--out);margin-left:8px"></span>Spent <span class="grow"></span><span class="muted">Tap a month</span></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}">${bars}</svg>
    </div>
    <div class="section"><div class="section-head"><h2>Spending by category</h2></div>
      <div class="card">${catRows(cats, tot.spent || 1, 'expense') || '<div class="empty">No spending</div>'}</div></div>
    <div class="section"><div class="section-head"><h2>Income by source</h2></div>
      <div class="card">${catRows(incs, tot.earned || 1, 'income') || '<div class="empty">No income</div>'}</div></div>
  </div>`;
}

function viewSettings() {
  const s = D().settings;
  const drive = s.drive || {};
  const bio = isNative() && window.KanakkuNative.bioAvailable?.();
  return `<div class="screen">${topbar('Settings', { back: true })}
    <div class="lbl">Currency</div>
    <div class="list">
      <button class="row tap" data-a="editRate"><div class="ic">₹</div><div class="mid"><div class="t">AED → INR rate</div><div class="d">1 AED = ₹${rate()} · only used to suggest amounts in transfers</div></div>${icon('chevron', 'chev')}</button>
    </div>
    <div class="lbl" style="margin-top:18px">Backup</div>
    <div class="list">
      <button class="row tap" data-a="backup"><div class="ic bg-in">${icon('download')}</div><div class="mid"><div class="t">Save backup now</div><div class="d" id="lastBackup">Saves a file to Downloads/Kanakku</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="driveShare"><div class="ic">☁️</div><div class="mid"><div class="t">Back up to Google Drive</div><div class="d">Save and share to Drive in one tap</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="driveMode"><div class="ic">🔄</div><div class="mid"><div class="t">Monthly Drive backup</div><div class="d">${{ off: 'Off', remind: 'Remind me each month (one tap)', auto: `Automatic${drive.account ? ' · ' + esc(drive.account) : ''}` }[drive.mode || 'off']}${drive.last ? ` · last ${fmtDate(drive.last.slice(0, 10), true)}` : ''}</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="restore"><div class="ic">${icon('upload')}</div><div class="mid"><div class="t">Restore backup</div><div class="d">Replace everything with a Kanakku backup file</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="importVyapar"><div class="ic">📥</div><div class="mid"><div class="t">Import from Vyapar</div><div class="d">Replace everything with a Vyapar .vyb backup</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="exportCsv"><div class="ic">${icon('list')}</div><div class="mid"><div class="t">Export to Excel (CSV)</div><div class="d">All entries as a spreadsheet</div></div>${icon('chevron', 'chev')}</button>
    </div>
    <div class="lbl" style="margin-top:18px">Organise</div>
    <div class="list">
      <button class="row tap" data-a="go" data-v="categories"><div class="ic">${icon('tag')}</div><div class="mid"><div class="t">Categories</div><div class="d">Rename, merge, change icons</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="go" data-v="accounts"><div class="ic">${icon('bank')}</div><div class="mid"><div class="t">Accounts</div><div class="d">Add, edit, close accounts</div></div>${icon('chevron', 'chev')}</button>
    </div>
    <div class="lbl" style="margin-top:18px">Privacy & look</div>
    <div class="list">
      <button class="row tap" data-a="setPin"><div class="ic">${icon('lock')}</div><div class="mid"><div class="t">App lock</div><div class="d">${s.pinHash ? 'On · tap to turn off' : 'Off · protect with a 4-digit PIN'}</div></div>${icon('chevron', 'chev')}</button>
      ${bio ? `<button class="row tap" data-a="toggleBio"><div class="ic">👆</div><div class="mid"><div class="t">Unlock with fingerprint</div><div class="d">${s.bio ? 'On' : s.pinHash ? 'Off' : 'Turn on App lock first'}</div></div><span class="switch ${s.bio ? 'on' : ''}"></span></button>` : ''}
      <button class="row tap" data-a="theme"><div class="ic">🌓</div><div class="mid"><div class="t">Theme</div><div class="d">${{ auto: 'Follow phone', light: 'Light', dark: 'Dark' }[s.theme || 'auto']}</div></div>${icon('chevron', 'chev')}</button>
    </div>
    <div class="sp"></div><div class="sp"></div>
    <button class="btn danger block" data-a="wipe">Delete all data</button>
    <p class="small muted" style="text-align:center;margin-top:16px">Kanakku ${isNative() ? esc(window.KanakkuNative.version()) : 'web'} · works offline · your data stays on this phone${drive.mode === 'auto' ? ' and your own Google Drive' : ''}</p>
  </div>`;
}

function viewCategories() {
  const counts = new Map();
  for (const t of D().txns) if (t.cat) counts.set(t.cat, (counts.get(t.cat) || 0) + 1);
  const sec = (kind, label) => `<div class="section-head" style="margin-top:18px"><h2>${label}</h2><button data-a="editCat" data-kind="${kind}">+ Add</button></div>
    <div class="list">${D().categories.filter(c => c.kind === kind).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)).map(c => `<button class="row tap" data-a="editCat" data-id="${c.id}">
      <div class="ic">${c.icon || '🏷️'}</div><div class="mid"><div class="t">${esc(c.name)}</div><div class="d">${counts.get(c.id) || 0} entries</div></div>${icon('chevron', 'chev')}</button>`).join('')}</div>`;
  return `<div class="screen">${topbar('Categories', { back: true })}${sec('expense', 'Expense')}${sec('income', 'Income')}</div>`;
}

const VIEWS = { accounts: viewAccounts, account: viewAccount, person: viewPerson, kuris: viewKuris, kuri: viewKuri, asset: viewAsset, reports: viewReports, settings: viewSettings, categories: viewCategories, recurring: viewRecurring, projects: viewProjects, project: viewProject, zakat: viewZakat };
const TABS = { home: viewHome, activity: viewActivity, people: viewPeople, wealth: viewWealth };

function nav() {
  const b = (tab, ic, label) => `<button class="${ui.tab === tab && !ui.stack.length ? 'on' : ''}" data-a="tab" data-tab="${tab}">${icon(ic)}<span>${label}</span></button>`;
  return `<nav class="nav"><div class="nav-inner">${b('home', 'home', 'Home')}${b('activity', 'list', 'Activity')}<div><button class="fab" data-a="newTxn" aria-label="Add">${icon('plus')}</button></div>${b('people', 'users', 'People')}${b('wealth', 'wallet', 'Wealth')}</div></nav>`;
}

let lastScrollKey = '';
function render() {
  if (!D()) return;
  const top = ui.stack[ui.stack.length - 1];
  const key = top ? top.v + (top.id || '') : 'tab:' + ui.tab;
  const y = window.scrollY;
  const html = top ? VIEWS[top.v](top.id) : TABS[ui.tab]();
  app.innerHTML = html + nav();
  if (key === lastScrollKey) window.scrollTo(0, y); else window.scrollTo(0, top?.scroll || 0);
  lastScrollKey = key;
  if (top?.v === 'settings') store.getMeta('lastBackup').then(d => { const el = document.getElementById('lastBackup'); if (el && d) el.textContent = `Last saved ${fmtDate(d.slice(0, 10), true)}`; });
}

// ======================================================================
// Sheets (bottom modals)
// ======================================================================
function openSheet(sheet) { ui.sheets.push(sheet); renderSheets(); }
function closeSheet() { ui.sheets.pop(); renderSheets(); }
function closeAllSheets() { ui.sheets = []; renderSheets(); }
function renderSheets() {
  if (!ui.sheets.length) { layer.innerHTML = ''; document.body.style.overflow = ''; return; }
  document.body.style.overflow = 'hidden';
  const top = ui.sheets[ui.sheets.length - 1];
  const body = top.render();
  layer.innerHTML = `<div class="scrim" data-a="closeSheet"></div><div class="sheet ${top.full ? 'full' : ''}">
    ${top.full ? '' : '<div class="grab"></div>'}
    <div class="sheet-head">${top.full ? `<button class="icon-btn plain" data-a="closeSheet">${icon('x')}</button>` : ''}<h3>${esc(typeof top.title === 'function' ? top.title() : top.title)}</h3>${top.headRight ? top.headRight() : top.full ? '' : `<button class="icon-btn plain" data-a="closeSheet">${icon('x')}</button>`}</div>
    <div class="sheet-body">${body}</div>
    ${top.foot ? `<div class="sheet-foot">${top.foot()}</div>` : ''}
  </div>`;
  top.after?.(layer);
}
const refreshSheet = () => { const sb = layer.querySelector('.sheet-body'); const st = sb?.scrollTop; renderSheets(); const nb = layer.querySelector('.sheet-body'); if (nb && st) nb.scrollTop = st; };

function confirmSheet(title, text, okLabel, fn, danger = true) {
  openSheet({
    title, render: () => `<p style="margin:4px 2px 8px;color:var(--ink-2)">${text}</p>`,
    foot: () => `<button class="btn ghost" data-a="closeSheet">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" style="flex:1" data-a="sheetOk">${esc(okLabel)}</button>`,
    ok: () => { closeSheet(); fn(); },
  });
}

// ---------- Transaction form
const FORM_TABS = [
  ['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer'], ['loan', 'Loan'], ['kuri', 'Kuri'], ['invest', 'Invest'],
];
const GROUP_OF = { expense: 'expense', income: 'income', transfer: 'transfer', adjust: 'transfer', lend: 'loan', collect: 'loan', borrow: 'loan', repay: 'loan', waive: 'loan', waived: 'loan', person_adjust: 'loan', kuri_pay: 'kuri', kuri_get: 'kuri', invest: 'invest', asset_in: 'invest' };
const SUBTYPES = {
  loan: [['lend', 'I gave'], ['collect', 'Got back'], ['waive', 'Discount'], ['borrow', 'I borrowed'], ['repay', 'I repaid'], ['waived', 'They let go']],
  kuri: [['kuri_pay', 'Paid instalment'], ['kuri_get', 'Got payout']],
  invest: [['invest', 'Invested'], ['asset_in', 'Got back / return']],
};

let lastAccount = null;
function defaultAccountFor(cur) {
  const d = defaultAccount();
  if (acc(d)?.cur === cur) return d;
  return D().accounts.find(a => !a.closed && a.cur === cur && a.kind !== 'card')?.id || d;
}
function defaultAccount() {
  if (lastAccount && acc(lastAccount) && !acc(lastAccount).closed) return lastAccount;
  const recent = sorted(D().txns).find(t => t.acc && acc(t.acc) && !acc(t.acc).closed);
  return recent?.acc || D().accounts[0]?.id;
}

function txnForm(init = {}) {
  const editing = init.id ? D().txns.find(t => t.id === init.id) : null;
  const f = editing ? { ...editing } : {
    type: 'expense', date: todayISO(), acc: defaultAccount(), ...init,
  };
  f.amtStr = f.amt != null ? String(f.amt) : '';
  f.amt2Str = f.amt2 != null ? String(f.amt2) : '';
  if (f.type === 'transfer' && !f.to) f.to = D().accounts.find(a => a.id !== f.acc && !a.closed)?.id;
  if (f.type === 'expense' || f.type === 'income') f.cat ||= null;
  const sheet = {
    full: true, f, editing,
    title: () => editing ? 'Edit entry' : 'New entry',
    headRight: () => editing ? `<button class="icon-btn plain" data-a="delTxn">${icon('trash')}</button>` : '',
    render: () => formBody(f, editing),
    foot: () => `<button class="btn primary" data-a="saveTxn">${icon('check')} ${editing ? 'Save changes' : 'Save'}</button>`,
    after: (root) => {
      const inp = root.querySelector('#amt');
      if (inp && !editing && !f._focused) { f._focused = true; setTimeout(() => inp.focus(), 60); }
    },
  };
  openSheet(sheet);
}

function curOf(f) {
  if (['lend', 'collect', 'borrow', 'repay', 'person_adjust'].includes(f.type) && !f.acc) return f.cur || 'AED';
  return acc(f.acc)?.cur || 'AED';
}

function accPicker(f, key, label, opts = {}) {
  const bal = accountBalances();
  const list = D().accounts.filter(a => !a.closed || a.id === f[key]);
  return `<div class="field"><div class="lbl">${label}</div><div class="acc-pick">
    ${opts.none ? `<button class="${!f[key] ? 'on' : ''}" data-a="fset" data-k="${key}" data-v=""><b>No account</b><span>just record</span></button>` : ''}
    ${list.map(a => `<button class="${f[key] === a.id ? 'on' : ''}" data-a="fset" data-k="${key}" data-v="${a.id}"><b>${esc(a.name)}</b><span class="num">${money(bal[a.id], a.cur, { short: true })}</span></button>`).join('')}
  </div></div>`;
}

function catGrid(f) {
  const kind = f.type;
  const counts = new Map();
  const recent = sorted(D().txns).slice(0, 400);
  for (const t of recent) if (t.type === kind && t.cat) counts.set(t.cat, (counts.get(t.cat) || 0) + 1);
  let cats = D().categories.filter(c => c.kind === kind).sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)).slice(0, 11);
  if (f.cat && !cats.some(c => c.id === f.cat)) cats = [catOf(f.cat), ...cats.slice(0, 10)].filter(Boolean);
  const subs = new Map();
  if (f.cat) for (const t of D().txns) if (t.cat === f.cat && t.sub) subs.set(t.sub, (subs.get(t.sub) || 0) + 1);
  const subList = [...subs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0]);
  return `<div class="field"><div class="lbl">Category</div><div class="pick-grid">
    ${cats.map(c => `<button class="pick ${f.cat === c.id ? 'on' : ''}" data-a="fset" data-k="cat" data-v="${c.id}"><span class="e">${c.icon || '🏷️'}</span><span>${esc(c.name)}</span></button>`).join('')}
    <button class="pick" data-a="pickCat"><span class="e">⋯</span><span>More</span></button>
  </div></div>
  ${f.cat ? `<div class="field"><div class="lbl">Detail <span style="text-transform:none;font-weight:600">(optional)</span></div>
    <input class="input" data-in="fsub" value="${esc(f.sub || '')}" placeholder="e.g. Lunch, Petrol, Du bill">
    ${subList.length ? `<div class="chips" style="margin-top:8px">${subList.map(s => `<button class="chip ${f.sub === s ? 'on' : ''}" data-a="fset" data-k="sub" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
  </div>` : ''}`;
}

function entityPicker(f, key, label, list, action, newAction) {
  const sel = list.find(x => x.id === f[key]);
  return `<div class="field"><div class="lbl">${label}</div>
    <button class="input flex" style="text-align:left" data-a="${action}">${sel ? `<b class="grow">${esc(sel.name)}</b>` : `<span class="grow muted">Choose…</span>`}${icon('down', 'chev')}</button>
    ${newAction ? '' : ''}</div>`;
}

function formBody(f, editing) {
  const group = GROUP_OF[f.type] || 'expense';
  const cur = curOf(f);
  const toAcc = acc(f.to);
  const cross = f.type === 'transfer' && toAcc && toAcc.cur !== cur;
  const calc = evalAmount(f.amtStr);
  const showCalc = /[+\-*/]/.test(f.amtStr.replace(/^-/, '')) && Number.isFinite(calc);
  let html = '';
  if (f.type !== 'adjust' && f.type !== 'person_adjust') {
    html += `<div class="type-tabs">${FORM_TABS.map(([k, l]) => `<button class="${group === k ? 'on' : ''}" data-a="fgroup" data-k="${k}">${l}</button>`).join('')}</div>`;
  }
  if (SUBTYPES[group]) html += `<div class="sp"></div><div class="seg ${group === 'loan' ? 'wrap' : ''}">${SUBTYPES[group].map(([k, l]) => `<button class="${f.type === k ? 'on' : ''}" data-a="fset" data-k="type" data-v="${k}">${l}</button>`).join('')}</div>`;

  html += `<div class="sp"></div><div class="amount-box"><span class="cur">${cur === 'INR' ? '₹' : 'AED'}</span>
    <input id="amt" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.amtStr)}" data-in="famt">
    <span class="calc num" id="calc">${showCalc ? '= ' + money(calc, cur) : ''}</span></div>`;

  if (f.type === 'transfer') {
    html += accPicker(f, 'acc', 'From');
    html += accPicker(f, 'to', 'To');
    if (cross) {
      const est = f.amtStr ? (cur === 'AED' ? evalAmount(f.amtStr) * rate() : evalAmount(f.amtStr) / rate()) : '';
      html += `<div class="field"><div class="lbl">Amount received in ${esc(toAcc.name)}</div>
        <div class="amount-box"><span class="cur">${toAcc.cur === 'INR' ? '₹' : 'AED'}</span><input id="amt2" inputmode="decimal" placeholder="${est ? Math.round(est * 100) / 100 : '0'}" value="${esc(f.amt2Str)}" data-in="famt2"></div>
        <div class="fx-note" id="fxnote">${fxNote(f, cur, toAcc.cur)}</div></div>`;
    }
  } else if (f.type === 'adjust') {
    html += accPicker(f, 'acc', 'Account');
    html += `<p class="small muted">A correction changes the balance without counting as income or expense. Use a minus sign to reduce.</p>`;
  } else if (group === 'loan') {
    html += entityPicker(f, 'person', 'Person', D().people, 'pickPerson');
    const isDisc = f.type === 'waive' || f.type === 'waived';
    if (isDisc) html += `<p class="small muted" style="margin:10px 4px 0">${f.type === 'waive' ? 'You let go of this amount – it reduces what they owe you. No money moves and it is not counted as spending.' : 'They let go of this amount – it reduces what you owe them.'}</p>`;
    if (f.type !== 'person_adjust' && !isDisc) html += accPicker(f, 'acc', ['lend', 'repay'].includes(f.type) ? 'Paid from' : 'Received into', { none: true });
    if (['collect', 'waive', 'repay', 'waived'].includes(f.type)) html += loanAgainstPicker(f);
    if (!f.acc) html += `<div class="field"><div class="lbl">Currency</div><div class="seg">${['AED', 'INR'].map(c => `<button class="${(f.cur || 'AED') === c ? 'on' : ''}" data-a="fset" data-k="cur" data-v="${c}">${c}</button>`).join('')}</div></div>`;
  } else if (group === 'kuri') {
    html += entityPicker(f, 'kuri', 'Kuri', D().kuris.filter(k => k.status !== 'closed' || k.id === f.kuri), 'pickKuri');
    html += accPicker(f, 'acc', f.type === 'kuri_pay' ? 'Paid from' : 'Received into');
  } else if (group === 'invest') {
    html += entityPicker(f, 'asset', 'Investment', D().assets, 'pickAsset');
    html += accPicker(f, 'acc', f.type === 'invest' ? 'Paid from' : 'Received into');
  } else {
    html += catGrid(f);
    html += accPicker(f, 'acc', f.type === 'expense' ? 'Paid from' : 'Received into');
    if (f.type === 'expense' && zakatCats().includes(f.cat)) {
      const y0 = +todayISO().slice(0, 4);
      const cur = f.zakatYear || paymentYear({ ...f, date: f.date || todayISO() });
      html += `<div class="field"><div class="lbl">Zakat for year</div><div class="seg">${[y0 - 2, y0 - 1, y0].map(y => `<button class="${String(cur) === String(y) ? 'on' : ''}" data-a="fset" data-k="zakatYear" data-v="${y}">${y}</button>`).join('')}</div></div>`;
    }
    const projs = D().projects.filter(p => p.status !== 'done' || p.id === f.project);
    if (projs.length) html += `<div class="field"><div class="lbl">Project <span style="text-transform:none;font-weight:600">(optional)</span></div><div class="chips">
      <button class="chip ${!f.project ? 'on' : ''}" data-a="fset" data-k="project" data-v="">None</button>
      ${projs.map(p => `<button class="chip ${f.project === p.id ? 'on' : ''}" data-a="fset" data-k="project" data-v="${p.id}">${p.icon || '🏗️'} ${esc(p.name)}</button>`).join('')}</div></div>`;
  }

  html += `<div class="row2"><div class="field"><div class="lbl">Date</div><input type="date" class="input" value="${f.date}" data-in="fdate"></div>
    ${!editing && (f.type === 'expense' || f.type === 'income' || f.type === 'transfer') ? `<div class="field"><div class="lbl">Repeat</div><button class="input flex" data-a="ftoggleRepeat" style="text-align:left"><span class="grow">${f.repeat ? 'Every month' : 'No'}</span>${icon('repeat', 'chev')}</button></div>` : '<div></div>'}</div>`;
  html += `<div class="field"><div class="lbl">Note</div><textarea class="input" rows="2" data-in="fnote" placeholder="Anything to remember">${esc(f.note || '')}</textarea></div>`;
  return html;
}

function fxNote(f, from, to) {
  const a = evalAmount(f.amtStr), b = evalAmount(f.amt2Str);
  if (!(a > 0) || !(b > 0)) return `Enter what actually arrived. Current rate: 1 AED = ₹${rate()}`;
  const r = from === 'AED' ? b / a : a / b;
  return `Your rate: <b>1 AED = ₹${r.toFixed(3)}</b>`;
}

function saveTxn(sheet) {
  const f = sheet.f;
  const amt = evalAmount(f.amtStr);
  if (!Number.isFinite(amt) || amt === 0 || (amt < 0 && !['adjust', 'person_adjust'].includes(f.type))) return toast('Enter an amount');
  const t = {
    id: f.id || newId('t'), type: f.type, date: f.date || todayISO(), amt: Math.round(amt * 100) / 100,
    note: (f.note || '').trim() || undefined, created: f.created || Date.now(),
  };
  const group = GROUP_OF[f.type];
  if (f.type !== 'person_adjust') {
    if (!f.acc && group !== 'loan') return toast('Choose an account');
    t.acc = f.acc || undefined;
  }
  t.cur = curOf(f);
  if (t.cur === 'INR') t.fx = f.fx && editingSameCur(f) ? f.fx : rate();
  if (f.type === 'transfer') {
    if (!f.to || f.to === f.acc) return toast('Choose a different “To” account');
    t.to = f.to;
    const toCur = acc(f.to).cur;
    t.cur2 = toCur;
    if (toCur !== t.cur) {
      let a2 = evalAmount(f.amt2Str);
      if (!(a2 > 0)) a2 = t.cur === 'AED' ? amt * rate() : amt / rate();
      t.amt2 = Math.round(a2 * 100) / 100;
      const r = t.cur === 'AED' ? t.amt2 / t.amt : t.amt / t.amt2;
      t.fx = Math.round(r * 1000) / 1000;
      if (!sheet.editing && evalAmount(f.amt2Str) > 0) D().settings.inrRate = Math.round(r * 100) / 100;
    } else t.amt2 = t.amt;
  }
  if (f.type === 'expense' || f.type === 'income') {
    if (!f.cat) return toast('Pick a category');
    t.cat = f.cat; if (f.sub && f.sub.trim()) t.sub = f.sub.trim();
    if (f.project) t.project = f.project;
    if (f.type === 'expense' && zakatCats().includes(f.cat) && f.zakatYear) t.zakatYear = String(f.zakatYear);
  }
  if (group === 'loan') {
    if (!f.person) return toast('Choose a person');
    t.person = f.person;
    if (f.type === 'waive' || f.type === 'waived') { delete t.acc; delete t.fx; }
    if (!t.acc) t.cur = f.cur || 'AED';
    if (f.against && ['collect', 'waive', 'repay', 'waived'].includes(f.type)) t.against = f.against;
  }
  if (group === 'kuri') { if (!f.kuri) return toast('Choose a kuri'); t.kuri = f.kuri; }
  if (group === 'invest') { if (!f.asset) return toast('Choose an investment'); t.asset = f.asset; if (f.sub) t.sub = f.sub; }
  // keep AED ledger value for imported entries if amount unchanged
  if (sheet.editing && f.cur2 && f.amt2 != null && f.type !== 'transfer' && sheet.editing.amt === t.amt && sheet.editing.acc === t.acc) { t.amt2 = f.amt2; t.cur2 = f.cur2; }

  const list = D().txns;
  const i = list.findIndex(x => x.id === t.id);
  if (i >= 0) list[i] = t; else list.push(t);
  if (f.repeat && !sheet.editing) {
    const day = +t.date.slice(8);
    D().recurring.push({ id: newId('r'), title: t.type === 'transfer' ? `${acc(t.acc)?.name} → ${acc(t.to)?.name}` : (catOf(t.cat)?.name || '') + (t.sub ? ' · ' + t.sub : ''), ...pickTemplate(t), day, next: addMonths(t.date, 1, day), active: true });
  }
  if (f.fromRec) { const r = D().recurring.find(x => x.id === f.fromRec); if (r) r.next = addMonths(r.next, 1, r.day); }
  lastAccount = t.acc || lastAccount;
  store.save();
  closeAllSheets();
  render();
  toast(sheet.editing ? 'Saved' : 'Added');
}
function editingSameCur(f) { return f.id && f.fx; }
function pickTemplate(t) {
  const { type, amt, acc: a, to, cat, sub, note, amt2, cur, cur2 } = t;
  return { type, amt, acc: a, to, cat, sub, note, amt2, cur, cur2 };
}

// ---------- Pickers
function listPicker({ title, items, onPick, onNew, newLabel, render: rowRender }) {
  const st = { q: '' };
  openSheet({
    title, st,
    render: () => {
      const q = st.q.toLowerCase();
      const shown = items().filter(x => !q || x.name.toLowerCase().includes(q));
      return `<label class="search">${icon('search')}<input data-in="pickq" placeholder="Search" value="${esc(st.q)}"></label><div class="sp"></div>
        ${onNew && st.q.trim() && !shown.some(x => x.name.toLowerCase() === q) ? `<button class="btn ghost block" data-a="pickNew">${icon('plus')} ${newLabel} “${esc(st.q.trim())}”</button><div class="sp"></div>` : ''}
        <div class="list">${shown.map(x => `<button class="row tap" data-a="pickOne" data-id="${x.id}">${rowRender(x)}</button>`).join('') || '<div class="empty">Nothing found. Type a name to add.</div>'}</div>`;
    },
    pick: (id) => { closeSheet(); onPick(id); },
    pickNew: () => { const name = st.q.trim(); closeSheet(); onNew(name); },
  });
}

function pickPerson(f) {
  const pb = peopleBalances();
  listPicker({
    title: 'Choose person', newLabel: 'Add',
    items: () => [...D().people].sort((a, b) => Math.abs(personAED(pb.get(b.id))) - Math.abs(personAED(pb.get(a.id))) || a.name.localeCompare(b.name)),
    render: (p) => { const v = personAED(pb.get(p.id)); return `<div class="ic"><b style="font-size:14px">${esc(initials(p.name))}</b></div><div class="mid"><div class="t">${esc(p.name)}</div></div><div class="amt num ${v > 0.5 ? 'c-lend' : v < -0.5 ? 'c-borrow' : 'muted'}">${Math.abs(v) > 0.5 ? money(Math.abs(v)) : ''}</div>`; },
    onPick: (id) => { f.person = id; refreshSheet(); },
    onNew: (name) => { const p = { id: newId('p'), name }; D().people.push(p); store.save(); f.person = p.id; refreshSheet(); },
  });
}
function pickCat(f) {
  listPicker({
    title: 'Choose category', newLabel: 'Create',
    items: () => D().categories.filter(c => c.kind === f.type).sort((a, b) => a.name.localeCompare(b.name)),
    render: (c) => `<div class="ic">${c.icon || '🏷️'}</div><div class="mid"><div class="t">${esc(c.name)}</div></div>`,
    onPick: (id) => { f.cat = id; f.sub = ''; refreshSheet(); },
    onNew: (name) => { const c = { id: newId('c'), kind: f.type, name, icon: '🏷️' }; D().categories.push(c); store.save(); f.cat = c.id; refreshSheet(); },
  });
}
function pickKuri(f) {
  listPicker({
    title: 'Choose kuri', newLabel: 'Create kuri',
    items: () => D().kuris.filter(k => k.status !== 'closed'),
    render: (k) => `<div class="ic bg-kuri">🪙</div><div class="mid"><div class="t">${esc(k.name)}</div>${k.instalment ? `<div class="d">Instalment ${money(k.instalment, k.cur)}</div>` : ''}</div>`,
    onPick: (id) => { f.kuri = id; const k = kuriOf(id); if (!f.amtStr && k.instalment && f.type === 'kuri_pay' && curOf(f) === (k.cur || 'AED')) f.amtStr = String(k.instalment); refreshSheet(); },
    onNew: (name) => { const k = { id: newId('k'), name, cur: 'AED', status: 'active' }; D().kuris.push(k); store.save(); f.kuri = k.id; refreshSheet(); },
  });
}
function pickAsset(f) {
  listPicker({
    title: 'Choose investment', newLabel: 'Create',
    items: () => D().assets,
    render: (s) => `<div class="ic bg-invest">📈</div><div class="mid"><div class="t">${esc(s.name)}</div></div>`,
    onPick: (id) => { f.asset = id; refreshSheet(); },
    onNew: (name) => { const s = { id: newId('s'), name, kind: 'investment', cur: 'AED', value: null }; D().assets.push(s); store.save(); f.asset = s.id; refreshSheet(); },
  });
}

// ---------- Generic edit forms
function formSheet({ title, fields, values, onSave, onDelete, deleteLabel }) {
  const v = { ...values };
  openSheet({
    title, v,
    headRight: () => onDelete ? `<button class="icon-btn plain" data-a="formDel">${icon('trash')}</button>` : `<button class="icon-btn plain" data-a="closeSheet">${icon('x')}</button>`,
    render: () => fields.map(fd => {
      if (fd.when && !fd.when(v)) return '';
      if (fd.type === 'seg') return `<div class="field"><div class="lbl">${fd.label}</div><div class="seg">${fd.options.map(([k, l]) => `<button class="${v[fd.key] === k ? 'on' : ''}" data-a="formSet" data-k="${fd.key}" data-v="${k}">${l}</button>`).join('')}</div></div>`;
      if (fd.type === 'select') return `<div class="field"><div class="lbl">${fd.label}</div><select class="input" data-in="form" data-k="${fd.key}">${fd.options().map(([k, l]) => `<option value="${esc(k)}" ${String(v[fd.key] ?? '') === String(k) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
      if (fd.type === 'note') return `<p class="small muted" style="margin:12px 2px 0">${fd.text(v)}</p>`;
      return `<div class="field"><div class="lbl">${fd.label}</div><input class="input" data-in="form" data-k="${fd.key}" ${fd.type === 'number' ? 'inputmode="decimal"' : ''} type="${fd.type === 'date' ? 'date' : 'text'}" placeholder="${esc(fd.ph || '')}" value="${esc(v[fd.key] ?? '')}"></div>`;
    }).join(''),
    foot: () => `<button class="btn primary" data-a="formSave">${icon('check')} Save</button>`,
    save: () => { const err = onSave(v); if (err) return toast(err); store.save(); closeSheet(); render(); },
    del: onDelete ? () => confirmSheet(deleteLabel || 'Delete?', 'This cannot be undone.', 'Delete', () => { onDelete(); store.save(); closeAllSheets(); ui.stack.pop(); render(); }) : null,
  });
}

function editAccount(id) {
  const a = id ? acc(id) : null;
  formSheet({
    title: a ? 'Edit account' : 'New account',
    values: a ? { ...a } : { kind: 'bank', cur: 'AED', opening: '' },
    fields: [
      { key: 'name', label: 'Name', ph: 'e.g. ADCB Salary' },
      { key: 'kind', label: 'Type', type: 'seg', options: [['bank', 'Bank'], ['cash', 'Cash'], ['card', 'Credit card']] },
      { key: 'cur', label: 'Currency', type: 'seg', options: [['AED', 'AED'], ['INR', 'INR']] },
      { key: 'opening', label: 'Opening balance', type: 'number', ph: '0' },
      { key: 'closed', label: 'Status', type: 'seg', options: [[false, 'Active'], [true, 'Closed']], when: () => !!a },
    ],
    onSave: (v) => {
      if (!v.name?.trim()) return 'Enter a name';
      const ob = evalAmount(v.opening);
      const o = { ...(a || { id: newId('a') }), name: v.name.trim(), kind: v.kind, cur: v.cur, opening: Number.isFinite(ob) ? ob : 0, closed: v.closed === true || v.closed === 'true' };
      if (a) Object.assign(a, o); else D().accounts.push(o);
    },
    onDelete: a && !D().txns.some(t => t.acc === a.id || t.to === a.id) ? () => { D().accounts = D().accounts.filter(x => x.id !== a.id); } : null,
  });
}

function editKuri(id) {
  const k = id ? kuriOf(id) : null;
  formSheet({
    title: k ? 'Edit kuri' : 'New kuri',
    values: k ? { ...k } : { cur: 'AED', status: 'active', start: todayISO() },
    fields: [
      { key: 'name', label: 'Name', ph: 'e.g. Family kuri' },
      { key: 'cur', label: 'Currency', type: 'seg', options: [['AED', 'AED'], ['INR', 'INR']] },
      { key: 'instalment', label: 'Monthly instalment', type: 'number' },
      { key: 'months', label: 'Number of instalments', type: 'number', ph: 'e.g. 20' },
      { key: 'total', label: 'Kuri value (total payout)', type: 'number' },
      { key: 'start', label: 'Started on', type: 'date' },
      { key: 'status', label: 'Status', type: 'seg', options: [['active', 'Active'], ['closed', 'Closed']] },
    ],
    onSave: (v) => {
      if (!v.name?.trim()) return 'Enter a name';
      const o = { ...(k || { id: newId('k') }), name: v.name.trim(), cur: v.cur, instalment: evalAmount(v.instalment) || null, months: parseInt(v.months) || null, total: evalAmount(v.total) || null, start: v.start, status: v.status };
      if (k) Object.assign(k, o); else D().kuris.push(o);
    },
    onDelete: k && !D().txns.some(t => t.kuri === k.id) ? () => { D().kuris = D().kuris.filter(x => x.id !== k.id); } : null,
  });
}

function editAsset(id) {
  const s = id ? assetOf(id) : null;
  formSheet({
    title: s ? 'Edit investment' : 'New investment',
    values: s ? { ...s } : { kind: 'investment' },
    fields: [
      { key: 'name', label: 'Name', ph: 'e.g. Plot in Kasaragod' },
      { key: 'kind', label: 'Type', type: 'select', options: () => [['investment', 'Investment / shares'], ['property', 'Property / land'], ['gold', 'Gold'], ['business', 'Business'], ['vehicle', 'Vehicle'], ['other', 'Other']] },
      { key: 'note', label: 'Note', ph: 'Location, documents, etc.' },
      ...(s ? [{ type: 'note', text: () => `Is this really spending (like construction or interior work)? <button class="link" data-a="assetToProject" data-id="${s.id}">Turn it into a project</button> – its entries become expenses.` }] : []),
    ],
    onSave: (v) => {
      if (!v.name?.trim()) return 'Enter a name';
      const o = { ...(s || { id: newId('s'), values: {} }), name: v.name.trim(), kind: v.kind, note: v.note };
      if (s) Object.assign(s, o); else D().assets.push(o);
    },
    onDelete: s && !D().txns.some(t => t.asset === s.id) ? () => { D().assets = D().assets.filter(x => x.id !== s.id); } : null,
  });
}

function editPerson(id) {
  const p = personOf(id);
  formSheet({
    title: 'Edit person', values: { ...p, mergeInto: '' },
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone (optional)', ph: '+971…' },
      { key: 'mergeInto', label: 'Same person as… (merge)', type: 'select', options: () => [['', '— Keep separate —'], ...D().people.filter(x => x.id !== id).sort((a, b) => a.name.localeCompare(b.name)).map(x => [x.id, x.name])] },
      { type: 'note', text: (v) => v.mergeInto ? `All of ${esc(p.name)}'s entries will move to ${esc(personOf(v.mergeInto)?.name)}.` : '' },
    ],
    onSave: (v) => {
      if (v.mergeInto) {
        for (const t of D().txns) if (t.person === id) t.person = v.mergeInto;
        D().people = D().people.filter(x => x.id !== id);
        ui.stack.pop(); ui.stack.push({ v: 'person', id: v.mergeInto });
        return;
      }
      if (!v.name?.trim()) return 'Enter a name';
      p.name = v.name.trim(); p.phone = v.phone?.trim() || undefined;
    },
    onDelete: !D().txns.some(t => t.person === id) ? () => { D().people = D().people.filter(x => x.id !== id); } : null,
  });
}

function editCat(id, kind) {
  const c = id ? catOf(id) : null;
  formSheet({
    title: c ? 'Edit category' : 'New category',
    values: c ? { ...c, mergeInto: '' } : { kind, icon: '🏷️' },
    fields: [
      { key: 'icon', label: 'Icon (any emoji)' },
      { key: 'name', label: 'Name' },
      ...(c ? [{ key: 'mergeInto', label: 'Merge into…', type: 'select', options: () => [['', '— Keep separate —'], ...D().categories.filter(x => x.kind === c.kind && x.id !== id).sort((a, b) => a.name.localeCompare(b.name)).map(x => [x.id, x.name])] },
        { type: 'note', text: (v) => v.mergeInto ? `Entries move to ${esc(catOf(v.mergeInto)?.name)}; the old name is kept as their detail.` : '' }] : []),
    ],
    onSave: (v) => {
      if (c && v.mergeInto) {
        for (const t of D().txns) if (t.cat === id) { t.cat = v.mergeInto; t.sub ||= c.name; }
        D().categories = D().categories.filter(x => x.id !== id);
        return;
      }
      if (!v.name?.trim()) return 'Enter a name';
      const o = { ...(c || { id: newId('c'), kind }), name: v.name.trim(), icon: (v.icon || '🏷️').trim().slice(0, 4) };
      if (c) Object.assign(c, o); else D().categories.push(o);
    },
    onDelete: c && !D().txns.some(t => t.cat === id) ? () => { D().categories = D().categories.filter(x => x.id !== id); } : null,
  });
}

function editRec(id) {
  const r = id ? D().recurring.find(x => x.id === id) : null;
  const expCats = () => D().categories.filter(c => c.kind === 'expense').sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, `${c.icon || ''} ${c.name}`]);
  const incCats = () => D().categories.filter(c => c.kind === 'income').sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.id, `${c.icon || ''} ${c.name}`]);
  const accs = () => D().accounts.filter(a => !a.closed).map(a => [a.id, `${a.name} (${a.cur})`]);
  formSheet({
    title: r ? 'Recurring entry' : 'New recurring entry',
    values: r ? { ...r, active: r.active !== false } : { type: 'expense', day: 1, next: addMonths(todayISO(), 1, 1), active: true, acc: defaultAccount() },
    fields: [
      { key: 'title', label: 'Title', ph: 'e.g. Monthly to Pappa' },
      { key: 'type', label: 'Type', type: 'seg', options: [['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']] },
      { key: 'amt', label: 'Amount (in account currency)', type: 'number' },
      { key: 'acc', label: 'Account', type: 'select', options: accs },
      { key: 'to', label: 'To account', type: 'select', options: () => [['', 'Choose…'], ...accs()], when: (v) => v.type === 'transfer' },
      { key: 'cat', label: 'Category', type: 'select', options: () => [['', 'Choose…'], ...expCats()], when: (v) => v.type === 'expense' },
      { key: 'cat', label: 'Category', type: 'select', options: () => [['', 'Choose…'], ...incCats()], when: (v) => v.type === 'income' },
      { key: 'sub', label: 'Detail', ph: 'optional', when: (v) => v.type !== 'transfer' },
      { key: 'day', label: 'Day of month', type: 'number' },
      { key: 'next', label: 'Next due', type: 'date' },
      { key: 'active', label: 'Status', type: 'seg', options: [[true, 'Active'], [false, 'Paused']] },
    ],
    onSave: (v) => {
      const amt = evalAmount(v.amt);
      if (!v.title?.trim()) return 'Enter a title';
      if (!(amt > 0)) return 'Enter an amount';
      if (v.type !== 'transfer' && !v.cat) return 'Choose a category';
      if (v.type === 'transfer' && (!v.to || v.to === v.acc)) return 'Choose the “To” account';
      const o = { ...(r || { id: newId('r') }), title: v.title.trim(), type: v.type, amt, acc: v.acc, to: v.type === 'transfer' ? v.to : undefined, cat: v.type !== 'transfer' ? v.cat : undefined, sub: v.sub || undefined, day: Math.min(31, Math.max(1, parseInt(v.day) || 1)), next: v.next, active: v.active === true || v.active === 'true' };
      o.cur = acc(o.acc)?.cur; if (o.to) o.cur2 = acc(o.to)?.cur;
      if (r) Object.assign(r, o); else D().recurring.push(o);
    },
    onDelete: r ? () => { D().recurring = D().recurring.filter(x => x.id !== r.id); } : null,
  });
}

function adjustBalance(id) {
  const a = acc(id);
  const cur = accountBalances()[id];
  formSheet({
    title: `Fix ${a.name} balance`, values: { actual: '' },
    fields: [
      { type: 'note', text: () => `Kanakku shows <b>${money(cur, a.cur)}</b>. Enter the real balance from your bank app; the difference is saved as a correction.` },
      { key: 'actual', label: `Actual balance (${a.cur})`, type: 'number', ph: String(cur) },
    ],
    onSave: (v) => {
      const actual = evalAmount(v.actual);
      if (!Number.isFinite(actual) || String(v.actual).trim() === '') return 'Enter the balance';
      const diff = Math.round((actual - cur) * 100) / 100;
      if (Math.abs(diff) < 0.005) return;
      D().txns.push({ id: newId('t'), type: 'adjust', date: todayISO(), acc: id, cur: a.cur, amt: diff, note: 'Balance correction', created: Date.now(), ...(a.cur === 'INR' ? { fx: rate() } : {}) });
    },
  });
}

function setValue(id) {
  const s = assetOf(id);
  const x = assetSummary(id);
  formSheet({
    title: 'Current value', values: { AED: s.values?.AED ?? '', INR: s.values?.INR ?? '' },
    fields: [
      { type: 'note', text: () => `What would it sell for today? Leave empty to use the amount invested (${multi(x.net)}).` },
      { key: 'AED', label: 'Value in AED', type: 'number', ph: String(Math.round(x.net.AED)) },
      { key: 'INR', label: 'Value in INR', type: 'number', ph: String(Math.round(x.net.INR)) },
    ],
    onSave: (v) => {
      s.values ||= {};
      for (const c of CURS) { const raw = String(v[c] ?? '').trim(); if (raw === '') delete s.values[c]; else s.values[c] = evalAmount(raw); }
    },
  });
}

function dual(o, opts = {}) {
  const cls = opts.cls || '';
  const rows = CURS.filter(c => Math.abs(o[c] || 0) >= 0.005);
  if (!rows.length) rows.push('AED');
  return rows.map((c, i) => `<div class="num ${cls} ${i ? 'dual2' : ''}">${money(o[c] || 0, c, opts)}</div>`).join('');
}

function assetIcon(s) {
  return { property: '🏠', gold: '🥇', business: '💼', vehicle: '🚗' }[s.kind] || '📈';
}

function viewRecurring() {
  return `<div class="screen">${topbar('Recurring', { back: true, right: `<button class="icon-btn" data-a="editRec">${icon('plus')}</button>` })}
    <p class="small muted" style="margin:0 4px 12px">Payments that repeat every month. On the due day Kanakku reminds you on Home and you record it with one tap.</p>
    <div class="list">${D().recurring.map(r => `<button class="row tap" data-a="editRec" data-id="${r.id}">
      <div class="ic">🔁</div><div class="mid"><div class="t">${esc(r.title)}</div><div class="d">Day ${r.day} of each month · next ${fmtDate(r.next, true)}${r.active === false ? ' · paused' : ''}</div></div>
      <div class="amt num">${money(r.amt, acc(r.acc)?.cur || 'AED')}</div></button>`).join('') || '<div class="empty">No recurring entries</div>'}</div>
  </div>`;
}

function viewProjects() {
  const act = D().projects.filter(p => p.status !== 'done'), done = D().projects.filter(p => p.status === 'done');
  const row = (p) => { const s = projectSummary(p.id); const pct = p.budget ? Math.min(100, (s.spent[p.cur || 'AED'] || 0) / p.budget * 100) : null; return `<button class="row tap" data-a="go" data-v="project" data-id="${p.id}">
    <div class="ic bg-invest">${p.icon || '🏗️'}</div><div class="mid"><div class="t">${esc(p.name)}</div><div class="d">${s.list.length} entries${p.budget ? ` · ${Math.round(pct)}% of budget` : ''}</div>${pct != null ? `<div class="bar"><i style="width:${pct}%;background:${pct >= 100 ? 'var(--out)' : 'var(--invest)'}"></i></div>` : ''}</div>
    <div class="amt">${dual(s.spent)}</div></button>`; };
  return `<div class="screen">${topbar('Projects', { back: true, right: `<button class="icon-btn" data-a="editProject">${icon('plus')}</button>` })}
    <p class="small muted" style="margin:0 4px 12px">Group spending for big things – house construction, interior work, a wedding, a trip – and see the total against a budget. It still counts as normal spending.</p>
    <div class="list">${act.map(row).join('') || '<div class="empty"><span class="big">🏗️</span>No projects yet</div>'}</div>
    ${done.length ? `<div class="lbl" style="margin-top:18px">Finished</div><div class="list">${done.map(row).join('')}</div>` : ''}
  </div>`;
}

function viewProject(id) {
  const p = projectOf(id);
  if (!p) return viewProjects();
  const s = projectSummary(id);
  const C = p.cur || 'AED';
  const pct = p.budget ? (s.spent[C] || 0) / p.budget * 100 : null;
  const cats = [...s.byCat.entries()].sort((a, b) => (b[1].AED + b[1].INR / 25) - (a[1].AED + a[1].INR / 25));
  return `<div class="screen">${topbar(p.name, { back: true, sub: 'Project', right: `<button class="icon-btn" data-a="editProject" data-id="${id}">${icon('edit')}</button>` })}
    <div class="detail-hero"><div class="ic-big bg-invest">${p.icon || '🏗️'}</div>
      <div class="big">${dual(s.spent)}</div><div class="cap">spent so far${p.budget ? ` · budget ${money(p.budget, C)}` : ''}</div></div>
    ${pct != null ? `<div class="card" style="margin-top:12px"><div class="flex"><b class="grow">${Math.round(pct)}% of budget used</b><span class="num ${pct > 100 ? 'c-out' : ''}">${money(p.budget - (s.spent[C] || 0), C)} left</span></div><div class="bar"><i style="width:${Math.min(100, pct)}%;background:${pct > 100 ? 'var(--out)' : 'var(--invest)'}"></i></div></div>` : ''}
    <div class="actions"><button data-a="newTxn" data-type="expense" data-project="${id}"><span class="ai bg-out">${icon('out')}</span>Add expense</button></div>
    ${cats.length ? `<div class="section"><div class="section-head"><h2>By category</h2></div><div class="card">${cats.map(([k, v]) => { const c = catOf(k); return `<div class="kv"><span>${c?.icon || ''} ${esc(c?.name || TYPES[k]?.label || 'Other')}</span><span class="num">${multi(v)}</span></div>`; }).join('')}</div></div>` : ''}
    <div class="section">${groupedTxns(sorted(s.list), { inProject: id })}</div>
  </div>`;
}

function viewZakat(yearArg) {
  const thisYear = +todayISO().slice(0, 4);
  const y = String(yearArg || ui.zakatYear || (todayISO().slice(5) < '12-31' ? thisYear : thisYear));
  ui.zakatYear = y;
  const v = zakatView(y);
  const st = v.st;
  const inc = st.include;
  const years = []; for (let i = thisYear; i >= thisYear - 4; i--) years.push(String(i));
  const ns = { nosym: true };
  const line = (label, k, sign = 1, cls = '', on = true) => `<div class="kv3 ${on ? '' : 'off'}"><span>${label}</span><span class="num ${cls}">${money(sign * v.comps.AED[k], 'AED', ns)}</span><span class="num ${cls}">${money(sign * v.comps.INR[k], 'INR', ns)}</span></div>`;
  const tog = (k, label) => `<button class="chip ${inc[k] ? 'on' : ''}" data-a="zInc" data-k="${k}" ${st.locked ? 'disabled' : ''}>${inc[k] ? '✓ ' : ''}${label}</button>`;
  const leftPos = { AED: Math.max(0, v.left.AED), INR: Math.max(0, v.left.INR) };
  const paidPct = (c) => v.due[c] ? Math.min(100, v.paid[c] / v.due[c] * 100) : 0;
  return `<div class="screen">${topbar('Zakat', { back: true, sub: 'Calculated on 31 December each year' })}
    <div class="chips">${years.map(yy => `<button class="chip ${yy === y ? 'on' : ''}" data-a="zYear" data-k="${yy}">${yy}</button>`).join('')}</div>
    <div class="hero" style="margin-top:8px">
      <div class="label">Zakat ${y} ${v.final ? '' : '· estimate so far'}</div>
      <div class="value num" style="margin-bottom:2px">${money(v.due.AED)}</div>
      ${v.due.INR ? `<div class="value2 num">${money(v.due.INR, 'INR')}</div>` : ''}
      <div class="split" style="grid-template-columns:1fr 1fr;margin-top:12px">
        <div><span>Given</span><b>${dual(v.paid)}</b></div>
        <div><span>Still to give</span><b>${dual(leftPos)}</b></div>
      </div>
    </div>
    ${CURS.filter(c => v.due[c]).map(c => `<div class="bar" style="margin:10px 4px 0;height:10px"><i style="width:${paidPct(c)}%;background:var(--in)"></i></div><div class="small muted" style="margin:4px 4px 0">${c}: ${Math.round(paidPct(c))}% given</div>`).join('')}
    <div class="actions"><button data-a="zPay" data-k="${y}"><span class="ai bg-in">${icon('out')}</span>Give zakat</button>
      <button data-a="zGold" data-k="${y}"><span class="ai bg-kuri">🥇</span>Gold price</button>
      <button data-a="zLock" data-k="${y}"><span class="ai bg-move">${icon('lock')}</span>${st.locked ? 'Unlock' : 'Finalise'}</button></div>

    <div class="section"><div class="section-head"><h2>Calculation</h2><span class="small muted">${st.locked ? 'Finalised' : 'Balances on'} ${fmtDate(v.asOf, true)}</span></div>
      <div class="card">
        <div class="kv3 head"><span></span><span>AED</span><span>INR</span></div>
        ${line('Bank & cash', 'cash')}
        ${line('+ Owed to you', 'owed', 1, 'c-lend', inc.owed)}
        ${line('− You owe', 'owe', -1, 'c-borrow', inc.owe)}
        ${line('− Credit card dues', 'cards', 1, 'c-out', inc.cards)}
        ${inc.invest ? line('+ Investments', 'invest', 1, 'c-invest') : ''}
        ${inc.gold ? line('+ Gold', 'gold', 1, 'c-kuri') : ''}
        <div class="kv3 total"><span>Zakatable</span><span class="num">${money(v.comps.AED.total, 'AED', ns)}</span><span class="num">${money(v.comps.INR.total, 'INR', ns)}</span></div>
        <div class="kv3"><span>Zakat 2.5%</span><span class="num c-in">${money(v.due.AED, 'AED', ns)}</span><span class="num c-in">${money(v.due.INR, 'INR', ns)}</span></div>
      </div>
      <div class="chips" style="margin-top:10px">${tog('owed', 'Owed to you')}${tog('owe', 'You owe')}${tog('cards', 'Card dues')}${tog('invest', 'Investments')}${tog('gold', 'Gold')}</div>
    </div>

    <div class="section card">
      <div class="flex"><b class="grow">Nisab (85 g gold)</b>${v.nisab ? `<span class="pill ${v.above ? 'bg-in' : 'bg-out'}">${v.above ? 'Above nisab' : 'Below nisab'}</span>` : ''}</div>
      ${v.nisab ? `<div class="kv"><span>Gold price</span><span class="num">${money(v.goldPrice)} / g</span></div>
        <div class="kv"><span>Nisab</span><span class="num">${money(v.nisab)}</span></div>
        <div class="kv"><span>Your total (₹ counted at ₹${v.fx} only for this check)</span><span class="num">${money(v.combined)}</span></div>`
        : `<p class="small muted" style="margin:6px 0 0">Add the gold price per gram (24K, in AED) to check nisab. <button class="link" data-a="zGold" data-k="${y}">Add price</button></p>`}
    </div>

    <div class="section"><div class="section-head"><h2>Given for ${y}</h2><button data-a="zPay" data-k="${y}">+ Give</button></div>
      ${groupedTxns(sorted(v.paidList))}
    </div>
    <p class="small muted" style="margin:14px 4px">Payments in the Zakat category count towards the year written in the note (e.g. “Zakat 2025”), or otherwise the year before they were paid. When you give zakat from here, it is linked to ${y} automatically.</p>
  </div>`;
}

function editProject(id) {
  const p = id ? projectOf(id) : null;
  formSheet({
    title: p ? 'Edit project' : 'New project',
    values: p ? { ...p, budget: p.budget ?? '' } : { cur: 'AED', status: 'active', icon: '🏗️' },
    fields: [
      { key: 'icon', label: 'Icon (any emoji)' },
      { key: 'name', label: 'Name', ph: 'e.g. House construction' },
      { key: 'cur', label: 'Budget currency', type: 'seg', options: [['AED', 'AED'], ['INR', 'INR']] },
      { key: 'budget', label: 'Budget (optional)', type: 'number' },
      { key: 'status', label: 'Status', type: 'seg', options: [['active', 'Active'], ['done', 'Finished']] },
    ],
    onSave: (v) => {
      if (!v.name?.trim()) return 'Enter a name';
      const b = String(v.budget ?? '').trim();
      const o = { ...(p || { id: newId('j') }), name: v.name.trim(), icon: (v.icon || '🏗️').trim().slice(0, 4), cur: v.cur, budget: b ? evalAmount(b) : null, status: v.status };
      if (p) Object.assign(p, o); else D().projects.push(o);
    },
    onDelete: p ? () => { for (const t of D().txns) if (t.project === p.id) delete t.project; D().projects = D().projects.filter(x => x.id !== p.id); } : null,
    deleteLabel: 'Delete project? (entries are kept)',
  });
}

function assetToProject(id) {
  const s = assetOf(id);
  confirmSheet(`Turn “${s.name}” into a project?`, 'Its investment entries become expenses in a category of the same name, grouped under a new project. Money returned becomes a refund. Your account balances do not change.', 'Convert', () => {
    let cat = D().categories.find(c => c.kind === 'expense' && c.name.toLowerCase() === s.name.toLowerCase());
    if (!cat) { cat = { id: newId('c'), kind: 'expense', name: s.name, icon: '🏗️' }; D().categories.push(cat); }
    let refund = D().categories.find(c => c.kind === 'income' && /^refund/i.test(c.name));
    const p = { id: newId('j'), name: s.name, icon: '🏗️', cur: 'AED', status: 'active', budget: null };
    D().projects.push(p);
    for (const t of D().txns) {
      if (t.asset !== id) continue;
      delete t.asset; delete t.amt2; delete t.cur2;
      t.project = p.id;
      if (t.type === 'invest') { t.type = 'expense'; t.cat = cat.id; }
      else { if (!refund) { refund = { id: newId('c'), kind: 'income', name: 'Refunds', icon: '↩️' }; D().categories.push(refund); } t.type = 'income'; t.cat = refund.id; }
    }
    D().assets = D().assets.filter(x => x.id !== id);
    store.save(); closeAllSheets(); ui.stack = [{ v: 'project', id: p.id }]; render(); toast('Converted to a project');
  }, false);
}

function loanCard(l, kind) {
  const open = ui.openLoan === l.t.id;
  const pct = l.amt ? Math.min(100, (l.back + l.waived) / l.amt * 100) : 0;
  const done = l.pending <= 0.004;
  const what = l.opening ? 'Balance from before' : kind === 'given' ? 'You gave' : 'You borrowed';
  return `<div class="loan ${done ? 'done' : ''}">
    <button class="loan-top" data-a="toggleLoan" data-id="${l.t.id}">
      <div class="grow"><div class="t">${what} ${money(l.amt, l.cur)}</div><div class="d">${fmtDate(l.t.date, true)}${l.t.note ? ' · ' + esc(l.t.note.split('\n')[0]) : ''}</div></div>
      <div class="right"><div class="num ${done ? 'c-in' : kind === 'given' ? 'c-lend' : 'c-borrow'}" style="font-weight:800">${done ? '✓ Settled' : money(l.pending, l.cur)}</div><div class="d">${done ? fmtDate(l.closedOn, true) : 'pending'}</div></div>
    </button>
    <div class="bar"><i style="width:${pct}%;background:${done ? 'var(--in)' : kind === 'given' ? 'var(--lend)' : 'var(--borrow)'}"></i></div>
    ${open ? `<div class="loan-detail">
      <div class="kv"><span>${kind === 'given' ? 'Given' : 'Borrowed'} · ${fmtDate(l.t.date, true)}</span><span class="num">${money(l.amt, l.cur)}</span></div>
      ${l.settles.map(s => `<button class="kv" style="width:100%" data-a="editTxn" data-id="${s.t.id}"><span>${s.t.type === 'waive' || s.t.type === 'waived' ? 'Discount' : kind === 'given' ? 'Got back' : 'Repaid'} · ${fmtDate(s.t.date, true)}${s.t.against ? '' : ' <span class="muted small">(auto)</span>'}</span><span class="num ${s.t.type.startsWith('waive') ? 'c-kuri' : 'c-in'}">− ${money(s.amt, l.cur)}</span></button>`).join('')}
      <div class="kv"><span>Pending</span><span class="num">${money(l.pending, l.cur)}</span></div>
      <div class="flex" style="gap:8px;margin-top:8px">
        <button class="btn ghost grow" data-a="editTxn" data-id="${l.t.id}">${icon('edit')} Edit</button>
        ${!done ? `<button class="btn ghost grow" data-a="newTxn" data-type="${kind === 'given' ? 'waive' : 'waived'}" data-person="${l.t.person}" data-against="${l.t.id}">% Discount</button>
        <button class="btn primary grow" data-a="newTxn" data-type="${kind === 'given' ? 'collect' : 'repay'}" data-person="${l.t.person}" data-against="${l.t.id}">${kind === 'given' ? 'Got back' : 'Repay'}</button>` : ''}
      </div>
    </div>` : ''}
  </div>`;
}

function loanAgainstPicker(f) {
  if (!f.person) return '';
  const kind = ['collect', 'waive'].includes(f.type) ? 'given' : 'borrowed';
  const books = personLoans(f.person);
  const cur = f.acc ? curOf(f) : (f.cur || 'AED');
  const pend = books[kind].filter(l => (l.pending > 0.004 || l.t.id === f.against) && l.cur === cur);
  if (!pend.length) return '';
  return `<div class="field"><div class="lbl">For which ${kind === 'given' ? 'loan' : 'borrowing'}?</div>
    <div class="list">
      <button class="radio-row ${!f.against ? 'on' : ''}" data-a="fset" data-k="against" data-v=""><i></i><div><b>Oldest pending first</b><span>Kanakku settles the oldest one automatically</span></div></button>
      ${pend.slice().reverse().map(l => `<button class="radio-row ${f.against === l.t.id ? 'on' : ''}" data-a="fset" data-k="against" data-v="${l.t.id}"><i></i><div class="grow"><b>${money(l.amt, l.cur)} on ${fmtDate(l.t.date, true)}</b><span>${l.t.note ? esc(l.t.note.split('\n')[0]) + ' · ' : ''}${money(l.pending, l.cur)} pending</span></div></button>`).join('')}
    </div></div>`;
}

function statementData(pid) {
  const p = personOf(pid);
  const e = peopleBalances().get(pid) || zero();
  const books = personLoans(pid);
  return { p, e, v: personAED(e), pendG: books.given.filter(l => l.pending > 0.004), pendB: books.borrowed.filter(l => l.pending > 0.004) };
}

function statementText(pid) {
  const { p, e, v, pendG, pendB } = statementData(pid);
  const L = [`*Kanakku – statement for ${p.name}*`, `Date: ${fmtDate(todayISO(), true)}`, ''];
  if (pendG.length) {
    L.push('Pending amounts you have to give me:');
    for (const l of pendG) L.push(`• ${fmtDate(l.t.date, true)}${l.t.note ? ' (' + l.t.note.split('\n')[0] + ')' : ''}: ${money(l.amt, l.cur)}${l.back ? `, paid ${money(l.back, l.cur)}` : ''}${l.waived ? `, discount ${money(l.waived, l.cur)}` : ''} → *${money(l.pending, l.cur)}*`);
    L.push('');
  }
  if (pendB.length) {
    L.push('Amounts I have to give you:');
    for (const l of pendB) L.push(`• ${fmtDate(l.t.date, true)}: ${money(l.amt, l.cur)} → ${money(l.pending, l.cur)} pending`);
    L.push('');
  }
  L.push(v > 0.5 ? `*Total pending: ${multi(e, { abs: true, sep: ' + ' })}*` : v < -0.5 ? `*I owe you: ${multi(e, { abs: true, sep: ' + ' })}*` : 'All settled 👍 Thank you!');
  return L.join('\n');
}

async function statementImage(pid) {
  const { p, e, v, pendG, pendB } = statementData(pid);
  const W = 1080, pad = 64;
  const rows = [...pendG.map(l => ({ l, k: 'given' })), ...pendB.map(l => ({ l, k: 'borrowed' }))];
  const H = 480 + Math.max(1, rows.length) * 132 + 130;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px Manrope, system-ui, sans-serif`;
  await document.fonts?.ready;
  g.fillStyle = '#F6F4EF'; g.fillRect(0, 0, W, H);
  // header band
  const grad = g.createLinearGradient(0, 0, 0, 380); grad.addColorStop(0, '#18705C'); grad.addColorStop(1, '#094035');
  g.fillStyle = grad; g.fillRect(0, 0, W, 380);
  const logo = new Image(); logo.src = 'icon-512.png';
  await new Promise(r => { logo.onload = r; logo.onerror = r; });
  try { g.drawImage(logo, pad, 56, 96, 96); } catch {}
  g.fillStyle = '#FFFFFF'; g.font = font(800, 44); g.fillText('Kanakku', pad + 120, 100);
  g.font = font(600, 28); g.globalAlpha = .8; g.fillText(`Statement · ${fmtDate(todayISO(), true)}`, pad + 120, 142); g.globalAlpha = 1;
  g.font = font(700, 34); g.globalAlpha = .85; g.fillText(v > 0.5 ? `${p.name}, pending to give` : v < -0.5 ? `I have to give ${p.name}` : `${p.name}`, pad, 236); g.globalAlpha = 1;
  g.font = font(800, 72); g.fillText(isZero(e) ? 'All settled' : multi(e, { abs: true, sep: ' + ' }), pad, 320);
  // rows
  let y = 450;
  g.fillStyle = '#56605B'; g.font = font(800, 24); g.fillText('DATE · DETAILS', pad, y); g.textAlign = 'right'; g.fillText('PENDING', W - pad, y); g.textAlign = 'left';
  y += 30;
  for (const { l, k } of rows) {
    g.fillStyle = '#FFFFFF'; roundRect(g, pad - 16, y, W - 2 * pad + 32, 112, 22); g.fill();
    g.fillStyle = '#1B2420'; g.font = font(800, 32);
    g.fillText(`${k === 'given' ? 'Given' : 'Borrowed'} ${money(l.amt, l.cur)} · ${fmtDate(l.t.date, true)}`, pad + 8, y + 48);
    g.fillStyle = '#8A928D'; g.font = font(600, 25);
    const sub = [l.t.note?.split('\n')[0], l.back ? `paid ${money(l.back, l.cur)}` : '', l.waived ? `discount ${money(l.waived, l.cur)}` : ''].filter(Boolean).join(' · ');
    g.fillText(sub.length > 52 ? sub.slice(0, 50) + '…' : sub, pad + 8, y + 88);
    g.textAlign = 'right'; g.fillStyle = k === 'given' ? '#7A5AC8' : '#C2742A'; g.font = font(800, 34); g.fillText(money(l.pending, l.cur), W - pad - 8, y + 66); g.textAlign = 'left';
    y += 132;
  }
  g.fillStyle = '#8A928D'; g.font = font(600, 24);
  g.fillText('Sent from Kanakku', pad, H - 70);
  return c.toDataURL('image/png').split(',')[1];
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

async function shareStatement(id, asImage) {
  const p = personOf(id);
  closeSheet();
  if (asImage) {
    const data = await statementImage(id);
    const name = `Kanakku-${p.name.replace(/\W+/g, '-')}-${todayISO()}.png`;
    if (isNative()) { const r = window.KanakkuNative.shareFile(name, data, 'image/png'); if (r.startsWith('ERR:')) toast('Could not share'); return; }
    const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
    const file = new File([bytes], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file] }).catch(() => {});
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    return;
  }
  const text = statementText(id);
  if (isNative() && window.KanakkuNative.shareText) return window.KanakkuNative.shareText(text);
  if (navigator.share) return navigator.share({ text }).catch(() => {});
  navigator.clipboard?.writeText(text).then(() => toast('Copied – paste it in WhatsApp'), () => toast('Could not copy'));
}

// ======================================================================
// Files: backup / restore / import / export
// ======================================================================
function b64(bytes) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function saveFile(name, text, mime) {
  const bytes = new TextEncoder().encode(text);
  if (isNative()) {
    const r = window.KanakkuNative.saveFile(name, b64(bytes), mime);
    if (r.startsWith('ERR:')) { toast('Could not save: ' + r.slice(4)); return false; }
    toast('Saved to ' + r); return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  return true;
}
function pickFile(accept) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; if (accept) i.accept = accept;
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}

async function doBackup() {
  await store.flush();
  const name = `kanakku-backup-${todayISO()}.json`;
  if (saveFile(name, JSON.stringify(D()), 'application/json')) await store.setMeta('lastBackup', new Date().toISOString());
  render();
}

// ---------- Google Drive backup
const monthOf = (iso) => (iso || '').slice(0, 7);
function backupName() { return `kanakku-backup-${todayISO()}.json`; }

async function driveShare() {
  await store.flush();
  const name = backupName();
  const text = JSON.stringify(D());
  if (isNative()) {
    const r = window.KanakkuNative.shareFile(name, b64(new TextEncoder().encode(text)), 'application/json');
    if (r.startsWith('ERR:')) return toast('Could not share: ' + r.slice(4));
  } else if (navigator.canShare?.({ files: [new File([text], name)] })) {
    navigator.share({ files: [new File([text], name, { type: 'application/json' })] }).catch(() => {});
  } else { saveFile(name, text, 'application/json'); }
  D().settings.drive ||= {};
  D().settings.drive.last = new Date().toISOString();
  store.save();
  await store.setMeta('lastBackup', new Date().toISOString());
}

let driveSilent = false;
async function driveUpload(silent) {
  if (!isNative()) return toast('Automatic Drive backup works in the Android app');
  await store.flush();
  driveSilent = !!silent;
  window.KanakkuNative.driveUpload(backupName(), b64(new TextEncoder().encode(JSON.stringify(D()))));
  if (!silent) toast('Uploading to Google Drive…');
}

window.kanakkuDriveResult = (r) => {
  const dr = (D().settings.drive ||= {});
  if (r.op === 'connect') {
    if (r.ok) { dr.mode = 'auto'; dr.account = r.account || dr.account; store.save(); render(); toast('Google Drive connected'); driveUpload(false); }
    else { toast(r.msg || 'Could not connect Google Drive'); }
    return;
  }
  if (r.ok) {
    dr.last = new Date().toISOString(); store.save(); store.setMeta('lastBackup', dr.last);
    if (!driveSilent) toast('Backup saved to Google Drive'); render();
  } else {
    toast('Drive backup failed', { label: 'Retry', fn: () => driveUpload(false) });
    console.warn(r.msg);
  }
};

function driveModeSheet() {
  const dr = (D().settings.drive ||= {});
  const opt = (k, title, text) => `<button class="radio-row ${(dr.mode || 'off') === k ? 'on' : ''}" data-a="setDriveMode" data-k="${k}"><i></i><div><b>${title}</b><span>${text}</span></div></button>`;
  openSheet({
    title: 'Monthly Drive backup',
    render: () => `<div class="list">
      ${opt('off', 'Off', 'Back up yourself from Settings whenever you like.')}
      ${opt('remind', 'Remind me (one tap)', 'On the first day you open Kanakku each month, it asks you to share the backup to Google Drive.')}
      ${opt('auto', 'Automatic', `Uploads a backup to “Kanakku Backups” in your Google Drive the first time you open Kanakku each month. ${dr.account ? 'Connected: ' + esc(dr.account) : 'You will be asked to choose your Google account once.'}`)}
    </div>
    ${dr.mode === 'auto' ? `<div class="sp"></div><button class="btn ghost block" data-a="driveNow">${icon('upload')} Upload a backup now</button>` : ''}
    <p class="small muted">Kanakku only goes online for this upload. It can only see the files it creates in your Drive.</p>`,
  });
}

function monthlyBackupCheck() {
  const dr = D().settings.drive || {};
  if (!dr.mode || dr.mode === 'off') return false;
  if (monthOf(dr.last) === monthOf(todayISO())) return false;
  if (dr.mode === 'auto' && isNative()) { driveUpload(true); return true; }
  if (dr.mode === 'remind') { setTimeout(() => toast('Time for your monthly backup', { label: 'Save to Drive', fn: driveShare }), 1200); return true; }
  return false;
}

async function doRestore() {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.txns) || !Array.isArray(data.accounts)) throw new Error('Not a Kanakku backup');
    confirmSheet('Restore this backup?', `It has ${data.txns.length.toLocaleString()} entries and ${data.accounts.length} accounts. Everything currently in the app will be replaced.`, 'Restore', async () => {
      await store.replace(data); ui.stack = []; ui.tab = 'home'; render(); toast('Backup restored');
    }, false);
  } catch (e) { toast('That file is not a Kanakku backup'); }
}

function importVyaparSheet(fromWelcome) {
  const st = { vyb: null, rules: null, rate: String(D()?.settings?.inrRate || 24), busy: false };
  openSheet({
    title: 'Import from Vyapar', st,
    render: () => `
      <p class="small muted" style="margin-top:0">In Vyapar: Settings → Backup & Restore → Backup to phone. Then choose that .vyb file here.</p>
      <div class="field"><div class="lbl">Vyapar backup (.vyb)</div><button class="input flex" data-a="vyPick" style="text-align:left"><span class="grow ${st.vyb ? '' : 'muted'}">${st.vyb ? esc(st.vyb.name) : 'Choose file…'}</span>${icon('upload', 'chev')}</button></div>
      <div class="field"><div class="lbl">Import rules (optional .json)</div><button class="input flex" data-a="vyRules" style="text-align:left"><span class="grow ${st.rules ? '' : 'muted'}">${st.rules ? esc(st.rules.name) : 'Name merges, INR accounts, kuri list'}</span>${icon('upload', 'chev')}</button></div>
      <div class="field"><div class="lbl">INR rate for old entries (1 AED = ₹)</div><input class="input" inputmode="decimal" data-in="vyRate" value="${esc(st.rate)}"></div>
      ${!fromWelcome ? `<p class="small" style="color:var(--out);font-weight:700">This replaces everything currently in Kanakku. Save a backup first if you need it.</p>` : ''}
      ${st.busy ? `<div class="sp"></div><div class="progress"><i></i></div><p class="small muted">Reading ${esc(st.vyb?.name || '')}…</p>` : ''}`,
    foot: () => `<button class="btn primary" data-a="vyGo" ${!st.vyb || st.busy ? 'disabled' : ''}>Import</button>`,
  });
}

let sqlPromise = null;
function loadSql() {
  if (!sqlPromise) sqlPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'lib/sql-wasm.js';
    s.onload = () => window.initSqlJs({ locateFile: (f) => 'lib/' + f }).then(res, rej);
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return sqlPromise;
}

async function runVyaparImport(st) {
  st.busy = true; refreshSheet();
  try {
    const [{ unzipSync }, { convertVyapar }, SQL] = await Promise.all([import('../lib/fflate.js'), import('./vyapar.js'), loadSql()]);
    let bytes = new Uint8Array(await st.vyb.arrayBuffer());
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const files = unzipSync(bytes);
      const name = Object.keys(files).find(n => /\.vyp$/i.test(n)) || Object.keys(files).find(n => files[n][0] === 0x53);
      if (!name) throw new Error('No Vyapar database inside this file');
      bytes = files[name];
    }
    const db = new SQL.Database(bytes);
    const rules = st.rules ? JSON.parse(await st.rules.text()) : {};
    const r = parseFloat(st.rate); if (r > 0) rules.inrRate = r;
    const { data } = convertVyapar(db, rules);
    db.close();
    applyImportExtras(data, rules);
    await store.replace(data);
    closeAllSheets(); ui.stack = []; ui.tab = 'home'; render();
    toast(`Imported ${data.txns.length.toLocaleString()} entries`);
  } catch (e) {
    console.error(e); st.busy = false; refreshSheet(); toast('Import failed: ' + e.message);
  }
}

/** Post-import touches: recurring entries from rules. */
function applyImportExtras(data, rules) {
  for (const r of rules.recurring || []) {
    const a = data.accounts.find(x => x.name.toLowerCase() === String(r.account || '').toLowerCase()) || data.accounts[0];
    const c = data.categories.find(x => x.name.toLowerCase() === String(r.category || '').toLowerCase());
    if (!c) continue;
    data.recurring.push({ id: newId('r'), title: r.title, type: 'expense', amt: r.amount, acc: a.id, cur: a.cur, cat: c.id, sub: r.sub, day: r.day || 1, next: r.next, active: true });
  }
}

function exportCsv() {
  const rows = [['Date', 'Type', 'Amount', 'Currency', 'Account', 'To account', 'Amount received', 'Category', 'Detail', 'Person', 'Kuri', 'Investment', 'Note']];
  for (const t of sorted(D().txns).reverse()) {
    rows.push([t.date, TYPES[t.type]?.label, t.amt, t.cur, acc(t.acc)?.name, acc(t.to)?.name, t.type === 'transfer' ? t.amt2 : '', catOf(t.cat)?.name, t.sub, personOf(t.person)?.name, kuriOf(t.kuri)?.name, assetOf(t.asset)?.name, t.note]);
  }
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
  saveFile(`kanakku-${todayISO()}.csv`, '﻿' + csv, 'text/csv');
}

function sharePerson(id) {
  const p = personOf(id);
  openSheet({
    title: `Send to ${p.name}`,
    render: () => `<div class="list">
      <button class="row tap" data-a="shareImg" data-id="${id}"><div class="ic bg-in">🖼️</div><div class="mid"><div class="t">As a picture</div><div class="d">A neat statement card for WhatsApp</div></div>${icon('chevron', 'chev')}</button>
      <button class="row tap" data-a="shareTxt" data-id="${id}"><div class="ic">💬</div><div class="mid"><div class="t">As a message</div><div class="d">Plain text with each pending amount</div></div>${icon('chevron', 'chev')}</button>
    </div>
    <div class="card" style="margin-top:12px;white-space:pre-wrap;font-size:13px">${esc(statementText(id)).replace(/\*/g, '')}</div>`,
  });
}

// ======================================================================
// PIN lock
// ======================================================================
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kanakku:' + s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function showLock({ mode = 'unlock', onDone }) {
  let pin = '', first = null;
  const el = document.createElement('div');
  el.className = 'lock';
  const bio = mode === 'unlock' && D().settings.bio && isNative() && window.KanakkuNative.bioAvailable?.();
  const title = () => mode === 'unlock' ? 'Enter PIN' : first ? 'Confirm new PIN' : 'Choose a 4-digit PIN';
  const unlock = () => { el.remove(); window.kanakkuBioResult = null; onDone?.(); };
  if (bio) window.kanakkuBioResult = (ok) => { if (ok) unlock(); };
  const draw = () => {
    el.innerHTML = `<img src="icon-512.png" width="64" height="64" style="border-radius:18px" alt=""><h2>${title()}</h2>
      <div class="pins">${[0, 1, 2, 3].map(i => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join('')}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, mode === 'unlock' ? (bio ? 'bio' : '') : '✕', 0, '⌫'].map(k => k === 'bio' ? `<button data-k="bio" aria-label="Fingerprint">👆</button>` : `<button data-k="${k}" ${k === '' ? 'style="visibility:hidden"' : ''}>${k}</button>`).join('')}</div>`;
  };
  el.addEventListener('click', async (e) => {
    const k = e.target.closest('button')?.dataset.k;
    if (k == null) return;
    if (k === '✕') { el.remove(); return; }
    if (k === 'bio') { window.KanakkuNative.bioAuth(); return; }
    if (k === '⌫') pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
    draw();
    if (pin.length === 4) {
      if (mode === 'unlock') {
        if (await sha(pin) === D().settings.pinHash) unlock();
        else { el.querySelector('.pins').classList.add('shake'); setTimeout(() => { pin = ''; draw(); }, 350); }
      } else if (!first) { first = pin; pin = ''; setTimeout(draw, 120); }
      else if (first === pin) { D().settings.pinHash = await sha(pin); store.save(); el.remove(); toast('App lock is on'); render(); }
      else { first = null; pin = ''; toast('PINs did not match'); draw(); }
    }
  });
  draw();
  document.body.appendChild(el);
  if (bio) setTimeout(() => window.KanakkuNative.bioAuth(), 250);
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); store.flush().catch(() => {}); }
  else if (D()?.settings.pinHash && Date.now() - hiddenAt > 60000 && !document.querySelector('.lock')) showLock({});
});

// ======================================================================
// Events
// ======================================================================
const topSheet = () => ui.sheets[ui.sheets.length - 1];

const actions = {
  tab: (d) => { ui.stack = []; ui.tab = d.tab; if (d.filter) ui.people.filter = d.filter; render(); },
  go: (d) => { const top = ui.stack[ui.stack.length - 1]; if (top) top.scroll = window.scrollY; ui.stack.push({ v: d.v, id: d.id }); render(); },
  back: () => goBack(),
  toggleHide: () => { ui.hide = !ui.hide; render(); },
  goAct: (d) => { Object.assign(ui.act, { type: d.type || 'all', month: d.month || '', cat: d.cat || '', acc: '', person: '', project: '', q: '', limit: 150 }); ui.stack = []; ui.tab = 'activity'; render(); },
  actType: (d) => { ui.act.type = d.k; ui.act.limit = 150; render(); },
  clearF: (d) => { ui.act[d.k] = ''; render(); },
  more: () => { ui.act.limit += 300; render(); },
  moreAcc: () => { ui.wealth.accLimit = (ui.wealth.accLimit || 150) + 300; render(); },
  pf: (d) => { ui.people.filter = d.k; render(); },
  filterSheet: () => filterSheet(),
  newTxn: (d) => {
    const init = {};
    if (d.type) init.type = d.type;
    if (d.acc) init.acc = d.acc;
    if (d.person) { init.person = d.person; }
    if (d.kuri) init.kuri = d.kuri;
    if (d.asset) init.asset = d.asset;
    if (d.project) init.project = d.project;
    if (d.against) init.against = d.against;
    if (d.person && !d.acc && ['waive', 'waived'].includes(d.type)) init.acc = null;
    if (d.person && d.against) { const l = [...personLoans(d.person).given, ...personLoans(d.person).borrowed].find(x => x.t.id === d.against); if (l) { if (l.t.acc && acc(l.t.acc)?.cur === l.cur && !['waive', 'waived'].includes(d.type)) init.acc = l.t.acc; else if (!['waive', 'waived'].includes(d.type)) init.acc = defaultAccountFor(l.cur); else init.cur = l.cur; if (d.type !== 'waive' && d.type !== 'waived') init.amt = l.pending; } }
    if (d.type === 'transfer' && d.acc) init.to = D().accounts.find(a => a.id !== d.acc && !a.closed)?.id;
    txnForm(init);
  },
  editTxn: (d) => txnForm({ id: d.id }),
  closeSheet: () => closeSheet(),
  sheetOk: () => topSheet()?.ok?.(),
  fgroup: (d) => {
    const f = topSheet().f;
    const map = { expense: 'expense', income: 'income', transfer: 'transfer', loan: 'lend', kuri: 'kuri_pay', invest: 'invest' };
    const was = f.type; f.type = map[d.k];
    if ((was === 'expense' || was === 'income') && was !== f.type) f.cat = null;
    if (f.type === 'transfer' && (!f.to || f.to === f.acc)) f.to = D().accounts.find(a => a.id !== f.acc && !a.closed)?.id;
    refreshSheet();
  },
  fset: (d) => {
    const f = topSheet().f;
    const v = d.v === '' ? null : d.v;
    if (d.k === 'cat' && f.cat !== v) f.sub = '';
    if (d.k === 'sub' && f.sub === v) { f.sub = ''; refreshSheet(); return; }
    f[d.k] = v;
    if (d.k === 'type' && (v === 'expense' || v === 'income')) f.cat = null;
    if (d.k === 'type' && v === 'lend' || d.k === 'type' && v === 'borrow') f.against = null;
    if (d.k === 'against' && v && f.person) {
      const l = [...personLoans(f.person).given, ...personLoans(f.person).borrowed].find(x => x.t.id === v);
      if (l && (!f.amtStr || f._autoAmt)) { f.amtStr = String(l.pending); f._autoAmt = true; }
    }
    refreshSheet();
  },
  ftoggleRepeat: () => { const f = topSheet().f; f.repeat = !f.repeat; refreshSheet(); },
  pickPerson: () => pickPerson(topSheet().f),
  pickCat: () => pickCat(topSheet().f),
  pickKuri: () => pickKuri(topSheet().f),
  pickAsset: () => pickAsset(topSheet().f),
  pickOne: (d) => topSheet().pick(d.id),
  pickNew: () => topSheet().pickNew(),
  saveTxn: () => saveTxn(topSheet()),
  delTxn: () => {
    const s = topSheet();
    confirmSheet('Delete this entry?', 'It will be removed from all balances.', 'Delete', () => {
      const t = D().txns.find(x => x.id === s.editing.id);
      D().txns = D().txns.filter(x => x.id !== s.editing.id);
      store.save(); closeAllSheets(); render();
      toast('Entry deleted', { label: 'Undo', fn: () => { D().txns.push(t); store.save(); render(); } });
    });
  },
  formSet: (d) => { const s = topSheet(); s.v[d.k] = d.v === 'true' ? true : d.v === 'false' ? false : d.v; refreshSheet(); },
  formSave: () => topSheet().save(),
  formDel: () => topSheet().del?.(),
  editAccount: (d) => editAccount(d.id),
  editKuri: (d) => editKuri(d.id),
  editAsset: (d) => editAsset(d.id),
  editPerson: (d) => editPerson(d.id),
  editCat: (d) => editCat(d.id, d.kind),
  editRec: (d) => editRec(d.id),
  adjustBal: (d) => adjustBalance(d.id),
  setValue: (d) => setValue(d.id),
  newPerson: () => formSheet({ title: 'New person', values: {}, fields: [{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone (optional)' }], onSave: (v) => { if (!v.name?.trim()) return 'Enter a name'; D().people.push({ id: newId('p'), name: v.name.trim(), phone: v.phone?.trim() || undefined }); } }),
  sharePerson: (d) => sharePerson(d.id),
  shareImg: (d) => shareStatement(d.id, true),
  shareTxt: (d) => shareStatement(d.id, false),
  toggleLoan: (d) => { ui.openLoan = ui.openLoan === d.id ? null : d.id; render(); },
  personAll: (d) => { ui.personAll = ui.personAll === d.id ? null : d.id; render(); },
  doRec: (d) => {
    const r = D().recurring.find(x => x.id === d.id);
    txnForm({ type: r.type, amt: r.amt, acc: r.acc, to: r.to, cat: r.cat, sub: r.sub, amt2: r.amt2, note: r.note, date: r.next > todayISO() ? todayISO() : r.next, fromRec: r.id });
  },
  skipRec: (d) => { const r = D().recurring.find(x => x.id === d.id); r.next = addMonths(r.next, 1, r.day); store.save(); render(); toast('Skipped this month'); },
  repMode: (d) => { ui.report.mode = d.k; render(); },
  repCur: (d) => { ui.report.cur = d.k; render(); },
  editProject: (d) => editProject(d.id),
  assetToProject: (d) => assetToProject(d.id),
  zYear: (d) => { ui.zakatYear = d.k; const top = ui.stack[ui.stack.length - 1]; if (top) top.id = d.k; render(); },
  zInc: (d) => { const st = yearState(ui.zakatYear); if (st.locked) return toast('Unlock the year to change this'); st.include[d.k] = !st.include[d.k]; store.save(); render(); },
  zPay: (d) => { const cat = ensureZakatCat(); store.save(); txnForm({ type: 'expense', cat, zakatYear: d.k }); },
  zGold: (d) => {
    const st = yearState(d.k);
    formSheet({ title: `Gold price · ${d.k}`, values: { gold: st.goldPrice ?? '', rate: st.rate ?? rate() },
      fields: [
        { type: 'note', text: () => 'Price of 1 gram of 24K gold in AED on 31 December. Nisab = 85 g × this price.' },
        { key: 'gold', label: 'Gold price per gram (AED)', type: 'number' },
        { key: 'rate', label: 'AED → INR rate (only for the nisab check)', type: 'number' },
      ],
      onSave: (v) => { const g = evalAmount(v.gold); if (!(g > 0)) return 'Enter the gold price'; st.goldPrice = g; const r = evalAmount(v.rate); if (r > 0) st.rate = r; } });
  },
  zLock: (d) => {
    const st = yearState(d.k);
    if (st.locked) { unlockYear(d.k); store.save(); render(); toast('Unlocked – showing live balances'); return; }
    confirmSheet(`Finalise zakat ${d.k}?`, 'The amounts are saved as they are now, so later edits to old entries will not change this year’s zakat. You can unlock it any time.', 'Finalise', () => { lockYear(d.k); store.save(); render(); toast('Zakat ' + d.k + ' finalised'); }, false);
  },
  repNav: (d) => {
    const r = ui.report;
    if (r.mode === 'month') r.ym = addMonths(r.ym + '-01', +d.d, 1).slice(0, 7);
    else r.y = String(+r.y + +d.d);
    render();
  },
  repMonth: (d) => { ui.report.mode = 'month'; ui.report.ym = d.ym; render(); },
  editRate: () => formSheet({ title: 'INR rate', values: { rate: rate() }, fields: [{ key: 'rate', label: '1 AED = ₹', type: 'number' }, { type: 'note', text: () => 'Used to show INR balances in AED totals and as the starting rate for new INR entries. Each AED→INR transfer you record with both amounts updates it automatically.' }], onSave: (v) => { const r = evalAmount(v.rate); if (!(r > 0)) return 'Enter a rate'; D().settings.inrRate = r; } }),
  backup: () => doBackup(),
  driveShare: () => driveShare(),
  driveMode: () => driveModeSheet(),
  driveNow: () => { closeSheet(); driveUpload(false); },
  setDriveMode: (d) => {
    const dr = (D().settings.drive ||= {});
    if (d.k === 'auto' && dr.mode !== 'auto') {
      if (!isNative()) return toast('Automatic Drive backup works in the Android app');
      closeSheet(); toast('Opening Google sign-in…'); window.KanakkuNative.driveConnect(); return;
    }
    dr.mode = d.k; store.save(); refreshSheet(); render();
  },
  toggleBio: () => {
    const s = D().settings;
    if (!s.pinHash) return toast('Turn on App lock (PIN) first');
    s.bio = !s.bio; store.save(); render(); toast(s.bio ? 'Fingerprint unlock is on' : 'Fingerprint unlock is off');
  },
  restore: () => doRestore(),
  importVyapar: () => importVyaparSheet(false),
  vyPick: async () => { const s = topSheet(); const f = await pickFile(); if (f) { s.st.vyb = f; refreshSheet(); } },
  vyRules: async () => { const s = topSheet(); const f = await pickFile('.json,application/json'); if (f) { s.st.rules = f; refreshSheet(); } },
  vyGo: () => runVyaparImport(topSheet().st),
  exportCsv: () => exportCsv(),
  setPin: () => {
    if (D().settings.pinHash) confirmSheet('App lock', 'Turn off the PIN or choose a new one.', 'Turn off', () => { delete D().settings.pinHash; delete D().settings.bio; store.save(); render(); toast('App lock is off'); }, true);
    else showLock({ mode: 'set' });
  },
  theme: () => {
    const order = ['auto', 'light', 'dark'];
    const s = D().settings; s.theme = order[(order.indexOf(s.theme || 'auto') + 1) % 3];
    applyTheme(); store.save(); render();
  },
  wipe: () => confirmSheet('Delete all data?', 'Every entry, account and person will be erased from this phone. Save a backup first if you might need it.', 'Delete everything', async () => {
    await store.replace(emptyData()); ui.stack = []; ui.tab = 'home'; await welcome();
  }),
  welcomeRestore: () => doRestore(),
  welcomeImport: () => importVyaparSheet(true),
  welcomeFresh: async () => { await store.replace(emptyData()); applyTheme(); render(); },
};

function filterSheet() {
  const st = ui.act;
  const months = [...new Set(D().txns.map(t => t.date.slice(0, 7)))].sort().reverse();
  openSheet({
    title: 'Filter',
    render: () => `
      <div class="field"><div class="lbl">Month</div><select class="input" data-in="flt" data-k="month"><option value="">All time</option>${months.map(mo => `<option value="${mo}" ${st.month === mo ? 'selected' : ''}>${fmtMonth(mo)}</option>`).join('')}</select></div>
      <div class="field"><div class="lbl">Account</div><select class="input" data-in="flt" data-k="acc"><option value="">All accounts</option>${D().accounts.map(a => `<option value="${a.id}" ${st.acc === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><div class="lbl">Category</div><select class="input" data-in="flt" data-k="cat"><option value="">All categories</option>${D().categories.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${st.cat === c.id ? 'selected' : ''}>${c.kind === 'income' ? '↓ ' : ''}${esc(c.name)}</option>`).join('')}</select></div>
      ${D().projects.length ? `<div class="field"><div class="lbl">Project</div><select class="input" data-in="flt" data-k="project"><option value="">Any</option>${D().projects.map(p => `<option value="${p.id}" ${st.project === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><div class="lbl">Person</div><select class="input" data-in="flt" data-k="person"><option value="">Anyone</option>${[...D().people].sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${p.id}" ${st.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`,
    foot: () => `<button class="btn ghost" data-a="fltClear">Clear</button><button class="btn primary" data-a="closeSheet">Show results</button>`,
  });
}
actions.fltClear = () => { Object.assign(ui.act, { month: '', acc: '', cat: '', person: '', project: '', type: 'all', q: '' }); closeSheet(); render(); };

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const fn = actions[el.dataset.a];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

let qTimer;
document.addEventListener('input', (e) => {
  const el = e.target; const k = el.dataset.in;
  if (!k) return;
  const s = topSheet();
  switch (k) {
    case 'actq': ui.act.q = el.value; ui.act.limit = 150; clearTimeout(qTimer); qTimer = setTimeout(() => { render(); const i = document.getElementById('actq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); break;
    case 'pq': ui.people.q = el.value; clearTimeout(qTimer); qTimer = setTimeout(() => { render(); const i = app.querySelector('[data-in="pq"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); break;
    case 'famt': {
      s.f.amtStr = el.value;
      const v = evalAmount(el.value); const c = document.getElementById('calc');
      if (c) c.textContent = /[+\-*/]/.test(el.value.replace(/^-/, '')) && Number.isFinite(v) ? '= ' + money(v, curOf(s.f)) : '';
      const a2 = document.getElementById('amt2');
      if (a2) { const toCur = acc(s.f.to).cur; const est = curOf(s.f) === 'AED' ? v * rate() : v / rate(); a2.placeholder = v ? String(Math.round(est * 100) / 100) : '0'; const n = document.getElementById('fxnote'); if (n) n.innerHTML = fxNote(s.f, curOf(s.f), toCur); }
      break;
    }
    case 'famt2': { s.f.amt2Str = el.value; const n = document.getElementById('fxnote'); if (n) n.innerHTML = fxNote(s.f, curOf(s.f), acc(s.f.to).cur); break; }
    case 'fsub': s.f.sub = el.value; break;
    case 'fdate': s.f.date = el.value; break;
    case 'fnote': s.f.note = el.value; break;
    case 'form': s.v[el.dataset.k] = el.value; if (el.tagName === 'SELECT') refreshSheet(); break;
    case 'pickq': { s.st.q = el.value; const pos = el.selectionStart; refreshSheet(); const i = layer.querySelector('[data-in="pickq"]'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } break; }
    case 'vyRate': s.st.rate = el.value; break;
    case 'flt': ui.act[el.dataset.k] = el.value; ui.act.limit = 150; render(); break;
  }
});

function goBack() {
  if (document.querySelector('.lock')) return true;
  if (ui.sheets.length) { closeSheet(); return true; }
  if (ui.stack.length) { ui.stack.pop(); render(); return true; }
  if (ui.tab !== 'home') { ui.tab = 'home'; render(); return true; }
  return false;
}
window.kanakkuBack = goBack;

function applyTheme() {
  const t = D()?.settings.theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ======================================================================
// Start
// ======================================================================
async function welcome() {
  closeAllSheets();
  app.innerHTML = `<div class="welcome">
    <img class="logo" src="icon-512.png" alt="">
    <h1>Kanakku</h1>
    <p>Your money, people, kuri and investments, in one place. Works fully offline; nothing leaves your phone.</p>
    <button class="btn primary block" data-a="welcomeImport">📥 Import my Vyapar backup</button>
    <button class="btn ghost block" data-a="welcomeRestore">${icon('upload')} Restore a Kanakku backup</button>
    <button class="btn ghost block" data-a="welcomeFresh">Start fresh</button>
  </div>`;
}

async function start() {
  await store.load();
  if (!store.data) { store.data = emptyData(); applyTheme(); await welcome(); return; }
  applyTheme();
  render();
  if (D().settings.pinHash) showLock({});
  const lb = await store.getMeta('lastBackup');
  const days = lb ? (Date.now() - Date.parse(lb)) / 864e5 : 999;
  if (monthlyBackupCheck()) return;
  if (days > 7 && D().txns.length > 20) setTimeout(() => toast(lb ? 'It has been a week since your last backup' : 'Save a backup to keep your data safe', { label: 'Back up', fn: doBackup }), 1200);
}

store.listeners.add(() => {});
start().catch(e => { app.innerHTML = `<div class="welcome"><h1>Something went wrong</h1><p>${esc(e.message)}</p></div>`; });
