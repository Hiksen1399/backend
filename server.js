require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Configuración de la base de datos
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

// Conexión a la base de datos
db.connect((err) => {
  if (err) {
    console.error('Error conectando a la base de datos:', err);
    return;
  }
  console.log('Conexión a la base de datos exitosa.');
});

// Configurar Nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente.');
});

// Ruta para registrar usuarios
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) return res.status(500).send('Error en la base de datos.');
    if (results.length > 0) return res.status(400).send('El correo ya está registrado.');

    const hashedPassword = await bcrypt.hash(password, 10);
    db.query(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword],
      (err) => {
        if (err) return res.status(500).send('Error al registrar usuario.');
        res.status(201).send('Usuario registrado con éxito.');
      }
    );
  });
});

// Ruta para iniciar sesión
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
    if (err) return res.status(500).send('Error en la base de datos.');
    if (results.length === 0) return res.status(404).send('Usuario no encontrado.');

    const user = results[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) return res.status(401).send('Contraseña incorrecta.');

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    res.status(200).json({ token });
  });
});

// Ruta para recuperación de contraseña
app.post('/recover-password', (req, res) => {
  const { email } = req.body;

  db.query('SELECT * FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.status(500).send('Error en la base de datos.');
    if (results.length === 0) return res.status(404).send('Correo no encontrado.');

    const user = results[0];
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '15m', // Expira en 15 minutos
    });

    const resetLink = `http://localhost:3000/reset-password/${token}`;

    const mailOptions = {
      from: `"Soporte PQRS" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Recuperación de Contraseña',
      html: `
        <h1>Recupera tu contraseña</h1>
        <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
        <a href="${resetLink}">Restablecer Contraseña</a>
        <p>Este enlace expira en 15 minutos.</p>
      `,
    };

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Error al enviar correo:', err);
        return res.status(500).send('Error al enviar correo.');
      }

      console.log('Correo enviado:', info.response);
      res.status(200).send('Correo enviado con instrucciones para recuperar la contraseña.');
    });
  });
});

// Ruta para restablecer contraseña
app.post('/reset-password', (req, res) => {
  const { token, password } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const hashedPassword = bcrypt.hashSync(password, 10);

    db.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, decoded.id],
      (err) => {
        if (err) return res.status(500).send('Error al actualizar la contraseña.');
        res.status(200).send('Contraseña actualizada con éxito.');
      }
    );
  } catch (err) {
    res.status(400).send('El enlace ha expirado o es inválido.');
  }
});

// Ruta para procesar el archivo Excel de PQRS
app.post('/upload-pqrs', (req, res) => {
  // Ruta del archivo Excel (puedes cambiarla por una subida dinámica en el futuro)
  const filePath = path.join(__dirname, 'pqrs.xlsx');

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Archivo Excel no encontrado.');
  }

  try {
    // Leer el archivo Excel
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0]; // Primera hoja del archivo
    const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    // Procesar los datos y guardarlos en la base de datos
    sheetData.forEach((row) => {
      const {
        RADICADO,
        'FECHA DE RADICACION': fechaRadicacion,
        'MEDIOS DE LLEGADA': mediosLlegada,
        'TIPO DE REQUERIMIENTO': tipoRequerimiento,
        ASUNTO,
        'NOMBRE DE QUIEN FORMULA EL REQUERIMIENTO': nombre,
        'ENTIDAD REQUERIDA': entidad,
        'DEPENDENCIA ASIGNADA': dependencia,
        'SECTOR AL QUE PERTENECE': sector,
        'FECHA LIMITE RESPUESTA': fechaLimite,
        'FECHA DE RESPUESTA': fechaRespuesta,
        'TRAZABILIDAD - TRAMITE': trazabilidad,
      } = row;

      // Inserción en la base de datos
      db.query(
        'INSERT INTO pqrs (radicado, fecha_radicacion, medios_llegada, tipo_requerimiento, asunto, nombre, entidad, dependencia, sector, fecha_limite, fecha_respuesta, trazabilidad) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          RADICADO,
          fechaRadicacion,
          mediosLlegada,
          tipoRequerimiento,
          ASUNTO,
          nombre,
          entidad,
          dependencia,
          sector,
          fechaLimite,
          fechaRespuesta,
          trazabilidad,
        ],
        (err) => {
          if (err) console.error(`Error al insertar PQRS: ${RADICADO}`, err);
        }
      );
    });

    res.status(200).send('Archivo procesado y datos almacenados con éxito.');
  } catch (error) {
    console.error('Error al procesar el archivo Excel:', error);
    res.status(500).send('Error al procesar el archivo.');
  }
});

// Ruta para obtener las PQRS
app.get('/api/pqrs', (req, res) => {
  db.query('SELECT * FROM pqrs', (err, results) => {
    if (err) {
      console.error('Error al obtener las PQRS:', err);
      return res.status(500).send('Error al obtener las PQRS.');
    }
    res.status(200).json(results);
  });
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
