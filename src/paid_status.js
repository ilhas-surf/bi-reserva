import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Status de pagamento por titulo (via /bills/{id}/installments, campo situation).
// Cache data/bill_paid.json = { [billId]: { pago, aberto, quitado } }.
// Titulos QUITADOS (quitado=true) sao congelados; nos demais (em aberto) e novos
// o status e re-buscado a cada run (pagamento muda no tempo). So busca titulos de
// custo real (exclui capital/provisao) p/ economizar chamadas.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const u = process.env.SIENGE_API_USER, p = process.env.SIENGE_API_PASSWORD, s = process.env.SIENGE_SUBDOMAIN || 'saab';
const auth = 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const base = `https://api.sienge.com.br/${s}/public/api/v1`;
const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return fb; } };
const CACHE = path.join(DATA, 'bill_paid.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const bills = read('payable_bills.json', []);
const cat = read('bill_categories.json', {});
const cache = read('bill_paid.json', {});
const CAP = /^(104|105|231|222|290|19202|29001|20303|2030304|2030305|2030307|2030216|2270107|2050110|2050111|2050112)/;
const catOf = (id) => { const e = cat[id]; return e && typeof e === 'object' ? String(e.c || '') : String(e || ''); };
const isCap = (b) => CAP.test(catOf(b.id));
const isPrv = (b) => (b.documentIdentificationId || '').trim() === 'PRV';

// so titulos de custo real; pula os ja quitados (congelados)
const alvo = bills.filter((b) => b.id !== 27287 && !isPrv(b) && !isCap(b));
const todo = alvo.filter((b) => !(cache[b.id] && cache[b.id].quitado));
console.log(`Custo real: ${alvo.length} titulos | quitados em cache: ${alvo.length - todo.length} | a checar: ${todo.length}`);

const CONC = 5; let done = 0, errors = 0;
const ERR = Symbol('err');
async function fetchPaid(id) {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(`${base}/bills/${id}/installments`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (r.status === 429) { await wait(3000 * (t + 1)); continue; }
      if (r.status === 404) return { pago: 0, aberto: 0, quitado: false };
      if (r.status !== 200) { await wait(500 * (t + 1)); continue; }
      const j = await r.json();
      let pago = 0, aberto = 0, todasPagas = true;
      for (const inst of (j.results || [])) {
        const amt = Number(inst.amount) || 0;
        if (/totalmente paga/i.test(inst.situation || '')) pago += amt;
        else { aberto += amt; todasPagas = false; }
      }
      return { pago, aberto, quitado: todasPagas && (j.results || []).length > 0 };
    } catch { await wait(1000 * (t + 1)); }
  }
  errors++; return ERR;
}

async function run() {
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    const res = await Promise.all(batch.map((b) => fetchPaid(b.id)));
    batch.forEach((b, k) => { if (res[k] !== ERR) cache[b.id] = res[k]; });
    done += batch.length;
    if (done % 200 === 0 || done === todo.length) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`  ${done}/${todo.length} (err ${errors})`); }
    await wait(120);
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  let pago = 0, aberto = 0;
  for (const b of alvo) { const c = cache[b.id]; if (c) { pago += c.pago; aberto += c.aberto; } }
  const f = (v) => 'R$' + Math.round(v).toLocaleString('pt-BR');
  console.log(`OK. Pago ${f(pago)} | Em aberto ${f(aberto)} | erros ${errors}`);
}
run().catch((e) => { console.error(e); process.exit(1); });
