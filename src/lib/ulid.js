import { randomBytes } from 'node:crypto';

// Alfabeto Crockford base32: sin I, L, O ni U para que un ciudadano pueda
// dictar su token de seguimiento por telefono sin ambiguedad.
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LARGO_TIEMPO = 10;
const LARGO_AZAR = 16;

function codificarTiempo(ms) {
  let salida = '';
  let resto = ms;
  for (let i = LARGO_TIEMPO - 1; i >= 0; i--) {
    const modulo = resto % 32;
    salida = ALFABETO[modulo] + salida;
    resto = (resto - modulo) / 32;
  }
  return salida;
}

function codificarAzar() {
  const bytes = randomBytes(LARGO_AZAR);
  let salida = '';
  for (let i = 0; i < LARGO_AZAR; i++) {
    salida += ALFABETO[bytes[i] % 32];
  }
  return salida;
}

/**
 * Genera un ULID: ordenable por tiempo y sin coordinacion entre invocaciones.
 * @param {number} [ms] marca de tiempo en milisegundos
 */
export function ulid(ms = Date.now()) {
  return codificarTiempo(ms) + codificarAzar();
}

/** Valida la forma de un ULID (26 caracteres del alfabeto Crockford). */
export function esUlid(valor) {
  return typeof valor === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(valor);
}

/** Extrae la fecha embebida en un ULID. */
export function fechaDeUlid(valor) {
  if (!esUlid(valor)) return null;
  let ms = 0;
  for (const caracter of valor.slice(0, LARGO_TIEMPO)) {
    ms = ms * 32 + ALFABETO.indexOf(caracter);
  }
  return new Date(ms);
}
