// SAE - Sistema de Asesorías Estudiantil · UAN, Unidad Académica de Economía
const express = require('express'), bcrypt = require('bcryptjs'), crypto = require('crypto');
const nodemailer = require('nodemailer'), QRCode = require('qrcode'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const PORT = process.env.PORT || 3000, BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
// Secreto con el que se firman las sesiones. Cualquiera que lo conozca puede fabricar una sesión de cualquier usuario (incluida la secretaría),
// así que NO hay valor por defecto: sin un secreto propio se usa uno aleatorio temporal (las sesiones se cierran al reiniciar) y en producción el servidor no arranca.
const SECRETO_DE_EJEMPLO = /pon-aqui|cambia-este/i;                                           // valores de ejemplo publicados en el repositorio y en .env.example
const secretoUsable = v => typeof v === 'string' && v.trim() !== '' && !SECRETO_DE_EJEMPLO.test(v);
const secretoFuerte = v => secretoUsable(v) && v.length >= 32;
const SECRET = secretoUsable(process.env.SESSION_SECRET) ? process.env.SESSION_SECRET : crypto.randomBytes(32).toString('hex');
const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, 'data', 'sae.db'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS padron(matricula TEXT PRIMARY KEY, nombre TEXT NOT NULL, email TEXT);   -- email (opcional): correo institucional de esa matrícula
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, matricula TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
  email TEXT NOT NULL, rol TEXT NOT NULL CHECK(rol IN('estudiante','docente','secretaria')), pass_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docentes(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id),
  materias TEXT NOT NULL, cubiculo TEXT, foto TEXT);
CREATE TABLE IF NOT EXISTS horarios(id INTEGER PRIMARY KEY, docente_id INTEGER NOT NULL REFERENCES docentes(id),
  fecha TEXT NOT NULL, hora TEXT NOT NULL, libre INTEGER NOT NULL DEFAULT 1, UNIQUE(docente_id,fecha,hora));
CREATE TABLE IF NOT EXISTS asesorias(id INTEGER PRIMARY KEY, estudiante_id INTEGER NOT NULL REFERENCES users(id),
  docente_id INTEGER NOT NULL REFERENCES docentes(id), horario_id INTEGER NOT NULL REFERENCES horarios(id),
  materia TEXT NOT NULL, duda TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente', creada TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notificaciones(id INTEGER PRIMARY KEY, asesoria_id INTEGER, destinatario TEXT, asunto TEXT,
  cuerpo TEXT, enviado INTEGER DEFAULT 0, fecha TEXT DEFAULT CURRENT_TIMESTAMP);
-- Códigos de un solo uso enviados por correo (verificar el registro, recuperar la contraseña). Solo se guarda su huella, nunca el código.
CREATE TABLE IF NOT EXISTS codigos(tipo TEXT NOT NULL, matricula TEXT NOT NULL, correo TEXT NOT NULL, pass_hash TEXT, codigo_hash TEXT NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0, expira INTEGER NOT NULL, creado INTEGER NOT NULL, envios INTEGER NOT NULL DEFAULT 1, ventana INTEGER NOT NULL,
  PRIMARY KEY(tipo, matricula));`);
if (!db.prepare('PRAGMA table_info(padron)').all().some(c => c.name === 'email')) db.exec('ALTER TABLE padron ADD COLUMN email TEXT');   // bases creadas antes de existir esa columna
// Horarios recurrentes: una "serie" es la regla semanal con la que el docente generó varios horarios (días, horas, duración y fechas).
db.exec(`CREATE TABLE IF NOT EXISTS series(id INTEGER PRIMARY KEY, docente_id INTEGER NOT NULL REFERENCES docentes(id), dias TEXT NOT NULL, inicio TEXT NOT NULL, fin TEXT NOT NULL,
  duracion INTEGER NOT NULL, desde TEXT NOT NULL, hasta TEXT NOT NULL, creada TEXT DEFAULT CURRENT_TIMESTAMP);`);
if (!db.prepare('PRAGMA table_info(horarios)').all().some(c => c.name === 'serie_id')) db.exec('ALTER TABLE horarios ADD COLUMN serie_id INTEGER');
// asesorias.recordatorio = 1 cuando ya se envió el recordatorio (o no hace falta enviarlo): así no se repite aunque el servidor se reinicie.
if (!db.prepare('PRAGMA table_info(asesorias)').all().some(c => c.name === 'recordatorio')) db.exec('ALTER TABLE asesorias ADD COLUMN recordatorio INTEGER NOT NULL DEFAULT 0');
// Las fechas y horas de los horarios son hora local de la Unidad Académica (no UTC): "ahora" se calcula en esa zona (ZONA_HORARIA, por defecto Nayarit/Pacífico).
const ZONA_DEFECTO = 'America/Mazatlan';
function ahoraLocal() {
  const parte = {};
  const fmt = z => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let f; try { f = fmt(process.env.ZONA_HORARIA || ZONA_DEFECTO); } catch { f = fmt(ZONA_DEFECTO); }   // zona inválida: se usa la de por defecto
  for (const x of f.formatToParts(new Date(Date.now()))) parte[x.type] = x.value;
  return { fecha: `${parte.year}-${parte.month}-${parte.day}`, hora: `${parte.hour}:${parte.minute}` };
}
const yaPaso = (fecha, hora) => { const n = ahoraLocal(); return `${fecha} ${hora}` <= `${n.fecha} ${n.hora}`; };   // vigente solo si empieza después de ahora
const futuro = al => `(${al}.fecha > ? OR (${al}.fecha = ? AND ${al}.hora > ?))`;       // condición SQL "empieza después de ahora" ...
const paramsFuturo = () => { const n = ahoraLocal(); return [n.fecha, n.fecha, n.hora]; };  // ... y sus 3 parámetros
const q = (s, ...p) => db.prepare(s).all(...p), one = (s, ...p) => db.prepare(s).get(...p), run = (s, ...p) => db.prepare(s).run(...p);

// ---- Correo: SMTP real si hay variables; si no, queda registrado en la bitácora (enviado=0) ----
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
async function notificar(asesoriaId, destinatarios, asunto, cuerpo) {   // devuelve cuántos envíos FALLARON (sin SMTP no es un fallo: solo queda en la bitácora)
  let fallos = 0;
  for (const to of destinatarios) {
    let ok = 0;
    try { if (mailer) { await mailer.sendMail({ from: process.env.SMTP_FROM || 'SAE <no-reply@uan.edu.mx>', to, subject: asunto, text: cuerpo }); ok = 1; } }
    catch (e) { fallos++; console.error('Correo falló:', e.message); }
    run('INSERT INTO notificaciones(asesoria_id,destinatario,asunto,cuerpo,enviado) VALUES(?,?,?,?,?)', asesoriaId, to, asunto, cuerpo, ok);
  }
  return fallos;
}
const detalle = id => one(`SELECT a.*, h.fecha, h.hora, e.nombre est_nombre, e.email est_email, u.nombre doc_nombre, u.email doc_email
  FROM asesorias a JOIN horarios h ON h.id=a.horario_id JOIN users e ON e.id=a.estudiante_id
  JOIN docentes d ON d.id=a.docente_id JOIN users u ON u.id=d.user_id WHERE a.id=?`, id);
const secretarias = () => q("SELECT email FROM users WHERE rol='secretaria'").map(r => r.email);

// ---- Códigos por correo: 6 dígitos, un solo uso, caducan a los 15 min ----
// Defensas: máx. 5 intentos por código, 60 s entre envíos y 5 envíos por hora y matrícula (para que nadie pueda llenar el buzón de otra persona).
const CODIGO_VIDA = 15 * 60e3, ESPERA_REENVIO = 60e3, VENTANA_ENVIOS = 3600e3, MAX_ENVIOS = 5, MAX_INTENTOS_CODIGO = 5;
const huella = (tipo, matricula, codigo) => crypto.createHmac('sha256', SECRET).update(`${tipo}|${matricula}|${codigo}`).digest('hex');
const iguales = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const enmascarar = c => `${c[0]}***${c.slice(c.lastIndexOf('@'))}`;
// Dominios de correo aceptados cuando el padrón no trae el correo de la matrícula (DOMINIOS_CORREO="uan.edu.mx,otro.mx"; "*" acepta cualquiera, no recomendado).
const dominiosCorreo = () => (process.env.DOMINIOS_CORREO || 'uan.edu.mx').split(',').map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const dominioPermitido = c => { const l = dominiosCorreo(); if (l.includes('*')) return true; const d = c.slice(c.lastIndexOf('@') + 1); return l.some(x => d === x || d.endsWith('.' + x)); };
// Crea (o reemplaza) el código de ese tipo y matrícula respetando las esperas y topes. Devuelve { codigo } o { status, error }.
function emitirCodigo(tipo, matricula, correo, passHash) {
  const ahora = Date.now(); run('DELETE FROM codigos WHERE expira < ? AND ventana < ?', ahora, ahora - VENTANA_ENVIOS);
  const ant = one('SELECT * FROM codigos WHERE tipo=? AND matricula=?', tipo, matricula); let envios = 1, ventana = ahora;
  if (ant) {
    if (ahora - ant.creado < ESPERA_REENVIO) return { status: 429, error: 'Ya te enviamos un código hace un momento. Espera un minuto para pedir otro.' };
    if (ahora - ant.ventana < VENTANA_ENVIOS) { if (ant.envios >= MAX_ENVIOS) return { status: 429, error: 'Pediste demasiados códigos. Intenta de nuevo en una hora.' }; envios = ant.envios + 1; ventana = ant.ventana; }
  }
  const codigo = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  run('INSERT OR REPLACE INTO codigos(tipo,matricula,correo,pass_hash,codigo_hash,intentos,expira,creado,envios,ventana) VALUES(?,?,?,?,?,0,?,?,?,?)',
    tipo, matricula, correo, passHash ?? null, huella(tipo, matricula, codigo), ahora + CODIGO_VIDA, ahora, envios, ventana);
  return { codigo };
}
// Envía el correo con el código. En la bitácora queda que se envió, pero NO el código (la secretaría puede leer la bitácora).
async function enviarCodigo(to, asunto, cuerpo) {
  let ok = 0;
  if (mailer) { try { await mailer.sendMail({ from: process.env.SMTP_FROM || 'SAE <no-reply@uan.edu.mx>', to, subject: asunto, text: cuerpo }); ok = 1; } catch (e) { console.error('Correo falló:', e.message); } }
  else if (process.env.NODE_ENV !== 'production') { console.log(`[sin SMTP] Correo para ${to} · ${asunto}\n${cuerpo}`); ok = 1; }   // desarrollo: el código se ve en la consola
  run('INSERT INTO notificaciones(asesoria_id,destinatario,asunto,cuerpo,enviado) VALUES(NULL,?,?,?,?)', to, asunto, '(contiene un código de un solo uso: no se guarda)', ok);
  return !!ok;
}
const sinCorreo = () => !mailer && process.env.NODE_ENV === 'production' ? 'El correo del sistema no está configurado, así que no se puede enviar el código. Avisa a la secretaría.' : null;
// Comprueba el código recibido (cuenta intentos, caduca). Devuelve el registro del código si es correcto, o { status, error }.
function comprobarCodigo(tipo, matricula, codigo) {
  const c = one('SELECT * FROM codigos WHERE tipo=? AND matricula=?', tipo, matricula);
  if (!c || c.expira < Date.now()) return { status: 400, error: 'El código venció o no hay una solicitud pendiente. Pide uno nuevo.' };
  if (c.intentos >= MAX_INTENTOS_CODIGO) return { status: 429, error: 'Demasiados intentos con este código. Pide uno nuevo.' };
  const cod = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cod) || !iguales(c.codigo_hash, huella(tipo, matricula, cod))) {
    run('UPDATE codigos SET intentos=intentos+1 WHERE tipo=? AND matricula=?', tipo, matricula); return { status: 400, error: 'Código incorrecto.' };
  }
  return c;
}

// ---- Sesión: cookie firmada (HMAC) httpOnly ----
const sign = d => { const p = Buffer.from(JSON.stringify(d)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); };
const verify = t => { try { const [p, s] = t.split('.'); const ok = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
  const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d : null; } catch { return null; } };
const app = express();
// Detrás de Nginx/proxy, req.ip sería la del proxy. Actívalo solo si hay proxy de confianza (ej. TRUST_PROXY=1); si no, X-Forwarded-For se podría falsificar.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? +process.env.TRUST_PROXY : process.env.TRUST_PROXY);
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  const m = /sae=([^;]+)/.exec(req.headers.cookie || ''); const s = m && verify(m[1]); const u = s ? one('SELECT id,matricula,nombre,email,rol,pass_hash FROM users WHERE id=?', s.uid) : null;
  if (u) { const { pass_hash, ...publico } = u; req.user = s.v === versionPass(pass_hash) ? publico : null; } else req.user = null; next(); });
const auth = (...roles) => (req, res, next) => !req.user ? res.status(401).json({ error: 'Inicia sesión.' }) :
  roles.length && !roles.includes(req.user.rol) ? res.status(403).json({ error: 'No tienes permiso para esta acción.' }) : next();
// La sesión lleva una "versión" derivada de la contraseña vigente: al cambiar la contraseña (recuperación) todas las sesiones abiertas dejan de valer.
const versionPass = h => crypto.createHash('sha256').update(h).digest('base64url').slice(0, 16);
const abrir = (res, u) => res.cookie('sae', sign({ uid: u.id, exp: Date.now() + 8 * 3600e3, v: versionPass(one('SELECT pass_hash FROM users WHERE id=?', u.id).pass_hash) }), { httpOnly: true, sameSite: 'lax', secure: BASE.startsWith('https'), maxAge: 8 * 3600e3 });
// Freno a fuerza bruta: solo cuentan los intentos FALLIDOS (login o registro con respuesta de error), por matrícula + IP.
// Así una persona que se equivoca no bloquea a las demás aunque compartan IP (red de la facultad, NAT) y los accesos correctos no gastan el cupo.
const VENTANA = 600e3, MAX_POR_CUENTA = 8, MAX_POR_IP = 100; // 8 fallos / 10 min por matrícula+IP; tope amplio por IP contra probar muchas matrículas
const fallos = new Map(); // clave -> marcas de tiempo de los fallos recientes
const recientes = k => { const n = (fallos.get(k) || []).filter(t => Date.now() - t < VENTANA); n.length ? fallos.set(k, n) : fallos.delete(k); return n; };
const limiteCon = ambito => (req, res, next) => {   // `ambito` separa los cupos: la recuperación de contraseña lleva los suyos
  const ip = ambito + (req.ip || ''), cuenta = `${ip}|${String(req.body?.matricula ?? '').trim().toUpperCase().slice(0, 40)}`;
  if (recientes(cuenta).length >= MAX_POR_CUENTA || recientes(ip).length >= MAX_POR_IP)
    return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });
  res.on('finish', () => {
    if (res.statusCode < 400) return fallos.delete(cuenta);                       // acceso correcto: se limpia el historial de esa cuenta
    for (const k of [cuenta, ip]) fallos.set(k, [...recientes(k), Date.now()]);   // fallo: cuenta contra la cuenta y contra la IP
    if (fallos.size > 5000) for (const k of fallos.keys()) recientes(k);          // limpieza de claves vencidas para no crecer sin límite
  });
  next();
};
// El registro NO crea la cuenta: guarda la solicitud y envía un código al correo institucional; la cuenta se crea al confirmarlo (/api/registro/confirmar).
// Así quien conozca la matrícula de otra persona no puede apropiarse de ella sin acceso a ese buzón. Si el padrón trae el correo de la matrícula, el código va a ESE correo.
const limite = limiteCon('');                 // login y registro
// Recuperación de contraseña, con cupos APARTE: quien olvidó su contraseña y falló varias veces al entrar no debe quedar bloqueado para recuperarla, y una
// respuesta 200 de aquí no debe borrar los fallos de login de esa cuenta (si no, pedir un código entre intentos esquivaría el límite).
const limiteRec = limiteCon('rec:');
app.post('/api/registro', limite, async (req, res) => {
  const { matricula, email, password } = req.body || {};
  if (!matricula || typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Completa matrícula, correo y una contraseña de 8+ caracteres.' });
  const p = one('SELECT * FROM padron WHERE matricula=?', String(matricula).trim());
  if (!p) return res.status(403).json({ error: 'Matrícula no válida: no aparece en el padrón de la Unidad Académica.' });
  if (one('SELECT 1 FROM users WHERE matricula=?', p.matricula)) return res.status(409).json({ error: 'Esa matrícula ya tiene cuenta.' });
  const correo = String(p.email || email || '').trim().toLowerCase();
  if (!p.email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo) || correo.length > 120) return res.status(400).json({ error: 'Escribe un correo electrónico válido.' });
    if (!dominioPermitido(correo)) return res.status(400).json({ error: `Usa tu correo institucional (@${dominiosCorreo().join(' o @')}).` });
  }
  const falta = sinCorreo(); if (falta) return res.status(503).json({ error: falta });
  const e = emitirCodigo('registro', p.matricula, correo, bcrypt.hashSync(password, 10)); if (e.error) return res.status(e.status).json({ error: e.error });
  const ok = await enviarCodigo(correo, 'SAE · Código para crear tu cuenta', `Tu código de verificación es: ${e.codigo}\n\nCaduca en 15 minutos. Si no solicitaste una cuenta en el Sistema de Asesorías Estudiantil, ignora este correo.`);
  if (!ok) { run('DELETE FROM codigos WHERE tipo=? AND matricula=?', 'registro', p.matricula); return res.status(502).json({ error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' }); }
  res.json({ ok: true, pendiente: true, correo: enmascarar(correo) });
});
app.post('/api/registro/confirmar', limite, (req, res) => {
  const matricula = String(req.body?.matricula ?? '').trim(), c = comprobarCodigo('registro', matricula, req.body?.codigo);
  if (c.error) return res.status(c.status).json({ error: c.error });
  const p = one('SELECT * FROM padron WHERE matricula=?', matricula);
  if (!p) return res.status(403).json({ error: 'Matrícula no válida: no aparece en el padrón de la Unidad Académica.' });
  let r; try { r = run("INSERT INTO users(matricula,nombre,email,rol,pass_hash) VALUES(?,?,?,'estudiante',?)", p.matricula, p.nombre, c.correo, c.pass_hash); }
  catch { return res.status(409).json({ error: 'Esa matrícula ya tiene cuenta.' }); }
  run('DELETE FROM codigos WHERE tipo=? AND matricula=?', 'registro', matricula);
  abrir(res, { id: Number(r.lastInsertRowid) }); res.json({ ok: true });
});
// ---- Recuperar la contraseña: código al correo de la cuenta → nueva contraseña. Sirve a estudiantes, docentes y secretaría. ----
const MIN_PASS = { estudiante: 8, docente: 10, secretaria: 10 }, PASS_DEMO = ['Secretaria2026', 'Docente2026'];   // igual que al crear las cuentas; las de demostración nunca
const passwordInvalida = (rol, pw) => pw.length < (MIN_PASS[rol] || 10) ? `La contraseña debe tener al menos ${MIN_PASS[rol] || 10} caracteres.`
  : rol !== 'estudiante' && PASS_DEMO.includes(pw) ? 'Esa contraseña es la de demostración; elige otra.' : null;
app.post('/api/recuperar', limiteRec, (req, res) => {
  const falta = sinCorreo(); if (falta) return res.status(503).json({ error: falta });
  const matricula = String(req.body?.matricula ?? '').trim(), u = matricula ? one('SELECT matricula,email FROM users WHERE matricula=?', matricula) : null;
  const e = u ? emitirCodigo('recuperar', u.matricula, u.email) : null;
  // Misma respuesta (y sin esperar al correo) exista o no la cuenta, y también si es muy pronto para otro código: no se revela quién tiene cuenta.
  res.json({ ok: true, mensaje: 'Si esa matrícula tiene una cuenta, enviamos un código a su correo. Revisa también la carpeta de spam.' });
  if (e?.codigo) enviarCodigo(u.email, 'SAE · Código para restablecer tu contraseña', `Tu código para restablecer la contraseña es: ${e.codigo}\n\nCaduca en 15 minutos. Si no lo solicitaste, ignora este correo: tu contraseña no cambia.`)
    .then(ok => { if (!ok) run('DELETE FROM codigos WHERE tipo=? AND matricula=?', 'recuperar', u.matricula); }).catch(() => {});
});
app.post('/api/recuperar/confirmar', limiteRec, async (req, res) => {
  const matricula = String(req.body?.matricula ?? '').trim(), password = req.body?.password;
  const c = comprobarCodigo('recuperar', matricula, req.body?.codigo); if (c.error) return res.status(c.status).json({ error: c.error });
  const u = one('SELECT id,rol,email FROM users WHERE matricula=?', matricula); if (!u) return res.status(400).json({ error: 'El código venció o no hay una solicitud pendiente. Pide uno nuevo.' });
  // La contraseña se revisa DESPUÉS del código, y si no cumple el código no se gasta: se puede corregir y reintentar.
  const err = typeof password !== 'string' ? 'Escribe la nueva contraseña.' : passwordInvalida(u.rol, password); if (err) return res.status(400).json({ error: err });
  run('UPDATE users SET pass_hash=? WHERE id=?', bcrypt.hashSync(password, 10), u.id);
  run('DELETE FROM codigos WHERE tipo=? AND matricula=?', 'recuperar', matricula);
  res.json({ ok: true });
  notificar(null, [u.email], 'SAE · Tu contraseña cambió', 'La contraseña de tu cuenta del Sistema de Asesorías Estudiantil se restableció y se cerraron las sesiones abiertas. Si no fuiste tú, contacta a la secretaría de inmediato.').catch(() => {});
});
app.post('/api/login', limite, (req, res) => {
  const { matricula, password } = req.body || {}; const u = one('SELECT * FROM users WHERE matricula=?', String(matricula || '').trim());
  if (!u || !bcrypt.compareSync(String(password || ''), u.pass_hash)) return res.status(401).json({ error: 'Matrícula o contraseña incorrecta.' });
  abrir(res, u); res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie('sae'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: req.user }));

app.get('/api/docentes', auth(), (req, res) => {
  const t = `%${(req.query.q || '').trim()}%`;
  res.json(q(`SELECT d.id, u.nombre, d.materias, d.cubiculo, d.foto,
    (SELECT COUNT(*) FROM horarios h WHERE h.docente_id=d.id AND h.libre=1 AND ${futuro('h')}) libres
    FROM docentes d JOIN users u ON u.id=d.user_id WHERE u.nombre LIKE ? OR d.materias LIKE ? ORDER BY u.nombre`, ...paramsFuturo(), t, t));
});
// Una ficha de docente (la usa el enlace directo del QR de cada docente: #docente/<id>).
app.get('/api/docentes/:id', auth(), (req, res) => {
  const d = /^\d{1,9}$/.test(req.params.id) && one(`SELECT d.id, u.nombre, d.materias, d.cubiculo, d.foto,
    (SELECT COUNT(*) FROM horarios h WHERE h.docente_id=d.id AND h.libre=1 AND ${futuro('h')}) libres FROM docentes d JOIN users u ON u.id=d.user_id WHERE d.id=?`, ...paramsFuturo(), req.params.id);
  d ? res.json(d) : res.status(404).json({ error: 'Ese docente no está en el sistema.' });
});
app.get('/api/docentes/:id/horarios', auth(), (req, res) =>
  res.json(q(`SELECT h.id,h.fecha,h.hora FROM horarios h WHERE h.docente_id=? AND h.libre=1 AND ${futuro('h')} ORDER BY h.fecha,h.hora`, req.params.id, ...paramsFuturo())));

// Tope de asesorías ACTIVAS por estudiante (pendientes o confirmadas cuyo horario aún no llega): evita que una cuenta acapare los horarios de un docente.
// Se puede ajustar con MAX_ASESORIAS_ACTIVAS; un valor inválido vuelve a 2. Las canceladas, las realizadas y las que ya pasaron no cuentan.
const maxActivas = () => { const n = parseInt(process.env.MAX_ASESORIAS_ACTIVAS, 10); return n >= 1 ? n : 2; };
const activas = estudianteId => one(`SELECT COUNT(*) n FROM asesorias a JOIN horarios h ON h.id=a.horario_id
  WHERE a.estudiante_id=? AND a.estado IN ('pendiente','confirmada') AND ${futuro('h')}`, estudianteId, ...paramsFuturo()).n;
app.post('/api/asesorias', auth('estudiante'), async (req, res) => {
  const { horario_id, materia, duda } = req.body || {};
  if (!horario_id || !materia?.trim() || !duda?.trim()) return res.status(400).json({ error: 'Indica horario, materia y tu duda.' });
  const h = one('SELECT * FROM horarios WHERE id=?', horario_id);
  if (!h) return res.status(404).json({ error: 'Horario inexistente.' });
  if (yaPaso(h.fecha, h.hora)) return res.status(400).json({ error: 'Ese horario ya pasó. Elige otro.' });   // antes de reservarlo: no consume el horario
  // Revisión del tope + reserva ocurren en el mismo turno síncrono (sin await entre medias), así que dos solicitudes simultáneas no lo rebasan.
  const max = maxActivas();
  if (activas(req.user.id) >= max) return res.status(409).json({ error: `Ya tienes ${max} ${max === 1 ? 'asesoría activa' : 'asesorías activas'}. Cancela una o espera a que se realice para pedir otra.` });
  // Validación de disponibilidad atómica: solo se reserva si sigue libre
  const r = run('UPDATE horarios SET libre=0 WHERE id=? AND libre=1', horario_id);
  if (!r.changes) return res.status(409).json({ error: 'Ese horario ya fue ocupado. Elige otro.' });
  const a = run('INSERT INTO asesorias(estudiante_id,docente_id,horario_id,materia,duda) VALUES(?,?,?,?,?)', req.user.id, h.docente_id, h.id, materia.trim().slice(0, 120), duda.trim().slice(0, 1000));
  const d = detalle(Number(a.lastInsertRowid));
  const txt = `Asesoría #${d.id} de ${d.materia}\nFecha: ${d.fecha} ${d.hora}\nEstudiante: ${d.est_nombre}\nDocente: ${d.doc_nombre}\nDuda: ${d.duda}\nEstado: pendiente de confirmación del docente.`;
  await notificar(d.id, [d.est_email, d.doc_email, ...secretarias()], `SAE · Solicitud de asesoría #${d.id}`, txt);
  res.json({ ok: true, id: d.id });
});
app.get('/api/asesorias', auth(), (req, res) => {
  const u = req.user, f = u.rol === 'estudiante' ? ['a.estudiante_id=?', u.id] : u.rol === 'docente' ? ['a.docente_id=(SELECT id FROM docentes WHERE user_id=?)', u.id] : ['1=?', 1];
  res.json(q(`SELECT a.id,a.materia,a.duda,a.estado,h.fecha,h.hora,e.nombre estudiante,du.nombre docente FROM asesorias a
    JOIN horarios h ON h.id=a.horario_id JOIN users e ON e.id=a.estudiante_id JOIN docentes d ON d.id=a.docente_id
    JOIN users du ON du.id=d.user_id WHERE ${f[0]} ORDER BY h.fecha DESC,h.hora DESC`, f[1]).map(a => ({ ...a, empezo: yaPaso(a.fecha, a.hora) })));   // empezo: ya llegó la hora (el docente ya puede cerrarla)
});
// Ciclo de vida de una asesoría: pendiente → confirmada → realizada (o inasistencia, si el estudiante no llegó; solo después de que empieza), y cancelable mientras esté
// pendiente o confirmada. Cancelada, realizada e inasistencia son DEFINITIVAS.
// Una asesoría activa (pendiente/confirmada) es la única dueña de su horario; por eso solo al cancelar una activa se libera. Si se pudiera cancelar dos veces
// (o reabrir una cancelada) se liberaría un horario que otra persona ya reservó, y dos estudiantes quedarían con el mismo.
const TRANSICIONES = { confirmada: ['pendiente'], realizada: ['confirmada'], inasistencia: ['confirmada'], cancelada: ['pendiente', 'confirmada'] };   // estado nuevo -> estados desde los que se permite
app.patch('/api/asesorias/:id', auth('estudiante', 'docente'), async (req, res) => {
  const d = detalle(req.params.id), est = req.body?.estado;
  const permitido = req.user.rol === 'docente' ? ['confirmada', 'realizada', 'inasistencia', 'cancelada'] : ['cancelada'];
  if (!d || !permitido.includes(est)) return res.status(400).json({ error: 'Cambio de estado no permitido.' });
  const mia = req.user.rol === 'estudiante' ? d.estudiante_id === req.user.id : !!one('SELECT 1 FROM docentes WHERE id=? AND user_id=?', d.docente_id, req.user.id);
  if (!mia) return res.status(403).json({ error: 'Esta asesoría no es tuya.' });
  // Revisión + cambio + liberación en el mismo turno síncrono (sin await entre medias): dos solicitudes simultáneas no pueden pasar ambas.
  if (!TRANSICIONES[est].includes(d.estado)) return res.status(409).json({ error: d.estado === est ? `Esa asesoría ya estaba ${est}.` : `Una asesoría ${d.estado} ya no puede quedar ${est}.` });
  if (est === 'inasistencia' && !yaPaso(d.fecha, d.hora)) return res.status(409).json({ error: 'Todavía no llega la hora de esa asesoría: la inasistencia solo se registra después de que empieza.' });
  if (!run('UPDATE asesorias SET estado=? WHERE id=? AND estado=?', est, d.id, d.estado).changes) return res.status(409).json({ error: 'La asesoría cambió mientras tanto. Recarga la lista.' });
  if (est === 'cancelada') run('UPDATE horarios SET libre=1 WHERE id=?', d.horario_id); // libera el horario
  const horas = horasRecordatorio();   // si se confirma cuando ya falta menos que el aviso, el correo de confirmación hace de recordatorio: no se manda otro
  if (est === 'confirmada' && horas && minutosHasta(d.fecha, d.hora) <= horas * 60) run('UPDATE asesorias SET recordatorio=1 WHERE id=?', d.id);
  const etiqueta = est === 'inasistencia' ? 'con inasistencia' : est;
  await notificar(d.id, [d.est_email, d.doc_email, ...secretarias()], `SAE · Asesoría #${d.id} ${etiqueta}`, `La asesoría de ${d.materia} (${d.fecha} ${d.hora}) quedó ${etiqueta}${est === 'inasistencia' ? ': el estudiante no asistió' : ''}.`);
  res.json({ ok: true });
});
// ---- Disponibilidad del docente: horarios sueltos y series semanales ----
// Cada horario es un bloque que EMPIEZA a esa hora (fecha y hora locales). Un horario retirado que tuvo asesorías (canceladas) no se borra para conservar el historial:
// queda con libre=0 y sin asesoría viva, y no aparece en ninguna lista; si se vuelve a agregar, se reactiva.
const pad = n => String(n).padStart(2, '0'), aMin = h => +h.slice(0, 2) * 60 + +h.slice(3), deMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const horaValida = h => typeof h === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
const fechaValida = f => { if (typeof f !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false; const [a, m, d] = f.split('-').map(Number), t = new Date(Date.UTC(a, m - 1, d)); return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const sumarDias = (f, n) => new Date(Date.parse(f + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const diaSemana = f => new Date(f + 'T00:00:00Z').getUTCDay() || 7;                  // 1 = lunes … 7 = domingo
const MAX_DIAS_SERIE = 120, MAX_HORARIOS_SERIE = 1000, DURACIONES = [15, 20, 30, 40, 45, 60, 90, 120];
const docenteDe = u => one('SELECT id FROM docentes WHERE user_id=?', u.id);
const viva = horarioId => !!one("SELECT 1 FROM asesorias WHERE horario_id=? AND estado IN ('pendiente','confirmada','realizada','inasistencia')", horarioId);
// Agrega un horario (o reactiva uno retirado). Devuelve 'creado' | 'reactivado' | 'existe' (ya estaba libre) | 'ocupado' (tiene una asesoría viva).
function ponerHorario(docenteId, fecha, hora, serieId = null) {
  const h = one('SELECT id,libre FROM horarios WHERE docente_id=? AND fecha=? AND hora=?', docenteId, fecha, hora);
  if (!h) { run('INSERT INTO horarios(docente_id,fecha,hora,serie_id) VALUES(?,?,?,?)', docenteId, fecha, hora, serieId); return 'creado'; }
  if (h.libre) return 'existe'; if (viva(h.id)) return 'ocupado';
  run('UPDATE horarios SET libre=1, serie_id=? WHERE id=?', serieId, h.id); return 'reactivado';
}
// Retira un horario SIN asesoría viva: se borra, o si tuvo asesorías (canceladas) se deja fuera de uso para no perder el historial.
function retirarHorario(id) { if (one('SELECT 1 FROM asesorias WHERE horario_id=?', id)) run('UPDATE horarios SET libre=0, serie_id=NULL WHERE id=?', id); else run('DELETE FROM horarios WHERE id=?', id); }
app.post('/api/horarios', auth('docente'), (req, res) => {
  const { fecha, hora } = req.body || {}; const d = docenteDe(req.user);
  if (!fechaValida(fecha) || !horaValida(hora)) return res.status(400).json({ error: 'Fecha u hora inválida.' });
  if (yaPaso(fecha, hora)) return res.status(400).json({ error: 'Esa fecha y hora ya pasaron.' });
  const r = ponerHorario(d.id, fecha, hora);
  if (r === 'existe') return res.status(409).json({ error: 'Ya registraste ese horario.' });
  if (r === 'ocupado') return res.status(409).json({ error: 'Ese horario ya tiene una asesoría.' });
  res.json({ ok: true });
});
// Mis horarios próximos (libres y reservados; los retirados no salen).
app.get('/api/mis-horarios', auth('docente'), (req, res) => res.json(q(`SELECT * FROM (SELECT h.id,h.fecha,h.hora,h.libre,h.serie_id,
    (SELECT a.estado FROM asesorias a WHERE a.horario_id=h.id AND a.estado IN ('pendiente','confirmada','realizada','inasistencia') LIMIT 1) estado
  FROM horarios h WHERE h.docente_id=? AND ${futuro('h')}) WHERE libre=1 OR estado IS NOT NULL ORDER BY fecha,hora LIMIT 500`, docenteDe(req.user).id, ...paramsFuturo())));
app.delete('/api/horarios/:id', auth('docente'), (req, res) => {
  const h = one('SELECT id FROM horarios WHERE id=? AND docente_id=?', req.params.id, docenteDe(req.user).id);
  if (!h) return res.status(404).json({ error: 'No encontré ese horario.' });
  if (viva(h.id)) return res.status(409).json({ error: 'Ese horario ya tiene una asesoría: cancélala primero.' });
  retirarHorario(h.id); res.json({ ok: true });
});
// Crea los horarios de una regla semanal: días (1 = lunes … 7 = domingo), de `inicio` a `fin` en bloques de `duracion` minutos, entre `desde` y `hasta`.
app.post('/api/series', auth('docente'), (req, res) => {
  const { dias, inicio, fin, duracion, desde, hasta } = req.body || {}, d = docenteDe(req.user), mal = m => res.status(400).json({ error: m });
  if (!Array.isArray(dias) || !dias.length || dias.length > 7 || new Set(dias).size !== dias.length || !dias.every(x => Number.isInteger(x) && x >= 1 && x <= 7)) return mal('Elige al menos un día de la semana.');
  if (!horaValida(inicio) || !horaValida(fin) || aMin(inicio) >= aMin(fin)) return mal('Revisa las horas: la de inicio debe ser anterior a la de fin.');
  if (!DURACIONES.includes(duracion)) return mal('La duración de cada asesoría debe ser de ' + DURACIONES.join(', ') + ' minutos.');
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return mal('Revisa las fechas: la inicial debe ser anterior o igual a la final.');
  if (hasta < ahoraLocal().fecha) return mal('La fecha final ya pasó.');
  if ((Date.parse(hasta) - Date.parse(desde)) / 864e5 + 1 > MAX_DIAS_SERIE) return mal(`El periodo no puede pasar de ${MAX_DIAS_SERIE} días; crea otra serie para continuar.`);
  const horas = []; for (let m = aMin(inicio); m + duracion <= aMin(fin); m += duracion) horas.push(deMin(m));
  if (!horas.length) return mal('Entre esas horas no cabe ni una asesoría de esa duración.');
  const fechas = []; for (let f = desde; f <= hasta; f = sumarDias(f, 1)) if (dias.includes(diaSemana(f))) fechas.push(f);
  if (!fechas.length) return mal('En ese periodo no hay ninguno de los días elegidos.');
  if (fechas.length * horas.length > MAX_HORARIOS_SERIE) return mal(`Serían ${fechas.length * horas.length} horarios; el máximo por serie es ${MAX_HORARIOS_SERIE}. Acorta el periodo o usa bloques más largos.`);
  const cuenta = { creados: 0, reactivados: 0, yaExistian: 0, ocupados: 0, pasados: 0 }; let serie;
  db.exec('BEGIN');
  try {
    serie = Number(run('INSERT INTO series(docente_id,dias,inicio,fin,duracion,desde,hasta) VALUES(?,?,?,?,?,?,?)', d.id, [...dias].sort().join(','), inicio, fin, duracion, desde, hasta).lastInsertRowid);
    for (const f of fechas) for (const h of horas) {
      if (yaPaso(f, h)) { cuenta.pasados++; continue; }
      const r = ponerHorario(d.id, f, h, serie); cuenta[{ creado: 'creados', reactivado: 'reactivados', existe: 'yaExistian', ocupado: 'ocupados' }[r]]++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, serie_id: serie, ...cuenta });
});
app.get('/api/series', auth('docente'), (req, res) => res.json(q(`SELECT s.id,s.dias,s.inicio,s.fin,s.duracion,s.desde,s.hasta,
    (SELECT COUNT(*) FROM horarios h WHERE h.serie_id=s.id AND ${futuro('h')} AND h.libre=1) libres,
    (SELECT COUNT(*) FROM horarios h WHERE h.serie_id=s.id AND ${futuro('h')} AND h.libre=0 AND EXISTS (SELECT 1 FROM asesorias a WHERE a.horario_id=h.id AND a.estado IN ('pendiente','confirmada','realizada','inasistencia'))) reservados
  FROM series s WHERE s.docente_id=? ORDER BY s.id DESC`, ...paramsFuturo(), ...paramsFuturo(), docenteDe(req.user).id).map(x => ({ ...x, dias: x.dias.split(',').map(Number) }))));
// Quitar una serie: se retiran sus horarios futuros que siguen libres; los que ya tienen asesoría se conservan como horarios sueltos.
app.delete('/api/series/:id', auth('docente'), (req, res) => {
  const d = docenteDe(req.user), s = one('SELECT id FROM series WHERE id=? AND docente_id=?', req.params.id, d.id);
  if (!s) return res.status(404).json({ error: 'No encontré esa serie.' });
  let quitados = 0, conservados = 0; db.exec('BEGIN');
  try {
    for (const h of q(`SELECT h.id FROM horarios h WHERE h.serie_id=? AND ${futuro('h')}`, s.id, ...paramsFuturo())) { if (viva(h.id)) conservados++; else { retirarHorario(h.id); quitados++; } }
    run('UPDATE horarios SET serie_id=NULL WHERE serie_id=?', s.id); run('DELETE FROM series WHERE id=?', s.id); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, quitados, conservados });
});
// ---- Recordatorios: un correo al estudiante y al docente unas horas antes de cada asesoría CONFIRMADA ----
// RECORDATORIO_HORAS = con cuántas horas de anticipación (24 por defecto; 0 lo apaga). Se revisa cada 5 minutos. La marca asesorias.recordatorio evita repetirlo aunque el
// servidor se reinicie, y se pone en 1 al confirmar cuando ya falta menos que el aviso (el correo de confirmación sirve de recordatorio). Si TODOS los envíos fallan
// (SMTP caído) la marca se quita y se reintenta en la siguiente revisión, mientras la asesoría no haya empezado.
const horasRecordatorio = () => { const v = process.env.RECORDATORIO_HORAS; if (v === undefined || v.trim() === '') return 24; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 168 ? n : 24; };
const aEpoch = (fecha, hora) => Date.parse(`${fecha}T${hora}:00Z`);                // fecha y hora LOCALES tratadas como una línea de tiempo continua (sin zona) para restarlas
const minutosHasta = (fecha, hora) => { const n = ahoraLocal(); return (aEpoch(fecha, hora) - aEpoch(n.fecha, n.hora)) / 60e3; };
async function revisarRecordatorios() {
  const horas = horasRecordatorio(); if (!horas) return 0;
  const n = ahoraLocal(), lim = new Date(aEpoch(n.fecha, n.hora) + horas * 3600e3).toISOString();
  const pendientes = q(`SELECT a.id FROM asesorias a JOIN horarios h ON h.id=a.horario_id WHERE a.estado='confirmada' AND a.recordatorio=0
    AND h.fecha||' '||h.hora > ? AND h.fecha||' '||h.hora <= ? ORDER BY h.fecha,h.hora`, `${n.fecha} ${n.hora}`, `${lim.slice(0, 10)} ${lim.slice(11, 16)}`);
  let enviados = 0;
  for (const { id } of pendientes) {
    if (!run("UPDATE asesorias SET recordatorio=1 WHERE id=? AND recordatorio=0 AND estado='confirmada'", id).changes) continue;
    const d = detalle(id), para = [...new Set([d.est_email, d.doc_email])], cub = one('SELECT cubiculo FROM docentes WHERE id=?', d.docente_id)?.cubiculo;
    const fallos = await notificar(id, para, 'SAE · Recordatorio de asesoría', `Recordatorio: el ${d.fecha} a las ${d.hora} tienes una asesoría de ${d.materia}.\nDocente: ${d.doc_nombre}${cub ? ` (${cub})` : ''}\nEstudiante: ${d.est_nombre}\n\nSi no vas a poder asistir, cancélala en el sistema (${BASE.replace(/\/+$/, '')}/#mis) para liberar el horario.`);
    if (fallos >= para.length) run('UPDATE asesorias SET recordatorio=0 WHERE id=?', id); else enviados++;
  }
  return enviados;
}
app.revisarRecordatorios = revisarRecordatorios;

// ---- Reporte de inasistencias: del docente (solo las suyas) o de toda la Unidad (secretaría) en un periodo, por la fecha de la asesoría ----
const MAX_DIAS_REPORTE = 400;
function periodoReporte(query) {
  const hoy = ahoraLocal().fecha, hasta = query.hasta || hoy, desde = query.desde || sumarDias(hasta, -29);
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return { error: 'Revisa las fechas: la inicial debe ser anterior o igual a la final.' };
  if ((Date.parse(hasta) - Date.parse(desde)) / 864e5 + 1 > MAX_DIAS_REPORTE) return { error: `El periodo no puede pasar de ${MAX_DIAS_REPORTE} días.` };
  return { desde, hasta };
}
const filasReporte = (user, desde, hasta) => q(`SELECT a.id, a.estado, a.materia, h.fecha, h.hora, a.docente_id, du.nombre docente, e.matricula, e.nombre estudiante
  FROM asesorias a JOIN horarios h ON h.id=a.horario_id JOIN users e ON e.id=a.estudiante_id JOIN docentes d ON d.id=a.docente_id JOIN users du ON du.id=d.user_id
  WHERE h.fecha BETWEEN ? AND ? ${user.rol === 'docente' ? 'AND d.user_id=?' : ''} ORDER BY h.fecha, h.hora`, desde, hasta, ...(user.rol === 'docente' ? [user.id] : []));
const porcentaje = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;          // 1 decimal; null si no hay con qué comparar
app.get('/api/reporte', auth('docente', 'secretaria'), (req, res) => {
  const p = periodoReporte(req.query); if (p.error) return res.status(400).json({ error: p.error });
  const n = ahoraLocal(), ahora = `${n.fecha} ${n.hora}`, cuenta = () => ({ total: 0, realizadas: 0, inasistencias: 0, canceladas: 0, sinCerrar: 0, proximas: 0 });
  const tot = cuenta(), docs = new Map(), ests = new Map();
  for (const f of filasReporte(req.user, p.desde, p.hasta)) {
    const k = f.estado === 'realizada' ? 'realizadas' : f.estado === 'inasistencia' ? 'inasistencias' : f.estado === 'cancelada' ? 'canceladas' : `${f.fecha} ${f.hora}` <= ahora ? 'sinCerrar' : 'proximas';
    const d = docs.get(f.docente_id) || { docente_id: f.docente_id, nombre: f.docente, ...cuenta() }; docs.set(f.docente_id, d);
    for (const c of [tot, d]) { c.total++; c[k]++; }
    if (k === 'realizadas' || k === 'inasistencias') { const e = ests.get(f.matricula) || { matricula: f.matricula, nombre: f.estudiante, inasistencias: 0, realizadas: 0, ultima: null }; ests.set(f.matricula, e);
      if (k === 'inasistencias') { e.inasistencias++; e.ultima = e.ultima && e.ultima > f.fecha ? e.ultima : f.fecha; } else e.realizadas++; }
  }
  const tasa = c => ({ ...c, tasaInasistencia: porcentaje(c.inasistencias, c.inasistencias + c.realizadas) });   // inasistencias entre las asesorías que ya se cerraron como realizada o inasistencia
  res.json({ desde: p.desde, hasta: p.hasta, alcance: req.user.rol === 'docente' ? 'propio' : 'todos', totales: tasa(tot),
    porDocente: [...docs.values()].map(tasa).sort((a, b) => b.inasistencias - a.inasistencias || a.nombre.localeCompare(b.nombre, 'es')),
    estudiantes: [...ests.values()].filter(e => e.inasistencias).sort((a, b) => b.inasistencias - a.inasistencias || a.nombre.localeCompare(b.nombre, 'es')) });
});
// CSV para Excel (UTF-8 con BOM). Las celdas que empiecen con = + - @ se neutralizan para que no se interpreten como fórmulas.
const celdaCsv = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
app.get('/api/reporte/inasistencias.csv', auth('docente', 'secretaria'), (req, res) => {
  const p = periodoReporte(req.query); if (p.error) return res.status(400).json({ error: p.error });
  const filas = filasReporte(req.user, p.desde, p.hasta).filter(f => f.estado === 'inasistencia');
  const csv = ['fecha,hora,docente,matricula,estudiante,materia', ...filas.map(f => [f.fecha, f.hora, f.docente, f.matricula, f.estudiante, f.materia].map(celdaCsv).join(','))].join('\r\n') + '\r\n';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="inasistencias_${p.desde}_${p.hasta}.csv"` }).send('﻿' + csv);
});
app.get('/api/notificaciones', auth('secretaria'), (req, res) => res.json(q('SELECT * FROM notificaciones ORDER BY id DESC LIMIT 100')));
app.get('/api/qr', async (req, res) => res.json({ url: BASE, png: await QRCode.toDataURL(BASE, { margin: 1, width: 320 }) }));
// QR por docente: lleva directo a su ficha con los horarios libres (#docente/<id>). Cada docente obtiene el suyo; la secretaría, el de todos (para imprimirlos).
// El enlace no da ningún acceso: solo apunta a algo que ya es visible para quien tiene sesión, y reservar sigue pidiéndola.
const urlDocente = id => `${BASE.replace(/\/+$/, '')}/#docente/${id}`;
app.get('/api/qr/docentes', auth('docente', 'secretaria'), async (req, res) => {
  const base = 'SELECT d.id, u.nombre, d.cubiculo FROM docentes d JOIN users u ON u.id=d.user_id', ds = req.user.rol === 'secretaria' ? q(base + ' ORDER BY u.nombre') : q(base + ' WHERE d.user_id=?', req.user.id);
  res.json(await Promise.all(ds.map(async d => ({ ...d, url: urlDocente(d.id), png: await QRCode.toDataURL(urlDocente(d.id), { margin: 2, width: 600 }) }))));
});
app.use(express.static(path.join(__dirname, 'public')));
if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && !secretoFuerte(process.env.SESSION_SECRET)) {
    console.error('Error: en producción SESSION_SECRET debe ser una cadena propia, larga y aleatoria (mínimo 32 caracteres; no sirve el valor de ejemplo).\n  Genera una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  } else if (!secretoUsable(process.env.SESSION_SECRET)) console.log('Aviso: SESSION_SECRET no está definido (o es el de ejemplo): se usa un secreto temporal y las sesiones se cierran al reiniciar.');
  if (process.env.NODE_ENV === 'production' && /^https?:\/\/(localhost|127\.)/.test(BASE)) console.error('Aviso: BASE_URL no está configurada (vale ' + BASE + '). Los códigos QR y los enlaces apuntarían a tu propia computadora; define BASE_URL con la dirección pública (https://...).');
  if (process.env.NODE_ENV === 'production' && !mailer) console.error('Aviso: no hay SMTP configurado (SMTP_HOST). Sin correo nadie podrá registrarse: el código de verificación se envía por correo.');
  // Los datos de demostración (seed.js) traen usuarios con contraseñas conocidas: SOLO se cargan si se piden (npm run demo / SEED_DEMO=1) y nunca en producción.
  const demo = process.argv.includes('--demo') || /^(1|true|si|sí)$/i.test(process.env.SEED_DEMO || '');
  if (demo && process.env.NODE_ENV === 'production') { console.error('Error: los datos de demostración no se cargan con NODE_ENV=production (traen contraseñas conocidas).'); process.exit(1); }
  if (demo) require('./seed')(db);
  else if (!db.prepare('SELECT COUNT(*) n FROM users').get().n) console.log('Aviso: la base no tiene usuarios. Para probar con datos de demostración: npm run demo. Para crear la cuenta de la secretaría: npm run crear-usuario (ver docs).');
  app.listen(PORT, () => console.log(`SAE en ${BASE}`));
  if (horasRecordatorio()) { const tic = () => revisarRecordatorios().catch(e => console.error('Recordatorios:', e.message)); setTimeout(tic, 10e3); setInterval(tic, 5 * 60e3); console.log(`Recordatorios de asesoría: ${horasRecordatorio()} h antes.`); }
}
app.db = db; module.exports = app;
