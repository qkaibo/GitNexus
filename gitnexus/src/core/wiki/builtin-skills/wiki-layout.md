# Skill: wiki-layout（版式 — MUST follow）

Visual presentation rules for wiki module pages. Pure Markdown only — no inline HTML for styling.

## Color chips (section markers)

- 🟢 intuition / foundation block at the top
- 🟠 main section headings
- 🟦 structure / concept callouts
- 🟣 analogy blocks
- 🔍 / 🟨 reading-the-diagram notes
- ✅ conclusions / why
- ⚠️ pitfalls
- 🔴 / 🧪 checkpoints

## Callout blockquotes

Use blockquotes as callout boxes:

- scene: `> 🎯 ...`
- 30-second intuition: `> 💡 ...`
- analogy: `> 📞 ...`
- read-the-diagram: `> 🔍 ...`
- conclusion/why: `> ✅ ...`
- pitfall: `> ⚠️ ...`
- checkpoint: `> 🧪 ...` (e.g. "看完本节你能回答…")

## Diagram budget

- Prefer tables over long prose for comparisons; emoji headers in the first table row are OK (e.g. `| 🗂 文件 | 📋 职责 |`).
- Use `- [ ]` checklists for checkpoints where natural.
- Mermaid: usually **1–2** diagrams per page (architecture and/or one key flow); hard cap **3**. Skip decorative diagrams.
- After every Mermaid: 2–3 plain sentences reading the diagram.
- Short pages (few files / thin module): you may omit extra diagrams and secondary callouts; keep at least scene + intuition when possible.

## Closing

End with a one-line color legend:

`> 🎨 色标图例: 🟦 结构/概念 · 🟠 主章节 · 🟩 结论 · 🟣 比喻 · 🟨 注意 · 🔴 检查点`

Domain-specific layout overrides may replace this file via repo skills / config; do not duplicate these rules in other skills.
