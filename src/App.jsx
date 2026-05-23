import { useState, useRef, useCallback, useEffect } from "react";

// ─────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────
const MAX_FILE_SIZE    = 25 * 1024 * 1024;
const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const ACCEPT_ATTR      = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";
const MAX_AGE_MS       = 24 * 60 * 60 * 1000;
const DEFAULT_PASSWORD = "luluwhisper";

const STORAGE = {
  pwdHash: "mw-pwd-hash",
  apiKey:  "mw-api-key",
  session: "mw-session",
};

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
// Auth helpers
// ─────────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getStoredHash() {
  const stored = localStorage.getItem(STORAGE.pwdHash);
  if (stored) return stored;
  // Primeira vez: inicializa com hash da senha padrão
  const hash = await sha256(DEFAULT_PASSWORD);
  localStorage.setItem(STORAGE.pwdHash, hash);
  return hash;
}

async function checkPassword(input) {
  const [inputHash, storedHash] = await Promise.all([
    sha256(input),
    getStoredHash(),
  ]);
  return inputHash === storedHash;
}

async function changePassword(current, next) {
  const ok = await checkPassword(current);
  if (!ok) throw new Error("Senha atual incorreta.");
  if (next.length < 4) throw new Error("A nova senha deve ter pelo menos 4 caracteres.");
  const hash = await sha256(next);
  localStorage.setItem(STORAGE.pwdHash, hash);
}

// ─────────────────────────────────────────────
// MediaRecorder mimeType
// ─────────────────────────────────────────────
function getBestMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return (
    candidates.find((t) => {
      try { return MediaRecorder.isTypeSupported(t); }
      catch { return false; }
    }) ?? ""
  );
}

// ─────────────────────────────────────────────
// IndexedDB — gravações temporárias (24 h)
// ─────────────────────────────────────────────
const DB_NAME = "malu-whisper-db";
const STORE_NAME = "recordings";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
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
      const req = db.transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put({ blob, timestamp: Date.now() }, "latest");
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
    db.transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME).delete("latest");
  } catch {}
}

// ─────────────────────────────────────────────
// Helpers gerais
// ─────────────────────────────────────────────
function pad2(n) { return String(Math.floor(n)).padStart(2, "0"); }
function pad3(n) { return String(Math.round(n)).padStart(3, "0"); }

function toSrtTime(s) {
  return `${pad2(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)},${pad3((s % 1) * 1000)}`;
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

function countWords(text) {
  if (!text?.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

// ─────────────────────────────────────────────
// Estilos globais (injetados uma vez)
// ─────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #FBF8F4; }

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
    outline: 2.5px solid #E8836B; outline-offset: 2px;
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
    border: 2.5px dashed #D1D5DB; border-radius: 14px; padding: 28px 20px;
    text-align: center; cursor: pointer; background: #FAFAFA;
    transition: all 0.2s; user-select: none;
  }
  .drop-zone:hover, .drop-zone.dragging { border-color: #E8836B; background: #FEF3F0; }
  .drop-zone:focus { outline: 2.5px solid #E8836B; }

  .nav-pill {
    padding: 8px 20px; border-radius: 50px; border: none;
    font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; transition: all 0.18s;
  }
  .nav-pill.active   { background: #E8836B; color: white; box-shadow: 0 3px 10px rgba(232,131,107,0.35); }
  .nav-pill.inactive { background: transparent; color: #9CA3AF; }
  .nav-pill.inactive:hover { color: #E8836B; }

  a.link {
    color: #E8836B; text-decoration: none; font-weight: 700;
    border-bottom: 1.5px solid rgba(232,131,107,0.3);
    transition: border-color 0.15s;
  }
  a.link:hover { border-color: #E8836B; }
`;

// ─────────────────────────────────────────────
// Componentes reutilizáveis
// ─────────────────────────────────────────────
function Card({ children, style = {}, className = "" }) {
  return (
    <div className={className} style={{
      background: "white", borderRadius: "18px",
      padding: "20px", boxShadow: "0 2px 14px rgba(0,0,0,0.06)", ...style,
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
      <button onClick={onDismiss} aria-label="Fechar" style={{
        background: "none", border: "none", cursor: "pointer",
        color: "#B91C1C", fontSize: "18px", padding: 0, lineHeight: 1, flexShrink: 0,
      }}>×</button>
    </div>
  );
}

function SuccessBanner({ message }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "10px",
      background: "#ECFDF5", border: "1.5px solid #A7F3D0",
      borderRadius: "12px", padding: "12px 14px",
      marginTop: "12px", fontSize: "13px", color: "#047857",
      animation: "fadeIn 0.3s ease",
    }}>
      <span>✅</span>
      <span style={{ lineHeight: 1.5 }}>{message}</span>
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

function LoadingOverlay() {
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "rgba(251,248,244,0.88)",
      backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      zIndex: 1000, gap: "20px",
    }}>
      <div className="spin" style={{
        width: 52, height: 52, borderRadius: "50%",
        border: "4px solid #F3D5CC", borderTopColor: "#E8836B",
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
// Tela de Login
// ─────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [pwd,     setPwd]     = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pwd.trim()) { setError("Digite sua senha."); return; }
    setLoading(true);
    setError("");
    try {
      const ok = await checkPassword(pwd);
      if (ok) { onLogin(); }
      else    { setError("Senha incorreta. Tente novamente."); }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex",
      alignItems: "center", justifyContent: "center",
      backgroundColor: "#FBF8F4", padding: "20px",
      fontFamily: "'Nunito', 'Segoe UI', sans-serif",
    }}>
      <div className="fade-in" style={{
        width: "100%", maxWidth: "360px",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <div style={{
            width: 64, height: 64, borderRadius: "18px",
            background: "linear-gradient(135deg, #E8836B 0%, #cf6a52 100%)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: "30px", boxShadow: "0 6px 20px rgba(232,131,107,0.4)",
            marginBottom: "16px",
          }}>🎙️</div>
          <h1 style={{ margin: "0 0 4px", fontSize: "26px", fontWeight: 900, color: "#E8836B" }}>
            malu-whisper
          </h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#9CA3AF", fontWeight: 600 }}>
            Acesso restrito
          </p>
        </div>

        {/* Formulário */}
        <Card>
          <form onSubmit={handleSubmit}>
            <FieldLabel htmlFor="login-pwd">Senha de acesso</FieldLabel>
            <div style={{ position: "relative", marginBottom: "16px" }}>
              <input
                id="login-pwd"
                type={showPwd ? "text" : "password"}
                value={pwd}
                onChange={(e) => { setPwd(e.target.value); setError(""); }}
                placeholder="Digite sua senha…"
                autoFocus
                autoComplete="current-password"
                style={{
                  width: "100%", padding: "12px 44px 12px 14px",
                  borderRadius: "10px", border: `1.5px solid ${error ? "#FECACA" : "#E5E7EB"}`,
                  fontSize: "15px", fontFamily: "inherit",
                  background: "#FAFAFA", color: "#2D2D2D",
                  transition: "border-color 0.2s",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
                onBlur={(e)  => (e.target.style.borderColor = error ? "#FECACA" : "#E5E7EB")}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "Ocultar senha" : "Mostrar senha"}
                style={{
                  position: "absolute", right: "12px", top: "50%",
                  transform: "translateY(-50%)",
                  background: "none", border: "none",
                  cursor: "pointer", fontSize: "16px", padding: "2px", lineHeight: 1,
                }}
              >{showPwd ? "🙈" : "👁️"}</button>
            </div>

            {error && (
              <p style={{
                fontSize: "13px", color: "#B91C1C",
                margin: "-8px 0 14px", display: "flex", alignItems: "center", gap: "6px",
              }}>
                <span>⚠️</span>{error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%", padding: "13px",
                borderRadius: "12px", border: "none",
                background: "linear-gradient(135deg, #E8836B, #cf6a52)",
                color: "white", fontSize: "15px", fontWeight: 800,
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                boxShadow: "0 4px 14px rgba(232,131,107,0.4)",
                opacity: loading ? 0.7 : 1,
                transition: "opacity 0.2s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
              }}
            >
              {loading
                ? <><span className="spin" style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.4)", borderTopColor: "white", display: "inline-block" }} /> Verificando…</>
                : "🔓 Entrar"
              }
            </button>
          </form>
        </Card>

        <p style={{ textAlign: "center", fontSize: "11px", color: "#C4C9D4", marginTop: "20px" }}>
          Acesso exclusivo da Malu 🎀
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Aba: Instruções
// ─────────────────────────────────────────────
function InstructionsTab() {
  const [curPwd,     setCurPwd]     = useState("");
  const [newPwd,     setNewPwd]     = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdError,   setPwdError]   = useState("");
  const [pwdSuccess, setPwdSuccess] = useState(false);
  const [loading,    setLoading]    = useState(false);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPwdError(""); setPwdSuccess(false);
    if (newPwd !== confirmPwd) { setPwdError("As senhas novas não conferem."); return; }
    setLoading(true);
    try {
      await changePassword(curPwd, newPwd);
      setPwdSuccess(true);
      setCurPwd(""); setNewPwd(""); setConfirmPwd("");
      setTimeout(() => setPwdSuccess(false), 5000);
    } catch (err) {
      setPwdError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const Step = ({ n, title, children }) => (
    <div style={{ display: "flex", gap: "14px", marginBottom: "20px" }}>
      <div style={{
        flexShrink: 0, width: 28, height: 28, borderRadius: "50%",
        background: "linear-gradient(135deg, #E8836B, #cf6a52)",
        color: "white", fontSize: "13px", fontWeight: 900,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginTop: "1px", boxShadow: "0 2px 6px rgba(232,131,107,0.35)",
      }}>{n}</div>
      <div style={{ flex: 1 }}>
        <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 800, color: "#2D2D2D" }}>{title}</p>
        <div style={{ fontSize: "13px", color: "#6B7280", lineHeight: 1.6 }}>{children}</div>
      </div>
    </div>
  );

  const PwdInput = ({ id, label, value, onChange, placeholder }) => (
    <div style={{ marginBottom: "12px" }}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id} type="password" value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        style={{
          width: "100%", padding: "10px 14px",
          borderRadius: "10px", border: "1.5px solid #E5E7EB",
          fontSize: "14px", fontFamily: "inherit",
          background: "#FAFAFA", color: "#2D2D2D",
          transition: "border-color 0.2s",
        }}
        onFocus={(e) => (e.target.style.borderColor = "#E8836B")}
        onBlur={(e)  => (e.target.style.borderColor = "#E5E7EB")}
      />
    </div>
  );

  return (
    <main style={{ maxWidth: "600px", margin: "0 auto", padding: "8px 16px 64px" }}>

      {/* ── Como configurar ── */}
      <Card style={{ marginBottom: "12px" }}>
        <SectionTitle icon="🚀" title="Como configurar" />
        <p style={{ fontSize: "13px", color: "#6B7280", marginTop: 0, marginBottom: "20px", lineHeight: 1.6 }}>
          O malu-whisper usa a API de transcrição da OpenAI. Você precisa de uma conta lá
          e de alguns créditos — o custo é bem barato, cerca de{" "}
          <strong style={{ color: "#2D2D2D" }}>R$ 0,03 por minuto</strong> de áudio.
        </p>

        <Step n="1" title="Crie uma conta na OpenAI">
          Acesse{" "}
          <a href="https://platform.openai.com" target="_blank" rel="noreferrer" className="link">
            platform.openai.com
          </a>{" "}
          e crie sua conta. É separado do ChatGPT — essa é a plataforma de desenvolvedores.
        </Step>

        <Step n="2" title="Adicione créditos">
          Vá em{" "}
          <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer" className="link">
            Configurações → Billing
          </a>{" "}
          e adicione um valor inicial. <strong style={{ color: "#2D2D2D" }}>$5 USD duram muito tempo</strong>{" "}
          — são mais de 800 minutos de transcrição.
        </Step>

        <Step n="3" title="Crie sua chave API">
          Acesse{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="link">
            platform.openai.com/api-keys
          </a>
          , clique em <strong style={{ color: "#2D2D2D" }}>"Create new secret key"</strong>,
          dê um nome (ex: <em>malu-whisper</em>) e copie a chave gerada —
          ela começa com <code style={{ background: "#F3F4F6", padding: "1px 5px", borderRadius: "4px", fontSize: "12px" }}>sk-</code>.{" "}
          <strong style={{ color: "#E8836B" }}>Guarde a chave com segurança</strong>, ela só aparece uma vez.
        </Step>

        <Step n="4" title="Cole a chave no malu-whisper">
          Na aba <strong style={{ color: "#2D2D2D" }}>Transcrever</strong>, cole a chave no campo
          "Chave API da OpenAI". Ela fica salva automaticamente neste browser —
          você só precisará colar uma vez.
        </Step>

        <Step n="5" title="Transcreva!">
          Envie um arquivo de áudio ou grave direto pelo microfone,
          escolha o idioma e clique em ✨ <strong style={{ color: "#2D2D2D" }}>Transcrever</strong>.
        </Step>
      </Card>

      {/* ── Dicas de uso ── */}
      <Card style={{ marginBottom: "12px" }}>
        <SectionTitle icon="💡" title="Dicas de uso" />

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[
            ["💾", "Gravação salva por 24h", "Se a transcrição falhar por qualquer motivo (internet, saldo, etc.), seu áudio fica guardado no browser por 24 horas. Na próxima vez que abrir o site, um aviso aparece para você restaurá-lo e tentar de novo."],
            ["✏️", "Texto editável", "O resultado da transcrição pode ser editado diretamente — útil para corrigir palavras que o Whisper entendeu errado."],
            ["🎬", "Arquivo .srt", "O .srt é um arquivo de legendas com os tempos de cada fala. Você pode importar no CapCut, Premiere, DaVinci ou qualquer editor de vídeo."],
            ["🌐", "Idioma automático", "Se você não tiver certeza do idioma, escolha 'Detecção automática' — o Whisper identifica sozinho. Para português, deixar em pt-BR costuma ser mais preciso."],
            ["📁", "Formatos aceitos", "mp3, mp4, m4a, wav, webm e mpeg. O limite é 25 MB por arquivo — suficiente para cerca de 2-3 horas de áudio comprimido."],
          ].map(([icon, title, text]) => (
            <div key={title} style={{
              display: "flex", gap: "12px",
              background: "#FAFAFA", borderRadius: "10px", padding: "12px",
              border: "1px solid #F3F4F6",
            }}>
              <span style={{ fontSize: "20px", flexShrink: 0, lineHeight: 1.3 }}>{icon}</span>
              <div>
                <p style={{ margin: "0 0 3px", fontSize: "13px", fontWeight: 800, color: "#2D2D2D" }}>{title}</p>
                <p style={{ margin: 0, fontSize: "12px", color: "#6B7280", lineHeight: 1.55 }}>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Links úteis ── */}
      <Card style={{ marginBottom: "12px" }}>
        <SectionTitle icon="🔗" title="Links úteis" />
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {[
            ["platform.openai.com/api-keys", "https://platform.openai.com/api-keys", "Suas chaves API"],
            ["Billing — adicionar créditos", "https://platform.openai.com/settings/organization/billing/overview", "Adicionar saldo"],
            ["Uso e custos em tempo real", "https://platform.openai.com/usage", "Ver quanto já gastou"],
          ].map(([label, href, desc]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer" style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 14px", borderRadius: "10px",
              background: "#FAFAFA", border: "1.5px solid #E5E7EB",
              textDecoration: "none", color: "#2D2D2D",
              transition: "border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#E8836B"; e.currentTarget.style.background = "#FEF3F0"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.background = "#FAFAFA"; }}
            >
              <div>
                <p style={{ margin: "0 0 1px", fontSize: "13px", fontWeight: 700 }}>{desc}</p>
                <p style={{ margin: 0, fontSize: "11px", color: "#9CA3AF", fontFamily: "'JetBrains Mono', monospace" }}>{label}</p>
              </div>
              <span style={{ fontSize: "16px", color: "#E8836B" }}>→</span>
            </a>
          ))}
        </div>
      </Card>

      {/* ── Alterar senha ── */}
      <Card>
        <SectionTitle icon="🔐" title="Alterar senha de acesso" />
        <p style={{ fontSize: "13px", color: "#6B7280", marginTop: 0, marginBottom: "16px" }}>
          A senha padrão inicial é <code style={{ background: "#F3F4F6", padding: "2px 6px", borderRadius: "5px", fontFamily: "'JetBrains Mono', monospace" }}>luluwhisper</code>.
          Recomendamos alterar para algo pessoal.
        </p>
        <form onSubmit={handleChangePassword}>
          <PwdInput
            id="cur-pwd" label="Senha atual"
            value={curPwd} onChange={setCurPwd}
            placeholder="Senha que você usa agora"
          />
          <PwdInput
            id="new-pwd" label="Nova senha"
            value={newPwd} onChange={setNewPwd}
            placeholder="Mínimo 4 caracteres"
          />
          <PwdInput
            id="confirm-pwd" label="Confirmar nova senha"
            value={confirmPwd} onChange={setConfirmPwd}
            placeholder="Repita a nova senha"
          />

          {pwdError   && <ErrorBanner message={pwdError} onDismiss={() => setPwdError("")} />}
          {pwdSuccess && <SuccessBanner message="Senha alterada com sucesso! Use a nova senha no próximo acesso." />}

          <div style={{ marginTop: "16px" }}>
            <ActionButton
              onClick={undefined}
              icon={loading ? "⟳" : "🔑"}
              label={loading ? "Salvando…" : "Alterar senha"}
              variant="primary"
              disabled={loading || !curPwd || !newPwd || !confirmPwd}
            />
          </div>
        </form>
      </Card>
    </main>
  );
}

// ─────────────────────────────────────────────
// Conteúdo principal: Transcrever
// ─────────────────────────────────────────────
function TranscribeContent({ apiKey, setApiKey }) {
  const [showKey,  setShowKey]  = useState(false);
  const [language, setLanguage] = useState("pt");

  const [audioFile,   setAudioFile]   = useState(null);
  const [audioUrl,    setAudioUrl]    = useState(null);
  const audioUrlRef                   = useRef(null);
  const [audioSource, setAudioSource] = useState(null);
  const [activeTab,   setActiveTab]   = useState("upload");
  const [isDragging,  setIsDragging]  = useState(false);

  const [isRecording,      setIsRecording]      = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const timerRef         = useRef(null);
  const fileInputRef     = useRef(null);

  const [savedRecording, setSavedRecording] = useState(null);

  const [isTranscribing,    setIsTranscribing]    = useState(false);
  const [transcriptionText, setTranscriptionText] = useState(null);
  const [transcriptionSrt,  setTranscriptionSrt]  = useState(null);
  const [error,             setError]             = useState(null);
  const [copied,            setCopied]            = useState(false);

  useEffect(() => { audioUrlRef.current = audioUrl; }, [audioUrl]);
  useEffect(() => { loadRecordingFromDB().then((rec) => { if (rec) setSavedRecording(rec); }); }, []);

  const revokeCurrentUrl = () => { if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); };

  const restoreSavedRecording = () => {
    if (!savedRecording) return;
    const { blob } = savedRecording;
    const file = new File([blob], "gravacao-restaurada.webm", { type: blob.type });
    revokeCurrentUrl();
    const url = URL.createObjectURL(blob);
    setAudioFile(file); setAudioUrl(url); audioUrlRef.current = url;
    setAudioSource("recording"); setActiveTab("record");
    setSavedRecording(null); setError(null);
  };

  const dismissSavedRecording = () => { clearRecordingFromDB(); setSavedRecording(null); };

  const handleFile = useCallback((file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { setError("Arquivo muito grande. O limite é 25 MB."); return; }
    revokeCurrentUrl();
    const url = URL.createObjectURL(file);
    setAudioFile(file); setAudioUrl(url); audioUrlRef.current = url;
    setAudioSource("upload"); setTranscriptionText(null); setTranscriptionSrt(null); setError(null);
  }, []); // eslint-disable-line

  const handleInputChange = (e) => { handleFile(e.target.files[0]); e.target.value = ""; };
  const handleDragLeave   = (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false); };
  const handleDrop        = (e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); };

  const startRecording = async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getBestMimeType();
      if (!mimeType) {
        setError("Seu browser não suporta gravação. Tente Chrome, Firefox ou Safari.");
        stream.getTracks().forEach((t) => t.stop()); return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext  = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `gravacao.${ext}`, { type: mimeType });
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(blob);
        setAudioFile(file); setAudioUrl(url); audioUrlRef.current = url;
        setAudioSource("recording"); setTranscriptionText(null); setTranscriptionSrt(null);
        stream.getTracks().forEach((t) => t.stop());
        await saveRecordingToDB(blob); setSavedRecording(null);
      };
      recorder.start(500); mediaRecorderRef.current = recorder;
      setIsRecording(true); setRecordingSeconds(0); setError(null);
      timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);
    } catch {
      setError("Não foi possível acessar o microfone. Verifique as permissões do browser.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current.stop();
    setIsRecording(false); clearInterval(timerRef.current);
  };

  const discardAudio = () => {
    if (isRecording) stopRecording();
    revokeCurrentUrl();
    setAudioFile(null); setAudioUrl(null); audioUrlRef.current = null;
    setAudioSource(null); setRecordingSeconds(0);
    setTranscriptionText(null); setTranscriptionSrt(null);
    if (audioSource === "recording") clearRecordingFromDB();
  };

  const transcribe = async () => {
    if (!apiKey.trim()) { setError("Insira sua chave API da OpenAI antes de continuar."); return; }
    if (!audioFile)     { setError("Selecione ou grave um áudio primeiro."); return; }
    setIsTranscribing(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", audioFile); fd.append("model", "whisper-1");
      fd.append("response_format", "verbose_json");
      if (language) fd.append("language", language);
      const res = await fetch(WHISPER_ENDPOINT, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey.trim()}` }, body: fd,
      });
      if (!res.ok) {
        let msg = `Erro ${res.status} da API OpenAI.`;
        try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
        if (res.status === 401) msg = "Chave API inválida ou expirada. Verifique e tente novamente.";
        else if (res.status === 413) msg = "Arquivo muito grande. O limite é 25 MB.";
        else if (res.status === 429) msg = "Muitas requisições. Aguarde um momento e tente novamente.";
        else if (res.status === 500) msg = "Erro interno da OpenAI. Tente novamente em instantes.";
        throw new Error(msg);
      }
      const data = await res.json();
      setTranscriptionText(data.text ?? "");
      setTranscriptionSrt(data.segments?.length ? segmentsToSrt(data.segments) : null);
      if (audioSource === "recording") clearRecordingFromDB();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(transcriptionText);
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("Não foi possível copiar. Use Ctrl+A → Ctrl+C na área de texto.");
    }
  };

  const downloadTxt  = () => downloadFile(transcriptionText, makeFilename("txt"));
  const downloadSrt  = () => downloadFile(transcriptionSrt,  makeFilename("srt"));
  const downloadBoth = () => { downloadTxt(); setTimeout(downloadSrt, 300); };

  const reset = () => {
    if (isRecording) stopRecording();
    revokeCurrentUrl();
    setAudioFile(null); setAudioUrl(null); audioUrlRef.current = null;
    setAudioSource(null); setRecordingSeconds(0);
    setTranscriptionText(null); setTranscriptionSrt(null);
    setError(null); setCopied(false); clearRecordingFromDB();
  };

  const hasResult     = transcriptionText !== null;
  const canTranscribe = !!(apiKey.trim() && audioFile && !isTranscribing);

  return (
    <main style={{ maxWidth: "600px", margin: "0 auto", padding: "8px 16px 64px" }}>
      {isTranscribing && <LoadingOverlay />}

      {/* Banner: gravação salva */}
      {savedRecording && (
        <div className="fade-in" style={{
          display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
          background: "linear-gradient(135deg, #FFF7ED, #FEF3C7)",
          border: "1.5px solid #FCD34D", borderRadius: "14px",
          padding: "14px 16px", marginBottom: "12px",
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

      {/* Card 1: Configuração */}
      <Card style={{ marginBottom: "12px" }}>
        <SectionTitle icon="🔑" title="Configuração da API" />

        <FieldLabel htmlFor="api-key">Chave API da OpenAI</FieldLabel>
        <div style={{ position: "relative" }}>
          <input
            id="api-key" type={showKey ? "text" : "password"}
            value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-proj-…" autoComplete="off"
            disabled={isTranscribing}
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
          <button onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
            style={{
              position: "absolute", right: "11px", top: "50%", transform: "translateY(-50%)",
              background: "none", border: "none", cursor: "pointer", fontSize: "15px", padding: "3px", lineHeight: 1,
            }}>{showKey ? "🙈" : "👁️"}</button>
        </div>
        <p style={{ fontSize: "11px", color: "#9CA3AF", margin: "6px 0 0", lineHeight: 1.5 }}>
          Sua chave fica salva neste browser — não é enviada a nenhum outro servidor além da OpenAI.
        </p>

        <div style={{ marginTop: "16px" }}>
          <FieldLabel htmlFor="language">Idioma da transcrição</FieldLabel>
          <select id="language" value={language} onChange={(e) => setLanguage(e.target.value)}
            disabled={isTranscribing}
            style={{
              width: "100%", padding: "10px 14px", borderRadius: "10px",
              border: "1.5px solid #E5E7EB", fontSize: "14px",
              background: "#FAFAFA", color: "#2D2D2D", cursor: "pointer",
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
          <span>Modelo: <strong>whisper-1</strong> — único disponível via API OpenAI. Novos modelos aparecerão aqui conforme liberados.</span>
        </div>
      </Card>

      {/* Card 2: Áudio */}
      <Card style={{ marginBottom: "12px" }}>
        <SectionTitle icon="🎵" title="Áudio" />

        <div style={{
          display: "flex", background: "#F3F4F6", borderRadius: "11px",
          padding: "3px", marginBottom: "18px", gap: "2px",
        }}>
          {[["upload", "📁 Enviar arquivo"], ["record", "🎤 Gravar agora"]].map(([tab, label]) => (
            <button key={tab}
              onClick={() => !isTranscribing && setActiveTab(tab)}
              className={`tab-btn ${activeTab === tab ? "active" : "inactive"}`}
              style={{ opacity: isTranscribing ? 0.6 : 1 }}
            >{label}</button>
          ))}
        </div>

        {activeTab === "upload" && (
          <div>
            <div
              role="button" tabIndex={0}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={handleDragLeave}
              onClick={() => !isTranscribing && fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && !isTranscribing && fileInputRef.current?.click()}
              className={`drop-zone${isDragging ? " dragging" : ""}`}
              style={{ opacity: isTranscribing ? 0.6 : 1, cursor: isTranscribing ? "not-allowed" : "pointer" }}
              aria-label="Selecionar arquivo de áudio"
            >
              <div style={{ fontSize: "36px", marginBottom: "10px" }}>{isDragging ? "🎯" : "📂"}</div>
              <p style={{ margin: "0 0 4px", fontSize: "14px", fontWeight: 700, color: "#374151" }}>Arraste um arquivo aqui</p>
              <p style={{ margin: "0 0 14px", fontSize: "12px", color: "#9CA3AF" }}>ou clique para selecionar</p>
              <span style={{
                display: "inline-block", padding: "7px 18px", borderRadius: "9px",
                background: "linear-gradient(135deg, #E8836B, #cf6a52)",
                color: "white", fontSize: "12px", fontWeight: 700,
                boxShadow: "0 2px 8px rgba(232,131,107,0.35)",
              }}>Escolher arquivo</span>
            </div>
            <p style={{ fontSize: "11px", color: "#9CA3AF", marginTop: "8px", textAlign: "center" }}>
              Formatos aceitos: mp3 · mp4 · m4a · wav · webm · mpeg — máx 25 MB
            </p>
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleInputChange} style={{ display: "none" }} />
          </div>
        )}

        {activeTab === "record" && (
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            {!isRecording && audioFile && audioSource === "upload" && (
              <div>
                <div style={{ fontSize: "36px", marginBottom: "10px" }}>📂</div>
                <p style={{ margin: "0 0 12px", fontSize: "14px", color: "#6B7280" }}>Você já tem um arquivo selecionado.</p>
                <button onClick={() => !isTranscribing && discardAudio()} disabled={isTranscribing}
                  style={{
                    padding: "10px 22px", borderRadius: "50px",
                    border: "1.5px solid #E5E7EB", background: "white",
                    color: "#6B7280", fontSize: "13px", fontWeight: 700,
                    cursor: isTranscribing ? "not-allowed" : "pointer",
                    fontFamily: "inherit", transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { if (!isTranscribing) { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.color = "#6B7280"; }}
                >🗑️ &nbsp;Descartar e gravar novo</button>
              </div>
            )}

            {!isRecording && !audioFile && (
              <>
                <div style={{ fontSize: "48px", marginBottom: "12px" }}>🎤</div>
                <p style={{ margin: "0 0 18px", fontSize: "14px", color: "#6B7280" }}>Clique para começar a gravar</p>
                <button onClick={startRecording} style={{
                  padding: "12px 30px", borderRadius: "50px", border: "none",
                  cursor: "pointer", fontFamily: "inherit",
                  background: "linear-gradient(135deg, #E8836B, #cf6a52)",
                  color: "white", fontSize: "14px", fontWeight: 800,
                  boxShadow: "0 4px 16px rgba(232,131,107,0.45)", transition: "opacity 0.15s",
                }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >● &nbsp;Iniciar gravação</button>
              </>
            )}

            {isRecording && (
              <div style={{ padding: "4px 0" }}>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: "10px",
                  background: "#FEF2F2", padding: "10px 22px",
                  borderRadius: "50px", marginBottom: "20px",
                }}>
                  <div className="pulse-dot" style={{ width: 10, height: 10, borderRadius: "50%", background: "#EF4444", flexShrink: 0 }} />
                  <span style={{ fontSize: "15px", fontWeight: 800, color: "#EF4444", fontFamily: "'JetBrains Mono', monospace" }}>
                    {formatTime(recordingSeconds)}
                  </span>
                  <span style={{ fontSize: "12px", color: "#F87171", fontWeight: 600 }}>gravando</span>
                </div>
                <br />
                <button onClick={stopRecording} style={{
                  padding: "12px 30px", borderRadius: "50px",
                  border: "2px solid #EF4444", background: "white",
                  color: "#EF4444", fontSize: "14px", fontWeight: 800,
                  cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#FEF2F2"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "white"; }}
                >■ &nbsp;Parar gravação</button>
              </div>
            )}
          </div>
        )}

        {audioFile && !isRecording && (
          <div className="fade-in" style={{
            marginTop: "16px", background: "#F8F9FA",
            borderRadius: "12px", padding: "14px", border: "1.5px solid #E5E7EB",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
              <span style={{ fontSize: "18px", flexShrink: 0 }}>{audioSource === "recording" ? "🎙️" : "📄"}</span>
              <div style={{ flex: 1, overflow: "hidden" }}>
                <p style={{ margin: 0, fontSize: "13px", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {audioFile.name}
                </p>
                <p style={{ margin: 0, fontSize: "11px", color: "#9CA3AF" }}>
                  {formatSize(audioFile.size)}
                  {audioSource === "recording" && (
                    <span style={{ marginLeft: "8px", color: "#F59E0B", fontWeight: 700 }}>· 💾 salvo por 24h</span>
                  )}
                </p>
              </div>
              <button onClick={() => !isTranscribing && discardAudio()} disabled={isTranscribing}
                aria-label="Remover áudio" title="Remover áudio"
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

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {!hasResult && (
        <button onClick={transcribe} disabled={!canTranscribe} style={{
          width: "100%", marginTop: "12px", padding: "15px",
          borderRadius: "14px", border: "none", fontFamily: "inherit",
          background: canTranscribe ? "linear-gradient(135deg, #E8836B 0%, #cf6a52 100%)" : "#E5E7EB",
          color: canTranscribe ? "white" : "#9CA3AF",
          fontSize: "16px", fontWeight: 900,
          cursor: canTranscribe ? "pointer" : "not-allowed",
          boxShadow: canTranscribe ? "0 5px 18px rgba(232,131,107,0.42)" : "none",
          transition: "all 0.2s",
          display: "flex", alignItems: "center", justifyContent: "center", gap: "10px",
        }}
          onMouseEnter={(e) => { if (canTranscribe) e.currentTarget.style.opacity = "0.88"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >✨ Transcrever</button>
      )}

      {hasResult && (
        <Card className="fade-in" style={{ marginTop: "12px" }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginBottom: "14px", flexWrap: "wrap", gap: "8px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "18px" }}>✅</span>
              <h2 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>Transcrição</h2>
            </div>
            <ActionButton onClick={reset} icon="↺" label="Nova transcrição" variant="secondary" />
          </div>

          <textarea
            value={transcriptionText}
            onChange={(e) => setTranscriptionText(e.target.value)}
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
          <div style={{
            display: "flex", justifyContent: "flex-end", gap: "12px",
            marginTop: "6px", fontSize: "11px", color: "#9CA3AF",
          }}>
            <span>{countWords(transcriptionText)} palavras</span>
            <span>{transcriptionText?.length ?? 0} caracteres</span>
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
            <ActionButton onClick={copyText} icon={copied ? "✅" : "📋"} label={copied ? "Copiado!" : "Copiar texto"} variant={copied ? "success" : "secondary"} />
            <ActionButton onClick={downloadTxt} icon="📄" label="Baixar .txt" variant="secondary" />
            {transcriptionSrt && <ActionButton onClick={downloadSrt} icon="🎬" label="Baixar .srt" variant="secondary" />}
            {transcriptionSrt && <ActionButton onClick={downloadBoth} icon="⬇️" label="Baixar ambos" variant="primary" />}
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
  );
}

// ─────────────────────────────────────────────
// App — raiz (login + nav + roteamento)
// ─────────────────────────────────────────────
export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    () => sessionStorage.getItem(STORAGE.session) === "ok"
  );
  const [activeNav, setActiveNav] = useState("app");
  const [apiKey, setApiKey] = useState("");

  // Carregar chave API do localStorage após login
  useEffect(() => {
    if (!isLoggedIn) return;
    const saved = localStorage.getItem(STORAGE.apiKey);
    if (saved) setApiKey(saved);
  }, [isLoggedIn]);

  // Salvar chave API no localStorage sempre que mudar
  useEffect(() => {
    if (!isLoggedIn) return;
    if (apiKey) localStorage.setItem(STORAGE.apiKey, apiKey);
  }, [apiKey, isLoggedIn]);

  const handleLogin = () => {
    sessionStorage.setItem(STORAGE.session, "ok");
    setIsLoggedIn(true);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(STORAGE.session);
    setIsLoggedIn(false);
    setApiKey("");
    setActiveNav("app");
  };

  if (!isLoggedIn) return (
    <>
      <style>{GLOBAL_CSS}</style>
      <LoginScreen onLogin={handleLogin} />
    </>
  );

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      <div style={{
        backgroundColor: "#FBF8F4", minHeight: "100vh",
        fontFamily: "'Nunito', 'Segoe UI', sans-serif", color: "#2D2D2D",
      }}>
        {/* Header */}
        <header style={{ padding: "20px 20px 0", borderBottom: "1px solid #F0EDE8" }}>
          <div style={{
            maxWidth: "600px", margin: "0 auto",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            paddingBottom: "16px",
          }}>
            {/* Logo */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{
                width: 38, height: 38, borderRadius: "10px",
                background: "linear-gradient(135deg, #E8836B 0%, #cf6a52 100%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "18px", boxShadow: "0 3px 10px rgba(232,131,107,0.4)",
                flexShrink: 0,
              }}>🎙️</div>
              <div>
                <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 900, color: "#E8836B", lineHeight: 1.1 }}>
                  malu-whisper
                </h1>
                <p style={{ margin: 0, fontSize: "10px", color: "#6B8E9B", fontWeight: 600 }}>
                  transcrição de áudio com IA
                </p>
              </div>
            </div>

            {/* Nav pills + logout */}
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <button onClick={() => setActiveNav("app")}       className={`nav-pill ${activeNav === "app"          ? "active" : "inactive"}`}>🎙️ Transcrever</button>
              <button onClick={() => setActiveNav("instrucoes")} className={`nav-pill ${activeNav === "instrucoes"   ? "active" : "inactive"}`}>📖 Instruções</button>
              <button
                onClick={handleLogout}
                title="Sair"
                aria-label="Sair"
                style={{
                  marginLeft: "4px",
                  padding: "8px 10px", borderRadius: "50px",
                  border: "1.5px solid #E5E7EB", background: "white",
                  color: "#9CA3AF", fontSize: "14px",
                  cursor: "pointer", transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#EF4444"; e.currentTarget.style.color = "#EF4444"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.color = "#9CA3AF"; }}
              >🚪</button>
            </div>
          </div>
        </header>

        {/* Conteúdo */}
        {activeNav === "app"
          ? <TranscribeContent apiKey={apiKey} setApiKey={setApiKey} />
          : <InstructionsTab />
        }
      </div>
    </>
  );
}
