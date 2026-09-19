// 用真实 B 站轨道文件跑生产合并管线（离线可复现验证）
import fs from 'node:fs';
import { splitFmp4Parts } from '../../src/background/sites/dash-nolist';
import { mergeFmp4Tracks, validateMergedMp4, repairTfdtTimelines, finalizeDuration } from '../../src/offscreen/mp4merge';
import { flattenFmp4 } from '../../src/offscreen/mp4flatten';
import { walkBoxes, childBoxes } from '../../src/offscreen/mp4box-lite';

const vPath = process.argv[2] ?? '/tmp/bili-video.m4s';
const aPath = process.argv[3] ?? '/tmp/bili-audio.m4s';
const out = process.argv[4] ?? '/tmp/bili-merged.mp4';

const vData = new Uint8Array(fs.readFileSync(vPath));
const aData = new Uint8Array(fs.readFileSync(aPath));
console.log(`视频轨 ${(vData.length / 1024 / 1024).toFixed(2)}MB | 音频轨 ${(aData.length / 1024 / 1024).toFixed(2)}MB`);

// 编解码器探查（stsd 内的 sample entry 类型）
function codecOf(data: Uint8Array): string {
  const moov = walkBoxes(data).find((b) => b.type === 'moov');
  if (!moov) return 'no-moov';
  const trak = childBoxes(data, moov).find((b) => b.type === 'trak');
  const mdia = trak && childBoxes(data, trak).find((b) => b.type === 'mdia');
  const minf = mdia && childBoxes(data, mdia).find((b) => b.type === 'minf');
  const stbl = minf && childBoxes(data, minf).find((b) => b.type === 'stbl');
  const stsd = stbl && childBoxes(data, stbl).find((b) => b.type === 'stsd');
  if (!stsd) return 'no-stsd';
  const off = stsd.start + 16; // size+type+vf+entry_count
  return String.fromCharCode(data[off + 4]!, data[off + 5]!, data[off + 6]!, data[off + 7]!);
}
console.log('视频轨 codec:', codecOf(vData), '| 音频轨 codec:', codecOf(aData));

const v = splitFmp4Parts(vData);
const a = splitFmp4Parts(aData);
console.log(`拆分：video init ${v.init.length}B + ${v.fragments.length} 片段 | audio init ${a.init.length}B + ${a.fragments.length} 片段`);

const merged = mergeFmp4Tracks(
  { init: v.init, fragments: v.fragments },
  { init: a.init, fragments: a.fragments }
);
console.log('双轨合并:', (merged.data.length / 1024 / 1024).toFixed(2), 'MB');

const repaired = repairTfdtTimelines(merged.data);
// 时长：从 sidx 估算或用轨道总时长（此处用 tfdt 跨度近似，仅用于播放器显示）
const v2 = repaired.data;

let valid = validateMergedMp4(v2, 0);
console.log('校验:', JSON.stringify(valid));

const flat = flattenFmp4(v2);
console.log(`拍平: ${flat.stats.tracks} 轨 / ${flat.stats.samples} 样本`);

const finalValid = validateMergedMp4(flat.data, 0);
console.log('拍平后校验:', JSON.stringify(finalValid));

fs.writeFileSync(out, flat.data);
console.log(`已写出 ${out} (${(flat.data.length / 1024 / 1024).toFixed(2)} MB)`);
void finalizeDuration;
