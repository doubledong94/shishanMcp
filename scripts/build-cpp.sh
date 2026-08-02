#!/bin/sh
# Local C++ build (no Docker). Output: native/cpp/build/worker
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR/native/cpp/build"
g++ -O2 -std=c++17 -o "$DIR/native/cpp/build/worker" "$DIR/native/cpp/worker.cpp"
echo "built: $DIR/native/cpp/build/worker"
