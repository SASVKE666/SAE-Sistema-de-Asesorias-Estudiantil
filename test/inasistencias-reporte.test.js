// Inasistencia (el estudiante no llegó) y reporte para el docente (lo suyo) y la secretaría (todo), con exportación a CSV.
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV; delete process.env.ZONA_HORARIA; delete process.env.RECORDATORIO_HORAS;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, AHORA = Date.UTC(2026, 10, 16, 15, 0);                       // lunes 2026-11-16 08:00 en Nayarit
let srv, base, desfase = 0, doc, doc2, sec, ana, beto;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body, crudo) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0];
    return crudo ? { status: r.status, headers: r.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()) } : { status: r.status, json: await r.json() }; }; return c; };
const idDoc = m => db.prepare('SELECT d.id FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula=?').get(m).id, idUser = m => db.prepare('SELECT id FROM users WHERE matricula=?').get(m).id;
const horario = (docente, fecha, hora) => Number(db.prepare('INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,?,?)').run(docente, fecha, hora).lastInsertRowid);
const fila = (docente, matricula, fecha, hora, estado, materia = 'Estadística') => Number(db.prepare('INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda,estado) VALUES(?,?,?,?,?,?)').run(idUser(matricula), docente, horario(docente, fecha, hora), materia, 'Duda', estado).lastInsertRowid);
const estado = id => db.prepare('SELECT estado FROM asesorias WHERE id=?').get(id).estado;
// Reserva y confirma por la API una asesoría que es futura ahora; luego el reloj avanza `horas` y ya empezó.
const confirmada = async (fecha, hora) => { const h = horario(idDoc('DOC001'), fecha, hora), r = await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'Una duda' }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await doc.call('/api/asesorias/' + r.json.id, 'PATCH', { estado: 'confirmada' })).status, 200); return { id: r.json.id, h }; };
const acceso = async (m, p) => { const c = cliente(); assert.equal((await c.call('/api/login', 'POST', { matricula: m, password: p })).status, 200); return c; };
const alta = async (matricula, nombre, email) => { db.prepare('INSERT OR IGNORE INTO padron(matricula,nombre) VALUES(?,?)').run(matricula, nombre); const c = cliente(); await correo.registrar((u, b) => c.call(u, 'POST', b), { matricula, email, password: 'segura1234' }); return c; };
test.before(async () => { test.mock.method(Date, 'now', () => AHORA + desfase); await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); });
  doc = await acceso('DOC001', 'Docente2026'); doc2 = await acceso('DOC002', 'Docente2026'); sec = await acceso('SEC001', 'Secretaria2026');
  ana = await alta('24100001', 'Ana Torres', 'ana@uan.edu.mx'); beto = await alta('24100002', 'Beto Ruiz', 'beto@uan.edu.mx'); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { desfase = 0; delete process.env.ZONA_HORARIA; db.exec('DELETE FROM asesorias; DELETE FROM horarios; DELETE FROM notificaciones;'); correo.enviados.length = 0; });

test('el docente registra la inasistencia de una asesoría confirmada que ya empezó; avisa a todos y queda cerrada', async () => {
  const { id } = await confirmada('2026-11-16', '09:00'); desfase = 3600e3;        // ahora son las 09:00
  correo.enviados.length = 0; const r = await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' }); assert.equal(r.status, 200); assert.equal(estado(id), 'inasistencia');
  const m = correo.enviados.filter(x => /con inasistencia/.test(x.subject)); assert.ok(m.length >= 3, 'estudiante, docente y secretaría'); assert.ok(m.every(x => /el estudiante no asistió/.test(x.text)));
  for (const otro of ['confirmada', 'realizada', 'cancelada']) { const x = await doc.call('/api/asesorias/' + id, 'PATCH', { estado: otro }); assert.equal(x.status, 409, otro); }
  assert.equal((await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'pendiente' })).status, 400, 'a pendiente nunca se vuelve');
  assert.equal((await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' })).status, 409, 'ni repetirla'); assert.equal(estado(id), 'inasistencia');
});

test('antes de la hora de inicio da 409, y llegada la hora ya se puede (justo a las 09:00)', async () => {
  const { id } = await confirmada('2026-11-16', '09:00'); desfase = 3600e3 - 60e3;
  const x = await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' }); assert.equal(x.status, 409); assert.match(x.json.error, /Todavía no llega la hora/); assert.equal(estado(id), 'confirmada');
  desfase = 3600e3; assert.equal((await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' })).status, 200);
});

test('solo desde confirmada (no desde pendiente), solo el docente de esa asesoría y nunca el estudiante', async () => {
  const h = horario(idDoc('DOC001'), '2026-11-16', '09:00'), p = await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'D' }); desfase = 3600e3;
  assert.equal((await doc.call('/api/asesorias/' + p.json.id, 'PATCH', { estado: 'inasistencia' })).status, 409, 'pendiente'); desfase = 0;
  const { id } = await confirmada('2026-11-16', '10:00'); desfase = 3 * 3600e3;
  assert.equal((await ana.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' })).status, 400, 'el estudiante no puede declararse ausente');
  assert.equal((await doc2.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' })).status, 403, 'otro docente'); assert.equal(estado(id), 'confirmada');
});

test('la inasistencia sigue ocupando el horario: no se libera ni se puede borrar, y la lista marca `empezo`', async () => {
  const { id, h } = await confirmada('2026-11-16', '09:00'), lista = async () => (await doc.call('/api/asesorias')).json.find(a => a.id === id);
  assert.equal((await lista()).empezo, false); desfase = 3600e3; assert.equal((await lista()).empezo, true);
  assert.equal((await doc.call('/api/asesorias/' + id, 'PATCH', { estado: 'inasistencia' })).status, 200);
  assert.equal(db.prepare('SELECT libre FROM horarios WHERE id=?').get(h).libre, 0); assert.equal((await doc.call('/api/horarios/' + h, 'DELETE')).status, 409);
  assert.equal((await ana.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'D' })).status >= 400, true, 'nadie más puede reservarlo');
});

test('el reporte cuenta por categoría, calcula la tasa y separa «sin cerrar» de «próximas»', async () => {
  const d1 = idDoc('DOC001');
  fila(d1, '24100001', '2026-11-02', '09:00', 'realizada'); fila(d1, '24100001', '2026-11-03', '09:00', 'realizada'); fila(d1, '24100001', '2026-11-04', '09:00', 'inasistencia');
  fila(d1, '24100002', '2026-11-05', '09:00', 'inasistencia'); fila(d1, '24100002', '2026-11-06', '09:00', 'cancelada');
  fila(d1, '24100002', '2026-11-10', '09:00', 'confirmada'); fila(d1, '24100002', '2026-11-11', '09:00', 'pendiente');         // pasadas sin cerrar
  fila(d1, '24100002', '2026-11-16', '07:59', 'confirmada'); fila(d1, '24100002', '2026-11-16', '08:00', 'confirmada');       // 08:00 = ya empezó
  fila(d1, '24100002', '2026-11-16', '08:01', 'confirmada'); fila(d1, '24100001', '2026-11-20', '09:00', 'pendiente');         // próximas
  const r = await doc.call('/api/reporte?desde=2026-11-01&hasta=2026-11-30'); assert.equal(r.status, 200);
  assert.deepEqual(r.json.totales, { total: 11, realizadas: 2, inasistencias: 2, canceladas: 1, sinCerrar: 4, proximas: 2, tasaInasistencia: 50 });
  assert.equal(r.json.alcance, 'propio'); assert.equal(r.json.desde, '2026-11-01'); assert.equal(r.json.hasta, '2026-11-30');
  assert.deepEqual(r.json.estudiantes.map(e => [e.matricula, e.inasistencias, e.realizadas, e.ultima]), [['24100001', 1, 2, '2026-11-04'], ['24100002', 1, 0, '2026-11-05']].sort((a, b) => b[1] - a[1] || 0), 'ordenados por inasistencias y luego nombre');
});

test('la tasa es 1 decimal, nula si no hay asesorías cerradas, y los estudiantes sin inasistencias no salen', async () => {
  const d1 = idDoc('DOC001'); let r = (await doc.call('/api/reporte?desde=2026-11-01&hasta=2026-11-30')).json; assert.equal(r.totales.tasaInasistencia, null); assert.deepEqual(r.estudiantes, []); assert.deepEqual(r.porDocente, []);
  fila(d1, '24100001', '2026-11-02', '09:00', 'realizada'); fila(d1, '24100001', '2026-11-03', '09:00', 'realizada'); fila(d1, '24100002', '2026-11-04', '09:00', 'inasistencia');
  r = (await doc.call('/api/reporte?desde=2026-11-01&hasta=2026-11-30')).json; assert.equal(r.totales.tasaInasistencia, 33.3); assert.deepEqual(r.estudiantes.map(e => e.matricula), ['24100002']);
});

test('el docente solo ve lo suyo; la secretaría ve todo y desglosa por docente', async () => {
  fila(idDoc('DOC001'), '24100001', '2026-11-02', '09:00', 'inasistencia'); fila(idDoc('DOC002'), '24100002', '2026-11-02', '09:00', 'inasistencia'); fila(idDoc('DOC002'), '24100002', '2026-11-03', '09:00', 'inasistencia'); fila(idDoc('DOC003'), '24100001', '2026-11-03', '10:00', 'realizada');
  const q = '?desde=2026-11-01&hasta=2026-11-30', d1 = (await doc.call('/api/reporte' + q)).json, d2 = (await doc2.call('/api/reporte' + q)).json, s = (await sec.call('/api/reporte' + q)).json;
  assert.equal(d1.totales.inasistencias, 1); assert.equal(d1.porDocente.length, 1); assert.deepEqual(d1.estudiantes.map(e => e.matricula), ['24100001']);
  assert.equal(d2.totales.inasistencias, 2); assert.deepEqual(d2.estudiantes.map(e => e.matricula), ['24100002']);
  assert.equal(s.alcance, 'todos'); assert.equal(s.totales.total, 4); assert.equal(s.totales.inasistencias, 3);
  assert.deepEqual(s.porDocente.map(d => [d.nombre, d.inasistencias]), [['Mtra. Patricia Lugo', 2], ['Dr. Héctor Salazar', 1], ['Dr. Ramón Villaseñor', 0]]);
  assert.equal(s.porDocente[2].tasaInasistencia, 0);
  assert.deepEqual(s.estudiantes.map(e => [e.matricula, e.inasistencias]), [['24100002', 2], ['24100001', 1]]);
});

test('el periodo incluye ambos extremos, por defecto son los últimos 30 días hasta hoy, y las fechas se validan', async () => {
  const d1 = idDoc('DOC001'); fila(d1, '24100001', '2026-11-01', '09:00', 'inasistencia'); fila(d1, '24100001', '2026-11-30', '09:00', 'inasistencia'); fila(d1, '24100001', '2026-10-31', '09:00', 'inasistencia');
  assert.equal((await doc.call('/api/reporte?desde=2026-11-01&hasta=2026-11-30')).json.totales.total, 2);
  assert.equal((await doc.call('/api/reporte?desde=2026-11-01&hasta=2026-11-01')).json.totales.total, 1);
  const def = (await doc.call('/api/reporte')).json; assert.equal(def.hasta, '2026-11-16'); assert.equal(def.desde, '2026-10-18'); assert.equal(def.totales.total, 2, 'el 31 de octubre y el 1 de noviembre caen en 18 oct – 16 nov; el 30 de noviembre no');
  assert.equal((await doc.call('/api/reporte?hasta=2026-11-01')).json.desde, '2026-10-03', 'con solo `hasta`, 30 días hacia atrás');
  for (const q of ['?desde=2026-11-30&hasta=2026-11-01', '?desde=2026-13-01', '?desde=hola', '?hasta=2026-02-30', '?desde=2026-1-1&hasta=2026-11-30']) assert.equal((await doc.call('/api/reporte' + q)).status, 400, q);
  assert.equal((await doc.call('/api/reporte?desde=2025-10-13&hasta=2026-11-16')).status, 200, '400 días exactos'); assert.equal((await doc.call('/api/reporte?desde=2025-10-12&hasta=2026-11-16')).status, 400, '401 días');
  assert.equal((await doc.call('/api/reporte/inasistencias.csv?desde=2026-11-30&hasta=2026-11-01', 'GET', null, true)).status, 400);
});

test('el reporte y el CSV exigen sesión de docente o secretaría', async () => {
  for (const u of ['/api/reporte', '/api/reporte/inasistencias.csv']) { assert.equal((await cliente().call(u, 'GET', null, true)).status, 401, 'sin sesión'); assert.equal((await ana.call(u, 'GET', null, true)).status, 403, 'estudiante'); }
});

test('CSV: UTF-8 con BOM, CRLF, nombre de archivo con el periodo, solo inasistencias y solo las del docente', async () => {
  const d1 = idDoc('DOC001'), d2 = idDoc('DOC002');
  fila(d1, '24100001', '2026-11-04', '09:30', 'inasistencia', 'Microeconomía'); fila(d1, '24100002', '2026-11-05', '10:00', 'realizada'); fila(d1, '24100002', '2026-11-06', '10:00', 'cancelada'); fila(d2, '24100002', '2026-11-03', '08:00', 'inasistencia', 'Contabilidad');
  const r = await doc.call('/api/reporte/inasistencias.csv?desde=2026-11-01&hasta=2026-11-30', 'GET', null, true); assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8'); assert.equal(r.headers.get('content-disposition'), 'attachment; filename="inasistencias_2026-11-01_2026-11-30.csv"');
  assert.equal(r.text, '﻿fecha,hora,docente,matricula,estudiante,materia\r\n2026-11-04,09:30,Dr. Héctor Salazar,24100001,Ana Lucía Torres,Microeconomía\r\n'.replace('Ana Lucía Torres', db.prepare("SELECT nombre FROM users WHERE matricula='24100001'").get().nombre));
  const s = await sec.call('/api/reporte/inasistencias.csv?desde=2026-11-01&hasta=2026-11-30', 'GET', null, true); const lineas = s.text.replace('﻿', '').trim().split('\r\n');
  assert.equal(lineas.length, 3, 'encabezado + 2 inasistencias de la Unidad'); assert.match(lineas[1], /^2026-11-03,08:00,Mtra\. Patricia Lugo/, 'ordenado por fecha');
  const vacio = await doc.call('/api/reporte/inasistencias.csv?desde=2026-01-01&hasta=2026-01-31', 'GET', null, true); assert.equal(vacio.text, '﻿fecha,hora,docente,matricula,estudiante,materia\r\n');
});

test('CSV: comas, comillas y saltos de línea se entrecomillan y las fórmulas se neutralizan', async () => {
  const d1 = idDoc('DOC001'); db.prepare("UPDATE users SET nombre=? WHERE matricula='24100002'").run('=HYPERLINK("http://x","clic")');
  fila(d1, '24100002', '2026-11-04', '09:00', 'inasistencia', 'Cálculo, "I"'); fila(d1, '24100002', '2026-11-05', '09:00', 'inasistencia', '+SUMA(1)\nlínea'); fila(d1, '24100002', '2026-11-06', '09:00', 'inasistencia', '-1; @x'); fila(d1, '24100002', '2026-11-07', '09:00', 'inasistencia', 'normal');
  const t = (await doc.call('/api/reporte/inasistencias.csv?desde=2026-11-01&hasta=2026-11-30', 'GET', null, true)).text;
  assert.ok(t.includes(`"'=HYPERLINK(""http://x"",""clic"")"`), 'fórmula neutralizada y comillas duplicadas'); assert.ok(t.includes('"Cálculo, ""I"""'));
  assert.ok(t.includes(`"'+SUMA(1)\nlínea"`)); assert.ok(t.includes(`"'-1; @x"`)); assert.ok(t.endsWith(',normal\r\n'));
  fila(d1, '24100002', '2026-11-08', '09:00', 'inasistencia', '\t=1+1'); fila(d1, '24100002', '2026-11-09', '09:00', 'inasistencia', '\r=2');
  const u = (await doc.call('/api/reporte/inasistencias.csv?desde=2026-11-08&hasta=2026-11-09', 'GET', null, true)).text; assert.ok(u.includes("'\t=1+1"), 'tabulador inicial'); assert.ok(u.includes('"\'\r=2"'), 'retorno de carro inicial');
});
