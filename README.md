# SAE · Sistema de Asesorías Estudiantil
Plataforma web para agendar y dar seguimiento a las asesorías académicas de la Unidad Académica de Economía, UAN.

- **Estudiantes:** buscan docente o materia (o escanean el QR de un docente), ven horarios libres, agendan y reciben confirmación.
- **Docentes:** publican su disponibilidad (horarios sueltos o repetidos cada semana), confirman y marcan asesorías como realizadas o con inasistencia.
- **Recordatorios:** correo al estudiante y al docente 24 h antes de cada asesoría confirmada (`RECORDATORIO_HORAS`).
- **Secretaría:** recibe copia de cada cita, consulta el historial y el reporte de inasistencias (con exportación a CSV); cada docente ve el de sus propias asesorías. Desde el panel de administración da de alta y desactiva docentes, administra el padrón, bloquea cuentas de estudiantes y consulta la bitácora.

```bash
npm install && npm start     # http://localhost:3000
npm test                     # prueba integral del flujo
```
Requiere Node.js 22.5 o superior.

## Documentación
- [Tesis: por qué existe SAE y qué necesidad atiende](docs/TESIS_SAE.md)
- [Construcción e instalación](docs/CONSTRUCCION_E_INSTALACION.md)

Equipo: Obed Moncada Contreras, Christian Gael Ortiz Ramírez, Lenni Naím Abarca Nava, Fabián Enrique Real Ramírez, Nerick Bryan Rodríguez Ramírez.
