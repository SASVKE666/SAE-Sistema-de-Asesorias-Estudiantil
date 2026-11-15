// QR por docente: cada docente obtiene el suyo (la secretaría, el de todos) y apunta a #docente/<id> de la dirección pública.
process.env.DB_FILE = ':memory:'; process.env.BASE_URL = 'https://sae.uan.edu.mx/'; delete process.env.NODE_ENV;   // con diagonal final a propósito
const test = require('node:test'), assert = require('node:assert');
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const QRCode = require('qrcode'), correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db; let srv, base;
const cliente = () => { const c = { cookie: '' };
  c.call = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: c.cookie }, body: body && JSON.stringify(body) });
    const k = r.headers.get('set-cookie'); if (k) c.cookie = k.split(';')[0]; return { status: r.status, json: await r.json() }; }; return c; };
const entrar = async (m, pass) => { const c = cliente(); assert.equal((await c.call('/api/login', 'POST', { matricula: m, password: pass })).status, 200); return c; };
const idDe = m => db.prepare('SELECT d.id FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.matricula=?').get(m).id;
const esperado = id => QRCode.toDataURL(`https://sae.uan.edu.mx/#docente/${id}`, { margin: 2, width: 600 });   // el QR que debe salir, generado aparte
test.before(() => new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }));
test.after(() => srv.close());

test('cada docente recibe SOLO su QR, que codifica su enlace directo (sin diagonal doble)', async () => {
  for (const m of ['DOC001', 'DOC002', 'DOC003']) {
    const c = await entrar(m, 'Docente2026'), r = await c.call('/api/qr/docentes'), id = idDe(m); assert.equal(r.status, 200); assert.equal(r.json.length, 1, m + ' solo ve el suyo');
    const q = r.json[0]; assert.equal(q.id, id); assert.equal(q.url, `https://sae.uan.edu.mx/#docente/${id}`); assert.match(q.png, /^data:image\/png;base64,/);
    assert.equal(q.png, await esperado(id), 'la imagen es exactamente el QR de ese enlace'); assert.ok(Buffer.from(q.png.split(',')[1], 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG válido');
  }
  const a = (await (await entrar('DOC001', 'Docente2026')).call('/api/qr/docentes')).json[0].png, b = (await (await entrar('DOC002', 'Docente2026')).call('/api/qr/docentes')).json[0].png; assert.notEqual(a, b);
});

test('la secretaría recibe el de todos los docentes, ordenados por nombre', async () => {
  const sec = await entrar('SEC001', 'Secretaria2026'), r = await sec.call('/api/qr/docentes'), todos = db.prepare('SELECT d.id,u.nombre FROM docentes d JOIN users u ON u.id=d.user_id ORDER BY u.nombre').all();
  assert.equal(r.status, 200); assert.deepEqual(r.json.map(x => [x.id, x.nombre]), todos.map(x => [x.id, x.nombre])); assert.ok(r.json.length >= 3);
  for (const x of r.json) { assert.equal(x.url, `https://sae.uan.edu.mx/#docente/${x.id}`); assert.equal(x.png, await esperado(x.id)); }
});

test('sin sesión 401 y los estudiantes no tienen esta pantalla (403)', async () => {
  assert.equal((await cliente().call('/api/qr/docentes')).status, 401);
  const ana = cliente(); await correo.registrar((u, b) => ana.call(u, 'POST', b), { matricula: '24100001', email: 'ana@uan.edu.mx', password: 'segura1234' });
  assert.equal((await ana.call('/api/qr/docentes')).status, 403);
  const general = await ana.call('/api/qr'); assert.equal(general.status, 200, 'el QR general sigue para todos'); assert.equal(general.json.url, 'https://sae.uan.edu.mx/');
});

test('la ficha de un docente por número: datos para el enlace directo; 404 si no existe o el número no es válido', async () => {
  const c = await entrar('DOC001', 'Docente2026'), id = idDe('DOC001'), r = await c.call('/api/docentes/' + id);
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json).sort(), ['cubiculo', 'foto', 'id', 'libres', 'materias', 'nombre']); assert.equal(r.json.id, id);
  assert.equal(r.json.libres, (await c.call('/api/docentes')).json.find(d => d.id === id).libres, 'mismos horarios libres que el catálogo');
  assert.ok(!JSON.stringify(r.json).match(/email|pass|@/), 'no expone correos ni contraseñas');
  for (const mal of ['99999', 'abc', '1.5', '1.0', '1e0', '-1', '1%20OR%201=1', '0x10', '1234567890123']) assert.equal((await c.call('/api/docentes/' + mal)).status, 404, mal);
  assert.equal((await cliente().call('/api/docentes/' + id)).status, 401, 'pide sesión como el catálogo');
});

test('en producción sin BASE_URL el servidor avisa que los QR apuntarían a localhost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-qr-')); const arrancar = base => new Promise(ok => {
    const env = { ...process.env, DB_FILE: path.join(dir, crypto.randomUUID() + '.db'), PORT: '0', NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), SMTP_HOST: 'smtp.invalido.test' }; delete env.BASE_URL; if (base) env.BASE_URL = base;
    const p = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: path.join(__dirname, '..'), env }); let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (/SAE en/.test(out)) p.kill(); }); p.stderr.on('data', d => { err += d; }); p.on('exit', () => ok({ out, err })); setTimeout(() => p.kill(), 15000); });
  try {
    const sin = await arrancar(); assert.match(sin.err, /BASE_URL no está configurada/); assert.match(sin.out, /SAE en/);
    const con = await arrancar('https://sae.uan.edu.mx'); assert.ok(!/BASE_URL/.test(con.err)); assert.match(con.out, /SAE en https:\/\/sae\.uan\.edu\.mx/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
