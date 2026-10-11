// Reglas de negocio del sistema. Vive aparte de los handlers para poder
// probarlas sin simular API Gateway.

export const CATEGORIAS = [
  'VENTA_AMBULANTE',
  'LIMPIA_PARABRISAS',
  'CARGA_MERCANCIA',
  'TRABAJO_DOMESTICO',
  'MENDICIDAD',
  'RECOLECCION_BASURA',
  'TRABAJO_AGRICOLA',
  'COMERCIO_ESTABLECIDO',
  'ESPECTACULO_CALLEJERO',
  'EXPLOTACION_SEXUAL',
  'ACTIVIDAD_ILICITA',
  'OTRO',
];

export const EDADES = ['0-5', '6-9', '10-13', '14-17', 'no_especificada'];

export const LUGARES = ['calle', 'mercado', 'crucero', 'transporte', 'comercio', 'otro'];

export const ESTATUS = [
  'nuevo',
  'en_revision',
  'asignado',
  'en_seguimiento',
  'resuelto',
  'descartado',
];

export const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

export const TURNOS = ['matutino', 'vespertino', 'nocturno'];

// Categorias que disparan el topic de urgencia y la alarma de CloudWatch.
export const CATEGORIAS_URGENTES = ['EXPLOTACION_SEXUAL', 'ACTIVIDAD_ILICITA'];

// Categorias que por si solas elevan a prioridad alta.
const CATEGORIAS_ALTAS = ['MENDICIDAD', 'TRABAJO_DOMESTICO'];

/**
 * Clasifica la prioridad de un reporte recien capturado.
 * La prioridad "baja" nunca se asigna automaticamente: solo un operador puede
 * degradar un caso tras revisarlo.
 */
export function clasificarPrioridad({ categoriaTrabajo, edadEstimada, cantidadNNA }) {
  if (CATEGORIAS_URGENTES.includes(categoriaTrabajo)) return 'urgente';

  const primeraInfancia = edadEstimada === '0-5';
  const grupoGrande = Number(cantidadNNA) > 3;
  if (CATEGORIAS_ALTAS.includes(categoriaTrabajo) || primeraInfancia || grupoGrande) {
    return 'alta';
  }

  return 'media';
}

/**
 * Lectura compatible de la cantidad de ninas, ninos y adolescentes.
 * Los reportes guardados antes del cambio de terminologia llevan el atributo
 * con el nombre anterior; se leen los dos hasta que corra la migracion, y
 * despues basta con quitar el segundo termino.
 */
export function cantidadNNADe(reporte) {
  return Number(reporte?.cantidadNNA ?? reporte?.cantidadMenores) || 0;
}

/** Transiciones de estatus permitidas. "resuelto" es terminal. */
export const TRANSICIONES = {
  nuevo: ['en_revision', 'descartado'],
  en_revision: ['asignado', 'descartado'],
  asignado: ['en_seguimiento', 'en_revision'],
  en_seguimiento: ['resuelto', 'asignado', 'descartado'],
  descartado: ['en_revision'],
  resuelto: [],
};

export function transicionValida(desde, hacia) {
  return (TRANSICIONES[desde] || []).includes(hacia);
}

/**
 * Turno en que se levanto el reporte, en hora local de la Ciudad de Mexico.
 * matutino 6-14, vespertino 14-20, nocturno 20-6.
 */
export function calcularTurno(fecha = new Date()) {
  const hora = Number(
    new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(fecha),
  ) % 24;

  if (hora >= 6 && hora < 14) return 'matutino';
  if (hora >= 14 && hora < 20) return 'vespertino';
  return 'nocturno';
}

/**
 * Zona geografica para el GSI: se prefiere el codigo postal porque es estable;
 * la colonia se normaliza cuando no hay CP.
 */
export function calcularZona(ubicacion = {}) {
  const cp = String(ubicacion.cp || '').trim();
  if (/^\d{5}$/.test(cp)) return `ATIZAPAN-${cp}`;

  const colonia = String(ubicacion.colonia || '').trim();
  if (colonia) {
    const normalizada = colonia
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (normalizada) return `ATIZAPAN-${normalizada}`;
  }

  return 'ATIZAPAN-SIN-ZONA';
}

/** Permisos efectivos por grupo de Cognito. */
export const PERMISOS = {
  operador: ['reportes:ver', 'reportes:actualizar', 'notas:agregar', 'seguimiento:agregar'],
  supervisor: [
    'reportes:ver',
    'reportes:actualizar',
    'notas:agregar',
    'seguimiento:agregar',
    'reportes:asignar',
    'estadisticas:ver',
  ],
  directivo: [
    'reportes:ver',
    'reportes:actualizar',
    'notas:agregar',
    'seguimiento:agregar',
    'reportes:asignar',
    'estadisticas:ver',
    'datos:exportar',
    'usuarios:gestionar',
    'auditoria:ver',
  ],
};

export function permisosDe(grupos = []) {
  const conjunto = new Set();
  for (const grupo of grupos) {
    for (const permiso of PERMISOS[grupo] || []) conjunto.add(permiso);
  }
  return [...conjunto];
}
