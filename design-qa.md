# Atelier homepage design QA

## Scope

- Integrated the Atelier Apple-inspired layout into the production React homepage.
- Preserved the existing upload, background-removal API, agent polling, history, comparison slider, background controls, colour controls, and PNG export flows.
- Removed visible Traditional Chinese UI copy across the client and user-facing worker errors.
- Forced the product surface to a white light theme.

## States reviewed

- Empty: split hero with custom upload/drop zone and workflow markers.
- Processing: dedicated progress state with live agent status copy.
- Studio / Ready: comparison canvas, background controls, effects, colour grading, history, and export actions.
- Settings: English-only labels and the existing Manyfold / Cloudflare controls.

## Verification

- Layout hotfix verified: the homepage now pins the hero copy to the left grid area and the upload card to the right grid area, with legacy landing selectors overridden.
- `npm test` — 8 test files, 93 tests passed.
- `npm run check` — TypeScript, Vite production build, and Wrangler deploy dry-run passed.
- `git diff --check` — passed.
- Session history now uses IndexedDB with legacy localStorage migration, keeps every result for 24 hours, and removes expired records automatically; Studio controls have an intentional 16px header-to-tabs gap.
- Local preview: `http://127.0.0.1:5173/`

final result: passed
