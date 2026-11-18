# SAE · Sistema de Asesorías Estudiantil
Plataforma web para agendar y dar seguimiento a las asesorías académicas de la Unidad Académica de Economía, UAN.

- **Estudiantes:** buscan docente o materia (o escanean el QR de un docente), ven horarios libres, agendan y reciben confirmación.
- **Docentes:** publican su disponibilidad (horarios sueltos o repetidos cada semana), confirman y marcan asesorías como realizadas o con inasistencia.
- **Recordatorios:** correo al estudiante y al docente 24 h antes de cada asesoría confirmada (`RECORDATORIO_HORAS`).
- **Secretaría:** recibe copia de cada cita, consulta el historial y el reporte de inasistencias (con exportación a CSV); cada docente ve el de sus propias asesorías. Desde el panel de administración da de alta y desactiva docentes, administra el padrón, bloquea cuentas de estudiantes y consulta la bitácora.

```bash
npm install
npm run demo                 # http://localhost:3000, con datos de demostración
npm test                     # pruebas automáticas
```
Requiere Node.js 22.5 o superior. `npm start` a secas arranca con la base **vacía** (sin usuarios): es el modo de producción; ver la [guía de instalación](docs/CONSTRUCCION_E_INSTALACION.md).

## Datos de demostración (`npm run demo`)
Solo para probar en desarrollo. Solo se cargan si la base **no tiene usuarios**: si ya los tiene, `npm run demo` no cambia nada (para empezar de cero, borra `data/sae.db` o usa otra base con `DB_FILE`). Crea **4 cuentas listas para entrar**, **3 matrículas por registrar** y **70 horarios libres**:

| Qué | Cuántos | Datos |
|---|---|---|
| Secretaría | 1 cuenta | `SEC001` · contraseña `Secretaria2026` |
| Docentes | 3 cuentas | `DOC001` (Dr. Héctor Salazar), `DOC002` (Mtra. Patricia Lugo), `DOC003` (Dr. Ramón Villaseñor) · contraseña `Docente2026` |
| Estudiantes | 3 matrículas en el padrón, **sin cuenta** | `24100001`, `24100002`, `24100003`: se crean con «Soy estudiante y no tengo cuenta». Sin SMTP, el código de verificación sale en la consola del servidor |
| Horarios | 70 libres | Los próximos 14 días, de lunes a viernes: 20 de `DOC001`, 30 de `DOC002` y 20 de `DOC003` |

Las contraseñas de demostración son públicas: el servidor se niega a cargar estos datos con `NODE_ENV=production`, y no se aceptan como contraseña de cuentas reales.

## Documentación
- [Tesis: por qué existe SAE y qué necesidad atiende](docs/TESIS_SAE.md)
- [Construcción e instalación](docs/CONSTRUCCION_E_INSTALACION.md)

Equipo: Obed Moncada Contreras, Christian Gael Ortiz Ramírez, Lenni Naím Abarca Nava, Fabián Enrique Real Ramírez, Nerick Bryan Rodríguez Ramírez.
