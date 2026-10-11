# SIPINNA Atizapán — API

Backend serverless del Sistema de Reporte de Trabajo Infantil de SIPINNA
Atizapán de Zaragoza. Atiende tanto a la
[app ciudadana](https://github.com/Ferrusca08/sipinna-movil) como al
[panel de administración](https://github.com/Ferrusca08/sipinna-admin).

Node 20 sobre AWS Lambda, un artefacto compartido donde cada función apunta a su
propio handler. Sin framework: los handlers hablan directo con el SDK de AWS.

## Endpoints

### Públicos (ciudadanía)

| Ruta | Qué hace |
|---|---|
| `POST /reportes` | Alta de reporte. Abierto a propósito: denunciar sin cuenta es el camino principal. Si la petición trae sesión, la Lambda verifica el token y liga el reporte a esa persona. |
| `GET /reportes/{id}/estatus` | Consulta por folio. Devuelve solo lo que quien reportó puede ver. |
| `POST /reportes/{id}/evidencia` | URLs prefirmadas para subir fotos a S3. |

### Ciudadanía autenticada

| Ruta | Qué hace |
|---|---|
| `GET /mis-reportes` | Reportes propios. El filtro sale del `sub` del token, no de un parámetro: no hay forma de pedir los de otra persona. |

### Personal SIPINNA

`GET|PATCH /admin/reportes`, `/admin/estadisticas`, `/admin/estadisticas/heatmap`,
`/admin/usuarios`, `/admin/exportar`, `/admin/auditlog`. Todas tras el
autorizador JWT del pool del personal, y cada una exige su permiso según el
grupo de Cognito.

## Modelo de datos

Tres tablas DynamoDB en modo bajo demanda:

- **reportes** — clave `(reporteId, fechaCreacion)`, con índices por estatus,
  zona, operador, prioridad y reportante.
- **seguimiento** — bitácora de acciones sobre cada caso.
- **auditlog** — con TTL; toda acción del personal queda registrada.

El `reporteId` es un ULID: ordenable por tiempo y sin revelar un contador de
cuántos reportes existen.

## Decisiones que no son negociables

- **El anonimato es el estado por defecto.** Un reporte sin sesión no guarda
  ningún identificador de quien lo envió.
- **Un `reportanteId` enviado en el cuerpo se ignora.** Solo vale el que sale de
  un token verificado; aceptarlo del cliente permitiría atribuir un reporte a
  cualquier persona.
- **Un token inválido degrada a anónimo, no rechaza.** Perder la trazabilidad de
  un reporte es mucho menos grave que perder el reporte.
- **La evidencia nunca pasa por la Lambda.** Va directo a S3 con URL prefirmada
  de vigencia corta y cifrado KMS.

## Desarrollo

```bash
npm ci
npm test
```

Las pruebas corren con el runner de Node, sin dependencias: clasificación de
prioridad, transiciones de estatus, cálculo de zona y turno, permisos por grupo,
generación de ULID y de PDF.

## Licencia

Sistema desarrollado para el H. Ayuntamiento de Atizapán de Zaragoza.
