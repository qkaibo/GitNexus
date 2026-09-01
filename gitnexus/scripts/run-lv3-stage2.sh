#!/usr/bin/env bash
# R1-⑧(ADR-029 两阶段) 全库 analyze 驱动: A(parse) → 子进程按语言组跑 Rust → B(收尾)
# 用法: run-lv3-stage2.sh <repoPath> [unitName]
#   单进程管线被拆成三段, 每段独立 node 进程, 段间只靠磁盘产物衔接:
#   A 段 GITNEXUS_PARSE_ONLY=1   → 跑到 parse 完成(JS 图+parsedfile-store 落盘)即退出
#   子进程 run-scope-group.cjs   → 每语言组一个独立进程: 只读 store 该语言分片,
#                                  Rust scope 解析, 边直写 graph-csv-rust/, 进程退出释放
#   B 段 GITNEXUS_SCOPE_STAGE2=1 → rust-scope-phase 跳过 Rust, 直接读 CSV 合并,
#                                  再走灌库/communities/processes 原收尾
# 不传模式变量 = 完整单进程管线(兼容旧行为)。
set -u
REPO="${1:-/home/ts/ssd/workspace/code/qcm4490}"
UNIT="${2:-qcm-lv3-stage2}"
NODE=/home/ts/.local/bin/node
CLI=/home/ts/RustNexus/GitNexus/gitnexus/dist/cli/index.js
GROUP=/home/ts/RustNexus/GitNexus/gitnexus/scripts/run-scope-group.cjs
export PARSE_NATIVE_NODE=/home/ts/RustNexus/parse_native/parse_native.node

echo "=== [stage2] A 段: parse-only $(date '+%F %T') ==="
GITNEXUS_PARSE_ONLY=1 "$NODE" "$CLI" analyze "$REPO" --skip-git || exit 1

echo "=== [stage2] 子进程段: 按语言组跑 Rust $(date '+%F %T') ==="
PLAN=$("$NODE" "$GROUP" plan "$REPO") || exit 1
echo "$PLAN"
# plan_groups 的 groups: [{lang, files, exts}] — exts 由 Rust 侧按 EXTENSION_MAP 回填
LANGS=$("$NODE" -e "
const p=JSON.parse(process.argv[1]);
for (const g of p.groups) console.log(g.lang + '|' + (g.exts||[]).join(','));
" "$PLAN")
for row in $LANGS; do
  L="${row%%|*}"; EXTS="${row#*|}"
  echo "--- [stage2] group=$L exts=$EXTS $(date '+%F %T') ---"
  "$NODE" "$GROUP" run "$REPO" "$L" "$EXTS" || exit 1
done

echo "=== [stage2] B 段: 收尾 $(date '+%F %T') ==="
# R1-⑧补(ADR-029): B 段灌库走 CSV→COPY, 量大(全库 ~5G+)。缓冲池上限默认
# 2G(DEFAULT_BUFFER_POOL_CAP), hint 只会缩不会涨 → 大库必撞 "buffer pool is
# full" (lv3e 实录 01:27)。给 8G, B 段单独进程, 机器 31G 装得下。
export GITNEXUS_LBUG_BUFFER_POOL_SIZE=${GITNEXUS_LBUG_BUFFER_POOL_SIZE:-8589934592}
GITNEXUS_SCOPE_STAGE2=1 "$NODE" "$CLI" analyze "$REPO" --skip-git
