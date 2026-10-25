import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Identidad ciudadana en rutas que NO pasan por el autorizador.
 *
 * POST /reportes tiene que seguir abierto: denunciar sin cuenta es el camino
 * principal y no se puede condicionar. Pero cuando la peticion si trae sesion,
 * conviene amarrar el reporte a esa persona para que luego pueda seguirlo.
 * API Gateway no sabe hacer un JWT opcional por ruta, asi que la verificacion
 * se hace aqui, con las mismas reglas que aplicaria el autorizador.
 *
 * El verificador cachea las llaves publicas del pool entre invocaciones, asi
 * que el costo real es una sola descarga por contenedor tibio.
 */
let verificador = null;

/**
 * Construye el verificador la primera vez que hace falta, y no al cargar el
 * modulo.
 *
 * CognitoJwtVerifier.create() valida sus parametros de inmediato y lanza si el
 * identificador del pool viene vacio. Al construirlo arriba, una lambda que solo
 * queria dar de alta un reporte moria durante el import y el API respondia 500
 * aunque la peticion fuera anonima y no necesitara verificar nada.
 */
function obtenerVerificador() {
  if (verificador) return verificador;

  verificador = CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID_CIUDADANIA,
    tokenUse: 'access',
    clientId: process.env.COGNITO_CLIENT_ID_CIUDADANIA,
  });
  return verificador;
}

/**
 * Devuelve el "sub" de la persona autenticada, o null si la peticion es
 * anonima o el token no resiste la verificacion.
 *
 * Nunca lanza: un token vencido o manipulado degrada el reporte a anonimo en
 * lugar de rechazarlo. Perder la trazabilidad de un reporte es mucho menos
 * grave que perder el reporte.
 */
export async function identidadCiudadanaOpcional(evento) {
  if (!process.env.USER_POOL_ID_CIUDADANIA) return null;

  const encabezados = evento?.headers ?? {};
  // API Gateway normaliza los nombres a minusculas, pero no cuesta cubrir ambos.
  const bruto = encabezados.authorization ?? encabezados.Authorization;
  if (!bruto) return null;

  const token = bruto.startsWith('Bearer ') ? bruto.slice(7).trim() : bruto.trim();
  if (!token) return null;

  try {
    const claims = await obtenerVerificador().verify(token);
    return claims.sub ?? null;
  } catch (e) {
    console.warn(JSON.stringify({
      nivel: 'aviso',
      mensaje: 'Token ciudadano no valido; el reporte se guarda como anonimo',
      detalle: String(e?.message ?? e),
    }));
    return null;
  }
}
