## 2026-05-09 - Precomputing toLowerCase() for Vault Search
**Learning:** In applications implementing full-text search against memory objects across keystroke inputs, invoking `.toLowerCase()` repetitively on string fields introduces substantial CPU overhead and blocks the main thread. Caching the lowercase strings ahead of time significantly improves latency during search.
**Action:** When evaluating full-text search components on frontend objects, look out for on-the-fly repeated lowercase transformations. Always precompute lowercase strings when indexing memory items intended for search.
