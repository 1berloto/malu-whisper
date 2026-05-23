import { useState, useRef, useCallback, useEffect } from "react";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────
const MAX_FILE_SIZE    = 25 * 1024 * 1024; // 25 MB
const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const ACCEPT_ATTR      = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";
const MAX_AGE_MS       = 24 * 60 * 60 * 1000; // 24 h

const LANGUAGES = [
  { code: "pt", label: "🇧🇷 Português (BR)" },
  { code: "en", label: "🇺🇸 Inglês" },
  { code: "es", label: "🇪🇸 Espanhol" },
  { code: "fr", label: "🇫🇷 Francês" },
  { code: "de", label: "🇩🇪 Alemão" },
  { code: "it", label: "🇮🇹 Italiano" },
  { code: "ja", label: "🇯🇵 Japonês" },
  { code: "zh", label: "🇨🇳 Chinês" },
  { code: "",   label: "🌐 Detecção automática" },
];

// FIX #2 — fallback completo de mimeType (cobre Safari/iOS com audio/mp4)
function getBestMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find((t) => {
    try { return MediaRecorder.isTypeSupported(t); }
    catch { return false; }
  }) ?? "";
}

// ─────────────────────────────────────────────
// IndexedDB — armazenamento temporário (24 h)
// ─────────────────────────────────────────────
const DB_NAME    = "malu-whisper-db";
const DB_VERSION = 1;
const STORE_NAME = "recordings";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function saveRecordingToDB(blob) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx  = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).put({ blob, timestamp: Date.now() }, "latest");
      req.onsuccess = res;
      req.onerror   = (e) => rej(e.target.error);
    });
  } catch (err) {
    console.warn("[malu-whisper] IndexedDB save failed:", err);
  }
}

async function loadRecordingFromDB() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const req = db.transaction(STORE_NAME, "readonly")
                    .objectStore(STORE_NAME).get("latest");
      req.onsuccess = (e) => {
        const rec = e.target.result;
        if (!rec) { resolve(null); return; }
        if (Date.now() - rec.timestamp > MAX_AGE_MS) {
          clearRecordingFromDB();
          resolve(null);
          return;
        }
        resolve(rec);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function clearRecordingFromDB() {
  try {
    const db = await openDB();
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete("latest");
  } catch {}
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function pad2(n) { return String(Math.floor(n)).padStart(2, "0"); }
function pad3(n) { return String(Math.round(n)).padStart(3, "0"); }

function toSrtTime(s) {
  return `${pad2(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)},${pad3((s % 1) * 1000)}`;
}

function segmentsToSrt(segments) {
  return segments
    .map((seg, i) =>
      `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text.trim()}`
    )
    .join("\n\n") + "\n";
}

// FIX #9 — nome do arquivo inclui data/hora
function makeFilename(ext) {
  const now = new Date();
  const ts  = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `transcricao_${ts}.${ext}`;
}

function downloadFile(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(secs) {
  return `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return "menos de 1 minuto atrás";
  if (mins < 60) return `${mins} min atrás`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h atrás` : "mais de 1 dia atrás";
}

// FIX #6 — contagem de palavras e caracteres
function countWords(text) {
  if (!text?.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

// ─────────────────────────────────────────────
// Componentes reutilizáveis
// ─────────────────────────────────────────────

function Card({ children, style = {}, className = "" }) {
  return (
    <div className={className} style={{
      background: "white", borderRadius: "18px",
      padding: "20px", boxShadow: "0 2px 14px rgba(0,0,0,0.06)",
      ...style,
    }}>
      {children}
    </div>
  );
}

function SectionTitle({ icon, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
      <span style={{ fontSize: "17px" }}>{icon}</span>
      <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "#2D2D2D" }}>{title}</h2>
    </div>
  );
}

function FieldLabel({ htmlFor, children }) {
  return (
    <label htmlFor={htmlFor} style={{
      display: "block", fontSize: "12px", fontWeight: 700,
      marginBottom: "6px", color: "#6B7280",
      textTransform: "uppercase", letterSpacing: "0.04em",
    }}>
      {children}
    </label>
  );
}

function ErrorBanner({ message, onDismiss }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: "10px",
      background: "#FEF2F2", border: "1.5px solid #FECACA",
      borderRadius: "12px", padding: "12px 14px",
      marginTop: "12px", fontSize: "13px", color: "#B91C1C",
      animation: "fadeIn 0.3s ease",
    }}>
      <span style={{ flexShrink: 0 }}>⚠️</span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{message}</span>
      <button onClick={onDismiss} aria-label="Fechar erro" style={{
        background: "none", border: "none", cursor: "pointer",
        color: "#B91C1C", fontSize: "18px", padding: 0, lineHeight: 1, flexShrink: 0,
      }}>×</button>
    </div>
  );
}

function ActionButton({ onClick, icon, label, variant = "secondary", disabled = false }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: "6px",
    padding: "9px 16px", borderRadius: "9px",
    fontSize: "13px", fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit", transition: "opacity 0.15s, transform 0.1s",
    opacity: disabled ? 0.5 : 1,
  };
  const variants = {
    primary:   { background: "linear-gradient(135deg, #E8836B, #cf6a52)", color: "white", border: "none", boxShadow: "0 3px 10px rgba(232,131,107,0.35)" },
    secondary: { background: "white", color: "#374151", border: "1.5px solid #E5E7EB" },
    success:   { background: "#ECFDF5", color: "#047857", border: "1.5px solid #A7F3D0" },
    danger:    { background: "#FEF2F2", color: "#B91C1C", border: "1.5px solid #FECACA" },
  };
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{ ...base, ...variants[variant] }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.opacity = "0.82"; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = disabled ? "0.5" : "1"; }}
      onMouseDown={(e)  => { if (!disabled) e.currentTarget.style.transform = "scale(0.97)"; }}
      onMouseUp={(e)    => { e.currentTarget.style.transform = "scale(1)"; }}
    >
      <span>{icon}</span>{label}
    </button>
  );
}

// FIX #7 — overlay de loading com mensagem de progresso
function LoadingOverlay() {
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(251,248,244,0.88)",
      backdropFilter: "blur(5px)",
      WebkitBackdropFilter: "blur(5px)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      zIndex: 1000, gap: "20px",
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%",
        border: "4px solid #F3D5CC",
        borderTopColor: "#E8836B",
        animation: "spin 0.85s linear infinite",
      }} />
      <div style={{ textAlign: "center" }}>
        <p style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: 800, color: "#E8836B" }}>
          Transcrevendo…
        </p>
        <p style={{ margin: 0, fontSize: "12px", color: "#9CA3AF" }}>
          Isso pode levar alguns segundos dependendo do tamanho do áudio
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// App principal
// ─────────────────────────────────────────────
export default function App() {
  // Config
  const [apiKey,   setApiKey]   = useState("");
  const [showKey,  setShowKey]  = useState(false);
  const [language, setLanguage] = useState("pt");

  // Áudio
  const [audioFile,   setAudioFile]   = useState(null);
  const [audioUrl,    setAudioUrl]    = useState(null);
  const audioUrlRef                   = useRef(null); // FIX #5 — ref para evitar closure obsoleta
  const [audioSource, setAudioSource] = useState(null);
  const [activeTab,   setActiveTab]   = useState("upload");
  const [isDragging,  setIsDragging]  = useState(false);

  // Gravação
  const [isRecording,      setIsRecording]      = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const timerRef         = useRef(null);
  const fileInputRef     = useRef(null);

  // IndexedDB
  const [savedRecording, setSavedRecording] = useState(null);

  // Resultado
  const [isTranscribing,    setIsTranscribing]    = useState(false);
  const [transcriptionText, setTranscriptionText] = useState(null);
  const [transcriptionSrt,  setTranscriptionSrt]  = useState(null);
  const [error,             setError]             = useState(null);
  const [copied,            setCopied]            = useState(false);

  // Manter ref sincronizada com o estado de audioUrl
  useEffect(() => { audioUrlRef.current = audioUrl; }, [audioUrl]);

  // Carregar gravação salva ao abrir
  useEffect(() => {
    loadRecordingFromDB().then((rec) => { if (rec) setSavedRecording(rec); });
  }, []);

  // ── Helpers de URL ──
  const revokeCurrentUrl = () => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  };

  // ── Restaurar gravação salva ──
  const restoreSavedRecording = () => {
    if (!savedRecording) return;
    const { blob } = savedRecording;
    const file = new File([blob], "gravacao-restaurada.webm", { type: blob.type });
    revokeCurrentUrl();
    const newUrl = URL.createObjectURL(blob);
    setAudioFile(file);
    setAudioUrl(newUrl);
    audioUrlRef.current = newUrl;
    setAudioSource("recording");
    setActiveTab("record");
    setSavedRecording(null);
    setError(null);
  };

  const dismissSavedRecording = () => {
    clearRecordingFromDB();
    setSavedRecording(null);
  };

  // ── File handling ──
  const handleFile = useCallback((file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError("Arquivo muito grande. O limite da API OpenAI é 25 MB.");
      return;
    }
    revokeCurrentUrl();
    const newUrl = URL.createObjectURL(file);
    setAudioFile(file);
    setAudioUrl(newUrl);
    audioUrlRef.current = newUrl;
    setAudioSource("upload");
    setTranscriptionText(null);
    setTranscriptionSrt(null);
    setError(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // FIX #3 — reseta o input para que o mesmo arquivo possa ser re-selecionado
  const handleInputChange = (e) => {
    handleFile(e.target.files[0]);
    e.target.value = "";
  };

  // FIX #1 — onDragLeave só dispara ao sair do drop zone de verdade
  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  // ── Gravação ──
  const startRecording = async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getBestMimeType(); // FIX #2

      if (!mimeType) {
        setError("Seu browser não suporta gravação de áudio. Tente Chrome, Firefox ou Safari.");
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext  = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `gravacao.${ext}`, { type: mimeType });

        // FIX #5 — usar ref para revogar URL, evitando closure obsoleta
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const newUrl = URL.createObjectURL(blob);
        setAudioFile(file);
        setAudioUrl(newUrl);
        audioUrlRef.current = newUrl;
        setAudioSource("recording");
        setTranscriptionText(null);
        setTranscriptionSrt(null);
        stream.getTracks().forEach((t) => t.stop());

        await saveRecordingToDB(blob);
        setSavedRecording(null); // já carregado na UI, banner não é necessário
      };

      recorder.start(500);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      setError(null);
      timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      setError("Não foi possível acessar o microfone. Verifique as permissões do browser.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== "inactive")
      mediaRecorderRef.current.stop();
    setIsRecording(false);
    clearInterval(timerRef.current);
  };

  // FIX #4 — só limpa IndexedDB quando a fonte é uma gravação
  const discardAudio = () => {
    if (isRecording) stopRecording();
    revokeCurrentUrl();
    setAudioFile(null);
    setAudioUrl(null);
    audioUrlRef.current = null;
    setAudioSource(null);
    setRecordingSeconds(0);
    setTranscriptionText(null);
    setTranscriptionSrt(null);
    if (audioSource === "recording") clearRecordingFromDB();
  };

  // ── Transcrição ──
  const transcribe = async () => {
    if (!apiKey.trim()) { setError("Insira sua chave API da OpenAI antes de continuar."); return; }
    if (!audioFile)     { setError("Selecione ou grave um áudio primeiro."); return; }

    setIsTranscribing(true);
    setError(null);

    try {
      const fd = new FormData();
      fd.append("file", audioFile);
      fd.append("model", "whisper-1");
      fd.append("response_format", "verbose_json");
      if (language) fd.append("language", language);

      const res = await fetch(WHISPER_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        body: fd,
      });

      if (!res.ok) {
        let msg = `Erro ${res.status} da API OpenAI.`;
        try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
        if (res.status === 401) msg = "Chave API inválida ou expirada. Verifique e tente novamente.";
        else if (res.status === 413) msg = "Arquivo muito grande. O limite é 25 MB.";
        else if (res.status === 429) msg = "Muitas requisições. Aguarde um momento e tente novamente.";
        else if (res.status === 500) msg = "Erro interno da OpenAI. Tente novamente em alguns instantes.";
        throw new Error(msg);
      }

      const data = await res.json();
      setTranscriptionText(data.text ?? "");
      setTranscriptionSrt(data.segments?.length ? segmentsToSrt(data.segments) : null);

      // Sucesso: limpar gravação salva (transcrição concluída)
      if (audioSource === "recording") clearRecordingFromDB();

    } catch (err) {
      setError(err.message);
      // Em caso de falha: manter áudio no IndexedDB para nova tentativa
    } finally {
      setIsTranscribing(false);
    }
  };

  // ── Copiar ──
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(transcriptionText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Não foi possível copiar automaticamente. Use Ctrl+A → Ctrl+C na área de texto.");
    }
  };

  // ── Downloads ── FIX #9 — nome inclui timestamp
  const downloadTxt  = () => downloadFile(transcriptionText, makeFilename("txt"));
  const downloadSrt  = () => downloadFile(transcriptionSrt,  makeFilename("srt"));
  const downloadBoth = () => { downloadTxt(); setTimeout(downloadSrt, 300); };

  // ── Reset ──
  const reset = () => {
    if (isRecording) stopRecording();
    revokeCurrentUrl();
    setAudioFile(null);
    setAudioUrl(null);
    audioUrlRef.current = null;
    setAudioSource(null);
    setRecordingSeconds(0);
    setTranscriptionText(null);
    setTranscriptionSrt(null);
    setError(null);
    setCopied(false);
    clearRecordingFromDB();
  };

  const hasResult     = transcriptionText !== null;
  const canTranscribe = !!(apiKey.trim() && audioFile && !isTranscribing);

  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; }

        .fade-in { animation: fadeIn 0.35s ease; }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        .pulse-dot { animation: pulseDot 1.3s ease-in-out infinite; }
        @keyframes pulseDot {
          0%, 100% { transform: scale(1); opacity: 1; }
          50%       { transform: scale(1.4); opacity: 0.55; }
        }

        .spin { animation: spin 0.85s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        button:focus-visible, input:focus-visible,
        select:focus-visible, textarea:focus-visible {
          outline: 2.5px solid #E8836B;
          outline-offset: 2px;
        }

        ::-webkit-scrollbar       { width: 5px; }
        ::-webkit-scrollbar-thumb { background: #DDD; border-radius: 4px; }

        .tab-btn {
          flex: 1; padding: 9px 8px; border-radius: 9px; border: none;
          cursor: pointer; font-size: 13px; font-weight: 700;
          font-family: inherit; transition: all 0.18s;
        }
        .tab-btn.active   { background: white; color: #E8836B; box-shadow: 0 1px 5px rgba(0,0,0,0.1); }
        .tab-btn.inactive { background: transparent; color: #9CA3AF; }
        .tab-btn.inactive:hover { color: #6B7280; }

        .drop-zone {
          border: 2.5px dashed #D1D5DB;
          border-radius: 14px; padding: 28px 20px;
          text-align: center; cursor: pointer;
          background: #FAFAFA; transition: all 0.2s;
          user-select: none;
        }
        .drop-zone:hover, .drop-zone.dragging {
          border-color: #E8836B;
          background: #FEF3F0;
        }
        .drop-zone:focus { outline: 2.5px solid #E8836B; }
      `}</style>

      {/* FIX #7 — overlay de loading */}
      {isTranscribing && <LoadingOverlay />}

      <div style={{
        backgroundColor: "#FBF8F4",
        minHeight: "100vh",
        fontFamily: "'Nunito', 'Segoe UI', sans-serif",
        color: "#2D2D2D",
      }}>

        {/* ════ HEADER ════ */}
        <header style={{ padding: "28px 20px 12px", textAlign: "center" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "12px" }}>
            <div style={{
              width: 46, height: 46, borderRadius: "13px",
              background: "linear-gradient(135deg, #E8836B 0%, #cf6a52 100%)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "22px", boxShadow: "0 4px 14px rgba(232,131,107,0.45)",
            }}>🎙️</div>
            <div style={{ textAlign: "left" }}>
              <h1 style={{ margin: 0, fontSize: "23px", fontWeight: 900, color: "#E8836B", lineHeight: 1.1 }}>
                malu-whisper
              </h1>
              <p style={{ margin: 0, fontSize: "12px", color: "#6B8E9B", fontWeight: 600 }}>
                transcrição de áudio com IA
              </p>
            </div>
          </div>
        </header>

        {/* ════ CONTEÚDO ════ */}
        <main style={{ maxWidth: "600px", margin: "0 auto", padding: "8px 16px 64px" }}>

          {/* ── Banner: gravação recuperável ── */}
          {savedRecording && (
            <div className="fade-in" style={{
              display: "flex", alignItems: "center", gap: "12px",
              flexWrap: "wrap", // FIX #11 — mobile friendly
              background: "linear-gradient(135deg, #FFF7ED, #FEF3C7)",
              border: "1.5px solid #FCD34D",
              borderRadius: "14px", padding: "14px 16px",
              marginBottom: "12px",
            }}>
              <span style={{ fontSize: "22px", flexShrink: 0 }}>💾</span>
              <div style={{ flex: 1, minWidth: "140px" }}>
                <p style={{ margin: "0 0 2px", fontSize: "13px", fontWeight: 800, color: "#92400E" }}>
                  Gravação salva encontrada
                </p>
                <p style={{ margin: 0, fontSize: "11px", color: "#B45309" }}>
                  {formatSize(savedRecording.blob.size)} · salva {timeAgo(savedRecording.timestamp)}
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                <button onClick={restoreSavedRecording} style={{
                  padding: "7px 14px", borderRadius: "8px", border: "none",
                  background: "#F59E0B", color: "white",
                  fontSize: "12px", fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
                }}>Restaurar</button>
                <button onClick={dismissSavedRecording} style={{
                  padding: "7px 10px", borderRadius: "8px",
                  border: "1px solid #FCD34D", background: "transparent",
                  color: "#92400E", fontSize: "12px", cursor: "pointer", fontFamily: "inherit",
                }}>Descartar</button>
              </div>
            </div>
          )}

          {/* ── CARD 1: Configuração ── */}
          <Card style={{ marginBottom: "12px" }}>
            <SectionTitle icon="🔑" title="Configuração da API" />

            <FieldLabel htmlFor="api-key">Chave API da OpenAI</FieldLabel>
            <div style={{ position: "relative" }}>
              <input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-proj-..."
                autoComplete="off"
                disabled={isTranscribing} // FIX #10
                style={{
                  width: "100%", padding: "10px 44px 10px 14px",
                  borderRadius: "10px", border: "1.5px solid #E5E7EB",
                  fontSize: "13px", fontFamily: "'JetBrains Mono', monospace",
                  background: "#FAFAFA", color: "#2D2D2D",
                  transition: "border-color 0.2s",
                  opacity: isTranscribing ? 0.6 : 1,
                }}
                onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
                onBlur={(e)  => (e.target.style.borderColor = "#E5E7EB")}
              />
              <button
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
                style={{
                  position: "absolute", right: "11px", top: "50%",
                  transform: "translateY(-50%)",
                  background: "none", border: "none",
                  cursor: "pointer", fontSize: "15px", padding: "3px", lineHeight: 1,
                }}
              >{showKey ? "🙈" : "👁️"}</button>
            </div>
            <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "6px 0 0", lineHeight: 1.5 }}>
              Sua chave fica apenas na memória desta sessão — não é salva nem enviada a outros servidores.
            </p>

            <div style={{ marginTop: "16px" }}>
              <FieldLabel htmlFor="language">Idioma da transcrição</FieldLabel>
              <select
                id="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isTranscribing} // FIX #10
                style={{
                  width: "100%", padding: "10px 14px",
                  borderRadius: "10px", border: "1.5px solid #E5E7EB",
                  fontSize: "14px", background: "#FAFAFA",
                  color: "#2D2D2D", cursor: "pointer",
                  fontFamily: "inherit", transition: "border-color 0.2s",
                  opacity: isTranscribing ? 0.6 : 1,
                }}
                onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
                onBlur={(e)  => (e.target.style.borderColor = "#E5E7EB")}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            <div style={{
              marginTop: "12px", padding: "8px 12px",
              background: "#F0F9FF", borderRadius: "8px",
              fontSize: "11px", color: "#0369A1",
              display: "flex", alignItems: "center", gap: "6px",
            }}>
              <span>ℹ️</span>
              <span>
                Modelo: <strong>whisper-1</strong> — único disponível via API OpenAI.
                Novos modelos aparecerão aqui conforme liberados.
              </span>
            </div>
          </Card>

          {/* ── CARD 2: Áudio ── */}
          <Card style={{ marginBottom: "12px" }}>
            <SectionTitle icon="🎵" title="Áudio" />

            {/* Tabs */}
            <div style={{
              display: "flex", background: "#F3F4F6",
              borderRadius: "11px", padding: "3px",
              marginBottom: "18px", gap: "2px",
            }}>
              {[["upload", "📁 Enviar arquivo"], ["record", "🎤 Gravar agora"]].map(
                ([tab, label]) => (
                  <button
                    key={tab}
                    onClick={() => !isTranscribing && setActiveTab(tab)} // FIX #10
                    className={`tab-btn ${activeTab === tab ? "active" : "inactive"}`}
                    style={{ opacity: isTranscribing ? 0.6 : 1 }}
                  >
                    {label}
                  </button>
                )
              )}
            </div>

            {/* ─ Tab: Upload ─ */}
            {activeTab === "upload" && (
              <div>
                {/* FIX #1 — handleDragLeave com relatedTarget check */}
                <div
                  role="button"
                  tabIndex={0}
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={handleDragLeave}
                  onClick={() => !isTranscribing && fileInputRef.current?.click()}
                  onKeyDown={(e) => e.key === "Enter" && !isTranscribing && fileInputRef.current?.click()}
                  className={`drop-zone${isDragging ? " dragging" : ""}`}
                  style={{ opacity: isTranscribing ? 0.6 : 1, cursor: isTranscribing ? "not-allowed" : "pointer" }}
                  aria-label="Selecionar arquivo de áudio"
                >
                  <div style={{ fontSize: "36px", marginBottom: "10px" }}>
                    {isDragging ? "🎯" : "📂"}
                  </div>
                  <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 700, color: "#374151" }}>
                    Arraste um arquivo aqui
                  </p>
                  <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#9CA3AF" }}>
                    ou clique para selecionar
                  </p>
                  <span style={{
                    display: "inline-block", padding: "7px 18px", borderRadius: "9px",
                    background: "linear-gradient(135deg, #E8836B, #cf6a52)",
                    color: "white", fontSize: "12px", fontWeight: 700,
                    boxShadow: "0 2px 8px rgba(232,131,107,0.35)",
                  }}>
                    Escolher arquivo
                  </span>
                </div>
                <p style={{ fontSize: "11px", color: "#9CA3AF", marginTop: "8px", textAlign: "center" }}>
                  Formatos aceitos: mp3 · mp4 · m4a · wav · webm · mpeg — máx 25 MB
                </p>
                {/* FIX #3 — fileInputRef resetado no handleInputChange */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  onChange={handleInputChange}
                  style={{ display: "none" }}
                />
              </div>
            )}

            {/* ─ Tab: Gravação ─ */}
            {activeTab === "record" && (
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                {/* Já tem um upload — pedir para descartar antes */}
                {!isRecording && audioFile && audioSource === "upload" && (
                  <div>
                    <div style={{ fontSize: "36px", marginBottom: "10px" }}>📂</div>
                    <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6B7280" }}>
                      Você já tem um arquivo selecionado.
                    </p>
                    <button
                      onClick={() => !isTranscribing && discardAudio()}
                      disabled={isTranscribing}
                      style={{
                        padding: "10px 22px", borderRadius: "50px",
                        border: "1.5px solid #E5E7EB", background: "white",
                        color: "#6B7280", fontSize: "13px", fontWeight: 700,
                        cursor: isTranscribing ? "not-allowed" : "pointer",
                        fontFamily: "inherit", transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { if (!isTranscribing) { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; } }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.color = "#6B7280"; }}
                    >
                      🗑️ &nbsp;Descartar e gravar novo
                    </button>
                  </div>
                )}

                {/* Idle — sem áudio */}
                {!isRecording && !audioFile && (
                  <>
                    <div style={{ fontSize: "48px", marginBottom: "12px" }}>🎤</div>
                    <p style={{ margin: "0 0 18px", fontSize: "14px", color: "#6B7280" }}>
                      Clique para começar a gravar
                    </p>
                    <button
                      onClick={startRecording}
                      style={{
                        padding: "12px 30px", borderRadius: "50px",
                        border: "none", cursor: "pointer", fontFamily: "inherit",
                        background: "linear-gradient(135deg, #E8836B, #cf6a52)",
                        color: "white", fontSize: "14px", fontWeight: 800,
                        boxShadow: "0 4px 16px rgba(232,131,107,0.45)",
                        transition: "opacity 0.15s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                    >
                      ● &nbsp;Iniciar gravação
                    </button>
                  </>
                )}

                {/* Gravando */}
                {isRecording && (
                  <div style={{ padding: "4px 0" }}>
                    <div style={{
                      display: "inline-flex", alignItems: "center", gap: "10px",
                      background: "#FEF2F2", padding: "10px 22px",
                      borderRadius: "50px", marginBottom: "20px",
                    }}>
                      <div className="pulse-dot" style={{
                        width: 10, height: 10, borderRadius: "50%",
                        background: "#EF4444", flexShrink: 0,
                      }} />
                      <span style={{
                        fontSize: "15px", fontWeight: 800, color: "#EF4444",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        {formatTime(recordingSeconds)}
                      </span>
                      <span style={{ fontSize: "12px", color: "#F87171", fontWeight: 600 }}>gravando</span>
                    </div>
                    <br />
                    <button
                      onClick={stopRecording}
                      style={{
                        padding: "12px 30px", borderRadius: "50px",
                        border: "2px solid #EF4444", background: "white",
                        color: "#EF4444", fontSize: "14px", fontWeight: 800,
                        cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#FEF2F2"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "white"; }}
                    >
                      ■ &nbsp;Parar gravação
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ─ Preview do áudio ─ */}
            {audioFile && !isRecording && (
              <div className="fade-in" style={{
                marginTop: "16px", background: "#F8F9FA",
                borderRadius: "12px", padding: "14px",
                border: "1.5px solid #E5E7EB",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px", flexShrink: 0 }}>
                    {audioSource === "recording" ? "🎙️" : "📄"}
                  </span>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <p style={{
                      margin: 0, fontSize: "13px", fontWeight: 700,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {audioFile.name}
                    </p>
                    <p style={{ margin: 0, fontSize: "11px", color: "#9CA3AF" }}>
                      {formatSize(audioFile.size)}
                      {audioSource === "recording" && (
                        <span style={{ marginLeft: "8px", color: "#F59E0B", fontWeight: 700 }}>
                          · 💾 salvo por 24h
                        </span>
                      )}
                    </p>
                  </div>
                  {/* FIX #10 — botão de remoção desabilitado durante transcrição */}
                  <button
                    onClick={() => !isTranscribing && discardAudio()}
                    disabled={isTranscribing}
                    aria-label="Remover áudio"
                    title="Remover áudio"
                    style={{
                      background: "none", border: "none",
                      cursor: isTranscribing ? "not-allowed" : "pointer",
                      fontSize: "16px", color: "#9CA3AF", padding: "4px",
                      borderRadius: "6px", flexShrink: 0, transition: "color 0.15s",
                      opacity: isTranscribing ? 0.4 : 1,
                    }}
                    onMouseEnter={(e) => { if (!isTranscribing) e.currentTarget.style.color = "#EF4444"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "#9CA3AF"; }}
                  >🗑️</button>
                </div>
                <audio src={audioUrl} controls style={{ width: "100%", borderRadius: "8px", height: "38px" }} />
              </div>
            )}
          </Card>

          {/* ── Erro ── */}
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          {/* ── Botão Transcrever ── */}
          {!hasResult && (
            <button
              onClick={transcribe}
              disabled={!canTranscribe}
              style={{
                width: "100%", marginTop: "12px", padding: "15px",
                borderRadius: "14px", border: "none", fontFamily: "inherit",
                background: canTranscribe
                  ? "linear-gradient(135deg, #E8836B 0%, #cf6a52 100%)"
                  : "#E5E7EB",
                color: canTranscribe ? "white" : "#9CA3AF",
                fontSize: "16px", fontWeight: 900,
                cursor: canTranscribe ? "pointer" : "not-allowed",
                boxShadow: canTranscribe ? "0 5px 18px rgba(232,131,107,0.42)" : "none",
                transition: "all 0.2s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "10px",
              }}
              onMouseEnter={(e) => { if (canTranscribe) e.currentTarget.style.opacity = "0.88"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
            >
              ✨ Transcrever
            </button>
          )}

          {/* ── Resultado ── */}
          {hasResult && (
            <Card className="fade-in" style={{ marginTop: "12px" }}>
              <div style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", marginBottom: "14px",
                flexWrap: "wrap", gap: "8px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "18px" }}>✅</span>
                  <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>Transcrição</h2>
                </div>
                <ActionButton onClick={reset} icon="↺" label="Nova transcrição" variant="secondary" />
              </div>

              {/* FIX #6 — textarea editável + contador de palavras */}
              <textarea
                value={transcriptionText}
                onChange={(e) => setTranscriptionText(e.target.value)}
                placeholder="A transcrição aparecerá aqui…"
                style={{
                  width: "100%", minHeight: "180px", padding: "14px",
                  borderRadius: "10px", border: "1.5px solid #E5E7EB",
                  background: "#FAFAFA", fontSize: "14px",
                  fontFamily: "'JetBrains Mono', monospace",
                  lineHeight: 1.65, resize: "vertical", color: "#2D2D2D",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
                onBlur={(e)  => (e.target.style.borderColor = "#E5E7EB")}
              />

              {/* Contadores de palavras/caracteres */}
              <div style={{
                display: "flex", justifyContent: "flex-end",
                gap: "12px", marginTop: "6px",
                fontSize: "11px", color: "#9CA3AF",
              }}>
                <span>{countWords(transcriptionText)} palavras</span>
                <span>{transcriptionText?.length ?? 0} caracteres</span>
              </div>

              <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                <ActionButton
                  onClick={copyText}
                  icon={copied ? "✅" : "📋"}
                  label={copied ? "Copiado!" : "Copiar texto"}
                  variant={copied ? "success" : "secondary"}
                />
                <ActionButton onClick={downloadTxt} icon="📄" label="Baixar .txt" variant="secondary" />
                {transcriptionSrt && (
                  <ActionButton onClick={downloadSrt} icon="🎬" label="Baixar .srt" variant="secondary" />
                )}
                {transcriptionSrt && (
                  <ActionButton onClick={downloadBoth} icon="⬇️" label="Baixar ambos" variant="primary" />
                )}
              </div>

              {!transcriptionSrt && (
                <p style={{ fontSize: "11px", color: "#9CA3AF", marginTop: "10px", marginBottom: 0 }}>
                  ⓘ Arquivo .srt não disponível — a resposta não retornou timestamps.
                </p>
              )}
            </Card>
          )}

          <p style={{ textAlign: "center", fontSize: "11px", color: "#C4C9D4", marginTop: "28px" }}>
            whisper-1 · ~$0,006/min · sua chave, sua conta OpenAI
          </p>
        </main>
      </div>
    </>
  );
}
