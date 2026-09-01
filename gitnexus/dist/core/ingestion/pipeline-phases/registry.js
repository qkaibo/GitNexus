/**
 * Phase registry seam (issue #2080, taint/PDG substrate M0).
 *
 * A small, behaviour-preserving abstraction over phase-list *assembly*. Today
 * `buildPhaseList` is a hand-maintained array with a single ad-hoc
 * `if (!skipGraphPhases)` guard; this registry generalises that guard into a
 * per-phase `enabledWhen` predicate so later milestones can register opt-in
 * phases (e.g. CFG → M1 #2081) without editing the array each time.
 *
 * M0 wires the seam with **no behaviour change**: `build(options)` must return
 * a phase list identical in membership and order to the legacy array for every
 * options combination. The registry covers only list assembly — the runner,
 * topological sort, `PipelinePhase.execute`, and any result-extraction guards
 * (e.g. the `skipGraphPhases` check in `runPipelineFromRepo`) are untouched.
 *
 * Generic over the options type so this module depends only on `PipelinePhase`
 * (no import of `PipelineOptions`, which lives in `pipeline.ts` and would
 * otherwise create an import cycle).
 */
/**
 * Ordered registry of pipeline phases. Not a global singleton — callers
 * construct a fresh registry (so registration order is deterministic and there
 * is no import-order or test-isolation hazard) and `build()` it per run.
 */
export class PhaseRegistry {
    registrations = [];
    /**
     * Register a phase. This is the `registerPhase(phase, { enabledWhen })` seam
     * named in issue #2080. Returns `this` for fluent chaining. Registration
     * order is preserved by `build()`.
     */
    register(phase, options) {
        // R1-⑧: enabledWhen=false 的相位整体移出列表(而不是留下相位让
        // topologicalSort 撞"依赖未注册"错)。它的下游依赖者按链路裁剪。
        this.registrations.push({ phase, enabledWhen: options?.enabledWhen });
        return this;
    }
    /**
     * Build the ordered phase list for the given options. A phase is included
     * iff it has no `enabledWhen` predicate or its predicate returns `true`.
     * Order matches registration order. `options` is required — callers that may
     * have no options normalize once at the call site (`options ?? {}`) so the
     * predicates never see `undefined`.
     */
    build(options) {
        // R1-⑧(ADR-029): 先按 enabledWhen 淘汰, 再级联移除"依赖了被淘汰相位"
        // 的相位(传递闭包)——否则 topologicalSort 撞死 'dep not registered'。
        // 语义: 关掉 X = 连锁关掉所有硬依赖 X 的相位。enabledWhen 原语义不变
        // (pdg 门等无人依赖的相位不受影响)。
        const alive = this.registrations.filter((r) => r.enabledWhen === undefined || r.enabledWhen(options));
        for (;;) {
            const names = new Set(alive.map((r) => r.phase.name));
            const dead = new Set();
            for (const r of alive) {
                if (r.phase.deps.some((d) => !names.has(d)))
                    dead.add(r);
            }
            if (dead.size === 0)
                break;
            for (const r of dead) {
                const ix = alive.indexOf(r);
                if (ix >= 0)
                    alive.splice(ix, 1);
            }
        }
        return alive.map((r) => r.phase);
    }
}
