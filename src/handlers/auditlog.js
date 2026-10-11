import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_AUDITLOG } from '../lib/aws.js';
import { ok, leerQuery, manejar } from '../lib/respuesta.js';
import { identidad, exigir } from '../lib/auth.js';
import { validarRangoFechas } from '../lib/validacion.js';
import { codificarCursor, decodificarCursor } from '../lib/reportes.js';

const LIMITE_MAXIMO = 200;

/**
 * GET /admin/auditlog
 *
 * Consulta de la bitacora de auditoria. Con userId usa el GSI; sin el, recorre
 * la tabla. Los registros caducan solos por TTL al ano.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'auditoria:ver');

  const q = leerQuery(evento);
  const { desde, hasta } = validarRangoFechas(q.desde, q.hasta);
  const limite = Math.min(Number(q.limite) || 50, LIMITE_MAXIMO);
  const cursor = decodificarCursor(q.cursor);

  // "timestamp" es palabra reservada en DynamoDB, asi que va por alias. El
  // alias solo se registra cuando alguna expresion lo usa: DynamoDB rechaza la
  // peticion completa si sobra un nombre en ExpressionAttributeNames.
  const nombres = {};
  const valores = {};
  const filtros = [];

  const usarAliasFecha = () => {
    nombres['#ts'] = 'timestamp';
  };

  if (q.accion) {
    nombres['#accion'] = 'accion';
    valores[':accion'] = q.accion;
    filtros.push('#accion = :accion');
  }

  if (q.recursoId) {
    nombres['#recursoId'] = 'recursoId';
    valores[':recursoId'] = q.recursoId;
    filtros.push('#recursoId = :recursoId');
  }

  let respuesta;

  if (q.userId) {
    const condiciones = ['#userId = :userId'];
    nombres['#userId'] = 'userId';
    valores[':userId'] = q.userId;

    if (desde && hasta) {
      usarAliasFecha();
      condiciones.push('#ts BETWEEN :desde AND :hasta');
      valores[':desde'] = desde;
      valores[':hasta'] = hasta;
    } else if (desde) {
      usarAliasFecha();
      condiciones.push('#ts >= :desde');
      valores[':desde'] = desde;
    } else if (hasta) {
      usarAliasFecha();
      condiciones.push('#ts <= :hasta');
      valores[':hasta'] = hasta;
    }

    respuesta = await dynamo.send(
      new QueryCommand({
        TableName: TABLA_AUDITLOG,
        IndexName: 'userId-timestamp-index',
        KeyConditionExpression: condiciones.join(' AND '),
        ExpressionAttributeNames: nombres,
        ExpressionAttributeValues: valores,
        FilterExpression: filtros.length ? filtros.join(' AND ') : undefined,
        ScanIndexForward: false,
        Limit: limite,
        ExclusiveStartKey: cursor,
      }),
    );
  } else {
    if (desde) {
      usarAliasFecha();
      valores[':desde'] = desde;
      filtros.push('#ts >= :desde');
    }
    if (hasta) {
      usarAliasFecha();
      valores[':hasta'] = hasta;
      filtros.push('#ts <= :hasta');
    }

    respuesta = await dynamo.send(
      new ScanCommand({
        TableName: TABLA_AUDITLOG,
        FilterExpression: filtros.length ? filtros.join(' AND ') : undefined,
        ExpressionAttributeNames: Object.keys(nombres).length ? nombres : undefined,
        ExpressionAttributeValues: Object.keys(valores).length ? valores : undefined,
        Limit: limite,
        ExclusiveStartKey: cursor,
      }),
    );
  }

  const items = (respuesta.Items || []).sort((a, b) =>
    String(b.timestamp).localeCompare(String(a.timestamp)),
  );

  return ok(
    {
      items,
      cursor: codificarCursor(respuesta.LastEvaluatedKey),
      hayMas: Boolean(respuesta.LastEvaluatedKey),
      conteo: items.length,
    },
    evento,
  );
});
