import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs/promises';
import { runVTracer, VTracerOptions } from './vtracer.js';
import { postProcessSVG, PostProcessorOptions } from './postprocessor.js';
import { XMLParser } from 'fast-xml-parser';

interface RGB {
  r: number;
  g: number;
  b: number;
}

// Convert RGB to hex string
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

// Euclidean distance between two colors
function getColorDistance(c1: RGB, c2: RGB): number {
  return Math.hypot(c1.r - c2.r, c1.g - c2.g, c1.b - c2.b);
}

// Extract dominant colors from the image
async function extractPalette(imageBuffer: Buffer, channels: number, maxColors: number): Promise<string[]> {
  const pixelCount = imageBuffer.length / channels;
  const colorCounts: Record<string, number> = {};
  
  // Sample pixels to build color frequency list
  const sampleStep = Math.max(1, Math.floor(pixelCount / 2000)); // Sample ~2000 pixels for speed
  for (let i = 0; i < pixelCount; i += sampleStep) {
    const idx = i * channels;
    const r = imageBuffer[idx];
    const g = imageBuffer[idx + 1];
    const b = imageBuffer[idx + 2];
    
    // Ignore fully transparent pixels
    if (channels === 4 && imageBuffer[idx + 3] < 10) continue;
    
    const hex = rgbToHex(r, g, b);
    colorCounts[hex] = (colorCounts[hex] || 0) + 1;
  }

  const sortedColors = Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  // Group similar colors to find unique clusters
  const palette: string[] = [];
  const paletteRgb: RGB[] = [];

  for (const colorHex of sortedColors) {
    if (palette.length >= maxColors) break;
    
    // Parse hex
    const r = parseInt(colorHex.substring(1, 3), 16);
    const g = parseInt(colorHex.substring(3, 5), 16);
    const b = parseInt(colorHex.substring(5, 7), 16);
    const currentRgb = { r, g, b };

    let isClose = false;
    for (const pRgb of paletteRgb) {
      if (getColorDistance(currentRgb, pRgb) < 45) { // Euclidean threshold
        isClose = true;
        break;
      }
    }

    if (!isClose) {
      palette.push(colorHex);
      paletteRgb.push(currentRgb);
    }
  }

  return palette;
}

export async function vectorizeWithMasks(
  inputImagePath: string,
  maxColors: number,
  options: VTracerOptions,
  postOptions: PostProcessorOptions
): Promise<{ svg: string; stats: any }> {
  
  const tempDir = path.dirname(inputImagePath);
  const baseName = path.basename(inputImagePath, path.extname(inputImagePath));

  // 1. Load image and upscale to high-res for smooth outlines
  const sharpImg = sharp(inputImagePath);
  const metadata = await sharpImg.metadata();
  
  const origWidth = metadata.width || 667;
  const origHeight = metadata.height || 278;
  
  // Resize to a high-quality 2000px width (keeping aspect ratio)
  const targetWidth = Math.min(origWidth * 3, 2000);
  const targetHeight = Math.round((origHeight / origWidth) * targetWidth);

  const resizedBufferInfo = await sharpImg
    .resize({
      width: targetWidth,
      height: targetHeight,
      kernel: sharp.kernel.lanczos3
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: pixelBuffer, info: pixelInfo } = resizedBufferInfo;
  
  // 2. Extract dominant color palette
  const rawPalette = await extractPalette(pixelBuffer, pixelInfo.channels, maxColors + 1);
  
  // Detect background color by sampling top-left corner pixel
  const bgR = pixelBuffer[0];
  const bgG = pixelBuffer[1];
  const bgB = pixelBuffer[2];
  const bgRgb = { r: bgR, g: bgG, b: bgB };
  const bgHex = rgbToHex(bgR, bgG, bgB);
  console.log(`Detected background color to exclude: ${bgHex}`);

  // Exclude colors that are close to the background color
  const palette = rawPalette.filter(colorHex => {
    const r = parseInt(colorHex.substring(1, 3), 16);
    const g = parseInt(colorHex.substring(3, 5), 16);
    const b = parseInt(colorHex.substring(5, 7), 16);
    const dist = getColorDistance({ r, g, b }, bgRgb);
    return dist > 50; // Skip if close to background color
  });
  console.log('Filtered color separation palette:', palette);

  // Parse palette to RGB objects for nearest-neighbor classification
  const paletteRgbList = palette.map(hex => {
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return { hex, rgb: { r, g, b } };
  });

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  const allGroupElements: string[] = [];
  let totalOriginalPaths = 0;
  let totalPrimitivesFound = 0;
  let totalVerticesCount = 0;

  // 3. Vectorize each color channel mask separately
  for (const layer of paletteRgbList) {
    const colorHex = layer.hex;

    // Create binary mask buffer:
    // Pixels closest to this layer's color become BLACK, all others become WHITE
    const maskBuffer = Buffer.alloc(pixelInfo.width * pixelInfo.height * 3);
    const pixelCount = pixelBuffer.length / pixelInfo.channels;
    
    for (let i = 0; i < pixelCount; i++) {
      const srcIdx = i * pixelInfo.channels;
      const r = pixelBuffer[srcIdx];
      const g = pixelBuffer[srcIdx + 1];
      const b = pixelBuffer[srcIdx + 2];
      const a = pixelInfo.channels === 4 ? pixelBuffer[srcIdx + 3] : 255;
      
      const currentRgb = { r, g, b };
      const destIdx = i * 3;

      if (a < 10) {
        // Transparent pixel -> White (background)
        maskBuffer[destIdx] = 255;
        maskBuffer[destIdx + 1] = 255;
        maskBuffer[destIdx + 2] = 255;
        continue;
      }

      // Find nearest color among palette list and the background color
      let minDistance = getColorDistance(currentRgb, bgRgb);
      let closestColor = 'bg';

      for (const item of paletteRgbList) {
        const dist = getColorDistance(currentRgb, item.rgb);
        if (dist < minDistance) {
          minDistance = dist;
          closestColor = item.hex;
        }
      }

      // If the pixel is closest to this layer's color, mark it as active (black)
      if (closestColor === colorHex) {
        maskBuffer[destIdx] = 0;
        maskBuffer[destIdx + 1] = 0;
        maskBuffer[destIdx + 2] = 0;
      } else {
        maskBuffer[destIdx] = 255;
        maskBuffer[destIdx + 1] = 255;
        maskBuffer[destIdx + 2] = 255;
      }
    }

    // Save mask as temporary file
    const maskPath = path.join(tempDir, `mask-${colorHex.replace('#', '')}-${Date.now()}.png`);
    await sharp(maskBuffer, {
      raw: {
        width: pixelInfo.width,
        height: pixelInfo.height,
        channels: 3
      }
    }).toFile(maskPath);

    try {
      // Trace this mask in B&W mode (extremely clean edges)
      const maskOptions: VTracerOptions = {
        colorMode: 'bw',
        colorPrecision: 5,
        filterSpeckle: options.filterSpeckle,
        mode: 'spline',
        hierarchical: 'cutout',
        cornerThreshold: options.cornerThreshold
      };

      const rawSvg = await runVTracer(maskPath, maskOptions);

      // Run post-processing to simplify nodes and fit curves/primitives
      const { svg: processedSvg, stats } = await postProcessSVG(rawSvg, {
        ...postOptions,
        colorMergeTolerance: 0 // No color merge needed on B&W mask
      });

      totalOriginalPaths += stats.originalPaths;
      totalPrimitivesFound += stats.primitivesFound;
      totalVerticesCount += stats.totalVertices;

      // Extract inner elements of the processed SVG (paths, circles, rects, etc.)
      const parsed = xmlParser.parse(processedSvg);
      if (parsed.svg) {
        const svgBody = parsed.svg;
        
        // Accumulate paths, rects, circles, etc.
        const pathList = Array.isArray(svgBody.path) ? svgBody.path : (svgBody.path ? [svgBody.path] : []);
        const circleList = Array.isArray(svgBody.circle) ? svgBody.circle : (svgBody.circle ? [svgBody.circle] : []);
        const ellipseList = Array.isArray(svgBody.ellipse) ? svgBody.ellipse : (svgBody.ellipse ? [svgBody.ellipse] : []);
        const rectList = Array.isArray(svgBody.rect) ? svgBody.rect : (svgBody.rect ? [svgBody.rect] : []);

        const groupContent: string[] = [];

        // Add back paths with our flat palette color fill
        for (const p of pathList) {
          const dAttr = p['@_d'];
          const transAttr = p['@_transform'] ? ` transform="${p['@_transform']}"` : '';
          if (dAttr) {
            groupContent.push(`<path d="${dAttr}"${transAttr} fill="${colorHex}" />`);
          }
        }

        // Add back circles
        for (const c of circleList) {
          const cx = c['@_cx'];
          const cy = c['@_cy'];
          const rAttr = c['@_r'];
          const transAttr = c['@_transform'] ? ` transform="${c['@_transform']}"` : '';
          groupContent.push(`<circle cx="${cx}" cy="${cy}" r="${rAttr}"${transAttr} fill="${colorHex}" />`);
        }

        // Add back ellipses
        for (const e of ellipseList) {
          const cx = e['@_cx'];
          const cy = e['@_cy'];
          const rx = e['@_rx'];
          const ry = e['@_ry'];
          const transAttr = e['@_transform'] ? ` transform="${e['@_transform']}"` : '';
          groupContent.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${transAttr} fill="${colorHex}" />`);
        }

        // Add back rects
        for (const r of rectList) {
          const rx = r['@_x'];
          const ry = r['@_y'];
          const w = r['@_width'];
          const h = r['@_height'];
          const transAttr = r['@_transform'] ? ` transform="${r['@_transform']}"` : '';
          groupContent.push(`<rect x="${rx}" y="${ry}" width="${w}" height="${h}"${transAttr} fill="${colorHex}" />`);
        }

        if (groupContent.length > 0) {
          allGroupElements.push(`<g id="layer-${colorHex.replace('#', '')}">\n    ${groupContent.join('\n    ')}\n  </g>`);
        }
      }

    } finally {
      // Clean up temp mask file
      await fs.unlink(maskPath).catch(() => {});
    }
  }

  // 4. Assemble master SVG with original coordinate scale
  // Calculate final scale so that SVG coordinates match original dimensions
  const scaleX = origWidth / targetWidth;
  const scaleY = origHeight / targetHeight;
  
  // Apply a scaling group wrapper to translate coordinates back to original size
  const scaleTransform = `scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;

  const finalSvgString = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${origWidth} ${origHeight}" width="${origWidth}" height="${origHeight}">`,
    `  <g transform="${scaleTransform}">`,
    `    ${allGroupElements.join('\n    ')}`,
    '  </g>',
    '</svg>'
  ].join('\n');

  return {
    svg: finalSvgString,
    stats: {
      originalPaths: totalOriginalPaths,
      primitivesFound: totalPrimitivesFound,
      totalVertices: totalVerticesCount
    }
  };
}
