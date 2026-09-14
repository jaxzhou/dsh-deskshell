#!/bin/sh
# Stands in for `npm` when the global prefix is not writable.
echo "npm error code EACCES" 1>&2
echo "npm error syscall mkdir" 1>&2
echo "npm error path /usr/local/lib/node_modules/@deepseek-ai" 1>&2
echo "npm error errno -13" 1>&2
echo "npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@deepseek-ai'" 1>&2
exit 243
