# fortigate-report-skill

Skill de agente (opencode, Claude Code y compatibles) para **generar el informe
de entrega de proyectos de firewalls Fortinet** (FortiGate / FortiAnalyzer), de
punta a punta, incluyendo la toma de capturas reales del equipo con Playwright.

A partir de uno o más archivos `.conf`, el skill:

- Extrae interfaces, rutas, OSPF, políticas de firewall, perfiles de seguridad
  (web / app / IPS / AV), HA y administradores — sin capturas de pantalla.
- Dibuja un diagrama de topología agrupado por zona (Graphviz).
- **Toma las capturas "en vivo"** que no existen en el `.conf` (licencia, HA,
  CPU / memoria / sesiones) con Playwright headless, navegando a la IP de gestión
  que el usuario indique.
- Genera el `.docx` final con la identidad de marca SUPRA (portada, watermark,
  header / footer), en un estilo calibrado contra un informe real entregado.

El flujo paso a paso que sigue el agente está en [`SKILL.md`](SKILL.md). Este
README es para **preparar la máquina** y para quien vaya a **modificar** el skill.

---

## Instalación rápida (Windows)

Un comando deja todo listo: el skill donde el agente lo encuentra, Playwright con
su Chromium, python-docx, Graphviz, y el archivo de credenciales abierto para que
lo llenes una sola vez.

```powershell
irm https://raw.githubusercontent.com/supra-soc/supra-fortigate-skills/master/install.ps1 | iex
```

Si prefieres leer el script antes de ejecutarlo — que es lo razonable con
cualquier instalador de internet:

```powershell
git clone https://github.com/supra-soc/supra-fortigate-skills.git
cd supra-fortigate-skills
.\install.ps1
```

Requisitos previos que el script **no** instala: Node.js 18+, Python 3.9+ y git.
Si falta alguno, te lo dice y para.

### Dónde queda instalado, y por qué importa

El skill se instala en `%USERPROFILE%\.claude\skills\fortigate-report`. Esa ruta
la leen **opencode y Claude Code**, así que una sola instalación sirve para los
dos.

El nombre de la carpeta tiene que ser exactamente **`fortigate-report`** — el
campo `name:` del `SKILL.md`. Si clonas el repo a mano te queda
`supra-fortigate-skills`, que es el nombre del repositorio y no el del skill, y
**el agente no lo encuentra**: el cargador de skills falla y el modelo termina
leyendo el `SKILL.md` como si fuera un archivo cualquiera. El instalador existe
en buena parte para evitar ese error.

Rutas alternativas válidas, si prefieres otra:

| Ruta | La lee |
|---|---|
| `~\.claude\skills\fortigate-report` (por defecto) | opencode y Claude Code |
| `~\.config\opencode\skills\fortigate-report` | opencode |
| `~\.agents\skills\fortigate-report` | opencode |
| `.opencode\skills\fortigate-report` (en un proyecto) | opencode, solo ese proyecto |

Se cambia con `.\install.ps1 -SkillsDir <ruta>`.

### Después de instalar

Pide el informe en **un solo mensaje**. Las credenciales ya están en el archivo,
así que no las escribas en el chat:

```
Genera el informe de entrega con C:
uta\al\equipo.conf
Es una migración. Cliente Acme, contacto Juan Pérez, sede Lima,
ingeniero Ana Torres, del 01/08/2026 al 08/08/2026.
Toma las capturas en https://10.10.200.100:9443
```

---

## Requisitos

Playwright es un requisito duro: **el skill asume en todo momento que Playwright
y su Chromium ya están instalados** y nunca intenta instalarlos por su cuenta. Si
falta, las capturas se omiten y el informe sale con recuadros `[ PEGAR AQUÍ ]`.

| Herramienta | Para qué | Instalación |
|---|---|---|
| Node.js 18+ y npm | `build_report.js`, `capture_playwright.js`, `credentials.js` | https://nodejs.org |
| **Playwright + Chromium** | **Requisito. Capturas reales de la GUI** | `npm install` + `npx playwright install chromium` |
| Python 3.9+ | Parsear el `.conf` y dibujar la topología | https://python.org |
| `python-docx` | Validar que el `.docx` abre sin corrupción | `pip install python-docx` |
| Graphviz (`dot`) en el PATH | Diagrama de topología | `winget install Graphviz.Graphviz` · `apt install graphviz` · `brew install graphviz` |
| LibreOffice o Word | Opcional: revisar el `.docx` en PDF | — |

---

## Instalación

### 1. Dependencias de Node (incluye Playwright)

Desde la raíz del repositorio:

```bash
npm install
npx playwright install chromium
```

O en un solo comando:

```bash
npm run setup
```

`npm install` instala `playwright` y `docx` según el `package.json`.
`npx playwright install chromium` descarga el binario del navegador, que es un
paso aparte y **obligatorio**: sin él Playwright está instalado pero no tiene qué
lanzar.

> Los scripts resuelven `docx` y `playwright` desde el `node_modules` de la raíz
> del repo. No instales nada dentro de `scripts/`, y **corre siempre los comandos
> desde la raíz**.

### 2. Dependencias de Python

```bash
pip install python-docx
```

### 3. Graphviz

Instálalo y **asegúrate de que `dot` esté en el PATH**:

```bash
winget install Graphviz.Graphviz
```

En Windows el instalador no siempre agrega Graphviz al PATH. Si `dot -V` falla,
añade `C:\Program Files\Graphviz\bin` al PATH de usuario y abre una terminal nueva.

### 4. Verificar que todo está listo

```bash
node -e "require('docx'); require('playwright'); console.log('Node deps OK')"
node -e "const{chromium}=require('playwright');const fs=require('fs');console.log('Chromium OK:',fs.existsSync(chromium.executablePath()))"
python -c "import docx; print('python-docx OK')"
dot -V
```

Los cuatro tienen que pasar antes de usar el skill.

---

## Credenciales

Las contraseñas **nunca** se pasan por el chat, por argumentos de línea de
comandos (quedarían en el historial del shell y en la lista de procesos) ni se
escriben en el código. Van en un archivo local que el agente crea vacío y el
humano llena.

```bash
node scripts/capture/credentials.js --init     # crea el archivo y muestra su ruta
node scripts/capture/credentials.js --check    # valida formato, sin mostrar contraseñas
node scripts/capture/credentials.js --wipe     # lo deja en blanco otra vez
```

También disponibles como `npm run creds:init`, `creds:check` y `creds:wipe`.

El archivo por defecto es `credentials.txt` en la raíz del repo, y está en
`.gitignore`. Formato: **un bloque por equipo, separados por una línea en
blanco**, cuatro líneas cada uno.

```
# FGT600-master
https://10.10.200.100:9443
usuario
contrasena

# FGT600-slave
https://10.10.200.101:9443
usuario
contrasena

# FAZ-CLIENTE
https://10.10.200.50:443
admin_faz
otra_contrasena
```

El `# nombre-del-equipo` es lo que empareja con el `--host` de
`capture_playwright.js`, así que tiene que coincidir. Las líneas que empiezan por
`#` dentro de la plantilla se ignoran, y un bloque cuyas líneas sean todas
comentario nunca se toma como credencial.

**El archivo persiste entre informes a propósito.** Lo llenas una vez al instalar
y a partir de ahí cada informe se pide en un solo mensaje, sin que las
contraseñas pasen nunca por el chat del agente. El skill no lo vacía solo; si
quieres borrarlo, `node scripts/capture/credentials.js --wipe`.

Esa persistencia es una decisión con contrapartida: la contraseña de admin queda
en tu disco entre proyectos. Por eso la recomendación de la cuenta de solo
lectura que viene abajo no es cosmética.

Recomendación operativa: usa una **cuenta de solo lectura** (`prof_admin` con
permisos de lectura) para las capturas. Las capturas de licencia, HA y gráficas no
necesitan permisos de escritura, y así una fuga del archivo no entrega el control
del perímetro del cliente.

Para automatizaciones sin humano, `FG_USER` y `FG_PASS` siguen funcionando como
variables de entorno y tienen precedencia sobre el archivo.

---

## Estructura del repositorio

```
fortigate-report-skill/
├── SKILL.md                        # Runbook del informe (lo que ejecuta el agente)
├── README.md                       # Este archivo: instalación y mantenimiento
├── install.ps1                     # Instalador de un comando (Windows)
├── reference/estructura_informe.md # Orden de secciones del informe de referencia
├── scripts/
│   ├── parse_fortigate_conf.py     # Parser .conf FortiOS/FAZ → JSON
│   ├── generate_topology.py        # Diagrama de topología (Graphviz)
│   ├── build_report.js             # Genera el .docx (paquete `docx`)
│   ├── check_report.py             # Verifica el .docx y lista lo que queda pendiente
│   ├── metadata.example.json       # Plantilla de metadata de intake
│   ├── assets/                     # Identidad de marca SUPRA (portada / watermark)
│   └── capture/
│       ├── capture_playwright.js   # Capturas en vivo vía Playwright
│       └── credentials.js          # Crear / validar / borrar credentials.txt
├── credentials.txt                 # GITIGNORED. Lo crea `credentials.js --init`
├── package.json
└── .gitignore
```

---

## Uso rápido (manual, sin agente)

Las credenciales se llenan una vez (`install.ps1` ya te abrió el archivo); estos
pasos asumen que `credentials.txt` ya está listo, así que las capturas van antes
que nada — son lo único que exige alcance de red, y conviene fallar rápido ahí
si el equipo no responde.

```bash
# 1. Confirmar que las credenciales estan cargadas
node scripts/capture/credentials.js --check

# 2. Capturas (la URL sale del archivo de credenciales)
node scripts/capture/capture_playwright.js --host FGT-EJEMPLO01 --out work/capturas

# 3. Parsear el/los .conf
python scripts/parse_fortigate_conf.py equipo.conf -o work/parsed.json

# 4. Topología
python scripts/generate_topology.py work/parsed.json -o work/topology.png

# 5. Generar el .docx  (metadata.json se escribe a mano; ver metadata.example.json)
node scripts/build_report.js --metadata work/metadata.json --parsed work/parsed.json \
  --topology work/topology.png --captures work/captures.json --out work/informe.docx

# 6. Validar el .docx y listar lo que queda pendiente
python scripts/check_report.py work/informe.docx --metadata work/metadata.json
```

El archivo de credenciales no se borra al final: queda listo para el siguiente
informe. Bórralo tú si lo necesitas: `node scripts/capture/credentials.js --wipe`.

---

## Notas para quien modifique el skill

### `build_report.js` — errores ya cometidos, no reintroducir

- **No uses una imagen de fondo a página completa para el header de contenido.**
  Esa plantilla es solo para la portada (`supra_cover_bg.png`). El header de
  contenido es una tabla de texto (`buildContentHeader()`) más la franja angosta
  del wordmark (`supra_watermark_narrow.png`).
- **No uses frames absolutos de Word** (`paragraph.frame`, `w:framePr`) para
  poner texto sobre imágenes: Word rechaza el archivo como corrupto. La portada
  usa párrafos con `spacing.before` sobre la imagen flotante `behindDocument`,
  que es lo estándar.

### Estilo visual

La tipografía, tamaños, colores, mayúsculas en títulos, formato de conclusiones y
el aviso legal están calibrados contra un informe real entregado. Antes de tocar
estilos, revisa el informe de referencia: "se ve mejor" no es lo mismo que
"coincide con la plantilla". Puntos verificados: fuente Arial, headings en negro
mayúscula, header de tabla `#4E5784`, sin rayado alterno, conclusiones con guion,
aviso legal de cinco párrafos completo.

### `capture_playwright.js` — acoplamiento frágil

El script engancha selectores internos de la GUI de FortiOS
(`NU-DASHBOARD-WIDGET`, `f-fortiguard-info`, `router-outlet-container`) y rutas
como `/ng/system/fortiguard` y `/ng/system/ha/monitor`. Fortinet no garantiza que
eso sea estable entre versiones, así que **es normal que se rompa al cambiar de
firmware**. El diseño lo absorbe: una captura que falla no se agrega a
`captures.json` y su sección cae al recuadro manual.

Si empieza a fallar, corre con `--headed` para ver la sesión, y revisa
`dashboard_body.txt` en la carpeta de salida, que guarda el texto de la página
tras el login para diagnosticar pantallas nuevas.

Variantes de login ya contempladas: banner "Accept" del certificado,
`#username` / `#secretkey`, y el prompt "Login Read-Only" de equipos gestionados
por FortiManager.

### `check_report.py` — por qué existe

Los recuadros `[ PEGAR AQUÍ ]` del informe viven **dentro de celdas de tabla**.
`Document.paragraphs` de python-docx no recorre las tablas, así que contarlos con
un one-liner sobre los párrafos devuelve `0` aunque haya siete pendientes. Este
script recorre párrafos y celdas, y de paso valida que el `.docx` no esté
corrupto y lista los campos de `metadata.json` que quedaron en `(completar ...)`.
Sale con código 1 solo si el documento no abre.

### Limitación conocida: OSPF declarado pero vacío

Si el `.conf` trae un bloque `config router ospf` que solo tiene `redistribute`
por defecto (sin router-id, áreas ni redes), el parser igual lo marca `ospf=sí` y
el informe imprime la subsección con "Router ID: (no configurado)" más un recuadro
de captura de neighbors. Es ruido en el entregable y hay que borrarlo a mano.

### Limitación conocida: multi-VDOM

El parser no separa VDOMs dentro de un mismo archivo. Para clientes con VDOMs,
exporta un `.conf` por VDOM.

---

## Licencia

Uso interno de SUPRA.
