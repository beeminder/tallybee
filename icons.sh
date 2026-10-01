#!/bin/sh
# Make TallyBee's icons, and its link-preview image (og.png), from a square
# image like tally-strike@2x.png or tally-boop@2x.png, all of it, scaled down.
# Needs ImageMagick. Run it from this directory:
#   sh icons.sh tally-strike@2x.png
# Android crops the maskable icon to a circle or some other shape, and only the
# middle 80% circle of it is sure to show. So that icon centers on the smallest
# circle that holds all of the image's drawing, disclosure included, and makes
# it that 80% circle, with the pixels along the image's edges stretched out to
# fill the rest. For tally-strike@2x.png that circle is centered at (1160, 1334)
# and reaches 1024.7 pixels out, to the disclosure's two ends, so the icon is
# 2564 (> 1024.7 / 0.4) pixels wide, starting 122 pixels left of the image and
# 52 down. (That circle holds all of tally-boop@2x.png's drawing too, though a
# smaller one would do for it. Another image needs its own numbers.) The
# link-preview image widens the image the same way, to 1200x630.
set -eu
src="$1"
# Make file $1 from the image, doing the rest of the arguments to it
make() { out="$1"; shift; magick "$src" -alpha off "$@" -strip "$out"; }
make icon-512.png -filter Lanczos -resize 512x512
make icon-192.png -filter Lanczos -resize 192x192
make apple-touch-icon.png -filter Lanczos -resize 180x180
make icon-maskable.png -virtual-pixel Edge \
     -set option:distort:viewport 2564x2564-122+52 -distort SRT 0 +repage \
     -filter Lanczos -resize 512x512
make og.png -virtual-pixel Edge \
     -set option:distort:viewport 3901x2048-927+0 -distort SRT 0 +repage \
     -filter Lanczos -resize '1200x630!'
