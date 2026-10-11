import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { dynamo, TABLA_REPORTES } from '../lib/aws.js';
import { ok, leerCuerpo, leerRuta, manejar, ErrorHttp } from '../lib/respuesta.js';
import { identidad, exigir, tienePermiso, ipOrigen } from '../lib/auth.js';
import { obtenerPorId } from '../lib/reportes.js';
import { transicionValida, TRANSICIONES, PRIORIDADES } from '../lib/dominio.js';
import { auditar } from '../lib/auditoria.js';
import { ulid } from '../lib/ulid.js';

/**
 * PATCH /admin/reportes/{id}
 *
 * Cambia estatus, prioridad, asignacion y agrega notas. Cada campo exige su
 * propio permiso y el estatus solo avanza por transiciones validas.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'reportes:actualizar');

  const reporteId = String(leerRuta(evento, 'id') || '').toUpperCase();
  const cuerpo = leerCuerpo(evento);
  const reporte = await obtenerPorId(reporteId);

  const ahora = new Date().toISOString();
  const asignaciones = ['actualizadoEn = :ahora'];
  const nombres = {};
  const valores = { ':ahora': ahora };
  const cambios = {};

  // --- Estatus -----------------------------------------------------------
  if (cuerpo.estatus && cuerpo.estatus !== reporte.estatus) {
    if (!transicionValida(reporte.estatus, cuerpo.estatus)) {
      throw new ErrorHttp(
        409,
        `No se puede pasar de "${reporte.estatus}" a "${cuerpo.estatus}".`,
        { estatusActual: reporte.estatus, transicionesValidas: TRANSICIONES[reporte.estatus] || [] },
      );
    }

    // Cerrar un caso es una decision de mando, no de captura.
    if (cuerpo.estatus === 'resuelto' && !tienePermiso(usuario, 'reportes:asignar')) {
      throw new ErrorHttp(403, 'Solo un supervisor o directivo puede cerrar un caso como resuelto.');
    }

    nombres['#estatus'] = 'estatus';
    valores[':estatus'] = cuerpo.estatus;
    asignaciones.push('#estatus = :estatus');
    cambios.estatus = { de: reporte.estatus, a: cuerpo.estatus };
  }

  // --- Prioridad ---------------------------------------------------------
  if (cuerpo.prioridad && cuerpo.prioridad !== reporte.prioridad) {
    if (!PRIORIDADES.includes(cuerpo.prioridad)) {
      throw new ErrorHttp(400, `Prioridad invalida. Valores: ${PRIORIDADES.join(', ')}.`);
    }
    // Bajar la prioridad de un caso urgente requiere criterio de supervision.
    if (reporte.prioridad === 'urgente' && !tienePermiso(usuario, 'reportes:asignar')) {
      throw new ErrorHttp(403, 'Solo un supervisor o directivo puede degradar un caso urgente.');
    }

    nombres['#prioridad'] = 'prioridad';
    valores[':prioridad'] = cuerpo.prioridad;
    asignaciones.push('#prioridad = :prioridad');
    cambios.prioridad = { de: reporte.prioridad, a: cuerpo.prioridad };
  }

  // --- Asignacion --------------------------------------------------------
  if (cuerpo.operadorAsignado !== undefined) {
    exigir(usuario, 'reportes:asignar');
    const operador = String(cuerpo.operadorAsignado || 'SIN_ASIGNAR').trim() || 'SIN_ASIGNAR';

    nombres['#operadorAsignado'] = 'operadorAsignado';
    valores[':operadorAsignado'] = operador;
    asignaciones.push('#operadorAsignado = :operadorAsignado');
    cambios.operadorAsignado = { de: reporte.operadorAsignado, a: operador };
  }

  // --- Nota en bitacora --------------------------------------------------
  if (cuerpo.nota) {
    exigir(usuario, 'notas:agregar');
    const texto = String(cuerpo.nota).trim();
    if (texto.length < 3 || texto.length > 1000) {
      throw new ErrorHttp(400, 'La nota debe tener entre 3 y 1000 caracteres.');
    }

    const nota = {
      id: ulid(),
      texto,
      autor: usuario.nombre,
      autorId: usuario.userId,
      fecha: ahora,
    };

    nombres['#notas'] = 'notas';
    valores[':nota'] = [nota];
    valores[':vacio'] = [];
    asignaciones.push('#notas = list_append(if_not_exists(#notas, :vacio), :nota)');
    cambios.notaAgregada = nota.id;
  }

  if (asignaciones.length === 1) {
    throw new ErrorHttp(400, 'No se envio ningun cambio.');
  }

  // Bloqueo optimista: si el panel manda la version que tenia en pantalla, el
  // update falla cuando otro operador toco el caso mientras tanto.
  let condicion = 'attribute_exists(reporteId)';
  if (cuerpo.actualizadoEnEsperado) {
    condicion += ' AND actualizadoEn = :esperado';
    valores[':esperado'] = String(cuerpo.actualizadoEnEsperado);
  }

  let resultado;
  try {
    resultado = await dynamo.send(
      new UpdateCommand({
        TableName: TABLA_REPORTES,
        Key: { reporteId: reporte.reporteId, fechaCreacion: reporte.fechaCreacion },
        UpdateExpression: `SET ${asignaciones.join(', ')}`,
        ExpressionAttributeNames: Object.keys(nombres).length ? nombres : undefined,
        ExpressionAttributeValues: valores,
        ConditionExpression: condicion,
        ReturnValues: 'ALL_NEW',
      }),
    );
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw new ErrorHttp(409, 'Otro usuario modifico el reporte. Recarga el caso e intenta de nuevo.');
    }
    throw e;
  }

  const { Attributes } = resultado;

  await auditar({
    accion: 'REPORTE_ACTUALIZADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: reporte.reporteId,
    ip: ipOrigen(evento),
    detalles: cambios,
  });

  return ok({ reporte: Attributes, cambios }, evento);
});
