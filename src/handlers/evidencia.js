import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_REPORTES } from '../lib/aws.js';
import { ok, leerCuerpo, leerRuta, manejar } from '../lib/respuesta.js';
import { validarSolicitudEvidencia } from '../lib/validacion.js';
import { generarUrlsDeSubida } from '../lib/evidencia.js';
import { obtenerPorId } from '../lib/reportes.js';
import { auditar } from '../lib/auditoria.js';
import { ipOrigen } from '../lib/auth.js';

/**
 * POST /reportes/{id}/evidencia  (publica, sin autenticacion)
 *
 * Dos modos:
 *  - { cantidad, tiposContenido }: entrega nuevas presigned URLs de subida.
 *  - { clavesConfirmadas: [...] }: registra en el reporte las que ya se subieron.
 *
 * Se protege por posesion del token: quien no conoce el ULID de 26 caracteres
 * no puede adjuntar evidencia a un caso ajeno.
 */
export const handler = manejar(async (evento) => {
  const reporteId = leerRuta(evento, 'id');
  const cuerpo = leerCuerpo(evento);
  const reporte = await obtenerPorId(reporteId);

  const yaSubidas = (reporte.evidenciaUrls || []).length;

  // --- Modo confirmacion -------------------------------------------------
  if (Array.isArray(cuerpo.clavesConfirmadas) && cuerpo.clavesConfirmadas.length > 0) {
    const claves = cuerpo.clavesConfirmadas
      .map((c) => String(c))
      // Solo se aceptan claves dentro del prefijo del propio reporte.
      .filter((c) => c.startsWith(`reportes/${reporteId}/`))
      .slice(0, 5);

    const combinadas = [...new Set([...(reporte.evidenciaUrls || []), ...claves])].slice(0, 5);

    await dynamo.send(
      new UpdateCommand({
        TableName: TABLA_REPORTES,
        Key: { reporteId: reporte.reporteId, fechaCreacion: reporte.fechaCreacion },
        UpdateExpression: 'SET evidenciaUrls = :ev, actualizadoEn = :ahora',
        ExpressionAttributeValues: {
          ':ev': combinadas,
          ':ahora': new Date().toISOString(),
        },
      }),
    );

    await auditar({
      accion: 'EVIDENCIA_ADJUNTADA',
      recursoId: reporteId,
      ip: ipOrigen(evento),
      detalles: { archivos: combinadas.length },
    });

    return ok({ reporteId, evidenciaUrls: combinadas, total: combinadas.length }, evento);
  }

  // --- Modo solicitud de URLs -------------------------------------------
  const { cantidad, tiposContenido } = validarSolicitudEvidencia(cuerpo, yaSubidas);
  const urlsEvidencia = await generarUrlsDeSubida(reporteId, cantidad, tiposContenido, yaSubidas);

  await auditar({
    accion: 'EVIDENCIA_URLS_SOLICITADAS',
    recursoId: reporteId,
    ip: ipOrigen(evento),
    detalles: { cantidad },
  });

  return ok({ reporteId, urlsEvidencia, yaSubidas, maximo: 5 }, evento);
});
