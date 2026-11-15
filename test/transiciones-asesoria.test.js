// Ciclo de vida de una asesoría: cancelar dos veces o reabrir una cancelada no puede dejar a dos estudiantes con el mismo horario.
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db; let srv, base;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; };
  c.reservar = h => c.call('/api/asesorias', 'POST', { horario_id: h, materia: 'Estadística', duda: 'Duda de prueba' });
  c.estado = (id, estado) => c.call('/api/asesorias/' + id, 'PATCH', { estado });
  return c; };
const memo = {}, una = (k, f) => memo[k] ||= f();                                  // cada persona se registra / entra una sola vez para todo el archivo
const estudiante = m => una(m, async () => { const c = cliente(); db.prepare('INSERT OR IGNORE INTO padron(matricula,nombre) VALUES(?,?)').run(m, 'Alumno ' + m);
  await correo.registrar((u, b) => c.call(u, 'POST', b), { matricula: m, email: m + '@uan.edu.mx', password: 'segura1234' }); return c; });
const docente = m => una(m, async () => { const c = cliente(); assert.equal((await c.call('/api/login', 'POST', { matricula: m, password: 'Docente2026' })).status, 200); return c; });
const horarios = d => db.prepare('SELECT id FROM horarios WHERE docente_id=? AND libre=1 ORDER BY fecha,hora').all(d).map(h => h.id);
const libre = h => db.prepare('SELECT libre FROM horarios WHERE id=?').get(h).libre;
const estadoDe = id => db.prepare('SELECT estado FROM asesorias WHERE id=?').get(id).estado;
const avisos = () => db.prepare('SELECT COUNT(*) n FROM notificaciones').get().n;
test.before(() => new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }));
test.after(() => srv.close());

test('cancelar dos veces NO libera un horario que otra persona ya reservó', async () => {
  const ana = await estudiante('24100001'), diego = await estudiante('24100002'), eva = await estudiante('24100003'), [h] = horarios(1);
  const a = (await ana.reservar(h)).json.id; assert.equal((await ana.estado(a, 'cancelada')).status, 200); assert.equal(libre(h), 1, 'al cancelar se libera');
  const d = (await diego.reservar(h)).json.id; assert.ok(d, 'Diego toma el horario liberado'); assert.equal(libre(h), 0);
  const antes = avisos(), otra = await ana.estado(a, 'cancelada');
  assert.equal(otra.status, 409); assert.match(otra.json.error, /ya estaba cancelada/);
  assert.equal(libre(h), 0, 'el horario sigue ocupado por Diego'); assert.equal(estadoDe(d), 'pendiente'); assert.equal(avisos(), antes, 'no se mandan avisos de un cambio rechazado');
  assert.equal((await eva.reservar(h)).status, 409, 'nadie más puede tomarlo');
});

test('el docente tampoco puede cancelar dos veces, ni reabrir o realizar una cancelada', async () => {
  const ana = await estudiante('24100001'), diego = await estudiante('24100002'), doc = await docente('DOC001'), [h] = horarios(1);
  const a = (await ana.reservar(h)).json.id; assert.equal((await doc.estado(a, 'cancelada')).status, 200);
  const d = (await diego.reservar(h)).json.id;
  for (const e of ['cancelada', 'confirmada', 'realizada']) { const r = await doc.estado(a, e); assert.equal(r.status, 409, e); assert.equal(estadoDe(a), 'cancelada'); assert.equal(libre(h), 0, 'el horario de Diego sigue ocupado (' + e + ')'); }
  assert.equal(estadoDe(d), 'pendiente');
});

test('una asesoría realizada es definitiva: no se cancela (el horario no se libera) ni se reabre', async () => {
  const ana = await estudiante('24100001'), doc = await docente('DOC001'), [h] = horarios(1);
  const a = (await ana.reservar(h)).json.id; assert.equal((await doc.estado(a, 'confirmada')).status, 200); assert.equal((await doc.estado(a, 'realizada')).status, 200);
  for (const [quien, e] of [[ana, 'cancelada'], [doc, 'cancelada'], [doc, 'confirmada'], [doc, 'realizada']]) assert.equal((await quien.estado(a, e)).status, 409, e);
  assert.equal(estadoDe(a), 'realizada'); assert.equal(libre(h), 0);
});

test('el orden es pendiente → confirmada → realizada: no se salta ni se repite', async () => {
  const ana = await estudiante('24100001'), doc = await docente('DOC001'), [h] = horarios(1);
  const a = (await ana.reservar(h)).json.id;
  assert.equal((await doc.estado(a, 'realizada')).status, 409, 'no se puede realizar sin confirmar'); assert.equal(estadoDe(a), 'pendiente');
  assert.equal((await doc.estado(a, 'confirmada')).status, 200); const antes = avisos();
  assert.equal((await doc.estado(a, 'confirmada')).status, 409, 'confirmar dos veces'); assert.equal(avisos(), antes, 'sin avisos duplicados');
  assert.equal((await ana.estado(a, 'cancelada')).status, 200, 'una confirmada todavía se cancela'); assert.equal(libre(h), 1);
});

test('permisos: otro estudiante no cancela; otro docente no toca la asesoría aunque comparta correo', async () => {
  const ana = await estudiante('24100001'), diego = await estudiante('24100002'), doc1 = await docente('DOC001'), doc2 = await docente('DOC002'), [h] = horarios(1);
  const a = (await ana.reservar(h)).json.id;
  assert.equal((await diego.estado(a, 'cancelada')).status, 403); assert.equal((await doc2.estado(a, 'confirmada')).status, 403);
  db.prepare("UPDATE users SET email=(SELECT email FROM users WHERE matricula='DOC001') WHERE matricula='DOC002'").run();   // mismo correo: antes se identificaba al docente por correo
  assert.equal((await doc2.estado(a, 'confirmada')).status, 403, 'el docente se identifica por su cuenta, no por el correo');
  assert.equal((await doc1.estado(a, 'confirmada')).status, 200); assert.equal((await ana.estado(a, 'confirmada')).status, 400, 'el estudiante no confirma');
  for (const e of ['xyz', '', null, undefined, 5]) assert.equal((await doc1.estado(a, e)).status, 400, String(e));
  assert.equal((await doc1.call('/api/asesorias/99999', 'PATCH', { estado: 'confirmada' })).status, 400);
});

test('propiedad: tras cualquier secuencia de reservas y cambios, cada horario tiene a lo sumo UNA asesoría viva y el horario refleja la realidad', async () => {
  const est = [await estudiante('24100001'), await estudiante('24100002'), await estudiante('24100003')], docs = [await docente('DOC001'), await docente('DOC002')];
  const hs = horarios(1).slice(0, 3).concat(horarios(2).slice(0, 2)); let semilla = 12345; const azar = n => (semilla = (semilla * 1103515245 + 12345) % 2147483648) % n;
  const creadas = []; let rechazadas = 0;
  for (let paso = 0; paso < 400; paso++) {
    if (azar(3) === 0 || !creadas.length) { const r = await est[azar(3)].reservar(hs[azar(hs.length)]); if (r.json.id) creadas.push(r.json.id); }
    else { const id = creadas[azar(creadas.length)], quien = azar(5) < 3 ? est[azar(3)] : docs[azar(2)], r = await quien.estado(id, ['confirmada', 'realizada', 'cancelada'][azar(3)]); if (r.status === 409) rechazadas++; }
    for (const h of hs) {
      const vivas = db.prepare("SELECT COUNT(*) n FROM asesorias WHERE horario_id=? AND estado IN ('pendiente','confirmada','realizada')").get(h).n;
      assert.ok(vivas <= 1, `horario ${h}: ${vivas} asesorías vivas (paso ${paso})`); assert.equal(libre(h), vivas ? 0 : 1, `horario ${h} mal marcado (paso ${paso})`);
    }
  }
  assert.ok(creadas.length >= 6 && rechazadas > 10, `la secuencia ejercitó el caso (${creadas.length} reservas, ${rechazadas} cambios rechazados)`);
});
