// ffmpeg helpers for event videos (bundled binary from ffmpeg-static, so the
// server needs no system ffmpeg). Everything works on a local temp file.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

const PREVIEW_SECONDS = 15;
const PREVIEW_HEIGHT = 480;
const FRAME_INTERVAL_SECONDS = 2;
const MAX_FRAMES = 150;
const FRAME_MAX_SIDE = 960;

function run(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args]);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
        const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
        proc.on('error', reject);
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stderr });
        });
    });
}

/** Duration (s), display width/height (rotation applied) and whether it has audio. */
async function probe(file) {
    // ffmpeg-static ships without ffprobe; `ffmpeg -i` prints the same header info.
    const { stderr } = await run(['-i', file]);
    const duration = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const video = stderr.match(/Stream #\S+.*Video: .*?(\d{2,5})x(\d{2,5})/);
    if (!duration || !video) throw new Error('Not a readable video');
    let width = Number(video[1]);
    let height = Number(video[2]);
    const rotation = stderr.match(/rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+)/);
    const degrees = rotation ? Math.abs(Number(rotation[1] ?? rotation[2])) % 180 : 0;
    if (degrees === 90) [width, height] = [height, width];
    return {
        header: stderr,
        duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
        width,
        height,
        hasAudio: /Stream #\S+.*Audio:/.test(stderr),
    };
}

/** One JPEG frame near the start (skips a possible black first frame). */
async function posterFrame(file, info, outFile) {
    const at = Math.min(1, info.duration / 2);
    const { code, stderr } = await run(['-ss', String(at), '-i', file, '-frames:v', '1', '-q:v', '3', '-y', outFile]);
    if (code !== 0 || !fs.existsSync(outFile)) throw new Error(`poster frame failed: ${stderr.slice(-200)}`);
    return fs.readFileSync(outFile);
}

/** Short, low-res, watermarked MP4 that clients can watch before buying. */
async function previewClip(file, info, watermarkPng, outFile) {
    const height = Math.min(PREVIEW_HEIGHT, info.height - (info.height % 2));
    const args = [
        '-t', String(PREVIEW_SECONDS), '-i', file, '-i', watermarkPng,
        '-filter_complex', `[0:v]scale=-2:${height},setsar=1[v];[v][1:v]overlay=0:0:format=auto[out]`,
        '-map', '[out]',
        ...(info.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k'] : ['-an']),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-y', outFile,
    ];
    const { code, stderr } = await run(args);
    if (code !== 0 || !fs.existsSync(outFile)) throw new Error(`preview clip failed: ${stderr.slice(-300)}`);
    return fs.readFileSync(outFile);
}

/** Size of the preview clip, so the watermark overlay can be drawn to match. */
function previewSize(info) {
    const height = Math.min(PREVIEW_HEIGHT, info.height - (info.height % 2));
    let width = Math.round((info.width * height) / info.height);
    width -= width % 2;
    return { width, height };
}

/**
 * Frames sampled across the video for face matching: one every 2 s, or spread
 * evenly when that would exceed MAX_FRAMES. Returns [{ buffer, time }].
 */
async function sampleFrames(file, info, outDir) {
    const interval = Math.max(FRAME_INTERVAL_SECONDS, info.duration / MAX_FRAMES);
    const { code, stderr } = await run([
        '-i', file,
        '-vf', `fps=1/${interval.toFixed(3)},scale='if(gt(iw,ih),min(${FRAME_MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${FRAME_MAX_SIDE},ih))'`,
        '-frames:v', String(MAX_FRAMES), '-q:v', '4', '-y', path.join(outDir, 'f%04d.jpg'),
    ]);
    if (code !== 0) throw new Error(`frame sampling failed: ${stderr.slice(-200)}`);
    return fs.readdirSync(outDir)
        .filter((f) => /^f\d+\.jpg$/.test(f))
        .sort()
        .map((f, i) => ({ buffer: fs.readFileSync(path.join(outDir, f)), time: i * interval }));
}

module.exports = { probe, posterFrame, previewClip, previewSize, sampleFrames, PREVIEW_SECONDS };
