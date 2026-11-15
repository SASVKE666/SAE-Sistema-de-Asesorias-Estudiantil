// Tope de asesorías activas por estudiante (por defecto 2): una cuenta no puede acaparar los horarios de un docente.
process.env.DB_FILE = ':memory:'; delete process.env.MAX_ASESORIAS_ACTIVAS;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
let srv, base; const db = app.db;
const cliente = () => {                                                         // cada cliente guarda su propia cookie de sesión
  const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  c.reservar = id => c.call('/api/asesorias', 'POST', { horario_id: id, materia: 'Estadística', duda: 'Duda de prueba' });
  return c;
};
const estudiante = async (matricula) => { const c = cliente(); await correo.registrar((url, b) => c.call(url, 'POST', b), { matricula, email: matricula + '@uan.edu.mx', password: 'segura1234' }); return c; };
const docente = async () => { const c = cliente(); assert.equal((await c.call('/api/login', 'POST', { matricula: 'DOC001', password: 'Docente2026' })).status, 200); return c; };
const libres = docenteId => db.prepare("SELECT id FROM horarios WHERE docente_id=? AND libre=1 AND fecha>date('now') ORDER BY fecha,hora").all(docenteId).map(h => h.id);
const estadoDe = id => db.prepare('SELECT estado FROM asesorias WHERE id=?').get(id).estado;
const cuantas = () => db.prepare('SELECT COUNT(*) n FROM asesorias').get().n;
test.before(() => new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }));
test.after(() => srv.close());

test('el caso original: con los 20 horarios de un docente a la mano, una cuenta solo logra 2', async () => {
  const ana = await estudiante('24100001'), ids = libres(1);
  assert.ok(ids.length >= 4, 'el docente tiene varios horarios libres');
  const r = []; for (const id of ids) r.push((await ana.reservar(id)).status);
  assert.equal(r.filter(s => s === 200).length, 2, 'solo 2 reservas');
  assert.ok(r.slice(2).every(s => s === 409), 'las demás se rechazan con 409');
  assert.equal(cuantas(), 2);
  assert.equal(libres(1).length, ids.length - 2, 'los rechazados siguen libres (no se consumen)');
  const x = await ana.reservar(ids[3]); assert.match(x.json.error, /Ya tienes 2 asesorías activas/);
});

test('es por estudiante: que Ana esté al tope no afecta a Diego', async () => {
  const diego = await estudiante('24100002');
  assert.equal((await diego.reservar(libres(1)[0])).status, 200);
});

test('cancelar libera cupo', async () => {
  const ana = cliente(); await ana.call('/api/login', 'POST', { matricula: '24100001', password: 'segura1234' });
  const mias = (await ana.call('/api/asesorias')).json;
  assert.equal((await ana.reservar(libres(1)[0])).status, 409, 'al tope');
  assert.equal((await ana.call('/api/asesorias/' + mias[0].id, 'PATCH', { estado: 'cancelada' })).status, 200);
  assert.equal((await ana.reservar(libres(1)[0])).status, 200, 'con una cancelada ya cabe otra');
  assert.equal((await ana.reservar(libres(1)[0])).status, 409, 'y vuelve al tope');
});

test('confirmada cuenta como activa; realizada y cancelada no', async () => {
  const doc = await docente(), ana = cliente(); await ana.call('/api/login', 'POST', { matricula: '24100001', password: 'segura1234' });
  const activas = () => db.prepare("SELECT a.id FROM asesorias a WHERE estudiante_id=(SELECT id FROM users WHERE matricula='24100001') AND estado IN ('pendiente','confirmada')").all().map(a => a.id);
  const [a1] = activas(); assert.equal(activas().length, 2);
  assert.equal((await doc.call('/api/asesorias/' + a1, 'PATCH', { estado: 'confirmada' })).status, 200);
  assert.equal((await ana.reservar(libres(1)[0])).status, 409, 'confirmada sigue contando');
  assert.equal((await doc.call('/api/asesorias/' + a1, 'PATCH', { estado: 'realizada' })).status, 200);
  assert.equal(estadoDe(a1), 'realizada');
  assert.equal((await ana.reservar(libres(1)[0])).status, 200, 'la realizada libera cupo');
  assert.equal((await ana.reservar(libres(1)[0])).status, 409);
});

test('una asesoría pendiente cuyo horario ya pasó no cuenta (no bloquea al alumno para siempre)', async () => {
  const eva = await estudiante('24100003'), uid = db.prepare("SELECT id FROM users WHERE matricula='24100003'").get().id;
  db.prepare("INSERT INTO horarios(docente_id,fecha,hora,libre) VALUES(1,'2020-01-01','09:00',0)").run();
  const hid = db.prepare("SELECT id FROM horarios WHERE fecha='2020-01-01' AND hora='09:00' AND docente_id=1").get().id;
  db.prepare("INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda,estado) VALUES(?,1,?,'Old','old','pendiente')").run(uid, hid);
  assert.equal((await eva.reservar(libres(1)[0])).status, 200);
  assert.equal((await eva.reservar(libres(1)[0])).status, 200, 'la vieja no ocupa un lugar: caben 2 nuevas');
  assert.equal((await eva.reservar(libres(1)[0])).status, 409);
});

test('solicitudes simultáneas no rebasan el tope', async () => {
  db.prepare("INSERT INTO padron(matricula,nombre) VALUES('24100099','Prueba Rápida')").run();
  const rapido = await estudiante('24100099'), ids = libres(2).slice(0, 6);
  assert.ok(ids.length >= 4);
  const r = await Promise.all(ids.map(id => rapido.reservar(id)));
  assert.equal(r.filter(x => x.status === 200).length, 2);
  assert.equal(r.filter(x => x.status === 409).length, ids.length - 2);
});

test('MAX_ASESORIAS_ACTIVAS ajusta el tope, y un valor inválido vuelve a 2', async t => {
  const prueba = async (valor, esperadas, matricula) => {
    if (valor === undefined) delete process.env.MAX_ASESORIAS_ACTIVAS; else process.env.MAX_ASESORIAS_ACTIVAS = valor;
    db.prepare('INSERT INTO padron(matricula,nombre) VALUES(?,?)').run(matricula, 'Alumno ' + matricula);
    const c = await estudiante(matricula), r = [];
    for (const id of libres(3).slice(0, 5)) r.push((await c.reservar(id)).status);
    assert.equal(r.filter(s => s === 200).length, esperadas, `MAX=${valor}: reservas logradas`);
    return r;
  };
  try {
    await prueba('3', 3, '24100101');
    process.env.MAX_ASESORIAS_ACTIVAS = '1'; db.prepare("INSERT INTO padron(matricula,nombre) VALUES('24100102','Uno')").run();
    const c = await estudiante('24100102'); assert.equal((await c.reservar(libres(3)[0])).status, 200);
    const x = await c.reservar(libres(3)[0]); assert.equal(x.status, 409); assert.match(x.json.error, /Ya tienes 1 asesoría activa\./, 'singular correcto');
    for (const [i, v] of ['abc', '0', '-4', ''].entries()) await prueba(v, 2, '2410020' + i);
  } finally { delete process.env.MAX_ASESORIAS_ACTIVAS; }
});
