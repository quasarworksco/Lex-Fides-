require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin Init ──
let serviceAccount;
try {
  serviceAccount = require('./serviceAccount.json');
} catch {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}
let db;
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id
  });
  db = admin.firestore();
  console.log('Firebase conectado');
} catch (e) {
  console.error('Error Firebase:', e.message);
  process.exit(1);
}

// ── Helpers Firestore ──
async function logConversation(sessionId, area, userMsg, botReply, durationMs) {
  const now = admin.firestore.Timestamp.now();
  const dateKey = new Date().toISOString().split('T')[0]; // "2025-06-08"

  const batch = db.batch();

  // Documento individual de mensaje
  const msgRef = db.collection('messages').doc();
  batch.set(msgRef, {
    sessionId,
    area,
    userMessage: userMsg,
    botReply,
    durationMs,
    createdAt: now,
    dateKey
  });

  // Contador diario por area
  const statsRef = db.collection('stats_daily').doc(`${dateKey}_${area}`);
  batch.set(statsRef, {
    date: dateKey,
    area,
    count: admin.firestore.FieldValue.increment(1),
    totalDurationMs: admin.firestore.FieldValue.increment(durationMs)
  }, { merge: true });

  // Contador global
  const globalRef = db.collection('stats_global').doc('totals');
  batch.set(globalRef, {
    totalMessages: admin.firestore.FieldValue.increment(1),
    totalSessions: admin.firestore.FieldValue.increment(0),
    lastActivity: now
  }, { merge: true });

  await batch.commit();
}

async function registerSession(sessionId) {
  await db.collection('sessions').doc(sessionId).set({
    createdAt: admin.firestore.Timestamp.now(),
    messageCount: 0
  }, { merge: true });

  await db.collection('stats_global').doc('totals').set({
    totalSessions: admin.firestore.FieldValue.increment(1)
  }, { merge: true });
}

async function incrementSessionMessages(sessionId) {
  await db.collection('sessions').doc(sessionId).update({
    messageCount: admin.firestore.FieldValue.increment(1),
    lastActivity: admin.firestore.Timestamp.now()
  });
}

// ── Prompts por area ──
const AREA_PROMPTS = {
  general:        'Eres un asistente juridico general especializado en toda la legislacion venezolana vigente. Orientas sobre cualquier rama del derecho: civil, penal, laboral, mercantil, familiar, constitucional, administrativo y mas. Cita normas especificas venezolanas.',
  laboral:        'Eres un experto en derecho laboral venezolano. Conoces la Ley Organica del Trabajo, los Trabajadores y las Trabajadoras (LOTTT), la Ley del Seguro Social, normativas del Ministerio del Poder Popular para el Proceso Social de Trabajo, prestaciones sociales, beneficios (utilidades, bono vacacional, cesta ticket), contratos laborales, jornada de trabajo, salario minimo, inamovilidad laboral, estabilidad absoluta y relativa, sindicatos y convenciones colectivas en Venezuela.',
  penal:          'Eres un experto en derecho penal venezolano. Conoces el Codigo Penal venezolano, el Codigo Organico Procesal Penal (COPP), la Ley Organica sobre el Derecho de las Mujeres a una Vida Libre de Violencia, la Ley Organica contra la Delincuencia Organizada y Financiamiento al Terrorismo (LOCDOFT), medidas cautelares, privacion judicial preventiva de libertad y el sistema de justicia penal en Venezuela.',
  civil:          'Eres un experto en derecho civil venezolano. Conoces el Codigo Civil venezolano, el Codigo de Procedimiento Civil, contratos, obligaciones, derechos reales, sucesiones, prescripcion, responsabilidad civil extracontractual y el sistema registral venezolano.',
  familiar:       'Eres un experto en derecho de familia venezolano. Conoces la Ley Organica para la Proteccion de Ninos, Ninas y Adolescentes (LOPNNA), el Codigo Civil en materia de familia, matrimonio, divorcio, union estable de hecho, filiacion, patria potestad, custodia, obligacion de manutención y adopcion en Venezuela.',
  mercantil:      'Eres un experto en derecho mercantil venezolano. Conoces el Codigo de Comercio venezolano, el Registro Mercantil, tipos de sociedades (C.A., S.R.L., firma personal), titulos valores (letras de cambio, pagares, cheques), contratos mercantiles y el sistema concursal venezolano.',
  constitucional: 'Eres un experto en derecho constitucional venezolano. Conoces la Constitucion de la Republica Bolivariana de Venezuela (CRBV 1999), derechos fundamentales, garantias constitucionales, accion de amparo constitucional, habeas corpus, habeas data, el Tribunal Supremo de Justicia (TSJ) y la Sala Constitucional.',
  administrativo: 'Eres un experto en derecho administrativo venezolano. Conoces la Ley Organica de Procedimientos Administrativos (LOPA), la Ley Organica de la Administracion Publica, la Ley de Contrataciones Publicas, la Ley del Estatuto de la Funcion Publica, recursos administrativos y contencioso-administrativos en Venezuela.',
  tributario:     'Eres un experto en derecho tributario venezolano. Conoces el Codigo Organico Tributario (COT), la Ley del ISLR (Impuesto sobre la Renta), la Ley del IVA (Impuesto al Valor Agregado), la Ley de Impuesto a los Grandes Patrimonios, el SENIAT, retenciones, declaraciones y procedimientos tributarios en Venezuela.'
};

function buildSystemPrompt(area) {
  const areaPrompt = AREA_PROMPTS[area] || AREA_PROMPTS.general;
  return `Eres el asistente juridico de Lex Fides Abogados, especializado en derecho venezolano. ${areaPrompt}

INSTRUCCIONES:
- Mantenes el hilo de la conversacion y construyes sobre respuestas previas.
- Haces preguntas de seguimiento cuando necesitas mas informacion.
- Respondes en espanol venezolano claro y accesible.
- Citas articulos y normas especificas venezolanas cuando aportan valor.
- No uses emojis.
- Al final de cada respuesta haz UNA pregunta de seguimiento relevante cuando corresponda.
- Aclara siempre que tu orientacion es informativa y que para casos concretos se recomienda consultar con un abogado habilitado en Venezuela.`;
}

// ── Limites por plan ──
const PLAN_LIMITS = {
  free:         10,
  basico:       150,
  profesional:  600,
  empresarial:  Infinity
};

const PLAN_AREAS = {
  free:         ['general'],
  basico:       ['general','laboral','civil'],
  profesional:  Object.keys(AREA_PROMPTS),
  empresarial:  Object.keys(AREA_PROMPTS)
};

async function getUserPlan(userId) {
  if (!userId) return { plan: 'free', messagesUsed: 0 };
  try {
    const userSnap = await db.collection('users').doc(userId).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      let plan = u.plan || 'free';

      // Verificar expiracion del plan
      if (plan !== 'free' && u.planExpiry) {
        const expiry = u.planExpiry.toDate ? u.planExpiry.toDate() : new Date(u.planExpiry);
        if (new Date() > expiry) {
          // Plan expirado — downgrade a free
          await db.collection('users').doc(userId).update({
            plan: 'free',
            planExpired: true,
            messagesUsed: 0
          });
          plan = 'free';
        }
      }

      return { plan, messagesUsed: u.messagesUsed || u.messageCount || 0 };
    }
  } catch(e) { console.error('getUserPlan:', e); }
  return { plan: 'free', messagesUsed: 0 };
}

// ── Middleware: verificar token Firebase ──
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Token invalido' });
  }
}

// ── ENDPOINTS ──

// Registrar nueva sesion
app.post('/api/session', verifyToken, async (req, res) => {
  try {
    const sessionId = uuidv4();
    const userId = req.user.uid;
    await registerSession(sessionId);
    // Actualizar contador de sesiones del usuario
    await db.collection('users').doc(userId).set({
      sessionCount: admin.firestore.FieldValue.increment(1),
      lastActivity: admin.firestore.Timestamp.now()
    }, { merge: true });
    res.json({ sessionId });
  } catch (e) {
    console.error('session error:', e);
    res.status(500).json({ error: 'Error al crear sesion' });
  }
});

// Enviar mensaje al asistente
app.post('/api/chat', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const { sessionId, area = 'general', message, history = [] } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId y message son requeridos' });
  }

  // Verificar plan y limites desde Firestore (fuente de verdad)
  const userPlan = await getUserPlan(userId);
  const limit = PLAN_LIMITS[userPlan.plan] || PLAN_LIMITS.free;
  if (limit !== Infinity && userPlan.messagesUsed >= limit) {
    return res.status(429).json({
      error: 'limite_alcanzado',
      message: `Has alcanzado el limite de ${limit} mensajes de tu plan ${userPlan.plan}. Actualiza tu plan para continuar.`,
      plan: userPlan.plan,
      messagesUsed: userPlan.messagesUsed,
      limit
    });
  }

  const allowedAreas = PLAN_AREAS[userPlan.plan] || PLAN_AREAS.free;
  if (!allowedAreas.includes(area)) {
    return res.status(403).json({
      error: 'area_no_disponible',
      message: `El area "${area}" no esta disponible en tu plan ${userPlan.plan}. Actualiza tu suscripcion para acceder a todas las areas juridicas.`,
      plan: userPlan.plan,
      allowedAreas
    });
  }

  const start = Date.now();

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
        messages: [
          { role: 'system', content: buildSystemPrompt(area) },
          ...history.slice(-20), // max 10 pares
          { role: 'user', content: message }
        ]
      })
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      console.error('Groq error:', data);
      return res.status(502).json({ error: 'Error del servicio de IA', detail: data });
    }

    const reply = data.choices?.[0]?.message?.content || 'No se pudo generar respuesta.';
    const durationMs = Date.now() - start;

    // Guardar en Firestore (sin bloquear la respuesta)
    Promise.all([
      logConversation(sessionId, area, message, reply, durationMs),
      incrementSessionMessages(sessionId),
      db.collection('users').doc(userId).set({
        messagesUsed: admin.firestore.FieldValue.increment(1),
        messageCount: admin.firestore.FieldValue.increment(1),
        lastActivity: admin.firestore.Timestamp.now()
      }, { merge: true }),
      userPlan.subId ? db.collection('subscriptions').doc(userPlan.subId).update({
        messagesUsed: admin.firestore.FieldValue.increment(1)
      }) : Promise.resolve()
    ]).catch(e => console.error('Firestore log error:', e));

    res.json({
      reply,
      durationMs,
      usage: {
        plan: userPlan.plan,
        messagesUsed: userPlan.messagesUsed + 1,
        limit: limit === Infinity ? null : limit
      }
    });
  } catch (e) {
    console.error('chat error:', e);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Metricas para el dashboard admin
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [globalSnap, dailySnap, recentSnap] = await Promise.all([
      db.collection('stats_global').doc('totals').get(),
      db.collection('stats_daily').orderBy('date', 'desc').limit(30).get(),
      db.collection('messages').orderBy('createdAt', 'desc').limit(20).get()
    ]);

    const global = globalSnap.exists ? globalSnap.data() : { totalMessages: 0, totalSessions: 0 };

    const daily = [];
    dailySnap.forEach(doc => daily.push({ id: doc.id, ...doc.data() }));

    const recent = [];
    recentSnap.forEach(doc => {
      const d = doc.data();
      recent.push({
        id: doc.id,
        area: d.area,
        userMessage: d.userMessage,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        durationMs: d.durationMs
      });
    });

    // Agrupar por area
    const byArea = {};
    daily.forEach(d => {
      byArea[d.area] = (byArea[d.area] || 0) + (d.count || 0);
    });

    res.json({ global, daily, recent, byArea });
  } catch (e) {
    console.error('stats error:', e);
    res.status(500).json({ error: 'Error al obtener estadisticas' });
  }
});

// Registrar o actualizar usuario
app.post('/api/user', async (req, res) => {
  const { userId, email, plan } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requerido' });
  try {
    const userRef = db.collection('users').doc(userId);
    const existing = await userRef.get();
    const isNew = !existing.exists;

    await userRef.set({
      email: email || null,
      plan: plan || 'free',
      ...(isNew ? { createdAt: admin.firestore.FieldValue.serverTimestamp(), messageCount: 0, sessionCount: 0 } : {}),
      active: true
    }, { merge: true });

    // Solo incrementar totalUsers si es un usuario nuevo
    if (isNew) {
      await db.collection('stats_global').doc('totals').set({
        totalUsers: admin.firestore.FieldValue.increment(1)
      }, { merge: true });
    }

    res.json({ success: true, isNew });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener estado del plan del usuario
app.get('/api/user/:userId/plan', async (req, res) => {
  try {
    const userPlan = await getUserPlan(req.params.userId);
    const limit = PLAN_LIMITS[userPlan.plan];
    res.json({
      plan: userPlan.plan,
      messagesUsed: userPlan.messagesUsed,
      limit: limit === Infinity ? null : limit,
      allowedAreas: PLAN_AREAS[userPlan.plan] || []
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LexBolivia backend corriendo en puerto ${PORT}`));
