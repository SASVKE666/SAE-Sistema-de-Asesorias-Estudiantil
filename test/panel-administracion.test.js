// Panel de administración (solo secretaría): docentes, estudiantes, padrón y bitácora; cuentas desactivables.
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV; delete process.env.DOMINIOS_CORREO;
const test = require('node:test'), assert = require('node:assert');
const { spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db;
let srv, base, sec, ana, doc;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; };
  c.entrar = async (m, p) => c.call('/api/login', 'POST', { matricula: m, password: p }); return c; };
const acceso = async (m, p) => { const c = cliente(); assert.equal((await c.entrar(m, p)).status, 200); return c; };
const docNuevo = (o = {}) => ({ clave: 'DOC010', nombre: 'Dra. Ana Pérez', email: 'ana.perez@uan.edu.mx', materias: 'Estadística, Econometría', cubiculo: 'Cubículo 3', ...o });
const actividad = () => db.prepare('SELECT * FROM auditoria ORDER BY id').all();
const idDoc = m => db.prepare('SELECT d.id FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula=?').get(m).id;
test.before(async () => { await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); });
  sec = await acceso('SEC001', 'Secretaria2026'); doc = await acceso('DOC001', 'Docente2026');
  ana = cliente(); await correo.registrar((u, b) => ana.call(u, 'POST', b), { matricula: '24100001', email: 'ana@uan.edu.mx', password: 'segura1234' }); });
test.after(() => srv.close());
test.beforeEach(() => { correo.falla = false; correo.enviados.length = 0; });

test('todo el panel exige secretaría: sin sesión 401, estudiante y docente 403', async () => {
  const rutas = [['GET', '/api/admin/docentes'], ['POST', '/api/admin/docentes', docNuevo()], ['PATCH', '/api/admin/docentes/1', { activo: false }], ['GET', '/api/admin/estudiantes'], ['PATCH', '/api/admin/estudiantes/1', { activo: false }],
    ['GET', '/api/admin/padron'], ['POST', '/api/admin/padron', { matricula: 'X123', nombre: 'X' }], ['PATCH', '/api/admin/padron/24100002', { nombre: 'X' }], ['DELETE', '/api/admin/padron/24100002'], ['GET', '/api/admin/actividad']];
  for (const [m, u, b] of rutas) { assert.equal((await cliente().call(u, m, b)).status, 401, 'sin sesión ' + m + u); assert.equal((await ana.call(u, m, b)).status, 403, 'estudiante ' + m + u); assert.equal((await doc.call(u, m, b)).status, 403, 'docente ' + m + u); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM auditoria').get().n, 0, 'ningún intento dejó rastro');
});

test('alta de docente: sin contraseña conocida, avisa por correo y el docente elige la suya con «Olvidé mi contraseña»', async () => {
  const r = await sec.call('/api/admin/docentes', 'POST', docNuevo()); assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.avisado, true);
  const m = correo.enviados.find(x => x.to === 'ana.perez@uan.edu.mx'); assert.ok(m); assert.match(m.text, /Tu clave: DOC010/); assert.match(m.text, /Olvidé mi contraseña/); assert.ok(!/contraseña:/i.test(m.text), 'no manda contraseñas');
  const fila = (await sec.call('/api/admin/docentes')).json.find(d => d.id === r.json.id); assert.deepEqual({ ...fila, libres: undefined }, { id: r.json.id, clave: 'DOC010', nombre: 'Dra. Ana Pérez', email: 'ana.perez@uan.edu.mx', materias: 'Estadística, Econometría', cubiculo: 'Cubículo 3', activo: 1, libres: undefined, abiertas: 0 });
  for (const p of ['Docente2026', 'DOC010', '', 'password123']) assert.equal((await cliente().entrar('DOC010', p)).status, 401, 'nadie entra sin elegir contraseña: ' + p);
  const d = cliente(); assert.equal((await d.call('/api/recuperar', 'POST', { matricula: 'DOC010' })).status, 200);
  assert.equal((await d.call('/api/recuperar/confirmar', 'POST', { matricula: 'DOC010', codigo: correo.codigo('ana.perez@uan.edu.mx'), password: 'MiClaveNueva2026' })).status, 200);
  assert.equal((await d.entrar('DOC010', 'MiClaveNueva2026')).status, 200); assert.equal((await d.call('/api/me')).json.user.rol, 'docente');
  assert.deepEqual(actividad().map(a => a.accion), ['docente creado']); assert.equal(actividad()[0].usuario, 'Secretaría de Economía (SEC001)'); assert.match(actividad()[0].detalle, /DOC010/);
});

test('alta de docente: si el correo falla igual se crea y se avisa a la secretaría (avisado:false)', async () => {
  correo.falla = true; const r = await sec.call('/api/admin/docentes', 'POST', docNuevo({ clave: 'DOC011', email: 'otro@uan.edu.mx' })); assert.equal(r.status, 200); assert.equal(r.json.avisado, false);
  assert.ok(db.prepare("SELECT 1 FROM users WHERE matricula='DOC011'").get());
});

test('alta de docente: valida clave, nombre, materias, cubículo, correo y duplicados', async () => {
  const malo = async (o, st, re) => { const r = await sec.call('/api/admin/docentes', 'POST', docNuevo({ clave: 'DOC020', email: 'x20@uan.edu.mx', ...o })); assert.equal(r.status, st, JSON.stringify(o)); assert.match(r.json.error, re); };
  const antes = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  await malo({ clave: 'ab' }, 400, /clave/); await malo({ clave: 'con espacio' }, 400, /clave/); await malo({ clave: "x'; DROP" }, 400, /clave/); await malo({ clave: 'A'.repeat(41) }, 400, /clave/); await malo({ clave: 7 }, 400, /clave/);
  await malo({ nombre: '' }, 400, /nombre/); await malo({ nombre: '   ' }, 400, /nombre/); await malo({ nombre: 'N'.repeat(121) }, 400, /nombre/); await malo({ nombre: 5 }, 400, /nombre/);
  await malo({ materias: '' }, 400, /materias/); await malo({ materias: 'M'.repeat(201) }, 400, /materias/); await malo({ cubiculo: 'C'.repeat(61) }, 400, /cubículo/);
  await malo({ email: 'sin-arroba' }, 400, /correo/); await malo({ email: 'alguien@gmail.com' }, 400, /institucional/); await malo({ email: '' }, 400, /correo/);
  await malo({ email: 'hsalazar@uan.edu.mx'.replace('hsalazar', db.prepare("SELECT email FROM users WHERE matricula='DOC001'").get().email.split('@')[0]) }, 400, /ya es de la cuenta DOC001/);
  await malo({ clave: 'DOC001' }, 409, /Ya existe/); await malo({ clave: '24100002' }, 409, /padrón/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, antes, 'ninguna petición inválida creó cuentas'); assert.equal(correo.enviados.length, 0);
  assert.equal((await sec.call('/api/admin/docentes', 'POST', docNuevo({ clave: 'DOC021', email: 'MAYUS@UAN.EDU.MX', nombre: '  Dr.   Espacios   Raros ', cubiculo: '' }))).status, 200);
  const u = db.prepare("SELECT nombre,email FROM users WHERE matricula='DOC021'").get(); assert.deepEqual({ ...u }, { nombre: 'Dr. Espacios Raros', email: 'mayus@uan.edu.mx' }, 'normaliza espacios y minúsculas');
});

test('DOMINIOS_CORREO se respeta en el alta de docentes', async () => {
  process.env.DOMINIOS_CORREO = 'facultad.mx,*.otra.mx'; try {
    assert.equal((await sec.call('/api/admin/docentes', 'POST', docNuevo({ clave: 'DOC030', email: 'a@uan.edu.mx' }))).status, 400);
    assert.equal((await sec.call('/api/admin/docentes', 'POST', docNuevo({ clave: 'DOC030', email: 'a@facultad.mx' }))).status, 200);
  } finally { delete process.env.DOMINIOS_CORREO; }
});

test('editar docente: cambia solo lo enviado, valida y deja bitácora únicamente si algo cambió', async () => {
  const id = idDoc('DOC002'), url = '/api/admin/docentes/' + id; const antes = actividad().length;
  const r = await sec.call(url, 'PATCH', { materias: 'Contabilidad, Auditoría', cubiculo: '' }); assert.equal(r.status, 200); assert.equal(r.json.docente.materias, 'Contabilidad, Auditoría'); assert.equal(r.json.docente.cubiculo, ''); assert.equal(r.json.docente.nombre, 'Mtra. Patricia Lugo');
  assert.equal(actividad().length, antes + 1); assert.match(actividad().at(-1).detalle, /materias, cubiculo/);
  assert.equal((await sec.call(url, 'PATCH', { materias: 'Contabilidad, Auditoría' })).status, 200); assert.equal(actividad().length, antes + 1, 'sin cambios reales no hay registro');
  assert.equal((await sec.call(url, 'PATCH', { nombre: 'Mtra. Patricia Lugo Ríos', email: 'PLUGO@uan.edu.mx' })).status, 200); const u = db.prepare("SELECT nombre,email FROM users WHERE matricula='DOC002'").get(); assert.deepEqual({ ...u }, { nombre: 'Mtra. Patricia Lugo Ríos', email: 'plugo@uan.edu.mx' });
  for (const [b, re] of [[{}, /nada que cambiar/], [{ nombre: '' }, /nombre/], [{ materias: ' ' }, /materias/], [{ cubiculo: 'C'.repeat(61) }, /cubículo/], [{ email: 'mal' }, /correo/], [{ email: 'x@gmail.com' }, /institucional/], [{ activo: 'false' }, /verdadero o falso/], [{ activo: 0 }, /verdadero o falso/]])
    { const x = await sec.call(url, 'PATCH', b); assert.equal(x.status, 400, JSON.stringify(b)); assert.match(x.json.error, re); }
  const otro = db.prepare("SELECT email FROM users WHERE matricula='DOC001'").get().email; const x = await sec.call(url, 'PATCH', { email: otro }); assert.equal(x.status, 400); assert.match(x.json.error, /DOC001/);
  assert.equal((await sec.call(url, 'PATCH', { email: 'plugo@uan.edu.mx' })).status, 200, 'conservar su propio correo no es conflicto');
  for (const id2 of ['99999', 'abc', '1e0', '-1', '1.0', '0x1']) assert.equal((await sec.call('/api/admin/docentes/' + id2, 'PATCH', { activo: true })).status, 404, id2);
});

test('desactivar docente: no entra, su sesión muere, sale del catálogo, nadie le agenda y reactivarlo lo restaura todo', async () => {
  const id = idDoc('DOC003'), url = '/api/admin/docentes/' + id; db.prepare('DELETE FROM horarios WHERE docente_id=?').run(id);
  const hid = Number(db.prepare("INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,'2099-01-05','10:00')").run(id).lastInsertRowid), hid2 = Number(db.prepare("INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,'2099-01-05','11:00')").run(id).lastInsertRowid);
  const d3 = await acceso('DOC003', 'Docente2026'); const res = await ana.call('/api/asesorias', 'POST', { horario_id: hid, materia: 'Estadística', duda: 'D' }); assert.equal(res.status, 200);
  assert.equal((await d3.call('/api/asesorias/' + res.json.id, 'PATCH', { estado: 'confirmada' })).status, 200);
  const lista = async () => (await sec.call('/api/admin/docentes')).json.find(d => d.id === id); assert.equal((await lista()).abiertas, 1); assert.equal((await lista()).libres, 1);
  assert.equal((await sec.call(url, 'PATCH', { activo: false })).status, 200); assert.equal((await lista()).activo, 0);
  assert.equal((await d3.call('/api/me')).json.user, null, 'su sesión abierta dejó de valer'); assert.equal((await d3.call('/api/asesorias')).status, 401);
  const intento = await cliente().entrar('DOC003', 'Docente2026'); assert.equal(intento.status, 403); assert.match(intento.json.error, /desactivada/);
  assert.equal((await cliente().entrar('DOC003', 'mala-contraseña')).status, 401, 'con contraseña incorrecta no se revela que existe');
  assert.ok(!(await ana.call('/api/docentes')).json.some(d => d.id === id), 'fuera del catálogo'); assert.ok(!(await ana.call('/api/docentes?q=Estad')).json.some(d => d.id === id));
  assert.equal((await ana.call('/api/docentes/' + id)).status, 404); assert.deepEqual((await ana.call(`/api/docentes/${id}/horarios`)).json, []);
  const b = await ana.call('/api/asesorias', 'POST', { horario_id: hid2, materia: 'Estadística', duda: 'D' }); assert.equal(b.status, 409); assert.match(b.json.error, /no está disponible/); assert.equal(db.prepare('SELECT libre FROM horarios WHERE id=?').get(hid2).libre, 1, 'el horario no se gasta');
  assert.ok(!(await sec.call('/api/qr/docentes')).json.some(d => d.id === id), 'ni en los QR');
  assert.equal(db.prepare('SELECT estado FROM asesorias WHERE id=?').get(res.json.id).estado, 'confirmada', 'sus asesorías abiertas se conservan');
  assert.equal((await sec.call(url, 'PATCH', { activo: true })).status, 200);
  assert.equal((await cliente().entrar('DOC003', 'Docente2026')).status, 200); assert.ok((await ana.call('/api/docentes')).json.some(d => d.id === id)); assert.equal((await ana.call('/api/docentes/' + id)).status, 200);
  assert.equal((await ana.call('/api/asesorias', 'POST', { horario_id: hid2, materia: 'Estadística', duda: 'D' })).status, 200);
  assert.deepEqual(actividad().filter(a => /DOC003/.test(a.detalle)).map(a => a.detalle.split(': ')[1]), ['desactivado', 'reactivado']);
  assert.equal(actividad().length > 0 && (await sec.call(url, 'PATCH', { activo: true })).status, 200); assert.equal(actividad().filter(a => /DOC003/.test(a.detalle)).length, 2, 'reactivar a quien ya está activo no deja registro');
});

test('estudiantes: lista y busca (sin comodines del usuario), bloquea y desbloquea', async () => {
  correo.enviados.length = 0; const beto = cliente(); db.prepare("INSERT OR IGNORE INTO padron(matricula,nombre) VALUES('24100002','Diego Ramos Ortiz')").run(); await correo.registrar((u, b) => beto.call(u, 'POST', b), { matricula: '24100002', email: 'diego@uan.edu.mx', password: 'segura1234' });
  const todos = (await sec.call('/api/admin/estudiantes')).json; assert.equal(todos.total, 2); assert.deepEqual(todos.filas.map(e => e.matricula).sort(), ['24100001', '24100002']); assert.ok(todos.filas.every(e => e.activo === 1 && 'abiertas' in e) && !JSON.stringify(todos).includes('pass'));
  for (const [qq, n] of [['diego', 1], ['24100001', 1], ['@UAN.edu', 2], ['zzz', 0], ['%', 0], ['_', 0], ['24100_01', 0], ['', 2]]) assert.equal((await sec.call('/api/admin/estudiantes?q=' + encodeURIComponent(qq))).json.total, n, 'q=' + qq);
  const id = todos.filas.find(e => e.matricula === '24100002').id;
  assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', { activo: false })).status, 200);
  assert.equal((await beto.call('/api/me')).json.user, null, 'sesión cerrada'); const i = await cliente().entrar('24100002', 'segura1234'); assert.equal(i.status, 403); assert.match(i.json.error, /desactivada/);
  assert.equal((await sec.call('/api/admin/estudiantes?q=diego')).json.filas[0].activo, 0);
  assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', { activo: false })).status, 200); assert.equal(actividad().filter(a => a.accion === 'estudiante bloqueado').length, 1, 'repetir no duplica la bitácora');
  assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', { activo: true })).status, 200); assert.equal((await cliente().entrar('24100002', 'segura1234')).status, 200);
  assert.deepEqual(actividad().filter(a => /24100002/.test(a.detalle)).map(a => a.accion), ['estudiante bloqueado', 'estudiante desbloqueado']);
  const idDocente = db.prepare("SELECT id FROM users WHERE matricula='DOC001'").get().id;
  assert.equal((await sec.call('/api/admin/estudiantes/' + idDocente, 'PATCH', { activo: false })).status, 404, 'no sirve para bloquear docentes ni a la secretaría');
  assert.equal((await sec.call('/api/admin/estudiantes/' + db.prepare("SELECT id FROM users WHERE matricula='SEC001'").get().id, 'PATCH', { activo: false })).status, 404);
  for (const b of [{}, { activo: 'no' }, { activo: 1 }]) assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', b)).status, 400);
  assert.equal((await sec.call('/api/admin/estudiantes/abc', 'PATCH', { activo: true })).status, 404);
});

test('estudiante bloqueado no puede agendar con una sesión anterior', async () => {
  const hid = Number(db.prepare("INSERT INTO horarios(docente_id,fecha,hora) VALUES(?,'2099-02-02','09:00')").run(idDoc('DOC001')).lastInsertRowid);
  const id = db.prepare("SELECT id FROM users WHERE matricula='24100001'").get().id; assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', { activo: false })).status, 200);
  assert.equal((await ana.call('/api/asesorias', 'POST', { horario_id: hid, materia: 'M', duda: 'D' })).status, 401); assert.equal(db.prepare('SELECT libre FROM horarios WHERE id=?').get(hid).libre, 1);
  assert.equal((await sec.call('/api/admin/estudiantes/' + id, 'PATCH', { activo: true })).status, 200); assert.equal((await ana.entrar('24100001', 'segura1234')).status, 200);
});

test('padrón: alta, duplicados, validaciones y el alumno nuevo ya puede registrarse', async () => {
  const r = await sec.call('/api/admin/padron', 'POST', { matricula: '25200001', nombre: '  Luis   Mora ', email: 'LMORA@uan.edu.mx' }); assert.equal(r.status, 200); assert.deepEqual(r.json.fila, { matricula: '25200001', nombre: 'Luis Mora', email: 'lmora@uan.edu.mx', registrado: 0 });
  const malo = async (b, st, re) => { const x = await sec.call('/api/admin/padron', 'POST', b); assert.equal(x.status, st, JSON.stringify(b)); assert.match(x.json.error, re); };
  await malo({ matricula: '25200001', nombre: 'Otro' }, 409, /ya está en el padrón/); await malo({ matricula: 'DOC001', nombre: 'Otro' }, 409, /cuenta existente/); await malo({ matricula: '24100001', nombre: 'Otro' }, 409, /ya está en el padrón/);
  await malo({ matricula: 'a b', nombre: 'X' }, 400, /matrícula/); await malo({ matricula: 'ab', nombre: 'X' }, 400, /matrícula/); await malo({ matricula: '25200002', nombre: '' }, 400, /nombre/); await malo({ matricula: '25200002', nombre: 'N'.repeat(121) }, 400, /nombre/);
  await malo({ matricula: '25200002', nombre: 'X', email: 'mal' }, 400, /correo/); await malo({ matricula: '25200002', nombre: 'X', email: 'lmora@uan.edu.mx' }, 400, /ya está en el padrón con la matrícula 25200001/);
  await malo({ matricula: '25200002', nombre: 'X', email: 'ana@uan.edu.mx' }, 400, /ya es de la cuenta 24100001/);
  const sinCorreo = await sec.call('/api/admin/padron', 'POST', { matricula: '25200003', nombre: 'Sin Correo' }); assert.equal(sinCorreo.status, 200); assert.equal(sinCorreo.json.fila.email, '');
  const luis = cliente(); correo.enviados.length = 0; await correo.registrar((u, b) => luis.call(u, 'POST', b), { matricula: '25200001', email: 'otro@uan.edu.mx', password: 'segura1234' }, 'lmora@uan.edu.mx');
  assert.equal(correo.enviados.at(-1).to, 'lmora@uan.edu.mx', 'el código va al correo del padrón'); assert.deepEqual(actividad().filter(a => a.accion === 'padrón: alta').map(a => a.detalle.split(' · ')[0]), ['25200001', '25200003']);
});

test('padrón: editar y quitar solo si no tiene cuenta; el padrón se busca y se limita a 50 filas', async () => {
  const url = '/api/admin/padron/25200003';
  let r = await sec.call(url, 'PATCH', { nombre: 'Sin Correo Editado', email: 'sc@uan.edu.mx' }); assert.equal(r.status, 200); assert.deepEqual(r.json.fila, { matricula: '25200003', nombre: 'Sin Correo Editado', email: 'sc@uan.edu.mx', registrado: 0 });
  r = await sec.call(url, 'PATCH', { email: '' }); assert.equal(r.status, 200); assert.equal(r.json.fila.email, ''); assert.equal(r.json.fila.nombre, 'Sin Correo Editado', 'solo cambia lo enviado');
  for (const [b, st] of [[{}, 400], [{ nombre: '' }, 400], [{ email: 'mal' }, 400], [{ email: 'lmora@uan.edu.mx' }, 400]]) assert.equal((await sec.call(url, 'PATCH', b)).status, st, JSON.stringify(b));
  assert.equal((await sec.call('/api/admin/padron/24100001', 'PATCH', { nombre: 'X' })).status, 409, 'con cuenta no se edita'); assert.equal((await sec.call('/api/admin/padron/24100001', 'DELETE')).status, 409); assert.ok(db.prepare("SELECT 1 FROM padron WHERE matricula='24100001'").get());
  assert.equal((await sec.call('/api/admin/padron/NOEXISTE', 'PATCH', { nombre: 'X' })).status, 404); assert.equal((await sec.call('/api/admin/padron/NOEXISTE', 'DELETE')).status, 404);
  assert.equal((await sec.call(url, 'DELETE')).status, 200); assert.ok(!db.prepare("SELECT 1 FROM padron WHERE matricula='25200003'").get());
  assert.equal((await cliente().call('/api/registro', 'POST', { matricula: '25200003', email: 'x@uan.edu.mx', password: 'segura1234' })).status, 403, 'quitada: ya no puede registrarse');
  db.exec('BEGIN'); const ins = db.prepare('INSERT INTO padron(matricula,nombre) VALUES(?,?)'); for (let i = 0; i < 120; i++) ins.run('M' + String(i).padStart(4, '0'), 'Alumno Número ' + i); db.exec('COMMIT');
  const todo = (await sec.call('/api/admin/padron')).json; assert.equal(todo.filas.length, 50); assert.equal(todo.total, 124);
  assert.deepEqual((await sec.call('/api/admin/padron?q=M0007')).json.filas.map(f => f.matricula), ['M0007']); assert.equal((await sec.call('/api/admin/padron?q=' + encodeURIComponent('%'))).json.total, 0); assert.equal((await sec.call('/api/admin/padron?q=' + 'x'.repeat(500))).json.total, 0);
  assert.deepEqual((await sec.call('/api/admin/padron?q=24100001')).json.filas, [{ matricula: '24100001', nombre: 'Ana Lucía Torres', email: '', registrado: 1 }]);
});

test('actividad: lo más reciente primero, con quién lo hizo, y máximo 50 movimientos', async () => {
  const a = (await sec.call('/api/admin/actividad')).json; assert.ok(a.length > 5); assert.ok(a.every((x, i) => i === 0 || x.id < a[i - 1].id)); assert.deepEqual(Object.keys(a[0]).sort(), ['accion', 'detalle', 'fecha', 'id', 'usuario']);
  assert.ok(a.every(x => x.usuario === 'Secretaría de Economía (SEC001)'));
  for (let i = 0; i < 60; i++) db.prepare("INSERT INTO auditoria(usuario,accion,detalle) VALUES('x','y','z')").run(); assert.equal((await sec.call('/api/admin/actividad')).json.length, 50);
});

test('una base anterior recibe la columna activo (todas las cuentas siguen activas) y la bitácora', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-adm-')), bd = path.join(dir, 'vieja.db');
  try { const { DatabaseSync } = require('node:sqlite'), v = new DatabaseSync(bd);
    v.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, matricula TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, email TEXT NOT NULL, rol TEXT NOT NULL CHECK(rol IN('estudiante','docente','secretaria')), pass_hash TEXT NOT NULL); INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES('SEC9','S','s@uan.edu.mx','secretaria','x');"); v.close();
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', "const a=require('./server');console.log(JSON.stringify([a.db.prepare('SELECT activo FROM users').all(), a.db.prepare('SELECT COUNT(*) n FROM auditoria').get()]))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), [[{ activo: 1 }], { n: 0 }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('en producción sin correo configurado no se dan de alta docentes (no podrían elegir su contraseña)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-adm-')), bd = path.join(dir, 'prod.db'), { DatabaseSync } = require('node:sqlite');
  const libre = await new Promise(ok => { const s = require('node:net').createServer().listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const v = new DatabaseSync(bd), setup = spawnSync(process.execPath, ['--no-warnings', '-e', "const a=require('./server');require('./scripts/crear-usuario')(a.db,{rol:'secretaria',matricula:'SECP',nombre:'Secretaría',email:'s@uan.edu.mx',password:'ClaveSegura2026!'})"],
    { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' }); v.close(); assert.equal(setup.status, 0, setup.stderr);
  const env = { ...process.env, DB_FILE: bd, NODE_ENV: 'production', PORT: String(libre), SESSION_SECRET: 'x'.repeat(40) }; delete env.SMTP_HOST;
  const { spawn } = require('node:child_process'), p = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: path.join(__dirname, '..'), env }); let out = '';
  try { await new Promise((ok, no) => { p.stdout.on('data', d => { out += d; if (/SAE en/.test(out)) ok(); }); p.on('exit', () => no(new Error('el servidor se cerró: ' + out))); setTimeout(() => no(new Error('no arrancó')), 15000); });
    const c = { cookie: '' }, llamar = async (u, m, b) => { const r = await fetch(`http://localhost:${libre}${u}`, { method: m, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: b && JSON.stringify(b) }); const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; };
    assert.equal((await llamar('/api/login', 'POST', { matricula: 'SECP', password: 'ClaveSegura2026!' })).status, 200);
    const r = await llamar('/api/admin/docentes', 'POST', docNuevo()); assert.equal(r.status, 503); assert.match(r.json.error, /correo/);
    assert.equal((await llamar('/api/admin/docentes')).json.length, 0, 'no se creó nada');
  } finally { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
