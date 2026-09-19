// 构建信息（由 vite define 注入；开发环境回退为 dev）
declare const __BUILD_TIME__: string | undefined;

export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev';
