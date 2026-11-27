// Reads a plain text file into the common book shape (see index.js).

import { findTextTables } from '../text/cleanup.js';

export async function readPlainText(file) {
  // Plain text is often hard-wrapped; join lines within a paragraph.
  const text = (await file.text()).replace(/\r/g, '').replace(/([^\n])\n(?!\n)/g, '$1 ');
  return { text, title: '', author: '', publisher: '', year: '', toc: [], pages: [], figures: findTextTables(text), images: [] };
}
