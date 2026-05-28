import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ITER = 310000; // PBKDF2 — precisa bater com o decriptador no navegador

const senha = process.env.BI_PASSWORD || process.argv[2] || '';
if (!senha || senha.length < 8) {
  console.error('\nDefina uma senha forte (>= 8 caracteres) antes de publicar:');
  console.error('  - edite bi-sienge/.env e preencha  BI_PASSWORD=suaSenhaForte');
  console.error('  - ou rode:  node src/encrypt.js suaSenhaForte\n');
  process.exit(1);
}

const src = path.join(ROOT, 'dashboard.html');
if (!fs.existsSync(src)) {
  console.error('dashboard.html nao existe. Rode "npm run build" primeiro.');
  process.exit(1);
}
const plain = fs.readFileSync(src, 'utf8');

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(senha, salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
const full = Buffer.concat([ct, cipher.getAuthTag()]); // Web Crypto espera o tag no fim

const payload = {
  v: 1,
  iter: ITER,
  salt: salt.toString('base64'),
  iv: iv.toString('base64'),
  ct: full.toString('base64'),
};

const out = wrapper(payload);
const dir = path.join(ROOT, 'public');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'index.html'), out);

console.log('\nPublicacao criptografada gerada: public/index.html');
console.log(`  AES-256-GCM · PBKDF2-SHA256 · ${ITER.toLocaleString('pt-BR')} iteracoes`);
console.log('  Nenhum dado legivel no arquivo sem a senha.');
console.log('\nProximo passo: suba SO a pasta public/ (ou public/index.html) para GitHub Pages ou Netlify.');
console.log('NUNCA suba a pasta data/ nem o .env.\n');

function wrapper(p) {
  const J = JSON.stringify(p);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Reserva · SPE 01 — acesso restrito</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#c9d1d9;
       font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:min(92vw,380px);background:#161b22;border:1px solid #2a3441;border-radius:14px;padding:28px 26px;
        box-shadow:0 10px 40px #0008}
  h1{font-size:18px;margin:0 0 4px}
  p{font-size:13px;color:#8b98a5;margin:0 0 20px}
  label{font-size:12px;color:#8b98a5;display:block;margin-bottom:6px}
  input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #2a3441;background:#0d1117;color:#c9d1d9;font-size:15px}
  input:focus{outline:none;border-color:#58a6ff}
  button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#238636;color:#fff;
         font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  .err{color:#f85149;font-size:13px;margin-top:12px;min-height:18px}
</style>
</head>
<body>
  <form class="card" id="f">
    <h1>🏢 Reserva · SPE 01</h1>
    <p>Painel restrito. Informe a senha para acessar.</p>
    <label for="pw">Senha</label>
    <input id="pw" type="password" autocomplete="current-password" autofocus>
    <button id="b" type="submit">Entrar</button>
    <div class="err" id="e"></div>
  </form>
<script>
const P=${J};
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const f=document.getElementById('f'),pw=document.getElementById('pw'),e=document.getElementById('e'),b=document.getElementById('b');
f.addEventListener('submit',async ev=>{
  ev.preventDefault();
  e.textContent='';b.disabled=true;b.textContent='Verificando...';
  try{
    const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw.value),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(P.salt),iterations:P.iter,hash:'SHA-256'},
      km,{name:'AES-GCM',length:256},false,['decrypt']);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64(P.iv)},key,b64(P.ct));
    const html=new TextDecoder().decode(plain);
    document.open();document.write(html);document.close();
  }catch(err){
    b.disabled=false;b.textContent='Entrar';
    e.textContent='Senha incorreta.';pw.value='';pw.focus();
  }
});
</script>
</body>
</html>`;
}
