## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2026-05-17 - Manual Audit for Dynamically Injected UI Components
**Learning:** UI components (like docks and HUDs) dynamically injected via template literals in TypeScript files bypass normal HTML linters. As a result, critical accessibility attributes like `aria-label` for icon-only buttons are easily missed and must be manually audited.
**Action:** When working on or reviewing dynamically injected UI code, explicitly verify that all interactive elements have appropriate accessible names (e.g., `aria-label`) since automated linters won't catch them.
