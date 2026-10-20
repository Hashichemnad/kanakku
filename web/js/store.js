// Data layer: persistence (IndexedDB) and all money calculations.

const DB_NAME = 'kanakku';
const STORE = 'kv';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

export function emptyData() {
  return {
    version: 1,
    settings: { baseCur: 'AED', inrRate: 24, theme: 'auto' },
    accounts: [
      { id: 'a_cash', name: 'Cash', kind: 'cash', cur: 'AED', opening: 0 },
    ],
    categories: [
      ['expense', 'Food', '🍽️'], ['expense', 'Grocery', '🛒'], ['expense', 'Transport', '🚕'], ['expense', 'Rent', '🏠'],
      ['expense', 'Bills', '💡'], ['expense', 'Mobile', '📱'], ['expense', 'Shopping', '🛍️'], ['expense', 'Health', '🏥'],
      ['expense', 'Family', '👨‍👩‍👦'], ['expense', 'Travel', '✈️'], ['expense', 'Misc', '📦'],
      ['income', 'Salary', '💰'], ['income', 'Cashback', '🎁'], ['income', 'Other income', '💵'],
    ].map(([kind, name, icon], i) => ({ id: 'c' + i, kind, name, icon })),
    people: [], kuris: [], assets: [], recurring: [], txns: [],
  };
}

export const store = {
  data: null,
  listeners: new Set(),
  async load() {
    this.data = (await idbGet('data')) || null;
    if (this.data) migrate(this.data);
    return this.data;
  },
  async replace(data) {
    migrate(data);
    this.data = data;
    await idbSet('data', data);
    this.emit();
  },
  _t: null,
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => idbSet('data', this.data).catch(e => console.error(e)), 150);
    this.emit();
  },
  async flush() { clearTimeout(this._t); await idbSet('data', this.data); },
  emit() { for (const f of this.listeners) f(); },
  async getMeta(k) { return idbGet('meta:' + k); },
  async setMeta(k, v) { return idbSet('meta:' + k, v); },
};

function migrate(d) {
  d.settings ||= {};
  d.settings.baseCur ||= 'AED';
  d.settings.inrRate ||= 24;
  for (const k of ['accounts', 'categories', 'people', 'kuris', 'assets', 'recurring', 'txns', 'projects']) d[k] ||= [];
  d.zakat ||= { years: {} };
  d.zakat.years ||= {};
  for (const a of d.assets) {
    if (!a.values) { a.values = {}; if (a.value != null && a.value !== '') a.values[a.cur || 'AED'] = Number(a.value); }
    delete a.value;
  }
}

export const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- Lookups
export const byId = (list, id) => list.find(x => x.id === id);
export const acc = (id) => byId(store.data.accounts, id);
export const catOf = (id) => byId(store.data.categories, id);
export const personOf = (id) => byId(store.data.people, id);
export const kuriOf = (id) => byId(store.data.kuris, id);
export const assetOf = (id) => byId(store.data.assets, id);
export const projectOf = (id) => byId(store.data.projects, id);

// ---------- Type metadata
export const TYPES = {
  expense:       { label: 'Expense',           dir: -1, color: 'out' },
  income:        { label: 'Income',            dir: 1,  color: 'in' },
  transfer:      { label: 'Transfer',          dir: 0,  color: 'move' },
  lend:          { label: 'Lent',              dir: -1, color: 'lend' },
  collect:       { label: 'Got back',          dir: 1,  color: 'lend' },
  borrow:        { label: 'Borrowed',          dir: 1,  color: 'borrow' },
  repay:         { label: 'Repaid',            dir: -1, color: 'borrow' },
  kuri_pay:      { label: 'Kuri instalment',   dir: -1, color: 'kuri' },
  kuri_get:      { label: 'Kuri received',     dir: 1,  color: 'kuri' },
  invest:        { label: 'Invested',          dir: -1, color: 'invest' },
  asset_in:      { label: 'Investment return', dir: 1,  color: 'invest' },
  adjust:        { label: 'Balance correction', dir: 1, color: 'move' },
  person_adjust: { label: 'Correction',       dir: 0,  color: 'lend' },
};

// ---------- Money helpers
// Amounts are never converted between AED and INR for totals; each currency is kept on its own.
export const CURS = ['AED', 'INR'];
export const rate = () => Number(store.data.settings.inrRate) || 24;
export const zero = () => ({ AED: 0, INR: 0 });
export const addTo = (o, cur, v) => { o[cur] = (o[cur] || 0) + v; return o; };
export const r2 = (n) => Math.round(n * 100) / 100;
export function toAED(amt, cur, fx) { return cur === 'INR' ? amt / (fx || rate()) : amt; }

/** Signed effect of t on account id. */
export function effectOn(t, accountId) {
  if (t.type === 'transfer') {
    let e = 0;
    if (t.acc === accountId) e -= t.amt;
    if (t.to === accountId) e += (t.amt2 ?? t.amt);
    return e;
  }
  if (t.acc !== accountId) return 0;
  if (t.type === 'adjust') return t.amt;
  return (TYPES[t.type]?.dir || 0) * t.amt;
}

/** Account balances, optionally as of the end of a date (inclusive). */
export function accountBalances(upto) {
  const b = {};
  for (const a of store.data.accounts) b[a.id] = Number(a.opening) || 0;
  for (const t of store.data.txns) {
    if (upto && t.date > upto) continue;
    if (t.type === 'transfer') {
      if (t.acc in b) b[t.acc] -= t.amt;
      if (t.to in b) b[t.to] += (t.amt2 ?? t.amt);
    } else if (t.acc && t.acc in b) {
      b[t.acc] += t.type === 'adjust' ? t.amt : (TYPES[t.type]?.dir || 0) * t.amt;
    }
  }
  for (const k in b) b[k] = r2(b[k]);
  return b;
}

/** Ledger side of a txn for people/kuri/assets: { amt, cur } */
export const side = (t) => ({ amt: t.amt2 ?? t.amt, cur: t.cur2 || t.cur });

export function personLedger(pid) {
  return store.data.txns.filter(t => t.person === pid && ['lend', 'collect', 'borrow', 'repay', 'person_adjust'].includes(t.type));
}
const PSIGN = { lend: 1, repay: 1, collect: -1, borrow: -1, person_adjust: 1 };
/** Map personId -> {AED, INR}. Positive = they owe you. */
export function peopleBalances(upto) {
  const m = new Map();
  for (const t of store.data.txns) {
    const s = PSIGN[t.type];
    if (!s || !t.person) continue;
    if (upto && t.date > upto) continue;
    const { amt, cur } = side(t);
    const e = m.get(t.person) || zero();
    e[cur] = (e[cur] || 0) + s * amt;
    m.set(t.person, e);
  }
  for (const e of m.values()) for (const k in e) e[k] = r2(e[k]);
  return m;
}
/** Used only for sorting / deciding owes-vs-owed when a person has both currencies. */
export function personAED(e) { return (e?.AED || 0) + (e?.INR || 0) / rate(); }
export const isZero = (o) => CURS.every(c => Math.abs(o?.[c] || 0) < 0.005);

export function kuriSummary(kid) {
  const paid = zero(), got = zero(); let n = 0; const list = [];
  for (const t of store.data.txns) {
    if (t.kuri !== kid) continue;
    list.push(t);
    const s = side(t);
    if (t.type === 'kuri_pay') { addTo(paid, s.cur, s.amt); n++; } else if (t.type === 'kuri_get') addTo(got, s.cur, s.amt);
  }
  const net = { AED: paid.AED - got.AED, INR: paid.INR - got.INR };
  return { paid, got, net, count: n, list };
}

export function assetSummary(sid, upto) {
  const invested = zero(), returned = zero(); const list = [];
  for (const t of store.data.txns) {
    if (t.asset !== sid) continue;
    if (upto && t.date > upto) continue;
    list.push(t);
    const s = side(t);
    if (t.type === 'invest') addTo(invested, s.cur, s.amt); else if (t.type === 'asset_in') addTo(returned, s.cur, s.amt);
  }
  const a = assetOf(sid);
  const net = { AED: invested.AED - returned.AED, INR: invested.INR - returned.INR };
  const value = {};
  const hasValue = {};
  for (const c of CURS) {
    const v = a?.values?.[c];
    hasValue[c] = v != null && v !== '';
    value[c] = hasValue[c] ? Number(v) : net[c];
  }
  const gain = { AED: value.AED - net.AED, INR: value.INR - net.INR };
  return { invested, returned, net, value, hasValue, gain, list };
}

export function projectSummary(pid) {
  const spent = zero(); const list = []; const byCat = new Map();
  for (const t of store.data.txns) {
    if (t.project !== pid) continue;
    list.push(t);
    const v = TYPES[t.type]?.dir === 1 ? -t.amt : t.amt;
    addTo(spent, t.cur, v);
    const k = t.cat || t.type;
    byCat.set(k, addTo(byCat.get(k) || zero(), t.cur, v));
  }
  return { spent, list, byCat };
}

/** Net worth per currency, optionally as of a date. Kuri is shown separately (not wealth). */
export function netWorth(upto) {
  const bal = accountBalances(upto);
  const out = {};
  for (const c of CURS) out[c] = { cash: 0, cards: 0, owed: 0, owe: 0, assets: 0, total: 0 };
  for (const a of store.data.accounts) {
    const o = out[a.cur || 'AED'];
    if (a.kind === 'card') o.cards += bal[a.id]; else o.cash += bal[a.id];
  }
  for (const e of peopleBalances(upto).values()) for (const c of CURS) { const v = e[c] || 0; if (v > 0) out[c].owed += v; else out[c].owe -= v; }
  for (const s of store.data.assets) { const v = assetSummary(s.id, upto).value; for (const c of CURS) out[c].assets += v[c]; }
  for (const c of CURS) { const o = out[c]; o.total = o.cash + o.cards + o.owed - o.owe + o.assets; }
  return out;
}

export function kuriTotals() {
  const net = zero();
  for (const k of store.data.kuris) if (k.status !== 'closed') { const s = kuriSummary(k.id).net; for (const c of CURS) net[c] += Math.max(0, s[c]); }
  return net;
}

export const monthKey = (d) => d.slice(0, 7);
/** Spending/earning for a period prefix ('2026-10' or '2026'), per currency. */
export function periodTotals(prefix) {
  const out = {};
  for (const c of CURS) out[c] = { spent: 0, earned: 0, byCat: new Map(), incCat: new Map() };
  for (const t of store.data.txns) {
    if (!t.date.startsWith(prefix)) continue;
    const o = out[t.cur || 'AED'];
    if (!o) continue;
    if (t.type === 'expense') { o.spent += t.amt; o.byCat.set(t.cat, (o.byCat.get(t.cat) || 0) + t.amt); }
    else if (t.type === 'income') { o.earned += t.amt; o.incCat.set(t.cat, (o.incCat.get(t.cat) || 0) + t.amt); }
  }
  return out;
}
export const monthTotals = periodTotals;

// ---------- Formatting
const fmtAED = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtINR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export function money(n, cur = 'AED', opts = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const f = cur === 'INR' ? fmtINR : fmtAED;
  let s = opts.short && abs >= 10000 ? shortNum(abs, cur) : f.format(Math.round(abs * 100) / 100);
  const sym = opts.nosym ? '' : cur === 'INR' ? '₹' : 'AED ';
  const sign = v < 0 ? '−' : opts.plus && v > 0 ? '+' : '';
  return `${sign}${sym}${s}`;
}
function shortNum(n, cur) {
  if (cur === 'INR') {
    if (n >= 1e7) return (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr';
    return (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' L';
  }
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
}

/** Format a {AED, INR} object, skipping zero currencies. */
export function multi(o, opts = {}) {
  const parts = CURS.filter(c => Math.abs(o?.[c] || 0) >= 0.005).map(c => money(opts.abs ? Math.abs(o[c]) : o[c], c, opts));
  return parts.length ? parts.join(opts.sep || ' · ') : money(0, opts.cur || 'AED');
}

export const todayISO = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = todayISO();
  if (iso === t) return 'Today';
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const yISO = new Date(yd.getTime() - yd.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (iso === yISO) return 'Yesterday';
  return `${d} ${MONTHS[m - 1]}${withYear || String(y) !== t.slice(0, 4) ? ' ' + y : ''}`;
}
export const fmtMonth = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
export const MONTH_NAMES = MONTHS;

/** Evaluate simple arithmetic like "120+35.5-10" safely. */
export function evalAmount(s) {
  const clean = String(s || '').replace(/,/g, '').replace(/[×x]/g, '*').replace(/÷/g, '/').trim();
  if (!clean) return 0;
  if (!/^[0-9+\-*/().\s]+$/.test(clean)) return NaN;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function('"use strict";return (' + clean + ')')();
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
  } catch { return NaN; }
}

// ---------- Recurring
export function addMonths(iso, n, day) {
  const [y, m] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, last));
  return dt.toISOString().slice(0, 10);
}
export function dueRecurring() {
  const t = todayISO();
  return store.data.recurring.filter(r => r.active !== false && r.next && r.next <= addDays(t, 3));
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
