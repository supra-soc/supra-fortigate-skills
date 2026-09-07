# Assets de identidad de marca

Esta carpeta va **vacía en el repositorio a propósito**. Los PNG de marca no se
publican.

`build_report.js` busca aquí dos archivos opcionales:

| Archivo | Qué es | Tamaño de referencia |
|---|---|---|
| `supra_cover_bg.png` | Fondo de la portada, a página completa | 1240 × 1754 px (A4 a 150 dpi) |
| `supra_watermark_narrow.png` | Franja angosta del wordmark, para el header de contenido | ancho de página × ~90 px |

Si no están, el informe **se genera igual**: sin fondo de portada y sin
watermark, con todo el resto del contenido intacto. La detección es un
`existsSync` en `build_report.js`, así que no hay que tocar código para
prescindir de ellos.

Para usar tu propia identidad, deja aquí dos PNG con esos nombres. Los tamaños
de arriba son los que producen un resultado bien proporcionado; otros funcionan,
pero puede que tengas que ajustar el `spacing.before` de los párrafos de portada.
