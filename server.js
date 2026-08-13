/* Reading for fun —— 后端服务
 * 访客：浏览分区 + 封面缩略图 + 在线阅读（纯展示）
 * 管理员：带密钥的后台上传 / 新建分区 / 删除
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
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

// 异步任务超时包装
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
  const ext = path.extname(f.thumb).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif' : 'image/png';
  res.type(type);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(path.join(THUMBS, f.thumb)).pipe(res);
});

// ---------- 默认封面（渐变占位图，不解析 PDF） ----------
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

// 允许上传的图片类型
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

// ---------- 上传（管理员） ----------
// 统一磁盘存储：pdf -> uploads/，cover -> 临时目录（稍后复制到 thumbs）
const store = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'cover' ? os.tmpdir() : UPLOADS),
  filename: (req, file, cb) => cb(null,
    file.fieldname === 'cover'
      ? crypto.randomUUID() + (path.extname(file.originalname).toLowerCase() || '.png')
      : crypto.randomUUID() + '.pdf'),
});
const isPdf = (f) => /pdf$/i.test(f.originalname) || f.mimetype === 'application/pdf';
const isImg = (f) => IMG_RE.test(f.originalname) || /^image\//.test(f.mimetype);
// PDF + 可选封面图 一起上传
const uploadBoth = multer({
  storage: store,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.fieldname === 'cover' ? isImg(file) : isPdf(file)),
}).fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);
// 单独更新封面图
const coverStore = multer.diskStorage({ destination: os.tmpdir(), filename: (req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname).toLowerCase() || '.png')) });
const uploadCover = multer({
  storage: coverStore,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isImg(file)),
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

app.post('/api/admin/upload', requireKey, uploadBoth, async (req, res) => {
  try {
    const pdfFile = req.files && req.files.pdf && req.files.pdf[0];
    if (!pdfFile) return res.status(400).json({ error: '请选择 PDF 文件' });
    let zoneId = (req.body.zoneId || '').trim();
    const newZone = (req.body.newZone || '').trim();
    if (newZone) {
      if (zones.some((z) => z.name === newZone)) return res.status(409).json({ error: '分区已存在' });
      const z = { id: 'z_' + crypto.randomUUID().slice(0, 8), name: newZone };
      zones.push(z); writeJSON(ZONES_F, zones); zoneId = z.id;
    }
    const zone = zones.find((z) => z.id === zoneId) || zones[0];
    const title = (req.body.title || pdfFile.originalname.replace(/\.pdf$/i, '')).trim();
    const id = crypto.randomUUID();

    // 封面：优先用上传的自定义图片，否则用渐变占位图（均不解析 PDF）
    let thumbName;
    const coverFile = req.files && req.files.cover && req.files.cover[0];
    if (coverFile) {
      const ext = path.extname(coverFile.originalname).toLowerCase() || '.png';
      thumbName = id + ext;
      fs.copyFileSync(coverFile.path, path.join(THUMBS, thumbName));
      fs.unlinkSync(coverFile.path);
    } else {
      thumbName = id + '.png';
      await placeholderThumb(path.join(THUMBS, thumbName), title);
    }

    const meta = {
      id, title, zoneId: zone.id, zoneName: zone.name,
      filename: pdfFile.filename, thumb: thumbName,
      pages: 0, size: pdfFile.size, uploadedAt: new Date().toISOString().slice(0, 10),
    };
    files.unshift(meta);
    writeJSON(FILES_F, files);
    res.json(meta);

    // 后台只读页数（轻量，不渲染封面），失败不影响已保存的文件
    (async () => {
      try {
        const pdfDoc = await withTimeout(PDFDocument.load(fs.readFileSync(pdfFile.path)), 8000, 'PDF页数读取');
        meta.pages = pdfDoc.getPageCount();
        writeJSON(FILES_F, files);
      } catch (e) { console.error('页数读取失败/超时：', e.message); }
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '上传失败：' + e.message });
  }
});

// 单独设置/替换封面
app.post('/api/admin/cover/:id', requireKey, uploadCover.single('cover'), (req, res) => {
  const f = files.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  if (!req.file) return res.status(400).json({ error: '请选择封面图片' });
  try { fs.unlinkSync(path.join(THUMBS, f.thumb)); } catch {}
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const thumbName = f.id + ext;
  fs.copyFileSync(req.file.path, path.join(THUMBS, thumbName));
  fs.unlinkSync(req.file.path);
  f.thumb = thumbName;
  writeJSON(FILES_F, files);
  res.json({ ok: true, thumb: thumbName });
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
