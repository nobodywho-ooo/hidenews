#!/bin/sh
# load unpacked in firefox
open --new -a Firefox "about:debugging#/runtime/this-firefox" 2>/dev/null || true
echo "focus Firefox -> Load Temporary Add-on -> extension/manifest.json"
