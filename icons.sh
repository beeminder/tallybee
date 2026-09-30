#!/bin/sh
# Make TallyBee's icons, and its link-preview image (og.png), from a square
# image like tally-strike@2x.png or tally-boop@2x.png, all of it, scaled down.
# Needs ImageMagick. Run it from this directory:
#   sh icons.sh tally-strike@2x.png
# Android crops the maskable icon to a circle or some other shape, and only the
# middle 80% of it is sure to show. So in that one the image shrinks to fit
# that 80% circle (the end of the disclosure at the bottom right is the part
# farthest from the center, 1327 of 2048 pixels out, so the icon is 3317 = 1327
# / 0.4 wide), and the pixels along the image's edges get stretched out to fill
# the rest. The link-preview image widens the image the same way, to 1200x630.
set -eu
src="$1"
# Make file $1 from the image, doing the rest of the arguments to it
make() { out="$1"; shift; magick "$src" -alpha off "$@" -strip "$out"; }
make icon-512.png -filter Lanczos -resize 512x512
make icon-192.png -filter Lanczos -resize 192x192
make apple-touch-icon.png -filter Lanczos -resize 180x180
make icon-maskable.png -virtual-pixel Edge \
     -set option:distort:viewport 3317x3317-634-634 -distort SRT 0 +repage \
     -filter Lanczos -resize 512x512
make og.png -virtual-pixel Edge \
     -set option:distort:viewport 3901x2048-927+0 -distort SRT 0 +repage \
     -filter Lanczos -resize '1200x630!'
