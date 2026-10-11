import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_SEGUIMIENTO } from '../lib/aws.js';
import { ok, leerRuta, manejar } from '../lib/respuesta.js';
import { identidad, exigir, ipOrigen } from '../lib/auth.js';
import { obtenerPorId, sinDatosPersonales } from '../lib/reportes.js';
import { generarUrlDeLectura } from '../lib/evidencia.js';
import { auditar } from '../lib/auditoria.js';
import { TRANSICIONES } from '../lib/dominio.js';

/**
 * GET /admin/reportes/{id}
 *
 * Detalle completo: reporte, bitacora de seguimiento, evidencia con URLs
 * temporales de lectura y las transiciones de estatus disponibles.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'reportes:ver');

  const reporteId = String(leerRuta(evento, 'id') || '').toUpperCase();
  const reporte = await obtenerPorId(reporteId);

  const { Items: seguimiento = [] } = await dynamo.send(
    new QueryCommand({
      TableName: TABLA_SEGUIMIENTO,
      KeyConditionExpression: 'reporteId = :id',
      ExpressionAttributeValues: { ':id': reporte.reporteId },
      ScanIndexForward: false,
    }),
  );

  // Las claves de S3 se firman al vuelo; nunca se guardan URLs permanentes.
  const evidencia = await Promise.all(
    (reporte.evidenciaUrls || []).map(async (clave) => ({
      clave,
      url: await generarUrlDeLectura(clave),
    })),
  );

  const puedeVerContacto = usuario.grupos.includes('supervisor') || usuario.grupos.includes('directivo');
  const cuerpo = puedeVerContacto ? reporte : sinDatosPersonales(reporte);

  await auditar({
    accion: 'REPORTE_CONSULTADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
  });

  return ok(
    {
      reporte: cuerpo,
      seguimiento,
      evidencia,
      transicionesDisponibles: TRANSICIONES[reporte.estatus] || [],
      permisos: usuario.permisos,
    },
    evento,
  );
});
