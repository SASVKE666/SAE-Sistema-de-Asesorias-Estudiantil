// Sin SMTP: en desarrollo el código sale por la consola; en producción no se puede registrar nadie (no hay forma de verificar) y se dice claro.
process.env.DB_FILE = ':memory:'; delete process.env.SMTP_HOST; delete process.env.NODE_ENV; delete process.env.DOMINIOS_CORREO;
const test = require('node:test'), assert = require('node:assert');
const app = require('../server'); require('../seed')(app.db);
const db = app.db; let srv, base;
test.before(() => new Promise(ok => { srv = app.listen(0, () => { base = 'http://localhost:' + srv.address().port; ok(); }); }));
test.after(() => srv.close());
const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie') }; };

test('desarrollo sin SMTP: el código se imprime en la consola y con él se completa el registro', async t => {
  const log = t.mock.method(console, 'log', () => {});
  const r = await post('/api/registro', { matricula: '24100001', email: 'ana@uan.edu.mx', password: 'segura1234' }); assert.equal(r.status, 200);
  const salida = log.mock.calls.map(c => c.arguments.join(' ')).join('\n'); const cod = /\b(\d{6})\b/.exec(salida)?.[1];
  assert.match(salida, /ana@uan\.edu\.mx/); assert.ok(cod, 'el código aparece en la consola');
  assert.equal((await post('/api/registro/confirmar', { matricula: '24100001', codigo: cod })).status, 200);
});

test('producción sin SMTP: 503 claro, sin crear solicitud ni gastar el cupo de envíos', async () => {
  process.env.NODE_ENV = 'production';
  try {
    const r = await post('/api/registro', { matricula: '24100002', email: 'diego@uan.edu.mx', password: 'segura1234' });
    assert.equal(r.status, 503); assert.match(r.json.error, /correo del sistema no está configurado/); assert.equal(r.cookie, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM codigos WHERE matricula=?').get('24100002').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE matricula=?').get('24100002').n, 0);
  } finally { delete process.env.NODE_ENV; }
});
