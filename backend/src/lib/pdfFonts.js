'use strict';

const path = require('path');

/**
 * Fonts for every PDF the API issues.
 *
 * PDFKit's built in Helvetica is a WinAnsi font with no glyph for the naira sign
 * (U+20A6), so "₦68,500.00" printed as a stray bar and a number. Liberation Sans
 * is metrically compatible with Helvetica, so layouts measured against it are
 * unchanged, and it carries ₦. It ships with the app (SIL OFL 1.1, licence
 * alongside the files) rather than being read from the host, because Render's
 * image has no fonts installed.
 */
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const SANS = 'Sans';
const SANS_BOLD = 'Sans-Bold';

/** Register the shared faces on a PDFKit document and return it. */
function registerFonts(doc) {
  doc.registerFont(SANS, path.join(FONT_DIR, 'LiberationSans-Regular.ttf'));
  doc.registerFont(SANS_BOLD, path.join(FONT_DIR, 'LiberationSans-Bold.ttf'));
  return doc;
}

module.exports = { registerFonts, SANS, SANS_BOLD };
