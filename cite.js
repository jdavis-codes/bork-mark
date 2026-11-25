// Turns a book's details and a place in it into one line of citation text.
// Plain text only: no italics, since the result is copied and shared as text.

export const STYLES = { simple: 'Simple', mla: 'MLA', apa: 'APA', chicago: 'Chicago' };

// "Henry Ford, Samuel Crowther" -> [{first: 'Henry', last: 'Ford'}, …].
// Names are taken as written, given name first; the last word is the surname.
function people(author) {
  return (author || '').split(/\s*(?:;|,|&|\band\b)\s*/).map((n) => n.trim()).filter(Boolean).map((name) => {
    const words = name.split(/\s+/);
    return { name, first: words.slice(0, -1).join(' '), last: words[words.length - 1] };
  });
}
const inverted = (p) => (p.first ? p.last + ', ' + p.first : p.last);
const initials = (p) => (p.first ? p.last + ', ' + p.first.split(/[\s-]+/).map((w) => w[0].toUpperCase() + '.').join(' ') : p.last);
const list = (items, and) => (items.length < 2 ? items.join('') : items.length === 2 ? items.join(' ' + and + ' ')
  : items.slice(0, -1).join(', ') + ', ' + and + ' ' + items[items.length - 1]);
// End a piece with a full stop unless it already ends a sentence.
// The stop goes inside a closing quotation mark.
const stop = (text) => (!text ? '' : /[.!?]["”’]*$/.test(text) ? text : /”$/.test(text) ? text.slice(0, -1) + '.”' : text + '.');
const join = (parts, sep) => parts.filter(Boolean).join(sep);

const FORMATS = {
  // Henry Ford, My Life and Work, “Chapter X”, p. 148
  simple(s) {
    return join([s.author, s.title, s.section && '“' + s.section + '”', s.page && 'p. ' + s.page], ', ');
  },
  // Ford, Henry. My Life and Work. Doubleday, 1922, p. 148.
  mla(s) {
    const who = people(s.author);
    const names = who.length > 2 ? inverted(who[0]) + ', et al' : who.length === 2 ? inverted(who[0]) + ', and ' + who[1].name : who.map(inverted).join('');
    const chapter = !s.page && s.section ? '“' + stop(s.section) + '”' : '';
    return join([stop(names), chapter, stop(s.title), stop(join([s.publisher, s.year, s.page && 'p. ' + s.page], ', '))], ' ');
  },
  // Ford, H. (1922). My Life and Work (p. 148). Doubleday.
  apa(s) {
    const who = people(s.author).map(initials);
    const names = who.length > 1 ? who.slice(0, -1).join(', ') + ', & ' + who[who.length - 1] : who.join('');
    const where = s.page ? 'p. ' + s.page : s.section;
    const title = s.title + (where ? ' (' + where + ')' : '');
    return join([names ? stop(names) + ' (' + (s.year || 'n.d.') + ').' : '', names ? stop(title) : stop(title) + ' (' + (s.year || 'n.d.') + ').', stop(s.publisher)], ' ');
  },
  // Henry Ford, My Life and Work (Doubleday, 1922), 148.
  chicago(s) {
    const who = people(s.author).map((p) => p.name);
    const names = who.length > 3 ? who[0] + ' et al.' : list(who, 'and');
    const made = join([s.publisher, s.year], ', ');
    return stop(join([names, s.title + (made ? ' (' + made + ')' : ''), s.page || (s.section && '“' + s.section + '”')], ', '));
  },
};

// source: { author, title, publisher, year, section, page, time }
// options: { style, audioTime, audioText } where audioText may contain {time}
export function formatCitation(source, options = {}) {
  const format = FORMATS[options.style] || FORMATS.simple;
  let line = format(source);
  if (options.audioTime !== false && source.time) {
    const wording = (options.audioText || 'audiobook, {time}').trim();
    line += ' (' + (wording.includes('{time}') ? wording.replace('{time}', source.time) : join([wording, source.time], ' ')) + ')';
  }
  return line;
}
