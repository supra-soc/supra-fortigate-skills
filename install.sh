#!/usr/bin/env bash
# install.sh — Instala el skill fortigate-report y todas sus dependencias en
# macOS o Linux. Equivalente a install.ps1 (Windows): mismo destino, misma
# logica de "limpiar y copiar" (nunca renombrar-en-el-lugar), mismas
# dependencias verificadas al final.
#
# Uso:
#   ./install.sh                       (desde una copia local del repo)
#   curl -fsSL .../install.sh | bash   (descarga y clona)
#
# Variables de entorno para personalizar (equivalentes a los parametros de
# install.ps1):
#   SKILLS_DIR          Carpeta de skills destino. Default: ~/.claude/skills
#   REPO                URL del repositorio a clonar si no hay copia local.
#   REF                 Rama/tag a clonar. Default: master
#   SKIP_CREDENTIALS=1  No crear/abrir credentials.txt al final.
set -uo pipefail
# NO se usa "set -e": igual que install.ps1 con $ErrorActionPreference, cada
# paso critico se verifica con su propio codigo de salida ($?), no se
# depende de que un comando fallido aborte el script entero -- un `grep`
# o `curl` que no encuentra nada no debe tumbar la instalacion completa.

SKILL_NAME="fortigate-report"
SKILLS_DIR="${SKILLS_DIR:-$HOME/.claude/skills}"
REPO="${REPO:-https://github.com/supra-soc/supra-fortigate-skills.git}"
REF="${REF:-master}"
SKIP_CREDENTIALS="${SKIP_CREDENTIALS:-0}"

# ---------------------------------------------------------------- salida
if [ -t 1 ]; then
  C_CYAN='\033[36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_GRAY='\033[90m'; C_RESET='\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_GRAY=''; C_RESET=''
fi
step()  { printf "\n${C_CYAN}==> %s${C_RESET}\n" "$1"; }
ok()    { printf "    ${C_GREEN}OK${C_RESET}   %s\n" "$1"; }
warn()  { printf "    ${C_YELLOW}!!${C_RESET}   %s\n" "$1"; }
bad()   { printf "    ${C_RED}X${C_RESET}    %s\n" "$1"; }

printf "\n  ============================================================\n"
printf "   fortigate-report  ::  instalador para macOS / Linux\n"
printf "  ============================================================\n"

# ---------------------------------------------------------- requisitos
step "Comprobando requisitos del sistema"

OS="$(uname -s)"
PYTHON=""
for cand in python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then
    if "$cand" -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' >/dev/null 2>&1; then
      PYTHON="$cand"; break
    fi
  fi
done

faltan=0
command -v git >/dev/null 2>&1 || { bad "git no encontrado -> https://git-scm.com/downloads"; faltan=1; }
command -v node >/dev/null 2>&1 || { bad "Node.js no encontrado -> https://nodejs.org"; faltan=1; }
command -v npm  >/dev/null 2>&1 || { bad "npm no encontrado -> viene con Node.js"; faltan=1; }
[ -n "$PYTHON" ] || { bad "Python 3 no encontrado -> https://python.org"; faltan=1; }

if [ "$faltan" = "1" ]; then
  printf "\n  Instala lo que falta arriba, abre una terminal NUEVA y reintenta.\n\n"
  exit 1
fi

ok "git    $(git --version | sed 's/git version //')"
ok "node   $(node -v)"
ok "npm    $(npm -v)"
ok "python $($PYTHON --version 2>&1 | sed 's/Python //')  (comando: $PYTHON)"

BREW="$(command -v brew || true)"
APT="$(command -v apt-get || true)"
[ "$OS" = "Darwin" ] && [ -z "$BREW" ] && warn "Homebrew no esta: Graphviz habra que instalarlo a mano (https://brew.sh)"

# ------------------------------------------------------------ obtener fuente
step "Obteniendo el skill"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
LOCAL_SRC=""
if [ -f "$SCRIPT_DIR/SKILL.md" ]; then
  LOCAL_SRC="$SCRIPT_DIR"
  ok "usando la copia local: $LOCAL_SRC"
fi

TMP_CLONE=""
if [ -z "$LOCAL_SRC" ]; then
  TMP_CLONE="$(mktemp -d 2>/dev/null || echo "/tmp/fgr-$$")"
  echo "    clonando $REPO ($REF)..."
  git clone --depth 1 --branch "$REF" "$REPO" "$TMP_CLONE" >/dev/null 2>&1
  if [ ! -f "$TMP_CLONE/SKILL.md" ]; then
    bad "El clon fallo o el repositorio no trae SKILL.md."
    exit 1
  fi
  LOCAL_SRC="$TMP_CLONE"
  ok "repositorio clonado"
fi

# -------------------------------------------------------------- instalar
step "Instalando el skill"

DEST="$SKILLS_DIR/$SKILL_NAME"
mkdir -p "$SKILLS_DIR"

# Rutas REALES (resueltas, sin ".."/symlinks) para comparar de forma
# confiable -- ver el aviso de seguridad mas abajo sobre por que esto
# importa tanto.
LOCAL_SRC_REAL="$(cd "$LOCAL_SRC" >/dev/null 2>&1 && pwd -P)"
DEST_PARENT_REAL="$(cd "$SKILLS_DIR" >/dev/null 2>&1 && pwd -P)"
DEST_REAL="$DEST_PARENT_REAL/$SKILL_NAME"

if [ -n "$LOCAL_SRC_REAL" ] && [ "$LOCAL_SRC_REAL" = "$DEST_REAL" ]; then
  # SEGURIDAD CRITICA: si la copia local que se esta usando como fuente ES
  # el propio destino (alguien corrio "./install.sh" desde DENTRO de
  # ~/.claude/skills/fortigate-report sin cambiar SKILLS_DIR, que es
  # ademas el escenario mas comun de "quiero reinstalar/actualizar"), un
  # simple "rm -rf $DEST && copiar desde $LOCAL_SRC" BORRA LA FUENTE ANTES
  # DE COPIARLA -- el resultado es una carpeta casi vacia, no una
  # reinstalacion limpia. Esto paso de verdad probando este script: destruyo
  # una instalacion real por completo (quedaron solo credentials.txt y dos
  # PNG, que es literalmente todo lo que el paso de "preservar" alcanzo a
  # respaldar en memoria antes del rm -rf).
  #
  # Si fuente y destino son la misma carpeta, no hay nada que copiar --  los
  # archivos ya estan exactamente donde tienen que estar. Se saltea todo el
  # bloque de copia y se sigue directo a dependencias.
  ok "la copia local YA ES el destino ($DEST_REAL) -- nada que copiar, se salta al siguiente paso"
else
  # Aviso de instalaciones duplicadas: opencode escanea ~/.claude/skills Y
  # ~/.agents/skills a la vez. Visto en la practica en Mac: una copia vieja en
  # ~/.agents/skills convivio con una nueva en la misma ruta o se "respaldo"
  # renombrandola ahi mismo, y la carpeta renombrada aparecio como un skill
  # DISTINTO en la lista de opencode (registra cualquier carpeta con un
  # SKILL.md, sin importar el nombre). Este script solo instala en $DEST -- si
  # hay algo en la otra ruta, se avisa pero NO se toca sin que el usuario lo
  # pida, porque no es la carpeta que este script declaro como destino.
  OTHER_AGENTS_DIR="$HOME/.agents/skills/$SKILL_NAME"
  if [ "$DEST_REAL" != "$OTHER_AGENTS_DIR" ] && [ -e "$OTHER_AGENTS_DIR" ]; then
    warn "Tambien existe una instalacion en $OTHER_AGENTS_DIR (opencode lee esa ruta tambien)."
    warn "Para evitar un skill duplicado, bórrala despues de confirmar que esta instalacion funciona:"
    warn "  rm -rf \"$OTHER_AGENTS_DIR\""
  fi

  # Se conservan credenciales y assets de marca si ya existian en el destino,
  # igual que install.ps1. Se leen ANTES de borrar el destino.
  PRESERVE_FILES="scripts/assets/supra_cover_bg.png scripts/assets/supra_watermark_narrow.png credentials.txt"
  BACKUP_DIR="$(mktemp -d 2>/dev/null || echo "/tmp/fgr-backup-$$")"
  for rel in $PRESERVE_FILES; do
    if [ -f "$DEST/$rel" ]; then
      mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
      cp "$DEST/$rel" "$BACKUP_DIR/$rel"
    fi
  done

  # El destino se borra por completo antes de copiar -- no se mezcla ni se
  # renombra-en-el-lugar (eso es justo lo que causo el skill duplicado en Mac).
  # Tambien evita que sobreviva un scripts/node_modules de una version anterior
  # que Node resolveria ANTES que el node_modules de la raiz nueva.
  # (Seguro llegar aqui: ya se confirmo arriba que DEST_REAL != LOCAL_SRC_REAL.)
  [ -d "$DEST" ] && rm -rf "$DEST"
  mkdir -p "$DEST"

  # Copia sin .git ni node_modules: .git vivo dentro del skill no aporta nada
  # (el repo real vive en GitHub) y puede confundir a quien corra "git" desde
  # ahi pensando que esta en su propio proyecto.
  ( cd "$LOCAL_SRC" && tar -cf - --exclude='.git' --exclude='node_modules' --exclude='credentials.txt' . ) | ( cd "$DEST" && tar -xf - )

  for rel in $PRESERVE_FILES; do
    if [ -f "$BACKUP_DIR/$rel" ]; then
      mkdir -p "$DEST/$(dirname "$rel")"
      cp "$BACKUP_DIR/$rel" "$DEST/$rel"
      ok "conservado: $rel"
    fi
  done
  rm -rf "$BACKUP_DIR"

  ok "skill en $DEST"
  printf "         ${C_GRAY}(esa ruta la leen opencode y Claude Code)${C_RESET}\n"
fi

[ -n "$TMP_CLONE" ] && rm -rf "$TMP_CLONE"

# ------------------------------------------------------------ deps de Node
step "Instalando dependencias de Node (docx + Playwright)"
(
  cd "$DEST" || exit 1
  npm install --no-audit --no-fund >/dev/null 2>&1
  if [ $? -ne 0 ]; then bad "npm install fallo"; exit 1; fi
  ok "docx y playwright instalados"

  echo "    descargando Chromium (puede tardar un par de minutos)..."
  npx playwright install chromium >/dev/null 2>&1
  ok "Chromium descargado"
) || exit 1

# ---------------------------------------------------------- deps de Python
step "Instalando dependencias de Python"
"$PYTHON" -m pip install --quiet --disable-pip-version-check --user python-docx >/dev/null 2>&1
ok "python-docx instalado"

# -------------------------------------------------------------- Graphviz
step "Instalando Graphviz"
if command -v dot >/dev/null 2>&1; then
  ok "graphviz ya estaba: $(dot -V 2>&1)"
elif [ -n "$BREW" ]; then
  "$BREW" install graphviz >/dev/null 2>&1
  if command -v dot >/dev/null 2>&1; then ok "graphviz $(dot -V 2>&1)"; else warn "brew install graphviz no dejo 'dot' en el PATH"; fi
elif [ -n "$APT" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get install -y graphviz >/dev/null 2>&1
  else
    apt-get install -y graphviz >/dev/null 2>&1
  fi
  if command -v dot >/dev/null 2>&1; then ok "graphviz $(dot -V 2>&1)"; else warn "apt-get install graphviz no dejo 'dot' en el PATH"; fi
else
  warn "No se encontro brew ni apt-get. Instala Graphviz a mano: https://graphviz.org/download/"
  warn "Los informes saldran sin diagrama de topologia hasta entonces."
fi

# ------------------------------------------------------------ verificacion
step "Verificando la instalacion"
fallos=0
(
  cd "$DEST" || exit 1
  node -e "require('docx');require('playwright')" >/dev/null 2>&1
  if [ $? -eq 0 ]; then ok "modulos docx y playwright"; else bad "faltan modulos de Node"; fallos=1; fi

  chromium_ok="$(node -e "const{chromium}=require('playwright');const fs=require('fs');process.stdout.write(fs.existsSync(chromium.executablePath())?'1':'0')" 2>/dev/null)"
  if [ "$chromium_ok" = "1" ]; then ok "binario de Chromium presente"; else bad "Chromium no descargado"; fallos=1; fi

  "$PYTHON" -c "import docx" >/dev/null 2>&1
  if [ $? -eq 0 ]; then ok "python-docx"; else bad "python-docx"; fallos=1; fi

  "$PYTHON" scripts/parse_fortigate_conf.py --help >/dev/null 2>&1
  if [ $? -eq 0 ]; then ok "scripts del skill ejecutables"; else bad "los scripts del skill no corren"; fallos=1; fi
  exit "$fallos"
)
fallos=$?

# ------------------------------------------------------------ credenciales
if [ "$SKIP_CREDENTIALS" != "1" ]; then
  step "Credenciales de captura"
  ( cd "$DEST" && node scripts/capture/credentials.js --init )

  CRED_FILE="$DEST/credentials.txt"
  printf "\n    ${C_YELLOW}Este es el paso que hace que luego el informe salga de un tiron.${C_RESET}\n"
  printf "    ${C_YELLOW}Llena el archivo AHORA con un bloque por equipo. Las contrasenas${C_RESET}\n"
  printf "    ${C_YELLOW}se quedan en tu disco y nunca pasan por el chat del agente.${C_RESET}\n\n"
  if [ "$OS" = "Darwin" ]; then
    open -e "$CRED_FILE" >/dev/null 2>&1 && ok "abierto en TextEdit: $CRED_FILE" || warn "abrelo a mano: $CRED_FILE"
  else
    ok "abrelo a mano en tu editor: $CRED_FILE"
  fi
fi

# ------------------------------------------------------------------ cierre
printf "\n  ============================================================\n"
if [ "$fallos" = "0" ]; then
  printf "   ${C_GREEN}LISTO${C_RESET}\n"
else
  printf "   ${C_YELLOW}TERMINADO CON FALLOS - revisa el detalle arriba${C_RESET}\n"
fi
printf "  ============================================================\n\n"
printf "  Siguiente paso: abre opencode (o Claude Code) y pide el informe\n"
printf "  en UN mensaje, algo asi:\n\n"
printf "    Genera el informe de entrega con /ruta/al/equipo.conf\n"
printf "    Es una migracion. Cliente Acme S.A., RUC 20123456789, direccion\n"
printf "    Av. Principal 123 Lima, contacto Juan Perez, sede Lima,\n"
printf "    ingeniero Ana Torres, del 01/08/2026 al 08/08/2026.\n"
printf "    Toma las capturas en https://10.10.200.100:9443\n\n"
printf "  Las credenciales ya estan en el archivo: no las escribas en el chat.\n\n"
