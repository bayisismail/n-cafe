require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET;
const missingEnvironment = ['JWT_SECRET', 'ADMIN_PASSWORD', 'OPERATOR_PIN']
  .filter((name) => !process.env[name]);
if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missingEnvironment.join(', ')}. ` +
    'Add them in Render Dashboard > Environment > Environment Variables. ' +
    'JWT_SECRET must contain at least 32 random characters.'
  );
}
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 random characters.');
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'n-cafe-data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'n_cafe.db');
const allowedOrigin = process.env.ALLOWED_ORIGIN;
const rateBuckets = new Map();
const paymentIntents = new Map();

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors({
  origin: allowedOrigin || false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json({ limit: '256kb' }));

function rateLimit(windowMs, max, keyPrefix) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    const current = rateBuckets.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      rateBuckets.set(key, { startedAt: now, count: 1 });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - current.startedAt)) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

app.use(rateLimit(60 * 1000, 120, 'global'));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (/\.(?:db|sqlite|sqlite3|env|log|sql|zip|bak)$/i.test(req.path) ||
      req.path.startsWith('/.')) {
    return res.status(404).end();
  }
  const publicFiles = new Set([
    '/index.html',
    '/admin.html',
    '/scanner.html',
    '/app.js',
    '/customer.js',
    '/admin.js',
    '/scanner.js',
    '/theme.js',
    '/style.css'
  ]);
  if (!req.path.startsWith('/api/') && req.method === 'GET' &&
      !publicFiles.has(req.path) &&
      !/^\/assets\/[^/]+\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff2?)$/i.test(req.path)) {
    if (!['/', '/admin', '/scanner'].includes(req.path)) return res.status(404).end();
  }
  next();
});

// Serve static web pages
app.use(express.static(path.join(__dirname), {
  dotfiles: 'deny',
  index: false
}));

// --- DATABASE INITIALIZATION & SCHEMA CREATION ---
class DB {
  constructor() {
    this.isPostgres = false;
    this.queue = Promise.resolve();

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
      try {
        const { Client } = require('pg');
        this.isPostgres = true;
        this.pgClient = new Client({
          connectionString: dbUrl,
          ssl: {
            rejectUnauthorized: true,
            ca: process.env.DATABASE_CA
          }
        });
      } catch (err) {
        console.error("PostgreSQL driver ('pg') failed to load. Defaulting to SQLite.", err);
        this.isPostgres = false;
        this.sqliteDb = new sqlite3.Database(DB_PATH);
      }
    } else {
      this.sqliteDb = new sqlite3.Database(DB_PATH);
    }
  }

  normalizeRow(row) {
    if (!row) return row;
    const mapping = {
      customername: 'customerName',
      customerphone: 'customerPhone',
      totalamount: 'totalAmount',
      bookingtime: 'bookingTime',
      expirytime: 'expiryTime',
      redeemedtime: 'redeemedTime',
      paymentmethod: 'paymentMethod',
      paymentstatus: 'paymentStatus',
      fooditemid: 'foodItemId',
      lastpurchasedate: 'lastPurchaseDate'
    };
    const newRow = {};
    for (const key in row) {
      if (mapping[key]) {
        newRow[mapping[key]] = row[key];
      } else {
        newRow[key] = row[key];
      }
    }
    return newRow;
  }

  connect(callback) {
    if (this.isPostgres) {
      this.pgClient.connect((err) => {
        if (err) {
          console.error("Failed to connect to PostgreSQL:", err);
          callback(err);
        } else {
          console.log("Connected to PostgreSQL database successfully.");
          callback(null);
        }
      });
    } else {
      console.log("Connected to SQLite database at:", DB_PATH);
      callback(null);
    }
  }

  translateQuery(sql) {
    if (!this.isPostgres) return sql;

    let translated = sql;

    // Translate SQLite UPSERT (INSERT OR REPLACE) to PostgreSQL ON CONFLICT DO UPDATE
    if (translated.toUpperCase().includes('INSERT OR REPLACE INTO')) {
      translated = translated.replace(/INSERT OR REPLACE INTO/i, 'INSERT INTO');
      translated += ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
    }

    // Replace "?" placeholders with "$1", "$2", etc. for Postgres
    let index = 1;
    while (translated.includes('?')) {
      translated = translated.replace('?', '$' + index);
      index++;
    }

    return translated;
  }

  serialize(cb) {
    if (this.isPostgres) {
      cb();
    } else {
      this.sqliteDb.serialize(cb);
    }
  }

  run(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (cb) cb(err);
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.run(sql, params, cb);
    }
  }

  get(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (err) {
              if (cb) cb(err);
            } else {
              const row = res.rows ? res.rows[0] : null;
              if (cb) cb(null, this.normalizeRow(row));
            }
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.get(sql, params, cb);
    }
  }

  all(sql, params, cb) {
    if (typeof params === 'function') {
      cb = params;
      params = [];
    }
    params = params || [];
    const translatedSql = this.translateQuery(sql);

    if (this.isPostgres) {
      this.queue = this.queue.then(() => {
        return new Promise((resolve) => {
          this.pgClient.query(translatedSql, params, (err, res) => {
            if (err) {
              if (cb) cb(err);
            } else {
              const rows = (res.rows || []).map(r => this.normalizeRow(r));
              if (cb) cb(null, rows);
            }
            resolve();
          });
        });
      });
    } else {
      this.sqliteDb.all(sql, params, cb);
    }
  }

  prepare(sql) {
    const translatedSql = this.translateQuery(sql);
    const self = this;

    if (this.isPostgres) {
      return {
        run(params, cb) {
          self.pgClient.query(translatedSql, params, (err) => {
            if (cb) cb(err);
          });
        },
        finalize(cb) {
          if (cb) cb();
        }
      };
    } else {
      const stmt = this.sqliteDb.prepare(sql);
      return {
        run(params, cb) {
          stmt.run(params, cb);
        },
        finalize(cb) {
          stmt.finalize(cb);
        }
      };
    }
  }
}

const db = new DB();

db.connect((err) => {
  if (err) {
    console.error('Failed to initialize database connection:', err);
  } else {
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // 1. Food Items Table
    db.run(`CREATE TABLE IF NOT EXISTS food_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL,
      category TEXT NOT NULL,
      isveg TEXT NOT NULL,
      image TEXT NOT NULL,
      details TEXT,
      listed INTEGER NOT NULL DEFAULT 1
    )`);

    // Migration: Add offer_price column if it does not exist
    db.run("ALTER TABLE food_items ADD COLUMN offer_price REAL DEFAULT NULL", (err) => {
      // Ignore error if column already exists
    });
    db.run("ALTER TABLE food_items ADD COLUMN listed INTEGER NOT NULL DEFAULT 1", (err) => {
      // Ignore error if column already exists
    });

    // 2. Bookings Table
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      customerName TEXT NOT NULL,
      customerPhone TEXT NOT NULL,
      passkey TEXT NOT NULL,
      items TEXT NOT NULL, -- JSON string
      totalAmount REAL NOT NULL,
      paymentMethod TEXT NOT NULL,
      paymentStatus TEXT NOT NULL,
      bookingTime TEXT NOT NULL,
      expiryTime TEXT NOT NULL,
      status TEXT NOT NULL, -- pending, redeemed, expired
      redeemedTime TEXT
    )`);

    // 3. Transactions (Cash Ledger) Table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- sale, purchase, expense
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT
    )`);

    // 4. Ingredients Table
    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stock REAL NOT NULL,
      unit TEXT NOT NULL,
      lastPurchaseDate TEXT
    )`);

    // 5. Temporary Stock Locks Table (Note: BIGINT support for Postgres millisecond timestamps)
    db.run("DROP TABLE IF EXISTS locks");
    db.run(`CREATE TABLE IF NOT EXISTS locks (
      id TEXT,
      foodItemId TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      expiryTime BIGINT NOT NULL,
      PRIMARY KEY (id, foodItemId)
    )`);

    // 6. Settings Table
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // --- SEED INITIAL DATA IF EMPTY ---
    seedDatabase();
  });
}

function seedDatabase() {
  db.get("SELECT value FROM settings WHERE key = 'food_listing_migration_v1'", (migrationErr, migrationRow) => {
    if (migrationErr) {
      console.error('Failed to check food listing migration:', migrationErr);
    } else if (!migrationRow) {
      db.run("UPDATE food_items SET listed = 1", (updateErr) => {
        if (updateErr) {
          console.error('Failed to normalize legacy food visibility:', updateErr);
          return;
        }
        db.run(
          "INSERT INTO settings (key, value) VALUES ('food_listing_migration_v1', 'completed')",
          (insertErr) => {
            if (insertErr) console.error('Failed to record food listing migration:', insertErr);
          }
        );
      });
    }
  });

  db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err) return console.error(err);
    if (parseInt(row.count, 10) === 0) {
      if (!process.env.ADMIN_PASSWORD || !process.env.OPERATOR_PIN) {
        return console.error('ADMIN_PASSWORD and OPERATOR_PIN must be configured before first startup.');
      }
      console.log('Seeding configured security credentials and settings...');
      const salt = bcrypt.genSaltSync(10);
      const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, salt);
      const scannerHash = bcrypt.hashSync(process.env.OPERATOR_PIN, salt);

      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password', ?)", [adminHash]);
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('scanner_pin', ?)", [scannerHash]);

      const defaultAcc = {
        name: 'N Cafe Hills Kitchen Services',
        bank: 'State Bank of India',
        accNo: '39485710293',
        ifsc: 'SBIN0008472',
        upiId: 'ncafe.canteen@okaxis',
        ticketExpiryHours: 5,
        logoImage: '',
        heroBannerImage: '',
        logoBackgroundColor: '#1b4d3e'
      };
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('account_details', ?)", [JSON.stringify(defaultAcc)]);
    }
  });

  // Seed special offer default configuration if missing
  db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'special_offer'", (err, row) => {
    if (err) return console.error(err);
    if (!row || parseInt(row.count, 10) === 0) {
      console.log('Seeding default special offer banner settings...');
      const defaultOffer = {
        active: false,
        title: 'Special Hills Combo',
        desc: 'Masala Dosa + Misty Hills Filter Coffee combo at a special discount!',
        price: 90,
        image: 'assets/south_indian_meals.png'
      };
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_offer', ?)", [JSON.stringify(defaultOffer)]);
    }
  });

  db.serialize(() => {
    const defaultFoods = [
      ['FD-101', 'Masala Dosa Special', 80, 20, 'Breakfast', 'Veg', 'masala_dosa.png', 'Crispy dosa with potato filling served with sambar and coconut chutney.'],
      ['FD-102', 'Idli Sambar (2 Pcs)', 50, 15, 'Breakfast', 'Veg', 'idli_sambar.png', 'Soft steamed rice cakes served with hot sambar and tomato chutney.'],
      ['FD-103', 'Misty Hills Filter Coffee', 30, 40, 'Beverages', 'Veg', 'filter_coffee.png', 'Traditional South Indian frothy chicory blended coffee.'],
      ['FD-104', 'Vada Sambar Combo', 60, 25, 'Breakfast', 'Veg', 'vada_combo.png', 'Crispy fried lentil donuts served with side sambar and dips.'],
      ['FD-105', 'Nilgiri South Indian Meals', 120, 15, 'Lunch', 'Veg', 'south_indian_meals.png', 'Traditional South Indian mini meals with rice, sambar, rasam, poriyal, appalam, and curd.'],
      ['FD-106', 'Steaming Hot Rava Dosa', 90, 15, 'Dinner', 'Veg', 'rava_dosa.png', 'Crispy semolina dosa spiced with black pepper, cumin, and green chillies.']
    ];
    defaultFoods.forEach(food => {
      db.get("SELECT COUNT(*) as count FROM food_items WHERE id = ?", [food[0]], (err, checkRow) => {
        if (!err && checkRow && parseInt(checkRow.count, 10) === 0) {
          console.log(`Seeding default food item: ${food[1]}`);
          db.run("INSERT INTO food_items (id, name, price, stock, category, isveg, image, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", food);
        }
      });
    });
  });

  db.get("SELECT COUNT(*) as count FROM ingredients", (err, row) => {
    if (err) return console.error(err);
    if (parseInt(row.count, 10) === 0) {
      console.log('Seeding default ingredients...');
      const defaultIngs = [
        ['ING-001', 'Rice Dosa Batter', 15.5, 'kg', new Date().toISOString()],
        ['ING-002', 'Filter Coffee Beans', 5.0, 'kg', new Date().toISOString()],
        ['ING-003', 'Sambhar Spices & Masala', 8.2, 'kg', new Date().toISOString()],
        ['ING-004', 'Lentil Vada Batter', 10.0, 'kg', new Date().toISOString()]
      ];
      const stmt = db.prepare("INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)");
      defaultIngs.forEach(ing => stmt.run(ing));
      stmt.finalize();
    }
  });
}

function cleanText(value, maxLength) {
      if (typeof value !== 'string') return null;
      const text = value.replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      return text && text.length <= maxLength ? text : null;
}

function validPhone(value) {
      return typeof value === 'string' && /^[0-9]{10,15}$/.test(value);
}

function normalizeBookingItems(items, catalog) {
      if (!Array.isArray(items) || items.length < 1 || items.length > 30) return null;
      const normalized = [];
      for (const item of items) {
        const id = cleanText(item && item.foodItemId, 32);
        const quantity = Number(item && item.quantity);
        if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) return null;
        const food = catalog.find(entry => entry.id === id);
        if (!food) return null;
        normalized.push({
          foodItemId: food.id,
          name: food.name,
          quantity,
          price: Number(food.offerPrice && food.offerPrice < food.price ? food.offerPrice : food.price)
        });
      }
      return normalized;
}

// --- SECURE JWT AUTHENTICATION MIDDLEWARE ---
function authenticateToken(allowedRoles = []) {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Token expired or invalid.' });
      }
      
      if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
        return res.status(403).json({ error: 'Unauthorized role.' });
      }

      req.user = user;
      next();
    });
  };
}

// --- BACKGROUND EXPIRED HOLDS CLEANUP ---
setInterval(() => {
  const now = Date.now();
  db.run("DELETE FROM locks WHERE expiryTime < ?", [now], function(err) {
    if (err) console.error("Error pruning expired locks:", err);
  });
}, 10000); // Clean up locks every 10 seconds

// --- SECURE ROUTING & HTML SERVING ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'scanner.html'));
});

// --- API AUTH ENDPOINTS ---

// Admin Login
app.post('/api/auth/login-admin', rateLimit(15 * 60 * 1000, 10, 'admin-login'), (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password required.' });
  }

  db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(password, row.value);
    if (match) {
      const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Incorrect Admin Password.' });
    }
  });
});

// Operator Login
app.post('/api/auth/login-operator', rateLimit(15 * 60 * 1000, 20, 'operator-login'), (req, res) => {
  const { pin } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'PIN required.' });
  }

  db.get("SELECT value FROM settings WHERE key = 'scanner_pin'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(pin, row.value);
    if (match) {
      const token = jwt.sign({ role: 'operator' }, JWT_SECRET, { expiresIn: '12h' });
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Incorrect Operator PIN.' });
    }
  });
});

// Change Security Credentials (Admin auth required)
app.post('/api/auth/change-credentials', authenticateToken(['admin']), (req, res) => {
  const { currentPassword, password, pin } = req.body;
  if (!currentPassword || !password || !pin) {
    return res.status(400).json({ error: 'Current password, new password, and PIN are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Admin password must be at least 6 characters.' });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'Operator PIN must be exactly 4 digits.' });
  }

  // Verify current password first
  db.get("SELECT value FROM settings WHERE key = 'admin_password'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Database error.' });
    }
    const match = bcrypt.compareSync(currentPassword, row.value);
    if (!match) {
      return res.status(401).json({ error: 'Incorrect current Admin password (security key mismatch).' });
    }

    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const pinHash = bcrypt.hashSync(pin, salt);

    db.serialize(() => {
      db.run("UPDATE settings SET value = ? WHERE key = 'admin_password'", [passwordHash]);
      db.run("UPDATE settings SET value = ? WHERE key = 'scanner_pin'", [pinHash], (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to update credentials.' });
        }
        res.json({ success: true, message: 'Security credentials updated successfully.' });
      });
    });
  });
});

// Admin Image Upload Endpoint (Admin only)
app.post('/api/upload-image', authenticateToken(['admin']), (req, res) => {
  const { imageName, base64Data } = req.body;
  if (!imageName || !base64Data) {
    return res.status(400).json({ error: 'Missing parameters.' });
  }

  try {
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Clean, 'base64');
    
    const originalName = path.basename(imageName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const safeName = `${baseName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const targetPath = path.join(__dirname, 'assets', safeName);

    fs.writeFile(targetPath, buffer, (err) => {
      if (err) {
        console.error("Failed to write image file:", err);
        return res.status(500).json({ error: 'Failed to save image file on server.' });
      }
      res.json({ success: true, imagePath: `assets/${safeName}` });
    });
  } catch (e) {
    console.error("Image upload parsing error:", e);
    res.status(500).json({ error: 'Failed to process image data.' });
  }
});

// --- API ACCOUNT SETTINGS ENDPOINTS ---

// Get Settings (Public bank info + credentials metadata)
app.get('/api/settings', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: 'Failed to retrieve settings.' });
    }
    res.json(JSON.parse(row.value));
  });
});

// Save Account Details (Admin auth required)
app.post('/api/settings', authenticateToken(['admin']), (req, res) => {
  const { name, bank, accNo, ifsc, upiId, ticketExpiryHours, logoImage, heroBannerImage, logoBackgroundColor } = req.body;
  if (!name || !bank || !accNo || !ifsc || !upiId) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const safeImagePath = (value) => typeof value === 'string' && /^assets\/[A-Za-z0-9._-]+$/.test(value) ? value : '';
  const safeColor = (value) => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : '#1b4d3e';
  const newAcc = {
    name,
    bank,
    accNo,
    ifsc,
    upiId,
    ticketExpiryHours: ticketExpiryHours ? parseInt(ticketExpiryHours, 10) : 5,
    logoImage: safeImagePath(logoImage),
    heroBannerImage: safeImagePath(heroBannerImage),
    logoBackgroundColor: safeColor(logoBackgroundColor)
  };
  db.run("UPDATE settings SET value = ? WHERE key = 'account_details'", [JSON.stringify(newAcc)], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to save account settings.' });
    }
    res.json({ success: true, message: 'Account details saved successfully.' });
  });
});

// Get Special Offer (Public)
app.get('/api/special-offer', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'special_offer'", (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to retrieve special offer settings.' });
    }
    if (!row) {
      const defaultOffer = {
        active: false,
        title: 'Special Hills Combo',
        desc: 'Masala Dosa + Misty Hills Filter Coffee combo at a special discount!',
        price: 90,
        image: 'assets/south_indian_meals.png'
      };
      return res.json(defaultOffer);
    }
    try {
      const offer = JSON.parse(row.value);
      res.json(offer);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse special offer settings.' });
    }
  });
});

// Save Special Offer (Admin only)
app.post('/api/special-offer', authenticateToken(['admin']), (req, res) => {
  const { active, title, desc, price, image } = req.body;
  if (title === undefined || price === undefined) {
    return res.status(400).json({ error: 'Missing title or price.' });
  }

  const offerData = {
    active: !!active,
    title,
    desc: desc || '',
    price: Number(price) || 0,
    image: image || 'assets/south_indian_meals.png'
  };

  db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('special_offer', ?)", [JSON.stringify(offerData)], (err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to save special offer settings.' });
    }
    res.json({ success: true, specialOffer: offerData });
  });
});

// --- API CATALOG / FOOD ENDPOINTS ---

// Get Food Catalog (Takes temporary locks into account)
app.get('/api/food-items', (req, res) => {
  db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (err, foods) => {
    if (err) return res.status(500).json({ error: err.message });

    const now = Date.now();
    db.all("SELECT foodItemId, SUM(quantity) as lockedQty FROM locks WHERE expiryTime > ? GROUP BY foodItemId", [now], (err, locked) => {
      if (err) return res.status(500).json({ error: err.message });

      const lockMap = {};
      locked.forEach(l => {
        lockMap[l.foodItemId] = l.lockedQty;
      });

      const processed = foods.map(f => {
        const lockedVal = lockMap[f.id] || 0;
        return {
          ...f,
          offerPrice: f.offer_price,
          availableStock: Math.max(0, f.stock - lockedVal)
        };
      });

      res.json(processed);
    });
  });
});

// Get the complete food catalog for the admin inventory view.
app.get('/api/admin/food-items', authenticateToken(['admin']), (req, res) => {
  db.all("SELECT id, name, price, stock, category, isveg, image, details, offer_price, COALESCE(listed, 1) AS listed FROM food_items", (err, foods) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(foods.map(f => ({ ...f, offerPrice: f.offer_price, listed: Boolean(f.listed) })));
  });
});

// Add Food Item (Admin required)
app.post('/api/food-items', authenticateToken(['admin']), (req, res) => {
  const { id, name, price, stock, category, isveg, image, details, offerPrice, listed } = req.body;
  if (!id || !name || price == null || stock == null || !category || !isveg || !image) {
    return res.status(400).json({ error: 'Invalid food payload.' });
  }

  const parsedOfferPrice = (offerPrice === '' || offerPrice === undefined || offerPrice === null) ? null : parseFloat(offerPrice);

  db.run(
    "INSERT INTO food_items (id, name, price, stock, category, isveg, image, details, offer_price, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, name, price, stock, category, isveg, image, details || '', parsedOfferPrice, listed === false ? 0 : 1],
    function(err) {
      if (err) return res.status(500).json({ error: err.message || 'ID already exists or DB error.' });
      res.json({ success: true, id });
    }
  );
});

// Edit Food Item (Admin required)
app.put('/api/food-items/:id', authenticateToken(['admin']), (req, res) => {
  const { name, price, stock, category, isveg, image, details, offerPrice, listed } = req.body;
  const foodId = req.params.id;
  const parsedOfferPrice = (offerPrice === '' || offerPrice === undefined || offerPrice === null) ? null : parseFloat(offerPrice);

  db.run(
    "UPDATE food_items SET name = ?, price = ?, stock = ?, category = ?, isveg = ?, image = ?, details = ?, offer_price = ?, listed = ? WHERE id = ?",
    [name, price, stock, category, isveg, image, details || '', parsedOfferPrice, listed === false || Number(stock) <= 0 ? 0 : 1, foodId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Item updated successfully.' });
    }
  );
});

// Delete Food Item (Admin required)
app.delete('/api/food-items/:id', authenticateToken(['admin']), (req, res) => {
  const foodId = req.params.id;
  db.run("DELETE FROM food_items WHERE id = ?", [foodId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Item deleted.' });
  });
});

// --- API INVENTORY / INGREDIENTS ENDPOINTS ---

// Get Ingredients
app.get('/api/ingredients', (req, res) => {
  db.all("SELECT * FROM ingredients", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add Ingredient (Admin required)
app.post('/api/ingredients', authenticateToken(['admin']), (req, res) => {
  const { id, name, stock, unit } = req.body;
  if (!id || !name || stock == null || !unit) {
    return res.status(400).json({ error: 'Missing parameters.' });
  }

  db.run(
    "INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)",
    [id, name, stock, unit, new Date().toISOString()],
    function(err) {
      if (err) return res.status(500).json({ error: err.message || 'Ingredient exists or DB error.' });
      res.json({ success: true });
    }
  );
});

// Update Ingredient Stock (Admin required)
app.put('/api/ingredients/:id', authenticateToken(['admin']), (req, res) => {
  const { stock, name, unit } = req.body;
  const ingId = req.params.id;

  db.run(
    "UPDATE ingredients SET name = ?, stock = ?, unit = ? WHERE id = ?",
    [name, stock, unit, ingId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Delete Ingredient (Admin required)
app.delete('/api/ingredients/:id', authenticateToken(['admin']), (req, res) => {
  const ingId = req.params.id;
  db.run("DELETE FROM ingredients WHERE id = ?", [ingId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Ingredient deleted.' });
  });
});

// --- API STOCK LOCKS ENDPOINTS ---

// Create Stock Hold Lock
app.post('/api/locks', (req, res) => {
  const { cartItems } = req.body; // Array of { id, quantity }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty.' });
  }

  const requested = new Map();
  for (const item of cartItems) {
    if (!item || item.id === 'FD-SPECIAL') continue;
    const quantity = Number(item.quantity);
    if (!/^[A-Za-z0-9-]{1,40}$/.test(String(item.id)) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'Invalid cart item or quantity.' });
    }
    requested.set(item.id, (requested.get(item.id) || 0) + quantity);
  }

  const lockId = 'LK-' + Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes

  db.serialize(() => {
    db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
      if (beginErr) return res.status(500).json({ error: 'Unable to reserve stock.' });

      db.run("DELETE FROM locks WHERE expiryTime <= ?", [Date.now()], (cleanupErr) => {
        if (cleanupErr) {
          return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
        }

        db.all(
          `SELECT f.id, f.stock, COALESCE(SUM(l.quantity), 0) AS lockedQty
           FROM food_items f
           LEFT JOIN locks l ON l.foodItemId = f.id AND l.expiryTime > ?
           GROUP BY f.id`,
          [Date.now()],
          (stockErr, rows) => {
            if (stockErr) {
              return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
            }

            const conflicts = [];
            requested.forEach((quantity, itemId) => {
              const row = rows.find(item => item.id === itemId);
              const available = row ? Number(row.stock) - Number(row.lockedQty) : 0;
              if (!row || quantity > available) {
                conflicts.push(`${itemId} (Only ${Math.max(0, available)} available)`);
              }
            });
            if (conflicts.length > 0) {
              return db.run(
                "ROLLBACK",
                () => res.status(409).json({ error: 'Some items are no longer available.', details: conflicts })
              );
            }

            const stmt = db.prepare(
              "INSERT INTO locks (id, foodItemId, quantity, expiryTime) VALUES (?, ?, ?, ?)"
            );
            let insertError = null;
            requested.forEach((quantity, itemId) => {
              stmt.run([lockId, itemId, quantity, expiry], (err) => {
                if (err) insertError = err;
              });
            });
            stmt.finalize((finalizeErr) => {
              if (insertError || finalizeErr) {
                return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
              }
              db.run("COMMIT", (commitErr) => {
                if (commitErr) {
                  return db.run("ROLLBACK", () => res.status(500).json({ error: 'Unable to reserve stock.' }));
                }
                res.json({ lockId });
              });
            });
          }
        );
      });
    });
  });
});

// Release Specific Lock
app.post('/api/locks/release', (req, res) => {
  const { lockId } = req.body;
  if (!lockId) return res.status(400).json({ error: 'Missing lock ID.' });

  db.run("DELETE FROM locks WHERE id = ?", [lockId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- API BOOKINGS & TRANSACTIONS ENDPOINTS ---

// Get All Bookings (Admin/Operator auth required)
app.get('/api/bookings', authenticateToken(['admin', 'operator']), (req, res) => {
  db.all("SELECT * FROM bookings ORDER BY bookingTime DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Parse items JSON strings
    const processed = rows.map(r => ({
      ...r,
      items: JSON.parse(r.items)
    }));
    res.json(processed);
  });
});

// Get Single Booking Status (Public)
app.get('/api/bookings/status/:id', (req, res) => {
  const bookingId = req.params.id;
  db.get("SELECT id, status, expiryTime, redeemedTime FROM bookings WHERE id = ?", [bookingId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Booking not found.' });
    res.json(row);
  });
});

// Retrieve Bookings by Customer Name and Pass Key (4-digit PIN)
app.post('/api/bookings/retrieve', (req, res) => {
  const { customerName, passkey } = req.body;
  const safeName = cleanText(customerName, 120);
  if (!safeName || typeof passkey !== 'string' || !/^\d{4}$/.test(passkey)) {
    return res.status(400).json({ error: 'Name and Pass Key PIN required.' });
  }

  db.all(
    "SELECT * FROM bookings WHERE LOWER(customerName) = ? AND status != 'redeemed' ORDER BY bookingTime DESC",
    [safeName.toLowerCase()],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const matches = [];
      for (const row of rows) {
        if (await bcrypt.compare(passkey, row.passkey)) matches.push(row);
      }
      const processed = matches.map(r => ({
        ...r,
        items: JSON.parse(r.items),
        passkey: undefined
      }));
      if (processed.length === 0) return res.status(404).json({ error: 'No pending tickets found for this name and pass key.' });
      res.json(processed);
    }
  );
});

// --- API RAZORPAY PAYMENT ENDPOINTS ---

// Get Razorpay Configuration (Public)
app.get('/api/payments/config', (req, res) => {
  db.get("SELECT value FROM settings WHERE key = 'razorpay_key_id'", (err, row) => {
    const keyId = row ? row.value : process.env.RAZORPAY_KEY_ID;
    if (keyId && keyId.trim() !== '') {
      res.json({ enabled: true, keyId: keyId.trim() });
    } else {
      res.json({ enabled: false });
    }
  });
});

// Save Razorpay API Keys (Admin only)
app.post('/api/settings/razorpay', authenticateToken(['admin']), (req, res) => {
  const { keyId, keySecret } = req.body;
  if (!keyId || !keySecret) {
    return res.status(400).json({ error: 'Both Key ID and Key Secret are required.' });
  }

  db.serialize(() => {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('razorpay_key_id', ?)", [keyId.trim()]);
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('razorpay_key_secret', ?)", [keySecret.trim()], (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to save Razorpay credentials.' });
      }
      res.json({ success: true, message: 'Razorpay API credentials updated successfully.' });
    });
  });
});

// Create Razorpay Order
app.post('/api/payments/create-order', (req, res) => {
  const { amount, bookingData } = req.body;
  if (!amount || amount <= 0 || !bookingData || typeof bookingData !== 'object') {
    return res.status(400).json({ error: 'Invalid checkout amount or booking data.' });
  }

  // Fetch Razorpay credentials from db or environment
  db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (catalogErr, catalog) => {
    if (catalogErr) return res.status(500).json({ error: 'Unable to validate menu items.' });
    const safeName = cleanText(bookingData.customerName, 120);
    const safePhone = cleanText(bookingData.customerPhone, 15);
    const normalizedItems = normalizeBookingItems(bookingData.items, catalog);
    const serverTotal = normalizedItems &&
      normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    if (!bookingData.id || !/^[A-Za-z0-9-]{10,40}$/.test(bookingData.id) ||
        !safeName || !validPhone(safePhone) || typeof bookingData.passkey !== 'string' ||
        !/^\d{4}$/.test(bookingData.passkey) || !normalizedItems ||
        !Number.isFinite(serverTotal) || Math.abs(serverTotal - Number(amount)) > 0.01) {
      return res.status(400).json({ error: 'Invalid or stale checkout data.' });
    }

    db.get("SELECT value FROM settings WHERE key = 'razorpay_key_id'", (err, rId) => {
      db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'", (err, rSecret) => {
      const keyId = (rId ? rId.value : process.env.RAZORPAY_KEY_ID) || '';
      const keySecret = (rSecret ? rSecret.value : process.env.RAZORPAY_KEY_SECRET) || '';

      if (!keyId.trim() || !keySecret.trim()) {
        return res.status(500).json({ error: 'Razorpay credentials not configured on server.' });
      }

      try {
        const Razorpay = require('razorpay');
        const razorpay = new Razorpay({
          key_id: keyId.trim(),
          key_secret: keySecret.trim()
        });

        const options = {
          amount: Math.round(amount * 100), // in paise
          currency: "INR",
          receipt: "rzp_rec_" + Math.floor(100000 + Math.random() * 900000).toString()
        };

        razorpay.orders.create(options, (err, order) => {
          if (err) {
            console.error("Razorpay order creation error:", err);
            return res.status(500).json({ error: err.message || 'Razorpay order creation failed.' });
          }
          paymentIntents.set(order.id, {
            id: bookingData.id,
            customerName: safeName,
            customerPhone: safePhone,
            passkey: bookingData.passkey,
            items: normalizedItems,
            totalAmount: serverTotal,
            lockId: bookingData.lockId
          });
          res.json(order);
        });
      } catch (e) {
        console.error("Razorpay SDK initialize failed:", e);
        res.status(500).json({ error: 'Failed to initialize payment gateway.' });
      }
      });
    });
  });
});

// Verify signature and finalize order
app.post('/api/payments/verify-signature', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment signature verification parameters.' });
  }
  const bookingData = paymentIntents.get(razorpay_order_id);
  if (!bookingData) return res.status(400).json({ error: 'Payment intent is missing or already used.' });

  db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'", (err, rSecret) => {
    const keySecret = (rSecret ? rSecret.value : process.env.RAZORPAY_KEY_SECRET) || '';

    if (!keySecret.trim()) {
      return res.status(500).json({ error: 'Payment gateway configuration missing.' });
    }

    try {
      const crypto = require('crypto');
      const text = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', keySecret.trim())
        .update(text)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Cryptographic signature verification failed.' });
      }

      paymentIntents.delete(razorpay_order_id);

      // Check stock & finalize booking
      const { id, customerName, customerPhone, passkey, items, totalAmount, lockId } = bookingData;

      db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (err, catalog) => {
        if (err) return res.status(500).json({ error: err.message });

        let stockIssues = [];
        items.forEach(cItem => {
          if (cItem.foodItemId === 'FD-SPECIAL') return;
          const food = catalog.find(f => f.id === cItem.foodItemId);
          if (!food || food.stock < cItem.quantity) {
            stockIssues.push(`${cItem.name} (Only ${food ? food.stock : 0} available)`);
          }
        });

        if (stockIssues.length > 0) {
          return res.status(409).json({ error: 'Stock deficit detected.', details: stockIssues });
        }

        db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, settingsRow) => {
          let ticketHours = 5;
          if (!err && settingsRow) {
            try {
              const config = JSON.parse(settingsRow.value);
              if (config.ticketExpiryHours) {
                ticketHours = parseFloat(config.ticketExpiryHours);
              }
            } catch (e) {}
          }

          const bookingTime = new Date().toISOString();
          const expiryTime = new Date(Date.now() + ticketHours * 3600 * 1000).toISOString();

          db.serialize(() => {
            db.run("BEGIN TRANSACTION");

            const updateStmt = db.prepare("UPDATE food_items SET stock = stock - ?, listed = CASE WHEN stock - ? <= 0 THEN 0 ELSE listed END WHERE id = ?");
            items.forEach(item => {
              if (item.foodItemId !== 'FD-SPECIAL') {
                updateStmt.run([item.quantity, item.quantity, item.foodItemId]);
              }
            });
            updateStmt.finalize();

            db.run(
              "INSERT INTO bookings (id, customerName, customerPhone, passkey, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [id, customerName, customerPhone, bcrypt.hashSync(passkey, 12), JSON.stringify(items), totalAmount, 'Razorpay (Online)', 'Paid', bookingTime, expiryTime, 'pending']
            );

            const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
            db.run(
              "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
              [txId, 'sale', `Online Order - ${customerName}`, totalAmount, bookingTime, items.map(i => `${i.name} x${i.quantity}`).join(', ')]
            );

            if (lockId) {
              db.run("DELETE FROM locks WHERE id = ?", [lockId]);
            }

            db.run("COMMIT", (commitErr) => {
              if (commitErr) {
                db.run("ROLLBACK");
                return res.status(500).json({ error: 'Failed to record online booking.' });
              }
              res.json({ success: true, bookingId: id });
            });
          });
        });
      });
    } catch (e) {
      console.error("Signature verify failed with crash:", e);
      res.status(500).json({ error: 'Cryptographic signature verification crash.' });
    }
  });
});

// Place Booking (Checkout Checkout Order)
app.post('/api/bookings', rateLimit(60 * 1000, 20, 'booking-create'), (req, res) => {
  const { id, customerName, customerPhone, passkey, items, totalAmount, paymentMethod, lockId } = req.body;

  const safeName = cleanText(customerName, 120);
  const safePhone = cleanText(customerPhone, 15);
  if (!id || !/^[A-Za-z0-9-]{10,40}$/.test(id) || !safeName ||
      !validPhone(safePhone) || typeof passkey !== 'string' || !/^\d{4}$/.test(passkey)) {
    return res.status(400).json({ error: 'Invalid booking data.' });
  }

  // 1. Double check current catalog stock
  db.all("SELECT * FROM food_items WHERE listed = 1 AND stock > 0", (err, catalog) => {
    if (err) return res.status(500).json({ error: err.message });

    const normalizedItems = normalizeBookingItems(items, catalog);
    if (!normalizedItems) return res.status(400).json({ error: 'Invalid order items.' });
    let stockIssues = [];
    normalizedItems.forEach(cItem => {
      const food = catalog.find(f => f.id === cItem.foodItemId);
      if (!food || food.stock < cItem.quantity) {
        stockIssues.push(`${cItem.name} (Only ${food ? food.stock : 0} available)`);
      }
    });

    if (stockIssues.length > 0) {
      return res.status(409).json({ error: 'Stock deficit detected.', details: stockIssues });
    }

    db.get("SELECT value FROM settings WHERE key = 'account_details'", (err, settingsRow) => {
      let ticketHours = 5;
      if (!err && settingsRow) {
        try {
          const config = JSON.parse(settingsRow.value);
          if (config.ticketExpiryHours) {
            ticketHours = parseFloat(config.ticketExpiryHours);
          }
        } catch (e) {}
      }

      const serverTotal = normalizedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      if (!Number.isFinite(serverTotal) || Math.abs(serverTotal - Number(totalAmount)) > 0.01) {
        return res.status(400).json({ error: 'Order total does not match the current menu.' });
      }
      const hashedPasskey = bcrypt.hashSync(passkey, 12);
      // 2. Perform booking insertion and stock reduction
      const bookingTime = new Date().toISOString();
      const expiryTime = new Date(Date.now() + ticketHours * 3600 * 1000).toISOString();

      db.serialize(() => {
        // Begin transaction manually in serialize
        db.run("BEGIN TRANSACTION");

        // Reduce item stock levels
        const updateStmt = db.prepare("UPDATE food_items SET stock = stock - ?, listed = CASE WHEN stock - ? <= 0 THEN 0 ELSE listed END WHERE id = ?");
        normalizedItems.forEach(item => {
          updateStmt.run([item.quantity, item.quantity, item.foodItemId]);
        });
        updateStmt.finalize();

        // Insert booking record
        db.run(
          "INSERT INTO bookings (id, customerName, customerPhone, passkey, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, safeName, safePhone, hashedPasskey, JSON.stringify(normalizedItems), serverTotal, 'UPI', 'Paid', bookingTime, expiryTime, 'pending']
        );

        // Create cashier ledger transaction logs
        const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
        const txTitle = `Order Placed - ${safeName}`;
        const txDetails = normalizedItems.map(i => `${i.name} x${i.quantity}`).join(', ');
        db.run(
          "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
          [txId, 'sale', txTitle, serverTotal, bookingTime, txDetails]
        );

        // Release the temporary lock
        if (lockId) {
          db.run("DELETE FROM locks WHERE id = ?", [lockId]);
        }

        db.run("COMMIT", (commitErr) => {
          if (commitErr) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: 'Failed to place booking transaction.' });
          }
          res.json({ success: true, bookingId: id });
        });
      });
    });
  });
});

// Redeem Booking (Admin/Operator required)
app.post('/api/bookings/redeem', authenticateToken(['admin', 'operator']), (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Booking token ID is required.' });

  db.get("SELECT * FROM bookings WHERE id = ?", [id], (err, booking) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!booking) {
      return res.status(404).json({ error: 'Ticket ID not found in database.' });
    }

    if (booking.status === 'redeemed') {
      return res.status(409).json({ error: 'Ticket already redeemed.', redeemedTime: booking.redeemedTime });
    }

    // Expiry check
    const expiry = new Date(booking.expiryTime);
    if (Date.now() > expiry.getTime()) {
      db.run("UPDATE bookings SET status = 'expired' WHERE id = ?", [id]);
      return res.status(410).json({ error: 'Ticket expired.' });
    }

    const redeemedTime = new Date().toISOString();
    db.run(
      "UPDATE bookings SET status = 'redeemed', redeemedTime = ? WHERE id = ?",
      [redeemedTime, id],
      function(updateErr) {
        if (updateErr) return res.status(500).json({ error: updateErr.message });
        
        // Return booking details parsed
        res.json({
          success: true,
          booking: {
            ...booking,
            items: JSON.parse(booking.items),
            status: 'redeemed',
            redeemedTime
          }
        });
      }
    );
  });
});

// --- API LEDGER ENDPOINTS ---

// Get Ledger logs (Admin/Operator required)
app.get('/api/ledger', authenticateToken(['admin', 'operator']), (req, res) => {
  db.all("SELECT * FROM transactions ORDER BY timestamp DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add Custom transaction (Admin required)
app.post('/api/ledger', authenticateToken(['admin']), (req, res) => {
  const { type, title, amount, details } = req.body;
  if (!type || !title || amount == null) {
    return res.status(400).json({ error: 'Invalid transaction parameters.' });
  }

  const txId = 'TX-' + Math.floor(20000 + Math.random() * 80000).toString();
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)",
    [txId, type, title, amount, timestamp, details || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: txId });
    }
  );
});

// Edit Transaction (Admin required)
app.put('/api/ledger/:id', authenticateToken(['admin']), (req, res) => {
  const { amount, details } = req.body;
  const txId = req.params.id;

  db.run(
    "UPDATE transactions SET amount = ?, details = ? WHERE id = ?",
    [amount, details, txId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Delete Transaction (Admin required)
app.delete('/api/ledger/:id', authenticateToken(['admin']), (req, res) => {
  const txId = req.params.id;
  db.run("DELETE FROM transactions WHERE id = ?", [txId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- API BACKUP / EXPORT / IMPORT ENDPOINTS ---

// Export entire database state as JSON string (Admin required)
app.get('/api/backup/export', authenticateToken(['admin']), (req, res) => {
  const backup = {};
  db.all("SELECT * FROM food_items", (err, foods) => {
    backup.foodItems = foods || [];
    db.all("SELECT * FROM bookings", (err, bookings) => {
      backup.bookings = (bookings || []).map(b => ({ ...b, items: JSON.parse(b.items) }));
      db.all("SELECT * FROM ingredients", (err, ings) => {
        backup.ingredients = ings || [];
        db.all("SELECT * FROM transactions", (err, txs) => {
          backup.transactions = txs || [];
          db.all("SELECT * FROM settings", (err, settings) => {
            // Find settings values
            const settingsObj = {};
            settings.forEach(s => {
              settingsObj[s.key] = s.value;
            });
            backup.settings = settingsObj;
            res.json(backup);
          });
        });
      });
    });
  });
});

// Restore database from uploaded JSON object (Admin required)
app.post('/api/backup/restore', authenticateToken(['admin']), (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'Missing backup payload.' });

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    
    // Clear and refill food items
    if (data.foodItems) {
      db.run("DELETE FROM food_items");
      const stmt = db.prepare("INSERT INTO food_items (id, name, price, stock, category, isveg, image, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      data.foodItems.forEach(f => {
        stmt.run([f.id, f.name, f.price, f.stock, f.category, f.isveg, f.image, f.details || '']);
      });
      stmt.finalize();
    }

    // Clear and refill bookings
    if (data.bookings) {
      db.run("DELETE FROM bookings");
      const stmt = db.prepare("INSERT INTO bookings (id, customerName, customerPhone, passkey, items, totalAmount, paymentMethod, paymentStatus, bookingTime, expiryTime, status, redeemedTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      data.bookings.forEach(b => {
        stmt.run([b.id, b.customerName, b.customerPhone, b.passkey, JSON.stringify(b.items), b.totalAmount, b.paymentMethod, b.paymentStatus, b.bookingTime, b.expiryTime, b.status, b.redeemedTime || null]);
      });
      stmt.finalize();
    }

    // Clear and refill ingredients
    if (data.ingredients) {
      db.run("DELETE FROM ingredients");
      const stmt = db.prepare("INSERT INTO ingredients (id, name, stock, unit, lastPurchaseDate) VALUES (?, ?, ?, ?, ?)");
      data.ingredients.forEach(i => {
        stmt.run([i.id, i.name, i.stock, i.unit, i.lastPurchaseDate || null]);
      });
      stmt.finalize();
    }

    // Clear and refill transactions
    if (data.transactions) {
      db.run("DELETE FROM transactions");
      const stmt = db.prepare("INSERT INTO transactions (id, type, title, amount, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)");
      data.transactions.forEach(t => {
        stmt.run([t.id, t.type, t.title, t.amount, t.timestamp, t.details || '']);
      });
      stmt.finalize();
    }

    // Refill settings credentials
    if (data.settings) {
      Object.keys(data.settings).forEach(key => {
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, data.settings[key]]);
      });
    }

    db.run("COMMIT", (err) => {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ error: 'Restore database failed.' });
      }
      res.json({ success: true, message: 'Database successfully restored.' });
    });
  });
});

// Launch Server Listening
app.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 N Cafe Production Server launched at: http://localhost:${PORT}`);
  console.log(`🔒 Secure SSL/HTTPS and API endpoints fully operational.`);
  console.log(`========================================================`);
});
