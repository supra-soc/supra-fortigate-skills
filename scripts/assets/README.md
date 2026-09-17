# Assets de identidad de marca

`supra_cover_bg.png` y `supra_watermark_narrow.png` viven directamente en esta
carpeta — decisión explícita de SUPRA: el repo sigue público de todas formas,
así que no tenía sentido dejarlos fuera y depender de que cada quien los
copiara a mano en cada instalación nueva (eso fue justo lo que falló: un
informe real salió sin logo porque nadie sabía que faltaban).

`build_report.js` los usa así:

| Archivo | Qué es | Tamaño de referencia |
|---|---|---|
| `supra_cover_bg.png` | Fondo de la portada, a página completa | 1240 × 1754 px (A4 a 150 dpi) |
| `supra_watermark_narrow.png` | Franja angosta del wordmark, para el header de contenido | ancho de página × ~90 px |

Si algún día no están (por ejemplo, alguien los borra a mano), el informe
**se genera igual**: sin fondo de portada y sin watermark, con todo el resto
del contenido intacto. La detección es un `existsSync` en `build_report.js`,
así que no hay que tocar código para prescindir de ellos si hace falta.

Para usar una identidad distinta a la de SUPRA (un fork para otro integrador,
por ejemplo), reemplaza estos dos archivos por los propios, con los mismos
nombres. Los tamaños de arriba son los que producen un resultado bien
proporcionado; otros funcionan, pero puede que haya que ajustar el
`spacing.before` de los párrafos de portada en `build_report.js`.
