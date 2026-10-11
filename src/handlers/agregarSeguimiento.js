import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_SEGUIMIENTO, TABLA_REPORTES } from '../lib/aws.js';
import { creado, leerCuerpo, leerRuta, manejar, ErrorHttp } from '../lib/respuesta.js';
import { identidad, exigir, ipOrigen } from '../lib/auth.js';
import { obtenerPorId } from '../lib/reportes.js';
import { auditar } from '../lib/auditoria.js';
import { ulid } from '../lib/ulid.js';

const TIPOS_ACCION = [
  'VISITA_CAMPO',
  'CONTACTO_FAMILIA',
  'CANALIZACION_DIF',
  'CANALIZACION_PROCURADURIA',
  'CANALIZACION_SALUD',
  'CANALIZACION_EDUCACION',
  'VERIFICACION',
  'ACTA_CIRCUNSTANCIADA',
  'CIERRE',
  'OTRO',
];

/**
 * POST /admin/reportes/{id}/seguimiento
 *
 * Registra una accion de seguimiento sobre el caso. La bitacora es
 * append-only: no hay endpoint para editar ni borrar entradas.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'seguimiento:agregar');

  const reporteId = String(leerRuta(evento, 'id') || '').toUpperCase();
  const cuerpo = leerCuerpo(evento);
  const reporte = await obtenerPorId(reporteId);

  const tipoAccion = String(cuerpo.tipoAccion || '').trim().toUpperCase();
  if (!TIPOS_ACCION.includes(tipoAccion)) {
    throw new ErrorHttp(400, `Tipo de accion invalido. Valores: ${TIPOS_ACCION.join(', ')}.`);
  }

  const descripcion = String(cuerpo.descripcion || '').trim();
  if (descripcion.length < 5 || descripcion.length > 2000) {
    throw new ErrorHttp(400, 'La descripcion del seguimiento debe tener entre 5 y 2000 caracteres.');
  }

  const ahora = new Date();
  const registro = {
    reporteId: reporte.reporteId,
    seguimientoId: ulid(ahora.getTime()),
    fecha: ahora.toISOString(),
    tipoAccion,
    descripcion,
    // Texto opcional que si puede leer el ciudadano en la consulta publica.
    descripcionPublica: cuerpo.descripcionPublica
      ? String(cuerpo.descripcionPublica).trim().slice(0, 300)
      : null,
    visiblePublico: Boolean(cuerpo.visiblePublico),
    dependenciaCanalizada: cuerpo.dependenciaCanalizada
      ? String(cuerpo.dependenciaCanalizada).trim().slice(0, 120)
      : null,
    resultado: cuerpo.resultado ? String(cuerpo.resultado).trim().slice(0, 500) : null,
    autor: usuario.nombre,
    autorId: usuario.userId,
    autorEmail: usuario.email,
  };

  await dynamo.send(new PutCommand({ TableName: TABLA_SEGUIMIENTO, Item: registro }));

  // El caso "toca" su fecha de actualizacion para que suba en el listado.
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLA_REPORTES,
      Key: { reporteId: reporte.reporteId, fechaCreacion: reporte.fechaCreacion },
      UpdateExpression: 'SET actualizadoEn = :ahora',
      ExpressionAttributeValues: { ':ahora': registro.fecha },
    }),
  );

  await auditar({
    accion: 'SEGUIMIENTO_AGREGADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
    detalles: { seguimientoId: registro.seguimientoId, tipoAccion },
  });

  return creado({ seguimiento: registro }, evento);
});
