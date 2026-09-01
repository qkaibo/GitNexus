// rust-scope-phase.ts — 用 Rust 核心(parse_native.node)替换 1.14.0 的
// scopeResolutionPhase。Phase 接口与 gitnexus 源码版兼容:
//   { name: 'scopeResolution', deps: [...], execute(ctx, deps) }
//
// 行为: 从 parse 输出收集 ParsedFile, 一次调用 Rust analyzeFiles 完成
//       scope resolution, 把 relationships 合并进 ctx.graph, 返回
//       ScopeResolutionOutput 兼容结构(空 resolutionOutcomes 等)。
//
// 内存设计(2026-08-27 大库 OOM 10 轮实测迭代):
//   - nodeLookup 全量构建(1387 万 keys ~12GB) 是 OOM 主因 → 不构建全量表
//   - Rust 算边后按"边端点 def id"提取 key 集合 → 遍历图节点只构建命中
//     子集 Map(几百万 keys ~2-3GB) → 合并时查子集(Rust 自身不持 JS 表)
import { createRequire } from 'node:module';
import { getDurableParsedFileDir } from '../../../storage/parsedfile-store.js';
const require = createRequire(import.meta.url);
let native = null;
// 方案 B+子集: JS 侧 lookup Map 保留本进程(不传 Rust), 合并段查 key → JS 节点 id
let lookupMap = null;
// qualifiedKey 构建函数缓存(合并段同步用; 构建失败时 lookupResolveId 退 convertRelId)
let cachedQualifiedKey = null;
function getNative() {
    if (native)
        return native;
    const candidates = [
        process.env.PARSE_NATIVE_NODE,
        new URL('./parse_native.node', import.meta.url).pathname,
        '/home/ts/RustNexus/parse_native/parse_native.node',
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            native = require(c);
            return native;
        }
        catch (e) {
            // try next
        }
    }
    throw new Error('parse_native.node not found (set PARSE_NATIVE_NODE)');
}
/** Rust id → JS graph 节点 id(格式转换保底; 方案 B 优先 lookup 查询)。 */
function convertRelId(id, repoPath) {
    if (!id)
        return id;
    const m = id.match(/^def:(.+?)#(\d+):(\d+):([^:]+):(.+)$/);
    if (m) {
        const absPath = m[1];
        const label = m[4];
        const name = m[5];
        return `${label}:${toRelPath(absPath, repoPath)}:${name}`;
    }
    if (id.startsWith('File:')) {
        const p = id.slice(5);
        return `File:${toRelPath(p, repoPath)}`;
    }
    return id;
}
function toRelPath(absPath, repoPath) {
    if (repoPath && absPath.startsWith(repoPath)) {
        let rel = absPath.slice(repoPath.length);
        if (rel.startsWith('/'))
            rel = rel.slice(1);
        return rel;
    }
    return absPath;
}
/**
 * ⚠️ 方案 B+子集: Rust def id → JS 图节点 id。
 * Rust 边端点 = Rust 自建 def id(def:/abs/path#L:C:Label:name, 无 arityTag)
 * —— nodeLookup 不传给 Rust(1387 万 keys × 3 份 HashMap ~4.5GB + 传输临时
 * 3-6GB = OOM 主因)。lookup Map 为"边端点驱动子集": def id 拆成
 * {relPath, label, name} 构造 key 查询(qKey 优先 → sKey fallback)。
 * 命中的边指向 JS 图真实节点(含 #N); miss → undefined → filter 丢弃。
 */
function lookupResolveId(id, repoPath, lookup) {
    if (!id)
        return id;
    if (lookup == null || cachedQualifiedKey == null)
        return convertRelId(id, repoPath);
    if (!id.startsWith('def:'))
        return convertRelId(id, repoPath);
    const m = id.match(/^def:(.+?)#(\d+):(\d+):([^:]+):(.+)$/);
    if (!m)
        return convertRelId(id, repoPath);
    const relPath = toRelPath(m[1], repoPath);
    if (!relPath)
        return undefined;
    const label = m[4];
    const name = m[5].split('#')[0];
    if (!name)
        return undefined;
    try {
        const qKey = cachedQualifiedKey(relPath, label, name);
        if (lookup.has(qKey))
            return lookup.get(qKey);
        const sKey = `${relPath}::${name}`;
        if (lookup.has(sKey))
            return lookup.get(sKey);
    }
    catch {
        /* key 构造异常 → 丢边(保守) */
    }
    return undefined;
}
/** 收集 parse 产物(与 1.6.9 rust-scope-phase 相同; 1.14.0 parse 输出 parsedFiles)。 */
function collectParsedFiles(deps) {
    const parseOutput = deps.get('parse')?.output;
    if (parseOutput?.parsedFiles?.length)
        return parseOutput.parsedFiles;
    const structureOutput = deps.get('structure')?.output;
    if (structureOutput?.scannedFiles) {
        return structureOutput.scannedFiles
            .map((f) => (f.path ?? f.filePath))
            .filter((p) => Boolean(p))
            .map((filePath) => ({ filePath }));
    }
    return [];
}
/**
 * ⚠️ 1.14.0 适配(2026-08-27): parse 阶段把 ParsedFile 落盘 durable store
 * (parse 输出只给 filePath 引用)。scope-resolution 需从磁盘读回完整
 * ParsedFile 传给 Rust(否则 Rust 无 pre_extracted → 0 边)。
 * 读所有 <chunkHash>/<shard>.json → Map<filePath, ParsedFile>。
 */
async function loadDurableParsedFiles(storagePath) {
    const map = new Map();
    if (!storagePath)
        return map;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const durableDir = getDurableParsedFileDir(storagePath);
    try {
        const chunkDirs = await fs.promises.readdir(durableDir);
        for (const chunk of chunkDirs) {
            if (!/^[0-9a-f]{64}$/.test(chunk))
                continue;
            const dir = path.join(durableDir, chunk);
            const shards = await fs.promises.readdir(dir);
            for (const shard of shards) {
                if (!shard.endsWith('.json'))
                    continue;
                try {
                    const arr = JSON.parse(await fs.promises.readFile(path.join(dir, shard), 'utf-8'));
                    for (const pf of arr ?? []) {
                        if (pf?.filePath)
                            map.set(pf.filePath, pf);
                    }
                }
                catch {
                    // corrupt shard — skip
                }
            }
        }
    }
    catch {
        // no durable dir yet
    }
    return map;
}
export const rustScopeResolutionPhase = {
    name: 'scopeResolution',
    deps: ['parse', 'crossFile', 'structure'],
    async execute(ctx, deps) {
        const parsedFiles = collectParsedFiles(deps);
        // 大库直出(2026-08-28): 不加载 durable ParsedFile——10 万文件 full JSON
        // (含 content) 读回 JS 主进程 ≈20GB 必 OOM(run3 撞 23.5GB cap 实证)。
        // 只传 filePath, Rust 按 repoPath+filePath 重读(1.6.9 时代机制, ~1h 无 OOM)。
        const files = parsedFiles.map((pf) => ({ filePath: pf.filePath }));
        if (process.env.GITNEXUS_VERBOSE) {
            const pf0 = parsedFiles[0];
            console.error(`[rust-phase] parsedFiles=${parsedFiles.length} pf0 顶层 keys=${pf0 ? Object.keys(pf0).slice(0, 12).join(',') : '?'} scopes=${Array.isArray(pf0?.scopes) ? pf0.scopes.length : typeof pf0?.scopes}`);
        }
        if (files.length === 0) {
            return {
                ran: false,
                filesProcessed: 0,
                importsEmitted: 0,
                referenceEdgesEmitted: 0,
                resolutionOutcomes: [],
                undecidedSatisfaction: [],
                propertyInference: [],
            };
        }
        const n = getNative();
        const t0 = performance.now();
        // ⚠️ 方案 B+子集: config 只传 repoPath(不传 nodeLookup——省 4.5GB + 传输)。
        // Rust 自建 lookup 内部对齐, 边端点=def id 输出; 合并段查本进程子集 Map。
        // ADR-029 R0: scopeCacheBudgetBytes 必须显式喂(此前恒回落默认1.5G→大库LRU换页放大RSS→27G OOM)
        const result = n.analyzeFiles(files, {
            repoPath: ctx.repoPath ?? '',
            scopeCacheBudgetBytes: 8 * 1024 * 1024 * 1024,
        });
        const elapsed = (performance.now() - t0).toFixed(1);
        const repoPath = ctx.repoPath ?? '';
        const relsRaw = result?.relationships ?? [];
        // ── 子集 lookup: 边端点(def id)驱动的 key 集合 → 图节点命中子集 ──
        try {
            const { qualifiedKey } = await import('../scope-resolution/graph-bridge/node-lookup.js');
            cachedQualifiedKey = qualifiedKey;
            const { isOverloadableCallable } = await import('../utils/callable-labels.js');
            // 1) 边端点 def id → 规范化 key 集合(qKey + sKey)
            const epKeys = new Set();
            for (const r of relsRaw) {
                for (const id of [r.sourceId, r.targetId]) {
                    if (typeof id !== 'string' || !id.startsWith('def:'))
                        continue;
                    const m = id.match(/^def:(.+?)#(\d+):(\d+):([^:]+):(.+)$/);
                    if (!m)
                        continue;
                    const relPath = toRelPath(m[1], repoPath);
                    if (!relPath)
                        continue;
                    const name = m[5].split('#')[0];
                    if (!name)
                        continue;
                    epKeys.add(qualifiedKey(relPath, m[4], name));
                    epKeys.add(`${relPath}::${name}`);
                }
            }
            // 2) 遍历图节点: 只存端点命中的 key → JS 节点 id(子集 Map, 不发散全量)
            const LINKABLE = new Set([
                'Function', 'Method', 'Constructor', 'Class', 'Interface', 'Struct',
                'Enum', 'Trait', 'Variable', 'Property', 'Const', 'Macro',
            ]);
            const subset = new Map();
            if (ctx.graph && typeof ctx.graph.iterNodes === 'function') {
                for (const node of ctx.graph.iterNodes()) {
                    const props = node.properties;
                    if (!props?.filePath || !props?.name)
                        continue;
                    if (!LINKABLE.has(node.label))
                        continue;
                    const idParts = String(node.id).split(':');
                    const qn = props.qualifiedName ??
                        (idParts.length > 2 ? idParts.slice(2).join(':').split('#')[0] : String(props.name));
                    if (!qn)
                        continue;
                    const keyQualified = String(qn).replace(/#\d+$/, '');
                    const qKey = qualifiedKey(String(props.filePath), node.label, keyQualified);
                    if (epKeys.has(qKey) && !subset.has(qKey))
                        subset.set(qKey, node.id);
                    const sKey = `${props.filePath}::${props.name}`;
                    if (epKeys.has(sKey) && !subset.has(sKey))
                        subset.set(sKey, node.id);
                    const pTypes = props.parameterTypes;
                    if (pTypes?.length && isOverloadableCallable(node.label)) {
                        const pKey = qualifiedKey(String(props.filePath), node.label, `${keyQualified}~${pTypes.join(',')}`);
                        if (epKeys.has(pKey) && !subset.has(pKey))
                            subset.set(pKey, node.id);
                    }
                    const pCount = props.parameterCount;
                    if (pCount !== undefined && isOverloadableCallable(node.label)) {
                        const aKey = qualifiedKey(String(props.filePath), node.label, `${keyQualified}#${pCount}`);
                        if (epKeys.has(aKey) && !subset.has(aKey))
                            subset.set(aKey, node.id);
                    }
                }
            }
            lookupMap = subset;
            if (process.env.GITNEXUS_VERBOSE) {
                // debug: Rust 返回的边类型分布(对比原生找差距根因)
                const tdist = {};
                for (const r of relsRaw) {
                    const t = String(r.type ?? '?');
                    tdist[t] = (tdist[t] ?? 0) + 1;
                }
                console.error(`[rust-phase] Rust 边类型分布(${relsRaw.length}): ${JSON.stringify(tdist)}`);
                console.error(`[rust-phase] 子集 lookup: epKeys=${epKeys.size} 节点子集=${subset.size} 边=${relsRaw.length} (debug: 端点样例见下)`);
                // debug: 打印 3 个端点 def id 与 3 个图节点 props 样例, 定位 key 格式差异
                const epSample = [...epKeys].slice(0, 2);
                console.error(`[rust-phase] epKeys 样例: ${epSample.join(' | ')}`);
                let printed = 0;
                if (ctx.graph && typeof ctx.graph.iterNodes === 'function') {
                    for (const node of ctx.graph.iterNodes()) {
                        const props = node.properties;
                        console.error(`[rust-phase] 节点样例: id=${String(node.id).slice(0, 80)} label=${node.label} filePath=${String(props?.filePath).slice(0, 60)} name=${String(props?.name).slice(0, 40)} qn=${String(props?.qualifiedName).slice(0, 50)}`);
                        if (++printed >= 3)
                            break;
                    }
                }
            }
        }
        catch (err) {
            lookupMap = null;
        }
        // 合并 relationships 进 ctx.graph(端点 def id → JS 节点 id)
        const rels = relsRaw
            .map((r) => ({
            ...r,
            id: r.id ? lookupResolveId(String(r.id), repoPath, lookupMap) : undefined,
            sourceId: lookupResolveId(String(r.sourceId), repoPath, lookupMap),
            targetId: lookupResolveId(String(r.targetId), repoPath, lookupMap),
        }))
            .filter((r) => r.sourceId && r.targetId);
        if (ctx.graph && typeof ctx.graph.addRelationship === 'function') {
            for (const r of rels)
                ctx.graph.addRelationship(r);
        }
        else if (Array.isArray(ctx.graph.relationships)) {
            ctx.graph.relationships.push(...rels);
        }
        return {
            ran: true,
            filesProcessed: files.length,
            importsEmitted: rels.filter((r) => r.type === 'IMPORTS').length,
            referenceEdgesEmitted: rels.length,
            resolutionOutcomes: [],
            undecidedSatisfaction: [],
            propertyInference: [],
            elapsedMs: elapsed,
        };
    },
};
