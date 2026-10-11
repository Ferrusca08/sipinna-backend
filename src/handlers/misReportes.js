import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_REPORTES } from '../lib/aws.js';
import { ok, leerQuery, manejar, ErrorHttp } from '../lib/respuesta.js';
import { codificarCursor, decodificarCursor } from '../lib/reportes.js';
import { cantidadNNADe } from '../lib/dominio.js';

const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 50;

/**
 * Campos que ve quien reporta sobre sus propios casos.
 *
 * Deliberadamente NO se devuelve el seguimiento interno, las notas del
 * operador ni el operador asignado: son trabajo interno de SIPINNA y quien
 * reporta no es parte de el. Tampoco el contacto, que ya es suyo y no aporta
 * nada de vuelta.
 */
function aVistaCiudadana(reporte) {
  return {
    reporteId: reporte.reporteId,
    fechaCreacion: reporte.fechaCreacion,
    estatus: reporte.estatus,
    categoriaTrabajo: reporte.categoriaTrabajo,
    descripcion: reporte.descripcion,
    cantidadNNA: cantidadNNADe(reporte),
    edadEstimada: reporte.edadEstimada,
    lugarEspecifico: reporte.lugarEspecifico,
    zonaGeografica: reporte.zonaGeografica,
    colonia: reporte.ubicacion?.colonia ?? '',
    totalEvidencia: Array.isArray(reporte.evidenciaUrls) ? reporte.evidenciaUrls.length : 0,
    actualizadoEn: reporte.actualizadoEn,
  };
}

/**
 * GET /mis-reportes
 *
 * Los reportes creados desde la cuenta que hace la peticion. El filtro no es
 * un parametro: sale del "sub" que API Gateway ya valido contra el pool de
 * ciudadania, de modo que no hay forma de pedir los reportes de otra persona.
 * Los reportes anonimos no tienen reportanteId y por eso nunca aparecen aqui,
 * ni siquiera para quien los envio.
 */
export const handler = manejar(async (evento) => {
  const sub = evento?.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!sub) {
    throw new ErrorHttp(401, 'Inicia sesion para ver tus reportes.');
  }

  const q = leerQuery(evento);
  const limite = Math.min(Number(q.limite) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);

  const { Items, LastEvaluatedKey } = await dynamo.send(
    new QueryCommand({
      TableName: TABLA_REPORTES,
      IndexName: 'reportante-fecha-index',
      KeyConditionExpression: 'reportanteId = :sub',
      ExpressionAttributeValues: { ':sub': sub },
      // Del mas reciente al mas antiguo: es el orden en que la gente los busca.
      ScanIndexForward: false,
      Limit: limite,
      ExclusiveStartKey: decodificarCursor(q.cursor),
    }),
  );

  return ok(
    {
      reportes: (Items ?? []).map(aVistaCiudadana),
      cursor: codificarCursor(LastEvaluatedKey),
      hayMas: Boolean(LastEvaluatedKey),
    },
    evento,
  );
});
