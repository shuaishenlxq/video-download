// MediaSniff 工具栏图标生成器 —— 零依赖：手写 PNG 编码 + 4x 超采样光栅化
// 产出四态 × 16/32/48/128：gray(无媒体) / idle(彩色) / ring(任务中) / locked(全部DRM)
// PRD P-04：深底严禁深色图标，统一浅色描边/白三角。
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'public/icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数

const ACCENT = [60, 219, 192, 255]; // #3CDBC0 亮薄荷（深底/浅底都醒目）
const ACCENT_DARK = [9, 66, 55, 255]; // 内部图形用深色，与亮底形成对比
const ACCENT_LIGHT = [138, 239, 217, 255]; // #8AEFD9
const WHITE = [255, 255, 255, 255];
// 「无媒体」态：与彩色态同色系的柔和薄荷（此前用中性灰，工具栏上显脏、且与扩展列表里的
// 薄荷图标不一致 —— 用户反馈"上面的图标跟下面不一致、颜色不好"）
const GRAY = [126, 217, 201, 255]; // #7ED9C9 柔和薄荷
const GRAY_DARK = [12, 92, 78, 255]; // #0C5C4E 深薄荷（内部图形）

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 形状判定（点在形状内）----------
const inRoundedRect = (px, py, x, y, w, h, r) => {
  if (px < x || px >= x + w || py < y || py >= y + h) return false;
  const cx = Math.max(x + r, Math.min(px, x + w - r));
  const cy = Math.max(y + r, Math.min(py, y + h - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};
const inTriangle = (px, py, a, b, c) => {
  const sign = (p, q, r2) => (q[0] - p[0]) * (r2[1] - p[1]) - (r2[0] - p[0]) * (q[1] - p[1]);
  const d1 = sign(a, b, [px, py]), d2 = sign(b, c, [px, py]), d3 = sign(c, a, [px, py]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};
const inRing = (px, py, cx, cy, r1, r2, a0, a1) => {
  const dx = px - cx, dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d < r1 || d >= r2) return false;
  let ang = Math.atan2(dy, dx);
  if (ang < 0) ang += Math.PI * 2;
  return ang >= a0 && ang <= a1;
};
const strokeRing = (px, py, cx, cy, r, w) => {
  const d = Math.hypot(px - cx, py - cy);
  return d >= r - w / 2 && d <= r + w / 2;
};

// ---------- 画布 ----------
function makeCanvas(size) {
  const N = size * SS;
  const buf = new Float64Array(N * N * 4);
  const put = (x, y, color) => {
    const i = (y * N + x) * 4;
    const a = color[3] / 255;
    const b = buf;
    b[i] = b[i] * (1 - a) + color[0] * a;
    b[i + 1] = b[i + 1] * (1 - a) + color[1] * a;
    b[i + 2] = b[i + 2] * (1 - a) + color[2] * a;
    b[i + 3] = b[i + 3] * (1 - a) + 255 * a;
  };
  const paint = (test, color) => {
    // 形状函数以「最终像素」为坐标系（0..size），而画布是 size*SS 的超采样网格 →
    // 必须把采样点除以 SS 再判定，否则图案只画在画布 1/SS 的角落（真实事故：工具栏图标几乎不可见）
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) if (test((x + 0.5) / SS, (y + 0.5) / SS)) put(x, y, color);
  };
  const finish = () => {
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * N + x * SS + sx) * 4;
            r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
          }
        const k = SS * SS;
        const o = (y * size + x) * 4;
        out[o] = Math.round(r / k); out[o + 1] = Math.round(g / k);
        out[o + 2] = Math.round(b / k); out[o + 3] = Math.round(a / k);
      }
    return out;
  };
  return { paint, finish };
}

// ---------- 四态绘制 ----------
function drawIdle(size, { gray = false, ring = false, locked = false } = {}) {
  const c = makeCanvas(size);
  const s = size / 24;
  const fill = gray ? GRAY : ACCENT;
  const ink = gray ? GRAY_DARK : ACCENT_DARK;

  // 底板：一律实心饱满（此前灰态只画描边，16px 下几乎看不清）
  c.paint((x, y) => inRoundedRect(x, y, 1 * s, 1 * s, 22 * s, 22 * s, 6.5 * s), fill);
  // 内圈浅色高光环，增加体积感
  c.paint((x, y) => strokeRing(x, y, 12 * s, 12 * s, 9.6 * s, Math.max(0.9 * s, 0.8)), gray ? WHITE : ACCENT_LIGHT);

  if (locked) {
    // 锁：实心挂锁（DRM 态）
    c.paint((x, y) => inRoundedRect(x, y, 9.4 * s, 10.6 * s, 5.2 * s, 5.0 * s, 1.2 * s), ink);
    c.paint((x, y) => strokeRing(x, y, 12 * s, 9.4 * s, 2.6 * s, Math.max(1.1 * s, 1)), ink);
  } else {
    // 播放三角：实心（饱满）
    const tri = [
      [9.6 * s, 7.8 * s],
      [9.6 * s, 16.2 * s],
      [16.6 * s, 12 * s],
    ];
    c.paint((x, y) => inTriangle(x, y, tri[0], tri[1], tri[2]), ink);
  }

  if (ring) {
    // 任务中：外圈进度环（粗环，深底/浅底均清晰）
    const w = Math.max(2.1 * s, 1.4);
    c.paint((x, y) => inRing(x, y, 12 * s, 12 * s, 9.2 * s, 9.2 * s + w, -Math.PI / 2, Math.PI * 0.75), gray ? GRAY_DARK : ACCENT_DARK);
    // 环底轨道（浅色）
    c.paint((x, y) => inRing(x, y, 12 * s, 12 * s, 9.2 * s, 9.2 * s + w, Math.PI * 0.75, Math.PI * 1.5), gray ? WHITE : WHITE);
  }
  return c.finish();
}


// ---------- 生成与写出 ----------
fs.mkdirSync(OUT, { recursive: true });
const STATES = [
  ['gray', { gray: true }], // 无媒体
  ['idle', {}], // 检测到媒体
  ['ring', { ring: true }], // 任务进行中（进度环）
  ['locked', { locked: true }], // 仅 DRM 内容
];
let count = 0;
for (const [name, opts] of STATES) {
  for (const size of SIZES) {
    const rgba = drawIdle(size, opts);
    fs.writeFileSync(path.join(OUT, `${name}${size}.png`), encodePNG(size, size, Buffer.from(rgba)));
    count++;
  }
}
console.log(`generated ${count} icons -> ${OUT}`);
