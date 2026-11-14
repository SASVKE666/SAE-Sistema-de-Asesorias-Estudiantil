// Ayuda para las pruebas: cambia el envío SMTP real por una captura en memoria. Se instala ANTES de cargar ../server.
// (Está fuera de test/ para que `node --test` no la ejecute como si fuera una prueba.)
const assert = require('node:assert'), nodemailer = require('nodemailer');
module.exports = () => {
  const enviados = [], api = { enviados, falla: false };          // api.falla = true simula un servidor SMTP caído
  process.env.SMTP_HOST = 'smtp.prueba.invalid';
  nodemailer.createTransport = () => ({ sendMail: async m => { if (api.falla) throw new Error('SMTP caído'); enviados.push(m); } });
  // Último código de 6 dígitos que se envió a ese correo (o undefined)
  const codigo = para => { const m = [...enviados].reverse().find(x => x.to === para); return m && /\b(\d{6})\b/.exec(m.text)?.[1]; };
  // Registro completo: solicita el código, lo "lee" del correo capturado y lo confirma. `enviar(url, cuerpo)` -> { status, json }
  const registrar = async (enviar, datos, correo = datos.email) => {
    const r1 = await enviar('/api/registro', datos); assert.equal(r1.status, 200, 'registro: ' + JSON.stringify(r1.json)); assert.equal(r1.json.pendiente, true);
    const r2 = await enviar('/api/registro/confirmar', { matricula: datos.matricula, codigo: codigo(correo) }); assert.equal(r2.status, 200, 'confirmar: ' + JSON.stringify(r2.json));
    return r2;
  };
  return Object.assign(api, { codigo, registrar });
};
