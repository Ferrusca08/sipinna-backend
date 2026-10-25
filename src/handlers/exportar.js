import { PutObjectCommand } from '@aws-sdk/client-s3';

import { s3, BUCKET_EVIDENCIA, KMS_KEY_ID } from '../lib/aws.js';
import { ok, leerCuerpo, manejar, ErrorHttp } from '../lib/respuesta.js';
import { identidad, exigir, ipOrigen } from '../lib/auth.js';
import { validarRangoFechas } from '../lib/validacion.js';
import { recorrerTodos } from '../lib/reportes.js';
import { generarUrlDeLectura } from '../lib/evidencia.js';
import { generarPdf } from '../lib/pdf.js';
import { auditar } from '../lib/auditoria.js';
import { ulid } from '../lib/ulid.js';
import { cantidadNNADe } from '../lib/dominio.js';

const COLUMNAS = [
  ['reporteId', 'Folio'],
  ['fechaCreacion', 'Fecha de creacion'],
  ['estatus', 'Estatus'],
  ['prioridad', 'Prioridad'],
  ['categoriaTrabajo', 'Categoria'],
  ['edadEstimada', 'Edad estimada'],
  ['cantidadNNA', 'Ninas, ninos y adolescentes'],
  ['turnoReporte', 'Turno'],
  ['zonaGeografica', 'Zona'],
  ['lugarEspecifico', 'Lugar'],
  ['colonia', 'Colonia'],
  ['cp', 'CP'],
  ['direccion', 'Direccion'],
  ['lat', 'Latitud'],
  ['lng', 'Longitud'],
  ['operadorAsignado', 'Operador asignado'],
  ['evidencias', 'Evidencias'],
  ['actualizadoEn', 'Ultima actualizacion'],
  ['descripcion', 'Descripcion'],
];

function aplanar(r) {
  return {
    reporteId: r.reporteId,
    fechaCreacion: r.fechaCreacion,
    estatus: r.estatus,
    prioridad: r.prioridad,
    categoriaTrabajo: r.categoriaTrabajo,
    edadEstimada: r.edadEstimada,
    cantidadNNA: cantidadNNADe(r),
    turnoReporte: r.turnoReporte,
    zonaGeografica: r.zonaGeografica,
    lugarEspecifico: r.lugarEspecifico,
    colonia: r.ubicacion?.colonia ?? '',
    cp: r.ubicacion?.cp ?? '',
    direccion: r.ubicacion?.direccion ?? '',
    lat: r.ubicacion?.lat ?? '',
    lng: r.ubicacion?.lng ?? '',
    operadorAsignado: r.operadorAsignado ?? '',
    evidencias: (r.evidenciaUrls || []).length,
    actualizadoEn: r.actualizadoEn,
    descripcion: r.descripcion,
  };
}

function celdaCsv(valor) {
  const texto = String(valor ?? '');
  // El prefijo evita que Excel interprete una celda como formula.
  const seguro = /^[=+\-@]/.test(texto) ? `'${texto}` : texto;
  return `"${seguro.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function construirCsv(filas) {
  const encabezado = COLUMNAS.map(([, titulo]) => celdaCsv(titulo)).join(',');
  const cuerpo = filas.map((fila) => COLUMNAS.map(([clave]) => celdaCsv(fila[clave])).join(','));
  // BOM para que Excel en Windows respete los acentos.
  return '﻿' + [encabezado, ...cuerpo].join('\r\n');
}

function construirPdf(filas, { desde, hasta }) {
  const lineas = [];

  const porEstatus = {};
  const porPrioridad = {};
  for (const f of filas) {
    porEstatus[f.estatus] = (porEstatus[f.estatus] || 0) + 1;
    porPrioridad[f.prioridad] = (porPrioridad[f.prioridad] || 0) + 1;
  }

  lineas.push({ texto: 'RESUMEN', negrita: true });
  lineas.push(`Total de reportes: ${filas.length}`);
  lineas.push(`Ninas, ninos y adolescentes involucrados: ${filas.reduce((s, f) => s + (Number(f.cantidadNNA) || 0), 0)}`);
  lineas.push(`Por estatus: ${Object.entries(porEstatus).map(([k, v]) => `${k}=${v}`).join('  ') || 'sin datos'}`);
  lineas.push(`Por prioridad: ${Object.entries(porPrioridad).map(([k, v]) => `${k}=${v}`).join('  ') || 'sin datos'}`);
  lineas.push('');
  lineas.push({ texto: 'DETALLE DE CASOS', negrita: true });
  lineas.push('');

  for (const f of filas) {
    lineas.push({ texto: `${f.reporteId}  |  ${String(f.fechaCreacion).slice(0, 16).replace('T', ' ')}`, negrita: true });
    lineas.push(`Estatus: ${f.estatus}   Prioridad: ${f.prioridad}   Turno: ${f.turnoReporte}`);
    lineas.push(`Categoria: ${f.categoriaTrabajo}   NNA: ${f.cantidadNNA}   Edad: ${f.edadEstimada}`);
    lineas.push(`Zona: ${f.zonaGeografica}   Lugar: ${f.lugarEspecifico}`);
    if (f.direccion) lineas.push(`Direccion: ${f.direccion}`);
    lineas.push(`Operador: ${f.operadorAsignado || 'sin asignar'}`);
    lineas.push(`Descripcion: ${f.descripcion}`);
    lineas.push('');
  }

  const periodo = [desde ? `del ${desde.slice(0, 10)}` : null, hasta ? `al ${hasta.slice(0, 10)}` : null]
    .filter(Boolean)
    .join(' ');

  return generarPdf({
    titulo: 'SIPINNA Atizapan - Reportes de Trabajo Infantil',
    subtitulo: `Generado el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC ${periodo}`.trim(),
    lineas,
  });
}

/**
 * POST /admin/exportar
 *
 * Genera CSV o PDF con los reportes filtrados, lo deja en S3 y devuelve una
 * presigned URL de descarga. El archivo hereda el ciclo de vida del bucket de
 * evidencia, asi que no queda material sensible sin caducidad.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'datos:exportar');

  const cuerpo = leerCuerpo(evento);
  const formato = String(cuerpo.formato || 'csv').toLowerCase();
  if (!['csv', 'pdf'].includes(formato)) {
    throw new ErrorHttp(400, 'Formato invalido. Usa "csv" o "pdf".');
  }

  const { desde, hasta } = validarRangoFechas(cuerpo.desde, cuerpo.hasta);
  let items = await recorrerTodos({ desde, hasta });

  // Filtros opcionales sobre el universo recuperado.
  if (cuerpo.estatus) items = items.filter((r) => r.estatus === cuerpo.estatus);
  if (cuerpo.prioridad) items = items.filter((r) => r.prioridad === cuerpo.prioridad);
  if (cuerpo.categoria) items = items.filter((r) => r.categoriaTrabajo === cuerpo.categoria);
  if (cuerpo.zona) items = items.filter((r) => r.zonaGeografica === cuerpo.zona);
  if (cuerpo.operador) items = items.filter((r) => r.operadorAsignado === cuerpo.operador);

  if (items.length === 0) {
    throw new ErrorHttp(404, 'No hay reportes que coincidan con los filtros seleccionados.');
  }

  items.sort((a, b) => String(b.fechaCreacion).localeCompare(String(a.fechaCreacion)));
  const filas = items.map(aplanar);

  const esCsv = formato === 'csv';
  const contenido = esCsv ? Buffer.from(construirCsv(filas), 'utf8') : construirPdf(filas, { desde, hasta });

  const marca = new Date().toISOString().slice(0, 10);
  const clave = `exportaciones/${marca}/sipinna-reportes-${ulid()}.${formato}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_EVIDENCIA,
      Key: clave,
      Body: contenido,
      ContentType: esCsv ? 'text/csv; charset=utf-8' : 'application/pdf',
      ContentDisposition: `attachment; filename="sipinna-reportes-${marca}.${formato}"`,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: KMS_KEY_ID,
      Metadata: {
        generadopor: usuario.userId,
        registros: String(filas.length),
      },
    }),
  );

  // Una hora: suficiente para descargar sin dejar el enlace vivo por dias.
  const urlDescarga = await generarUrlDeLectura(clave, 3600);

  await auditar({
    accion: 'DATOS_EXPORTADOS',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: clave,
    ip: ipOrigen(evento),
    detalles: { formato, registros: filas.length, filtros: { desde, hasta, ...cuerpo } },
  });

  return ok(
    {
      urlDescarga,
      clave,
      formato,
      registros: filas.length,
      expiraEnSegundos: 3600,
      bytes: contenido.length,
    },
    evento,
  );
});
