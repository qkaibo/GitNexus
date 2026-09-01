#!/usr/bin/env node
/**
 * R1-⑥(ADR-029 两阶段) stage2 子进程: 按语言组独立跑 Rust scope 解析。
 *
 * 背景: 全库 analyze 单进程共址死结(lv3b/c/d 三连 OOM)——JS parse 图 13.8G
 * 全程驻留 + Rust 语言组工作集叠上去顶穿 30G。本子进程只吃 parsedfile-store
 * (JSON 分片), 不建 JS 图, 单语言组峰值 ~2-3G(java 最重 ~9G), 独立进程
 * 退出即全量释放。
 *
 * 用法:
 *   node run-scope-group.cjs plan  <repoPath>                 # 枚举语言分组规划
 *   node run-scope-group.cjs run   <repoPath> <lang> <exts>   # 单语言组跑 Rust→CSV
 *
 * run 产物: <repo>/.gitnexus/graph-csv-rust/rel-<lang>.csv
 *          + <repo>/.gitnexus/graph-csv-rust/manifest-<lang>.json
 */
'use strict';
const path = require('path');

const NATIVE = process.env.PARSE_NATIVE_NODE;
if (!NATIVE) {
  console.error('[run-scope-group] PARSE_NATIVE_NODE 未设置');
  process.exit(2);
}
const n = require(NATIVE);

const [, , cmd, repoPath, langArg, extsArg] = process.argv;
if (!cmd || !repoPath) {
  console.error('用法: run-scope-group.cjs plan <repoPath> | run <repoPath> <lang> <exts>');
  process.exit(2);
}
const repo = repoPath.replace(/\/+$/, '');
const csvDir = `${repo}/.gitnexus/graph-csv-rust`;

if (cmd === 'plan') {
  const plan = n.planGroups(repo);
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (cmd === 'run') {
  const lang = langArg;
  const exts = (extsArg || '').split(',').filter(Boolean);
  if (!lang || exts.length === 0) {
    console.error('run 需要 <lang> <exts>(逗号分隔扩展名, 不带点)');
    process.exit(2);
  }
  // 扫 parsedfile-store 分片, 只收本语言的 filePath
  const storeDir = `${repo}/.gitnexus/parsedfile-store`;
  const fs = require('fs');
  let entries;
  try {
    entries = fs.readdirSync(storeDir);
  } catch (e) {
    console.error(`[run-scope-group] store 不可读: ${storeDir} (${e.message})`);
    process.exit(3);
  }
  const shards = entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(storeDir, f));
  const filePaths = [];
  const extSet = new Set(exts);
  for (const shard of shards) {
    let text;
    try {
      text = fs.readFileSync(shard, 'utf-8');
    } catch {
      continue;
    }
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const pf of arr) {
      const fp = pf && pf.filePath;
      if (typeof fp !== 'string' || !fp) continue;
      const ext = fp.includes('.') ? fp.slice(fp.lastIndexOf('.') + 1).toLowerCase() : '';
      if (extSet.has(ext)) filePaths.push(fp);
    }
  }
  console.error(`[run-scope-group] lang=${lang} files=${filePaths.length} (store shards=${shards.length})`);
  if (filePaths.length === 0) {
    console.error('[run-scope-group] 该语言 0 文件, 不产 CSV');
    process.exit(0);
  }
  // files 只带 filePath(content 留空) → Rust 按 repoPath+path 自读源码
  const files = filePaths.map((fp) => ({ filePath: fp, content: '' }));
  const result = n.analyzeFiles(files, {
    repoPath: repo,
    scopeCacheBudgetBytes: 8 * 1024 * 1024 * 1024,
    onlyLangs: [lang],
  });
  const langStats = result && result.stats && result.stats[lang];
  const total = (result && result.totalRels) || 0;
  const csv = `${csvDir}/rel-${lang}.csv`;
  fs.mkdirSync(csvDir, { recursive: true });
  const manifest = {
    lang,
    files: filePaths.length,
    rels: total,
    csv,
    stats: langStats || null,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${csvDir}/manifest-${lang}.json`, JSON.stringify(manifest, null, 2));
  console.error(`[run-scope-group] done lang=${lang} rels=${total} csv=${csv}`);
  process.exit(0);
}

console.error(`未知命令: ${cmd}`);
process.exit(2);
