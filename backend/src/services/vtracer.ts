import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VTracerOptions {
  colorMode: 'color' | 'bw';
  colorPrecision: number;     // 1 to 8
  filterSpeckle: number;      // 1 to 100 px
  mode: 'pixel' | 'polygon' | 'spline';
  hierarchical: 'stacked' | 'cutout';
  cornerThreshold: number;    // degrees
}

const NATIVE_VTRACER_PATH = 'vtracer'; // Cargo puts it in PATH, fallback to absolute path if needed
const ABSOLUTE_VTRACER_PATH = 'C:\\Users\\disk_\\.cargo\\bin\\vtracer.exe';

export async function runVTracer(
  inputImagePath: string,
  options: VTracerOptions
): Promise<string> {
  const tempOutputDir = path.dirname(inputImagePath);
  const outputSvgPath = path.join(
    tempOutputDir,
    `output-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.svg`
  );

  const args = [
    '--input', inputImagePath,
    '--output', outputSvgPath,
    '--colormode', options.colorMode,
    '--color_precision', options.colorPrecision.toString(),
    '--filter_speckle', options.filterSpeckle.toString(),
    '--mode', options.mode,
    '--hierarchical', options.hierarchical,
    '--corner_threshold', options.cornerThreshold.toString()
  ];

  // Attempt using PATH first, then fallback to absolute path
  let binaryPath = NATIVE_VTRACER_PATH;
  try {
    await execFileAsync(binaryPath, ['-V']);
  } catch (err) {
    binaryPath = ABSOLUTE_VTRACER_PATH;
  }

  try {
    await execFileAsync(binaryPath, args);
    const svgContent = await fs.readFile(outputSvgPath, 'utf8');
    
    // Clean up temp SVG file
    await fs.unlink(outputSvgPath).catch(() => {});
    
    return svgContent;
  } catch (error: any) {
    console.error('VTracer execution failed:', error);
    throw new Error(`Failed to vectorize image: ${error.message}`);
  }
}
