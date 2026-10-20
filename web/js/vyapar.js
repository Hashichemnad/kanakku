// Converts a Vyapar backup database (sql.js Database) into a Kanakku data object.
// Personal mapping rules (name aliases, INR accounts, kuri names, rate) are passed in
// separately so that no personal data lives in the app code.

const uid = (() => { let n = 0; return (p) => `${p}${(++n).toString(36)}`; })();

const PLACE_AND_NOISE = new Set([
  'yasmeen', 'yasmin', 'yasmen', 'ajman', 'aed', 'inr', 'sar', 'rs', 'rupees', 'rupee', 'lakh', 'lak', 'k',
  'cc', 'credit', 'card', 'fine', 'payment', 'paid', 'on', 'amount', 'amnt', 'amt', 'received', 'recieved', 'receievd',
  'will', 'give', 'to', 'given', 'for', 'with', 'all', 'dept', 'loan', 'set', 'done', 'return', 'pending', 'previous',
  'months', 'days', 'remaining', 'and', 'the', 'of', 'from', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
  'sep', 'oct', 'nov', 'dec', 'excess', 'extra', 'balance', 'transfer', 'by', 'via',
]);

export function normaliseName(desc) {
  for (const line of String(desc || '').split('\n')) {
    let s = line.toLowerCase();
    s = s.replace(/₹/g, ' ').replace(/[0-9][0-9,.]*\s*(k|lakh|lak)?/g, ' ').replace(/[^a-z\s]/g, ' ');
    const words = s.split(/\s+/).filter(w => w && !PLACE_AND_NOISE.has(w));
    if (words.length) return words.join(' ').trim();
  }
  return '';
}

const title = (s) => s.replace(/\b[a-z]/g, c => c.toUpperCase());

export function parseRupees(text) {
  if (!text || !/₹|rupee|lakh/i.test(text)) return null;
  const t = text.replace(/,/g, '').toLowerCase();
  const re = /(?:₹\s*([0-9]+(?:\.[0-9]+)?)\s*(lakh|lak|k)?)|(?:([0-9]+(?:\.[0-9]+)?)\s*(lakh|lak|k)?\s*(?:₹|rupees?))/g;
  let m, best = null;
  while ((m = re.exec(t))) {
    let v = parseFloat(m[1] || m[3]);
    const unit = m[2] || m[4];
    if (unit === 'lakh' || unit === 'lak') v *= 100000;
    if (unit === 'k') v *= 1000;
    if (!best || v > best) best = v;
  }
  return best;
}

const round2 = (n) => Math.round(n * 100) / 100;

const CATEGORY_ICONS = {
  hotel: '🍽️', grocery: '🛒', taxi: '🚕', 'bus/metro': '🚇', cafeteria: '☕', electronics: '💻', clothes: '👕',
  barber: '💈', pappa: '👨‍👦', bank: '🏦', hospital: '🏥', mobile: '📱', flight: '✈️', online: '🛍️', traffic: '🚦',
  pumb: '⛽', misc: '📦', trip: '🧳', train: '🚆', 'room rent': '🏠', room: '🛏️', dewa: '💡', sewrage: '🚰',
  'house hold': '🧺', zakath: '🤲', 'drinking water': '💧', education: '📚', car: '🚗', business: '💼', gym: '🏋️',
  event: '🎉', parking: '🅿️', flat: '🏢', rta: '🚘', 'ai subscribe': '🤖', support: '🤝', extra: '➕',
  'other shopping': '🛍️', salary: '💰', cashback: '🎁', 'side earn': '🧑‍💻', 'swedish technology': '💰',
  ajmandof: '💰', 'bank charges': '🏦', refunds: '↩️', 'other income': '💵', 'given (not returnable)': '🎁',
  'construction exp': '🏗️', kuri: '🪙', gold: '🥇', spidev: '🧑‍💻', ktc: '📈',
};

export function convertVyapar(db, rules = {}) {
  const rate = Number(rules.inrRate) || 24;
  const inrAccounts = new Set((rules.inrAccounts || []).map(s => s.toLowerCase()));
  const kuriNames = new Set((rules.kuris || []).map(s => s.toLowerCase()));
  const aliases = {};
  for (const [k, v] of Object.entries(rules.aliases || {})) aliases[normaliseName(k)] = v;

  const q = (sql, params = []) => {
    const st = db.prepare(sql); st.bind(params); const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free(); return out;
  };

  const warnings = [];
  const data = {
    version: 1,
    settings: { baseCur: 'AED', inrRate: rate, importedAt: new Date().toISOString(), source: 'vyapar' },
    accounts: [], categories: [], people: [], kuris: [], assets: [], recurring: [], txns: [],
  };

  // ---- Accounts
  const accById = {};
  const cardRe = /credit|\bcc\b/i;
  for (const p of q('select * from kb_paymentTypes order by paymentType_id')) {
    if (p.paymentType_type === 'CHEQUE') continue;
    const name = String(p.paymentType_name).trim();
    const cur = inrAccounts.has(name.toLowerCase()) ? 'INR' : 'AED';
    const kind = p.paymentType_type === 'CASH' ? 'cash' : cardRe.test(name) ? 'card' : 'bank';
    const a = { id: uid('a'), name: prettyAccount(name), kind, cur, opening: round2((p.paymentType_opening_balance || 0) * (cur === 'INR' ? rate : 1)), closed: false };
    data.accounts.push(a); accById[p.paymentType_id] = a;
  }
  const conv = (acc, aed) => acc.cur === 'INR' ? round2(aed * rate) : round2(aed);

  // ---- Lookups
  const catMap = new Map();
  const cat = (kind, name) => {
    const key = kind + ':' + name.toLowerCase();
    if (!catMap.has(key)) {
      const c = { id: uid('c'), kind, name: title(name), icon: CATEGORY_ICONS[name.toLowerCase()] || (kind === 'income' ? '💵' : '🏷️') };
      catMap.set(key, c); data.categories.push(c);
    }
    return catMap.get(key).id;
  };
  const personMap = new Map();
  const person = (desc) => {
    let n = normaliseName(desc);
    if (aliases[n] !== undefined) n = aliases[n];
    else n = n ? title(n) : 'Unknown';
    const key = n.toLowerCase();
    if (!personMap.has(key)) { const p = { id: uid('p'), name: n }; personMap.set(key, p); data.people.push(p); }
    return personMap.get(key).id;
  };
  const kuriMap = new Map();
  const kuri = (name) => {
    const key = name.toLowerCase();
    if (!kuriMap.has(key)) { const k = { id: uid('k'), name: title(name), cur: 'AED', status: 'active' }; kuriMap.set(key, k); data.kuris.push(k); }
    return kuriMap.get(key).id;
  };
  const assetMap = new Map();
  const asset = (name, kind) => {
    const key = name.toLowerCase();
    if (!assetMap.has(key)) { const a = { id: uid('s'), name, kind, cur: 'AED', value: null }; assetMap.set(key, a); data.assets.push(a); }
    return assetMap.get(key).id;
  };

  const items = {};
  for (const i of q('select item_id,item_name from kb_items')) items[i.item_id] = String(i.item_name).trim();
  const parties = {};
  for (const n of q('select name_id,full_name from kb_names')) parties[n.name_id] = String(n.full_name).trim();
  const lines = {};
  for (const l of q('select lineitem_txn_id,item_id,total_amount from kb_lineitems')) (lines[l.lineitem_txn_id] ||= []).push(l);
  const pays = {};
  for (const m of q('select txn_id,payment_id,amount from txn_payment_mapping')) (pays[m.txn_id] ||= []).push(m);

  const push = (t) => { if (!t.amt || Math.abs(t.amt) < 0.005) return; data.txns.push({ id: uid('t'), ...t }); };

  // Vyapar balance per person (truth for reconciliation): open balances on Dept entries
  const truth = new Map();

  // ---- Transactions
  const txns = q('select * from kb_transactions order by txn_date, txn_id');
  for (const t of txns) {
    const date = String(t.txn_date).slice(0, 10);
    const party = parties[t.txn_name_id] || '';
    const pl = party.toLowerCase();
    const note = String(t.txn_description || '').trim();
    const ls = (lines[t.txn_id] || []).filter(l => Math.abs(l.total_amount) > 0.001);
    const lineTotal = ls.reduce((s, l) => s + l.total_amount, 0);
    const parts = ls.length ? ls.map(l => ({ item: items[l.item_id] || '', share: lineTotal ? l.total_amount / lineTotal : 1 / ls.length }))
                            : [{ item: '', share: 1 }];
    const payList = pays[t.txn_id] || [];
    const vt = t.txn_type;

    if (pl === 'dept' && (vt === 23 || vt === 2)) {
      const total = (t.txn_cash_amount || 0) + (t.txn_balance_amount || 0);
      if (vt === 23) {
        const pid = person(note);
        truth.set(pid, (truth.get(pid) || 0) + (t.txn_balance_amount || 0));
        void total;
      }
    }

    // A single INR-account, single-line entry whose note states the rupee amount → use it.
    const rupees = parseRupees(note);

    for (const pay of payList) {
      const acc = accById[pay.payment_id];
      if (!acc) { warnings.push(`Unknown account on ${date}`); continue; }
      for (const part of parts) {
        const aed = pay.amount * part.share;
        let amt = conv(acc, aed);
        let fx;
        if (acc.cur === 'INR') {
          fx = rate;
          if (rules.useNoteRupees && rupees && payList.length === 1 && parts.length === 1) {
            const r = rupees / aed;
            if (r > 15 && r < 32) { amt = round2(rupees); fx = round2(r * 100) / 100; }
          }
        }
        const base = { date, acc: acc.id, cur: acc.cur, amt, note, ...(fx ? { fx } : {}) };
        const il = part.item.toLowerCase();

        if (vt === 1) { // Sale = money in
          if (pl === 'kuri') push({ ...base, type: 'kuri_get', kuri: kuri(part.item), ...personSide(acc, aed) });
          else if (pl === 'dept') push({ ...base, type: 'borrow', person: person(note), ...personSide(acc, aed) });
          else if (pl === 'business') push({ ...base, type: 'asset_in', asset: asset('Business', 'business'), ...personSide(acc, aed) });
          else push({ ...base, type: 'income', cat: cat('income', party || 'Other income'), sub: part.item && part.item.toLowerCase() !== pl ? part.item : undefined });
        } else if (vt === 21) { // Sale return = money out
          if (pl === 'dept') push({ ...base, type: 'repay', person: person(note), ...personSide(acc, aed) });
          else push({ ...base, type: 'expense', cat: cat('expense', party || 'Misc'), sub: part.item || undefined });
        } else if (vt === 2) { // Purchase = money out
          if (il === 'transfer charge') push({ ...base, type: 'expense', cat: cat('expense', 'Bank charges'), sub: pl === 'bank' ? undefined : title(party) });
          else if (pl === 'dept' && il === 'non recevable') push({ ...base, type: 'expense', cat: cat('expense', 'Given (not returnable)'), person: person(note) });
          else if (pl === 'dept') push({ ...base, type: 'lend', person: person(note), ...personSide(acc, aed) });
          else if (pl === 'kuri') push({ ...base, type: 'kuri_pay', kuri: kuri(part.item), ...personSide(acc, aed) });
          else if (il === 'investment') push({ ...base, type: 'invest', asset: asset(pl === 'asset' ? 'Investments' : pl === 'business' ? 'Business' : title(party) + ' investment', pl === 'business' ? 'business' : 'investment'), ...personSide(acc, aed) });
          else if (il === 'property') push({ ...base, type: 'invest', asset: asset('Property', 'property'), ...personSide(acc, aed) });
          else if (pl === 'gold' && il === 'gold') push({ ...base, type: 'invest', asset: asset('Gold', 'gold'), ...personSide(acc, aed) });
          else if (pl === 'construction exp') push({ ...base, type: 'invest', asset: asset('House construction', 'property'), sub: part.item, ...personSide(acc, aed) });
          else push({ ...base, type: 'expense', cat: cat('expense', party || 'Misc'), sub: part.item && part.item.toLowerCase() !== pl ? part.item : undefined });
        } else if (vt === 23) { // Purchase return = money in
          if (pl === 'dept') push({ ...base, type: 'collect', person: person(note), ...personSide(acc, aed) });
          else if (pl === 'kuri') push({ ...base, type: 'kuri_get', kuri: kuri(part.item), ...personSide(acc, aed) });
          else if (pl === 'business') push({ ...base, type: 'asset_in', asset: asset('Business', 'business'), ...personSide(acc, aed) });
          else push({ ...base, type: 'income', cat: cat('income', 'Refunds'), sub: title(party) + (part.item ? ' · ' + part.item : '') });
        } else {
          warnings.push(`Skipped unknown Vyapar type ${vt} on ${date}`);
        }
      }
    }
  }

  // Person-side amounts stay in AED (as recorded in Vyapar) when money moved through an INR account.
  function personSide(acc, aed) { return acc.cur === 'INR' ? { amt2: round2(aed), cur2: 'AED' } : {}; }

  // ---- Bank / cash adjustments
  for (const b of q('select * from kb_bank_adjustments order by bank_adj_date')) {
    const date = String(b.bank_adj_date).slice(0, 10);
    const note = String(b.bank_adj_description || '').trim();
    const bank = accById[b.bank_adj_bank_id];
    const cash = data.accounts.find(a => a.kind === 'cash');
    const amt = b.bank_adj_amount;
    if (!bank) continue;
    const transfer = (from, to) => push({ date, type: 'transfer', acc: from.id, cur: from.cur, amt: conv(from, amt), to: to.id, cur2: to.cur, amt2: conv(to, amt), note, ...(from.cur !== to.cur ? { fx: rate } : {}) });
    switch (b.bank_adj_type) {
      case 25: { const to = accById[b.bank_adj_to_bank_id]; if (to) transfer(bank, to); break; }
      case 14: transfer(cash, bank); break;          // cash deposited into bank
      case 15: transfer(bank, cash); break;          // withdrawn from bank as cash
      case 17: push({ date, type: 'adjust', acc: bank.id, cur: bank.cur, amt: conv(bank, amt), note: note || 'Balance correction' }); break;
      case 18: push({ date, type: 'adjust', acc: bank.id, cur: bank.cur, amt: -conv(bank, amt), note: note || 'Balance correction' }); break;
      default: warnings.push(`Skipped bank adjustment type ${b.bank_adj_type}`);
    }
  }
  for (const c of q('select * from kb_cash_adjustments')) {
    const cash = data.accounts.find(a => a.kind === 'cash');
    push({ date: String(c.cash_adj_date).slice(0, 10), type: 'adjust', acc: cash.id, cur: 'AED', amt: c.cash_adj_type === 19 ? c.cash_adj_amount : -c.cash_adj_amount, note: c.cash_adj_description || 'Balance correction' });
  }

  // ---- Reconcile each person to Vyapar's open balance
  const ledger = personBalances(data.txns);
  const today = new Date().toISOString().slice(0, 10);
  for (const p of data.people) {
    const have = ledger.get(p.id)?.AED || 0;
    const want = truth.get(p.id) || 0;
    const diff = round2(want - have);
    if (Math.abs(diff) >= 0.01) {
      const last = data.txns.filter(t => t.person === p.id).reduce((d, t) => t.date > d ? t.date : d, '') || today;
      data.txns.push({ id: uid('t'), date: last, type: 'person_adjust', person: p.id, cur: 'AED', amt: diff, note: 'Correction to match Vyapar balance' });
    }
  }

  // ---- Mark dormant zero-balance accounts as closed
  const bal = {}; const lastUse = {};
  for (const a of data.accounts) { bal[a.id] = a.opening; lastUse[a.id] = ''; }
  for (const t of data.txns) {
    if (t.type === 'transfer') { bal[t.acc] -= t.amt; bal[t.to] += t.amt2; lastUse[t.to] = t.date > lastUse[t.to] ? t.date : lastUse[t.to]; }
    else if (t.acc) bal[t.acc] += ({ income: 1, collect: 1, borrow: 1, kuri_get: 1, asset_in: 1, adjust: 1 }[t.type] ? t.amt : -t.amt);
    if (t.acc) lastUse[t.acc] = t.date > lastUse[t.acc] ? t.date : lastUse[t.acc];
  }
  const cutoff = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  for (const a of data.accounts) if (a.kind === 'bank' && Math.abs(bal[a.id]) < 0.01 && lastUse[a.id] < cutoff) a.closed = true;

  // ---- Kuri instalment guesses
  for (const k of data.kuris) {
    const paid = data.txns.filter(t => t.kuri === k.id && t.type === 'kuri_pay');
    if (paid.length) {
      const amts = paid.map(t => t.amt2 || (t.fx ? t.amt / t.fx : t.amt));
      k.instalment = round2(mode(amts));
      k.start = paid[0].date;
    }
  }

  data.txns.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { data, warnings };
}

function mode(arr) {
  const m = new Map(); let best = arr[0], bc = 0;
  for (const v of arr) { const r = Math.round(v); const c = (m.get(r) || 0) + 1; m.set(r, c); if (c > bc) { bc = c; best = r; } }
  return best;
}

function prettyAccount(n) {
  return n.replace(/\bcc\b/i, 'Credit Card').replace(/fedral/i, 'Federal').replace(/\bnri\b/i, 'NRI').replace(/\bnro\b/i, 'NRO')
    .replace(/\badcb\b/i, 'ADCB').replace(/\bcbd\b/i, 'CBD').replace(/\b[a-z]/g, c => c.toUpperCase());
}

export function personBalances(txns) {
  const m = new Map();
  for (const t of txns) {
    if (!t.person) continue;
    const sign = { lend: 1, repay: 1, collect: -1, borrow: -1, person_adjust: 1 }[t.type];
    if (!sign) continue;
    const cur = t.cur2 || t.cur;
    const amt = t.amt2 ?? t.amt;
    const e = m.get(t.person) || {}; e[cur] = (e[cur] || 0) + sign * amt; m.set(t.person, e);
  }
  return m;
}
