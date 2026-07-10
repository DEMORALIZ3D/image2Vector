import { XMLParser, XMLBuilder } from 'fast-xml-parser';

interface Point {
  x: number;
  y: number;
}

interface PathCommand {
  type: string;
  points: Point[];
}

export interface PostProcessorOptions {
  simplifyEpsilon: number;       // 0 to 10 (RDP tolerance)
  curveSmoothing: number;        // 0 to 1 (0 = polygon, 1 = smooth spline)
  primitiveTolerance: number;    // 0 to 10 (lower = stricter matching)
  enablePrimitives: boolean;
  colorMergeTolerance: number;   // 0 to 100 (Euclidean distance threshold)
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): RGB | null {
  const cleanHex = hex.trim().replace(/^#/, '');
  if (cleanHex.length === 6) {
    const num = parseInt(cleanHex, 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255
    };
  }
  if (cleanHex.length === 3) {
    const r = parseInt(cleanHex[0] + cleanHex[0], 16);
    const g = parseInt(cleanHex[1] + cleanHex[1], 16);
    const b = parseInt(cleanHex[2] + cleanHex[2], 16);
    return { r, g, b };
  }
  return null;
}

function getColorDistance(c1: RGB, c2: RGB): number {
  return Math.hypot(c1.r - c2.r, c1.g - c2.g, c1.b - c2.b);
}

function parseSvgPath(d: string): PathCommand[] {
  const commands: PathCommand[] = [];
  const regex = /([MLCSZz])([^MLCSZz]*)/g;
  let match;

  while ((match = regex.exec(d)) !== null) {
    const type = match[1];
    const argsStr = match[2].trim();
    const args = argsStr ? argsStr.split(/[\s,]+/).map(Number).filter(n => !isNaN(n)) : [];
    
    const points: Point[] = [];
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] !== undefined && args[i + 1] !== undefined) {
        points.push({ x: args[i], y: args[i + 1] });
      }
    }
    
    commands.push({ type, points });
  }

  return commands;
}

function splitIntoSubPaths(commands: PathCommand[]): PathCommand[][] {
  const subPaths: PathCommand[][] = [];
  let current: PathCommand[] = [];
  for (const cmd of commands) {
    if (cmd.type.toUpperCase() === 'M' && current.length > 0) {
      subPaths.push(current);
      current = [];
    }
    current.push(cmd);
  }
  if (current.length > 0) {
    subPaths.push(current);
  }
  return subPaths;
}

function samplePathToPoints(commands: PathCommand[]): Point[] {
  const points: Point[] = [];
  let currentPoint: Point = { x: 0, y: 0 };

  for (const cmd of commands) {
    const type = cmd.type.toUpperCase();
    if (type === 'M') {
      if (cmd.points.length > 0) {
        currentPoint = cmd.points[0];
        points.push({ ...currentPoint });
      }
    } else if (type === 'L') {
      for (const p of cmd.points) {
        currentPoint = p;
        points.push({ ...currentPoint });
      }
    } else if (type === 'C') {
      for (let i = 0; i < cmd.points.length; i += 3) {
        const cp1 = cmd.points[i];
        const cp2 = cmd.points[i + 1];
        const end = cmd.points[i + 2];
        if (!cp1 || !cp2 || !end) continue;

        const start = currentPoint;
        for (let t = 0.1; t <= 1.0; t += 0.1) {
          const u = 1 - t;
          const x = u * u * u * start.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * end.x;
          const y = u * u * u * start.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * end.y;
          points.push({ x, y });
        }
        currentPoint = end;
      }
    } else if (type === 'Z') {
      if (points.length > 0 && (points[0].x !== currentPoint.x || points[0].y !== currentPoint.y)) {
        points.push({ ...points[0] });
      }
    }
  }

  const uniquePoints: Point[] = [];
  for (const p of points) {
    if (uniquePoints.length === 0) {
      uniquePoints.push(p);
    } else {
      const prev = uniquePoints[uniquePoints.length - 1];
      const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (dist > 0.01) {
        uniquePoints.push(p);
      }
    }
  }

  return uniquePoints;
}

function getOrthogonalDistance(p: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - lineStart.x, p.y - lineStart.y);
  }

  const numerator = Math.abs(dy * p.x - dx * p.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
}

export function simplifyRDP(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2 || epsilon <= 0) return points;

  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const dist = getOrthogonalDistance(points[i], points[0], points[end]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const results1 = simplifyRDP(points.slice(0, index + 1), epsilon);
    const results2 = simplifyRDP(points.slice(index), epsilon);
    return results1.slice(0, results1.length - 1).concat(results2);
  }

  return [points[0], points[end]];
}

interface PrimitiveResult {
  isPrimitive: boolean;
  tag: string;
  attributes: Record<string, string | number>;
}

function detectPrimitive(points: Point[], tolerance: number): PrimitiveResult {
  if (points.length < 5) return { isPrimitive: false, tag: '', attributes: {} };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    sumX += p.x;
    sumY += p.y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const cx = sumX / points.length;
  const cy = sumY / points.length;

  if (width < 3 || height < 3) return { isPrimitive: false, tag: '', attributes: {} };

  const rx = width / 2;
  const ry = height / 2;
  
  let ellipseErrorSum = 0;
  let circleRadiusErrorSum = 0;
  const targetRadius = (rx + ry) / 2;

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    
    const r = Math.hypot(dx, dy);
    circleRadiusErrorSum += Math.abs(r - targetRadius) / targetRadius;

    const ellipseVal = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    ellipseErrorSum += Math.abs(ellipseVal - 1);
  }

  const circleError = circleRadiusErrorSum / points.length;
  const ellipseError = ellipseErrorSum / points.length;
  const threshold = 0.01 * tolerance;

  if (circleError < threshold && Math.abs(rx - ry) / targetRadius < 0.1) {
    return {
      isPrimitive: true,
      tag: 'circle',
      attributes: {
        cx: parseFloat(cx.toFixed(2)),
        cy: parseFloat(cy.toFixed(2)),
        r: parseFloat(targetRadius.toFixed(2))
      }
    };
  }

  if (ellipseError < threshold) {
    return {
      isPrimitive: true,
      tag: 'ellipse',
      attributes: {
        cx: parseFloat(cx.toFixed(2)),
        cy: parseFloat(cy.toFixed(2)),
        rx: parseFloat(rx.toFixed(2)),
        ry: parseFloat(ry.toFixed(2))
      }
    };
  }

  let shoelaceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    shoelaceArea += points[i].x * points[j].y;
    shoelaceArea -= points[j].x * points[i].y;
  }
  shoelaceArea = Math.abs(shoelaceArea) / 2;

  const bboxArea = width * height;
  const areaRatio = shoelaceArea / bboxArea;

  if (areaRatio > (1 - threshold * 2)) {
    return {
      isPrimitive: true,
      tag: 'rect',
      attributes: {
        x: parseFloat(minX.toFixed(2)),
        y: parseFloat(minY.toFixed(2)),
        width: parseFloat(width.toFixed(2)),
        height: parseFloat(height.toFixed(2))
      }
    };
  }

  return { isPrimitive: false, tag: '', attributes: {} };
}

function fitBezierCurves(points: Point[], smoothing: number, isClosed: boolean): string {
  if (points.length <= 1) return '';
  if (points.length === 2) {
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
    if (isClosed) d += ' Z';
    return d;
  }

  const len = points.length;
  const isCorner = new Array(len).fill(false);

  if (!isClosed) {
    isCorner[0] = true;
    isCorner[len - 1] = true;
  }

  for (let i = 1; i < len - 1; i++) {
    const pPrev = points[i - 1];
    const pCurr = points[i];
    const pNext = points[i + 1];

    const dx1 = pCurr.x - pPrev.x;
    const dy1 = pCurr.y - pPrev.y;
    const dx2 = pNext.x - pCurr.x;
    const dy2 = pNext.y - pCurr.y;

    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);

    if (len1 > 0.1 && len2 > 0.1) {
      const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
      if (dot < 0.76) {
        isCorner[i] = true;
      }
    } else {
      isCorner[i] = true;
    }
  }

  if (isClosed && len > 2) {
    const pPrev = points[len - 2];
    const pCurr = points[0];
    const pNext = points[1];

    const dx1 = pCurr.x - pPrev.x;
    const dy1 = pCurr.y - pPrev.y;
    const dx2 = pNext.x - pCurr.x;
    const dy2 = pNext.y - pCurr.y;

    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);

    if (len1 > 0.1 && len2 > 0.1) {
      const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
      if (dot < 0.76) {
        isCorner[0] = true;
        isCorner[len - 1] = true;
      }
    }
  }

  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  
  if (smoothing <= 0) {
    for (let i = 1; i < len; i++) {
      d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
    }
    if (isClosed) d += ' Z';
    return d;
  }

  for (let i = 0; i < len - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    
    const p0 = i > 0 ? points[i - 1] : (isClosed ? points[len - 2] : p1);
    const p3 = i < len - 2 ? points[i + 2] : (isClosed ? points[1] : p2);

    const s1 = isCorner[i] ? 0 : smoothing;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * s1;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * s1;

    const s2 = isCorner[i + 1] ? 0 : smoothing;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * s2;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * s2;

    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  if (isClosed) {
    d += ' Z';
  }

  return d;
}

export function postProcessSVG(
  svgString: string,
  options: PostProcessorOptions
): { svg: string; stats: { originalPaths: number; primitivesFound: number; totalVertices: number } } {
  
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  });

  const jsonObj = parser.parse(svgString);
  if (!jsonObj.svg) {
    throw new Error('Invalid SVG input');
  }

  const svg = jsonObj.svg;
  let paths = svg.path;
  if (!paths && svg.g) {
    paths = svg.g.path;
  }
  if (!paths) {
    return { svg: svgString, stats: { originalPaths: 0, primitivesFound: 0, totalVertices: 0 } };
  }

  if (!Array.isArray(paths)) {
    paths = [paths];
  }

  const colorCounts: Record<string, number> = {};
  for (const pathObj of paths) {
    const fill = pathObj['@_fill'];
    if (fill && fill !== 'none' && fill !== 'transparent') {
      colorCounts[fill] = (colorCounts[fill] || 0) + 1;
    }
  }

  const mergedColorMap: Record<string, string> = {};
  const uniqueColors = Object.keys(colorCounts);
  const colorRgbList = uniqueColors.map(hex => ({ hex, rgb: hexToRgb(hex) })).filter(item => item.rgb !== null) as { hex: string; rgb: RGB }[];

  colorRgbList.sort((a, b) => (colorCounts[b.hex] || 0) - (colorCounts[a.hex] || 0));

  const clusters: { center: RGB; hex: string; members: string[] }[] = [];

  for (const item of colorRgbList) {
    let matchedCluster = null;
    for (const cluster of clusters) {
      const dist = getColorDistance(item.rgb, cluster.center);
      if (dist < options.colorMergeTolerance) {
        matchedCluster = cluster;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.members.push(item.hex);
      mergedColorMap[item.hex] = matchedCluster.hex;
    } else {
      clusters.push({
        center: item.rgb,
        hex: item.hex,
        members: [item.hex]
      });
      mergedColorMap[item.hex] = item.hex;
    }
  }

  const processedElements: any[] = [];
  let primitivesCount = 0;
  let totalVerticesCount = 0;

  for (const pathObj of paths) {
    const d = pathObj['@_d'];
    const fill = pathObj['@_fill'] || 'none';
    const finalFill = (fill !== 'none' && fill !== 'transparent') ? (mergedColorMap[fill] || fill) : fill;
    const stroke = pathObj['@_stroke'] || 'none';
    const strokeWidth = pathObj['@_stroke-width'];
    const transform = pathObj['@_transform'];

    if (!d) continue;

    const commands = parseSvgPath(d);
    const subPathList = splitIntoSubPaths(commands);
    
    let isPrimitiveMatched = false;

    if (options.enablePrimitives && subPathList.length === 1) {
      const sampledPoints = samplePathToPoints(commands);
      totalVerticesCount += sampledPoints.length;

      const prim = detectPrimitive(sampledPoints, options.primitiveTolerance);
      if (prim.isPrimitive) {
        primitivesCount++;
        const element: Record<string, any> = {
          [`@_fill`]: finalFill,
        };
        if (stroke !== 'none') element[`@_stroke`] = stroke;
        if (strokeWidth) element[`@_stroke-width`] = strokeWidth;
        if (transform) element[`@_transform`] = transform;
        
        for (const [key, value] of Object.entries(prim.attributes)) {
          element[`@_${key}`] = value;
        }

        processedElements.push({
          type: prim.tag,
          data: element
        });
        isPrimitiveMatched = true;
      }
    }

    if (isPrimitiveMatched) continue;

    const subPathDs: string[] = [];
    for (const subCommands of subPathList) {
      const subClosed = subCommands.some(c => c.type.toUpperCase() === 'Z');
      const subPoints = samplePathToPoints(subCommands);
      totalVerticesCount += subPoints.length;

      const simplifiedPoints = simplifyRDP(subPoints, options.simplifyEpsilon);
      const subD = fitBezierCurves(simplifiedPoints, options.curveSmoothing, subClosed);
      if (subD) {
        subPathDs.push(subD);
      }
    }

    const newD = subPathDs.join(' ');
    if (!newD) continue;

    const pathData: Record<string, any> = {
      '@_d': newD,
      '@_fill': finalFill
    };
    if (stroke !== 'none') pathData['@_stroke'] = stroke;
    if (strokeWidth) pathData['@_stroke-width'] = strokeWidth;
    if (transform) pathData['@_transform'] = transform;

    processedElements.push({
      type: 'path',
      data: pathData
    });
  }

  const widthVal = svg['@_width'] || 100;
  const heightVal = svg['@_height'] || 100;
  const newSvgObj: Record<string, any> = {
    svg: {
      '@_xmlns': 'http://www.w3.org/2000/svg',
      '@_viewBox': svg['@_viewBox'] || `0 0 ${widthVal} ${heightVal}`,
      '@_width': svg['@_width'] || '100%',
      '@_height': svg['@_height'] || '100%',
    }
  };

  for (const elem of processedElements) {
    if (!newSvgObj.svg[elem.type]) {
      newSvgObj.svg[elem.type] = [];
    }
    newSvgObj.svg[elem.type].push(elem.data);
  }

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: true
  });

  const newSvgString = builder.build(newSvgObj);

  return {
    svg: newSvgString,
    stats: {
      originalPaths: paths.length,
      primitivesFound: primitivesCount,
      totalVertices: totalVerticesCount
    }
  };
}
