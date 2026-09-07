#!/usr/bin/env node
/**
 * capture_playwright.js — Toma las capturas "en vivo" de la GUI de un
 * FortiGate / FortiAnalyzer usando Playwright y deja un captures.json listo
 * para build_report.js.
 *
 * Playwright corre como un proceso Node autonomo: no depende de ningun MCP ni
 * de las herramientas de navegador del agente, guarda PNGs reales en disco y
 * funciona igual con opencode, Claude Code o cualquier otro agente.
 *
 * Cómo corre la sesión (headless por defecto; `--headed` para verla):
 *   node capture_playwright.js --url https://10.10.200.100:10443 \
 *     --host FGT600-master --out capturas
 *
 * Credenciales: NUNCA por argumentos (quedarian en el historial del shell y en
 * la lista de procesos). Se leen de credentials.txt en la raiz del repo, que se
 * crea vacio con `node scripts/capture/credentials.js --init`. Un bloque por
 * equipo: "# hostname", url, usuario, contrasena. Ver credentials.js.
 *
 * Requisito: playwright instalado en la raiz del repo (ver README.md).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadCredentialsFor, DEFAULT_FILE } = require('./credentials');

// ---------- argumentos ----------
const USAGE = `
Uso:
  node capture_playwright.js --host <hostname> [--url <https://IP:puerto>] [--out <dir>] [--headed]

Toma las capturas "en vivo" de la GUI de un FortiGate / FortiAnalyzer (licencia,
gráficas CPU/memoria/sesiones, HA) con Playwright y deja/actualiza captures.json
listo para build_report.js.

Obligatorio:
  --host  hostname del equipo, ej. FGT-EJEMPLO01. Debe coincidir con el
          "# hostname" de un bloque de credentials.txt.

Opcionales:
  --url    URL de gestion. Si se omite se usa la del bloque en credentials.txt.
  --creds  ruta a otro archivo de credenciales (default: credentials.txt del repo)
  --out    carpeta de salida para los PNG (default: capturas/)
  --headed abrir navegador visible en vez de headless (default: false)

Credenciales (NUNCA por argumentos):
  Se leen de credentials.txt (raiz del repo, gitignored). Crealo vacio con:
      node scripts/capture/credentials.js --init
  y llenalo con un bloque por equipo, separados por una linea en blanco:
      # hostname
      https://ip:puerto
      usuario
      contrasena
  Con --creds <ruta> se usa otro archivo.
`.trim();
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const HOST = arg('host') || process.env.FG_HOST || '';
const OUT = arg('out') || process.env.FG_OUT || 'capturas';
const HEADED = arg('headed', 'false') === 'true';
const WIDTH = parseInt(arg('width') || '1700', 10);
const HEIGHT = parseInt(arg('height') || '950', 10);
const CREDS_FILE = arg('creds') || process.env.FG_CREDS || DEFAULT_FILE;

if (!HOST) {
  console.error('Falta el hostname (--host). Ejemplo:');
  console.error('  node scripts/capture/capture_playwright.js --host FGT-EJEMPLO01');
  console.error('Da --help para mas detalles.');
  process.exit(2);
}

// ---------- credenciales ----------
// La URL puede venir del archivo de credenciales (cada bloque la trae), asi que
// --url es opcional: con --host basta. Si se pasa --url, gana el argumento.
let creds;
try {
  creds = loadCredentialsFor({ host: HOST, url: arg('url') || '', file: CREDS_FILE });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (process.env.FG_USER && process.env.FG_PASS) {
  creds = { ...creds, user: process.env.FG_USER, pass: process.env.FG_PASS };
}

const URL = arg('url') || process.env.FG_URL || creds.url || '';
if (!/^https?:\/\//i.test(URL)) {
  console.error('URL de gestion invalida o ausente: "' + URL + '".');
  console.error('Ponla en el bloque del equipo dentro de ' + CREDS_FILE + ', o pasa --url.');
  process.exit(2);
}
console.log('Equipo:', HOST, '| URL:', URL, '| usuario:', creds.user);

// ---------- helpers ----------
async function shot(page, save) {
  await page.screenshot({ path: save, animations: 'disabled' });
  console.log('SHOT:', save);
}

async function shotEl(page, label, save) {
  // Buscar el widget cuyo título (.widget-title) empieza por el label
  // (case-insensitive, tolerando espacios/no-break y sufijos como "(IP)").
  const handle = await page.evaluateHandle((lbl) => {
    const titles = [...document.querySelectorAll('.widget-title')];
    const t = titles.find(el => {
      const txt = (el.textContent || '').trim().replace(/\u00a0/g, ' ');
      return txt.toUpperCase().startsWith(lbl.toUpperCase());
    });
    if (!t) return null;
    let cur = t;
    while (cur && cur !== document.body) {
      const cls = typeof cur.className === 'string' ? cur.className : (cur.className && cur.className.baseVal) || '';
      if (/NU-DASHBOARD-WIDGET|rsb-widget|widget-card|widget-container\b/i.test(cls)) return cur;
      cur = cur.parentElement;
    }
    return t;
  }, label);
  const element = await handle.asElement();
  if (!element) { console.log('WARN: widget no encontrado:', label); return false; }
  try {
    await element.screenshot({ path: save, animations: 'disabled' });
    console.log('SHOT:', save);
    return true;
  } catch (e) { console.log('WARN: screenshot de', label, 'falló:', e.message); return false; }
}

// Menú lateral: hacer clic en una etiqueta del sidebar (x < 300)
async function clickSidebar(page, label) {
  try {
    const el = await page.evaluateHandle((lbl) => {
      const els = [...document.querySelectorAll('a, div')];
      const c = els.filter(el => {
        const t = (el.textContent || '').trim();
        if (!new RegExp('^' + lbl + '$').test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.x >= 0 && r.x < 320 && r.y > 0 && r.width > 40;
      });
      return c[0] || null;
    }, label);
    const asEl = el.asElement();
    if (asEl) { await asEl.click(); return true; }
  } catch (e) { /* noop */ }
  console.log('WARN: enlace', label, 'en sidebar no hallado');
  return false;
}

// ---------- flujo ----------
async function login(page) {
  await page.goto(URL, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // Banner de certificado/advertencia (varía según firmware)
  const accept = page.getByRole('button', { name: 'Accept' }).first();
  if (await accept.count()) { await accept.click(); await page.waitForTimeout(4000); }

  // Formulario de login estándar de FortiOS
  await page.fill('#username', creds.user);
  await page.fill('#secretkey', creds.pass);
  await page.click('#login_button');
  await page.waitForTimeout(8000);

  // Gestión central por FortiManager: proceder en modo solo lectura
  const ro = page.locator('text=Login Read-Only');
  if (await ro.count()) {
    await ro.first().click();
    await page.waitForTimeout(10000);
    console.log('login read-only seleccionado:', page.url());
  }
  await page.waitForTimeout(5000);
  console.log('URL final:', page.url());
  console.log('Título:', await page.title());

  // El formulario de login (usuario + contraseña) sigue en el DOM si las
  // credenciales fueron rechazadas o el equipo no llego a autenticar. Sin
  // este chequeo el script seguiria de largo, no encontraria ningun widget
  // del dashboard, y terminaria con un captures.json vacio sin decir por
  // que — exactamente el fallo silencioso que las reglas del skill piden
  // evitar. Se detecta ANTES de intentar ninguna captura.
  if (await page.locator('#secretkey').count()) {
    const body = await page.locator('body').innerText().catch(() => '');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'login_fallido.txt'), body);
    throw new Error(
      'El login no se completo: el formulario de usuario/contrasena sigue en pantalla. ' +
      'Credenciales incorrectas, cuenta bloqueada, o la GUI de este firmware difiere de lo esperado. ' +
      'Pagina guardada en ' + path.join(OUT, 'login_fallido.txt') + ' para diagnostico.'
    );
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED });
  // Todo lo que sigue puede fallar de muchas formas (IP inalcanzable, login
  // rechazado, timeout de red) y antes de este try/finally cualquiera de esos
  // fallos saltaba directo al catch final sin pasar por browser.close(),
  // dejando un Chromium huerfano corriendo en segundo plano — mas notorio
  // cuantos mas reintentos haga el agente. El finally garantiza el cierre
  // pase lo que pase.
  try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: WIDTH, height: HEIGHT },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  await login(page);

  const bodyText = await page.locator('body').innerText();
  fs.writeFileSync(path.join(OUT, 'dashboard_body.txt'), bodyText);
  const serial = (bodyText.match(/Serial[:\s]*([A-Z0-9-]{10,})/i) || [])[1];
  const model = (bodyText.match(/Model[:\s]*([A-Za-z0-9-]+)/i) || [])[1];
  console.log('SERIAL:', serial || 'n/a', '| MODEL:', model || 'n/a');

  // Widgets del dashboard: usar la etiqueta en español (firmware puede variar)
  const widgets = [
    { labels: ['CPU', 'Processador', 'Procesador'], key: 'cpu_' + HOST },
    { labels: ['Memory', 'Memoria'], key: 'memoria_' + HOST },
    { labels: ['Sessions', 'Sesiones'], key: 'sesiones_' + HOST },
  ];
  for (const w of widgets) {
    let done = false;
    for (const lbl of w.labels) {
      if (await shotEl(page, lbl, path.join(OUT, w.key + '.png'))) { done = true; break; }
    }
    if (!done) console.log('WARN: capture de', w.key, 'omitida (widget no visible)');
  }

  // Licencia / estado de soporte: la captura profesional es el apartado
  // "License Information" de System > FortiGuard (Entitlement Status con las
  // fechas de expiración de cada servicio: Web Filtering, Intrusion
  // Prevention, etc.). Se navega ahí y se recorta el bloque f-fortiguard-info.
  // El widget "Licenses" del dashboard queda solo como fallback si no se puede
  // acceder a FortiGuard.
  const licKey = 'licencia_' + HOST;
  let licOk = false;
  try {
    await page.goto(URL.replace(/\/+$/, '') + '/ng/system/fortiguard', { timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    const fgEl = page.locator('f-fortiguard-info').first();
    const fgN = await fgEl.count();
    if (fgN) {
      await fgEl.screenshot({ path: path.join(OUT, licKey + '.png'), animations: 'disabled' });
      console.log('SHOT:', path.join(OUT, licKey + '.png'), '(System > FortiGuard > License Information)');
      fs.copyFileSync(path.join(OUT, licKey + '.png'), path.join(OUT, 'licencia_general.png'));
      console.log('SHOT:', path.join(OUT, 'licencia_general.png'));
      licOk = true;
    }
  } catch (e) { console.log('WARN: navegación a FortiGuard falló:', e.message); }
  if (!licOk) {
    const lic = { labels: ['Licenses', 'Licencias', 'FortiGuard'], key: licKey };
    let licDone = false;
    for (const lbl of lic.labels) {
      if (await shotEl(page, lbl, path.join(OUT, lic.key + '.png'))) { licDone = true; break; }
    }
    if (licDone) {
      fs.copyFileSync(path.join(OUT, lic.key + '.png'), path.join(OUT, 'licencia_general.png'));
    } else {
      await clickSidebar(page, 'System');
      await clickSidebar(page, 'FortiGuard');
      await page.waitForTimeout(5000);
      await shot(page, path.join(OUT, 'licencia_general.png'));
      await shot(page, path.join(OUT, lic.key + '.png'));
    }
  }

  // HA en vivo: ruta Angular /ng/system/ha/monitor (determinista); fallback: menú lateral
  try {
    let haUrl = '';
    try {
      await page.goto(URL.replace(/\/+$/, '') + '/ng/system/ha/monitor', { timeout: 60000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000);
      haUrl = page.url();
    } catch (e) { /* fallback abajo */ }
    if (!/\/ha\//.test(haUrl)) {
      await clickSidebar(page, 'System');
      await page.waitForTimeout(3000);
      await clickSidebar(page, 'HA');
      await page.waitForTimeout(6000);
      haUrl = page.url();
    }
    console.log('HA URL:', haUrl);
    const haText = await page.locator('body').innerText();
    fs.writeFileSync(path.join(OUT, 'ha_body.txt'), haText);
    // Recortar la zona de contenido (a la derecha del sidebar). Se prefiere el
    // contenedor Angular router-outlet-container (1450x909); si no aparece, se
    // cae al contenedor visible de mayor área que no sea el body.
    const haHandle = await page.evaluateHandle(() => {
      const all = [...document.querySelectorAll('div, section, main')];
      const visible = all.filter(el => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 600 && r.height > 300 && r.width < window.innerWidth;
      });
      const target = all.find(el => /router-outlet-container/i.test(String(el.className)))
        || visible.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (rb.width * rb.height) - (ra.width * ra.height);
        })[0];
      return target || null;
    });
    const haEl = await haHandle.asElement();
    if (haEl) {
      await haEl.screenshot({ path: path.join(OUT, 'ha_live_' + HOST + '.png'), animations: 'disabled' });
    } else {
      await shot(page, path.join(OUT, 'ha_live_' + HOST + '.png'));
    }
    console.log('SHOT: ha_live_' + HOST);
  } catch (e) { console.log('WARN: captura HA falló:', e.message); }
  } finally {
    // .catch(()=>{}) porque si ya estamos manejando un error real (p.ej. el
    // de login), un fallo secundario al cerrar el navegador no debe tapar el
    // mensaje que el usuario realmente necesita ver.
    await browser.close().catch(() => {});
  }

  // ---------- generar captures.json ----------
  // Solo se llega aqui si el try de arriba termino sin lanzar: si login()
  // fallo, no hay nada que registrar y el catch final de abajo ya se encarga
  // de reportarlo.
  const map = {
    'licencia_general': 'captures/licencia_general.png',
    ['licencia_' + HOST]: 'captures/licencia_' + HOST + '.png',
    ['cpu_' + HOST]: 'captures/cpu_' + HOST + '.png',
    ['memoria_' + HOST]: 'captures/memoria_' + HOST + '.png',
    ['sesiones_' + HOST]: 'captures/sesiones_' + HOST + '.png',
    ['ha_live_' + HOST]: 'captures/ha_live_' + HOST + '.png',
  };
  // Rutas relativas al captures.json (colocado en el OUT padre)
  const rel = {};
  for (const [k, v] of Object.entries(map)) {
    if (fs.existsSync(path.join(OUT, path.basename(v)))) {
      rel[k] = v.replace(/^captures\//, OUT.split(path.sep).pop() + '/');
    }
  }
  const outJson = path.join(OUT, '..', 'captures.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch (e) { existing = {}; }
  fs.writeFileSync(outJson, JSON.stringify({ ...existing, ...rel }, null, 2));
  console.log('captures.json actualizado:', outJson);
  console.log('Claves generadas:', Object.keys(rel).join(', '));
  console.log('DONE');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
