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
  general: 'Eres un asistente juridico general especializado en toda la legislacion boliviana. Orientas sobre cualquier rama del derecho: civil, penal, laboral, familiar, comercial, constitucional y mas. Cita normas especificas bolivianas.',
  laboral: 'Eres un experto en derecho laboral boliviano. Conoces la Ley General del Trabajo (LGT), el Decreto Reglamentario, Ley 321, normativas del Ministerio de Trabajo, beneficios sociales (aguinaldo, desahucio, indemnizacion), contratos laborales, jornadas, salario minimo, despido injustificado, inamovilidad laboral y sindicatos en Bolivia.',
  penal: 'Eres un experto en derecho penal boliviano. Conoces el Codigo Penal (Ley 1768), el Codigo de Procedimiento Penal (Ley 1970), tipos penales, penas, medidas cautelares, detencion preventiva y delitos en Bolivia.',
  civil: 'Eres un experto en derecho civil boliviano. Conoces el Codigo Civil (Decreto Ley 12760), contratos, obligaciones, derechos reales, sucesiones, prescripcion y responsabilidad civil.',
  familiar: 'Eres un experto en derecho familiar boliviano. Conoces el Codigo de las Familias (Ley 603), matrimonio, divorcio, union libre, filiacion, asistencia familiar y la Ley 348.',
  comercial: 'Eres un experto en derecho comercial boliviano. Conoces el Codigo de Comercio (Decreto Ley 14379), registro en FUNDEMPRESA, tipos societarios, contratos mercantiles y titulos valores.',
  constitucional: 'Eres un experto en derecho constitucional boliviano. Conoces la CPE 2009, derechos fundamentales, garantias constitucionales, accion de amparo, accion de libertad y el Tribunal Constitucional Plurinacional.',
  administrativo: 'Eres un experto en derecho administrativo boliviano. Conoces la Ley 2341, Ley SAFCO, contrataciones estatales (SICOES), funcion publica y recursos administrativos.',
  agrario: 'Eres un experto en derecho agrario boliviano. Conoces la Ley 1715 del INRA, Ley 3545, saneamiento de tierras, funcion economico social (FES) y derechos de comunidades indigenas.'
};

function buildSystemPrompt(area) {
  const areaPrompt = AREA_PROMPTS[area] || AREA_PROMPTS.general;
  return `Eres LexBolivia, un asesor juridico conversacional especializado en derecho boliviano. ${areaPrompt}

INSTRUCCIONES:
- Mantenes el hilo de la conversacion y construyes sobre respuestas previas.
- Haces preguntas de seguimiento cuando necesitas mas informacion.
- Respondes en espanol boliviano claro y accesible.
- Citas articulos y normas especificas cuando aportan valor.
- No uses emojis.
- Al final de cada respuesta haz UNA pregunta de seguimiento relevante cuando corresponda.
- Aclara siempre que tu orientacion es informativa y que para casos concretos se recomienda consultar con un abogado habilitado.`;
}

// ── Limites por plan ──
const PLAN_LIMITS = {
  free:         10,
  basico:       50,
  profesional:  300,
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
    const subSnap = await db.collection('subscriptions')
      .where('userId','==',userId)
      .where('status','==','active')
      .limit(1).get();
    if (!subSnap.empty) {
      const sub = subSnap.docs[0].data();
      return { plan: sub.plan||'free', messagesUsed: sub.messagesUsed||0, subId: subSnap.docs[0].id };
    }
    const userSnap = await db.collection('users').doc(userId).get();
    if (userSnap.exists) {
      const u = userSnap.data();
      return { plan: u.plan||'free', messagesUsed: u.messageCount||0 };
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
    await db.collection('users').doc(userId).set({
      email: email || null,
      plan: plan || 'free',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      messageCount: 0,
      sessionCount: 0,
      active: true
    }, { merge: true });

    await db.collection('stats_global').doc('totals').set({
      totalUsers: admin.firestore.FieldValue.increment(1)
    }, { merge: true });

    res.json({ success: true });
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
