// collect_files.mjs — 对齐 1.14.0 walkRepositoryPaths 的文件收集(ignore-service + glob + 512KB 过滤)
// 用法: node collect_files.mjs <repo>  → 写 output/qcm4490_files.json(相对路径数组)
import { createIgnoreFilter } from './dist/config/ignore-service.js';
import { glob } from 'glob';
import { statSync, writeFileSync } from 'node:fs';

const repo = process.argv[2];
if (!repo) { console.error('usage: node collect_files.mjs <repo>'); process.exit(1); }
const MAX = 512 * 1024;
const ignoreFilter = await createIgnoreFilter(repo);
console.log('[collect] glob 收集(与 1.14.0 同参数: nodir, dot:false, ignore=ignoreFilter)...');
const filtered = await glob('**/*', { cwd: repo, nodir: true, dot: false, ignore: ignoreFilter });
const out = [];
let big = 0;
for (const rel of filtered) {
  try {
    if (statSync(repo + '/' + rel).size <= MAX) out.push(rel); else big++;
  } catch { /* 忽略 */ }
}
console.log('[collect] 过滤后:', out.length, '| 跳过>512KB:', big);
writeFileSync('/home/ts/RustNexus/parse_native/output/qcm4490_files.json', JSON.stringify(out));
console.log('[collect] 已写 /home/ts/RustNexus/parse_native/output/qcm4490_files.json');
