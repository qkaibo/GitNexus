import { isVerboseIngestionEnabled } from './utils/verbose.js';
import { DEFAULT_MAX_FILE_SIZE_BYTES, getMaxFileSizeBytes } from './utils/max-file-size.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createIgnoreFilter, getHardcodedRules, getIgnoreRuleContents } from '../../config/ignore-service.js';
import { mapConcurrent } from '../../lib/utils.js';
import { logger } from '../logger.js';
const READ_CONCURRENCY = 32;
const ANALYZE_PROGRESS_ACTIVE_ENV = 'GITNEXUS_ANALYZE_PROGRESS_ACTIVE';
const DECLARATION_COMPANION_SUFFIXES = [
    { declaration: '.d.ts', implementations: ['.ts', '.tsx'] },
    { declaration: '.d.mts', implementations: ['.mts'] },
    { declaration: '.d.cts', implementations: ['.cts'] },
];
const hasImplementationSibling = (declarationPath, scannedPaths) => {
    const companion = DECLARATION_COMPANION_SUFFIXES.find(({ declaration }) => declarationPath.endsWith(declaration));
    if (!companion)
        return false;
    // Keep standalone declarations. Only suppress declaration output that sits
    // beside an implementation with the corresponding module suffix.
    const stem = declarationPath.slice(0, -companion.declaration.length);
    return companion.implementations.some((suffix) => scannedPaths.has(`${stem}${suffix}`));
};
const warnLargeFileSkip = (message) => {
    if (process.env[ANALYZE_PROGRESS_ACTIVE_ENV] === '1') {
        // analyze.ts routes console.warn through the progress bar logger while
        // the bar is active. Emitting the operator-facing large-file notice there
        // avoids raw pino NDJSON corrupting the one-line progress display in the
        // heap-respawn child, whose stderr is intentionally piped for crash
        // classification.
        // eslint-disable-next-line no-console -- intentionally routed by analyze progress UI
        console.warn(message);
        return;
    }
    logger.warn(message);
};
/**
 * Phase 1: Scan repository — stat files to get paths + sizes, no content loaded.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 */
export const walkRepositoryPaths = async (repoPath, onProgress) => {
    // 默认 Rust 快扫(默认Rust, JS 仅对拍)。GITNEXUS_WALKER_RUST=0 显式退回 JS glob。
    if (process.env.GITNEXUS_WALKER_RUST !== '0') {
        return walkRepositoryPathsRust(repoPath, onProgress);
    }
    const ignoreFilter = await createIgnoreFilter(repoPath);
    const maxFileSizeBytes = getMaxFileSizeBytes();
    const filtered = await glob('**/*', {
        cwd: repoPath,
        nodir: true,
        dot: false,
        ignore: ignoreFilter,
    });
    const entries = [];
    let processed = 0;
    let skippedLarge = 0;
    const skippedLargePaths = [];
    for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
        const batch = filtered.slice(start, start + READ_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (relativePath) => {
            const fullPath = path.join(repoPath, relativePath);
            const stat = await fs.stat(fullPath);
            if (stat.size > maxFileSizeBytes) {
                skippedLarge++;
                skippedLargePaths.push(relativePath.replace(/\\/g, '/'));
                return null;
            }
            return { path: relativePath.replace(/\\/g, '/'), size: stat.size };
        }));
        for (const result of results) {
            processed++;
            if (result.status === 'fulfilled' && result.value !== null) {
                entries.push(result.value);
                onProgress?.(processed, filtered.length, result.value.path);
            }
            else {
                onProgress?.(processed, filtered.length, batch[results.indexOf(result)]);
            }
        }
    }
    const scannedPaths = new Set(entries.map((entry) => entry.path));
    const deduplicatedEntries = entries.filter((entry) => !hasImplementationSibling(entry.path, scannedPaths));
    // Filesystem/glob traversal order is not stable across filesystems or repeated
    // scans. Canonicalize once at the scan boundary so every downstream phase sees
    // the same repository order.
    deduplicatedEntries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (skippedLarge > 0) {
        const isDefault = maxFileSizeBytes === DEFAULT_MAX_FILE_SIZE_BYTES;
        const isOverrideUnset = !process.env.GITNEXUS_MAX_FILE_SIZE;
        const suffix = isDefault ? ', likely generated/vendored' : '';
        warnLargeFileSkip(`  Skipped ${skippedLarge} large files (>${maxFileSizeBytes / 1024}KB${suffix})`);
        // Always show at least the first few paths so users can diagnose why
        // edges are missing from a specific file (issue #1659). The full list is
        // gated behind GITNEXUS_VERBOSE=1 to avoid flooding output on repos with
        // many generated/vendored blobs. Sort before slicing so the preview is
        // stable across runs (fs.stat callbacks race within each batch).
        skippedLargePaths.sort();
        const SKIPPED_PREVIEW_CAP = 5;
        const showAll = isVerboseIngestionEnabled() || skippedLargePaths.length <= SKIPPED_PREVIEW_CAP;
        const preview = showAll ? skippedLargePaths : skippedLargePaths.slice(0, SKIPPED_PREVIEW_CAP);
        for (const p of preview) {
            warnLargeFileSkip(`  - ${p}`);
        }
        if (!showAll) {
            const remaining = skippedLargePaths.length - SKIPPED_PREVIEW_CAP;
            warnLargeFileSkip(`  ...and ${remaining} more (set GITNEXUS_VERBOSE=1 to list them all)`);
        }
        // Only hint about the env var when the user has not set it at all. An
        // explicit GITNEXUS_MAX_FILE_SIZE=512 happens to resolve to the same
        // bytes as the default but the operator clearly already knows the knob.
        if (isDefault && isOverrideUnset) {
            warnLargeFileSkip(`  Set GITNEXUS_MAX_FILE_SIZE=<KB> to include files above the default cap.`);
        }
    }
    return deduplicatedEntries;
};
/**
 * Phase 1 (Rust 分支): GITNEXUS_WALKER_RUST=1 时用 parse_native.node 的
 * walk_files(Rust ignore crate, 多线程+目录剪枝)替换 JS glob 单线程扫描。
 * 返回结构与 JS 版一致: [{path, size}]。大文件过滤/提示逻辑与 JS 版相同。
 */
const walkRepositoryPathsRust = async (repoPath, onProgress) => {
    const native = getNativeWalker();
    const hardcoded = getHardcodedRules();
    const customContents = await getIgnoreRuleContents(repoPath);
    const customLines = [];
    for (const content of customContents) {
        customLines.push(...content.split('\n'));
    }
    const raw = native.walkFiles(repoPath, hardcoded, customLines);
    const entries = JSON.parse(raw);
    if (entries.error) {
        throw new Error(`[walker] Rust walk failed: ${entries.error}`);
    }
    const maxFileSizeBytes = getMaxFileSizeBytes();
    const skippedLarge = [];
    const result = [];
    let processed = 0;
    for (const e of entries) {
        processed++;
        if (e.size > maxFileSizeBytes) {
            skippedLarge.push(e.path);
            onProgress?.(processed, entries.length, e.path);
            continue;
        }
        result.push(e);
        onProgress?.(processed, entries.length, e.path);
    }
    if (skippedLarge.length > 0) {
        warnLargeFileSkip(`  Skipped ${skippedLarge.length} large files (>${maxFileSizeBytes / 1024}KB)`);
        const preview = skippedLarge.slice(0, 5).sort();
        for (const p of preview) {
            warnLargeFileSkip(`  - ${p}`);
        }
        if (skippedLarge.length > 5) {
            warnLargeFileSkip(`  ...and ${skippedLarge.length - 5} more (set GITNEXUS_VERBOSE=1 to list them all)`);
        }
    }
    return result;
};
let nativeWalker = null;
function getNativeWalker() {
    if (nativeWalker)
        return nativeWalker;
    const candidates = [
        process.env.PARSE_NATIVE_NODE,
        new URL('./parse_native.node', import.meta.url).pathname,
        '/home/ts/RustNexus/parse_native/parse_native.node',
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            nativeWalker = require(c);
            return nativeWalker;
        }
        catch (e) {
            // try next
        }
    }
    throw new Error('parse_native.node not found (set PARSE_NATIVE_NODE) for GITNEXUS_WALKER_RUST=1');
}
/**
 * Phase 2: Read file contents for a specific set of relative paths.
 * Returns a Map for O(1) lookup. Silently skips files that fail to read.
 */
export const readFileContents = async (repoPath, relativePaths) => {
    const contents = new Map();
    const results = await mapConcurrent(relativePaths, async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { path: relativePath, content };
    }, { concurrency: READ_CONCURRENCY });
    // An unreadable file yields `undefined` (mapConcurrent's per-item degrade) and
    // is skipped, exactly as the previous allSettled/`status === 'fulfilled'` shape
    // did — no `onError`, so the skip stays silent per this function's contract.
    for (const result of results) {
        if (result)
            contents.set(result.path, result.content);
    }
    return contents;
};
