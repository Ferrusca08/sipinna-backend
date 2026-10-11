import { ErrorHttp } from './respuesta.js';
import { CATEGORIAS, EDADES, LUGARES } from './dominio.js';

// Caja aproximada del Valle de Mexico. Un reporte fuera de este rango casi
// siempre es un GPS mal fijado, no un caso real fuera del municipio.
const LAT_MIN = 19.0;
const LAT_MAX = 20.0;
const LNG_MIN = -99.8;
const LNG_MAX = -98.5;

export const MAX_EVIDENCIAS = 5;

function agregar(errores, campo, mensaje) {
  errores.push({ campo, mensaje });
}

/**
 * Valida el payload de creacion de reporte y devuelve una version normalizada.
 * Lanza ErrorHttp 400 con el detalle de todos los campos invalidos a la vez,
 * para que la app pueda pintar el formulario completo en un solo viaje.
 */
export function validarReporte(cuerpo) {
  const errores = [];

  // --- Descripcion -------------------------------------------------------
  const descripcion = String(cuerpo.descripcion ?? '').trim();
  if (descripcion.length < 10 || descripcion.length > 2000) {
    agregar(errores, 'descripcion', 'La descripcion debe tener entre 10 y 2000 caracteres.');
  }

  // --- Categoria ---------------------------------------------------------
  const categoriaTrabajo = String(cuerpo.categoriaTrabajo ?? '').trim().toUpperCase();
  if (!CATEGORIAS.includes(categoriaTrabajo)) {
    agregar(errores, 'categoriaTrabajo', `Categoria invalida. Valores: ${CATEGORIAS.join(', ')}.`);
  }

  // --- Edad estimada -----------------------------------------------------
  const edadEstimada = String(cuerpo.edadEstimada ?? 'no_especificada').trim();
  if (!EDADES.includes(edadEstimada)) {
    agregar(errores, 'edadEstimada', `Rango de edad invalido. Valores: ${EDADES.join(', ')}.`);
  }

  // --- Cantidad de ninas, ninos y adolescentes ---------------------------
  // Se acepta tambien el nombre anterior del campo: las APK ya instaladas
  // siguen enviando "cantidadMenores" y no se les puede forzar a actualizar.
  const cantidadNNA = Number(cuerpo.cantidadNNA ?? cuerpo.cantidadMenores ?? 1);
  if (!Number.isInteger(cantidadNNA) || cantidadNNA < 1 || cantidadNNA > 50) {
    agregar(
      errores,
      'cantidadNNA',
      'La cantidad de ninas, ninos y adolescentes debe ser un entero entre 1 y 50.',
    );
  }

  // --- Ubicacion ---------------------------------------------------------
  const ubicacionEntrada = cuerpo.ubicacion ?? {};
  const lat = Number(ubicacionEntrada.lat);
  const lng = Number(ubicacionEntrada.lng);

  if (!Number.isFinite(lat) || lat < LAT_MIN || lat > LAT_MAX) {
    agregar(errores, 'ubicacion.lat', `La latitud debe estar entre ${LAT_MIN} y ${LAT_MAX}.`);
  }
  if (!Number.isFinite(lng) || lng < LNG_MIN || lng > LNG_MAX) {
    agregar(errores, 'ubicacion.lng', `La longitud debe estar entre ${LNG_MIN} y ${LNG_MAX}.`);
  }

  const cp = String(ubicacionEntrada.cp ?? '').trim();
  if (cp && !/^\d{5}$/.test(cp)) {
    agregar(errores, 'ubicacion.cp', 'El codigo postal debe tener 5 digitos.');
  }

  const ubicacion = {
    lat,
    lng,
    direccion: String(ubicacionEntrada.direccion ?? '').trim().slice(0, 300),
    cp,
    colonia: String(ubicacionEntrada.colonia ?? '').trim().slice(0, 120),
  };

  // --- Lugar especifico --------------------------------------------------
  const lugarEspecifico = String(cuerpo.lugarEspecifico ?? 'otro').trim().toLowerCase();
  if (!LUGARES.includes(lugarEspecifico)) {
    agregar(errores, 'lugarEspecifico', `Lugar invalido. Valores: ${LUGARES.join(', ')}.`);
  }

  // --- Contacto (opcional: el reporte puede ser anonimo) -----------------
  let contactoReportante = null;
  if (cuerpo.contactoReportante && typeof cuerpo.contactoReportante === 'object') {
    const { nombre = '', telefono = '', email = '' } = cuerpo.contactoReportante;
    const tel = String(telefono).replace(/\D/g, '');
    const correo = String(email).trim();

    if (tel && tel.length !== 10) {
      agregar(errores, 'contactoReportante.telefono', 'El telefono debe tener 10 digitos.');
    }
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
      agregar(errores, 'contactoReportante.email', 'El correo no tiene un formato valido.');
    }

    // Un objeto de contacto totalmente vacio equivale a reporte anonimo.
    if (String(nombre).trim() || tel || correo) {
      contactoReportante = {
        nombre: String(nombre).trim().slice(0, 120),
        telefono: tel,
        email: correo.slice(0, 160),
      };
    }
  }

  // --- Evidencia ---------------------------------------------------------
  const cantidadEvidencia = Number(cuerpo.cantidadEvidencia ?? 0);
  if (!Number.isInteger(cantidadEvidencia) || cantidadEvidencia < 0 || cantidadEvidencia > MAX_EVIDENCIAS) {
    agregar(
      errores,
      'cantidadEvidencia',
      `Se permiten como maximo ${MAX_EVIDENCIAS} archivos de evidencia por reporte.`,
    );
  }

  if (errores.length) {
    throw new ErrorHttp(400, 'El reporte tiene campos invalidos.', errores);
  }

  return {
    descripcion,
    categoriaTrabajo,
    edadEstimada,
    cantidadNNA,
    ubicacion,
    lugarEspecifico,
    contactoReportante,
    cantidadEvidencia,
  };
}

/** Valida el numero de archivos pedidos para una solicitud de presigned URLs. */
export function validarSolicitudEvidencia(cuerpo, yaSubidas = 0) {
  const cantidad = Number(cuerpo.cantidad ?? 1);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_EVIDENCIAS) {
    throw new ErrorHttp(400, `La cantidad debe ser un entero entre 1 y ${MAX_EVIDENCIAS}.`);
  }
  if (yaSubidas + cantidad > MAX_EVIDENCIAS) {
    throw new ErrorHttp(
      400,
      `El reporte ya tiene ${yaSubidas} archivos; el maximo permitido es ${MAX_EVIDENCIAS}.`,
    );
  }

  const tipos = Array.isArray(cuerpo.tiposContenido) ? cuerpo.tiposContenido : [];
  const permitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
  for (const tipo of tipos) {
    if (!permitidos.includes(tipo)) {
      throw new ErrorHttp(400, `Tipo de archivo no permitido: ${tipo}.`);
    }
  }

  return { cantidad, tiposContenido: tipos };
}

/** Normaliza un rango de fechas ISO recibido por query string. */
export function validarRangoFechas(desde, hasta) {
  const salida = {};
  if (desde) {
    const d = new Date(desde);
    if (Number.isNaN(d.getTime())) throw new ErrorHttp(400, 'El parametro "desde" no es una fecha valida.');
    salida.desde = d.toISOString();
  }
  if (hasta) {
    const h = new Date(hasta);
    if (Number.isNaN(h.getTime())) throw new ErrorHttp(400, 'El parametro "hasta" no es una fecha valida.');
    salida.hasta = h.toISOString();
  }
  if (salida.desde && salida.hasta && salida.desde > salida.hasta) {
    throw new ErrorHttp(400, 'El rango de fechas esta invertido.');
  }
  return salida;
}
