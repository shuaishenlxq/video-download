// ============ 内存水位估算（F-402 规则 3，纯函数）============

/** 峰值内存估算：体积 MB × 双缓冲系数 1.6（mux 转换器输入/输出各持一份） */
export function estimatePeakMemoryMb(sizeMb: number): number {
  return sizeMb * 1.6;
}

/** 安全水位：设备内存的 25%（PRD 建议值，实测校准点 Q-03） */
export function memoryWatermarkMb(deviceMemoryGb: number): number {
  return deviceMemoryGb * 1024 * 0.25;
}

export type MergeFeasibility = { ok: true } | { ok: false; peakMb: number; watermarkMb: number; suggestLocalEngine: true };

export function canMergeInBrowser(sizeMb: number, deviceMemoryGb: number): MergeFeasibility {
  const peakMb = estimatePeakMemoryMb(sizeMb);
  const watermarkMb = memoryWatermarkMb(deviceMemoryGb);
  if (peakMb <= watermarkMb) return { ok: true };
  return { ok: false, peakMb, watermarkMb, suggestLocalEngine: true };
}

/** 读取设备内存（GB），不可用时按 8GB 保守取值 */
export function detectDeviceMemoryGb(): number {
  const g = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return g && g > 0 ? g : 8;
}
