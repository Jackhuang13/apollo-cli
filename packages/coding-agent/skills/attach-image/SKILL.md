---
name: attach-image
description: Attach a PNG, JPEG, GIF, or WEBP image from disk into the active cell output so vision-capable models and the TUI can inspect it. Import via `import { attach_image } from "attach_image"`.
---

# `attach-image` — Attach Images for Visual Inspection

Attach an image file from disk to the current cell's display output so it is rendered in the TUI and forwarded to vision-capable models.

## Import

```ts
import { attach_image, AttachImageError } from "attach_image";
```

## Usage

```ts
attach_image("artifacts/plot.png");
attach_image("screenshots/ui.webp", { label: "Dashboard state after login" });
```

Supported formats (detected by magic bytes): PNG, JPEG, GIF, WEBP.
