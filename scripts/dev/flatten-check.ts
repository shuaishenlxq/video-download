// 本地验证：对真实合并产物跑拍平，输出到 /tmp 供 avconvert / Chrome 验证
import fs from 'node:fs';
import path from 'node:path';
import { flattenFmp4 } from '../../src/offscreen/mp4flatten';
import { validateMergedMp4 } from '../../src/offscreen/mp4merge';

const src = process.argv[2];
const dst = process.argv[3] ?? '/tmp/ms-flat.mp4';
if (!src) {
  console.error('用法: vite-node scripts/dev/flatten-check.ts <input.mp4> [output.mp4]');
  process.exit(1);
}
const data = new Uint8Array(fs.readFileSync(src));
console.log(`输入: ${path.basename(src)} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);

const t0 = Date.now();
const r = flattenFmp4(data);
console.log(`拍平完成: ${Date.now() - t0}ms, ${r.stats.tracks} 轨 / ${r.stats.samples} 样本 / ${r.stats.fragments} 片段`);
console.log(`输出: ${(r.data.length / 1024 / 1024).toFixed(1)} MB`);

const v = validateMergedMp4(r.data, 0);
console.log(`校验: ${JSON.stringify(v)}`);
fs.writeFileSync(dst, r.data);
console.log(`已写出 ${dst}`);
