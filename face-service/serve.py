"""
Local face service: finds faces in images and returns a 128-number fingerprint
(embedding) for each. It stores nothing — the Node API keeps the embeddings in
MySQL and does the matching (see helpers/faces/localProvider.js).

  YuNet (detection, MIT) + SFace (recognition, Apache 2.0) via OpenCV, CPU only.

Run with:
    ./.venv/bin/python serve.py
(app.js starts it automatically when FACE_PROVIDER=local.)

POST /embed   multipart, one or more `images` files (JPEG/PNG)
  → { "results": [ { "width": W, "height": H,
                     "faces": [ { "box": [x, y, w, h], "score": 0.97,
                                  "embedding": "<base64 float32 x128, L2-normalised>" } ] } ] }
GET  /health  → { "status": "ok" }
"""
import base64
import os
import threading

import cv2
import numpy as np
from flask import Flask, abort, jsonify, request

HERE = os.path.dirname(os.path.abspath(__file__))
DETECTOR_PATH = os.path.join(HERE, 'models', 'face_detection_yunet_2023mar.onnx')
RECOGNIZER_PATH = os.path.join(HERE, 'models', 'face_recognition_sface_2021dec.onnx')

PORT = int(os.environ.get('FACE_SERVICE_PORT', 8611))
TOKEN = os.environ.get('FACE_SERVICE_TOKEN', '')
SCORE_THRESHOLD = float(os.environ.get('FACE_DETECT_SCORE', 0.8))
# Faces smaller than this (pixels, shorter side of the box) give unreliable fingerprints.
MIN_FACE_PX = int(os.environ.get('FACE_MIN_SIZE', 36))
# YuNet is tuned for small/medium faces: a large copy finds faces in crowd shots, a small
# copy finds big close-ups (which it misses at high resolution). Detections are merged.
DETECT_SIDES = [int(v) for v in os.environ.get('FACE_DETECT_SIDES', '1600,640').split(',')]
MAX_IMAGES_PER_REQUEST = 40

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 64 * 1024 * 1024

# OpenCV DNN objects aren't thread-safe; give each server thread its own pair.
_local = threading.local()


def models():
    if not hasattr(_local, 'detector'):
        _local.detector = cv2.FaceDetectorYN.create(DETECTOR_PATH, '', (320, 320), SCORE_THRESHOLD, 0.3, 5000)
        _local.recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_PATH, '')
    return _local.detector, _local.recognizer


def detect(image, max_side):
    """Detections in original-image coordinates for one downscaled copy."""
    height, width = image.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    work = image if scale == 1.0 else cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    detector, _ = models()
    detector.setInputSize((work.shape[1], work.shape[0]))
    _, detections = detector.detect(work)
    if detections is None:
        return []
    out = []
    for det in detections:
        full = det.copy()
        full[:14] = det[:14] / scale  # box + 5 landmarks back to full resolution
        out.append(full)
    return out


def iou(a, b):
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def embed_image(data):
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return {'error': 'unreadable image', 'faces': []}
    height, width = image.shape[:2]

    # Merge detections from every scale, keeping the higher-scoring box where they overlap.
    merged = []
    for side in DETECT_SIDES:
        for det in detect(image, side):
            duplicate = next((i for i, m in enumerate(merged) if iou(m[:4], det[:4]) > 0.4), None)
            if duplicate is None:
                merged.append(det)
            elif det[14] > merged[duplicate][14]:
                merged[duplicate] = det

    _, recognizer = models()
    faces = []
    for det in merged:
        if min(det[2], det[3]) < MIN_FACE_PX:
            continue
        aligned = recognizer.alignCrop(image, det)  # 112x112 crop aligned on the landmarks
        feature = recognizer.feature(aligned).flatten().astype(np.float32)
        feature /= (np.linalg.norm(feature) or 1.0)
        faces.append({
            'box': [round(float(v), 1) for v in det[:4]],
            'score': round(float(det[14]), 4),
            'embedding': base64.b64encode(feature.tobytes()).decode('ascii'),
        })
    return {'width': width, 'height': height, 'faces': faces}


@app.before_request
def check_token():
    if TOKEN and request.path != '/health' and request.headers.get('X-Face-Token') != TOKEN:
        abort(401)


@app.get('/health')
def health():
    return jsonify(status='ok')


@app.post('/embed')
def embed():
    files = request.files.getlist('images')
    if not files:
        return jsonify(error='no images'), 400
    if len(files) > MAX_IMAGES_PER_REQUEST:
        return jsonify(error=f'at most {MAX_IMAGES_PER_REQUEST} images per request'), 400
    return jsonify(results=[embed_image(f.read()) for f in files])


if __name__ == '__main__':
    from waitress import serve

    models()  # fail fast if the model files are missing
    # Localhost only: the Node API is the only caller. Each waitress thread gets its own models.
    print(f'face-service listening on 127.0.0.1:{PORT}', flush=True)
    serve(app, host='127.0.0.1', port=PORT, threads=int(os.environ.get('FACE_SERVICE_THREADS', 4)))
