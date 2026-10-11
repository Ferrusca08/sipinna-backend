import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_EVIDENCIA, KMS_KEY_ID, PRESIGN_EXPIRA_SEG } from './aws.js';

const EXTENSION_POR_TIPO = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

/**
 * Genera presigned URLs de subida para la evidencia de un reporte.
 * La app movil sube directo a S3: la Lambda nunca toca los bytes de la foto.
 */
export async function generarUrlsDeSubida(reporteId, cantidad, tiposContenido = [], desplazamiento = 0) {
  const urls = [];

  for (let i = 0; i < cantidad; i++) {
    const tipo = tiposContenido[i] || 'image/jpeg';
    const extension = EXTENSION_POR_TIPO[tipo] || 'jpg';
    const clave = `reportes/${reporteId}/evidencia-${desplazamiento + i + 1}.${extension}`;

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET_EVIDENCIA,
        Key: clave,
        ContentType: tipo,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: KMS_KEY_ID,
      }),
      { expiresIn: PRESIGN_EXPIRA_SEG },
    );

    urls.push({ clave, url, tipoContenido: tipo, expiraEnSegundos: PRESIGN_EXPIRA_SEG });
  }

  return urls;
}

/** URL de lectura temporal para que el panel muestre la evidencia. */
export async function generarUrlDeLectura(clave, expiraEn = PRESIGN_EXPIRA_SEG) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET_EVIDENCIA, Key: clave }),
    { expiresIn: expiraEn },
  );
}
