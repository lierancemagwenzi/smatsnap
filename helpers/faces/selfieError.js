// The selfie can't be used for matching. `code` lets the app show the right tip.
class SelfieError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

SelfieError.noFace = () => new SelfieError('NO_FACE', "We couldn't see a face. Face the camera in good light and try again.");
SelfieError.multipleFaces = () => new SelfieError('MULTIPLE_FACES', 'Make sure only your face is in the selfie.');
SelfieError.tooSmall = () => new SelfieError('FACE_TOO_SMALL', 'Move closer so your face fills more of the frame.');

module.exports = { SelfieError };
