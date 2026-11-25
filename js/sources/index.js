// Where a book's text comes from. Each kind of file has a reader that turns it
// into the same shape, so everything after this (matching, quotes, figures,
// citations) doesn't care which kind it was:
//
//   { text,                        the whole book as one string
//     title, author, publisher, year,  '' when the file doesn't say
//     toc:   [{ label, at }],      contents entries; `at` is a character position in text
//     pages: [{ label, at }],      print page numbers, when the file records them
//     figures: [{ at, kind: 'image' | 'table', cap, img | rows }],   img indexes images
//     images: [Blob] }
//
// A new kind of file (a PDF of the book, say) needs only a reader here.

import { readEpub } from './epub.js';
import { readPlainText } from './plain-text.js';

export function readBook(file) {
  return /\.epub$/i.test(file.name) ? readEpub(file) : readPlainText(file);
}
