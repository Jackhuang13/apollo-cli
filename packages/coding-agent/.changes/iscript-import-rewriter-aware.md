# Changelog fragment

- Fixed the IScript kernel's import rewriter so import-like text inside strings, template literals, and comments is no longer rewritten into broken code.
- Fixed awaited dynamic-import chains (for example `await import("node:fs").readFileSync(...)`) so the member or call after the import still binds to the resolved module.
