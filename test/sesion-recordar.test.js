// «Mantener la sesión abierta»: opcional al iniciar sesión (30 días, configurable); sin marcar sigue siendo de 8 h.
process.env.DB_FILE = ':memory:'; delete process.env.NODE_ENV; delete process.env.SESION_RECORDAR_DIAS;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, AHORA = Date.UTC(2026, 10, 18, 18, 0), HORA = 3600e3, DIA = 24 * HORA;
let srv, base, desfase = 0;
test.before(async () => { test.mock.method(Date, 'now', () => AHORA + desfase); await new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { desfase = 0; delete process.env.SESION_RECORDAR_DIAS; });
const pedir = async (url, { method = 'GET', body, cookie = '' } = {}) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
  const raw = r.headers.get('set-cookie') || ''; return { status: r.status, json: await r.json(), raw, cookie: raw.split(';')[0], maxAge: Number((/Max-Age=(\d+)/i.exec(raw) || [])[1]) }; };
const entrar = (recordar, m = 'DOC001', p = 'Docente2026') => pedir('/api/login', { method: 'POST', body: { matricula: m, password: p, ...(recordar === undefined ? {} : { recordar }) } });
const vence = c => JSON.parse(Buffer.from(decodeURIComponent(c.split('=')[1]).split('.')[0], 'base64url').toString()).exp - Date.now();
const sigue = async (cookie, tras) => { desfase = tras; try { return (await pedir('/api/me', { cookie })).json.user !== null; } finally { desfase = 0; } };

test('sin marcar la casilla la sesión dura 8 h (como siempre); marcada, 30 días', async () => {
  const n = await entrar(false); assert.equal(n.status, 200); assert.equal(n.maxAge, 8 * 3600); assert.equal(vence(n.cookie), 8 * HORA);
  const r = await entrar(true); assert.equal(r.status, 200); assert.equal(r.maxAge, 30 * 86400); assert.equal(vence(r.cookie), 30 * DIA);
  assert.match(r.raw, /HttpOnly/i); assert.match(r.raw, /SameSite=Lax/i);
  assert.equal(await sigue(n.cookie, 7 * HORA), true); assert.equal(await sigue(n.cookie, 8 * HORA + 1000), false, 'la normal vence a las 8 h');
  assert.equal(await sigue(r.cookie, 8 * HORA + 1000), true, 'la recordada sigue'); assert.equal(await sigue(r.cookie, 29 * DIA), true); assert.equal(await sigue(r.cookie, 30 * DIA + 1000), false, 'y vence a los 30 días');
});

test('solo `true` (booleano) la recuerda: ausente, "true", 1, "on" o null dan la sesión normal', async () => {
  for (const v of [undefined, 'true', 1, 'on', null, 0, [true], {}]) { const r = await entrar(v); assert.equal(r.status, 200); assert.equal(r.maxAge, 8 * 3600, 'recordar=' + JSON.stringify(v)); }
});

test('SESION_RECORDAR_DIAS cambia la duración; vacío, 0, negativo, decimal, texto o más de 90 vuelven a 30', async () => {
  for (const [v, dias] of [['7', 7], ['1', 1], ['90', 90], ['', 30], ['0', 30], ['-5', 30], ['1.5', 30], ['91', 30], ['abc', 30], ['1e1', 10]]) {
    process.env.SESION_RECORDAR_DIAS = v; const r = await entrar(true); assert.equal(r.maxAge, dias * 86400, `SESION_RECORDAR_DIAS="${v}"`); assert.equal(vence(r.cookie), dias * DIA);
    assert.equal((await entrar(false)).maxAge, 8 * 3600, 'sin marcar nunca cambia');
  }
});

test('una contraseña incorrecta no abre sesión ni cookie aunque pidan recordarla', async () => {
  const r = await entrar(true, 'DOC001', 'incorrecta'); assert.equal(r.status, 401); assert.equal(r.raw, '');
});

test('la sesión recordada se cierra igual al cambiar la contraseña, al desactivar la cuenta y al cerrar sesión', async () => {
  const a = await entrar(true, 'DOC002'), b = await entrar(true, 'DOC003'), c = await entrar(true, 'SEC001', 'Secretaria2026');
  assert.equal((await pedir('/api/me', { cookie: a.cookie })).json.user.matricula, 'DOC002');
  db.prepare("UPDATE users SET pass_hash=? WHERE matricula='DOC002'").run(require('bcryptjs').hashSync('Otra-clave-2026', 4)); assert.equal((await pedir('/api/me', { cookie: a.cookie })).json.user, null, 'cambio de contraseña');
  db.prepare("UPDATE users SET activo=0 WHERE matricula='DOC003'").run(); assert.equal((await pedir('/api/me', { cookie: b.cookie })).json.user, null, 'cuenta desactivada'); db.prepare("UPDATE users SET activo=1 WHERE matricula='DOC003'").run();
  const o = await pedir('/api/logout', { method: 'POST', cookie: c.cookie }); assert.match(o.raw, /sae=;/); assert.match(o.raw, /Expires=Thu, 01 Jan 1970/i);
});

test('el registro de estudiantes abre la sesión normal (8 h): la casilla es solo del inicio de sesión', async () => {
  correo.enviados.length = 0; db.prepare("INSERT OR IGNORE INTO padron(matricula,nombre) VALUES('24100001','Ana')").run();
  assert.equal((await pedir('/api/registro', { method: 'POST', body: { matricula: '24100001', email: 'ana@uan.edu.mx', password: 'segura1234', recordar: true } })).status, 200);
  const r = await pedir('/api/registro/confirmar', { method: 'POST', body: { matricula: '24100001', codigo: correo.codigo('ana@uan.edu.mx'), recordar: true } }); assert.equal(r.status, 200); assert.equal(r.maxAge, 8 * 3600);
});
