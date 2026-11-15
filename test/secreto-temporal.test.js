// Sin secreto propio no hay ningún valor conocido con el que fabricar sesiones; con uno propio, solo ese sirve.
const test = require('node:test'), assert = require('node:assert'), crypto = require('node:crypto');
const CONOCIDOS = ['cambia-este-secreto-en-produccion', 'pon-aqui-una-cadena-larga-y-aleatoria', '', 'secret', 'undefined'];   // el valor por defecto anterior, el de .env.example y otros típicos
const firmar = (d, secreto) => { const p = Buffer.from(JSON.stringify(d)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secreto).update(p).digest('base64url'); };
let dbActual;                                                                          // base de la instancia cargada más recientemente (para la versión de sesión)
const versionPass = h => crypto.createHash('sha256').update(h).digest('base64url').slice(0, 16);
const sesion = secreto => 'sae=' + firmar({ uid: 1, exp: Date.now() + 36e5, v: versionPass(dbActual.prepare('SELECT pass_hash FROM users WHERE id=1').get().pass_hash) }, secreto);   // uid 1 = la secretaría (SEC001) en los datos de demostración

// Carga una instancia NUEVA del servidor con ese SESSION_SECRET (o sin él), base en memoria y datos de demostración.
async function instancia(secreto) {
  if (secreto === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secreto;
  process.env.DB_FILE = ':memory:'; delete process.env.NODE_ENV;
  delete require.cache[require.resolve('../server')];
  const app = require('../server'); require('../seed')(app.db); dbActual = app.db;
  const srv = await new Promise(ok => { const s = app.listen(0, () => ok(s)); });
  const base = 'http://localhost:' + srv.address().port;
  return { srv, yo: async cookie => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user,
    login: async () => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ matricula: 'SEC001', password: 'Secretaria2026' }) })).headers.get('set-cookie').split(';')[0] };
}

test('sin SESSION_SECRET no se puede falsificar una sesión con los valores conocidos', async () => {
  const a = await instancia(undefined);
  try {
    const propia = await a.login(); assert.equal((await a.yo(propia)).rol, 'secretaria', 'control: la sesión legítima funciona');
    for (const v of CONOCIDOS) assert.equal(await a.yo(sesion(v)), null, 'secreto conocido: ' + JSON.stringify(v));
  } finally { a.srv.close(); }
});

test('un SESSION_SECRET de ejemplo o en blanco se trata como no definido (tampoco sirve para falsificar)', async () => {
  for (const v of ['pon-aqui-una-cadena-larga-y-aleatoria', 'Cambia-Este-Secreto-en-produccion', '   ']) {
    const a = await instancia(v);
    try { assert.equal(await a.yo(sesion(v)), null, JSON.stringify(v)); assert.equal((await a.yo(await a.login())).rol, 'secretaria'); } finally { a.srv.close(); }
  }
});

test('el secreto temporal es distinto en cada arranque: la sesión de un proceso no vale en otro', async () => {
  const a = await instancia(undefined), cookie = await a.login(); a.srv.close();
  const b = await instancia(undefined);
  try { assert.equal(await b.yo(cookie), null, 'la cookie de la instancia anterior no se acepta'); } finally { b.srv.close(); }
});

test('con secreto propio solo sirve ese: la sesión firmada con él se acepta y las demás no', async () => {
  const propio = crypto.randomBytes(32).toString('hex'), a = await instancia(propio);
  try {
    assert.equal((await a.yo(sesion(propio))).rol, 'secretaria', 'control: firmar con el secreto correcto funciona (la técnica de falsificación es válida)');
    for (const v of [...CONOCIDOS, propio + 'x', propio.slice(1)]) assert.equal(await a.yo(sesion(v)), null, JSON.stringify(v.slice(0, 12)));
    assert.equal((await a.yo(await a.login())).rol, 'secretaria');
  } finally { a.srv.close(); }
});
