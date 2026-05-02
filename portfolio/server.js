const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
// Trust proxy for correct secure cookies behind cPanel/Apache proxy
app.set('trust proxy', 1);

// Lightweight request logger (no external deps)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${ms}ms`);
  });
  next();
});
const PORT = process.env.PORT || 3000;

// Paths
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT);
const IMG_DIR = path.join(ROOT, 'assets', 'img');
const DB_PATH = path.join(ROOT, 'data.db');

// Ensure image category folders exist
['web', 'app', 'seo'].forEach((dir) => {
  const p = path.join(IMG_DIR, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// DB setup
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password_hash TEXT,
  email TEXT UNIQUE
)`);
db.exec(`CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  category TEXT CHECK(category IN ('web','app','seo')),
  image_path TEXT,
  live_url TEXT,
  sort_order INTEGER DEFAULT 0
)`);
// Try to add columns if they don't exist (better-sqlite3 doesn't have ALTER IF NOT EXISTS, so use try-catch)
try { db.exec('ALTER TABLE works ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email TEXT UNIQUE'); } catch {}

// Seed a default admin if none
const seedAdmin = async () => {
  const stmt = db.prepare('SELECT COUNT(*) as c FROM users');
  const row = stmt.get();
  if (row.c === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    const adminEmail = process.env.ADMIN_EMAIL || 'paulvictor433@gmail.com';
    const insertStmt = db.prepare('INSERT INTO users(username, password_hash, email) VALUES(?, ?, ?)');
    insertStmt.run(['admin', hash, adminEmail]);
    console.log('Seeded admin user: admin / admin123 with email', adminEmail);
  }
};
seedAdmin();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'portfolio-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    }
  })
);

// Static files
app.use(express.static(PUBLIC_DIR));

// Auth helpers
const requireAuth = (req, res, next) => {
  if (req.session && req.session.userId) return next();
  return res.redirect('/admin/login');
};

// Upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const cat = req.body.category;
      const dest = path.join(IMG_DIR, cat);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    } catch (err) {
      console.error('Upload destination error:', err);
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^\w.\- ]+/g, '');
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Admin pages (very minimal)
app.get('/admin/login', (_req, res) => {
  res.sendFile(path.join(ROOT, 'admin', 'login.html'));
});
app.get('/admin', requireAuth, (_req, res) => {
  res.sendFile(path.join(ROOT, 'admin', 'dashboard.html'));
});

// Auth APIs
app.post('/api/login', (req, res) => {
  const { username, password, email } = req.body;
  // Allow login by either username or email for convenience/migration
  const stmt = db.prepare('SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1');
  const user = stmt.get(username, email || '');
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  bcrypt.compare(password, user.password_hash).then(ok => {
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.regenerate((regenErr) => {
      if (regenErr) return res.status(500).json({ error: 'Session error' });
      req.session.userId = user.id;
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Session error' });
        res.json({ ok: true });
      });
    });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ userId: req.session.userId || null });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Diagnostics (temporary): checks perms and session
app.get('/api/diag', (_req, res) => {
  const result = { ROOT, PUBLIC_DIR, IMG_DIR, folders: {}, db: null };
  const cats = ['web','app','seo'];
  try {
    result.folders.baseExists = fs.existsSync(IMG_DIR);
    cats.forEach((c) => {
      const p = path.join(IMG_DIR, c);
      const exists = fs.existsSync(p);
      let canWrite = false;
      if (exists) {
        try {
          const testFile = path.join(p, '.perm_test');
          fs.writeFileSync(testFile, 'ok');
          fs.unlinkSync(testFile);
          canWrite = true;
        } catch { canWrite = false; }
      }
      result.folders[c] = { exists, canWrite };
    });
  } catch (e) {
    result.foldersError = String(e);
  }
  try {
    const stmt = db.prepare('SELECT 1 AS ok');
    const row = stmt.get();
    result.db = { ok: row && row.ok === 1, error: null };
  } catch (e) {
    result.db = { ok: false, error: String(e) };
  }
  res.json(result);
});

// Contact form mail endpoint
// Configure transport via env or fallback to disabled in dev
const mailTransport = (() => {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.warn('SMTP not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to enable contact emails.');
    return null;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for 587/STARTTLS
    auth: { user, pass },
  });
})();

app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields' });
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return res.status(400).json({ error: 'Invalid email' });
    if (!mailTransport) return res.status(503).json({ error: 'Email not configured' });
    const to = process.env.CONTACT_TO || process.env.ADMIN_EMAIL || 'paulvictor433@gmail.com';
    const info = await mailTransport.sendMail({
      from: `Portfolio Contact <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to,
      subject: `New contact from ${name}`,
      replyTo: `${name} <${email}>`,
      text: message,
      html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p>${message.replace(/\n/g,'<br>')}</p>`
    });
    console.log('Contact mail sent:', info.messageId);
    res.json({ ok: true });
  } catch (e) {
    console.error('Contact error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Works APIs
app.get('/api/works', (_req, res) => {
  try {
    const stmt = db.prepare("SELECT * FROM works ORDER BY category ASC, sort_order ASC, id DESC");
    const rows = stmt.all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/works', requireAuth, upload.single('image'), (req, res) => {
  try {
    const { title, category, live_url } = req.body;
    console.log('POST /api/works payload:', { title, category, hasFile: !!req.file });
    if (!req.file) return res.status(400).json({ error: 'Image is required' });
    if (!['web','app','seo'].includes(String(category))) return res.status(400).json({ error: 'Invalid category' });
    console.log('Uploaded file info:', {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
    });
    const imgRel = path.join('assets', 'img', category, path.basename(req.file.path)).replace(/\\/g, '/');
    console.log('Computed image relative path:', imgRel);
    const maxStmt = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM works WHERE category = ?');
    const row = maxStmt.get(category);
    const next = (row && typeof row.next === 'number') ? row.next : 0;
    const insertStmt = db.prepare('INSERT INTO works(title, category, image_path, live_url, sort_order) VALUES(?,?,?,?,?)');
    const result = insertStmt.run(title, category, imgRel, live_url || null, next);
    res.json({ id: result.lastInsertRowid, title, category, image_path: imgRel, live_url, sort_order: next });
  } catch (e) {
    console.error('POST /api/works error:', e);
    return res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/works/reorder', requireAuth, (req, res) => {
  const { category, ids } = req.body || {};
  if (!category || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid payload' });
  const cleanIds = ids
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (cleanIds.length === 0) return res.json({ ok: true, order: [] });
  db.serialize(() => {
    db.run('BEGIN');
    const stmt = db.prepare('UPDATE works SET sort_order = ? WHERE id = ? AND category = ?');
    cleanIds.forEach((id, idx) => stmt.run(idx, id, category));
    stmt.finalize((err) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: 'db error' });
      }
      db.run('COMMIT', (commitErr) => {
        if (commitErr) return res.status(500).json({ error: 'db error' });
        db.all(
          'SELECT id, sort_order FROM works WHERE category = ? ORDER BY sort_order ASC',
          [category],
          (selErr, rows) => {
            if (selErr) return res.status(500).json({ error: 'db error' });
            res.json({ ok: true, order: rows });
          }
        );
      });
    });
  });
});

app.delete('/api/works/:id', requireAuth, (req, res) => {
  db.run('DELETE FROM works WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: 'db error' });
    res.json({ ok: this.changes > 0 });
  });
});

// Edit work (title/category/live_url and optional image replace)
app.post('/api/works/:id/edit', requireAuth, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { title, category, live_url } = req.body;
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const updateWithImage = !!req.file;
  let imgRel = null;
  if (updateWithImage) {
    imgRel = path.join('assets', 'img', category, path.basename(req.file.path)).replace(/\\/g, '/');
  }

  // If category changes, move to end of that category
  const runUpdate = () => {
    const sql = updateWithImage
      ? 'UPDATE works SET title = ?, category = ?, live_url = ?, image_path = ?, sort_order = ? WHERE id = ?'
      : 'UPDATE works SET title = ?, category = ?, live_url = ?, sort_order = ? WHERE id = ?';
    db.run(sql, updateWithImage ? [title, category, live_url || null, imgRel, nextOrder, id] : [title, category, live_url || null, nextOrder, id], function (err) {
      if (err) return res.status(500).json({ error: 'db error' });
      db.get('SELECT * FROM works WHERE id = ?', [id], (selErr, row) => {
        if (selErr) return res.status(500).json({ error: 'db error' });
        res.json({ ok: true, work: row });
      });
    });
  };

  let nextOrder = 0;
  db.get('SELECT COALESCE(MAX(sort_order), -1) + 1 as next FROM works WHERE category = ?', [category], (err, row) => {
    nextOrder = (!err && row && typeof row.next === 'number') ? row.next : 0;
    runUpdate();
  });
});

// Change credentials (username, email, password)
app.post('/api/change-credentials', requireAuth, (req, res) => {
  const { current_password, new_username, new_email, new_password } = req.body || {};
  if (!current_password || !new_username || !new_email || !new_password) return res.status(400).json({ error: 'Missing fields' });
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(new_email);
  if (!emailOk) return res.status(400).json({ error: 'Invalid email' });
  if (new_username.length < 3) return res.status(400).json({ error: 'Username too short' });
  if (new_password.length < 8 || !/[0-9]/.test(new_password) || !/[A-Za-z]/.test(new_password)) return res.status(400).json({ error: 'Weak password' });
  db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], async (err, user) => {
    if (err || !user) return res.status(500).json({ error: 'User not found' });
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    db.run('UPDATE users SET username = ?, password_hash = ?, email = ? WHERE id = ?', [new_username, hash, new_email, req.session.userId], function (uErr) {
      if (uErr) {
        const msg = String(uErr);
        if (msg.includes('UNIQUE') && msg.includes('username')) return res.status(409).json({ error: 'Username already taken' });
        if (msg.includes('UNIQUE') && msg.includes('email')) return res.status(409).json({ error: 'Email already in use' });
        return res.status(500).json({ error: 'Update failed' });
      }
      res.json({ ok: true });
    });
  });
});

// Admin static
app.use('/admin', express.static(path.join(ROOT, 'admin')));

// Global error handler to surface stack traces in logs
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err && (err.stack || err));
  if (err && err.name === 'MulterError') {
    console.error('Upload error details:', { code: err.code, field: err.field, storageErrors: err.storageErrors });
    if (!res.headersSent) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image too large (max 10MB)' });
      return res.status(400).json({ error: 'Upload error' });
    }
    return;
  }
  if (!res.headersSent) res.status(500).json({ error: 'server error' });
});

// Catch unhandled promise rejections and exceptions
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));


