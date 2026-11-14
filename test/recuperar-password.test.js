// Recuperación de contraseña por código al correo: sin revelar quién tiene cuenta, con topes, y cerrando las sesiones abiertas.
process.env.DB_FILE = ':memory:'; delete process.env.DOMINIOS_CORREO; delete process.env.NODE_ENV;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, real = Date.now.bind(Date);
let srv, base, desfase = 0, n = 300;
test.before(() => { test.mock.method(Date, 'now', () => real() + desfase); return new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { desfase = 0; });
const post = async (url, body, cookie = '') => { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const me = async cookie => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user;
const espera = ms => new Promise(ok => setTimeout(ok, ms));
const esperarCodigo = async para => { for (let i = 0; i < 100; i++) { const c = correo.codigo(para); if (c && correo.enviados.filter(m => m.to === para).length > (esperarCodigo.vistos[para] || 0)) { esperarCodigo.vistos[para] = correo.enviados.filter(m => m.to === para).length; return c; } await espera(10); } throw new Error('no llegó el código a ' + para); };
esperarCodigo.vistos = {};
const malo = c => String((+c + 1) % 1e6).padStart(6, '0');
// Un alumno con cuenta (registro completo) y su sesión abierta; el correo es distinto por alumno.
const alumno = async (pass = 'clave-original-1') => { const m = String(24300000 + ++n), email = `a${m}@uan.edu.mx`;
  db.prepare('INSERT INTO padron(matricula,nombre) VALUES(?,?)').run(m, 'Alumno ' + m);
  const r = await correo.registrar((url, b) => post(url, b), { matricula: m, email, password: pass }); esperarCodigo.vistos[email] = correo.enviados.filter(x => x.to === email).length;
  return { m, email, cookie: r.cookie }; };
const pedir = m => post('/api/recuperar', { matricula: m });
const cambiar = (m, codigo, password) => post('/api/recuperar/confirmar', { matricula: m, codigo, password });

test('la respuesta es idéntica exista o no la cuenta, y solo a la existente le llega el correo', async () => {
  const a = await alumno(), antes = correo.enviados.length;
  const si = await pedir(a.m), no = await pedir('99999999'), vacio = await post('/api/recuperar', {}), raro = await post('/api/recuperar', { matricula: { x: 1 } });
  for (const r of [no, vacio, raro]) { assert.equal(r.status, si.status); assert.deepEqual(r.json, si.json); assert.equal(r.cookie, ''); }
  assert.equal(si.status, 200); await esperarCodigo(a.email);
  assert.equal(correo.enviados.length, antes + 1, 'solo se envió el de la cuenta existente'); assert.equal(correo.enviados.at(-1).to, a.email);
});

test('con el código se cambia la contraseña: la nueva entra, la vieja ya no, y el código no se reutiliza', async () => {
  const a = await alumno(); await pedir(a.m); const cod = await esperarCodigo(a.email);
  assert.equal((await cambiar(a.m, cod, 'clave-nueva-2')).status, 200);
  assert.equal((await post('/api/login', { matricula: a.m, password: 'clave-nueva-2' })).status, 200);
  assert.equal((await post('/api/login', { matricula: a.m, password: 'clave-original-1' })).status, 401);
  assert.equal((await cambiar(a.m, cod, 'otra-clave-3')).status, 400, 'un solo uso');
  assert.equal((await post('/api/login', { matricula: a.m, password: 'otra-clave-3' })).status, 401);
});

test('al cambiar la contraseña se cierran las sesiones abiertas (también la de quien tuviera la cuenta)', async () => {
  const a = await alumno(); assert.equal((await me(a.cookie)).matricula, a.m, 'control: la sesión vale antes');
  await pedir(a.m); assert.equal((await me(a.cookie)).matricula, a.m, 'pedir el código no cierra la sesión');
  assert.equal((await cambiar(a.m, await esperarCodigo(a.email), 'clave-nueva-2')).status, 200);
  assert.equal(await me(a.cookie), null, 'la sesión anterior ya no vale');
  const nueva = await post('/api/login', { matricula: a.m, password: 'clave-nueva-2' }); assert.equal((await me(nueva.cookie)).matricula, a.m, 'la sesión nueva sí');
});

test('se avisa por correo del cambio, y los códigos no quedan en la bitácora ni en la base', async () => {
  const a = await alumno(); await pedir(a.m); const cod = await esperarCodigo(a.email); await cambiar(a.m, cod, 'clave-nueva-2'); await espera(50);
  assert.ok(correo.enviados.some(m => m.to === a.email && /contraseña cambió/.test(m.subject)), 'aviso de cambio');
  assert.ok(!JSON.stringify([db.prepare('SELECT * FROM notificaciones').all(), db.prepare('SELECT * FROM codigos').all()]).includes(cod));
});

test('código incorrecto: 5 intentos y se bloquea (incluso con el correcto); no cambia la contraseña', async () => {
  const a = await alumno(); await pedir(a.m); const cod = await esperarCodigo(a.email);
  for (let i = 0; i < 5; i++) assert.equal((await cambiar(a.m, malo(cod), 'clave-nueva-2')).status, 400);
  assert.equal((await cambiar(a.m, cod, 'clave-nueva-2')).status, 429);
  assert.equal((await post('/api/login', { matricula: a.m, password: 'clave-original-1' })).status, 200, 'la contraseña no cambió');
});

test('caduca a los 15 minutos', async () => {
  const a = await alumno(); await pedir(a.m); const cod = await esperarCodigo(a.email);
  desfase = 16 * 60e3; const r = await cambiar(a.m, cod, 'clave-nueva-2'); assert.equal(r.status, 400); assert.match(r.json.error, /venció/);
});

test('una contraseña que no cumple no gasta el código ni los intentos; se corrige y se reintenta', async () => {
  const a = await alumno(); await pedir(a.m); const cod = await esperarCodigo(a.email);
  for (const mala of ['corta', '1234567', undefined, null, 12345678]) assert.equal((await cambiar(a.m, cod, mala)).status, 400, JSON.stringify(mala));
  assert.equal(db.prepare("SELECT intentos FROM codigos WHERE tipo='recuperar' AND matricula=?").get(a.m).intentos, 0);
  assert.equal((await cambiar(a.m, cod, 'clave-nueva-2')).status, 200, 'el mismo código sigue sirviendo');
});

test('docentes y secretaría: mínimo 10 caracteres y nunca la contraseña de demostración', async () => {
  await pedir('DOC002'); const cod = await esperarCodigo('doc002@uan.edu.mx');
  for (const mala of ['12345678', '123456789', 'Docente2026']) assert.equal((await cambiar('DOC002', cod, mala)).status, 400, mala);
  assert.equal((await cambiar('DOC002', cod, 'clave-docente-propia')).status, 200);
  assert.equal((await post('/api/login', { matricula: 'DOC002', password: 'clave-docente-propia' })).status, 200);
  assert.equal((await post('/api/login', { matricula: 'DOC002', password: 'Docente2026' })).status, 401);
  await pedir('SEC001'); const c2 = await esperarCodigo('secretaria@uan.edu.mx'); assert.equal((await cambiar('SEC001', c2, 'Secretaria2026')).status, 400);
  assert.equal((await cambiar('SEC001', c2, 'secretaria-propia-1')).status, 200);
});

test('un código de registro no sirve para recuperar (ni al revés): cada tipo es aparte', async () => {
  const m = String(24300000 + ++n); db.prepare('INSERT INTO padron(matricula,nombre) VALUES(?,?)').run(m, 'Pendiente'); await post('/api/registro', { matricula: m, email: `p${m}@uan.edu.mx`, password: 'segura1234' });
  const codReg = correo.codigo(`p${m}@uan.edu.mx`);
  assert.equal((await cambiar(m, codReg, 'clave-nueva-2')).status, 400, 'no hay solicitud de recuperación');
  assert.equal((await post('/api/login', { matricula: m, password: 'clave-nueva-2' })).status, 401);
  const a = await alumno(); await pedir(a.m); const codRec = await esperarCodigo(a.email);
  assert.equal((await post('/api/registro/confirmar', { matricula: a.m, codigo: codRec })).status, 400, 'ese código no confirma registros');
});

test('esperas y topes: pedir muy seguido no manda más correos (y la respuesta no delata nada)', async () => {
  const a = await alumno(), antes = correo.enviados.length, primera = await pedir(a.m); await esperarCodigo(a.email);
  const segunda = await pedir(a.m); assert.deepEqual(segunda.json, primera.json); assert.equal(segunda.status, 200); await espera(50);
  assert.equal(correo.enviados.length, antes + 1, 'dentro de los 60 s no se manda otro');
  for (let i = 2; i <= 5; i++) { desfase = (i - 1) * 61e3; await pedir(a.m); await esperarCodigo(a.email); }
  assert.equal(correo.enviados.length, antes + 5); desfase = 5 * 61e3; await pedir(a.m); await espera(50);
  assert.equal(correo.enviados.length, antes + 5, 'tope de 5 por hora'); desfase = 3600e3 + 10e3; await pedir(a.m); await esperarCodigo(a.email);
  assert.equal(correo.enviados.length, antes + 6, 'pasada la hora se puede otra vez');
});

test('si el correo falla no queda solicitud (se puede reintentar enseguida)', async () => {
  const a = await alumno(); correo.falla = true;
  try { assert.equal((await pedir(a.m)).status, 200); await espera(100); } finally { correo.falla = false; }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM codigos WHERE tipo='recuperar' AND matricula=?").get(a.m).n, 0);
  await pedir(a.m); assert.match(await esperarCodigo(a.email), /^\d{6}$/);
});

test('los cupos de login y de recuperación van aparte: quien falló al entrar sí puede recuperar, y pedir un código NO borra sus fallos', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/login', { matricula: 'DOC003', password: 'mala' + i })).status, 401);
  assert.equal((await post('/api/login', { matricula: 'DOC003', password: 'otra-mala' })).status, 429, 'el login queda frenado');
  assert.equal((await pedir('DOC003')).status, 200, 'pero puede pedir el código de recuperación');
  assert.equal((await post('/api/login', { matricula: 'DOC003', password: 'Docente2026' })).status, 429, 'y eso no le devuelve el cupo de login (no se esquiva el límite)');
  const cod = await esperarCodigo('doc003@uan.edu.mx'); assert.equal((await cambiar('DOC003', cod, 'clave-docente-propia')).status, 200);
});

test('los intentos de adivinar códigos de recuperación también se frenan por matrícula+IP (aunque se vaya pidiendo uno nuevo)', async () => {
  const a = await alumno();
  for (let i = 0; i < 8; i++) assert.equal((await cambiar(a.m, '000000', 'clave-nueva-2')).status, 400, 'sin solicitud pendiente');
  assert.equal((await cambiar(a.m, '000000', 'clave-nueva-2')).status, 429, 'el noveno intento se frena');
  assert.equal((await pedir(a.m)).status, 429, 'pedir códigos nuevos no esquiva el freno'); assert.equal((await post('/api/login', { matricula: a.m, password: 'clave-original-1' })).status, 200, 'el login no se ve afectado');
});
