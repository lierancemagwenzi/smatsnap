// When a photo/video was captured — galleries (iOS Photos, Google Photos) file a saved copy under
// this date, so the app tells buyers where to find it.
const sharp = require('sharp');
const exifReader = require('exif-reader');

/** EXIF date taken as "YYYY-MM-DDTHH:mm:ss" (camera-local time, no zone), or '' when absent. */
async function photoTakenAt(buffer) {
    try {
        const { exif } = await sharp(buffer, { failOn: 'none' }).metadata();
        if (!exif) return '';
        const tags = exifReader(exif);
        // exif-reader reads the zone-less EXIF time as if it were UTC; keep it as written.
        const date = tags.Photo?.DateTimeOriginal || tags.Photo?.DateTimeDigitized || tags.Image?.DateTime;
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 19) : '';
    } catch {
        return '';
    }
}

/** Video creation_time from ffmpeg's header dump (ISO, UTC), or ''. */
function videoTakenAt(ffmpegHeader) {
    const m = String(ffmpegHeader || '').match(/creation_time\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z/);
    return m && !m[1].startsWith('1970') ? `${m[1]}Z` : '';
}

module.exports = { photoTakenAt, videoTakenAt };
