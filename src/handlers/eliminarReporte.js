import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_REPORTES } from '../lib/aws.js';
import { ok, leerCuerpo, leerRuta, manejar, ErrorHttp } from '../lib/respuesta.js';
import { identidad, exigir, ipOrigen } from '../lib/auth.js';
import { obtenerPorId } from '../lib/reportes.js';
import { auditar } from '../lib/auditoria.js';

/**
 * DELETE /admin/reportes/{id}   Oculta el reporte
 * POST   /admin/reportes/{id}/restaurar   Lo devuelve al listado
 *
 * El borrado es logico a proposito. El registro no se destruye: se marca como
 * eliminado y deja de aparecer en listados, estadisticas, mapa y exportaciones.
 *
 * La razon no es tecnica sino de responsabilidad. Este sistema documenta como
 * se atendio cada caso de trabajo infantil, y un borrado real haria imposible
 * demostrar despues que un reporte existio y que se le dio seguimiento. Para
 * una solicitud formal de cancelacion de datos personales hace falta una purga
 * aparte, deliberada y tambien auditada.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'reportes:eliminar');

  const reporteId = String(leerRuta(evento, 'id') || '').toUpperCase();
  const reporte = await obtenerPorId(reporteId);

  const metodo = evento?.requestContext?.http?.method ?? 'DELETE';
  const restaurando = metodo === 'POST';

  if (restaurando) return restaurar(evento, usuario, reporte);
  return eliminar(evento, usuario, reporte);
});

async function eliminar(evento, usuario, reporte) {
  if (reporte.eliminado) {
    throw new ErrorHttp(409, 'Este reporte ya estaba eliminado.');
  }

  const cuerpo = leerCuerpo(evento);
  const motivo = String(cuerpo.motivo ?? '').trim();

  // Obligar un motivo es lo que convierte el borrado en una decision explicable
  // cuando alguien revise la bitacora meses despues.
  if (motivo.length < 10) {
    throw new ErrorHttp(400, 'Indica el motivo del borrado, con al menos 10 caracteres.', {
      motivo: 'El motivo es obligatorio y queda registrado en la auditoria.',
    });
  }

  const ahora = new Date().toISOString();

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLA_REPORTES,
      Key: { reporteId: reporte.reporteId, fechaCreacion: reporte.fechaCreacion },
      UpdateExpression:
        'SET eliminado = :si, eliminadoEn = :ahora, eliminadoPor = :quien, '
        + 'motivoEliminacion = :motivo, actualizadoEn = :ahora',
      ExpressionAttributeValues: {
        ':si': true,
        ':ahora': ahora,
        ':quien': usuario.email,
        ':motivo': motivo.slice(0, 500),
      },
    }),
  );

  await auditar({
    accion: 'REPORTE_ELIMINADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
    detalles: { motivo, estatusAlEliminar: reporte.estatus, zona: reporte.zonaGeografica },
  });

  return ok(
    {
      reporteId: reporte.reporteId,
      eliminado: true,
      eliminadoEn: ahora,
      eliminadoPor: usuario.email,
      mensaje: 'El reporte se ocultó del panel. El registro se conserva y la acción quedó auditada.',
    },
    evento,
  );
}

async function restaurar(evento, usuario, reporte) {
  if (!reporte.eliminado) {
    throw new ErrorHttp(409, 'Este reporte no está eliminado.');
  }

  const ahora = new Date().toISOString();

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLA_REPORTES,
      Key: { reporteId: reporte.reporteId, fechaCreacion: reporte.fechaCreacion },
      UpdateExpression:
        'REMOVE eliminado, eliminadoEn, eliminadoPor, motivoEliminacion SET actualizadoEn = :ahora',
      ExpressionAttributeValues: { ':ahora': ahora },
    }),
  );

  await auditar({
    accion: 'REPORTE_RESTAURADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
    detalles: { motivoDelBorradoPrevio: reporte.motivoEliminacion ?? null },
  });

  return ok(
    { reporteId: reporte.reporteId, eliminado: false, mensaje: 'El reporte volvió al panel.' },
    evento,
  );
}
