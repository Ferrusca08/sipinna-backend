import { ErrorHttp } from './respuesta.js';
import { permisosDe } from './dominio.js';

/**
 * Extrae la identidad del claim JWT que API Gateway ya valido.
 * No se vuelve a verificar la firma: el autorizador rechaza la peticion antes
 * de llegar aqui, asi que los claims son de confianza.
 */
export function identidad(evento) {
  const claims = evento?.requestContext?.authorizer?.jwt?.claims;
  if (!claims) {
    throw new ErrorHttp(401, 'La peticion no incluye un token valido.');
  }

  // cognito:groups llega como arreglo o como cadena "[a b]" segun el caso.
  let grupos = claims['cognito:groups'] ?? [];
  if (typeof grupos === 'string') {
    grupos = grupos.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }

  return {
    userId: claims.sub,
    email: claims.email || claims['cognito:username'] || 'desconocido',
    nombre: claims['custom:full_name'] || claims.email || 'Sin nombre',
    grupos,
    permisos: permisosDe(grupos),
  };
}

/** Corta la ejecucion si al usuario le falta el permiso indicado. */
export function exigir(usuario, permiso) {
  if (!usuario.permisos.includes(permiso)) {
    throw new ErrorHttp(
      403,
      'No tienes permisos para realizar esta accion.',
      { permisoRequerido: permiso, tusGrupos: usuario.grupos },
    );
  }
}

export function tienePermiso(usuario, permiso) {
  return usuario.permisos.includes(permiso);
}

/** IP del ciudadano o del operador, para la bitacora de auditoria. */
export function ipOrigen(evento) {
  return evento?.requestContext?.http?.sourceIp || 'desconocida';
}
