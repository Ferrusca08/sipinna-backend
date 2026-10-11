import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand } from '@aws-sdk/client-sns';

import { dynamo, sns, TABLA_REPORTES, TOPIC_NUEVO, TOPIC_URGENTE } from '../lib/aws.js';
import { creado, leerCuerpo, manejar } from '../lib/respuesta.js';
import { validarReporte } from '../lib/validacion.js';
import { calcularTurno, calcularZona, clasificarPrioridad, CATEGORIAS_URGENTES } from '../lib/dominio.js';
import { generarUrlsDeSubida } from '../lib/evidencia.js';
import { auditar } from '../lib/auditoria.js';
import { ipOrigen } from '../lib/auth.js';
import { identidadCiudadanaOpcional } from '../lib/ciudadania.js';
import { ulid } from '../lib/ulid.js';

/**
 * POST /reportes  (publica, sin autenticacion)
 *
 * Da de alta el reporte del ciudadano, lo clasifica, avisa por SNS y devuelve
 * el token de seguimiento junto con las URLs para subir evidencia.
 */
export const handler = manejar(async (evento) => {
  const datos = validarReporte(leerCuerpo(evento));

  // Si la peticion trae sesion, el reporte queda ligado a esa cuenta y luego
  // aparece en "Mis reportes". Sin sesion sigue siendo anonimo, que es el
  // comportamiento por defecto y el que mas se usa.
  const reportanteId = await identidadCiudadanaOpcional(evento);

  const ahora = new Date();
  const reporteId = ulid(ahora.getTime());
  const fechaCreacion = ahora.toISOString();

  const prioridad = clasificarPrioridad(datos);
  const turnoReporte = calcularTurno(ahora);
  const zonaGeografica = calcularZona(datos.ubicacion);

  const reporte = {
    reporteId,
    fechaCreacion,
    descripcion: datos.descripcion,
    categoriaTrabajo: datos.categoriaTrabajo,
    edadEstimada: datos.edadEstimada,
    cantidadNNA: datos.cantidadNNA,
    ubicacion: datos.ubicacion,
    lugarEspecifico: datos.lugarEspecifico,
    turnoReporte,
    estatus: 'nuevo',
    prioridad,
    zonaGeografica,
    evidenciaUrls: [],
    // Un reportanteId mandado en el cuerpo no es de fiar: solo vale el que
    // sale del token verificado. Los anonimos no llevan el atributo, para no
    // ensuciar el indice de reportante con cadenas vacias.
    ...(reportanteId ? { reportanteId } : {}),
    contactoReportante: datos.contactoReportante,
    // Cadena vacia rompe el GSI de operador, asi que el sin-asignar es explicito.
    operadorAsignado: 'SIN_ASIGNAR',
    notas: [],
    actualizadoEn: fechaCreacion,
  };

  await dynamo.send(
    new PutCommand({
      TableName: TABLA_REPORTES,
      Item: reporte,
      ConditionExpression: 'attribute_not_exists(reporteId)',
    }),
  );

  // Presigned URLs opcionales: el ciudadano puede enviar el reporte sin fotos
  // y agregarlas despues desde la pantalla de evidencia.
  const urlsEvidencia = datos.cantidadEvidencia > 0
    ? await generarUrlsDeSubida(reporteId, datos.cantidadEvidencia)
    : [];

  const esUrgente = CATEGORIAS_URGENTES.includes(datos.categoriaTrabajo);

  // Esta linea alimenta el metric filter de CloudWatch que dispara la alarma
  // de pico de reportes urgentes.
  if (esUrgente) {
    console.log(`REPORTE_URGENTE reporteId=${reporteId} categoria=${datos.categoriaTrabajo} zona=${zonaGeografica}`);
  }

  const resumen = [
    `Nuevo reporte ${reporteId}`,
    `Categoria: ${datos.categoriaTrabajo}`,
    `Prioridad: ${prioridad}`,
    `Ninas, ninos y adolescentes: ${datos.cantidadNNA} (edad ${datos.edadEstimada})`,
    `Zona: ${zonaGeografica}`,
    `Turno: ${turnoReporte}`,
    `Ubicacion: ${datos.ubicacion.lat}, ${datos.ubicacion.lng}`,
    datos.ubicacion.direccion ? `Direccion: ${datos.ubicacion.direccion}` : null,
    '',
    `Descripcion: ${datos.descripcion}`,
  ].filter(Boolean).join('\n');

  const notificaciones = [
    sns.send(new PublishCommand({
      TopicArn: TOPIC_NUEVO,
      Subject: `SIPINNA - Reporte ${prioridad} en ${zonaGeografica}`.slice(0, 100),
      Message: resumen,
      MessageAttributes: {
        prioridad: { DataType: 'String', StringValue: prioridad },
        categoria: { DataType: 'String', StringValue: datos.categoriaTrabajo },
      },
    })),
  ];

  if (esUrgente) {
    notificaciones.push(sns.send(new PublishCommand({
      TopicArn: TOPIC_URGENTE,
      Subject: `URGENTE - ${datos.categoriaTrabajo} en ${zonaGeografica}`.slice(0, 100),
      Message: `ATENCION INMEDIATA REQUERIDA\n\n${resumen}`,
    })));
  }

  // Un fallo de SNS no debe invalidar un reporte ya guardado.
  const resultados = await Promise.allSettled(notificaciones);
  for (const r of resultados) {
    if (r.status === 'rejected') {
      console.error(JSON.stringify({ nivel: 'error', mensaje: 'Fallo la notificacion SNS', detalle: String(r.reason) }));
    }
  }

  await auditar({
    accion: 'REPORTE_CREADO',
    recursoId: reporteId,
    ip: ipOrigen(evento),
    detalles: {
      categoria: datos.categoriaTrabajo,
      prioridad,
      zona: zonaGeografica,
      anonimo: !datos.contactoReportante,
      conCuenta: Boolean(reportanteId),
    },
  });

  return creado(
    {
      reporteId,
      fechaCreacion,
      estatus: 'nuevo',
      prioridad,
      turnoReporte,
      zonaGeografica,
      urlsEvidencia,
      mensaje: 'Reporte recibido. Guarda tu codigo de seguimiento para consultar el avance.',
    },
    evento,
  );
});
