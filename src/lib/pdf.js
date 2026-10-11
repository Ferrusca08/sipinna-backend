// Generador de PDF minimo, sin dependencias externas.
//
// Solo cubre lo que necesita el reporte ejecutivo de SIPINNA: texto Helvetica
// en varias paginas con encabezado y pie. Meter pdfkit u otra libreria solo
// para esto agregaria ~10 MB al artefacto de las once funciones Lambda.

const ANCHO = 612; // Carta, en puntos
const ALTO = 792;
const MARGEN = 50;
const INTERLINEA = 14;
const LINEAS_POR_PAGINA = Math.floor((ALTO - MARGEN * 2 - 60) / INTERLINEA);

/** Escapa una cadena para un literal de texto PDF. */
function escapar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Parte una linea larga para que quepa en el ancho util de la pagina. */
function ajustar(texto, maximo = 95) {
  const palabras = String(texto).split(/\s+/);
  const lineas = [];
  let actual = '';

  for (const palabra of palabras) {
    if ((actual + ' ' + palabra).trim().length > maximo) {
      if (actual) lineas.push(actual);
      actual = palabra.slice(0, maximo);
    } else {
      actual = (actual + ' ' + palabra).trim();
    }
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [''];
}

/**
 * Construye un PDF a partir de un titulo y una lista de lineas.
 * Cada linea puede ser una cadena o { texto, negrita }.
 *
 * @returns {Buffer}
 */
export function generarPdf({ titulo, subtitulo = '', lineas = [] }) {
  // --- Paginado ----------------------------------------------------------
  const expandidas = [];
  for (const linea of lineas) {
    const texto = typeof linea === 'string' ? linea : linea.texto;
    const negrita = typeof linea === 'object' && linea.negrita;
    for (const parte of ajustar(texto)) expandidas.push({ texto: parte, negrita });
  }

  const paginas = [];
  for (let i = 0; i < expandidas.length; i += LINEAS_POR_PAGINA) {
    paginas.push(expandidas.slice(i, i + LINEAS_POR_PAGINA));
  }
  if (paginas.length === 0) paginas.push([]);

  // --- Contenido de cada pagina -----------------------------------------
  const contenidos = paginas.map((lineasPagina, indice) => {
    const partes = ['BT'];

    // Encabezado institucional
    partes.push('/F2 14 Tf');
    partes.push(`1 0 0 1 ${MARGEN} ${ALTO - MARGEN} Tm`);
    partes.push(`(${escapar(titulo)}) Tj`);

    if (subtitulo) {
      partes.push('/F1 9 Tf');
      partes.push(`1 0 0 1 ${MARGEN} ${ALTO - MARGEN - 16} Tm`);
      partes.push(`(${escapar(subtitulo)}) Tj`);
    }

    let y = ALTO - MARGEN - 44;
    for (const linea of lineasPagina) {
      partes.push(linea.negrita ? '/F2 9 Tf' : '/F1 9 Tf');
      partes.push(`1 0 0 1 ${MARGEN} ${y} Tm`);
      partes.push(`(${escapar(linea.texto)}) Tj`);
      y -= INTERLINEA;
    }

    // Pie de pagina
    partes.push('/F1 8 Tf');
    partes.push(`1 0 0 1 ${MARGEN} ${MARGEN - 20} Tm`);
    partes.push(
      `(${escapar(`SIPINNA Atizapan de Zaragoza - Documento confidencial - Pagina ${indice + 1} de ${paginas.length}`)}) Tj`,
    );
    partes.push('ET');

    return partes.join('\n');
  });

  // --- Ensamblado de objetos --------------------------------------------
  // 1 Catalog | 2 Pages | 3 Helvetica | 4 Helvetica-Bold | luego N paginas y N contenidos
  const primeraPagina = 5;
  const objetos = [];

  objetos.push('<< /Type /Catalog /Pages 2 0 R >>');

  const idsPaginas = paginas.map((_, i) => `${primeraPagina + i * 2} 0 R`);
  objetos.push(`<< /Type /Pages /Kids [${idsPaginas.join(' ')}] /Count ${paginas.length} >>`);

  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  paginas.forEach((_, i) => {
    const idContenido = primeraPagina + i * 2 + 1;
    objetos.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idContenido} 0 R >>`,
    );
    const flujo = contenidos[i];
    objetos.push(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
  });

  // --- Serializacion con tabla xref -------------------------------------
  let pdf = '%PDF-1.4\n';
  const desplazamientos = [];

  objetos.forEach((cuerpo, i) => {
    desplazamientos.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });

  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const desplazamiento of desplazamientos) {
    pdf += `${String(desplazamiento).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
