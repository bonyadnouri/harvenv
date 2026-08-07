#!/bin/sh
# Executable on purpose: the executable bit is part of the Store's content hash
# (ADR 0010), so a materialized tree that lost it is a tree that failed its pin.
echo "harvenv-ci-demo"
