import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLA_REPORTES } from './aws.js';
import { ErrorHttp } from './respuesta.js';

/**
 * Recupera un reporte por su token. La tabla tiene clave compuesta
 * (reporteId, fechaCreacion) y el ciudadano solo conoce el reporteId, asi que
 * se resuelve con un Query de una sola particion en lugar de un GetItem.
 */
export async function obtenerPorId(reporteId) {
  if (!reporteId) throw new ErrorHttp(400, 'Falta el identificador del reporte.');

  const { Items } = await dynamo.send(
    new QueryCommand({
      TableName: TABLA_REPORTES,
      KeyConditionExpression: 'reporteId = :id',
      ExpressionAttributeValues: { ':id': reporteId },
      Limit: 1,
    }),
  );

  if (!Items || Items.length === 0) {
    throw new ErrorHttp(404, 'No encontramos ningun reporte con ese codigo de seguimiento.');
  }

  return Items[0];
}

/** Codifica el cursor de paginacion de DynamoDB para viajar por query string. */
export function codificarCursor(lastKey) {
  if (!lastKey) return null;
  return Buffer.from(JSON.stringify(lastKey), 'utf8').toString('base64url');
}

export function decodificarCursor(cursor) {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ErrorHttp(400, 'El cursor de paginacion es invalido.');
  }
}

/**
 * Recorre la tabla completa aplicando un filtro en memoria.
 * Se usa solo en estadisticas, heatmap y exportacion, donde hace falta el
 * universo entero y no un listado paginado.
 */
export async function recorrerTodos({ desde, hasta, limiteSeguridad = 20000 } = {}) {
  const items = [];
  let cursor;

  do {
    const params = {
      TableName: TABLA_REPORTES,
      ExclusiveStartKey: cursor,
    };

    const filtros = [];
    const valores = {};
    if (desde) {
      filtros.push('fechaCreacion >= :desde');
      valores[':desde'] = desde;
    }
    if (hasta) {
      filtros.push('fechaCreacion <= :hasta');
      valores[':hasta'] = hasta;
    }
    if (filtros.length) {
      params.FilterExpression = filtros.join(' AND ');
      params.ExpressionAttributeValues = valores;
    }

    const respuesta = await dynamo.send(new ScanCommand(params));
    items.push(...(respuesta.Items || []));
    cursor = respuesta.LastEvaluatedKey;
  } while (cursor && items.length < limiteSeguridad);

  return items;
}

/** Quita del reporte los datos personales del reportante. */
export function sinDatosPersonales(reporte) {
  const { contactoReportante, reportanteId, ...resto } = reporte;
  return { ...resto, anonimo: !contactoReportante };
}
