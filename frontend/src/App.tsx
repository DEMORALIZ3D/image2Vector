import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, Download, Copy, Trash2, Settings, Activity, 
  RefreshCw, FileCode, Check, Info, Zap
} from 'lucide-react';
import { vectorizeInBrowser } from './services/wasmTracer.js';

interface VectorStats {
  originalPaths: number;
  primitivesFound: number;
  totalVertices: number;
  originalSizeKb: number;
  svgSizeKb: number;
}

const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

export default function App() {
  // Input file state
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>('');
  
  // Processing state
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState<string | null>(null);

  // SVG Data states
  const [rawSvg, setRawSvg] = useState<string>('');
  const [activeSvg, setActiveSvg] = useState<string>('');
  const [stats, setStats] = useState<VectorStats | null>(null);
  
  // List of active colors in the current SVG and their hidden state
  const [colors, setColors] = useState<{ hex: string; count: number; hidden: boolean }[]>([]);

  // DOM Parser state
  const svgDocRef = useRef<Document | null>(null);

  // Pipeline Parameters
  const [colorMode, setColorMode] = useState<'color' | 'bw'>('color');
  const [colorPrecision, setColorPrecision] = useState<number>(6); // 1-8
  const [filterSpeckle, setFilterSpeckle] = useState<number>(4); // 1-100 px
  const [mode, setMode] = useState<'pixel' | 'polygon' | 'spline'>('spline');
  const [hierarchical, setHierarchical] = useState<'stacked' | 'cutout'>('cutout');
  const [cornerThreshold, setCornerThreshold] = useState<number>(60);
  
  const [separationMode, setSeparationMode] = useState<boolean>(true);
  const [colorMergeTolerance, setColorMergeTolerance] = useState<number>(35); // 0-100
  const [engineMode, setEngineMode] = useState<'local' | 'wasm'>(isLocalhost ? 'local' : 'wasm');

  // Gradient creator states
  const [gradStart, setGradStart] = useState<string>('');
  const [gradEnd, setGradEnd] = useState<string>('');
  const [gradAngle, setGradAngle] = useState<number>(45);

  const applyGradient = (startHex: string, endHex: string, angle: number) => {
    if (!svgDocRef.current) return;

    // Convert angle to SVG linear gradient coordinates (x1, y1, x2, y2)
    const angleRad = (angle * Math.PI) / 180;
    const x1 = Math.round(50 - Math.cos(angleRad) * 50);
    const y1 = Math.round(50 - Math.sin(angleRad) * 50);
    const x2 = Math.round(50 + Math.cos(angleRad) * 50);
    const y2 = Math.round(50 + Math.sin(angleRad) * 50);

    const gradId = `grad-${Date.now()}`;
    const doc = svgDocRef.current;
    const svgEl = doc.querySelector('svg');
    if (!svgEl) return;

    // Find or create <defs>
    let defs = svgEl.querySelector('defs');
    if (!defs) {
      defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
      svgEl.insertBefore(defs, svgEl.firstChild);
    }

    // Create linearGradient
    const gradEl = doc.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gradEl.setAttribute('id', gradId);
    gradEl.setAttribute('x1', `${x1}%`);
    gradEl.setAttribute('y1', `${y1}%`);
    gradEl.setAttribute('x2', `${x2}%`);
    gradEl.setAttribute('y2', `${y2}%`);

    const stop1 = doc.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', startHex);
    gradEl.appendChild(stop1);

    const stop2 = doc.createElementNS('http://www.w3.org/2000/svg', 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', endHex);
    gradEl.appendChild(stop2);

    defs.appendChild(gradEl);

    // Swap fills for all matching color paths
    const elements = doc.querySelectorAll('path, circle, ellipse, rect');
    elements.forEach(el => {
      const fill = el.getAttribute('fill');
      if (fill && (fill.toUpperCase() === startHex.toUpperCase() || fill.toUpperCase() === endHex.toUpperCase())) {
        el.setAttribute('fill', `url(#${gradId})`);
      }
    });

    updateActiveSvg();
  };

  // Post-processing parameters
  const [simplifyEpsilon, setSimplifyEpsilon] = useState<number>(0.2); // 0-5
  const [curveSmoothing, setCurveSmoothing] = useState<number>(0.8); // 0-1
  const [primitiveTolerance, setPrimitiveTolerance] = useState<number>(3.0); // 0-10
  const [enablePrimitives, setEnablePrimitives] = useState<boolean>(true);

  // Interactive tooltip
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number; show: boolean }>({
    text: '', x: 0, y: 0, show: false
  });

  // Handle Drag & Drop
  const [dragActive, setDragActive] = useState(false);
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const processFile = (file: File) => {
    setImageFile(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
    
    // Reset output when uploading a new file
    setRawSvg('');
    setActiveSvg('');
    setStats(null);
    setColors([]);
    svgDocRef.current = null;
    setError(null);
  };

  // Run vectorization API
  const handleVectorize = async () => {
    if (!imageFile) return;
    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('colorMode', colorMode);
    formData.append('colorPrecision', colorPrecision.toString());
    formData.append('filterSpeckle', filterSpeckle.toString());
    formData.append('mode', mode);
    formData.append('hierarchical', hierarchical);
    formData.append('cornerThreshold', cornerThreshold.toString());
    formData.append('simplifyEpsilon', simplifyEpsilon.toString());
    formData.append('curveSmoothing', curveSmoothing.toString());
    formData.append('primitiveTolerance', primitiveTolerance.toString());
    formData.append('enablePrimitives', enablePrimitives ? 'true' : 'false');
    formData.append('separationMode', separationMode ? 'true' : 'false');
    formData.append('colorMergeTolerance', colorMergeTolerance.toString());

    const postOptions = {
      simplifyEpsilon,
      curveSmoothing,
      primitiveTolerance,
      enablePrimitives,
      colorMergeTolerance
    };

    if (engineMode === 'wasm') {
      try {
        if (!imagePreview) return;
        const data = await vectorizeInBrowser(
          imagePreview,
          colorPrecision,
          { filterSpeckle, cornerThreshold },
          postOptions
        );
        setRawSvg(data.svg);
        setStats(data.stats);
        initializeSvgDocument(data.svg);
      } catch (err: any) {
        console.error(err);
        setError(err.message || 'Wasm vectorization failed.');
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const response = await fetch('http://localhost:3001/api/vectorize', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server error occurred during vectorization');
      }

      const data = await response.json();
      setRawSvg(data.svg);
      setStats(data.stats);
      initializeSvgDocument(data.svg);

    } catch (err: any) {
      console.warn('Local Express server unavailable, trying in-browser Wasm fallback...', err);
      try {
        if (!imagePreview) return;
        const data = await vectorizeInBrowser(
          imagePreview,
          colorPrecision,
          { filterSpeckle, cornerThreshold },
          postOptions
        );
        setRawSvg(data.svg);
        setStats(data.stats);
        initializeSvgDocument(data.svg);
      } catch (wasmErr: any) {
        console.error(wasmErr);
        setError('Vectorization failed: Local Express server is offline, and browser Wasm fallback failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Trigger vectorization when parameters change (if image is already loaded)
  useEffect(() => {
    if (imageFile && rawSvg) {
      const delayDebounce = setTimeout(() => {
        handleVectorize();
      }, 600); // debounce API requests during slider drag
      return () => clearTimeout(delayDebounce);
    }
  }, [
    colorMode, colorPrecision, filterSpeckle, mode, hierarchical, 
    cornerThreshold, simplifyEpsilon, curveSmoothing, primitiveTolerance, enablePrimitives
  ]);

  // Load and tag SVG document elements for interactive editing
  const initializeSvgDocument = (svgStr: string) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgStr, 'image/svg+xml');
    
    // Find all visual elements
    const elements = doc.querySelectorAll('path, rect, circle, ellipse, line');
    
    // Extract unique colors and assign identifiers to elements
    const colorMap: Record<string, number> = {};
    elements.forEach((el, index) => {
      el.setAttribute('data-svg-id', `el-${index}`);
      el.setAttribute('data-svg-element', 'true');
      
      const fill = el.getAttribute('fill') || 'none';
      if (fill !== 'none' && fill !== 'transparent') {
        colorMap[fill] = (colorMap[fill] || 0) + 1;
      }
    });

    const colorList = Object.entries(colorMap).map(([hex, count]) => ({
      hex,
      count,
      hidden: false
    })).sort((a, b) => b.count - a.count);

    setColors(colorList);
    if (colorList.length >= 2) {
      setGradStart(colorList[0].hex);
      setGradEnd(colorList[1].hex);
    } else if (colorList.length === 1) {
      setGradStart(colorList[0].hex);
      setGradEnd(colorList[0].hex);
    }
    svgDocRef.current = doc;
    updateActiveSvg();
  };

  // Sync XML Document changes back to active SVG preview
  const updateActiveSvg = () => {
    if (!svgDocRef.current) return;
    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgDocRef.current);
    setActiveSvg(svgStr);
    
    // Update vector file size stat dynamically
    if (stats) {
      const sizeKb = parseFloat((new Blob([svgStr]).size / 1024).toFixed(2));
      setStats(prev => prev ? { ...prev, svgSizeKb: sizeKb } : null);
    }
  };

  // Remove individual element on click
  const handleSvgClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as SVGElement;
    const svgId = target.getAttribute('data-svg-id');
    
    if (svgId && svgDocRef.current) {
      const elInDoc = svgDocRef.current.querySelector(`[data-svg-id="${svgId}"]`);
      if (elInDoc) {
        elInDoc.remove();
        
        // Hide tooltip
        setTooltip(prev => ({ ...prev, show: false }));
        
        // Recalculate color list and update SVG
        recalculateColors();
        updateActiveSvg();
      }
    }
  };

  // Show hover tooltip with point counts and details
  const handleSvgMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as SVGElement;
    const isSvgEl = target.getAttribute('data-svg-element');
    
    if (isSvgEl) {
      const tag = target.tagName;
      const fill = target.getAttribute('fill') || 'none';
      
      let details = `Type: ${tag}\nFill: ${fill}`;
      
      if (tag === 'path') {
        const d = target.getAttribute('d') || '';
        // count coordinate numbers in path string
        const matches = d.match(/[-+]?[0-9]*\.?[0-9]+/g);
        const pointsCount = matches ? Math.floor(matches.length / 2) : 0;
        details += `\nVertices: ${pointsCount}`;
      } else if (tag === 'rect') {
        const w = target.getAttribute('width');
        const h = target.getAttribute('height');
        details += `\nSize: ${w} x ${h} (Primitive rect)`;
      } else if (tag === 'circle') {
        const r = target.getAttribute('r');
        details += `\nRadius: ${r} (Primitive circle)`;
      } else if (tag === 'ellipse') {
        const rx = target.getAttribute('rx');
        const ry = target.getAttribute('ry');
        details += `\nRadii: rx:${rx}, ry:${ry} (Primitive ellipse)`;
      }

      // Calculate relative coordinate for tooltip
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltip({
        text: details,
        x: e.clientX - rect.left + 15,
        y: e.clientY - rect.top + 15,
        show: true
      });
    } else {
      setTooltip(prev => ({ ...prev, show: false }));
    }
  };

  const handleSvgMouseLeave = () => {
    setTooltip(prev => ({ ...prev, show: false }));
  };

  // Recalculate color palette stats from current document
  const recalculateColors = () => {
    if (!svgDocRef.current) return;
    const elements = svgDocRef.current.querySelectorAll('[data-svg-element]');
    const colorMap: Record<string, number> = {};
    
    elements.forEach(el => {
      const fill = el.getAttribute('fill') || 'none';
      if (fill !== 'none' && fill !== 'transparent') {
        colorMap[fill] = (colorMap[fill] || 0) + 1;
      }
    });

    const newColors = colors.map(c => ({
      ...c,
      count: colorMap[c.hex] || 0
    })).filter(c => c.count > 0);

    setColors(newColors);
  };

  // Toggle visibility of all shapes sharing a specific color
  const toggleColorVisibility = (hex: string) => {
    if (!svgDocRef.current) return;
    
    const isHidden = !colors.find(c => c.hex === hex)?.hidden;
    
    // Update colors state
    setColors(prev => prev.map(c => c.hex === hex ? { ...c, hidden: isHidden } : c));
    
    // Update elements fill-opacity or display in document
    const elements = svgDocRef.current.querySelectorAll('[data-svg-element]');
    elements.forEach(el => {
      if (el.getAttribute('fill') === hex) {
        if (isHidden) {
          el.setAttribute('data-original-opacity', el.getAttribute('fill-opacity') || '1');
          el.setAttribute('fill-opacity', '0');
          el.setAttribute('pointer-events', 'none'); // disable hover on hidden paths
        } else {
          const origOpacity = el.getAttribute('data-original-opacity') || '1';
          el.setAttribute('fill-opacity', origOpacity);
          el.removeAttribute('pointer-events');
        }
      }
    });

    updateActiveSvg();
  };

  // Delete all paths sharing a specific color (ideal for solid background stripping)
  const deleteColorPaths = (hex: string) => {
    if (!svgDocRef.current) return;
    
    const elements = svgDocRef.current.querySelectorAll('[data-svg-element]');
    elements.forEach(el => {
      if (el.getAttribute('fill') === hex) {
        el.remove();
      }
    });

    // Remove from colors array
    setColors(prev => prev.filter(c => c.hex !== hex));
    updateActiveSvg();
  };

  // Clipboard Copiers
  const handleCopySvg = () => {
    if (!activeSvg) return;
    navigator.clipboard.writeText(activeSvg);
    triggerCopyNotification('svg');
  };

  const handleCopyReactComponent = () => {
    if (!activeSvg) return;
    // Simple conversion of SVG string to JSX component style
    let jsx = activeSvg
      .replace(/class=/g, 'className=')
      .replace(/fill-rule=/g, 'fillRule=')
      .replace(/stroke-width=/g, 'strokeWidth=')
      .replace(/viewbox=/g, 'viewBox=');
    
    const componentStr = `import React from 'react';\n\nexport default function VectorGraphic(props: React.SVGProps<SVGSVGElement>) {\n  return (\n    ${jsx.split('\n').map(line => '    ' + line).join('\n').trim()}\n  );\n}`;
    
    navigator.clipboard.writeText(componentStr);
    triggerCopyNotification('react');
  };

  const handleCopyPaths = () => {
    if (!svgDocRef.current) return;
    const paths = svgDocRef.current.querySelectorAll('path');
    const pathStrings: string[] = [];
    paths.forEach(p => {
      const d = p.getAttribute('d');
      if (d) pathStrings.push(d);
    });
    
    navigator.clipboard.writeText(JSON.stringify(pathStrings, null, 2));
    triggerCopyNotification('paths');
  };

  const triggerCopyNotification = (key: string) => {
    setIsCopied(key);
    setTimeout(() => setIsCopied(null), 2000);
  };

  // Download final SVG file
  const handleDownloadSvg = () => {
    if (!activeSvg) return;
    const blob = new Blob([activeSvg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    // Create clean file name based on original or generic name
    const baseName = imageFile ? imageFile.name.substring(0, imageFile.name.lastIndexOf('.')) : 'vector';
    link.download = `${baseName}_vectoprime.svg`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      
      {/* HEADER BAR */}
      <header className="app-header">
        <div className="app-title">
          <div className="app-logo-icon">V</div>
          VectoPrime
        </div>
        {isLocalhost && (
          <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Status: <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>Active Local Node Engine</span>
            </span>
          </div>
        )}
      </header>

      {/* DASHBOARD CONTAINER */}
      <main className="dashboard-grid">
        
        {/* SIDEBAR PARAMETERS PANEL */}
        <aside className="controls-sidebar">
          
          {/* UPLOADER */}
          <div className="glass-panel section-card">
            <h2 className="section-title">
              <Upload size={16} /> Load Image
            </h2>
            <div 
              className={`uploader-box ${dragActive ? 'drag-active' : ''}`}
              onDragEnter={handleDrag}
              onDragOver={handleDrag}
              onDragLeave={handleDrag}
              onDrop={handleDrop}
              onClick={() => document.getElementById('file-upload-input')?.click()}
            >
              <Upload className="uploader-icon" />
              <p style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                {imageFile ? imageFile.name : 'Drag & drop image here'}
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Supports PNG, JPEG, WebP
              </p>
              <input 
                id="file-upload-input"
                type="file" 
                style={{ display: 'none' }} 
                accept="image/*"
                onChange={handleFileChange}
              />
            </div>
            
            {imageFile && (
              <button 
                className="btn-primary" 
                style={{ marginTop: '1rem' }}
                onClick={handleVectorize}
                disabled={loading}
              >
                {loading ? <RefreshCw className="spinner" size={16} /> : <Zap size={16} />}
                {loading ? 'Vectorizing...' : 'Vectorize Image'}
              </button>
            )}
          </div>

          {/* TRACE PARAMETERS */}
          {imageFile && (
            <div className="glass-panel section-card">
              <h2 className="section-title">
                <Settings size={16} /> Vectorizer Settings
              </h2>
              
              {isLocalhost && (
                <div className="form-group">
                  <label className="form-label">Processing Engine</label>
                  <div className="toggle-group">
                    <button 
                      className={`toggle-btn ${engineMode === 'local' ? 'active' : ''}`}
                      onClick={() => setEngineMode('local')}
                    >
                      Local Backend
                    </button>
                    <button 
                      className={`toggle-btn ${engineMode === 'wasm' ? 'active' : ''}`}
                      onClick={() => setEngineMode('wasm')}
                    >
                      In-Browser (Wasm)
                    </button>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Trace Mode</label>
                <div className="toggle-group">
                  <button 
                    className={`toggle-btn ${colorMode === 'color' ? 'active' : ''}`}
                    onClick={() => { setColorMode('color'); setMode('spline'); }}
                  >
                    Color Fills
                  </button>
                  <button 
                    className={`toggle-btn ${colorMode === 'bw' ? 'active' : ''}`}
                    onClick={() => { setColorMode('bw'); setMode('polygon'); }}
                  >
                    B&W Outline
                  </button>
                </div>
              </div>

              {colorMode === 'color' && (
                <>
                  <div className="form-group">
                    <label className="form-label">
                      Color Depth (RGB Bits)
                      <span className="form-value">{colorPrecision}</span>
                    </label>
                    <input 
                      type="range" min="1" max="8" step="1"
                      value={colorPrecision}
                      onChange={(e) => setColorPrecision(parseInt(e.target.value))}
                    />
                  </div>
                  
                  <div className="form-group">
                    <label className="form-label">Grouping Style</label>
                    <div className="toggle-group">
                      <button 
                        className={`toggle-btn ${hierarchical === 'cutout' ? 'active' : ''}`}
                        onClick={() => setHierarchical('cutout')}
                      >
                        Cutout (Puzzle)
                      </button>
                      <button 
                        className={`toggle-btn ${hierarchical === 'stacked' ? 'active' : ''}`}
                        onClick={() => setHierarchical('stacked')}
                      >
                        Stacked (Layered)
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Color separation mode</label>
                    <div className="toggle-group">
                      <button 
                        className={`toggle-btn ${separationMode ? 'active' : ''}`}
                        onClick={() => setSeparationMode(true)}
                      >
                        Separation Layers
                      </button>
                      <button 
                        className={`toggle-btn ${!separationMode ? 'active' : ''}`}
                        onClick={() => setSeparationMode(false)}
                      >
                        Standard (Fast)
                      </button>
                    </div>
                  </div>

                  {separationMode && (
                    <div className="form-group">
                      <label className="form-label">
                        Color Layer Tolerance
                        <span className="form-value">{colorMergeTolerance}</span>
                      </label>
                      <input 
                        type="range" min="10" max="80" step="5"
                        value={colorMergeTolerance}
                        onChange={(e) => setColorMergeTolerance(parseInt(e.target.value))}
                      />
                    </div>
                  )}
                </>
              )}

              <div className="form-group">
                <label className="form-label">
                  Noise Filter (Speckle size)
                  <span className="form-value">{filterSpeckle}px</span>
                </label>
                <input 
                  type="range" min="1" max="100" step="1"
                  value={filterSpeckle}
                  onChange={(e) => setFilterSpeckle(parseInt(e.target.value))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">
                  Corner Threshold
                  <span className="form-value">{cornerThreshold}°</span>
                </label>
                <input 
                  type="range" min="10" max="150" step="5"
                  value={cornerThreshold}
                  onChange={(e) => setCornerThreshold(parseInt(e.target.value))}
                />
              </div>
            </div>
          )}

          {/* SIMPLIFICATION & PRIMITIVES PARAMETERS */}
          {imageFile && (
            <div className="glass-panel section-card">
              <h2 className="section-title">
                <Activity size={16} /> Node Refinement
              </h2>

              <div className="form-group">
                <label className="form-label">
                  Node Simplification (RDP Epsilon)
                  <span className="form-value">{simplifyEpsilon}</span>
                </label>
                <input 
                  type="range" min="0" max="5" step="0.05"
                  value={simplifyEpsilon}
                  onChange={(e) => setSimplifyEpsilon(parseFloat(e.target.value))}
                />
              </div>

              <div className="form-group">
                <label className="form-label">
                  Curve Smoothing (Cubic Bezier)
                  <span className="form-value">{curveSmoothing}</span>
                </label>
                <input 
                  type="range" min="0" max="1.2" step="0.05"
                  value={curveSmoothing}
                  onChange={(e) => setCurveSmoothing(parseFloat(e.target.value))}
                />
              </div>

              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <label className="form-label" style={{ marginBottom: 0 }}>Fit Geometric Primitives</label>
                  <input 
                    type="checkbox"
                    checked={enablePrimitives}
                    onChange={(e) => setEnablePrimitives(e.target.checked)}
                    style={{ accentColor: 'var(--accent-blue)', width: '1rem', height: '1rem', cursor: 'pointer' }}
                  />
                </div>
              </div>

              {enablePrimitives && (
                <div className="form-group">
                  <label className="form-label">
                    Shape Fit Tolerance
                    <span className="form-value">{primitiveTolerance}</span>
                  </label>
                  <input 
                    type="range" min="0.5" max="8" step="0.1"
                    value={primitiveTolerance}
                    onChange={(e) => setPrimitiveTolerance(parseFloat(e.target.value))}
                  />
                </div>
              )}
            </div>
          )}

        </aside>

        {/* WORKBENCH & SVG CANVAS */}
        <section className="workbench-container">
          
          <div className="canvas-split">
            
            {/* INPUT PANEL */}
            <div className="glass-panel canvas-card">
              <div className="canvas-header">
                <div className="canvas-title">Original Raster</div>
                {imageFile && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Type: {imageFile.type.split('/')[1].toUpperCase()}
                  </span>
                )}
              </div>
              <div className="canvas-body">
                {imagePreview ? (
                  <img src={imagePreview} className="preview-img" alt="Original preview" />
                ) : (
                  <div style={{ color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <Upload size={32} />
                    <span>Upload an image to start</span>
                  </div>
                )}
              </div>
            </div>

            {/* OUTPUT SVG PANEL */}
            <div className="glass-panel canvas-card">
              <div className="canvas-header">
                <div className="canvas-title">Vectorized SVG Editor</div>
                {stats && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--accent-blue)', fontSize: '0.75rem' }}>
                    <Info size={12} />
                    <span>Click paths to erase them</span>
                  </div>
                )}
              </div>
              
              <div className="canvas-body" style={{ cursor: 'crosshair' }}>
                {loading && (
                  <div className="loading-overlay">
                    <div className="spinner"></div>
                    <span className="spinner-text">Running Vectorizer Engine...</span>
                  </div>
                )}

                {error && (
                  <div style={{ color: 'var(--accent-pink)', textAlign: 'center', padding: '1rem' }}>
                    <p style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>Error</p>
                    <p style={{ fontSize: '0.9rem' }}>{error}</p>
                  </div>
                )}

                {activeSvg ? (
                  <div 
                    className="svg-canvas-container"
                    dangerouslySetInnerHTML={{ __html: activeSvg }}
                    onClick={handleSvgClick}
                    onMouseMove={handleSvgMouseMove}
                    onMouseLeave={handleSvgMouseLeave}
                  />
                ) : !loading && (
                  <span style={{ color: 'var(--text-muted)' }}>SVG output will appear here</span>
                )}

                {/* Live Tooltip Overlay */}
                {tooltip.show && activeSvg && (
                  <div 
                    className="custom-tooltip"
                    style={{ left: tooltip.x, top: tooltip.y, whiteSpace: 'pre-line' }}
                  >
                    {tooltip.text}
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* COLOR PALETTE PANEL */}
          {activeSvg && colors.length > 0 && (
            <div className="glass-panel section-card">
              <h3 className="section-title" style={{ marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                Active SVG Color Palette ({colors.length} Colors)
              </h3>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.8rem' }}>
                Click a color swatch to toggle visibility. Left-click the <Trash2 size={10} /> icon to permanently delete all matching paths.
              </p>
              <div className="palette-container">
                {colors.map((color) => (
                  <div key={color.hex} className="color-swatch-wrapper" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <div 
                      className={`color-swatch ${color.hidden ? 'hidden-color' : ''}`}
                      style={{ backgroundColor: color.hex }}
                      title={`Toggle visibility (${color.count} paths)`}
                      onClick={() => toggleColorVisibility(color.hex)}
                    />
                    <button 
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
                      title="Delete all matching paths"
                      onClick={() => deleteColorPaths(color.hex)}
                    >
                      <Trash2 size={12} className="hover-danger" />
                    </button>
                  </div>
                ))}
              </div>

              {colors.length >= 2 && (
                <div style={{ marginTop: '1.2rem', paddingTop: '1rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <h4 style={{ fontSize: '0.8rem', marginBottom: '0.6rem', color: 'var(--text)' }}>
                    Convert Colors to Gradient
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.8rem', alignItems: 'center' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 120px' }}>
                      <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Start Color</label>
                      <select 
                        value={gradStart} 
                        onChange={(e) => setGradStart(e.target.value)}
                        style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: '#fff', fontSize: '0.75rem', padding: '4px' }}
                      >
                        {colors.map(c => <option key={c.hex} value={c.hex}>{c.hex}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 120px' }}>
                      <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>End Color</label>
                      <select 
                        value={gradEnd} 
                        onChange={(e) => setGradEnd(e.target.value)}
                        style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '4px', color: '#fff', fontSize: '0.75rem', padding: '4px' }}
                      >
                        {colors.map(c => <option key={c.hex} value={c.hex}>{c.hex}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 150px' }}>
                      <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                        <span>Angle</span>
                        <span>{gradAngle}°</span>
                      </label>
                      <input 
                        type="range" min="0" max="360" step="15"
                        value={gradAngle}
                        onChange={(e) => setGradAngle(parseInt(e.target.value))}
                        style={{ height: '4px' }}
                      />
                    </div>
                    <button 
                      className="toggle-btn active"
                      onClick={() => applyGradient(gradStart, gradEnd, gradAngle)}
                      style={{ height: 'fit-content', padding: '6px 12px', fontSize: '0.75rem', marginTop: 'auto' }}
                    >
                      Apply Gradient
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* EXPORTS BAR & STATS PANEL */}
          {activeSvg && stats && (
            <div className="glass-panel" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                
                {/* Stats indicators */}
                <div className="stats-bar" style={{ padding: 0 }}>
                  <div className="stat-item">
                    <span className="stat-label">Original Image</span>
                    <span className="stat-value">{stats.originalSizeKb} KB</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Vector Output</span>
                    <span className="stat-value">{stats.svgSizeKb} KB</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Total Shapes</span>
                    <span className="stat-value">{stats.originalPaths}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Primitives Fitted</span>
                    <span className="stat-value" style={{ color: 'var(--accent-blue)' }}>
                      {stats.primitivesFound}
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Total Vertices</span>
                    <span className="stat-value">{stats.totalVertices}</span>
                  </div>
                </div>

                {/* Exporter drawer buttons */}
                <div className="export-panel">
                  <button className="export-btn accent" onClick={handleDownloadSvg}>
                    <Download size={14} /> Download SVG
                  </button>
                  <button className="export-btn" onClick={handleCopySvg}>
                    {isCopied === 'svg' ? <Check size={14} style={{ color: 'var(--accent-blue)' }} /> : <Copy size={14} />}
                    {isCopied === 'svg' ? 'Copied!' : 'Copy Code'}
                  </button>
                  <button className="export-btn" onClick={handleCopyReactComponent}>
                    {isCopied === 'react' ? <Check size={14} style={{ color: 'var(--accent-blue)' }} /> : <FileCode size={14} />}
                    {isCopied === 'react' ? 'Copied!' : 'Copy React Component'}
                  </button>
                  <button className="export-btn" onClick={handleCopyPaths}>
                    {isCopied === 'paths' ? <Check size={14} style={{ color: 'var(--accent-blue)' }} /> : <Activity size={14} />}
                    {isCopied === 'paths' ? 'Copied!' : 'Copy Path Coordinates'}
                  </button>
                </div>

              </div>
            </div>
          )}

        </section>

      </main>

      {/* SHOWCASE BANNER */}
      <section className="showcase-banner">
        <h3 className="showcase-title">More Products from AHM Labs</h3>
        <div className="showcase-grid">
          
          <a href="https://ahm-labs.com" target="_blank" rel="noopener noreferrer" className="glass-panel showcase-card">
            <div className="showcase-logo-icon">
              <svg viewBox="0 0 773 154" fill="none">
                <g transform="matrix(0.840407,0,0,0.840406,-170,18)">
                  <path d="M702.037,364.625C703.503,364.872 705.009,365 706.545,365C708.736,365 710.865,364.739 712.904,364.246C719.879,363.034 726.119,358.972 730.04,352.921C734.769,345.623 735.48,336.426 731.927,328.488C715.331,291.406 688.245,230.883 675.659,202.76C670.925,192.183 660.418,185.375 648.83,185.375L630.545,185.375C629.014,185.375 627.65,186.344 627.146,187.789L604.721,252.092L576.85,187.548C576.28,186.229 574.981,185.375 573.545,185.375L544.243,185.375C542.73,185.375 541.378,186.322 540.86,187.744L522.865,237.216L523.145,188.996C523.15,188.037 522.773,187.116 522.098,186.437C521.422,185.757 520.503,185.375 519.545,185.375L480.545,185.375C478.557,185.375 476.945,186.987 476.945,188.975L476.945,251.4L435.145,251.4L435.145,188.975C435.145,186.987 433.533,185.375 431.545,185.375L389.545,185.375C387.557,185.375 385.945,186.987 385.945,188.975L385.945,235.289L362.786,187.407C362.184,186.165 360.925,185.375 359.545,185.375L342.236,185.375C328.888,185.375 316.933,193.634 312.21,206.119C295.417,250.506 254.088,359.751 254.088,359.751C253.67,360.857 253.821,362.098 254.493,363.071C255.165,364.044 256.273,364.625 257.455,364.625L702.037,364.625ZM717.188,313.181L669.087,205.702C665.513,197.716 657.58,192.575 648.83,192.575L633.102,192.575L608.478,263.185C607.989,264.586 606.691,265.544 605.208,265.598C603.725,265.651 602.362,264.789 601.773,263.427L571.178,192.575L546.765,192.575L522.528,259.206C521.929,260.851 520.233,261.827 518.51,261.518C516.786,261.21 515.535,259.705 515.545,257.954L515.924,192.575L484.145,192.575L484.145,255C484.145,256.988 482.533,258.6 480.545,258.6L431.545,258.6C429.557,258.6 427.945,256.988 427.945,255L427.945,192.575L393.145,192.575L393.145,251C393.145,252.678 391.985,254.134 390.349,254.509C388.713,254.884 387.035,254.078 386.304,252.568L357.287,192.575L342.236,192.575C331.882,192.575 322.608,198.982 318.944,208.666L262.666,357.425L687.802,357.425C682.706,352.504 679.545,345.603 679.545,338C679.545,323.162 691.586,311 706.545,311C710.328,311 713.924,311.778 717.188,313.181ZM723.548,327.39L725.355,331.43C725.722,332.25 726.026,333.088 726.267,333.938C726.546,335.248 726.692,336.606 726.692,338C726.692,347.352 720.095,355.121 711.297,357.214C710.382,357.353 709.45,357.425 708.509,357.425L702.794,357.425C693.501,355.704 686.398,347.705 686.398,338C686.398,327.026 695.482,318.232 706.545,318.232C713.662,318.232 719.96,321.871 723.548,327.39Z" fill="#a855f7" />
                </g>
              </svg>
            </div>
            <span className="showcase-name">ahm-labs.com</span>
            <span className="showcase-desc">Consulting, deployment blueprints, and specialized edge infrastructure.</span>
          </a>

          <a href="https://nanolog.dev" target="_blank" rel="noopener noreferrer" className="glass-panel showcase-card">
            <div className="showcase-logo-icon">
              <svg viewBox="0 0 1360 1123" fill="none">
                <g transform="matrix(1,0,0,1,-366.39735,-407.766318)">
                  <g transform="matrix(3.324567,0,0,3.324567,-655.929722,36.159873)">
                    <path d="M681.4,111.9C711.4,118.1 721.3,144.7 714,166.5C712.2,171.9 586.7,398.3 572.3,411.7C547,435.2 503.5,431.7 485.2,406.3C476,393.5 474.1,387.8 479.4,322.8L445.7,322.9C416.9,373.6 384.2,434.8 371.6,443.2C339.6,464.3 289.9,429.3 313.8,386.7C324.2,368.1 437,167.3 445.9,156.3C478,116.4 539.8,133.5 547.3,176.4C548.9,185.6 544,237.8 544.1,237.9C544.4,238.2 576.5,242.4 580.9,234.7C640,132.2 638.3,131.2 648.4,121.4C650.4,119.5 659.7,110.6 681.4,111.9ZM498.6,160C483.5,157.4 468.5,168.8 466,172.9C464,176 336.7,397.6 334.7,405.2C331.1,418.6 351,435.4 364.9,411.4C367.1,407.6 493.7,184.4 504.3,165.4C506.9,160.8 503.8,161.3 498.6,160ZM520.8,188.8C517.9,194.2 461.5,294.4 461.4,294.9C461.1,298.6 463.9,295.5 507.5,296.4C512.6,296.5 500.7,372.3 501.6,373.7C502.4,375 502.7,373.2 562.5,265.5L514.4,264.6L522.3,189.6L520.8,188.8ZM672.4,138.1C671.3,138.5 665.2,140.3 661,147.2C659.2,150.2 518.8,397.1 518.8,399.6C518.9,402 542.4,406.2 557.1,389.5C563.8,381.8 684,167.8 689.8,155.6C691.6,152 687.3,136.3 672.4,138.1Z" fill="#00b4d8" />
                  </g>
                </g>
              </svg>
            </div>
            <span className="showcase-name">NanoLog</span>
            <span className="showcase-desc">Ultralightweight, zero-dependency structural logger for TypeScript.</span>
          </a>

          <a href="https://redact.nanolog.dev" target="_blank" rel="noopener noreferrer" className="glass-panel showcase-card">
            <div className="showcase-logo-icon">
              <svg viewBox="0 0 1360 1123" fill="none">
                <g transform="matrix(1,0,0,1,-366.39735,-407.766318)">
                  <g transform="matrix(3.324567,0,0,3.324567,-655.929722,36.159873)">
                    <path d="M681.4,111.9C711.4,118.1 721.3,144.7 714,166.5C712.2,171.9 586.7,398.3 572.3,411.7C547,435.2 503.5,431.7 485.2,406.3C476,393.5 474.1,387.8 479.4,322.8L445.7,322.9C416.9,373.6 384.2,434.8 371.6,443.2C339.6,464.3 289.9,429.3 313.8,386.7C324.2,368.1 437,167.3 445.9,156.3C478,116.4 539.8,133.5 547.3,176.4C548.9,185.6 544,237.8 544.1,237.9C544.4,237.9 576.5,242.4 580.9,234.7C640,132.2 638.3,131.2 648.4,121.4C650.4,119.5 659.7,110.6 681.4,111.9ZM498.6,160C483.5,157.4 468.5,168.8 466,172.9C464,176 336.7,397.6 334.7,405.2C331.1,418.6 351,435.4 364.9,411.4C367.1,407.6 493.7,184.4 504.3,165.4C506.9,160.8 503.8,161.3 498.6,160ZM520.8,188.8C517.9,194.2 461.5,294.4 461.4,294.9C461.1,298.6 463.9,295.5 507.5,296.4C512.6,296.5 500.7,372.3 501.6,373.7C502.4,375 502.7,373.2 562.5,265.5L514.4,264.6L522.3,189.6L520.8,188.8ZM672.4,138.1C671.3,138.5 665.2,140.3 661,147.2C659.2,150.2 518.8,397.1 518.8,399.6C518.9,402 542.4,406.2 557.1,389.5C563.8,381.8 684,167.8 689.8,155.6C691.6,152 687.3,136.3 672.4,138.1Z" fill="#7b2cbf" />
                  </g>
                </g>
              </svg>
            </div>
            <span className="showcase-name">Nanolog Redact</span>
            <span className="showcase-desc">Secure scrubbing of PII & secrets from structural server logs.</span>
          </a>

          <a href="https://fastaddress.ahm-labs.com" target="_blank" rel="noopener noreferrer" className="glass-panel showcase-card">
            <div className="showcase-logo-icon">
              <svg viewBox="0 0 128 128" fill="none">
                <path d="M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z" fill="#00f5d4" />
              </svg>
            </div>
            <span className="showcase-name">fastAddressUK</span>
            <span className="showcase-desc">Ultra-fast UK address parsing and validation REST API.</span>
          </a>

        </div>
      </section>

      {/* CASE STUDY SECTION */}
      <section className="case-study-section">
        <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '24px' }}>
          <div className="case-study-container">
            <div>
              <span className="case-study-tag">Case Study</span>
              <h3 className="case-study-title">Creating the fastAddress Logo</h3>
              <p className="case-study-desc">
                When building fastAddressUK, the development team needed an iconic, clean symbol that rendered perfectly across retina displays and print media. Using VectoPrime, a high-resolution raster asset was split into color separation layers, simplified using RDP to remove noise, and fitted with smooth cubic Bézier curves. 
              </p>
              <div className="case-study-stats">
                <div className="cs-stat-box">
                  <div className="cs-stat-num">87%</div>
                  <div className="cs-stat-lbl">File Reduction</div>
                </div>
                <div className="cs-stat-box">
                  <div className="cs-stat-num">12</div>
                  <div className="cs-stat-lbl">Vector Nodes</div>
                </div>
                <div className="cs-stat-box">
                  <div className="cs-stat-num">0.7 KB</div>
                  <div className="cs-stat-lbl">Final SVG Size</div>
                </div>
              </div>
            </div>
            <div className="case-study-logo">
              <div style={{ width: '150px', height: '150px' }}>
                <svg viewBox="0 0 128 128" fill="none" style={{ width: '100%', height: '100%' }}>
                  <path d="M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z" fill="url(#studyglow)" />
                  <defs>
                    <linearGradient id="studyglow" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#7b2cbf" />
                      <stop offset="100%" stopColor="#00f5d4" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ SECTION (AEO/GEO Optimized) */}
      <section className="faq-section" id="faq">
        <div className="faq-header">
          <h3 className="faq-section-title">Frequently Asked Questions</h3>
          <p className="faq-section-subtitle">Technical answers about the VectoPrime image vectorization pipeline</p>
        </div>
        <div className="faq-grid">
          
          <div className="glass-panel faq-card">
            <h4 className="faq-q">How does in-browser WebAssembly vectorization work?</h4>
            <p className="faq-a">
              VectoPrime downloads a compiled WebAssembly binary of the high-performance Rust VTracer engine. When you upload an image, your browser parses the pixels locally in memory, splits the colors into separate mask channels, runs the vectorizer ticks via Wasm, and stitches them back into a unified SVG XML structure. No image data is ever uploaded to a server.
            </p>
          </div>

          <div className="glass-panel faq-card">
            <h4 className="faq-q">What is Color Separation Masking and why is it useful?</h4>
            <p className="faq-a">
              Standard image tracing runs on the entire color spectrum at once, which often merges similar colors and creates wobbly, blurred boundaries. VectoPrime uses an advanced separation technique: it isolates each dominant color channel into a crisp black-and-white binary mask. Each mask is vectorized individually with maximum precision, yielding sharp outlines, clean points, and zero color gaps.
            </p>
          </div>

          <div className="glass-panel faq-card">
            <h4 className="faq-q">How does RDP simplification and Bézier curve fitting optimize vectors?</h4>
            <p className="faq-a">
              Raw vectorization produces thousands of jagged nodes. RDP (Ramer-Douglas-Peucker) simplification calculates the orthogonal distance between vertices and prunes points that lie within a specified epsilon. Then, our spline fitter calculates turn angles between the remaining nodes: angles below a threshold are kept as sharp corners, while smooth paths are fitted with parametric cubic Bézier curves.
            </p>
          </div>

          <div className="glass-panel faq-card">
            <h4 className="faq-q">What is Geometric Primitive Fitting?</h4>
            <p className="faq-a">
              Many logos feature perfect circles, ellipses, or rectangles. If geometric primitive fitting is enabled, VectoPrime runs a statistical regression check on all single closed loops. If the shapes match the mathematical equations for circles, ellipses, or rectangles within a user-defined tolerance, they are replaced with clean, semantic XML elements (`&lt;circle&gt;`, `&lt;ellipse&gt;`, `&lt;rect&gt;`) rather than path coordinates.
            </p>
          </div>

        </div>
      </section>

      {/* PREMIUM FOOTER */}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <span className="footer-logo">VectoPrime</span>
            <span className="footer-tagline">High-fidelity SVG vectorization engine powered by WebAssembly. Built by AHM Labs.</span>
          </div>
          <div className="footer-links">
            <div className="footer-col">
              <span className="footer-col-title">Products</span>
              <a href="https://ahm-labs.com" target="_blank" rel="noopener noreferrer">AHM Labs</a>
              <a href="https://nanolog.dev" target="_blank" rel="noopener noreferrer">NanoLog</a>
              <a href="https://redact.nanolog.dev" target="_blank" rel="noopener noreferrer">Nanolog Redact</a>
              <a href="https://fastaddress.ahm-labs.com" target="_blank" rel="noopener noreferrer">fastAddressUK</a>
            </div>
            <div className="footer-col">
              <span className="footer-col-title">Technology</span>
              <a href="https://github.com/visioncortex/vtracer" target="_blank" rel="noopener noreferrer">VTracer Engine</a>
              <a href="https://webassembly.org/" target="_blank" rel="noopener noreferrer">WebAssembly</a>
              <a href="https://github.com/DEMORALIZ3D/image2Vector" target="_blank" rel="noopener noreferrer">Source Code</a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span>&copy; {new Date().getFullYear()} AHM Labs. All rights reserved.</span>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <a href="#faq" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>FAQ</a>
            <span>&bull;</span>
            <a href="https://ahm-labs.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
