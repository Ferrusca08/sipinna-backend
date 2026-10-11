import { ok, leerQuery, manejar } from '../lib/respuesta.js';
import { identidad, exigir } from '../lib/auth.js';
import { validarRangoFechas } from '../lib/validacion.js';
import { recorrerTodos } from '../lib/reportes.js';
import { cantidadNNADe } from '../lib/dominio.js';
import { CATEGORIAS, EDADES, ESTATUS, PRIORIDADES, TURNOS } from '../lib/dominio.js';

const DIA_MS = 24 * 60 * 60 * 1000;

function contarPor(items, obtenerClave, clavesBase = []) {
  const conteo = Object.fromEntries(clavesBase.map((c) => [c, 0]));
  for (const item of items) {
    const clave = obtenerClave(item) ?? 'sin_dato';
    conteo[clave] = (conteo[clave] || 0) + 1;
  }
  return Object.entries(conteo)
    .map(([clave, total]) => ({ clave, total }))
    .sort((a, b) => b.total - a.total);
}

/** Serie diaria de reportes entre dos fechas, incluyendo dias en cero. */
function serieTemporal(items, desde, hasta) {
  const porDia = new Map();
  for (const item of items) {
    const dia = String(item.fechaCreacion).slice(0, 10);
    porDia.set(dia, (porDia.get(dia) || 0) + 1);
  }

  const inicio = desde ? new Date(desde) : new Date(Date.now() - 29 * DIA_MS);
  const fin = hasta ? new Date(hasta) : new Date();

  const serie = [];
  for (let t = inicio.getTime(); t <= fin.getTime(); t += DIA_MS) {
    const dia = new Date(t).toISOString().slice(0, 10);
    serie.push({ fecha: dia, total: porDia.get(dia) || 0 });
    // Corta series absurdamente largas por si el rango viene mal.
    if (serie.length > 400) break;
  }
  return serie;
}

/** Compara los ultimos 30 dias contra los 30 previos. */
function calcularTendencia(items) {
  const ahora = Date.now();
  const corte = ahora - 30 * DIA_MS;
  const corteAnterior = ahora - 60 * DIA_MS;

  let recientes = 0;
  let previos = 0;
  for (const item of items) {
    const t = new Date(item.fechaCreacion).getTime();
    if (t >= corte) recientes++;
    else if (t >= corteAnterior) previos++;
  }

  const variacion = previos === 0
    ? (recientes > 0 ? 100 : 0)
    : Math.round(((recientes - previos) / previos) * 1000) / 10;

  return {
    ultimos30dias: recientes,
    periodoAnterior: previos,
    variacionPorcentual: variacion,
    direccion: variacion > 0 ? 'alza' : variacion < 0 ? 'baja' : 'estable',
  };
}

/** Promedio de horas entre creacion y ultima actualizacion de los casos cerrados. */
function tiempoPromedioResolucion(items) {
  const cerrados = items.filter((r) => r.estatus === 'resuelto' && r.actualizadoEn);
  if (cerrados.length === 0) return null;

  const horas = cerrados.map(
    (r) => (new Date(r.actualizadoEn).getTime() - new Date(r.fechaCreacion).getTime()) / 3600000,
  );
  const promedio = horas.reduce((a, b) => a + b, 0) / horas.length;
  return Math.round(promedio * 10) / 10;
}

/**
 * GET /admin/estadisticas
 *
 * Metricas agregadas del tablero. Recorre la tabla completa dentro del rango
 * pedido: al volumen de reportes de un municipio es mas simple y barato que
 * mantener contadores materializados.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'estadisticas:ver');

  const q = leerQuery(evento);
  const { desde, hasta } = validarRangoFechas(q.desde, q.hasta);

  const items = await recorrerTodos({ desde, hasta });

  const abiertos = items.filter((r) => !['resuelto', 'descartado'].includes(r.estatus));
  const urgentes = items.filter((r) => r.prioridad === 'urgente');
  const sinAsignar = items.filter((r) => !r.operadorAsignado || r.operadorAsignado === 'SIN_ASIGNAR');

  return ok(
    {
      resumen: {
        total: items.length,
        abiertos: abiertos.length,
        urgentes: urgentes.length,
        sinAsignar: sinAsignar.length,
        resueltos: items.filter((r) => r.estatus === 'resuelto').length,
        descartados: items.filter((r) => r.estatus === 'descartado').length,
        nnaInvolucrados: items.reduce((suma, r) => suma + cantidadNNADe(r), 0),
      },
      porCategoria: contarPor(items, (r) => r.categoriaTrabajo, CATEGORIAS),
      porPrioridad: contarPor(items, (r) => r.prioridad, PRIORIDADES),
      porEstatus: contarPor(items, (r) => r.estatus, ESTATUS),
      porTurno: contarPor(items, (r) => r.turnoReporte, TURNOS),
      porZona: contarPor(items, (r) => r.zonaGeografica).slice(0, 20),
      porEdad: contarPor(items, (r) => r.edadEstimada, EDADES),
      porLugar: contarPor(items, (r) => r.lugarEspecifico),
      serieTemporal: serieTemporal(items, desde, hasta),
      tendencia: calcularTendencia(items),
      rendimiento: {
        horasPromedioResolucion: tiempoPromedioResolucion(items),
        tasaResolucion: items.length
          ? Math.round((items.filter((r) => r.estatus === 'resuelto').length / items.length) * 1000) / 10
          : 0,
        cargaPorOperador: contarPor(
          items.filter((r) => r.operadorAsignado && r.operadorAsignado !== 'SIN_ASIGNAR'),
          (r) => r.operadorAsignado,
        ),
      },
      generadoEn: new Date().toISOString(),
    },
    evento,
  );
});
