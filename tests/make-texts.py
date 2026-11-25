# Writes the text and EPUB fixtures next to the audio (run from tests/fixtures).
import random, struct, zipfile, zlib
WORDS = "the quick brown fox jumps over a lazy dog while reading old books under quiet lamps and thinking".split()
HARVARD = ["The birch canoe slid on the smooth planks.", "Glue the sheet to the dark blue background.", "It's easy to tell the depth of a well.",
           "These days a chicken leg is a rare dish.", "Rice is often served in round bowls.", "The juice of lemons makes fine punch.",
           "The box was thrown beside the parked truck.", "The hogs were fed chopped corn and garbage.", "Four hours of steady work faced us.",
           "Large size in stockings is hard to sell."]
def para(rng): return " ".join((" ".join(rng.choice(WORDS) for _ in range(rng.randint(6, 14)))).capitalize() + "." for _ in range(4))
def png(rng, w=64, h=64):   # noisy, so it is big enough (over 4 KB) to count as a picture
    raw = b''.join(b'\x00' + bytes(rng.randrange(256) for _ in range(w * 3)) for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 0)) + chunk(b'IEND', b'')
def epub(name, title, author, chapters, extra=None):
    """chapters: [(heading, html body)]"""
    z = zipfile.ZipFile(name, 'w')
    z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
    z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    items = ''.join('<item id="c%d" href="c%d.xhtml" media-type="application/xhtml+xml"/>' % (i, i) for i in range(len(chapters)))
    if extra: items += '<item id="pic" href="pic.png" media-type="image/png"/>'
    z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>%s</dc:title><dc:creator>%s</dc:creator><dc:publisher>Test Press</dc:publisher><dc:date>1922-01-01</dc:date></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>%s</manifest><spine>%s</spine></package>'
               % (title, author, items, ''.join('<itemref idref="c%d"/>' % i for i in range(len(chapters)))))
    z.writestr('OEBPS/nav.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>%s</ol></nav></body></html>'
               % ''.join('<li><a href="c%d.xhtml#h%d">%s</a></li>' % (i, i, h) for i, (h, _) in enumerate(chapters)))
    for i, (h, body) in enumerate(chapters):
        z.writestr('OEBPS/c%d.xhtml' % i, '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>%s</title></head><body><h1 id="h%d">%s</h1>%s</body></html>' % (h, i, h, body))
    if extra: z.writestr('OEBPS/pic.png', extra)
    z.close()

rng = random.Random(1)
open('book.txt', 'w').write('\n\n'.join(para(rng) for _ in range(60)))
rng = random.Random(2)
fig = '<figure><img src="pic.png" alt="A drawing"/><figcaption>Figure 1. A drawing of a fox</figcaption></figure><table><caption>Table 1. Costs</caption><tr><th>Year</th><th>Cost</th></tr><tr><td>1909</td><td>$950</td></tr><tr><td>1910</td><td>$780</td></tr></table>'
ps = lambda n: ''.join('<p>%s</p>' % para(rng) for _ in range(n))
epub('book.epub', 'The Epub Title', 'Epub Author', [('Chapter 1', ps(8) + fig + ps(8)), ('Chapter 2', ps(16))], extra=png(rng))
rng = random.Random(3)
open('speech.txt', 'w').write('\n\n'.join([para(rng) for _ in range(5)] + [' '.join(HARVARD[:5]), ' '.join(HARVARD[5:])] + [para(rng) for _ in range(5)]))
rng = random.Random(4)
epub('chapters.epub', 'Speech Book', 'A', [('Opening Remarks', ps(6)), ('The Harvard Sentences', '<p>%s</p><p>%s</p>' % (' '.join(HARVARD[:5]), ' '.join(HARVARD[5:])) + ps(4))])
