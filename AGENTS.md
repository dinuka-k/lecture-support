# Agent guide: lecture demos

Interactive teaching canvases by Dinuka Kodithuwakku, hosted on GitHub Pages
(dinuka-k.github.io/lecture-support).

## Structure
- One folder per demo: `<demo>/index.html` plus its own `.css` and `.js` files.
- Every demo is linked as a card from the root `index.html` hub, inside the
  right category section: **Database Systems (DBMS)** (`#cat-dbms`) or
  **Data Structures & Algorithms** (`#cat-dsa`). Update the section's
  "N demos" count when adding a card. A new subject area gets its own section
  with the same `.cat` / `.cat-head` / `.cat-badge` markup.
- Shared look and helpers live in `shared/theme.css` (color tokens, light/dark)
  and `shared/shell.js` (theme toggle, fullscreen, author name, watermark).
- No external dependencies and no ES modules: pages must work offline and when
  opened straight from disk (`file://`).

## Author credit (required on every page)
- The author's name is defined once, as `AUTHOR` in `shared/shell.js`. Never
  hard-code it elsewhere.
- Every page must load `../shared/theme.css` and `../shared/shell.js` (end of
  `<body>`). shell.js then adds the **watermark**: a translucent "by Dinuka
  Kodithuwakku" pill in the bottom-right corner of the drawing area.
  - It attaches to the element marked `data-watermark-host`, else the parent of
    the first `<canvas>`, else the window corner.
  - If it collides with overlays, move it with the CSS variables
    `--watermark-bottom` / `--watermark-right` on the host: do not remove it,
    and do not draw a separate watermark on the canvas.
  - Only the hub may opt out (`<body data-no-watermark>`); demos must not.
- Each page also carries `<meta name="author" content="Dinuka Kodithuwakku">`
  and a "Created by <b data-author></b>" credit line in its help modal.

## Teaching conventions
- Step-by-step playback (prev / next / play), a caption per step, synced
  pseudocode, a steps side panel, and a speed slider.
- Keep animations evenly paced; no built-in speed-ups: the lecturer uses the
  speed slider.
- Projector screens are short (~720–810 px): keep vertical chrome minimal.

## Writing style for on-screen text
- Never use em dashes (the long dash) in any text a viewer sees: captions,
  toasts, pseudocode, labels, help text, hub cards. Use a colon, comma, period
  or middle dot instead. Use a plain hyphen for an empty cell.
