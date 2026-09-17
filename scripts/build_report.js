/**
 * build_report.js
 *
 * Assembles the final Word (.docx) implementation/migration report from:
 *   1) parsed.json   -> output of parse_fortigate_conf.py (one or more devices)
 *   2) metadata.json -> project/client answers collected during intake
 *
 * Usage:
 *   node build_report.js --metadata metadata.json --parsed parsed.json --out informe.docx
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, PageBreak, TableOfContents, ImageRun,
  Header, Footer, PageNumber, TextWrappingType, TableLayoutType,
  VerticalPositionRelativeFrom, HorizontalPositionRelativeFrom,
} = require("docx");

// Google Docs' .docx importer does not recompute table column widths the way
// Word does: without an explicit fixed layout it autofits tables (including
// the header) down to their content, which can shrink a column to near-zero
// width and wrap every word one character per line. Word tolerates the
// missing layout hint; Google Docs does not — so every Table() below must
// set this explicitly instead of relying on the DXA widths alone.
const FIXED_LAYOUT = { layout: TableLayoutType.FIXED };

// An interface counts as active/enabled for report tables when it isn't
// administratively disabled AND it actually carries some configuration
// (IP, alias, a WAN/DMZ role, or shows up as src/dstintf in a policy) --
// same "meaningful" test generate_topology.py uses to decide what to draw,
// kept in sync so the interfaces table and the topology diagram agree on
// which ports are "in use" and which are just bare, untouched physical ports.
function isActiveInterface(iface, referencedSet) {
  if ((iface.status || "up").toLowerCase() === "down") return false;
  const hasRole = iface.role === "wan" || iface.role === "dmz" || iface.role === "lan";
  const isReferenced = referencedSet.has(iface.name) && (iface.ip || iface.role);
  return Boolean(iface.ip || iface.alias || hasRole || isReferenced);
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const metadataPath = arg("metadata");
const parsedPath = arg("parsed");
const outPath = arg("out", "informe.docx");
const topologyPath = arg("topology"); // optional: PNG produced by generate_topology.py
const capturesPath = arg("captures"); // optional: JSON map { key: "path/to/screenshot.png" }

if (!metadataPath || !parsedPath) {
  console.error("Uso: node build_report.js --metadata metadata.json --parsed parsed.json --out informe.docx [--captures captures.json]");
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const parsed = JSON.parse(fs.readFileSync(parsedPath, "utf8"));

// ---------- captures (real screenshots -> embedded instead of "PEGAR AQUÍ") ----------
// captures.json keys used below: licencia_general, licencia_<hostname>, ospf_neighbor_<hostname>,
// ha_live_<hostname>, faz_logs, graficas_<hostname>. Any key not present (or file missing) falls
// back to the yellow "PEGAR AQUÍ" placeholder box, so partial capture sets are fine.
let captures = {};
if (capturesPath && fs.existsSync(capturesPath)) {
  const raw = JSON.parse(fs.readFileSync(capturesPath, "utf8"));
  const baseDir = path.dirname(path.resolve(capturesPath));
  captures = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, path.isAbsolute(v) ? v : path.join(baseDir, v)]),
  );
}

function isRealHa(ha) {
  if (!ha) return false;
  const mode = ha.mode || "";
  if (mode && mode !== "standalone") return true;
  if (["hbdev", "group-id", "group-name", "password"].some((k) => k in ha)) return true;
  return false;
}

// Un "config router ospf" vacio (solo los redistribute por defecto, sin
// router-id ni areas/redes/interfaces) hace que el parser marque ospf=si
// aunque el protocolo no este realmente en uso. Sin este chequeo el informe
// imprime "Router ID: (no configurado)" mas un recuadro de captura de
// neighbors que nunca se va a poder llenar porque OSPF no corre.
function isRealOspf(ospf) {
  if (!ospf) return false;
  if (ospf.router_id) return true;
  return ["areas", "networks", "interfaces"].some((k) => (ospf[k] || []).length);
}

// Sampled directly from the reference deliverable (anonymized) rather
// than guessed: table header band is a muted navy-indigo (~RGB 78,87,132),
// heading text is plain black, not the brand blue.
const COLOR_BRAND = "1F3864"; // kept for anything not re-themed below
const TABLE_HEADER_BG = "4E5784";
const HEADING_COLOR = "000000";
const COLOR_LIGHT = "DCE6F1";
const SUPRA_BLUE = "2B2570";
const FONT = "Arial"; // reference report renders as plain Arial-like sans, not Calibri

// ---------- SUPRA branding assets ----------

const ASSETS_DIR = path.join(__dirname, "assets");
const COVER_BG_PATH = path.join(ASSETS_DIR, "supra_cover_bg.png");
// Content-page header uses only a narrow sliver of the wordmark bleeding off
// the left margin (matches the reference report); the full-page version with
// baked-in contact text and footer dots is for the cover only.
const WATERMARK_PATH = path.join(ASSETS_DIR, "supra_watermark_narrow.png");
const HAS_COVER_BG = fs.existsSync(COVER_BG_PATH);
const HAS_WATERMARK = fs.existsSync(WATERMARK_PATH);

// A4 page geometry
const PAGE_W_TW = 11906; // 210mm in twips
const PAGE_H_TW = 16838; // 297mm in twips
const PAGE_W_PX = 794;   // 210mm @ 96dpi
const PAGE_H_PX = 1123;  // 297mm @ 96dpi

function pxToTwips(px) { return Math.round(px * 15); } // 1440 twips/in ÷ 96 px/in
function twipsToEmu(tw) { return Math.round(tw * 635); } // 1 twip = 635 EMU

function floatingImage(pngPath, { width, height, xTwips = 0, yTwips = 0, behind = true }) {
  const buf = fs.readFileSync(pngPath);
  return new ImageRun({
    type: "png",
    data: buf,
    transformation: { width, height },
    floating: {
      horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: twipsToEmu(xTwips) },
      verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: twipsToEmu(yTwips) },
      behindDocument: behind,
      wrap: { type: TextWrappingType.NONE },
      // relativeHeight in the OOXML schema is xsd:unsignedInt (required) -- a
      // negative zIndex here serializes as relativeHeight="-N", which Word's
      // strict validator rejects as corrupt even though LibreOffice, Google
      // Docs and python-docx all silently accept it. Must stay >= 0;
      // behindDocument already handles putting it behind the text.
      zIndex: behind ? 1 : 1000,
      allowOverlap: true,
    },
  });
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

function buildContentHeader() {
  const children = [];
  const headerTable = new Table({
    ...FIXED_LAYOUT,
    width: { size: 9300, type: WidthType.DXA },
    columnWidths: [4650, 4650],
    borders: { ...NO_BORDERS, insideHorizontal: NO_BORDER, insideVertical: NO_BORDER },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 4650, type: WidthType.DXA },
            borders: NO_BORDERS,
            children: [
              new Paragraph({ children: [new TextRun({ text: "Powering", size: 16, color: "404040", font: FONT })] }),
              new Paragraph({ children: [new TextRun({ text: "Future", italics: true, size: 16, color: "404040", font: FONT })] }),
            ],
          }),
          new TableCell({
            width: { size: 4650, type: WidthType.DXA },
            borders: NO_BORDERS,
            children: [
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Av. Manuel Olguín Nro. 325 Int. 502.", size: 16, color: SUPRA_BLUE, font: FONT })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "www.supra.com.pe", size: 16, color: SUPRA_BLUE, font: FONT })] }),
            ],
          }),
        ],
      }),
    ],
  });
  children.push(headerTable);
  if (HAS_WATERMARK) {
    // Just the narrow SUPRA wordmark sliver bleeding off the left margin,
    // like the reference report -- the full-bleed image with baked-in
    // contact text/footer dots belongs on the cover only (see COVER_BG_PATH).
    const wmW = 120;
    const wmH = Math.round(wmW * (2160 / 310));
    const yTwips = Math.round((PAGE_H_TW - pxToTwips(wmH)) / 2);
    children.push(new Paragraph({
      children: [floatingImage(WATERMARK_PATH, { width: wmW, height: wmH, xTwips: 0, yTwips, behind: true })],
    }));
  }
  return new Header({ children });
}

function buildContentFooter() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "595959", font: FONT })],
      }),
    ],
  });
}

// ---------- small helpers ----------

// Headings pushed through h1/h2/h3 are tracked here so the TOC can be built
// with cachedEntries once the full document is known -- LibreOffice/Google
// Docs render the TOC field as empty until someone opens it in Word and
// updates fields; cached entries make the "Contenido" page show real text
// (page numbers still resolve correctly in Word via features.updateFields).
const tocHeadings = [];
function h1(text) {
  tocHeadings.push({ title: text, level: 1 });
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 } });
}
function h2(text) {
  tocHeadings.push({ title: text, level: 2 });
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 250, after: 120 } });
}
function h3(text) {
  tocHeadings.push({ title: text, level: 3 });
  return new Paragraph({ text, heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 100 } });
}
function p(text, opts = {}) {
  return new Paragraph({ children: [new TextRun({ text: String(text ?? ""), ...opts })], spacing: { after: 120 } });
}
// Prose paragraph matching the reference report's body style: justified with
// a first-line indent (used for Alcance, HA/OSPF narrative notes, legal text).
function prose(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 720 },
    spacing: { after: 160 },
    children: [new TextRun({ text: String(text ?? ""), ...opts })],
  });
}
// Reference report uses a plain hyphen prefix for conclusiones, not a round
// bullet glyph, with generous spacing between items.
function bullet(text) {
  return new Paragraph({
    indent: { left: 400, hanging: 400 },
    spacing: { after: 200 },
    children: [new TextRun({ text: `-\t${text}` })],
  });
}

function cell(text, { header = false, width = 2000, shade = null } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: shade ? { type: ShadingType.CLEAR, fill: shade } : undefined,
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? ""), bold: header, color: header ? "FFFFFF" : undefined })],
    })],
  });
}

function dataTable(headers, rows, widths) {
  const w = widths || headers.map(() => Math.floor(9000 / headers.length));
  const headRow = new TableRow({
    tableHeader: true,
    children: headers.map((hd, idx) => cell(hd, { header: true, width: w[idx], shade: TABLE_HEADER_BG })),
  });
  const bodyRows = rows.map((r) => new TableRow({
    children: r.map((val, idx) => cell(val, { width: w[idx] })),
  }));
  return new Table({
    ...FIXED_LAYOUT,
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: w,
    rows: [headRow, ...bodyRows],
  });
}

// Plain key/value table with no header row and no shading, e.g. Memoria
// Descriptiva in the reference report -- just bordered rows of label|value.
function kvTable(rows, widths) {
  const w = widths || [3500, 5500];
  return new Table({
    ...FIXED_LAYOUT,
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: w,
    rows: rows.map((r) => new TableRow({
      children: r.map((val, idx) => cell(val, { width: w[idx] })),
    })),
  });
}

function manualPlaceholder(label) {
  return new Table({
    ...FIXED_LAYOUT,
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: [9000],
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 9000, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: "FFF2CC" },
        borders: {
          top: { style: BorderStyle.DASHED, size: 6, color: "BF9000" },
          bottom: { style: BorderStyle.DASHED, size: 6, color: "BF9000" },
          left: { style: BorderStyle.DASHED, size: 6, color: "BF9000" },
          right: { style: BorderStyle.DASHED, size: 6, color: "BF9000" },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
            children: [new TextRun({ text: `[ PEGAR AQUÍ: ${label} ]`, bold: true, color: "7F6000" })],
          }),
        ],
      })],
    })],
  });
}

function pngDimensions(buf) {
  // PNG: bytes 16-19 = width, 20-23 = height (big-endian), per IHDR chunk.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function imageParagraph(pngPath, maxWidthPx = 600) {
  const buf = fs.readFileSync(pngPath);
  const { width, height } = pngDimensions(buf);
  const scale = Math.min(1, maxWidthPx / width);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      type: "png",
      data: buf,
      transformation: { width: Math.round(width * scale), height: Math.round(height * scale) },
    })],
  });
}

function evidence(key, label, maxWidthPx = 550) {
  const imgPath = captures[key];
  if (imgPath && fs.existsSync(imgPath)) {
    return [
      imageParagraph(imgPath, maxWidthPx),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new TextRun({ text: `Captura: ${label}`, italics: true, size: 16, color: "595959" })],
      }),
    ];
  }
  return [manualPlaceholder(label)];
}

function usageMap(policies, field) {
  const set = new Set();
  policies.forEach((pol) => {
    (pol[field] || "").split(" ").filter(Boolean).forEach((v) => set.add(v));
  });
  return set;
}

// ---------- gather devices ----------

const deviceEntries = Object.entries(parsed.devices || {});
function deviceKind(dev) {
  const header = (dev._header || []).join(" ");
  if (/FAZ/i.test(header) || /FAZ/i.test(dev._source_file || "")) return "faz";
  return "fgt";
}
const firewalls = deviceEntries.filter(([, d]) => deviceKind(d) === "fgt");
const analyzers = deviceEntries.filter(([, d]) => deviceKind(d) === "faz");

// ---------- alinear captures.json con el hostname del .conf ----------
// capture_playwright.js guarda las claves con el --host que se le paso (la
// etiqueta del bloque de credentials.txt, p.ej. "fgt-lab"), no con el
// hostname real dentro del .conf (p.ej. "FGT-EJEMPLO01"). Nada obliga a que
// coincidan -- un ingeniero puede llamarle "fgt-lab" a las credenciales de
// un equipo cuyo .conf trae otro hostname. Sin este alias, evidence() busca
// "cpu_FGT-EJEMPLO01" y nunca encuentra "cpu_fgt-lab": todo cae al recuadro
// manual aunque las 6 capturas existan y esten bien. Confirmado en una
// corrida real: sin este fix, un agente sin iniciativa para diagnosticarlo
// entrega un informe con 6 recuadros vacios de pura casualidad de nombres.
//
// Solo se resuelve solo cuando es inambiguo: un unico firewall en el .conf y
// un unico sufijo de hostname entre las claves de captures.json. Con un par
// HA o varios equipos, adivinar cual captura es de cual firewall podria
// asignar mal las imagenes -- ahi se exige coincidencia exacta.
if (firewalls.length === 1 && Object.keys(captures).length) {
  const confHost = firewalls[0][0];
  const prefixes = ["licencia_", "cpu_", "memoria_", "sesiones_", "ha_live_", "ospf_neighbor_"];
  const suffixes = new Set();
  for (const key of Object.keys(captures)) {
    if (key === "licencia_general") continue; // clave fija, sin hostname -- no es un candidato a "sufijo"
    const pre = prefixes.find((p) => key.startsWith(p));
    if (pre) suffixes.add(key.slice(pre.length));
  }
  if (suffixes.size === 1) {
    const [capHost] = suffixes;
    if (capHost && capHost !== confHost) {
      for (const pre of prefixes) {
        const oldKey = pre + capHost;
        const newKey = pre + confHost;
        if (captures[oldKey] && !captures[newKey]) captures[newKey] = captures[oldKey];
      }
    }
  }
}

const tipoProyectoLabel = metadata.tipo_proyecto === "migracion"
  ? "Migración de equipos existentes"
  : "Implementación nueva (desde cero)";

// ---------- build sections ----------

const tituloInforme = metadata.tipo_proyecto === "migracion" ? "Informe de Migración" : "Informe de Implementación";

// ---------- Cover (its own section, full-bleed SUPRA background) ----------

const coverChildren = [];

if (HAS_COVER_BG) {
  // NOTE: absolute paragraph frames (w:framePr) were tried here first but produced a .docx that
  // Word refused to open ("unreadable content") even though LibreOffice/Google Docs rendered it
  // (with overlapping text, since neither positions legacy frames reliably either). Plain flowing
  // paragraphs on top of the behind-document background image is the safe, universally-compatible
  // approach -- spacing-before approximates the vertical position instead of pixel-perfect placement.
  coverChildren.push(new Paragraph({
    children: [floatingImage(COVER_BG_PATH, { width: PAGE_W_PX, height: PAGE_H_PX, xTwips: 0, yTwips: 0, behind: true })],
    spacing: { before: 4450 },
  }));
  coverChildren.push(new Paragraph({
    indent: { left: 2600 },
    spacing: { after: 0 },
    children: [new TextRun({ text: tituloInforme, bold: true, size: 56, color: "FFFFFF", font: FONT })],
  }));
  coverChildren.push(new Paragraph({
    indent: { left: 2600 },
    spacing: { before: 60, after: 600 },
    children: [new TextRun({ text: metadata.nombre_proyecto || "", size: 30, color: "D9D9D9", font: FONT })],
  }));
  coverChildren.push(new Paragraph({
    indent: { left: 2600 },
    spacing: { before: 5800 },
    children: [new TextRun({ text: `Cliente: ${metadata.cliente || ""}`, bold: true, size: 28, color: "FFFFFF", font: FONT })],
  }));
  coverChildren.push(new Paragraph({
    alignment: AlignmentType.RIGHT,
    indent: { right: 2600 },
    spacing: { before: 3600 },
    children: [new TextRun({ text: metadata.fecha_fin || new Date().toLocaleDateString("es-PE"), italics: true, bold: true, size: 22, color: "FFFFFF", font: FONT })],
  }));
} else {
  // Fallback (no brand asset found): plain cover, same content, no imagery.
  coverChildren.push(
    new Paragraph({ spacing: { before: 1500 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: tituloInforme, bold: true, size: 56, color: COLOR_BRAND, font: FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 600 },
      children: [new TextRun({ text: metadata.nombre_proyecto || "", size: 32, color: COLOR_BRAND, font: FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Cliente: ${metadata.cliente || ""}`, bold: true, size: 28 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 800 },
      children: [new TextRun({ text: metadata.fecha_fin || new Date().toLocaleDateString("es-PE"), size: 22 })],
    }),
  );
}

// ---------- Content (own section: SUPRA header/footer + watermark on every page) ----------

const children = [];

// Table of contents. "Contenido" itself must NOT go through h1() (it would
// list itself). The real TableOfContents is built at the very end, once every
// heading in the document is known, and spliced in here at tocIndex.
children.push(new Paragraph({ text: "Contenido", heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 150 } }));
const tocIndex = children.length;
children.push(new Paragraph({ text: "" })); // placeholder, replaced below once tocHeadings is complete
children.push(new Paragraph({ children: [new PageBreak()] }));

// Memoria descriptiva
children.push(h1("Memoria Descriptiva"));
children.push(kvTable(
  [
    ["NOMBRE DE PROYECTO", metadata.nombre_proyecto || ""],
    ["CLIENTE", metadata.cliente || ""],
    ["RUC DEL CLIENTE", metadata.ruc_cliente || ""],
    ["DIRECCIÓN DEL CLIENTE", metadata.direccion_cliente || ""],
    ["PERSONA DE CONTACTO EN CLIENTE", metadata.contacto_cliente || ""],
    ["UBICACIÓN (SEDE DEL PROYECTO)", metadata.ubicacion || ""],
    ["INGENIERO DE SUPRA A CARGO DEL PROYECTO", metadata.ingeniero || ""],
    ["TIPO DE PROYECTO", tipoProyectoLabel],
    ["FECHA DE INICIO", metadata.fecha_inicio || ""],
    ["FECHA DE CULMINACIÓN", metadata.fecha_fin || ""],
  ],
  [3500, 5500],
));

children.push(h2("Alcance"));
children.push(prose(metadata.alcance || "(pendiente de completar)"));

children.push(h2("Listado de Equipamiento"));
const equipoRows = (metadata.equipos || []).map((e) => [e.equipo || "", e.modelo || "", e.serie || "", e.fortios || ""]);
children.push(dataTable(["Equipo", "Modelo", "Número de serie", "FortiOS"], equipoRows, [2500, 2000, 3000, 1500]));

children.push(h2("Licencia / estado de soporte"));
children.push(...evidence("licencia_general", "estado de licencia y soporte (System > FortiGuard — License Information)"));

children.push(new Paragraph({ children: [new PageBreak()] }));

// Topología
children.push(h1("Topología de Red"));
children.push(p("Se implementó la siguiente infraestructura de red."));
if (topologyPath && fs.existsSync(topologyPath)) {
  children.push(imageParagraph(topologyPath));
  children.push(p("Diagrama generado automáticamente a partir de la configuración (interfaces, roles WAN/LAN/DMZ, HA y FortiAnalyzer detectados en el .conf).", { italics: true, size: 16 }));
} else {
  children.push(manualPlaceholder("diagrama de topología de red"));
}
children.push(new Paragraph({ children: [new PageBreak()] }));

// FORTIGATES
children.push(h1("Fortigates"));

firewalls.forEach(([hostname, dev]) => {
  children.push(h2(hostname + (dev.global.alias ? ` (${dev.global.alias})` : "")));

  children.push(h3("Versión de firmware y estado de licencia"));
  const cv = (dev._header || []).find((l) => l.includes("config-version")) || "";
  children.push(p(`Config-version reportado: ${cv.replace("#config-version=", "") || "N/D"}`));
  children.push(p("Estado de licencia:"));
  children.push(...evidence(`licencia_${hostname}`, `estado de licencia y soporte (System > FortiGuard) — ${hostname}`));

  children.push(h3("Interfaces"));
  const referencedSet = new Set(dev.referenced_interfaces || []);
  const activeInterfaces = dev.interfaces.filter((f) => isActiveInterface(f, referencedSet));
  const ifaceRows = activeInterfaces.map((f) => [f.name, f.alias, f.ip, f.role, f.allowaccess, f.vdom]);
  children.push(p(
    `Se listan solo las interfaces activas/habilitadas (${activeInterfaces.length} de ${dev.interfaces.length} detectadas en el .conf); los puertos físicos sin uso quedan fuera de esta tabla.`,
    { italics: true, size: 16 },
  ));
  children.push(dataTable(
    ["Interfaz", "Alias", "IP", "Rol", "Acceso admin", "VDOM"],
    ifaceRows,
    [1300, 1700, 2200, 1200, 1800, 800],
  ));

  children.push(h3("Rutas"));
  children.push(new Paragraph({ text: "Rutas estáticas", heading: HeadingLevel.HEADING_4 }));
  if (dev.static_routes.length) {
    children.push(dataTable(
      ["ID", "Destino", "Gateway", "Interfaz salida", "Distancia", "Zona SD-WAN"],
      dev.static_routes.map((r) => [r.id, r.dst, r.gateway, r.device, r.distance, r.sdwan_zone]),
      [700, 2400, 1800, 1800, 1200, 1100],
    ));
  } else {
    children.push(p("No se encontraron rutas estáticas configuradas en el .conf."));
  }
  if (dev.ospf) {
    children.push(new Paragraph({ text: "OSPF", heading: HeadingLevel.HEADING_4 }));
    children.push(p(`Router ID: ${dev.ospf.router_id || "(no configurado)"}`));
    if (dev.ospf.networks.length) {
      children.push(dataTable(["Red", "Área"], dev.ospf.networks.map((nw) => [nw.prefix, nw.area]), [4500, 4500]));
    }
    if (isRealOspf(dev.ospf)) {
      children.push(p("Estado de neighbors (información en vivo, no incluida en el .conf):"));
      children.push(...evidence(`ospf_neighbor_${hostname}`, `"get router info ospf neighbor" — ${hostname}`));
    } else {
      children.push(p("Bloque OSPF por defecto detectado (sin router-id, áreas ni redes configuradas) — el protocolo no está en uso. No aplica captura de neighbors."));
    }
  }

  children.push(h3("Políticas de Firewall"));
  const byVdom = {};
  dev.firewall_policies.forEach((pol) => {
    const vd = "root"; // el parser no distingue vdom por política en modo single-vdom
    byVdom[vd] = byVdom[vd] || [];
    byVdom[vd].push(pol);
  });
  Object.entries(byVdom).forEach(([vd, pols]) => {
    children.push(new Paragraph({ text: `VDOM: ${vd}`, heading: HeadingLevel.HEADING_4 }));
    children.push(dataTable(
      ["ID", "Nombre", "Origen", "Destino", "Servicio", "Acción", "NAT", "UTM"],
      pols.map((pol) => [pol.id, pol.name, `${pol.srcintf} / ${pol.srcaddr}`, `${pol.dstintf} / ${pol.dstaddr}`, pol.service, pol.action, pol.nat, pol.utm_status]),
      [500, 1600, 1900, 1900, 1100, 800, 700, 600],
    ));
  });

  const webUsed = usageMap(dev.firewall_policies, "webfilter_profile");
  const appUsed = usageMap(dev.firewall_policies, "application_list");
  const ipsUsed = usageMap(dev.firewall_policies, "ips_sensor");
  const avUsed = usageMap(dev.firewall_policies, "av_profile");

  children.push(h3("Filtro Web"));
  children.push(p(`Se cuenta con ${dev.webfilter_profiles.length} perfil(es) de filtrado web configurado(s).`));
  children.push(dataTable(
    ["Perfil", "Comentario", "¿En uso en una política?"],
    dev.webfilter_profiles.map((wf) => [wf.name, wf.comment, webUsed.has(wf.name) ? "Sí" : "No"]),
    [2500, 4500, 2000],
  ));

  children.push(h3("Filtro de Aplicaciones"));
  children.push(p(`Se cuenta con ${dev.application_profiles.length} perfil(es) de filtrado de aplicaciones configurado(s).`));
  children.push(dataTable(
    ["Perfil", "Comentario", "¿En uso en una política?"],
    dev.application_profiles.map((ap) => [ap.name, ap.comment, appUsed.has(ap.name) ? "Sí" : "No"]),
    [2500, 4500, 2000],
  ));

  children.push(h3("Filtro de IPS"));
  children.push(p(`Se cuenta con ${dev.ips_sensors.length} perfil(es) de IPS configurado(s).`));
  children.push(dataTable(
    ["Perfil", "Comentario", "¿En uso en una política?"],
    dev.ips_sensors.map((ip) => [ip.name, ip.comment, ipsUsed.has(ip.name) ? "Sí" : "No"]),
    [2500, 4500, 2000],
  ));

  children.push(h3("Filtro de Antivirus"));
  children.push(p(`Se cuenta con ${dev.antivirus_profiles.length} perfil(es) de antivirus configurado(s).`));
  children.push(dataTable(
    ["Perfil", "Comentario", "¿En uso en una política?"],
    dev.antivirus_profiles.map((av) => [av.name, av.comment, avUsed.has(av.name) ? "Sí" : "No"]),
    [2500, 4500, 2000],
  ));

  children.push(h3("HA"));
  if (dev.ha) {
    const haRows = Object.entries(dev.ha).map(([k, v]) => [k, v]);
    children.push(dataTable(["Parámetro", "Valor"], haRows, [4500, 4500]));
    if (isRealHa(dev.ha)) {
      children.push(p("Estado de sincronización en vivo (información no incluida en el .conf):"));
      children.push(...evidence(`ha_live_${hostname}`, `estado de HA en vivo — ${hostname}`));
    } else {
      children.push(p("Configuración por defecto detectada (sin group-id/hbdev/modo real configurado) — el equipo opera en modo standalone. No aplica captura de estado de HA en vivo."));
    }
  } else {
    children.push(p("No se encontró configuración de HA en el .conf (equipo standalone)."));
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));
});

// Accesos a gestión
children.push(h1("Accesos a Gestión Fortigate"));
firewalls.forEach(([hostname, dev]) => {
  children.push(h3(hostname));
  if (dev.admins.length) {
    children.push(dataTable(
      ["Usuario", "Perfil de acceso", "VDOM"],
      dev.admins.map((a) => [a.name, a.accprofile, a.vdom]),
      [3000, 3000, 3000],
    ));
  }
  children.push(p("Contraseñas: no se incluyen en este informe por seguridad — entregar por canal separado."));
});
children.push(new Paragraph({ children: [new PageBreak()] }));

// FortiAnalyzer
children.push(h1("Integración a FortiAnalyzer"));
if (analyzers.length > 0) {
  children.push(...evidence("faz_logs", "envío de logs al FAZ (Log Settings > FortiAnalyzer)"));
} else {
  children.push(p("No se encontró FortiAnalyzer asociado a este proyecto: no hay .conf de FAZ ni integración de logs configurada en el equipo."));
}

analyzers.forEach(([hostname, dev]) => {
  children.push(h2(`FortiAnalyzer (${hostname})`));
  const faz = metadata.faz || {};
  children.push(kvTable(
    [
      ["MODELO", faz.modelo || ""],
      ["VERSIÓN", faz.version || ""],
      ["CPU", faz.cpu || ""],
      ["MEMORIA", faz.memoria || ""],
      ["DISCO", faz.disco || ""],
    ],
    [3500, 5500],
  ));

  children.push(h3("Interface"));
  const fazReferencedSet = new Set(dev.referenced_interfaces || []);
  children.push(dataTable(
    ["Interfaz", "IP", "Rol"],
    dev.interfaces.filter((f) => isActiveInterface(f, fazReferencedSet)).map((f) => [f.name, f.ip, f.role]),
    [3000, 3000, 3000],
  ));

  if (dev.static_routes.length) {
    children.push(h3("Enrutamiento"));
    children.push(dataTable(
      ["Destino", "Gateway", "Interfaz"],
      dev.static_routes.map((r) => [r.dst, r.gateway, r.device]),
      [3000, 3000, 3000],
    ));
  }

  children.push(h3("Administradores"));
  if (dev.admins.length) {
    children.push(dataTable(["Usuario", "Perfil"], dev.admins.map((a) => [a.name, a.accprofile]), [4500, 4500]));
  }

  children.push(h3("Device Manager"));
  children.push(manualPlaceholder(`captura de Device Manager — ${hostname}`));
  children.push(h3("Reportes FAZ"));
  children.push(manualPlaceholder(`captura de reportes/templates exportados — ${hostname}`));
});
children.push(new Paragraph({ children: [new PageBreak()] }));

// Logs / gráficas / reportes
children.push(h1("Logs / Gráficas / Reportes"));
firewalls.concat(analyzers).forEach(([hostname]) => {
  children.push(h2(hostname));

  children.push(h3("CPU"));
  children.push(p(`Uso de CPU en tiempo real del equipo ${hostname}, medido en el dashboard (ventana de 1 minuto).`));
  children.push(...evidence(`cpu_${hostname}`, `uso de CPU — ${hostname}`));

  children.push(h3("Memoria"));
  children.push(p(`Uso de memoria RAM en tiempo real del equipo ${hostname}, medido en el dashboard (ventana de 1 minuto).`));
  children.push(...evidence(`memoria_${hostname}`, `uso de memoria — ${hostname}`));

  children.push(h3("Sesiones"));
  children.push(p(`Sesiones de firewall activas en tiempo real en ${hostname} (SPU/nTurbo desglosado).`));
  children.push(...evidence(`sesiones_${hostname}`, `sesiones activas — ${hostname}`));
});
children.push(new Paragraph({ children: [new PageBreak()] }));

// Conclusiones
children.push(h1("Conclusiones y Recomendaciones"));
const conclusiones = (metadata.conclusiones && metadata.conclusiones.length)
  ? metadata.conclusiones
  : [
      metadata.tipo_proyecto === "migracion"
        ? "Se cumplió con la migración de configuración a los nuevos equipos."
        : "Se cumplió con la implementación de los equipos desde cero.",
      "(completar con hallazgos y pendientes específicos del proyecto)",
    ];
conclusiones.forEach((c) => children.push(bullet(c)));

// Legal footer -- full text as used in delivered reports (not a one-line summary).
const empresaLegal = metadata.empresa || "SUPRA";
children.push(new Paragraph({ children: [new PageBreak()] }));
children.push(p(`${empresaLegal}. Todos los derechos reservados.`, { size: 20 }));
children.push(prose(
  `La información contenida en este documento es propiedad y está sujeta a todas las leyes de derechos de autor, patentes y otras de protección de propiedad intelectual, así como cualquier acuerdo específico de protección de los derechos de ${empresaLegal} en la información arriba mencionada. Ni este documento ni la información contenida en este documento puede ser copiado, reproducido o cedido a terceros, en todo o en parte, sin el consentimiento expreso, previo y por escrito de ${empresaLegal}. Además, cualquier uso de este documento o la información contenida en este documento para fines distintos de aquellos para los que se dio a conocer está estrictamente prohibido.`,
  { size: 20 },
));
children.push(prose(
  `La información proporcionada por ${empresaLegal} se cree que es precisa y fiable. Sin embargo, ${empresaLegal} no asume ninguna responsabilidad por los derechos de terceros que puedan verse afectados en modo alguno por el uso de los mismos.`,
  { size: 20 },
));
children.push(prose(
  `Cualquier representación(es) en este documento sobre el rendimiento de los productos provistos por ${empresaLegal} son sólo para fines informativos y no son garantías de rendimiento futuro, ya sea expresa o implícita. La garantía de ${empresaLegal} es limitada, establecida en el contrato de compraventa o la forma de confirmación de pedido, es la única garantía ofrecida por ${empresaLegal} en relación con ello.`,
  { size: 20 },
));
children.push(prose(
  `Este documento puede contener errores, omisiones o errores tipográficos, sin garantía se otorga, ni asume responsabilidad alguna en relación con ello a menos que sea llevado a cabo en los contratos de venta o la confirmación del pedido. La información contenida en este documento se actualiza periódicamente y los cambios se incorporarán en ediciones posteriores. Si usted ha encontrado un error, por favor notifique a ${empresaLegal}. Todas las especificaciones están sujetas a cambios sin previo aviso.`,
  { size: 20 },
));

// Now that every h1/h2/h3 call has run, build the real TOC with cached
// entries (title + level; no page number -- Word recomputes those itself via
// features.updateFields, but LibreOffice/Google Docs at least show the titles
// instead of a blank "Contenido" page).
children[tocIndex] = new TableOfContents("Contenido", {
  hyperlink: true,
  headingStyleRange: "1-3",
  cachedEntries: tocHeadings.map((h) => ({ title: h.title, level: h.level })),
});

// ---------- write doc ----------

const doc = new Document({
  creator: metadata.empresa || "SUPRA",
  title: metadata.nombre_proyecto || tituloInforme,
  features: { updateFields: true }, // forces Word to recalculate the TOC field on open
  styles: {
    default: {
      document: { run: { font: FONT, size: 22 } },
      // Reference report headings are plain black, bold, uppercase -- allCaps
      // keeps the underlying text (and TOC entries) in normal case while
      // rendering uppercase, so search/copy-paste isn't shouting.
      heading1: { run: { font: FONT, size: 28, bold: true, color: HEADING_COLOR, allCaps: true } },
      heading2: { run: { font: FONT, size: 24, bold: true, color: HEADING_COLOR, allCaps: true } },
      heading3: { run: { font: FONT, size: 22, bold: true, color: HEADING_COLOR, allCaps: true } },
    },
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W_TW, height: PAGE_H_TW },
          margin: { top: 0, bottom: 0, left: 0, right: 0, header: 0, footer: 0 },
        },
      },
      children: coverChildren,
    },
    {
      properties: {
        page: {
          size: { width: PAGE_W_TW, height: PAGE_H_TW },
          margin: { top: 1700, bottom: 1200, left: 1300, right: 1300, header: 500, footer: 500 },
        },
      },
      headers: { default: buildContentHeader() },
      footers: { default: buildContentFooter() },
      children,
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outPath, buf);
  console.error(`OK: informe generado -> ${outPath}`);
});
