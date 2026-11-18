#!/usr/bin/env node
// Carga (o actualiza) el padrón de estudiantes desde un archivo CSV: matrícula, nombre y correo institucional.
// Con el correo en el padrón, el código de verificación del registro llega SOLO al dueño de esa matrícula.
// Uso:   npm run cargar-padron -- alumnos.csv            (carga)
//        npm run cargar-padron -- alumnos.csv --simular  (solo revisa y muestra qué haría; no escribe nada)
// El archivo debe tener encabezado (matricula,nombre,correo), estar en UTF-8 (en Excel: "CSV UTF-8") y separar con coma, punto y coma o tabulador.
// Si alguna fila tiene un error no se carga NADA y se listan todos los errores con su número de línea. Las matrículas que ya están se actualizan;
// nunca se borra a nadie del padrón. Usa la base de DB_FILE (o data/sae.db).
const fs = require('fs');
const { esMatricula, MENSAJE_MATRICULA } = require('../matricula');

const MAX_BYTES = 5 * 1024 * 1024, MAX_FILAS = 50000;
const quitarAcentos = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const COLUMNAS = { matricula: ['matricula', 'clave', 'no de control'], nombre: ['nombre', 'nombre completo', 'alumno', 'estudiante'],
  correo: ['correo', 'email', 'correo electronico', 'correo institucional', 'e-mail'] };

// CSV con comillas ("a,b", "" dentro de un campo, saltos de línea entre comillas). Devuelve filas con su número de línea.
function leerCsv(texto, sep) {
  const filas = []; let fila = [], campo = '', comillas = false, linea = 1, inicio = 1, hayDatos = false;
  const cerrarFila = () => { fila.push(campo); campo = ''; if (hayDatos || fila.length > 1 || fila[0] !== '') filas.push({ linea: inicio, celdas: fila }); fila = []; hayDatos = false; };
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) { if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false; } else { campo += c; if (c === '\n') linea++; } continue; }
    if (c === '"' && campo === '') { comillas = true; hayDatos = true; }
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && texto[i + 1] === '\n') i++; cerrarFila(); linea++; inicio = linea; }
    else campo += c;
  }
  if (comillas) throw new Error('Hay unas comillas sin cerrar en el archivo.');
  if (campo !== '' || fila.length) cerrarFila();
  return filas;
}
const detectarSeparador = texto => { const l = texto.split(/\r?\n/, 1)[0]; return [',', ';', '\t'].map(s => [s, l.split(s).length]).sort((a, b) => b[1] - a[1])[0][0]; };

// Valida TODAS las filas y, si no hay errores (y no es simulación), las guarda en una sola transacción.
function cargarPadron(db, buffer, { simular = false } = {}) {
  if (buffer.length > MAX_BYTES) throw new Error('El archivo es demasiado grande (máximo 5 MB).');
  let texto; try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('El archivo no está en UTF-8. En Excel: Guardar como → "CSV UTF-8 (delimitado por comas)".'); }
  if (!texto.trim()) throw new Error('El archivo está vacío.');
  const filas = leerCsv(texto, detectarSeparador(texto)).filter(f => f.celdas.some(c => c.trim() !== ''));
  const cab = filas.shift(); if (!cab) throw new Error('El archivo no tiene filas.');
  const idx = {}; cab.celdas.forEach((c, i) => { const n = quitarAcentos(c.trim().toLowerCase()).replace(/\s+/g, ' ');
    for (const [k, alias] of Object.entries(COLUMNAS)) if (alias.includes(n) && !(k in idx)) idx[k] = i; });
  if (!('matricula' in idx) || !('nombre' in idx)) throw new Error('La primera fila debe ser el encabezado y traer al menos las columnas "matricula" y "nombre" (y "correo"). Se leyó: ' + cab.celdas.join(' | '));
  if (filas.length > MAX_FILAS) throw new Error(`Demasiadas filas (máximo ${MAX_FILAS}).`);

  const errores = [], vistas = new Map(), correos = new Map(), listas = [];
  const personal = db.prepare("SELECT matricula FROM users WHERE rol<>'estudiante'"), duenoDeCorreo = db.prepare('SELECT matricula,rol FROM users WHERE lower(email)=?');
  const claves = new Set(personal.all().map(u => u.matricula.toUpperCase()));
  for (const f of filas) {
    const cel = k => (k in idx ? String(f.celdas[idx[k]] ?? '') : '').trim();
    const matricula = cel('matricula'), nombre = cel('nombre').replace(/\s+/g, ' '), correo = cel('correo').toLowerCase(), err = m => errores.push(`Línea ${f.linea}: ${m}`);
    if (!esMatricula(matricula)) { err(`matrícula no válida "${matricula}" (${MENSAJE_MATRICULA}).`); continue; }
    if (!nombre || nombre.length > 120) { err(`el nombre de ${matricula} está vacío o pasa de 120 caracteres.`); continue; }
    const clave = matricula.toUpperCase();   // «ab123» y «AB123» son la misma matrícula
    if (vistas.has(clave)) { err(`la matrícula ${matricula} ya aparece en la línea ${vistas.get(clave)} (no se distingue entre mayúsculas y minúsculas).`); continue; } vistas.set(clave, f.linea);
    if (claves.has(clave)) { err(`${matricula} es la clave de una cuenta de docente o secretaría, no de un estudiante.`); continue; }
    if (correo) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo) || correo.length > 120) { err(`correo no válido "${correo}" (matrícula ${matricula}).`); continue; }
      if (correos.has(correo)) { err(`el correo ${correo} ya está en la línea ${correos.get(correo)}: cada estudiante necesita el suyo.`); continue; } correos.set(correo, f.linea);
      const d = duenoDeCorreo.get(correo); if (d && d.matricula !== matricula) { err(`el correo ${correo} ya es de la cuenta ${d.matricula}.`); continue; }
    }
    listas.push({ matricula, nombre, correo: correo || null });
  }
  const resumen = { filas: filas.length, nuevas: 0, actualizadas: 0, sinCambios: 0, sinCorreo: 0, conCuenta: 0, errores, simulado: simular };
  if (errores.length) return resumen;
  const leer = db.prepare('SELECT matricula,nombre,email FROM padron WHERE matricula=? COLLATE NOCASE'), cuenta = db.prepare('SELECT 1 FROM users WHERE matricula=? COLLATE NOCASE');
  const insertar = db.prepare('INSERT INTO padron(matricula,nombre,email) VALUES(?,?,?)'), actualizar = db.prepare('UPDATE padron SET nombre=?, email=? WHERE matricula=?');
  db.exec('BEGIN');
  try {
    for (const p of listas) {
      const ant = leer.get(p.matricula), email = p.correo ?? ant?.email ?? null;      // un correo vacío en el archivo no borra el que ya estaba
      if (!email) resumen.sinCorreo++; if (cuenta.get(p.matricula)) resumen.conCuenta++;
      if (!ant) { resumen.nuevas++; insertar.run(p.matricula, p.nombre, email); }
      else if (ant.nombre !== p.nombre || (ant.email ?? null) !== email) { resumen.actualizadas++; actualizar.run(p.nombre, email, ant.matricula); }   // conserva la forma guardada de la matrícula
      else resumen.sinCambios++;
    }
    db.exec(simular ? 'ROLLBACK' : 'COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return resumen;
}

function main(argv) {
  const archivo = argv.find(a => !a.startsWith('--')), simular = argv.includes('--simular');
  if (!archivo) { console.error('Uso: npm run cargar-padron -- <archivo.csv> [--simular]'); return 2; }
  let buffer; try { buffer = fs.readFileSync(archivo); } catch (e) { throw new Error(`No se pudo leer "${archivo}": ${e.code === 'ENOENT' ? 'no existe' : e.message}`); }
  const r = cargarPadron(require('../server').db, buffer, { simular });
  if (r.errores.length) { console.error(`No se cargó nada: ${r.errores.length} ${r.errores.length === 1 ? 'error' : 'errores'} en ${r.filas} filas.`); r.errores.slice(0, 50).forEach(e => console.error('  ' + e)); if (r.errores.length > 50) console.error(`  … y ${r.errores.length - 50} más.`); return 1; }
  console.log(`${simular ? 'SIMULACIÓN (no se escribió nada). Resultaría: ' : 'Listo: '}${r.filas} filas · ${r.nuevas} nuevas · ${r.actualizadas} actualizadas · ${r.sinCambios} sin cambios.`);
  if (r.conCuenta) console.log(`  ${r.conCuenta} ya tienen cuenta (su correo de cuenta no cambia; el del padrón solo se usa para registros nuevos).`);
  if (r.sinCorreo) console.log(`  Aviso: ${r.sinCorreo} sin correo en el padrón: al registrarse se aceptará el que escriban (del dominio DOMINIOS_CORREO), lo que deja la matrícula menos protegida.`);
  return 0;
}

module.exports = cargarPadron; module.exports.leerCsv = leerCsv;
if (require.main === module) { try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error('Error: ' + e.message); process.exit(1); } }
