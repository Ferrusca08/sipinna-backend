import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, TABLA_AUDITLOG } from './aws.js';
import { ulid } from './ulid.js';

const UN_ANIO_EN_SEGUNDOS = 365 * 24 * 60 * 60;

/**
 * Registra una accion en la bitacora de auditoria.
 *
 * Nunca lanza: si la auditoria falla no debe tumbar la operacion del usuario,
 * pero si queda el error en los logs de la funcion para investigarlo.
 */
export async function auditar({
  accion,
  userId = 'anonimo',
  email = 'anonimo',
  recursoId = null,
  detalles = {},
  ip = 'desconocida',
  exitoso = true,
}) {
  const ahora = new Date();

  try {
    await dynamo.send(
      new PutCommand({
        TableName: TABLA_AUDITLOG,
        Item: {
          logId: ulid(ahora.getTime()),
          timestamp: ahora.toISOString(),
          accion,
          userId,
          email,
          recursoId,
          detalles,
          ip,
          exitoso,
          expiraEn: Math.floor(ahora.getTime() / 1000) + UN_ANIO_EN_SEGUNDOS,
        },
      }),
    );
  } catch (e) {
    console.error(
      JSON.stringify({ nivel: 'error', mensaje: 'No se pudo escribir la auditoria', accion, detalle: e.message }),
    );
  }
}
