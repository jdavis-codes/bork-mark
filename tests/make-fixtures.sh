#!/bin/sh
# Builds the test media into tests/fixtures/ (not committed). Needs ffmpeg and
# python3; the speech book also downloads a short public recording of spoken
# test sentences (Open Speech Repository, Harvard sentences list 1).
set -e
cd "$(dirname "$0")"
mkdir -p fixtures && cd fixtures
if [ -f book.m4b ] && [ -f speech.m4b ] && [ -f chapters.m4b ]; then
  [ -f extras.pdf ] || python3 ../make-texts.py   # added later than the media
  exit 0
fi

# A 3-minute tone with two chapters and long titles, plus a text and an EPUB
# (contents, a picture and a table) to go with it.
printf ';FFMETADATA1\ntitle=Test Book With A Rather Long Title That Needs To Scroll Across\nartist=Some Author\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=60000\ntitle=Chapter One: A Very Long Chapter Title Indeed That Scrolls\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=60000\nEND=180000\ntitle=Chapter Two\n' > book-meta.txt
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=220:duration=180" -i book-meta.txt -map_metadata 1 -c:a aac -b:a 32k book.m4b

# Spoken sentences: as a book with no chapters, and as one with two chapters
# whose second starts where the speech does.
curl -sfL -o osr.wav https://www.voiptroubleshooter.com/open_speech/american/OSR_us_000_0010_8k.wav
ffmpeg -loglevel error -y -i osr.wav -f lavfi -t 26 -i anullsrc=r=8000:cl=mono \
  -filter_complex "[0][1]concat=n=2:v=0:a=1,aresample=44100,pan=stereo|c0=c0|c1=c0" -c:a aac -b:a 96k speech.m4b
printf ';FFMETADATA1\ntitle=Speech Book\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=15000\ntitle=Track 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=15000\nEND=75000\ntitle=Track 2\n' > chapters-meta.txt
ffmpeg -loglevel error -y -f lavfi -t 15 -i anullsrc=r=8000:cl=mono -i osr.wav -f lavfi -t 26 -i anullsrc=r=8000:cl=mono -i chapters-meta.txt \
  -filter_complex "[0][1][2]concat=n=3:v=0:a=1,aresample=44100,pan=stereo|c0=c0|c1=c0[a]" -map "[a]" -map_metadata 3 -map_chapters 3 -c:a aac -b:a 96k chapters.m4b

python3 ../make-texts.py
