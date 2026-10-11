const ORIGENES = (process.env.CORS_ORIGENES || '*').split(',').map((o) => o.trim());

/**
 * Devuelve el origen que corresponde reflejar. Con la lista en "*" se responde
 * "*"; si hay lista blanca, solo se refleja un origen que este en ella.
 */
function resolverOrigen(evento) {
  if (ORIGENES.includes('*')) return '*';
  const solicitado = evento?.headers?.origin || evento?.headers?.Origin;
  return solicitado && ORIGENES.includes(solicitado) ? solicitado : ORIGENES[0];
}

export function encabezados(evento) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': resolverOrigen(evento),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function ok(cuerpo, evento, codigo = 200) {
  return {
    statusCode: codigo,
    headers: encabezados(evento),
    body: JSON.stringify(cuerpo),
  };
}

export function creado(cuerpo, evento) {
  return ok(cuerpo, evento, 201);
}

export function error(codigo, mensaje, evento, detalles) {
  return {
    statusCode: codigo,
    headers: encabezados(evento),
    body: JSON.stringify({
      error: true,
      mensaje,
      ...(detalles ? { detalles } : {}),
    }),
  };
}

/** Error de negocio con codigo HTTP, para lanzar desde cualquier capa. */
export class ErrorHttp extends Error {
  constructor(codigo, mensaje, detalles) {
    super(mensaje);
    this.codigo = codigo;
    this.detalles = detalles;
  }
}

/**
 * Envuelve un handler: parsea el body, atrapa errores y siempre responde JSON
 * con CORS. Evita repetir el mismo try/catch en las once funciones.
 */
export function manejar(fn) {
  return async (evento, contexto) => {
    try {
      return await fn(evento, contexto);
    } catch (e) {
      if (e instanceof ErrorHttp) {
        console.warn(JSON.stringify({ nivel: 'aviso', mensaje: e.message, detalles: e.detalles }));
        return error(e.codigo, e.message, evento, e.detalles);
      }
      console.error(JSON.stringify({ nivel: 'error', mensaje: e.message, stack: e.stack }));
      return error(500, 'Ocurrio un error interno. Intenta de nuevo mas tarde.', evento);
    }
  };
}

/** Lee el cuerpo JSON de un evento API Gateway v2 (payload 2.0). */
export function leerCuerpo(evento) {
  if (!evento?.body) return {};
  const crudo = evento.isBase64Encoded
    ? Buffer.from(evento.body, 'base64').toString('utf8')
    : evento.body;
  try {
    return JSON.parse(crudo);
  } catch {
    throw new ErrorHttp(400, 'El cuerpo de la peticion no es JSON valido.');
  }
}

/** Parametros de query string, siempre como objeto. */
export function leerQuery(evento) {
  return evento?.queryStringParameters || {};
}

/** Parametro de ruta por nombre. */
export function leerRuta(evento, nombre) {
  return evento?.pathParameters?.[nombre];
}
