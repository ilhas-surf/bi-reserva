import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const read = (f, fallback = []) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
  catch { return fallback; }
};

// ---------- Dados da API ----------
const salesContracts = read('sales_contracts.json');
const units = read('units.json');
const receivables = read('receivable_bills.json');
const payables = read('payable_bills.json');
const creditors = read('creditors.json');
const customers = read('customers.json');
const supplyContracts = read('supply_contracts.json');
const supplyMeasurements = read('supply_measurements.json');
const billCategories = read('bill_categories.json', {}); // { billId: paymentCategoryId } via /bills/{id}/budget-categories
const billPaid = read('bill_paid.json', {});             // { billId: {pago, aberto, quitado} } via /bills/{id}/installments
const summary = read('_summary.json', {});

const LANCAMENTO_INICIO = '2023-08-01'; // data de lancamento das vendas da Reserva

// ---------- Entrada manual (orcado / avanco fisico) ----------
const MANUAL_FILE = path.join(DATA, 'manual.json');
if (!fs.existsSync(MANUAL_FILE)) {
  const template = {
    _instrucoes: 'Preencha aqui os dados que NAO vem do Sienge. Datas no formato AAAA-MM. Depois rode: npm run build',
    obraNome: 'Reserva - SPE 01',
    orcamentoObra: 83000000,
    obraRealizada: 21964551.30,
    retPct: 4.7,
    avancoFisico: [
      { mes: '2025-01', planejado: 5, real: 4 },
      { mes: '2025-02', planejado: 12, real: 10 }
    ],
    orcadoMensalCusto: [
      { mes: '2025-01', orcado: 0 },
      { mes: '2025-02', orcado: 0 }
    ]
  };
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(template, null, 2));
  console.log('Criado data/manual.json (modelo). Preencha avanco fisico e orcado e rode build de novo.');
}
const manual = read('manual.json', {});

// ---------- Helpers ----------
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const ym = (d) => (d ? String(d).slice(0, 7) : null);
const fmtBRL = (v) => num(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function sortedMonths(...series) {
  const set = new Set();
  for (const s of series) for (const m of s) if (m) set.add(m);
  return [...set].sort();
}
function byMonth(rows, dateField, valField) {
  const map = {};
  for (const r of rows) {
    const m = ym(r[dateField]);
    if (!m) continue;
    map[m] = (map[m] || 0) + num(r[valField]);
  }
  return map;
}

const creditorName = {};
for (const c of creditors) creditorName[c.id ?? c.creditorId] = c.name ?? c.tradeName ?? c.corporateName ?? ('Credor ' + (c.id ?? ''));

// ---------- VENDAS ----------
const canceladas = salesContracts.filter((c) => /cancel/i.test(c.situation || ''));
const ativos = salesContracts.filter((c) => !/cancel/i.test(c.situation || ''));
const vgv = ativos.reduce((s, c) => s + num(c.totalSellingValue || c.value), 0);
const contratosPorMes = byMonth(ativos, 'contractDate', 'totalSellingValue');

// unidades por commercialStock (Sienge): V=Vendida, D=Disponivel, E=Permuta,
// M=Mutuo, R=Reserva tecnica. So D fica disponivel p/ venda; o resto e comprometido.
const stk = { V: 0, R: 0, D: 0, E: 0, M: 0, outros: 0 };
for (const u of units) {
  const c = (u.commercialStock || '').toString().toUpperCase();
  if (c in stk) stk[c]++; else stk.outros++;
}
const unidTotal = units.length;
const unidDisponiveis = stk.D;                          // estoque a vender
const unidVendidas = stk.V + stk.E + stk.M + stk.R;     // comprometidas (vendida+permuta+mutuo+reserva tecnica)
const unidEstoque = unidDisponiveis;

// area privativa por commercialStock (para estimar preco/m2 e VGV de estoque)
const areaStk = { V: 0, R: 0, D: 0, E: 0, M: 0 };
for (const u of units) {
  const c = (u.commercialStock || '').toString().toUpperCase();
  if (c in areaStk) areaStk[c] += num(u.privateArea);
}

// ---------- RECEBIVEIS ----------
// Carteira a receber = SALDO DEVEDOR das parcelas (balanceDue), nao o valor de face do
// contrato. Vem de receivable_balance.json (src/receivable_status.js). O valor de face
// (recTotal) inclui o que ja foi recebido + juros futuros, por isso superestima.
const recBal = read('receivable_balance.json', {});
const recFace = receivables.reduce((s, r) => s + num(r.receivableBillValue), 0);
const aReceber = num(recBal.saldoAReceber) || (recFace - num(recBal.recebido)); // saldo real da carteira
const recVencido = num(recBal.vencido);
const recAVencer = num(recBal.aVencer);
const recRecebido = num(recBal.recebido);
const recTotal = aReceber; // "carteira" agora = saldo a receber real
const recPorMes = byMonth(receivables, 'issueDate', 'receivableBillValue');

// ---------- CUSTOS (contas a pagar) ----------
// Anomalia: um titulo isolado maior que o VGV inteiro do empreendimento nao e
// custo operacional real (erro de digitacao no Sienge ou lancamento de base de
// RET/tributo). Separamos para nao distorcer os graficos, mas listamos no painel.
const ANOM_LIMITE = Math.max(vgv, 10_000_000);
const anomalias = payables
  .filter((b) => num(b.totalInvoiceAmount) > ANOM_LIMITE)
  .map((b) => ({
    id: b.id, valor: num(b.totalInvoiceAmount),
    credor: creditorName[b.creditorId] || ('Credor ' + b.creditorId),
    doc: b.documentNumber, data: b.issueDate, nota: (b.notes || '').trim()
  }))
  .sort((a, b) => b.valor - a.valor);
const anomSet = new Set(anomalias.map((a) => a.id));
const payablesOk = payables.filter((b) => !anomSet.has(b.id));

// ---------- CUSTO REAL x CAPITAL (classificacao por categoria de pagamento) ----------
// Cada titulo tem uma categoria (bill_categories.json, do /bills/{id}/budget-categories).
// Custo REAL da obra = titulos a partir do lancamento das vendas (01/08/2023),
// EXCLUINDO movimentacao de capital (emprestimos/aportes/socios/mutuo) e provisoes (PRV).
const CAP_RE = /^(104|105|231|222|290|19202|29001|20303|2030304|2030305|2030307|2030216|2270107|2050110|2050111|2050112)/;
// bill_categories.json: { id: {c: categoria, cc: centroCusto} } (formato novo) ou string (antigo)
const catOf = (id) => { const e = billCategories[id]; return e && typeof e === 'object' ? String(e.c || '') : String(e || ''); };
const ccOf = (id) => { const e = billCategories[id]; return e && typeof e === 'object' ? e.cc : null; };
const isCapital = (b) => CAP_RE.test(catOf(b.id));
const isProvisao = (b) => (b.documentIdentificationId || '').trim() === 'PRV';
const noPeriodo = (b) => (b.issueDate || '') >= LANCAMENTO_INICIO;
// Centros de custo da Reserva: Custos de Obra (direto) = 4,6,20 ; Administrativo de obra = 7,22
const CC_OBRA = new Set([4, 6, 20]);
const isObraDireta = (b) => CC_OBRA.has(Number(ccOf(b.id)));

let custoCapital = 0, custoProvisao = 0;
for (const b of payablesOk) {
  const v = num(b.totalInvoiceAmount);
  if (isProvisao(b)) custoProvisao += v;
  else if (isCapital(b)) custoCapital += v;
}
// Titulos de custo real (no periodo, sem capital/provisao)
const payablesReal = payablesOk.filter((b) => noPeriodo(b) && !isProvisao(b) && !isCapital(b));
const custoReal = payablesReal.reduce((s, b) => s + num(b.totalInvoiceAmount), 0);
const semCategoria = payablesReal.filter((b) => !catOf(b.id)).reduce((s, b) => s + num(b.totalInvoiceAmount), 0);
const classificados = Object.values(billCategories).filter((v) => v && typeof v === 'object').length;

const orcamentoObra = num(manual.orcamentoObra) || 83_000_000; // orcamento de obra (manual; Sienge desatualizado)

// Pago x a pagar em aberto (status de pagamento por titulo, bill_paid.json)
const PLANO_OBRA = '202'; // plano financeiro 2.02 = Custos e Despesas Gerais (a obra)
let custoPago = 0, aPagarAberto = 0, paidConhecidos = 0;
let obraPago = 0, obraAberto = 0; // do plano 2.02 (obra)
for (const b of payablesReal) {
  const c = billPaid[b.id];
  if (!c) continue;
  custoPago += num(c.pago); aPagarAberto += num(c.aberto); paidConhecidos++;
  if (catOf(b.id).startsWith(PLANO_OBRA)) { obraPago += num(c.pago); obraAberto += num(c.aberto); }
}
const temPaid = Object.keys(billPaid).length > 0;

// Obra realizada = PAGO dos titulos do plano financeiro 2.02 (relatorio "Contas Pagas - Obra").
// 100% API (parcelas pagas filtradas pelo plano 2.02). Override manual opcional.
const custoObraReal = num(manual.obraRealizada) || obraPago;
const pctObra = orcamentoObra ? 100 * custoObraReal / orcamentoObra : 0;
const custoOutros = Math.max(custoReal - custoObraReal, 0); // demais lancamentos reais (indiretos/terreno/comercial)

// series e fornecedores do custo REAL (nao do capital)
const custoTotal = custoReal; // compat: custoTotal agora = custo real
const custoPorMes = byMonth(payablesReal, 'issueDate', 'totalInvoiceAmount');
const porCredor = {};
for (const b of payablesReal) porCredor[b.creditorId] = (porCredor[b.creditorId] || 0) + num(b.totalInvoiceAmount);
const topCredores = Object.entries(porCredor)
  .sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([id, v]) => ({ nome: creditorName[id] || ('Credor ' + id), valor: v }));

// ---------- SUPRIMENTOS (contratos de fornecimento + medicoes) ----------
// Join: contrato documentId|contractNumber|supplierId  <->  medicao documentId|contractNumber|contractSupplierId
const measKey = (m) => `${m.documentId}|${m.contractNumber}|${m.contractSupplierId}`;
const realizadoPorContrato = {};
for (const m of supplyMeasurements) {
  const k = measKey(m);
  realizadoPorContrato[k] = (realizadoPorContrato[k] || 0) + num(m.netValue);
}
const isRescindido = (s) => /RESCIND/i.test(s || '');
const contratosSup = supplyContracts.map((c) => {
  const k = `${c.documentId}|${c.contractNumber}|${c.supplierId}`;
  const total = num(c.totalLaborValue) + num(c.totalMaterialValue);
  const realizado = realizadoPorContrato[k] || 0;
  const rescindido = isRescindido(c.status);
  const aRealizar = rescindido ? 0 : Math.max(total - realizado, 0);
  return {
    doc: `${c.documentId} ${c.contractNumber}`,
    fornecedor: c.supplierName || ('Fornecedor ' + c.supplierId),
    objeto: (c.object || '').trim(),
    status: c.status || '',
    rescindido,
    contratado: total,
    realizado,
    aRealizar,
    pct: total ? 100 * realizado / total : 0,
    data: c.contractDate,
  };
}).sort((a, b) => b.contratado - a.contratado);

const supTotalContratado = contratosSup.reduce((s, c) => s + c.contratado, 0);
const supTotalRealizado = contratosSup.reduce((s, c) => s + c.realizado, 0);
const supTotalARealizar = contratosSup.reduce((s, c) => s + c.aRealizar, 0);
const supContratadoAtivo = contratosSup.filter((c) => !c.rescindido).reduce((s, c) => s + c.contratado, 0);
const supPctExec = supContratadoAtivo ? 100 * supTotalRealizado / supContratadoAtivo : 0;
const supQtdRescindidos = contratosSup.filter((c) => c.rescindido).length;

// Agregado por fornecedor
const supPorForn = {};
for (const c of contratosSup) {
  const f = (supPorForn[c.fornecedor] ||= { fornecedor: c.fornecedor, contratos: 0, contratado: 0, realizado: 0, aRealizar: 0 });
  f.contratos++; f.contratado += c.contratado; f.realizado += c.realizado; f.aRealizar += c.aRealizar;
}
const fornecedoresSup = Object.values(supPorForn)
  .map((f) => ({ ...f, pct: f.contratado ? 100 * f.realizado / f.contratado : 0 }))
  .sort((a, b) => b.contratado - a.contratado);

// Cronograma de obra: contratado (curva por data do contrato) x realizado/medido (por data da medicao), acumulados
const contratadoMes = byMonth(supplyContracts.map((c) => ({
  contractDate: c.contractDate, v: num(c.totalLaborValue) + num(c.totalMaterialValue),
})), 'contractDate', 'v');
const medidoMes = byMonth(supplyMeasurements, 'measurementDate', 'netValue');
const mesesCron = sortedMonths(Object.keys(contratadoMes), Object.keys(medidoMes));
let accC = 0, accM = 0;
const cronContratadoAcum = [], cronMedidoAcum = [];
for (const m of mesesCron) {
  accC += contratadoMes[m] || 0; cronContratadoAcum.push(accC);
  accM += medidoMes[m] || 0; cronMedidoAcum.push(accM);
}

// ---------- ORCADO x REALIZADO (custo) ----------
const orcMap = {};
for (const o of (manual.orcadoMensalCusto || [])) orcMap[o.mes] = num(o.orcado);

// ---------- AVANCO FISICO ----------
const af = manual.avancoFisico || [];

// ---------- VIABILIDADE (indicadores) — 100% Sienge, sem entrada manual ----------
// VGV = valor de TODAS as unidades. Vendidas (contratos) usam o valor de contrato;
// as demais (permuta, mutuo, reserva tecnica, disponivel) usam o "Valor Atual" do /units
// (campo indexedQuantity, validado contra o relatorio de Estoque do Comercial).
// VGV total = vendido + permuta + mutuo + reserva tecnica + estoque (a vender).
// Sem comissao (retida no ato pelo corretor). Custo = custo REAL + suprimentos a realizar.
let vgvEstoque = 0, vgvPermuta = 0, vgvMutuo = 0, vgvReservaTec = 0;
for (const u of units) {
  const c = (u.commercialStock || '').toString().toUpperCase();
  const val = num(u.indexedQuantity);
  if (c === 'D') vgvEstoque += val;            // Disponivel = estoque a vender
  else if (c === 'E') vgvPermuta += val;       // Permuta
  else if (c === 'M') vgvMutuo += val;         // Mutuo
  else if (c === 'R') vgvReservaTec += val;    // Reserva tecnica
}
const vgvVendido = vgv + vgvPermuta + vgvMutuo + vgvReservaTec; // comprometido (vendido + permuta + mutuo + reserva tec.)
const precoM2Estoque = areaStk.D ? vgvEstoque / areaStk.D : 0;
const vgvTotal = vgvVendido + vgvEstoque;      // todas as unidades
const custoSuprARealizar = (typeof supTotalARealizar === 'number' ? supTotalARealizar : 0);
// pctObra ja calculado acima (obra realizada / orcamento)

// ---- Custo da VIABILIDADE (projecao) = Orcamento da Obra (manual) + Impostos RET ----
// Orcamento da obra: o do Sienge esta desatualizado -> manual (orcamentoObra, R$83M).
// RET: imposto sobre a receita das vendas (Regime Especial de Tributacao), retPct% do VGV.
const retPct = manual.retPct != null ? num(manual.retPct) : 4.7;
const impostoRET = vgvTotal * retPct / 100;
const custoProjetado = orcamentoObra + impostoRET;   // custo total da viabilidade
const resultado = vgvTotal - custoProjetado;
const margemPct = vgvTotal ? 100 * resultado / vgvTotal : 0;
const exposicaoCaixa = custoReal - recRecebido;   // caixa real ja desembolsado menos recebido

// ---------- Series para graficos ----------
const mesesFin = sortedMonths(Object.keys(custoPorMes), Object.keys(recPorMes), Object.keys(orcMap));
const mesesVendas = sortedMonths(Object.keys(contratosPorMes));

const payload = {
  geradoEm: summary.generatedAt || new Date().toISOString(),
  janela: summary.window || {},
  obraNome: manual.obraNome || 'SPE 01',
  kpis: {
    vgv, contratosAtivos: ativos.length, contratosCancelados: canceladas.length,
    unidVendidas, unidDisponiveis, unidTotal, unidEstoque,
    aReceber, recVencido, recAVencer,
    custoTotal, qtdTitulosPagar: payablesReal.length,
  },
  anomalias,
  fin: {
    meses: mesesFin,
    custo: mesesFin.map((m) => custoPorMes[m] || 0),
    receita: mesesFin.map((m) => recPorMes[m] || 0),
    orcado: mesesFin.map((m) => orcMap[m] || 0),
  },
  vendas: {
    meses: mesesVendas,
    vgvMes: mesesVendas.map((m) => contratosPorMes[m] || 0),
  },
  topCredores,
  suprimentos: {
    totalContratado: supTotalContratado,
    totalRealizado: supTotalRealizado,
    totalARealizar: supTotalARealizar,
    pctExec: supPctExec,
    qtdContratos: contratosSup.length,
    qtdRescindidos: supQtdRescindidos,
    qtdFornecedores: fornecedoresSup.length,
    contratos: contratosSup,
    fornecedores: fornecedoresSup,
  },
  cronograma: {
    meses: mesesCron,
    contratadoAcum: cronContratadoAcum,
    medidoAcum: cronMedidoAcum,
  },
  viabilidade: {
    vgvContratos: vgv, vgvVendido, vgvEstoque, vgvTotal,
    vgvPermuta, vgvMutuo, vgvReservaTec,
    precoM2Estoque, areaEstoque: areaStk.D,
    orcamentoObra, retPct, impostoRET, custoProjetado,
    custoObraReal, custoOutros, pctObra,
    resultado, margemPct, exposicaoCaixa,
  },
  financeiro: {
    // carteira (vendido) — saldo a receber real (balanceDue das parcelas)
    carteiraAReceber: aReceber, carteiraVencido: recVencido, carteiraAVencer: recAVencer,
    // estoque (a vender) — potencial, nao e conta a receber ainda
    estoqueVgv: vgvEstoque, estoqueUnid: unidDisponiveis,
    // obra (construcao) x outros; pago/aberto do custo real total (execucao)
    custoReal, obraConstrucao: custoObraReal, outros: custoOutros,
    orcamentoObra, pctObra,
    obraPago: custoPago, obraAberto: aPagarAberto, temPaid,
    obraTitulos: payablesReal.length,
    suprContratado: supTotalContratado, suprRealizado: supTotalRealizado, suprARealizar: supTotalARealizar,
  },
  avancoFisico: {
    meses: af.map((x) => x.mes),
    planejado: af.map((x) => num(x.planejado)),
    real: af.map((x) => num(x.real)),
  },
  temManual: !!(manual.avancoFisico?.length || manual.orcadoMensalCusto?.some((o) => o.orcado)),
};

// ---------- HTML ----------
const html = renderHtml(payload);
fs.writeFileSync(path.join(ROOT, 'dashboard.html'), html);
console.log('Dashboard gerado: dashboard.html');
console.log(`  Vendas: ${ativos.length} contratos | VGV ${fmtBRL(vgv)}`);
console.log(`  Carteira a receber (saldo): ${fmtBRL(aReceber)} (vencido ${fmtBRL(recVencido)} · a vencer ${fmtBRL(recAVencer)})`);
console.log(`  Custo real (>=${LANCAMENTO_INICIO}, sem capital/provisao): ${payablesReal.length} titulos | ${fmtBRL(custoReal)}`);
console.log(`    pago ${fmtBRL(custoPago)} | a pagar em aberto ${fmtBRL(aPagarAberto)} | status conhecido p/ ${paidConhecidos}/${payablesReal.length} titulos`);
console.log(`  Suprimentos: ${contratosSup.length} contratos (${supQtdRescindidos} rescindidos) | contratado ${fmtBRL(supTotalContratado)} · realizado ${fmtBRL(supTotalRealizado)} · a realizar ${fmtBRL(supTotalARealizar)}`);
console.log(`  Viabilidade: VGV total ${fmtBRL(vgvTotal)} (contratos ${fmtBRL(vgv)} + permuta/mutuo/reserva ${fmtBRL(vgvPermuta + vgvMutuo + vgvReservaTec)} + estoque ${fmtBRL(vgvEstoque)})`);
console.log(`    Custo total ${fmtBRL(custoProjetado)} = orcamento obra ${fmtBRL(orcamentoObra)} + RET ${retPct}% ${fmtBRL(impostoRET)} | Resultado ${fmtBRL(resultado)} | Margem ${margemPct.toFixed(1)}%`);
console.log(`    (execucao real: obra ${fmtBRL(custoObraReal)} de ${fmtBRL(orcamentoObra)} = ${pctObra.toFixed(0)}% | outros ${fmtBRL(custoOutros)})`);

function renderHtml(d) {
  const J = JSON.stringify(d);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BI ${d.obraNome} — Sienge</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root{--bg:#0f1419;--card:#1a2129;--line:#2a3441;--txt:#e6edf3;--mut:#8b98a5;--ac:#3fb950;--ac2:#58a6ff;--red:#f85149;--yel:#d29922;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
header h1{font-size:20px;font-weight:600}
header .meta{color:var(--mut);font-size:12px}
nav{display:flex;gap:4px;padding:0 28px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:none;border:none;color:var(--mut);padding:14px 16px;cursor:pointer;font-size:14px;border-bottom:2px solid transparent}
nav button.active{color:var(--txt);border-bottom-color:var(--ac)}
nav button:hover{color:var(--txt)}
.tab{display:none;padding:24px 28px}.tab.active{display:block}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.kpi .label{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.kpi .val{font-size:26px;font-weight:700;margin-top:6px}
.kpi .sub{color:var(--mut);font-size:12px;margin-top:4px}
.green{color:var(--ac)}.blue{color:var(--ac2)}.red{color:var(--red)}.yel{color:var(--yel)}.mut{color:var(--mut)}
.chartbox{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:16px}
.chartbox h3{font-size:14px;font-weight:600;margin-bottom:14px;color:var(--txt)}
.chartbox canvas{max-height:340px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase}
td.r,th.r{text-align:right}
.note{background:#1c2530;border:1px solid var(--line);border-left:3px solid var(--yel);padding:12px 16px;border-radius:6px;color:var(--mut);margin-top:16px;font-size:13px}
.row2{display:grid;gap:16px;grid-template-columns:1fr 1fr}@media(max-width:900px){.row2{grid-template-columns:1fr}}
</style></head>
<body>
<header>
  <div><h1>📊 ${d.obraNome}</h1><div class="meta">Fonte: API Sienge — empresa 3 (SPE 01) · gerado em ${new Date(d.geradoEm).toLocaleString('pt-BR')}</div></div>
  <div class="meta">Período: ${d.janela.startDate || '?'} a ${d.janela.endDate || '?'}</div>
</header>
<nav id="nav"></nav>
<main>
  <section class="tab active" data-tab="geral"></section>
  <section class="tab" data-tab="viabilidade"></section>
  <section class="tab" data-tab="orcado"></section>
  <section class="tab" data-tab="vendas"></section>
  <section class="tab" data-tab="financeiro"></section>
  <section class="tab" data-tab="suprimentos"></section>
  <section class="tab" data-tab="cronograma"></section>
  <section class="tab" data-tab="fisico"></section>
</main>
<script>
const D=${J};
const BRL=v=>(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
const PCT=v=>(v||0).toFixed(1)+'%';
const tabs=[['geral','Visão geral'],['viabilidade','Viabilidade'],['orcado','Orçado × Realizado'],['vendas','Vendas'],['financeiro','Financeiro'],['suprimentos','Suprimentos'],['cronograma','Cronograma de obra'],['fisico','Avanço físico']];
const nav=document.getElementById('nav');
tabs.forEach(([id,label],i)=>{const b=document.createElement('button');b.textContent=label;if(i===0)b.className='active';b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelector('.tab[data-tab="'+id+'"]').classList.add('active');};nav.appendChild(b);});

function kpi(label,val,sub,cls){return '<div class="card kpi"><div class="label">'+label+'</div><div class="val '+(cls||'')+'">'+val+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>';}
function box(title,canvasId){return '<div class="chartbox"><h3>'+title+'</h3><canvas id="'+canvasId+'"></canvas></div>';}

const k=D.kpis;
const anomBox=()=>''; // banner de anomalia/RET removido (a pedido)
// GERAL — dashboard resumo
const vg=D.viabilidade, fg=D.financeiro;
document.querySelector('[data-tab="geral"]').innerHTML=
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">Viabilidade</h3>'+
 '<div class="grid">'+
 kpi('VGV total',BRL(vg.vgvTotal),k.unidTotal+' unidades','green')+
 kpi('Custo total',BRL(vg.custoProjetado),'orçamento obra + RET','yel')+
 kpi('Resultado projetado',BRL(vg.resultado),'VGV − custo',vg.resultado>=0?'green':'red')+
 kpi('Margem de resultado',PCT(vg.margemPct),'resultado / VGV',vg.margemPct>=0?'green':'red')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">Vendas e estoque</h3>'+
 '<div class="grid">'+
 kpi('Unidades vendidas',k.unidVendidas+' / '+k.unidTotal,k.unidDisponiveis+' disponíveis (estoque)','blue')+
 kpi('VGV vendido',BRL(vg.vgvVendido),PCT(vg.vgvTotal?100*vg.vgvVendido/vg.vgvTotal:0)+' do VGV','green')+
 kpi('VGV em estoque',BRL(vg.vgvEstoque),k.unidDisponiveis+' un. a vender','yel')+
 kpi('Contratos ativos',k.contratosAtivos,k.contratosCancelados+' cancelados')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">Financeiro</h3>'+
 '<div class="grid">'+
 kpi('A receber (carteira)',BRL(fg.carteiraAReceber),'saldo das parcelas','blue')+
 kpi('Obra realizada',BRL(fg.obraConstrucao),PCT(fg.pctObra)+' do orçado','yel')+
 (fg.temPaid?kpi('A pagar em aberto',BRL(fg.obraAberto),'saldo a vencer','red'):'')+
 kpi('Suprimentos a realizar',BRL(fg.suprARealizar),'compromisso de obra')+
 '</div>'+
 '<div class="row2">'+box('Receita × Custo por mês','cGeral')+box('VGV × Custo × Resultado','cGeralRes')+'</div>';

// VIABILIDADE — tudo da API Sienge
const v=D.viabilidade;
document.querySelector('[data-tab="viabilidade"]').innerHTML=
 '<div class="grid">'+
 kpi('VGV total',BRL(v.vgvTotal),'todas as unidades','green')+
 kpi('VGV vendido (comprometido)',BRL(v.vgvVendido),PCT(v.vgvTotal?100*v.vgvVendido/v.vgvTotal:0)+' do VGV','blue')+
 kpi('VGV estoque (a vender)',BRL(v.vgvEstoque),v.areaEstoque.toFixed(0)+' m² · '+BRL(v.precoM2Estoque)+'/m²','yel')+
 kpi('Custo total',BRL(v.custoProjetado),'orçamento obra + RET')+
 kpi('Resultado projetado',BRL(v.resultado),'VGV − custo',v.resultado>=0?'green':'red')+
 kpi('Margem de resultado',PCT(v.margemPct),'resultado / VGV',v.margemPct>=0?'green':'red')+
 kpi('Obra realizada',PCT(v.pctObra),BRL(v.custoObraReal)+' de '+BRL(v.orcamentoObra),'blue')+
 '</div>'+
 '<div class="chartbox"><h3>Avanço da obra (financeiro)</h3><div style="background:#0f1419;border:1px solid var(--line);border-radius:8px;height:26px;overflow:hidden"><div style="height:100%;width:'+Math.min(v.pctObra,100).toFixed(1)+'%;background:linear-gradient(90deg,#3fb950,#58a6ff);display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#fff;font-size:12px;font-weight:600">'+PCT(v.pctObra)+'</div></div><div class="sub" style="margin-top:6px;color:var(--mut)">Realizado '+BRL(v.custoObraReal)+' de '+BRL(v.orcamentoObra)+' orçado (Contas Pagas - Obra, plano 2.02, líquido)</div></div>'+
 '<div class="row2">'+box('Composição do VGV','cViabVgv')+box('VGV × Custo × Resultado','cViabRes')+'</div>'+
 '<div class="row2">'+
 '<div class="chartbox"><h3>Custo total da viabilidade</h3><table><tbody>'+
 '<tr><td>Orçamento da obra <span style="color:var(--mut)">(manual)</span></td><td class="r">'+BRL(v.orcamentoObra)+'</td></tr>'+
 '<tr><td>Impostos — RET ('+v.retPct+'% do VGV)</td><td class="r">'+BRL(v.impostoRET)+'</td></tr>'+
 '<tr><td><b>Custo total</b></td><td class="r"><b>'+BRL(v.custoProjetado)+'</b></td></tr>'+
 '<tr><td style="color:var(--mut);padding-top:14px">Execução real da obra (Sienge): '+BRL(v.custoObraReal)+' = '+PCT(v.pctObra)+' do orçado</td><td></td></tr>'+
 '<tr><td style="color:var(--mut)">Outros custos lançados (terreno/comercial/adm): '+BRL(v.custoOutros)+'</td><td></td></tr>'+
 '</tbody></table></div>'+
 '<div class="chartbox"><h3>Composição do VGV por situação</h3><table><tbody>'+
 '<tr><td>Vendido (contratos)</td><td class="r">'+BRL(v.vgvContratos)+'</td></tr>'+
 (v.vgvPermuta?'<tr><td>Permuta</td><td class="r">'+BRL(v.vgvPermuta)+'</td></tr>':'')+
 (v.vgvMutuo?'<tr><td>Mútuo</td><td class="r">'+BRL(v.vgvMutuo)+'</td></tr>':'')+
 (v.vgvReservaTec?'<tr><td>Reserva técnica</td><td class="r">'+BRL(v.vgvReservaTec)+'</td></tr>':'')+
 '<tr><td>Estoque a vender (Disponível)</td><td class="r yel">'+BRL(v.vgvEstoque)+'</td></tr>'+
 '<tr><td><b>VGV total</b></td><td class="r"><b>'+BRL(v.vgvTotal)+'</b></td></tr>'+
 '</tbody></table></div>'+
 '</div>'+
 '<div class="note">Tudo da API Sienge. VGV = "Valor Atual" das unidades (/units, confere com o relatório de Estoque do Comercial); vendido usa o valor de contrato. Custo a partir de 01/08/2023 (lançamento das vendas), excluindo capital (empréstimos/aportes/sócios/mútuo) e provisões — '+v.classificados+' títulos classificados por categoria. Sem comissão (retida no ato pelo corretor).</div>';

// ORCADO x REALIZADO
document.querySelector('[data-tab="orcado"]').innerHTML=box('Custo: Orçado × Realizado (por mês)','cOrc')+
 '<div class="note">Realizado = títulos a pagar emitidos (API Sienge). Orçado = valores que você preenche em <b>data/manual.json</b>.</div>';

// VENDAS
document.querySelector('[data-tab="vendas"]').innerHTML='<div class="grid">'+
 kpi('VGV',BRL(k.vgv),null,'green')+kpi('Contratos ativos',k.contratosAtivos)+kpi('Cancelados',k.contratosCancelados,null,'red')+
 kpi('Estoque',k.unidDisponiveis+' un.',k.unidVendidas+' comprometidas')+'</div>'+
 '<div class="row2">'+box('VGV por mês (data do contrato)','cVgv')+box('Unidades: vendidas × estoque','cUnid')+'</div>';

// FINANCEIRO
const fin=D.financeiro;
document.querySelector('[data-tab="financeiro"]').innerHTML=
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">A receber — Carteira (saldo das parcelas)</h3>'+
 '<div class="grid">'+
 kpi('A receber (carteira)',BRL(fin.carteiraAReceber),'saldo devedor dos contratos','blue')+
 kpi('A vencer',BRL(fin.carteiraAVencer),'parcelas futuras','green')+
 kpi('Vencido (em atraso)',BRL(fin.carteiraVencido),PCT(fin.carteiraAReceber?100*fin.carteiraVencido/fin.carteiraAReceber:0)+' da carteira','red')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">A vender — Estoque (potencial, não é recebível ainda)</h3>'+
 '<div class="grid">'+
 kpi('VGV de estoque',BRL(fin.estoqueVgv),fin.estoqueUnid+' unidades disponíveis','yel')+
 kpi('Potencial total (carteira + estoque)',BRL(fin.carteiraAReceber+fin.estoqueVgv),'a receber + a vender')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">Obra — Construção (a partir de ago/2023)</h3>'+
 '<div class="grid">'+
 kpi('Obra realizada',BRL(fin.obraConstrucao),PCT(fin.pctObra)+' do orçado ('+BRL(fin.orcamentoObra)+')','yel')+
 kpi('Suprimentos a realizar',BRL(fin.suprARealizar),'compromisso de obra','blue')+
 (fin.temPaid?kpi('Já pago (total real)',BRL(fin.obraPago),PCT(fin.custoReal?100*fin.obraPago/fin.custoReal:0)+' do custo','green'):'')+
 (fin.temPaid?kpi('A pagar em aberto',BRL(fin.obraAberto),'saldo a vencer','red'):'')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">Outros custos do empreendimento</h3>'+
 '<div class="grid">'+
 kpi('Outros custos',BRL(fin.outros),'terreno, pessoal, tributos, comercial…')+
 kpi('Custo real total',BRL(fin.custoReal),fin.obraTitulos+' títulos (obra + outros)')+
 '</div>'+
 '<div class="note">Obra = categorias de construção (materiais, serviços, projetos). Outros = terreno, pessoal, tributos, jurídico, comercial. Exclui capital (empréstimos/aportes/sócios/mútuo) e provisões. Orçamento de obra (R$83M) é referência informada; pago × a pagar vêm do status das parcelas.</div>'+
 box('Fluxo: Entradas × Saídas por mês','cFluxo')+
 '<div class="chartbox"><h3>Top fornecedores (custo real)</h3><table><thead><tr><th>Fornecedor</th><th class="r">Valor</th></tr></thead><tbody>'+
 D.topCredores.map(c=>'<tr><td>'+c.nome+'</td><td class="r">'+BRL(c.valor)+'</td></tr>').join('')+'</tbody></table></div>';

// SUPRIMENTOS
const sup=D.suprimentos;
const statusLabel={PARTIALLY_MEASURED:'Em medição',COMPLETED:'Concluído',FULLY_MEASURED:'Medido 100%',PENDING:'Pendente',RESCINDED:'Rescindido'};
const stLbl=s=>statusLabel[s]||s||'—';
document.querySelector('[data-tab="suprimentos"]').innerHTML='<div class="grid">'+
 kpi('Total contratado',BRL(sup.totalContratado),sup.qtdContratos+' contratos'+(sup.qtdRescindidos?' · '+sup.qtdRescindidos+' rescindidos':''),'blue')+
 kpi('Realizado (medido)',BRL(sup.totalRealizado),PCT(sup.pctExec)+' executado','green')+
 kpi('A realizar (saldo)',BRL(sup.totalARealizar),'exclui rescindidos','yel')+
 kpi('Fornecedores',sup.qtdFornecedores,null)+
 '</div>'+
 box('Contratado × Realizado × A realizar (por contrato — top 15)','cSupBar')+
 '<div class="chartbox"><h3>Contratos de fornecimento ('+sup.contratos.length+')</h3><div style="overflow:auto;max-height:520px"><table><thead><tr><th>Contrato</th><th>Fornecedor</th><th>Status</th><th class="r">Contratado</th><th class="r">Realizado</th><th class="r">A realizar</th><th class="r">%</th></tr></thead><tbody>'+
 sup.contratos.map(c=>'<tr'+(c.rescindido?' style="opacity:.45"':'')+'><td>'+c.doc+'</td><td title="'+(c.objeto||'').replace(/"/g,'&quot;')+'">'+c.fornecedor+'</td><td>'+stLbl(c.status)+'</td><td class="r">'+BRL(c.contratado)+'</td><td class="r">'+BRL(c.realizado)+'</td><td class="r">'+BRL(c.aRealizar)+'</td><td class="r">'+PCT(c.pct)+'</td></tr>').join('')+
 '</tbody></table></div></div>'+
 '<div class="chartbox"><h3>Por fornecedor ('+sup.fornecedores.length+')</h3><div style="overflow:auto;max-height:520px"><table><thead><tr><th>Fornecedor</th><th class="r">Contratos</th><th class="r">Contratado</th><th class="r">Realizado</th><th class="r">A realizar</th><th class="r">%</th></tr></thead><tbody>'+
 sup.fornecedores.map(f=>'<tr><td>'+f.fornecedor+'</td><td class="r">'+f.contratos+'</td><td class="r">'+BRL(f.contratado)+'</td><td class="r">'+BRL(f.realizado)+'</td><td class="r">'+BRL(f.aRealizar)+'</td><td class="r">'+PCT(f.pct)+'</td></tr>').join('')+
 '</tbody></table></div></div>';

// CRONOGRAMA
const temCron=D.cronograma.meses.length>0;
document.querySelector('[data-tab="cronograma"]').innerHTML=(temCron?
 box('Cronograma físico-financeiro: Contratado × Realizado (acumulado)','cCron')+
 '<div class="note">Curva de <b>contratado</b> = soma acumulada dos contratos de fornecimento por data de assinatura. Curva de <b>realizado</b> = soma acumulada das medições por data. Fonte: Suprimentos do Sienge (obra Reserva).</div>'
 :'<div class="note">Sem dados de suprimentos para montar o cronograma.</div>')+
 (D.avancoFisico.meses.length?box('Avanço físico %: Planejado × Real','cCronAF'):'');

// FISICO
const temAF=D.avancoFisico.meses.length>0;
document.querySelector('[data-tab="fisico"]').innerHTML= temAF? box('Avanço físico: Planejado × Real (curva S)','cAF') :
 '<div class="note">Nenhum avanço físico preenchido. Edite <b>data/manual.json</b> → campo <b>avancoFisico</b> (mes, planejado, real) e rode <b>npm run build</b>.</div>';

// ===== Charts =====
Chart.defaults.color='#8b98a5';Chart.defaults.borderColor='#2a3441';
const mk=(id,cfg)=>{const el=document.getElementById(id);if(el)new Chart(el,cfg);};
const ds=(label,data,color,type)=>({label,data,borderColor:color,backgroundColor:color+'33',type:type||'line',tension:.3,borderWidth:2,fill:type==='line'||!type});

mk('cGeral',{data:{labels:D.fin.meses,datasets:[ds('Receita',D.fin.receita,'#3fb950'),ds('Custo',D.fin.custo,'#d29922')]},options:{responsive:true,plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
mk('cOrc',{type:'bar',data:{labels:D.fin.meses,datasets:[{label:'Orçado',data:D.fin.orcado,backgroundColor:'#58a6ff88'},{label:'Realizado',data:D.fin.custo,backgroundColor:'#d2992288'}]},options:{plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
mk('cVgv',{type:'bar',data:{labels:D.vendas.meses,datasets:[{label:'VGV',data:D.vendas.vgvMes,backgroundColor:'#3fb95088'}]},options:{plugins:{tooltip:{callbacks:{label:c=>BRL(c.parsed.y)}}}}});
mk('cUnid',{type:'doughnut',data:{labels:['Comprometidas','Disponíveis'],datasets:[{data:[k.unidVendidas,k.unidDisponiveis],backgroundColor:['#3fb950','#d29922']}]}});
mk('cFluxo',{data:{labels:D.fin.meses,datasets:[ds('Entradas',D.fin.receita,'#3fb950'),ds('Saídas',D.fin.custo,'#f85149')]},options:{plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
// Visao geral: VGV x Custo x Resultado
mk('cGeralRes',{type:'bar',data:{labels:['VGV total','Custo total','Resultado'],datasets:[{data:[vg.vgvTotal,vg.custoProjetado,vg.resultado],backgroundColor:['#58a6ff','#f85149',vg.resultado>=0?'#3fb950':'#f85149']}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>BRL(c.parsed.y)}}}}});
// Viabilidade
mk('cViabVgv',{type:'doughnut',data:{labels:['VGV vendido (comprometido)','VGV estoque (a vender)'],datasets:[{data:[v.vgvVendido,v.vgvEstoque],backgroundColor:['#3fb950','#d29922']}]},options:{plugins:{tooltip:{callbacks:{label:c=>c.label+': '+BRL(c.parsed)}}}}});
mk('cViabRes',{type:'bar',data:{labels:['VGV total','Custo total','Resultado'],datasets:[{data:[v.vgvTotal,v.custoProjetado,v.resultado],backgroundColor:['#58a6ff','#f85149',v.resultado>=0?'#3fb950':'#f85149']}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>BRL(c.parsed.y)}}}}});
// Suprimentos: barras por contrato (top 15 por contratado)
const supTop=sup.contratos.slice(0,15);
mk('cSupBar',{type:'bar',data:{labels:supTop.map(c=>c.fornecedor.length>22?c.fornecedor.slice(0,22)+'…':c.fornecedor),datasets:[{label:'Realizado',data:supTop.map(c=>c.realizado),backgroundColor:'#3fb950cc'},{label:'A realizar',data:supTop.map(c=>c.aRealizar),backgroundColor:'#d29922aa'}]},options:{indexAxis:'y',scales:{x:{stacked:true},y:{stacked:true}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.x)}}}}});
if(temCron)mk('cCron',{data:{labels:D.cronograma.meses,datasets:[ds('Contratado (acum.)',D.cronograma.contratadoAcum,'#58a6ff'),ds('Realizado/medido (acum.)',D.cronograma.medidoAcum,'#3fb950')]},options:{plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
if(D.avancoFisico.meses.length)mk('cCronAF',{data:{labels:D.avancoFisico.meses,datasets:[ds('Planejado',D.avancoFisico.planejado,'#58a6ff'),ds('Real',D.avancoFisico.real,'#3fb950')]},options:{scales:{y:{ticks:{callback:v=>v+'%'},max:100}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+PCT(c.parsed.y)}}}}});
if(temAF)mk('cAF',{data:{labels:D.avancoFisico.meses,datasets:[ds('Planejado',D.avancoFisico.planejado,'#58a6ff'),ds('Real',D.avancoFisico.real,'#3fb950')]},options:{scales:{y:{ticks:{callback:v=>v+'%'},max:100}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+PCT(c.parsed.y)}}}}});
</script>
</body></html>`;
}
