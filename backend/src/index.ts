import express from 'express';
import cors from 'cors';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs/promises';
import { runVTracer } from './services/vtracer.js';
import { postProcessSVG } from './services/postprocessor.js';
import { vectorizeWithMasks } from './services/maskTracer.js';
import sharp from 'sharp';

const app = express();
const PORT = 3001;

// CORS setup to allow request from Vite frontend (default 5173)
app.use(cors());
app.use(express.json());

// Set up upload dir inside backend
const uploadDir = path.join(process.cwd(), 'temp');
await fs.mkdir(uploadDir, { recursive: true }).catch(() => {});

const upload = multer({ dest: uploadDir });

app.post('/api/vectorize', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  const inputPath = req.file.path;
  const ext = path.extname(req.file.originalname) || '.png';
  const finalInputPath = `${inputPath}${ext}`;

  try {
    // Rename to include extension so VTracer can decode correctly
    await fs.rename(inputPath, finalInputPath);

    // Parse options from body with sensible defaults
    const options = {
      colorMode: (req.body.colorMode as 'color' | 'bw') || 'color',
      colorPrecision: parseInt(req.body.colorPrecision) || 5,
      filterSpeckle: parseInt(req.body.filterSpeckle) || 4,
      mode: (req.body.mode as 'pixel' | 'polygon' | 'spline') || 'spline',
      hierarchical: (req.body.hierarchical as 'stacked' | 'cutout') || 'cutout',
      cornerThreshold: parseInt(req.body.cornerThreshold) || 60,
    };

    const postOptions = {
      simplifyEpsilon: parseFloat(req.body.simplifyEpsilon) || 0.5,
      curveSmoothing: parseFloat(req.body.curveSmoothing) || 0.8,
      primitiveTolerance: parseFloat(req.body.primitiveTolerance) || 3.0,
      enablePrimitives: req.body.enablePrimitives === 'true',
      colorMergeTolerance: parseFloat(req.body.colorMergeTolerance) || 30.0,
    };

    let svg: string;
    let stats: any;

    if (req.body.separationMode === 'true') {
      // Run the advanced color separation multi-layer masking tracer!
      const maxColors = parseInt(req.body.colorPrecision) || 6;
      const res = await vectorizeWithMasks(finalInputPath, maxColors, options, postOptions);
      svg = res.svg;
      stats = res.stats;
    } else {
      // Fall back to standard single-pass upscaled vectorization
      const metadata = await sharp(finalInputPath).metadata();
      const origWidth = metadata.width || 667;
      const targetWidth = Math.min(origWidth * 4, 3000); // Clamped to 3000px max width for trace speed
      const tempUpscaledPath = `${finalInputPath}-upscaled.png`;

      await sharp(finalInputPath)
        .resize({
          width: targetWidth,
          kernel: sharp.kernel.lanczos3
        })
        .blur(1.2) // Blurring slightly smooths out wobbly pixel stair-stepping
        .toFile(tempUpscaledPath);

      // Run raw vectorization on the upscaled, smoothed image
      const rawSvg = await runVTracer(tempUpscaledPath, options);

      // Clean up temp upscaled file
      await fs.unlink(tempUpscaledPath).catch(() => {});

      // Run geometry post-processing and primitive fitting
      const processed = await postProcessSVG(rawSvg, postOptions);
      svg = processed.svg;
      stats = processed.stats;
    }

    // Clean up input temp image file
    await fs.unlink(finalInputPath).catch(() => {});

    // Return the result
    return res.json({
      svg,
      stats: {
        ...stats,
        originalSizeKb: parseFloat((req.file.size / 1024).toFixed(2)),
        svgSizeKb: parseFloat((Buffer.byteLength(svg) / 1024).toFixed(2))
      }
    });

  } catch (err: any) {
    console.error('Vectorization API Error:', err);
    // Make sure we clean up the files in case of error
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(finalInputPath).catch(() => {});
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'vtracer' });
});

app.listen(PORT, () => {
  console.log(`VectoPrime server running at http://localhost:${PORT}`);
});
