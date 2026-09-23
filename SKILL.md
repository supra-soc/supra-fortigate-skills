---
name: fortigate-report
description: Genera el informe de entrega (implementación o migración) para proyectos de firewalls Fortinet — FortiGate y FortiAnalyzer — a partir de uno o más archivos .conf del equipo, incluyendo las capturas en vivo de la GUI tomadas con Playwright. Usa este skill SIEMPRE que el usuario suba, adjunte o mencione un .conf de FortiGate o FortiAnalyzer y quiera un informe, entregable, acta o documento para el cliente después de una instalación, migración o puesta en marcha, aunque no use la palabra "informe". Extrae del .conf las interfaces, rutas, OSPF, políticas, perfiles web/app/IPS/AV, HA y administradores; se conecta a la IP de gestión que indique el usuario y captura licencia, HA y las gráficas de CPU, memoria y sesiones; dibuja la topología por zonas; y entrega un .docx con la identidad de marca SUPRA. NO uses este skill para auditorías de seguridad o hardening de un .conf — para eso existe fortigate-config-review.
license: Uso interno.
---

# Informe de entrega Fortinet (FortiGate / FortiAnalyzer) — edición SUPRA

Convierte uno o más `.conf` en el `.docx` de entrega al cliente, **con las
capturas en vivo incluidas**. Lo que está en el `.conf` se extrae y se tabula;
lo que solo existe en la GUI se captura con Playwright.

## Antes de empezar

**Corre todos los comandos desde la raíz del skill** — la carpeta que contiene
`package.json`. Los scripts resuelven `docx` y `playwright` desde el
`node_modules` de esa raíz; desde otra carpeta fallan.

Playwright, Chromium, Graphviz y python-docx **ya están instalados** por
`install.ps1`. Si algo falla por dependencias, no lo instales tú: dilo y remite
al usuario al `README.md`.

En Windows, si `npm` o `npx` fallan por la política de ejecución de PowerShell,
usa `npm.cmd` y `npx.cmd`. Es el mismo programa sin el envoltorio bloqueado.

### Las tres reglas que no se negocian

**1. Las capturas no son opcionales.** Si el usuario dio una IP de gestión y el
archivo de credenciales está lleno, el Paso 4 es obligatorio. Un informe con
recuadros `[ PEGAR AQUÍ ]` vacíos cuando el equipo era alcanzable es un trabajo
a medias, no una degradación elegante. Solo se omite si el usuario dice
explícitamente que no hay alcance al equipo, o si no hay credenciales.

**2. No escribas tu propio script de captura.** Ya existe
`scripts/capture/capture_playwright.js`, hace login programático y conoce las
rutas de la GUI de FortiOS. Escribir uno nuevo desde cero desperdicia el trabajo
que ya está hecho y reintroduce bugs ya resueltos.

**3. Nunca abras un navegador visible para que el usuario inicie sesión a mano.**
Cada invocación de Node lanza un contexto de navegador nuevo, así que ese login
se pierde en cuanto el proceso termina y entras en un bucle infinito de "vuelve
a entrar". El login lo hace el script solo, headless, con las credenciales del
archivo. Si no hay credenciales, la respuesta es pedirlas en el archivo, no
abrir una ventana.

**4. Cada informe va en su propia carpeta de trabajo — nunca reutilices `work/` entre `.conf` o clientes distintos.**
Si generaste un informe para un equipo y ahora te piden otro (otro `.conf`,
otro cliente, o el mismo cliente en una corrida nueva), crea una carpeta
nueva — por ejemplo `work_<hostname>/` o `work_<cliente>/`, no la misma
`work/` de antes. `capture_playwright.js` **acumula** claves en
`captures.json` en vez de reemplazarlo (para no perder capturas de una
corrida parcial); si dos proyectos comparten la carpeta, `captures.json`
termina con imágenes de un equipo mezcladas con las de otro, y `build_report.js`
puede insertar la captura del cliente equivocado en el informe del cliente
actual. En los comandos de abajo esa carpeta se llama `work/` solo por
brevedad — sustituye el nombre real que le hayas puesto.

---

## Paso 1 — Intake

Necesitas estos datos. **Si el usuario ya los dio TODOS en su mensaje, no
preguntes nada: continúa directo al Paso 2.** Ese es el camino feliz — un
mensaje bien escrito produce el informe completo sin ida y vuelta.

1. **Tipo de proyecto**: `migracion` o `implementacion_nueva`.
2. **Cliente, RUC del cliente, dirección del cliente, contacto en el cliente,
   ubicación/sede del proyecto, nombre del proyecto, ingeniero, fecha de
   inicio y fecha de fin.**
3. **Alcance**, 1-2 frases.
4. **IP de gestión y puerto admin** de cada equipo, para las capturas. Si el
   `.conf` tiene interfaces con `allowaccess https`, propón esa IP y confirma.
5. **Modelo y número de serie**. El modelo sale de la cabecera del `.conf`,
   confírmalo. La serie **no está en el `.conf`**: la da el usuario, o la saca
   la captura del Paso 4.
6. **FortiAnalyzer**, si lo hay: modelo, versión, CPU, memoria y disco de la VM.
7. **Conclusiones**, 2-4 bullets. Si no las aporta, redacta un default según el
   tipo de proyecto y avísale que las revise.
8. **Empresa** para portada y aviso legal: normalmente `SUPRA`.

No preguntes por nada que el `.conf` ya traiga — interfaces, rutas, políticas,
perfiles, HA, admins — eso se extrae solo en el Paso 2.

### Si falta algo del punto 2 (cliente, RUC, dirección, contacto, sede,
### proyecto, ingeniero, fechas): **pregúntalo y espera la respuesta antes de
### seguir al Paso 2.** No es opcional, y no es lo mismo que "el usuario no
### contestó rápido" — es una entrevista, no una sugerencia.

Solo saltas la pregunta y usas `(completar ...)` cuando el usuario **ya te
dijo explícitamente** que no los tiene o que uses defaults — frases como "no
tengo esos datos ahora", "usa defaults y los completo yo después", "no puedo
darte esa info todavía". Un mensaje que simplemente **no menciona** el cliente
no cuenta como eso: la ausencia de datos no es lo mismo que un permiso para
omitirlos. Si tienes duda de cuál es el caso, pregunta — el costo de preguntar
de más es un mensaje; el costo de entregar un informe con `(completar ...)`
en el cliente y el proyecto sin que nadie lo haya pedido es un informe inútil
para el ingeniero que lo iba a usar.

La **IP de gestión** tiene la misma regla, con más razón: sin ella no hay
capturas, así que si no la dio y no dijo que el equipo es inalcanzable,
pregúntala — nunca la saltees en silencio.

---

## Paso 2 — Parsear el `.conf`

```bash
python scripts/parse_fortigate_conf.py <conf1> [<conf2> ...] -o work/parsed.json
```

Acepta varios archivos: el par HA y el FortiAnalyzer juntos. El FAZ se reconoce
por la cabecera `#config-version=FAZ...`.

Lee el resumen de stderr (interfaces, rutas, políticas, perfiles). Si sale en
cero, el `.conf` está vacío, truncado o cifrado: detente y dilo.

**Contrasta lo que dijo el usuario contra lo que el `.conf` realmente trae —
no asumas que coinciden.** Visto en la práctica: un usuario dio el modelo
`FGT600F` y el `.conf` decía `FGT60F`; dijo "par HA" y el `.conf` no tenía
`mode`/`group-id`/`hbdev`; dio una IP y el `.conf` traía otra; dijo "40
políticas" y el parser contó 25. Ninguno de esos casos es que el usuario
mintiera — son datos de memoria, de otro proyecto, o simplemente viejos. Si
algo choca:

- Si es fácil de verificar solo (p.ej. si hay o no un bloque de
  FortiAnalyzer, o el conteo real de políticas), verifícalo tú mismo y sigue.
- Si cambia el contenido del informe de forma material (modelo, si hay HA de
  verdad o no, la IP a la que te vas a conectar), **pregúntale al usuario
  cuál vale** en vez de elegir uno de los dos en silencio.

No es opcional ni cosmético: el usuario no siempre puede ver el `.conf` con
el mismo detalle que tú, y un informe de entrega con el modelo o el estado de
HA equivocado es peor que uno que tardó un mensaje más en confirmarlo.

---

## Paso 3 — Comprobar las credenciales

```bash
node scripts/capture/credentials.js --check
```

Lista los equipos cargados sin mostrar contraseñas. El archivo lo llenó el
usuario durante la instalación, así que **normalmente esto ya pasa y sigues
directo al Paso 4**.

Si sale error porque está vacío o mal formado:

```bash
node scripts/capture/credentials.js --init
```

Dale al usuario la **ruta absoluta** que imprime y pídele que escriba un bloque
por equipo, separados por una línea en blanco:

```
# nombre-del-equipo
https://ip:puerto
usuario
contrasena
```

El `# nombre-del-equipo` debe coincidir con el `--host` del Paso 4. Detente ahí
hasta que confirme, y vuelve a validar. No inventes credenciales ni las pidas
por chat.

---

## Paso 4 — Capturas en vivo

Una corrida por equipo. La URL sale del bloque de credenciales:

```bash
node scripts/capture/capture_playwright.js --host <hostname> --out work/capturas
```

Captura licencia y soporte, HA en vivo, y las gráficas de CPU, memoria y
sesiones, y deja `work/captures.json` con las claves `licencia_general`,
`licencia_<host>`, `cpu_<host>`, `memoria_<host>`, `sesiones_<host>`,
`ha_live_<host>`.

También imprime `SERIAL:` y `MODEL:` leídos del dashboard. **Si el usuario no
dio la serie, tómala de aquí** y úsala en el Paso 5.

Al terminar, **cuenta cuántas claves quedaron en `captures.json`**. Si son menos
de las esperadas, dilo explícitamente antes de seguir: el usuario tiene que
saber qué no se pudo capturar y por qué.

### Si algo falla

| Síntoma | Qué hacer |
|---|---|
| `No existe el archivo de credenciales` | Vuelve al Paso 3. |
| `No hay credenciales para "X"` | El `--host` no coincide con ningún `# hostname`. Usa uno de los que lista el error. |
| `El login no se completo` | El script detectó que el formulario de usuario/contraseña seguía en pantalla y se detuvo ahí — no intentó capturas sobre una página de login. Revisa `login_fallido.txt` en la carpeta de salida. Pide al usuario que corrija las credenciales **en el archivo** y reintenta una vez. |
| Timeout o `ERR_CONNECTION` | No hay ruta a esa IP desde esta máquina. Verifica la IP con el usuario y reintenta una vez. Si sigue, informa que el equipo es inalcanzable y pregúntale si continúas sin capturas. |
| Salen unas capturas y otras no | Las rutas de la GUI cambian entre versiones de FortiOS. Continúa con las que salieron y di cuáles faltaron. |
| El script tarda mucho | Es normal: son varias páginas con gráficas. Dale al menos 3 minutos antes de considerarlo colgado. No lo mates ni lo relances en paralelo. |

Si tras dos intentos no hay ninguna captura, **pregúntale al usuario si sigues
sin ellas** en vez de decidirlo tú. El informe sin capturas es su decisión, no
la tuya.

---

## Paso 5 — Escribir `metadata.json`

Copia `scripts/metadata.example.json` y llénalo con lo del Paso 1, más la serie
y el modelo que salieron del Paso 4 si el usuario no los dio.

Campos: `empresa`, `nombre_proyecto`, `cliente`, `ruc_cliente`,
`direccion_cliente`, `contacto_cliente`, `ubicacion`, `ingeniero`,
`tipo_proyecto` (`migracion` | `implementacion_nueva`), `fecha_inicio`,
`fecha_fin`, `alcance`, `equipos` (lista de `{equipo, modelo, serie, fortios}`),
`faz` (`{modelo, version, cpu, memoria, disco}` o `null`), `conclusiones` (lista).

`fortios` sale de la cabecera del `.conf`: en
`#config-version=FG120G-7.2.11-FW-build1740-250210` la versión es
`7.2.11 build 1740` y el modelo es `FG120G`.

---

## Paso 6 — Topología

```bash
python scripts/generate_topology.py work/parsed.json -o work/topology.png
```

Dibuja Internet → WAN → firewall → LAN/DMZ/VPN/Fabric, el par HA si el `.conf`
trae HA real, y el FortiAnalyzer si subieron su `.conf`. Deja también un
`topology.dot` editable.

Si `dot` no está en el PATH, prueba con `C:\Program Files\Graphviz\bin` añadido
al PATH de la sesión. Si aun así falla, sigue sin topología: esa sección cae al
recuadro manual.

---

## Paso 7 — Generar el `.docx`

**No ejecutes este paso sin haber pasado por el Paso 4.** Si vas a construir el
informe sin `--captures`, tiene que ser porque el usuario lo autorizó
explícitamente, no porque las capturas resultaran incómodas.

```bash
node scripts/build_report.js --metadata work/metadata.json --parsed work/parsed.json --topology work/topology.png --captures work/captures.json --out work/informe.docx
```

`--topology` y `--captures` son opcionales para el script; las secciones sin
insumo caen al recuadro manual. La portada, el watermark y el header/footer se
aplican solos desde `scripts/assets/`.

---

## Paso 8 — Verificar

```bash
python scripts/check_report.py work/informe.docx --metadata work/metadata.json
```

Valida que el `.docx` abra sin corrupción, lista cada recuadro `[ PEGAR AQUÍ ]`
con su sección, y muestra los campos que siguen en `(completar ...)`.

Si sale con error, el archivo está corrupto y Word lo va a rechazar: arréglalo
antes de entregar.

No cuentes los recuadros por tu cuenta. Viven dentro de tablas, y recorrer
`Document.paragraphs` **devuelve cero aunque haya siete**, porque esa colección
no entra en las tablas. Por eso existe este script.

---

## Paso 9 — Entregar

Entrega el `.docx` y dile al usuario:

1. **Qué capturas entraron y cuáles no**, y por qué. Si el informe quedó con
   recuadros vacíos habiendo alcance al equipo, eso es un pendiente tuyo, no un
   resultado normal.
2. Qué campos quedaron en `(completar ...)`, y que puede regenerar el `.docx`
   repitiendo el Paso 7 cuando los complete.
3. Si alguna contraseña llegó a aparecer en el chat, recomiéndale rotarla.

El archivo de credenciales **se queda como está**: el usuario lo llenó una vez
al instalar y sirve para los siguientes informes. Solo se vacía
(`node scripts/capture/credentials.js --wipe`) si él lo pide.

---

## Qué es automático y qué no

| Sección del informe | De dónde sale |
|---|---|
| Memoria descriptiva, alcance, equipos, conclusiones | Intake (Paso 1) |
| Interfaces, rutas estáticas, OSPF | `.conf` |
| Políticas de firewall | `.conf` |
| Perfiles web / app / IPS / AV, con columna "¿en uso?" | `.conf` (cruce contra políticas) |
| HA: modo, group-id, prioridad, override | `.conf` |
| Cuentas de administrador (sin contraseñas) | `.conf` |
| FortiAnalyzer: interfaz, ruteo, admins | `.conf` del FAZ |
| Topología por zonas | Graphviz (Paso 6) |
| Portada, watermark, header/footer | Assets embebidos |
| Licencia, CPU/memoria/sesiones, HA en vivo, número de serie | Playwright (Paso 4) |

**Multi-VDOM**: el parser no separa VDOMs dentro de un mismo archivo. Si el
cliente usa VDOMs, pide un `.conf` exportado por VDOM o avísale de la limitación
antes de generar el informe.
