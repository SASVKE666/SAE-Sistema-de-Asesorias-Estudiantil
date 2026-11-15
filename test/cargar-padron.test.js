// Carga del padrón desde CSV: valida todo antes de escribir, actualiza sin borrar, y el correo del padrón gobierna el código de registro.
process.env.DB_FILE = ':memory:'; delete process.env.DOMINIOS_CORREO; delete process.env.NODE_ENV;
const test = require('node:test'), assert = require('node:assert');
const { spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'), cargar = require('../scripts/cargar-padron'), db = app.db;
const csv = t => Buffer.from(t, 'utf8');
const padron = () => db.prepare('SELECT matricula,nombre,email FROM padron ORDER BY matricula').all();
test.beforeEach(() => { db.exec("DELETE FROM padron; DELETE FROM users; DELETE FROM codigos;"); });

test('carga normal: encabezado con acentos y mayúsculas, CRLF, BOM, espacios; correo en minúsculas', () => {
  const r = cargar(db, csv('﻿Matrícula,Nombre Completo,Correo Institucional\r\n24100001,  Ana   Lucía Torres ,ANA.Torres@UAN.edu.mx\r\n\r\n24100002,Diego Ramos,diego@uan.edu.mx\r\n'));
  assert.deepEqual([r.filas, r.nuevas, r.actualizadas, r.errores.length], [2, 2, 0, 0]);
  assert.deepEqual(padron(), [{ matricula: '24100001', nombre: 'Ana Lucía Torres', email: 'ana.torres@uan.edu.mx' }, { matricula: '24100002', nombre: 'Diego Ramos', email: 'diego@uan.edu.mx' }]);
});

test('separador punto y coma (Excel en español) y tabulador; comillas con comas y comillas escapadas', () => {
  cargar(db, csv('matricula;nombre;correo\n24100001;"Pérez, Ana ""Anita"""; ana@uan.edu.mx\n'));
  assert.equal(padron()[0].nombre, 'Pérez, Ana "Anita"'); assert.equal(padron()[0].email, 'ana@uan.edu.mx');
  cargar(db, csv('matricula\tnombre\tcorreo\n24100002\tDiego Ramos\td@uan.edu.mx\n')); assert.equal(padron().length, 2);
  cargar(db, csv('clave,alumno,email\n24100003,"Eva\nLinda",e@uan.edu.mx\n')); assert.equal(db.prepare("SELECT nombre FROM padron WHERE matricula='24100003'").get().nombre, 'Eva Linda', 'alias de columnas y salto de línea entre comillas');
});

test('si hay errores no se carga NADA y se listan todos con su línea', () => {
  db.prepare("INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES('DOC001','Doc','doc@uan.edu.mx','docente','x')").run();
  const r = cargar(db, csv([ 'matricula,nombre,correo', '24100001,Ana,ana@uan.edu.mx', 'ab,Corta,c@uan.edu.mx', '24100003,,s@uan.edu.mx', '24100001,Repetida,r@uan.edu.mx',
    '24100005,Mal Correo,sin-arroba', '24100006,Mismo Correo,ana@uan.edu.mx', '24100007,Del Docente,doc@uan.edu.mx', 'DOC001,Es Docente,otro@uan.edu.mx', '24100009,Con Espacio y símbolos,x@uan.edu.mx', '24100 010,Espacio,y@uan.edu.mx' ].join('\n')));
  assert.equal(padron().length, 0, 'la fila válida de la línea 2 tampoco se cargó');
  const t = r.errores.join('\n'); assert.equal(r.errores.length, 8);
  for (const l of [3, 4, 5, 6, 7, 8, 9, 11]) assert.match(t, new RegExp(`Línea ${l}:`), 'línea ' + l);
  assert.match(t, /ya aparece en la línea 2/); assert.match(t, /ya está en la línea 2/); assert.match(t, /ya es de la cuenta DOC001/); assert.match(t, /clave de una cuenta de docente/);
});

test('actualiza las que ya están, cuenta las sin cambios, no borra a nadie y un correo vacío no borra el que había', () => {
  cargar(db, csv('matricula,nombre,correo\n24100001,Ana Torres,ana@uan.edu.mx\n24100002,Diego Ramos,diego@uan.edu.mx\n24100003,Sin Correo,\n'));
  db.prepare("INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES('24100002','Diego Ramos','mio@gmail.com','estudiante','x')").run();
  const r = cargar(db, csv('matricula,nombre,correo\n24100001,Ana Lucía Torres,ana@uan.edu.mx\n24100002,Diego Ramos,\n24100003,Sin Correo,eva@uan.edu.mx\n24100004,Nueva,n@uan.edu.mx\n'));
  assert.deepEqual([r.nuevas, r.actualizadas, r.sinCambios, r.conCuenta, r.sinCorreo], [1, 2, 1, 1, 0]);
  const p = Object.fromEntries(padron().map(x => [x.matricula, x]));
  assert.equal(p['24100001'].nombre, 'Ana Lucía Torres'); assert.equal(p['24100002'].email, 'diego@uan.edu.mx', 'correo vacío no borra'); assert.equal(p['24100003'].email, 'eva@uan.edu.mx'); assert.equal(Object.keys(p).length, 4);
  assert.equal(db.prepare("SELECT email FROM users WHERE matricula='24100002'").get().email, 'mio@gmail.com', 'la cuenta existente no se toca');
  const s = cargar(db, csv('matricula,nombre\n24100001,Ana Lucía Torres\n')); assert.equal(padron().length, 4, 'las que no vienen en el archivo se quedan'); assert.equal(s.sinCambios, 1);
});

test('--simular informa qué haría pero no escribe nada', () => {
  const r = cargar(db, csv('matricula,nombre,correo\n24100001,Ana,ana@uan.edu.mx\n24100002,Diego,\n'), { simular: true });
  assert.deepEqual([r.nuevas, r.sinCorreo, r.simulado], [2, 1, true]); assert.equal(padron().length, 0);
});

test('archivos que no sirven: no UTF-8, vacío, sin encabezado, comillas sin cerrar, demasiado grande o con demasiadas filas', () => {
  assert.throws(() => cargar(db, Buffer.from('matricula,nombre\n24100001,Mar\xEDa\n', 'latin1')), /no está en UTF-8.*CSV UTF-8/);
  assert.throws(() => cargar(db, csv('')), /vacío/); assert.throws(() => cargar(db, csv('  \n\n')), /vacío/);
  assert.throws(() => cargar(db, csv('24100001,Ana,ana@uan.edu.mx\n24100002,Diego,d@uan.edu.mx\n')), /encabezado/);
  assert.throws(() => cargar(db, csv('correo,edad\na@uan.edu.mx,20\n')), /encabezado/);
  assert.throws(() => cargar(db, csv('matricula,nombre\n24100001,"Ana\n')), /comillas sin cerrar/);
  assert.throws(() => cargar(db, Buffer.alloc(5 * 1024 * 1024 + 1, 'a')), /demasiado grande/);
  assert.throws(() => cargar(db, csv('matricula,nombre\n' + Array.from({ length: 50001 }, (_, i) => `M${i + 100},N`).join('\n'))), /Demasiadas filas/);
  assert.equal(padron().length, 0);
});

test('con el correo en el padrón, el código de registro va a ESE correo aunque el alumno escriba otro', async () => {
  cargar(db, csv('matricula,nombre,correo\n24100001,Ana Torres,ana.real@uan.edu.mx\n24100002,Diego Ramos,\n'));
  const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); }), base = 'http://localhost:' + srv.address().port;
  const post = async (u, b) => { const r = await fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
  try {
    const antes = correo.enviados.length; assert.equal((await post('/api/registro', { matricula: '24100001', email: 'atacante@uan.edu.mx', password: 'segura1234' })).status, 200);
    assert.equal(correo.enviados.at(-1).to, 'ana.real@uan.edu.mx'); assert.equal(correo.enviados.length, antes + 1); assert.ok(!correo.enviados.some(m => m.to === 'atacante@uan.edu.mx'));
    assert.equal((await post('/api/registro/confirmar', { matricula: '24100001', codigo: correo.codigo('ana.real@uan.edu.mx') })).status, 200);
    assert.equal(db.prepare("SELECT email FROM users WHERE matricula='24100001'").get().email, 'ana.real@uan.edu.mx');
    assert.equal((await post('/api/registro', { matricula: '24100002', email: 'diego@uan.edu.mx', password: 'segura1234' })).status, 200); assert.equal(correo.enviados.at(-1).to, 'diego@uan.edu.mx', 'sin correo en el padrón rige el dominio');
  } finally { srv.close(); }
});

test('línea de comandos: carga, simula, y falla con mensajes claros', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-padron-')), bd = path.join(dir, 'p.db'), f = nombre => path.join(dir, nombre);
  try {
    fs.writeFileSync(f('ok.csv'), 'matricula,nombre,correo\n24100001,Ana,ana@uan.edu.mx\n24100002,Diego,\n'); fs.writeFileSync(f('mal.csv'), 'matricula,nombre,correo\n24100001,Ana,no-es-correo\n');
    const cli = (...a) => spawnSync(process.execPath, ['--no-warnings', 'scripts/cargar-padron.js', ...a], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' });
    let r = cli(f('ok.csv'), '--simular'); assert.equal(r.status, 0); assert.match(r.stdout, /SIMULACIÓN.*2 nuevas/); assert.match(r.stdout, /1 sin correo/);
    r = cli(f('ok.csv')); assert.equal(r.status, 0); assert.match(r.stdout, /Listo: 2 filas · 2 nuevas/);
    r = cli(f('ok.csv')); assert.equal(r.status, 0); assert.match(r.stdout, /0 nuevas · 0 actualizadas · 2 sin cambios/, 'repetir la carga es inofensivo');
    r = cli(f('mal.csv')); assert.equal(r.status, 1); assert.match(r.stderr, /No se cargó nada: 1 error/); assert.match(r.stderr, /Línea 2: correo no válido/);
    r = cli(); assert.equal(r.status, 2); assert.match(r.stderr, /Uso:/);
    r = cli(f('no-existe.csv')); assert.equal(r.status, 1); assert.match(r.stderr, /no existe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
