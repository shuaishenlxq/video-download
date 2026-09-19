// 打包 dist 为可安装 zip（排除开发文件）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, `mediasniff-v${pkg.version}.zip`);

execSync(`cd "${dist}" && zip -rq "${out}" . -x ".DS_Store"`, { stdio: 'inherit' });
const size = fs.statSync(out).size;
console.log(`打包完成：${out}（${(size / 1024).toFixed(1)} KB）`);
