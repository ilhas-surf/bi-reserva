import 'dotenv/config';

const SUBDOMAIN = process.env.SIENGE_SUBDOMAIN?.trim();
const USER = process.env.SIENGE_API_USER?.trim();
const PASS = process.env.SIENGE_API_PASSWORD?.trim();

if (!SUBDOMAIN || !USER || !PASS) {
  console.error('\n[ERRO] Preencha SIENGE_SUBDOMAIN, SIENGE_API_USER e SIENGE_API_PASSWORD no arquivo .env');
  console.error('Copie .env.example para .env e edite.\n');
  process.exit(1);
}

const BASE = `https://api.sienge.com.br/${SUBDOMAIN}/public/api/v1`;
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

// Limite da API: 200 req/min. Usamos margem (150/min ~= 1 req a cada 400ms).
const MIN_INTERVAL_MS = 400;
let lastCall = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

function buildUrl(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

// GET simples (uma chamada), com retry para 429/5xx.
export async function get(path, params = {}, { tries = 4 } = {}) {
  const url = buildUrl(path, params);
  for (let attempt = 1; attempt <= tries; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
    } catch (err) {
      if (attempt === tries) throw err;
      await sleep(1000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || attempt * 2;
      if (attempt === tries) {
        throw new Error(`${res.status} em ${path} apos ${tries} tentativas`);
      }
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status === 404) return { __status: 404, results: [] };
    if (res.status === 401) {
      throw new Error(`401 CREDENCIAL invalida em ${path}. Verifique usuario/senha de API no .env.`);
    }
    if (res.status === 403) {
      // Permissao negada para este recurso especifico: nao e fatal, apenas pula.
      return { __status: 403, results: [] };
    }
    if (res.status === 400) {
      // Parametro/filtro nao suportado por este endpoint: nao fatal.
      const body = await res.text().catch(() => '');
      return { __status: 400, results: [], error: body.slice(0, 200) };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} em ${path}: ${body.slice(0, 300)}`);
    }
    const text = await res.text();
    if (!text) return { results: [] };
    try {
      return JSON.parse(text);
    } catch {
      return { results: [], raw: text };
    }
  }
}

// GET paginado: percorre todas as paginas via limit/offset e concatena results.
// Blindagens:
//  - para se a pagina vier menor que pageSize (ultima pagina)
//  - usa resultSetMetadata.count quando existir
//  - DETECTA endpoint que ignora offset (devolve sempre a mesma 1a linha) e para
//  - teto de paginas (maxPages) para nunca rodar pra sempre
export async function getAll(path, params = {}, { pageSize = 200, max = Infinity, maxPages = 100 } = {}) {
  const out = [];
  let offset = 0;
  let prevFirstKey = null;
  for (let page = 0; page < maxPages && out.length < max; page++) {
    const data = await get(path, { ...params, limit: pageSize, offset });
    if (data.__status === 404 || data.__status === 403 || data.__status === 400) {
      out.__status = data.__status;
      out.__error = data.error;
      break;
    }
    const batch = Array.isArray(data.results) ? data.results : (Array.isArray(data) ? data : []);
    if (batch.length === 0) break;

    // Deteccao de offset ignorado: se a 1a linha desta pagina e igual a da anterior,
    // o endpoint nao esta paginando -> ficamos so com a 1a pagina.
    const firstKey = JSON.stringify(batch[0]);
    if (firstKey === prevFirstKey) {
      console.warn(`    [aviso] ${path} parece ignorar offset; usando apenas a 1a pagina.`);
      break;
    }
    prevFirstKey = firstKey;

    out.push(...batch);
    const total = data.resultSetMetadata?.count;
    if (batch.length < pageSize) break;
    if (typeof total === 'number' && out.length >= total) break;
    offset += pageSize;
  }
  return out;
}

export { BASE, SUBDOMAIN };
