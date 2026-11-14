// Registro con verificación de correo: la cuenta solo se crea con el código que llega al buzón institucional.
process.env.DB_FILE = ':memory:'; delete process.env.DOMINIOS_CORREO; delete process.env.NODE_ENV;
const test = require('node:test'), assert = require('node:assert');
const correo = require('../pruebas-ayuda/correo')();
const app = require('../server'); require('../seed')(app.db);
const db = app.db, real = Date.now.bind(Date);
let srv, base, desfase = 0, n = 100;
test.before(() => { test.mock.method(Date, 'now', () => real() + desfase); return new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }); });
test.after(() => { test.mock.restoreAll(); srv.close(); });
test.beforeEach(() => { desfase = 0; });
const post = async (url, body, cookie = '') => { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const me = async cookie => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user;
const alumno = (extra = {}) => { const m = String(24200000 + ++n); db.prepare('INSERT INTO padron(matricula,nombre,email) VALUES(?,?,?)').run(m, 'Alumno ' + m, extra.email ?? null); return m; };
const pedir = (matricula, email = `${matricula}@uan.edu.mx`, password = 'segura1234') => post('/api/registro', { matricula, email, password });
const hayCuenta = m => !!db.prepare('SELECT 1 FROM users WHERE matricula=?').get(m);
const confirmar = (matricula, codigo) => post('/api/registro/confirmar', { matricula, codigo });
const malo = c => String((+c + 1) % 1e6).padStart(6, '0');                        // un código distinto del bueno

test('pedir el registro NO crea la cuenta ni abre sesión: solo envía un código al correo', async () => {
  const m = alumno(), antes = correo.enviados.length, r = await pedir(m, 'ana.nueva@uan.edu.mx');
  assert.equal(r.status, 200); assert.equal(r.json.pendiente, true); assert.equal(r.cookie, '', 'no hay cookie de sesión');
  assert.equal(r.json.correo, 'a***@uan.edu.mx', 'el correo se muestra enmascarado');
  assert.ok(!hayCuenta(m), 'la cuenta no existe todavía');
  assert.equal(correo.enviados.length, antes + 1); const mail = correo.enviados.at(-1);
  assert.equal(mail.to, 'ana.nueva@uan.edu.mx'); assert.match(mail.text, /\b\d{6}\b/);
});

test('con el código correcto se crea la cuenta (con el correo verificado) y se abre la sesión', async () => {
  const m = alumno(), r = await pedir(m, 'Luis.Mora@UAN.edu.mx'); assert.equal(r.status, 200);
  const c = await confirmar(m, correo.codigo('luis.mora@uan.edu.mx')); assert.equal(c.status, 200); assert.ok(c.cookie.startsWith('sae='));
  const u = await me(c.cookie); assert.equal(u.rol, 'estudiante'); assert.equal(u.matricula, m); assert.equal(u.email, 'luis.mora@uan.edu.mx');
  assert.equal((await post('/api/login', { matricula: m, password: 'segura1234' })).status, 200, 'la contraseña elegida al registrarse funciona');
});

test('el código no se guarda: ni en la bitácora (que lee la secretaría) ni en la base', async () => {
  const m = alumno(); await pedir(m); const cod = correo.codigo(`${m}@uan.edu.mx`);
  const todo = JSON.stringify([db.prepare('SELECT * FROM notificaciones').all(), db.prepare('SELECT * FROM codigos').all()]);
  assert.ok(!todo.includes(cod), 'el código en claro no aparece');
  const bit = db.prepare('SELECT * FROM notificaciones WHERE destinatario=? ORDER BY id DESC').get(`${m}@uan.edu.mx`); assert.equal(bit.enviado, 1);
});

test('quien conoce la matrícula pero no el buzón no puede quedarse con la cuenta', async () => {
  const m = alumno(); await pedir(m, 'atacante@uan.edu.mx');                           // el atacante pide el registro con la matrícula de otro
  const cod = correo.codigo('atacante@uan.edu.mx');
  for (let i = 0; i < 3; i++) assert.equal((await confirmar(m, malo(cod))).status, 400);   // adivina sin ver el correo de la víctima
  assert.ok(!hayCuenta(m));
  desfase = 61e3;                                                                      // la persona real pide su registro con SU correo: reemplaza la solicitud
  assert.equal((await pedir(m, 'victima@uan.edu.mx', 'clave-de-la-victima')).status, 200);
  const reales = correo.codigo('victima@uan.edu.mx');
  assert.equal((await confirmar(m, cod === reales ? malo(cod) : cod)).status, 400, 'el código del atacante ya no sirve');
  const c = await confirmar(m, reales); assert.equal(c.status, 200);
  const u = await me(c.cookie); assert.equal(u.email, 'victima@uan.edu.mx');
  assert.equal((await post('/api/login', { matricula: m, password: 'clave-de-la-victima' })).status, 200);
});

test('5 intentos fallidos bloquean ese código, incluso con el correcto; uno nuevo funciona', async () => {
  const m = alumno(); await pedir(m); const cod = correo.codigo(`${m}@uan.edu.mx`);
  for (let i = 0; i < 5; i++) assert.equal((await confirmar(m, malo(cod))).status, 400);
  const r = await confirmar(m, cod); assert.equal(r.status, 429); assert.match(r.json.error, /Pide uno nuevo/); assert.ok(!hayCuenta(m));
  desfase = 61e3; assert.equal((await pedir(m)).status, 200);
  assert.equal((await confirmar(m, correo.codigo(`${m}@uan.edu.mx`))).status, 200, 'el código nuevo empieza con los intentos en cero');
});

test('el código caduca a los 15 minutos (y a los 14 todavía sirve)', async () => {
  const a = alumno(), b = alumno(); await pedir(a); await pedir(b);
  desfase = 14 * 60e3; assert.equal((await confirmar(a, correo.codigo(`${a}@uan.edu.mx`))).status, 200);
  desfase = 16 * 60e3; const r = await confirmar(b, correo.codigo(`${b}@uan.edu.mx`)); assert.equal(r.status, 400); assert.match(r.json.error, /venció/); assert.ok(!hayCuenta(b));
});

test('el código es de un solo uso y sin solicitud previa no hay nada que confirmar', async () => {
  const m = alumno(); await pedir(m); const cod = correo.codigo(`${m}@uan.edu.mx`);
  assert.equal((await confirmar(m, cod)).status, 200); assert.equal((await confirmar(m, cod)).status, 400, 'repetirlo no sirve (ya no hay solicitud pendiente)');
  assert.equal((await confirmar(alumno(), '123456')).status, 400, 'matrícula sin solicitud');
  assert.equal((await confirmar('99999999', '123456')).status, 400, 'matrícula fuera del padrón');
  for (const x of [undefined, null, '', 'abcdef', '12345', '1234567', {}, [123456]]) { const o = alumno(); await pedir(o); assert.equal((await confirmar(o, x)).status, 400, JSON.stringify(x)); assert.ok(!hayCuenta(o)); }
});

test('no se puede pedir otro código hasta pasados 60 s, y máximo 5 por hora (nadie puede llenar el buzón de otra persona)', async () => {
  const m = alumno(); assert.equal((await pedir(m)).status, 200);
  const r = await pedir(m); assert.equal(r.status, 429); assert.match(r.json.error, /Espera un minuto/);
  for (let i = 2; i <= 5; i++) { desfase = (i - 1) * 61e3; assert.equal((await pedir(m)).status, 200, 'envío #' + i); }
  const antes = correo.enviados.length; desfase = 5 * 61e3;
  const tope = await pedir(m); assert.equal(tope.status, 429); assert.match(tope.json.error, /demasiados códigos/); assert.equal(correo.enviados.length, antes, 'no se envía el 6.º correo');
  desfase = 3600e3 + 10e3; assert.equal((await pedir(m)).status, 200, 'pasada la hora se puede otra vez');
});

test('solo se aceptan correos del dominio institucional (y sus subdominios) si el padrón no trae el correo', async () => {
  const m = alumno(), antes = correo.enviados.length;
  for (const mal of ['alguien@gmail.com', 'x@uan.edu.mx.evil.com', 'x@notuan.edu.mx', 'x@evil.com', 'sinarroba', 'a b@uan.edu.mx', 'a@@uan.edu.mx', '', null])
    assert.equal((await pedir(alumno(), mal)).status, 400, JSON.stringify(mal));
  assert.equal(correo.enviados.length, antes, 'no se envió nada');
  assert.equal((await pedir(m, 'x@alumnos.uan.edu.mx')).status, 200, 'subdominio permitido');
  process.env.DOMINIOS_CORREO = 'otra.mx, @uan.edu.mx'; desfase = 61e3;
  try { assert.equal((await pedir(m, 'x@otra.mx')).status, 200, 'DOMINIOS_CORREO configurable'); } finally { delete process.env.DOMINIOS_CORREO; }
});

test('si el padrón trae el correo de la matrícula, el código va a ESE correo, no al que se escriba', async () => {
  const m = alumno({ email: 'Diego.Real@uan.edu.mx' }), antes = correo.enviados.length;
  const r = await pedir(m, 'otro@gmail.com'); assert.equal(r.status, 200); assert.equal(r.json.correo, 'd***@uan.edu.mx');
  assert.equal(correo.enviados.length, antes + 1); assert.equal(correo.enviados.at(-1).to, 'diego.real@uan.edu.mx');
  const c = await confirmar(m, correo.codigo('diego.real@uan.edu.mx')); assert.equal(c.status, 200);
  assert.equal((await me(c.cookie)).email, 'diego.real@uan.edu.mx');
  const m2 = alumno({ email: 'sin.correo.escrito@uan.edu.mx' }); assert.equal((await post('/api/registro', { matricula: m2, password: 'segura1234' })).status, 200, 'con correo en el padrón no hace falta escribirlo');
});

test('una matrícula que ya tiene cuenta no recibe correo: 409', async () => {
  const r = await pedir('SEC001'); assert.equal(r.status, 403, 'una clave que no es del padrón (ej. la secretaría) no se puede registrar');
  const m = alumno(); await pedir(m); await confirmar(m, correo.codigo(`${m}@uan.edu.mx`)); const despues = correo.enviados.length;
  const otra = await pedir(m); assert.equal(otra.status, 409); assert.equal(correo.enviados.length, despues);
});

test('si el correo no se puede enviar: 502 y no queda solicitud ni espera (se puede reintentar enseguida)', async () => {
  const m = alumno(); correo.falla = true;
  try { const r = await pedir(m); assert.equal(r.status, 502); } finally { correo.falla = false; }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM codigos WHERE matricula=?').get(m).n, 0, 'no queda solicitud');
  assert.equal(db.prepare('SELECT enviado FROM notificaciones WHERE destinatario=? ORDER BY id DESC').get(`${m}@uan.edu.mx`).enviado, 0, 'la bitácora lo marca como no enviado');
  assert.equal((await pedir(m)).status, 200, 'sin esperar los 60 s');
});
