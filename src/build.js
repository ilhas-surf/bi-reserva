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

// ---------- ORCADO x REALIZADO (custo) ----------
const orcMap = {};
for (const o of (manual.orcadoMensalCusto || [])) orcMap[o.mes] = num(o.orcado);

// ---------- AVANCO FISICO ----------
const af = manual.avancoFisico || [];

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
.green{color:var(--ac)}.blue{color:var(--ac2)}.red{color:var(--red)}.yel{color:var(--yel)}
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
  <section class="tab" data-tab="orcado"></section>
  <section class="tab" data-tab="vendas"></section>
  <section class="tab" data-tab="financeiro"></section>
  <section class="tab" data-tab="fisico"></section>
</main>
<script>
const D=${J};
const BRL=v=>(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0});
const PCT=v=>(v||0).toFixed(1)+'%';
const tabs=[['geral','Visão geral'],['orcado','Orçado × Realizado'],['vendas','Vendas'],['financeiro','Financeiro'],['fisico','Avanço físico']];
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

// ORCADO x REALIZADO
document.querySelector('[data-tab="orcado"]').innerHTML=box('Custo: Orçado × Realizado (por mês)','cOrc')+
 '<div class="note">Realizado = títulos a pagar emitidos (API Sienge). Orçado = valores que você preenche em <b>data/manual.json</b>.</div>';

// VENDAS
document.querySelector('[data-tab="vendas"]').innerHTML='<div class="grid">'+
 kpi('VGV',BRL(k.vgv),null,'green')+kpi('Contratos ativos',k.contratosAtivos)+kpi('Cancelados',k.contratosCancelados,null,'red')+
 kpi('Estoque',k.unidEstoque+' un.',k.unidVendidas+' vendidas')+'</div>'+
 '<div class="row2">'+box('VGV por mês (data do contrato)','cVgv')+box('Unidades: vendidas × estoque','cUnid')+'</div>';

// FINANCEIRO
document.querySelector('[data-tab="financeiro"]').innerHTML='<div class="grid">'+
 kpi('Entradas (recebíveis)',BRL(k.recTotal),'Recebido '+BRL(k.recebido),'green')+
 kpi('Saídas (a pagar)',BRL(k.custoTotal),null,'yel')+
 kpi('A receber',BRL(k.aReceber),null,'blue')+'</div>'+anomBox()+
 box('Fluxo: Entradas × Saídas por mês','cFluxo')+
 '<div class="chartbox"><h3>Top fornecedores (por valor a pagar)</h3><table><thead><tr><th>Fornecedor</th><th class="r">Valor</th></tr></thead><tbody>'+
 D.topCredores.map(c=>'<tr><td>'+c.nome+'</td><td class="r">'+BRL(c.valor)+'</td></tr>').join('')+'</tbody></table></div>';

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
if(temAF)mk('cAF',{data:{labels:D.avancoFisico.meses,datasets:[ds('Planejado',D.avancoFisico.planejado,'#58a6ff'),ds('Real',D.avancoFisico.real,'#3fb950')]},options:{scales:{y:{ticks:{callback:v=>v+'%'},max:100}},plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+': '+PCT(c.parsed.y)}}}}});
</script>
</body></html>`;
}
