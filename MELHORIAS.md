# Melhorias do BI Reserva

Lista de ideias e ajustes para o painel. Quando quiser implementar, abra uma sessão
com o Claude e diga: **"faz as melhorias do MELHORIAS.md"** — ele pega o lote inteiro
de uma vez (mais rápido e gasta menos token que pedir uma por vez).

## Como pedir (para gastar menos token)
1. **Junte tudo numa lista** — um lote por sessão, não uma correção por mensagem.
2. **Dê a regra/fonte do número** — ex.: "obra = plano 2.02, valor Líquido do relatório".
   Evita o Claude ter que investigar.
3. **Sessão nova para assunto novo** (`/clear`) — o contexto do projeto está salvo na
   memória; sessões longas reprocessam tudo e ficam caras.
4. **Anexe o relatório/dado** (Excel) quando o número não vier da API.
5. **Peça para validar tudo e só publicar no fim** — evita deploys intermediários.

## Backlog (a fazer)

- [ ] **Automatizar "obra realizada"** (hoje manual = R$ 21.964.551,30 em `data/manual.json`).
      É o "Total geral/Líquido" do relatório *Contas Pagas - Obra* (plano financeiro 2.02).
      A API pública dá o pago **bruto** (~R$ 48,7M, conta antecipações PCT/PPC em dobro);
      falta reproduzir o **Líquido** (abater antecipações/substituições) — investigar
      bulk-data (cota) ou o vínculo antecipação→substituição. Atualizar pelo relatório
      enquanto não automatiza.
- [ ] (adicione novas ideias aqui)

## Feito (histórico recente)
- Viabilidade: VGV total (todas as unidades), custo = orçamento obra + RET 4,7%, margem.
- Financeiro: carteira a receber (saldo das parcelas), estoque, obra realizada % + barra.
- Custo real sem capital/provisões; pago × a pagar em aberto; suprimentos; cronograma.
- Visão Geral como dashboard resumo.

## Números manuais (em `data/manual.json`)
Só estes 3 não vêm da API (editar pelo GitHub quando mudarem):
- `orcamentoObra` — orçamento da obra (R$ 83.000.000)
- `obraRealizada` — Líquido do relatório Contas Pagas - Obra (R$ 21.964.551,30)
- `retPct` — alíquota do RET sobre o VGV (4,7)
