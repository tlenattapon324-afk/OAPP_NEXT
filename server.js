const express  = require('express');
const session  = require('express-session');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const app  = express();
const PORT = 3300;

// ── Setup ───────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'static')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'oapp_limit_s3cr3t_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'db_config.json');
const DEFAULT_CFG = {
  active: 'mysql',
  mysql:      { host: 'localhost', port: 3300, database: '', username: '', password: '' },
  postgresql: { host: 'localhost', port: 5432, database: '', username: '', password: '' }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!data.mysql && !data.postgresql) {
        // migrate old flat format
        const t = data.db_type || 'mysql';
        const m = JSON.parse(JSON.stringify(DEFAULT_CFG));
        m.active  = t;
        m[t]      = { host: data.host||'', port: data.port||3300,
                      database: data.database||'', username: data.username||'',
                      password: data.password||'' };
        return m;
      }
      const c = JSON.parse(JSON.stringify(DEFAULT_CFG));
      c.active     = data.active || c.active;
      if (data.mysql)      Object.assign(c.mysql,      data.mysql);
      if (data.postgresql) Object.assign(c.postgresql, data.postgresql);
      return c;
    }
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_CFG));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── DB helpers ──────────────────────────────────────────────────────────────
async function openConn(cfg) {
  const t = cfg.db_type || 'mysql';
  const d = cfg[t] || cfg;
  if (t === 'mysql') {
    const mysql = require('mysql2/promise');
    return await mysql.createConnection({
      host: d.host, port: parseInt(d.port)||3300,
      database: d.database, user: d.username, password: d.password,
      connectTimeout: 10000,
      charset: 'tis620',   // DB ของ HOSxP ใช้ tis620 — ถ้าไม่ระบุ mysql2 จะเขียน/อ่านข้อความไทยผิดเพี้ยน
    });
  }
  if (t === 'postgresql') {
    const { Client } = require('pg');
    const c = new Client({ host: d.host, port: parseInt(d.port)||5432,
                            database: d.database, user: d.username, password: d.password,
                            connectionTimeoutMillis: 10000 });
    await c.connect();
    return c;
  }
  throw new Error('Unsupported db_type: ' + t);
}

async function runQuery(conn, dbType, sql, params=[]) {
  if (dbType === 'mysql') {
    const [rows] = await conn.execute(sql, params);
    return rows;
  }
  const res = await conn.query(sql, params);
  return res.rows;
}

async function testConnection(dbType, dbCfg) {
  try {
    const conn = await openConn({ db_type: dbType, [dbType]: dbCfg });
    await conn.end();
    return { ok: true, msg: 'เชื่อมต่อสำเร็จ!' };
  } catch (e) { return { ok: false, msg: e.message }; }
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex'); // lowercase hex
}

async function verifyLogin(username, password) {
  const cfg    = loadConfig();
  const active = cfg.active || 'mysql';
  const conn   = await openConn({ db_type: active, ...cfg });
  try {
    // Step 1: ดึง officer record
    const sql1 = active === 'mysql'
      ? 'SELECT officer_id, officer_login_password_md5 FROM officer WHERE officer_login_name = ? LIMIT 1'
      : 'SELECT officer_id, officer_login_password_md5 FROM officer WHERE officer_login_name = $1 LIMIT 1';
    const rows = await runQuery(conn, active, sql1, [username]);

    if (!rows || rows.length === 0) {
      console.log(`[Login] ไม่พบ username: ${username}`);
      return { ok: false, reason: 'invalid' };
    }

    // Step 2: ตรวจสอบรหัสผ่าน MD5
    const storedHash = (rows[0].officer_login_password_md5 || rows[0][1] || '').trim();
    const inputHash  = md5(password);
    const match      = storedHash.toLowerCase() === inputHash.toLowerCase();
    console.log(`[Login] user=${username} | match=${match}`);

    if (!match) return { ok: false, reason: 'invalid' };

    // Step 3: ตรวจสอบสิทธิ์ task_id='164'
    const officerId = rows[0].officer_id || rows[0][0];
    const sql2 = active === 'mysql'
      ? `SELECT COUNT(*) AS cnt
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = ?`
      : `SELECT COUNT(*) AS cnt
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = $1`;

    const accessRows = await runQuery(conn, active, sql2, [officerId]);
    const cnt = parseInt(accessRows[0]?.cnt ?? accessRows[0]?.[0] ?? 0);
    console.log(`[Login] user=${username} officer_id=${officerId} task164_access=${cnt}`);

    if (cnt === 0) return { ok: false, reason: 'no_access' };

    return { ok: true };
  } finally {
    try { await conn.end(); } catch (_) {}
  }
}

// ── Verify connection-settings login (hardcoded admin credentials) ──────────
const CONN_USER = 'admin';
const CONN_PASS = 'appointment';

function verifyConnLogin(username, password) {
  if (username === CONN_USER && password === CONN_PASS)
    return { ok: true };
  return { ok: false, reason: 'invalid' };
}

// ── Middleware ──────────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.redirect(req.session.user ? '/main' : '/login'));

// Login
app.get('/login', (req, res) => res.render('login', { error: null, noAccess: false }));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render('login', { error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', noAccess: false });
  try {
    const result = await verifyLogin(username, password);
    if (result.ok) {
      req.session.user = username;
      return res.redirect('/main');
    }
    if (result.reason === 'no_access') {
      return res.render('login', { error: null, noAccess: true });
    }
    res.render('login', { error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', noAccess: false });
  } catch (e) {
    res.render('login', {
      error: `ไม่สามารถเชื่อมต่อฐานข้อมูลได้ — กรุณาตั้งค่าการเชื่อมต่อก่อน\n(${e.message})`,
      noAccess: false
    });
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ── API: Connection settings auth (hardcoded admin) ───────────────────────
app.post('/api/conn-auth', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ ok: false, reason: 'invalid', msg: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  const result = verifyConnLogin(username, password);
  if (result.ok) {
    req.session.connAuthed = true;
    return res.json({ ok: true });
  }
  return res.json({ ok: false, reason: 'invalid', msg: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

// Connection settings
app.get('/connection', (req, res) => {
  if (!req.session.connAuthed) return res.redirect('/');
  res.render('connection', { cfg: loadConfig(), alert: null });
});

app.post('/connection', async (req, res) => {
  if (!req.session.connAuthed) return res.redirect('/');
  const { action, active } = req.body;
  const newCfg = {
    active: active || 'mysql',
    mysql:      { host: req.body.mysql_host||'', port: req.body.mysql_port||'3300',
                  database: req.body.mysql_database||'', username: req.body.mysql_username||'',
                  password: req.body.mysql_password||'' },
    postgresql: { host: req.body.pg_host||'', port: req.body.pg_port||'5432',
                  database: req.body.pg_database||'', username: req.body.pg_username||'',
                  password: req.body.pg_password||'' }
  };

  if (action === 'test') {
    const t = newCfg.active;
    const r = await testConnection(t, newCfg[t]);
    return res.render('connection', { cfg: newCfg,
      alert: { type: r.ok?'success':'danger',
               msg: `[${t.toUpperCase()}] ${r.ok?'✔ ':'✘ '}${r.msg}` }});
  }
  if (action === 'save') {
    saveConfig(newCfg);
    return res.render('connection', { cfg: newCfg,
      alert: { type:'success', msg:'บันทึกการตั้งค่าเรียบร้อยแล้ว' }});
  }
  if (action === 'open_main') { saveConfig(newCfg); return res.redirect('/main'); }
  if (action === 'save_back') {
    saveConfig(newCfg);
    const db = newCfg[newCfg.active];
    const text = `บันทึกเรียบร้อยแล้ว\nใช้งาน    : ${newCfg.active.toUpperCase()}\nServer   : ${db.host}:${db.port}\nDatabase : ${db.database}\nUsername : ${db.username}`;
    return res.redirect('/status?text=' + encodeURIComponent(text));
  }
  res.redirect('/connection');
});

// ── Helper: build oapp_limit query with optional filters ──────────────────
function buildRecordsQuery(active, { dateFrom, dateTo, clinic } = {}) {
  const isMySQL = active === 'mysql';
  let idx = 1;
  const ph = () => isMySQL ? '?' : `$${idx++}`;

  // DATE_FORMAT/TO_CHAR บังคับคืน string 'YYYY-MM-DD'
  // หลีกเลี่ยง mysql2 แปลง DATE เป็น JS Date object แล้ว shift timezone
  const dateFmt = isMySQL
    ? `DATE_FORMAT(o.oapp_date, '%Y-%m-%d')`
    : `TO_CHAR(o.oapp_date, 'YYYY-MM-DD')`;

  let sql = `
    SELECT o.oapp_limit_id,
           ${dateFmt}             AS oapp_date,
           o.oapp_clinic,
           COALESCE(c.name, '')   AS clinic_name,
           o.oapp_limit,
           o.start_time,
           o.end_time,
           o.check_time,
           o.hos_guid,
           o.limit_note
    FROM   oapp_limit o
    LEFT JOIN clinic c ON c.clinic = o.oapp_clinic
    WHERE  1=1`;

  const params = [];
  if (dateFrom) { sql += ` AND o.oapp_date >= ${ph()}`; params.push(dateFrom); }
  if (dateTo)   { sql += ` AND o.oapp_date <= ${ph()}`; params.push(dateTo);   }
  if (clinic)   { sql += ` AND o.oapp_clinic = ${ph()}`; params.push(clinic);  }

  sql += ' ORDER BY o.oapp_date, o.oapp_clinic LIMIT 500';
  return { sql, params };
}

// Main
app.get('/main', requireLogin, async (req, res) => {
  let clinics=[], records=[], dbError=null;
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const safe   = (sql, p=[]) => runQuery(conn, active, sql, p).catch(() => []);

    // Clinic list — ลอง clinic table ก่อน ถ้าไม่ได้ fallback จาก oapp_limit
    clinics = await safe('SELECT clinic, name FROM clinic ORDER BY name');
    if (!clinics.length) {
      const rows = await safe(
        `SELECT DISTINCT oapp_clinic AS clinic, oapp_clinic AS name
         FROM oapp_limit ORDER BY oapp_clinic`
      );
      clinics = rows;
    }
    // Records (no filter on initial load)
    const { sql, params } = buildRecordsQuery(active);
    records = await safe(sql, params);

    try { await conn.end(); } catch (_) {}
  } catch (e) { dbError = e.message; }

  res.render('main', { user: req.session.user, clinics, records, dbError });
});

// API – filter records (AJAX)
app.get('/api/records', requireLogin, async (req, res) => {
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const { sql, params } = buildRecordsQuery(active, {
      dateFrom: req.query.date_from || '',
      dateTo:   req.query.date_to   || '',
      clinic:   req.query.clinic    || '',
    });
    const rows = await runQuery(conn, active, sql, params);
    try { await conn.end(); } catch (_) {}
    res.json({ ok: true, records: rows });
  } catch (e) {
    res.json({ ok: false, msg: e.message, records: [] });
  }
});

// ── Helper: get next serial ID via getserial(), fallback MAX+1 ────────────
async function getNextId(conn, active, table) {
  const sql = active === 'mysql'
    ? `SELECT getserial(?) AS new_id`
    : `SELECT getserial($1) AS new_id`;
  try {
    const rows = await runQuery(conn, active, sql, [table]);
    const id = rows[0]?.new_id ?? rows[0]?.NEW_ID;
    if (id !== undefined && id !== null) return id;
    throw new Error('null');
  } catch (_) {
    // fallback: MAX + 1
    const fb = active === 'mysql'
      ? `SELECT COALESCE(MAX(oapp_limit_id),0)+1 AS new_id FROM oapp_limit`
      : `SELECT COALESCE(MAX(oapp_limit_id),0)+1 AS new_id FROM oapp_limit`;
    const rows = await runQuery(conn, active, fb, []);
    return rows[0]?.new_id ?? rows[0]?.NEW_ID;
  }
}

// format local date → "YYYY-MM-DD" (ไม่ใช้ toISOString เพื่อหลีกเลี่ยง timezone offset)
function localDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// ── Helper: generate list of dates in range matching selected days ─────────
function buildDateList(startStr, endStr, days, weekNum) {
  const dayMap = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  const selNums = (Array.isArray(days) ? days : [days])
    .map(d => dayMap[d])
    .filter(n => n !== undefined);

  const result = [];
  // เพิ่ม T12:00:00 เพื่อป้องกัน DST/timezone ทำให้วันเลื่อน
  const cur  = new Date(startStr + 'T12:00:00');
  const last = new Date(endStr   + 'T12:00:00');

  while (cur <= last) {
    if (selNums.includes(cur.getDay())) {
      if (weekNum) {
        const wom = Math.ceil(cur.getDate() / 7);
        if (wom !== parseInt(weekNum)) { cur.setDate(cur.getDate()+1); continue; }
      }
      result.push(localDateStr(cur));   // ใช้ local date ไม่ใช่ UTC
    }
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

// ── Helper: ดึงรายการวันหยุดนักขัตฤกษ์ในช่วงวันที่ จากตาราง holiday ──────────
async function getHolidayDates(conn, active, startStr, endStr) {
  // DATE_FORMAT/TO_CHAR บังคับคืน string 'YYYY-MM-DD' หลีกเลี่ยง timezone shift (เหมือน buildRecordsQuery)
  const dateFmt = active === 'mysql'
    ? `DATE_FORMAT(holiday_date, '%Y-%m-%d')`
    : `TO_CHAR(holiday_date, 'YYYY-MM-DD')`;
  const sql = active === 'mysql'
    ? `SELECT ${dateFmt} AS d FROM holiday WHERE holiday_date BETWEEN ? AND ?`
    : `SELECT ${dateFmt} AS d FROM holiday WHERE holiday_date BETWEEN $1 AND $2`;
  const rows = await runQuery(conn, active, sql, [startStr, endStr]);
  return rows.map(r => r.d).filter(Boolean);
}

// API – preview dates (ดูรายการวันที่จะถูก insert ก่อนสร้างจริง)
app.post('/api/preview-dates', requireLogin, async (req, res) => {
  const { start, end, days, week, holiday } = req.body;
  const dayArr = Array.isArray(days) ? days : (days ? [days] : []);
  if (!start || !end || (!dayArr.length && !holiday)) return res.json({ ok: false, dates: [] });

  let dates = dayArr.length ? buildDateList(start, end, dayArr, week || null) : [];

  if (holiday) {
    try {
      const cfg    = loadConfig();
      const active = cfg.active || 'mysql';
      const conn   = await openConn({ db_type: active, ...cfg });
      const hdates = await getHolidayDates(conn, active, start, end);
      try { await conn.end(); } catch (_) {}
      dates = Array.from(new Set([...dates, ...hdates])).sort();
    } catch (e) {
      return res.json({ ok: false, dates: [], msg: 'ไม่สามารถตรวจสอบวันหยุดได้: ' + e.message });
    }
  }

  res.json({ ok: true, dates, count: dates.length });
});

// API – create records (INSERT oapp_limit)
app.post('/api/create-records', requireLogin, async (req, res) => {
  const {
    clinic, start, end, days, week,
    limit, start_time, end_time, check_time,
    note, holiday
  } = req.body;

  // ── Validate ──────────────────────────────────────────────────────────
  if (!clinic)       return res.json({ ok:false, msg:'กรุณาเลือกคลินิก' });
  if (!start||!end)  return res.json({ ok:false, msg:'กรุณาระบุวันที่เริ่มต้นและสิ้นสุด' });
  const dayArr = Array.isArray(days) ? days : (days ? [days] : []);
  if (!dayArr.length && !holiday)
    return res.json({ ok:false, msg:'กรุณาเลือกอย่างน้อย 1 วัน หรือวันหยุดนักขัตฤกษ์' });

  // ── Build date list ────────────────────────────────────────────────────
  let dates = dayArr.length ? buildDateList(start, end, dayArr, week || null) : [];

  // ── Insert ─────────────────────────────────────────────────────────────
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });

    // รวมวันหยุดนักขัตฤกษ์จากตาราง holiday เข้ากับรายการวันที่ (ถ้าติ๊กเลือก)
    if (holiday) {
      const hdates = await getHolidayDates(conn, active, start, end);
      dates = Array.from(new Set([...dates, ...hdates])).sort();
    }
    if (!dates.length) {
      try { await conn.end(); } catch (_) {}
      return res.json({ ok:false, msg:'ไม่พบวันที่ตรงตามเงื่อนไขที่เลือก' });
    }

    let inserted = 0;
    const skipped = [];

    const limitVal = parseInt(limit);
    if (isNaN(limitVal)) {
      await conn.end();
      return res.json({ ok:false, msg:'จำนวนจำกัดต้องเป็นตัวเลข' });
    }

    // normalize time → "HH:MM:SS" เก็บตรงๆ ตามที่กรอก
    const normTime = (t) => {
      if (t === null || t === undefined || String(t).trim() === '') return null;
      const s = String(t).trim();
      // ตรวจรูปแบบ HH:MM:SS หรือ HH:MM
      const m2 = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!m2) return null;                     // รูปแบบผิด → null
      const hh = m2[1].padStart(2, '0');
      const mm = m2[2].padStart(2, '0');
      const ss = (m2[3] || '00').padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    };
    const stVal = normTime(start_time);
    const etVal = normTime(end_time);

    const ctVal = (check_time === 'Y') ? 'Y' : '0';
    console.log(`[CREATE] clinic=${clinic.substring(0,3)} limit=${limitVal} start_time=${stVal} end_time=${etVal} check_time=${ctVal} dates=${dates.length}`);

    for (const date of dates) {
      try {
        const newId = await getNextId(conn, active, 'oapp_limit');

        const params = [
          newId,
          date,
          clinic.substring(0, 3),
          limitVal,
          stVal,           // start_time HH:MM:SS หรือ null
          etVal,           // end_time   HH:MM:SS หรือ null
          ctVal,           // check_time 'Y' หรือ '0'
          null,            // hos_guid
          note || null     // limit_note
        ];
        console.log(`[INSERT try] id=${newId} date=${date} params=`, params);

        if (active === 'mysql') {
          await conn.execute(
            `INSERT INTO oapp_limit
               (oapp_limit_id, oapp_date, oapp_clinic,
                oapp_limit, start_time, end_time,
                check_time, hos_guid, limit_note)
             VALUES (?,?,?,?,?,?,?,?,?)`, params);
        } else {
          await conn.query(
            `INSERT INTO oapp_limit
               (oapp_limit_id, oapp_date, oapp_clinic,
                oapp_limit, start_time, end_time,
                check_time, hos_guid, limit_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, params);
        }

        inserted++;
        console.log(`[INSERT OK] id=${newId} date=${date}`);

      } catch (e) {
        console.error(`[INSERT ERROR] date=${date} code=${e.code}:`, e.message, e.detail||'');
        skipped.push(`${date}: [${e.code}] ${e.message}`);
      }
    }

    try { await conn.end(); } catch (_) {}

    if (inserted > 0) {
      return res.json({
        ok:       true,
        msg:      `✔ สร้างรายการสำเร็จ ${inserted} วัน` +
                  (skipped.length ? `\n⚠ ข้าม ${skipped.length} วัน` : ''),
        inserted, skipped,
        filter:   { date_from: start, date_to: end, clinic }   // ← ส่งกลับเพื่อ set filter
      });
    }
    // แสดง error จริงๆ กลับไป
    return res.json({
      ok:    false,
      msg:   `ไม่สามารถสร้างรายการได้ (${skipped.length} error)\n\n` +
             skipped.slice(0, 5).join('\n'),
      skipped
    });

  } catch (e) {
    return res.json({ ok: false, msg: e.message });
  }
});

// Status
app.get('/status', (req, res) =>
  res.render('status', { text: req.query.text || 'บันทึกเรียบร้อยแล้ว' }));

// ══════════════════════════════════════════════════════════════════════════
// TEMPLATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════

// ── API: add single record ────────────────────────────────────────────────
app.post('/api/records', requireLogin, async (req, res) => {
  try {
    const { oapp_date, oapp_clinic, oapp_limit, start_time, end_time, check_time, limit_note } = req.body;
    if (!oapp_date)   return res.json({ ok:false, msg:'กรุณาระบุวันที่' });
    if (!oapp_clinic) return res.json({ ok:false, msg:'กรุณาระบุคลินิก' });

    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const newId  = await getNextId(conn, active, 'oapp_limit');
    const normT  = v => {
      if (!v || !String(v).trim()) return null;
      const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      return m ? `${m[1].padStart(2,'0')}:${m[2].padStart(2,'0')}:${(m[3]||'00').padStart(2,'0')}` : null;
    };
    const p   = [newId, oapp_date, String(oapp_clinic).substring(0,3),
                 parseInt(oapp_limit)||0, normT(start_time), normT(end_time),
                 check_time==='Y'?'Y':'0', limit_note||null];
    const sql = active==='mysql'
      ? 'INSERT INTO oapp_limit (oapp_limit_id,oapp_date,oapp_clinic,oapp_limit,start_time,end_time,check_time,limit_note) VALUES (?,?,?,?,?,?,?,?)'
      : 'INSERT INTO oapp_limit (oapp_limit_id,oapp_date,oapp_clinic,oapp_limit,start_time,end_time,check_time,limit_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
    await runQuery(conn, active, sql, p);
    try { await conn.end(); } catch(_) {}
    res.json({ ok:true, msg:'เพิ่มรายการเรียบร้อยแล้ว', id:newId });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── API: bulk update records ──────────────────────────────────────────────
app.put('/api/records/bulk', requireLogin, async (req, res) => {
  try {
    const { ids, fields, apply } = req.body;
    if (!ids || !ids.length)
      return res.json({ ok:false, msg:'ไม่มีรายการที่เลือก' });
    if (!apply || !Object.values(apply).some(Boolean))
      return res.json({ ok:false, msg:'กรุณาเลือกอย่างน้อย 1 ฟิลด์ที่ต้องการแก้ไข' });

    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const normT  = v => {
      if (!v || !String(v).trim()) return null;
      const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      return m ? `${m[1].padStart(2,'0')}:${m[2].padStart(2,'0')}:${(m[3]||'00').padStart(2,'0')}` : null;
    };

    // ── Date rescheduling (proportional) ─────────────────────────────────
    if (apply.date) {
      if (!fields.oapp_date_from) return res.json({ ok:false, msg:'กรุณาระบุวันที่เริ่มต้น' });
      const newStart = new Date(fields.oapp_date_from + 'T00:00:00');
      const ph2 = active==='mysql'
        ? ids.map(()=>'?').join(',')
        : ids.map((_,i)=>`$${i+1}`).join(',');
      const recs = await runQuery(conn, active,
        `SELECT oapp_limit_id, oapp_date FROM oapp_limit WHERE oapp_limit_id IN (${ph2}) ORDER BY oapp_date`,
        [...ids]);
      const MS_DAY  = 86400000;
      const toDate  = v => new Date(String(v).substring(0,10) + 'T00:00:00');
      const toISO   = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const dates   = recs.map(r => toDate(r.oapp_date).getTime());
      const origMin = Math.min(...dates);
      // shift: ย้ายทุก record ตามระยะห่างจาก start date ใหม่
      const shift   = newStart.getTime() - origMin;
      for (const rec of recs) {
        const newDate = new Date(toDate(rec.oapp_date).getTime() + shift);
        const dSql    = active==='mysql'
          ? 'UPDATE oapp_limit SET oapp_date=? WHERE oapp_limit_id=?'
          : 'UPDATE oapp_limit SET oapp_date=$1 WHERE oapp_limit_id=$2';
        await runQuery(conn, active, dSql, [toISO(newDate), rec.oapp_limit_id]);
      }
    }

    const setClauses = [], params = [];
    if (apply.limit) {
      setClauses.push(active==='mysql' ? 'oapp_limit=?' : `oapp_limit=$${params.length+1}`);
      params.push(parseInt(fields.oapp_limit)||0);
    }
    if (apply.time) {
      setClauses.push(active==='mysql' ? 'start_time=?' : `start_time=$${params.length+1}`);
      params.push(normT(fields.start_time));
      setClauses.push(active==='mysql' ? 'end_time=?' : `end_time=$${params.length+1}`);
      params.push(normT(fields.end_time));
    }
    if (apply.check) {
      setClauses.push(active==='mysql' ? 'check_time=?' : `check_time=$${params.length+1}`);
      params.push(fields.check_time==='Y' ? 'Y' : '0');
    }
    if (apply.note) {
      setClauses.push(active==='mysql' ? 'limit_note=?' : `limit_note=$${params.length+1}`);
      params.push(fields.limit_note||null);
    }
    const si = params.length + 1;
    const ph = active==='mysql'
      ? ids.map(()=>'?').join(',')
      : ids.map((_,i)=>`$${si+i}`).join(',');
    params.push(...ids);
    if (setClauses.length) {
      await runQuery(conn, active,
        `UPDATE oapp_limit SET ${setClauses.join(',')} WHERE oapp_limit_id IN (${ph})`, params);
    }
    try { await conn.end(); } catch(_) {}
    res.json({ ok:true, msg:`แก้ไข ${ids.length} รายการเรียบร้อยแล้ว` });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── API: bulk delete records ──────────────────────────────────────────────
app.delete('/api/records/bulk', requireLogin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length)
      return res.json({ ok:false, msg:'ไม่มีรายการที่เลือก' });
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const ph = active==='mysql'
      ? ids.map(()=>'?').join(',')
      : ids.map((_,i)=>`$${i+1}`).join(',');
    await runQuery(conn, active,
      `DELETE FROM oapp_limit WHERE oapp_limit_id IN (${ph})`, ids);
    try { await conn.end(); } catch(_) {}
    res.json({ ok:true, msg:`ลบ ${ids.length} รายการเรียบร้อยแล้ว` });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── API: update record ────────────────────────────────────────────────────
app.put('/api/records/:id', requireLogin, async (req, res) => {
  try {
    const id = req.params.id;
    const { oapp_date, oapp_clinic, oapp_limit, start_time, end_time, check_time, limit_note } = req.body;
    if (!oapp_date)   return res.json({ ok:false, msg:'กรุณาระบุวันที่' });
    if (!oapp_clinic) return res.json({ ok:false, msg:'กรุณาระบุคลินิก' });

    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const normT  = v => {
      if (!v || !String(v).trim()) return null;
      const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      return m ? `${m[1].padStart(2,'0')}:${m[2].padStart(2,'0')}:${(m[3]||'00').padStart(2,'0')}` : null;
    };
    const p   = [oapp_date, String(oapp_clinic).substring(0,3),
                 parseInt(oapp_limit)||0, normT(start_time), normT(end_time),
                 check_time==='Y'?'Y':'0', limit_note||null, id];
    const sql = active==='mysql'
      ? 'UPDATE oapp_limit SET oapp_date=?,oapp_clinic=?,oapp_limit=?,start_time=?,end_time=?,check_time=?,limit_note=? WHERE oapp_limit_id=?'
      : 'UPDATE oapp_limit SET oapp_date=$1,oapp_clinic=$2,oapp_limit=$3,start_time=$4,end_time=$5,check_time=$6,limit_note=$7 WHERE oapp_limit_id=$8';
    await runQuery(conn, active, sql, p);
    try { await conn.end(); } catch(_) {}
    res.json({ ok:true, msg:'แก้ไขรายการเรียบร้อยแล้ว' });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── API: delete record ────────────────────────────────────────────────────
app.delete('/api/records/:id', requireLogin, async (req, res) => {
  try {
    const id  = req.params.id;
    const cfg = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    const sql    = active==='mysql'
      ? 'DELETE FROM oapp_limit WHERE oapp_limit_id=?'
      : 'DELETE FROM oapp_limit WHERE oapp_limit_id=$1';
    await runQuery(conn, active, sql, [id]);
    try { await conn.end(); } catch(_) {}
    res.json({ ok:true, msg:'ลบรายการเรียบร้อยแล้ว' });
  } catch(e) { res.json({ ok:false, msg:e.message }); }
});

// ── Debug: ทดสอบ getserial + INSERT ────────────────────────────────────────
app.get('/debug/insert-test', async (req, res) => {
  const result = {};
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    result.db_type = active;

    const conn = await openConn({ db_type: active, ...cfg });
    result.connected = true;

    // 1) ทดสอบ getserial
    try {
      const id = await getNextId(conn, active, 'oapp_limit');
      result.getserial = { ok: true, next_id: id };
    } catch (e) {
      result.getserial = { ok: false, error: e.message };
    }

    // 2) ทดสอบ MAX(oapp_limit_id)
    try {
      const rows = await runQuery(conn, active,
        'SELECT MAX(oapp_limit_id) AS max_id, COUNT(*) AS total FROM oapp_limit', []);
      result.table_stats = rows[0];
    } catch (e) {
      result.table_stats = { error: e.message };
    }

    // 3) column types
    try {
      const sql = active === 'mysql'
        ? `DESCRIBE oapp_limit`
        : `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_name='oapp_limit' ORDER BY ordinal_position`;
      result.columns = await runQuery(conn, active, sql, []);
    } catch (e) {
      result.columns = { error: e.message };
    }

    await conn.end();
  } catch (e) {
    result.connected = false;
    result.error = e.message;
  }
  res.json(result);
});

// ── Debug: จำลองการ create-records แสดง log ทุกขั้นตอน ─────────────────────
app.post('/debug/create-trace', async (req, res) => {
  const log = [];
  const body = req.body;
  log.push({ step: 1, msg: 'รับ request body', data: body });

  const { clinic, start, end, days, week, limit, start_time, end_time, note } = body;

  // validate
  if (!clinic) return res.json({ ok:false, log, error:'clinic empty' });
  if (!start||!end) return res.json({ ok:false, log, error:'date empty' });
  const dayArr = Array.isArray(days) ? days : (days ? [days] : []);
  log.push({ step: 2, msg: 'วันที่เลือก', dayArr });
  if (!dayArr.length) return res.json({ ok:false, log, error:'days empty' });

  const limitVal = parseInt(limit);
  if (isNaN(limitVal)) return res.json({ ok:false, log, error:'limit not number' });

  // date list
  const dates = buildDateList(start, end, dayArr, week||null);
  log.push({ step: 3, msg: `วันที่จะ insert (${dates.length} วัน)`, dates });
  if (!dates.length) return res.json({ ok:false, log, error:'no dates' });

  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    log.push({ step: 4, msg: 'db', active });

    const conn = await openConn({ db_type: active, ...cfg });
    log.push({ step: 5, msg: 'connected' });

    // test getserial
    const newId = await getNextId(conn, active, 'oapp_limit');
    log.push({ step: 6, msg: 'getserial', newId });

    // test INSERT แค่แถวแรก
    const date = dates[0];
    const sql = `INSERT INTO oapp_limit
      (oapp_limit_id, oapp_date, oapp_clinic, oapp_limit, check_time, limit_note)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
    const vals = [newId, date, clinic.substring(0,3), limitVal, '0', note||null];
    log.push({ step: 7, msg: 'INSERT params', sql, vals });

    const result = await conn.query(sql, vals);
    log.push({ step: 8, msg: 'INSERT result', row: result.rows[0] });

    await conn.end();
    return res.json({ ok:true, log, inserted_first_row: result.rows[0] });
  } catch(e) {
    log.push({ step:'ERROR', msg: e.message, detail: e.detail||null, code: e.code||null });
    return res.json({ ok:false, log, error: e.message });
  }
});

// ── Debug: ดู 10 records ล่าสุดใน oapp_limit ─────────────────────────────
app.get('/debug/last-records', async (req, res) => {
  try {
    const cfg  = loadConfig();
    const active = cfg.active || 'mysql';
    const conn = await openConn({ db_type: active, ...cfg });
    const rows = await runQuery(conn, active,
      `SELECT oapp_limit_id, oapp_date, oapp_clinic, oapp_limit,
              start_time, end_time, check_time, limit_note
       FROM oapp_limit ORDER BY oapp_limit_id DESC LIMIT 10`, []);
    await conn.end();
    return res.json({ ok:true, count: rows.length, rows });
  } catch(e) { return res.json({ ok:false, error: e.message }); }
});

// ── Debug: ทดสอบ INSERT จริง 1 แถว ────────────────────────────────────────
app.get('/debug/test-insert', async (req, res) => {
  const clinic = req.query.clinic || '001';
  const date   = req.query.date   || new Date().toISOString().split('T')[0];
  const limit  = parseInt(req.query.limit) || 1;

  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });

    // 1) getserial
    const newId = await getNextId(conn, active, 'oapp_limit');

    // 2) INSERT
    const sql = `INSERT INTO oapp_limit
       (oapp_limit_id, oapp_date, oapp_clinic,
        oapp_limit, check_time, limit_note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING oapp_limit_id, oapp_date, oapp_clinic, oapp_limit`;

    const result = await conn.query(sql, [newId, date, clinic, limit, '0', 'DEBUG TEST']);
    await conn.end();

    return res.json({
      ok:       true,
      inserted: result.rows[0],
      msg:      `INSERT สำเร็จ — id=${newId}, date=${date}, clinic=${clinic}, limit=${limit}`
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message, detail: e.detail || null });
  }
});

// ── Debug: ตรวจสอบ login (ลบออกก่อน production) ───────────────────────────
app.get('/debug/login-check', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ error: 'ต้องส่ง ?username=xxx' });

  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });

    const sql = active === 'mysql'
      ? 'SELECT officer_login_name, officer_login_password_md5 FROM officer WHERE officer_login_name = ? LIMIT 1'
      : 'SELECT officer_login_name, officer_login_password_md5 FROM officer WHERE officer_login_name = $1 LIMIT 1';

    const rows = await runQuery(conn, active, sql, [username]);
    await conn.end();

    if (!rows || rows.length === 0)
      return res.json({ found: false, msg: `ไม่พบ username "${username}" ในตาราง officer` });

    const storedHash = (rows[0].officer_login_password_md5 || rows[0][1] || '').trim();
    return res.json({
      found:       true,
      username:    rows[0].officer_login_name || rows[0][0],
      stored_hash: storedHash,
      hash_length: storedHash.length,
      hash_format: /^[0-9a-fA-F]{32}$/.test(storedHash) ? 'MD5 hex (32 chars) ✔' : 'รูปแบบไม่ใช่ MD5 hex — ตรวจสอบอีกครั้ง',
      hint:        'ทดสอบ: md5("รหัสผ่านที่จะใช้") ต้องตรงกับ stored_hash (case-insensitive)',
      example_md5: `md5("test") = ${md5('test')}`
    });
  } catch (e) {
    return res.json({ error: e.message });
  }
});

// ── Debug: ตรวจสอบ access task 164 ────────────────────────────────────────
app.get('/debug/access-check', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ error: 'ต้องส่ง ?username=xxx' });
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });

    const sql1 = active === 'mysql'
      ? 'SELECT officer_id, officer_login_name FROM officer WHERE officer_login_name = ? LIMIT 1'
      : 'SELECT officer_id, officer_login_name FROM officer WHERE officer_login_name = $1 LIMIT 1';
    const rows = await runQuery(conn, active, sql1, [username]);
    if (!rows || rows.length === 0) {
      await conn.end();
      return res.json({ found: false });
    }
    const officerId = rows[0].officer_id ?? rows[0][0];
    const sql2 = active === 'mysql'
      ? `SELECT t.officer_task_id, g.officer_group_id, l.officer_id
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = ?`
      : `SELECT t.officer_task_id, g.officer_group_id, l.officer_id
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = $1`;
    const accessRows = await runQuery(conn, active, sql2, [officerId]);

    const sql3 = active === 'mysql'
      ? `SELECT COUNT(*) AS cnt
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = ?`
      : `SELECT COUNT(*) AS cnt
         FROM officer_group_task_access t
         INNER JOIN officer_group g ON g.officer_group_id = t.officer_group_id
         INNER JOIN officer_group_list l ON l.officer_group_id = g.officer_group_id
         WHERE t.officer_task_id = '164' AND l.officer_id = $1`;
    const cntRows = await runQuery(conn, active, sql3, [officerId]);
    await conn.end();

    res.json({
      username, officer_id: officerId, officer_id_type: typeof officerId,
      cnt_raw: cntRows[0], access_detail_rows: accessRows
    });
  } catch (e) { res.json({ error: e.message }); }
});

// ── Debug: ตรวจสอบ raw type ของ oapp_date ─────────────────────────────────
app.get('/api/debug-date', async (req, res) => {
  try {
    const cfg    = loadConfig();
    const active = cfg.active || 'mysql';
    const conn   = await openConn({ db_type: active, ...cfg });
    // ทดสอบทั้ง raw และ DATE_FORMAT
    const raw  = await runQuery(conn, active,
      'SELECT oapp_date FROM oapp_limit ORDER BY oapp_limit_id DESC LIMIT 3', []);
    const dateFmt = active === 'mysql'
      ? "DATE_FORMAT(oapp_date,'%Y-%m-%d')"
      : "TO_CHAR(oapp_date,'YYYY-MM-DD')";
    const fmt  = await runQuery(conn, active,
      `SELECT ${dateFmt} AS oapp_date FROM oapp_limit ORDER BY oapp_limit_id DESC LIMIT 3`, []);
    await conn.end();
    res.json({
      raw:  raw.map(r => ({ val: r.oapp_date, type: typeof r.oapp_date, isDate: r.oapp_date instanceof Date })),
      fmt:  fmt.map(r => ({ val: r.oapp_date, type: typeof r.oapp_date, isDate: r.oapp_date instanceof Date })),
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✔  oapp_limit พร้อมใช้งานที่  http://localhost:${PORT}\n`);
});
