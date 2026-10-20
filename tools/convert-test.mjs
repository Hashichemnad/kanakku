// Usage: node convert-test.mjs <file.vyb> <rules.json> <out.json>
import fs from 'node:fs';
import initSqlJs from 'sql.js';
import { unzipSync } from 'fflate';
import { convertVyapar, normaliseName, personBalances } from '../web/js/vyapar.js';
const [,, vyb, rulesPath, out] = process.argv;
const files = unzipSync(new Uint8Array(fs.readFileSync(vyb)));
const dbName = Object.keys(files).find(n => n.endsWith('.vyp'));
const SQL = await initSqlJs();
const db = new SQL.Database(files[dbName]);
const rules = rulesPath && fs.existsSync(rulesPath) ? JSON.parse(fs.readFileSync(rulesPath, 'utf8')) : {};
const { data, warnings } = convertVyapar(db, rules);
fs.writeFileSync(out, JSON.stringify(data));
console.log('warnings', warnings.slice(0, 10), warnings.length);
const counts = {}; for (const t of data.txns) counts[t.type] = (counts[t.type] || 0) + 1; console.log(counts);
const bal = {}; for (const a of data.accounts) bal[a.id] = a.opening;
for (const t of data.txns) {
  if (t.type === 'transfer') { bal[t.acc] -= t.amt; bal[t.to] += t.amt2; continue; }
  if (!t.acc) continue;
  const out = ['expense', 'lend', 'repay', 'kuri_pay', 'invest'].includes(t.type);
  bal[t.acc] += out ? -t.amt : t.amt;
}
for (const a of data.accounts) console.log(a.name.padEnd(22), a.cur, a.kind, bal[a.id].toFixed(2));
const pb = personBalances(data.txns); let tot = 0;
const rows = data.people.map(p => [p.name, +(pb.get(p.id)?.AED || 0).toFixed(2)]).sort((a, b) => b[1] - a[1]);
for (const r of rows) tot += r[1];
console.log('people', data.people.length, 'total owed', tot.toFixed(2));
console.log(rows.map(r => r.join(':')).join(' | '));
console.log('kuris', data.kuris.map(k => k.name + ' ' + k.instalment).join(', '));
console.log('assets', data.assets.map(a => a.name).join(', '));
console.log('person_adjusts', data.txns.filter(t => t.type === 'person_adjust').map(t => data.people.find(p => p.id === t.person).name + ' ' + t.amt).join(', '));
