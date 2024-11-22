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

const natural = require('natural');
const tokenizer = new natural.WordTokenizer();

// Definir palabras clave para clasificar
const keywords = {
  DENUNCIA: ['denuncia', 'irregularidad', 'ilegal', 'corrupción'],
  QUEJA: ['queja', 'inconformidad', 'problema', 'insatisfacción'],
  PETICIÓN: ['petición', 'solicitud', 'requerimiento', 'consulta'],
};

// Función para clasificar el asunto
const classifyPqrs = (asunto) => {
  const tokens = tokenizer.tokenize(asunto.toLowerCase());
  let category = 'OTROS';

  Object.keys(keywords).forEach((key) => {
    if (tokens.some((token) => keywords[key].includes(token))) {
      category = key;
    }
  });

  return category;
};

// Ruta para procesar y clasificar PQRS
app.post('/api/classify-pqrs', (req, res) => {
  const { asunto } = req.body;

  if (!asunto) {
    return res.status(400).send('El campo "asunto" es obligatorio.');
  }

  const category = classifyPqrs(asunto);

  res.status(200).json({ category });
});

// Ruta para clasificar y almacenar automáticamente
app.post('/api/auto-classify-pqrs', (req, res) => {
  const { radicado, fecha_radicacion, medios_llegada, asunto, nombre, entidad } = req.body;

  if (!asunto || !radicado) {
    return res.status(400).send('Los campos "radicado" y "asunto" son obligatorios.');
  }

  const category = classifyPqrs(asunto);

  db.query(
    'INSERT INTO pqrs (radicado, fecha_radicacion, medios_llegada, tipo_requerimiento, asunto, nombre, entidad) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [radicado, fecha_radicacion, medios_llegada, category, asunto, nombre, entidad],
    (err) => {
      if (err) {
        console.error('Error al guardar la PQRS:', err);
        return res.status(500).send('Error al guardar la PQRS.');
      }

      res.status(201).json({ message: 'PQRS clasificada y almacenada con éxito.', category });
    }
  );
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
          estado,
          comentarios
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

// Ruta para obtener los detalles de una PQRS
app.get('/api/pqrs/:id', (req, res) => {
  const { id } = req.params;

  db.query('SELECT * FROM pqrs WHERE id = ?', [id], (err, results) => {
    if (err) {
      console.error('Error al obtener los detalles de la PQRS:', err);
      return res.status(500).send('Error al obtener los detalles.');
    }

    if (results.length === 0) {
      return res.status(404).send('PQRS no encontrada.');
    }

    res.status(200).json(results[0]);
  });
});

// Ruta para actualizar una PQRS y registrar en el historial
app.put('/api/pqrs/:id', (req, res) => {
  const { id } = req.params;
  const { estado, comentarios } = req.body;

  db.query('SELECT * FROM pqrs WHERE id = ?', [id], (err, results) => {
    if (err) {
      console.error('Error al obtener la PQRS:', err);
      return res.status(500).send('Error al obtener la PQRS.');
    }

    if (results.length === 0) {
      return res.status(404).send('PQRS no encontrada.');
    }

    const pqrs = results[0];
    const estadoAnterior = pqrs.estado;

    // Actualizar la PQRS
    db.query(
      'UPDATE pqrs SET estado = ?, comentarios = ? WHERE id = ?',
      [estado, comentarios, id],
      (err) => {
        if (err) {
          console.error('Error al actualizar la PQRS:', err);
          return res.status(500).send('Error al actualizar la PQRS.');
        }

        // Registrar en el historial
        db.query(
          'INSERT INTO pqrs_historial (pqrs_id, estado_anterior, estado_nuevo, comentarios) VALUES (?, ?, ?, ?)',
          [id, estadoAnterior, estado, comentarios],
          (err) => {
            if (err) {
              console.error('Error al registrar en el historial:', err);
              return res.status(500).send('Error al registrar en el historial.');
            }

            // Enviar notificación por correo a los funcionarios
            const mailOptions = {
              from: `"PQRS Soporte" <${process.env.EMAIL_USER}>`,
              to: 'funcionarios@dominio.com', // Correo de los funcionarios
              subject: `Actualización de PQRS - Radicado ${pqrs.radicado}`,
              html: `
                <h1>Notificación de Actualización de PQRS</h1>
                <p>Se ha actualizado una PQRS:</p>
                <ul>
                  <li><strong>Radicado:</strong> ${pqrs.radicado}</li>
                  <li><strong>Estado Anterior:</strong> ${estadoAnterior}</li>
                  <li><strong>Estado Nuevo:</strong> ${estado}</li>
                  <li><strong>Comentarios:</strong> ${comentarios}</li>
                </ul>
                <p>Por favor, revise los detalles en el sistema.</p>
              `,
            };

            transporter.sendMail(mailOptions, (err, info) => {
              if (err) {
                console.error('Error al enviar notificación:', err);
                return res.status(500).send('Error al enviar notificación.');
              }

              console.log('Notificación enviada:', info.response);
              res.status(200).send('PQRS actualizada y notificación enviada con éxito.');
            });
          }
        );
      }
    );
  });
});

// Ruta para obtener el historial de una PQRS
app.get('/api/pqrs/:id/historial', (req, res) => {
  const { id } = req.params;

  db.query(
    'SELECT * FROM pqrs_historial WHERE pqrs_id = ? ORDER BY fecha_cambio DESC',
    [id],
    (err, results) => {
      if (err) {
        console.error('Error al obtener el historial de la PQRS:', err);
        return res.status(500).send('Error al obtener el historial.');
      }

      res.status(200).json(results);
    }
  );
});

// Ruta para enviar alertas de PQRS cerca de su fecha límite
app.post('/api/pqrs/alertas', (req, res) => {
  const fechaActual = new Date();

  db.query(
    'SELECT * FROM pqrs WHERE DATEDIFF(fecha_limite, ?) <= 2 AND estado != "Resuelta"',
    [fechaActual],
    (err, results) => {
      if (err) {
        console.error('Error al obtener PQRS próximas a vencer:', err);
        return res.status(500).send('Error al obtener PQRS próximas a vencer.');
      }

      results.forEach((pqrs) => {
        const mailOptions = {
          from: `"PQRS Soporte" <${process.env.EMAIL_USER}>`,
          to: 'funcionarios@dominio.com', // Correo de los funcionarios
          subject: `Alerta de PQRS Próxima a Vencer - ${pqrs.radicado}`,
          html: `
            <h1>Alerta de PQRS Próxima a Vencer</h1>
            <p>La siguiente PQRS está próxima a su fecha límite:</p>
            <ul>
              <li><strong>Radicado:</strong> ${pqrs.radicado}</li>
              <li><strong>Asunto:</strong> ${pqrs.asunto}</li>
              <li><strong>Fecha Límite:</strong> ${pqrs.fecha_limite}</li>
              <li><strong>Estado:</strong> ${pqrs.estado}</li>
            </ul>
            <p>Por favor tome las acciones necesarias.</p>
          `,
        };

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) {
            console.error('Error al enviar alerta:', err);
          } else {
            console.log('Alerta enviada:', info.response);
          }
        });
      });

      res.status(200).send('Alertas enviadas con éxito.');
    }
  );
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
