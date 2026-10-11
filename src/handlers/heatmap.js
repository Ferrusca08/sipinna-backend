import { ok, leerQuery, manejar } from '../lib/respuesta.js';
import { identidad, exigir } from '../lib/auth.js';
import { validarRangoFechas } from '../lib/validacion.js';
import { recorrerTodos } from '../lib/reportes.js';
import { cantidadNNADe } from '../lib/dominio.js';

// Peso por prioridad: un caso urgente pinta mas fuerte que uno medio.
const PESO_PRIORIDAD = { urgente: 4, alta: 3, media: 2, baja: 1 };

// Un caso abierto pesa mas que uno ya cerrado.
const PESO_ESTATUS = { nuevo: 1.2, en_revision: 1.1, asignado: 1, en_seguimiento: 1, resuelto: 0.5, descartado: 0.2 };

const CENTRO_ATIZAPAN = { lat: 19.5588, lng: -99.2536 };

/**
 * GET /admin/estadisticas/heatmap
 *
 * Puntos ponderados para el mapa de calor. El peso combina prioridad, cantidad
 * de ninas, ninos y adolescentes, estatus y antiguedad, de modo que la mancha
 * refleje donde hay problema activo y no solo donde hubo reportes historicos.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'estadisticas:ver');

  const q = leerQuery(evento);
  const { desde, hasta } = validarRangoFechas(q.desde, q.hasta);

  const items = await recorrerTodos({ desde, hasta });
  const ahora = Date.now();
  const noventaDias = 90 * 24 * 60 * 60 * 1000;

  const puntos = items
    .filter((r) => Number.isFinite(Number(r.ubicacion?.lat)) && Number.isFinite(Number(r.ubicacion?.lng)))
    .filter((r) => (q.categoria ? r.categoriaTrabajo === q.categoria : true))
    .filter((r) => (q.prioridad ? r.prioridad === q.prioridad : true))
    .map((r) => {
      const base = PESO_PRIORIDAD[r.prioridad] || 1;
      const porEstatus = PESO_ESTATUS[r.estatus] ?? 1;
      // Cada nina, nino o adolescente adicional suma, pero con rendimientos
      // decrecientes.
      const porNNA = 1 + Math.log2(Math.max(1, cantidadNNADe(r) || 1));
      // Un caso de hace mas de 90 dias conserva la mitad de su peso.
      const antiguedad = (ahora - new Date(r.fechaCreacion).getTime()) / noventaDias;
      const porRecencia = Math.max(0.5, 1 - antiguedad * 0.5);

      const peso = Math.round(base * porEstatus * porNNA * porRecencia * 100) / 100;

      return {
        lat: Number(r.ubicacion.lat),
        lng: Number(r.ubicacion.lng),
        peso,
        reporteId: r.reporteId,
        categoria: r.categoriaTrabajo,
        prioridad: r.prioridad,
        estatus: r.estatus,
        zona: r.zonaGeografica,
        cantidadNNA: cantidadNNADe(r),
        fechaCreacion: r.fechaCreacion,
      };
    });

  // Agrupacion por zona para la tabla lateral del tablero.
  const porZona = new Map();
  for (const p of puntos) {
    const acumulado = porZona.get(p.zona) || { zona: p.zona, total: 0, peso: 0, urgentes: 0 };
    acumulado.total += 1;
    acumulado.peso += p.peso;
    if (p.prioridad === 'urgente') acumulado.urgentes += 1;
    porZona.set(p.zona, acumulado);
  }

  const pesoMaximo = puntos.reduce((max, p) => Math.max(max, p.peso), 0);

  return ok(
    {
      centro: CENTRO_ATIZAPAN,
      zoomSugerido: 13,
      puntos,
      totalPuntos: puntos.length,
      pesoMaximo,
      zonasCalientes: [...porZona.values()]
        .sort((a, b) => b.peso - a.peso)
        .slice(0, 10)
        .map((z) => ({ ...z, peso: Math.round(z.peso * 100) / 100 })),
      generadoEn: new Date().toISOString(),
    },
    evento,
  );
});
