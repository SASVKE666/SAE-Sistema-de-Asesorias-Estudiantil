// La regla de las matrículas y claves de docente, en un solo lugar (la usan el servidor, el panel de administración y los scripts).
// Letras, números, punto, guion bajo y guion; de 3 a 40 caracteres, sin espacios. Al compararlas NO se distingue entre mayúsculas y minúsculas
// ("doc001" entra a la cuenta DOC001), y en todo lo demás se usa la forma tal como quedó guardada.
const MATRICULA_RE = /^[A-Za-z0-9._-]{3,40}$/;
const MENSAJE_MATRICULA = 'de 3 a 40 caracteres: letras, números, punto, guion o guion bajo (sin espacios)';
module.exports = { MATRICULA_RE, MENSAJE_MATRICULA, esMatricula: m => typeof m === 'string' && MATRICULA_RE.test(m) };
