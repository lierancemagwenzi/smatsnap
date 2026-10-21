require('dotenv').config();
const express = require('express');
const http = require('http');
const morgan = require('morgan');
const cors = require('cors');
const schedule = require('node-schedule');
const models = require('./models');
const mediaProcessor = require('./helpers/mediaProcessor');
const paymentTracker = require('./helpers/paymentTracker');

const app = express();
const port = process.env.PORT || 8010;

app.set('trust proxy', 1);
app.use(morgan('dev'));
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));
// rawBody: gateway webhooks sign the exact bytes they sent.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const registration_routes = require('./app-routes/registration_routes');
registration_routes(app);
const event_routes = require('./app-routes/event_routes');
event_routes(app);
const creator_routes = require('./app-routes/creator_routes');
creator_routes(app);
const client_routes = require('./app-routes/client_routes');
client_routes(app);

app.use((req, res) => res.status(404).json({ message: 'Not found' }));
// Malformed JSON bodies etc.
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Invalid JSON body' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error' });
});

models.sequelize.authenticate()
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err.message));

// Every 10s: thumbnails + watermarked previews for newly uploaded photos.
schedule.scheduleJob('*/10 * * * * *', () => mediaProcessor.processUploadedMedia());
// Every 15 min: delete media past its 7-day window and abandoned uploads.
schedule.scheduleJob('*/15 * * * *', () => mediaProcessor.expireMedia());
// Every 10s: follow pending payments with their gateway (like tese-backend's payment checks).
schedule.scheduleJob('*/10 * * * * *', () => paymentTracker.checkPendingOrders());
// Every 10 min: retry face indexing that failed (e.g. the face service was down).
schedule.scheduleJob('*/10 * * * *', () => mediaProcessor.retryFaceIndexing());

// Local face service (face-service/serve.py), auto-started and restarted on crash —
// same pattern as tese-backend's ml-recommendations service. Only needed for FACE_PROVIDER=local.
if ((process.env.FACE_PROVIDER || 'local') === 'local' && process.env.FACE_SERVICE_AUTOSTART !== 'false') {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'face-service');
    const python = path.join(dir, '.venv', 'bin', 'python');
    let child = null;
    let shuttingDown = false;

    const start = () => {
        if (!fs.existsSync(python)) {
            console.error('[face-service] venv missing — set up with: cd face-service && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt && ./download_models.sh');
            return;
        }
        child = spawn(python, ['serve.py'], { cwd: dir, env: { ...process.env, OPENBLAS_NUM_THREADS: '1' } });
        child.stdout.on('data', (d) => console.log(`[face-service] ${d.toString().trim()}`));
        child.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (!/ "(GET|POST) \/(health|embed) HTTP/.test(line)) console.error(`[face-service] ${line}`);
        });
        child.on('exit', (code, signal) => {
            child = null;
            if (shuttingDown) return;
            console.error(`[face-service] exited (code=${code}, signal=${signal}) — restarting in 5s`);
            setTimeout(start, 5000);
        });
    };
    start();
    const stop = () => { shuttingDown = true; if (child) child.kill(); };
    process.on('exit', stop);
    process.on('SIGINT', () => { stop(); process.exit(); });
    process.on('SIGTERM', () => { stop(); process.exit(); });
}

http.createServer(app).listen(port, () => console.log(`API listening on port ${port}`));
