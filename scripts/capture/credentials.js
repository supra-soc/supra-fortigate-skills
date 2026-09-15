#!/usr/bin/env node
/**
 * credentials.js — Manejo del archivo de credenciales para la toma de capturas.
 *
 * Existe para que las contrasenas nunca pasen por el chat, por argumentos de
 * linea de comandos (donde quedarian en el historial del shell y en la lista de
 * procesos) ni por el codigo. El agente (o install.ps1) crea el archivo vacio,
 * el humano lo llena una vez, y el script lo lee en cada informe. El archivo
 * NO se borra solo: persiste entre informes a proposito, para que pedir un
 * informe sea un solo mensaje sin volver a escribir contrasenas. Se vacia
 * solo si alguien corre --wipe explicitamente.
 *
 * CLI:
 *   node credentials.js --init    Crea el archivo vacio con la plantilla y
 *                                 muestra su ruta absoluta. No pisa un archivo
 *                                 que ya tenga credenciales.
 *   node credentials.js --check   Valida el formato y lista los equipos que
 *                                 encontro. NUNCA imprime contrasenas.
 *   node credentials.js --wipe    Deja el archivo en blanco otra vez.
 *
 * Todas aceptan --file <ruta> para usar otro archivo.
 *
 * Formato (bloques separados por una linea en blanco, 4 lineas por bloque):
 *   # <hostname>
 *   https://<ip>:<puerto>
 *   <usuario>
 *   <contrasena>
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'credentials.txt');

const TEMPLATE = [
  '# ARCHIVO DE CREDENCIALES — toma de capturas con Playwright',
  '#',
  '# Este archivo NO se versiona (esta en .gitignore). Llenalo una vez: no se',
  '# borra solo entre informes, asi que pedir un informe despues de esto es un',
  '# solo mensaje sin contrasenas en el chat. Borralo tu con --wipe si quieres.',
  '#',
  '# Escribe UN BLOQUE POR EQUIPO, separados por UNA LINEA EN BLANCO.',
  '# Cada bloque son exactamente 4 lineas, en este orden:',
  '#',
  '#     # nombre-del-equipo',
  '#     https://ip:puerto',
  '#     usuario',
  '#     contrasena',
  '#',
  '# Ejemplo de referencia (esta comentado, el parser lo ignora):',
  '#',
  '#     # FGT600-master',
  '#     https://10.10.200.100:9443',
  '#     usuario',
  '#     contrasena',
  '#',
  '#     # FAZ-CLIENTE',
  '#     https://10.10.200.50:443',
  '#     admin_faz',
  '#     otra_contrasena',
  '#',
  '# Escribe tus bloques reales debajo de esta linea:',
  '',
  '',
].join('\n');

function parseCredentials(text) {
  // Escaneo lineal, SIN depender de lineas en blanco como separador de bloque.
  //
  // Version anterior: partia el archivo por "\n\s*\n" (linea en blanco). Se
  // rompio en el primer uso real: la plantilla usa "#" (un comentario vacio)
  // como relleno visual entre parrafos de instrucciones, no una linea en
  // blanco de verdad -- asi que el bloque entero de instrucciones y el primer
  // equipo real terminaban fusionados en un solo "bloque", y el hostname
  // detectado era la primera linea del encabezado, no el "# nombre-equipo"
  // real. Con un solo equipo en el archivo, el fallback de "un solo bloque =
  // usarlo" tapaba el bug; con dos, habria fallado de verdad.
  //
  // Este parser no necesita lineas en blanco en absoluto: cualquier linea que
  // empiece por "#" es una etiqueta candidata a hostname. Un bloque se cierra
  // en cuanto acumula sus 3 lineas de datos (url, usuario, contrasena); la
  // siguiente linea "#" que aparezca abre el bloque siguiente. Varias lineas
  // de comentario seguidas antes de los datos son validas (instrucciones,
  // ejemplos) -- se queda con la ULTIMA como hostname, que es la mas cercana
  // a los datos y por tanto la que de verdad los etiqueta.
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);

  const entries = [];
  const problems = [];
  let pendingHost = null;
  let data = [];
  let blockNum = 0;

  function closeBlock() {
    if (data.length === 0) return; // nada pendiente, no era un bloque real
    blockNum += 1;
    const label = pendingHost ? ' (' + pendingHost + ')' : '';
    if (data.length !== 3) {
      problems.push(
        'Bloque ' + blockNum + label + ': tiene ' + data.length +
        ' linea(s) de datos, se esperaban 3 (url, usuario, contrasena).'
      );
      return;
    }
    const [url, user, pass] = data;
    if (!/^https?:\/\//i.test(url)) {
      problems.push(
        'Bloque ' + blockNum + label + ': la primera linea de datos debe ser la ' +
        'URL y empezar por https:// — se leyo "' + url + '".'
      );
      return;
    }
    entries.push({ host: pendingHost || '', url: url, user: user, pass: pass });
  }

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (data.length > 0) {
        // Ya hay datos acumulados (completos o no): esta "#" cierra ese
        // bloque -- con sus propios datos, nunca mezclado con el siguiente
        // -- y abre uno nuevo. Un bloque a medias (1-2 lineas) se reporta
        // con su propio host, no se le pega la culpa al bloque de despues.
        closeBlock();
        data = [];
      }
      // Con datos a medio acumular (1-2 lineas) o sin datos aun, una nueva
      // etiqueta de comentario siempre reemplaza al pendiente: es la mas
      // cercana a los datos que vienen despues.
      pendingHost = line.replace(/^#+\s*/, '').trim();
    } else {
      data.push(line);
    }
  }
  closeBlock();

  return { entries: entries, problems: problems };
}

function readCredentialsFile(file) {
  if (!fs.existsSync(file)) {
    const err = new Error(
      'No existe el archivo de credenciales:\n  ' + file + '\n\n' +
      'Crealo con:\n  node scripts/capture/credentials.js --init\n' +
      'y pide al usuario que lo llene antes de tomar capturas.'
    );
    err.code = 'ENOCREDS';
    throw err;
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * Devuelve las credenciales del equipo pedido.
 * Coincidencia por hostname (sin distinguir mayusculas) y, si falla, por URL.
 * Si el archivo tiene un solo bloque se usa ese, para que el caso comun de un
 * equipo unico no obligue a que el hostname coincida exactamente.
 */
function loadCredentialsFor(opts) {
  const host = opts.host;
  const url = opts.url;
  const file = opts.file || DEFAULT_FILE;

  const parsed = parseCredentials(readCredentialsFile(file));
  const entries = parsed.entries;
  const problems = parsed.problems;

  if (!entries.length) {
    const detail = problems.length
      ? '\n\nProblemas de formato:\n  - ' + problems.join('\n  - ')
      : '';
    const err = new Error(
      'El archivo de credenciales esta vacio o mal formado:\n  ' + file + detail +
      '\n\nCada bloque son 4 lineas: "# hostname", url, usuario, contrasena.'
    );
    err.code = 'ENOCREDS';
    throw err;
  }

  const norm = (s) => (s || '').toLowerCase().replace(/\/+$/, '');
  let hit =
    entries.find((e) => host && norm(e.host) === norm(host)) ||
    entries.find((e) => url && norm(e.url) === norm(url));

  if (!hit && entries.length === 1) hit = entries[0];

  if (!hit) {
    const err = new Error(
      'No hay credenciales para "' + (host || url) + '" en ' + file + '.\n' +
      'Equipos disponibles en el archivo: ' +
      entries.map((e) => e.host || e.url).join(', ') + '.\n' +
      'Revisa que el "# hostname" del bloque coincida con el --host que pasaste.'
    );
    err.code = 'ENOCREDS';
    throw err;
  }

  if (problems.length) {
    console.error('AVISO: hay bloques ignorados por formato invalido:');
    problems.forEach((p) => console.error('  - ' + p));
  }

  return hit;
}

function cliInit(file) {
  if (fs.existsSync(file)) {
    const entries = parseCredentials(fs.readFileSync(file, 'utf8')).entries;
    if (entries.length) {
      console.log('El archivo ya existe y tiene ' + entries.length + ' equipo(s) cargado(s):');
      console.log('  ' + path.resolve(file));
      console.log('Equipos: ' + entries.map((e) => e.host || e.url).join(', '));
      console.log('No se toco. Usa --wipe si quieres vaciarlo.');
      return;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE, 'utf8');
  console.log('Archivo de credenciales listo (vacio). Ruta absoluta:');
  console.log('  ' + path.resolve(file));
  console.log('');
  console.log('Abrelo y escribe un bloque por equipo, separados por una linea en blanco:');
  console.log('  # nombre-del-equipo');
  console.log('  https://ip:puerto');
  console.log('  usuario');
  console.log('  contrasena');
}

function cliCheck(file) {
  let text;
  try {
    text = readCredentialsFile(file);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const parsed = parseCredentials(text);
  parsed.problems.forEach((p) => console.error('ERROR: ' + p));
  if (!parsed.entries.length) {
    console.error('Sin credenciales validas en ' + path.resolve(file) + '. Falta llenarlo.');
    process.exit(2);
  }
  // Se listan host y URL para poder verificar el formato; la contrasena solo se
  // reporta como presente/ausente, nunca se imprime.
  console.log('OK: ' + parsed.entries.length + ' equipo(s) en ' + path.resolve(file));
  parsed.entries.forEach((e) => {
    console.log(
      '  - ' + (e.host || '(sin nombre)') + ' -> ' + e.url +
      ' | usuario: ' + e.user +
      ' | contrasena: ' + (e.pass ? 'presente' : 'FALTA')
    );
  });
  if (parsed.problems.length) process.exit(2);
}

function cliWipe(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, TEMPLATE, 'utf8');
  console.log('Credenciales borradas. El archivo quedo en blanco: ' + path.resolve(file));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const file = fileIdx !== -1 && argv[fileIdx + 1] ? argv[fileIdx + 1] : DEFAULT_FILE;

  if (argv.includes('--init')) cliInit(file);
  else if (argv.includes('--check')) cliCheck(file);
  else if (argv.includes('--wipe')) cliWipe(file);
  else {
    console.log('Uso: node credentials.js (--init | --check | --wipe) [--file <ruta>]');
    console.log('  --init   crea el archivo vacio y muestra su ruta');
    console.log('  --check  valida el formato y lista equipos (sin mostrar contrasenas)');
    console.log('  --wipe   vacia el archivo');
    process.exit(argv.length ? 2 : 0);
  }
}

module.exports = {
  loadCredentialsFor: loadCredentialsFor,
  parseCredentials: parseCredentials,
  DEFAULT_FILE: DEFAULT_FILE,
  TEMPLATE: TEMPLATE,
};
