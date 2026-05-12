## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2026-05-10 - Add ARIA Labels to dynamically injected icon-only buttons
**Learning:** Found multiple icon-only buttons inside `src/world/*.ts` files (like audio HUD, vault HUD, librarian dock, DJ dock). Because these UI components are dynamically injected via template literals in TypeScript files rather than being statically defined in `index.html`, they can easily lack proper accessibility attributes if not careful.
**Action:** Added descriptive `aria-label` attributes to these dynamically injected icon-only buttons to ensure screen reader accessibility, reinforcing the need to audit TS template literals for a11y just like standard HTML.
