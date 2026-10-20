// Zakat: calculated on 31 December of each year from balances on that date.
import { store, accountBalances, peopleBalances, assetSummary, CURS, zero, r2, rate, todayISO, newId } from './store.js';

export const NISAB_GOLD_GRAMS = 85;
export const ZAKAT_RATE = 0.025;
export const DEFAULT_INCLUDE = { owed: true, owe: true, cards: true, invest: false, gold: false };

export const zakatCats = () => store.data.categories.filter(c => c.kind === 'expense' && /^zaka/i.test(c.name)).map(c => c.id);
export function ensureZakatCat() {
  const ids = zakatCats();
  if (ids.length) return ids[0];
  const c = { id: newId('c'), kind: 'expense', name: 'Zakat', icon: '🤲' };
  store.data.categories.push(c);
  return c.id;
}

export function yearState(y) {
  const z = store.data.zakat;
  z.years[y] ||= {};
  const s = z.years[y];
  s.include ||= { ...DEFAULT_INCLUDE };
  return s;
}

/** Which zakat year a payment belongs to. */
export function paymentYear(t) {
  if (t.zakatYear) return String(t.zakatYear);
  const m = String(t.note || '').match(/\b(20\d\d)\b/);
  if (m) return m[1];
  return String(+t.date.slice(0, 4) - 1);
}

export function paymentsFor(y) {
  const cats = new Set(zakatCats());
  return store.data.txns.filter(t => t.type === 'expense' && cats.has(t.cat) && paymentYear(t) === String(y));
}

/** Compute zakat for year y (live, from balances on 31 Dec, or today for the running year). */
export function computeZakat(y, inc = yearState(y).include) {
  const end = `${y}-12-31`;
  const today = todayISO();
  const asOf = end > today ? today : end;
  const bal = accountBalances(asOf);
  const comps = {};
  for (const c of CURS) comps[c] = { cash: 0, cards: 0, owed: 0, owe: 0, invest: 0, gold: 0, total: 0 };
  for (const a of store.data.accounts) {
    const o = comps[a.cur || 'AED'];
    if (a.kind === 'card') o.cards += Math.min(0, bal[a.id]);
    else o.cash += bal[a.id];
  }
  for (const e of peopleBalances(asOf).values()) for (const c of CURS) { const v = e[c] || 0; if (v > 0) comps[c].owed += v; else comps[c].owe -= v; }
  for (const s of store.data.assets) {
    const v = assetSummary(s.id, asOf).value;
    for (const c of CURS) { if (s.kind === 'gold') comps[c].gold += v[c]; else if (s.kind === 'investment' || s.kind === 'business') comps[c].invest += v[c]; }
  }
  for (const c of CURS) {
    const o = comps[c];
    o.total = o.cash + (inc.owed ? o.owed : 0) - (inc.owe ? o.owe : 0) + (inc.cards ? o.cards : 0) + (inc.invest ? o.invest : 0) + (inc.gold ? o.gold : 0);
    for (const k in o) o[k] = r2(o[k]);
  }
  return { asOf, final: end <= today, comps };
}

export function zakatView(y) {
  const st = yearState(y);
  const live = st.locked ? null : computeZakat(y, st.include);
  const comps = st.locked ? st.comps : live.comps;
  const goldPrice = Number(st.goldPrice) || 0;
  const fx = Number(st.rate) || rate();
  const nisab = goldPrice ? NISAB_GOLD_GRAMS * goldPrice : 0;
  const combined = comps.AED.total + comps.INR.total / fx;
  const above = nisab ? combined >= nisab : null;
  const due = zero();
  if (above !== false) for (const c of CURS) due[c] = r2(Math.max(0, comps[c].total) * ZAKAT_RATE);
  if (st.locked && st.due) Object.assign(due, st.due);
  const paidList = paymentsFor(y);
  const paid = zero();
  for (const t of paidList) paid[t.cur] = r2((paid[t.cur] || 0) + t.amt);
  const left = { AED: r2(due.AED - paid.AED), INR: r2(due.INR - paid.INR) };
  return { st, comps, asOf: st.locked ? st.date : live.asOf, final: st.locked || live.final, goldPrice, fx, nisab, combined, above, due, paid, left, paidList };
}

export function lockYear(y) {
  const st = yearState(y);
  const v = zakatView(y);
  Object.assign(st, { locked: true, date: v.asOf, comps: v.comps, due: v.due, rate: v.fx });
}
export function unlockYear(y) {
  const st = yearState(y);
  delete st.locked; delete st.comps; delete st.due; delete st.date;
}
