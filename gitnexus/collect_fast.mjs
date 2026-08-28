// collect_fast.mjs — 快 walk + .gitnexusignore 过滤(与 1.14.0 同口径, 比 glob 快)
// 用法: node collect_fast.mjs <repo>  → 写 output/qcm4490_files.json(相对路径数组)
import { createIgnoreFilter } from './dist/config/ignore-service.js';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = process.argv[2];
const MAX = 512 * 1024;
const ignore = await createIgnoreFilter(repo);
const files = [];
let skippedBig = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    const rel = relative(repo, p).replace(/\\/g, '/');
    const pp = { relative: () => rel };
    if (e.isDirectory()) {
      if (ignore.childrenIgnored(pp)) continue;
      walk(p);
    } else {
      if (ignore.ignored(pp)) continue;
      try {
        if (statSync(p).size <= MAX) files.push(rel);
        else skippedBig++;
      } catch { /* 读不到就跳过 */ }
    }
  }
}

console.log('[collect_fast] walk 开始(读 .gitignore + .gitnexusignore, 与 1.14.0 同口径)...');
const t0 = Date.now();
walk(repo);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[collect_fast] 完成 ${secs}s  collected=${files.length}  跳过>512KB=${skippedBig}`);
writeFileSync('/home/ts/RustNexus/parse_native/output/qcm4490_files.json', JSON.stringify(files));
console.log('[collect_fast] 已写: output/qcm4490_files.json');
