// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { probeTsStreamTypes, isTransmuxable, codecLabel } from '../src/offscreen/tsprobe';

// ---------- 合成 TS 测试包 ----------
function tsPacket(pid: number, payload: Uint8Array, pusi = true): Uint8Array {
  const pkt = new Uint8Array(188).fill(0xff);
  pkt[0] = 0x47;
  pkt[1] = pusi ? 0x40 | ((pid >> 8) & 0x1f) : (pid >> 8) & 0x1f;
  pkt[2] = pid & 0xff;
  pkt[3] = 0x10; // AFC=01 仅 payload，continuity 0
  pkt.set(payload, 4);
  return pkt;
}

function section(tableId: number, body: Uint8Array): Uint8Array {
  // 完整 payload：pointer_field(1) + table_id(1) + section_length(2) + body + CRC(4)
  // 注意：PUSI=1 的 TS 包第一个 payload 字节必须是 pointer_field，不能切掉
  const secLen = body.length + 4;
  const out = new Uint8Array(1 + 3 + body.length + 4);
  out[0] = 0; // pointer_field
  out[1] = tableId;
  out[2] = 0xb0 | ((secLen >> 8) & 0x0f);
  out[3] = secLen & 0xff;
  out.set(body, 4);
  return out;
}

function pat(programMapPid: number): Uint8Array {
  // 真实布局：body[0..1]=tsid, body[2]=ver, body[3]=sec, body[4]=last, body[5..6]=prog, body[7..8]=map_pid
  const body = new Uint8Array(9);
  body[0] = 0x00; body[1] = 0x01; // tsid
  body[2] = 0xc1; // version/current
  body[3] = 0x00; // section_number
  body[4] = 0x00; // last_section
  body[5] = 0x00; body[6] = 0x01; // program_number 1
  body[7] = 0xe0 | ((programMapPid >> 8) & 0x1f);
  body[8] = programMapPid & 0xff;
  return section(0x00, body);
}

function pmt(streams: Array<{ type: number; pid: number }>): Uint8Array {
  // body: program_number(2) + version/current(1) + section(1) + last(1) + PCR_PID(2) + program_info_length(2) + [stream_type(1)+PID(2)+info_len(2)]*
  const body = new Uint8Array(9 + streams.length * 5);
  body[0] = 0x00; body[1] = 0x01; // program_number
  body[2] = 0xc1; // version/current
  body[3] = 0x00; // section
  body[4] = 0x00; // last_section
  body[5] = 0xe0; body[6] = 0x64; // PCR PID 100
  body[7] = 0xf0; body[8] = 0x00; // program_info_length 0
  streams.forEach((s, i) => {
    const q = 9 + i * 5;
    body[q] = s.type;
    body[q + 1] = 0xe0 | ((s.pid >> 8) & 0x1f);
    body[q + 2] = s.pid & 0xff;
    body[q + 3] = 0xf0;
    body[q + 4] = 0x00;
  });
  return section(0x02, body);
}

describe('probeTsStreamTypes（合并前编码诊断）', () => {
  it('H.264 + AAC 流 → 可转封装', () => {
    const ts = new Uint8Array(188 * 3);
    ts.set(tsPacket(0x0000, pat(0x1000)), 0);
    ts.set(tsPacket(0x1000, pmt([{ type: 0x1b, pid: 0x101 }, { type: 0x0f, pid: 0x102 }])), 188);
    const r = probeTsStreamTypes(ts);
    expect(r.video).toBe('h264');
    expect(r.audio).toBe('aac');
    expect(isTransmuxable(r)).toBe(true);
    expect(codecLabel(r)).toBe('H.264 + AAC');
  });

  it('HEVC 流 → 识别并标记不可转封装（mux.js 静默失败的根因）', () => {
    const ts = new Uint8Array(188 * 2);
    ts.set(tsPacket(0x0000, pat(0x1000)), 0);
    ts.set(tsPacket(0x1000, pmt([{ type: 0x24, pid: 0x101 }])), 188);
    const r = probeTsStreamTypes(ts);
    expect(r.video).toBe('hevc');
    expect(isTransmuxable(r)).toBe(false);
    expect(codecLabel(r)).toBe('HEVC (H.265) + 未知');
  });

  it('空/垃圾输入 → unknown 不抛错', () => {
    const r = probeTsStreamTypes(new Uint8Array(50));
    expect(r.video).toBe('unknown');
    expect(() => probeTsStreamTypes(new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it('跨 400 包扫描（PAT/PMT 在尾部也能找到）', () => {
    const packets: Uint8Array[] = [];
    // 前置 500 个不相关包（PID 0x1FFF 空包）
    for (let i = 0; i < 500; i++) packets.push(tsPacket(0x1fff, new Uint8Array(0), false));
    packets.push(tsPacket(0x0000, pat(0x1000)));
    packets.push(tsPacket(0x1000, pmt([{ type: 0x1b, pid: 0x101 }])));
    const ts = new Uint8Array(packets.length * 188);
    packets.forEach((p, i) => ts.set(p, i * 188));
    const r = probeTsStreamTypes(ts, 520);
    expect(r.video).toBe('h264');
  });
});
