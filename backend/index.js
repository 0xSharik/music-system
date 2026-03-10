require('dotenv').config();

// Polyfill for File and Blob (required by undici/cheerio in Node < 20)
if (typeof global.Blob === 'undefined') {
    const buffer = require('buffer');
    global.Blob = buffer.Blob;
}
if (typeof global.File === 'undefined') {
    const buffer = require('buffer');
    global.File = class File extends global.Blob {
        constructor(parts, filename, options = {}) {
            super(parts, options);
            this.filename = filename;
            this.lastModified = options.lastModified || Date.now();
        }
    };
}
const express = require('express');
const cors = require('cors');
const ytSearch = require('yt-search');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Helper: run yt-dlp and return parsed JSON (single video)
function ytDlp(args) {
    return new Promise((resolve, reject) => {
        execFile('yt-dlp', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error('Failed to parse yt-dlp output'));
            }
        });
    });
}

// Helper: run yt-dlp and return raw stdout (for playlists with multi-line JSON)
function ytDlpRaw(args) {
    return new Promise((resolve, reject) => {
        execFile('yt-dlp', args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout);
        });
    });
}

// 1. Search Endpoint
app.get('/api/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });

        const searchResult = await ytSearch(q);
        const videos = searchResult.videos.slice(0, 15).map(v => ({
            id: v.videoId,
            title: v.title,
            artist: v.author.name,
            thumbnail: v.thumbnail,
            duration: v.timestamp,
            views: v.views
        }));

        res.json({ results: videos });
    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

// 2. Direct Stream Extraction Endpoint (uses yt-dlp)
app.get('/api/extract', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Video parameter "id" is required.' });

    try {
        const videoUrl = `https://www.youtube.com/watch?v=${id}`;

        // yt-dlp: get best audio format, dump json only (no download)
        const info = await ytDlp([
            videoUrl,
            '--dump-json',
            '--no-warnings',
            '--format', 'bestaudio/best',
            '--no-playlist',
        ]);

        const format = info.requested_downloads?.[0] || info;

        res.json({
            id: id,
            title: info.title,
            streamUrl: format.url,
            format: format.ext,
            bitrate: format.abr
        });

    } catch (error) {
        console.error('Extract error for ID', id, ':', error.message);
        res.status(500).json({ error: 'Stream extraction failed.', details: error.message });
    }
});

// 3. Suggestions / Up Next Endpoint — uses YouTube Radio Mix (RD{id})
app.get('/api/suggest', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Video parameter "id" is required.' });

    // Helper to parse yt-dlp flat-playlist JSON output and filter to real songs
    const parseSuggestions = (output, excludeId) => {
        const raw = typeof output === 'string' ? output : JSON.stringify(output);
        return raw.split('\n')
            .filter(Boolean)
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(v =>
                v &&
                v.id &&
                v.id !== excludeId &&
                v.duration &&          // must have duration
                v.duration >= 60 &&    // skip shorts / reaction clips (< 60s)
                v.title &&
                !v.title.startsWith('http') // skip entries with raw URL as title
            )
            .map(v => ({
                id: v.id,
                title: v.title,
                artist: v.uploader || v.channel || 'Unknown',
                thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
                duration: v.duration_string || ''
            }))
            .slice(0, 15);
    };

    try {
        // YouTube Music Radio Mix gives the best music-specific suggestions
        const radioUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;

        const output = await ytDlpRaw([
            radioUrl,
            '--flat-playlist',
            '--dump-json',
            '--no-warnings',
            '--playlist-end', '25',
        ]);

        const suggestions = parseSuggestions(output, id);

        if (suggestions.length > 0) {
            return res.json({ suggestions });
        }

        // Fallback: search YouTube with the video's title for similar tracks
        throw new Error('No valid suggestions from Radio Mix');

    } catch (error) {
        console.error('Suggest error, using search fallback:', error.message);
        try {
            // Get title for fallback search
            const info = await ytDlp([
                `https://www.youtube.com/watch?v=${id}`,
                '--dump-json', '--no-warnings', '--no-playlist'
            ]);
            const title = typeof info === 'object' ? info.title : info;
            const searchResult = await ytSearch(title);
            const fallback = searchResult.videos
                .filter(v => v.videoId !== id && v.seconds > 60)
                .slice(0, 12)
                .map(v => ({
                    id: v.videoId,
                    title: v.title,
                    artist: v.author.name,
                    thumbnail: v.thumbnail,
                    duration: v.timestamp
                }));
            res.json({ suggestions: fallback });
        } catch {
            res.status(500).json({ error: 'Failed to fetch suggestions.' });
        }
    }
});

// Root check
app.get('/', (req, res) => {
    res.json({ message: 'StreamExtractor Backend Active — powered by yt-dlp.' });
});

app.listen(PORT, () => {
    console.log(`Extractor API running on http://localhost:${PORT}`);
});
