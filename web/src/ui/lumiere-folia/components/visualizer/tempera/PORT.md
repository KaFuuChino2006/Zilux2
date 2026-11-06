# Folia Tempera in Zilux2

Source: https://github.com/chthollyphile/folia-major, local v0.7.21 snapshot at
`research/repos/folia`. The snapshot does not contain verified commit metadata.
Copyright remains with the upstream authors. See `../../../LICENSE` and the
repository's `THIRD-PARTY-NOTICES.md` for attribution and license text.

The original program compiler, shot profiles, layouts, motion, camera,
compositions, inversion shader, transitions and print filters are retained.
Supporting Sonnet and Pixi modules are included only where required by this runtime.
Changes in imported files are limited to the MotionValue type import, unused
declarations rejected by this project's compiler, and omission of AI-directed comments.

`web/src/ui/flowScene.ts` adapts milliseconds to seconds, maps lyrics and word timing,
applies Zilux's positive lyric-clock offset, and drives the original `renderOnce`.
Folia's default Midnight theme and `DEFAULT_TEMPERA_TUNING` are used unchanged.
The persisted effect id remains `flow`; its displayed name is now 凝彩.
The React settings panel, image-library UI and subtitle-overlay UI are not ported.

Validation on 2026-11-06:

- TypeScript and Vite production build passed.
- Headless Edge: rendering, seeking, offset equivalence, activation, deactivation,
  and disposal during asynchronous creation passed without console errors.
- Compared against a separate copy of the unmodified upstream runtime and dependencies,
  using the same Pixi installation, lyrics, theme, seed and 1440 × 900 viewport.
  After warming both scene caches, PNG bytes matched at 4.2, 6.8, 8.2, 12.5,
  21.1 and 25.2 seconds. Initial cold-cache frames did not all match; this is a
  sampled warm-cache comparison, not a claim of universal pixel identity.
- Desktop and 390 × 844 viewport screenshots were captured. Font availability,
  theme, input timing, seed and upstream version remain relevant to visual matching.

## Zilux customization (2026-11-06)

The `flowSettings.ts` panel now adds independent background/text palettes, cover
colour input, deterministic paragraph palette rotation and custom colours.
`flowScene.ts` can override shot flow angles for horizontal, diagonal and mixed
entries. `temperaSceneBuilder.ts` applies the selected palette, and hand-off
travel honours camera intensity. Original colour/motion options remain available;
custom modes intentionally differ from the upstream defaults. Cover colours are
provided by Zilux's cached cover extractor, independently of the DOM lyric colour mode.

## Expanded settings and MG library

`flowSettingsPanel.ts` uses the same `sheet / text-sheet / vinyl-sheet / ts-*`
layout as PV settings: independent live preview, grouped controls, reset, cancel,
save and Escape cleanup. Draft values never alter saved or live player settings
until Save. `flowSettings.ts` normalizes 31 persisted controls and supports older
saved values through defaults.

`flowMg.ts` provides 32 original vector compositions across eight families.
The song compiler assigns optional `mgVariants` arrays; `temperaBlocks.ts` routes
those shots to the new drawers while retaining the original absolute-time block
animation, camera, lyric layout and transitions. Automatic mode mixes original
and new shots; manual multi-selection plays all selected variants simultaneously, without category filters. Automatic mode combines 1–6 distinct variants per shot (default 3). Layer density and opacity are normalized by the square root of layer count. Legacy single selections migrate to one selected layer; the stored original camera mode is displayed as 默认运镜.

Validation: all 32 variants rendered in headless Edge without console errors;
32 distinct screenshot sizes were produced and a contact sheet inspected.
The styled panel displayed six groups, 16 parameter sliders plus a seek slider,
32 catalogue buttons and one preview canvas. Save/reopen, cancel persistence and
Escape cleanup passed. TypeScript and Vite production build passed; payloads
were copied and SHA-256 checked in the installed and portable application folders.

MG playback defaults to sequential rotation of the complete 193-item pool: all 121 original lyric-aware Tempera shot compositions plus 72 added MG variants, one composition per shot. Original styles are individually selectable and the automatic order interleaves both families. Choosing an original style overrides only its composition drawer; lyric layout, camera and transitions remain those compiled for the shot. In overlay mode, selected original styles rotate as backgrounds while the selected MG variants layer together. Explicit selections preserve their order. Automatic overlay count and frequency controls are hidden in rotation mode. The original IDs 32–152 are frozen; the second MG batch uses IDs 153–192 so existing saved selections keep their meaning.
