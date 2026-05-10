## 2026-05-09 - Add ARIA Labels to Icon-Only Buttons
**Learning:** Found multiple icon-only buttons (like settings, research, voice, camera toggles) in the main toolbar that lacked accessible names. Because they rely entirely on emojis (⚙, 🔬, 🔊, 📹), screen reader users would only hear the emoji names (which may be inaccurate or unhelpful in this context).
**Action:** Added descriptive `aria-label` attributes to these buttons to provide clear context (e.g., 'Open settings', 'Toggle text to speech') without altering the visual design.

## 2024-05-10 - Inputs Missing Explicit Labels
**Learning:** Inputs (like textareas or search fields) that rely solely on `placeholder` text or adjacent icon buttons without explicit `<label>` elements are not fully accessible to screen readers.
**Action:** Always ensure such inputs have an appropriate `aria-label` attribute (e.g., `aria-label="Chat input"`) to provide necessary context.
