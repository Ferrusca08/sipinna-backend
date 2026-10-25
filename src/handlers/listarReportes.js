import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_REPORTES } from '../lib/aws.js';
import { ok, leerQuery, manejar } from '../lib/respuesta.js';
import { identidad, exigir } from '../lib/auth.js';
import { validarRangoFechas } from '../lib/validacion.js';
import { codificarCursor, decodificarCursor, sinDatosPersonales } from '../lib/reportes.js';

const LIMITE_POR_DEFECTO = 25;
const LIMITE_MAXIMO = 100;

// Cada filtro con GSI propio; el orden define cual gana si vienen varios.
const INDICES = [
  { parametro: 'estatus', indice: 'estatus-fecha-index', clave: 'estatus' },
  { parametro: 'prioridad', indice: 'prioridad-fecha-index', clave: 'prioridad' },
  { parametro: 'zona', indice: 'zona-fecha-index', clave: 'zonaGeografica' },
  { parametro: 'operador', indice: 'operador-fecha-index', clave: 'operadorAsignado' },
];

/**
 * GET /admin/reportes
 *
 * Listado paginado. Cuando el filtro principal coincide con un GSI se hace
 * Query sobre ese indice; el resto de filtros se aplican como FilterExpression.
 * Sin ningun filtro indexado cae a Scan, que es aceptable al volumen de un
 * municipio pero no a escala estatal.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'reportes:ver');

  const q = leerQuery(evento);
  const { desde, hasta } = validarRangoFechas(q.desde, q.hasta);

  const limite = Math.min(Number(q.limite) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
  const cursor = decodificarCursor(q.cursor);

  const indiceElegido = INDICES.find((i) => q[i.parametro]);

  const nombres = {};
  const valores = {};
  // Los eliminados no se listan. El atributo solo existe en los borrados, asi
  // que basta comprobar su ausencia y no hace falta migrar los reportes viejos.
  const filtros = ['attribute_not_exists(eliminado)'];

  // Filtros que no van en la condicion de clave.
  for (const { parametro, clave } of INDICES) {
    if (!q[parametro]) continue;
    if (indiceElegido && indiceElegido.parametro === parametro) continue;
    nombres[`#${clave}`] = clave;
    valores[`:${clave}`] = q[parametro];
    filtros.push(`#${clave} = :${clave}`);
  }

  if (q.categoria) {
    nombres['#categoriaTrabajo'] = 'categoriaTrabajo';
    valores[':categoriaTrabajo'] = q.categoria;
    filtros.push('#categoriaTrabajo = :categoriaTrabajo');
  }

  let respuesta;

  if (indiceElegido) {
    const condiciones = [`#pk = :pk`];
    nombres['#pk'] = indiceElegido.clave;
    valores[':pk'] = q[indiceElegido.parametro];

    if (desde && hasta) {
      condiciones.push('#fecha BETWEEN :desde AND :hasta');
      nombres['#fecha'] = 'fechaCreacion';
      valores[':desde'] = desde;
      valores[':hasta'] = hasta;
    } else if (desde) {
      condiciones.push('#fecha >= :desde');
      nombres['#fecha'] = 'fechaCreacion';
      valores[':desde'] = desde;
    } else if (hasta) {
      condiciones.push('#fecha <= :hasta');
      nombres['#fecha'] = 'fechaCreacion';
      valores[':hasta'] = hasta;
    }

    respuesta = await dynamo.send(
      new QueryCommand({
        TableName: TABLA_REPORTES,
        IndexName: indiceElegido.indice,
        KeyConditionExpression: condiciones.join(' AND '),
        ExpressionAttributeNames: nombres,
        ExpressionAttributeValues: valores,
        FilterExpression: filtros.length ? filtros.join(' AND ') : undefined,
        // Mas reciente primero.
        ScanIndexForward: false,
        Limit: limite,
        ExclusiveStartKey: cursor,
      }),
    );
  } else {
    if (desde) {
      nombres['#fecha'] = 'fechaCreacion';
      valores[':desde'] = desde;
      filtros.push('#fecha >= :desde');
    }
    if (hasta) {
      nombres['#fecha'] = 'fechaCreacion';
      valores[':hasta'] = hasta;
      filtros.push('#fecha <= :hasta');
    }

    respuesta = await dynamo.send(
      new ScanCommand({
        TableName: TABLA_REPORTES,
        FilterExpression: filtros.length ? filtros.join(' AND ') : undefined,
        ExpressionAttributeNames: Object.keys(nombres).length ? nombres : undefined,
        ExpressionAttributeValues: Object.keys(valores).length ? valores : undefined,
        Limit: limite,
        ExclusiveStartKey: cursor,
      }),
    );
  }

  let items = respuesta.Items || [];

  // Busqueda libre sobre la pagina ya recuperada.
  if (q.buscar) {
    const termino = String(q.buscar).toLowerCase();
    items = items.filter(
      (r) =>
        String(r.reporteId).toLowerCase().includes(termino) ||
        String(r.descripcion).toLowerCase().includes(termino) ||
        String(r.ubicacion?.direccion || '').toLowerCase().includes(termino) ||
        String(r.ubicacion?.colonia || '').toLowerCase().includes(termino),
    );
  }

  if (!indiceElegido) {
    items.sort((a, b) => String(b.fechaCreacion).localeCompare(String(a.fechaCreacion)));
  }

  // El operador raso no necesita ver los datos del reportante en el listado.
  const puedeVerContacto = usuario.grupos.includes('supervisor') || usuario.grupos.includes('directivo');
  const salida = puedeVerContacto ? items : items.map(sinDatosPersonales);

  return ok(
    {
      items: salida,
      cursor: codificarCursor(respuesta.LastEvaluatedKey),
      hayMas: Boolean(respuesta.LastEvaluatedKey),
      conteo: salida.length,
    },
    evento,
  );
});
