import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, Download, FileArchive, FileImage, FileText, LoaderCircle, LockKeyhole, RotateCcw, ScanLine, ShieldCheck, UploadCloud, X } from 'lucide-react';
import {
  engineApi,
  type ArtworkJob,
  type CreateArtworkJobRequest,
  type DetectionCandidate,
  type DetectionResult,
  type EngineCapabilities,
  type PixelBox,
  type SourceAnalysis,
  type UploadedSource,
} from '@/lib/engine-api';
import { useAccessControl } from '@/components/access-gate';

const STEPS = ['Upload', 'Analysis', 'Detection', 'Vectorization', 'Validation', 'Editor', 'Export'];
const ALLOWED_FILE_NAMES = [
  'front-body.svg',
  'front-body.eps',
  'back-body.svg',
  'back-body.eps',
  'manifest.json',
  'front-body-preview.png',
  'back-body-preview.png',
] as const;
type OutputName = (typeof ALLOWED_FILE_NAMES)[number];
type SideAssignment = 'front' | 'back' | '';
type EngineState = 'loading' | 'ready' | 'offline';
const DOWNLOADABLE_JOB_STATUSES = new Set(['review_required', 'approved', 'complete', 'completed', 'succeeded', 'success', 'awaiting_desktop']);
const TERMINAL_JOB_STATUSES = new Set([...DOWNLOADABLE_JOB_STATUSES, 'failed', 'cancelled', 'canceled']);

function normalizedStatus(status?: string) {
  return status?.toLowerCase() ?? '';
}

function JerseyMark() {
  return (
    <svg className="aa-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M20 2.8 36.2 12v16L20 37.2 3.8 28V12L20 2.8Z" stroke="#dce9ee" strokeWidth="1.35" />
      <path d="m7.9 13.6 12.1 6.8 12.1-6.8M20 20.4v13.1M10.3 17.4l9.7 5.4 9.7-5.4M10.3 23.2 20 28.8l9.7-5.6M13.5 10l6.5-3.7 6.5 3.7-6.5 3.8-6.5-3.8Z" stroke="#71f1c6" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

function LoadingScreen() {
  return (
    <main className="aa-loading-screen" aria-live="polite">
      <section className="aa-loading-card">
        <JerseyMark />
        <h1>Artboard Ai</h1>
        <p>Connecting to the artwork engine and reading its current capabilities.</p>
        <div className="aa-loading-line" aria-hidden="true"><span /></div>
        <p className="aa-eyebrow" style={{ margin: '16px 0 0' }}>JERSEY OS / ENGINE CHECK</p>
      </section>
    </main>
  );
}

function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="aa-alert" role="alert">
      <CircleAlert size={14} style={{ verticalAlign: 'middle', marginRight: 7 }} />
      {message}
      {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  );
}

function StatusDot({ state }: { state: 'ready' | 'pending' | 'off' }) {
  return <span className={`aa-orb ${state === 'off' ? '' : state}`} aria-hidden="true" />;
}

function Header({ capabilities, engineState }: { capabilities: EngineCapabilities | null; engineState: EngineState }) {
  const aiReady = capabilities?.ai_assistance.configured ?? false;
  const accessControl = useAccessControl();
  return (
    <header className="aa-topbar">
      <div className="aa-brand">
        <JerseyMark />
        <div><p className="aa-brand-name">JERSEY OS</p><p className="aa-brand-sub">Artboard Ai · Artwork workflow</p></div>
      </div>
      <div className="aa-system" aria-label="Engine capability status">
        <div className="aa-status"><StatusDot state={engineState === 'ready' ? 'ready' : engineState === 'loading' ? 'pending' : 'off'} /><span className="aa-status-copy"><span className="aa-status-label">Artwork engine</span><span className={`aa-status-value ${engineState === 'ready' ? 'ready' : ''}`}>{engineState === 'ready' ? capabilities?.engine ?? 'Available' : engineState === 'loading' ? 'Checking' : 'Unavailable'}</span></span></div>
        <div className="aa-status"><StatusDot state={capabilities ? (aiReady ? 'ready' : 'pending') : 'off'} /><span className="aa-status-copy"><span className="aa-status-label">AI assistance</span><span className="aa-status-value">{capabilities ? (aiReady ? 'Configured · opt-in' : 'Not configured') : 'Unknown'}</span></span></div>
        <div className="aa-status"><StatusDot state={capabilities?.formats.ai.supported ? 'ready' : 'off'} /><span className="aa-status-copy"><span className="aa-status-label">Native .ai</span><span className="aa-status-value">{capabilities ? (capabilities.formats.ai.supported ? 'Supported' : 'Unavailable') : 'Unknown'}</span></span></div>
      </div>
      <div className="aa-header-end">
        <div className="aa-connection"><StatusDot state={engineState === 'ready' ? 'ready' : engineState === 'loading' ? 'pending' : 'off'} />{engineState === 'ready' ? 'ENGINE CONNECTED' : engineState === 'loading' ? 'CONNECTING' : 'ENGINE OFFLINE'}</div>
        {accessControl && (
          <>
            {accessControl.lockError && <span className="aa-lock-error" role="alert">{accessControl.lockError}</span>}
            <button
              className="aa-lock-action"
              type="button"
              onClick={() => void accessControl.lockWorkspace()}
              disabled={accessControl.isLocking}
              data-testid="button-lock-workspace"
              aria-label="Lock private workspace"
            >
              {accessControl.isLocking ? <LoaderCircle size={13} className="aa-spin" /> : <LockKeyhole size={13} />}
              <span>{accessControl.isLocking ? 'Locking' : 'Lock'}</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function WorkflowNav({ stage, highestStage, onNavigate }: { stage: number; highestStage: number; onNavigate: (step: number) => void }) {
  return (
    <nav className="aa-workflow" aria-label="Artwork workflow stages">
      {STEPS.map((label, index) => {
        const number = index + 1;
        const reachable = index <= highestStage;
        return (
          <button key={label} type="button" className={`aa-step${stage === index ? ' active' : ''}${stage > index ? ' complete' : ''}`} aria-current={stage === index ? 'step' : undefined} disabled={!reachable} onClick={() => onNavigate(index)}>
            <span className="aa-step-index">{stage > index ? <Check size={12} /> : String(number).padStart(2, '0')}</span>
            <span className="aa-step-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function App() {
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [capabilityError, setCapabilityError] = useState('');
  const [stage, setStage] = useState(0);
  const [highestStage, setHighestStage] = useState(0);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState('');
  const [uploadedSource, setUploadedSource] = useState<UploadedSource | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [manualCandidates, setManualCandidates] = useState<DetectionCandidate[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [manualBox, setManualBox] = useState<PixelBox | null>(null);
  const [manualCropFields, setManualCropFields] = useState<PixelBox>({ x: 0, y: 0, width: 0, height: 0 });
  const manualStart = useRef<{ x: number; y: number } | null>(null);
  const [assignments, setAssignments] = useState<Record<string, SideAssignment>>({});
  const [job, setJob] = useState<ArtworkJob | null>(null);
  const [dpi, setDpi] = useState<330 | 600>(330);
  const [formats, setFormats] = useState<Array<'svg' | 'eps'>>([]);
  const [runOcr, setRunOcr] = useState(true);
  const [useAiAssistance, setUseAiAssistance] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pollError, setPollError] = useState('');
  const [availableFiles, setAvailableFiles] = useState<OutputName[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Partial<Record<OutputName, string>>>({});
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [downloadBusy, setDownloadBusy] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const checkCapabilities = useCallback(async () => {
    setEngineState('loading');
    setCapabilityError('');
    const started = Date.now();
    const responsePromise = engineApi.getCapabilities();
    const minimumDisplay = new Promise<void>((resolve) => window.setTimeout(resolve, Math.max(0, 4000 - (Date.now() - started))));
    try {
      const response = await responsePromise;
      await minimumDisplay;
      setCapabilities(response);
      setFormats([
        ...(response.formats.svg.supported ? ['svg' as const] : []),
        ...(response.formats.eps.supported ? ['eps' as const] : []),
      ]);
      setEngineState('ready');
    } catch (reason) {
      await minimumDisplay;
      setCapabilities(null);
      setCapabilityError(reason instanceof Error ? reason.message : 'The engine capabilities could not be loaded.');
      setEngineState('offline');
    }
  }, []);

  useEffect(() => { void checkCapabilities(); }, [checkCapabilities]);

  useEffect(() => {
    if (!sourceFile) {
      setLocalPreview('');
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  const jobTerminal = useMemo(() => {
    return TERMINAL_JOB_STATUSES.has(normalizedStatus(job?.status));
  }, [job?.status]);

  useEffect(() => {
    if (!job?.job_id || jobTerminal) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await engineApi.getJob(job.job_id);
        if (cancelled) return;
        setJob(response);
        setPollError('');
        if (!TERMINAL_JOB_STATUSES.has(normalizedStatus(response.status))) {
          timer = window.setTimeout(() => void poll(), 1400);
        } else if (DOWNLOADABLE_JOB_STATUSES.has(normalizedStatus(response.status))) {
          setStage((current) => current < 4 ? 4 : current);
          setHighestStage((current) => Math.max(current, 4));
        }
      } catch (reason) {
        if (cancelled) return;
        setPollError(reason instanceof Error ? reason.message : 'Job status could not be refreshed.');
      }
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.job_id, job?.status, jobTerminal]);

  useEffect(() => {
    if (!job?.job_id || !DOWNLOADABLE_JOB_STATUSES.has(normalizedStatus(job.status))) {
      setAvailableFiles([]);
      setPreviewUrls({});
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    void Promise.all(ALLOWED_FILE_NAMES.map(async (filename) => {
      try {
        const blob = await engineApi.downloadFile(job.job_id, filename);
        if (cancelled) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return { filename, url };
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) {
        urls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      const present = results.filter((entry): entry is { filename: OutputName; url: string } => entry !== null);
      setAvailableFiles(present.map((entry) => entry.filename));
      setPreviewUrls(Object.fromEntries(present.map((entry) => [entry.filename, entry.url])));
    });
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [job?.job_id, job?.status]);

  const previewUrl = uploadedSource ? engineApi.sourcePreviewUrl(uploadedSource.source_id) : localPreview;
  const uploadLimit = capabilities?.limits.upload_mib ?? 30;
  const megapixelLimit = capabilities?.limits.source_megapixels;

  function setCurrentStage(next: number) {
    if (next <= highestStage) setStage(next);
    setError('');
  }

  function acceptFile(file?: File) {
    if (!file) return;
    const validType = ['image/png', 'image/jpeg', 'image/webp', 'image/tiff'].includes(file.type) || /\.(png|jpe?g|webp|tif|tiff)$/i.test(file.name);
    if (!validType) {
      setError('Choose a PNG, JPEG, WebP, or TIFF image supported by the engine.');
      return;
    }
    if (file.size > uploadLimit * 1024 * 1024) {
      setError(`This file exceeds the engine upload limit of ${uploadLimit} MiB.`);
      return;
    }
    setSourceFile(file);
    setUploadedSource(null);
    setAnalysis(null);
    setDetection(null);
    setManualCandidates([]);
    setManualMode(false);
    setManualBox(null);
    setManualCropFields({ x: 0, y: 0, width: 0, height: 0 });
    setAssignments({});
    setJob(null);
    setAvailableFiles([]);
    setPreviewUrls({});
    setStage(0);
    setHighestStage(0);
    setError('');
  }

  function removeSelectedSource() {
    setSourceFile(null);
    setUploadedSource(null);
    setAnalysis(null);
    setDetection(null);
    setManualCandidates([]);
    setManualMode(false);
    setManualBox(null);
    setManualCropFields({ x: 0, y: 0, width: 0, height: 0 });
    manualStart.current = null;
    setAssignments({});
    setJob(null);
    setAvailableFiles([]);
    setPreviewUrls({});
    setStage(0);
    setHighestStage(0);
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function uploadAndDetect() {
    if (!sourceFile || engineState !== 'ready') return;
    setBusy('upload');
    setError('');
    let sourceWasUploaded = false;
    try {
      const source = await engineApi.uploadSource(sourceFile);
      sourceWasUploaded = true;
      setUploadedSource(source);
      setAnalysis(null);
      setManualCandidates([]);
      setManualMode(false);
      setManualBox(null);
      setManualCropFields({ x: 0, y: 0, width: 0, height: 0 });
      setHighestStage((current) => Math.max(current, 1));
      setStage(1);
      await inspectSource(source.source_id, useAiAssistance);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The source could not be processed.');
      if (sourceWasUploaded) {
        setStage(1);
        setHighestStage((current) => Math.max(current, 1));
      } else {
        setStage(0);
      }
    } finally {
      setBusy('');
    }
  }

  async function inspectSource(sourceId: string, aiEnabled: boolean) {
    setBusy('analysis');
    setError('');
    setAnalysis(null);
    setDetection(null);
    setManualCandidates([]);
    setManualMode(false);
    setManualBox(null);
    setManualCropFields({ x: 0, y: 0, width: 0, height: 0 });
    setAssignments({});
    let analysisCompleted = false;
    try {
      const imageAnalysis = await engineApi.analyzeSource(sourceId, aiEnabled);
      setAnalysis(imageAnalysis);
      analysisCompleted = true;
      setHighestStage((current) => Math.max(current, 1));
      setStage(1);
      setBusy('detect');
      const result = await engineApi.detectPanels(sourceId, aiEnabled);
      setDetection(result);
      setAssignments({});
      setSelectedCandidate(result.candidates[0]?.candidate_id ?? '');
      setHighestStage((current) => Math.max(current, 2));
      setStage(2);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The source could not be analyzed.');
      const failedStage = analysisCompleted ? 2 : 1;
      setHighestStage((current) => Math.max(current, failedStage));
      setStage(failedStage);
    } finally {
      setBusy('');
    }
  }

  async function rerunDetection() {
    if (!uploadedSource) return;
    setBusy('detect');
    setError('');
    try {
      const result = await engineApi.detectPanels(uploadedSource.source_id, useAiAssistance);
      setDetection(result);
      setManualCandidates([]);
      setManualMode(false);
      setManualBox(null);
      setAssignments({});
      setSelectedCandidate(result.candidates[0]?.candidate_id ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Panel detection failed.');
    } finally {
      setBusy('');
    }
  }

  const regionCandidates = useMemo(
    () => [...(detection?.candidates ?? []), ...manualCandidates],
    [detection?.candidates, manualCandidates],
  );

  function sourcePixel(event: ReactPointerEvent<SVGSVGElement>) {
    if (!detection) return null;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return null;
    const point = event.currentTarget.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const mapped = point.matrixTransform(matrix.inverse());
    if (mapped.x < 0 || mapped.y < 0 || mapped.x > detection.source_dimensions.width_px || mapped.y > detection.source_dimensions.height_px) return null;
    return {
      x: Math.round(mapped.x),
      y: Math.round(mapped.y),
    };
  }

  function updateManualCrop(event: ReactPointerEvent<SVGSVGElement>, finish = false) {
    const start = manualStart.current;
    const point = sourcePixel(event);
    if (!start || !point) {
      if (finish) {
        manualStart.current = null;
        setManualBox(null);
      }
      return;
    }
    const crop = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    };
    setManualBox(crop);
    if (!finish) return;
    manualStart.current = null;
    setManualBox(null);
    addManualCandidate(crop);
  }

  function addManualCandidate(crop: PixelBox) {
    if (!detection || !Number.isInteger(crop.x) || !Number.isInteger(crop.y) ||
      !Number.isInteger(crop.width) || !Number.isInteger(crop.height) ||
      crop.x < 0 || crop.y < 0 || crop.width < 8 || crop.height < 8 ||
      crop.x + crop.width > detection.source_dimensions.width_px ||
      crop.y + crop.height > detection.source_dimensions.height_px) {
      setError('A manual crop must be at least 8 × 8 whole source pixels and stay inside the uploaded image.');
      return;
    }
    const id = `manual-${manualCandidates.length + 1}`;
    const candidate: DetectionCandidate = {
      candidate_id: id,
      position_hint: 'operator-drawn crop',
      suggested_side: 'unknown',
      source_bbox_px: crop,
      score_type: 'operator_defined_crop',
    };
    setManualCandidates((current) => [...current, candidate]);
    setSelectedCandidate(id);
    setManualCropFields(crop);
    setManualMode(false);
    setError('');
  }

  function assign(candidateId: string, side: SideAssignment) {
    setAssignments((current) => {
      const next = { ...current };
      if (side) {
        Object.keys(next).forEach((key) => { if (next[key] === side) next[key] = ''; });
      }
      next[candidateId] = side;
      return next;
    });
  }

  const frontCandidate = regionCandidates.find((candidate) => assignments[candidate.candidate_id] === 'front');
  const backCandidate = regionCandidates.find((candidate) => assignments[candidate.candidate_id] === 'back');

  async function createArtworkJob() {
    if (!uploadedSource || !frontCandidate || !backCandidate || !capabilities || formats.length === 0) return;
    const payload: CreateArtworkJobRequest = {
      panels: [
        { side: 'front', source_id: uploadedSource.source_id, crop: frontCandidate.source_bbox_px, run_ocr: runOcr && capabilities.ocr.available },
        { side: 'back', source_id: uploadedSource.source_id, crop: backCandidate.source_bbox_px, run_ocr: runOcr && capabilities.ocr.available },
      ],
      dpi,
      formats,
      native_ai_mode: 'disabled',
    };
    setBusy('job');
    setError('');
    setPollError('');
    setJob(null);
    try {
      const created = await engineApi.createJob(payload);
      setJob(created);
      setStage(3);
      setHighestStage((current) => Math.max(current, 3));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The artwork job could not be created.');
    } finally {
      setBusy('');
    }
  }

  async function refreshJob() {
    if (!job?.job_id) return;
    setBusy('refresh');
    try {
      setJob(await engineApi.getJob(job.job_id));
      setPollError('');
    } catch (reason) {
      setPollError(reason instanceof Error ? reason.message : 'Job status could not be refreshed.');
    } finally {
      setBusy('');
    }
  }

  async function downloadOutput(filename: OutputName | 'bundle') {
    if (!job?.job_id) return;
    setDownloadBusy(filename);
    setError('');
    try {
      const blob = filename === 'bundle'
        ? await engineApi.downloadBundle(job.job_id)
        : await engineApi.downloadFile(job.job_id, filename);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename === 'bundle' ? `artboard-${job.job_id}.zip` : filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'This output file is not available.');
    } finally {
      setDownloadBusy('');
    }
  }

  const canStartJob = Boolean(frontCandidate && backCandidate && formats.length > 0);
  const jobFailed = job && ['failed', 'cancelled', 'canceled'].includes(normalizedStatus(job.status));
  const jobComplete = job && DOWNLOADABLE_JOB_STATUSES.has(normalizedStatus(job.status));
  const awaitingDesktop = normalizedStatus(job?.status) === 'awaiting_desktop';
  const maxWidth = capabilities?.canvas.width_inches;
  const maxHeight = capabilities?.canvas.height_inches;

  if (engineState === 'loading') return <LoadingScreen />;

  return (
    <main className="aa-app">
      <Header capabilities={capabilities} engineState={engineState} />
      <div className="aa-workspace">
        <WorkflowNav stage={stage} highestStage={highestStage} onNavigate={setCurrentStage} />
        <div className="aa-heading">
          <div>
            <p className="aa-kicker">ARTBOARD AI / JERSEY OS</p>
            <h1 className="aa-title">{STEPS[stage] === 'Upload' ? 'One source photo. Two separate canvases.' : STEPS[stage] === 'Analysis' ? 'Reading the source image' : STEPS[stage] === 'Detection' ? 'Confirm the two panel regions' : STEPS[stage] === 'Vectorization' ? 'Artwork job' : STEPS[stage] === 'Validation' ? 'Review the engine report' : STEPS[stage] === 'Editor' ? 'Review the generated artwork' : 'Download available files'}</h1>
            <p className="aa-subtitle">{STEPS[stage] === 'Upload' ? 'Upload one photo showing both jersey sides. Local geometry proposes regions; you assign front and back before processing.' : 'Every status, measurement, preview and file below is returned by the connected engine. No printer approval is performed.'}</p>
          </div>
          <div className="aa-meta">{capabilities ? <>{capabilities.engine} · {capabilities.version}<br />{maxWidth} × {maxHeight} IN · {capabilities.canvas.color_mode}</> : 'ENGINE CAPABILITIES UNAVAILABLE'}</div>
        </div>

        {engineState === 'offline' && <ErrorMessage message={capabilityError || 'The engine is offline. Connect it to begin.'} onRetry={() => void checkCapabilities()} />}
        {error && <ErrorMessage message={error} onRetry={undefined} />}

        {stage === 0 && (
          <section className="aa-card" aria-label="Upload source image">
            <div className="aa-card-head"><div><p className="aa-eyebrow">SOURCE IMAGE / REQUIRED</p><h2>One combined jersey photo</h2></div><span className="aa-meta">FRONT + BACK IN ONE FRAME</span></div>
            <input ref={inputRef} className="aa-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/tiff,.tif,.tiff" aria-label="Choose source image" data-testid="input-source-image" onChange={(event) => acceptFile(event.currentTarget.files?.[0])} />
            <div className={`aa-drop${dragging ? ' dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files?.[0]); }}>
              <span className="aa-drop-icon"><UploadCloud size={23} /></span>
              <h2>Drop one source photo here</h2>
              <p>Both sides must be visible in the same image. The engine accepts PNG, JPEG, WebP and TIFF within its current limits.</p>
              <button type="button" className="aa-btn secondary" style={{ marginTop: 17 }} onClick={() => inputRef.current?.click()} data-testid="button-browse-source">Choose image <ArrowRight size={14} /></button>
            </div>
            {sourceFile && (
              <div className="aa-file-line">
                {localPreview && !/\.tiff?$/i.test(sourceFile.name) && <img src={localPreview} alt={`Selected source photo ${sourceFile.name}`} />}
                <div className="aa-file-detail"><strong>{sourceFile.name}</strong><span>{(sourceFile.size / (1024 * 1024)).toFixed(2)} MiB · {sourceFile.type || 'Image file'} · upload limit {uploadLimit} MiB</span></div>
                 <button className="aa-btn ghost" type="button" aria-label="Remove selected image" onClick={removeSelectedSource}><X size={15} /> Remove</button>
              </div>
            )}
            <div className="aa-note" style={{ margin: '0 17px 15px' }}>
              {capabilities ? `Engine limits: ${uploadLimit} MiB${megapixelLimit ? ` · ${megapixelLimit} megapixels` : ''}. Source dimensions and format are confirmed by the engine after upload.` : 'Waiting for engine capabilities. Upload is unavailable until the engine responds.'}
            </div>
            <div className="aa-note warn" style={{ margin: '0 17px 15px' }}>Development preview: there are no account-level access or retention controls yet. Do not upload confidential production artwork until those controls are configured.</div>
            <div className="aa-controls" style={{ padding: '0 17px 17px' }}>
              {capabilities?.ai_assistance.configured ? (
                <label className="aa-note" style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 440 }}>
                  <input type="checkbox" checked={useAiAssistance} onChange={(event) => setUseAiAssistance(event.currentTarget.checked)} />
                  Use configured AI for image analysis and panel suggestions (opt-in)
                </label>
              ) : <span className="aa-meta">AI ASSISTANCE · NOT CONFIGURED</span>}
              <button type="button" className="aa-btn" disabled={!sourceFile || engineState !== 'ready' || Boolean(busy)} onClick={() => void uploadAndDetect()} data-testid="button-upload-analyze">
                {busy === 'upload' ? <><LoaderCircle size={14} /> Uploading source</> : busy === 'detect' ? <><LoaderCircle size={14} /> Finding geometry</> : <>Upload and inspect <ArrowRight size={14} /></>}
              </button>
            </div>
          </section>
        )}

        {stage === 1 && (
          <section className="aa-split">
            <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">SOURCE / ENGINE RESPONSE</p><h2>Image analysis</h2></div>{analysis ? <Check size={16} color="#6ff2c7" /> : <LoaderCircle size={16} />}</div>
              {previewUrl && <div className="aa-image-stage"><img className="aa-source-image" src={previewUrl} alt="Uploaded source photo" /></div>}
              <div style={{ display: 'grid', gap: 9, padding: '0 14px 14px' }}>
                {analysis ? <>
                  <div className="aa-inline"><span className="aa-meta">SOURCE DIMENSIONS</span><span className="aa-note">{analysis.width_px} × {analysis.height_px} PX</span></div>
                  <div className="aa-inline"><span className="aa-meta">SOURCE PPI AT CANVAS</span><span className="aa-note">{analysis.source_ppi_at_canvas.horizontal} × {analysis.source_ppi_at_canvas.vertical}</span></div>
                  <div className="aa-inline"><span className="aa-meta">SHARPNESS HEURISTIC · NOT A QUALITY GRADE</span><span className="aa-note">{analysis.sharpness_heuristic}</span></div>
                  <div className="aa-note">Transparency: {analysis.has_transparency ? 'present' : 'not detected'} · Source color: {JSON.stringify(analysis.source_color)}</div>
                  {analysis.issues.length ? analysis.issues.map((item, index) => <div className="aa-note warn" key={`${index}-${item}`}>{item}</div>) : <div className="aa-note">No analysis observations were returned.</div>}
                </> : <div className="aa-job-state"><StatusDot state="pending" />{busy === 'upload' ? 'Uploading the source to the local engine…' : busy === 'detect' ? 'Requesting geometry-only panel detection…' : 'Waiting for source analysis…'}</div>}
                {uploadedSource && !analysis && <button type="button" className="aa-btn secondary" disabled={Boolean(busy)} onClick={() => void inspectSource(uploadedSource.source_id, useAiAssistance)}>{busy === 'analysis' ? <LoaderCircle size={14} /> : <RotateCcw size={14} />} Retry image analysis</button>}
              </div>
            </div>
            <aside className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">NO SEMANTIC CLASSIFICATION</p><h2>Operator confirmation</h2></div><ShieldCheck size={16} color="#f2c477" /></div>
              <div style={{ display: 'grid', gap: 12, padding: 16 }}>
                {analysis && <div className="aa-note">The engine returned {analysis.width_px} × {analysis.height_px} px, approximately {analysis.source_ppi_at_canvas.horizontal} × {analysis.source_ppi_at_canvas.vertical} PPI at the configured canvas size.</div>}
                <div className="aa-note warn">Local detection identifies geometric regions only. It cannot tell which garment is front or back; you will assign both sides yourself.</div>
                <div className="aa-note">Fabric flattening and hidden-artwork reconstruction are not automatic. AI setup is unavailable unless the capabilities response says it is configured.</div>
              </div>
            </aside>
          </section>
        )}

        {stage === 2 && (
          <section>
            {!uploadedSource || !detection ? (
              <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">DETECTION</p><h2>No detection response</h2></div><ScanLine size={16} /></div><div style={{ display: 'grid', gap: 12, padding: 16 }}><p className="aa-subtitle" style={{ margin: 0 }}>{uploadedSource ? 'The source is uploaded, but no candidate response is available yet.' : 'Upload and inspect a source image to request real geometric candidates from the engine.'}</p><div className="aa-inline">{uploadedSource && <button type="button" className="aa-btn" disabled={busy === 'detect'} onClick={() => void rerunDetection()}>{busy === 'detect' ? <LoaderCircle size={14} /> : <RotateCcw size={14} />} Retry detection</button>}<button type="button" className="aa-btn secondary" onClick={() => setCurrentStage(0)}><ArrowLeft size={14} /> Return to upload</button></div></div></div>
            ) : (
              <>
                <div className="aa-split">
                  <section className="aa-card">
                    <div className="aa-card-head"><div><p className="aa-eyebrow">GEOMETRY ONLY · {detection.method}</p><h2>Uploaded source with returned regions</h2></div><span className="aa-meta">{detection.source_dimensions.width_px} × {detection.source_dimensions.height_px} PX</span></div>
                    <div className="aa-image-stage">
                      <img className="aa-source-image" src={engineApi.sourcePreviewUrl(uploadedSource.source_id)} alt="Uploaded source photo with engine candidates and any operator-drawn crop overlays" />
                      <svg
                        className={`aa-detection-overlay${manualMode ? ' drawing' : ''}`}
                        viewBox={`0 0 ${detection.source_dimensions.width_px} ${detection.source_dimensions.height_px}`}
                        preserveAspectRatio="xMidYMid meet"
                        aria-hidden="true"
                        onPointerDown={(event) => {
                          if (!manualMode) return;
                          const point = sourcePixel(event);
                          if (!point) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          manualStart.current = point;
                          setManualBox({ x: point.x, y: point.y, width: 0, height: 0 });
                          setError('');
                        }}
                        onPointerMove={(event) => { if (manualMode) updateManualCrop(event); }}
                        onPointerUp={(event) => { if (manualMode) updateManualCrop(event, true); }}
                        onPointerCancel={(event) => { if (manualMode) updateManualCrop(event, true); }}
                      >
                        {regionCandidates.map((candidate) => <rect key={candidate.candidate_id} className={selectedCandidate === candidate.candidate_id ? 'selected' : ''} x={candidate.source_bbox_px.x} y={candidate.source_bbox_px.y} width={candidate.source_bbox_px.width} height={candidate.source_bbox_px.height} />)}
                        {manualBox && <rect className="drawing-box" x={manualBox.x} y={manualBox.y} width={manualBox.width} height={manualBox.height} />}
                      </svg>
                    </div>
                    <div style={{ padding: '0 14px 14px' }}>
                      <div className="aa-note">{detection.warnings.length ? detection.warnings.join(' ') : `Method: ${detection.method}. Coordinate system: ${detection.coordinate_system}. Geometry scores are heuristics, not calibrated probabilities.`}</div>
                    </div>
                  </section>
                  <aside className="aa-card">
                    <div className="aa-card-head"><div><p className="aa-eyebrow">MANUAL SIDE ASSIGNMENT</p><h2>{regionCandidates.length} panel regions</h2></div><span className="aa-meta">{detection.status}</span></div>
                    <div className="aa-region-list">
                      {regionCandidates.map((candidate, index) => (
                        <div className={`aa-region${selectedCandidate === candidate.candidate_id ? ' selected' : ''}`} key={candidate.candidate_id}>
                          <span className="aa-region-index">{String(index + 1).padStart(2, '0')}</span>
                          <span className="aa-region-copy"><strong>Candidate {candidate.candidate_id}</strong><span>{candidate.position_hint || 'Position not identified'} · {candidate.source_bbox_px.width} × {candidate.source_bbox_px.height} px{candidate.geometry_score !== undefined ? ` · geometry score ${candidate.geometry_score}` : ''}</span>{candidate.region && <span>{candidate.region.part} · {candidate.region.note}</span>}</span>
                          <select className="aa-select" aria-label={`Assign candidate ${candidate.candidate_id} side`} value={assignments[candidate.candidate_id] ?? ''} onFocus={() => setSelectedCandidate(candidate.candidate_id)} onChange={(event) => { setSelectedCandidate(candidate.candidate_id); assign(candidate.candidate_id, event.target.value as SideAssignment); }} data-testid={`select-side-${index}`}>
                            <option value="">Unassigned</option><option value="front">Front</option><option value="back">Back</option>
                          </select>
                        </div>
                      ))}
                      {regionCandidates.length === 0 && <div className="aa-canvas-empty"><div><strong>No candidate regions returned</strong>The engine found no geometric regions. Draw a crop on the source image to define one manually.</div></div>}
                    </div>
                    <div style={{ padding: '0 14px 14px' }}>
                      <div className="aa-note warn">Local detection does not classify front/back. Assign exactly one region to each side. Detector bounds come from the engine; manual bounds are drawn by you.</div>
                      <button type="button" className="aa-btn secondary" aria-pressed={manualMode} style={{ marginTop: 10 }} onClick={() => { setManualMode((current) => !current); setManualBox(null); manualStart.current = null; setError(''); }}>
                        {manualMode ? <><X size={13} /> Cancel drawing</> : <><ScanLine size={13} /> Draw a panel region on the image</>}
                      </button>
                      {manualMode && <p className="aa-meta" style={{ margin: '8px 0 0', textAlign: 'left' }}>DRAG A RECTANGLE AROUND ONE PANEL · MINIMUM 8 × 8 SOURCE PIXELS</p>}
                      {manualMode && <div className="aa-crop-form" aria-label="Enter manual crop coordinates">
                        {([
                          ['x', 'Source X', detection.source_dimensions.width_px],
                          ['y', 'Source Y', detection.source_dimensions.height_px],
                          ['width', 'Width', detection.source_dimensions.width_px],
                          ['height', 'Height', detection.source_dimensions.height_px],
                        ] as const).map(([field, label, max]) => (
                          <label className="aa-crop-field" key={field}>{label} · px
                            <input
                              className="aa-input"
                              type="number"
                              min={0}
                              max={max}
                              step={1}
                              value={manualCropFields[field]}
                              onChange={(event) => setManualCropFields((current) => ({ ...current, [field]: event.currentTarget.value === '' ? 0 : Number(event.currentTarget.value) }))}
                            />
                          </label>
                        ))}
                        <button type="button" className="aa-btn secondary" onClick={() => addManualCandidate(manualCropFields)}>Add entered crop</button>
                      </div>}
                    </div>
                  </aside>
                </div>
                <div className="aa-controls">
                  <button type="button" className="aa-btn secondary" disabled={Boolean(busy)} onClick={() => setCurrentStage(0)}><ArrowLeft size={14} /> Change source</button>
                  <div className="aa-control-right">
                    <button type="button" className="aa-btn secondary" disabled={Boolean(busy)} onClick={() => void rerunDetection()}>{busy === 'detect' ? <LoaderCircle size={14} /> : <RotateCcw size={14} />} Detect again</button>
                    <button type="button" className="aa-btn" disabled={!canStartJob || formats.length === 0} onClick={() => { setStage(3); setHighestStage((current) => Math.max(current, 3)); }} data-testid="button-continue-vectorize">Review vectorization settings <ArrowRight size={14} /></button>
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        {stage === 3 && (
          <section className="aa-split">
            <div className="aa-card">
              <div className="aa-card-head"><div><p className="aa-eyebrow">ENGINE JOB</p><h2>{job ? `Job ${job.job_id}` : 'Prepare front and back vectors'}</h2></div>{job && <span className="aa-meta">{job.status}</span>}</div>
              {job ? (
                <div style={{ padding: 15 }}>
                  <div className="aa-job-state"><StatusDot state={jobFailed ? 'off' : jobComplete ? 'ready' : 'pending'} /><span>{job.error?.message || job.stage || job.status}</span></div>
                  {Number.isFinite(job.progress) && <><div className="aa-inline" style={{ justifyContent: 'space-between', marginTop: 13, color: '#9aabba', font: '9px var(--app-font-mono)' }}><span>ENGINE REPORTED PROGRESS</span><span>{job.progress}%</span></div><div className="aa-meter" role="progressbar" aria-label="Engine job progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}><span style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div></>}
                  {pollError && <ErrorMessage message={pollError} onRetry={() => void refreshJob()} />}
                  {jobFailed && <ErrorMessage message={job.error?.message || 'The engine job did not complete.'} onRetry={() => void refreshJob()} />}
                  {awaitingDesktop && <div className="aa-note warn" style={{ marginTop: 12 }}>The engine reports that this job is awaiting a desktop handoff. This interface does not create native .ai files.</div>}
                  <div className="aa-controls"><span className="aa-meta">STATUS REFRESHES FROM THE ENGINE</span><button className="aa-btn secondary" type="button" disabled={busy === 'refresh'} onClick={() => void refreshJob()}>{busy === 'refresh' ? <LoaderCircle size={14} /> : <RotateCcw size={14} />} Refresh job</button></div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 14, padding: 16 }}>
                  {!frontCandidate || !backCandidate ? <div className="aa-note warn">A front and back crop must each be manually assigned in Detection before a job can be created.</div> : (
                    <div className="aa-pair">
                      {([['Front', frontCandidate], ['Back', backCandidate]] as const).map(([side, region]) => {
                        return <div className="aa-candidate" key={side}><div className="aa-card-head"><div><p className="aa-eyebrow">{side} PANEL</p><h2>{region.candidate_id}</h2></div><span className="aa-meta">CROP · SOURCE PIXELS</span></div><pre className="aa-json">{JSON.stringify(region.source_bbox_px, null, 2)}</pre></div>;
                      })}
                    </div>
                  )}
                  <div className="aa-field"><span>Raster equivalent resolution · applies only if raster content remains</span><div className="aa-inline">{([330, 600] as const).map((value) => <button key={value} type="button" className={`aa-btn ${dpi === value ? '' : 'secondary'}`} aria-pressed={dpi === value} onClick={() => setDpi(value)}>{value} DPI</button>)}</div></div>
                  <div className="aa-field"><span>Output vector formats</span><div className="aa-inline">{(['svg', 'eps'] as const).map((format) => {
                    const supported = capabilities?.formats[format].supported ?? false;
                    const checked = formats.includes(format);
                    return <label key={format} className="aa-note" style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: supported ? 1 : .48 }}>
                      <input type="checkbox" checked={checked && supported} disabled={!supported} onChange={() => setFormats((current) => checked ? current.filter((item) => item !== format) : [...current, format])} />
                      {format.toUpperCase()} {supported ? `· ${capabilities?.formats[format].color_space}` : '· unavailable'}
                    </label>;
                  })}</div></div>
                  <label className="aa-note" style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 460, opacity: capabilities?.ocr.available ? 1 : .55 }}>
                    <input type="checkbox" checked={runOcr && Boolean(capabilities?.ocr.available)} disabled={!capabilities?.ocr.available} onChange={(event) => setRunOcr(event.currentTarget.checked)} />
                    Run OCR text observations · advisory only · {capabilities?.ocr.available ? capabilities.ocr.engine : 'unavailable'}
                  </label>
                  <div className="aa-note warn">{useAiAssistance ? 'Opt-in AI was requested for image analysis and panel suggestions only; it does not approve or export artwork.' : 'AI was not invoked. Native AI mode remains disabled; fabric flattening and hidden artwork reconstruction are not automatic.'}</div>
                  <div className="aa-controls"><button type="button" className="aa-btn secondary" onClick={() => setCurrentStage(2)}><ArrowLeft size={14} /> Back to regions</button><button type="button" className="aa-btn" disabled={!canStartJob || Boolean(busy) || !capabilities} onClick={() => void createArtworkJob()} data-testid="button-create-job">{busy === 'job' ? <><LoaderCircle size={14} /> Creating job</> : <>Create artwork job <ArrowRight size={14} /></>}</button></div>
                </div>
              )}
            </div>
            <aside className="aa-card">
              <div className="aa-card-head"><div><p className="aa-eyebrow">LOCKED CANVAS RULES</p><h2>Engine specification</h2></div><LockKeyhole size={15} color="#8ddbc6" /></div>
              <div style={{ display: 'grid', gap: 8, padding: 14 }}>
                <div className="aa-note">Front and back: {maxWidth} × {maxHeight} in · {capabilities?.canvas.color_mode ?? 'CMYK'} · physical size comes from current engine capabilities.</div>
                <div className="aa-note">SVG: {capabilities?.formats.svg.supported ? 'supported' : 'unavailable'} · {capabilities?.formats.svg.color_space ?? 'not reported'} · EPS: {capabilities?.formats.eps.supported ? 'supported' : 'unavailable'} · {capabilities?.formats.eps.standard ?? 'not reported'}.</div>
                <div className="aa-note warn">DPI describes a raster equivalent, not vector path resolution. No print approval, bleed, seam allowance, or cutting pattern is part of this workflow.</div>
              </div>
            </aside>
          </section>
        )}

        {stage === 4 && (
          <section className="aa-split">
            <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">ENGINE RESULT / PREFLIGHT</p><h2>Returned report</h2></div><span className="aa-meta">{job?.status ?? 'No job'}</span></div>
              {job ? <pre className="aa-json">{JSON.stringify({ stage: job.stage, status: job.status, production_ready: job.production_ready, result: job.result, error: job.error }, null, 2)}</pre> : <div className="aa-canvas-empty"><div><strong>No artwork job</strong>Create a job after assigning both detected regions.</div></div>}
              {job && <div style={{ padding: 14 }}><div className="aa-note warn">This report reflects engine output only. It is not printer approval. Review source fidelity, text, color handling and any remaining raster content manually.</div></div>}
            </div>
            <aside className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">REVIEW BOUNDARIES</p><h2>What this does not certify</h2></div><ShieldCheck size={15} color="#f2c477" /></div>
              <div style={{ display: 'grid', gap: 9, padding: 14 }}>
                <div className="aa-note">Traced paths approximate the visible source; original fonts, designer layers, or obscured artwork are not reconstructed automatically.</div>
                <div className="aa-note">Fabric flattening/reconstruction and printing approval are out of scope. Native .ai output is unsupported here.</div>
                {job?.production_ready !== undefined && <div className="aa-job-state"><StatusDot state={job.production_ready ? 'ready' : 'pending'} />Engine production_ready: {String(job.production_ready)} · not printer approval</div>}
              </div>
            </aside>
            <div className="aa-controls" style={{ gridColumn: '1 / -1' }}>
              <button className="aa-btn secondary" type="button" onClick={() => setCurrentStage(3)}><ArrowLeft size={14} /> Job status</button>
              <div className="aa-control-right"><button className="aa-btn secondary" type="button" disabled={!jobComplete} onClick={() => { setStage(5); setHighestStage((current) => Math.max(current, 5)); }}>Open editor review</button><button className="aa-btn" type="button" disabled={!jobComplete} onClick={() => { setStage(6); setHighestStage((current) => Math.max(current, 6)); }}>Available exports <ArrowRight size={14} /></button></div>
            </div>
          </section>
        )}

        {stage === 5 && (
          <section className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">EDITOR / SOURCE REVIEW</p><h2>Separate artboards are available only from actual engine output</h2></div><span className="aa-meta">{job?.job_id ?? 'NO JOB'}</span></div>
            <div className="aa-pair" style={{ padding: 14 }}>
              {([['front-body', 'FRONT'], ['back-body', 'BACK']] as const).map(([prefix, side]) => {
                const svgName = `${prefix}.svg` as OutputName;
                const pngName = `${prefix}-preview.png` as OutputName;
                const imageName = previewUrls[svgName] ? svgName : pngName;
                const imageUrl = previewUrls[imageName];
                return <article key={prefix} className="aa-card">
                <div className="aa-card-head"><div><p className="aa-eyebrow">{side} / ENGINE OUTPUT</p><h2>{imageUrl ? imageName : `${prefix} · no preview returned`}</h2></div>{imageUrl && <a className="aa-btn secondary" href={imageUrl} download={imageName}><Download size={13} /> Download</a>}</div>
                {imageUrl ? <div className="aa-output-preview"><img src={imageUrl} alt={`${side.toLowerCase()} artwork returned by the engine`} /></div> : <div className="aa-canvas-empty"><div><strong>No preview file available</strong>The engine did not return an SVG or rendered preview image for this side.</div></div>}
                </article>;
              })}
            </div>
            <div style={{ padding: '0 14px 14px' }}><div className="aa-note">This review surface displays the engine’s real rendered preview files only. It does not provide object-level editing or fabricate editable layers. Use SVG/EPS in a compatible design application for editing.</div></div>
            <div className="aa-controls" style={{ padding: '0 14px 14px' }}><button className="aa-btn secondary" type="button" onClick={() => setCurrentStage(4)}><ArrowLeft size={14} /> Validation</button><button className="aa-btn" type="button" onClick={() => { setStage(6); setHighestStage((current) => Math.max(current, 6)); }}>Export files <ArrowRight size={14} /></button></div>
          </section>
        )}

        {stage === 6 && (
          <section className="aa-split">
            <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">OUTPUTS RETURNED BY ENGINE</p><h2>Available files</h2></div><span className="aa-meta">{availableFiles.length} FILES FOUND</span></div>
              {jobComplete ? availableFiles.length ? <div className="aa-export-list" style={{ padding: 14 }}>
                {availableFiles.map((filename) => {
                  const imageFile = filename.endsWith('.png');
                  const jsonFile = filename.endsWith('.json');
                  const Icon = imageFile ? FileImage : jsonFile ? FileText : FileText;
                  return <div className="aa-export-file" key={filename}><Icon size={17} color="#8ddbc6" /><span>{filename}</span><button className="aa-btn secondary" type="button" disabled={downloadBusy === filename} onClick={() => void downloadOutput(filename)}>{downloadBusy === filename ? <LoaderCircle size={13} /> : <Download size={13} />} Download</button></div>;
                })}
              </div> : <div className="aa-canvas-empty"><div><strong>No output files returned</strong>The job has completed, but the engine did not return an available file from its allowlist.</div></div> : <div className="aa-canvas-empty"><div><strong>Exports are not ready</strong>Only files successfully returned by a completed engine job are listed here.</div></div>}
              <div style={{ padding: '0 14px 14px' }}><div className="aa-note warn">An engine-generated file is not automatically print-approved. Confirm artwork, color workflow and downstream production requirements with your team.</div></div>
            </div>
            <aside style={{ display: 'grid', gap: 12 }}>
              <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">BUNDLE</p><h2>Download returned bundle</h2></div><FileArchive size={16} color="#8ddbc6" /></div><div style={{ display: 'grid', gap: 10, padding: 14 }}><p className="aa-subtitle" style={{ margin: 0 }}>Bundle download is requested from the engine and enabled only after a completed job.</p><button className="aa-btn" type="button" disabled={!jobComplete || downloadBusy === 'bundle'} onClick={() => void downloadOutput('bundle')}>{downloadBusy === 'bundle' ? <LoaderCircle size={14} /> : <Download size={14} />} Download ZIP bundle</button>{error && <p className="aa-alert" role="alert">{error}</p>}</div></div>
              <div className="aa-card"><div className="aa-card-head"><div><p className="aa-eyebrow">UNAVAILABLE</p><h2>Native Illustrator file</h2></div><CircleAlert size={15} color="#f2c477" /></div><div style={{ padding: 14 }}><div className="aa-note warn">Native .ai is unsupported in this workflow. An EPS/SVG file is never renamed or represented as a native .ai document.</div></div></div>
            </aside>
            <div className="aa-controls" style={{ gridColumn: '1 / -1' }}><button className="aa-btn secondary" type="button" onClick={() => setCurrentStage(5)}><ArrowLeft size={14} /> Editor review</button><span className="aa-meta">NO PRINTER APPROVAL · NO AUTOMATIC FABRIC RECONSTRUCTION</span></div>
          </section>
        )}

        <footer className="aa-footer"><span>ARTBOARD AI · A TOOL OF JERSEY OS</span><span>ONE SOURCE · TWO OPERATOR-ASSIGNED PANELS</span></footer>
      </div>
    </main>
  );
}

export default App;
