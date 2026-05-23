import { useState, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const ACCEPT_ATTR = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";

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

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function pad2(n) { return String(Math.floor(n)).padStart(2, "0"); }
function pad3(n) { return String(Math.round(n)).padStart(3, "0"); }

function toSrtTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(sc)},${pad3(ms)}`;
}

function segmentsToSrt(segments) {
  return (
    segments
      .map((seg, i) =>
        `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text.trim()}`
      )
      .join("\n\n") + "\n"
  );
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
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(secs) {
  return `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
}

// ─────────────────────────────────────────────
// Sub-componentes
// ─────────────────────────────────────────────

function Card({ children, style = {} }) {
  return (
    <div
      style={{
        background: "white",
        borderRadius: "18px",
        padding: "20px",
        boxShadow: "0 2px 14px rgba(0,0,0,0.06)",
        ...style,
      }}
    >
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
    <label
      htmlFor={htmlFor}
      style={{ display: "block", fontSize: "12px", fontWeight: 700, marginBottom: "6px", color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.04em" }}
    >
      {children}
    </label>
  );
}

function ErrorBanner({ message, onDismiss }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "flex-start", gap: "10px",
        background: "#FEF2F2", border: "1.5px solid #FECACA",
        borderRadius: "12px", padding: "12px 14px",
        marginTop: "12px", fontSize: "13px", color: "#B91C1C",
        animation: "fadeIn 0.3s ease",
      }}
    >
      <span style={{ flexShrink: 0 }}>⚠️</span>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{message}</span>
      <button
        onClick={onDismiss}
        aria-label="Fechar erro"
        style={{ background: "none", border: "none", cursor: "pointer", color: "#B91C1C", fontSize: "18px", padding: 0, lineHeight: 1, flexShrink: 0 }}
      >
        ×
      </button>
    </div>
  );
}

function ActionButton({ onClick, icon, label, variant = "secondary", disabled = false }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: "6px",
    padding: "9px 16px", borderRadius: "9px",
    fontSize: "13px", fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit", transition: "opacity 0.15s, transform 0.1s",
    opacity: disabled ? 0.5 : 1,
  };
  const variants = {
    primary:  { background: "linear-gradient(135deg, #E8836B, #cf6a52)", color: "white", border: "none", boxShadow: "0 3px 10px rgba(232,131,107,0.35)" },
    secondary:{ background: "white", color: "#374151", border: "1.5px solid #E5E7EB" },
    success:  { background: "#ECFDF5", color: "#047857", border: "1.5px solid #A7F3D0" },
    danger:   { background: "#FEF2F2", color: "#B91C1C", border: "1.5px solid #FECACA" },
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
  const [audioSource, setAudioSource] = useState(null); // "upload" | "recording"
  const [activeTab,   setActiveTab]   = useState("upload");
  const [isDragging,  setIsDragging]  = useState(false);

  // Gravação
  const [isRecording,      setIsRecording]      = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef   = useRef(null);
  const chunksRef          = useRef([]);
  const timerRef           = useRef(null);
  const fileInputRef       = useRef(null);

  // Processamento & resultado
  const [isTranscribing,    setIsTranscribing]    = useState(false);
  const [transcriptionText, setTranscriptionText] = useState(null);
  const [transcriptionSrt,  setTranscriptionSrt]  = useState(null);
  const [error,             setError]             = useState(null);
  const [copied,            setCopied]            = useState(false);

  // ── File handling ──────────────────────────
  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      if (file.size > MAX_FILE_SIZE) {
        setError("Arquivo muito grande. O limite da API OpenAI é 25 MB.");
        return;
      }
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
      setAudioSource("upload");
      setTranscriptionText(null);
      setTranscriptionSrt(null);
      setError(null);
    },
    [audioUrl]
  );

  const handleInputChange = (e) => handleFile(e.target.files[0]);

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  // ── Gravação ───────────────────────────────
  const startRecording = async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const file = new File([blob], "gravacao.webm", { type: mimeType });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioFile(file);
        setAudioUrl(URL.createObjectURL(blob));
        setAudioSource("recording");
        setTranscriptionText(null);
        setTranscriptionSrt(null);
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start(500);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      setError(null);
      timerRef.current = setInterval(
        () => setRecordingSeconds((s) => s + 1),
        1000
      );
    } catch {
      setError(
        "Não foi possível acessar o microfone. Verifique as permissões do browser."
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    clearInterval(timerRef.current);
  };

  const discardAudio = () => {
    if (isRecording) stopRecording();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(null);
    setAudioUrl(null);
    setAudioSource(null);
    setRecordingSeconds(0);
    setTranscriptionText(null);
    setTranscriptionSrt(null);
  };

  // ── Transcrição ────────────────────────────
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
        try {
          const d = await res.json();
          msg = d.error?.message || msg;
        } catch {}
        if (res.status === 401) msg = "Chave API inválida ou expirada. Verifique e tente novamente.";
        else if (res.status === 413) msg = "Arquivo muito grande. O limite é 25 MB.";
        else if (res.status === 429) msg = "Muitas requisições. Aguarde um momento e tente novamente.";
        throw new Error(msg);
      }

      const data = await res.json();
      setTranscriptionText(data.text ?? "");
      setTranscriptionSrt(
        data.segments?.length ? segmentsToSrt(data.segments) : null
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setIsTranscribing(false);
    }
  };

  // ── Copiar ─────────────────────────────────
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(transcriptionText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.");
    }
  };

  // ── Downloads ──────────────────────────────
  const downloadTxt  = () => downloadFile(transcriptionText, "transcricao.txt");
  const downloadSrt  = () => downloadFile(transcriptionSrt,  "transcricao.srt");
  const downloadBoth = () => { downloadTxt(); setTimeout(downloadSrt, 300); };

  // ── Resetar ────────────────────────────────
  const reset = () => {
    if (isRecording) stopRecording();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(null);
    setAudioUrl(null);
    setAudioSource(null);
    setRecordingSeconds(0);
    setTranscriptionText(null);
    setTranscriptionSrt(null);
    setError(null);
    setCopied(false);
  };

  const hasResult    = transcriptionText !== null;
  const canTranscribe = !!(apiKey.trim() && audioFile && !isTranscribing);

  // ─────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────
  return (
    <>
      {/* ── Estilos globais ── */}
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
          0%, 100% { transform: scale(1);   opacity: 1;   }
          50%       { transform: scale(1.4); opacity: 0.55; }
        }

        .spin { animation: spin 0.9s linear infinite; display: inline-block; }
        @keyframes spin { to { transform: rotate(360deg); } }

        button:focus-visible,
        input:focus-visible,
        select:focus-visible,
        textarea:focus-visible {
          outline: 2.5px solid #E8836B;
          outline-offset: 2px;
        }

        ::-webkit-scrollbar       { width: 5px; }
        ::-webkit-scrollbar-thumb { background: #DDD; border-radius: 4px; }

        .drop-active {
          border-color: #E8836B !important;
          background: #FEF3F0 !important;
        }

        .tab-btn {
          flex: 1; padding: 9px 8px;
          border-radius: 9px; border: none;
          cursor: pointer; font-size: 13px;
          font-weight: 700; font-family: inherit;
          transition: all 0.18s;
        }
        .tab-btn.active {
          background: white;
          color: #E8836B;
          box-shadow: 0 1px 5px rgba(0,0,0,0.1);
        }
        .tab-btn.inactive {
          background: transparent;
          color: #9CA3AF;
        }
        .tab-btn.inactive:hover { color: #6B7280; }

        input[type=range] { accent-color: #E8836B; }
      `}</style>

      {/* ── Layout raiz ── */}
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
            }}>
              🎙️
            </div>
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

        {/* ════ CONTEÚDO PRINCIPAL ════ */}
        <main style={{ maxWidth: "600px", margin: "0 auto", padding: "8px 16px 64px" }}>

          {/* ── CARD 1: Configuração ── */}
          <Card style={{ marginBottom: "12px" }}>
            <SectionTitle icon="🔑" title="Configuração da API" />

            {/* Chave API */}
            <FieldLabel htmlFor="api-key">Chave API da OpenAI</FieldLabel>
            <div style={{ position: "relative" }}>
              <input
                id="api-key"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-proj-..."
                autoComplete="off"
                style={{
                  width: "100%", padding: "10px 44px 10px 14px",
                  borderRadius: "10px", border: "1.5px solid #E5E7EB",
                  fontSize: "13px", fontFamily: "'JetBrains Mono', monospace",
                  background: "#FAFAFA", color: "#2D2D2D",
                  transition: "border-color 0.2s",
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
                  cursor: "pointer", fontSize: "15px", padding: "3px",
                  lineHeight: 1,
                }}
              >
                {showKey ? "🙈" : "👁️"}
              </button>
            </div>
            <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "6px 0 0", lineHeight: 1.5 }}>
              Sua chave fica apenas na memória desta sessão — não é salva nem enviada a outros servidores.
            </p>

            {/* Idioma */}
            <div style={{ marginTop: "16px" }}>
              <FieldLabel htmlFor="language">Idioma da transcrição</FieldLabel>
              <select
                id="language"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                style={{
                  width: "100%", padding: "10px 14px",
                  borderRadius: "10px", border: "1.5px solid #E5E7EB",
                  fontSize: "14px", background: "#FAFAFA",
                  color: "#2D2D2D", cursor: "pointer",
                  transition: "border-color 0.2s",
                  fontFamily: "inherit",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
                onBlur={(e)  => (e.target.style.borderColor = "#E5E7EB")}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>

            {/* Modelo (informativo) */}
            <div style={{
              marginTop: "12px", padding: "8px 12px",
              background: "#F0F9FF", borderRadius: "8px",
              fontSize: "11px", color: "#0369A1",
              display: "flex", alignItems: "center", gap: "6px",
            }}>
              <span>ℹ️</span>
              <span>Modelo: <strong>whisper-1</strong> — único modelo disponível via API OpenAI. Novos modelos aparecerão aqui conforme liberados.</span>
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
                    onClick={() => setActiveTab(tab)}
                    className={`tab-btn ${activeTab === tab ? "active" : "inactive"}`}
                  >
                    {label}
                  </button>
                )
              )}
            </div>

            {/* ─ Tab: Upload ─ */}
            {activeTab === "upload" && (
              <div>
                <div
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onClick={() => fileInputRef.current?.click()}
                  className={isDragging ? "drop-active" : ""}
                  style={{
                    border: `2.5px dashed ${isDragging ? "#E8836B" : "#D1D5DB"}`,
                    borderRadius: "14px", padding: "28px 20px",
                    textAlign: "center", cursor: "pointer",
                    background: isDragging ? "#FEF3F0" : "#FAFAFA",
                    transition: "all 0.2s",
                    userSelect: "none",
                  }}
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
                    display: "inline-block", padding: "7px 18px",
                    borderRadius: "9px",
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
                {/* Estado: idle, mas já tem um áudio carregado (upload) */}
                {!isRecording && audioFile && audioSource === "upload" && (
                  <div style={{ padding: "8px 0 4px" }}>
                    <div style={{ fontSize: "36px", marginBottom: "10px" }}>📂</div>
                    <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6B7280" }}>
                      Você já tem um arquivo selecionado.
                    </p>
                    <button
                      onClick={discardAudio}
                      style={{
                        padding: "10px 22px", borderRadius: "50px",
                        border: "1.5px solid #E5E7EB", background: "white",
                        color: "#6B7280", fontSize: "13px", fontWeight: 700,
                        cursor: "pointer", fontFamily: "inherit",
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.color = "#6B7280"; }}
                    >
                      🗑️ &nbsp;Descartar e gravar novo
                    </button>
                  </div>
                )}

                {/* Estado: idle, sem arquivo de gravação */}
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

                {/* Estado: gravando */}
                {isRecording && (
                  <div style={{ padding: "4px 0" }}>
                    <div style={{
                      display: "inline-flex", alignItems: "center", gap: "10px",
                      background: "#FEF2F2", padding: "10px 22px",
                      borderRadius: "50px", marginBottom: "20px",
                    }}>
                      <div
                        className="pulse-dot"
                        style={{ width: 10, height: 10, borderRadius: "50%", background: "#EF4444", flexShrink: 0 }}
                      />
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
                        cursor: "pointer", fontFamily: "inherit",
                        transition: "all 0.15s",
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

            {/* ─ Preview do áudio (qualquer fonte) ─ */}
            {audioFile && !isRecording && (
              <div
                className="fade-in"
                style={{
                  marginTop: "16px", background: "#F8F9FA",
                  borderRadius: "12px", padding: "14px",
                  border: "1.5px solid #E5E7EB",
                }}
              >
                <div style={{
                  display: "flex", alignItems: "center",
                  gap: "10px", marginBottom: "10px",
                }}>
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
                    </p>
                  </div>
                  <button
                    onClick={discardAudio}
                    aria-label="Remover áudio"
                    title="Remover"
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      fontSize: "16px", color: "#9CA3AF", padding: "4px",
                      borderRadius: "6px", flexShrink: 0,
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                    onMouseLeave={(e) => (e.currentTarget.style.color = "#9CA3AF")}
                  >
                    🗑️
                  </button>
                </div>
                <audio
                  src={audioUrl}
                  controls
                  style={{ width: "100%", borderRadius: "8px", height: "38px" }}
                />
              </div>
            )}
          </Card>

          {/* ── Mensagem de erro ── */}
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

          {/* ── Botão principal de transcrição ── */}
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
              {isTranscribing ? (
                <>
                  <span className="spin" style={{ fontSize: "18px" }}>◌</span>
                  Transcrevendo...
                </>
              ) : (
                <>✨ Transcrever</>
              )}
            </button>
          )}

          {/* ── Painel de resultado ── */}
          {hasResult && (
            <Card className="fade-in" style={{ marginTop: "12px" }}>
              {/* Header do resultado */}
              <div style={{
                display: "flex", alignItems: "center",
                justifyContent: "space-between", marginBottom: "14px",
                flexWrap: "wrap", gap: "8px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "18px" }}>✅</span>
                  <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>Transcrição</h2>
                </div>
                <ActionButton
                  onClick={reset}
                  icon="↺"
                  label="Nova transcrição"
                  variant="secondary"
                />
              </div>

              {/* Texto transcrito */}
              <textarea
                readOnly
                value={transcriptionText}
                style={{
                  width: "100%", minHeight: "180px",
                  padding: "14px", borderRadius: "10px",
                  border: "1.5px solid #E5E7EB", background: "#FAFAFA",
                  fontSize: "14px", fontFamily: "'JetBrains Mono', monospace",
                  lineHeight: 1.65, resize: "vertical", color: "#2D2D2D",
                }}
              />

              {/* Botões de ação */}
              <div style={{
                display: "flex", gap: "8px", marginTop: "12px",
                flexWrap: "wrap",
              }}>
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

              {/* Aviso se não tiver SRT */}
              {!transcriptionSrt && (
                <p style={{
                  fontSize: "11px", color: "#9CA3AF",
                  marginTop: "10px", marginBottom: 0,
                }}>
                  ⓘ Arquivo .srt não disponível — a resposta não retornou timestamps.
                </p>
              )}
            </Card>
          )}

          {/* ── Rodapé informativo ── */}
          <p style={{
            textAlign: "center", fontSize: "11px",
            color: "#C4C9D4", marginTop: "28px",
          }}>
            whisper-1 · ~$0,006/min · sua chave, sua conta OpenAI
          </p>
        </main>
      </div>
    </>
  );
}
