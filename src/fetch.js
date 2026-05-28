import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, getAll, SUBDOMAIN } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const COMPANY_ID = Number(process.env.SPE_COMPANY_ID || 3); // empresa transacional da SPE 01

// Janela de datas (ultimos N meses ate hoje) para endpoints que exigem.
function dateWindow(months = 48) {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

const save = (key, data) =>
  fs.writeFileSync(path.join(DATA_DIR, `${key}.json`), JSON.stringify(data, null, 2));

async function step(label, fn) {
  process.stdout.write(`-> ${label.padEnd(26)} ... `);
  try {
    const rows = await fn();
    const n = Array.isArray(rows) ? rows.length : '(obj)';
    console.log(`${n}`);
    return { label, count: Array.isArray(rows) ? rows.length : 0, ok: true };
  } catch (err) {
    console.log(`FALHOU (${err.message})`);
    return { label, count: 0, ok: false, error: err.message };
  }
}

async function main() {
  const dates = dateWindow();
  console.log(`\n== BI Sienge :: SPE 01 (Reserva) :: conta "${SUBDOMAIN}" :: empresa ${COMPANY_ID} ==`);
  console.log(`Janela: ${dates.startDate} a ${dates.endDate}\n`);
  const summary = [];

  // ---- Cadastros de referencia (conta toda; pequenos) ----
  summary.push(await step('companies', async () => { const r = await getAll('/companies'); save('companies', r); return r; }));
  summary.push(await step('enterprises', async () => { const r = await getAll('/enterprises'); save('enterprises', r); return r; }));
  summary.push(await step('cost_centers', async () => { const r = await getAll('/cost-centers'); save('cost_centers', r); return r; }));
  summary.push(await step('payment_categories', async () => { const r = await getAll('/payment-categories'); save('payment_categories', r); return r; }));
  summary.push(await step('creditors', async () => { const r = await getAll('/creditors'); save('creditors', r); return r; }));
  summary.push(await step('customers', async () => { const r = await getAll('/customers'); save('customers', r); return r; }));

  // ---- SPE 01: Vendas ----
  let salesContracts = [];
  summary.push(await step('sales_contracts (emp 3)', async () => {
    salesContracts = await getAll('/sales-contracts', { companyId: COMPANY_ID });
    save('sales_contracts', salesContracts);
    return salesContracts;
  }));

  // ---- SPE 01: Unidades (por empreendimento dos contratos) ----
  summary.push(await step('units', async () => {
    const entIds = [...new Set(salesContracts.map((c) => c.enterpriseId).filter(Boolean))];
    let units = [];
    for (const eid of entIds) {
      const u = await getAll('/units', { enterpriseId: eid });
      units = units.concat(u);
    }
    save('units', units);
    return units;
  }));

  // ---- SPE 01: Recebiveis ----
  summary.push(await step('receivable_bills (emp 3)', async () => {
    const r = await getAll('/accounts-receivable/receivable-bills', { companyId: COMPANY_ID, ...dates });
    save('receivable_bills', r);
    return r;
  }));

  // ---- SPE 01: Contas a pagar / custos (debtorId = empresa) ----
  summary.push(await step('payable_bills (debtor 3)', async () => {
    const r = await getAll('/bills', { debtorId: COMPANY_ID, ...dates }, { maxPages: 80 });
    save('payable_bills', r);
    return r;
  }));

  save('_summary', { generatedAt: new Date().toISOString(), subdomain: SUBDOMAIN, companyId: COMPANY_ID, window: dates, steps: summary });

  console.log('\n== Resumo ==');
  for (const s of summary) console.log(`${s.ok ? 'OK ' : '-- '} ${s.label.padEnd(26)} ${s.ok ? s.count : s.error}`);
  console.log('\nDados em data/. Rode "npm run build" para gerar o dashboard.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
