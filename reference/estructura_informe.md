# Estructura del informe de referencia

Tomado de un informe real de SUPRA (proyecto de renovación de firewalls +
FortiAnalyzer en una sede regional; cliente anonimizado). Se usó únicamente como plantilla de estilo y
estructura, no contiene datos de este skill.

Orden de secciones y de dónde sale cada una en el flujo automatizado:

1. **Portada** — nombre de proyecto, cliente, fecha → intake.
2. **Contenido** (índice) → generado con campo TOC de Word.
3. **Memoria descriptiva** — nombre de proyecto, cliente, contacto, ubicación,
   ingeniero a cargo, fechas → intake.
4. **Alcance** → intake (texto libre corto).
5. **Listado de equipamiento** (equipo, modelo, número de serie, FortiOS) →
   intake para modelo/serie, `.conf` para hostname/FortiOS si está disponible.
6. **Topología de red** (diagrama) → **automático** (`generate_topology.py`,
   Graphviz a partir de interfaces/HA/FAZ del `.conf`; si no se genera, cae a
   recuadro manual).
7. **Fortigates**
   - Versión de firmware y estado de licencia → firmware desde cabecera del
     `.conf` (`#config-version=...`); estado de licencia → manual.
   - Interfaces → automático (`config system interface`).
   - Rutas: estáticas (`config router static`) automático; OSPF config
     (`config router ospf`) automático; estado de neighbors → manual (vive
     solo en runtime, `get router info ospf neighbor`).
   - Políticas de firewall, por VDOM → automático (`config firewall
     policy`). Nota: el parser actual no separa VDOMs múltiples dentro de un
     mismo archivo — si el cliente tiene VDOMs (`config vdom` / `edit
     "nombre"` envolviendo los bloques), hay que exportar un `.conf` por VDOM
     o extender el parser para bloques `config vdom`.
   - Filtro web / aplicaciones / IPS / antivirus → automático, con columna
     "¿En uso en una política?" cruzando contra `firewall policy`.
   - HA → automático (`config system ha`); estado de sincronización en vivo
     → manual.
8. **Accesos a gestión Fortigate** — usuarios y perfiles → automático
   (`config system admin`); passwords **nunca** se incluyen (se entregan por
   canal separado, ej. gestor de contraseñas).
9. **Integración a FortiAnalyzer** (envío de logs) → manual (vista de
   Log Settings del GUI); si el `.conf` tiene `config log fortianalyzer
   setting`, se podría extender el parser para sacar la IP del FAZ
   automáticamente (no implementado en v1).
10. **FortiAnalyzer (FAZ-VMxx)**
    - Specs de VM (CPU/memoria/disco) → intake (no está en el `.conf`).
    - Interface, enrutamiento, administradores → automático, si se sube el
      `.conf` del FAZ (mismo parser).
    - Log View, Device Manager, Reportes/templates FAZ → manual (vistas de
      GUI).
11. **Logs / gráficas / reportes** (CPU, memoria, sesiones) → manual
    (gráficas en vivo).
12. **Conclusiones y recomendaciones** → intake (bullets libres); si el
    usuario no da nada, se genera un default genérico según tipo de proyecto
    (migración vs implementación nueva).
13. **Aviso legal / pie de página** → texto fijo, se genera con el nombre de
    la empresa del intake (`empresa`, default "SUPRA").

## Extensiones futuras posibles

- Soporte multi-VDOM real (detectar bloques `config vdom`).
- Extraer IP de FortiAnalyzer desde `config log fortianalyzer setting`.
- Extraer `admin-sport` de `system global` para armar automáticamente la URL
  de gestión (`https://<ip>:<admin-sport>/`).
- Adjuntar imágenes automáticamente: si el usuario deja las capturas en una
  carpeta con nombres tipo `topologia.png`, `licencia_FW1.png`, el generador
  podría insertarlas directo en vez de dejar el recuadro `[ PEGAR AQUÍ ]`.
