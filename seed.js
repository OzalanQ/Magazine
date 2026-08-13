/* 示例数据生成：生成带封面的 PDF，并通过真实上传接口写入资料库 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('fontkit');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const KEY = process.env.ADMIN_KEY || 'changeme';
const CJK = fs.readFileSync('/System/Library/Fonts/Supplemental/Arial Unicode.ttf');
const W = 595, H = 842;

function cover({ title, subtitle, bg, accent, tag }) {
  return (async () => {
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const font = await d.embedFont(CJK);
    const p = d.addPage([W, H]);
    p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: bg });
    p.drawRectangle({ x: 0, y: H - 150, width: W, height: 150, color: accent });
    p.drawText(tag, { x: 48, y: H - 70, size: 16, color: rgb(1, 1, 1), font });
    p.drawText(title, { x: 48, y: 560, size: 34, color: rgb(1, 1, 1), maxWidth: W - 96, lineHeight: 42, font });
    p.drawCircle({ x: 470, y: 230, radius: 95, color: accent, opacity: 0.45 });
    p.drawCircle({ x: 360, y: 150, radius: 50, color: rgb(1, 1, 1), opacity: 0.18 });
    p.drawText(subtitle, { x: 48, y: 90, size: 13, color: rgb(1, 1, 1), opacity: 0.9, font });
    p.drawText('Reading for fun · 示例', { x: 48, y: 56, size: 11, color: rgb(1, 1, 1), opacity: 0.7, font });
    return d.save();
  })();
}

const SAMPLES = [
  { title: '2026 春季刊\n城市漫游', subtitle: 'MAGAZINE · ISSUE 12', bg: rgb(0.27, 0.42, 0.92), accent: rgb(0.52, 0.29, 0.94), tag: 'MAGAZINE', zone: 'z_mag' },
  { title: '设计美学特辑\nNo.07', subtitle: 'DESIGN · AESTHETICS', bg: rgb(0.9, 0.4, 0.36), accent: rgb(0.94, 0.6, 0.3), tag: 'MAGAZINE', zone: 'z_mag' },
  { title: '独立出版合集', subtitle: 'INDIE PRESS', bg: rgb(0.22, 0.7, 0.52), accent: rgb(0.16, 0.55, 0.78), tag: 'MAGAZINE', zone: 'z_mag' },
  { title: '2026 中国\n消费趋势报告', subtitle: 'REPORT · CONSUMER', bg: rgb(0.25, 0.36, 0.82), accent: rgb(0.38, 0.25, 0.82), tag: 'REPORT', zone: 'z_rep' },
  { title: '跨境电商白皮书', subtitle: 'REPORT · CROSS-BORDER', bg: rgb(0.85, 0.32, 0.28), accent: rgb(0.72, 0.2, 0.5), tag: 'REPORT', zone: 'z_rep' },
  { title: '新员工入职手册', subtitle: 'TRAINING · ONBOARDING', bg: rgb(0.92, 0.56, 0.2), accent: rgb(0.88, 0.35, 0.4), tag: 'TRAINING', zone: 'z_tra' },
  { title: '年度服务\n采购合同', subtitle: 'CONTRACT', bg: rgb(0.16, 0.53, 0.4), accent: rgb(0.1, 0.4, 0.52), tag: 'CONTRACT', zone: 'z_con' },
  { title: '保密协议\nNDA 模板', subtitle: 'CONTRACT · NDA', bg: rgb(0.45, 0.38, 0.78), accent: rgb(0.27, 0.3, 0.7), tag: 'CONTRACT', zone: 'z_con' },
];

(async () => {
  const existing = await fetch(`http://localhost:${PORT}/api/files?zone=all`).then((r) => r.json());
  const have = new Set(existing.map((f) => f.title));
  for (const s of SAMPLES) {
    const title = s.title.replace(/\n/g, ' ');
    if (have.has(title)) { console.log(`· 已存在，跳过：${title}`); continue; }
    const buf = await cover(s);
    const fd = new FormData();
    fd.append('pdf', new Blob([buf], { type: 'application/pdf' }), title + '.pdf');
    fd.append('title', title);
    fd.append('zoneId', s.zone);
    try {
      const r = await fetch(`http://localhost:${PORT}/api/admin/upload`, {
        method: 'POST', headers: { 'x-admin-key': KEY }, body: fd,
      });
      const j = await r.json();
      console.log(r.ok ? `✓ ${j.title} (${j.zoneName}, ${j.pages}页)` : `✗ ${j.error}`);
    } catch (e) {
      console.log(`✗ ${title} 上传异常：${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log('\n示例数据写入完成。');
})();
