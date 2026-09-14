#!/bin/sh
# Stands in for `npm` in tests: prints the lines a real global install emits.
echo "npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5.tgz 41ms (cache miss)"
echo "npm http fetch GET 200 https://registry.npmjs.org/cordis/-/cordis-4.0.2.tgz 12ms (cache miss)"
echo "npm http fetch GET 200 https://registry.npmjs.org/commander/-/commander-15.0.0.tgz 9ms (cache miss)"
echo "npm warn deprecated foo@1.0.0: use bar instead"
echo "npm http fetch GET 200 https://registry.npmjs.org/js-yaml/-/js-yaml-4.2.0.tgz 8ms (cache miss)"
echo "npm http fetch GET 200 https://registry.npmjs.org/zod/-/zod-3.23.0.tgz 7ms (cache miss)"
echo "added 284 packages in 11s"
exit 0
