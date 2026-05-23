import { useState, useRef, useCallback, useEffect } from "react";

// ══════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════
const MAX_FILE_SIZE     = 25 * 1024 * 1024;
const WHISPER_ENDPOINT  = "https://api.openai.com/v1/audio/transcriptions";
const ACCEPT_ATTR       = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";
const MAX_AGE_MS        = 24 * 60 * 60 * 1000;
const DEFAULT_PASSWORD  = "luluwhisper";
const DEFAULT_USERNAMES = ["humberto", "malu"];
const USD_TO_BRL        = 5.85;

const STORAGE = { users: "mw-users", session: "mw-session" };

const MODELS = [
  { id: "whisper-1",              name: "Whisper-1",          usdPerMin: 0.006, note: "Clássico e confiável",     badge: "padrão",    badgeColor: "#6B7280" },
  { id: "gpt-4o-mini-transcribe", name: "GPT-4o Mini",        usdPerMin: 0.003, note: "2× mais barato, rápido",  badge: "econômico", badgeColor: "#059669" },
  { id: "gpt-4o-transcribe",      name: "GPT-4o Transcribe",  usdPerMin: 0.006, note: "Maior precisão",          badge: "preciso",   badgeColor: "#7C3AED" },
];

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

const CONVERTER_FORMATS = [
  { id: "mp3",  label: "MP3",  mime: "audio/mpeg", note: "universal" },
  { id: "wav",  label: "WAV",  mime: "audio/wav",  note: "sem perda" },
  { id: "m4a",  label: "M4A",  mime: "audio/mp4",  note: "Apple/iOS" },
  { id: "ogg",  label: "OGG",  mime: "audio/ogg",  note: "open" },
  { id: "webm", label: "WebM", mime: "audio/webm", note: "web" },
];

// ══════════════════════════════════════════════
// AUTH — MULTI-USUÁRIO
// ══════════════════════════════════════════════
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function initUsers() {
  if (localStorage.getItem(STORAGE.users)) return;
  const hash = await sha256(DEFAULT_PASSWORD);
  const users = {};
  for (const name of DEFAULT_USERNAMES)
    users[name] = { pwdHash: hash, apiKey: "", model: "whisper-1" };
  localStorage.setItem(STORAGE.users, JSON.stringify(users));
}

function getUsers() { return JSON.parse(localStorage.getItem(STORAGE.users) || "{}"); }
function saveUsers(u) { localStorage.setItem(STORAGE.users, JSON.stringify(u)); }

async function checkLogin(username, password) {
  const users = getUsers();
  if (!users[username]) return false;
  return (await sha256(password)) === users[username].pwdHash;
}

async function changeUserPassword(username, currentPwd, newPwd) {
  if (!(await checkLogin(username, currentPwd))) throw new Error("Senha atual incorreta.");
  if (newPwd.length < 4) throw new Error("A nova senha deve ter pelo menos 4 caracteres.");
  const users = getUsers();
  users[username].pwdHash = await sha256(newPwd);
  saveUsers(users);
}

function getUserData(username) {
  return getUsers()[username] || { apiKey: "", model: "whisper-1" };
}

function persistUserApiKey(username, apiKey) {
  const u = getUsers();
  if (u[username]) { u[username].apiKey = apiKey; saveUsers(u); }
}

function persistUserModel(username, model) {
  const u = getUsers();
  if (u[username]) { u[username].model = model; saveUsers(u); }
}

function getUserHistory(username) {
  return getUsers()[username]?.history || [];
}

function addUsageRecord(username, { modelId, durationMin, costUSD, costBRL }) {
  const u = getUsers();
  if (!u[username]) return;
  if (!u[username].history) u[username].history = [];
  u[username].history.unshift({ ts: Date.now(), modelId, durationMin, costUSD, costBRL });
  if (u[username].history.length > 500) u[username].history = u[username].history.slice(0, 500);
  saveUsers(u);
}

function getTotalSpent(username) {
  const history = getUserHistory(username);
  const totalUSD = history.reduce((sum, r) => sum + (r.costUSD || 0), 0);
  const totalBRL = history.reduce((sum, r) => sum + (r.costBRL || 0), 0);
  const lastTs   = history.length ? history[0].ts : null;
  return { totalUSD, totalBRL, count: history.length, lastTs };
}

function clearUserHistory(username) {
  const u = getUsers();
  if (u[username]) { u[username].history = []; saveUsers(u); }
}

// ══════════════════════════════════════════════
// MediaRecorder
// ══════════════════════════════════════════════
function getBestMimeType() {
  const c = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg;codecs=opus","audio/ogg"];
  return c.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) ?? "";
}

// ══════════════════════════════════════════════
// IndexedDB
// ══════════════════════════════════════════════
const DB_NAME = "malu-whisper-db", STORE_NAME = "recordings";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveRecordingToDB(blob) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const req = db.transaction(STORE_NAME,"readwrite").objectStore(STORE_NAME)
        .put({ blob, timestamp: Date.now() }, "latest");
      req.onsuccess = res; req.onerror = e => rej(e.target.error);
    });
  } catch (err) { console.warn("[malu-whisper] IndexedDB save failed:", err); }
}

async function loadRecordingFromDB() {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const req = db.transaction(STORE_NAME,"readonly").objectStore(STORE_NAME).get("latest");
      req.onsuccess = e => {
        const rec = e.target.result;
        if (!rec) { resolve(null); return; }
        if (Date.now() - rec.timestamp > MAX_AGE_MS) { clearRecordingFromDB(); resolve(null); return; }
        resolve(rec);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function clearRecordingFromDB() {
  try {
    const db = await openDB();
    db.transaction(STORE_NAME,"readwrite").objectStore(STORE_NAME).delete("latest");
  } catch {}
}

// ══════════════════════════════════════════════
// HELPERS GERAIS
// ══════════════════════════════════════════════
function pad2(n)  { return String(Math.floor(n)).padStart(2,"0"); }
function pad3(n)  { return String(Math.round(n)).padStart(3,"0"); }

function toSrtTime(s) {
  return `${pad2(s/3600)}:${pad2((s%3600)/60)}:${pad2(s%60)},${pad3((s%1)*1000)}`;
}

function segmentsToSrt(segs) {
  return segs.map((s,i) => `${i+1}\n${toSrtTime(s.start)} --> ${toSrtTime(s.end)}\n${s.text.trim()}`).join("\n\n") + "\n";
}

function makeFilename(ext) {
  const now = new Date();
  const ts = `${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `transcricao_${ts}.${ext}`;
}

function downloadFile(content, filename, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function formatTime(secs) { return `${pad2(Math.floor(secs/60))}:${pad2(secs%60)}`; }

function timeAgo(ts) {
  const mins = Math.floor((Date.now()-ts)/60000);
  if (mins < 1) return "menos de 1 minuto atrás";
  if (mins < 60) return `${mins} min atrás`;
  const hrs = Math.floor(mins/60);
  return hrs < 24 ? `${hrs}h atrás` : "mais de 1 dia atrás";
}

function countWords(text) {
  if (!text?.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function brlPerMin(usdPerMin) {
  return (usdPerMin * USD_TO_BRL).toFixed(3).replace(".", ",");
}

function brlPerHour(usdPerMin) {
  return (usdPerMin * 60 * USD_TO_BRL).toFixed(2).replace(".", ",");
}

function getAudioDuration(file) {
  return new Promise(resolve => {
    const audio = new Audio();
    const url   = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(audio.duration); };
    audio.onerror          = () => { URL.revokeObjectURL(url); resolve(null); };
    audio.src = url;
  });
}

function estimatePrice(durationSec, modelObj) {
  if (!durationSec || durationSec <= 0 || !modelObj) return null;
  const mins    = durationSec / 60;
  const costUSD = mins * modelObj.usdPerMin;
  const costBRL = costUSD * USD_TO_BRL;
  return { mins, costUSD, costBRL };
}

// ══════════════════════════════════════════════
// CSS GLOBAL
// ══════════════════════════════════════════════
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; background: #FBF8F4; }

  .fade-in { animation: fadeIn 0.35s ease; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

  .pulse-dot { animation: pulseDot 1.3s ease-in-out infinite; }
  @keyframes pulseDot { 0%,100% { transform:scale(1); opacity:1; } 50% { transform:scale(1.4); opacity:0.55; } }

  .spin { animation: spin 0.85s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }

  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2.5px solid #E8836B; outline-offset: 2px;
  }

  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-thumb { background: #DDD; border-radius: 4px; }

  .tab-btn {
    flex:1; padding:9px 8px; border-radius:9px; border:none;
    cursor:pointer; font-size:13px; font-weight:700;
    font-family:inherit; transition:all 0.18s;
  }
  .tab-btn.active   { background:white; color:#E8836B; box-shadow:0 1px 5px rgba(0,0,0,0.1); }
  .tab-btn.inactive { background:transparent; color:#9CA3AF; }
  .tab-btn.inactive:hover { color:#6B7280; }

  .drop-zone {
    border:2.5px dashed #D1D5DB; border-radius:14px; padding:28px 20px;
    text-align:center; cursor:pointer; background:#FAFAFA;
    transition:all 0.2s; user-select:none;
  }
  .drop-zone:hover, .drop-zone.dragging { border-color:#E8836B; background:#FEF3F0; }
  .drop-zone:focus { outline:2.5px solid #E8836B; }

  .nav-pill {
    padding:7px 13px; border-radius:50px; border:none;
    font-size:12px; font-weight:700; font-family:inherit;
    cursor:pointer; transition:all 0.18s; white-space:nowrap;
  }
  .nav-pill.active   { background:#E8836B; color:white; box-shadow:0 3px 10px rgba(232,131,107,0.35); }
  .nav-pill.inactive { background:transparent; color:#9CA3AF; }
  .nav-pill.inactive:hover { color:#E8836B; }

  .model-card {
    border:2px solid #E5E7EB; border-radius:12px; padding:13px;
    cursor:pointer; transition:all 0.18s; background:white;
    display:flex; align-items:flex-start; gap:10px;
  }
  .model-card:hover   { border-color:#E8836B; background:#FEF3F0; }
  .model-card.selected { border-color:#E8836B; background:#FEF3F0; }

  a.link {
    color:#E8836B; text-decoration:none; font-weight:700;
    border-bottom:1.5px solid rgba(232,131,107,0.3); transition:border-color 0.15s;
  }
  a.link:hover { border-color:#E8836B; }
`;

// ══════════════════════════════════════════════
// COMPONENTES COMPARTILHADOS
// ══════════════════════════════════════════════
function Card({ children, style={}, className="" }) {
  return (
    <div className={className} style={{
      background:"white", borderRadius:"18px",
      padding:"20px", boxShadow:"0 2px 14px rgba(0,0,0,0.06)", ...style,
    }}>{children}</div>
  );
}

function SectionTitle({ icon, title }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"16px" }}>
      <span style={{ fontSize:"17px" }}>{icon}</span>
      <h2 style={{ fontSize:"15px", fontWeight:700, margin:0, color:"#2D2D2D" }}>{title}</h2>
    </div>
  );
}

function FieldLabel({ htmlFor, children }) {
  return (
    <label htmlFor={htmlFor} style={{
      display:"block", fontSize:"12px", fontWeight:700,
      marginBottom:"6px", color:"#6B7280",
      textTransform:"uppercase", letterSpacing:"0.04em",
    }}>{children}</label>
  );
}

function StyledInput({ id, type="text", value, onChange, placeholder, disabled, monospace, autoComplete, autoFocus }) {
  return (
    <input
      id={id} type={type} value={value} onChange={onChange}
      placeholder={placeholder} disabled={disabled}
      autoComplete={autoComplete} autoFocus={autoFocus}
      style={{
        width:"100%", padding:"10px 14px",
        borderRadius:"10px", border:"1.5px solid #E5E7EB",
        fontSize:"13px", fontFamily: monospace ? "'JetBrains Mono', monospace" : "inherit",
        background:"#FAFAFA", color:"#2D2D2D",
        transition:"border-color 0.2s",
        opacity: disabled ? 0.6 : 1,
      }}
      onFocus={e => e.target.style.borderColor = "#E8836B"}
      onBlur={e => e.target.style.borderColor = "#E5E7EB"}
    />
  );
}

function ErrorBanner({ message, onDismiss }) {
  return (
    <div style={{
      display:"flex", alignItems:"flex-start", gap:"10px",
      background:"#FEF2F2", border:"1.5px solid #FECACA",
      borderRadius:"12px", padding:"12px 14px",
      marginTop:"12px", fontSize:"13px", color:"#B91C1C",
      animation:"fadeIn 0.3s ease",
    }}>
      <span style={{ flexShrink:0 }}>⚠️</span>
      <span style={{ flex:1, lineHeight:1.5 }}>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} style={{
          background:"none", border:"none", cursor:"pointer",
          color:"#B91C1C", fontSize:"18px", padding:0, lineHeight:1, flexShrink:0,
        }}>×</button>
      )}
    </div>
  );
}

function SuccessBanner({ message }) {
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:"10px",
      background:"#ECFDF5", border:"1.5px solid #A7F3D0",
      borderRadius:"12px", padding:"12px 14px",
      marginTop:"12px", fontSize:"13px", color:"#047857",
      animation:"fadeIn 0.3s ease",
    }}>
      <span>✅</span>
      <span style={{ lineHeight:1.5 }}>{message}</span>
    </div>
  );
}

function ActionButton({ onClick, icon, label, variant="secondary", disabled=false, type="button" }) {
  const base = {
    display:"inline-flex", alignItems:"center", gap:"6px",
    padding:"9px 16px", borderRadius:"9px",
    fontSize:"13px", fontWeight:700,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily:"inherit", transition:"opacity 0.15s, transform 0.1s",
    opacity: disabled ? 0.5 : 1, border:"none",
  };
  const v = {
    primary:   { background:"linear-gradient(135deg,#E8836B,#cf6a52)", color:"white", border:"none", boxShadow:"0 3px 10px rgba(232,131,107,0.35)" },
    secondary: { background:"white", color:"#374151", border:"1.5px solid #E5E7EB" },
    success:   { background:"#ECFDF5", color:"#047857", border:"1.5px solid #A7F3D0" },
    danger:    { background:"#FEF2F2", color:"#B91C1C", border:"1.5px solid #FECACA" },
  };
  return (
    <button type={type} onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{ ...base, ...v[variant] }}
      onMouseEnter={e => { if(!disabled) e.currentTarget.style.opacity="0.82"; }}
      onMouseLeave={e => { e.currentTarget.style.opacity=disabled?"0.5":"1"; }}
      onMouseDown={e  => { if(!disabled) e.currentTarget.style.transform="scale(0.97)"; }}
      onMouseUp={e    => { e.currentTarget.style.transform="scale(1)"; }}
    ><span>{icon}</span>{label}</button>
  );
}

function LoadingOverlay({ label="Transcrevendo…" }) {
  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(251,248,244,0.88)",
      backdropFilter:"blur(5px)", WebkitBackdropFilter:"blur(5px)",
      display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      zIndex:1000, gap:"20px",
    }}>
      <div className="spin" style={{
        width:52, height:52, borderRadius:"50%",
        border:"4px solid #F3D5CC", borderTopColor:"#E8836B",
      }} />
      <div style={{ textAlign:"center" }}>
        <p style={{ margin:"0 0 4px", fontSize:"16px", fontWeight:800, color:"#E8836B" }}>{label}</p>
        <p style={{ margin:0, fontSize:"12px", color:"#9CA3AF" }}>
          Isso pode levar alguns segundos
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// TELA DE LOGIN
// ══════════════════════════════════════════════
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState(DEFAULT_USERNAMES[0]);
  const [pwd,      setPwd]      = useState("");
  const [showPwd,  setShowPwd]  = useState(false);
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!pwd.trim()) { setError("Digite sua senha."); return; }
    setLoading(true); setError("");
    try {
      const ok = await checkLogin(username, pwd);
      if (ok) onLogin(username);
      else    setError("Senha incorreta. Tente novamente.");
    } finally { setLoading(false); }
  };

  return (
    <div style={{
      minHeight:"100vh", display:"flex",
      alignItems:"center", justifyContent:"center",
      backgroundColor:"#FBF8F4", padding:"20px",
      fontFamily:"'Nunito','Segoe UI',sans-serif",
    }}>
      <div className="fade-in" style={{ width:"100%", maxWidth:"360px" }}>
        <div style={{ textAlign:"center", marginBottom:"32px" }}>
          <div style={{
            width:64, height:64, borderRadius:"18px",
            background:"linear-gradient(135deg,#E8836B 0%,#cf6a52 100%)",
            display:"inline-flex", alignItems:"center", justifyContent:"center",
            fontSize:"30px", boxShadow:"0 6px 20px rgba(232,131,107,0.4)", marginBottom:"16px",
          }}>🎙️</div>
          <h1 style={{ margin:"0 0 4px", fontSize:"26px", fontWeight:900, color:"#E8836B" }}>
            malu-whisper
          </h1>
          <p style={{ margin:0, fontSize:"13px", color:"#9CA3AF", fontWeight:600 }}>Acesso restrito</p>
        </div>

        <Card>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom:"14px" }}>
              <FieldLabel htmlFor="login-user">Usuário</FieldLabel>
              <select id="login-user" value={username} onChange={e => { setUsername(e.target.value); setError(""); }}
                style={{
                  width:"100%", padding:"10px 14px", borderRadius:"10px",
                  border:"1.5px solid #E5E7EB", fontSize:"14px",
                  background:"#FAFAFA", color:"#2D2D2D", cursor:"pointer",
                  fontFamily:"inherit", transition:"border-color 0.2s",
                }}
                onFocus={e => e.target.style.borderColor="#E8836B"}
                onBlur={e  => e.target.style.borderColor="#E5E7EB"}
              >
                {DEFAULT_USERNAMES.map(n => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>

            <FieldLabel htmlFor="login-pwd">Senha</FieldLabel>
            <div style={{ position:"relative", marginBottom:"16px" }}>
              <input
                id="login-pwd" type={showPwd ? "text" : "password"}
                value={pwd}
                onChange={e => { setPwd(e.target.value); setError(""); }}
                placeholder="Digite sua senha…"
                autoFocus autoComplete="current-password"
                style={{
                  width:"100%", padding:"12px 44px 12px 14px",
                  borderRadius:"10px", border:`1.5px solid ${error ? "#FECACA" : "#E5E7EB"}`,
                  fontSize:"15px", fontFamily:"inherit",
                  background:"#FAFAFA", color:"#2D2D2D", transition:"border-color 0.2s",
                }}
                onFocus={e => e.target.style.borderColor="#E8836B"}
                onBlur={e  => e.target.style.borderColor=error ? "#FECACA" : "#E5E7EB"}
              />
              <button type="button" onClick={() => setShowPwd(v => !v)}
                style={{
                  position:"absolute", right:"12px", top:"50%", transform:"translateY(-50%)",
                  background:"none", border:"none", cursor:"pointer", fontSize:"16px", padding:"2px", lineHeight:1,
                }}>{showPwd ? "🙈" : "👁️"}</button>
            </div>

            {error && (
              <p style={{ fontSize:"13px", color:"#B91C1C", margin:"-8px 0 14px", display:"flex", alignItems:"center", gap:"6px" }}>
                <span>⚠️</span>{error}
              </p>
            )}

            <button type="submit" disabled={loading} style={{
              width:"100%", padding:"13px", borderRadius:"12px", border:"none",
              background:"linear-gradient(135deg,#E8836B,#cf6a52)",
              color:"white", fontSize:"15px", fontWeight:800,
              cursor: loading ? "not-allowed" : "pointer",
              fontFamily:"inherit", boxShadow:"0 4px 14px rgba(232,131,107,0.4)",
              opacity: loading ? 0.7 : 1, transition:"opacity 0.2s",
              display:"flex", alignItems:"center", justifyContent:"center", gap:"8px",
            }}>
              {loading
                ? <><span className="spin" style={{ width:16, height:16, borderRadius:"50%", border:"2px solid rgba(255,255,255,0.4)", borderTopColor:"white", display:"inline-block" }} /> Verificando…</>
                : "🔓 Entrar"
              }
            </button>
          </form>
        </Card>

        <p style={{ textAlign:"center", fontSize:"11px", color:"#C4C9D4", marginTop:"20px" }}>
          Acesso exclusivo 🎀
        </p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// ABA: CONFIGURAÇÕES
// ══════════════════════════════════════════════

// Definido FORA do SettingsTab para evitar re-criação a cada render (que causava perda de foco)
function PwdInput({ id, label, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom:"12px" }}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input id={id} type="password" value={value}
        onChange={e => onChange(e.target.value)} placeholder={placeholder}
        autoComplete="off"
        style={{
          width:"100%", padding:"10px 14px", borderRadius:"10px",
          border:"1.5px solid #E5E7EB", fontSize:"14px",
          fontFamily:"inherit", background:"#FAFAFA", color:"#2D2D2D",
          transition:"border-color 0.2s",
        }}
        onFocus={e => e.target.style.borderColor="#E8836B"}
        onBlur={e  => e.target.style.borderColor="#E5E7EB"}
      />
    </div>
  );
}

function SettingsTab({ username, apiKey, setApiKey, model, setModel }) {
  const [showKey,    setShowKey]    = useState(false);
  const [curPwd,     setCurPwd]     = useState("");
  const [newPwd,     setNewPwd]     = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [pwdError,   setPwdError]   = useState("");
  const [pwdSuccess, setPwdSuccess] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [spendStats, setSpendStats] = useState(() => getTotalSpent(username));
  const [clearConfirm, setClearConfirm] = useState(false);

  const refreshStats = () => setSpendStats(getTotalSpent(username));

  const handleClearHistory = () => {
    if (!clearConfirm) { setClearConfirm(true); setTimeout(() => setClearConfirm(false), 4000); return; }
    clearUserHistory(username);
    refreshStats();
    setClearConfirm(false);
  };

  const handleChangePassword = async e => {
    e.preventDefault();
    setPwdError(""); setPwdSuccess(false);
    if (newPwd !== confirmPwd) { setPwdError("As senhas novas não conferem."); return; }
    setPwdLoading(true);
    try {
      await changeUserPassword(username, curPwd, newPwd);
      setPwdSuccess(true);
      setCurPwd(""); setNewPwd(""); setConfirmPwd("");
      setTimeout(() => setPwdSuccess(false), 5000);
    } catch (err) {
      setPwdError(err.message);
    } finally { setPwdLoading(false); }
  };

  return (
    <main style={{ maxWidth:"600px", margin:"0 auto", padding:"8px 16px 64px" }}>

      {/* Conta atual */}
      <div style={{
        display:"inline-flex", alignItems:"center", gap:"8px",
        background:"#F0F9FF", border:"1px solid #BAE6FD",
        borderRadius:"50px", padding:"6px 14px", marginBottom:"16px",
        fontSize:"13px", color:"#0369A1", fontWeight:700,
      }}>
        <span>👤</span> Conta: <strong>{username}</strong>
      </div>

      {/* Chave API */}
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🔑" title="Chave API da OpenAI" />
        <p style={{ fontSize:"13px", color:"#6B7280", margin:"0 0 14px", lineHeight:1.5 }}>
          Sua chave fica salva <strong>só nesta conta</strong> — ninguém mais acessa.
          Não é enviada a nenhum servidor além da OpenAI.
        </p>
        <div style={{ position:"relative" }}>
          <input
            id="api-key" type={showKey ? "text" : "password"}
            value={apiKey} onChange={e => setApiKey(e.target.value)}
            placeholder="sk-proj-…" autoComplete="off"
            style={{
              width:"100%", padding:"10px 44px 10px 14px",
              borderRadius:"10px", border:"1.5px solid #E5E7EB",
              fontSize:"13px", fontFamily:"'JetBrains Mono',monospace",
              background:"#FAFAFA", color:"#2D2D2D", transition:"border-color 0.2s",
            }}
            onFocus={e => e.target.style.borderColor="#E8836B"}
            onBlur={e  => e.target.style.borderColor="#E5E7EB"}
          />
          <button onClick={() => setShowKey(v=>!v)}
            aria-label={showKey ? "Ocultar" : "Mostrar"}
            style={{
              position:"absolute", right:"11px", top:"50%", transform:"translateY(-50%)",
              background:"none", border:"none", cursor:"pointer", fontSize:"15px", padding:"3px", lineHeight:1,
            }}>{showKey ? "🙈" : "👁️"}</button>
        </div>
        {apiKey && (
          <p style={{ fontSize:"11px", color:"#059669", marginTop:"6px" }}>
            ✅ Chave salva automaticamente nesta conta.
          </p>
        )}
      </Card>

      {/* Modelo */}
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🤖" title="Modelo de transcrição" />
        <p style={{ fontSize:"13px", color:"#6B7280", margin:"0 0 14px", lineHeight:1.5 }}>
          Todos usam o mesmo endpoint da OpenAI. O preço é por minuto de áudio transcrito.
        </p>
        <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
          {MODELS.map(m => (
            <div key={m.id}
              className={`model-card${model === m.id ? " selected" : ""}`}
              onClick={() => setModel(m.id)}
            >
              <div style={{
                marginTop:"2px", width:18, height:18, borderRadius:"50%",
                border:`2px solid ${model===m.id ? "#E8836B" : "#D1D5DB"}`,
                display:"flex", alignItems:"center", justifyContent:"center",
                flexShrink:0, transition:"border-color 0.15s",
              }}>
                {model === m.id && (
                  <div style={{ width:9, height:9, borderRadius:"50%", background:"#E8836B" }} />
                )}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"3px", flexWrap:"wrap" }}>
                  <span style={{ fontSize:"14px", fontWeight:800, color:"#2D2D2D" }}>{m.name}</span>
                  <span style={{
                    fontSize:"10px", fontWeight:700, padding:"2px 7px",
                    borderRadius:"50px", background:`${m.badgeColor}18`,
                    color:m.badgeColor, border:`1px solid ${m.badgeColor}40`,
                  }}>{m.badge}</span>
                </div>
                <p style={{ margin:"0 0 6px", fontSize:"12px", color:"#6B7280" }}>{m.note}</p>
                <div style={{ display:"flex", gap:"14px" }}>
                  <span style={{ fontSize:"12px", fontWeight:700, color:"#2D2D2D" }}>
                    R$ {brlPerMin(m.usdPerMin)}/min
                  </span>
                  <span style={{ fontSize:"12px", color:"#9CA3AF" }}>
                    ≈ R$ {brlPerHour(m.usdPerMin)}/hora
                  </span>
                  <span style={{ fontSize:"12px", color:"#9CA3AF" }}>
                    US$ {m.usdPerMin.toFixed(3)}/min
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <p style={{ fontSize:"11px", color:"#9CA3AF", marginTop:"10px", marginBottom:0 }}>
          * Preços aproximados. Consulte{" "}
          <a href="https://openai.com/api/pricing" target="_blank" rel="noreferrer" className="link">
            openai.com/api/pricing
          </a>{" "}
          para valores atualizados. Câmbio estimado R$ {USD_TO_BRL.toFixed(2)}/USD.
        </p>
      </Card>

      {/* Alterar senha */}
      <Card>
        <SectionTitle icon="🔐" title="Alterar senha" />
        <p style={{ fontSize:"13px", color:"#6B7280", marginTop:0, marginBottom:"16px" }}>
          Altera apenas a senha da conta <strong>{username}</strong>.
          A senha padrão inicial é{" "}
          <code style={{ background:"#F3F4F6", padding:"2px 6px", borderRadius:"5px", fontFamily:"'JetBrains Mono',monospace" }}>
            luluwhisper
          </code>.
        </p>
        <form onSubmit={handleChangePassword}>
          <PwdInput id="cur-pwd" label="Senha atual" value={curPwd} onChange={setCurPwd} placeholder="Senha atual" />
          <PwdInput id="new-pwd" label="Nova senha"  value={newPwd} onChange={setNewPwd} placeholder="Mínimo 4 caracteres" />
          <PwdInput id="conf-pwd" label="Confirmar nova senha" value={confirmPwd} onChange={setConfirmPwd} placeholder="Repita a nova senha" />

          {pwdError   && <ErrorBanner message={pwdError} onDismiss={() => setPwdError("")} />}
          {pwdSuccess && <SuccessBanner message="Senha alterada com sucesso!" />}

          <div style={{ marginTop:"16px" }}>
            <ActionButton
              type="submit" onClick={undefined}
              icon={pwdLoading ? "⟳" : "🔑"}
              label={pwdLoading ? "Salvando…" : "Alterar senha"}
              variant="primary"
              disabled={pwdLoading || !curPwd || !newPwd || !confirmPwd}
            />
          </div>
        </form>
      </Card>

      {/* Gastos acumulados */}
      <Card style={{ marginTop:"12px" }}>
        <SectionTitle icon="💸" title="Gastos acumulados" />
        <p style={{ fontSize:"13px", color:"#6B7280", margin:"0 0 14px", lineHeight:1.5 }}>
          Total gasto pela conta <strong>{username}</strong> em transcrições neste dispositivo.
        </p>

        {spendStats.count === 0 ? (
          <div style={{
            textAlign:"center", padding:"24px 0",
            color:"#9CA3AF", fontSize:"13px",
          }}>
            <div style={{ fontSize:"36px", marginBottom:"8px" }}>🪙</div>
            Nenhuma transcrição registrada ainda.
          </div>
        ) : (
          <>
            <div style={{
              display:"grid", gridTemplateColumns:"1fr 1fr 1fr",
              gap:"8px", marginBottom:"14px",
            }}>
              {[
                { label:"Total em R$", value:`R$ ${spendStats.totalBRL.toFixed(2).replace(".",",")}`, icon:"🇧🇷" },
                { label:"Total em USD", value:`US$ ${spendStats.totalUSD.toFixed(4)}`, icon:"🇺🇸" },
                { label:"Transcrições", value:`${spendStats.count}`, icon:"🎙️" },
              ].map(({ label, value, icon }) => (
                <div key={label} style={{
                  background:"#F8F9FA", borderRadius:"10px",
                  padding:"12px 10px", textAlign:"center",
                  border:"1px solid #E5E7EB",
                }}>
                  <div style={{ fontSize:"20px", marginBottom:"4px" }}>{icon}</div>
                  <p style={{ margin:"0 0 2px", fontSize:"15px", fontWeight:900, color:"#2D2D2D" }}>{value}</p>
                  <p style={{ margin:0, fontSize:"10px", color:"#9CA3AF", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.04em" }}>{label}</p>
                </div>
              ))}
            </div>

            {spendStats.lastTs && (
              <p style={{ fontSize:"11px", color:"#9CA3AF", margin:"0 0 14px" }}>
                Última transcrição: {timeAgo(spendStats.lastTs)}
              </p>
            )}

            <ActionButton
              onClick={handleClearHistory}
              icon={clearConfirm ? "⚠️" : "🗑️"}
              label={clearConfirm ? "Clique novamente para confirmar" : "Limpar histórico"}
              variant={clearConfirm ? "danger" : "secondary"}
            />
          </>
        )}
      </Card>
    </main>
  );
}

// ══════════════════════════════════════════════
// ABA: INSTRUÇÕES
// ══════════════════════════════════════════════
function InstructionsTab() {
  const Step = ({ n, title, children }) => (
    <div style={{ display:"flex", gap:"14px", marginBottom:"20px" }}>
      <div style={{
        flexShrink:0, width:28, height:28, borderRadius:"50%",
        background:"linear-gradient(135deg,#E8836B,#cf6a52)",
        color:"white", fontSize:"13px", fontWeight:900,
        display:"flex", alignItems:"center", justifyContent:"center",
        marginTop:"1px", boxShadow:"0 2px 6px rgba(232,131,107,0.35)",
      }}>{n}</div>
      <div style={{ flex:1 }}>
        <p style={{ margin:"0 0 4px", fontSize:"14px", fontWeight:800, color:"#2D2D2D" }}>{title}</p>
        <div style={{ fontSize:"13px", color:"#6B7280", lineHeight:1.6 }}>{children}</div>
      </div>
    </div>
  );

  return (
    <main style={{ maxWidth:"600px", margin:"0 auto", padding:"8px 16px 64px" }}>
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🚀" title="Como configurar" />
        <p style={{ fontSize:"13px", color:"#6B7280", marginTop:0, marginBottom:"20px", lineHeight:1.6 }}>
          O malu-whisper usa a API da OpenAI. Você precisa de uma conta e alguns créditos —
          o custo é muito barato, cerca de{" "}
          <strong style={{ color:"#2D2D2D" }}>R$ 0,03 por minuto</strong> de áudio.
        </p>
        <Step n="1" title="Crie uma conta na OpenAI">
          Acesse{" "}
          <a href="https://platform.openai.com" target="_blank" rel="noreferrer" className="link">
            platform.openai.com
          </a>{" "}
          e crie sua conta. É separado do ChatGPT.
        </Step>
        <Step n="2" title="Adicione créditos">
          Vá em{" "}
          <a href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noreferrer" className="link">
            Configurações → Billing
          </a>{" "}
          e adicione um valor inicial.{" "}
          <strong style={{ color:"#2D2D2D" }}>$5 USD duram muito tempo</strong> — mais de 800 minutos.
        </Step>
        <Step n="3" title="Crie sua chave API">
          Acesse{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="link">
            platform.openai.com/api-keys
          </a>
          , clique em <strong style={{ color:"#2D2D2D" }}>"Create new secret key"</strong>,
          copie a chave (começa com{" "}
          <code style={{ background:"#F3F4F6", padding:"1px 5px", borderRadius:"4px", fontSize:"12px" }}>sk-</code>).{" "}
          <strong style={{ color:"#E8836B" }}>Guarde-a — aparece só uma vez.</strong>
        </Step>
        <Step n="4" title="Cole a chave no malu-whisper">
          Na aba <strong style={{ color:"#2D2D2D" }}>⚙️ Config</strong>, cole a chave no campo
          "Chave API". Ela fica salva <strong>só na sua conta</strong>.
        </Step>
        <Step n="5" title="Transcreva!">
          Vá para a aba <strong style={{ color:"#2D2D2D" }}>🎙️ Transcrever</strong>,
          envie um áudio ou grave pelo microfone e clique em ✨ Transcrever.
        </Step>
      </Card>

      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="💡" title="Dicas de uso" />
        <div style={{ display:"flex", flexDirection:"column", gap:"12px" }}>
          {[
            ["💾","Gravação salva por 24h","Se a transcrição falhar, seu áudio fica guardado no browser por 24h. Na próxima visita, um aviso aparece para restaurá-lo."],
            ["🤖","Escolha o modelo","Em ⚙️ Config você escolhe entre Whisper-1, GPT-4o Mini e GPT-4o Transcribe — com estimativa de custo em R$."],
            ["🔄","Conversor de áudio","Use a aba 🔄 Converter para converter formatos de áudio (mp3, wav, m4a…) ou extrair o áudio de um vídeo."],
            ["✏️","Texto editável","O resultado pode ser editado diretamente antes de baixar."],
            ["🎬","Arquivo .srt","O .srt é um arquivo de legendas com timestamps. Importa direto no CapCut, Premiere ou DaVinci."],
            ["📁","Formatos aceitos","mp3, mp4, m4a, wav, webm e mpeg — limite de 25 MB."],
          ].map(([icon, title, text]) => (
            <div key={title} style={{
              display:"flex", gap:"12px", background:"#FAFAFA",
              borderRadius:"10px", padding:"12px", border:"1px solid #F3F4F6",
            }}>
              <span style={{ fontSize:"20px", flexShrink:0, lineHeight:1.3 }}>{icon}</span>
              <div>
                <p style={{ margin:"0 0 3px", fontSize:"13px", fontWeight:800, color:"#2D2D2D" }}>{title}</p>
                <p style={{ margin:0, fontSize:"12px", color:"#6B7280", lineHeight:1.55 }}>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle icon="🔗" title="Links úteis" />
        <div style={{ display:"flex", flexDirection:"column", gap:"10px" }}>
          {[
            ["Suas chaves API",          "https://platform.openai.com/api-keys",                                        "platform.openai.com/api-keys"],
            ["Adicionar créditos",       "https://platform.openai.com/settings/organization/billing/overview",         "Billing → Add credit"],
            ["Ver uso e custos",         "https://platform.openai.com/usage",                                           "platform.openai.com/usage"],
            ["Preços dos modelos",       "https://openai.com/api/pricing",                                              "openai.com/api/pricing"],
          ].map(([desc, href, label]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer" style={{
              display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"12px 14px", borderRadius:"10px",
              background:"#FAFAFA", border:"1.5px solid #E5E7EB",
              textDecoration:"none", color:"#2D2D2D", transition:"border-color 0.2s, background 0.2s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor="#E8836B"; e.currentTarget.style.background="#FEF3F0"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor="#E5E7EB"; e.currentTarget.style.background="#FAFAFA"; }}
            >
              <div>
                <p style={{ margin:"0 0 1px", fontSize:"13px", fontWeight:700 }}>{desc}</p>
                <p style={{ margin:0, fontSize:"11px", color:"#9CA3AF", fontFamily:"'JetBrains Mono',monospace" }}>{label}</p>
              </div>
              <span style={{ fontSize:"16px", color:"#E8836B" }}>→</span>
            </a>
          ))}
        </div>
      </Card>
    </main>
  );
}

// ══════════════════════════════════════════════
// ABA: CONVERSOR (ffmpeg.wasm)
// ══════════════════════════════════════════════
const QUALITY_ARGS = {
  mp3:  { high:["-b:a","320k"],                         medium:["-b:a","128k"],                         low:["-b:a","64k"] },
  ogg:  { high:["-c:a","libvorbis","-b:a","192k"],      medium:["-c:a","libvorbis","-b:a","96k"],       low:["-c:a","libvorbis","-b:a","48k"] },
  m4a:  { high:["-c:a","aac","-b:a","256k"],            medium:["-c:a","aac","-b:a","128k"],            low:["-c:a","aac","-b:a","64k"] },
  wav:  { high:[], medium:[], low:[] },
  webm: { high:["-c:a","libopus","-b:a","192k"],        medium:["-c:a","libopus","-b:a","96k"],         low:["-c:a","libopus","-b:a","48k"] },
};

const APPROX_MB_PER_MIN = {
  mp3:  { high:2.4, medium:1.0, low:0.5 },
  ogg:  { high:1.4, medium:0.7, low:0.35 },
  m4a:  { high:1.9, medium:1.0, low:0.5 },
  wav:  { high:10,  medium:10,  low:10 },
  webm: { high:1.4, medium:0.7, low:0.35 },
};

function ConverterTab() {
  const [ffmpegState, setFfmpegState] = useState("idle"); // idle | loading | ready | error
  const [loadError,   setLoadError]   = useState(null);
  const [inputFile,   setInputFile]   = useState(null);
  const [outputFmt,   setOutputFmt]   = useState("mp3");
  const [quality,     setQuality]     = useState("medium");
  const [converting,  setConverting]  = useState(false);
  const [progress,    setProgress]    = useState(0);
  const [outputBlob,  setOutputBlob]  = useState(null);
  const [outputName,  setOutputName]  = useState(null);
  const [error,       setError]       = useState(null);
  const [isDragging,  setIsDragging]  = useState(false);
  const ffmpegRef  = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => { loadFFmpeg(); }, []);

  async function loadFFmpeg() {
    if (ffmpegRef.current) { setFfmpegState("ready"); return; }
    setFfmpegState("loading");
    try {
      await loadScript("https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js");
      const { createFFmpeg, fetchFile } = window.FFmpeg;
      const ff = createFFmpeg({
        log: false,
        corePath: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js",
        progress: ({ ratio }) => setProgress(Math.min(99, Math.round(ratio * 100))),
      });
      await ff.load();
      ffmpegRef.current = { ff, fetchFile };
      setFfmpegState("ready");
    } catch (err) {
      console.error(err);
      setLoadError("Não foi possível carregar o conversor. Verifique sua conexão e recarregue a página.");
      setFfmpegState("error");
    }
  }

  const handleFile = useCallback(file => {
    if (!file) return;
    setInputFile(file); setOutputBlob(null); setOutputName(null); setError(null);
  }, []);

  const handleDrop = e => {
    e.preventDefault(); setIsDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleDragLeave = e => {
    if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false);
  };

  const convert = async () => {
    if (!ffmpegRef.current || !inputFile) return;
    const { ff, fetchFile } = ffmpegRef.current;
    setConverting(true); setProgress(0); setError(null);
    if (outputBlob) { URL.revokeObjectURL(URL.createObjectURL(outputBlob)); setOutputBlob(null); }

    const inputExt  = (inputFile.name.split(".").pop() || "mp4").toLowerCase();
    const inputName = `input.${inputExt}`;
    const outputName = `output.${outputFmt}`;
    const baseName   = inputFile.name.replace(/\.[^.]+$/, "");

    try {
      ff.FS("writeFile", inputName, await fetchFile(inputFile));
      const qArgs = QUALITY_ARGS[outputFmt]?.[quality] ?? [];
      await ff.run("-i", inputName, "-vn", ...qArgs, "-y", outputName);

      const data = ff.FS("readFile", outputName);
      const fmt  = CONVERTER_FORMATS.find(f => f.id === outputFmt);
      const blob = new Blob([data.buffer], { type: fmt?.mime ?? "audio/mpeg" });
      setOutputBlob(blob);
      setOutputName(`${baseName}_convertido.${outputFmt}`);
      try { ff.FS("unlink", inputName); } catch {}
      try { ff.FS("unlink", outputName); } catch {}
    } catch (err) {
      console.error(err);
      setError("Erro durante a conversão. O arquivo pode não ser suportado ou estar corrompido.");
    } finally { setConverting(false); setProgress(0); }
  };

  const approxMB = APPROX_MB_PER_MIN[outputFmt]?.[quality];

  return (
    <main style={{ maxWidth:"600px", margin:"0 auto", padding:"8px 16px 64px" }}>
      {converting && <LoadingOverlay label="Convertendo…" />}

      {/* Status do ffmpeg */}
      {ffmpegState === "loading" && (
        <div style={{
          display:"flex", alignItems:"center", gap:"12px",
          background:"#F0F9FF", border:"1px solid #BAE6FD",
          borderRadius:"12px", padding:"14px 16px", marginBottom:"12px",
          fontSize:"13px", color:"#0369A1",
        }}>
          <span className="spin" style={{ width:16, height:16, borderRadius:"50%", border:"2px solid #BAE6FD", borderTopColor:"#0369A1", display:"inline-block", flexShrink:0 }} />
          <span>Carregando conversor (~30 MB, aguarde…)</span>
        </div>
      )}
      {ffmpegState === "error" && loadError && (
        <ErrorBanner message={loadError} onDismiss={null} />
      )}

      {/* Card principal */}
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🔄" title="Conversor de Áudio / Vídeo" />
        <p style={{ fontSize:"13px", color:"#6B7280", margin:"0 0 16px", lineHeight:1.5 }}>
          Converte formatos de áudio e <strong>extrai áudio de vídeos</strong> (mp4, mkv, avi…).
          Tudo processado localmente no seu browser — nenhum arquivo é enviado a servidores.
        </p>

        {/* Dropzone */}
        <div
          role="button" tabIndex={0}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={handleDragLeave}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={e => e.key==="Enter" && fileInputRef.current?.click()}
          className={`drop-zone${isDragging ? " dragging" : ""}`}
          style={{ opacity: ffmpegState==="ready" ? 1 : 0.5, cursor: ffmpegState==="ready" ? "pointer" : "not-allowed" }}
        >
          <div style={{ fontSize:"36px", marginBottom:"10px" }}>{isDragging ? "🎯" : "🎵"}</div>
          <p style={{ margin:"0 0 4px", fontSize:"14px", fontWeight:700, color:"#374151" }}>
            {inputFile ? inputFile.name : "Arraste um arquivo aqui"}
          </p>
          <p style={{ margin:"0 0 14px", fontSize:"12px", color:"#9CA3AF" }}>
            {inputFile ? formatSize(inputFile.size) : "áudio ou vídeo — qualquer formato"}
          </p>
          <span style={{
            display:"inline-block", padding:"7px 18px", borderRadius:"9px",
            background:"linear-gradient(135deg,#E8836B,#cf6a52)",
            color:"white", fontSize:"12px", fontWeight:700,
            boxShadow:"0 2px 8px rgba(232,131,107,0.35)",
          }}>{inputFile ? "Trocar arquivo" : "Escolher arquivo"}</span>
        </div>
        <input ref={fileInputRef} type="file"
          accept="audio/*,video/*,.mkv,.avi,.mov,.flv,.ts"
          onChange={e => { handleFile(e.target.files[0]); e.target.value=""; }}
          style={{ display:"none" }}
        />
      </Card>

      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="⚙️" title="Opções de conversão" />

        {/* Formato de saída */}
        <div style={{ marginBottom:"16px" }}>
          <FieldLabel>Formato de saída</FieldLabel>
          <div style={{ display:"flex", gap:"8px", flexWrap:"wrap" }}>
            {CONVERTER_FORMATS.map(f => (
              <button key={f.id} onClick={() => setOutputFmt(f.id)}
                style={{
                  padding:"8px 14px", borderRadius:"9px", fontFamily:"inherit",
                  fontSize:"13px", fontWeight:700, cursor:"pointer",
                  border:`2px solid ${outputFmt===f.id ? "#E8836B" : "#E5E7EB"}`,
                  background: outputFmt===f.id ? "#FEF3F0" : "white",
                  color: outputFmt===f.id ? "#E8836B" : "#374151",
                  transition:"all 0.15s",
                }}
              >
                {f.label}
                <span style={{ marginLeft:"4px", fontSize:"10px", color: outputFmt===f.id ? "#E8836B" : "#9CA3AF", fontWeight:600 }}>
                  {f.note}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Qualidade */}
        {outputFmt !== "wav" && (
          <div style={{ marginBottom:"16px" }}>
            <FieldLabel>Qualidade</FieldLabel>
            <div style={{ display:"flex", gap:"8px" }}>
              {[
                { id:"high",   label:"Alta",   desc:"melhor qualidade" },
                { id:"medium", label:"Média",  desc:"equilíbrio" },
                { id:"low",    label:"Baixa",  desc:"arquivo menor" },
              ].map(q => (
                <button key={q.id} onClick={() => setQuality(q.id)}
                  style={{
                    flex:1, padding:"8px 8px", borderRadius:"9px", fontFamily:"inherit",
                    fontSize:"12px", fontWeight:700, cursor:"pointer",
                    border:`2px solid ${quality===q.id ? "#E8836B" : "#E5E7EB"}`,
                    background: quality===q.id ? "#FEF3F0" : "white",
                    color: quality===q.id ? "#E8836B" : "#374151",
                    transition:"all 0.15s", textAlign:"center",
                  }}
                >
                  {q.label}
                  <div style={{ fontSize:"10px", fontWeight:600, color: quality===q.id ? "#E8836B" : "#9CA3AF" }}>
                    {q.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Info */}
        <div style={{
          background:"#F8F9FA", borderRadius:"8px", padding:"10px 12px",
          fontSize:"12px", color:"#6B7280", display:"flex", gap:"16px", flexWrap:"wrap",
        }}>
          <span>📤 Saída: <strong style={{ color:"#2D2D2D" }}>.{outputFmt}</strong></span>
          <span>📦 ~{outputFmt==="wav" ? "10" : approxMB?.toFixed(1)} MB/min</span>
          {outputFmt==="wav" && <span style={{ color:"#059669", fontWeight:700 }}>Sem compressão (PCM)</span>}
        </div>
      </Card>

      {/* Progresso */}
      {converting && (
        <Card style={{ marginBottom:"12px" }}>
          <div style={{ marginBottom:"8px", fontSize:"13px", fontWeight:700, color:"#2D2D2D" }}>
            Convertendo… {progress}%
          </div>
          <div style={{ background:"#F3F4F6", borderRadius:"50px", height:8, overflow:"hidden" }}>
            <div style={{
              height:"100%", borderRadius:"50px",
              background:"linear-gradient(90deg,#E8836B,#cf6a52)",
              width:`${progress}%`, transition:"width 0.3s",
            }} />
          </div>
        </Card>
      )}

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Resultado */}
      {outputBlob && !converting && (
        <Card className="fade-in" style={{ marginBottom:"12px" }}>
          <SectionTitle icon="✅" title="Conversão concluída!" />
          <div style={{
            display:"flex", alignItems:"center", gap:"12px",
            background:"#F8F9FA", borderRadius:"10px", padding:"12px",
            border:"1.5px solid #E5E7EB", marginBottom:"14px",
          }}>
            <span style={{ fontSize:"22px" }}>🎵</span>
            <div style={{ flex:1, overflow:"hidden" }}>
              <p style={{ margin:0, fontSize:"13px", fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {outputName}
              </p>
              <p style={{ margin:0, fontSize:"11px", color:"#9CA3AF" }}>
                {formatSize(outputBlob.size)}
              </p>
            </div>
          </div>
          <audio src={URL.createObjectURL(outputBlob)} controls style={{ width:"100%", borderRadius:"8px", height:"38px", marginBottom:"12px" }} />
          <ActionButton
            onClick={() => downloadBlob(outputBlob, outputName)}
            icon="⬇️" label={`Baixar .${outputFmt}`}
            variant="primary"
          />
        </Card>
      )}

      {/* Botão converter */}
      {!converting && !outputBlob && (
        <button
          onClick={convert}
          disabled={!inputFile || ffmpegState !== "ready"}
          style={{
            width:"100%", marginTop:"4px", padding:"15px",
            borderRadius:"14px", border:"none", fontFamily:"inherit",
            background: (inputFile && ffmpegState==="ready") ? "linear-gradient(135deg,#E8836B,#cf6a52)" : "#E5E7EB",
            color: (inputFile && ffmpegState==="ready") ? "white" : "#9CA3AF",
            fontSize:"16px", fontWeight:900,
            cursor: (inputFile && ffmpegState==="ready") ? "pointer" : "not-allowed",
            boxShadow: (inputFile && ffmpegState==="ready") ? "0 5px 18px rgba(232,131,107,0.42)" : "none",
            transition:"all 0.2s",
          }}
        >
          {ffmpegState==="loading" ? "⏳ Carregando conversor…" : "🔄 Converter"}
        </button>
      )}

      {outputBlob && (
        <button onClick={() => { setOutputBlob(null); setOutputName(null); setInputFile(null); setError(null); }}
          style={{
            width:"100%", marginTop:"10px", padding:"12px",
            borderRadius:"12px", border:"1.5px solid #E5E7EB",
            background:"white", color:"#6B7280",
            fontSize:"14px", fontWeight:700, cursor:"pointer", fontFamily:"inherit",
          }}
        >↺ Nova conversão</button>
      )}
    </main>
  );
}

// ══════════════════════════════════════════════
// ABA: TRANSCREVER
// ══════════════════════════════════════════════
function TranscribeContent({ apiKey, model, onGoToConfig, username }) {
  const [language, setLanguage] = useState("pt");

  const [audioFile,   setAudioFile]   = useState(null);
  const [audioUrl,    setAudioUrl]    = useState(null);
  const audioUrlRef                   = useRef(null);
  const [audioSource, setAudioSource] = useState(null);
  const [activeTab,   setActiveTab]   = useState("upload");
  const [isDragging,  setIsDragging]  = useState(false);
  const [priceEst,    setPriceEst]    = useState(null);

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
  useEffect(() => { loadRecordingFromDB().then(rec => { if (rec) setSavedRecording(rec); }); }, []);

  // Estimativa de preço sempre que o arquivo ou o modelo mudar
  useEffect(() => {
    if (!audioFile) { setPriceEst(null); return; }
    let cancelled = false;
    const modelObj = MODELS.find(m => m.id === model) || MODELS[0];
    getAudioDuration(audioFile).then(dur => {
      if (cancelled) return;
      setPriceEst(dur ? estimatePrice(dur, modelObj) : null);
    });
    return () => { cancelled = true; };
  }, [audioFile, model]);

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

  const handleFile = useCallback(file => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { setError("Arquivo muito grande. O limite é 25 MB."); return; }
    revokeCurrentUrl();
    const url = URL.createObjectURL(file);
    setAudioFile(file); setAudioUrl(url); audioUrlRef.current = url;
    setAudioSource("upload"); setTranscriptionText(null); setTranscriptionSrt(null); setError(null);
  }, []); // eslint-disable-line

  const handleInputChange = e => { handleFile(e.target.files[0]); e.target.value=""; };
  const handleDragLeave   = e => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false); };
  const handleDrop        = e => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); };

  const startRecording = async () => {
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getBestMimeType();
      if (!mimeType) {
        setError("Seu browser não suporta gravação. Tente Chrome, Firefox ou Safari.");
        stream.getTracks().forEach(t => t.stop()); return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext  = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        const file = new File([blob], `gravacao.${ext}`, { type: mimeType });
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        const url = URL.createObjectURL(blob);
        setAudioFile(file); setAudioUrl(url); audioUrlRef.current = url;
        setAudioSource("recording"); setTranscriptionText(null); setTranscriptionSrt(null);
        stream.getTracks().forEach(t => t.stop());
        await saveRecordingToDB(blob); setSavedRecording(null);
      };
      recorder.start(500); mediaRecorderRef.current = recorder;
      setIsRecording(true); setRecordingSeconds(0); setError(null);
      timerRef.current = setInterval(() => setRecordingSeconds(s => s+1), 1000);
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
    setPriceEst(null);
    if (audioSource === "recording") clearRecordingFromDB();
  };

  const transcribe = async () => {
    if (!apiKey.trim()) { setError("Insira sua Chave API nas ⚙️ Configurações antes de continuar."); return; }
    if (!audioFile)     { setError("Selecione ou grave um áudio primeiro."); return; }
    setIsTranscribing(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", audioFile);
      fd.append("model", model || "whisper-1");
      fd.append("response_format", "verbose_json");
      if (language) fd.append("language", language);
      const res = await fetch(WHISPER_ENDPOINT, {
        method:"POST", headers:{ Authorization:`Bearer ${apiKey.trim()}` }, body:fd,
      });
      if (!res.ok) {
        let msg = `Erro ${res.status} da API OpenAI.`;
        try { const d = await res.json(); msg = d.error?.message || msg; } catch {}
        if (res.status===401) msg = "Chave API inválida ou expirada.";
        else if (res.status===413) msg = "Arquivo muito grande. O limite é 25 MB.";
        else if (res.status===429) msg = "Muitas requisições. Aguarde e tente novamente.";
        else if (res.status===500) msg = "Erro interno da OpenAI. Tente em instantes.";
        throw new Error(msg);
      }
      const data = await res.json();
      setTranscriptionText(data.text ?? "");
      setTranscriptionSrt(data.segments?.length ? segmentsToSrt(data.segments) : null);
      if (audioSource === "recording") clearRecordingFromDB();

      // Registrar custo real no histórico do usuário
      const durMin = ((data.duration ?? 0) / 60) || (priceEst?.mins ?? 0);
      if (username && durMin > 0) {
        const activeModel = MODELS.find(m => m.id === model) || MODELS[0];
        const costUSD = durMin * activeModel.usdPerMin;
        const costBRL = costUSD * USD_TO_BRL;
        addUsageRecord(username, { modelId: model, durationMin: durMin, costUSD, costBRL });
      }
    } catch (err) {
      setError(err.message);
    } finally { setIsTranscribing(false); }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(transcriptionText);
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    } catch { setError("Use Ctrl+A → Ctrl+C na área de texto."); }
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
  const currentModel  = MODELS.find(m => m.id === model) || MODELS[0];

  return (
    <main style={{ maxWidth:"600px", margin:"0 auto", padding:"8px 16px 64px" }}>
      {isTranscribing && <LoadingOverlay />}

      {/* Banner: gravação salva */}
      {savedRecording && (
        <div className="fade-in" style={{
          display:"flex", alignItems:"center", gap:"12px", flexWrap:"wrap",
          background:"linear-gradient(135deg,#FFF7ED,#FEF3C7)",
          border:"1.5px solid #FCD34D", borderRadius:"14px",
          padding:"14px 16px", marginBottom:"12px",
        }}>
          <span style={{ fontSize:"22px", flexShrink:0 }}>💾</span>
          <div style={{ flex:1, minWidth:"140px" }}>
            <p style={{ margin:"0 0 2px", fontSize:"13px", fontWeight:800, color:"#92400E" }}>
              Gravação salva encontrada
            </p>
            <p style={{ margin:0, fontSize:"11px", color:"#B45309" }}>
              {formatSize(savedRecording.blob.size)} · salva {timeAgo(savedRecording.timestamp)}
            </p>
          </div>
          <div style={{ display:"flex", gap:"8px", flexShrink:0 }}>
            <button onClick={restoreSavedRecording} style={{
              padding:"7px 14px", borderRadius:"8px", border:"none",
              background:"#F59E0B", color:"white",
              fontSize:"12px", fontWeight:800, cursor:"pointer", fontFamily:"inherit",
            }}>Restaurar</button>
            <button onClick={dismissSavedRecording} style={{
              padding:"7px 10px", borderRadius:"8px",
              border:"1px solid #FCD34D", background:"transparent",
              color:"#92400E", fontSize:"12px", cursor:"pointer", fontFamily:"inherit",
            }}>Descartar</button>
          </div>
        </div>
      )}

      {/* Aviso: sem chave API */}
      {!apiKey.trim() && (
        <div className="fade-in" style={{
          display:"flex", alignItems:"center", gap:"12px",
          background:"#FFFBEB", border:"1.5px solid #FCD34D",
          borderRadius:"12px", padding:"12px 16px", marginBottom:"12px",
          fontSize:"13px", color:"#92400E",
        }}>
          <span style={{ fontSize:"18px" }}>🔑</span>
          <span style={{ flex:1 }}>Você ainda não configurou sua Chave API.</span>
          <button onClick={onGoToConfig} style={{
            padding:"6px 12px", borderRadius:"8px", border:"none",
            background:"#F59E0B", color:"white",
            fontSize:"12px", fontWeight:800, cursor:"pointer", fontFamily:"inherit",
            flexShrink:0,
          }}>⚙️ Config</button>
        </div>
      )}

      {/* Card: Idioma + modelo atual */}
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🌐" title="Opções de transcrição" />
        <FieldLabel htmlFor="language">Idioma da transcrição</FieldLabel>
        <select id="language" value={language} onChange={e => setLanguage(e.target.value)}
          disabled={isTranscribing}
          style={{
            width:"100%", padding:"10px 14px", borderRadius:"10px",
            border:"1.5px solid #E5E7EB", fontSize:"14px",
            background:"#FAFAFA", color:"#2D2D2D", cursor:"pointer",
            fontFamily:"inherit", transition:"border-color 0.2s",
            opacity: isTranscribing ? 0.6 : 1, marginBottom:"12px",
          }}
          onFocus={e => e.target.style.borderColor="#E8836B"}
          onBlur={e  => e.target.style.borderColor="#E5E7EB"}
        >
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>

        {/* Modelo ativo */}
        <div style={{
          display:"flex", alignItems:"center", justifyContent:"space-between",
          background:"#F8F9FA", borderRadius:"10px", padding:"10px 14px",
          border:"1px solid #E5E7EB",
        }}>
          <div>
            <p style={{ margin:"0 0 2px", fontSize:"12px", color:"#9CA3AF", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.04em" }}>Modelo ativo</p>
            <p style={{ margin:0, fontSize:"13px", fontWeight:800, color:"#2D2D2D" }}>
              {currentModel.name}
              <span style={{
                marginLeft:"8px", fontSize:"10px", fontWeight:700,
                padding:"2px 7px", borderRadius:"50px",
                background:`${currentModel.badgeColor}18`,
                color:currentModel.badgeColor,
              }}>{currentModel.badge}</span>
            </p>
          </div>
          <button onClick={onGoToConfig} style={{
            padding:"6px 12px", borderRadius:"8px",
            border:"1.5px solid #E5E7EB", background:"white",
            fontSize:"12px", fontWeight:700, cursor:"pointer",
            color:"#6B7280", fontFamily:"inherit",
          }}>alterar</button>
        </div>
      </Card>

      {/* Card: Áudio */}
      <Card style={{ marginBottom:"12px" }}>
        <SectionTitle icon="🎵" title="Áudio" />

        <div style={{
          display:"flex", background:"#F3F4F6", borderRadius:"11px",
          padding:"3px", marginBottom:"18px", gap:"2px",
        }}>
          {[["upload","📁 Enviar arquivo"],["record","🎤 Gravar agora"]].map(([tab, label]) => (
            <button key={tab}
              onClick={() => !isTranscribing && setActiveTab(tab)}
              className={`tab-btn ${activeTab===tab ? "active" : "inactive"}`}
              style={{ opacity: isTranscribing ? 0.6 : 1 }}
            >{label}</button>
          ))}
        </div>

        {activeTab === "upload" && (
          <div>
            <div
              role="button" tabIndex={0}
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={handleDragLeave}
              onClick={() => !isTranscribing && fileInputRef.current?.click()}
              onKeyDown={e => e.key==="Enter" && !isTranscribing && fileInputRef.current?.click()}
              className={`drop-zone${isDragging ? " dragging" : ""}`}
              style={{ opacity: isTranscribing ? 0.6 : 1, cursor: isTranscribing ? "not-allowed" : "pointer" }}
            >
              <div style={{ fontSize:"36px", marginBottom:"10px" }}>{isDragging ? "🎯" : "📂"}</div>
              <p style={{ margin:"0 0 4px", fontSize:"14px", fontWeight:700, color:"#374151" }}>Arraste um arquivo aqui</p>
              <p style={{ margin:"0 0 14px", fontSize:"12px", color:"#9CA3AF" }}>ou clique para selecionar</p>
              <span style={{
                display:"inline-block", padding:"7px 18px", borderRadius:"9px",
                background:"linear-gradient(135deg,#E8836B,#cf6a52)",
                color:"white", fontSize:"12px", fontWeight:700,
                boxShadow:"0 2px 8px rgba(232,131,107,0.35)",
              }}>Escolher arquivo</span>
            </div>
            <p style={{ fontSize:"11px", color:"#9CA3AF", marginTop:"8px", textAlign:"center" }}>
              mp3 · mp4 · m4a · wav · webm · mpeg — máx 25 MB
            </p>
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleInputChange} style={{ display:"none" }} />
          </div>
        )}

        {activeTab === "record" && (
          <div style={{ textAlign:"center", padding:"8px 0 4px" }}>
            {!isRecording && audioFile && audioSource==="upload" && (
              <div>
                <div style={{ fontSize:"36px", marginBottom:"10px" }}>📂</div>
                <p style={{ margin:"0 0 12px", fontSize:"14px", color:"#6B7280" }}>Você já tem um arquivo selecionado.</p>
                <button onClick={() => !isTranscribing && discardAudio()} disabled={isTranscribing}
                  style={{
                    padding:"10px 22px", borderRadius:"50px",
                    border:"1.5px solid #E5E7EB", background:"white",
                    color:"#6B7280", fontSize:"13px", fontWeight:700,
                    cursor: isTranscribing ? "not-allowed" : "pointer",
                    fontFamily:"inherit",
                  }}
                  onMouseEnter={e => { if(!isTranscribing) { e.currentTarget.style.borderColor="#EF4444"; e.currentTarget.style.color="#EF4444"; }}}
                  onMouseLeave={e => { e.currentTarget.style.borderColor="#E5E7EB"; e.currentTarget.style.color="#6B7280"; }}
                >🗑️ &nbsp;Descartar e gravar novo</button>
              </div>
            )}

            {!isRecording && !audioFile && (
              <>
                <div style={{ fontSize:"48px", marginBottom:"12px" }}>🎤</div>
                <p style={{ margin:"0 0 18px", fontSize:"14px", color:"#6B7280" }}>Clique para começar a gravar</p>
                <button onClick={startRecording} style={{
                  padding:"12px 30px", borderRadius:"50px", border:"none",
                  cursor:"pointer", fontFamily:"inherit",
                  background:"linear-gradient(135deg,#E8836B,#cf6a52)",
                  color:"white", fontSize:"14px", fontWeight:800,
                  boxShadow:"0 4px 16px rgba(232,131,107,0.45)",
                }}
                  onMouseEnter={e => e.currentTarget.style.opacity="0.85"}
                  onMouseLeave={e => e.currentTarget.style.opacity="1"}
                >● &nbsp;Iniciar gravação</button>
              </>
            )}

            {isRecording && (
              <div style={{ padding:"4px 0" }}>
                <div style={{
                  display:"inline-flex", alignItems:"center", gap:"10px",
                  background:"#FEF2F2", padding:"10px 22px",
                  borderRadius:"50px", marginBottom:"20px",
                }}>
                  <div className="pulse-dot" style={{ width:10, height:10, borderRadius:"50%", background:"#EF4444", flexShrink:0 }} />
                  <span style={{ fontSize:"15px", fontWeight:800, color:"#EF4444", fontFamily:"'JetBrains Mono',monospace" }}>
                    {formatTime(recordingSeconds)}
                  </span>
                  <span style={{ fontSize:"12px", color:"#F87171", fontWeight:600 }}>gravando</span>
                </div>
                <br />
                <button onClick={stopRecording} style={{
                  padding:"12px 30px", borderRadius:"50px",
                  border:"2px solid #EF4444", background:"white",
                  color:"#EF4444", fontSize:"14px", fontWeight:800,
                  cursor:"pointer", fontFamily:"inherit",
                }}
                  onMouseEnter={e => e.currentTarget.style.background="#FEF2F2"}
                  onMouseLeave={e => e.currentTarget.style.background="white"}
                >■ &nbsp;Parar gravação</button>
              </div>
            )}
          </div>
        )}

        {audioFile && !isRecording && (
          <div className="fade-in" style={{
            marginTop:"16px", background:"#F8F9FA",
            borderRadius:"12px", padding:"14px", border:"1.5px solid #E5E7EB",
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"10px" }}>
              <span style={{ fontSize:"18px", flexShrink:0 }}>{audioSource==="recording" ? "🎙️" : "📄"}</span>
              <div style={{ flex:1, overflow:"hidden" }}>
                <p style={{ margin:0, fontSize:"13px", fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {audioFile.name}
                </p>
                <p style={{ margin:"0 0 4px", fontSize:"11px", color:"#9CA3AF" }}>
                  {formatSize(audioFile.size)}
                  {audioSource==="recording" && (
                    <span style={{ marginLeft:"8px", color:"#F59E0B", fontWeight:700 }}>· 💾 salvo por 24h</span>
                  )}
                </p>
                {priceEst ? (
                  <span style={{
                    display:"inline-flex", alignItems:"center", gap:"4px",
                    background:"#ECFDF5", color:"#047857",
                    padding:"2px 9px", borderRadius:"50px",
                    fontSize:"11px", fontWeight:700,
                    border:"1px solid #A7F3D0",
                  }}>
                    💰 ~R$&nbsp;{priceEst.costBRL.toFixed(2).replace(".",",")}
                    &nbsp;·&nbsp;{priceEst.mins.toFixed(1).replace(".",",")} min
                  </span>
                ) : (
                  <span style={{
                    display:"inline-flex", alignItems:"center", gap:"4px",
                    background:"#F3F4F6", color:"#9CA3AF",
                    padding:"2px 9px", borderRadius:"50px",
                    fontSize:"11px", fontWeight:600,
                  }}>estimando preço…</span>
                )}
              </div>
              <button onClick={() => !isTranscribing && discardAudio()} disabled={isTranscribing}
                aria-label="Remover" title="Remover"
                style={{
                  background:"none", border:"none",
                  cursor: isTranscribing ? "not-allowed" : "pointer",
                  fontSize:"16px", color:"#9CA3AF", padding:"4px",
                  borderRadius:"6px", flexShrink:0,
                  opacity: isTranscribing ? 0.4 : 1,
                }}
                onMouseEnter={e => { if(!isTranscribing) e.currentTarget.style.color="#EF4444"; }}
                onMouseLeave={e => e.currentTarget.style.color="#9CA3AF"}
              >🗑️</button>
            </div>
            <audio src={audioUrl} controls style={{ width:"100%", borderRadius:"8px", height:"38px" }} />
          </div>
        )}
      </Card>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {!hasResult && (
        <button onClick={transcribe} disabled={!canTranscribe} style={{
          width:"100%", marginTop:"12px", padding:"15px",
          borderRadius:"14px", border:"none", fontFamily:"inherit",
          background: canTranscribe ? "linear-gradient(135deg,#E8836B,#cf6a52)" : "#E5E7EB",
          color: canTranscribe ? "white" : "#9CA3AF",
          fontSize:"16px", fontWeight:900,
          cursor: canTranscribe ? "pointer" : "not-allowed",
          boxShadow: canTranscribe ? "0 5px 18px rgba(232,131,107,0.42)" : "none",
          transition:"all 0.2s",
          display:"flex", alignItems:"center", justifyContent:"center", gap:"10px",
        }}
          onMouseEnter={e => { if(canTranscribe) e.currentTarget.style.opacity="0.88"; }}
          onMouseLeave={e => e.currentTarget.style.opacity="1"}
        >✨ Transcrever</button>
      )}

      {hasResult && (
        <Card className="fade-in" style={{ marginTop:"12px" }}>
          <div style={{
            display:"flex", alignItems:"center", justifyContent:"space-between",
            marginBottom:"14px", flexWrap:"wrap", gap:"8px",
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
              <span style={{ fontSize:"18px" }}>✅</span>
              <h2 style={{ fontSize:"15px", fontWeight:700, margin:0 }}>Transcrição</h2>
            </div>
            <ActionButton onClick={reset} icon="↺" label="Nova transcrição" variant="secondary" />
          </div>

          <textarea
            value={transcriptionText}
            onChange={e => setTranscriptionText(e.target.value)}
            style={{
              width:"100%", minHeight:"180px", padding:"14px",
              borderRadius:"10px", border:"1.5px solid #E5E7EB",
              background:"#FAFAFA", fontSize:"14px",
              fontFamily:"'JetBrains Mono',monospace",
              lineHeight:1.65, resize:"vertical", color:"#2D2D2D",
            }}
            onFocus={e => e.target.style.borderColor="#E8836B"}
            onBlur={e  => e.target.style.borderColor="#E5E7EB"}
          />
          <div style={{
            display:"flex", justifyContent:"flex-end", gap:"12px",
            marginTop:"6px", fontSize:"11px", color:"#9CA3AF",
          }}>
            <span>{countWords(transcriptionText)} palavras</span>
            <span>{transcriptionText?.length ?? 0} caracteres</span>
          </div>

          <div style={{ display:"flex", gap:"8px", marginTop:"10px", flexWrap:"wrap" }}>
            <ActionButton onClick={copyText} icon={copied ? "✅" : "📋"} label={copied ? "Copiado!" : "Copiar texto"} variant={copied ? "success" : "secondary"} />
            <ActionButton onClick={downloadTxt} icon="📄" label="Baixar .txt" variant="secondary" />
            {transcriptionSrt && <ActionButton onClick={downloadSrt} icon="🎬" label="Baixar .srt" variant="secondary" />}
            {transcriptionSrt && <ActionButton onClick={downloadBoth} icon="⬇️" label="Baixar ambos" variant="primary" />}
          </div>
          {!transcriptionSrt && (
            <p style={{ fontSize:"11px", color:"#9CA3AF", marginTop:"10px", marginBottom:0 }}>
              ⓘ Arquivo .srt não disponível — resposta sem timestamps.
            </p>
          )}
        </Card>
      )}

      <p style={{ textAlign:"center", fontSize:"11px", color:"#C4C9D4", marginTop:"28px" }}>
        {currentModel.name} · R$ {brlPerMin(currentModel.usdPerMin)}/min · sua chave, sua conta OpenAI
      </p>
    </main>
  );
}

// ══════════════════════════════════════════════
// APP — RAIZ
// ══════════════════════════════════════════════
export default function App() {
  const [isIniting,  setIsIniting]  = useState(true);
  const [username,   setUsername]   = useState(() => sessionStorage.getItem(STORAGE.session) || null);
  const [activeNav,  setActiveNav]  = useState("app");
  const [apiKey,     setApiKeyState] = useState("");
  const [model,      setModelState]  = useState("whisper-1");

  useEffect(() => { initUsers().then(() => setIsIniting(false)); }, []);

  useEffect(() => {
    if (!username) return;
    const data = getUserData(username);
    setApiKeyState(data.apiKey || "");
    setModelState(data.model  || "whisper-1");
  }, [username]);

  const setApiKey = key => {
    setApiKeyState(key);
    if (username) persistUserApiKey(username, key);
  };

  const setModel = m => {
    setModelState(m);
    if (username) persistUserModel(username, m);
  };

  const handleLogin = uname => {
    sessionStorage.setItem(STORAGE.session, uname);
    setUsername(uname);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(STORAGE.session);
    setUsername(null); setApiKeyState(""); setModelState("whisper-1"); setActiveNav("app");
  };

  if (isIniting) return <style>{GLOBAL_CSS}</style>;

  if (!username) return (
    <>
      <style>{GLOBAL_CSS}</style>
      <LoginScreen onLogin={handleLogin} />
    </>
  );

  const NAV = [
    { id:"app",        label:"🎙️ Transcrever" },
    { id:"converter",  label:"🔄 Converter" },
    { id:"config",     label:"⚙️ Config" },
    { id:"instrucoes", label:"📖 Instruções" },
  ];

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{
        backgroundColor:"#FBF8F4", minHeight:"100vh",
        fontFamily:"'Nunito','Segoe UI',sans-serif", color:"#2D2D2D",
      }}>
        <header style={{ borderBottom:"1px solid #F0EDE8", paddingBottom:"4px" }}>
          {/* Linha 1: Logo + usuário + sair */}
          <div style={{
            maxWidth:"600px", margin:"0 auto",
            display:"flex", alignItems:"center", justifyContent:"space-between",
            padding:"16px 20px 10px",
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
              <div style={{
                width:36, height:36, borderRadius:"10px",
                background:"linear-gradient(135deg,#E8836B,#cf6a52)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:"17px", boxShadow:"0 3px 10px rgba(232,131,107,0.4)",
              }}>🎙️</div>
              <div>
                <h1 style={{ margin:0, fontSize:"17px", fontWeight:900, color:"#E8836B", lineHeight:1.1 }}>
                  malu-whisper
                </h1>
                <p style={{ margin:0, fontSize:"10px", color:"#6B8E9B", fontWeight:600 }}>
                  transcrição com IA
                </p>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:"8px" }}>
              <span style={{
                fontSize:"12px", fontWeight:700, color:"#9CA3AF",
                background:"#F3F4F6", padding:"4px 10px", borderRadius:"50px",
              }}>👤 {username}</span>
              <button
                onClick={handleLogout} title="Sair" aria-label="Sair"
                style={{
                  padding:"7px 10px", borderRadius:"50px",
                  border:"1.5px solid #E5E7EB", background:"white",
                  color:"#9CA3AF", fontSize:"14px", cursor:"pointer",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor="#EF4444"; e.currentTarget.style.color="#EF4444"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor="#E5E7EB"; e.currentTarget.style.color="#9CA3AF"; }}
              >🚪</button>
            </div>
          </div>

          {/* Linha 2: Nav */}
          <div style={{
            maxWidth:"600px", margin:"0 auto",
            display:"flex", gap:"4px", padding:"0 20px 12px",
            overflowX:"auto",
          }}>
            {NAV.map(({ id, label }) => (
              <button key={id}
                onClick={() => setActiveNav(id)}
                className={`nav-pill ${activeNav===id ? "active" : "inactive"}`}
              >{label}</button>
            ))}
          </div>
        </header>

        {activeNav === "app"        && <TranscribeContent apiKey={apiKey} model={model} onGoToConfig={() => setActiveNav("config")} username={username} />}
        {activeNav === "converter"  && <ConverterTab />}
        {activeNav === "config"     && <SettingsTab username={username} apiKey={apiKey} setApiKey={setApiKey} model={model} setModel={setModel} />}
        {activeNav === "instrucoes" && <InstructionsTab />}
      </div>
    </>
  );
}
