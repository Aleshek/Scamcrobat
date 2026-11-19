# Changelog

What changed in each version of Scamcrobat. The newest version is at the top.
The release notes on GitHub are taken from this file when a version is released.

## 0.8.0 – 2026-11-19

- **New version notice** (desktop): once a day the app asks GitHub for the number of the
  latest version and shows a small notice when a newer one is out. Nothing about you or your
  documents is sent; it can be turned off on the start page
- Double-clicking a word selects exactly that word: the last word of a line no longer selects
  the first word of the next line, and in documents whose words are separated by gaps instead
  of spaces it no longer selects the whole line
- The start page shows the version number and a link to the project on GitHub
- Release notes come from this changelog, and every installer has its SHA-256 checksum next to it
- How to report a security problem privately (SECURITY.md) and forms for reporting bugs and ideas
- New screenshots in the README, made by a script (`npm run screenshots`)
- Automated tests: the PDF engine (saving, redaction, text correction, passwords, page tools,
  images, file size) and the web version in a real browser run on every change and before
  every release
- Development builds keep their own settings and recent files, apart from the installed app
- Electron 45.4.1 (security fixes of Chromium)

## 0.7.0 – 2026-11-18

- **PDF from images**: JPG, PNG, GIF, BMP, TIFF and WebP images (opened, dropped or sent with
  "Open with") become a new PDF with a page for each image; scans keep their size, photos and
  screenshots go on A4 or Letter with 10 mm margins
- "Insert file" in the page organizer also takes images
- **Reduce file size**: saves a smaller copy – images scaled down by the chosen preset, private
  data and thumbnails dropped, fonts subset; secured documents keep their passwords
- The installer adds Scamcrobat to "Open with" for images (never as the default)

## 0.6.1 – 2026-11-18

- Search finds every word again on pages that were already shown (MuPDF stored an
  uninitialised character for some symbols Word uses for parentheses, and the rest of the page
  could not be found)

## 0.6.0 – 2026-11-18

- **View menu**: rotate the view without changing the file, two pages side by side (with or
  without a cover page), full screen (Ctrl+L, F11)
- Merging keeps the bookmarks of every merged or inserted file, each under a bookmark named
  after the file
- **Crop pages**: drag a box or set the margins in mm, for one page, all pages or a range
- **Watermark** (text, size, color, opacity, rotation, over or under the content) and
  **page numbers** (position, format, first number, which pages)

## 0.5.1 – 2026-11-18

- Secured documents are respected: printing, copying, changes, comments, form filling and
  organizing pages follow the document's permissions; a bar says what is not allowed, and the
  permissions password unlocks it until the document is closed

## 0.5.0 – 2026-11-18

- **Redaction** (black out text or an area): text, images, drawings and links under the black
  box are really removed, not just covered
- **Correcting text line by line**: the line is written again in place with the same font, size
  and color; missing letters come from metric-compatible fonts
- **Password protection**: an open password and/or restrictions of printing, copying and
  changes, AES-256
- After a redaction, a text correction or a protection change the whole file is written again,
  so nothing removed stays in it

## 0.4.0 – 2026-11-13

- **Comments**: highlight, underline and strike out text, sticky notes, text boxes and freehand
  drawing; move, resize, recolor and delete them; undo/redo
- **Filling in PDF forms**: text fields, check boxes and drop-down lists
- **Signing**: draw a signature or load a photo of it, place it on the page or into a signature
  field; up to four signatures can be remembered on the device
- Clickable links to pages and web pages
- Recent files on the start page (desktop); documents reopen on the page where you left them
- Changes are appended to the file when saving, so the original content stays intact

## 0.3.0 – 2026-11-13

- English and Czech user interface (follows the system, can be switched on the start page)
- **Printing**: all pages, the current one or a range; every sheet keeps the size and
  orientation of its page
- **Tabs** for several open documents (Ctrl+Tab, Ctrl+W, Ctrl+T)
- Search ignores case and diacritics

## 0.2.0 – 2026-11-13

- First public version: PDF viewer (pages, thumbnails, bookmarks, zoom, search, copying text),
  export of pages to JPG, PNG or WebP, organizing pages (rotate, delete, reorder, insert from
  other PDFs), merging, splitting and extracting pages, Save and Save as, a Windows installer
  and a web version
