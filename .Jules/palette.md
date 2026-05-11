## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2026-05-11 - Missing ARIA Labels in Dynamically Injected Docks
**Learning:** An accessibility issue pattern specific to this app is that UI "docks" (like the DJ-7 player, Librarian, Audio HUD, and Vault HUD) are dynamically injected via template literals in TypeScript files (e.g., `src/world/dj.ts`) rather than statically defined in `index.html`. Consequently, their icon-only buttons consistently lack `aria-label`s, rendering them inaccessible to screen readers.
**Action:** When adding or modifying interactive UI components that appear as popups or docks over the 3D canvas, always verify the template literals in the corresponding TypeScript files to ensure `aria-label`s are applied to all icon-only buttons.
