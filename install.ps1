<#
.SYNOPSIS
  Instala el skill fortigate-report y todas sus dependencias en Windows.

.DESCRIPTION
  Deja la maquina lista para generar informes de entrega Fortinet con capturas
  reales: instala el skill donde el agente lo va a encontrar, las dependencias
  de Node (incluido Playwright + Chromium), python-docx y Graphviz, verifica
  todo, y termina abriendo el archivo de credenciales para que lo llenes una
  sola vez.

  El skill se instala en $HOME\.claude\skills\fortigate-report. Esa ruta la leen
  tanto opencode como Claude Code, asi que una sola instalacion sirve para los
  dos. El nombre de la carpeta TIENE que ser "fortigate-report" (el campo name:
  del SKILL.md); si clonas el repo a mano te queda "supra-fortigate-skills" y el
  agente no encuentra el skill. Por eso existe este script.

.PARAMETER SkillsDir
  Carpeta de skills donde instalar. Por defecto $HOME\.claude\skills.
  Para opencode nativo tambien vale $HOME\.config\opencode\skills.

.PARAMETER Ref
  Rama o tag del repositorio a instalar. Por defecto main.

.PARAMETER SkipCredentials
  No abrir el archivo de credenciales al final.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  irm https://raw.githubusercontent.com/supra-soc/supra-fortigate-skills/master/install.ps1 | iex
#>
[CmdletBinding()]
param(
    [string] $SkillsDir = (Join-Path $HOME '.claude\skills'),
    [string] $Repo      = 'https://github.com/supra-soc/supra-fortigate-skills.git',
    [string] $Ref       = 'master',
    [switch] $SkipCredentials
)

$ErrorActionPreference = 'Continue'
# 'Continue', no 'Stop'. Verificado en una instalacion real: en PowerShell 5.1,
# cuando powershell.exe se invoca de forma NO interactiva -- exactamente como
# lo hace un agente (opencode, Claude Code) al correr un .ps1 -- CUALQUIER
# texto que un ejecutable externo escriba a stderr (p.ej. "Cloning into..." de
# git, que git escribe SIEMPRE, incluso en un clon exitoso) se envuelve en un
# NativeCommandError y, con 'Stop', mata el script entero. Esto ocurre pase lo
# que pase con la redireccion del comando (2>$null incluido: no es un problema
# de este script sino de como PS 5.1 maneja stderr de procesos nativos cuando
# su propia salida esta siendo capturada por otro proceso). Con 'Continue' el
# script sigue de largo y cada paso critico ya se verifica con su propio
# $LASTEXITCODE o exit 1 explicito -- no depende de que una excepcion no
# capturada detenga la ejecucion.
$SKILL_NAME = 'fortigate-report'
$GRAPHVIZ_BIN = 'C:\Program Files\Graphviz\bin'

function Write-Step  { param($m) Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "    OK   $m" -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host "    !!   $m" -ForegroundColor Yellow }
function Write-Bad   { param($m) Write-Host "    X    $m" -ForegroundColor Red }

function Get-Exe {
    # En Windows npm y npx se instalan como .ps1, .cmd y sin extension. Si la
    # politica de ejecucion de PowerShell esta restringida, el .ps1 esta
    # bloqueado y solo funciona el .cmd. Por eso se prefiere .cmd siempre.
    param([string[]] $Names)
    foreach ($n in $Names) {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c) { return $c.Source }
    }
    return $null
}

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   fortigate-report  ::  instalador para Windows" -ForegroundColor Cyan
Write-Host "  ============================================================" -ForegroundColor Cyan

# ---------------------------------------------------------------- requisitos
Write-Step "Comprobando requisitos del sistema"

$git    = Get-Exe @('git.exe','git')
$node   = Get-Exe @('node.exe','node')
$npm    = Get-Exe @('npm.cmd','npm')
$npx    = Get-Exe @('npx.cmd','npx')
$python = Get-Exe @('python.exe','python','py.exe')
$winget = Get-Exe @('winget.exe','winget')

$faltan = @()
if (-not $git)    { $faltan += 'git      -> https://git-scm.com/download/win' }
if (-not $node)   { $faltan += 'Node.js  -> https://nodejs.org (incluye npm)' }
if (-not $npm)    { $faltan += 'npm      -> viene con Node.js' }
if (-not $python) { $faltan += 'Python 3 -> https://python.org' }

if ($faltan.Count -gt 0) {
    Write-Bad "Faltan requisitos que este script no instala:"
    foreach ($f in $faltan) { Write-Host "         $f" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  Instalalos, abre una terminal NUEVA y vuelve a ejecutar." -ForegroundColor Red
    exit 1
}

Write-Ok "git    $((& $git --version) -replace 'git version ','')"
Write-Ok "node   $(& $node -v)"
Write-Ok "npm    $(& $npm -v)"
Write-Ok "python $((& $python --version) -replace 'Python ','')"
if ($npm -like '*.cmd') { Write-Ok "usando npm.cmd (inmune a la politica de ejecucion de PowerShell)" }
if (-not $winget) { Write-Warn2 "winget no esta: tendras que instalar Graphviz a mano" }

# ------------------------------------------------------------ obtener fuente
Write-Step "Obteniendo el skill"

$localSrc = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'SKILL.md'))) {
    $localSrc = $PSScriptRoot
    Write-Ok "usando la copia local: $localSrc"
}

$tmp = $null
if (-not $localSrc) {
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("fgr-" + [guid]::NewGuid().ToString('N').Substring(0,8))
    Write-Host "    clonando $Repo ($Ref)..."
    & $git clone --depth 1 --branch $Ref $Repo $tmp 2>$null | Out-Null
    if (-not (Test-Path (Join-Path $tmp 'SKILL.md'))) {
        Write-Bad "El clon fallo o el repositorio no trae SKILL.md."
        exit 1
    }
    $localSrc = $tmp
    Write-Ok "repositorio clonado"
}

# -------------------------------------------------------------- instalar skill
Write-Step "Instalando el skill"

$dest = Join-Path $SkillsDir $SKILL_NAME
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null

# Rutas REALES (resueltas, sin ".."/symlinks/alias 8.3 tipo LIEBES~1) para
# comparar de forma confiable -- ver el aviso de seguridad justo abajo sobre
# por que esto importa tanto. Get-Item, a diferencia de Resolve-Path, SI
# normaliza los alias cortos de Windows a su nombre largo real (verificado:
# Resolve-Path deja "LIEBES~1" tal cual, Get-Item lo convierte a
# "Liebeslied") -- sin esto, dos rutas que apuntan a la MISMA carpeta pueden
# no compararse como iguales solo porque una se escribio con el alias corto.
$localSrcReal = (Get-Item -LiteralPath $localSrc).FullName.TrimEnd('\')
$destParentReal = (Get-Item -LiteralPath $SkillsDir).FullName.TrimEnd('\')
$destReal = Join-Path $destParentReal $SKILL_NAME

if ($localSrcReal -ieq $destReal) {
    # SEGURIDAD CRITICA: si la copia local que se esta usando como fuente ES
    # el propio destino (alguien corrio "install.ps1" desde DENTRO de
    # ~\.claude\skills\fortigate-report sin cambiar -SkillsDir, que es
    # ademas el escenario mas comun de "quiero reinstalar/actualizar"), un
    # simple "Remove-Item $dest -Recurse -Force" seguido de copiar desde
    # $localSrc BORRA LA FUENTE ANTES DE COPIARLA -- el resultado es una
    # carpeta casi vacia, no una reinstalacion limpia. Esto paso de verdad
    # probando la version equivalente de este script en bash: destruyo una
    # instalacion real por completo (quedaron solo credentials.txt y dos
    # PNG, que es literalmente todo lo que el paso de "preservar" alcanzo a
    # respaldar en memoria antes del Remove-Item).
    #
    # Si fuente y destino son la misma carpeta, no hay nada que copiar -- los
    # archivos ya estan exactamente donde tienen que estar. Se salta todo el
    # bloque de copia y se sigue directo a dependencias.
    Write-Ok "la copia local YA ES el destino ($destReal) -- nada que copiar, se salta al siguiente paso"
} else {
    # Aviso de instalaciones duplicadas: opencode escanea ~\.claude\skills Y
    # ~\.agents\skills a la vez. Este script solo instala en $dest -- si hay
    # algo en la otra ruta, se avisa pero NO se toca sin que el usuario lo
    # pida, porque no es la carpeta que este script declaro como destino.
    $otherAgentsDir = Join-Path $HOME ".agents\skills\$SKILL_NAME"
    if ($destReal -ne $otherAgentsDir -and (Test-Path $otherAgentsDir)) {
        Write-Warn2 "Tambien existe una instalacion en $otherAgentsDir (opencode lee esa ruta tambien)."
        Write-Warn2 "Para evitar un skill duplicado, borrala despues de confirmar que esta instalacion funciona:"
        Write-Warn2 "  Remove-Item -Recurse -Force `"$otherAgentsDir`""
    }

    # Se conservan los archivos que NO vienen del repo y que el usuario si
    # quiere mantener entre instalaciones: la identidad de marca y sus
    # credenciales. Se leen ANTES de borrar el destino.
    $preservar = @(
        'scripts\assets\supra_cover_bg.png',
        'scripts\assets\supra_watermark_narrow.png',
        'credentials.txt'
    )
    $respaldo = @{}
    foreach ($rel in $preservar) {
        $p = Join-Path $dest $rel
        if (Test-Path $p) { $respaldo[$rel] = [IO.File]::ReadAllBytes($p) }
    }

    # El destino se borra por completo antes de copiar, no se mezcla encima.
    # Una instalacion anterior (de una version vieja del skill, con otra
    # estructura de carpetas) puede dejar archivos que el arbol nuevo no toca
    # porque no coinciden por ruta -- por ejemplo esta misma carpeta tuvo, en
    # una version anterior, un scripts\node_modules\ propio con su propio
    # docx instalado. Si eso sigue ahi, Node lo resuelve ANTES que el
    # node_modules de la raiz (busca de adentro hacia afuera), y
    # build_report.js terminaria usando ese docx viejo en silencio, sin
    # ningun error. Borrar y reconstruir es la unica forma de garantizar que
    # instalar "reemplaza" de verdad y no "mezcla".
    # (Seguro llegar aqui: ya se confirmo arriba que $destReal -ne $localSrcReal.)
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    Get-ChildItem -Path $localSrc -Force |
        Where-Object { $_.Name -notin @('.git', 'node_modules', 'credentials.txt') } |
        ForEach-Object { Copy-Item $_.FullName -Destination $dest -Recurse -Force }

    foreach ($rel in $respaldo.Keys) {
        $p = Join-Path $dest $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
        [IO.File]::WriteAllBytes($p, $respaldo[$rel])
        Write-Ok "conservado: $rel"
    }

    Write-Ok "skill en $dest (destino limpiado antes de copiar)"
    Write-Host "         (esa ruta la leen opencode y Claude Code)" -ForegroundColor DarkGray
}

if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

# ------------------------------------------------------------ deps de Node
Write-Step "Instalando dependencias de Node (docx + Playwright)"
Push-Location $dest
try {
    & $npm install --no-audit --no-fund 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Bad "npm install fallo"; exit 1 }
    Write-Ok "docx y playwright instalados"

    Write-Host "    descargando Chromium (puede tardar un par de minutos)..."
    & $npx playwright install chromium 2>$null | Out-Null
    Write-Ok "Chromium descargado"
}
finally { Pop-Location }

# ---------------------------------------------------------- deps de Python
Write-Step "Instalando dependencias de Python"
& $python -m pip install --quiet --disable-pip-version-check python-docx 2>$null | Out-Null
Write-Ok "python-docx instalado"

# -------------------------------------------------------------- Graphviz
Write-Step "Instalando Graphviz"
$dot = Get-Exe @('dot.exe','dot')
if (-not $dot -and (Test-Path (Join-Path $GRAPHVIZ_BIN 'dot.exe'))) {
    $dot = Join-Path $GRAPHVIZ_BIN 'dot.exe'
}
if (-not $dot) {
    if ($winget) {
        & $winget install --id Graphviz.Graphviz -e --accept-package-agreements --accept-source-agreements --disable-interactivity 2>$null | Out-Null
        if (Test-Path (Join-Path $GRAPHVIZ_BIN 'dot.exe')) { $dot = Join-Path $GRAPHVIZ_BIN 'dot.exe' }
    }
}
if ($dot) {
    # graphviz escribe su version en stderr (asi es dot -V, no es un fallo).
    # Un "2>&1" directo de PowerShell la envuelve en NativeCommandError y,
    # con $ErrorActionPreference='Stop', eso mata el script aunque dot este
    # bien. cmd /c hace la fusion de stdout+stderr fuera de PowerShell, asi
    # que aqui solo llega texto plano.
    $dotVersion = cmd /c "`"$dot`" -V 2>&1"
    Write-Ok "graphviz $dotVersion"
    # El instalador de Graphviz no siempre agrega su bin al PATH, y sin eso el
    # paso de topologia falla en cada terminal nueva.
    $userPath = [Environment]::GetEnvironmentVariable('Path','User')
    if (($userPath -split ';') -notcontains $GRAPHVIZ_BIN) {
        $nuevo = $GRAPHVIZ_BIN
        if ($userPath) { $nuevo = $userPath.TrimEnd(';') + ';' + $GRAPHVIZ_BIN }
        [Environment]::SetEnvironmentVariable('Path', $nuevo, 'User')
        Write-Ok "agregado al PATH de usuario: $GRAPHVIZ_BIN"
        Write-Warn2 "abre una terminal NUEVA para que 'dot' resuelva"
    }
    $env:Path = $env:Path + ';' + $GRAPHVIZ_BIN
} else {
    Write-Warn2 "Graphviz no quedo instalado. Los informes saldran sin diagrama de topologia."
    Write-Host "         Instalalo con: winget install Graphviz.Graphviz" -ForegroundColor DarkGray
}

# ------------------------------------------------------------ verificacion
Write-Step "Verificando la instalacion"
Push-Location $dest
$fallos = 0
try {
    & $node -e "require('docx');require('playwright')" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "modulos docx y playwright" } else { Write-Bad "faltan modulos de Node"; $fallos++ }

    $chromiumOk = & $node -e "const{chromium}=require('playwright');const fs=require('fs');process.stdout.write(fs.existsSync(chromium.executablePath())?'1':'0')" 2>$null
    if ($chromiumOk -eq '1') { Write-Ok "binario de Chromium presente" } else { Write-Bad "Chromium no descargado"; $fallos++ }

    & $python -c "import docx" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "python-docx" } else { Write-Bad "python-docx"; $fallos++ }

    & $python (Join-Path $dest 'scripts\parse_fortigate_conf.py') --help 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "scripts del skill ejecutables" } else { Write-Bad "los scripts del skill no corren"; $fallos++ }
}
finally { Pop-Location }

# ------------------------------------------------------------ credenciales
if (-not $SkipCredentials) {
    Write-Step "Credenciales de captura"
    Push-Location $dest
    try { & $node 'scripts\capture\credentials.js' --init }
    finally { Pop-Location }

    $credFile = Join-Path $dest 'credentials.txt'
    Write-Host ""
    Write-Host "    Este es el paso que hace que luego el informe salga de un tiron." -ForegroundColor Yellow
    Write-Host "    Llena el archivo AHORA con un bloque por equipo. Las contrasenas" -ForegroundColor Yellow
    Write-Host "    se quedan en tu disco y nunca pasan por el chat del agente." -ForegroundColor Yellow
    Write-Host ""
    Start-Process notepad.exe -ArgumentList "`"$credFile`""
    Write-Ok "abierto en el Bloc de notas: $credFile"
}

# ------------------------------------------------------------------ cierre
Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
if ($fallos -eq 0) {
    Write-Host "   LISTO" -ForegroundColor Green
} else {
    Write-Host "   TERMINADO CON $fallos FALLO(S) - revisa el detalle arriba" -ForegroundColor Yellow
}
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Siguiente paso: abre opencode (o Claude Code) y pide el informe"
Write-Host "  en UN mensaje, algo asi:" -ForegroundColor Gray
Write-Host ""
Write-Host '    Genera el informe de entrega con C:\ruta\al\equipo.conf' -ForegroundColor White
Write-Host '    Es una migracion. Cliente Acme S.A., RUC 20123456789, direccion' -ForegroundColor White
Write-Host '    Av. Principal 123 Lima, contacto Juan Perez, sede Lima,' -ForegroundColor White
Write-Host '    ingeniero Ana Torres, del 01/08/2026 al 08/08/2026.' -ForegroundColor White
Write-Host '    Toma las capturas en https://10.10.200.100:9443' -ForegroundColor White
Write-Host ""
Write-Host "  Las credenciales ya estan en el archivo: no las escribas en el chat." -ForegroundColor Gray
Write-Host ""
