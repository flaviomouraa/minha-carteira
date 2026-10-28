/* Minha Carteira — app 100% local (sem servidor). Dados ficam no navegador e, se a pessoa quiser,
   num arquivo na nuvem dela (Google Drive / OneDrive). */
'use strict';

/* =========================================================================
   Utilidades
   ========================================================================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const NUM = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const fmt = v => (v == null || isNaN(v) ? '—' : BRL.format(v));
const fmtN = v => (v == null || isNaN(v) ? '—' : NUM.format(v));
const pct = (v, d = 1) => (v == null || isNaN(v) ? '—' : (v * 100).toFixed(d).replace('.', ',') + '%');
const signedPct = (v, d = 1) => (v == null || isNaN(v) ? '—' : (v > 0 ? '+' : '') + pct(v, d));
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Aceita "1.234,56", "1234.56", "R$ 10,5", "8%" */
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[R$\s%]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/* =========================================================================
   Classes de ativos (cores fixas por classe — nunca mudam com filtros)
   ========================================================================= */
const CLASSES = {
  acao: { label: 'Ações', color: 'var(--s1)' },
  fii:  { label: 'Fundos imobiliários', short: 'FIIs', color: 'var(--s2)' },
  etf:  { label: 'ETFs', color: 'var(--s3)' },
  rf:   { label: 'Renda fixa', color: 'var(--s4)' },
};
const CLASS_KEYS = Object.keys(CLASSES);
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const clsLabel = c => CLASSES[c]?.short || CLASSES[c]?.label || c;

const SETORES_ACOES = ['Bancos', 'Seguros', 'Energia elétrica', 'Saneamento', 'Telecomunicações', 'Petróleo e gás',
  'Mineração', 'Siderurgia', 'Indústria', 'Varejo', 'Consumo', 'Saúde', 'Construção', 'Agronegócio', 'Tecnologia',
  'Logística', 'Papel e celulose', 'Holding'];
// Setores costumeiramente chamados de "perenes" (demanda estável) — usados só como sugestão de diversificação
const SETORES_PERENES = ['Bancos', 'Seguros', 'Energia elétrica', 'Saneamento', 'Telecomunicações'];
const SETORES_FII = ['Logística', 'Lajes corporativas', 'Shoppings', 'Recebíveis (papel)', 'Fundo de fundos', 'Híbrido', 'Agro', 'Renda urbana', 'Hotel', 'Residencial'];
const INDEXADORES = ['Pós-fixado (CDI/Selic)', 'IPCA+', 'Prefixado'];

/* =========================================================================
   Estado
   ========================================================================= */
const STORE_KEY = 'minha-carteira.v1';
const DEFAULT_SETTINGS = {
  token: '',
  bazinYield: 0.06,     // Bazin: preço-teto = dividendos 12m / 6%
  safety: 0.15,         // margem de segurança mínima para "oportunidade"
  dropMin: 0.15,        // queda desde a máxima de 52 semanas considerada relevante
  pvpBuy: 0.95,         // FII: P/VP abaixo disso = desconto
  pvpSell: 1.10,        // FII: P/VP acima disso = caro
  dyMin: 0.08,          // FII: dividend yield mínimo desejado
  maxAsset: 0.15,       // concentração máxima por ativo
};
const DEFAULT_TARGETS = { acao: 35, fii: 25, etf: 10, rf: 30 };

function blankState() {
  return { version: 1, assets: [], radar: [], targets: { ...DEFAULT_TARGETS }, settings: { ...DEFAULT_SETTINGS }, lastUpdate: null, onboarded: false };
}

let state = load();
let ui = { tab: 'painel', aporte: 1000, sortBy: 'value', radarFilter: 'all' };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return blankState();
    const s = JSON.parse(raw);
    const b = blankState();
    return { ...b, ...s, targets: { ...b.targets, ...s.targets }, settings: { ...b.settings, ...s.settings } };
  } catch { return blankState(); }
}
function persistLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch { toast('Não foi possível salvar neste navegador (modo anônimo?). Exporte um backup.'); }
}
/** Toda alteração passa por aqui: grava no navegador e agenda a gravação no arquivo */
function save() {
  state.savedAt = new Date().toISOString();
  persistLocal();
  scheduleFileWrite();
  updateFileChip();
}

/* =========================================================================
   Cálculos da carteira
   ========================================================================= */
const priceOf = a => a.price ?? a.mkt?.price ?? a.avg ?? 0;
function valueOf(a) {
  if (a.cls === 'rf') return a.current ?? a.invested ?? 0;
  return (a.qty || 0) * priceOf(a);
}
function costOf(a) {
  if (a.cls === 'rf') return a.invested ?? 0;
  return (a.qty || 0) * (a.avg || 0);
}
/** indicadores: valor manual tem prioridade sobre o da API */
function ind(a, k) {
  const m = a.manual?.[k];
  if (m != null && m !== '') return Number(m);
  const v = a.mkt?.[k];
  return v == null ? null : Number(v);
}

function portfolio() {
  const assets = state.assets;
  const total = assets.reduce((s, a) => s + valueOf(a), 0);
  const cost = assets.reduce((s, a) => s + costOf(a), 0);
  const byClass = Object.fromEntries(CLASS_KEYS.map(k => [k, 0]));
  assets.forEach(a => { byClass[a.cls] = (byClass[a.cls] || 0) + valueOf(a); });
  const income = assets.reduce((s, a) => {
    if (a.cls === 'rf') return s;
    const dpa = ind(a, 'dpa');
    return s + (dpa ? dpa * (a.qty || 0) : 0);
  }, 0);
  return { total, cost, gain: total - cost, gainPct: cost ? (total - cost) / cost : 0, byClass, income };
}

/* =========================================================================
   Motor de sinais (regras objetivas e ajustáveis — sem "achismo")
   ========================================================================= */
function analyze(a) {
  const S = state.settings;
  const p = priceOf(a);
  const res = { kind: 'nodata', label: 'Sem dados', reasons: [], teto: null, margin: null, drop: null, rangePos: null, score: 0, metrics: [] };
  if (a.cls === 'rf') { res.kind = 'hold'; res.label = 'Renda fixa'; return res; }
  if (!p) { res.reasons.push('Sem preço atual. Atualize as cotações ou informe o preço manualmente.'); return res; }

  const hi = a.mkt?.hi52, lo = a.mkt?.lo52;
  if (hi && lo && hi > lo) {
    res.drop = (hi - p) / hi;
    res.rangePos = clamp((p - lo) / (hi - lo), 0, 1);
  }
  const fell = res.drop != null && res.drop >= S.dropMin;
  const nearTop = res.rangePos != null && res.rangePos >= 0.85;

  const lpa = ind(a, 'lpa'), vpa = ind(a, 'vpa'), dpa = ind(a, 'dpa');

  if (a.cls === 'acao') {
    const graham = lpa > 0 && vpa > 0 ? Math.sqrt(22.5 * lpa * vpa) : null;
    const bazin = dpa > 0 ? dpa / S.bazinYield : null;
    const tetos = [graham, bazin].filter(Boolean);
    res.teto = tetos.length ? tetos.reduce((s, v) => s + v, 0) / tetos.length : null;
    res.metrics = [
      ['P/L', lpa ? fmtN(p / lpa) : '—'],
      ['P/VP', vpa ? fmtN(p / vpa) : '—'],
      ['DY 12m', dpa ? pct(dpa / p) : '—'],
    ];
    if (graham) res.reasons.push(`Preço justo de Graham: ${fmt(graham)}.`);
    if (bazin) res.reasons.push(`Preço-teto de Bazin (DY ${pct(S.bazinYield, 0)}): ${fmt(bazin)}.`);

    if (lpa != null && lpa <= 0) {
      res.kind = 'risk'; res.label = 'Atenção';
      res.reasons.unshift(fell
        ? `Caiu ${pct(res.drop, 0)} da máxima, mas a empresa tem lucro negativo — pode ser uma armadilha de valor.`
        : 'Empresa com lucro por ação negativo nos últimos 12 meses.');
    } else if (res.teto) {
      res.margin = (res.teto - p) / res.teto;
      if (res.margin >= S.safety) {
        res.kind = 'buy'; res.label = 'Oportunidade';
        res.reasons.unshift(fell
          ? `Caiu ${pct(res.drop, 0)} desde a máxima de 52 semanas e está ${pct(res.margin, 0)} abaixo do preço-teto, com lucro positivo.`
          : `Está ${pct(res.margin, 0)} abaixo do preço-teto (margem de segurança).`);
      } else if (res.margin < -0.2 || (nearTop && res.margin < 0)) {
        res.kind = 'wait'; res.label = 'Esperar';
        res.reasons.unshift(nearTop
          ? `Está perto da máxima de 52 semanas e ${pct(-res.margin, 0)} acima do preço-teto — momento caro para comprar.`
          : `Está ${pct(-res.margin, 0)} acima do preço-teto — preço esticado.`);
      } else {
        res.kind = 'hold'; res.label = 'Neutro';
        res.reasons.unshift(res.margin >= 0
          ? `Abaixo do preço-teto, mas com margem pequena (${pct(res.margin, 0)}).`
          : `Levemente acima do preço-teto (${pct(-res.margin, 0)}).`);
      }
    } else {
      res.reasons.unshift(fell
        ? `Caiu ${pct(res.drop, 0)} da máxima, mas faltam LPA/VPA/dividendos para confirmar se está barata.`
        : 'Informe LPA, VPA ou dividendos por ação para calcular o preço-teto.');
    }
  } else if (a.cls === 'fii') {
    const pvp = vpa ? p / vpa : null;
    const dy = dpa ? dpa / p : null;
    res.metrics = [['P/VP', pvp ? fmtN(pvp) : '—'], ['DY 12m', dy ? pct(dy) : '—'], ['Renda/cota', dpa ? fmt(dpa / 12) : '—']];
    if (vpa) res.teto = vpa * S.pvpBuy;
    if (pvp == null) {
      res.reasons.unshift(fell ? `Caiu ${pct(res.drop, 0)} da máxima, mas falta o valor patrimonial (VPA) por cota para avaliar.` : 'Informe o valor patrimonial por cota (VPA) para calcular o P/VP.');
    } else if (dy != null && dy < S.dyMin * 0.6) {
      res.kind = 'risk'; res.label = 'Atenção';
      res.reasons.unshift(`Dividend yield de ${pct(dy)} está bem abaixo do mínimo desejado (${pct(S.dyMin, 0)}).`);
    } else if (pvp <= S.pvpBuy && (dy == null || dy >= S.dyMin)) {
      res.kind = 'buy'; res.label = 'Oportunidade';
      res.margin = 1 - pvp;
      res.reasons.unshift(`Negociado com desconto (P/VP ${fmtN(pvp)})` + (dy ? ` e pagando ${pct(dy)} ao ano.` : '.') + (fell ? ` Caiu ${pct(res.drop, 0)} da máxima.` : ''));
    } else if (pvp >= S.pvpSell) {
      res.kind = 'wait'; res.label = 'Esperar';
      res.margin = 1 - pvp;
      res.reasons.unshift(`Negociado com ágio (P/VP ${fmtN(pvp)}) — você paga mais que o valor dos imóveis/títulos.`);
    } else {
      res.kind = 'hold'; res.label = 'Neutro';
      res.margin = 1 - pvp;
      res.reasons.unshift(`P/VP ${fmtN(pvp)} perto do valor justo` + (dy ? `, DY de ${pct(dy)}.` : '.'));
    }
  } else if (a.cls === 'etf') {
    res.metrics = [['Máx. 52s', fmt(hi)], ['Mín. 52s', fmt(lo)], ['Queda', res.drop != null ? pct(res.drop, 0) : '—']];
    if (res.drop == null) {
      res.reasons.unshift('Atualize as cotações para ver a posição no intervalo de 52 semanas.');
    } else if (fell) {
      res.kind = 'buy'; res.label = 'Oportunidade';
      res.reasons.unshift(`Está ${pct(res.drop, 0)} abaixo da máxima de 52 semanas — bom momento para aportes graduais no índice.`);
    } else if (nearTop) {
      res.kind = 'wait'; res.label = 'Esperar';
      res.reasons.unshift('Perto da máxima de 52 semanas — prefira aportar em outras classes agora.');
    } else {
      res.kind = 'hold'; res.label = 'Neutro';
      res.reasons.unshift('No meio do intervalo de 52 semanas.');
    }
  }
  const order = { buy: 3, hold: 2, nodata: 1, risk: 0, wait: 0 };
  res.score = order[res.kind] + (res.margin || 0) + (res.drop || 0) * 0.5;
  return res;
}

/* =========================================================================
   Diagnóstico da carteira
   ========================================================================= */
function diagnose() {
  const P = portfolio();
  const out = [];
  if (!P.total) return out;
  const tSum = CLASS_KEYS.reduce((s, k) => s + (Number(state.targets[k]) || 0), 0) || 1;

  CLASS_KEYS.forEach(k => {
    const target = (Number(state.targets[k]) || 0) / tSum;
    const cur = P.byClass[k] / P.total;
    if (target > 0 && P.byClass[k] === 0) {
      out.push({ lvl: 'bad', title: `Você ainda não tem ${CLASSES[k].label.toLowerCase()}`, text: `Sua meta é ${pct(target, 0)} da carteira. Veja a aba "Onde aportar" e o Radar para escolher o primeiro ativo.` });
    } else if (target - cur > 0.05) {
      out.push({ lvl: 'warn', title: `${CLASSES[k].label}: abaixo da meta`, text: `Está em ${pct(cur)} e a meta é ${pct(target, 0)}. Priorize esta classe nos próximos aportes.` });
    } else if (cur - target > 0.05) {
      out.push({ lvl: 'info', title: `${CLASSES[k].label}: acima da meta`, text: `Está em ${pct(cur)} e a meta é ${pct(target, 0)}. Segure novos aportes aqui até as outras classes alcançarem.` });
    }
  });

  state.assets.forEach(a => {
    const w = valueOf(a) / P.total;
    if (a.cls !== 'rf' && a.cls !== 'etf' && w > state.settings.maxAsset) {
      out.push({ lvl: 'warn', title: `${a.ticker} concentra ${pct(w)} da carteira`, text: `Acima do limite de ${pct(state.settings.maxAsset, 0)} por ativo. Se ele cair, o impacto será grande.` });
    }
  });

  const acoes = state.assets.filter(a => a.cls === 'acao');
  const fiis = state.assets.filter(a => a.cls === 'fii');
  if (acoes.length && acoes.length < 5) out.push({ lvl: 'info', title: `Poucas ações (${acoes.length})`, text: 'Ter pelo menos 5 a 10 empresas de setores diferentes reduz o risco de uma só.' });
  if (fiis.length && fiis.length < 4) out.push({ lvl: 'info', title: `Poucos FIIs (${fiis.length})`, text: 'Combine fundos de tijolo (logística, lajes, shoppings) e de papel (recebíveis).' });

  if (acoes.length) {
    const have = new Set(acoes.map(a => a.sector));
    const missing = SETORES_PERENES.filter(s => !have.has(s));
    if (missing.length) out.push({ lvl: 'info', title: 'Setores perenes que faltam', text: `Você ainda não tem: ${missing.join(', ')}. Pesquise empresas desses setores no Radar.` });
    const bySec = {};
    acoes.forEach(a => { bySec[a.sector || 'Sem setor'] = (bySec[a.sector || 'Sem setor'] || 0) + valueOf(a); });
    const totA = P.byClass.acao;
    Object.entries(bySec).forEach(([s, v]) => {
      if (totA && v / totA > 0.35 && acoes.length > 1) out.push({ lvl: 'warn', title: `${s} pesa ${pct(v / totA, 0)} das suas ações`, text: 'Concentração alta num setor só. Diversifique nos próximos aportes.' });
    });
  }
  if (!out.length) out.push({ lvl: 'good', title: 'Carteira equilibrada', text: 'As classes estão perto das metas e não há concentrações relevantes.' });
  return out;
}

/* =========================================================================
   Planejador de aporte
   ========================================================================= */
function planAporte(amount) {
  const P = portfolio();
  const tSum = CLASS_KEYS.reduce((s, k) => s + (Number(state.targets[k]) || 0), 0) || 1;
  const newTotal = P.total + amount;
  const gaps = Object.fromEntries(CLASS_KEYS.map(k => [k, Math.max(0, newTotal * (Number(state.targets[k]) || 0) / tSum - P.byClass[k])]));
  const gapSum = Object.values(gaps).reduce((s, v) => s + v, 0);
  const perClass = {};
  CLASS_KEYS.forEach(k => { perClass[k] = gapSum > 0 ? amount * gaps[k] / gapSum : amount * (Number(state.targets[k]) || 0) / tSum; });

  const result = [];
  let leftover = 0;
  CLASS_KEYS.forEach(k => {
    const budget = perClass[k];
    if (budget < 1) return;
    const block = { cls: k, budget, items: [], note: null };
    if (k === 'rf') {
      block.note = 'Escolha um título conforme seu objetivo: Tesouro Selic ou CDB com liquidez diária para reserva; IPCA+ para longo prazo.';
      result.push(block);
      return;
    }
    // candidatos: ativos da carteira + oportunidades do Radar desta classe
    const held = state.assets.filter(a => a.cls === k).map(a => ({ a, sig: analyze(a), held: true }));
    const radar = state.radar.filter(a => a.cls === k).map(a => ({ a, sig: analyze(a), held: false })).filter(c => c.sig.kind === 'buy');
    let cands = [...held, ...radar].filter(c => c.sig.kind !== 'wait' && c.sig.kind !== 'risk' && priceOf(c.a) > 0);
    if (!cands.length) {
      block.note = held.length
        ? 'Todos os seus ativos desta classe estão "Esperar" ou "Atenção". Considere adicionar novas opções ao Radar.'
        : `Você ainda não tem ${CLASSES[k].label.toLowerCase()}. Adicione opções ao Radar para receber uma sugestão.`;
      leftover += budget;
      result.push(block);
      return;
    }
    // peso: igual dentro da classe (ou meta do ativo), multiplicado pela força do sinal
    const classVal = held.reduce((s, c) => s + valueOf(c.a), 0) + budget;
    const n = cands.length;
    cands = cands.map(c => {
      const ideal = classVal * (c.a.target ? c.a.target / 100 : 1 / n);
      const gap = Math.max(0, ideal - (c.held ? valueOf(c.a) : 0));
      const mult = c.sig.kind === 'buy' ? 1.6 : c.sig.kind === 'hold' ? 1 : 0.6;
      return { ...c, w: (gap + classVal * 0.02) * mult };
    });
    const wSum = cands.reduce((s, c) => s + c.w, 0);
    let spent = 0;
    cands.sort((x, y) => y.w - x.w).forEach(c => {
      const share = budget * c.w / wSum;
      const p = priceOf(c.a);
      const q = Math.floor(share / p);
      if (q > 0) { block.items.push({ ...c, qty: q, cost: q * p }); spent += q * p; }
    });
    // sobra: tenta comprar mais 1 cota dos melhores sinais
    let rest = budget - spent;
    for (let bought = true; bought;) {
      bought = false;
      for (const c of cands) {
        const p = priceOf(c.a);
        if (rest < p) continue;
        let it = block.items.find(i => i.a.id === c.a.id);
        if (!it) { it = { ...c, qty: 0, cost: 0 }; block.items.push(it); }
        it.qty++; it.cost += p; rest -= p; bought = true;
      }
    }
    leftover += rest;
    result.push(block);
  });
  return { blocks: result, leftover, newTotal };
}

/* =========================================================================
   Cotações (brapi.dev — plano gratuito com token)
   ========================================================================= */
async function fetchQuote(ticker, token) {
  const base = `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}`;
  const tk = token ? `&token=${encodeURIComponent(token)}` : '';
  const tries = [
    `${base}?fundamental=true&dividends=true&modules=defaultKeyStatistics${tk}`,
    `${base}?fundamental=true&dividends=true${tk}`,
    `${base}?${tk.slice(1)}`,
  ];
  let lastErr;
  for (const url of tries) {
    try {
      const r = await fetch(url);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); if (r.status === 404) break; continue; }
      const j = await r.json();
      const q = j.results?.[0];
      if (!q || q.regularMarketPrice == null) { lastErr = new Error('sem resultado'); continue; }
      return parseQuote(q);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('falha');
}
function parseQuote(q) {
  const ks = q.defaultKeyStatistics || {};
  const out = {
    price: q.regularMarketPrice,
    chg: q.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null,
    hi52: q.fiftyTwoWeekHigh ?? null,
    lo52: q.fiftyTwoWeekLow ?? null,
    lpa: q.earningsPerShare ?? ks.trailingEps ?? null,
    vpa: ks.bookValue ?? null,
    name: q.longName || q.shortName || null,
    logo: q.logourl || null,
    updatedAt: new Date().toISOString(),
  };
  const divs = q.dividendsData?.cashDividends;
  if (Array.isArray(divs) && divs.length) {
    const since = Date.now() - 365 * 864e5;
    const sum = divs.filter(d => new Date(d.paymentDate || d.lastDatePrior || 0).getTime() >= since)
      .reduce((s, d) => s + (Number(d.rate) || 0), 0);
    if (sum > 0) out.dpa = sum;
  } else if (ks.dividendYield && q.regularMarketPrice) {
    const dy = ks.dividendYield > 1 ? ks.dividendYield / 100 : ks.dividendYield;
    out.dpa = dy * q.regularMarketPrice;
  }
  return out;
}

async function refreshQuotes() {
  const list = [...state.assets, ...state.radar].filter(a => a.cls !== 'rf' && a.ticker);
  const tickers = [...new Set(list.map(a => a.ticker.toUpperCase()))];
  if (!tickers.length) return toast('Adicione ações, FIIs ou ETFs primeiro.');
  if (!state.settings.token) toast('Dica: cadastre seu token gratuito da brapi.dev em Ajustes para cotar todos os ativos.', 5000);
  const btn = $('#btnRefresh'); btn.disabled = true;
  let ok = 0, fail = [];
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    btn.querySelector('span').textContent = `Atualizando ${i + 1}/${tickers.length}…`;
    try {
      const m = await fetchQuote(t, state.settings.token);
      list.filter(a => a.ticker.toUpperCase() === t).forEach(a => { a.mkt = { ...a.mkt, ...m }; a.price = null; if (!a.name && m.name) a.name = m.name; });
      ok++;
    } catch { fail.push(t); }
  }
  btn.disabled = false; btn.querySelector('span').textContent = 'Atualizar cotações';
  state.lastUpdate = new Date().toISOString();
  save(); render();
  toast(fail.length ? `${ok} atualizados. Falharam: ${fail.join(', ')}${state.settings.token ? '' : ' (configure seu token em Ajustes)'}` : `${ok} cotações atualizadas.`, 6000);
}

/* =========================================================================
   Gráficos em SVG (sem bibliotecas — funciona offline)
   ========================================================================= */
function donut(data, { size = 200, center = '', sub = '' } = {}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return '<div class="empty">Sem dados</div>';
  const r = size / 2, ro = r - 2, ri = r * 0.62;
  let a0 = -Math.PI / 2;
  const pt = (ang, rad) => [r + rad * Math.cos(ang), r + rad * Math.sin(ang)];
  const arcs = data.filter(d => d.value > 0).map(d => {
    const frac = d.value / total;
    let a1 = a0 + frac * Math.PI * 2;
    if (frac >= 0.9999) a1 = a0 + Math.PI * 2 - 0.0001;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = pt(a0, ro), [x1, y1] = pt(a1, ro), [x2, y2] = pt(a1, ri), [x3, y3] = pt(a0, ri);
    const path = `M${x0},${y0} A${ro},${ro} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${ri},${ri} 0 ${large} 0 ${x3},${y3} Z`;
    a0 = a1;
    const tip = `<b>${esc(d.label)}</b><br>${fmt(d.value)} · ${pct(frac)}`;
    return `<path class="mark" d="${path}" fill="${d.color}" stroke="var(--surface)" stroke-width="2" stroke-linejoin="round" data-tip="${esc(tip)}"/>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Gráfico de rosca">
    ${arcs}
    <text x="${r}" y="${r - 2}" text-anchor="middle" font-size="17" font-weight="700" fill="var(--ink)">${esc(center)}</text>
    <text x="${r}" y="${r + 16}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(sub)}</text>
  </svg>`;
}
function legend(data) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return `<ul class="legend">${data.map(d => `<li><span class="sw" style="background:${d.color}"></span><span>${esc(d.label)}</span><span class="v">${fmt(d.value)}</span><span class="p">${pct(d.value / total)}</span></li>`).join('')}</ul>`;
}

/** largura lógica do SVG ≈ largura real do card, para o texto não encolher no celular */
const chartW = () => Math.round(clamp(innerWidth - 72, 300, 560));

/** Barras horizontais "atual x meta" (bullet) */
function bulletChart(rows) {
  const W = chartW(), rowH = 46, padL = W < 420 ? 84 : 120, padR = 60, H = rows.length * rowH + 22;
  const max = Math.max(0.5, ...rows.map(r => Math.max(r.cur, r.target))) * 1.1;
  const x = v => padL + (v / max) * (W - padL - padR);
  const ticks = [0, 0.25, 0.5, 0.75, 1].filter(t => t <= max);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribuição atual versus meta por classe">`;
  ticks.forEach(t => {
    s += `<line x1="${x(t)}" x2="${x(t)}" y1="0" y2="${H - 20}" stroke="var(--grid)"/>`;
    s += `<text class="axis-label" x="${x(t)}" y="${H - 4}" text-anchor="middle">${pct(t, 0)}</text>`;
  });
  rows.forEach((r, i) => {
    const y = i * rowH + 10;
    const w = Math.max(0, x(r.cur) - padL);
    const diff = r.cur - r.target;
    const tip = `<b>${esc(r.label)}</b><br>Atual: ${pct(r.cur)} (${fmt(r.value)})<br>Meta: ${pct(r.target, 0)}<br>${diff >= 0 ? 'Acima' : 'Abaixo'} da meta: ${pct(Math.abs(diff))}`;
    s += `<text class="bar-label" x="${padL - 10}" y="${y + 17}" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${padL}" y="${y + 4}" width="${W - padL - padR}" height="20" fill="transparent" data-tip="${esc(tip)}"/>`;
    if (w > 0) s += `<path class="mark" d="${roundedBar(padL, y + 6, w, 16, 4)}" fill="${r.color}" data-tip="${esc(tip)}"/>`;
    s += `<line x1="${x(r.target)}" x2="${x(r.target)}" y1="${y}" y2="${y + 28}" stroke="var(--ink)" stroke-width="2" pointer-events="none"/>`;
    s += `<text class="bar-value" x="${W - padR + 8}" y="${y + 18}">${pct(r.cur)}</text>`;
  });
  s += `<line x1="${padL}" x2="${padL}" y1="0" y2="${H - 20}" stroke="var(--axis)"/>`;
  return s + '</svg>';
}
/** barra com cantos arredondados só na ponta (direita) */
function roundedBar(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}
function roundedBarLeft(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + w},${y} H${x + r} Q${x},${y} ${x},${y + r} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w} Z`;
}

/** Barras horizontais simples (um tom) */
function hbars(rows, { color = 'var(--s1)', fmtV = fmt } = {}) {
  if (!rows.length) return '<div class="empty">Sem dados</div>';
  const W = chartW(), rowH = 30, padL = W < 420 ? 110 : 150, padR = W < 420 ? 100 : 120, H = rows.length * rowH + 4;
  const max = Math.max(...rows.map(r => r.value)) || 1;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, (r.value / max) * (W - padL - padR));
    const tip = `<b>${esc(r.label)}</b><br>${fmtV(r.value)}${r.extra ? '<br>' + esc(r.extra) : ''}`;
    const maxCh = padL < 140 ? 13 : 20;
    s += `<text class="bar-label" x="${padL - 10}" y="${y + 15}" text-anchor="end">${esc(r.label.length > maxCh ? r.label.slice(0, maxCh - 1) + '…' : r.label)}</text>`;
    s += `<rect x="0" y="${y}" width="${W}" height="${rowH - 4}" fill="transparent" data-tip="${esc(tip)}"/>`;
    s += `<path class="mark" d="${roundedBar(padL, y + 3, w, 16, 4)}" fill="${r.color || color}" data-tip="${esc(tip)}"/>`;
    s += `<text class="bar-value" x="${padL + w + 8}" y="${y + 15}">${esc(r.text ?? fmtV(r.value))}</text>`;
  });
  s += `<line x1="${padL}" x2="${padL}" y1="0" y2="${H}" stroke="var(--axis)"/>`;
  return s + '</svg>';
}

/** Barras divergentes (ganho/perda por ativo) — azul/vermelho, zero no meio */
function divergingBars(rows) {
  if (!rows.length) return '<div class="empty">Sem dados</div>';
  const W = chartW(), rowH = 28, padL = 100, padR = 10, H = rows.length * rowH + 4;
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.value))) || 0.01;
  const mid = padL + (W - padL - padR) / 2;
  const half = (W - padL - padR) / 2 - 56;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rentabilidade por ativo">`;
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, Math.abs(r.value) / maxAbs * half);
    const posv = r.value >= 0;
    const tip = `<b>${esc(r.label)}</b><br>Rentabilidade: ${signedPct(r.value)}<br>Resultado: ${fmt(r.gain)}`;
    s += `<text class="bar-label" x="${padL - 10}" y="${y + 15}" text-anchor="end" font-weight="600">${esc(r.label)}</text>`;
    s += `<rect x="0" y="${y}" width="${W}" height="${rowH - 4}" fill="transparent" data-tip="${esc(tip)}"/>`;
    s += `<path class="mark" d="${posv ? roundedBar(mid, y + 3, w, 15, 4) : roundedBarLeft(mid - w, y + 3, w, 15, 4)}" fill="${posv ? 'var(--s1)' : 'var(--s8)'}" data-tip="${esc(tip)}"/>`;
    s += `<text class="bar-value" x="${posv ? mid + w + 6 : mid - w - 6}" y="${y + 15}" text-anchor="${posv ? 'start' : 'end'}">${signedPct(r.value)}</text>`;
  });
  s += `<line x1="${mid}" x2="${mid}" y1="0" y2="${H}" stroke="var(--axis)"/>`;
  return s + '</svg>';
}

/* =========================================================================
   Ícones
   ========================================================================= */
const ICON = {
  up: '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5.5 3v10M10.5 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2 1.5 13.5h13zM8 6.5v3.5M8 12v.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dot: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 7v4.5M8 4.6v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 18l5-6 4 3 7-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const BADGE = { buy: ['b-buy', ICON.up], wait: ['b-wait', ICON.pause], risk: ['b-risk', ICON.warn], hold: ['b-hold', ICON.dot], nodata: ['b-nodata', ICON.info] };
const badge = sig => `<span class="badge ${BADGE[sig.kind][0]}">${BADGE[sig.kind][1]}${esc(sig.label)}</span>`;
const alertIcon = { good: ICON.check, warn: ICON.warn, bad: ICON.warn, info: ICON.info };

/* =========================================================================
   Telas
   ========================================================================= */
function render() {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === ui.tab));
  const v = $('#view');
  if (!state.assets.length && !state.onboarded && ui.tab !== 'config') { v.innerHTML = viewWelcome(); return; }
  v.innerHTML = ({ painel: viewPainel, carteira: viewCarteira, sinais: viewSinais, aportar: viewAportar, radar: viewRadar, config: viewConfig })[ui.tab]();
  if (ui.tab === 'aportar') bindAporte();
  if (ui.tab === 'config') bindConfig();
}

function viewWelcome() {
  return `<section class="welcome">
    <h1>Organize seus investimentos</h1>
    <p>Cadastre o que você já tem — ações, fundos imobiliários, ETFs e renda fixa — e veja gráficos da sua carteira,
      sinais de oportunidade e onde aportar a cada mês.</p>
    <div class="choices">
      <div class="card choice" data-act="add"><div class="ic">${ICON.plus}</div><h3>Adicionar ativos</h3><p>Cadastre um a um, com quantidade e preço médio.</p></div>
      <div class="card choice" data-act="import"><div class="ic">${ICON.file}</div><h3>Importar planilha</h3><p>Traga sua carteira de um arquivo CSV/Excel de uma vez.</p></div>
      <div class="card choice" data-act="openFile"><div class="ic">${ICON.folder}</div><h3>Abrir minha carteira</h3><p>Já usa o app em outro aparelho? Abra o arquivo salvo no seu Drive ou OneDrive.</p></div>
      <div class="card choice" data-act="demo"><div class="ic">${ICON.spark}</div><h3>Ver um exemplo</h3><p>Explore o app com uma carteira fictícia antes de usar a sua.</p></div>
    </div>
  </section>`;
}

function viewPainel() {
  const P = portfolio();
  if (!state.assets.length) return emptyState();
  const tSum = CLASS_KEYS.reduce((s, k) => s + (Number(state.targets[k]) || 0), 0) || 1;
  const classData = CLASS_KEYS.map(k => ({ label: CLASSES[k].label, value: P.byClass[k], color: CLASSES[k].color })).filter(d => d.value > 0);

  // ativos: top 7 + "Outros" (nunca gerar uma 9ª cor)
  const sorted = [...state.assets].sort((a, b) => valueOf(b) - valueOf(a));
  const top = sorted.slice(0, 7).map((a, i) => ({ label: a.ticker || a.name, value: valueOf(a), color: SERIES[i] }));
  const rest = sorted.slice(7).reduce((s, a) => s + valueOf(a), 0);
  if (rest > 0) top.push({ label: `Outros (${sorted.length - 7})`, value: rest, color: 'var(--other)' });

  const bullets = CLASS_KEYS.map(k => ({ label: clsLabel(k), cur: P.total ? P.byClass[k] / P.total : 0, target: (Number(state.targets[k]) || 0) / tSum, value: P.byClass[k], color: CLASSES[k].color }));

  const bySec = {};
  state.assets.filter(a => a.cls === 'acao' || a.cls === 'fii').forEach(a => {
    const key = (a.sector || 'Sem setor') + (a.cls === 'fii' ? ' (FII)' : '');
    bySec[key] = (bySec[key] || 0) + valueOf(a);
  });
  const rv = Object.values(bySec).reduce((s, v) => s + v, 0) || 1;
  const secRows = Object.entries(bySec).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, text: `${fmt(value)} · ${pct(value / rv, 0)}` }));

  const perf = state.assets.filter(a => a.cls !== 'rf' ? a.avg : a.invested).map(a => {
    const c = costOf(a), v = valueOf(a);
    return { label: a.ticker || (a.name.length > 13 ? a.name.slice(0, 12) + '…' : a.name), value: c ? (v - c) / c : 0, gain: v - c };
  }).sort((a, b) => b.value - a.value);

  const sigs = [...state.assets, ...state.radar].filter(a => a.cls !== 'rf').map(a => ({ a, s: analyze(a) }));
  const opp = sigs.filter(x => x.s.kind === 'buy').sort((x, y) => y.s.score - x.s.score);
  const wait = sigs.filter(x => x.s.kind === 'wait');
  const diag = diagnose().filter(d => d.lvl === 'bad' || d.lvl === 'warn').slice(0, 3);

  return `
  <div class="page-head">
    <div><h1>Painel</h1><p>${state.lastUpdate ? 'Cotações atualizadas em ' + new Date(state.lastUpdate).toLocaleString('pt-BR') : 'Cotações ainda não atualizadas — usando preço médio/manual.'}</p></div>
    <div class="row"><button class="btn primary" data-act="add">${ICON.plus} Adicionar ativo</button></div>
  </div>
  <div class="grid g-4">
    <div class="card kpi"><div class="label">Patrimônio</div><div class="value">${fmt(P.total)}</div><div class="sub">${state.assets.length} ativos</div></div>
    <div class="card kpi"><div class="label">Total investido</div><div class="value">${fmt(P.cost)}</div><div class="sub">custo de aquisição</div></div>
    <div class="card kpi"><div class="label">Resultado</div><div class="value ${P.gain >= 0 ? 'pos' : 'neg'}">${fmt(P.gain)}</div><div class="sub ${P.gain >= 0 ? 'pos' : 'neg'}">${signedPct(P.gainPct, 2)} sobre o investido</div></div>
    <div class="card kpi"><div class="label">Renda passiva estimada</div><div class="value">${fmt(P.income / 12)}<span class="muted" style="font-size:.9rem;font-weight:500"> /mês</span></div><div class="sub">${fmt(P.income)} nos últimos 12 meses</div></div>
  </div>

  <div class="grid g-2" style="margin-top:16px">
    <div class="card">
      <div class="card-head"><h2>Por tipo de investimento</h2></div>
      <div class="donut-wrap">${donut(classData, { center: compact(P.total), sub: 'patrimônio' })}${legend(classData)}</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Por ativo</h2><span class="muted">maiores posições</span></div>
      <div class="donut-wrap">${donut(top, { center: String(state.assets.length), sub: 'ativos' })}${legend(top)}</div>
    </div>
  </div>

  <div class="grid g-2" style="margin-top:16px">
    <div class="card">
      <div class="card-head"><h2>Atual × meta</h2><span class="muted">traço = meta</span></div>
      ${bulletChart(bullets)}
      <div class="row" style="margin-top:10px"><button class="btn sm" data-tab-go="config">Ajustar metas</button><button class="btn sm primary" data-tab-go="aportar">Onde aportar agora</button></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Sinais do momento</h2><button class="btn sm" data-tab-go="sinais">Ver todos</button></div>
      <div class="stack">
        ${diag.map(d => alertBox(d)).join('')}
        ${opp.length ? `<div><h3 style="margin-bottom:8px">Oportunidades (${opp.length})</h3><div class="row">${opp.slice(0, 6).map(x => `<span class="badge b-buy">${ICON.up}${esc(x.a.ticker)}${state.radar.includes(x.a) ? ' · novo' : ''}</span>`).join('')}</div></div>` : ''}
        ${wait.length ? `<div><h3 style="margin-bottom:8px">Em alta — esperar (${wait.length})</h3><div class="row">${wait.slice(0, 6).map(x => `<span class="badge b-wait">${ICON.pause}${esc(x.a.ticker)}</span>`).join('')}</div></div>` : ''}
        ${!diag.length && !opp.length && !wait.length ? '<p class="muted">Atualize as cotações e informe os indicadores dos ativos para gerar sinais.</p>' : ''}
      </div>
    </div>
  </div>

  <div class="grid g-2" style="margin-top:16px">
    <div class="card">
      <div class="card-head"><h2>Setores (renda variável)</h2></div>
      ${hbars(secRows.slice(0, 10))}
    </div>
    <div class="card">
      <div class="card-head"><h2>Rentabilidade por ativo</h2><span class="muted">desde a compra</span></div>
      ${divergingBars(perf.slice(0, 14))}
    </div>
  </div>`;
}
function compact(v) {
  if (v >= 1e6) return 'R$ ' + (v / 1e6).toFixed(2).replace('.', ',') + ' mi';
  if (v >= 1e3) return 'R$ ' + (v / 1e3).toFixed(1).replace('.', ',') + ' mil';
  return fmt(v);
}
function alertBox(d) {
  return `<div class="alert ${d.lvl}"><div class="ic">${alertIcon[d.lvl]}</div><div><h3>${esc(d.title)}</h3><p>${esc(d.text)}</p></div></div>`;
}
function emptyState() {
  return `<div class="card empty"><h2>Sua carteira está vazia</h2><p style="margin:8px 0 16px">Adicione seus ativos ou importe uma planilha.</p>
    <div class="row" style="justify-content:center"><button class="btn primary" data-act="add">${ICON.plus} Adicionar ativo</button><button class="btn" data-act="import">Importar CSV</button><button class="btn" data-act="demo">Carregar exemplo</button></div></div>`;
}

function viewCarteira() {
  const P = portfolio();
  const sorters = {
    value: (a, b) => valueOf(b) - valueOf(a),
    gain: (a, b) => (valueOf(b) - costOf(b)) / (costOf(b) || 1) - (valueOf(a) - costOf(a)) / (costOf(a) || 1),
    name: (a, b) => (a.ticker || a.name).localeCompare(b.ticker || b.name),
    cls: (a, b) => CLASS_KEYS.indexOf(a.cls) - CLASS_KEYS.indexOf(b.cls) || valueOf(b) - valueOf(a),
  };
  const rows = [...state.assets].sort(sorters[ui.sortBy]);
  return `
  <div class="page-head">
    <div><h1>Carteira</h1><p>${state.assets.length} ativos · ${fmt(P.total)}</p></div>
    <div class="row">
      <button class="btn" data-act="import">Importar CSV</button>
      <button class="btn primary" data-act="add">${ICON.plus} Adicionar ativo</button>
    </div>
  </div>
  ${!rows.length ? emptyState() : `
  <div class="card">
    <div class="card-head"><h2>Posições</h2>
      <div class="seg" role="group" aria-label="Ordenar">${[['value', 'Valor'], ['gain', 'Rentabilidade'], ['cls', 'Classe'], ['name', 'Nome']].map(([k, l]) => `<button data-sort="${k}" class="${ui.sortBy === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Ativo</th><th>Classe</th><th class="r">Qtd.</th><th class="r">Preço médio</th><th class="r">Preço atual</th><th class="r">Dia</th><th class="r">Valor</th><th class="r">Resultado</th><th class="r">% carteira</th><th>Sinal</th><th></th></tr></thead>
      <tbody>${rows.map(a => {
        const v = valueOf(a), c = costOf(a), g = v - c, s = analyze(a);
        const isRf = a.cls === 'rf';
        return `<tr>
          <td><span class="cls-dot" style="background:${CLASSES[a.cls].color}"></span><span class="ticker">${esc(isRf ? a.name : a.ticker)}</span>
            <div class="muted" style="font-size:.78rem;margin-left:16px">${esc(isRf ? [a.indexer, a.rate, a.maturity && 'venc. ' + new Date(a.maturity + 'T00:00').toLocaleDateString('pt-BR')].filter(Boolean).join(' · ') : (a.sector || a.name || ''))}</div></td>
          <td>${clsLabel(a.cls)}</td>
          <td class="r">${isRf ? '—' : fmtN(a.qty)}</td>
          <td class="r">${isRf ? fmt(a.invested) : fmt(a.avg)}</td>
          <td class="r">${isRf ? fmt(a.current) : fmt(priceOf(a))}</td>
          <td class="r ${a.mkt?.chg > 0 ? 'pos' : a.mkt?.chg < 0 ? 'neg' : ''}">${a.mkt?.chg != null ? signedPct(a.mkt.chg, 2) : '—'}</td>
          <td class="r"><b>${fmt(v)}</b></td>
          <td class="r ${g >= 0 ? 'pos' : 'neg'}">${fmt(g)}<div style="font-size:.78rem">${c ? signedPct(g / c) : ''}</div></td>
          <td class="r">${P.total ? pct(v / P.total) : '—'}</td>
          <td>${isRf ? '' : badge(s)}</td>
          <td class="r"><div class="row" style="flex-wrap:nowrap;justify-content:flex-end">
            ${isRf ? '' : `<button class="btn sm" data-buy="${a.id}">Comprar</button>`}
            <button class="btn sm ghost" data-edit="${a.id}">Editar</button>
            <button class="btn sm ghost danger" data-del="${a.id}" aria-label="Excluir">✕</button></div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`}`;
}

function signalCard(a, s, inRadar) {
  const p = priceOf(a);
  const hi = a.mkt?.hi52, lo = a.mkt?.lo52;
  let range = '';
  if (hi && lo && hi > lo) {
    const pos = clamp((p - lo) / (hi - lo), 0, 1) * 100;
    const tetoPos = s.teto ? clamp((s.teto - lo) / (hi - lo), 0, 1) * 100 : null;
    range = `<div><div class="range" data-tip="${esc(`Mín. 52s ${fmt(lo)} · Atual ${fmt(p)} · Máx. 52s ${fmt(hi)}`)}">
      ${tetoPos != null ? `<div class="teto" style="left:${tetoPos}%"><span>teto</span></div>` : ''}
      <div class="dot" style="left:${pos}%"></div></div>
      <div class="range-labels"><span>mín. 52s ${fmt(lo)}</span><span>máx. ${fmt(hi)}</span></div></div>`;
  }
  return `<div class="card signal-card">
    <div class="top">
      <div style="min-width:0"><div class="row" style="gap:6px"><span class="cls-dot" style="background:${CLASSES[a.cls].color}"></span><span class="ticker">${esc(a.ticker)}</span>${inRadar ? '<span class="badge b-new">fora da carteira</span>' : ''}</div>
        <div class="name">${esc(a.name || a.sector || clsLabel(a.cls))}</div></div>
      ${badge(s)}
    </div>
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <div><span style="font-size:1.35rem;font-weight:700">${fmt(p)}</span> ${a.mkt?.chg != null ? `<span class="${a.mkt.chg >= 0 ? 'pos' : 'neg'}" style="font-size:.85rem">${signedPct(a.mkt.chg, 2)}</span>` : ''}</div>
      ${s.teto ? `<div class="muted" style="font-size:.85rem">${a.cls === 'fii' ? 'Preço p/ desconto' : 'Preço-teto'}: <b class="ink2">${fmt(s.teto)}</b></div>` : ''}
    </div>
    ${range}
    ${s.metrics.length ? `<div class="metrics">${s.metrics.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>` : ''}
    <ul>${s.reasons.slice(0, 3).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    <div class="row">${inRadar ? `<button class="btn sm" data-promote="${a.id}">Já comprei</button>` : `<button class="btn sm" data-buy="${a.id}">Registrar compra</button>`}<button class="btn sm ghost" data-edit="${a.id}">Editar indicadores</button></div>
  </div>`;
}

function viewSinais() {
  const all = [
    ...state.assets.filter(a => a.cls !== 'rf').map(a => ({ a, s: analyze(a), r: false })),
    ...state.radar.map(a => ({ a, s: analyze(a), r: true })),
  ].sort((x, y) => y.s.score - x.s.score);
  const groups = [
    ['buy', 'Oportunidades', 'Abaixo do preço-teto, com fundamentos positivos. Bons candidatos para o próximo aporte.'],
    ['hold', 'Neutros', 'Perto do preço justo. Pode manter e aportar se a classe estiver abaixo da meta.'],
    ['wait', 'Em alta — esperar', 'Acima do preço-teto ou perto da máxima. Evite comprar agora; não significa vender.'],
    ['risk', 'Atenção', 'Queda acompanhada de fundamentos fracos (lucro negativo, dividendos baixos). Cuidado com armadilhas.'],
    ['nodata', 'Faltam dados', 'Atualize as cotações e informe LPA, VPA e dividendos para avaliar.'],
  ];
  const diag = diagnose();
  return `
  <div class="page-head">
    <div><h1>Sinais</h1><p>Análise por regras objetivas: Graham e Bazin para ações, P/VP e dividend yield para FIIs, máxima de 52 semanas para todos.</p></div>
    <button class="btn" data-tab-go="config">Ajustar critérios</button>
  </div>
  <div class="card"><div class="card-head"><h2>Diagnóstico da carteira</h2></div><div class="grid g-2">${diag.map(alertBox).join('')}</div></div>
  ${!all.length ? '<div class="card empty" style="margin-top:16px">Adicione ações, FIIs ou ETFs para ver sinais.</div>' : ''}
  ${groups.map(([k, title, desc]) => {
    const items = all.filter(x => x.s.kind === k);
    if (!items.length) return '';
    return `<div class="section-title"><h2>${title} <span class="count">${items.length}</span></h2></div>
      <p class="muted" style="margin:-6px 0 12px;font-size:.88rem">${desc}</p>
      <div class="grid g-3">${items.map(x => signalCard(x.a, x.s, x.r)).join('')}</div>`;
  }).join('')}`;
}

function viewAportar() {
  const plan = planAporte(ui.aporte || 0);
  const P = portfolio();
  const tSum = CLASS_KEYS.reduce((s, k) => s + (Number(state.targets[k]) || 0), 0) || 1;
  const after = Object.fromEntries(CLASS_KEYS.map(k => [k, P.byClass[k]]));
  plan.blocks.forEach(b => { after[b.cls] += b.cls === 'rf' ? b.budget : b.items.reduce((s, i) => s + i.cost, 0); });
  const afterTotal = Object.values(after).reduce((s, v) => s + v, 0) || 1;
  const bullets = CLASS_KEYS.map(k => ({ label: clsLabel(k), cur: after[k] / afterTotal, target: (Number(state.targets[k]) || 0) / tSum, value: after[k], color: CLASSES[k].color }));

  return `
  <div class="page-head">
    <div><h1>Onde aportar</h1><p>Distribui o valor para aproximar a carteira das metas, priorizando ativos com sinal de oportunidade.</p></div>
  </div>
  <div class="grid g-2">
    <div class="card">
      <label class="field" for="aporteVal"><span>Quanto você vai investir agora?</span></label>
      <div class="amount-input" style="margin-top:6px"><span style="font-size:1.3rem;font-weight:650">R$</span><input id="aporteVal" type="text" inputmode="decimal" value="${NUM.format(ui.aporte)}"></div>
      <div class="row" style="margin-top:10px">${[500, 1000, 2000, 5000].map(v => `<button class="btn sm" data-quick="${v}">${fmt(v)}</button>`).join('')}</div>
      <div style="margin-top:22px" id="planList">${planHtml(plan)}</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Como a carteira fica depois</h2><span class="muted">traço = meta</span></div>
      ${bulletChart(bullets)}
      <p class="muted" style="font-size:.85rem;margin-top:12px">Ativos com sinal "Esperar" ou "Atenção" ficam de fora. Oportunidades do Radar entram na sugestão da sua classe.</p>
    </div>
  </div>`;
}
function planHtml(plan) {
  if (!plan.blocks.length) return '<p class="muted">Informe um valor para ver a sugestão.</p>';
  return plan.blocks.map(b => `
    <div class="plan-class">
      <div class="row" style="justify-content:space-between"><h3><span class="cls-dot" style="background:${CLASSES[b.cls].color}"></span>${CLASSES[b.cls].label}</h3><b class="num">${fmt(b.cls === 'rf' ? b.budget : b.items.reduce((s, i) => s + i.cost, 0))}</b></div>
      ${b.items.map(i => `<div class="plan-item"><div class="row" style="gap:6px"><span class="ticker">${esc(i.a.ticker)}</span>${i.held ? '' : '<span class="badge b-new">novo</span>'}${badge(i.sig)}</div><div class="num"><span class="muted">${i.qty} × ${fmt(priceOf(i.a))}</span> <b>${fmt(i.cost)}</b></div></div>`).join('')}
      ${b.note ? `<p class="muted" style="font-size:.86rem;margin-top:6px">${esc(b.note)}</p>` : ''}
    </div>`).join('') + (plan.leftover >= 1 ? `<p class="muted" style="margin-top:14px;font-size:.88rem">Sobra não alocada: <b>${fmt(plan.leftover)}</b> — pode ir para a renda fixa ou ficar para o próximo mês.</p>` : '');
}
function bindAporte() {
  const inp = $('#aporteVal');
  const upd = () => { ui.aporte = parseNum(inp.value) || 0; const pos = inp.selectionStart; render(); const n = $('#aporteVal'); n.focus(); try { n.setSelectionRange(pos, pos); } catch {} };
  let t; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(upd, 400); });
}

function viewRadar() {
  const items = state.radar.map(a => ({ a, s: analyze(a) })).sort((x, y) => y.s.score - x.s.score);
  return `
  <div class="page-head">
    <div><h1>Radar</h1><p>Ativos que você <b>ainda não tem</b> e quer acompanhar. Quando ficarem baratos, aparecem como oportunidade e entram na sugestão de aporte.</p></div>
    <button class="btn primary" data-act="addRadar">${ICON.plus} Adicionar ao radar</button>
  </div>
  ${items.length ? `<div class="grid g-3">${items.map(x => signalCard(x.a, x.s, true)).join('')}</div>` : `<div class="card empty"><h2>Radar vazio</h2><p style="margin:8px 0 16px">Adicione ações, FIIs ou ETFs que você está pesquisando para receber sinais sobre eles.</p><button class="btn primary" data-act="addRadar">${ICON.plus} Adicionar ao radar</button></div>`}`;
}

function viewConfig() {
  const S = state.settings, T = state.targets;
  const tSum = CLASS_KEYS.reduce((s, k) => s + (Number(T[k]) || 0), 0);
  const pctField = (k, label, hint) => `<label class="field"><span>${label}</span><input type="number" step="0.5" data-set="${k}" value="${+(S[k] * 100).toFixed(2)}"><small>${hint}</small></label>`;
  return `
  <div class="page-head"><div><h1>Ajustes</h1><p>Metas da carteira, critérios dos sinais, cotações e backup.</p></div></div>
  <div class="grid g-2">
    ${fileCardHtml()}
    <div class="card">
      <div class="card-head"><h2>Metas por tipo de investimento</h2><span class="muted" id="tsum">Soma: ${tSum}%</span></div>
      <div class="form-grid">${CLASS_KEYS.map(k => `<label class="field"><span><span class="cls-dot" style="background:${CLASSES[k].color}"></span>${CLASSES[k].label} (%)</span><input type="number" min="0" max="100" step="1" data-target="${k}" value="${T[k] ?? 0}"></label>`).join('')}</div>
      <p class="muted" style="font-size:.85rem;margin-top:10px">Se a soma não der 100%, as metas são proporcionalizadas automaticamente.</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>Cotações automáticas</h2></div>
      <p class="ink2" style="font-size:.9rem">As cotações vêm da <a href="https://brapi.dev" target="_blank" rel="noopener">brapi.dev</a>. Crie uma conta gratuita, copie seu token e cole abaixo. Ele fica salvo só neste navegador.</p>
      <label class="field" style="margin-top:12px"><span>Token brapi.dev</span><input type="password" id="token" value="${esc(S.token)}" placeholder="cole seu token aqui" autocomplete="off"></label>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="saveToken">Salvar token</button><button class="btn" data-act="refresh">Atualizar cotações agora</button></div>
    </div>
    <div class="card span-2">
      <div class="card-head"><h2>Critérios dos sinais</h2><button class="btn sm ghost" id="resetCrit">Restaurar padrão</button></div>
      <div class="grid g-4">
        ${pctField('bazinYield', 'Bazin: dividend yield mínimo (%)', 'Preço-teto = dividendos 12m ÷ este valor')}
        ${pctField('safety', 'Margem de segurança (%)', 'Quanto abaixo do teto para ser "oportunidade"')}
        ${pctField('dropMin', 'Queda relevante (%)', 'Desde a máxima de 52 semanas')}
        ${pctField('maxAsset', 'Limite por ativo (%)', 'Alerta de concentração')}
        <label class="field"><span>FII: P/VP de desconto</span><input type="number" step="0.01" data-setraw="pvpBuy" value="${S.pvpBuy}"><small>Abaixo disso = oportunidade</small></label>
        <label class="field"><span>FII: P/VP caro</span><input type="number" step="0.01" data-setraw="pvpSell" value="${S.pvpSell}"><small>Acima disso = esperar</small></label>
        ${pctField('dyMin', 'FII: dividend yield mínimo (%)', 'Ao ano')}
      </div>
    </div>
    <div class="card span-2">
      <div class="card-head"><h2>Outras opções</h2></div>
      <p class="ink2" style="font-size:.9rem;margin-bottom:12px">Além do arquivo da carteira, os dados ficam guardados neste navegador. Um backup avulso é uma cópia de segurança extra.</p>
      <div class="row">
        <button class="btn primary" data-act="export">Baixar backup (.json)</button>
        <button class="btn" data-act="restore">Restaurar backup</button>
        <button class="btn" data-act="import">Importar CSV</button>
        <button class="btn" data-act="template">Baixar modelo de planilha</button>
        <button class="btn" data-act="exportCsv">Exportar carteira (CSV)</button>
        <button class="btn danger" data-act="reset">Apagar tudo</button>
      </div>
    </div>
  </div>`;
}
function bindConfig() {
  $$('[data-target]').forEach(i => i.addEventListener('change', () => {
    state.targets[i.dataset.target] = Math.max(0, parseNum(i.value) || 0); save();
    $('#tsum').textContent = 'Soma: ' + CLASS_KEYS.reduce((s, k) => s + (Number(state.targets[k]) || 0), 0) + '%';
  }));
  $$('[data-set]').forEach(i => i.addEventListener('change', () => { const v = parseNum(i.value); if (v != null && v > 0) { state.settings[i.dataset.set] = v / 100; save(); toast('Critério salvo.'); } }));
  $$('[data-setraw]').forEach(i => i.addEventListener('change', () => { const v = parseNum(i.value); if (v != null && v > 0) { state.settings[i.dataset.setraw] = v; save(); toast('Critério salvo.'); } }));
  $('#saveToken').onclick = () => { state.settings.token = $('#token').value.trim(); save(); toast('Token salvo.'); };
  $('#resetCrit').onclick = () => { const tk = state.settings.token; state.settings = { ...DEFAULT_SETTINGS, token: tk }; save(); render(); toast('Critérios restaurados.'); };
}

/* =========================================================================
   Formulários (modal)
   ========================================================================= */
function openModal(html, onMount) {
  const m = $('#modal');
  m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  onMount?.(m);
  setTimeout(() => m.querySelector('input, select')?.focus(), 30);
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

function assetForm(existing, { radar = false } = {}) {
  const a = existing || { cls: 'acao', manual: {} };
  const title = existing ? `Editar ${esc(a.ticker || a.name)}` : radar ? 'Adicionar ao radar' : 'Adicionar ativo';
  openModal(`
    <h2>${title}</h2>
    <form id="assetForm" class="form-grid">
      <label class="field full"><span>Tipo de investimento</span>
        <select name="cls">${CLASS_KEYS.filter(k => !radar || k !== 'rf').map(k => `<option value="${k}" ${a.cls === k ? 'selected' : ''}>${CLASSES[k].label}</option>`).join('')}</select></label>
      <div class="full rv form-grid" style="padding:0">
        <label class="field"><span>Código (ticker)</span><input name="ticker" type="text" placeholder="ex.: ITSA4, MXRF11, BOVA11" value="${esc(a.ticker || '')}" style="text-transform:uppercase"></label>
        <label class="field"><span>Setor / segmento</span><input name="sector" type="text" list="setores" value="${esc(a.sector || '')}" placeholder="ex.: Bancos"></label>
        ${radar ? '' : `
        <label class="field"><span>Quantidade</span><input name="qty" type="text" inputmode="decimal" value="${a.qty ?? ''}"></label>
        <label class="field"><span>Preço médio (R$)</span><input name="avg" type="text" inputmode="decimal" value="${a.avg != null ? NUM.format(a.avg) : ''}"></label>`}
        <label class="field"><span>Preço atual (R$)</span><input name="price" type="text" inputmode="decimal" value="${a.price != null ? NUM.format(a.price) : ''}" placeholder="${a.mkt?.price ? NUM.format(a.mkt.price) + ' (cotação)' : 'opcional — vem da cotação'}"><small>Deixe vazio para usar a cotação automática.</small></label>
        ${radar ? '' : `<label class="field"><span>Meta dentro da classe (%)</span><input name="target" type="text" inputmode="decimal" value="${a.target ?? ''}" placeholder="opcional"><small>Vazio = peso igual entre os ativos da classe.</small></label>`}
        <fieldset class="full"><legend>Indicadores (opcional — melhora os sinais)</legend>
          <div class="form-grid">
            <label class="field"><span>LPA — lucro por ação (R$)</span><input name="lpa" type="text" inputmode="decimal" value="${a.manual?.lpa ?? ''}" placeholder="${a.mkt?.lpa != null ? NUM.format(a.mkt.lpa) + ' (automático)' : ''}"></label>
            <label class="field"><span>VPA — valor patrimonial por ação/cota (R$)</span><input name="vpa" type="text" inputmode="decimal" value="${a.manual?.vpa ?? ''}" placeholder="${a.mkt?.vpa != null ? NUM.format(a.mkt.vpa) + ' (automático)' : ''}"></label>
            <label class="field"><span>Dividendos por ação/cota nos últimos 12 meses (R$)</span><input name="dpa" type="text" inputmode="decimal" value="${a.manual?.dpa ?? ''}" placeholder="${a.mkt?.dpa != null ? NUM.format(a.mkt.dpa) + ' (automático)' : ''}"></label>
            <p class="muted" style="font-size:.8rem;align-self:end">Encontre esses números em sites como Status Invest, Investidor10 ou no relatório da empresa/fundo.</p>
          </div>
        </fieldset>
      </div>
      <div class="full rf form-grid" style="padding:0">
        <label class="field full"><span>Nome do título</span><input name="name" type="text" value="${esc(a.cls === 'rf' ? a.name || '' : '')}" placeholder="ex.: Tesouro Selic 2029, CDB Banco X"></label>
        <label class="field"><span>Valor aplicado (R$)</span><input name="invested" type="text" inputmode="decimal" value="${a.invested != null ? NUM.format(a.invested) : ''}"></label>
        <label class="field"><span>Valor atual (R$)</span><input name="current" type="text" inputmode="decimal" value="${a.current != null ? NUM.format(a.current) : ''}"><small>Veja no app da corretora.</small></label>
        <label class="field"><span>Indexador</span><select name="indexer">${INDEXADORES.map(i => `<option ${a.indexer === i ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label class="field"><span>Taxa</span><input name="rate" type="text" value="${esc(a.rate || '')}" placeholder="ex.: 110% CDI, IPCA+6%"></label>
        <label class="field"><span>Vencimento</span><input name="maturity" type="date" value="${esc(a.maturity || '')}"></label>
      </div>
      <datalist id="setores"></datalist>
    </form>
    <div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="saveAsset">Salvar</button></div>
  `, m => {
    const f = $('#assetForm', m);
    const sync = () => {
      const c = f.cls.value;
      $('.rv', f).hidden = c === 'rf'; $('.rv', f).style.display = c === 'rf' ? 'none' : '';
      $('.rf', f).style.display = c === 'rf' ? '' : 'none';
      $('#setores', f).innerHTML = (c === 'fii' ? SETORES_FII : SETORES_ACOES).map(s => `<option value="${s}">`).join('');
    };
    f.cls.addEventListener('change', sync); sync();
    $('#saveAsset', m).onclick = () => {
      const g = n => f[n]?.value?.trim?.() ?? '';
      const cls = g('cls');
      const obj = existing || { id: uid(), manual: {}, mkt: {} };
      obj.cls = cls;
      if (cls === 'rf') {
        obj.name = g('name'); obj.invested = parseNum(g('invested')); obj.current = parseNum(g('current')) ?? obj.invested;
        obj.indexer = g('indexer'); obj.rate = g('rate'); obj.maturity = g('maturity'); obj.ticker = '';
        if (!obj.name || !obj.invested) return toast('Informe o nome e o valor aplicado.');
      } else {
        obj.ticker = g('ticker').toUpperCase().replace(/\s/g, ''); obj.sector = g('sector');
        obj.price = parseNum(g('price'));
        if (!radar) { obj.qty = parseNum(g('qty')); obj.avg = parseNum(g('avg')); obj.target = parseNum(g('target')); }
        obj.manual = { lpa: parseNum(g('lpa')), vpa: parseNum(g('vpa')), dpa: parseNum(g('dpa')) };
        if (!obj.ticker) return toast('Informe o código do ativo.');
        if (!radar && (!obj.qty || !obj.avg)) return toast('Informe quantidade e preço médio.');
      }
      if (!existing) (radar ? state.radar : state.assets).push(obj);
      state.onboarded = true;
      save(); closeModal(); render();
      toast(existing ? 'Ativo atualizado.' : 'Ativo adicionado.');
    };
  });
}

function buyForm(a) {
  openModal(`
    <h2>Registrar compra de ${esc(a.ticker)}</h2>
    <form id="buyForm" class="form-grid">
      <label class="field"><span>Quantidade comprada</span><input name="q" type="text" inputmode="decimal"></label>
      <label class="field"><span>Preço pago por unidade (R$)</span><input name="p" type="text" inputmode="decimal" value="${NUM.format(priceOf(a))}"></label>
      <p class="full muted" id="preview" style="font-size:.88rem">Preço médio atual: ${fmt(a.avg)} · ${fmtN(a.qty)} unidades</p>
    </form>
    <div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="okBuy">Registrar</button></div>`, m => {
    const f = $('#buyForm', m);
    const calc = () => {
      const q = parseNum(f.q.value) || 0, p = parseNum(f.p.value) || 0;
      const nq = (a.qty || 0) + q, navg = nq ? ((a.qty || 0) * (a.avg || 0) + q * p) / nq : 0;
      $('#preview', m).textContent = q ? `Novo preço médio: ${fmt(navg)} · ${fmtN(nq)} unidades · total ${fmt(q * p)}` : `Preço médio atual: ${fmt(a.avg)} · ${fmtN(a.qty)} unidades`;
      return { q, p, nq, navg };
    };
    f.addEventListener('input', calc);
    $('#okBuy', m).onclick = () => {
      const { q, p, nq, navg } = calc();
      if (!q || !p) return toast('Informe quantidade e preço.');
      if (state.radar.includes(a)) { state.radar = state.radar.filter(x => x !== a); state.assets.push(a); }
      a.qty = nq; a.avg = navg; save(); closeModal(); render(); toast('Compra registrada.');
    };
  });
}

/* =========================================================================
   Importação / exportação
   ========================================================================= */
const CSV_TEMPLATE = 'classe;ativo;quantidade;preco_medio;setor;valor_aplicado;valor_atual;indexador;taxa;vencimento\n' +
  'acao;ITSA4;100;9,80;Holding;;;;;\n' +
  'acao;TAEE11;50;34,20;Energia elétrica;;;;;\n' +
  'fii;MXRF11;200;10,05;Recebíveis (papel);;;;;\n' +
  'etf;BOVA11;10;118,50;;;;;;\n' +
  'rf;Tesouro Selic 2029;;;;5000;5420;Pós-fixado (CDI/Selic);Selic + 0,1%;2029-03-01\n';

function download(name, text, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function pickFile(accept, cb) {
  const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
  i.onchange = () => { const f = i.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(String(r.result)); r.readAsText(f, 'utf-8'); };
  i.click();
}
function normCls(s) {
  s = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (/^(acao|acoes|stock|a)$/.test(s)) return 'acao';
  if (/fii|imobili/.test(s)) return 'fii';
  if (/etf/.test(s)) return 'etf';
  if (/^rf$|renda fixa|tesouro|cdb|lci|lca|debenture/.test(s)) return 'rf';
  return null;
}
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(s => s.trim()); };
  const head = split(lines[0]).map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'));
  const idx = names => head.findIndex(h => names.some(n => h.includes(n)));
  const col = {
    cls: idx(['classe', 'tipo', 'categoria']), tk: idx(['ativo', 'ticker', 'codigo', 'nome', 'produto']),
    qty: idx(['quantidade', 'qtd']), avg: idx(['preco_medio', 'pm', 'preco']), sector: idx(['setor', 'segmento']),
    inv: idx(['valor_aplicado', 'aplicado', 'investido']), cur: idx(['valor_atual', 'atual', 'saldo']),
    indexer: idx(['indexador']), rate: idx(['taxa']), mat: idx(['vencimento']),
  };
  const out = [];
  lines.slice(1).forEach(l => {
    const c = split(l), g = k => (col[k] >= 0 ? c[col[k]] : '');
    let cls = normCls(g('cls'));
    const tk = g('tk');
    if (!tk) return;
    if (!cls) cls = /11$/.test(tk.toUpperCase()) ? 'fii' : /\d$/.test(tk) ? 'acao' : 'rf';
    if (cls === 'rf') {
      const inv = parseNum(g('inv')); if (!inv) return;
      out.push({ id: uid(), cls, name: tk, invested: inv, current: parseNum(g('cur')) ?? inv, indexer: g('indexer') || INDEXADORES[0], rate: g('rate'), maturity: g('mat'), manual: {}, mkt: {} });
    } else {
      const qty = parseNum(g('qty')), avg = parseNum(g('avg')); if (!qty || !avg) return;
      out.push({ id: uid(), cls, ticker: tk.toUpperCase(), qty, avg, sector: g('sector'), manual: {}, mkt: {} });
    }
  });
  return out;
}
function importCsv() {
  openModal(`<h2>Importar planilha (CSV)</h2>
    <p class="ink2" style="font-size:.92rem">No Excel ou Google Planilhas, salve como <b>CSV</b>. Colunas reconhecidas: <code>classe</code> (acao, fii, etf, rf), <code>ativo</code>, <code>quantidade</code>, <code>preco_medio</code>, <code>setor</code> e, para renda fixa, <code>valor_aplicado</code>, <code>valor_atual</code>, <code>indexador</code>, <code>taxa</code>, <code>vencimento</code>.</p>
    <p class="muted" style="font-size:.85rem;margin-top:8px">Ativos que já existem na carteira (mesmo código) são somados com preço médio recalculado.</p>
    <div class="modal-foot"><button class="btn" data-act="template">Baixar modelo</button><button class="btn primary" id="pickCsv">Escolher arquivo…</button></div>`, m => {
    $('#pickCsv', m).onclick = () => pickFile('.csv,text/csv,.txt', text => {
      const rows = parseCsv(text);
      if (!rows.length) return toast('Nenhuma linha válida encontrada. Confira as colunas com o modelo.', 5000);
      rows.forEach(r => {
        const ex = r.cls !== 'rf' && state.assets.find(a => a.ticker === r.ticker);
        if (ex) { const nq = ex.qty + r.qty; ex.avg = (ex.qty * ex.avg + r.qty * r.avg) / nq; ex.qty = nq; if (!ex.sector) ex.sector = r.sector; }
        else state.assets.push(r);
      });
      state.onboarded = true; save(); closeModal(); ui.tab = 'carteira'; render();
      toast(`${rows.length} linhas importadas. Clique em "Atualizar cotações".`, 5000);
    });
  });
}
function exportCsv() {
  const lines = ['classe;ativo;quantidade;preco_medio;setor;valor_aplicado;valor_atual;indexador;taxa;vencimento'];
  const n = v => (v == null ? '' : String(v).replace('.', ','));
  state.assets.forEach(a => lines.push(a.cls === 'rf'
    ? ['rf', a.name, '', '', '', n(a.invested), n(a.current), a.indexer || '', a.rate || '', a.maturity || ''].join(';')
    : [a.cls, a.ticker, n(a.qty), n(a.avg?.toFixed(4)), a.sector || '', '', '', '', '', ''].join(';')));
  download('minha-carteira.csv', '﻿' + lines.join('\n'), 'text/csv');
}

/* =========================================================================
   Dados de exemplo (fictícios, apenas para demonstração)
   ========================================================================= */
function loadDemo() {
  const A = (cls, ticker, sector, qty, avg, price, hi52, lo52, lpa, vpa, dpa, name) =>
    ({ id: uid(), cls, ticker, sector, qty, avg, name, manual: {}, mkt: { price, hi52, lo52, lpa, vpa, dpa, chg: (Math.random() - 0.5) * 0.03 } });
  state.assets = [
    A('acao', 'ITSA4', 'Holding', 400, 8.9, 10.2, 11.4, 8.6, 1.12, 6.9, 0.78, 'Itaúsa (exemplo)'),
    A('acao', 'BBAS3', 'Bancos', 200, 26.5, 22.1, 29.8, 21.4, 5.2, 34.1, 2.35, 'Banco do Brasil (exemplo)'),
    A('acao', 'WEGE3', 'Indústria', 60, 38.0, 52.6, 54.1, 36.2, 1.55, 6.1, 0.6, 'WEG (exemplo)'),
    A('acao', 'PETR4', 'Petróleo e gás', 150, 31.0, 30.4, 38.9, 29.6, 5.9, 32.8, 3.1, 'Petrobras (exemplo)'),
    A('acao', 'TAEE11', 'Energia elétrica', 80, 33.0, 35.8, 37.0, 31.5, 3.6, 22.0, 3.3, 'Taesa (exemplo)'),
    A('fii', 'MXRF11', 'Recebíveis (papel)', 600, 10.1, 9.35, 10.6, 9.1, null, 9.85, 1.18, 'Maxi Renda (exemplo)'),
    A('fii', 'HGLG11', 'Logística', 25, 162, 158, 168, 150, null, 160, 13.2, 'CSHG Logística (exemplo)'),
    A('fii', 'KNRI11', 'Híbrido', 20, 140, 152, 156, 138, null, 135, 12.0, 'Kinea Renda Imobiliária (exemplo)'),
    A('etf', 'BOVA11', '', 30, 115, 124, 136, 112, null, null, null, 'iShares Ibovespa (exemplo)'),
    { id: uid(), cls: 'rf', name: 'Tesouro Selic 2029', invested: 12000, current: 13150, indexer: 'Pós-fixado (CDI/Selic)', rate: 'Selic + 0,1%', maturity: '2029-03-01', manual: {}, mkt: {} },
    { id: uid(), cls: 'rf', name: 'CDB Banco X', invested: 5000, current: 5480, indexer: 'Pós-fixado (CDI/Selic)', rate: '110% CDI', maturity: '2027-08-15', manual: {}, mkt: {} },
  ];
  state.assets.forEach(a => { if (a.mkt?.price) a.mkt.chg = Math.round(a.mkt.chg * 1e4) / 1e4; });
  state.radar = [
    A('acao', 'SAPR11', 'Saneamento', 0, null, 26.1, 33.5, 25.4, 3.9, 30.2, 1.35, 'Sanepar (exemplo)'),
    A('acao', 'BBSE3', 'Seguros', 0, null, 37.9, 38.6, 30.1, 4.1, 5.0, 3.4, 'BB Seguridade (exemplo)'),
    A('fii', 'XPML11', 'Shoppings', 0, null, 101, 117, 98, null, 112, 11.4, 'XP Malls (exemplo)'),
  ];
  state.onboarded = true; state.demo = true;
  save(); ui.tab = 'painel'; render();
  toast('Carteira de exemplo carregada. Os valores são fictícios — apague em Ajustes quando quiser usar a sua.', 6000);
}

/* =========================================================================
   Arquivo da carteira (para guardar no Google Drive / OneDrive da pessoa)
   - Chrome/Edge no computador: grava sozinho no arquivo a cada alteração.
   - Celular e outros navegadores: abrir e salvar manualmente (compartilhar/baixar).
   ========================================================================= */
const FS_OK = 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
const FILE_TYPES = [{ description: 'Carteira (Minha Carteira)', accept: { 'application/json': ['.json'] } }];
const fileSync = { handle: null, status: 'none', busy: false };
// status: none | ok | saving | permission | error | manual

const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('minha-carteira', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }
    catch { return null; }
  },
  async set(k, v) {
    try {
      const db = await this.open();
      await new Promise(res => { const tx = db.transaction('kv', 'readwrite'); const st = tx.objectStore('kv'); v == null ? st.delete(k) : st.put(v, k); tx.oncomplete = res; tx.onerror = res; });
    } catch {}
  },
};

const fmtWhen = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'data desconhecida');
const hasLocalChanges = () => !!state.savedAt && (!state.fileSyncedAt || state.savedAt > state.fileSyncedAt);

function serialize() {
  const { fileSyncedAt, fileName, ...rest } = state;
  return JSON.stringify({ app: 'minha-carteira', ...rest }, null, 2);
}
function parseCarteira(text) {
  if (!text || !text.trim()) return null;
  const d = JSON.parse(text);
  if (!Array.isArray(d.assets)) throw new Error('formato');
  return d;
}
/** Substitui os dados locais pelos do arquivo (sem marcar como "alteração local") */
function applyFileData(d, name) {
  const b = blankState();
  const { app, ...rest } = d;
  const token = state.settings.token;
  state = { ...b, ...rest, targets: { ...b.targets, ...rest.targets }, settings: { ...b.settings, ...rest.settings }, onboarded: true };
  if (!state.settings.token && token) state.settings.token = token;
  state.fileSyncedAt = d.savedAt || null;
  state.fileName = name || state.fileName;
  persistLocal();
  render();
}

function setFileStatus(s) { fileSync.status = s; updateFileChip(); if (ui.tab === 'config') { const c = $('#fileCard'); if (c) c.outerHTML = fileCardHtml(); } }

/* ---------- modo automático (File System Access API) ---------- */
async function readHandle(h) { const f = await h.getFile(); return parseCarteira(await f.text()); }

async function writeToFile({ force = false } = {}) {
  const h = fileSync.handle;
  if (!h || !['ok', 'saving', 'error'].includes(fileSync.status)) return;
  try {
    if (!force) {
      // alguém salvou o arquivo em outro aparelho depois da nossa última sincronização?
      const d = await readHandle(h).catch(() => null);
      if (d?.savedAt && state.fileSyncedAt && d.savedAt > state.fileSyncedAt) return askConflict(d, h.name);
    }
    setFileStatus('saving');
    const w = await h.createWritable();
    await w.write(serialize());
    await w.close();
    state.fileSyncedAt = state.savedAt || new Date().toISOString();
    persistLocal();
    setFileStatus('ok');
  } catch (e) {
    setFileStatus(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'permission' : 'error');
  }
}
let fileT;
function scheduleFileWrite() {
  if (fileSync.handle && (fileSync.status === 'ok' || fileSync.status === 'error')) { clearTimeout(fileT); fileT = setTimeout(() => writeToFile(), 800); }
}

/** Compara arquivo x dados locais e decide o que fazer */
async function syncFromFile() {
  const h = fileSync.handle;
  if (!h || fileSync.busy) return;
  fileSync.busy = true;
  try {
    const d = await readHandle(h);
    if (!d) return await writeToFile({ force: true }); // arquivo novo/vazio
    const fileChanged = !state.fileSyncedAt || (d.savedAt || '') > state.fileSyncedAt;
    if (fileChanged) {
      if (hasLocalChanges() && state.assets.length && contentKey(state) !== contentKey(d)) return askConflict(d, h.name);
      applyFileData(d, h.name);
      toast(`Carteira carregada do arquivo (salva em ${fmtWhen(d.savedAt)}).`);
    } else if (hasLocalChanges()) {
      await writeToFile({ force: true });
    }
  } catch (e) {
    if (e?.name === 'NotAllowedError') setFileStatus('permission');
    else { setFileStatus('error'); toast('Não foi possível ler o arquivo da carteira.'); }
  } finally { fileSync.busy = false; }
}
/** compara só o conteúdo que importa (ativos, radar, metas), ignorando datas de gravação */
const contentKey = o => JSON.stringify([o.assets, o.radar, o.targets]);

function askConflict(d, name) {
  openModal(`
    <h2>Duas versões da carteira</h2>
    <p class="ink2">O arquivo <b>${esc(name || 'da carteira')}</b> foi alterado em outro aparelho, e este aparelho também tem alterações que ainda não foram para o arquivo.</p>
    <div class="grid g-2" style="margin-top:16px">
      <div class="card"><h3>Versão do arquivo</h3><p class="muted" style="font-size:.85rem;margin:4px 0 8px">salva em ${fmtWhen(d.savedAt)}</p><p style="font-size:.9rem">${d.assets.length} ativos</p></div>
      <div class="card"><h3>Versão deste aparelho</h3><p class="muted" style="font-size:.85rem;margin:4px 0 8px">alterada em ${fmtWhen(state.savedAt)}</p><p style="font-size:.9rem">${state.assets.length} ativos</p></div>
    </div>
    <p class="muted" style="font-size:.85rem;margin-top:12px">A versão que você não escolher será descartada.</p>
    <div class="modal-foot"><button class="btn" id="keepLocal">Manter a deste aparelho</button><button class="btn primary" id="useFile">Usar a do arquivo</button></div>`, m => {
    $('#useFile', m).onclick = () => { closeModal(); applyFileData(d, fileSync.handle ? name : state.fileName); setFileStatus(fileSync.handle ? 'ok' : 'manual'); toast('Carteira do arquivo carregada.'); };
    $('#keepLocal', m).onclick = async () => {
      closeModal();
      state.fileSyncedAt = d.savedAt; // considera o arquivo "visto" e sobrescreve
      if (fileSync.handle) { setFileStatus('ok'); await writeToFile({ force: true }); toast('Arquivo atualizado com a versão deste aparelho.'); }
      else { state.savedAt = new Date().toISOString(); persistLocal(); setFileStatus('manual'); toast('Mantida a versão deste aparelho. Toque em "Salvar no Drive" para atualizar o arquivo.', 5000); }
    };
  });
}

async function connectHandle(h) {
  fileSync.handle = h;
  state.fileName = h.name;
  await idb.set('handle', h);
  setFileStatus('ok');
}

async function createFile() {
  if (!FS_OK) return saveManual();
  try {
    const h = await window.showSaveFilePicker({ suggestedName: 'minha-carteira.json', types: FILE_TYPES });
    state.fileSyncedAt = null;
    await connectHandle(h);
    if (!state.savedAt) state.savedAt = new Date().toISOString();
    await writeToFile({ force: true });
    toast(`Pronto! A carteira agora é salva automaticamente em "${h.name}".`, 5000);
  } catch (e) { if (e?.name !== 'AbortError') toast('Não foi possível criar o arquivo.'); }
}

async function openFile() {
  if (!FS_OK) return openManual();
  try {
    const [h] = await window.showOpenFilePicker({ types: FILE_TYPES, multiple: false });
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('Sem permissão para salvar nesse arquivo.');
    const d = await readHandle(h).catch(() => { throw new Error('inválido'); });
    if (!d) return toast('Esse arquivo está vazio.');
    state.fileSyncedAt = null; // arquivo diferente: força a comparação
    await connectHandle(h);
    await syncFromFile();
    ui.tab = 'painel'; render();
  } catch (e) {
    if (e?.name !== 'AbortError') toast('Esse arquivo não é uma carteira válida.');
  }
}

async function reconnectFile() {
  const h = fileSync.handle;
  if (!h) return;
  try {
    if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { setFileStatus('ok'); await syncFromFile(); toast('Arquivo reconectado.'); }
  } catch { setFileStatus('error'); }
}

async function disconnectFile() {
  if (!confirm('Parar de salvar no arquivo? Seus dados continuam neste navegador e o arquivo não é apagado.')) return;
  fileSync.handle = null; state.fileName = null; state.fileSyncedAt = null;
  await idb.set('handle', null);
  persistLocal(); setFileStatus('none');
}

/* ---------- modo manual (celular, Safari, Firefox) ---------- */
function openManual() {
  pickFile('.json,application/json,text/plain', text => {
    let d;
    try { d = parseCarteira(text); } catch { return toast('Esse arquivo não é uma carteira válida.'); }
    if (!d) return toast('Esse arquivo está vazio.');
    const finish = () => { applyFileData(d, state.fileName || 'minha-carteira.json'); setFileStatus('manual'); toast(`Carteira aberta (salva em ${fmtWhen(d.savedAt)}).`); };
    if (state.assets.length && hasLocalChanges() && !state.demo) {
      state.fileName = state.fileName || 'minha-carteira.json';
      return askConflict(d, 'escolhido');  // decide entre a versão do arquivo e a deste aparelho
    }
    finish();
  });
}

async function saveManual() {
  if (!state.savedAt) state.savedAt = new Date().toISOString();
  const name = state.fileName || 'minha-carteira.json';
  const f = new File([serialize()], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [f] })) {
      await navigator.share({ files: [f], title: 'Minha Carteira' });
      toast('Escolha o Google Drive ou o OneDrive e substitua o arquivo antigo.', 5000);
    } else {
      download(name, serialize(), 'application/json');
      toast('Arquivo baixado. Envie-o para o Drive/OneDrive substituindo o antigo.', 6000);
    }
    state.fileName = name;
    state.fileSyncedAt = state.savedAt;
    persistLocal(); setFileStatus('manual');
  } catch (e) { if (e?.name !== 'AbortError') toast('Não foi possível salvar o arquivo.'); }
}

/* ---------- indicador no topo + cartão em Ajustes ---------- */
function updateFileChip() {
  const c = $('#fileChip');
  if (!c) return;
  const s = fileSync.status;
  let html = '', cls = 'btn ghost file-chip', title = '';
  if (s === 'ok') { html = `${ICON.check}<span class="hide-sm">Salvo no arquivo</span>`; cls += ' ok'; title = `Salvando automaticamente em ${state.fileName}`; }
  else if (s === 'saving') { html = `${ICON.dot}<span class="hide-sm">Salvando…</span>`; title = 'Salvando no arquivo'; }
  else if (s === 'permission') { html = `${ICON.warn}<span>Reconectar arquivo</span>`; cls += ' warn'; title = 'Clique para permitir que o app continue salvando no seu arquivo'; }
  else if (s === 'error') { html = `${ICON.warn}<span class="hide-sm">Erro ao salvar</span>`; cls += ' warn'; title = 'Não foi possível salvar no arquivo — clique para ver'; }
  else if (s === 'manual') {
    if (hasLocalChanges()) { html = `${ICON.warn}<span>Salvar no Drive</span>`; cls += ' warn'; title = 'Há alterações que ainda não foram salvas no arquivo'; }
    else { html = `${ICON.check}<span class="hide-sm">Arquivo em dia</span>`; cls += ' ok'; title = 'Nenhuma alteração pendente'; }
  } else if (state.assets.length) { html = `${ICON.file.replace('width="20" height="20"', 'width="16" height="16"')}<span class="hide-sm">Salvar no Drive</span>`; title = 'Guarde sua carteira num arquivo no Google Drive ou OneDrive'; }
  c.hidden = !html; c.className = cls; c.innerHTML = html; c.title = title;
}
function onFileChip() {
  const s = fileSync.status;
  if (s === 'permission') return reconnectFile();
  if (s === 'manual' && hasLocalChanges()) return saveManual();
  ui.tab = 'config'; render();
  setTimeout(() => $('#fileCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}

function fileCardHtml() {
  const s = fileSync.status;
  const name = esc(state.fileName || '');
  let status = '';
  if (s === 'ok' || s === 'saving') status = `<div class="alert good"><div class="ic">${ICON.check}</div><div><h3>Salvando automaticamente em "${name}"</h3><p>Última gravação: ${fmtWhen(state.fileSyncedAt)}. Se o arquivo estiver numa pasta do Google Drive ou do OneDrive, ele vai para a nuvem sozinho.</p></div></div>`;
  else if (s === 'permission') status = `<div class="alert warn"><div class="ic">${ICON.warn}</div><div><h3>O navegador pediu para confirmar o acesso a "${name}"</h3><p>Por segurança, às vezes o navegador pede a permissão de novo depois que é fechado.</p></div></div>`;
  else if (s === 'error') status = `<div class="alert bad"><div class="ic">${ICON.warn}</div><div><h3>Não foi possível salvar em "${name}"</h3><p>O arquivo pode ter sido movido ou apagado. Reconecte ou escolha outro arquivo.</p></div></div>`;
  else if (s === 'manual') status = hasLocalChanges()
    ? `<div class="alert warn"><div class="ic">${ICON.warn}</div><div><h3>Alterações ainda não salvas no arquivo</h3><p>Toque em "Salvar no Drive" e substitua o arquivo antigo para levar as mudanças para os outros aparelhos.</p></div></div>`
    : `<div class="alert good"><div class="ic">${ICON.check}</div><div><h3>Arquivo em dia</h3><p>Salvo pela última vez em ${fmtWhen(state.fileSyncedAt)}.</p></div></div>`;

  const howAuto = `<ol class="steps"><li>Instale o <b>Google Drive para computador</b> ou use o <b>OneDrive</b> (já vem no Windows). Eles criam uma pasta que se sincroniza com a nuvem.</li><li>Clique em <b>Salvar carteira num arquivo</b> e escolha essa pasta.</li><li>Pronto: cada alteração é gravada no arquivo automaticamente. Em outro aparelho, use <b>Abrir arquivo</b>.</li></ol>`;
  const howManual = `<ol class="steps"><li>Para abrir: toque em <b>Abrir arquivo</b> e escolha o arquivo no Google Drive ou OneDrive.</li><li>Depois de alterar algo, toque em <b>Salvar no Drive</b>, escolha o Drive/OneDrive e substitua o arquivo antigo.</li></ol>
    <p class="muted" style="font-size:.82rem">Neste navegador o salvamento automático não está disponível — ele só existe no Chrome e no Edge de computador.</p>`;

  let buttons;
  if (FS_OK && fileSync.handle) {
    buttons = `${s === 'permission' || s === 'error' ? '<button class="btn primary" data-act="reconnect">Reconectar arquivo</button>' : ''}
      <button class="btn" data-act="createFile">Salvar em outro arquivo</button><button class="btn" data-act="openFile">Abrir outro arquivo</button><button class="btn ghost danger" data-act="disconnect">Parar de salvar no arquivo</button>`;
  } else if (FS_OK) {
    buttons = `<button class="btn primary" data-act="createFile">Salvar carteira num arquivo</button><button class="btn" data-act="openFile">Abrir arquivo</button>`;
  } else {
    buttons = `<button class="btn primary" data-act="saveManual">Salvar no Drive</button><button class="btn" data-act="openFile">Abrir arquivo</button>`;
  }
  return `<div class="card span-2" id="fileCard">
    <div class="card-head"><h2>Arquivo da carteira (Google Drive / OneDrive)</h2></div>
    <p class="ink2" style="font-size:.9rem">Guarde a carteira num arquivo na <b>sua</b> nuvem para acessar de outros computadores e do celular. O arquivo é só seu: ninguém mais tem acesso a ele.</p>
    ${status ? `<div style="margin-top:12px">${status}</div>` : ''}
    ${!fileSync.handle && s !== 'manual' ? (FS_OK ? howAuto : howManual) : s === 'manual' ? howManual : ''}
    <div class="row" style="margin-top:12px">${buttons}</div>
  </div>`;
}

async function initFileSync() {
  if (!FS_OK) { if (state.fileName) setFileStatus('manual'); else updateFileChip(); return; }
  const h = await idb.get('handle');
  if (!h) { updateFileChip(); return; }
  fileSync.handle = h;
  state.fileName = h.name;
  let p = 'prompt';
  try { p = await h.queryPermission({ mode: 'readwrite' }); } catch {}
  if (p === 'granted') { setFileStatus('ok'); await syncFromFile(); }
  else setFileStatus('permission');
}
// ao voltar para a aba, confere se o arquivo foi alterado em outro aparelho
let lastVisCheck = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && fileSync.status === 'ok' && Date.now() - lastVisCheck > 5000 && $('#modal').hidden) {
    lastVisCheck = Date.now(); syncFromFile();
  }
});

/* =========================================================================
   Tooltip, toast, eventos
   ========================================================================= */
const tip = $('#tooltip');
document.addEventListener('pointermove', e => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.dataset.tip; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
});
document.addEventListener('pointerleave', () => { tip.hidden = true; });

let toastT;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

const findAny = id => state.assets.find(a => a.id === id) || state.radar.find(a => a.id === id);

document.addEventListener('click', e => {
  const el = e.target.closest('button, [data-act]');
  if (!el) { if (e.target.id === 'modal') closeModal(); return; }
  const d = el.dataset;
  if (d.tab) { ui.tab = d.tab; render(); scrollTo(0, 0); return; }
  if (d.tabGo) { ui.tab = d.tabGo; render(); scrollTo(0, 0); return; }
  if (d.sort) { ui.sortBy = d.sort; render(); return; }
  if (d.close !== undefined) return closeModal();
  if (d.edit) { const a = findAny(d.edit); return assetForm(a, { radar: state.radar.includes(a) }); }
  if (d.buy) return buyForm(findAny(d.buy));
  if (d.promote) return buyForm(findAny(d.promote));
  if (d.quick) { ui.aporte = Number(d.quick); render(); return; }
  if (d.del) {
    const a = findAny(d.del);
    if (confirm(`Excluir ${a.ticker || a.name} da carteira?`)) { state.assets = state.assets.filter(x => x.id !== d.del); save(); render(); }
    return;
  }
  switch (d.act) {
    case 'add': return assetForm(null);
    case 'addRadar': return assetForm(null, { radar: true });
    case 'import': return importCsv();
    case 'demo': return loadDemo();
    case 'refresh': return refreshQuotes();
    case 'template': return download('modelo-carteira.csv', '﻿' + CSV_TEMPLATE, 'text/csv');
    case 'exportCsv': return exportCsv();
    case 'export': return download(`backup-carteira-${new Date().toISOString().slice(0, 10)}.json`, serialize(), 'application/json');
    case 'restore': return pickFile('.json,application/json', text => {
      try { const d = parseCarteira(text); if (!d) throw 0; const { app, ...rest } = d; state = { ...blankState(), ...rest, fileName: state.fileName, fileSyncedAt: state.fileSyncedAt }; save(); render(); toast('Backup restaurado.'); }
      catch { toast('Arquivo de backup inválido.'); }
    });
    case 'openFile': return openFile();
    case 'createFile': return createFile();
    case 'saveManual': return saveManual();
    case 'reconnect': return reconnectFile();
    case 'disconnect': return disconnectFile();
    case 'reset':
      if (confirm('Apagar TODOS os dados deste navegador? Faça um backup antes, se quiser guardar.')) {
        const tk = state.settings.token; state = blankState(); state.settings.token = tk; save(); ui.tab = 'painel'; render();
      }
      return;
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#btnRefresh').addEventListener('click', refreshQuotes);
$('#fileChip').addEventListener('click', onFileChip);
$('#btnTheme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('minha-carteira.theme', next); } catch {}
});
try { const t = localStorage.getItem('minha-carteira.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

// clique nos botões de quantia rápida também atualiza o campo
document.addEventListener('click', e => { const q = e.target.closest('[data-quick]'); if (q && $('#aporteVal')) $('#aporteVal').value = NUM.format(ui.aporte); });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// gráficos recalculam a largura quando a janela muda de tamanho
let resizeT, lastW = innerWidth;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40 && $('#modal').hidden && document.activeElement?.id !== 'aporteVal') { lastW = innerWidth; render(); } }, 250);
});

render();
initFileSync();
