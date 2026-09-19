import fs from 'node:fs';
import { walkBoxes, childBoxes, readMvhdDuration, readMdhd, readVersionFlags } from '../../src/offscreen/mp4box-lite';

const p = process.argv[2] ?? '';
const data = new Uint8Array(fs.readFileSync(p));
console.log('文件:', p.split('/').pop(), (data.length / 1024 / 1024).toFixed(2), 'MB');
const top = walkBoxes(data);
console.log('顶层:', top.map((b) => b.type).join(','));
const moov = top.find((b) => b.type === 'moov');
if (!moov) { console.log('无 moov'); process.exit(0); }
const mv = readMvhdDuration(data, moov);
console.log('mvhd: version=' + readVersionFlags(data, walkBoxes(data, moov.start + 8, moov.start + moov.size).find((b) => b.type === 'mvhd')!.start).version +
  ' timescale=' + mv.timescale + ' duration=' + mv.duration + ' → ' + (mv.duration / (mv.timescale || 1)).toFixed(1) + 's');
for (const trak of childBoxes(data, moov).filter((b) => b.type === 'trak')) {
  const mdia = childBoxes(data, trak).find((b) => b.type === 'mdia');
  const mdhd = mdia && childBoxes(data, mdia).find((b) => b.type === 'mdhd');
  const minf = mdia && childBoxes(data, mdia).find((b) => b.type === 'minf');
  const stbl = minf && childBoxes(data, minf).find((b) => b.type === 'stbl');
  const stsz = stbl && childBoxes(data, stbl).find((b) => b.type === 'stsz');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = stsz ? dv.getUint32(readVersionFlags(data, stsz.start).body + 4) : 0;
  const mh = mdhd ? readMdhd(data, mdhd) : { timescale: 0, duration: 0 };
  const type = data.slice(trak.start, trak.start + trak.size).includes('soun'.split('').map((c) => c.charCodeAt(0)).reduce((a, b) => a, 0)) ? '?' : '?';
  void type;
  console.log('  trak: mdhd ts=' + mh.timescale + ' dur=' + mh.duration + ' (' + (mh.duration / (mh.timescale || 1)).toFixed(1) + 's) 样本数=' + n);
}
