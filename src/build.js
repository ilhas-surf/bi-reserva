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
const summary = read('_summary.json', {});

// ---------- Entrada manual (orcado / avanco fisico) ----------
const MANUAL_FILE = path.join(DATA, 'manual.json');
if (!fs.existsSync(MANUAL_FILE)) {
  const template = {
    _instrucoes: 'Preencha aqui os dados que NAO vem do Sienge. Datas no formato AAAA-MM. Depois rode: npm run build',
    obraNome: 'Reserva - SPE 01',
    avancoFisico: [
      { mes: '2025-01', planejado: 5, real: 4 },
      { mes: '2025-02', planejado: 12, real: 10 }
    ],
    orcadoMensalCusto: [
      { mes: '2025-01', orcado: 0 },
      { mes: '2025-02', orcado: 0 }
    ],
    viabilidade: {
      _ajuda: 'Premissas da viabilidade que NAO vem do Sienge. Deixe 0/vazio para usar a estimativa automatica.',
      vgvEstoque: 0,        // R$ do estoque a vender; 0 = estima por preco/m2 dos vendidos
      deducoesPct: 0,       // % sobre o VGV (impostos sobre venda + comissao) p/ VGV liquido
      custoTotalOrcado: 0,  // custo total orcado da obra (terreno+obra+despesas); 0 = usa lancado+suprimentos+terreno+despesas
      custoTerreno: 0,      // usado so quando custoTotalOrcado=0
      outrasDespesas: 0     // usado so quando custoTotalOrcado=0
    }
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

// unidades por commercialStock (Sienge): V=Vendida, R=Reservada, D=Disponivel,
// E/M = nao comercializaveis (estoque/permuta/escritorio).
const stk = { V: 0, R: 0, D: 0, E: 0, M: 0, outros: 0 };
for (const u of units) {
  const c = (u.commercialStock || '').toString().toUpperCase();
  if (c in stk) stk[c]++; else stk.outros++;
}
const unidVendidas = stk.V;
const unidReservadas = stk.R;
const unidDisponiveis = stk.D;
const unidComercializaveis = stk.V + stk.R + stk.D;
const unidTotal = units.length;
let unidEstoque = unidDisponiveis;
if (!unidTotal && ativos.length) { // fallback: conta unidades dos contratos
  const us = new Set();
  for (const c of ativos) for (const u of (c.salesContractUnits || [])) us.add(u.unitId ?? u.id);
}

// area privativa por commercialStock (para estimar preco/m2 e VGV de estoque)
const areaStk = { V: 0, R: 0, D: 0, E: 0, M: 0 };
for (const u of units) {
  const c = (u.commercialStock || '').toString().toUpperCase();
  if (c in areaStk) areaStk[c] += num(u.privateArea);
}

// ---------- RECEBIVEIS ----------
const recTotal = receivables.reduce((s, r) => s + num(r.receivableBillValue), 0);
const recebido = receivables.filter((r) => r.payOffDate).reduce((s, r) => s + num(r.receivableBillValue), 0);
const aReceber = recTotal - recebido;
const inadimplencia = receivables.filter((r) => r.defaulting).reduce((s, r) => s + num(r.receivableBillValue), 0);
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

const custoTotal = payablesOk.reduce((s, b) => s + num(b.totalInvoiceAmount), 0);
const custoPorMes = byMonth(payablesOk, 'issueDate', 'totalInvoiceAmount');
const porCredor = {};
for (const b of payablesOk) {
  const id = b.creditorId;
  porCredor[id] = (porCredor[id] || 0) + num(b.totalInvoiceAmount);
}
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

// ---------- VIABILIDADE (indicadores) ----------
// VGV vendido (carteira) vem da API. VGV de estoque a API nao traz preco -> estima por
// preco/m2 medio dos vendidos, ou usa valor manual (viabilidade.vgvEstoque) se preenchido.
// VGV liquido = VGV - deducoes (impostos+comissao, % manual). Margem = resultado / VGV liquido,
// com custo total = orcado manual (viabilidade.custoTotalOrcado) ou, na falta, custo lancado + suprimentos a realizar.
const viab = manual.viabilidade || {};
const vgvVendido = vgv;
const precoM2 = areaStk.V ? vgvVendido / areaStk.V : 0;
const vgvEstoqueEstimado = precoM2 * areaStk.D;
const vgvEstoqueManual = num(viab.vgvEstoque);
const vgvEstoque = vgvEstoqueManual > 0 ? vgvEstoqueManual : vgvEstoqueEstimado;
const vgvEstoqueFonte = vgvEstoqueManual > 0 ? 'manual' : 'estimado';
const vgvTotal = vgvVendido + vgvEstoque;
const deducoesPct = num(viab.deducoesPct);            // % sobre o VGV (impostos sobre venda + comissao)
const deducoesValor = vgvTotal * deducoesPct / 100;
const vgvLiquido = vgvTotal - deducoesValor;
const vgvVendidoLiquido = vgvVendido * (1 - deducoesPct / 100);
// custo total da viabilidade
const custoTotalOrcado = num(viab.custoTotalOrcado);
const custoTerreno = num(viab.custoTerreno);
const outrasDespesas = num(viab.outrasDespesas);
// custo lancado (obra) ja temos em custoTotal (payables). Suprimentos a realizar = compromisso futuro.
// custo estimado p/ conclusao = custo lancado + saldo a realizar de suprimentos (+ terreno/despesas manuais)
const custoProjetado = custoTotalOrcado > 0
  ? custoTotalOrcado
  : (custoTotal + (typeof supTotalARealizar === 'number' ? supTotalARealizar : 0) + custoTerreno + outrasDespesas);
const custoProjetadoFonte = custoTotalOrcado > 0 ? 'orcado' : 'estimado';
const resultado = vgvLiquido - custoProjetado;
const margemPct = vgvLiquido ? 100 * resultado / vgvLiquido : 0;
const exposicaoCaixa = custoTotal - recebido; // quanto ja saiu menos quanto ja entrou
const temViab = !!(viab.vgvEstoque || viab.deducoesPct || viab.custoTotalOrcado);

// ---------- Series para graficos ----------
const mesesFin = sortedMonths(Object.keys(custoPorMes), Object.keys(recPorMes), Object.keys(orcMap));
const mesesVendas = sortedMonths(Object.keys(contratosPorMes));

const payload = {
  geradoEm: summary.generatedAt || new Date().toISOString(),
  janela: summary.window || {},
  obraNome: manual.obraNome || 'SPE 01',
  kpis: {
    vgv, contratosAtivos: ativos.length, contratosCancelados: canceladas.length,
    unidVendidas, unidReservadas, unidDisponiveis, unidComercializaveis, unidTotal, unidEstoque,
    recTotal, recebido, aReceber, inadimplencia,
    custoTotal, qtdTitulosPagar: payablesOk.length,
    resultadoBruto: recTotal - custoTotal,
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
    vgvVendido, vgvEstoque, vgvEstoqueFonte, vgvTotal,
    precoM2, areaVendida: areaStk.V, areaEstoque: areaStk.D,
    deducoesPct, deducoesValor, vgvLiquido, vgvVendidoLiquido,
    custoLancado: custoTotal, custoSuprimentosARealizar: supTotalARealizar,
    custoTerreno, outrasDespesas, custoProjetado, custoProjetadoFonte,
    resultado, margemPct, exposicaoCaixa, temViab,
  },
  financeiro: {
    // carteira (vendido) — firme, da API
    carteiraTotal: recTotal, carteiraRecebido: recebido, carteiraAReceber: aReceber,
    carteiraInadimplencia: inadimplencia,
    // estoque (a vender) — potencial, nao e conta a receber ainda
    estoqueVgv: vgvEstoque, estoqueUnid: unidDisponiveis, estoqueFonte: vgvEstoqueFonte,
    // obra (custo lancado) — sem split pago/a-pagar (decisao do usuario)
    obraLancado: custoTotal, obraTitulos: payablesOk.length,
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
console.log(`  Recebiveis: ${fmtBRL(recTotal)} (recebido ${fmtBRL(recebido)}, inadimpl. ${fmtBRL(inadimplencia)})`);
console.log(`  Custos (a pagar): ${payablesOk.length} titulos | ${fmtBRL(custoTotal)}`);
console.log(`  Suprimentos: ${contratosSup.length} contratos (${supQtdRescindidos} rescindidos) | contratado ${fmtBRL(supTotalContratado)} · realizado ${fmtBRL(supTotalRealizado)} · a realizar ${fmtBRL(supTotalARealizar)}`);
console.log(`  Viabilidade: VGV total ${fmtBRL(vgvTotal)} (vendido ${fmtBRL(vgvVendido)} + estoque ${fmtBRL(vgvEstoque)} [${vgvEstoqueFonte}]) | margem ${margemPct.toFixed(1)}% [custo ${custoProjetadoFonte}]`);
if (anomalias.length) {
  console.log(`  ! ${anomalias.length} titulo(s) anomalo(s) excluido(s) (> VGV):`);
  for (const a of anomalias) console.log(`    - #${a.id} ${fmtBRL(a.valor)} ${a.credor} "${a.nota}"`);
}

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
function anomBox(){if(!D.anomalias||!D.anomalias.length)return '';
 return '<div class="note" style="border-color:#7d4e00;background:#2a1f0a">⚠️ '+D.anomalias.length+' título(s) a pagar excluído(s) do custo por serem maiores que o VGV inteiro — provável erro de lançamento no Sienge:<ul style="margin:6px 0 0 18px">'+
 D.anomalias.map(a=>'<li>#'+a.id+' · '+BRL(a.valor)+' · '+a.credor+(a.nota?' · "'+a.nota+'"':'')+(a.data?' · '+a.data:'')+'</li>').join('')+'</ul></div>';}
// GERAL
document.querySelector('[data-tab="geral"]').innerHTML='<div class="grid">'+
 kpi('VGV (contratos ativos)',BRL(k.vgv),k.contratosAtivos+' contratos','green')+
 kpi('Unidades vendidas',k.unidVendidas+' / '+k.unidComercializaveis,k.unidDisponiveis+' disponíveis · '+k.unidReservadas+' reservadas','blue')+
 kpi('Total a receber',BRL(k.recTotal),'Recebido '+BRL(k.recebido))+
 kpi('Inadimplência',BRL(k.inadimplencia),PCT(k.recTotal?100*k.inadimplencia/k.recTotal:0)+' do total','red')+
 kpi('Custo (contas a pagar)',BRL(k.custoTotal),k.qtdTitulosPagar+' títulos','yel')+
 kpi('Resultado (receb. − custo)',BRL(k.resultadoBruto),'visão de caixa simplificada',k.resultadoBruto>=0?'green':'red')+
 '</div>'+anomBox()+box('Receita × Custo por mês','cGeral')+
 (D.temManual?'':'<div class="note">💡 Preencha <b>data/manual.json</b> (orçado mensal e avanço físico) e rode <b>npm run build</b> para ativar as abas Orçado×Realizado e Avanço físico.</div>');

// VIABILIDADE
const v=D.viabilidade;
const fonteTag=f=>f==='manual'||f==='orcado'?'<span style="color:var(--ac)">'+(f==='manual'?'manual':'orçado')+'</span>':'<span style="color:var(--yel)">estimado</span>';
document.querySelector('[data-tab="viabilidade"]').innerHTML=
 '<div class="grid">'+
 kpi('VGV total',BRL(v.vgvTotal),'vendido + estoque','green')+
 kpi('VGV líquido',BRL(v.vgvLiquido),v.deducoesPct?('após '+PCT(v.deducoesPct)+' de deduções'):'sem deduções (preencher)','blue')+
 kpi('VGV vendido (carteira)',BRL(v.vgvVendido),PCT(v.vgvTotal?100*v.vgvVendido/v.vgvTotal:0)+' do VGV')+
 kpi('VGV estoque (a vender)',BRL(v.vgvEstoque),v.areaEstoque.toFixed(0)+' m² · '+(v.vgvEstoqueFonte==='manual'?'manual':'estimado p/ m²'),'yel')+
 (v.custoProjetadoFonte==='orcado'
   ? kpi('Resultado projetado',BRL(v.resultado),'VGV líq − custo orçado',v.resultado>=0?'green':'red')+
     kpi('Margem de resultado',PCT(v.margemPct),'resultado / VGV líquido',v.margemPct>=0?'green':'red')
   : kpi('Resultado projetado','—','preencha o custo orçado','mut')+
     kpi('Margem de resultado','—','preencha o custo orçado','mut'))+
 '</div>'+
 '<div class="row2">'+box('Composição do VGV','cViabVgv')+(v.custoProjetadoFonte==='orcado'?box('VGV líquido × Custo × Resultado','cViabRes'):'')+'</div>'+
 '<div class="chartbox"><h3>Premissas e fontes</h3><table><tbody>'+
 '<tr><td>Preço médio / m² (vendidos)</td><td class="r">'+BRL(v.precoM2)+'/m²</td></tr>'+
 '<tr><td>Área vendida × estoque</td><td class="r">'+v.areaVendida.toFixed(0)+' m² · '+v.areaEstoque.toFixed(0)+' m²</td></tr>'+
 '<tr><td>VGV de estoque</td><td class="r">'+BRL(v.vgvEstoque)+' ('+fonteTag(v.vgvEstoqueFonte)+')</td></tr>'+
 '<tr><td>Deduções sobre venda (impostos+comissão)</td><td class="r">'+PCT(v.deducoesPct)+' = '+BRL(v.deducoesValor)+'</td></tr>'+
 '<tr><td>Custo lançado na obra (API)</td><td class="r">'+BRL(v.custoLancado)+'</td></tr>'+
 '<tr><td>Suprimentos a realizar (compromisso)</td><td class="r">'+BRL(v.custoSuprimentosARealizar)+'</td></tr>'+
 (v.custoTerreno?'<tr><td>Terreno (manual)</td><td class="r">'+BRL(v.custoTerreno)+'</td></tr>':'')+
 (v.outrasDespesas?'<tr><td>Outras despesas (manual)</td><td class="r">'+BRL(v.outrasDespesas)+'</td></tr>':'')+
 '<tr><td><b>Custo total considerado</b></td><td class="r"><b>'+BRL(v.custoProjetado)+'</b> ('+fonteTag(v.custoProjetadoFonte)+')</td></tr>'+
 '</tbody></table></div>'+
 (v.temViab?'':'<div class="note">💡 Os valores de <b>estoque</b>, <b>deduções</b> e <b>custo total orçado</b> são estimados. Para precisão, preencha o bloco <b>viabilidade</b> em <b>data/manual.json</b> (vgvEstoque, deducoesPct, custoTotalOrcado, custoTerreno, outrasDespesas) e rode o build.</div>');

// ORCADO x REALIZADO
document.querySelector('[data-tab="orcado"]').innerHTML=box('Custo: Orçado × Realizado (por mês)','cOrc')+
 '<div class="note">Realizado = títulos a pagar emitidos (API Sienge). Orçado = valores que você preenche em <b>data/manual.json</b>.</div>';

// VENDAS
document.querySelector('[data-tab="vendas"]').innerHTML='<div class="grid">'+
 kpi('VGV',BRL(k.vgv),null,'green')+kpi('Contratos ativos',k.contratosAtivos)+kpi('Cancelados',k.contratosCancelados,null,'red')+
 kpi('Estoque',k.unidEstoque+' un.',k.unidVendidas+' vendidas')+'</div>'+
 '<div class="row2">'+box('VGV por mês (data do contrato)','cVgv')+box('Unidades: vendidas × estoque','cUnid')+'</div>';

// FINANCEIRO
const fin=D.financeiro;
document.querySelector('[data-tab="financeiro"]').innerHTML=
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">A receber — Carteira (unidades vendidas)</h3>'+
 '<div class="grid">'+
 kpi('Carteira total',BRL(fin.carteiraTotal),'recebíveis dos contratos','green')+
 kpi('Já recebido',BRL(fin.carteiraRecebido),PCT(fin.carteiraTotal?100*fin.carteiraRecebido/fin.carteiraTotal:0)+' da carteira')+
 kpi('A receber (carteira)',BRL(fin.carteiraAReceber),'saldo dos vendidos','blue')+
 kpi('Inadimplência',BRL(fin.carteiraInadimplencia),PCT(fin.carteiraTotal?100*fin.carteiraInadimplencia/fin.carteiraTotal:0)+' da carteira','red')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">A vender — Estoque (potencial, não é recebível ainda)</h3>'+
 '<div class="grid">'+
 kpi('VGV de estoque',BRL(fin.estoqueVgv),fin.estoqueUnid+' unidades · '+(fin.estoqueFonte==='manual'?'manual':'estimado'),'yel')+
 kpi('Potencial total (carteira + estoque)',BRL(fin.carteiraAReceber+fin.estoqueVgv),'a receber + a vender')+
 '</div>'+
 '<h3 style="color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:22px 0 10px">Obra — Custos (contas lançadas)</h3>'+
 '<div class="grid">'+
 kpi('Custo lançado na obra',BRL(fin.obraLancado),fin.obraTitulos+' títulos a pagar','yel')+
 kpi('Suprimentos contratado',BRL(fin.suprContratado),'realizado '+BRL(fin.suprRealizado))+
 kpi('Suprimentos a realizar',BRL(fin.suprARealizar),'saldo dos contratos','blue')+
 '</div>'+anomBox()+
 '<div class="note">Pago × a pagar não é separado (decisão atual): o Sienge só expõe o status de pagamento parcela a parcela. O valor acima é o total <b>lançado</b> na obra. Dá para ativar a separação depois.</div>'+
 box('Fluxo: Entradas × Saídas por mês','cFluxo')+
 '<div class="chartbox"><h3>Top fornecedores (por valor a pagar)</h3><table><thead><tr><th>Fornecedor</th><th class="r">Valor</th></tr></thead><tbody>'+
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
mk('cUnid',{type:'doughnut',data:{labels:['Vendidas','Reservadas','Disponíveis'],datasets:[{data:[k.unidVendidas,k.unidReservadas,k.unidDisponiveis],backgroundColor:['#3fb950','#d29922','#2a3441']}]}});
mk('cFluxo',{data:{labels:D.fin.meses,datasets:[ds('Entradas',D.fin.receita,'#3fb950'),ds('Saídas',D.fin.custo,'#f85149')]},options:{plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
// Viabilidade
mk('cViabVgv',{type:'doughnut',data:{labels:['VGV vendido (carteira)','VGV estoque (a vender)'],datasets:[{data:[v.vgvVendido,v.vgvEstoque],backgroundColor:['#3fb950','#d29922']}]},options:{plugins:{tooltip:{callbacks:{label:c=>c.label+': '+BRL(c.parsed)}}}}});
mk('cViabRes',{type:'bar',data:{labels:['VGV líquido','Custo total','Resultado'],datasets:[{data:[v.vgvLiquido,v.custoProjetado,v.resultado],backgroundColor:['#58a6ff','#f85149',v.resultado>=0?'#3fb950':'#f85149']}]},options:{plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>BRL(c.parsed.y)}}}}});
// Suprimentos: barras por contrato (top 15 por contratado)
const supTop=sup.contratos.slice(0,15);
mk('cSupBar',{type:'bar',data:{labels:supTop.map(c=>c.fornecedor.length>22?c.fornecedor.slice(0,22)+'…':c.fornecedor),datasets:[{label:'Realizado',data:supTop.map(c=>c.realizado),backgroundColor:'#3fb950cc'},{label:'A realizar',data:supTop.map(c=>c.aRealizar),backgroundColor:'#d29922aa'}]},options:{indexAxis:'y',scales:{x:{stacked:true},y:{stacked:true}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.x)}}}}});
if(temCron)mk('cCron',{data:{labels:D.cronograma.meses,datasets:[ds('Contratado (acum.)',D.cronograma.contratadoAcum,'#58a6ff'),ds('Realizado/medido (acum.)',D.cronograma.medidoAcum,'#3fb950')]},options:{plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+BRL(c.parsed.y)}}}}});
if(D.avancoFisico.meses.length)mk('cCronAF',{data:{labels:D.avancoFisico.meses,datasets:[ds('Planejado',D.avancoFisico.planejado,'#58a6ff'),ds('Real',D.avancoFisico.real,'#3fb950')]},options:{scales:{y:{ticks:{callback:v=>v+'%'},max:100}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+PCT(c.parsed.y)}}}}});
if(temAF)mk('cAF',{data:{labels:D.avancoFisico.meses,datasets:[ds('Planejado',D.avancoFisico.planejado,'#58a6ff'),ds('Real',D.avancoFisico.real,'#3fb950')]},options:{scales:{y:{ticks:{callback:v=>v+'%'},max:100}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+PCT(c.parsed.y)}}}}});
</script>
</body></html>`;
}
