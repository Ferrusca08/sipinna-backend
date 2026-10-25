import {
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
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

async function actualizarRol(evento, usuario, cuerpoPrevio) {
  const cuerpo = cuerpoPrevio || leerCuerpo(evento);
  const username = String(
    evento?.pathParameters?.id ||
    evento?.pathParameters?.username ||
    cuerpo?.username ||
    cuerpo?.email ||
    ''
  ).trim();

  if (!username) {
    throw new ErrorHttp(400, 'El identificador de usuario (username o email) es obligatorio.');
  }

  const nuevoRol = String(cuerpo?.grupo || cuerpo?.rol || '').trim().toLowerCase();
  if (!GRUPOS_VALIDOS.includes(nuevoRol)) {
    throw new ErrorHttp(400, `Rol inválido. Valores permitidos: ${GRUPOS_VALIDOS.join(', ')}.`);
  }

  // Consultar grupos actuales del usuario
  const { Groups = [] } = await cognito.send(
    new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
  );

  // Remover de grupos anteriores si difieren del nuevo rol
  for (const g of Groups) {
    if (GRUPOS_VALIDOS.includes(g.GroupName) && g.GroupName !== nuevoRol) {
      await cognito.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: g.GroupName,
        }),
      );
    }
  }

  // Asociar al nuevo grupo si no lo tenía ya
  const yaAsignado = Groups.some((g) => g.GroupName === nuevoRol);
  if (!yaAsignado) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: nuevoRol,
      }),
    );
  }

  // Actualizar atributo custom:role
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      UserAttributes: [{ Name: 'custom:role', Value: nuevoRol }],
    }),
  );

  await auditar({
    accion: 'USUARIO_ROL_MODIFICADO',
    userId: usuario.userId,
    email: usuario.email,
    recursoId: username,
    ip: ipOrigen(evento),
    detalles: {
      nuevoRol,
      rolesAnteriores: Groups.map((g) => g.GroupName),
    },
  });

  return ok(
    {
      mensaje: `Rol de usuario actualizado a "${nuevoRol}" exitosamente.`,
      usuario: {
        username,
        rol: nuevoRol,
        grupos: [nuevoRol],
      },
    },
    evento,
  );
}

/**
 * GET   /admin/usuarios - listado del personal con sus grupos.
 * POST  /admin/usuarios - alta de un operador o cambio de rol ({ accion: 'cambiar_rol' }).
 * PATCH /admin/usuarios/{id} - modificación de rol de un usuario existente.
 *
 * Exigen el permiso de gestión de usuarios, exclusivo de directivo.
 */
export const handler = manejar(async (evento) => {
  const usuario = identidad(evento);
  exigir(usuario, 'usuarios:gestionar');

  const metodo = (evento?.requestContext?.http?.method || evento?.httpMethod || 'GET').toUpperCase();
  if (metodo === 'PATCH' || metodo === 'PUT') {
    return actualizarRol(evento, usuario);
  }
  if (metodo === 'POST') {
    const cuerpo = leerCuerpo(evento);
    if (cuerpo?.accion === 'cambiar_rol' || (cuerpo?.username && cuerpo?.grupo && !cuerpo?.nombreCompleto)) {
      return actualizarRol(evento, usuario, cuerpo);
    }
    return crear(evento, usuario);
  }
  return listar(evento, usuario);
});
