// Where a book's text comes from. Each kind of file has a reader that turns it
// into the same shape, so everything after this (matching, quotes, figures,
// citations) doesn't care which kind it was:
//
//   { text,                        the whole book as one string
//     title, author, publisher, year,  '' when the file doesn't say
//     toc:   [{ label, at, depth }],  contents entries; `at` is a character position in text,
//                                  `depth` how far it is nested (0 at the top; may be missing)
//     pages: [{ label, at }],      print page numbers, when the file records them
//     figures: [{ at, kind: 'image' | 'table', cap, img | rows }],   img indexes images
//     images: [Blob] }
//
// A new kind of file (a PDF of the book, say) needs only a reader here.

import { readEpub } from './epub.js';
import { readMarkdown } from './markdown.js';
import { readPlainText } from './plain-text.js';

export function readBook(file) {
  if (/\.epub$/i.test(file.name)) return readEpub(file);
  return /\.(md|markdown|mdown)$/i.test(file.name) ? readMarkdown(file) : readPlainText(file);
}
