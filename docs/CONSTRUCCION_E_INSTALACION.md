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
| `server.js` | API, sesiones, permisos, correos, recordatorios, reportes, QR |
| `seed.js` | Datos de demostración (padrón, docentes, horarios); solo se cargan con `npm run demo` |
| `scripts/crear-usuario.js` | Crea cuentas de secretaría o docente con contraseña propia (`npm run crear-usuario`) |
| `public/index.html` | Interfaz completa (login, catálogo, agendar, historial, disponibilidad, reporte, QR) |
| `test/flujo.test.js` | Prueba integral automatizada |
| `docs/` | Este documento y la tesis |

### Base de datos
| Tabla | Contenido |
|---|---|
| `padron` | Matrículas válidas (valida el registro) y, opcionalmente, el correo institucional de cada una (`email`) |
| `users` | Estudiantes, docentes y secretaría (`rol`), contraseña en hash |
| `docentes` | Materias, cubículo, foto (1 a 1 con `users`) |
| `horarios` | Franjas por docente; `libre` = 1 o 0; única por docente/fecha/hora; `serie_id` si nacieron de una serie semanal |
| `series` | Reglas semanales con las que un docente generó horarios (días, horas, duración, periodo) |
| `asesorias` | Estudiante, docente, horario, materia, duda, estado |
| `notificaciones` | Copia de cada correo y si se envió (los códigos de verificación no se guardan) |
| `codigos` | Códigos de un solo uso enviados por correo (solo su huella): solicitud de registro pendiente, con caducidad y contador de intentos |

### Decisiones de diseño y seguridad
- **Registro solo con matrícula del padrón y correo verificado** (actividad 1.3.1): el registro no crea la cuenta; envía un código de 6 dígitos (caduca en 15 min, 5 intentos, un envío por minuto y 5 por hora) al correo institucional y la cuenta se crea al escribirlo. Si el padrón (`padron.email`) trae el correo de la matrícula, el código va a ese correo; si no, se acepta el que escriba el estudiante siempre que sea del dominio `DOMINIOS_CORREO`.  Docentes y secretaría se dan de alta con `npm run crear-usuario` (o con `npm run demo` para datos de prueba).
- **Contraseñas** con bcrypt; **sesión** en cookie firmada, `httpOnly`, 8 horas; freno a fuerza bruta: solo cuentan los **fallos**, por matrícula + IP (8 en 10 min; el acceso correcto limpia el contador) y un tope amplio de 100 fallos por IP. Así quien se equivoca no bloquea a los demás aunque compartan la red de la facultad.
- **Consultas parametrizadas** (evita inyección SQL) y escape de HTML en la interfaz (evita XSS).
- **Tope de reservas:** cada estudiante puede tener como máximo 2 asesorías activas (`MAX_ASESORIAS_ACTIVAS`); la tercera recibe 409 con el mensaje "Ya tienes 2 asesorías activas…". Cancelar o que se realice la asesoría libera el cupo. La revisión y la reserva ocurren en el mismo turno síncrono, así que solicitudes simultáneas no lo rebasan.
- **Disponibilidad del docente** (pantalla *Mi disponibilidad*): además de agregar horarios sueltos, puede **repetir cada semana** (`POST /api/series`): elige los días, el rango de horas, la duración de cada asesoría (15 a 120 min) y el periodo (hasta 120 días y 1000 horarios por serie). Los bloques que ya pasaron se omiten y los que ya existían no se duplican. Cada horario es un bloque que *empieza* a esa hora. Puede ver sus horarios próximos y **quitarlos** uno por uno o toda una serie (`DELETE /api/horarios/:id`, `DELETE /api/series/:id`): solo se quitan los libres; uno con asesoría pendiente, confirmada o realizada se conserva (hay que cancelarla primero). Si un horario retirado tuvo asesorías canceladas no se borra, para no perder el historial: queda fuera de uso y se reactiva si se vuelve a agregar.
- **QR por docente:** cada docente tiene un QR que apunta a su ficha con los horarios libres (`<BASE_URL>/#docente/<id>`). En la sección *Código QR* el docente ve y descarga el suyo; la secretaría ve el de todos y puede **imprimirlos** (una hoja por docente, con su nombre y cubículo). Pensado para pegarlo en la puerta del cubículo o en el material de clase: quien lo escanea llega directo a los horarios de ese docente. Si no tiene sesión, el enlace se conserva al iniciar sesión o al registrarse (incluida la verificación del correo) y lo lleva directo al docente; si el docente ya no existe, muestra un aviso claro. El enlace no da acceso extra: solo muestra lo que ya ve cualquiera con sesión, y reservar sigue siendo solo para estudiantes (`GET /api/docentes/:id`, `GET /api/qr/docentes`).
- **Horarios vencidos:** un horario que ya empezó no se puede reservar (400, sin consumirlo) y los listados no lo ofrecen; se calcula en la hora local de la facultad (`ZONA_HORARIA`), no en UTC.
- **Reserva atómica:** `UPDATE horarios SET libre=0 WHERE id=? AND libre=1`; si dos estudiantes pulsan a la vez, solo uno gana.
- **Ciclo de vida de una asesoría:** pendiente → confirmada → realizada o *inasistencia* (el estudiante no se presentó); se puede cancelar mientras esté pendiente o confirmada. *Cancelada*, *realizada* e *inasistencia* son definitivas: no se cancelan de nuevo ni se reabren (responde 409), de modo que un horario liberado por una cancelación no puede volver a liberarse bajo los pies de quien ya lo reservó. El docente se identifica por su cuenta, no por su correo. La *inasistencia* solo la registra el docente de esa asesoría, solo desde *confirmada* y solo cuando ya llegó la hora de inicio (antes responde 409); el horario sigue ocupado y todos reciben el aviso por correo.
- **Recordatorios:** el sistema envía un correo al estudiante y al docente `RECORDATORIO_HORAS` horas antes (24 por defecto) de cada asesoría *confirmada*, una sola vez. Revisa cada 5 minutos, la marca queda en la base (reiniciar no repite ni pierde avisos), y si el correo falla para todos se reintenta en la siguiente revisión. Si la asesoría se confirma cuando ya falta menos que el aviso, la confirmación hace de recordatorio. Sin SMTP configurado solo queda en la bitácora de notificaciones.
- **Reporte de inasistencias** (pantalla *Reporte*, `GET /api/reporte` y `GET /api/reporte/inasistencias.csv`): el docente ve solo lo suyo y la secretaría toda la Unidad, con totales, tasa de inasistencia (inasistencias entre realizadas + inasistencias), desglose por docente y estudiantes con inasistencias. Por defecto cubre los últimos 30 días (máximo 400); el periodo se filtra por la fecha de la asesoría. Se resalta cuántas asesorías ya pasaron sin cerrarse. El CSV (UTF-8 con BOM, abre bien en Excel) lista las inasistencias y neutraliza celdas que empiecen con `=`, `+`, `-` o `@`.
- **Panel de administración** (pantalla *Administración*, solo secretaría, rutas `/api/admin/*`): *Docentes* (alta, edición de nombre, correo, materias y cubículo, desactivar y reactivar), *Estudiantes* (buscar y bloquear o desbloquear la cuenta), *Padrón* (buscar, agregar, editar y quitar matrículas que aún no tienen cuenta) y *Actividad* (bitácora de lo que se hizo, con quién y cuándo; tabla `auditoria`). El alta de un docente **no captura contraseña**: se crea con una que nadie conoce y se le envía un correo para que la elija con «Olvidé mi contraseña» (por eso el alta exige correo configurado en producción y usa `DOMINIOS_CORREO`). Una cuenta desactivada o bloqueada no puede entrar, sus sesiones abiertas dejan de valer, y si es un docente desaparece del catálogo y nadie puede agendarle; sus asesorías abiertas se conservan. La columna `users.activo` se agrega sola a bases anteriores.
- **Permisos por rol:** el estudiante agenda y cancela las suyas; el docente confirma, realiza o cancela las suyas; la secretaría ve todo y la bitácora.
- **Recuperación de contraseña** (estudiantes, docentes y secretaría): "Olvidé mi contraseña" envía un código de 6 dígitos al correo de la cuenta (mismas reglas que el registro: 15 min, 5 intentos, 1 envío por minuto, 5 por hora). La respuesta es la misma exista o no la matrícula, así que no revela quién tiene cuenta. Al cambiar la contraseña se **cierran todas las sesiones abiertas** y se avisa por correo; docentes y secretaría necesitan 10 caracteres o más y no pueden usar las contraseñas de demostración. Los intentos fallidos de recuperación llevan su propio cupo (no se mezclan con los de iniciar sesión).
- **Correos:** si hay SMTP configurado se envían; si no, se guardan en la bitácora con "pendiente" para que el sistema funcione igual en pruebas.

### Correspondencia con el EDT
| EDT | Dónde está |
|---|---|
| 1.3.1 Registro y acceso | `/api/registro`, `/api/registro/confirmar`, `/api/login`, `/api/recuperar`, `/api/recuperar/confirmar`, `padron`, `codigos` |
| 1.3.2 Catálogo de docentes | `/api/docentes?q=` |
| 1.3.3 Agendamiento | `/api/asesorias` (POST), `/api/horarios`, `/api/mis-horarios`, `/api/series`, `/api/docentes/:id`, `/api/qr/docentes`, `/api/reporte`, `/api/reporte/inasistencias.csv`, `/api/admin/docentes`, `/api/admin/estudiantes`, `/api/admin/padron`, `/api/admin/actividad` |
| 1.3.4 Confirmaciones | función `notificar()`, tabla `notificaciones` |
| 1.3.5 Historial | `/api/asesorias` (GET), vista "Historial" |
| 1.2.4 Seguridad y accesibilidad | roles, cookie segura, diseño responsivo, foco visible |
| 1.4.2 Pruebas integrales | `npm test` |

## 2. Instalación local (Windows, macOS o Linux)
1. Instala **Node.js 22.5 o superior** desde https://nodejs.org (LTS reciente). Verifica: `node -v`.
2. Instala **Git** y clona el repositorio:
   ```bash
   git clone https://github.com/SASVKE666/SAE-Sistema-de-Asesorias-Estudiantil.git
   cd SAE-Sistema-de-Asesorias-Estudiantil
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
| `BASE_URL` | URL pública (la usan los códigos QR y activa cookie `secure` si empieza con `https`). **Defínela antes de imprimir QR**: con el valor por defecto apuntarían a tu propia computadora (en producción el servidor lo avisa al arrancar) | http://localhost:PORT |
| `SESSION_SECRET` | Firma de sesiones. **Obligatorio en producción**: con `NODE_ENV=production` el servidor no arranca si falta, es un valor de ejemplo o tiene menos de 32 caracteres. Fuera de producción, sin él se usa un secreto aleatorio temporal (las sesiones se cierran al reiniciar). Genera uno con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | sin valor: temporal (no hay secreto conocido) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Correo real. **Obligatorio en producción**: el código de verificación del registro viaja por correo; sin SMTP el registro responde 503 | sin SMTP: solo bitácora (en desarrollo el código se imprime en la consola) |
| `DOMINIOS_CORREO` | Dominios aceptados para el correo del estudiante cuando el padrón no lo trae (separados por coma; incluye subdominios; `*` acepta cualquiera, no recomendado) | `uan.edu.mx` |
| `DB_FILE` | Ruta de la base | `data/sae.db` |
| `ZONA_HORARIA` | Zona horaria IANA de la facultad. Los horarios se guardan en hora local; con esta zona se decide cuáles ya pasaron (no se pueden reservar ni se ofrecen) | `America/Mazatlan` |
| `RECORDATORIO_HORAS` | Horas de anticipación del correo recordatorio de cada asesoría confirmada (24 por defecto; máximo 168). `0` desactiva los recordatorios; un valor inválido vuelve a 24. |
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
   Para automatizarlo (sin terminal) define la contraseña en la variable `SAE_PASSWORD`. Después **carga el padrón de estudiantes** desde un CSV con las columnas `matricula,nombre,correo` (el correo institucional de cada alumno; en Excel guárdalo como "CSV UTF-8"):
   ```bash
   npm run cargar-padron -- alumnos.csv --simular   # solo revisa y dice qué haría
   npm run cargar-padron -- alumnos.csv             # carga o actualiza (no borra a nadie)
   ```
   Si alguna fila tiene un error no se carga nada y se listan todos con su línea. **Conviene que todas las filas traigan el correo**: así el código de verificación del registro solo llega al dueño de la matrícula. Si probaste con `npm run demo` en esa misma base, bórrala (`data/sae.db`) antes de publicar.
4. La aplicación **no lee el archivo `.env` por sí sola**: define las variables en el entorno del servicio (pm2 `ecosystem.config.js`, systemd `Environment=`, etc.) o arranca con `node --env-file=.env server.js`. Mantén el proceso activo con `pm2 start server.js --name sae`. Respalda `data/sae.db` periódicamente.
5. Con `BASE_URL` ya definida, entra a la sección "Código QR": ahí está el QR general para carteles y, para docentes y secretaría, el **QR de cada docente** (ver "QR por docente").

## 5. Publicar este proyecto en GitHub
```bash
git init -b main
git add .
git commit -m "SAE: primera versión (EDT hasta pruebas)"
git remote add origin https://github.com/SASVKE666/SAE-Sistema-de-Asesorias-Estudiantil.git
git push -u origin main
```
Si GitHub pide contraseña, usa un *Personal Access Token* (Settings → Developer settings) o GitHub Desktop.

## 6. Límites conocidos y siguientes pasos
- No hay carga de fotos de docentes (se muestran iniciales); el campo `foto` ya existe en la base.
- Los docentes se dan de alta desde el panel de administración (uno por uno); la secretaría sigue creándose con `npm run crear-usuario`, y una carga masiva de docentes por CSV aún no existe. El padrón de estudiantes se puede cargar por CSV (`npm run cargar-padron`) o editar desde el panel. El panel no crea cuentas de secretaría ni cambia contraseñas ajenas; tampoco borra cuentas (se desactivan para conservar el historial).
- La recuperación de contraseña depende del correo guardado en la cuenta: quien perdió también el acceso a ese buzón debe pedir a la secretaría que lo corrija (aún no hay panel para ello).
- La verificación del registro prueba que quien se registra controla **un** buzón del dominio institucional, no que sea el dueño de la matrícula: si el padrón no trae el correo de cada matrícula, alguien con cuenta institucional podría registrar la de otro alumno antes que él. Por eso conviene cargar el padrón con el correo institucional de cada estudiante (`npm run cargar-padron`): así el código solo llega a su dueño.
- Las pruebas de aceptación con usuarios reales (1.4.3) están por realizarse.
