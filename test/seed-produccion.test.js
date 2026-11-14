// Los datos de demostración (usuarios con contraseñas conocidas) solo se cargan si se piden, y nunca en producción.
// Estas pruebas arrancan el servidor de verdad (proceso aparte) porque la lógica vive en el arranque.
const test = require('node:test'), assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const RAIZ = path.join(__dirname, '..'), NODE = ['--no-warnings'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-seed-')); let n = 0;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Arranca server.js con una base nueva; devuelve lo que imprimió, el código de salida (si terminó solo) y la base ya cerrada.
function arrancar(args = [], env = {}) {
  const DB_FILE = path.join(dir, `b${++n}.db`);
  const e = { ...process.env, DB_FILE, PORT: '0', ...env }; for (const k of ['SEED_DEMO', 'NODE_ENV']) if (!(k in env)) delete e[k];
  return new Promise(ok => {
    const p = spawn(process.execPath, [...NODE, 'server.js', ...args], { cwd: RAIZ, env: e });
    let out = '', err = '', listo = false;
    const fin = code => { clearTimeout(t); ok({ out, err, code, DB_FILE }); };
    p.stdout.on('data', d => { out += d; if (!listo && /SAE en/.test(out)) { listo = true; p.once('exit', () => fin(null)); p.kill(); } });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => { if (!listo) fin(code); });
    const t = setTimeout(() => { p.kill(); }, 20000);
  });
}
const usuarios = f => { const db = new DatabaseSync(f); try { return db.prepare('SELECT matricula, rol FROM users ORDER BY id').all(); } finally { db.close(); } };

test('arranque normal: la base queda SIN usuarios (nada de contraseñas conocidas) y avisa cómo seguir', async () => {
  const r = await arrancar();
  assert.deepEqual(usuarios(r.DB_FILE), []);
  assert.match(r.out, /la base no tiene usuarios/); assert.match(r.out, /npm run demo/); assert.match(r.out, /crear-usuario/);
});

test('--demo y SEED_DEMO=1 sí cargan los datos de demostración', async () => {
  for (const r of [await arrancar(['--demo']), await arrancar([], { SEED_DEMO: '1' }), await arrancar([], { SEED_DEMO: 'true' })]) {
    const u = usuarios(r.DB_FILE);
    assert.ok(u.some(x => x.matricula === 'SEC001' && x.rol === 'secretaria') && u.filter(x => x.rol === 'docente').length === 3, JSON.stringify(u));
    assert.ok(!/no tiene usuarios/.test(r.out));
  }
});

test('SEED_DEMO con otros valores (0, vacío, no) no carga nada', async () => {
  for (const v of ['0', '', 'no', 'false']) assert.deepEqual(usuarios((await arrancar([], { SEED_DEMO: v })).DB_FILE), [], `SEED_DEMO=${JSON.stringify(v)}`);
});

test('en producción los datos de demostración se rechazan y el servidor no arranca', async () => {
  for (const r of [await arrancar(['--demo'], { NODE_ENV: 'production' }), await arrancar([], { NODE_ENV: 'production', SEED_DEMO: '1' })]) {
    assert.equal(r.code, 1, 'termina con error'); assert.match(r.err, /NODE_ENV=production/);
    assert.deepEqual(usuarios(r.DB_FILE), [], 'no se creó ningún usuario');
    assert.ok(!/SAE en/.test(r.out), 'no llegó a escuchar');
  }
});

test('producción normal (sin demo) arranca y no crea usuarios', async () => {
  const r = await arrancar([], { NODE_ENV: 'production' });
  assert.match(r.out, /SAE en/); assert.deepEqual(usuarios(r.DB_FILE), []);
});

// ---- scripts/crear-usuario.js ----
const crearUsuario = require('../scripts/crear-usuario');
const baseNueva = () => { process.env.DB_FILE = ':memory:'; return require('../server').db; };

test('crear-usuario: crea la secretaría y puede iniciar sesión con la contraseña elegida', async () => {
  process.env.DB_FILE = ':memory:'; const app = require('../server'), db = app.db;
  const u = crearUsuario(db, { rol: 'secretaria', matricula: 'SEC777', nombre: 'Secretaría', email: 'Sec@UAN.edu.mx', password: 'una-clave-larga-y-propia' });
  assert.equal(u.rol, 'secretaria');
  const fila = db.prepare('SELECT * FROM users WHERE matricula=?').get('SEC777');
  assert.equal(fila.email, 'sec@uan.edu.mx', 'el correo se guarda en minúsculas'); assert.ok(bcrypt.compareSync('una-clave-larga-y-propia', fila.pass_hash)); assert.notEqual(fila.pass_hash, 'una-clave-larga-y-propia');
  const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
  try {
    const r = await fetch(`http://localhost:${srv.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matricula: 'SEC777', password: 'una-clave-larga-y-propia' }) });
    assert.equal(r.status, 200);
    const yo = await fetch(`http://localhost:${srv.address().port}/api/me`, { headers: { cookie: r.headers.get('set-cookie').split(';')[0] } });
    assert.equal((await yo.json()).user.rol, 'secretaria');
  } finally { srv.close(); }
});

test('crear-usuario: docente con su fila de docentes; sin materias, no', () => {
  const db = baseNueva();
  crearUsuario(db, { rol: 'docente', matricula: 'DOC900', nombre: 'Dra. Prueba', email: 'prueba@uan.edu.mx', password: 'clave-docente-larga', materias: ' Estadística ', cubiculo: ' Cubículo 9 ' });
  const d = db.prepare('SELECT d.materias, d.cubiculo FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula=?').get('DOC900');
  assert.deepEqual({ ...d }, { materias: 'Estadística', cubiculo: 'Cubículo 9' });
  assert.throws(() => crearUsuario(db, { rol: 'docente', matricula: 'DOC901', nombre: 'X', email: 'x@uan.edu.mx', password: 'clave-docente-larga' }), /materias/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE matricula='DOC901'").get().n, 0, 'no queda un usuario a medias');
});

test('crear-usuario: rechaza contraseñas cortas o de demostración, roles/correos inválidos y duplicados', () => {
  const db = baseNueva(), ok = { rol: 'secretaria', matricula: 'SEC800', nombre: 'S', email: 's800@uan.edu.mx', password: 'clave-larga-correcta' };
  assert.throws(() => crearUsuario(db, { ...ok, password: '123456789' }), /al menos 10/, '9 caracteres no alcanzan');
  crearUsuario(db, { ...ok, matricula: 'SEC899', email: 'l899@uan.edu.mx', password: '1234567890' });                  // exactamente 10 sí
  for (const p of ['Secretaria2026', 'Docente2026']) assert.throws(() => crearUsuario(db, { ...ok, password: p }), /demostración/);
  assert.throws(() => crearUsuario(db, { ...ok, rol: 'estudiante' }), /rol/); assert.throws(() => crearUsuario(db, { ...ok, rol: 'admin' }), /rol/);
  assert.throws(() => crearUsuario(db, { ...ok, email: 'no-es-correo' }), /correo/);
  assert.throws(() => crearUsuario(db, { ...ok, matricula: '  ' }), /matrícula/); assert.throws(() => crearUsuario(db, { ...ok, nombre: '' }), /nombre/);
  crearUsuario(db, ok);
  assert.throws(() => crearUsuario(db, { ...ok, email: 'otro@uan.edu.mx' }), /Ya existe.*SEC800/, 'matrícula repetida');
  assert.throws(() => crearUsuario(db, { ...ok, matricula: 'SEC801', email: 'S800@UAN.edu.mx' }), /ese correo/, 'correo repetido (sin importar mayúsculas)');
});

test('crear-usuario (línea de comandos): usa SAE_PASSWORD, y sin ella ni terminal falla sin crear nada', () => {
  const DB_FILE = path.join(dir, 'cli.db'), cli = env => spawnSync(process.execPath, [...NODE, 'scripts/crear-usuario.js', 'secretaria', 'SEC123', 'Secretaría', 'sec123@uan.edu.mx'], { cwd: RAIZ, env: { ...process.env, DB_FILE, ...env }, encoding: 'utf8', input: '' });
  const sinClave = cli({ SAE_PASSWORD: '' }); assert.equal(sinClave.status, 1); assert.match(sinClave.stderr, /SAE_PASSWORD/); assert.ok(!fs.existsSync(DB_FILE), 'ni siquiera abre la base');
  const corta = cli({ SAE_PASSWORD: 'corta' }); assert.equal(corta.status, 1); assert.match(corta.stderr, /al menos 10/); assert.deepEqual(usuarios(DB_FILE), []);
  const bien = cli({ SAE_PASSWORD: 'clave-desde-entorno-1' }); assert.equal(bien.status, 0, bien.stderr); assert.match(bien.stdout, /SEC123 creada/);
  assert.deepEqual(usuarios(DB_FILE), [{ matricula: 'SEC123', rol: 'secretaria' }]);
  const dup = cli({ SAE_PASSWORD: 'clave-desde-entorno-1' }); assert.equal(dup.status, 1); assert.match(dup.stderr, /Ya existe/);
  const sinArgs = spawnSync(process.execPath, [...NODE, 'scripts/crear-usuario.js'], { cwd: RAIZ, env: { ...process.env, DB_FILE }, encoding: 'utf8' }); assert.equal(sinArgs.status, 2); assert.match(sinArgs.stderr, /Uso:/);
});
