# AGENTS.md

Guidance for coding agents working in this repository.

## Repository snapshot

- Project name: `plugin_hyphenation`
- Current state: minimal repository (only `README.md` at time of writing)
- Language/tooling: not yet established

Because this repo is intentionally sparse, prioritize small, reversible changes and avoid introducing heavy scaffolding unless explicitly requested.

## Core working rules

1. Keep scope tight.
   - Implement only what was requested.
   - Do not perform broad refactors without an explicit ask.
2. Prefer incremental changes.
   - Create the smallest useful file/layout needed for the task.
   - Preserve backward compatibility once interfaces exist.
3. Make behavior explicit.
   - Document assumptions in code comments or commit messages when requirements are ambiguous.
4. Avoid speculative dependencies.
   - Do not add frameworks or packages unless required for the requested feature.
   - If adding dependencies is necessary, use the latest stable release.

## File and structure conventions

- Follow existing conventions when files are present.
- If creating new structure from scratch, prefer:
  - `src/` for implementation code
  - `tests/` for automated tests
  - concise top-level docs (`README.md`, `AGENTS.md`, and task-specific docs only)
- Keep top-level directory clean; avoid unnecessary config files.

## Testing and verification

- For every non-trivial logic change, add or update tests when a test framework exists.
- If no test framework exists yet:
  - include a short verification section in your final notes describing what was validated.
  - avoid inventing large test infrastructure unless requested.

## Commit hygiene

- Use clear, descriptive commit messages.
- Keep commits focused on one logical change.
- Do not rewrite history unless explicitly instructed.

## Communication expectations (for agents)

- Briefly summarize:
  - what changed,
  - why it changed,
  - how it was validated,
  - and any follow-up work.
- Call out tradeoffs and unknowns instead of silently guessing.

## If requirements are unclear

- Choose the least risky implementation that can be extended later.
- Leave short TODO notes only when they are actionable and necessary.
