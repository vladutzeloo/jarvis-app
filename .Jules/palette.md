## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2024-05-14 - Dynamically Injected HTML and Accessibility Audits
**Learning:** UI components (like HUDs and docks) dynamically injected via template literals in TypeScript files (e.g., in `src/world/*.ts`) bypass standard HTML linters. This means accessibility issues, such as missing `aria-label`s on icon-only buttons, can easily slip through automated checks.
**Action:** When adding or reviewing dynamically injected UI components in TypeScript files, manually audit the template strings for accessibility best practices, specifically checking for missing `aria-label`s on icon-only interactive elements.
