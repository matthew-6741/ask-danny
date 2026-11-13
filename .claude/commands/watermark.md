---
description: Find or remove hidden and odd characters (zero-width, soft hyphens, direction controls, no-break spaces) in files or pasted text, using the same cleanup Ask Danny runs on model answers
argument-hint: "[--fix] <file>... | pasted text"
---

Run Ask Danny's answer cleanup (`cleanModelText` in
`netlify/functions/ai-council.js`) through `eval/watermark.js`.

Arguments: $ARGUMENTS

- If the arguments are file paths (optionally with `--fix`), run
  `node eval/watermark.js $ARGUMENTS` from the repository root and report
  what it found per file. Without `--fix` nothing is changed; say that `--fix`
  cleans the files in place.
- If the arguments are text rather than paths, or there are none and the
  person pasted text, write the text to a scratch file, run
  `node eval/watermark.js -` with that file on stdin, and give back the
  cleaned text and how many characters were removed.
- With no arguments and nothing pasted, check the files changed on this
  branch: `git diff --name-only main...HEAD` filtered to text files.

This only removes hidden and unusual characters. It does not strip
AI-provenance watermarks or rewrite text, and photo metadata needs no command:
the page already redraws every photo and video frame on a canvas before upload,
which leaves out EXIF, GPS and camera data.
