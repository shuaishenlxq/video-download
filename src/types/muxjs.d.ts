// mux.js 的最小类型声明（无官方 types）
declare module 'mux.js' {
  interface TransmuxerOptions {
    remux?: boolean;
    keepOriginalTimestamps?: boolean;
  }
  interface TransmuxedData {
    initSegment: Uint8Array;
    data: Uint8Array;
    type: 'combined' | 'video' | 'audio';
  }
  export class Transmuxer {
    constructor(options?: TransmuxerOptions);
    push(data: Uint8Array): void;
    flush(): void;
    on(event: 'data', listener: (segment: TransmuxedData) => void): void;
    on(event: 'done', listener: () => void): void;
    off(event: string, listener: (...args: unknown[]) => void): void;
  }
  const muxjs: {
    codecs: Record<string, unknown>;
    mp4: {
      Transmuxer: typeof Transmuxer;
      probe: Record<string, unknown>;
      generator: Record<string, unknown>;
      tools: Record<string, unknown>;
    };
    flv: Record<string, unknown>;
    mp2t: Record<string, unknown>;
    partial: Record<string, unknown>;
  };
  export default muxjs;
}
