import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Los clientes se crean una sola vez por contenedor para reutilizar la
// conexion TLS entre invocaciones tibias.
const region = process.env.AWS_REGION || 'us-east-1';

export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

export const s3 = new S3Client({ region });
export const sns = new SNSClient({ region });
export const cognito = new CognitoIdentityProviderClient({ region });

export const TABLA_REPORTES = process.env.TABLA_REPORTES;
export const TABLA_SEGUIMIENTO = process.env.TABLA_SEGUIMIENTO;
export const TABLA_AUDITLOG = process.env.TABLA_AUDITLOG;
export const BUCKET_EVIDENCIA = process.env.BUCKET_EVIDENCIA;
export const KMS_KEY_ID = process.env.KMS_KEY_ID;
export const TOPIC_NUEVO = process.env.TOPIC_NUEVO;
export const TOPIC_URGENTE = process.env.TOPIC_URGENTE;
export const USER_POOL_ID = process.env.USER_POOL_ID;
export const PRESIGN_EXPIRA_SEG = Number(process.env.PRESIGN_EXPIRA_SEG || 900);
