/* Reading for fun —— 后端服务
 * 访客：浏览分区 + 封面缩略图 + 在线阅读（纯展示）
 * 管理员：带密钥的后台上传 / 新建分区 / 删除
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

const app = express();
const ROOT = __dirname;
const UPLOADS = path.join(ROOT, 'uploads');
const THUMBS = path.join(ROOT, 'thumbs');
const DATA = path.join(ROOT, 'data');
const ZONES_F = path.join(DATA, 'zones.json');
const FILES_F = path.join(DATA, 'files.json');
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const THUMB_W = 480; // 缩略图目标宽度(px)

// 异步任务超时包装，防止 PDF 渲染卡住导致请求挂起
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms))
  ]);
}

// 记录未捕获异常，避免进程直接崩溃
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack || e));

[UPLOADS, THUMBS, DATA].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const readJSON = (f, def) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
};
const writeJSON = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

let zones = readJSON(ZONES_F, null);
if (!zones) {
  zones = [
    { id: 'z_mag', name: '杂志' },
    { id: 'z_rep', name: '行业报告' },
    { id: 'z_con', name: '合同文档' },
    { id: 'z_tra', name: '培训资料' },
  ];
  writeJSON(ZONES_F, zones);
}
let files = readJSON(FILES_F, []);

app.use(express.static(path.join(ROOT, 'public')));

// 管理员密钥校验
function requireKey(req, res, next) {
  const k = req.get('x-admin-key') || req.query.key;
  if (k !== ADMIN_KEY) return res.status(401).json({ error: '管理员密钥错误' });
  next();
}

// ---------- 公共接口（访客） ----------
app.get('/api/zones', (req, res) => res.json(zones));

app.get('/api/files', (req, res) => {
  const z = req.query.zone || 'all';
  const list = z === 'all' ? files : files.filter((f) => f.zoneId === z);
  res.json(list);
});

app.get('/file/:id', (req, res) => {
  const f = files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).end();
  res.type('application/pdf');
  fs.createReadStream(path.join(UPLOADS, f.filename)).pipe(res);
});

app.get('/thumb/:id', (req, res) => {
  const f = files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).end();
  res.type('image/png');
  fs.createReadStream(path.join(THUMBS, f.thumb)).pipe(res);
});

// ---------- 缩略图生成（PDF 首页 -> PNG） ----------
async function makeThumb(pdfPath, outPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const stdFonts = 'file://' + path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts');
  const buf = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data: buf, standardFontDataUrl: stdFonts }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = THUMB_W / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  // 白底，避免透明
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  await doc.destroy();
}

async function placeholderThumb(outPath, title) {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(THUMB_W, Math.round(THUMB_W * 1.33));
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, '#4f6ef7'); g.addColorStop(1, '#7b5cf0');
  ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif';
  ctx.fillText((title || 'PDF').slice(0, 12), 20, 60);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
}

// ---------- 上传（管理员） ----------
const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.pdf'),
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf'),
});

app.post('/api/admin/zone', requireKey, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '分区名不能为空' });
  if (zones.some((z) => z.name === name)) return res.status(409).json({ error: '分区已存在' });
  const zone = { id: 'z_' + crypto.randomUUID().slice(0, 8), name };
  zones.push(zone);
  writeJSON(ZONES_F, zones);
  res.json(zone);
});

app.delete('/api/admin/zone/:id', requireKey, (req, res) => {
  const target = zones.find((z) => z.id === req.params.id);
  if (!target) return res.status(404).json({ error: '分区不存在' });
  const remain = zones.filter((z) => z.id !== req.params.id);
  if (remain.length) {
    const fallback = remain[0];
    files.forEach((f) => { if (f.zoneId === target.id) { f.zoneId = fallback.id; f.zoneName = fallback.name; } });
    writeJSON(FILES_F, files);
  }
  zones = remain;
  writeJSON(ZONES_F, zones);
  res.json({ ok: true });
});

app.post('/api/admin/upload', requireKey, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择 PDF 文件' });
    let zoneId = (req.body.zoneId || '').trim();
    const newZone = (req.body.newZone || '').trim();
    if (newZone) {
      if (zones.some((z) => z.name === newZone)) return res.status(409).json({ error: '分区已存在' });
      const z = { id: 'z_' + crypto.randomUUID().slice(0, 8), name: newZone };
      zones.push(z); writeJSON(ZONES_F, zones); zoneId = z.id;
    }
    const zone = zones.find((z) => z.id === zoneId) || zones[0];
    const title = (req.body.title || req.file.originalname.replace(/\.pdf$/i, '')).trim();
    const id = crypto.randomUUID();
    const thumbName = id + '.png';
    // 页数
    let pages = 0;
    try {
      const pdfDoc = await withTimeout(PDFDocument.load(fs.readFileSync(req.file.path)), 5000, 'PDF页数读取');
      pages = pdfDoc.getPageCount();
    } catch (e) { console.error('页数读取失败/超时：', e.message); }
    // 缩略图
    try {
      await withTimeout(makeThumb(req.file.path, path.join(THUMBS, thumbName)), 15000, '缩略图生成');
    } catch (e) {
      console.error('缩略图生成失败/超时，使用占位图：', e.message);
      await placeholderThumb(path.join(THUMBS, thumbName), title);
    }
    const meta = {
      id, title, zoneId: zone.id, zoneName: zone.name,
      filename: req.file.filename, thumb: thumbName,
      pages, size: req.file.size, uploadedAt: new Date().toISOString().slice(0, 10),
    };
    files.unshift(meta);
    writeJSON(FILES_F, files);
    res.json(meta);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '上传失败：' + e.message });
  }
});

app.delete('/api/admin/file/:id', requireKey, (req, res) => {
  const f = files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  try { fs.unlinkSync(path.join(UPLOADS, f.filename)); } catch {}
  try { fs.unlinkSync(path.join(THUMBS, f.thumb)); } catch {}
  files = files.filter((x) => x.id !== f.id);
  writeJSON(FILES_F, files);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`\n  Reading for fun 已启动`);
  console.log(`  访客浏览:  http://localhost:${PORT}/`);
  console.log(`  后台上传:  http://localhost:${PORT}/admin   (密钥: ${ADMIN_KEY})`);
  console.log(`  修改密钥:  ADMIN_KEY=你的密钥 npm start\n`);
});
