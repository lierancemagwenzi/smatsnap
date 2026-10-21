#!/usr/bin/env bash
# Downloads the two face models from the OpenCV model zoo into ./models:
#   YuNet  (face detection)            — MIT license
#   SFace  (face recognition features) — Apache 2.0 license
# Both allow commercial use. Run once: ./download_models.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models
BASE=https://github.com/opencv/opencv_zoo/raw/main/models
fetch() {
  local name=$1 url=$2
  if [ -s "models/$name" ] && [ "$(wc -c < "models/$name")" -gt 100000 ]; then echo "$name: already present"; return; fi
  echo "$name: downloading…"
  curl -fsSL "$url" -o "models/$name"
  # Guard against Git-LFS pointer files / error pages.
  [ "$(wc -c < "models/$name")" -gt 100000 ] || { rm -f "models/$name"; echo "$name: download looks wrong"; exit 1; }
  echo "$name: $(du -h "models/$name" | cut -f1)"
}
fetch face_detection_yunet_2023mar.onnx  "$BASE/face_detection_yunet/face_detection_yunet_2023mar.onnx"
fetch face_recognition_sface_2021dec.onnx "$BASE/face_recognition_sface/face_recognition_sface_2021dec.onnx"
