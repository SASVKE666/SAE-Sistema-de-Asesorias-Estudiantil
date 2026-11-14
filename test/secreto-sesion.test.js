// El secreto que firma las sesiones: sin valor por defecto conocido, y en producción el servidor no arranca sin uno propio y fuerte.
const test = require('node:test'), assert = require('node:assert');
const { spawn } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const RAIZ = path.join(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sae-secreto-')); let n = 0;
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BUENO = crypto.randomBytes(32).toString('hex');                              // 64 caracteres

// Arranca server.js de verdad (proceso aparte); devuelve lo que imprimió y el código de salida si terminó solo.
function arrancar(env) {
  const e = { ...process.env, DB_FILE: path.join(dir, `b${++n}.db`), PORT: '0' }; for (const k of ['SESSION_SECRET', 'NODE_ENV', 'SEED_DEMO']) delete e[k];
  Object.assign(e, env);
  return new Promise(ok => {
    const p = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: RAIZ, env: e });
    let out = '', err = '', listo = false;
    const fin = code => { clearTimeout(t); ok({ out, err, code, escucha: listo }); };
    p.stdout.on('data', d => { out += d; if (!listo && /SAE en/.test(out)) { listo = true; p.once('exit', () => fin(null)); p.kill(); } });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', code => { if (!listo) fin(code); });
    const t = setTimeout(() => p.kill(), 20000);
  });
}

test('en producción sin SESSION_SECRET el servidor no arranca y explica cómo generar uno', async () => {
  const r = await arrancar({ NODE_ENV: 'production' });
  assert.equal(r.code, 1); assert.ok(!r.escucha, 'no llegó a escuchar');
  assert.match(r.err, /SESSION_SECRET/); assert.match(r.err, /randomBytes/);
});

test('en producción se rechazan vacío, espacios, los valores de ejemplo y los secretos de menos de 32 caracteres', async () => {
  const malos = ['', '   ', ' '.repeat(40), 'cambia-este-secreto-en-produccion', 'pon-aqui-una-cadena-larga-y-aleatoria', 'PON-AQUI-UNA-CADENA-LARGA-Y-ALEATORIA',
    'x'.repeat(31), 'una-clave-buena-pero-" + "cambia-este-ejemplo-xxxxxxxxxxxxx'];
  for (const v of malos) { const r = await arrancar({ NODE_ENV: 'production', SESSION_SECRET: v }); assert.equal(r.code, 1, JSON.stringify(v)); assert.ok(!r.escucha, JSON.stringify(v)); }
});

test('en producción un secreto propio de 32+ caracteres arranca normal y sin avisos de secreto', async () => {
  for (const v of ['x'.repeat(32), BUENO]) { const r = await arrancar({ NODE_ENV: 'production', SESSION_SECRET: v }); assert.ok(r.escucha, v.length + ' caracteres'); assert.ok(!/SESSION_SECRET/.test(r.out + r.err)); }
});

test('fuera de producción arranca sin secreto (uno temporal) y lo avisa; con secreto propio no avisa', async () => {
  for (const env of [{}, { SESSION_SECRET: '' }, { SESSION_SECRET: 'pon-aqui-una-cadena-larga-y-aleatoria' }, { NODE_ENV: 'development' }]) {
    const r = await arrancar(env); assert.ok(r.escucha, JSON.stringify(env)); assert.match(r.out, /SESSION_SECRET no está definido.*temporal/);
  }
  const r = await arrancar({ SESSION_SECRET: 'corto-pero-propio' }); assert.ok(r.escucha); assert.ok(!/SESSION_SECRET/.test(r.out), 'un secreto propio (aunque corto) en desarrollo no avisa');
});
