// 回归测试：mux.js 导入结构（真实站点 819 分片合并失败事故）
// 事故：d.ts 误声明 Transmuxer 在顶层，运行时 new muxjs.Transmuxer() 抛
// "TypeError: ...Transmuxer is not a constructor"。Transmuxer 实际在 mp4 命名空间下。
import { describe, it, expect } from 'vitest';
import muxjs from 'mux.js';

describe('mux.js 导入结构（合并引擎回归）', () => {
  it('Transmuxer 构造器位于 muxjs.mp4 下', () => {
    expect(typeof muxjs.mp4.Transmuxer).toBe('function');
  });
  it('可实例化并可完整走一次 push/flush（空输入不抛错）', () => {
    const t = new muxjs.mp4.Transmuxer();
    expect(() => {
      // 188 字节 TS 包头骨架：sync byte 0x47（内容非法时 flush 不产出 data 事件，但不允许抛构造/调用错误）
      const pkt = new Uint8Array(188);
      pkt[0] = 0x47;
      t.push(pkt);
      t.flush();
    }).not.toThrow();
  });
  it('data 事件收到 initSegment + data 结构', () => {
    // 用 mux.js 自带的 mp2t 传输流能力合成一段极小的可转码输入不现实；
    // 此处仅锁定事件 API 存在（真实 TS 的转码正确性由真实站点 E2E 覆盖）
    const t = new muxjs.mp4.Transmuxer();
    expect(typeof t.on).toBe('function');
    expect(typeof t.push).toBe('function');
    expect(typeof t.flush).toBe('function');
  });
});
