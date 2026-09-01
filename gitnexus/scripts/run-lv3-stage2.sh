#!/usr/bin/env bash
# R1-⑧(ADR-029 两阶段) 全库 analyze 驱动:
#   A 段: fork 管道跑到 parse 完成(GITNEXUS_PARSE_ONLY=1, 产 JS 图节点+parsedfile-store)
#   子进程: 按语言组独立跑 Rust scope 解析 → 边直写 CSV(每组一个进程, 退出释放)
#   B 段: fork 管道收尾(GITNEXUS_SCOPE_STAGE2=1, 读 CSV 合并→灌库→communities→wiki 前置)
# 用法: run-lv3-stage2.sh <repoPath> [unitName]
set -u
REPO="${1:-/home/ts/ssd/workspace/code/qcm4490}"
UNIT="${2:-qcm-lv3-stage2}"
export GITNEXUS_PARSE_ONLY=1
exec /home/ts/.local/bin/node /home/ts/RustNexus/GitNexus/gitnexus/dist/cli/index.js analyze "$REPO" --skip-git
