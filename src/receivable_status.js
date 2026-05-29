import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Saldo a receber real da carteira: soma o balanceDue das parcelas de cada
// titulo de recebivel (/accounts-receivable/receivable-bills/{id}/installments).
// Sao ~120 titulos -> roda inteiro a cada vez (saldo muda no tempo). Sem cache.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const u = process.env.SIENGE_API_USER, p = process.env.SIENGE_API_PASSWORD, s = process.env.SIENGE_SUBDOMAIN || 'saab';
const auth = 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const base = `https://api.sienge.com.br/${s}/public/api/v1`;
const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fb; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => Number(v) || 0;

const bills = read('receivable_bills.json', []);
const hoje = new Date().toISOString().slice(0, 10);
let face = 0, saldo = 0, vencido = 0, aVencer = 0, parcelas = 0, erros = 0;

async function inst(id) {
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(`${base}/accounts-receivable/receivable-bills/${id}/installments`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (r.status === 429) { await wait(2000 * (t + 1)); continue; }
      if (r.status !== 200) return [];
      return (await r.json()).results || [];
    } catch { await wait(800 * (t + 1)); }
  }
  erros++; return [];
}

async function run() {
  for (const b of bills) {
    face += num(b.receivableBillValue);
    const rows = await inst(b.receivableBillId);
    for (const i of rows) { const bd = num(i.balanceDue); saldo += bd; parcelas++; if ((i.dueDate || '') < hoje) vencido += bd; else aVencer += bd; }
    await wait(60);
  }
  const out = { geradoEm: new Date().toISOString(), face, saldoAReceber: saldo, vencido, aVencer, recebido: face - saldo, parcelas, titulos: bills.length, erros };
  fs.writeFileSync(path.join(DATA, 'receivable_balance.json'), JSON.stringify(out, null, 2));
  const f = (v) => 'R$' + Math.round(v).toLocaleString('pt-BR');
  console.log(`Carteira a receber ${f(saldo)} (vencido ${f(vencido)} · a vencer ${f(aVencer)}) | recebido ${f(face - saldo)} | erros ${erros}`);
}
run().catch((e) => { console.error(e); process.exit(1); });
