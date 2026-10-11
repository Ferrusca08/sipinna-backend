import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calcularTurno,
  calcularZona,
  cantidadNNADe,
  clasificarPrioridad,
  permisosDe,
  transicionValida,
} from '../src/lib/dominio.js';
import { esUlid, fechaDeUlid, ulid } from '../src/lib/ulid.js';
import { generarPdf } from '../src/lib/pdf.js';

// --- Clasificacion automatica de prioridad ---------------------------------
test('las categorias de maxima gravedad son urgentes', () => {
  for (const categoria of ['EXPLOTACION_SEXUAL', 'ACTIVIDAD_ILICITA']) {
    assert.equal(
      clasificarPrioridad({ categoriaTrabajo: categoria, edadEstimada: '14-17', cantidadNNA: 1 }),
      'urgente',
    );
  }
});

test('mendicidad y trabajo domestico suben a alta', () => {
  assert.equal(
    clasificarPrioridad({ categoriaTrabajo: 'MENDICIDAD', edadEstimada: '10-13', cantidadNNA: 1 }),
    'alta',
  );
  assert.equal(
    clasificarPrioridad({ categoriaTrabajo: 'TRABAJO_DOMESTICO', edadEstimada: '14-17', cantidadNNA: 1 }),
    'alta',
  );
});

test('la primera infancia y los grupos grandes suben a alta', () => {
  assert.equal(
    clasificarPrioridad({ categoriaTrabajo: 'VENTA_AMBULANTE', edadEstimada: '0-5', cantidadNNA: 1 }),
    'alta',
  );
  assert.equal(
    clasificarPrioridad({ categoriaTrabajo: 'VENTA_AMBULANTE', edadEstimada: '14-17', cantidadNNA: 4 }),
    'alta',
  );
});

test('tres NNA todavia no bastan para elevar la prioridad', () => {
  assert.equal(
    clasificarPrioridad({ categoriaTrabajo: 'VENTA_AMBULANTE', edadEstimada: '14-17', cantidadNNA: 3 }),
    'media',
  );
});

test('la prioridad baja nunca se asigna automaticamente', () => {
  const combinaciones = ['VENTA_AMBULANTE', 'LIMPIA_PARABRISAS', 'OTRO', 'COMERCIO_ESTABLECIDO'];
  for (const categoria of combinaciones) {
    const resultado = clasificarPrioridad({
      categoriaTrabajo: categoria,
      edadEstimada: '14-17',
      cantidadNNA: 1,
    });
    assert.notEqual(resultado, 'baja');
  }
});

// --- Lectura compatible de la cantidad de NNA -------------------------------
// El atributo se llamaba "cantidadMenores" antes del cambio de terminologia.
// Hasta que corra la migracion conviven los dos nombres en la tabla.
test('se lee el atributo nuevo cuando esta presente', () => {
  assert.equal(cantidadNNADe({ cantidadNNA: 3 }), 3);
});

test('se cae al atributo anterior en los reportes ya guardados', () => {
  assert.equal(cantidadNNADe({ cantidadMenores: 4 }), 4);
});

test('el atributo nuevo gana si por alguna razon vienen los dos', () => {
  assert.equal(cantidadNNADe({ cantidadNNA: 2, cantidadMenores: 9 }), 2);
});

test('un reporte sin ninguno de los dos no rompe la suma', () => {
  assert.equal(cantidadNNADe({}), 0);
  assert.equal(cantidadNNADe(null), 0);
  assert.equal(cantidadNNADe({ cantidadNNA: 'nada' }), 0);
});

// --- Transiciones de estatus ------------------------------------------------
test('el flujo feliz del caso es transitable de punta a punta', () => {
  assert.ok(transicionValida('nuevo', 'en_revision'));
  assert.ok(transicionValida('en_revision', 'asignado'));
  assert.ok(transicionValida('asignado', 'en_seguimiento'));
  assert.ok(transicionValida('en_seguimiento', 'resuelto'));
});

test('resuelto es terminal', () => {
  for (const destino of ['nuevo', 'en_revision', 'asignado', 'en_seguimiento', 'descartado']) {
    assert.equal(transicionValida('resuelto', destino), false);
  }
});

test('un caso descartado se puede reabrir a revision, pero no saltar a resuelto', () => {
  assert.ok(transicionValida('descartado', 'en_revision'));
  assert.equal(transicionValida('descartado', 'resuelto'), false);
});

test('no se puede brincar de nuevo directo a seguimiento', () => {
  assert.equal(transicionValida('nuevo', 'en_seguimiento'), false);
  assert.equal(transicionValida('nuevo', 'resuelto'), false);
});

// --- Turno ------------------------------------------------------------------
test('el turno se calcula en hora local de la Ciudad de Mexico', () => {
  // 2025-06-15T15:00:00Z = 09:00 en CDMX (UTC-6)
  assert.equal(calcularTurno(new Date('2025-06-15T15:00:00Z')), 'matutino');
  // 2025-06-15T21:00:00Z = 15:00 en CDMX
  assert.equal(calcularTurno(new Date('2025-06-15T21:00:00Z')), 'vespertino');
  // 2025-06-16T04:00:00Z = 22:00 del dia 15 en CDMX
  assert.equal(calcularTurno(new Date('2025-06-16T04:00:00Z')), 'nocturno');
  // 2025-06-15T09:00:00Z = 03:00 en CDMX
  assert.equal(calcularTurno(new Date('2025-06-15T09:00:00Z')), 'nocturno');
});

// --- Zona geografica --------------------------------------------------------
test('el codigo postal gana sobre la colonia', () => {
  assert.equal(calcularZona({ cp: '52900', colonia: 'Centro' }), 'ATIZAPAN-52900');
});

test('sin CP se normaliza la colonia sin acentos ni espacios', () => {
  assert.equal(calcularZona({ colonia: 'Lomas de Atizapán' }), 'ATIZAPAN-LOMAS-DE-ATIZAPAN');
  assert.equal(calcularZona({ colonia: 'México Nuevo' }), 'ATIZAPAN-MEXICO-NUEVO');
});

test('un CP mal formado no se toma como zona', () => {
  assert.equal(calcularZona({ cp: '529', colonia: '' }), 'ATIZAPAN-SIN-ZONA');
  assert.equal(calcularZona({}), 'ATIZAPAN-SIN-ZONA');
});

// --- RBAC -------------------------------------------------------------------
test('cada grupo acumula solo los permisos que le tocan', () => {
  const operador = permisosDe(['operador']);
  assert.ok(operador.includes('reportes:actualizar'));
  assert.ok(!operador.includes('reportes:asignar'));
  assert.ok(!operador.includes('datos:exportar'));

  const supervisor = permisosDe(['supervisor']);
  assert.ok(supervisor.includes('reportes:asignar'));
  assert.ok(!supervisor.includes('datos:exportar'));

  const directivo = permisosDe(['directivo']);
  assert.ok(directivo.includes('datos:exportar'));
  assert.ok(directivo.includes('usuarios:gestionar'));
  assert.ok(directivo.includes('auditoria:ver'));
});

test('un grupo desconocido no otorga permisos', () => {
  assert.deepEqual(permisosDe(['invitado']), []);
  assert.deepEqual(permisosDe([]), []);
});

// --- ULID -------------------------------------------------------------------
test('el ULID tiene 26 caracteres del alfabeto Crockford', () => {
  const token = ulid();
  assert.equal(token.length, 26);
  assert.ok(esUlid(token));
  // Sin las letras ambiguas al dictarlo por telefono.
  assert.ok(!/[ILOU]/.test(token));
});

test('los ULID son ordenables por tiempo', () => {
  const antes = ulid(1_700_000_000_000);
  const despues = ulid(1_700_000_001_000);
  assert.ok(antes < despues);
});

test('la fecha se recupera del propio ULID', () => {
  const marca = 1_700_000_000_000;
  assert.equal(fechaDeUlid(ulid(marca)).getTime(), marca);
});

test('se rechazan tokens con forma invalida', () => {
  assert.equal(esUlid('corto'), false);
  assert.equal(esUlid('IIIIIIIIIIIIIIIIIIIIIIIIII'), false);
  assert.equal(esUlid(null), false);
});

// --- PDF --------------------------------------------------------------------
test('el PDF generado tiene cabecera, xref y EOF', () => {
  const pdf = generarPdf({
    titulo: 'Prueba SIPINNA',
    subtitulo: 'Generado en pruebas',
    lineas: ['Primera linea', { texto: 'En negrita', negrita: true }],
  });

  const texto = pdf.toString('latin1');
  assert.ok(texto.startsWith('%PDF-1.4'));
  assert.ok(texto.includes('/Type /Catalog'));
  assert.ok(texto.includes('xref'));
  assert.ok(texto.trimEnd().endsWith('%%EOF'));
});

test('el PDF pagina un volumen grande de casos', () => {
  const lineas = Array.from({ length: 500 }, (_, i) => `Caso numero ${i}`);
  const texto = generarPdf({ titulo: 'Volumen', lineas }).toString('latin1');

  const paginas = (texto.match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(paginas > 1, 'debe repartirse en varias paginas');
  assert.ok(texto.includes(`/Count ${paginas}`));
});

test('los parentesis del texto se escapan y no rompen el PDF', () => {
  const texto = generarPdf({
    titulo: 'Escape',
    lineas: ['Nino (5 anos) con \\ barra'],
  }).toString('latin1');

  assert.ok(texto.includes('\\(5 anos\\)'));
});
