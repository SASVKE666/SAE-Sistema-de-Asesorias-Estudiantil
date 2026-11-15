// Horarios recurrentes: series semanales, ver y quitar horarios, sin tocar lo que ya tiene una asesoría.
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV; delete process.env.ZONA_HORARIA;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, AHORA = Date.UTC(2026, 10, 16, 15, 0);                 // lunes 2026-11-16, 08:00 en Nayarit (UTC-7)
let srv, base;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; }; return c; };
const docente = async m => { const c = cliente(); assert.equal((await c.call('/api/login', 'POST', { matricula: m, password: 'Docente2026' })).status, 200); c.id = db.prepare('SELECT d.id FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula=?').get(m).id; return c; };
const estudiante = async m => { const c = cliente(); db.prepare('INSERT OR IGNORE INTO padron(matricula,nombre) VALUES(?,?)').run(m, 'Alumno ' + m);
  await correo.registrar((u, b) => c.call(u, 'POST', b), { matricula: m, email: m + '@uan.edu.mx', password: 'segura1234' }); return c; };
const filas = (docId, extra = '') => db.prepare(`SELECT fecha,hora,libre,serie_id FROM horarios WHERE docente_id=? ${extra} ORDER BY fecha,hora`).all(docId);
const lista = (docId, serie) => filas(docId, serie ? `AND serie_id=${serie}` : '').map(h => `${h.fecha} ${h.hora}`);
const SERIE = { dias: [1, 3], inicio: '10:00', fin: '12:00', duracion: 60, desde: '2026-11-16', hasta: '2026-11-30' };
let doc1, doc2, ana;
test.before(async () => { test.mock.method(Date, 'now', () => AHORA); await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); });
  db.prepare('DELETE FROM horarios').run(); doc1 = await docente('DOC001'); doc2 = await docente('DOC002'); ana = await estudiante('24100001'); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { db.exec('DELETE FROM asesorias; DELETE FROM horarios; DELETE FROM series;'); });

test('una serie crea los bloques de cada día elegido en el periodo (y solo ahí)', async () => {
  const r = await doc1.call('/api/series', 'POST', SERIE); assert.equal(r.status, 200); assert.deepEqual([r.json.creados, r.json.yaExistian, r.json.pasados], [10, 0, 0]);
  assert.deepEqual(lista(doc1.id), ['2026-11-16 10:00', '2026-11-16 11:00', '2026-11-18 10:00', '2026-11-18 11:00', '2026-11-23 10:00', '2026-11-23 11:00', '2026-11-25 10:00', '2026-11-25 11:00', '2026-11-30 10:00', '2026-11-30 11:00']);
  assert.equal(filas(doc2.id).length, 0, 'el otro docente no recibe nada'); assert.ok(filas(doc1.id).every(h => h.libre === 1 && h.serie_id === r.json.serie_id));
  const verlo = await ana.call(`/api/docentes/${doc1.id}/horarios`); assert.equal(verlo.json.length, 10, 'los estudiantes los ven como libres');
});

test('todos los días de la semana funcionan (1 = lunes … 7 = domingo)', async () => {
  const r = await doc1.call('/api/series', 'POST', { ...SERIE, dias: [1, 2, 3, 4, 5, 6, 7], inicio: '10:00', fin: '10:30', duracion: 30, desde: '2026-11-16', hasta: '2026-11-22' });
  assert.equal(r.json.creados, 7); assert.deepEqual(lista(doc1.id), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map(f => f + ' 10:00'));
  const solo = await doc2.call('/api/series', 'POST', { ...SERIE, dias: [7], inicio: '10:00', fin: '10:30', duracion: 30, desde: '2026-11-16', hasta: '2026-11-29' }); assert.deepEqual(lista(doc2.id), ['2026-11-22 10:00', '2026-11-29 10:00']); assert.equal(solo.json.creados, 2);
});

test('la duración manda: el último bloque tiene que caber completo antes de la hora final', async () => {
  const r = await doc1.call('/api/series', 'POST', { ...SERIE, dias: [2], inicio: '08:00', fin: '10:00', duracion: 45, desde: '2026-11-17', hasta: '2026-11-17' });
  assert.equal(r.status, 200); assert.deepEqual(lista(doc1.id), ['2026-11-17 08:00', '2026-11-17 08:45'], '09:30 + 45 min pasaría de las 10:00');
  const exacta = await doc1.call('/api/series', 'POST', { ...SERIE, dias: [4], inicio: '09:00', fin: '10:30', duracion: 90, desde: '2026-11-19', hasta: '2026-11-19' }); assert.deepEqual(lista(doc1.id).slice(2), ['2026-11-19 09:00']);
  assert.equal(exacta.json.creados, 1);
});

test('los bloques que ya pasaron (hoy, antes de ahora) se omiten y se cuentan', async () => {
  const r = await doc1.call('/api/series', 'POST', { ...SERIE, dias: [1], inicio: '07:00', fin: '10:00', duracion: 60, desde: '2026-11-16', hasta: '2026-11-16' });
  assert.deepEqual([r.json.creados, r.json.pasados], [1, 2], '07:00 y 08:00 (que empieza justo ahora) ya pasaron'); assert.deepEqual(lista(doc1.id), ['2026-11-16 09:00']);
});

test('repetir la misma serie no duplica nada; un horario con asesoría no se toca', async () => {
  await doc1.call('/api/series', 'POST', SERIE); const h = db.prepare("SELECT id FROM horarios WHERE fecha='2026-11-18' AND hora='10:00'").get().id;
  assert.equal((await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'Una duda' })).status, 200);
  const otra = await doc1.call('/api/series', 'POST', SERIE); assert.deepEqual([otra.json.creados, otra.json.yaExistian, otra.json.ocupados], [0, 9, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM horarios').get().n, 10); assert.equal(db.prepare('SELECT libre FROM horarios WHERE id=?').get(h).libre, 0);
});

test('datos inválidos: se rechazan sin crear nada', async () => {
  const malos = [{ dias: [] }, { dias: [0] }, { dias: [8] }, { dias: [1, 1] }, { dias: 'lunes' }, { dias: [1.5] }, { dias: undefined }, { inicio: '25:00' }, { inicio: '10:60' }, { inicio: '9:00' }, { fin: undefined },
    { inicio: '12:00', fin: '10:00' }, { inicio: '10:00', fin: '10:00' }, { duracion: 5 }, { duracion: 300 }, { duracion: '60' }, { duracion: 59 }, { desde: '2026-02-30' }, { desde: '16/11/2026' }, { hasta: '2026-13-01' },
    { desde: '2026-12-01', hasta: '2026-11-30' }, { desde: '2026-10-01', hasta: '2026-11-15' }, { hasta: '2027-03-31' }, { inicio: '10:00', fin: '10:30', duracion: 60 }, { dias: [7], desde: '2026-11-16', hasta: '2026-11-20' },
    { inicio: '00:00', fin: '23:59', duracion: 15, hasta: '2027-02-10' }];
  for (const m of malos) { const r = await doc1.call('/api/series', 'POST', { ...SERIE, ...m }); assert.equal(r.status, 400, JSON.stringify(m)); assert.ok(r.json.error); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM horarios').get().n, 0); assert.equal(db.prepare('SELECT COUNT(*) n FROM series').get().n, 0);
  const justo = await doc1.call('/api/series', 'POST', { ...SERIE, desde: '2026-11-16', hasta: '2027-03-15' }); assert.equal(justo.status, 200, '120 días exactos sí');
});

test('permisos: solo docentes, cada uno con lo suyo', async () => {
  const sin = cliente(); for (const [u, m, b] of [['/api/series', 'POST', SERIE], ['/api/series', 'GET'], ['/api/mis-horarios', 'GET'], ['/api/horarios/1', 'DELETE'], ['/api/series/1', 'DELETE']]) {
    assert.equal((await sin.call(u, m, b)).status, 401, 'sin sesión ' + m + u); assert.equal((await ana.call(u, m, b)).status, 403, 'estudiante ' + m + u); }
  const s = (await doc1.call('/api/series', 'POST', SERIE)).json.serie_id, h = db.prepare('SELECT id FROM horarios LIMIT 1').get().id;
  assert.equal((await doc2.call('/api/series/' + s, 'DELETE')).status, 404); assert.equal((await doc2.call('/api/horarios/' + h, 'DELETE')).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM horarios').get().n, 10); assert.equal((await doc2.call('/api/series')).json.length, 0); assert.equal((await doc2.call('/api/mis-horarios')).json.length, 0);
});

test('quitar un horario: libre sin historia se borra; con asesorías canceladas se retira sin perder el historial; con asesoría viva no', async () => {
  await doc1.call('/api/series', 'POST', { ...SERIE, dias: [1], hasta: '2026-11-16' });                          // 16/11 10:00 y 11:00
  const [a, b] = db.prepare('SELECT id FROM horarios ORDER BY hora').all().map(x => x.id);
  assert.equal((await doc1.call('/api/horarios/' + a, 'DELETE')).status, 200); assert.equal(db.prepare('SELECT COUNT(*) n FROM horarios WHERE id=?').get(a).n, 0, 'sin historia: se borra');
  const asesoria = (await ana.call('/api/asesorias', 'POST', { horario_id: b, materia: 'Estadística', duda: 'Una duda' })).json.id;
  assert.equal((await doc1.call('/api/horarios/' + b, 'DELETE')).status, 409, 'con asesoría viva no');
  assert.equal((await ana.call('/api/asesorias/' + asesoria, 'PATCH', { estado: 'cancelada' })).status, 200);
  assert.equal((await doc1.call('/api/horarios/' + b, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT libre FROM horarios WHERE id=?').get(b).libre, 0, 'con historial: se conserva fuera de uso'); assert.equal(db.prepare('SELECT estado FROM asesorias WHERE id=?').get(asesoria).estado, 'cancelada');
  assert.equal((await ana.call(`/api/docentes/${doc1.id}/horarios`)).json.length, 0, 'los estudiantes no lo ven'); assert.equal((await doc1.call('/api/mis-horarios')).json.length, 0, 'ni el docente en su lista');
  assert.equal((await ana.call('/api/asesorias', 'POST', { horario_id: b, materia: 'Estadística', duda: 'Otra duda' })).status, 409, 'y nadie puede reservarlo');
  assert.equal((await doc1.call('/api/horarios', 'POST', { fecha: '2026-11-16', hora: '11:00' })).status, 200, 'si lo vuelve a agregar, se reactiva'); assert.equal((await doc1.call('/api/mis-horarios')).json.length, 1);
  assert.equal((await doc1.call('/api/horarios/99999', 'DELETE')).status, 404);
});

test('quitar una serie retira sus horarios libres futuros y conserva los que ya tienen asesoría', async () => {
  const s = (await doc1.call('/api/series', 'POST', SERIE)).json.serie_id; const h = db.prepare("SELECT id FROM horarios WHERE fecha='2026-11-23' AND hora='10:00'").get().id;
  await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'Una duda' });
  const ant = (await doc1.call('/api/series')).json[0]; assert.deepEqual([ant.libres, ant.reservados, ant.dias], [9, 1, [1, 3]]);
  const r = await doc1.call('/api/series/' + s, 'DELETE'); assert.deepEqual([r.status, r.json.quitados, r.json.conservados], [200, 9, 1]);
  assert.deepEqual(lista(doc1.id), ['2026-11-23 10:00']); assert.equal(filas(doc1.id)[0].serie_id, null, 'queda como horario suelto'); assert.equal((await doc1.call('/api/series')).json.length, 0);
  assert.equal((await doc1.call('/api/series/' + s, 'DELETE')).status, 404, 'ya no existe');
});

test('"mis horarios" muestra solo los próximos, libres o reservados, con su estado', async () => {
  db.prepare("INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,'2026-11-10','10:00'),(?,'2026-11-16','08:00'),(?,'2026-11-20','10:00'),(?,'2026-11-21','10:00')").run(doc1.id, doc1.id, doc1.id, doc1.id);
  db.prepare("INSERT INTO horarios(docente_id,fecha,hora,libre) VALUES(?,'2026-11-22','10:00',0)").run(doc1.id);                       // retirado
  const h = db.prepare("SELECT id FROM horarios WHERE fecha='2026-11-21'").get().id; await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'Una duda' });
  const l = (await doc1.call('/api/mis-horarios')).json; assert.deepEqual(l.map(x => [x.fecha, x.libre, x.estado]), [['2026-11-20', 1, null], ['2026-11-21', 0, 'pendiente']]);
});

test('un horario suelto ahora se valida: fecha y hora reales y futuras', async () => {
  for (const b of [{ fecha: '2026-02-30', hora: '10:00' }, { fecha: '2026-11-20', hora: '99:99' }, { fecha: '2026-11-20', hora: '24:00' }, { fecha: '2026-11-15', hora: '10:00' }, { fecha: '2026-11-16', hora: '08:00' }, { fecha: 20261120, hora: '10:00' }, { fecha: '2026-11-20' }, {}])
    assert.equal((await doc1.call('/api/horarios', 'POST', b)).status, 400, JSON.stringify(b));
  assert.equal((await doc1.call('/api/horarios', 'POST', { fecha: '2026-11-20', hora: '10:00' })).status, 200);
  assert.equal((await doc1.call('/api/horarios', 'POST', { fecha: '2026-11-20', hora: '10:00' })).status, 409, 'repetido');
});

test('una base creada antes de existir las series se actualiza sola al arrancar', () => {
  const { spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-mig-')), bd = path.join(dir, 'vieja.db');
  try {
    const { DatabaseSync } = require('node:sqlite'), v = new DatabaseSync(bd);
    v.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, matricula TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, email TEXT NOT NULL, rol TEXT NOT NULL, pass_hash TEXT NOT NULL); CREATE TABLE docentes(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, materias TEXT NOT NULL, cubiculo TEXT, foto TEXT); CREATE TABLE horarios(id INTEGER PRIMARY KEY, docente_id INTEGER NOT NULL, fecha TEXT NOT NULL, hora TEXT NOT NULL, libre INTEGER NOT NULL DEFAULT 1, UNIQUE(docente_id,fecha,hora)); INSERT INTO horarios(docente_id,fecha,hora) VALUES(1,'2030-01-01','10:00');"); v.close();
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', "const a=require('./server');console.log(JSON.stringify([a.db.prepare('PRAGMA table_info(horarios)').all().map(c=>c.name),a.db.prepare('SELECT COUNT(*) n FROM series').get().n,a.db.prepare('SELECT COUNT(*) n FROM horarios').get().n]))"],
      { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [['id', 'docente_id', 'fecha', 'hora', 'libre', 'serie_id'], 0, 1]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
