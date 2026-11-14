#!/usr/bin/env node
// Crea una cuenta de secretaría o de docente con contraseña propia (sin contraseñas conocidas de demostración).
// Uso:   npm run crear-usuario -- secretaria SEC001 "Secretaría de Economía" secretaria@uan.edu.mx
//        npm run crear-usuario -- docente DOC010 "Dra. Ana Pérez" ana@uan.edu.mx --materias "Estadística, Econometría" --cubiculo "Cubículo 3"
// La contraseña se pide por teclado (no se ve) o, para automatizar, se toma de la variable SAE_PASSWORD. Usa la base de DB_FILE (o data/sae.db).
const bcrypt = require('bcryptjs');

const MIN_PASSWORD = 10;
const DEMO_PASSWORDS = ['Secretaria2026', 'Docente2026'];   // contraseñas de seed.js: nunca para cuentas reales

function crearUsuario(db, { rol, matricula, nombre, email, password, materias, cubiculo }) {
  matricula = String(matricula || '').trim(); nombre = String(nombre || '').trim(); email = String(email || '').trim().toLowerCase();
  if (!['secretaria', 'docente'].includes(rol)) throw new Error('El rol debe ser "secretaria" o "docente".');
  if (!matricula || !nombre) throw new Error('Indica matrícula/clave y nombre.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('El correo no es válido.');
  if (String(password || '').length < MIN_PASSWORD) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
  if (DEMO_PASSWORDS.includes(password)) throw new Error('Esa contraseña es la de demostración; elige otra.');
  if (rol === 'docente' && !String(materias || '').trim()) throw new Error('Para un docente indica --materias.');
  if (db.prepare('SELECT 1 FROM users WHERE matricula=?').get(matricula)) throw new Error(`Ya existe un usuario con la matrícula/clave ${matricula}.`);
  if (db.prepare('SELECT 1 FROM users WHERE lower(email)=?').get(email)) throw new Error('Ya existe un usuario con ese correo.');   // la propiedad de una asesoría se decide por correo
  db.exec('BEGIN');
  try {
    const u = db.prepare('INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES(?,?,?,?,?)').run(matricula, nombre, email, rol, bcrypt.hashSync(password, 10));
    if (rol === 'docente') db.prepare('INSERT INTO docentes(user_id,materias,cubiculo) VALUES(?,?,?)').run(u.lastInsertRowid, String(materias).trim(), String(cubiculo || '').trim());
    db.exec('COMMIT');
    return { id: Number(u.lastInsertRowid), matricula, rol };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function pedirPassword(pregunta) {
  return new Promise((ok, fallo) => {
    if (!process.stdin.isTTY) return fallo(new Error('No hay terminal para pedir la contraseña: define la variable SAE_PASSWORD.'));
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(pregunta); rl._writeToOutput = () => {};                  // no mostrar lo que se teclea
    rl.question('', r => { rl.close(); process.stdout.write('\n'); ok(r); });
  });
}

async function main(argv) {
  const opciones = {}, pos = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) opciones[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]); }
  const [rol, matricula, nombre, email] = pos;
  if (!email) { console.error('Uso: npm run crear-usuario -- <secretaria|docente> <matricula> "<nombre>" <correo> [--materias "..." --cubiculo "..."]'); return 2; }
  let password = process.env.SAE_PASSWORD;
  if (!password) { password = await pedirPassword('Contraseña (mínimo ' + MIN_PASSWORD + ' caracteres): '); if (password !== await pedirPassword('Repite la contraseña: ')) throw new Error('Las contraseñas no coinciden.'); }
  const db = require('../server').db;
  const u = crearUsuario(db, { rol, matricula, nombre, email, password, materias: opciones.materias, cubiculo: opciones.cubiculo });
  console.log(`Listo: ${u.rol} ${u.matricula} creada.`); return 0;
}

module.exports = crearUsuario; module.exports.MIN_PASSWORD = MIN_PASSWORD;
if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error('Error: ' + e.message); process.exit(1); });
