import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET_EVIDENCIA, PRESIGN_EXPIRA_SEG } from './aws.js';

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

    // Sin parametros de cifrado en la firma, a proposito.
    //
    // SigV4 exige que el cliente reproduzca EXACTAMENTE los encabezados que
    // quedaron firmados. Al declarar aqui ServerSideEncryption y SSEKMSKeyId,
    // la firma pasaba a exigir tambien x-amz-server-side-encryption-aws-kms-key-id,
    // que la app no enviaba, y S3 respondia 403 SignatureDoesNotMatch en toda
    // subida de evidencia. Mandar el ARN de la llave al telefono para corregirlo
    // seria peor: expone la infraestructura dentro del APK.
    //
    // El bucket ya cifra por omision con la llave del proyecto, asi que el objeto
    // queda igual de protegido y la firma solo exige el encabezado host. Cuidado
    // con "arreglarlo" declarando solo ServerSideEncryption: entonces S3 usa la
    // llave gestionada por AWS y no la del proyecto.
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET_EVIDENCIA,
        Key: clave,
        ContentType: tipo,
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
