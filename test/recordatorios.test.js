// Recordatorios: un correo 24 h antes (configurable) de cada asesoría confirmada, una sola vez, sin duplicar ni perderse.
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV; delete process.env.ZONA_HORARIA; delete process.env.RECORDATORIO_HORAS;
const test = require('node:test'), assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, AHORA = Date.UTC(2026, 10, 16, 15, 0);                       // lunes 2026-11-16 08:00 en Nayarit (UTC-7)
let srv, base, desfase = 0, doc, ana;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; }; return c; };
const docId = db.prepare("SELECT d.id FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula='DOC001'").get().id;
const horario = (fecha, hora) => db.prepare('INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,?,?)').run(docId, fecha, hora).lastInsertRowid;
// Reserva (API) y confirma (API) una asesoría en esa fecha y hora; devuelve su id.
const confirmada = async (fecha, hora) => { const r = await ana.call('/api/asesorias', 'POST', { horario_id: Number(horario(fecha, hora)), materia: 'Estadística', duda: 'Una duda' }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await doc.call('/api/asesorias/' + r.json.id, 'PATCH', { estado: 'confirmada' })).status, 200); return r.json.id; };
const flag = id => db.prepare('SELECT recordatorio FROM asesorias WHERE id=?').get(id).recordatorio;
const recordatorios = () => correo.enviados.filter(m => /Recordatorio/.test(m.subject));
test.before(async () => { test.mock.method(Date, 'now', () => AHORA + desfase); await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); });
  db.prepare('DELETE FROM horarios').run(); doc = cliente(); assert.equal((await doc.call('/api/login', 'POST', { matricula: 'DOC001', password: 'Docente2026' })).status, 200);
  ana = cliente(); db.prepare('INSERT OR IGNORE INTO padron(matricula,nombre) VALUES(?,?)').run('24100001', 'Ana Torres'); await correo.registrar((u, b) => ana.call(u, 'POST', b), { matricula: '24100001', email: 'ana@uan.edu.mx', password: 'segura1234' }); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { desfase = 0; delete process.env.ZONA_HORARIA; delete process.env.RECORDATORIO_HORAS; correo.falla = false; db.exec('DELETE FROM asesorias; DELETE FROM horarios; DELETE FROM notificaciones;'); correo.enviados.length = 0; });

test('se envía al estudiante y al docente cuando falta menos de 24 h, con los datos de la asesoría, y una sola vez', async () => {
  const id = await confirmada('2026-11-17', '09:00');                              // faltan 25 h
  assert.equal(await app.revisarRecordatorios(), 0, 'todavía falta mucho'); assert.equal(recordatorios().length, 0); assert.equal(flag(id), 0);
  desfase = 2 * 3600e3;                                                            // ahora son las 10:00: faltan 23 h
  assert.equal(await app.revisarRecordatorios(), 1); const m = recordatorios(), emailDoc = db.prepare("SELECT email FROM users WHERE matricula='DOC001'").get().email;
  assert.deepEqual(m.map(x => x.to).sort(), ['ana@uan.edu.mx', emailDoc].sort());
  for (const x of m) { assert.match(x.text, /2026-11-17 a las 09:00/); assert.match(x.text, /Estadística/); assert.match(x.text, /Ana Lucía Torres/); assert.match(x.text, /cancélala en el sistema/); assert.match(x.text, /#mis/); }
  assert.equal(flag(id), 1); assert.equal(await app.revisarRecordatorios(), 0, 'no se repite'); assert.equal(recordatorios().length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificaciones WHERE asunto LIKE '%Recordatorio%'").get().n, 2, 'queda en la bitácora');
});

test('dos revisiones simultáneas no duplican el correo', async () => {
  await confirmada('2026-11-17', '07:00'); db.prepare('UPDATE asesorias SET recordatorio=0').run();   // (se confirmó ya dentro de la ventana; aquí se fuerza el caso)
  const [a, b] = await Promise.all([app.revisarRecordatorios(), app.revisarRecordatorios()]); assert.equal(a + b, 1); assert.equal(recordatorios().length, 2);
});

test('con varias asesorías, dos revisiones simultáneas tampoco repiten ninguna', async () => {
  const ids = [await confirmada('2026-11-17', '06:00'), await confirmada('2026-11-17', '06:30'), await confirmada('2026-11-17', '07:00')]; db.prepare('UPDATE asesorias SET recordatorio=0').run();
  const r = await Promise.all([app.revisarRecordatorios(), app.revisarRecordatorios(), app.revisarRecordatorios()]); assert.equal(r.reduce((a, b) => a + b), 3); assert.equal(recordatorios().length, 6);
  for (const id of ids) assert.equal(flag(id), 1);
});

test('confirmar justo 24 h antes ya cuenta como dentro de la ventana (no se manda un segundo correo)', async () => {
  const id = await confirmada('2026-11-17', '08:00'); assert.equal(flag(id), 1); assert.equal(await app.revisarRecordatorios(), 0);
  const tarde = await confirmada('2026-11-17', '08:01'); assert.equal(flag(tarde), 0, 'un minuto más allá todavía le toca recordatorio');
});

test('solo las CONFIRMADAS y futuras: pendientes, canceladas, realizadas, con inasistencia y pasadas no reciben', async () => {
  const mk = async (hora, estado) => { const r = await ana.call('/api/asesorias', 'POST', { horario_id: Number(horario('2026-11-17', hora)), materia: 'Estadística', duda: 'Una duda' }); if (estado !== 'pendiente') db.prepare('UPDATE asesorias SET estado=? WHERE id=?').run(estado, r.json.id); return r.json.id; };
  await mk('10:00', 'pendiente'); await mk('10:30', 'cancelada'); await mk('11:00', 'realizada'); await mk('11:30', 'inasistencia');
  const pasada = Number(horario('2026-11-16', '07:00')); db.prepare("INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda,estado) VALUES((SELECT id FROM users WHERE matricula='24100001'),?,?,'X','Y','confirmada')").run(docId, pasada);
  const empieza = Number(horario('2026-11-16', '08:00')); db.prepare("INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda,estado) VALUES((SELECT id FROM users WHERE matricula='24100001'),?,?,'X','Y','confirmada')").run(docId, empieza);
  assert.equal(await app.revisarRecordatorios(), 0, 'la que empieza justo ahora ya no es futura'); assert.equal(recordatorios().length, 0);
});

test('la ventana: justo 24 h sí, 24 h y un minuto no, y días después no', async () => {
  const dentro = await confirmada('2026-11-17', '08:00'), fuera = await confirmada('2026-11-17', '08:01'), lejos = await confirmada('2026-11-20', '09:00');
  db.prepare('UPDATE asesorias SET recordatorio=0').run(); assert.equal(await app.revisarRecordatorios(), 1);
  assert.equal(flag(dentro), 1); assert.equal(flag(fuera), 0); assert.equal(flag(lejos), 0);
  desfase = 60e3; assert.equal(await app.revisarRecordatorios(), 1, 'un minuto después ya entra la siguiente'); assert.equal(flag(fuera), 1); assert.equal(flag(lejos), 0);
});

test('si se confirma cuando ya falta menos que el aviso, el correo de confirmación hace de recordatorio: no se manda otro', async () => {
  const id = await confirmada('2026-11-17', '07:00');                              // faltan 23 h al confirmar
  assert.equal(flag(id), 1); assert.equal(await app.revisarRecordatorios(), 0); assert.equal(recordatorios().length, 0);
  assert.ok(correo.enviados.some(m => /confirmada/.test(m.subject)), 'sí salió el aviso de confirmación');
});

test('RECORDATORIO_HORAS: 0 lo apaga, otro valor cambia la anticipación y un valor inválido vuelve a 24', async () => {
  const id = await confirmada('2026-11-17', '09:00'); desfase = 2 * 3600e3;
  process.env.RECORDATORIO_HORAS = '0'; assert.equal(await app.revisarRecordatorios(), 0); assert.equal(flag(id), 0);
  process.env.RECORDATORIO_HORAS = '2'; assert.equal(await app.revisarRecordatorios(), 0, 'con 2 h todavía faltan 23');
  desfase = 23 * 3600e3; assert.equal(await app.revisarRecordatorios(), 1, 'ya faltan 2 h'); assert.equal(flag(id), 1);
  for (const mal of ['abc', '-1', '1000', 'NaN', '  ']) { db.prepare('UPDATE asesorias SET recordatorio=0').run(); desfase = 2 * 3600e3; process.env.RECORDATORIO_HORAS = mal; assert.equal(await app.revisarRecordatorios(), 1, 'inválido → 24 h: ' + mal); }
});

test('si el correo falla en todos los destinatarios se reintenta en la siguiente revisión', async () => {
  const id = await confirmada('2026-11-17', '09:00'); desfase = 2 * 3600e3; correo.falla = true;
  assert.equal(await app.revisarRecordatorios(), 0); assert.equal(flag(id), 0, 'la marca se quita para reintentar'); assert.equal(recordatorios().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificaciones WHERE asunto LIKE '%Recordatorio%' AND enviado=0").get().n, 2);
  correo.falla = false; assert.equal(await app.revisarRecordatorios(), 1); assert.equal(recordatorios().length, 2); assert.equal(flag(id), 1);
  desfase = 25 * 3600e3; db.prepare('UPDATE asesorias SET recordatorio=0').run(); assert.equal(await app.revisarRecordatorios(), 0, 'y una asesoría que ya empezó nunca se reintenta');
});

test('usa la hora local de la facultad (ZONA_HORARIA), no UTC', async () => {
  const id = await confirmada('2026-11-17', '09:00');                              // en Nayarit faltan 25 h
  assert.equal(await app.revisarRecordatorios(), 0);
  process.env.ZONA_HORARIA = 'America/Mexico_City';                                // allá ya son las 09:00 de ese lunes: faltan 24 h exactas
  assert.equal(await app.revisarRecordatorios(), 1); assert.equal(flag(id), 1);
});

test('al arrancar el servidor se programa la revisión (y no si RECORDATORIO_HORAS=0); una base antigua recibe la columna', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-rec-'));
  try {
    const arrancar = extra => new Promise(ok => { const env = { ...process.env, DB_FILE: path.join(dir, crypto.randomUUID() + '.db'), PORT: '0', ...extra }; delete env.NODE_ENV;
      const p = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: path.join(__dirname, '..'), env }); let out = ''; p.stdout.on('data', d => { out += d; if (/SAE en/.test(out)) setTimeout(() => p.kill(), 200); }); p.on('exit', () => ok(out)); setTimeout(() => p.kill(), 15000); });
    const bd = path.join(dir, 'vieja.db'), { DatabaseSync } = require('node:sqlite'), v = new DatabaseSync(bd);
    v.exec("CREATE TABLE asesorias(id INTEGER PRIMARY KEY, estudiante_id INTEGER NOT NULL, docente_id INTEGER NOT NULL, horario_id INTEGER NOT NULL, materia TEXT NOT NULL, duda TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente', creada TEXT); INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda) VALUES(1,1,1,'M','D');"); v.close();
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', "const a=require('./server');console.log(JSON.stringify(a.db.prepare('SELECT recordatorio FROM asesorias').all()))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [{ recordatorio: 0 }]);
    return Promise.all([arrancar({}), arrancar({ RECORDATORIO_HORAS: '0' }), arrancar({ RECORDATORIO_HORAS: '6' })]).then(([a, b, c]) => { assert.match(a, /Recordatorios de asesoría: 24 h antes/); assert.ok(!/Recordatorios/.test(b)); assert.match(c, /6 h antes/); }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
});
