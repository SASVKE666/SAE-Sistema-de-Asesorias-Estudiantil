// Matrículas y claves: una sola regla (matricula.js) y se comparan sin distinguir mayúsculas ("doc001" = "DOC001").
process.env.DB_FILE = ':memory:'; process.env.MAX_ASESORIAS_ACTIVAS = '50'; delete process.env.NODE_ENV; delete process.env.DOMINIOS_CORREO;
const test = require('node:test'), assert = require('node:assert');
const { spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const correo = require('../pruebas-ayuda/correo')();
const { MATRICULA_RE, esMatricula } = require('../matricula');
const app = require('../server'); require('../seed')(app.db);
const cargarPadron = require('../scripts/cargar-padron'), crearUsuario = require('../scripts/crear-usuario');
const db = app.db; let srv, base;
const cliente = () => { const c = { cookie: '' }; c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
  const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; }; return c; };
test.before(async () => { await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }); });
test.after(() => srv.close());
test.beforeEach(() => { correo.falla = false; correo.enviados.length = 0; });

test('la regla: 3 a 40 caracteres de letras, números, punto, guion o guion bajo; sin espacios ni otros símbolos', () => {
  for (const ok of ['abc', '24100001', 'DOC001', 'a.b-c_d', 'A'.repeat(40), 'ñ'.length ? 'x1y' : '']) assert.equal(esMatricula(ok), true, ok);
  for (const mal of ['ab', '', 'A'.repeat(41), 'con espacio', ' abc', 'abc ', 'ab\nc', 'año', 'ab@c', "a'b", 'a;b', 'ab/c', '٣٣٣', 'abc​', null, undefined, 123, ['abc']]) assert.equal(esMatricula(mal), false, JSON.stringify(mal));
  assert.equal(MATRICULA_RE.test('abc\n'), false, 'el salto de línea final no se cuela');
});

test('iniciar sesión con la clave en minúsculas o con espacios alrededor', async () => {
  for (const m of ['doc001', 'Doc001', ' DOC001 ', 'dOc001\t']) { const c = cliente(); const r = await c.call('/api/login', 'POST', { matricula: m, password: 'Docente2026' }); assert.equal(r.status, 200, JSON.stringify(m)); assert.equal((await c.call('/api/me')).json.user.matricula, 'DOC001', 'la sesión usa la forma guardada'); }
  assert.equal((await cliente().call('/api/login', 'POST', { matricula: 'DOC 001', password: 'Docente2026' })).status, 401);
  assert.equal((await cliente().call('/api/login', 'POST', { matricula: 'doc001', password: 'mala' })).status, 401);
  for (const m of [['DOC001'], { toString: 'DOC001' }, null, true]) assert.equal((await cliente().call('/api/login', 'POST', { matricula: m, password: 'Docente2026' })).status, 401, JSON.stringify(m) + ' no vale');
});

test('el registro y la confirmación funcionan escribiendo la matrícula en otra forma, y la cuenta queda con la forma del padrón', async () => {
  db.prepare("INSERT INTO padron(matricula,nombre,email) VALUES('Ab-2026.1','Luz Mena','luz@uan.edu.mx')").run();
  const c = cliente(); const r = await c.call('/api/registro', 'POST', { matricula: '  ab-2026.1 ', email: 'x@uan.edu.mx', password: 'segura1234' }); assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(correo.enviados.at(-1).to, 'luz@uan.edu.mx', 'el código va al correo del padrón');
  assert.equal((await c.call('/api/registro/confirmar', 'POST', { matricula: 'AB-2026.1', codigo: '000000' })).status, 400, 'código incorrecto');
  const ok = await c.call('/api/registro/confirmar', 'POST', { matricula: 'aB-2026.1', codigo: correo.codigo('luz@uan.edu.mx') }); assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(db.prepare('SELECT matricula FROM users WHERE nombre=?').get('Luz Mena').matricula, 'Ab-2026.1', 'forma del padrón');
  assert.equal((await cliente().call('/api/registro', 'POST', { matricula: 'AB-2026.1', email: 'z@uan.edu.mx', password: 'segura1234' })).status, 409, 'ya tiene cuenta, la escriban como la escriban');
  assert.equal((await cliente().call('/api/login', 'POST', { matricula: 'ab-2026.1', password: 'segura1234' })).status, 200);
  assert.equal((await cliente().call('/api/registro', 'POST', { matricula: 'noexiste', email: 'z@uan.edu.mx', password: 'segura1234' })).status, 403);
});

test('recuperar la contraseña también acepta cualquier forma de la clave', async () => {
  const c = cliente(); correo.enviados.length = 0; assert.equal((await c.call('/api/recuperar', 'POST', { matricula: ' doc002' })).status, 200);
  const to = db.prepare("SELECT email FROM users WHERE matricula='DOC002'").get().email; assert.equal(correo.enviados.at(-1).to, to, 'sí salió el código');
  const x = await c.call('/api/recuperar/confirmar', 'POST', { matricula: 'Doc002', codigo: correo.codigo(to), password: 'NuevaClave-2026' }); assert.equal(x.status, 200, JSON.stringify(x.json));
  assert.equal((await cliente().call('/api/login', 'POST', { matricula: 'DOC002', password: 'NuevaClave-2026' })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM codigos WHERE tipo='recuperar'").get().n, 0, 'el código se gastó');
});

test('no puede haber dos cuentas ni dos filas de padrón que solo difieran en mayúsculas (índices únicos)', () => {
  assert.throws(() => db.prepare("INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES('doc001','X','x@uan.edu.mx','docente','x')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO padron(matricula,nombre) VALUES('24100001'||'','X')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO padron(matricula,nombre) VALUES('ab-2026.1','X')").run(), /UNIQUE/);
});

test('panel de administración: alta de docente y de padrón rechazan variantes de mayúsculas y aplican la misma regla', async () => {
  const sec = cliente(); assert.equal((await sec.call('/api/login', 'POST', { matricula: 'sec001', password: 'Secretaria2026' })).status, 200, 'la secretaría entra con minúsculas');
  const doc = b => sec.call('/api/admin/docentes', 'POST', { clave: 'DOC050', nombre: 'Dr. X', email: 'x50@uan.edu.mx', materias: 'M', ...b });
  for (const [b, st, re] of [[{ clave: 'doc001' }, 409, /Ya existe/], [{ clave: '24100001' }, 409, /padrón/], [{ clave: 'ab-2026.1' }, 409, /Ya existe|padrón/], [{ clave: 'a b' }, 400, /espacios/], [{ clave: 'ab' }, 400, /3 a 40/]]) { const r = await doc(b); assert.equal(r.status, st, JSON.stringify(b)); assert.match(r.json.error, re); }
  const p = b => sec.call('/api/admin/padron', 'POST', { matricula: 'P-001', nombre: 'Pablo', ...b });
  assert.equal((await p({})).status, 200); for (const m of ['p-001', 'P-001']) assert.equal((await p({ matricula: m })).status, 409, m);
  assert.equal((await p({ matricula: 'doc001' })).status, 409, 'ni una clave de personal'); assert.equal((await p({ matricula: 'p 002' })).status, 400); assert.match((await p({ matricula: 'p 002' })).json.error, /sin espacios/);
  assert.equal((await sec.call('/api/admin/padron/p-001', 'PATCH', { nombre: 'Pablo Ruiz' })).json.fila.matricula, 'P-001', 'editar con otra forma encuentra la fila y conserva la forma guardada');
  assert.equal((await sec.call('/api/admin/padron/p-001', 'DELETE')).status, 200); assert.equal(db.prepare("SELECT COUNT(*) n FROM padron WHERE matricula='P-001'").get().n, 0);
  assert.equal((await sec.call('/api/admin/padron/ab-2026.1', 'PATCH', { nombre: 'X' })).status, 409, 'con cuenta (aunque la escriban distinto) no se edita');
  const reg = (await sec.call('/api/admin/padron?q=ab-2026')).json.filas[0]; assert.equal(reg.registrado, 1);
});

test('npm run cargar-padron: filas repetidas en otra capitalización, claves de personal y actualización conservando la forma guardada', () => {
  const csv = t => Buffer.from(t, 'utf8');
  let r = cargarPadron(db, csv('matricula,nombre,correo\nQ-1,Uno,\nq-1,Otra vez,\nDoc003,Chocan,\nsin espacio,X,\nQ 2,Y,\n'), { simular: true });
  assert.equal(r.errores.length, 4, JSON.stringify(r.errores)); assert.match(r.errores[0], /Línea 3.*línea 2.*mayúsculas/); assert.match(r.errores[1], /clave de una cuenta de docente/); assert.match(r.errores.join('|'), /matrícula no válida "sin espacio".*sin espacios/);
  crearUsuario(db, { rol: 'docente', matricula: 'prof.luis', nombre: 'Prof. Luis', email: 'pluis@uan.edu.mx', password: 'ClaveLarga-2026', materias: 'M' });
  r = cargarPadron(db, csv('matricula,nombre,correo\nPROF.LUIS,Alumno,\n'), { simular: true }); assert.match(r.errores[0], /clave de una cuenta de docente/, 'clave de personal en minúsculas vs mayúsculas en el archivo');
  assert.equal(cargarPadron(db, csv('matricula,nombre,correo\nZ-9,Zeta,\n'), {}).nuevas, 1);
  r = cargarPadron(db, csv('matricula,nombre,correo\nz-9,Zeta Nueva,\n'), {}); assert.deepEqual([r.nuevas, r.actualizadas], [0, 1], 'es la misma fila');
  assert.deepEqual({ ...db.prepare("SELECT matricula,nombre FROM padron WHERE matricula='Z-9' COLLATE NOCASE").get() }, { matricula: 'Z-9', nombre: 'Zeta Nueva' }); assert.equal(db.prepare("SELECT COUNT(*) n FROM padron WHERE matricula LIKE 'z-9'").get().n, 1);
  r = cargarPadron(db, csv('matricula,nombre,correo\nab-2026.1,Luz Mena,\n'), { simular: true }); assert.equal(r.conCuenta, 1, 'detecta la cuenta aunque cambie la capitalización');
});

test('npm run crear-usuario valida la clave y no duplica en otra capitalización', () => {
  const nuevo = (m) => crearUsuario(db, { rol: 'docente', matricula: m, nombre: 'Dr. C', email: m.replace(/\W/g, '') + '@uan.edu.mx', password: 'ClaveLarga-2026', materias: 'M' });
  assert.throws(() => nuevo('con espacio'), /sin espacios/); assert.throws(() => nuevo('ab'), /3 a 40/); assert.throws(() => nuevo('a;b'), /matrícula\/clave/);
  assert.throws(() => crearUsuario(db, { rol: 'secretaria', matricula: 'sec001', nombre: 'Otra', email: 'o@uan.edu.mx', password: 'ClaveLarga-2026' }), /Ya existe un usuario con la matrícula/);
  assert.equal(nuevo('DOC060').matricula, 'DOC060'); assert.throws(() => nuevo('doc060'), /Ya existe/);
});

test('una base antigua con dos matrículas que solo difieren en mayúsculas arranca y avisa en vez de fallar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-mat-')), bd = path.join(dir, 'vieja.db'), { DatabaseSync } = require('node:sqlite');
  try { const v = new DatabaseSync(bd);
    v.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, matricula TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL, email TEXT NOT NULL, rol TEXT NOT NULL CHECK(rol IN('estudiante','docente','secretaria')), pass_hash TEXT NOT NULL); INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES('ab1','A','a@uan.edu.mx','estudiante','x'),('AB1','B','b@uan.edu.mx','estudiante','x');"); v.close();
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', "const a=require('./server');console.log(a.db.prepare('SELECT COUNT(*) n FROM users').get().n)"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: bd }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stderr, /AVISO: la tabla users tiene matrículas que solo difieren/); assert.equal(r.stdout.trim().split('\n').pop(), '2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
