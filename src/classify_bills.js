import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Busca a apropriacao (budget-categories) de cada titulo a pagar para obter o
// paymentCategoriesId e classificar capital (emprestimo/aporte/socios/mutuo) x custo real.
// A categoria de um titulo e imutavel -> salva cache data/bill_categories.json e so
// busca os ids ainda nao cacheados (incremental).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');
const u = process.env.SIENGE_API_USER, p = process.env.SIENGE_API_PASSWORD, s = process.env.SIENGE_SUBDOMAIN || 'saab';
const auth = 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const base = `https://api.sienge.com.br/${s}/public/api/v1`;

const CACHE_FILE = path.join(DATA, 'bill_categories.json');
const read = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

const bills = read(path.join(DATA, 'payable_bills.json'), []);
const cache = read(CACHE_FILE, {});            // { [billId]: "categId" | "" }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// re-busca quem nao esta no cache OU esta no formato antigo (string, sem centro de custo)
const todo = bills.map((b) => b.id).filter((id) => !(id in cache) || typeof cache[id] !== 'object');
console.log(`Titulos: ${bills.length} | cacheados (obj): ${Object.values(cache).filter((v) => v && typeof v === 'object').length} | a buscar: ${todo.length}`);

const CONC = 5;
let done = 0, errors = 0;
const ERR = Symbol('err'); // falha de rede: NAO cacheia (re-tenta no proximo run)
async function fetchCat(id) {
  for (let t = 0; t < 5; t++) {
    try {
      const r = await fetch(`${base}/bills/${id}/budget-categories`, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (r.status === 429) { await wait(3000 * (t + 1)); continue; }
      if (r.status === 404) return { c: '', cc: null };  // sem apropriacao -> cacheia vazio
      if (r.status !== 200) { await wait(500 * (t + 1)); continue; }
      const j = await r.json();
      const rows = j.results || [];
      // apropriacao predominante (maior percentage): categoria + centro de custo
      let bestC = '', bestCC = null, bestPct = -1;
      for (const a of rows) { const pct = Number(a.percentage) || 0; if (pct > bestPct) { bestPct = pct; bestC = String(a.paymentCategoriesId || ''); bestCC = a.costCenterId ?? null; } }
      return { c: bestC, cc: bestCC };
    } catch { await wait(1000 * (t + 1)); }
  }
  errors++; return ERR;
}

async function run() {
  for (let i = 0; i < todo.length; i += CONC) {
    const batch = todo.slice(i, i + CONC);
    const res = await Promise.all(batch.map((id) => fetchCat(id)));
    batch.forEach((id, k) => { if (res[k] !== ERR) cache[id] = res[k]; }); // erros ficam fora do cache
    done += batch.length;
    if (done % 200 === 0 || done === todo.length) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      console.log(`  ${done}/${todo.length} (err ${errors})`);
    }
    await wait(120);
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`OK. Cache salvo: ${Object.keys(cache).length} titulos. Erros: ${errors}`);
}
run().catch((e) => { console.error(e); process.exit(1); });
