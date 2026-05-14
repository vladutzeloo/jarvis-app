## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.
## 2026-05-14 - Add ARIA Labels to Dynamically Injected UI
**Learning:** This app extensively uses TypeScript template literals to dynamically inject HTML for UI overlays (like the DJ dock, Librarian, Audio HUD, and Vault) in the `src/world/` directory. Accessibility issues like missing `aria-label`s on icon-only buttons exist in these injected HTML strings just as they do in static HTML files.
**Action:** When auditing or fixing accessibility, remember to search through TypeScript files for injected HTML (`.innerHTML = \``) to ensure dynamically rendered elements are also accessible.
