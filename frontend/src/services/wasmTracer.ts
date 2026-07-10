import { BinaryImageConverter } from 'vectortracer';
import { postProcessSVG } from './postprocessor.js';
import type { PostProcessorOptions } from './postprocessor.js';
import { XMLParser } from 'fast-xml-parser';

interface RGB {
  r: number;
  g: number;
  b: number;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function getColorDistance(c1: RGB, c2: RGB): number {
  return Math.hypot(c1.r - c2.r, c1.g - c2.g, c1.b - c2.b);
}

// Extract dominant color palette (same logic as backend)
function extractPalette(pixelBuffer: Uint8ClampedArray, channels: number, maxColors: number): string[] {
  const pixelCount = pixelBuffer.length / channels;
  const colorCounts: Record<string, number> = {};
  
  const sampleStep = Math.max(1, Math.floor(pixelCount / 2000));
  for (let i = 0; i < pixelCount; i += sampleStep) {
    const idx = i * channels;
    const r = pixelBuffer[idx];
    const g = pixelBuffer[idx + 1];
    const b = pixelBuffer[idx + 2];
    
    if (channels === 4 && pixelBuffer[idx + 3] < 10) continue;
    
    const hex = rgbToHex(r, g, b);
    colorCounts[hex] = (colorCounts[hex] || 0) + 1;
  }

  const sortedColors = Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .map(entry => entry[0]);

  const palette: string[] = [];
  const paletteRgb: RGB[] = [];

  for (const colorHex of sortedColors) {
    if (palette.length >= maxColors) break;
    
    const r = parseInt(colorHex.substring(1, 3), 16);
    const g = parseInt(colorHex.substring(3, 5), 16);
    const b = parseInt(colorHex.substring(5, 7), 16);
    const currentRgb = { r, g, b };

    let isClose = false;
    for (const pRgb of paletteRgb) {
      if (getColorDistance(currentRgb, pRgb) < 45) {
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

export async function vectorizeInBrowser(
  imageSrc: string,
  maxColors: number,
  vtracerOptions: { filterSpeckle: number; cornerThreshold: number },
  postOptions: PostProcessorOptions
): Promise<{ svg: string; stats: any }> {
  
  // 1. Load image onto a canvas to get raw pixel buffer
  const img = new Image();
  img.src = imageSrc;
  await img.decode();

  const origWidth = img.width;
  const origHeight = img.height;

  // Resize 3x (max 1500px width) for high-fidelity outlines without lag
  const targetWidth = Math.min(origWidth * 3, 1500);
  const targetHeight = Math.round((origHeight / origWidth) * targetWidth);

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas context');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const pixelBuffer = imageData.data;

  // 2. Sample background color (top-left pixel)
  const bgR = pixelBuffer[0];
  const bgG = pixelBuffer[1];
  const bgB = pixelBuffer[2];
  const bgRgb = { r: bgR, g: bgG, b: bgB };
  console.log(`Detected background color to exclude: ${rgbToHex(bgR, bgG, bgB)}`);

  // 3. Extract palette and filter out background color
  const rawPalette = extractPalette(pixelBuffer, 4, maxColors + 1);
  const palette = rawPalette.filter(colorHex => {
    const r = parseInt(colorHex.substring(1, 3), 16);
    const g = parseInt(colorHex.substring(3, 5), 16);
    const b = parseInt(colorHex.substring(5, 7), 16);
    const dist = getColorDistance({ r, g, b }, bgRgb);
    return dist > 50;
  });

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

  // 4. Trace each color layer using Wasm BinaryImageConverter
  for (const layer of paletteRgbList) {
    const colorHex = layer.hex;

    // Create binary mask ImageData
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = targetWidth;
    maskCanvas.height = targetHeight;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) continue;

    const maskImageData = maskCtx.createImageData(targetWidth, targetHeight);
    const maskData = maskImageData.data;

    for (let i = 0; i < pixelBuffer.length; i += 4) {
      const r = pixelBuffer[i];
      const g = pixelBuffer[i + 1];
      const b = pixelBuffer[i + 2];
      const a = pixelBuffer[i + 3];

      const currentRgb = { r, g, b };

      if (a < 10) {
        maskData[i] = 255;
        maskData[i + 1] = 255;
        maskData[i + 2] = 255;
        maskData[i + 3] = 255;
        continue;
      }

      let minDistance = getColorDistance(currentRgb, bgRgb);
      let closestColor = 'bg';

      for (const item of paletteRgbList) {
        const dist = getColorDistance(currentRgb, item.rgb);
        if (dist < minDistance) {
          minDistance = dist;
          closestColor = item.hex;
        }
      }

      if (closestColor === colorHex) {
        // Black mask (foreground object)
        maskData[i] = 0;
        maskData[i + 1] = 0;
        maskData[i + 2] = 0;
        maskData[i + 3] = 255;
      } else {
        // White (background)
        maskData[i] = 255;
        maskData[i + 1] = 255;
        maskData[i + 2] = 255;
        maskData[i + 3] = 255;
      }
    }

    // Call Wasm converter
    const converter = new BinaryImageConverter(
      maskImageData,
      {
        debug: false,
        mode: 'spline',
        cornerThreshold: vtracerOptions.cornerThreshold,
        filterSpeckle: vtracerOptions.filterSpeckle,
      },
      {
        invert: false,
        pathFill: colorHex,
        backgroundColor: undefined,
        attributes: undefined,
      }
    );

    converter.init();
    while (!converter.tick()) {
      // Synchronously process tracing ticks (Wasm is very fast)
    }

    const rawSvg = converter.getResult();
    converter.free(); // Free Wasm memory!

    // Post-process the generated layer vector
    const { svg: processedSvg, stats } = postProcessSVG(rawSvg, {
      ...postOptions,
      colorMergeTolerance: 0
    });

    totalOriginalPaths += stats.originalPaths;
    totalPrimitivesFound += stats.primitivesFound;
    totalVerticesCount += stats.totalVertices;

    // Extract elements
    const parsed = xmlParser.parse(processedSvg);
    if (parsed.svg) {
      const svgBody = parsed.svg;
      const pathList = Array.isArray(svgBody.path) ? svgBody.path : (svgBody.path ? [svgBody.path] : []);
      const circleList = Array.isArray(svgBody.circle) ? svgBody.circle : (svgBody.circle ? [svgBody.circle] : []);
      const ellipseList = Array.isArray(svgBody.ellipse) ? svgBody.ellipse : (svgBody.ellipse ? [svgBody.ellipse] : []);
      const rectList = Array.isArray(svgBody.rect) ? svgBody.rect : (svgBody.rect ? [svgBody.rect] : []);

      const groupContent: string[] = [];

      for (const p of pathList) {
        const dAttr = p['@_d'];
        const transAttr = p['@_transform'] ? ` transform="${p['@_transform']}"` : '';
        if (dAttr) {
          groupContent.push(`<path d="${dAttr}"${transAttr} fill="${colorHex}" />`);
        }
      }

      for (const c of circleList) {
        const cx = c['@_cx'];
        const cy = c['@_cy'];
        const rAttr = c['@_r'];
        const transAttr = c['@_transform'] ? ` transform="${c['@_transform']}"` : '';
        groupContent.push(`<circle cx="${cx}" cy="${cy}" r="${rAttr}"${transAttr} fill="${colorHex}" />`);
      }

      for (const e of ellipseList) {
        const cx = e['@_cx'];
        const cy = e['@_cy'];
        const rx = e['@_rx'];
        const ry = e['@_ry'];
        const transAttr = e['@_transform'] ? ` transform="${e['@_transform']}"` : '';
        groupContent.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${transAttr} fill="${colorHex}" />`);
      }

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
  }

  // Calculate final scale so coordinates match original size
  const scaleX = origWidth / targetWidth;
  const scaleY = origHeight / targetHeight;
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
      totalVertices: totalVerticesCount,
      originalSizeKb: parseFloat((imageSrc.length * 0.75 / 1024).toFixed(2)), // Base64 approximate size
      svgSizeKb: parseFloat((new Blob([finalSvgString]).size / 1024).toFixed(2))
    }
  };
}
