import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, RefreshCw, Layers, Keyboard, Settings, Image as ImageIcon } from 'lucide-react';
import { UploadZone } from './components/UploadZone';
import { ComparisonSlider } from './components/ComparisonSlider';
import { BackgroundCustomizer } from './components/BackgroundCustomizer';
import { ExportToolbar } from './components/ExportToolbar';
import { HistoryDrawer } from './components/HistoryDrawer';
import SettingsView from './components/SettingsView';
import { ToastContainer } from './components/Toast';
import type { AppState } from '../shared/types';
import type { BgConfig, PostProcessConfig, HistoryItem, ToastMessage } from './types/studio';
import { DEFAULT_POST_PROCESS } from './types/studio';
import { api } from './api';
import { waitForJobResult } from './jobs';
import { addHistoryItem, clearHistoryStore, createHistoryId, loadHistory } from './history';

import { compressImageForAI, createCutoutFromSvgPath } from './utils/image';

export function App() {
  const [currentPath, setCurrentPath] = useState<string>(() => window.location.pathname);
  const [appState, setAppState] = useState<AppState | null>(null);

  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [cutoutImage, setCutoutImage] = useState<string | null>(null);
  const [svgPath, setSvgPath] = useState<string | null>(null);
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  /** What the agent is doing right now. An agent turn runs for minutes — say something. */
  const [progressHint, setProgressHint] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Background Manyfold Agents state for A2A delegation
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const fetchState = async () => {
    try {
      const res = await api<AppState>('/api/state');
      setAppState(res);
      if (res.agents && res.agents.length > 0 && !selectedAgentId) {
        setSelectedAgentId(res.agents[0].agentId);
      }
    } catch {
      // Ignore initial state fetch error if unauthenticated
    }
  };

  useEffect(() => {
    void fetchState();
  }, []);

  // Listen to browser forward/back popstate
  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigateTo = (path: string) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  // Studio customizer state
  const [bgConfig, setBgConfig] = useState<BgConfig>({
    mode: 'transparent',
    color: '#FFFFFF',
    customImageUrl: null,
    blurAmount: 10,
  });

  const [postProcess, setPostProcess] = useState<PostProcessConfig>(DEFAULT_POST_PROCESS);

  // History & Toast State
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [forceShowOriginal, setForceShowOriginal] = useState<boolean>(false);

  const showToast = useCallback((text: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, text, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  useEffect(() => {
    let disposed = false;

    const refreshHistory = async () => {
      try {
        const items = await loadHistory();
        if (!disposed) setHistory(items);
      } catch (err) {
        console.error('Session history load failed:', err);
        if (!disposed) showToast('Session history could not be loaded.', 'warning');
      }
    };

    void refreshHistory();
    const cleanupTimer = window.setInterval(() => void refreshHistory(), 60_000);

    return () => {
      disposed = true;
      window.clearInterval(cleanupTimer);
    };
  }, [showToast]);

  const saveToHistory = async (item: Omit<HistoryItem, 'id' | 'timestamp'>) => {
    const newItem: HistoryItem = {
      ...item,
      id: createHistoryId(),
      timestamp: Date.now(),
    };

    try {
      const updated = await addHistoryItem(newItem);
      setHistory(updated);
    } catch (err) {
      console.error('Session history save failed:', err);
      showToast('This result could not be saved to Session history.', 'warning');
    }
  };

  const clearHistory = async () => {
    try {
      await clearHistoryStore();
      setHistory([]);
      showToast('All history has been cleared', 'info');
    } catch (err) {
      console.error('Session history clear failed:', err);
      showToast('Session history could not be cleared.', 'warning');
    }
  };

  const handleImageSelected = async (dataUrl: string) => {
    setOriginalImage(dataUrl);
    setIsLoading(true);
    setErrorMsg(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setProgressHint(null);
    setPostProcess(DEFAULT_POST_PROCESS);

    try {
      // 1. Compress image payload preserving alpha channel for AI vision processing
      const compressedImage = await compressImageForAI(dataUrl, 1536, 0.85);

      // 2. Call background removal API powered by Manyfold Agent / Gemini 3.6 Flash
      const response = await fetch('/api/remove-bg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: compressedImage,
          ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errDetail = errorData.error?.message || errorData.message || `HTTP ${response.status}`;
        throw new Error(`Background removal failed (${errDetail})`);
      }

      const data = (await response.json()) as {
        label?: string;
        image?: string;
        svgPath?: string;
        r2Key?: string;
        r2Url?: string;
        jobId?: string;
        statusUrl?: string;
      };

      // A jobId means 202: the agent's turn is running in the Worker's waitUntil and the
      // cutout will appear in R2 minutes from now. Nothing else in this response is a
      // result. Without one, this is the direct-Gemini path, which answers inline.
      if (data.jobId && data.statusUrl) {
        const agentLabel = data.label || 'Manyfold Agent';
        setSubjectLabel(agentLabel);
        setProgressHint(`Handed to ${agentLabel}. Waiting for the result…`);

        const { dataUrl: cutout } = await waitForJobResult(data.statusUrl, (message) =>
          setProgressHint(message),
        );

        setCutoutImage(cutout);
        setSvgPath(null);
        await saveToHistory({
          originalImage: dataUrl,
          cutoutImage: cutout,
          svgPath: null,
          subjectLabel: agentLabel,
        });
        showToast(`✦ Background removed (${agentLabel}) · backed up to R2`, 'success');
        return;
      }

      if (!data.image && !data.svgPath) {
        throw new Error('Background removal failed: no cutout image was returned.');
      }

      const extractedLabel = data.label || 'Subject detected';
      setSubjectLabel(extractedLabel);

      if (data.image) {
        // Native image background removal from Agent
        setCutoutImage(data.image);
        setSvgPath(null);

        await saveToHistory({
          originalImage: dataUrl,
          cutoutImage: data.image,
          svgPath: null,
          subjectLabel: extractedLabel,
        });
      } else if (data.svgPath) {
        // Legacy SVG path fallback
        const extractedSvgPath = data.svgPath;
        setSvgPath(extractedSvgPath);
        const generatedCutout = await createCutoutFromSvgPath(dataUrl, extractedSvgPath);
        setCutoutImage(generatedCutout);

        await saveToHistory({
          originalImage: dataUrl,
          cutoutImage: generatedCutout,
          svgPath: extractedSvgPath,
          subjectLabel: extractedLabel,
        });
      }

      if (data.r2Url) {
        showToast(`✦ Background removed (${extractedLabel}) · backed up to R2`, 'success');
      } else {
        showToast(`✦ Background removed and subject detected (${extractedLabel})`, 'success');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Background removal error:', message);
      setErrorMsg(message);
      showToast(message, 'warning');
    } finally {
      setIsLoading(false);
      setProgressHint(null);
    }
  };

  const handleReset = () => {
    setOriginalImage(null);
    setCutoutImage(null);
    setSvgPath(null);
    setSubjectLabel(null);
    setErrorMsg(null);
    setIsLoading(false);
    setProgressHint(null);
    setBgConfig({
      mode: 'transparent',
      color: '#FFFFFF',
      customImageUrl: null,
      blurAmount: 10,
    });
    setPostProcess(DEFAULT_POST_PROCESS);
  };

  const handleRestoreHistoryItem = (item: HistoryItem) => {
    setOriginalImage(item.originalImage);
    setCutoutImage(item.cutoutImage);
    setSvgPath(item.svgPath ?? null);
    setSubjectLabel(item.subjectLabel);
    setPostProcess(DEFAULT_POST_PROCESS);
    showToast(`Loaded history item: ${item.subjectLabel || 'background removal'}`, 'info');
  };

  // Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.code === 'Space' && originalImage) {
        e.preventDefault();
        setForceShowOriginal(true);
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && originalImage) {
        e.preventDefault();
        handleReset();
        showToast('Canvas and settings reset', 'info');
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setForceShowOriginal(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [originalImage, showToast]);

  const isSettingsRoute = currentPath === '/settings' || currentPath.startsWith('/settings');

  return (
    <div className="app-shell atelier-app-shell">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <header className="atelier-header">
        <button type="button" className="atelier-brand" onClick={() => navigateTo('/')}>
          <img src="/atelier-icon.png" alt="Atelier" className="atelier-brand-icon" />
          <span>ATELIER</span>
        </button>
        <div className="atelier-header-actions">
          <span className="atelier-header-note">Private image workspace</span>
          {isSettingsRoute ? (
            <button type="button" className="atelier-header-button" onClick={() => navigateTo('/')}>
              <ImageIcon size={15} />
              <span>Studio</span>
            </button>
          ) : (
            <button type="button" className="atelier-header-button" onClick={() => navigateTo('/settings')}>
              <Settings size={15} />
              <span>Settings</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content View */}
      {isSettingsRoute ? (
        <main className="app-main atelier-main">
          <SettingsView
            agents={appState?.agents || []}
            initialSession={appState?.connect?.session || null}
            adminRequired={appState?.adminRequired || false}
            adminOk={appState?.adminOk ?? true}
            refreshState={fetchState}
            onBackToCanvas={() => navigateTo('/')}
            showToast={showToast}
          />
        </main>
      ) : (
        <main className="app-main atelier-main">
          {/* Step 1: Uploading State */}
          {!originalImage && (
            <UploadZone onImageSelected={handleImageSelected} isLoading={isLoading} />
          )}

          {/* Step 2: Processing / Loading Overlay */}
          {isLoading && (
            <section className="atelier-processing" aria-live="polite">
              <div className="processing-mark"><RefreshCw size={22} className="spinning-icon" /></div>
              <span className="atelier-eyebrow">PROCESSING IMAGE</span>
              <h2>Separating the subject.</h2>
              <p>{progressHint ?? 'Detecting edges, hair, and transparent detail.'}</p>
              <div className="processing-progress" aria-hidden="true"><span /></div>
              <span className="processing-meta">{progressHint ? 'Agent processing can take a few minutes.' : 'Usually ready in a few seconds.'}</span>
            </section>
          )}

          {/* Error Notice */}
          {errorMsg && (
            <div className="notice error row align-center error-box">
              <AlertCircle size={20} />
              <div className="error-content">
                <strong>Background removal failed:</strong> {errorMsg}
              </div>
              <button type="button" className="button subtle" onClick={handleReset}>
                Try again
              </button>
            </div>
          )}

          {/* Step 3: Editor & Comparison Preview */}
          {originalImage && !isLoading && (
            <div className="atelier-studio-shell">
              <div className="studio-titlebar">
                <div>
                  <span className="atelier-eyebrow">STUDIO / READY</span>
                  <h2>Make the final cut.</h2>
                </div>
                <div className="studio-titlebar-meta">
                  <span className="studio-status-dot" />
                  <span>{subjectLabel ? `Subject: ${subjectLabel}` : 'Subject detected'}</span>
                </div>
              </div>
              <div className="editor-grid">
              {/* Left: Interactive Before/After Comparison Slider */}
              <div className="preview-panel">
                <div className="panel-header-row">
                  <span className="panel-heading">
                    <Layers size={16} /> Live comparison
                  </span>
                  <div className="panel-badges">
                    {subjectLabel && (
                      <span className="badge-subject">
                        Detected: {subjectLabel}
                      </span>
                    )}
                    <span className="badge-hint">
                      <Keyboard size={12} /> Hold Space to view original
                    </span>
                  </div>
                </div>

                <ComparisonSlider
                  originalImage={originalImage}
                  cutoutImage={cutoutImage}
                  svgPath={svgPath}
                  bgConfig={bgConfig}
                  postProcess={postProcess}
                  forceShowOriginal={forceShowOriginal}
                />
              </div>

              {/* Right: Controls & Export Toolbar */}
              <div className="controls-panel">
                <BackgroundCustomizer
                  config={bgConfig}
                  onChange={setBgConfig}
                  postProcess={postProcess}
                  onPostProcessChange={setPostProcess}
                  onResetAll={() => {
                    setPostProcess(DEFAULT_POST_PROCESS);
                    showToast('Effects and color adjustments reset', 'info');
                  }}
                />

                <ExportToolbar
                  originalImage={originalImage}
                  cutoutImage={cutoutImage}
                  svgPath={svgPath}
                  bgConfig={bgConfig}
                  postProcess={postProcess}
                  onReset={handleReset}
                  onShowToast={showToast}
                />
              </div>
              </div>
            </div>
          )}

          {/* Session History Drawer */}
          <HistoryDrawer
            history={history}
            onSelect={handleRestoreHistoryItem}
            onClear={clearHistory}
          />
        </main>
      )}

      <footer className="app-footer">
        <p>© 2026 Atelier — Powered by Cloudflare Workers & Manyfold AI</p>
        <a
          className="footer-github-link"
          href="https://github.com/manyfold-open/rmbg"
          target="_blank"
          rel="noreferrer"
          aria-label="Open the Atelier GitHub repository"
          title="GitHub repository"
        >
          <img src="/github.svg" alt="" aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}

export default App;
