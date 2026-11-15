# SAE · Construcción de la página e instalación

## 1. Cómo está construido
**Stack:** Node.js 22.5+ · Express · SQLite (módulo `node:sqlite` incluido en Node) · HTML/CSS/JavaScript sin frameworks · bcryptjs · nodemailer · qrcode.

Se eligió así porque la propuesta del proyecto pide HTML, CSS, JavaScript y base de datos SQL, y porque no requiere instalar servidor de base de datos aparte: la base es un archivo (`data/sae.db`).

### Flujo general
```
Navegador (public/index.html)
   │  fetch /api/...
   ▼
Express (server.js): sesión → permisos por rol → validación
   ▼
SQLite (data/sae.db)  +  notificaciones (SMTP o bitácora)
```

### Archivos
| Archivo | Función |
|---|---|
| `server.js` | API, sesiones, permisos, correos, QR |
| `seed.js` | Datos de demostración (padrón, docentes, horarios); solo se cargan con `npm run demo` |
| `scripts/crear-usuario.js` | Crea cuentas de secretaría o docente con contraseña propia (`npm run crear-usuario`) |
| `public/index.html` | Interfaz completa (login, catálogo, agendar, historial, disponibilidad, QR) |
| `test/flujo.test.js` | Prueba integral automatizada |
| `docs/` | Este documento y la tesis |

### Base de datos
| Tabla | Contenido |
|---|---|
| `padron` | Matrículas válidas (valida el registro) y, opcionalmente, el correo institucional de cada una (`email`) |
| `users` | Estudiantes, docentes y secretaría (`rol`), contraseña en hash |
| `docentes` | Materias, cubículo, foto (1 a 1 con `users`) |
| `horarios` | Franjas por docente; `libre` = 1 o 0; única por docente/fecha/hora |
| `asesorias` | Estudiante, docente, horario, materia, duda, estado |
| `notificaciones` | Copia de cada correo y si se envió (los códigos de verificación no se guardan) |
| `codigos` | Códigos de un solo uso enviados por correo (solo su huella): solicitud de registro pendiente, con caducidad y contador de intentos |

### Decisiones de diseño y seguridad
- **Registro solo con matrícula del padrón y correo verificado** (actividad 1.3.1): el registro no crea la cuenta; envía un código de 6 dígitos (caduca en 15 min, 5 intentos, un envío por minuto y 5 por hora) al correo institucional y la cuenta se crea al escribirlo. Si el padrón (`padron.email`) trae el correo de la matrícula, el código va a ese correo; si no, se acepta el que escriba el estudiante siempre que sea del dominio `DOMINIOS_CORREO`.  Docentes y secretaría se dan de alta con `npm run crear-usuario` (o con `npm run demo` para datos de prueba).
- **Contraseñas** con bcrypt; **sesión** en cookie firmada, `httpOnly`, 8 horas; freno a fuerza bruta: solo cuentan los **fallos**, por matrícula + IP (8 en 10 min; el acceso correcto limpia el contador) y un tope amplio de 100 fallos por IP. Así quien se equivoca no bloquea a los demás aunque compartan la red de la facultad.
- **Consultas parametrizadas** (evita inyección SQL) y escape de HTML en la interfaz (evita XSS).
- **Tope de reservas:** cada estudiante puede tener como máximo 2 asesorías activas (`MAX_ASESORIAS_ACTIVAS`); la tercera recibe 409 con el mensaje "Ya tienes 2 asesorías activas…". Cancelar o que se realice la asesoría libera el cupo. La revisión y la reserva ocurren en el mismo turno síncrono, así que solicitudes simultáneas no lo rebasan.
- **Horarios vencidos:** un horario que ya empezó no se puede reservar (400, sin consumirlo) y los listados no lo ofrecen; se calcula en la hora local de la facultad (`ZONA_HORARIA`), no en UTC.
- **Reserva atómica:** `UPDATE horarios SET libre=0 WHERE id=? AND libre=1`; si dos estudiantes pulsan a la vez, solo uno gana.
- **Ciclo de vida de una asesoría:** pendiente → confirmada → realizada; se puede cancelar mientras esté pendiente o confirmada. *Cancelada* y *realizada* son definitivas: no se cancelan de nuevo ni se reabren (responde 409), de modo que un horario liberado por una cancelación no puede volver a liberarse bajo los pies de quien ya lo reservó. El docente se identifica por su cuenta, no por su correo.
- **Permisos por rol:** el estudiante agenda y cancela las suyas; el docente confirma, realiza o cancela las suyas; la secretaría ve todo y la bitácora.
- **Recuperación de contraseña** (estudiantes, docentes y secretaría): "Olvidé mi contraseña" envía un código de 6 dígitos al correo de la cuenta (mismas reglas que el registro: 15 min, 5 intentos, 1 envío por minuto, 5 por hora). La respuesta es la misma exista o no la matrícula, así que no revela quién tiene cuenta. Al cambiar la contraseña se **cierran todas las sesiones abiertas** y se avisa por correo; docentes y secretaría necesitan 10 caracteres o más y no pueden usar las contraseñas de demostración. Los intentos fallidos de recuperación llevan su propio cupo (no se mezclan con los de iniciar sesión).
- **Correos:** si hay SMTP configurado se envían; si no, se guardan en la bitácora con "pendiente" para que el sistema funcione igual en pruebas.

### Correspondencia con el EDT
| EDT | Dónde está |
|---|---|
| 1.3.1 Registro y acceso | `/api/registro`, `/api/registro/confirmar`, `/api/login`, `/api/recuperar`, `/api/recuperar/confirmar`, `padron`, `codigos` |
| 1.3.2 Catálogo de docentes | `/api/docentes?q=` |
| 1.3.3 Agendamiento | `/api/asesorias` (POST), `/api/horarios` |
| 1.3.4 Confirmaciones | función `notificar()`, tabla `notificaciones` |
| 1.3.5 Historial | `/api/asesorias` (GET), vista "Historial" |
| 1.2.4 Seguridad y accesibilidad | roles, cookie segura, diseño responsivo, foco visible |
| 1.4.2 Pruebas integrales | `npm test` |

## 2. Instalación local (Windows, macOS o Linux)
1. Instala **Node.js 22.5 o superior** desde https://nodejs.org (LTS reciente). Verifica: `node -v`.
2. Instala **Git** y clona el repositorio:
   ```bash
   git clone https://github.com/SASVKE666/SAE-Sistema-de-Asesorias-Estudiantil-.git
   cd SAE-Sistema-de-Asesorias-Estudiantil-
   ```
3. Instala dependencias: `npm install`
4. (Opcional) copia `.env.example` a `.env` como referencia de las variables. **La aplicación no lee `.env` por sí sola**: defínelas en el entorno (en PowerShell: `$env:SESSION_SECRET="..."`) o arranca con `node --env-file=.env server.js`.
5. Inicia con datos de demostración: `npm run demo` → abre http://localhost:3000. (`npm start` a secas arranca con la base **vacía**, sin usuarios: es lo que se usa en producción.)
6. Verifica con las pruebas: `npm test` (todas deben pasar).

**Cuentas de demostración** (solo existen con `npm run demo`; tienen contraseñas conocidas, por eso **nunca** se cargan con `NODE_ENV=production`: el servidor se niega a arrancar):
| Rol | Usuario | Contraseña |
|---|---|---|
| Estudiante | Se registra con matrícula `24100001`, `24100002` o `24100003` | La que elija |
| Docente | `DOC001`, `DOC002`, `DOC003` | `Docente2026` |
| Secretaría | `SEC001` | `Secretaria2026` |

## 3. Variables de entorno
| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | Puerto | 3000 |
| `BASE_URL` | URL pública (la usa el QR y activa cookie `secure` si empieza con `https`) | http://localhost:PORT |
| `SESSION_SECRET` | Firma de sesiones. **Obligatorio en producción**: con `NODE_ENV=production` el servidor no arranca si falta, es un valor de ejemplo o tiene menos de 32 caracteres. Fuera de producción, sin él se usa un secreto aleatorio temporal (las sesiones se cierran al reiniciar). Genera uno con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | sin valor: temporal (no hay secreto conocido) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Correo real. **Obligatorio en producción**: el código de verificación del registro viaja por correo; sin SMTP el registro responde 503 | sin SMTP: solo bitácora (en desarrollo el código se imprime en la consola) |
| `DOMINIOS_CORREO` | Dominios aceptados para el correo del estudiante cuando el padrón no lo trae (separados por coma; incluye subdominios; `*` acepta cualquiera, no recomendado) | `uan.edu.mx` |
| `DB_FILE` | Ruta de la base | `data/sae.db` |
| `ZONA_HORARIA` | Zona horaria IANA de la facultad. Los horarios se guardan en hora local; con esta zona se decide cuáles ya pasaron (no se pueden reservar ni se ofrecen) | `America/Mazatlan` |
| `MAX_ASESORIAS_ACTIVAS` | Máximo de asesorías activas por estudiante (pendientes o confirmadas cuyo horario aún no llega); evita que una cuenta acapare los horarios de un docente. Las canceladas, las realizadas y las que ya pasaron no cuentan | `2` |
| `TRUST_PROXY` | Número de proxies de confianza delante de la app (ej. `1` con Nginx); necesario para que el límite de intentos vea la IP real | sin proxy: desactivado |

## 4. Puesta en producción (resumen)
1. Servidor con Node 22.5+ (VPS o hosting con Node). Dominio y **certificado SSL** (por ejemplo con Nginx + Let's Encrypt como proxy hacia el puerto 3000).
2. Define `BASE_URL=https://tu-dominio`, `TRUST_PROXY=1` (si usas Nginx), un `SESSION_SECRET` propio de 32 caracteres o más (sin él, en producción el servidor se niega a arrancar) y las variables SMTP (**obligatorias**: sin correo nadie puede registrarse) (el correo institucional o un servicio SMTP).
3. **Sin datos de demostración:** arranca con `NODE_ENV=production npm start` (la base queda vacía; no se crean usuarios con contraseñas conocidas). Crea la cuenta de la secretaría y las de los docentes con tu propia contraseña (se pide por teclado, sin mostrarse; mínimo 10 caracteres y no puede ser una de las de demostración):
   ```bash
   npm run crear-usuario -- secretaria SEC001 "Secretaría de Economía" secretaria@uan.edu.mx
   npm run crear-usuario -- docente DOC010 "Dra. Ana Pérez" ana@uan.edu.mx --materias "Estadística, Econometría" --cubiculo "Cubículo 3"
   ```
   Para automatizarlo (sin terminal) define la contraseña en la variable `SAE_PASSWORD`. El **padrón de estudiantes** todavía no tiene carga por archivo: ver "Límites conocidos". Si probaste con `npm run demo` en esa misma base, bórrala (`data/sae.db`) antes de publicar.
4. La aplicación **no lee el archivo `.env` por sí sola**: define las variables en el entorno del servicio (pm2 `ecosystem.config.js`, systemd `Environment=`, etc.) o arranca con `node --env-file=.env server.js`. Mantén el proceso activo con `pm2 start server.js --name sae`. Respalda `data/sae.db` periódicamente.
5. Genera el QR desde la sección "Código QR" e imprímelo para carteles.

## 5. Publicar este proyecto en GitHub
```bash
git init -b main
git add .
git commit -m "SAE: primera versión (EDT hasta pruebas)"
git remote add origin https://github.com/SASVKE666/SAE-Sistema-de-Asesorias-Estudiantil-.git
git push -u origin main
```
Si GitHub pide contraseña, usa un *Personal Access Token* (Settings → Developer settings) o GitHub Desktop.

## 6. Límites conocidos y siguientes pasos
- No hay carga de fotos de docentes (se muestran iniciales); el campo `foto` ya existe en la base.
- El alta de docentes y secretaría se hace con `npm run crear-usuario`; la **carga del padrón de estudiantes** y el alta masiva de docentes aún no tienen herramienta (un panel de administración o una carga por CSV sería la siguiente mejora).
- La recuperación de contraseña depende del correo guardado en la cuenta: quien perdió también el acceso a ese buzón debe pedir a la secretaría que lo corrija (aún no hay panel para ello).
- La verificación del registro prueba que quien se registra controla **un** buzón del dominio institucional, no que sea el dueño de la matrícula: si el padrón no trae el correo de cada matrícula, alguien con cuenta institucional podría registrar la de otro alumno antes que él. Lo ideal es cargar `padron.email` con el correo institucional de cada estudiante (así el código solo llega a su dueño); esa carga aún no tiene herramienta.
- Las pruebas de aceptación con usuarios reales (1.4.3) están por realizarse.
