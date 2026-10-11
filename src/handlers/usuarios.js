import {
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { cognito, USER_POOL_ID } from '../lib/aws.js';
import { ok, creado, leerCuerpo, manejar, ErrorHttp } from '../lib/respuesta.js';
import { identidad, exigir, ipOrigen } from '../lib/auth.js';
import { auditar } from '../lib/auditoria.js';

const GRUPOS_VALIDOS = ['operador', 'supervisor', 'directivo'];

function atributo(usuario, nombre) {
  return usuario.Attributes?.find((a) => a.Name === nombre)?.Value ?? null;
}

async function listar(evento, usuario) {
  const { Users = [] } = await cognito.send(
    new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }),
  );

  const enriquecidos = await Promise.all(
    Users.map(async (u) => {
      const { Groups = [] } = await cognito.send(
        new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: u.Username }),
      );

      return {
        username: u.Username,
        email: atributo(u, 'email'),
        nombreCompleto: atributo(u, 'custom:full_name'),
        rol: atributo(u, 'custom:role'),
        estado: u.UserStatus,
        habilitado: u.Enabled,
        creadoEn: u.UserCreateDate,
        actualizadoEn: u.UserLastModifiedDate,
        grupos: Groups.map((g) => g.GroupName),
      };
    }),
  );

  await auditar({
    accion: 'USUARIOS_CONSULTADOS',
    userId: usuario.userId,
    email: usuario.email,
    ip: ipOrigen(evento),
    detalles: { total: enriquecidos.length },
  });

  return ok({ usuarios: enriquecidos, total: enriquecidos.length }, evento);
}

async function crear(evento, usuario) {
  const cuerpo = leerCuerpo(evento);

  const email = String(cuerpo.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ErrorHttp(400, 'El correo no tiene un formato valido.');
  }

  const grupo = String(cuerpo.grupo || 'operador').trim().toLowerCase();
  if (!GRUPOS_VALIDOS.includes(grupo)) {
    throw new ErrorHttp(400, `Grupo invalido. Valores: ${GRUPOS_VALIDOS.join(', ')}.`);
  }

  const nombreCompleto = String(cuerpo.nombreCompleto || '').trim();
  if (nombreCompleto.length < 3) {
    throw new ErrorHttp(400, 'El nombre completo es obligatorio.');
  }

  // Cognito envia la contrasena temporal por correo; el sistema nunca la ve.
  const { User } = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:role', Value: grupo },
        { Name: 'custom:full_name', Value: nombreCompleto },
      ],
    }),
  );

  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      GroupName: grupo,
    }),
  );

  await auditar({
    accion: 'USUARIO_CREADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: email,
    ip: ipOrigen(evento),
    detalles: { grupo, nombreCompleto },
  });

  return creado(
    {
      usuario: {
        username: User?.Username ?? email,
        email,
        nombreCompleto,
        grupos: [grupo],
        estado: User?.UserStatus,
      },
      mensaje: 'Se envio la invitacion con la contrasena temporal al correo indicado.',
    },
    evento,
  );
}

/**
 * GET  /admin/usuarios - listado del personal con sus grupos.
 * POST /admin/usuarios - alta de un operador nuevo.
 *
 * Ambas exigen el permiso de gestion de usuarios, exclusivo de directivo.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'usuarios:gestionar');

  const metodo = evento?.requestContext?.http?.method || 'GET';
  if (metodo === 'POST') return crear(evento, usuario);
  return listar(evento, usuario);
});
