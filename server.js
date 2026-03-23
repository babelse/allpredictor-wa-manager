// server-whatsapp.js — AllPredictor WhatsApp Bot Manager (Baileys) 
const express   = require('express');
const multer    = require('multer');
const { spawn } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const qrcode    = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 8081;

// ── CORS ──
app.use(function(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// ── Health check ──
app.get('/', function(req, res) {
  res.json({ status: 'AllPredictor WhatsApp Manager ✅', bots: Object.keys(runningBots).length });
});

// ── PERSISTANCE ──
const BOTS_DIR      = './wa_bots';
const REGISTRY_FILE = path.join(BOTS_DIR, 'registry.json');

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE))
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch(e) {}
  return {};
}

function saveRegistry(registry) {
  try {
    fs.mkdirSync(BOTS_DIR, { recursive: true });
    const toSave = {};
    for (const [id, bot] of Object.entries(registry)) {
      toSave[id] = { botId: bot.botId, userId: bot.userId, filename: bot.filename, name: bot.name, startedAt: bot.startedAt };
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(toSave, null, 2));
  } catch(e) { console.error('Erreur registry:', e.message); }
}

const runningBots = {};

// ── Wrapper bot WhatsApp ─────────────────────────────────────
// Chaque bot utilisateur est lancé avec un wrapper Baileys qui :
// 1. Gère la connexion WhatsApp (QR, session)
// 2. Importe et appelle le code du bot utilisateur
// 3. Expose le numéro connecté via IPC stdout

function generateWrapper(botId, filename, lang) {
  const isPy = lang === 'py';
  if (isPy) {
    // Pour Python : on génère un wrapper Node qui lance le script Python
    // avec la session Baileys comme variable d'environnement
    return `
// wrapper.js — généré automatiquement pour ${filename}
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const P    = require('pino');

const BOT_ID   = '${botId}';
const BOT_DIR  = path.dirname(__filename);
const AUTH_DIR = path.join(BOT_DIR, 'auth');
const USER_FILE = path.join(BOT_DIR, '${filename}');

let childProc = null;

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // Envoyer le QR au manager via stdout pour le transmettre au dashboard
      process.stdout.write('QR:' + qr + '\\n');
    }
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || 'inconnu';
      process.stdout.write('CONNECTED:' + phone + '\\n');
      console.log('[OK] WhatsApp connecté — ' + phone);
      // Lancer le script Python avec les infos de session
      if (!childProc) {
        childProc = spawn('python3', [USER_FILE], {
          env: { ...process.env, WA_BOT_ID: BOT_ID, WA_PHONE: phone },
          stdio: ['pipe', 'pipe', 'pipe']
        });
        childProc.stdout.on('data', d => console.log(d.toString().trim()));
        childProc.stderr.on('data', d => console.error('[ERR]', d.toString().trim()));
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('[WARN] Connexion fermée, code:', code, '| reconnexion:', shouldReconnect);
      if (shouldReconnect) setTimeout(startWA, 3000);
      else process.stdout.write('LOGGED_OUT\\n');
    }
  });

  // Exposer sock globalement pour que le bot puisse envoyer des messages
  global._waSock = sock;

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const from = msg.key.remoteJid;
      // Commandes de base
      if (body === '/ping') {
        await sock.sendMessage(from, { text: '🟢 Bot AllPredictor actif !' });
      }
    }
  });
}

startWA().catch(e => { console.error('[ERR] Démarrage WA:', e.message); process.exit(1); });
`;
  }

  // Pour JS : le bot utilisateur reçoit sock directement
  return `
// wrapper.js — généré automatiquement pour ${filename}
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');
const P    = require('pino');

const BOT_ID   = '${botId}';
const BOT_DIR  = path.dirname(__filename);
const AUTH_DIR = path.join(BOT_DIR, 'auth');

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      process.stdout.write('QR:' + qr + '\\n');
    }
    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || 'inconnu';
      process.stdout.write('CONNECTED:' + phone + '\\n');
      console.log('[OK] WhatsApp connecté — ' + phone);
      // Charger et lancer le bot utilisateur avec sock
      try {
        const userBot = require('./${filename}');
        if (typeof userBot === 'function') await userBot(sock);
        else if (typeof userBot.start === 'function') await userBot.start(sock);
        else if (typeof userBot.default === 'function') await userBot.default(sock);
      } catch(e) { console.error('[ERR] Bot utilisateur:', e.message); }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startWA, 3000);
      else process.stdout.write('LOGGED_OUT\\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const from = msg.key.remoteJid;
      if (body === '/ping') {
        await sock.sendMessage(from, { text: '🟢 Bot AllPredictor actif !' });
      }
    }
  });
}

startWA().catch(e => { console.error('[ERR] Démarrage WA:', e.message); process.exit(1); });
`;
}

// ── Spawn bot WhatsApp ──
function spawnBot(botId, userId) {
  const dir = path.join(BOTS_DIR, botId);
  if (!fs.existsSync(dir)) { console.error('Dossier introuvable:', dir); return null; }

  const files = fs.readdirSync(dir).filter(f => f !== 'wrapper.js' && (f.endsWith('.js') || f.endsWith('.py')));
  if (!files.length) { console.error('Aucun fichier bot dans:', dir); return null; }

  const filename = files[0];
  const ext      = path.extname(filename).toLowerCase().replace('.', '');
  const wrapper  = path.join(dir, 'wrapper.js');

  // (Re)générer le wrapper
  fs.writeFileSync(wrapper, generateWrapper(botId, filename, ext));

  const env  = { ...process.env, BOT_ID: botId };
  const proc = spawn('node', [wrapper], { env, detached: false, cwd: dir });

  runningBots[botId] = {
    process: proc, pid: proc.pid, status: 'connecting',
    userId, filename, botId,
    qr: null, phone: null,
    startedAt: new Date().toISOString(), logs: [],
  };

  const pushLog = (msg) => {
    if (!runningBots[botId]) return;
    runningBots[botId].logs.push({ t: new Date().toISOString(), msg: msg.slice(0, 500) });
    if (runningBots[botId].logs.length > 200) runningBots[botId].logs.shift();
  };

  let qrBuffer = '';

  proc.stdout.on('data', async (d) => {
    const str = d.toString();
    qrBuffer += str;

    // Parser les lignes spéciales
    const lines = qrBuffer.split('\n');
    qrBuffer = lines.pop(); // garder le fragment incomplet

    for (const line of lines) {
      if (line.startsWith('QR:')) {
        const qrData = line.slice(3).trim();
        try {
          // Convertir en image base64
          const qrImage = await qrcode.toDataURL(qrData, { width: 300, margin: 2 });
          if (runningBots[botId]) runningBots[botId].qr = qrImage;
          console.log('[QR] Nouveau QR code généré pour', botId);
        } catch(e) { console.error('Erreur QR:', e.message); }
      } else if (line.startsWith('CONNECTED:')) {
        const phone = line.slice(10).trim();
        if (runningBots[botId]) {
          runningBots[botId].status  = 'running';
          runningBots[botId].phone   = phone;
          runningBots[botId].qr      = null; // effacer le QR une fois connecté
        }
        console.log('[OK] Bot', botId, 'connecté au numéro', phone);
        pushLog('[OK] Connecté au numéro +' + phone);
        // Sauvegarder le numéro dans le registry
        const reg = loadRegistry();
        if (reg[botId]) { reg[botId].phone = phone; saveRegistry(reg); }
      } else if (line.startsWith('LOGGED_OUT')) {
        if (runningBots[botId]) runningBots[botId].status = 'logged_out';
        pushLog('[WARN] Déconnecté — rescannez le QR code');
      } else if (line.trim()) {
        pushLog(line.trim());
      }
    }
  });

  proc.stderr.on('data', d => pushLog('[ERR] ' + d.toString().trim()));
  proc.on('exit', code => {
    if (runningBots[botId]) runningBots[botId].status = 'stopped';
    console.log('Bot WA', botId, 'stoppé, code:', code);
  });
  proc.on('error', err => {
    if (runningBots[botId]) { runningBots[botId].status = 'stopped'; pushLog('[ERR] ' + err.message); }
  });

  return proc;
}

// ── Restaurer au démarrage ──
function restoreAllBots() {
  const registry = loadRegistry();
  const entries  = Object.entries(registry);
  if (!entries.length) return;
  console.log('Restauration de', entries.length, 'bot(s) WA...');
  for (const [botId, meta] of entries) {
    try {
      const proc = spawnBot(botId, meta.userId);
      console.log(proc ? 'Bot WA restauré: ' + botId : 'Fichier manquant: ' + botId);
    } catch(e) { console.error('Erreur restauration WA', botId, ':', e.message); }
  }
}

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: function(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.js' || ext === '.py') cb(null, true);
    else cb(new Error('Seuls .js et .py sont acceptés'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ══════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════

// ── Déployer ──
app.post('/api/wa/deploy', upload.single('file'), function(req, res) {
  const { botId, userId, name } = req.body;
  if (!botId || !userId || !req.file) {
    return res.status(400).json({ success: false, error: 'botId, userId et fichier requis' });
  }

  const botDir   = path.join(BOTS_DIR, botId);
  const filePath = path.join(botDir, req.file.originalname);

  try {
    fs.mkdirSync(botDir, { recursive: true });
    fs.mkdirSync(path.join(botDir, 'auth'), { recursive: true });
    fs.writeFileSync(filePath, req.file.buffer);
  } catch(e) {
    return res.status(500).json({ success: false, error: 'Erreur écriture: ' + e.message });
  }

  // Installer Baileys dans le dossier si pas déjà là
  if (!fs.existsSync(path.join(botDir, 'node_modules'))) {
    const installProc = spawn('npm', ['install', '@whiskeysockets/baileys', 'pino', 'qrcode'], {
      cwd: botDir, stdio: 'pipe',
    });
    installProc.on('close', () => {
      console.log('[OK] Baileys installé pour', botId);
    });
    // Créer un package.json minimal
    fs.writeFileSync(path.join(botDir, 'package.json'), JSON.stringify({
      name: botId, version: '1.0.0', main: 'wrapper.js',
      dependencies: { '@whiskeysockets/baileys': 'latest', 'pino': 'latest', 'qrcode': 'latest' },
    }, null, 2));
  }

  const registry = loadRegistry();
  registry[botId] = { botId, userId, name: name || req.file.originalname, filename: req.file.originalname, startedAt: new Date().toISOString() };
  saveRegistry(registry);

  if (runningBots[botId]) {
    try { runningBots[botId].process.kill('SIGTERM'); } catch(e) {}
    delete runningBots[botId];
  }

  // Lancer après installation (délai si première fois)
  const delay = fs.existsSync(path.join(botDir, 'node_modules')) ? 0 : 8000;
  setTimeout(() => {
    const proc = spawnBot(botId, userId);
    if (!proc) console.error('Impossible de lancer le bot WA', botId);
  }, delay);

  res.json({ success: true, botId, status: 'connecting', message: 'Bot déployé. Scannez le QR code dans quelques secondes.' });
});

// ── QR code ──
app.get('/api/wa/qr/:botId', function(req, res) {
  const bot = runningBots[req.params.botId];
  if (!bot) return res.json({ qr: null, status: 'not_found' });
  res.json({ qr: bot.qr, status: bot.status, phone: bot.phone });
});

// ── Statut ──
app.get('/api/wa/status/:botId', function(req, res) {
  const bot = runningBots[req.params.botId];
  if (!bot) return res.json({ status: 'not_found' });
  res.json({ status: bot.status, pid: bot.pid, phone: bot.phone, startedAt: bot.startedAt });
});

// ── Logs ──
app.get('/api/wa/logs/:botId', function(req, res) {
  const bot = runningBots[req.params.botId];
  if (!bot) return res.json({ logs: [] });
  res.json({ logs: bot.logs });
});

// ── Stop ──
app.post('/api/wa/stop', function(req, res) {
  const { botId } = req.body;
  const bot = runningBots[botId];
  if (!bot || bot.status === 'stopped') return res.json({ success: true, status: 'already_stopped' });
  try { bot.process.kill('SIGTERM'); bot.status = 'stopped'; res.json({ success: true }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Restart ──
app.post('/api/wa/restart', function(req, res) {
  const { botId } = req.body;
  const existing = runningBots[botId];
  if (existing) { try { existing.process.kill('SIGTERM'); } catch(e) {} }
  const registry = loadRegistry();
  const meta     = registry[botId];
  if (!meta) return res.status(404).json({ success: false, error: 'Bot introuvable' });
  setTimeout(() => {
    const proc = spawnBot(botId, meta.userId);
    if (!proc) return res.status(500).json({ success: false, error: 'Impossible de relancer' });
    res.json({ success: true, status: 'connecting' });
  }, 1000);
});

// ── Supprimer ──
app.delete('/api/wa/:botId', function(req, res) {
  const { botId } = req.params;
  const bot = runningBots[botId];
  if (bot) { try { bot.process.kill('SIGTERM'); } catch(e) {} }
  delete runningBots[botId];
  const registry = loadRegistry();
  delete registry[botId];
  saveRegistry(registry);
  const dir = path.join(BOTS_DIR, botId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ success: true });
});

// ── Bots par user ──
app.get('/api/wa/user/:userId', function(req, res) {
  const bots = Object.entries(runningBots)
    .filter(([, b]) => b.userId === req.params.userId)
    .map(([id, b]) => ({ id, status: b.status, phone: b.phone, startedAt: b.startedAt, filename: b.filename }));
  res.json({ bots });
});

// ── Démarrer ──
app.listen(PORT, '0.0.0.0', function() {
  console.log('🚀 WA Bot Manager démarré sur le port ' + PORT);
  setTimeout(function() {
    try { restoreAllBots(); } catch(e) { console.error('Restore WA failed:', e.message); }
  }, 3000);
});
