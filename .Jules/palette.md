## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2026-05-13 - Add ARIA Labels to Injected Templates
**Learning:** This app heavily relies on dynamically injected HTML templates constructed via literal strings inside TypeScript code (e.g., in `src/world/*.ts` for HUDs and docks). Since these templates bypass normal HTML linters and static checks, common accessibility issues like missing `aria-label` attributes on icon-only buttons often slip through unnoticed.
**Action:** When auditing for accessibility issues, actively search through template literals (`innerHTML = \`...\``) in TypeScript files, not just static HTML files.
