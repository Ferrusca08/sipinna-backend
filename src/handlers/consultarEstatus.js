import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_SEGUIMIENTO } from '../lib/aws.js';
import { ok, leerRuta, manejar, ErrorHttp } from '../lib/respuesta.js';
import { esUlid } from '../lib/ulid.js';
import { obtenerPorId } from '../lib/reportes.js';
import { auditar } from '../lib/auditoria.js';
import { ipOrigen } from '../lib/auth.js';

// Texto que ve el ciudadano por cada estatus interno.
const DESCRIPCION_ESTATUS = {
  nuevo: 'Recibimos tu reporte y esta en espera de revision.',
  en_revision: 'Personal de SIPINNA esta revisando la informacion que enviaste.',
  asignado: 'Tu reporte fue asignado a un operador para su atencion.',
  en_seguimiento: 'Se estan realizando acciones de seguimiento en campo.',
  resuelto: 'El caso fue atendido y cerrado.',
  descartado: 'Tras la revision, el caso no procedio como situacion de trabajo infantil.',
};

const LINEA_TIEMPO = ['nuevo', 'en_revision', 'asignado', 'en_seguimiento', 'resuelto'];

/**
 * GET /reportes/{id}/estatus  (publica, sin autenticacion)
 *
 * Devuelve unicamente el avance del caso. No expone descripcion, ubicacion,
 * evidencia, notas internas ni datos del reportante: el token viaja por
 * WhatsApp o mensaje y podria terminar en manos de un tercero.
 */
export const handler = manejar(async (evento) => {
  const reporteId = leerRuta(evento, 'id');

  if (!esUlid(String(reporteId || '').toUpperCase())) {
    throw new ErrorHttp(400, 'El codigo de seguimiento no tiene el formato correcto.');
  }

  const reporte = await obtenerPorId(String(reporteId).toUpperCase());

  // Solo las acciones marcadas como visibles para el ciudadano.
  const { Items: seguimientos = [] } = await dynamo.send(
    new QueryCommand({
      TableName: TABLA_SEGUIMIENTO,
      KeyConditionExpression: 'reporteId = :id',
      FilterExpression: 'visiblePublico = :si',
      ExpressionAttributeValues: { ':id': reporte.reporteId, ':si': true },
    }),
  );

  const indiceActual = LINEA_TIEMPO.indexOf(reporte.estatus);

  const lineaTiempo = LINEA_TIEMPO.map((etapa, i) => ({
    etapa,
    alcanzada: indiceActual >= 0 && i <= indiceActual,
    actual: etapa === reporte.estatus,
  }));

  await auditar({
    accion: 'ESTATUS_CONSULTADO',
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
  });

  return ok(
    {
      reporteId: reporte.reporteId,
      estatus: reporte.estatus,
      descripcionEstatus: DESCRIPCION_ESTATUS[reporte.estatus] || 'Estatus en revision.',
      fechaCreacion: reporte.fechaCreacion,
      actualizadoEn: reporte.actualizadoEn,
      categoriaTrabajo: reporte.categoriaTrabajo,
      zonaGeografica: reporte.zonaGeografica,
      // El caso descartado no forma parte de la linea de tiempo lineal.
      descartado: reporte.estatus === 'descartado',
      lineaTiempo,
      acciones: seguimientos
        .map((s) => ({ fecha: s.fecha, descripcion: s.descripcionPublica || s.tipoAccion }))
        .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))),
    },
    evento,
  );
});
