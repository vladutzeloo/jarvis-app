## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.
## 2024-05-15 - Dynamic UI Components require inline attributes
**Learning:** UI components in `src/world/` are injected using template literals within TypeScript, which requires that accessibility attributes like `aria-label` be inline within the templates rather than static HTML.
**Action:** Always check the TS source files for dynamically injected UI to address accessibility missing features.
