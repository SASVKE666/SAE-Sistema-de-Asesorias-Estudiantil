// El README dice cuántas cuentas, matrículas y horarios crea `npm run demo`: que no se desactualice cuando cambie seed.js.
process.env.DB_FILE = ':memory:'; delete process.env.NODE_ENV;
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), path = require('node:path');
const app = require('../server'); require('../seed')(app.db);
const db = app.db, readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const n = sql => db.prepare(sql).get().n;

test('los números del README coinciden con lo que crea seed.js', () => {
  const cuentas = n('SELECT COUNT(*) n FROM users'), matriculas = n('SELECT COUNT(*) n FROM padron'), horarios = n('SELECT COUNT(*) n FROM horarios');
  assert.equal(cuentas, 4); assert.equal(matriculas, 3); assert.equal(horarios, 70, '14 días seguidos siempre traen 10 días hábiles');
  assert.ok(readme.includes(`**${cuentas} cuentas listas para entrar**`), 'cuentas'); assert.ok(readme.includes(`**${matriculas} matrículas por registrar**`), 'matrículas'); assert.ok(readme.includes(`**${horarios} horarios libres**`), 'horarios');
  for (const d of db.prepare("SELECT u.matricula, COUNT(*) n FROM horarios h JOIN docentes d ON d.id=h.docente_id JOIN users u ON u.id=d.user_id GROUP BY u.matricula").all()) assert.ok(new RegExp(`${d.n} de \`${d.matricula}\``).test(readme), `${d.n} horarios de ${d.matricula}`);
});

test('el README nombra las cuentas, matrículas y contraseñas reales del seed', () => {
  for (const u of db.prepare('SELECT matricula, nombre, rol FROM users').all()) { assert.ok(readme.includes('`' + u.matricula + '`'), u.matricula); if (u.rol === 'docente') assert.ok(readme.includes(u.nombre), u.nombre); }
  for (const p of db.prepare('SELECT matricula FROM padron').all()) assert.ok(readme.includes('`' + p.matricula + '`'), p.matricula);
  const bcrypt = require('bcryptjs'), hash = m => db.prepare('SELECT pass_hash h FROM users WHERE matricula=?').get(m).h;
  assert.ok(readme.includes('`Secretaria2026`') && bcrypt.compareSync('Secretaria2026', hash('SEC001'))); assert.ok(readme.includes('`Docente2026`') && bcrypt.compareSync('Docente2026', hash('DOC001')));
});

test('el inicio rápido usa npm run demo (npm start arranca vacío) y el README lo explica', () => {
  assert.match(readme, /npm run demo/); assert.match(readme, /`npm start` a secas arranca con la base \*\*vacía\*\*/);
});

test('cargar la demostración dos veces no duplica nada (el README dice que con usuarios no cambia nada)', () => {
  const antes = [n('SELECT COUNT(*) n FROM users'), n('SELECT COUNT(*) n FROM padron'), n('SELECT COUNT(*) n FROM horarios')];
  require('../seed')(db); assert.deepEqual([n('SELECT COUNT(*) n FROM users'), n('SELECT COUNT(*) n FROM padron'), n('SELECT COUNT(*) n FROM horarios')], antes);
  assert.match(readme, /no tiene usuarios/);
});
