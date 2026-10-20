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
  for (const k of ['accounts', 'categories', 'people', 'kuris', 'assets', 'recurring', 'txns']) d[k] ||= [];
}

export const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- Lookups
export const byId = (list, id) => list.find(x => x.id === id);
export const acc = (id) => byId(store.data.accounts, id);
export const catOf = (id) => byId(store.data.categories, id);
export const personOf = (id) => byId(store.data.people, id);
export const kuriOf = (id) => byId(store.data.kuris, id);
export const assetOf = (id) => byId(store.data.assets, id);

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
export const rate = () => Number(store.data.settings.inrRate) || 24;
/** Value of a transaction's main amount in AED. */
export function toAED(amt, cur, fx) {
  if (cur === 'INR') return amt / (fx || rate());
  return amt;
}
export const tAED = (t) => toAED(t.amt, t.cur, t.fx);

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

export function accountBalances() {
  const b = {};
  for (const a of store.data.accounts) b[a.id] = Number(a.opening) || 0;
  for (const t of store.data.txns) {
    if (t.type === 'transfer') {
      if (t.acc in b) b[t.acc] -= t.amt;
      if (t.to in b) b[t.to] += (t.amt2 ?? t.amt);
    } else if (t.acc && t.acc in b) {
      b[t.acc] += t.type === 'adjust' ? t.amt : (TYPES[t.type]?.dir || 0) * t.amt;
    }
  }
  for (const k in b) b[k] = Math.round(b[k] * 100) / 100;
  return b;
}

/** Ledger side of a txn for people/kuri/assets: { amt, cur } */
export const side = (t) => ({ amt: t.amt2 ?? t.amt, cur: t.cur2 || t.cur });

export function personLedger(pid) {
  return store.data.txns.filter(t => t.person === pid && ['lend', 'collect', 'borrow', 'repay', 'person_adjust'].includes(t.type));
}
const PSIGN = { lend: 1, repay: 1, collect: -1, borrow: -1, person_adjust: 1 };
/** Map personId -> {AED: n, INR: n}. Positive = they owe you. */
export function peopleBalances() {
  const m = new Map();
  for (const t of store.data.txns) {
    const s = PSIGN[t.type];
    if (!s || !t.person) continue;
    const { amt, cur } = side(t);
    const e = m.get(t.person) || { AED: 0, INR: 0 };
    e[cur] = (e[cur] || 0) + s * amt;
    m.set(t.person, e);
  }
  for (const e of m.values()) for (const k in e) e[k] = Math.round(e[k] * 100) / 100;
  return m;
}
export function personAED(e) { return (e?.AED || 0) + (e?.INR || 0) / rate(); }

export function kuriSummary(kid) {
  let paid = 0, got = 0, n = 0; const list = [];
  for (const t of store.data.txns) {
    if (t.kuri !== kid) continue;
    list.push(t);
    const v = toAED(side(t).amt, side(t).cur, t.fx);
    if (t.type === 'kuri_pay') { paid += v; n++; } else if (t.type === 'kuri_get') got += v;
  }
  return { paid, got, net: paid - got, count: n, list };
}

export function assetSummary(sid) {
  let invested = 0, returned = 0; const list = [];
  for (const t of store.data.txns) {
    if (t.asset !== sid) continue;
    list.push(t);
    const v = toAED(side(t).amt, side(t).cur, t.fx);
    if (t.type === 'invest') invested += v; else if (t.type === 'asset_in') returned += v;
  }
  const a = assetOf(sid);
  const net = invested - returned;
  const value = a?.value != null && a.value !== '' ? toAED(Number(a.value), a.cur || 'AED') : net;
  return { invested, returned, net, value, gain: value - net, list };
}

export function netWorth() {
  const bal = accountBalances();
  let cash = 0, cards = 0;
  for (const a of store.data.accounts) {
    if (a.closed && Math.abs(bal[a.id]) < 0.01) continue;
    const v = toAED(bal[a.id], a.cur);
    if (a.kind === 'card') cards += v; else cash += v;
  }
  let owed = 0, owe = 0;
  for (const e of peopleBalances().values()) { const v = personAED(e); if (v > 0) owed += v; else owe -= v; }
  let assets = 0; for (const s of store.data.assets) assets += assetSummary(s.id).value;
  let kuri = 0; for (const k of store.data.kuris) if (k.status !== 'closed') kuri += Math.max(0, kuriSummary(k.id).net);
  return { cash, cards, owed, owe, assets, kuri, total: cash + cards + owed - owe + assets + kuri };
}

export const monthKey = (d) => d.slice(0, 7);
export function monthTotals(month) {
  let spent = 0, earned = 0; const byCat = new Map();
  for (const t of store.data.txns) {
    if (!t.date.startsWith(month)) continue;
    if (t.type === 'expense') { const v = tAED(t); spent += v; byCat.set(t.cat, (byCat.get(t.cat) || 0) + v); }
    else if (t.type === 'income') earned += tAED(t);
  }
  return { spent, earned, byCat };
}

// ---------- Formatting
const fmtAED = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const fmtINR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export function money(n, cur = 'AED', opts = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const f = cur === 'INR' ? fmtINR : fmtAED;
  let s = opts.short && abs >= 10000 ? shortNum(abs, cur) : f.format(Math.round(abs * 100) / 100);
  const sym = cur === 'INR' ? '₹' : 'AED ';
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
