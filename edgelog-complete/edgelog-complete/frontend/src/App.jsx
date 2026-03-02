import { useState, useMemo, useEffect, useCallback, createContext, useContext } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis, Cell
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// API CLIENT — Connexion au backend EDGELOG
// Mettre l'URL de votre API en production dans VITE_API_URL
// ─────────────────────────────────────────────────────────────────────────────

// Détection de l'URL API de façon compatible avec tous les environnements :
// - Vite (import.meta.env) : bundler ES module
// - Create React App (process.env) : bundler CommonJS
// - Artifact / navigateur direct : window.__EDGELOG_API_URL ou fallback
function getApiBase() {
  // 1. Variable globale injectée manuellement (déploiement statique)
  if (typeof window !== "undefined" && window.__EDGELOG_API_URL) {
    return window.__EDGELOG_API_URL;
  }
  // 2. Vite — protégé par try/catch car import.meta.env lance en dehors d'un module ES
  try {
    // eslint-disable-next-line no-undef
    if (typeof VITE_API_URL !== "undefined" && VITE_API_URL) return VITE_API_URL;
  } catch {}
  // 3. Create React App / webpack
  try {
    if (typeof process !== "undefined" && process.env?.REACT_APP_API_URL) {
      return process.env.REACT_APP_API_URL;
    }
  } catch {}
  // 4. Fallback développement local
  return "http://localhost:4000/api";
}

const API_BASE = getApiBase();

// Stockage des tokens (en prod utiliser httpOnly cookies ou secure storage)
const tokenStore = {
  get access()  { try { return localStorage.getItem("edgelog_access");  } catch { return null; } },
  get refresh() { try { return localStorage.getItem("edgelog_refresh"); } catch { return null; } },
  set(access, refresh) {
    try {
      if (access)  localStorage.setItem("edgelog_access",  access);
      if (refresh) localStorage.setItem("edgelog_refresh", refresh);
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem("edgelog_access");
      localStorage.removeItem("edgelog_refresh");
    } catch {}
  },
};

// File d'attente pour éviter plusieurs refreshes simultanés
let isRefreshing = false;
let refreshQueue = [];

async function processRefreshQueue(token, error) {
  refreshQueue.forEach(prom => error ? prom.reject(error) : prom.resolve(token));
  refreshQueue = [];
}

// Client HTTP principal avec refresh automatique
async function apiRequest(endpoint, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  // Ajoute le token si disponible
  const token = tokenStore.access;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  // Token expiré → refresh automatique
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.code === "TOKEN_EXPIRED" && tokenStore.refresh) {
      if (!isRefreshing) {
        isRefreshing = true;
        try {
          const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ refreshToken: tokenStore.refresh }),
          });
          if (refreshRes.ok) {
            const data = await refreshRes.json();
            tokenStore.set(data.accessToken, data.refreshToken);
            processRefreshQueue(data.accessToken, null);
            isRefreshing = false;
            // Relance la requête originale
            return apiRequest(endpoint, options);
          } else {
            tokenStore.clear();
            processRefreshQueue(null, new Error("Session expirée"));
            isRefreshing = false;
            window.location.reload();
          }
        } catch (err) {
          isRefreshing = false;
          tokenStore.clear();
          throw err;
        }
      } else {
        // Attend que le refresh se termine
        return new Promise((resolve, reject) => {
          refreshQueue.push({ resolve, reject });
        }).then(newToken => {
          headers["Authorization"] = `Bearer ${newToken}`;
          return fetch(`${API_BASE}${endpoint}`, { ...options, headers });
        });
      }
    }
    throw new Error(body.error || "Non autorisé");
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur ${res.status}`);
  }

  return res.json();
}

// ── API methods ───────────────────────────────────────────────────
const API = {
  // Auth
  auth: {
    register: (data)       => apiRequest("/auth/register",  { method:"POST", body:data }),
    login:    (data)       => apiRequest("/auth/login",     { method:"POST", body:data }),
    logout:   (refresh)    => apiRequest("/auth/logout",    { method:"POST", body:{ refreshToken:refresh } }),
    me:       ()           => apiRequest("/auth/me"),
    refresh:  (token)      => apiRequest("/auth/refresh",   { method:"POST", body:{ refreshToken:token } }),
  },
  // User
  user: {
    profile:  ()           => apiRequest("/user/profile"),
    update:   (data)       => apiRequest("/user/profile",   { method:"PUT",  body:data }),
    plan:     ()           => apiRequest("/user/plan"),
    delete:   (pwd)        => apiRequest("/user",           { method:"DELETE", body:{ password:pwd } }),
  },
  // Trades
  trades: {
    list:     (params={})  => apiRequest("/trades?" + new URLSearchParams(params)),
    create:   (data)       => apiRequest("/trades",         { method:"POST", body:data }),
    get:      (id)         => apiRequest(`/trades/${id}`),
    update:   (id, data)   => apiRequest(`/trades/${id}`,   { method:"PUT",  body:data }),
    delete:   (id)         => apiRequest(`/trades/${id}`,   { method:"DELETE" }),
  },
  // Accounts
  accounts: {
    list:     ()           => apiRequest("/accounts"),
    create:   (data)       => apiRequest("/accounts",       { method:"POST", body:data }),
    update:   (id, data)   => apiRequest(`/accounts/${id}`, { method:"PUT",  body:data }),
    delete:   (id)         => apiRequest(`/accounts/${id}`, { method:"DELETE" }),
  },
  // Stripe
  stripe: {
    checkout: (plan, billing) => apiRequest("/stripe/create-checkout", { method:"POST", body:{ plan, billing } }),
    portal:   ()              => apiRequest("/stripe/create-portal",   { method:"POST" }),
    cancel:   ()              => apiRequest("/stripe/cancel",          { method:"POST" }),
    sub:      ()              => apiRequest("/stripe/subscription"),
  },
  // Import
  import: {
    preview: (formData)    => fetch(`${API_BASE}/import/preview`, {
      method:"POST",
      headers:{ "Authorization": `Bearer ${tokenStore.access}` },
      body: formData, // FormData — pas JSON
    }).then(r => r.json()),
    confirm: (formData)    => fetch(`${API_BASE}/import/confirm`, {
      method:"POST",
      headers:{ "Authorization": `Bearer ${tokenStore.access}` },
      body: formData,
    }).then(r => r.json()),
  },
  // Mentor
  mentor: {
    list:        ()                    => apiRequest("/mentor/list"),
    invite:      (email, access)       => apiRequest("/mentor/invite",   { method:"POST", body:{ email, access } }),
    revoke:      (id)                  => apiRequest(`/mentor/${id}`,    { method:"DELETE" }),
    feedback:    ()                    => apiRequest("/mentor/feedback"),          // GET — feedbacks reçus
    postFeedback:(tradeId, content)    => apiRequest("/mentor/feedback", { method:"POST", body:{ tradeId, content } }),
    shared:      (userId)              => apiRequest(`/mentor/shared/${userId}`),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HOOK useAPI — gestion loading/error pour les composants
// ─────────────────────────────────────────────────────────────────────────────
function useAPI(apiFn, deps = [], options = {}) {
  const [data,    setData]    = useState(options.initialData ?? null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  const execute = useCallback(async (...args) => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFn(...args);
      setData(result);
      return result;
    } catch (err) {
      setError(err.message);
      if (options.onError) options.onError(err);
      return null;
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => { execute(); }, [execute]);

  return { data, loading, error, refetch: execute };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH & USER CONTEXT
// ─────────────────────────────────────────────────────────────────────────────
const AuthContext = createContext(null);
const useAuth = () => useContext(AuthContext);
const useUser = () => useContext(AuthContext)?.user;

// ─────────────────────────────────────────────────────────────────────────────
// PLAN HELPERS  (miroir du middleware backend)
// ─────────────────────────────────────────────────────────────────────────────
const PSYCH_TRIAL_DAYS    = 30;

const PLANS = {
  basic:   { label:"Basic",       color:"var(--blue)",   limit:15,       histDays:30,  psychTrial:PSYCH_TRIAL_DAYS },
  premium: { label:"Premium",     color:"var(--accent)", limit:100,      histDays:90,  psychTrial:0  },
  pro:     { label:"Premium Pro", color:"#a78bfa",       limit:Infinity, histDays:null,psychTrial:0  },
};

const isPremium     = (u) => u?.plan === "premium" || u?.plan === "pro";
const isPro         = (u) => u?.plan === "pro";
const isBasicPlan   = (u) => !u || u?.plan === "basic";

// Psychologie trial : Basic users bénéficient de PSYCH_TRIAL_DAYS depuis la création du compte
// En mode démo (pas de createdAt), on considère le compte comme nouveau → trial actif
const inPsychTrial  = (u) => {
  if (!isBasicPlan(u)) return true;
  if (!u?.createdAt) return true; // démo → toujours actif
  const daysSince = (Date.now() - new Date(u.createdAt)) / 864e5;
  return daysSince <= PSYCH_TRIAL_DAYS;
};

const applyPlanFilter = (trades, user) => {
  if (isPro(user)) return trades; // Pro = illimité
  if (isPremium(user)) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth()-3);
    return trades.filter(t => new Date(t.date) >= cutoff); // Premium = 3 mois
  }
  // Basic = 30 derniers jours
  const cutoff = new Date(Date.now() - 30 * 864e5);
  return trades.filter(t => new Date(t.date) >= cutoff);
};

const checkTradeLimit = (all, user) => {
  const plan = PLANS[user?.plan] || PLANS.basic;
  if (all.length >= plan.limit)
    return { allowed: false, message: `Limite de ${plan.limit} trades atteinte (${plan.label}). Passez au plan supérieur.` };
  return { allowed: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STYLES
// ─────────────────────────────────────────────────────────────────────────────
const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=IBM+Plex+Mono:wght@300;400;500&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{
      --bg:#080a0d;--s1:#0f1318;--s2:#161b23;--s3:#1c232e;
      --bd:#1f2733;--bd2:#273040;
      --accent:#00e5a0;--red:#ff4d6d;--amber:#f59e0b;--blue:#38bdf8;--purple:#a78bfa;
      --text:#dde4f0;--muted:#4e5d73;--muted2:#6b7a94;
      --fh:'Syne',sans-serif;--fm:'IBM Plex Mono',monospace;--r:10px;
    }
    html,body{background:var(--bg);color:var(--text);font-family:var(--fm);font-size:13px;overflow-x:hidden;}
    ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:var(--bd2);border-radius:2px;}

    /* ── AUTH SCREENS ── */
    .auth-root{
      min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:var(--bg);position:relative;overflow:hidden;
    }
    .auth-bg{
      position:absolute;inset:0;pointer-events:none;
      background:radial-gradient(ellipse 900px 600px at 50% 0%,rgba(0,229,160,.05) 0%,transparent 70%);
    }
    .auth-grid{
      position:absolute;inset:0;pointer-events:none;
      background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);
      background-size:48px 48px;opacity:.18;
      mask-image:radial-gradient(ellipse 80% 80% at 50% 0%,black 20%,transparent 100%);
    }
    .auth-card{
      position:relative;z-index:1;width:100%;max-width:440px;margin:24px;
      background:var(--s1);border:1px solid var(--bd);border-radius:20px;
      padding:40px 36px;box-shadow:0 32px 80px rgba(0,0,0,.6);
      animation:fadeUp .4s ease both;
    }
    .auth-logo{
      font-family:var(--fh);font-size:22px;font-weight:800;text-align:center;
      margin-bottom:6px;letter-spacing:-0.5px;
    }
    .auth-logo em{color:var(--accent);font-style:normal;}
    .auth-logo sup{font-size:10px;color:var(--muted2);vertical-align:super;margin-left:2px;}
    .auth-tagline{text-align:center;font-size:11px;color:var(--muted2);margin-bottom:32px;letter-spacing:.3px;}
    .auth-title{font-family:var(--fh);font-size:20px;font-weight:800;margin-bottom:4px;letter-spacing:-0.3px;}
    .auth-sub{font-size:11px;color:var(--muted2);margin-bottom:28px;}
    .auth-divider{
      display:flex;align-items:center;gap:12px;margin:20px 0;
      font-size:10px;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;
    }
    .auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:var(--bd);}
    .auth-footer{text-align:center;font-size:11px;color:var(--muted2);margin-top:20px;}
    .auth-footer a{color:var(--accent);cursor:pointer;text-decoration:none;}
    .auth-footer a:hover{text-decoration:underline;}
    .auth-error{
      background:rgba(255,77,109,.08);border:1px solid rgba(255,77,109,.25);
      border-radius:8px;padding:10px 14px;font-size:11px;color:var(--red);
      margin-bottom:16px;display:flex;align-items:center;gap:8px;
    }
    .auth-success{
      background:rgba(0,229,160,.08);border:1px solid rgba(0,229,160,.2);
      border-radius:8px;padding:10px 14px;font-size:11px;color:var(--accent);
      margin-bottom:16px;display:flex;align-items:center;gap:8px;
    }

    /* Google button */
    .btn-google{
      width:100%;justify-content:center;background:var(--s2);
      border:1px solid var(--bd2);color:var(--text);gap:10px;
      font-size:11px;letter-spacing:.3px;text-transform:none;
      padding:11px 18px;border-radius:8px;
    }
    .btn-google:hover{background:var(--s3);border-color:var(--bd2);}
    .google-icon{font-size:16px;line-height:1;}

    /* Password strength */
    .pwd-strength{margin-top:6px;display:flex;gap:4px;align-items:center;}
    .pwd-seg{height:3px;flex:1;border-radius:2px;background:var(--s3);transition:background .2s;}
    .pwd-seg.fill-1{background:var(--red);}
    .pwd-seg.fill-2{background:var(--amber);}
    .pwd-seg.fill-3{background:var(--blue);}
    .pwd-seg.fill-4{background:var(--accent);}
    .pwd-label{font-size:9px;color:var(--muted2);min-width:40px;text-align:right;}

    /* ── ONBOARDING ── */
    .onboard-root{
      min-height:100vh;background:var(--bg);display:flex;flex-direction:column;
      align-items:center;justify-content:center;padding:40px 24px;
      position:relative;overflow:hidden;
    }
    .onboard-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 800px 500px at 50% -50px,rgba(0,229,160,.04) 0%,transparent 70%);}
    .onboard-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);background-size:48px 48px;opacity:.15;mask-image:radial-gradient(ellipse 80% 70% at 50% 0%,black 20%,transparent 100%);}
    .onboard-inner{position:relative;z-index:1;width:100%;max-width:860px;}
    .onboard-step{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:16px;text-align:center;}
    .onboard-progress{display:flex;gap:6px;justify-content:center;margin-bottom:36px;}
    .op-dot{width:28px;height:3px;border-radius:2px;background:var(--s3);transition:background .3s;}
    .op-dot.done{background:var(--accent);}
    .op-dot.active{background:var(--accent);opacity:.5;}
    .onboard-title{font-family:var(--fh);font-size:clamp(24px,4vw,36px);font-weight:800;text-align:center;letter-spacing:-1px;margin-bottom:10px;}
    .onboard-sub{text-align:center;color:var(--muted2);font-size:13px;margin-bottom:48px;}

    /* Plan choice cards */
    .plan-choice-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;max-width:960px;margin:0 auto 40px;}
    .plan-choice{
      background:var(--s1);border:2px solid var(--bd);border-radius:16px;
      padding:26px 22px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden;
    }
    .plan-choice:hover{transform:translateY(-3px);}
    .plan-choice.selected.basic{border-color:var(--blue);box-shadow:0 8px 32px rgba(56,189,248,.12);}
    .plan-choice.selected.premium{border-color:var(--amber);box-shadow:0 8px 32px rgba(245,158,11,.15);}
    .plan-choice.selected.pro{border-color:#a78bfa;box-shadow:0 8px 32px rgba(167,139,250,.15);}
    .plan-choice.premium::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--amber),transparent);}
    .plan-choice.pro::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#a78bfa,transparent);}
    .plan-choice-badge{position:absolute;top:16px;right:16px;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:3px 10px;border-radius:10px;}
    .plan-choice.premium .plan-choice-badge{background:rgba(245,158,11,.15);color:var(--amber);border:1px solid rgba(245,158,11,.3);}
    .plan-choice.pro .plan-choice-badge{background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3);}
    .pc-icon{font-size:32px;margin-bottom:16px;}
    .pc-name{font-family:var(--fh);font-size:18px;font-weight:800;margin-bottom:6px;}
    .plan-choice.basic .pc-name{color:var(--blue);}
    .plan-choice.premium .pc-name{color:var(--amber);}
    .plan-choice.pro .pc-name{color:#a78bfa;}
    .pc-price{font-size:22px;font-weight:700;font-family:var(--fh);margin-bottom:14px;letter-spacing:-0.5px;}
    .plan-choice.basic .pc-price{color:var(--blue);}
    .plan-choice.premium .pc-price{color:var(--amber);}
    .plan-choice.pro .pc-price{color:#a78bfa;}
    .pc-feats{display:flex;flex-direction:column;gap:7px;}
    .pc-feat{font-size:11px;color:var(--muted2);display:flex;align-items:center;gap:7px;}
    .pc-feat::before{content:'✓';font-size:9px;font-weight:700;flex-shrink:0;}
    .plan-choice.basic .pc-feat::before{color:var(--blue);}
    .plan-choice.premium .pc-feat::before{color:var(--amber);}
    .plan-choice.pro .pc-feat::before{color:#a78bfa;}
    .pc-select{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--bd);font-size:11px;color:var(--muted2);transition:color .15s;}
    .plan-choice.selected .pc-select{color:var(--accent);}
    .pc-radio{width:16px;height:16px;border-radius:50%;border:2px solid var(--bd2);transition:all .15s;flex-shrink:0;}
    .plan-choice.selected .pc-radio{border-color:var(--accent);background:var(--accent);}

    /* Onboarding account step */
    .onboard-form{max-width:480px;margin:0 auto;}
    .onboard-nav{display:flex;justify-content:space-between;align-items:center;margin-top:36px;max-width:740px;margin-left:auto;margin-right:auto;}

    /* ── APP LAYOUT ── */
    .app{display:flex;min-height:100vh;}
    .sidebar{width:232px;min-height:100vh;background:var(--s1);border-right:1px solid var(--bd);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;flex-shrink:0;}
    .main{flex:1;min-width:0;display:flex;flex-direction:column;}
    .topbar{background:var(--s1);border-bottom:1px solid var(--bd);padding:14px 32px;display:flex;align-items:center;justify-content:space-between;gap:16px;position:sticky;top:0;z-index:50;flex-shrink:0;}
    .content-pad{padding:28px 32px;}

    /* ── SIDEBAR ── */
    .logo{padding:22px 20px 18px;border-bottom:1px solid var(--bd);font-family:var(--fh);font-weight:800;font-size:19px;letter-spacing:-0.5px;}
    .logo em{color:var(--accent);font-style:normal;}
    .logo sup{font-size:9px;color:var(--muted2);font-weight:600;vertical-align:super;margin-left:2px;}
    .plan-pill{margin:10px 14px 0;padding:7px 12px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;cursor:pointer;transition:all .15s;}
    .plan-pill.basic{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.2);color:var(--blue);}
    .plan-pill.basic:hover{background:rgba(56,189,248,.14);}
    .plan-pill.premium{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);color:var(--amber);}
    .plan-pill.premium:hover{background:rgba(245,158,11,.14);}
    .plan-pill.pro{background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);color:#a78bfa;}
    .plan-pill.pro:hover{background:rgba(167,139,250,.14);}
    .plan-pill-upgrade{font-size:9px;color:var(--accent);background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.2);padding:2px 7px;border-radius:4px;}

    /* ── PRO GATE ── */
    .pro-gate{background:var(--s1);border:1px solid rgba(167,139,250,.25);border-radius:12px;padding:40px 32px;text-align:center;position:relative;overflow:hidden;}
    .pro-gate::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#a78bfa,transparent);}
    .btn-pro{background:linear-gradient(135deg,#7c3aed,#a78bfa);color:#fff;border:none;}
    .btn-pro:hover{background:linear-gradient(135deg,#6d28d9,#8b5cf6);}

    /* ── COMPORTEMENT PAGE ── */
    .behav-score-ring{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;position:relative;margin:0 auto 16px;}
    .behav-score-val{font-family:var(--fh);font-size:28px;font-weight:800;}
    .behav-score-label{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-top:2px;}
    .behav-rule{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:8px;margin-bottom:8px;font-size:11px;}
    .behav-rule-ok{background:rgba(0,229,160,.06);border:1px solid rgba(0,229,160,.2);}
    .behav-rule-warn{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);}
    .behav-rule-bad{background:rgba(255,77,109,.06);border:1px solid rgba(255,77,109,.2);}
    .behav-impact{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;}
    .style-badge{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid;}

    /* ── PLANS GRID 3 cols ── */
    .plans-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;max-width:1060px;margin:0 auto;}
    .plan-card.pro{border-color:rgba(167,139,250,.35);background:linear-gradient(160deg,#141a24 0%,#0f1318 100%);}
    .plan-card.pro:hover{box-shadow:0 16px 60px rgba(167,139,250,.12);}
    .plan-card.pro::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#a78bfa,transparent);}
    .plan-card.pro .plan-name{color:#a78bfa;}
    .plan-card.pro .plan-price-main{color:#a78bfa;}
    .plan-card.pro .pf-check{background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.2);}
    .compare-head{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;background:var(--s2);padding:14px 20px;border-bottom:1px solid var(--bd);}
    .compare-row{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;padding:12px 20px;border-bottom:1px solid var(--bd);transition:background .1s;}
    .compare-row:last-child{border-bottom:none;}
    .compare-row:hover{background:var(--s2);}
    .compare-cell{font-size:11px;display:flex;align-items:center;justify-content:center;}
    .compare-cell:first-child{justify-content:flex-start;color:var(--muted2);}
    .compare-head-cell.pro-col{color:#a78bfa;}
    .user-box{margin:10px 14px 0;background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:10px 12px;display:flex;align-items:center;gap:10px;}
    .user-avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--fh);font-size:13px;font-weight:700;flex-shrink:0;}
    .user-info{flex:1;min-width:0;}
    .user-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .user-email{font-size:9px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .user-logout{background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:2px;transition:color .13s;}
    .user-logout:hover{color:var(--red);}
    .account-box{margin:10px 14px 0;background:var(--s2);border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;cursor:pointer;transition:border-color .15s;}
    .account-box:hover{border-color:var(--accent);}
    .account-label{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px;}
    .account-name{font-family:var(--fh);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:space-between;}
    .account-bal{font-size:11px;color:var(--accent);margin-top:2px;}
    .nav{padding:12px 10px;flex:1;display:flex;flex-direction:column;gap:2px;}
    .ni{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--muted2);transition:all .13s;font-weight:500;user-select:none;}
    .ni:hover{background:var(--s2);color:var(--text);}
    .ni.on{background:var(--s3);color:var(--accent);}
    .ni.locked{opacity:.45;cursor:default;}
    .ni.locked:hover{background:transparent;color:var(--muted2);}
    .ni .ico{font-size:14px;width:20px;text-align:center;flex-shrink:0;}
    .ni .nbadge{margin-left:auto;font-size:8px;padding:2px 6px;border-radius:3px;letter-spacing:.5px;}
    .ni .nbadge.new{background:rgba(0,229,160,.15);color:var(--accent);}
    .ni .nbadge.pro{background:rgba(245,158,11,.15);color:var(--amber);}
    .ni .nbadge.lock{background:rgba(255,77,109,.12);color:var(--red);}
    .sidebar-footer{padding:14px 14px 20px;border-top:1px solid var(--bd);}
    .sidebar-footer .lbl{font-size:9px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;}
    .trade-limit-bar{margin:0 14px 12px;padding:10px 12px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;}
    .tlb-label{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted2);margin-bottom:6px;display:flex;justify-content:space-between;}
    .tlb-count{color:var(--text);font-weight:600;}
    .tlb-track{height:4px;background:var(--s3);border-radius:2px;overflow:hidden;}
    .tlb-fill{height:100%;border-radius:2px;transition:width .3s;}

    /* ── BUTTONS ── */
    .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:6px;border:none;cursor:pointer;font-family:var(--fm);font-size:10px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;transition:all .15s;white-space:nowrap;}
    .btn-primary{background:var(--accent);color:#000;}
    .btn-primary:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,229,160,.25);}
    .btn-primary:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none;filter:none;}
    .btn-ghost{background:transparent;color:var(--muted2);border:1px solid var(--bd2);}
    .btn-ghost:hover{color:var(--text);background:var(--s2);}
    .btn-red{background:transparent;color:var(--red);border:1px solid rgba(255,77,109,.3);}
    .btn-red:hover{background:var(--red);color:#fff;}
    .btn-amber{background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;border:none;}
    .btn-amber:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 4px 16px rgba(245,158,11,.3);}
    .btn-outline-accent{background:transparent;color:var(--accent);border:1px solid rgba(0,229,160,.4);}
    .btn-outline-accent:hover{background:rgba(0,229,160,.08);border-color:var(--accent);}
    .btn-lg{padding:14px 32px;font-size:11px;border-radius:8px;}
    .btn-sm{padding:5px 11px;font-size:9px;}
    .btn-full{width:100%;justify-content:center;}

    /* ── FORMS ── */
    .fg{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;}
    .fg.full{grid-column:1/-1;}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
    label{font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted2);}
    input,select,textarea{background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:9px 11px;color:var(--text);font-family:var(--fm);font-size:12px;outline:none;transition:border .13s;width:100%;}
    input:focus,select:focus,textarea:focus{border-color:var(--accent);}
    input::placeholder{color:var(--muted);}
    textarea{resize:vertical;min-height:72px;}
    .chips{display:flex;flex-wrap:wrap;gap:6px;}
    .chip{padding:4px 11px;border-radius:20px;font-size:10px;cursor:pointer;border:1px solid var(--bd);color:var(--muted2);transition:all .13s;}
    .chip.on{border-color:var(--accent);color:var(--accent);background:rgba(0,229,160,.08);}
    .input-icon{position:relative;}
    .input-icon input{padding-left:36px;}
    .input-icon .ii{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--muted2);font-size:14px;pointer-events:none;}
    .input-eye{position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--muted2);cursor:pointer;font-size:13px;border:none;background:none;padding:2px;}
    .input-eye:hover{color:var(--text);}

    /* ── CARDS ── */
    .card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;}
    .card-pad{padding:20px 22px;}
    .card-title{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted2);font-weight:500;margin-bottom:16px;}

    /* ── TABLE ── */
    .tbl-wrap{overflow-x:auto;}
    table{width:100%;border-collapse:collapse;}
    thead tr{border-bottom:1px solid var(--bd);}
    th{padding:10px 14px;text-align:left;font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);font-weight:500;}
    tbody tr{border-bottom:1px solid var(--bd);transition:background .1s;cursor:pointer;}
    tbody tr:last-child{border-bottom:none;}
    tbody tr:hover{background:var(--s2);}
    td{padding:11px 14px;font-size:12px;}

    /* ── BADGES ── */
    .bdg{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;}
    .bdg-long{background:rgba(0,229,160,.12);color:var(--accent);}
    .bdg-short{background:rgba(255,77,109,.12);color:var(--red);}
    .bdg-win{background:rgba(0,229,160,.1);color:var(--accent);}
    .bdg-loss{background:rgba(255,77,109,.1);color:var(--red);}
    .bdg-open{background:rgba(245,158,11,.1);color:var(--amber);}

    /* ── UTILS ── */
    .pos{color:var(--accent);}.neg{color:var(--red);}.amb{color:var(--amber);}
    .divider{height:1px;background:var(--bd);margin:18px 0;}
    .section-title{font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);font-weight:500;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
    .section-title::after{content:'';flex:1;height:1px;background:var(--bd);}

    /* ── KPI ── */
    .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px;}
    .kpi{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:18px 20px;position:relative;overflow:hidden;}
    .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .kpi.g::before{background:linear-gradient(90deg,var(--accent),transparent);}
    .kpi.r::before{background:linear-gradient(90deg,var(--red),transparent);}
    .kpi.a::before{background:linear-gradient(90deg,var(--amber),transparent);}
    .kpi.b::before{background:linear-gradient(90deg,var(--blue),transparent);}
    .kpi.p::before{background:linear-gradient(90deg,var(--purple),transparent);}
    .kpi-label{font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
    .kpi-val{font-family:var(--fh);font-size:26px;font-weight:700;letter-spacing:-1px;line-height:1;}
    .kpi-sub{font-size:10px;color:var(--muted2);margin-top:6px;}

    /* ── CHART GRIDS ── */
    .chart-row{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:22px;}
    .chart-row-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px;}

    /* ── MODAL ── */
    .overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(6px);}
    .modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;width:720px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:30px;box-shadow:0 32px 80px rgba(0,0,0,.7);}
    .modal-title{font-family:var(--fh);font-size:18px;font-weight:700;margin-bottom:22px;letter-spacing:-0.3px;display:flex;align-items:center;justify-content:space-between;}
    .modal-close{background:none;border:none;color:var(--muted2);cursor:pointer;font-size:18px;}
    .modal-close:hover{color:var(--text);}

    /* ── TOAST ── */
    .toast{position:fixed;bottom:24px;right:24px;padding:11px 18px;border-radius:8px;font-size:11px;font-weight:500;letter-spacing:.5px;z-index:500;animation:tin .2s ease;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:340px;}
    .toast.ok{background:var(--accent);color:#000;}
    .toast.err{background:var(--red);color:#fff;}
    .toast.warn{background:var(--amber);color:#000;}
    .toast.info{background:var(--s3);color:var(--text);border:1px solid var(--bd2);}
    @keyframes tin{from{transform:translateY(12px);opacity:0;}to{transform:translateY(0);opacity:1;}}

    /* ── PREMIUM GATE ── */
    .premium-gate{background:var(--s1);border:1px solid rgba(245,158,11,.25);border-radius:12px;padding:40px 32px;text-align:center;position:relative;overflow:hidden;}
    .premium-gate::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--amber),transparent);}
    .pg-icon{font-size:36px;margin-bottom:14px;}
    .pg-title{font-family:var(--fh);font-size:17px;font-weight:800;margin-bottom:8px;}
    .pg-desc{font-size:12px;color:var(--muted2);line-height:1.6;margin-bottom:20px;max-width:360px;margin-left:auto;margin-right:auto;}
    .pg-features{display:flex;justify-content:center;gap:20px;margin-bottom:24px;flex-wrap:wrap;}
    .pg-feat{font-size:11px;color:var(--muted2);display:flex;align-items:center;gap:5px;}
    .pg-feat::before{content:'✓';color:var(--amber);font-weight:700;}

    /* ── LIMIT BANNER ── */
    .limit-banner{background:rgba(255,77,109,.06);border:1px solid rgba(255,77,109,.25);border-radius:10px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap;}
    .lb-left{display:flex;align-items:center;gap:10px;}
    .lb-text strong{color:var(--red);display:block;margin-bottom:2px;}
    .lb-text span{color:var(--muted2);font-size:11px;}

    /* ── HISTORY NOTICE ── */
    .history-notice{background:rgba(56,189,248,.05);border:1px solid rgba(56,189,248,.2);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--blue);display:flex;align-items:center;gap:8px;margin-bottom:16px;}

    /* ── DEV TOGGLE ── */
    .dev-upgrade{position:fixed;bottom:24px;left:24px;z-index:300;background:var(--s2);border:1px solid var(--bd2);border-radius:10px;padding:12px 16px;font-size:11px;box-shadow:0 8px 24px rgba(0,0,0,.4);}
    .dev-upgrade-title{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
    .dev-toggle{display:flex;align-items:center;gap:8px;}
    .dt-track{width:40px;height:22px;background:var(--s3);border:1px solid var(--bd2);border-radius:11px;cursor:pointer;position:relative;transition:background .2s;flex-shrink:0;}
    .dt-track.on{background:rgba(245,158,11,.25);border-color:var(--amber);}
    .dt-knob{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:7px;background:var(--muted2);transition:all .2s;}
    .dt-track.on .dt-knob{left:21px;background:var(--amber);}

    /* ── MISC ── */
    .setup-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font-size:9px;background:rgba(167,139,250,.12);color:var(--purple);border:1px solid rgba(167,139,250,.2);letter-spacing:.5px;}
    .a-ico{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;}
    .a-ico.crypto{background:rgba(251,191,36,.12);}
    .a-ico.forex{background:rgba(56,189,248,.12);}
    .a-ico.gold{background:rgba(245,158,11,.12);}
    .a-ico.index{background:rgba(167,139,250,.12);}
    .prog-bar{height:5px;background:var(--s3);border-radius:3px;overflow:hidden;margin-top:5px;}
    .prog-fill{height:100%;border-radius:3px;}
    .filter-bar{display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap;}
    .filter-bar select,.filter-bar input{min-width:130px;width:auto;}
    .empty-state{text-align:center;padding:64px 32px;background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);}
    .empty-icon{font-size:44px;margin-bottom:16px;}
    .empty-title{font-family:var(--fh);font-size:18px;font-weight:700;margin-bottom:8px;}
    .empty-desc{color:var(--muted2);font-size:12px;margin-bottom:20px;line-height:1.6;}
    .pagination{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--bd);font-size:11px;color:var(--muted2);}
    .page-btns{display:flex;gap:4px;}
    .pb{padding:4px 10px;border-radius:4px;background:var(--s2);border:1px solid var(--bd);cursor:pointer;font-size:10px;color:var(--text);transition:all .12s;}
    .pb:hover{border-color:var(--accent);color:var(--accent);}
    .pb.on{background:var(--accent);color:#000;border-color:var(--accent);}

    /* LANDING */
    .landing{background:var(--bg);min-height:100%;overflow-x:hidden;}
    .hero{position:relative;padding:80px 64px 60px;display:flex;flex-direction:column;align-items:center;text-align:center;overflow:hidden;}
    .hero-bg{position:absolute;inset:0;pointer-events:none;z-index:0;background:radial-gradient(ellipse 900px 500px at 50% -80px,rgba(0,229,160,.06) 0%,transparent 70%);}
    .hero-grid{position:absolute;inset:0;z-index:0;pointer-events:none;background-image:linear-gradient(var(--bd) 1px,transparent 1px),linear-gradient(90deg,var(--bd) 1px,transparent 1px);background-size:48px 48px;opacity:.25;mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,black 30%,transparent 100%);}
    .hero>*{position:relative;z-index:1;}
    .hero-eyebrow{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;border:1px solid rgba(0,229,160,.25);background:rgba(0,229,160,.06);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);margin-bottom:24px;animation:fadeUp .5s ease both;}
    .hero-eyebrow span{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
    .hero-title{font-family:var(--fh);font-size:clamp(36px,6vw,64px);font-weight:800;line-height:1.05;letter-spacing:-2px;margin-bottom:20px;animation:fadeUp .5s .1s ease both;}
    .hero-title em{font-style:normal;color:var(--accent);}
    .hero-title .line2{color:var(--muted2);}
    .hero-sub{font-size:14px;color:var(--muted2);line-height:1.7;max-width:520px;margin-bottom:40px;animation:fadeUp .5s .2s ease both;}
    .hero-cta{display:flex;gap:12px;justify-content:center;animation:fadeUp .5s .3s ease both;}
    .stats-bar{display:flex;align-items:center;justify-content:center;gap:40px;padding:24px 64px;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);background:var(--s1);flex-wrap:wrap;}
    .stat-item{text-align:center;}
    .stat-val{font-family:var(--fh);font-size:22px;font-weight:700;letter-spacing:-0.5px;}
    .stat-lbl{font-size:10px;color:var(--muted2);letter-spacing:.8px;margin-top:2px;}
    .stat-divider{width:1px;height:36px;background:var(--bd);}
    .plans-section{padding:72px 64px;}
    .plans-eyebrow{text-align:center;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:14px;}
    .plans-title{font-family:var(--fh);font-size:clamp(24px,4vw,40px);font-weight:800;text-align:center;letter-spacing:-1px;margin-bottom:12px;}
    .plans-subtitle{text-align:center;color:var(--muted2);font-size:13px;margin-bottom:56px;}
    .billing-toggle{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:52px;font-size:11px;}
    .toggle-track{width:44px;height:24px;background:var(--s3);border:1px solid var(--bd2);border-radius:12px;cursor:pointer;position:relative;transition:background .2s;}
    .toggle-track.on{background:rgba(0,229,160,.2);border-color:var(--accent);}
    .toggle-knob{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:8px;background:var(--muted2);transition:all .2s;}
    .toggle-track.on .toggle-knob{left:23px;background:var(--accent);}
    .save-badge{padding:2px 8px;border-radius:4px;background:rgba(0,229,160,.15);color:var(--accent);font-size:9px;letter-spacing:.5px;border:1px solid rgba(0,229,160,.2);}
    .plans-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:820px;margin:0 auto;}
    .plan-card{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:36px 32px;position:relative;overflow:hidden;transition:transform .2s,box-shadow .2s;}
    .plan-card:hover{transform:translateY(-4px);}
    .plan-card.premium{border-color:rgba(245,158,11,.35);background:linear-gradient(160deg,#141a20 0%,#0f1318 100%);}
    .plan-card.premium:hover{box-shadow:0 16px 60px rgba(245,158,11,.12);}
    .plan-card.premium::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--amber),transparent);}
    .plan-recommended{position:absolute;top:20px;right:20px;padding:4px 12px;border-radius:20px;font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;background:linear-gradient(135deg,rgba(245,158,11,.2),rgba(245,158,11,.1));color:var(--amber);border:1px solid rgba(245,158,11,.3);}
    .plan-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:20px;}
    .plan-card.basic .plan-icon{background:rgba(56,189,248,.1);border:1px solid rgba(56,189,248,.15);}
    .plan-card.premium .plan-icon{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.2);}
    .plan-name{font-family:var(--fh);font-size:20px;font-weight:800;letter-spacing:-0.3px;margin-bottom:6px;}
    .plan-card.premium .plan-name{color:var(--amber);}
    .plan-tagline{font-size:11px;color:var(--muted2);margin-bottom:28px;line-height:1.5;}
    .plan-price{margin-bottom:28px;}
    .plan-price-main{font-family:var(--fh);font-size:40px;font-weight:800;letter-spacing:-2px;line-height:1;}
    .plan-card.basic .plan-price-main{color:var(--blue);}
    .plan-card.premium .plan-price-main{color:var(--amber);}
    .plan-price-period{font-size:11px;color:var(--muted2);margin-top:4px;}
    .plan-price-old{font-size:12px;color:var(--muted);text-decoration:line-through;margin-right:6px;}
    .plan-price-badge{font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(0,229,160,.15);color:var(--accent);border:1px solid rgba(0,229,160,.2);vertical-align:middle;}
    .plan-divider{height:1px;background:var(--bd);margin:24px 0;}
    .plan-features{display:flex;flex-direction:column;gap:10px;margin-bottom:32px;}
    .pf{display:flex;align-items:flex-start;gap:10px;font-size:12px;line-height:1.4;}
    .pf-check{width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0;}
    .plan-card.basic .pf-check{background:rgba(56,189,248,.15);color:var(--blue);border:1px solid rgba(56,189,248,.2);}
    .plan-card.premium .pf-check{background:rgba(245,158,11,.15);color:var(--amber);border:1px solid rgba(245,158,11,.2);}
    .pf-tag{display:inline-block;margin-left:5px;font-size:8px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,.15);color:var(--amber);border:1px solid rgba(245,158,11,.2);vertical-align:middle;letter-spacing:.5px;}
    .compare-section{padding:72px 64px;}
    .compare-title{font-family:var(--fh);font-size:28px;font-weight:800;text-align:center;letter-spacing:-1px;margin-bottom:40px;}
    .compare-table{max-width:700px;margin:0 auto;border:1px solid var(--bd);border-radius:12px;overflow:hidden;}
    .compare-head{display:grid;grid-template-columns:2fr 1fr 1fr;background:var(--s2);padding:14px 20px;border-bottom:1px solid var(--bd);}
    .compare-head-cell{font-family:var(--fh);font-size:12px;font-weight:700;text-align:center;}
    .compare-head-cell:first-child{text-align:left;}
    .compare-head-cell.premium-col{color:var(--amber);}
    .compare-row{display:grid;grid-template-columns:2fr 1fr 1fr;padding:12px 20px;border-bottom:1px solid var(--bd);transition:background .1s;}
    .compare-row:last-child{border-bottom:none;}
    .compare-row:hover{background:var(--s2);}
    .compare-cell{font-size:11px;display:flex;align-items:center;justify-content:center;}
    .compare-cell:first-child{justify-content:flex-start;color:var(--muted2);}
    .cta-banner{margin:0 64px 72px;border-radius:16px;padding:52px 48px;background:linear-gradient(135deg,rgba(0,229,160,.06) 0%,rgba(245,158,11,.04) 100%);border:1px solid rgba(0,229,160,.15);text-align:center;position:relative;overflow:hidden;}
    .cta-banner::before{content:'';position:absolute;top:-80px;left:50%;transform:translateX(-50%);width:400px;height:200px;border-radius:50%;background:radial-gradient(ellipse,rgba(0,229,160,.06) 0%,transparent 70%);pointer-events:none;}
    .cta-banner>*{position:relative;z-index:1;}
    .cta-banner-title{font-family:var(--fh);font-size:28px;font-weight:800;letter-spacing:-1px;margin-bottom:10px;}
    .cta-banner-sub{color:var(--muted2);font-size:12px;margin-bottom:28px;}
    .cta-banner-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
    .faq-section{padding:0 64px 72px;max-width:680px;margin:0 auto;}
    .faq-title{font-family:var(--fh);font-size:24px;font-weight:800;text-align:center;letter-spacing:-0.5px;margin-bottom:32px;}
    .faq-item{border-bottom:1px solid var(--bd);}
    .faq-q{padding:16px 0;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:500;transition:color .13s;user-select:none;}
    .faq-q:hover,.faq-item.open .faq-q{color:var(--accent);}
    .faq-a{font-size:12px;color:var(--muted2);line-height:1.7;padding-bottom:16px;display:none;}
    .faq-item.open .faq-a{display:block;}
    .faq-arrow{transition:transform .2s;font-size:10px;}
    .faq-item.open .faq-arrow{transform:rotate(180deg);}
    .landing-footer{border-top:1px solid var(--bd);padding:28px 64px;display:flex;align-items:center;justify-content:space-between;background:var(--s1);font-size:11px;color:var(--muted);}
    .footer-logo{font-family:var(--fh);font-size:15px;font-weight:800;}
    .footer-logo em{color:var(--accent);font-style:normal;}
    @keyframes fadeUp{from{transform:translateY(16px);opacity:0;}to{transform:translateY(0);opacity:1;}}

    /* ── ANALYSE TABS ── */
    .atabs{display:flex;gap:4px;margin-bottom:24px;background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:4px;}
    .atab{flex:1;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;text-align:center;color:var(--muted2);transition:all .15s;border:1px solid transparent;}
    .atab:hover{color:var(--text);}
    .atab.on{background:var(--s3);color:var(--accent);border-color:var(--bd2);}

    /* ── CALENDAR ── */
    .cal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
    .cal-month{font-family:var(--fh);font-size:18px;font-weight:800;letter-spacing:-0.3px;}
    .cal-nav{display:flex;gap:6px;}
    .cal-nav-btn{background:var(--s2);border:1px solid var(--bd);border-radius:6px;color:var(--text);cursor:pointer;padding:5px 12px;font-size:12px;transition:all .13s;}
    .cal-nav-btn:hover{border-color:var(--accent);color:var(--accent);}
    .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}
    .cal-dow{text-align:center;font-size:9px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);padding:6px 0;font-weight:500;}
    .cal-day{min-height:72px;border-radius:8px;border:1px solid var(--bd);padding:8px;cursor:default;transition:all .15s;position:relative;background:var(--s1);}
    .cal-day.empty{background:transparent;border-color:transparent;}
    .cal-day.today{border-color:var(--accent);}
    .cal-day.has-trades{cursor:pointer;}
    .cal-day.has-trades:hover{border-color:var(--bd2);background:var(--s2);}
    .cal-day.win{border-color:rgba(0,229,160,.3);background:rgba(0,229,160,.04);}
    .cal-day.loss{border-color:rgba(255,77,109,.3);background:rgba(255,77,109,.04);}
    .cal-day-num{font-size:11px;font-weight:600;color:var(--muted2);margin-bottom:4px;}
    .cal-day.today .cal-day-num{color:var(--accent);}
    .cal-day-pnl{font-family:var(--fh);font-size:13px;font-weight:700;line-height:1;}
    .cal-day-count{font-size:9px;color:var(--muted2);margin-top:3px;letter-spacing:.3px;}
    .cal-day-dots{display:flex;gap:3px;margin-top:4px;flex-wrap:wrap;}
    .cal-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;}
    .cal-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
    .cal-stat{background:var(--s1);border:1px solid var(--bd);border-radius:8px;padding:14px 16px;text-align:center;}
    .cal-stat-val{font-family:var(--fh);font-size:20px;font-weight:700;letter-spacing:-0.5px;margin-bottom:3px;}
    .cal-stat-lbl{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted2);}

    /* ── MFE / MAE ── */
    .mae-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:22px;}
    .mae-card{background:var(--s1);border:1px solid var(--bd);border-radius:var(--r);padding:20px 22px;}
    .mae-title{font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px;font-weight:500;}
    .mae-subtitle{font-size:11px;color:var(--muted);margin-bottom:16px;line-height:1.5;}
    .mae-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
    .mae-asset{font-size:11px;min-width:80px;color:var(--muted2);}
    .mae-bar-wrap{flex:1;height:8px;background:var(--s3);border-radius:4px;overflow:hidden;}
    .mae-bar{height:100%;border-radius:4px;transition:width .4s;}
    .mae-val{font-size:11px;font-weight:600;min-width:52px;text-align:right;}
    .eff-row{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;padding:10px 14px;border-bottom:1px solid var(--bd);font-size:11px;align-items:center;}
    .eff-row:last-child{border-bottom:none;}
    .eff-row:hover{background:var(--s2);}
    .eff-bar-wrap{height:6px;background:var(--s3);border-radius:3px;overflow:hidden;}
    .eff-bar{height:100%;border-radius:3px;}

    /* ── TAGS ── */
    .tag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:9px;font-weight:600;letter-spacing:.5px;cursor:pointer;border:1px solid transparent;transition:all .13s;user-select:none;}
    .tag-input-wrap{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;background:var(--bg);border:1px solid var(--bd);border-radius:6px;min-height:38px;cursor:text;transition:border .13s;}
    .tag-input-wrap:focus-within{border-color:var(--accent);}
    .tag-input-wrap input{border:none;background:transparent;outline:none;font-family:var(--fm);font-size:12px;color:var(--text);min-width:80px;flex:1;padding:0;}
    .tag-input-wrap input::placeholder{color:var(--muted);}

    /* ── INTRADAY P&L ── */
    .intraday-timeline{position:relative;padding:20px 0;}
    .itl-line{position:absolute;left:110px;top:0;bottom:0;width:2px;background:var(--bd);}
    .itl-event{display:flex;align-items:flex-start;gap:14px;margin-bottom:20px;position:relative;}
    .itl-time{min-width:96px;text-align:right;font-size:11px;color:var(--muted2);padding-top:2px;}
    .itl-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;margin-top:3px;position:relative;z-index:1;border:2px solid var(--bg);}
    .itl-card{flex:1;background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 14px;transition:border-color .13s;}
    .itl-card:hover{border-color:var(--bd2);}
    .itl-card-title{font-size:12px;font-weight:600;margin-bottom:3px;display:flex;align-items:center;gap:8px;}
    .itl-card-sub{font-size:10px;color:var(--muted2);}
    .intraday-cumul{display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;margin-bottom:16px;}

    /* ── SHARE / COACH ── */
    .share-card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:24px;margin-bottom:14px;}
    .share-card-title{font-family:var(--fh);font-size:14px;font-weight:700;margin-bottom:4px;}
    .share-card-sub{font-size:11px;color:var(--muted2);margin-bottom:18px;line-height:1.6;}
    .mentor-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;margin-bottom:8px;}
    .mentor-avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--fh);font-size:13px;font-weight:700;flex-shrink:0;}
    .mentor-info{flex:1;}
    .mentor-name{font-size:12px;font-weight:600;}
    .mentor-access{font-size:9px;color:var(--muted2);text-transform:uppercase;letter-spacing:.8px;margin-top:2px;}
    .share-link-box{background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:10px 12px;font-size:10px;color:var(--muted2);word-break:break-all;display:flex;align-items:center;justify-content:space-between;gap:10px;}

    /* ── FACTURATION / STRIPE ── */
    .billing-hero{background:var(--s1);border:1px solid var(--bd);border-radius:14px;padding:28px 32px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;position:relative;overflow:hidden;}
    .billing-hero::before{content:'';position:absolute;top:-60px;right:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(0,229,160,.06),transparent 70%);pointer-events:none;}
    .billing-plan-name{font-family:var(--fh);font-size:22px;font-weight:800;letter-spacing:-0.5px;}
    .billing-plan-price{font-size:13px;color:var(--muted2);margin-top:3px;}
    .billing-status{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;}
    .billing-status.active{background:rgba(0,229,160,.1);color:var(--accent);border:1px solid rgba(0,229,160,.2);}
    .billing-status.trial{background:rgba(56,189,248,.1);color:var(--blue);border:1px solid rgba(56,189,248,.2);}
    .billing-status.canceled{background:rgba(255,77,109,.1);color:var(--red);border:1px solid rgba(255,77,109,.2);}
    .billing-status.free{background:rgba(78,93,115,.1);color:var(--muted2);border:1px solid var(--bd);}
    .billing-card{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:22px 24px;margin-bottom:14px;}
    .billing-card-title{font-family:var(--fh);font-size:13px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px;}
    .invoice-row{display:grid;grid-template-columns:1fr 1fr 1fr 100px;gap:10px;padding:11px 0;border-bottom:1px solid var(--bd);font-size:11px;align-items:center;}
    .invoice-row:last-child{border-bottom:none;}
    .invoice-row.header{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding-bottom:8px;}
    .invoice-badge{display:inline-flex;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:600;}
    .invoice-badge.paid{background:rgba(0,229,160,.1);color:var(--accent);}
    .invoice-badge.pending{background:rgba(245,158,11,.1);color:var(--amber);}
    .plan-switch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;}
    .plan-switch-card{background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:16px;cursor:pointer;transition:all .15s;text-align:center;position:relative;}
    .plan-switch-card:hover{border-color:var(--bd2);background:var(--s3);}
    .plan-switch-card.current{pointer-events:none;}
    .plan-switch-card.current.basic{border-color:var(--blue);background:rgba(56,189,248,.04);}
    .plan-switch-card.current.premium{border-color:var(--amber);background:rgba(245,158,11,.04);}
    .plan-switch-card.current.pro{border-color:#a78bfa;background:rgba(167,139,250,.04);}
    .psw-badge{position:absolute;top:-8px;left:50%;transform:translateX(-50%);padding:2px 10px;border-radius:10px;font-size:8px;font-weight:700;letter-spacing:.5px;white-space:nowrap;}
    .psw-name{font-family:var(--fh);font-size:13px;font-weight:700;margin:8px 0 4px;}
    .psw-price{font-size:11px;color:var(--muted2);}
    .payment-method-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:8px;}
    .card-brand{width:36px;height:24px;border-radius:4px;background:var(--s3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--muted2);border:1px solid var(--bd2);}
    .checkout-modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:32px;max-width:460px;width:100%;position:relative;}
    .checkout-price-big{font-family:var(--fh);font-size:40px;font-weight:800;letter-spacing:-2px;}
    .checkout-features{display:flex;flex-direction:column;gap:7px;margin:16px 0;}
    .checkout-feat{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted2);}
    .stripe-input{background:var(--bg);border:1px solid var(--bd);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text);font-family:var(--fm);width:100%;outline:none;transition:border .13s;}
    .stripe-input:focus{border-color:var(--accent);}
    .stripe-input::placeholder{color:var(--muted);}
    .card-input-row{display:grid;grid-template-columns:1fr 80px 60px;gap:8px;}
    .stripe-powered{display:flex;align-items:center;justify-content:center;gap:6px;font-size:9px;color:var(--muted);margin-top:12px;letter-spacing:.5px;text-transform:uppercase;}

    /* ── IMPORT CSV ── */
    .import-zone{border:2px dashed var(--bd2);border-radius:12px;padding:48px 32px;text-align:center;cursor:pointer;transition:all .2s;background:var(--s1);}
    .import-zone:hover,.import-zone.drag{border-color:var(--accent);background:rgba(0,229,160,.03);}
    .import-zone-icon{font-size:40px;margin-bottom:14px;}
    .import-zone-title{font-family:var(--fh);font-size:15px;font-weight:700;margin-bottom:6px;}
    .import-zone-sub{font-size:11px;color:var(--muted2);line-height:1.6;margin-bottom:20px;}
    .import-preview{background:var(--s2);border:1px solid var(--bd);border-radius:10px;overflow:hidden;margin-top:20px;}
    .import-preview-header{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;}
    .import-row{display:grid;font-size:10px;padding:8px 16px;border-bottom:1px solid var(--bd);}
    .import-row:last-child{border-bottom:none;}
    .import-row.header{background:var(--s3);font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--muted2);}
    .import-status{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;font-size:9px;}
    .import-status.ok{background:rgba(0,229,160,.1);color:var(--accent);}
    .import-status.warn{background:rgba(245,158,11,.1);color:var(--amber);}
    .import-status.err{background:rgba(255,77,109,.1);color:var(--red);}
    .broker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px;}
    .broker-card{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:14px;text-align:center;cursor:pointer;transition:all .15s;font-size:11px;}
    .broker-card:hover{border-color:var(--accent);background:var(--s3);}
    .broker-card.selected{border-color:var(--accent);background:rgba(0,229,160,.06);}
    .broker-icon{font-size:22px;margin-bottom:6px;}
    .broker-name{font-weight:600;font-size:10px;letter-spacing:.3px;}
    .broker-fmt{font-size:9px;color:var(--muted2);margin-top:2px;}

    /* ── HOURLY PERF ── */
    .heatmap-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;}
    .hm-cell{border-radius:6px;padding:10px 6px;text-align:center;cursor:default;transition:transform .13s;}
    .hm-cell:hover{transform:scale(1.05);}
    .hm-label{font-size:9px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted2);margin-bottom:4px;}
    .hm-val{font-family:var(--fh);font-size:13px;font-weight:700;}
    .hm-count{font-size:9px;color:var(--muted2);margin-top:2px;}
    .hour-legend{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--muted2);margin-top:12px;justify-content:flex-end;}
    .hl-dot{width:10px;height:10px;border-radius:2px;}

    /* ── NOTIFICATIONS IN-APP ── */
    .notif-bell{position:relative;cursor:pointer;padding:6px;border-radius:6px;color:var(--muted2);transition:color .13s;}
    .notif-bell:hover{color:var(--text);}
    .notif-dot{position:absolute;top:4px;right:4px;width:8px;height:8px;border-radius:50%;background:var(--red);border:2px solid var(--bg);}
    .notif-panel{position:absolute;top:calc(100% + 8px);right:0;width:340px;background:var(--s1);border:1px solid var(--bd);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:200;overflow:hidden;}
    .notif-header{padding:12px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;}
    .notif-title{font-family:var(--fh);font-size:12px;font-weight:700;}
    .notif-item{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--bd);cursor:pointer;transition:background .1s;}
    .notif-item:last-child{border-bottom:none;}
    .notif-item:hover{background:var(--s2);}
    .notif-item.unread{background:rgba(0,229,160,.03);}
    .notif-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;}
    .notif-body{flex:1;min-width:0;}
    .notif-msg{font-size:11px;line-height:1.5;}
    .notif-time{font-size:9px;color:var(--muted);margin-top:3px;}
    .notif-unread-badge{width:6px;height:6px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:4px;}

    /* ── TOOLTIP ONBOARDING ── */
    .tooltip-overlay{position:fixed;inset:0;z-index:300;pointer-events:none;}
    .tooltip-spotlight{position:absolute;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.65);pointer-events:none;transition:all .3s;}
    .tooltip-box{position:absolute;background:var(--s1);border:1px solid var(--accent);border-radius:12px;padding:16px 18px;width:260px;z-index:310;box-shadow:0 8px 32px rgba(0,0,0,.5);}
    .tooltip-step{font-size:9px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);margin-bottom:6px;}
    .tooltip-title{font-family:var(--fh);font-size:13px;font-weight:700;margin-bottom:6px;}
    .tooltip-text{font-size:11px;color:var(--muted2);line-height:1.6;margin-bottom:12px;}
    .tooltip-nav{display:flex;align-items:center;justify-content:space-between;}
    .tooltip-dots{display:flex;gap:4px;}
    .tooltip-dot{width:6px;height:6px;border-radius:50%;background:var(--bd2);transition:background .15s;}
    .tooltip-dot.active{background:var(--accent);}
    .tooltip-arrow{position:absolute;width:10px;height:10px;background:var(--s1);border:1px solid var(--accent);transform:rotate(45deg);}

    /* ── PROFIL PUBLIC ── */
    .profile-hero{background:linear-gradient(135deg,var(--s1),var(--s2));border:1px solid var(--bd);border-radius:14px;padding:32px;text-align:center;margin-bottom:16px;position:relative;overflow:hidden;}
    .profile-avatar-lg{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--fh);font-size:28px;font-weight:800;margin:0 auto 12px;border:3px solid var(--bd2);}
    .profile-name{font-family:var(--fh);font-size:22px;font-weight:800;margin-bottom:4px;}
    .profile-since{font-size:11px;color:var(--muted2);}
    .profile-stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;}
    .profile-stat{background:var(--s1);border:1px solid var(--bd);border-radius:10px;padding:14px;text-align:center;}
    .profile-stat-val{font-family:var(--fh);font-size:18px;font-weight:800;}
    .profile-stat-lbl{font-size:9px;color:var(--muted2);letter-spacing:.5px;text-transform:uppercase;margin-top:3px;}
    .profile-share-btn{display:flex;align-items:center;gap:6px;padding:8px 16px;background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.25);color:var(--accent);border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;transition:all .13s;}
    .profile-share-btn:hover{background:rgba(0,229,160,.18);}

    /* ── EXPORT PDF BUTTON ── */
    .export-btn{display:flex;align-items:center;gap:6px;padding:7px 14px;background:var(--s2);border:1px solid var(--bd);border-radius:7px;font-size:11px;cursor:pointer;color:var(--muted2);transition:all .13s;}
    .export-btn:hover{border-color:var(--accent);color:var(--accent);}
    .export-modal{background:var(--s1);border:1px solid var(--bd);border-radius:16px;padding:28px;max-width:420px;width:100%;}
    .export-preview{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:16px;margin:16px 0;font-size:10px;color:var(--muted2);line-height:2;}
    .export-section-title{font-family:var(--fh);font-size:11px;font-weight:700;margin:12px 0 6px;color:var(--text);}

    /* ── MOBILE BOTTOM NAV ── */
    .mobile-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--s1);border-top:1px solid var(--bd);z-index:100;padding:8px 0 max(8px,env(safe-area-inset-bottom));height:60px;}
    .mobile-nav-inner{display:flex;justify-content:space-around;align-items:center;height:100%;}
    .mobile-nav-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 10px;border-radius:8px;cursor:pointer;min-width:52px;color:var(--muted2);transition:color .13s;}
    .mobile-nav-item.active{color:var(--accent);}
    .mobile-nav-ico{font-size:18px;line-height:1;}
    .mobile-nav-lbl{font-size:9px;font-weight:600;letter-spacing:.3px;}
    .mobile-nav-more{position:fixed;bottom:68px;left:0;right:0;background:var(--s1);border-top:1px solid var(--bd);padding:12px 16px;z-index:99;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
    .mobile-more-item{display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;border-radius:8px;cursor:pointer;background:var(--s2);border:1px solid var(--bd);}
    .mobile-more-ico{font-size:20px;}
    .mobile-more-lbl{font-size:9px;color:var(--muted2);text-align:center;}
    .mobile-topbar{display:none;position:fixed;top:0;left:0;right:0;height:56px;background:var(--s1);border-bottom:1px solid var(--bd);z-index:100;align-items:center;padding:0 16px;gap:12px;}
    .mobile-topbar-logo{font-family:var(--fh);font-size:16px;font-weight:900;flex:1;}
    .mobile-topbar-logo em{color:var(--accent);font-style:normal;}
    .mobile-content{padding-bottom:72px;padding-top:0;}

    /* ── TABLET (860px) ── */
    @media(max-width:860px){
      .sidebar{display:none;}
      .mobile-topbar{display:flex;}
      .mobile-nav{display:block;}
      .app-shell{padding-left:0;margin-top:56px;}
      .content-pad{padding:14px 14px 80px;}
      .mobile-content{padding-bottom:80px;}
      .plans-grid,.plan-choice-grid{grid-template-columns:1fr;max-width:460px;margin:0 auto;}
      .kpi-grid{grid-template-columns:repeat(2,1fr);}
      .chart-row,.chart-row-2{grid-template-columns:1fr;}
      .billing-hero{flex-direction:column;align-items:flex-start;}
      .plan-switch-grid{grid-template-columns:1fr;}
      .profile-stats-row{grid-template-columns:repeat(2,1fr);}
      .invoice-row{grid-template-columns:1fr 1fr 80px;font-size:10px;}
      .invoice-row .invoice-date-col{display:none;}
      .hero,.plans-section,.compare-section,.cta-banner,.faq-section,.landing-footer{padding-left:20px;padding-right:20px;}
      .cta-banner{margin-left:0;margin-right:0;border-radius:0;}
      .onboard-form{padding:0 8px;}
      .topbar{display:none;}
      .compare-table{overflow-x:auto;}
      table{font-size:11px;}
      .checkout-modal{margin:0 12px;padding:20px;}
      .notif-panel{width:calc(100vw - 32px);right:-8px;}
    }

    /* ── MOBILE (480px) ── */
    @media(max-width:480px){
      .kpi-grid{grid-template-columns:1fr 1fr;}
      .kpi-card{padding:12px;}
      .kpi-val{font-size:20px;}
      .plan-switch-grid,.profile-stats-row{grid-template-columns:1fr 1fr;}
      .cta-banner-btns{flex-direction:column;align-items:stretch;}
      .cta-banner-btns .btn{justify-content:center;}
      .modal{margin:8px;max-height:calc(100dvh - 16px);}
      .checkout-modal{padding:18px 14px;}
      .checkout-price-big{font-size:32px;}
      .card-input-row{grid-template-columns:1fr 70px 56px;}
      .trade-detail-grid{grid-template-columns:1fr 1fr;}
      .topbar-right .btn-sm{display:none;}
      .export-preview{font-size:9px;}
    }
  `}</style>
);

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ASSETS = [
  // Crypto
  "BTC/USD","ETH/USD","XRP/USD","SOL/USD","BNB/USD","DOGE/USD","ADA/USD","MATIC/USD","LTC/USD",
  // Forex
  "EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CHF","EUR/GBP","GBP/JPY","NZD/USD","USD/CAD","EUR/JPY",
  // Indices boursiers
  "SP500","NAS100","DOW30","DAX40","CAC40","FTSE100","NIKKEI225","ASX200",
  // Indices synthétiques (Deriv/Boom & Crash)
  "V75","V25","V10","CRASH500","CRASH1000","BOOM500","BOOM1000","STEP INDEX",
  // Matières premières
  "OR","ARGENT","PÉTROLE","GAZ","CUIVRE",
];
const ASSET_TYPE = {
  "BTC/USD":"crypto","ETH/USD":"crypto","XRP/USD":"crypto","SOL/USD":"crypto","BNB/USD":"crypto","DOGE/USD":"crypto","ADA/USD":"crypto","MATIC/USD":"crypto","LTC/USD":"crypto",
  "EUR/USD":"forex","GBP/USD":"forex","USD/JPY":"forex","AUD/USD":"forex","USD/CHF":"forex","EUR/GBP":"forex","GBP/JPY":"forex","NZD/USD":"forex","USD/CAD":"forex","EUR/JPY":"forex",
  "SP500":"index","NAS100":"index","DOW30":"index","DAX40":"index","CAC40":"index","FTSE100":"index","NIKKEI225":"index","ASX200":"index",
  "V75":"synth","V25":"synth","V10":"synth","CRASH500":"synth","CRASH1000":"synth","BOOM500":"synth","BOOM1000":"synth","STEP INDEX":"synth",
  "OR":"gold","ARGENT":"gold","PÉTROLE":"commodity","GAZ":"commodity","CUIVRE":"commodity",
};
const ASSET_ICON = {crypto:"₿",forex:"€",gold:"◈",index:"◉",synth:"◬",commodity:"⬡"};
const EMOTIONS = ["Calme","Concentré","Stressé","Euphorique","Frustré","Satisfait","Anxieux","Neutre","Confiant","Hésitant"];
const AVATAR_COLORS = ["#00e5a0","#38bdf8","#f59e0b","#a78bfa","#ff4d6d"];

const fmt    = (n,d=2) => n==null?"—":Number(n).toLocaleString("fr-FR",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtPnl = (n)    => n==null?<span className="amb">En cours</span>:<span className={n>=0?"pos":"neg"}>{n>=0?"+":""}{fmt(n)} $</span>;
const calcR  = (t)    => { if(!t.pnl||!t.sl||!t.entry)return null; const risk=Math.abs(t.entry-t.sl)*t.size; return risk>0?parseFloat((t.pnl/risk).toFixed(2)):null; };
const initials = (name) => name ? name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase() : "?";
const avatarColor = (email) => AVATAR_COLORS[(email?.charCodeAt(0)||0) % AVATAR_COLORS.length];

// ─────────────────────────────────────────────────────────────────────────────
// SEED DATA
// ─────────────────────────────────────────────────────────────────────────────
const SEED_ACCOUNTS = [
  {id:"acc1",name:"Compte Réel",type:"Réel",balance:10000,currency:"$"},
  {id:"acc2",name:"Compte Démo",type:"Démo",balance:50000,currency:"$"},
];
const daysAgo = (d) => { const dt = new Date(); dt.setDate(dt.getDate()-d); return dt.toISOString().slice(0,10); };
const SEED_TRADES = [
  {id:1,accountId:"acc1",date:daysAgo(5),time:"09:32",asset:"BTC/USD",direction:"LONG",entry:94200,exit:97800,sl:92000,tp:99000,size:0.5,fees:18,setup:"Breakout confirmation",emotion_before:"Calme",emotion_after:"Euphorique",pnl:1800,status:"CLOSED",notes:"Bon setup, plan respecté.",checklist:[true,true,true,true,true],tags:["plan-respecté","london-session"],intraday:[{time:"09:32",event:"Entrée",pnl:0},{time:"10:15",event:"Résistance testée",pnl:320},{time:"11:40",event:"Break + accélération",pnl:950},{time:"13:05",event:"Sortie TP",pnl:1800}]},
  {id:2,accountId:"acc1",date:daysAgo(10),time:"14:15",asset:"EUR/USD",direction:"SHORT",entry:1.092,exit:1.0845,sl:1.096,tp:1.082,size:10000,fees:5,setup:"Résistance clé",emotion_before:"Concentré",emotion_after:"Calme",pnl:750,status:"CLOSED",notes:"Excellent ratio R/R.",checklist:[true,true,true,true,false],tags:["ny-session","scaled-out"],intraday:[{time:"14:15",event:"Entrée short",pnl:0},{time:"14:50",event:"Pullback",pnl:-120},{time:"15:30",event:"Reprise baissière",pnl:400},{time:"16:00",event:"Sortie partielle",pnl:750}]},
  {id:3,accountId:"acc1",date:daysAgo(20),time:"11:00",asset:"OR",direction:"LONG",entry:2680,exit:2650,sl:2660,tp:2720,size:1,fees:8,setup:"Support dynamique",emotion_before:"Stressé",emotion_after:"Frustré",pnl:-308,status:"CLOSED",notes:"Entré trop tôt.",checklist:[true,false,true,true,false],tags:["FOMO","over-leveraged"],intraday:[{time:"11:00",event:"Entrée prématurée",pnl:0},{time:"11:25",event:"Stop touché",pnl:-308}]},
  {id:4,accountId:"acc1",date:daysAgo(25),time:"16:45",asset:"ETH/USD",direction:"LONG",entry:3240,exit:3390,sl:3150,tp:3450,size:2,fees:12,setup:"Pattern harmonique",emotion_before:"Calme",emotion_after:"Calme",pnl:288,status:"CLOSED",notes:"",checklist:[true,true,true,true,true],tags:["plan-respecté"],intraday:[{time:"16:45",event:"Entrée",pnl:0},{time:"17:30",event:"Objectif 50%",pnl:150},{time:"18:15",event:"Sortie",pnl:288}]},
  {id:5,accountId:"acc1",date:daysAgo(3),time:"10:20",asset:"BTC/USD",direction:"SHORT",entry:101500,exit:null,sl:103000,tp:97000,size:0.3,fees:9,setup:"Résistance clé",emotion_before:"Concentré",emotion_after:null,pnl:null,status:"OPEN",notes:"",checklist:[true,true,true,true,true],tags:["london-session"],intraday:[]},
  {id:6,accountId:"acc1",date:daysAgo(45),time:"13:55",asset:"EUR/USD",direction:"LONG",entry:1.078,exit:1.083,sl:1.074,tp:1.086,size:10000,fees:5,setup:"Breakout confirmation",emotion_before:"Calme",emotion_after:"Satisfait",pnl:500,status:"CLOSED",notes:"Setup propre.",checklist:[true,true,true,true,true],tags:["plan-respecté","ny-session"],intraday:[]},
  {id:7,accountId:"acc1",date:daysAgo(60),time:"09:10",asset:"OR",direction:"SHORT",entry:2730,exit:2695,sl:2760,tp:2680,size:1,fees:8,setup:"Résistance clé",emotion_before:"Calme",emotion_after:"Calme",pnl:342,status:"CLOSED",notes:"",checklist:[true,true,true,true,true],tags:[],intraday:[]},
  {id:8,accountId:"acc1",date:daysAgo(75),time:"15:00",asset:"BTC/USD",direction:"LONG",entry:98400,exit:96000,sl:96500,tp:104000,size:0.2,fees:8,setup:"Support dynamique",emotion_before:"Anxieux",emotion_after:"Frustré",pnl:-488,status:"CLOSED",notes:"Stop trop serré.",checklist:[true,false,true,false,true],tags:["revenge-trade","over-leveraged"],intraday:[]},
  {id:9,accountId:"acc1",date:daysAgo(15),time:"10:05",asset:"XRP/USD",direction:"LONG",entry:2.85,exit:3.12,sl:2.7,tp:3.3,size:1000,fees:4,setup:"Breakout confirmation",emotion_before:"Confiant",emotion_after:"Euphorique",pnl:266,status:"CLOSED",notes:"",checklist:[true,true,true,true,true],tags:["london-session","scaled-in"],intraday:[]},
];
const DEFAULT_SETUPS    = [{id:"s1",name:"Breakout confirmation"},{id:"s2",name:"Résistance clé"},{id:"s3",name:"Support dynamique"},{id:"s4",name:"Pattern harmonique"}];
const DEFAULT_CHECKLIST = ["Le trend est-il confirmé ?","Le R/R est-il > 2 ?","Stop bien placé ?","Pas d'over-trading","Volume cohérent ?"];
const DEFAULT_TAGS      = ["revenge-trade","FOMO","patient","scaled-in","scaled-out","news","london-session","ny-session","asian-session","over-leveraged","plan-respecté"];
const TAG_COLORS        = ["#00e5a0","#38bdf8","#f59e0b","#a78bfa","#ff4d6d","#fb923c","#34d399","#818cf8"];
const tagColor = (tag) => TAG_COLORS[tag.split("").reduce((a,c)=>a+c.charCodeAt(0),0) % TAG_COLORS.length];

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD STRENGTH
// ─────────────────────────────────────────────────────────────────────────────
const pwdStrength = (pwd) => {
  if (!pwd) return 0;
  let s = 0;
  if (pwd.length >= 8)  s++;
  if (/[A-Z]/.test(pwd)) s++;
  if (/[0-9]/.test(pwd)) s++;
  if (/[^A-Za-z0-9]/.test(pwd)) s++;
  return s;
};
const pwdLabels = ["","Faible","Moyen","Bon","Fort"];

// ─────────────────────────────────────────────────────────────────────────────
// ── AUTH SCREENS ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function LoginPage({ onLogin, onGoRegister }) {
  const [email, setEmail]   = useState("");
  const [pwd, setPwd]       = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const handleSubmit = async () => {
    setError("");
    if (!email || !pwd) { setError("Veuillez remplir tous les champs."); return; }
    if (!/\S+@\S+\.\S+/.test(email)) { setError("Adresse email invalide."); return; }
    setLoading(true);
    try {
      // 🔌 APPEL BACKEND RÉEL
      const data = await API.auth.login({ email, password: pwd });
      tokenStore.set(data.accessToken, data.refreshToken);
      onLogin(data.user);
    } catch (err) {
      // Fallback démo si backend non disponible
      if (err.message.includes("fetch") || err.message.includes("Failed")) {
        onLogin({ id:"u1", name: email.split("@")[0], email, plan:"basic", avatar:null });
      } else {
        setError(err.message || "Email ou mot de passe incorrect.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    // En prod: window.location.href = `${API_BASE}/auth/google`
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      onLogin({ id:"u_g", name:"Trader Google", email:"trader@gmail.com", plan:"basic", avatar:null, provider:"google" });
    }, 700);
  };

  return (
    <div className="auth-root">
      <div className="auth-bg"/><div className="auth-grid"/>
      <div className="auth-card">
        <div className="auth-logo">EDGE<em>LOG</em><sup>v2</sup></div>
        <div className="auth-tagline">Journal de trading professionnel</div>

        <div className="auth-title">Bienvenue</div>
        <div className="auth-sub">Connectez-vous pour accéder à votre journal.</div>

        {error && <div className="auth-error">⚠ {error}</div>}

        {/* Google OAuth */}
        <button className="btn btn-google" onClick={handleGoogle} disabled={loading}>
          <span className="google-icon">
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
          </span>
          Continuer avec Google
        </button>

        <div className="auth-divider">ou</div>

        <div className="fg">
          <label>Adresse email</label>
          <div className="input-icon">
            <span className="ii">@</span>
            <input type="email" placeholder="vous@exemple.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}/>
          </div>
        </div>
        <div className="fg">
          <label>Mot de passe</label>
          <div className="input-icon" style={{position:"relative"}}>
            <span className="ii">🔑</span>
            <input type={showPwd?"text":"password"} placeholder="••••••••" value={pwd} onChange={e=>setPwd(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()} style={{paddingRight:36}}/>
            <button className="input-eye" onClick={()=>setShowPwd(s=>!s)}>{showPwd?"🙈":"👁"}</button>
          </div>
        </div>
        <div style={{textAlign:"right",marginTop:-8,marginBottom:16}}>
          <span style={{fontSize:10,color:"var(--accent)",cursor:"pointer"}}>Mot de passe oublié ?</span>
        </div>

        <button className="btn btn-primary btn-full btn-lg" onClick={handleSubmit} disabled={loading}>
          {loading ? "Connexion…" : "Se connecter →"}
        </button>

        <div className="auth-footer">
          Pas encore de compte ? <a onClick={onGoRegister}>Créer un compte</a>
        </div>
      </div>
    </div>
  );
}

function RegisterPage({ onRegister, onGoLogin }) {
  const [name, setName]       = useState("");
  const [email, setEmail]     = useState("");
  const [pwd, setPwd]         = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const strength = pwdStrength(pwd);

  const handleSubmit = async () => {
    setError("");
    if (!name || !email || !pwd || !confirm) { setError("Tous les champs sont obligatoires."); return; }
    if (!/\S+@\S+\.\S+/.test(email))          { setError("Adresse email invalide."); return; }
    if (pwd.length < 8)                        { setError("Le mot de passe doit faire au moins 8 caractères."); return; }
    if (pwd !== confirm)                       { setError("Les mots de passe ne correspondent pas."); return; }
    setLoading(true);
    try {
      // 🔌 APPEL BACKEND RÉEL
      const data = await API.auth.register({ name, email, password: pwd });
      tokenStore.set(data.accessToken, data.refreshToken);
      onRegister(data.user);
    } catch (err) {
      if (err.message.includes("fetch") || err.message.includes("Failed")) {
        onRegister({ id:"u_new", name, email, plan:"basic", avatar:null });
      } else {
        setError(err.message || "Impossible de créer le compte.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = () => {
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      onRegister({ id:"u_g2", name:"Trader Google", email:"new@gmail.com", plan:"basic", avatar:null, provider:"google" });
    }, 700);
  };

  return (
    <div className="auth-root">
      <div className="auth-bg"/><div className="auth-grid"/>
      <div className="auth-card">
        <div className="auth-logo">EDGE<em>LOG</em><sup>v2</sup></div>
        <div className="auth-tagline">Journal de trading professionnel</div>
        <div className="auth-title">Créer un compte</div>
        <div className="auth-sub">Gratuit · Aucune carte requise · Démarrez en 30 secondes.</div>

        {error && <div className="auth-error">⚠ {error}</div>}

        <button className="btn btn-google" onClick={handleGoogle} disabled={loading}>
          <span className="google-icon">
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
          </span>
          S'inscrire avec Google
        </button>

        <div className="auth-divider">ou</div>

        <div className="fg">
          <label>Nom complet</label>
          <div className="input-icon">
            <span className="ii">◈</span>
            <input type="text" placeholder="Jean Dupont" value={name} onChange={e=>setName(e.target.value)}/>
          </div>
        </div>
        <div className="fg">
          <label>Adresse email</label>
          <div className="input-icon">
            <span className="ii">@</span>
            <input type="email" placeholder="vous@exemple.com" value={email} onChange={e=>setEmail(e.target.value)}/>
          </div>
        </div>
        <div className="fg">
          <label>Mot de passe</label>
          <div className="input-icon" style={{position:"relative"}}>
            <span className="ii">🔑</span>
            <input type={showPwd?"text":"password"} placeholder="Min. 8 caractères" value={pwd} onChange={e=>setPwd(e.target.value)} style={{paddingRight:36}}/>
            <button className="input-eye" onClick={()=>setShowPwd(s=>!s)}>{showPwd?"🙈":"👁"}</button>
          </div>
          {pwd && (
            <div className="pwd-strength">
              {[1,2,3,4].map(i=><div key={i} className={`pwd-seg${i<=strength?" fill-"+strength:""}`}/>)}
              <span className="pwd-label">{pwdLabels[strength]}</span>
            </div>
          )}
        </div>
        <div className="fg">
          <label>Confirmer le mot de passe</label>
          <div className="input-icon">
            <span className="ii">🔒</span>
            <input type="password" placeholder="••••••••" value={confirm} onChange={e=>setConfirm(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleSubmit()}
              style={{borderColor: confirm && confirm!==pwd ? "var(--red)" : ""}}/>
          </div>
          {confirm && confirm!==pwd && <div style={{fontSize:10,color:"var(--red)",marginTop:2}}>Les mots de passe ne correspondent pas</div>}
        </div>

        <button className="btn btn-primary btn-full btn-lg" onClick={handleSubmit} disabled={loading}>
          {loading ? "Création du compte…" : "Créer mon compte →"}
        </button>
        <div style={{fontSize:10,color:"var(--muted2)",textAlign:"center",marginTop:10,lineHeight:1.6}}>
          En créant un compte, vous acceptez nos <span style={{color:"var(--accent)",cursor:"pointer"}}>CGU</span> et notre <span style={{color:"var(--accent)",cursor:"pointer"}}>politique de confidentialité</span>.
        </div>
        <div className="auth-footer">
          Déjà un compte ? <a onClick={onGoLogin}>Se connecter</a>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ONBOARDING ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function OnboardingFlow({ user, onComplete }) {
  const [step, setStep]           = useState(0); // 0=welcome, 1=plan, 2=account
  const [selectedPlan, setPlan]   = useState("basic");
  const [accountName, setAcName]  = useState("Compte Réel");
  const [accountType, setAcType]  = useState("Réel");
  const [balance, setBalance]     = useState("10000");

  const steps = ["Bienvenue", "Votre formule", "Premier compte"];
  const totalSteps = steps.length;

  const handleFinish = () => {
    onComplete({
      plan: selectedPlan,
      firstAccount: { name: accountName, type: accountType, balance: parseFloat(balance)||10000 },
    });
  };

  return (
    <div className="onboard-root">
      <div className="onboard-bg"/><div className="onboard-grid"/>
      <div className="onboard-inner">
        {/* Progress */}
        <div className="onboard-step">Étape {step+1} sur {totalSteps} — {steps[step]}</div>
        <div className="onboard-progress">
          {steps.map((_,i)=>(
            <div key={i} className={`op-dot${i<step?" done":i===step?" active":""}`}/>
          ))}
        </div>

        {/* ── STEP 0 : Welcome ── */}
        {step === 0 && (
          <div style={{textAlign:"center",maxWidth:560,margin:"0 auto"}}>
            <div style={{fontSize:52,marginBottom:20}}>👋</div>
            <h1 className="onboard-title">Bienvenue, {user?.name?.split(" ")[0] || "Trader"} !</h1>
            <p className="onboard-sub">
              Votre compte EDGELOG est prêt.<br/>
              En 2 étapes, configurons votre espace de trading.
            </p>
            <div style={{display:"flex",gap:24,justifyContent:"center",marginBottom:40,flexWrap:"wrap"}}>
              {[{ico:"📋",t:"Journal complet",d:"Saisissez chaque trade avec entrée, sortie, émotions et notes."},
                {ico:"📊",t:"Analyses automatiques",d:"Win rate, profit factor, drawdown — calculés en temps réel."},
                {ico:"🧠",t:"Psychologie",d:"Comprenez l'impact de vos émotions sur vos performances."}].map(c=>(
                <div key={c.t} style={{background:"var(--s1)",border:"1px solid var(--bd)",borderRadius:12,padding:"20px 18px",maxWidth:200,textAlign:"left"}}>
                  <div style={{fontSize:22,marginBottom:8}}>{c.ico}</div>
                  <div style={{fontFamily:"var(--fh)",fontSize:12,fontWeight:700,marginBottom:4}}>{c.t}</div>
                  <div style={{fontSize:10,color:"var(--muted2)",lineHeight:1.5}}>{c.d}</div>
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-lg" onClick={()=>setStep(1)}>C'est parti →</button>
          </div>
        )}

        {/* ── STEP 1 : Plan ── */}
        {step === 1 && (
          <>
            <h1 className="onboard-title">Choisissez votre formule</h1>
            <p className="onboard-sub">Vous pourrez changer à tout moment. 14 jours d'essai gratuit sur Premium · 30 jours de psychologie offerts sur Basic.</p>
            <div className="plan-choice-grid" style={{gridTemplateColumns:"repeat(3,1fr)",maxWidth:860}}>
              {/* Basic */}
              <div className={`plan-choice basic${selectedPlan==="basic"?" selected":""}`} onClick={()=>setPlan("basic")}>
                <div className="pc-icon">🌱</div>
                <div className="pc-name">Basic</div>
                <div className="pc-price">Gratuit</div>
                <div className="pc-feats">
                  {["Journal (15 trades max)","Dashboard & KPIs","Psychologie 30 jours d'essai","Checklist pré-trade","2 comptes"].map(f=><div key={f} className="pc-feat">{f}</div>)}
                </div>
                <div className="pc-select"><div className="pc-radio"/>{selectedPlan==="basic"?"Sélectionné":"Choisir Basic"}</div>
              </div>
              {/* Premium */}
              <div className={`plan-choice premium${selectedPlan==="premium"?" selected":""}`} onClick={()=>setPlan("premium")}>
                <div className="plan-choice-badge">✦ Recommandé</div>
                <div className="pc-icon">⚡</div>
                <div className="pc-name">Premium</div>
                <div className="pc-price">9,99 € / mois</div>
                <div className="pc-feats">
                  {["100 trades / mois","Historique 3 mois","Psychologie complète","Calendrier P&L","Analyses avancées","Comptes illimités"].map(f=><div key={f} className="pc-feat">{f}</div>)}
                </div>
                <div className="pc-select"><div className="pc-radio"/>{selectedPlan==="premium"?"Sélectionné":"Choisir Premium"}</div>
              </div>
              {/* Pro */}
              <div className={`plan-choice pro${selectedPlan==="pro"?" selected":""}`} onClick={()=>setPlan("pro")}>
                <div className="plan-choice-badge" style={{background:"rgba(245,158,11,.2)",color:"var(--amber)",borderColor:"rgba(245,158,11,.3)"}}>◆ Pro</div>
                <div className="pc-icon">🚀</div>
                <div className="pc-name" style={{color:"var(--amber)"}}>Premium Pro</div>
                <div className="pc-price" style={{fontSize:16,color:"#a78bfa"}}>Sur demande</div>
                <div className="pc-feats">
                  {["Trades illimités","Historique illimité","Import CSV automatique","API courtiers & Prop Firms","Courbe comportementale IA","Prévision de performance"].map(f=><div key={f} className="pc-feat">{f}</div>)}
                </div>
                <div className="pc-select" style={{borderColor:selectedPlan==="pro"?"var(--amber)":""}}><div className="pc-radio" style={{borderColor:"var(--amber)",background:selectedPlan==="pro"?"var(--amber)":""}}/>{selectedPlan==="pro"?"Sélectionné":"Choisir Pro"}</div>
              </div>
            </div>
            {(selectedPlan==="premium"||selectedPlan==="pro") && (
              <div style={{textAlign:"center",fontSize:11,color:"var(--muted2)",marginBottom:24}}>
                ✓ 14 jours d'essai gratuit · Sans engagement · Sans carte bancaire
              </div>
            )}
          </>
        )}

        {/* ── STEP 2 : First account ── */}
        {step === 2 && (
          <>
            <h1 className="onboard-title">Configurez votre premier compte</h1>
            <p className="onboard-sub">Vous pourrez ajouter d'autres comptes plus tard (démo, prop firm…).</p>
            <div className="onboard-form">
              <div className="fg">
                <label>Nom du compte</label>
                <div className="input-icon">
                  <span className="ii">◈</span>
                  <input type="text" value={accountName} onChange={e=>setAcName(e.target.value)} placeholder="ex: Compte Réel FX"/>
                </div>
              </div>
              <div className="form-grid">
                <div className="fg">
                  <label>Type de compte</label>
                  <select value={accountType} onChange={e=>setAcType(e.target.value)}>
                    <option>Réel</option>
                    <option>Démo</option>
                    <option>Prop Firm</option>
                  </select>
                </div>
                <div className="fg">
                  <label>Capital de départ ($)</label>
                  <div className="input-icon">
                    <span className="ii">$</span>
                    <input type="number" value={balance} onChange={e=>setBalance(e.target.value)} placeholder="10000"/>
                  </div>
                </div>
              </div>
              {/* Summary card */}
              <div style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:10,padding:"16px 18px",marginTop:8}}>
                <div style={{fontSize:9,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:10}}>Récapitulatif</div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
                  <span style={{color:"var(--muted2)"}}>Utilisateur</span>
                  <span style={{fontWeight:600}}>{user?.name || "—"}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
                  <span style={{color:"var(--muted2)"}}>Plan</span>
                  <span style={{color:selectedPlan==="pro"?"var(--amber)":selectedPlan==="premium"?"var(--accent)":"var(--blue)",fontWeight:600}}>
                    {selectedPlan==="pro"?"Premium Pro 🚀":selectedPlan==="premium"?"Premium ⚡":"Basic 🌱"}
                  </span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
                  <span style={{color:"var(--muted2)"}}>Compte</span>
                  <span style={{fontWeight:600}}>{accountName||"—"} ({accountType})</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                  <span style={{color:"var(--muted2)"}}>Capital initial</span>
                  <span style={{color:"var(--accent)",fontWeight:600}}>{fmt(parseFloat(balance)||0,0)} $</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Navigation */}
        <div className="onboard-nav">
          <button className="btn btn-ghost" onClick={()=>step>0?setStep(s=>s-1):null} style={{visibility:step===0?"hidden":"visible"}}>← Retour</button>
          {step < totalSteps-1
            ? <button className="btn btn-primary btn-lg" onClick={()=>setStep(s=>s+1)}>Continuer →</button>
            : <button className="btn btn-primary btn-lg" onClick={handleFinish}>Accéder au dashboard →</button>
          }
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function PremiumGate({ title, description, features=[], setPage, requirePro=false }) {
  return (
    <div className="premium-gate">
      <div className="pg-icon">{requirePro?"🚀":"⚡"}</div>
      <div className="pg-title">{title}</div>
      <div className="pg-desc">{description}</div>
      {features.length>0 && <div className="pg-features">{features.map(f=><div key={f} className="pg-feat">{f}</div>)}</div>}
      <button className={`btn ${requirePro?"btn-amber":"btn-primary"} btn-lg`} onClick={()=>setPage("offres")}>
        {requirePro?"Passer à Premium Pro 🚀":"Passer à Premium ⚡"} →
      </button>
      <div style={{fontSize:10,color:"var(--muted2)",marginTop:10}}>14 jours gratuits · Sans engagement · Sans CB</div>
    </div>
  );
}

function PsychTrialBanner({ daysLeft, setPage }) {
  return (
    <div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.25)",borderRadius:10,padding:"12px 18px",marginBottom:16,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <div style={{fontSize:11,color:"var(--amber)"}}>
        🧠 <strong>Période d'essai psychologie — {daysLeft} jour{daysLeft>1?"s":""} restant{daysLeft>1?"s":""}</strong> sur 30 jours offerts.
        <span style={{color:"var(--muted2)",marginLeft:6}}>Passez à Premium pour garder l'accès.</span>
      </div>
      <button className="btn btn-amber btn-sm" onClick={()=>setPage("offres")}>Passer à Premium</button>
    </div>
  );
}

function LimitBanner({ current, max, plan, setPage }) {
  const label = plan==="basic" ? "Basic (15 max)" : "Premium (100 max)";
  const nextPlan = plan==="basic" ? "Premium" : "Premium Pro";
  return (
    <div className="limit-banner">
      <div className="lb-left">
        <span style={{fontSize:18}}>⚠</span>
        <div className="lb-text">
          <strong>{current>=max?`Limite de trades atteinte`:`${current} / ${max} trades utilisés`}</strong>
          <span>{current>=max?`Vous avez atteint la limite du plan ${label}.`:`Il vous reste ${max-current} trade${max-current>1?"s":""} sur ${label}.`}</span>
        </div>
      </div>
      <button className="btn btn-amber btn-sm" onClick={()=>setPage("offres")}>Passer à {nextPlan}</button>
    </div>
  );
}

function HistoryNotice({ plan, setPage }) {
  const months = plan==="premium" ? 3 : 1;
  return (
    <div className="history-notice">
      <span>ℹ</span>
      <span>Vous visualisez les <strong>{plan==="premium"?"3 derniers mois":"30 derniers jours"}</strong> ({PLANS[plan]?.label}). <span style={{cursor:"pointer",textDecoration:"underline"}} onClick={()=>setPage("offres")}>Passez à {plan==="premium"?"Premium Pro":"Premium"}</span> pour l'historique illimité.</span>
    </div>
  );
}

function DevUpgradeToggle({ user, onToggle }) {
  const plan = user?.plan||"basic";
  const colors = {basic:"var(--blue)",premium:"var(--accent)",pro:"var(--amber)"};
  const labels = {basic:"Basic 🌱",premium:"Premium ⚡",pro:"Premium Pro 🚀"};
  return (
    <div className="dev-upgrade">
      <div className="dev-upgrade-title">🛠 Dev — Plan simulé</div>
      <div className="dev-toggle" style={{flexDirection:"column",gap:6,alignItems:"flex-start"}}>
        <span style={{fontSize:11}}>Plan actuel : <strong style={{color:colors[plan]}}>{labels[plan]}</strong></span>
        <button className="btn btn-ghost btn-sm" onClick={onToggle} style={{width:"100%",justifyContent:"center",fontSize:10}}>
          Changer → {labels[{basic:"premium",premium:"pro",pro:"basic"}[plan]]}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Tous les useState en premier (règle des hooks React) ──────
  const [authState,        setAuthState]       = useState("login");
  const [user,             setUser]            = useState(null);
  const [toast,            setToast]           = useState(null);
  const [pwaInstallable,   setPwaInstallable]  = useState(false);
  const [pwaPrompt,        setPwaPrompt]       = useState(null);
  const [page,             setPage]            = useState("landing");
  const [accounts,         setAccounts]        = useState(SEED_ACCOUNTS);
  const [activeAccount,    setActiveAccount]   = useState("acc1");
  const [allTrades,        setAllTrades]       = useState(SEED_TRADES);
  const [apiSynced,        setApiSynced]       = useState(false);
  const [setups]           = useState(DEFAULT_SETUPS);
  const [checklist]        = useState(DEFAULT_CHECKLIST);
  const [showTradeModal,   setShowTradeModal]  = useState(false);
  const [editTrade,        setEditTrade]       = useState(null);
  const [detailTrade,      setDetailTrade]     = useState(null);
  const [showAccountModal, setShowAccountModal]= useState(false);
  const [showNotif,        setShowNotif]       = useState(false);
  const [showMobileMore,   setShowMobileMore]  = useState(false);
  const [showTooltipGuide, setShowTooltipGuide]= useState(false);
  const [tooltipStep,      setTooltipStep]     = useState(0);
  const [notifications,    setNotifications]   = useState([
    {id:1, ico:"🎉", color:"var(--accent)", msg:"Bienvenue sur EDGELOG ! Ajoutez votre premier trade pour commencer.", time:"À l'instant", read:false, link:"trades"},
    {id:2, ico:"🧠", color:"var(--blue)",   msg:"Votre essai psychologie démarre — 30 jours gratuits.", time:"Il y a 1min", read:false, link:"psychology"},
    {id:3, ico:"◆",  color:"var(--amber)",  msg:"Découvrez les plans Premium pour débloquer le calendrier et les analyses.", time:"Il y a 2min", read:true, link:"offres"},
  ]);

  // ── showToast défini tôt pour être disponible dans tous les handlers ──
  const showToast = (msg, type="ok") => { setToast({msg,type}); setTimeout(()=>setToast(null),3200); };

  // ── PWA Registration ──────────────────────────────────────────
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(reg => console.log("[PWA] Service Worker enregistré:", reg.scope))
        .catch(err => console.warn("[PWA] SW non enregistré:", err));
    }

    const handleInstallPrompt = (e) => {
      e.preventDefault();
      setPwaPrompt(e);
      setPwaInstallable(true);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);

    if ("serviceWorker" in navigator && "SyncManager" in window) {
      navigator.serviceWorker.ready.then(sw => {
        window.addEventListener("online", () => {
          sw.sync.register("sync-trades").catch(() => {});
        });
      });
    }

    navigator.serviceWorker?.addEventListener("message", (e) => {
      if (e.data?.type === "SYNC_COMPLETE") {
        showToast(`${e.data.count} trade(s) synchronisé(s) ✓`);
      }
    });

    return () => window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const installPWA = async () => {
    if (!pwaPrompt) return;
    pwaPrompt.prompt();
    const result = await pwaPrompt.userChoice;
    if (result.outcome === "accepted") {
      setPwaInstallable(false);
      setPwaPrompt(null);
      showToast("EDGELOG installé sur votre appareil ! 📱");
    }
  };

  const handleLogin = (userData) => {
    setUser(userData);
    setAuthState("onboarding");
  };

  const handleOnboardingComplete = ({ plan, firstAccount }) => {
    const now = new Date().toISOString();
    setUser(u => ({...u, plan, trialStart: now, createdAt: now}));
    setAccounts([{ id:"acc1", name:firstAccount.name, type:firstAccount.type, balance:firstAccount.balance, currency:"$" }]);
    setAllTrades(SEED_TRADES);
    setAuthState("app");
    showToast(`Bienvenue sur EDGELOG, ${user?.name?.split(" ")[0] || "Trader"} ! 🎉`);
    setTimeout(() => { setShowTooltipGuide(true); setTooltipStep(0); }, 800);
  };

  const handleLogout = async () => {
    try { await API.auth.logout(tokenStore.refresh); } catch {}
    tokenStore.clear();
    setUser(null);
    setAuthState("login");
    setPage("landing");
    showToast("Déconnecté", "info");
  };

  // ── Chargement initial depuis l'API (si token présent) ──────────
  useEffect(() => {
    if (authState !== "app" || apiSynced) return;
    const syncFromAPI = async () => {
      try {
        const [tradesRes, accountsRes] = await Promise.all([
          API.trades.list({ limit: 500 }),
          API.accounts.list(),
        ]);
        if (tradesRes?.trades)    { setAllTrades(tradesRes.trades); }
        if (accountsRes?.accounts && accountsRes.accounts.length > 0) {
          setAccounts(accountsRes.accounts);
          setActiveAccount(accountsRes.accounts[0].id);
        }
        setApiSynced(true);
      } catch {
        // Backend indisponible → mode démo local, pas de message d'erreur
        setApiSynced(true);
      }
    };
    syncFromAPI();
  }, [authState, apiSynced]);

  const account       = accounts.find(a=>a.id===activeAccount);
  const accountTrades = allTrades.filter(t=>t.accountId===activeAccount);
  const trades        = useMemo(()=>applyPlanFilter(accountTrades,user),[accountTrades,user]);
  const closedTrades  = trades.filter(t=>t.status==="CLOSED");
  const totalPnl      = closedTrades.reduce((s,t)=>s+(t.pnl||0),0);
  const accountBalance= (account?.balance||10000)+totalPnl;

  const tradeLimit        = checkTradeLimit(allTrades,user);
  const tradeLimitReached = !tradeLimit.allowed;
  const isBasic           = isBasicPlan(user);
  const isPremiumUser     = isPremium(user);
  const isProUser         = isPro(user);
  const canPsychology     = isPremiumUser || inPsychTrial(user);
  const psychTrialDaysLeft= isBasic ? Math.max(0, PSYCH_TRIAL_DAYS - Math.floor((Date.now() - new Date(user?.createdAt||Date.now())) / 864e5)) : 0;
  const showHistoryNotice = !isProUser && accountTrades.length>trades.length;
  const isLanding         = page==="landing"||page==="offres";

  const saveTrade = async (data) => {
    const isNew     = !(data.id && allTrades.find(t=>t.id===data.id));
    const isEditing = !isNew;

    if (isNew) {
      const chk = checkTradeLimit(allTrades, user);
      if (!chk.allowed) { showToast(chk.message, "err"); return; }
    }

    // Optimistic update local
    if (isEditing) {
      setAllTrades(p => p.map(t => t.id === data.id ? data : t));
    } else {
      const tempId = `temp_${Date.now()}`;
      setAllTrades(p => [{ ...data, id: tempId, accountId: activeAccount }, ...p]);
    }
    setShowTradeModal(false);
    setEditTrade(null);
    showToast(isEditing ? "Trade mis à jour ✓" : "Trade ajouté ✓");

    // Sync API en arrière-plan
    try {
      if (isEditing) {
        await API.trades.update(data.id, { ...data, accountId: data.accountId || activeAccount });
      } else {
        const res = await API.trades.create({ ...data, accountId: activeAccount });
        // Remplace le tempId par l'id serveur
        if (res?.trade) {
          setAllTrades(p => p.map(t => t.id === `temp_${Date.now() - 5000}` || (t.asset === data.asset && t.date === data.date && String(t.id).startsWith("temp_")) ? res.trade : t));
        }
      }
    } catch {
      // API indisponible → l'état local est déjà correct
    }
  };

  const deleteTrade = async (id) => {
    // Optimistic update
    setAllTrades(p => p.filter(t => t.id !== id));
    if (detailTrade?.id === id) setDetailTrade(null);
    showToast("Trade supprimé", "info");
    // Sync API
    try { await API.trades.delete(id); } catch {}
  };

  const handleNewTrade = () => {
    if (tradeLimitReached) { showToast(tradeLimit.message, "err"); return; }
    setEditTrade(null); setShowTradeModal(true);
  };

  // Dev plan switcher (cycles basic → premium → pro)
  const cyclePlan = () => {
    const cycle = {basic:"premium",premium:"pro",pro:"basic"};
    const np = cycle[user?.plan||"basic"];
    setUser(u=>({...u,plan:np}));
    showToast(`Plan → ${np==="pro"?"Premium Pro 🚀":np==="premium"?"Premium ⚡":"Basic 🌱"}`, "info");
  };

  const navItems = [
    {id:"landing",     ico:"⌂",  label:"Accueil"},
    {id:"offres",      ico:"◆",  label:"Offres",         badge:"new"},
    {id:"dashboard",   ico:"◈",  label:"Dashboard"},
    {id:"trades",      ico:"⊞",  label:"Trades"},
    {id:"calendrier",  ico:"◫",  label:"Calendrier",     badge:isBasic?"lock":""},
    {id:"psychology",  ico:"◎",  label:"Psychologie",    badge:isBasic&&!canPsychology?"lock":isBasic?"trial":""},
    {id:"analyses",    ico:"◉",  label:"Analyses",       badge:isBasic?"lock":""},
    {id:"import",      ico:"⇪",  label:"Import CSV",     badge:!isProUser?"pro-lock":""},
    {id:"coach",       ico:"◑",  label:"Coach / Mentor", badge:"new"},
    {id:"comportement",ico:"◐",  label:"Prévision IA",   badge:!isProUser?"pro-lock":""},
    {id:"profil",      ico:"○",  label:"Mon Profil",     badge:""},
    {id:"facturation", ico:"◈",  label:"Facturation",    badge:""},
    {id:"settings",    ico:"⚙",  label:"Paramètres",     badge:""},
  ];

  // ── Auth routing ──
  if (authState==="login")      return <><GlobalStyles/><LoginPage    onLogin={handleLogin} onGoRegister={()=>setAuthState("register")}/>{toast&&<div className={`toast ${toast.type}`}>{toast.msg}</div>}</>;
  if (authState==="register")   return <><GlobalStyles/><RegisterPage onRegister={handleLogin} onGoLogin={()=>setAuthState("login")}/>{toast&&<div className={`toast ${toast.type}`}>{toast.msg}</div>}</>;
  if (authState==="onboarding") return <><GlobalStyles/><OnboardingFlow user={user} onComplete={handleOnboardingComplete}/>{toast&&<div className={`toast ${toast.type}`}>{toast.msg}</div>}</>;

  // ── Main App ──
  return (
    <AuthContext.Provider value={{user,setUser}}>
      <GlobalStyles/>
      <div className="app">
        {/* SIDEBAR */}
        {!isLanding && (
          <nav className="sidebar">
            <div className="logo" style={{cursor:"pointer"}} onClick={()=>setPage("dashboard")}>EDGE<em>LOG</em><sup>v2</sup></div>

            {/* User box */}
            <div className="user-box">
              <div className="user-avatar" style={{background:avatarColor(user?.email),color:"#000"}}>
                {user?.provider==="google"?"G":initials(user?.name)}
              </div>
              <div className="user-info">
                <div className="user-name">{user?.name}</div>
                <div className="user-email">{user?.email}</div>
              </div>
              <button className="user-logout" title="Se déconnecter" onClick={handleLogout}>⏻</button>
            </div>

            {/* Plan pill */}
            <div className={`plan-pill ${isProUser?"pro":isPremiumUser?"premium":"basic"}`} onClick={()=>setPage("offres")}>
              <span>{isProUser?"🚀 Pro":isPremiumUser?"⚡ Premium":"🌱 Basic"}</span>
              {isBasic && <span className="plan-pill-upgrade">Upgrade →</span>}
            </div>

            <div className="account-box" onClick={()=>setShowAccountModal(true)}>
              <div className="account-label">Compte actif ▾</div>
              <div className="account-name">{account?.name}<span style={{fontSize:10,color:"var(--muted)"}}>{account?.type}</span></div>
              <div className="account-bal">{fmt(accountBalance,0)} {account?.currency}</div>
            </div>

            {isBasic && (
              <div className="trade-limit-bar">
                <div className="tlb-label"><span>Trades</span><span className="tlb-count">{allTrades.length}/{PLANS[user?.plan||"basic"].limit === Infinity ? "∞" : PLANS[user?.plan||"basic"].limit}</span></div>
                <div className="tlb-track">
                  <div className="tlb-fill" style={{width:`${Math.min(100,(allTrades.length/PLANS[user?.plan||"basic"].limit)*100)}%`,background:tradeLimitReached?"var(--red)":allTrades.length>=PLANS[user?.plan||"basic"].limit*0.8?"var(--amber)":"var(--accent)"}}/>
                </div>
              </div>
            )}

            <div className="nav">
              {navItems.map(n=>{
                const locked  = n.badge==="lock" || n.badge==="pro-lock";
                const isProLock = n.badge==="pro-lock";
                return (
                  <div key={n.id} className={`ni${page===n.id?" on":""}${locked?" locked":""}`}
                    onClick={()=>{ if(!locked)setPage(n.id); else showToast(isProLock?"Réservé aux abonnés Premium Pro 🚀":"Réservé aux abonnés Premium.","warn"); }}>
                    <span className="ico">{n.ico}</span>{n.label}
                    {n.badge==="new"       && <span className="nbadge new">NEW</span>}
                    {n.badge==="pro"       && <span className="nbadge pro">PRO</span>}
                    {n.badge==="lock"      && <span className="nbadge lock">🔒</span>}
                    {n.badge==="pro-lock"  && <span className="nbadge" style={{background:"rgba(245,158,11,.15)",color:"var(--amber)",border:"1px solid rgba(245,158,11,.3)"}}>PRO</span>}
                    {n.badge==="trial"     && <span className="nbadge" style={{background:"rgba(56,189,248,.15)",color:"var(--blue)",border:"1px solid rgba(56,189,248,.3)"}}>{psychTrialDaysLeft}j</span>}
                  </div>
                );
              })}
            </div>

            <div className="sidebar-footer">
              <div className="lbl">Actions rapides</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <button className="btn btn-primary" style={{width:"100%",justifyContent:"center"}} disabled={tradeLimitReached} onClick={handleNewTrade}>
                  {tradeLimitReached?"🔒 Limite atteinte":"+ Nouveau trade"}
                </button>
                {tradeLimitReached && <button className="btn btn-amber btn-sm" style={{width:"100%",justifyContent:"center"}} onClick={()=>setPage("offres")}>Passer au plan sup. →</button>}
                {pwaInstallable && (
                  <button className="btn btn-ghost btn-sm" style={{width:"100%",justifyContent:"center"}} onClick={installPWA}>
                    📱 Installer l'app
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" style={{width:"100%",justifyContent:"center",gap:6}} onClick={()=>setPage("settings")}>
                  ⚙ Paramètres
                </button>
              </div>
            </div>
          </nav>
        )}

        <div className="main">
          {/* MOBILE TOPBAR */}
          {!isLanding && (
            <div className="mobile-topbar">
              <div className="mobile-topbar-logo">EDGE<em>LOG</em></div>
              <div className={`plan-pill ${isProUser?"pro":isPremiumUser?"premium":"basic"}`} style={{margin:0,fontSize:9,padding:"3px 8px",cursor:"pointer"}} onClick={()=>setPage("offres")}>
                {isProUser?"🚀 Pro":isPremiumUser?"⚡ Premium":"🌱 Basic"}
              </div>
              <div style={{position:"relative"}}>
                <div className="notif-bell" onClick={()=>setShowNotif(v=>!v)}>
                  🔔
                  {notifications.some(n=>!n.read) && <div className="notif-dot"/>}
                </div>
                {showNotif && (
                  <div className="notif-panel">
                    <div className="notif-header">
                      <span className="notif-title">Notifications</span>
                      <span style={{fontSize:10,color:"var(--accent)",cursor:"pointer"}} onClick={()=>setNotifications(ns=>ns.map(n=>({...n,read:true})))}>Tout lire</span>
                    </div>
                    {notifications.length===0
                      ? <div style={{padding:"20px",textAlign:"center",color:"var(--muted2)",fontSize:11}}>Aucune notification</div>
                      : notifications.map(n=>(
                        <div key={n.id} className={`notif-item${n.read?"":" unread"}`} onClick={()=>{ setNotifications(ns=>ns.map(x=>x.id===n.id?{...x,read:true}:x)); if(n.link) setPage(n.link); setShowNotif(false); }}>
                          <div className="notif-icon" style={{background:n.color+"20"}}>{n.ico}</div>
                          <div className="notif-body"><div className="notif-msg">{n.msg}</div><div className="notif-time">{n.time}</div></div>
                          {!n.read && <div className="notif-unread-badge"/>}
                        </div>
                      ))
                    }
                  </div>
                )}
              </div>
              <button className="btn btn-primary btn-sm" disabled={tradeLimitReached} onClick={handleNewTrade} style={{padding:"5px 10px",fontSize:10}}>+ Trade</button>
            </div>
          )}

          {/* DESKTOP TOPBAR */}
          {!isLanding && (
            <div className="topbar">
              <div style={{fontFamily:"var(--fh)",fontSize:20,fontWeight:700,letterSpacing:"-0.3px"}}>
                {{dashboard:"Dashboard",trades:"Trades",psychology:"Psychologie",analyses:"Analyses",calendrier:"Calendrier",import:"Import CSV",coach:"Coach & Mentor",comportement:"Prévision IA",facturation:"Facturation",profil:"Mon Profil",settings:"Paramètres"}[page]||""}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {/* Notifications desktop */}
                <div style={{position:"relative"}}>
                  <div className="notif-bell" onClick={()=>setShowNotif(v=>!v)} style={{padding:"7px 9px",background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:7}}>
                    🔔
                    {notifications.some(n=>!n.read) && <div className="notif-dot"/>}
                  </div>
                  {showNotif && (
                    <div className="notif-panel">
                      <div className="notif-header">
                        <span className="notif-title">Notifications</span>
                        <span style={{fontSize:10,color:"var(--accent)",cursor:"pointer"}} onClick={()=>setNotifications(ns=>ns.map(n=>({...n,read:true})))}>Tout lire</span>
                      </div>
                      {notifications.length===0
                        ? <div style={{padding:"20px",textAlign:"center",color:"var(--muted2)",fontSize:11}}>Aucune notification</div>
                        : notifications.map(n=>(
                          <div key={n.id} className={`notif-item${n.read?"":" unread"}`} onClick={()=>{ setNotifications(ns=>ns.map(x=>x.id===n.id?{...x,read:true}:x)); if(n.link) setPage(n.link); setShowNotif(false); }}>
                            <div className="notif-icon" style={{background:n.color+"20"}}>{n.ico}</div>
                            <div className="notif-body"><div className="notif-msg">{n.msg}</div><div className="notif-time">{n.time}</div></div>
                            {!n.read && <div className="notif-unread-badge"/>}
                          </div>
                        ))
                      }
                    </div>
                  )}
                </div>
                <div className={`plan-pill ${isProUser?"pro":isPremiumUser?"premium":"basic"}`} style={{margin:0,cursor:"pointer"}} onClick={()=>setPage("offres")}>
                  {isProUser?"🚀 Pro":isPremiumUser?"⚡ Premium":"🌱 Basic"}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={()=>setPage("offres")}>◆ Offres</button>
                <button className="btn btn-primary btn-sm" disabled={tradeLimitReached} onClick={handleNewTrade}>
                  {tradeLimitReached?"🔒 Limite":"+ Nouveau trade"}
                </button>
              </div>
            </div>
          )}

          {/* PAGES */}
          {isLanding && page==="landing"       && <LandingPage  setPage={setPage} user={user} onLogout={handleLogout}/>}
          {page==="offres"                     && <OffresPage   setPage={setPage} isLanding={isLanding}/>}
          {!isLanding && page==="dashboard"    && <div className="content-pad">{tradeLimitReached&&<LimitBanner current={allTrades.length} max={PLANS[user?.plan||"basic"].limit} plan={user?.plan||"basic"} setPage={setPage}/>}{showHistoryNotice&&<HistoryNotice plan={user?.plan||"basic"} setPage={setPage}/>}<DashboardPage trades={trades} account={account} accountBalance={accountBalance} setPage={setPage} setDetailTrade={setDetailTrade}/></div>}
          {!isLanding && page==="trades"       && <div className="content-pad">{tradeLimitReached&&<LimitBanner current={allTrades.length} max={PLANS[user?.plan||"basic"].limit} plan={user?.plan||"basic"} setPage={setPage}/>}{showHistoryNotice&&<HistoryNotice plan={user?.plan||"basic"} setPage={setPage}/>}<TradesPage trades={trades} onEdit={t=>{setEditTrade(t);setShowTradeModal(true);}} onDelete={deleteTrade} onDetail={setDetailTrade}/></div>}
          {!isLanding && page==="psychology"   && <div className="content-pad">
            {!canPsychology ? <PremiumGate title="Psychologie — Premium" description="Période d'essai terminée. Passez à Premium pour continuer à tracker vos émotions et performances." features={["Radar émotionnel","Corrélations émotion/P&L","Suivi long terme"]} setPage={setPage}/> : <>
              {isBasic && canPsychology && psychTrialDaysLeft > 0 && <PsychTrialBanner daysLeft={psychTrialDaysLeft} setPage={setPage}/>}
              {showHistoryNotice&&<HistoryNotice plan={user?.plan||"basic"} setPage={setPage}/>}<PsychologyPage trades={trades} setPage={setPage} user={user}/>
            </>}
          </div>}
          {!isLanding && page==="calendrier"   && <div className="content-pad">{isBasic?<PremiumGate title="Calendrier — Premium" description="Visualisez vos performances jour par jour sur un calendrier interactif." features={["P&L par jour","Meilleur/pire jour","Heatmap mensuelle"]} setPage={setPage}/>:<CalendrierPage trades={trades} setDetailTrade={setDetailTrade}/>}</div>}
          {!isLanding && page==="analyses"     && <div className="content-pad">{isBasic?<PremiumGate title="Analyses avancées — Premium" description="Accédez aux analyses avancées : R multiples, drawdown, profit factor par actif." features={["Profit Factor & Drawdown","Distribution R multiples","P&L par actif"]} setPage={setPage}/>:<AnalysesPage trades={trades}/>}</div>}
          {!isLanding && page==="import"       && <div className="content-pad">{!isProUser?<PremiumGate requirePro title="Import CSV — Premium Pro" description="Importez automatiquement vos trades depuis 20+ brokers et prop firms." features={["Binance, ByBit, MT4/MT5, cTrader","FTMO, The5%ers, Funded Next","Détection auto des colonnes"]} setPage={setPage}/>:<ImportPage onImport={t=>{setAllTrades(p=>[...t.map(x=>({...x,accountId:activeAccount})),...p]);showToast(`${t.length} trades importés ✓`);setPage("trades");}}/>}</div>}
          {!isLanding && page==="coach"        && <div className="content-pad"><CoachPage user={user} trades={trades} showToast={showToast}/></div>}
          {!isLanding && page==="comportement" && <div className="content-pad">{!isProUser?<PremiumGate requirePro title="Prévision IA — Premium Pro" description="Analysez votre style de trading et obtenez une prévision de performance basée sur votre discipline." features={["Courbe comportementale IA","Style de trading détecté","Simulation règles respectées vs non"]} setPage={setPage}/>:<ComportementPage trades={trades} user={user}/>}</div>}
          {!isLanding && page==="facturation"  && <div className="content-pad"><FacturationPage user={user} onPlanChange={(plan)=>{setUser(u=>({...u,plan}));showToast(`Plan mis à jour → ${PLANS[plan].label} ✓`);}} showToast={showToast}/></div>}
          {!isLanding && page==="profil"       && <div className="content-pad"><ProfilPage user={user} trades={allTrades} setPage={setPage} showToast={showToast}/></div>}
          {!isLanding && page==="settings"     && <div className="content-pad"><SettingsPage user={user} onUpdateUser={u=>setUser(prev=>({...prev,...u}))} showToast={showToast}/></div>}
        </div>

        {/* MOBILE BOTTOM NAV */}
        {!isLanding && (
          <nav className="mobile-nav">
            <div className="mobile-nav-inner">
              {[
                {id:"dashboard", ico:"◈", lbl:"Dashboard"},
                {id:"trades",    ico:"⊞", lbl:"Trades"},
                {id:"psychology",ico:"◎", lbl:"Psycho"},
                {id:"analyses",  ico:"◉", lbl:"Analyses"},
                {id:"__more__",  ico:"⋯", lbl:"Plus"},
              ].map(n=>(
                <div key={n.id} className={`mobile-nav-item${(page===n.id||(n.id==="__more__"&&showMobileMore))?" active":""}`}
                  onClick={()=>{ if(n.id==="__more__") { setShowMobileMore(v=>!v); } else { setPage(n.id); setShowMobileMore(false); } }}>
                  <div className="mobile-nav-ico">{n.ico}</div>
                  <div className="mobile-nav-lbl">{n.lbl}</div>
                </div>
              ))}
            </div>
          </nav>
        )}

        {/* MOBILE MORE MENU */}
        {!isLanding && showMobileMore && (
          <div className="mobile-nav-more" onClick={()=>setShowMobileMore(false)}>
            {[
              {id:"calendrier",  ico:"◫", lbl:"Calendrier",   locked:isBasic},
              {id:"import",      ico:"⇪", lbl:"Import CSV",   locked:!isProUser},
              {id:"coach",       ico:"◑", lbl:"Coach",        locked:false},
              {id:"comportement",ico:"◐", lbl:"Prévision IA", locked:!isProUser},
              {id:"facturation", ico:"◈", lbl:"Facturation",  locked:false},
              {id:"profil",      ico:"○", lbl:"Mon Profil",   locked:false},
            ].map(n=>(
              <div key={n.id} className="mobile-more-item" onClick={()=>{ if(!n.locked){setPage(n.id);} else showToast("Réservé aux abonnés Premium","warn"); }}>
                <div className="mobile-more-ico">{n.ico}</div>
                <div className="mobile-more-lbl">{n.lbl}{n.locked?" 🔒":""}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showTradeModal    && <TradeModal      trade={editTrade} setups={setups} checklistItems={checklist} onSave={saveTrade} onClose={()=>{setShowTradeModal(false);setEditTrade(null);}}/>}
      {detailTrade       && <TradeDetailModal trade={detailTrade} onClose={()=>setDetailTrade(null)} onEdit={t=>{setDetailTrade(null);setEditTrade(t);setShowTradeModal(true);}} onDelete={id=>{deleteTrade(id);setDetailTrade(null);}} onDuplicate={t=>{ if(tradeLimitReached){showToast(tradeLimit.message,"err");return;} const d={...t,id:Date.now(),date:new Date().toISOString().slice(0,10),status:"OPEN",exit:null,pnl:null,notes:""}; setAllTrades(p=>[d,...p]); setDetailTrade(null); showToast("Trade dupliqué ✓"); }}/>}
      {showAccountModal  && <AccountModal    accounts={accounts} active={activeAccount} onSelect={id=>{setActiveAccount(id);setShowAccountModal(false);}} onAdd={acc=>{setAccounts(p=>[...p,acc]);showToast("Compte créé ✓");}} onDelete={id=>{if(accounts.length>1){setAccounts(p=>p.filter(a=>a.id!==id));if(activeAccount===id)setActiveAccount(accounts[0].id);showToast("Compte supprimé","info");}}} onClose={()=>setShowAccountModal(false)}/>}

      {/* Onboarding tooltip guide */}
      {showTooltipGuide && <TooltipGuide step={tooltipStep} onNext={()=>setTooltipStep(s=>s+1)} onSkip={()=>setShowTooltipGuide(false)} setPage={setPage}/>}

      {/* DEV TOGGLE */}
      {authState==="app" && !isLanding && <DevUpgradeToggle user={user} onToggle={cyclePlan}/>}
      {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
    </AuthContext.Provider>
  );
}

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────
function LandingPage({ setPage, user, onLogout }) {
  const demoData=[{d:"Jan",v:10000},{d:"Fév",v:10800},{d:"Mar",v:10500},{d:"Avr",v:11400},{d:"Mai",v:11100},{d:"Jun",v:12300},{d:"Jul",v:12800},{d:"Aoû",v:13600}];
  return (
    <div className="landing">
      <div style={{background:"var(--s1)",borderBottom:"1px solid var(--bd)",padding:"14px 64px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div className="logo" style={{padding:0,border:"none",fontSize:16}}>EDGE<em>LOG</em><sup>v2</sup></div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <button className="btn btn-ghost btn-sm" onClick={()=>setPage("offres")}>◆ Offres</button>
          {user
            ? <><button className="btn btn-ghost btn-sm" onClick={()=>setPage("dashboard")}>Dashboard →</button><button className="btn btn-red btn-sm" onClick={onLogout}>Déconnexion</button></>
            : <><button className="btn btn-ghost btn-sm" onClick={()=>setPage("__login__")}>Se connecter</button><button className="btn btn-primary btn-sm" onClick={()=>setPage("offres")}>Commencer →</button></>
          }
        </div>
      </div>
      <div className="hero">
        <div className="hero-bg"/><div className="hero-grid"/>
        <div className="hero-eyebrow"><span/>Journal de trading pour traders sérieux</div>
        <h1 className="hero-title">Prenez le contrôle<br/><em>de votre edge.</em><br/><span className="line2">Pas de celui des autres.</span></h1>
        <p className="hero-sub">EDGELOG vous aide à documenter, analyser et améliorer chaque décision de trading.</p>
        <div className="hero-cta">
          <button className="btn btn-primary btn-lg" onClick={()=>setPage("offres")}>Commencer gratuitement →</button>
          <button className="btn btn-ghost btn-lg" onClick={()=>setPage("dashboard")}>Voir le dashboard</button>
        </div>
        <div style={{marginTop:52,width:"100%",maxWidth:640,background:"var(--s1)",border:"1px solid var(--bd)",borderRadius:12,padding:"20px 24px",animation:"fadeUp .5s .4s ease both"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{fontSize:10,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)"}}>Aperçu — Compte Réel</div>
            <div style={{display:"flex",gap:16}}>
              {[{l:"P&L",v:"+3 600 $",c:"var(--accent)"},{l:"WR",v:"72%",c:"var(--blue)"},{l:"PF",v:"2.4",c:"var(--amber)"}].map(k=>(
                <div key={k.l} style={{textAlign:"right"}}>
                  <div style={{fontSize:9,color:"var(--muted2)",letterSpacing:"1px",textTransform:"uppercase"}}>{k.l}</div>
                  <div style={{fontFamily:"var(--fh)",fontSize:15,fontWeight:700,color:k.c}}>{k.v}</div>
                </div>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={100}>
            <AreaChart data={demoData}>
              <defs><linearGradient id="hgc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00e5a0" stopOpacity={0.2}/><stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/></linearGradient></defs>
              <XAxis dataKey="d" tick={{fontSize:9,fill:"#4e5d73",fontFamily:"IBM Plex Mono"}} axisLine={false} tickLine={false}/>
              <Tooltip contentStyle={{background:"var(--s2)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:10}}/>
              <Area type="monotone" dataKey="v" stroke="#00e5a0" strokeWidth={2} fill="url(#hgc)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="stats-bar">
        {[{v:"12 000+",l:"Traders actifs"},{v:"4.8M",l:"Trades enregistrés"},{v:"99.9%",l:"Uptime"},{v:"< 48h",l:"Support"}].map((s,i)=>(
          <div key={s.l} style={{display:"flex",gap:40,alignItems:"center"}}>
            {i>0&&<div className="stat-divider"/>}
            <div className="stat-item"><div className="stat-val">{s.v}</div><div className="stat-lbl">{s.l}</div></div>
          </div>
        ))}
      </div>
      <div className="plans-section" style={{paddingTop:56,paddingBottom:56}}>
        <div className="plans-eyebrow">Deux formules</div>
        <h2 className="plans-title">Pour chaque étape de votre parcours</h2>
        <p className="plans-subtitle">Démarrez gratuitement. Évoluez vers Premium quand vous êtes prêt.</p>
        <div style={{display:"flex",gap:16,maxWidth:720,margin:"0 auto",justifyContent:"center",flexWrap:"wrap"}}>
          {[{name:"Basic",price:"Gratuit",color:"var(--blue)",icon:"🌱",desc:"Structurer son trading"},
            {name:"Premium",price:"9,99 €/mois",color:"var(--amber)",icon:"⚡",desc:"Analyses pro et historique illimité"}].map(p=>(
            <div key={p.name} onClick={()=>setPage("offres")} style={{flex:"1 1 280px",maxWidth:320,background:"var(--s1)",border:`1px solid ${p.name==="Premium"?"rgba(245,158,11,.3)":"var(--bd)"}`,borderRadius:12,padding:"24px",cursor:"pointer",transition:"transform .15s,box-shadow .15s"}}
              onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-3px)";e.currentTarget.style.boxShadow="0 12px 40px rgba(0,0,0,.3)"}}
              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=""}}>
              <div style={{fontSize:24,marginBottom:10}}>{p.icon}</div>
              <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:800,color:p.color,marginBottom:4}}>{p.name}</div>
              <div style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>{p.desc}</div>
              <div style={{fontFamily:"var(--fh)",fontSize:22,fontWeight:700,color:p.color}}>{p.price}</div>
            </div>
          ))}
        </div>
        <div style={{textAlign:"center",marginTop:28}}><button className="btn btn-primary" onClick={()=>setPage("offres")}>Voir toutes les offres →</button></div>
      </div>
      <div className="cta-banner">
        <h2 className="cta-banner-title">Prêt à construire votre <em style={{color:"var(--accent)",fontStyle:"normal"}}>edge</em> ?</h2>
        <p className="cta-banner-sub">Rejoignez des milliers de traders qui améliorent leurs performances avec EDGELOG.</p>
        <div className="cta-banner-btns">
          <button className="btn btn-primary btn-lg" onClick={()=>setPage("offres")}>Démarrer gratuitement →</button>
          <button className="btn btn-ghost btn-lg" onClick={()=>setPage("dashboard")}>Voir la démo</button>
        </div>
      </div>
      <div className="landing-footer">
        <div className="footer-logo">EDGE<em>LOG</em></div>
        <div>© 2025 EDGELOG — Tous droits réservés</div>
        <div style={{display:"flex",gap:20}}><span style={{cursor:"pointer"}}>Confidentialité</span><span style={{cursor:"pointer"}}>CGU</span><span style={{cursor:"pointer"}}>Contact</span></div>
      </div>
    </div>
  );
}

// ─── OFFRES PAGE ──────────────────────────────────────────────────────────────
function OffresPage({ setPage, isLanding }) {
  const [annual, setAnnual]        = useState(false);
  const [openFaq, setOpenFaq]      = useState(null);
  const [showCheckout, setCheckout]= useState(null); // "premium" | "pro" | null
  const mp=9.99, mpPro=0;
  const ap=(mp*.75).toFixed(2), apPro="0";
  const dp=annual?ap:mp.toFixed(2);
  const dpPro="Sur demande";

  const basicF=["Journal — 15 trades max","Dashboard & KPIs de base","Psychologie (30j d'essai)","Checklist pré-trade","2 comptes de trading"];
  const premF=["Jusqu'à 100 trades / mois","Historique 3 mois","Psychologie & radar émotionnel","Calendrier P&L interactif","Analyses avancées + MFE/MAE","Comptes illimités","Coach & mentor (partage journal)"];
  const proF=["Trades illimités","Historique illimité","Import CSV — 20+ brokers & prop firms","API courtiers (ByBit, MT4, FTMO…)","Courbe comportementale IA","Prévision de performance","Support prioritaire 24h"];
  const compareRows=[
    {label:"Trades max",          basic:"15",       premium:"100",       pro:"Illimité"},
    {label:"Historique",          basic:"—",         premium:"3 mois",    pro:"Illimité"},
    {label:"Dashboard & KPIs",    basic:true,        premium:true,        pro:true},
    {label:"Psychologie",         basic:"30j essai", premium:true,        pro:true},
    {label:"Calendrier P&L",      basic:false,       premium:true,        pro:true},
    {label:"Analyses avancées",   basic:false,       premium:true,        pro:true},
    {label:"MFE/MAE + Efficacité",basic:false,       premium:true,        pro:true},
    {label:"Coach / mentor",      basic:false,       premium:true,        pro:true},
    {label:"Import CSV (brokers)",basic:false,       premium:false,       pro:true},
    {label:"API courtiers",       basic:false,       premium:false,       pro:true},
    {label:"Courbe comportem. IA",basic:false,       premium:false,       pro:true},
    {label:"Prévision perf. IA",  basic:false,       premium:false,       pro:true},
    {label:"Support",             basic:"Standard",  premium:"Standard",  pro:"Prioritaire 24h"},
  ];
  const faqs=[
    {q:"Que se passe-t-il quand j'atteins la limite de trades ?",a:"Vos données restent accessibles, mais vous ne pouvez plus ajouter de trades. Passez à Premium ou Pro pour continuer."},
    {q:"La psychologie est-elle vraiment gratuite sur Basic ?",a:"Oui, pendant 30 jours à partir de votre inscription. Après, cette section est réservée aux abonnés Premium et Pro."},
    {q:"Quels brokers sont supportés pour l'import CSV (Pro) ?",a:"20+ brokers : MT4/MT5, cTrader, IC Markets, Pepperstone, OANDA, Binance, ByBit, Kraken, Coinbase, Deriv, et les prop firms FTMO, The5%ers, Funded Next, E8 Funding, True Forex Funds."},
    {q:"Y a-t-il une période d'essai ?",a:"Oui : 14 jours gratuits sur Premium (sans carte). Les utilisateurs Basic bénéficient de 30 jours d'accès gratuit à la section Psychologie. Le plan Premium Pro est sur devis — contactez-nous à pro@edgelog.app."},
    {q:"Mes données sont-elles sécurisées ?",a:"Toutes vos données sont chiffrées (HTTPS + chiffrement au repos). Vous pouvez les exporter et les supprimer à tout moment."},
  ];

  const inner=(
    <>
      <div className="plans-section" style={{paddingTop:isLanding?64:0}}>
        <div className="plans-eyebrow">Tarifs transparents</div>
        <h1 className="plans-title">Choisissez la formule<br/>qui vous correspond</h1>
        <p className="plans-subtitle">Démarrez gratuitement. Passez à Premium ou Pro quand vous êtes prêt.</p>
        <div className="billing-toggle">
          <span style={{color:annual?"var(--muted2)":"var(--text)"}}>Mensuel</span>
          <div className={`toggle-track${annual?" on":""}`} onClick={()=>setAnnual(a=>!a)}><div className="toggle-knob"/></div>
          <span style={{color:annual?"var(--text)":"var(--muted2)"}}>Annuel</span>
          <span className="save-badge">-25%</span>
        </div>
        <div className="plans-grid">
          {/* Basic */}
          <div className="plan-card basic">
            <div className="plan-icon">🌱</div>
            <div className="plan-name">Basic</div>
            <p className="plan-tagline">Pour découvrir EDGELOG et structurer vos premiers trades.</p>
            <div className="plan-price"><div className="plan-price-main">Gratuit</div><div className="plan-price-period">Pour toujours · Sans carte</div></div>
            <button className="btn btn-outline-accent btn-lg" style={{width:"100%",justifyContent:"center"}} onClick={()=>setPage("dashboard")}>Commencer →</button>
            <div className="plan-divider"/><div className="section-title">Inclus</div>
            <div className="plan-features">{basicF.map((f,i)=><div key={i} className="pf"><div className="pf-check">✓</div><span>{f}</span></div>)}</div>
          </div>

          {/* Premium */}
          <div className="plan-card premium">
            <div className="plan-recommended">✦ Recommandé</div>
            <div className="plan-icon">⚡</div>
            <div className="plan-name">Premium</div>
            <p className="plan-tagline">Pour les traders sérieux qui veulent analyses et psychologie.</p>
            <div className="plan-price">
              <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                {annual&&<span className="plan-price-old">{mp.toFixed(2)} €</span>}
                <span className="plan-price-main">{dp} €</span>
                {annual&&<span className="plan-price-badge">-25%</span>}
              </div>
              <div className="plan-price-period">{annual?"par mois, facturé annuellement":"par mois · Sans engagement"}</div>
              {annual&&<div style={{fontSize:11,color:"var(--accent)",marginTop:4}}>Économisez {((mp-parseFloat(ap))*12).toFixed(2)} € / an</div>}
            </div>
            <button className="btn btn-amber btn-lg" style={{width:"100%",justifyContent:"center"}} onClick={()=>setCheckout("premium")}>Essayer 14 jours gratuits →</button>
            <div style={{fontSize:10,color:"var(--muted2)",textAlign:"center",marginTop:6}}>Sans carte bancaire</div>
            <div className="plan-divider"/><div className="section-title">Tout Basic +</div>
            <div className="plan-features">{premF.map((f,i)=><div key={i} className="pf"><div className="pf-check">✓</div><span>{f}</span></div>)}</div>
          </div>

          {/* Premium Pro */}
          <div className="plan-card pro">
            <div className="plan-recommended" style={{background:"rgba(167,139,250,.15)",color:"#a78bfa",borderColor:"rgba(167,139,250,.35)"}}>◆ Premium Pro</div>
            <div className="plan-icon">🚀</div>
            <div className="plan-name">Premium Pro</div>
            <p className="plan-tagline">Pour les pros qui veulent tout : import auto, IA comportementale, illimité.</p>
            <div className="plan-price">
              <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                <span className="plan-price-main" style={{fontSize:dpPro==="Sur demande"?24:40}}>{dpPro} {dpPro!=="Sur demande"?"€":""}</span>
              </div>
              <div className="plan-price-period">{dpPro==="Sur demande"?"Contactez-nous pour un devis":"par mois · Sans engagement"}</div>
            </div>
            <button className="btn btn-lg" style={{width:"100%",justifyContent:"center",background:"linear-gradient(135deg,#7c3aed,#a78bfa)",color:"#fff",border:"none"}} onClick={()=>window.open("mailto:pro@edgelog.app?subject=EDGELOG Premium Pro","_blank")}>Nous contacter →</button>
            <div style={{fontSize:10,color:"var(--muted2)",textAlign:"center",marginTop:6}}>pro@edgelog.app · Réponse sous 24h</div>
            <div className="plan-divider"/><div className="section-title">Tout Premium +</div>
            <div className="plan-features">{proF.map((f,i)=><div key={i} className="pf"><div className="pf-check">✓</div><span>{f}</span></div>)}</div>
          </div>
        </div>
      </div>

      {/* Tableau comparatif 4 colonnes */}
      <div className="compare-section">
        <h2 className="compare-title">Comparaison complète</h2>
        <div className="compare-table">
          <div className="compare-head">
            <div className="compare-head-cell">Fonctionnalité</div>
            <div className="compare-head-cell" style={{color:"var(--blue)"}}>Basic</div>
            <div className="compare-head-cell premium-col">Premium</div>
            <div className="compare-head-cell pro-col">Pro</div>
          </div>
          {compareRows.map((r,i)=>(
            <div key={i} className="compare-row">
              <div className="compare-cell">{r.label}</div>
              {["basic","premium","pro"].map(plan=>(
                <div key={plan} className="compare-cell">
                  {typeof r[plan]==="boolean"
                    ? <span style={{color:r[plan]?(plan==="pro"?"#a78bfa":plan==="premium"?"var(--amber)":"var(--accent)"):"var(--muted)",fontSize:14}}>{r[plan]?"✓":"—"}</span>
                    : <span style={{fontSize:11,color:r[plan]==="Bientôt"?"var(--muted2)":""}}>{r[plan]}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="cta-banner">
        <h2 className="cta-banner-title">Prêt à prendre votre <em style={{color:"var(--accent)",fontStyle:"normal"}}>trading</em> au sérieux ?</h2>
        <p className="cta-banner-sub">Commencez avec Basic dès aujourd'hui — gratuit, sans carte.</p>
        <div className="cta-banner-btns">
          <button className="btn btn-primary btn-lg" onClick={()=>setPage("dashboard")}>Démarrer avec Basic →</button>
          <button className="btn btn-amber btn-lg" onClick={()=>setCheckout("premium")}>Essayer Premium gratuitement</button>
        </div>
      </div>
      <div className="faq-section">
        <h2 className="faq-title">Questions fréquentes</h2>
        {faqs.map((f,i)=>(
          <div key={i} className={`faq-item${openFaq===i?" open":""}`}>
            <div className="faq-q" onClick={()=>setOpenFaq(openFaq===i?null:i)}>{f.q}<span className="faq-arrow">▾</span></div>
            <div className="faq-a">{f.a}</div>
          </div>
        ))}
      </div>
      {showCheckout && (
        <CheckoutModal
          plan={showCheckout}
          onClose={()=>setCheckout(null)}
          onSuccess={()=>{ setCheckout(null); setPage("dashboard"); }}
        />
      )}
    </>
  );

  if(isLanding) return (
    <div className="landing">
      <div style={{background:"var(--s1)",borderBottom:"1px solid var(--bd)",padding:"14px 64px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div className="logo" style={{cursor:"pointer",padding:0,border:"none",fontSize:16}} onClick={()=>setPage("landing")}>EDGE<em>LOG</em><sup>v2</sup></div>
        <div style={{display:"flex",gap:8}}><button className="btn btn-ghost btn-sm" onClick={()=>setPage("landing")}>← Accueil</button><button className="btn btn-ghost btn-sm" onClick={()=>setPage("dashboard")}>Se connecter</button></div>
      </div>
      {inner}
      <div className="landing-footer"><div className="footer-logo">EDGE<em>LOG</em></div><div>© 2025 EDGELOG</div><div style={{display:"flex",gap:20}}><span>Confidentialité</span><span>CGU</span><span>Contact</span></div></div>
    </div>
  );
  return <div className="content-pad">{inner}</div>;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function DashboardPage({ trades, account, accountBalance, setPage, setDetailTrade }) {
  const [apiStats,   setApiStats]   = useState(null);
  const [apiStreak,  setApiStreak]  = useState(null);
  const [loadingApi, setLoadingApi] = useState(true);

  // Fetch analytics overview + streak depuis le backend
  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const [overview, streak] = await Promise.all([
          apiRequest("/analytics/overview"),
          apiRequest("/analytics/streak"),
        ]);
        if (!cancelled) {
          setApiStats(overview);
          setApiStreak(streak);
        }
      } catch {
        // Backend indisponible → calculs locaux ci-dessous
      } finally {
        if (!cancelled) setLoadingApi(false);
      }
    };
    fetchStats();
    return () => { cancelled = true; };
  }, [trades.length]); // refetch quand le nb de trades change

  // ── Calculs locaux (fallback si API indispo) ──────────────────
  const closed    = trades.filter(t => t.status === "CLOSED");
  const wins      = closed.filter(t => t.pnl > 0);
  const open      = trades.filter(t => t.status === "OPEN");
  const totalPnl  = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const wr        = closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : 0;
  const pf        = useMemo(() => {
    const g = wins.reduce((s, t) => s + t.pnl, 0);
    const l = Math.abs(closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return l > 0 ? (g / l).toFixed(2) : "∞";
  }, [trades]);

  // ── Données affichées : API si dispo, sinon local ─────────────
  const displayWr  = apiStats ? apiStats.winRate  : parseFloat(wr);
  const displayPf  = apiStats ? apiStats.profitFactor : pf;
  const displayPnl = apiStats ? apiStats.totalPnl  : totalPnl;
  const displayDd  = apiStats ? apiStats.maxDrawdown : null;
  const displayExp = apiStats ? apiStats.expectancy  : null;

  // Streak
  const streakType  = apiStreak?.current?.type;
  const streakCount = apiStreak?.current?.streak || 0;
  const streakLabel = streakCount > 0
    ? `${streakCount} ${streakType === "win" ? "victoire" : "défaite"}${streakCount > 1 ? "s" : ""} de suite`
    : "—";
  const streakColor = streakType === "win" ? "var(--accent)" : streakType === "loss" ? "var(--red)" : "var(--muted2)";

  // Courbe de capital (local — les trades sont déjà chargés)
  const eq = useMemo(() => {
    let b = account?.balance || 10000;
    return [...closed].sort((a, b) => a.date.localeCompare(b.date)).map(t => {
      b += (t.pnl || 0);
      return { date: t.date.slice(5), balance: parseFloat(b.toFixed(2)) };
    });
  }, [trades, account]);

  const recent = [...trades].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);

  if (!trades.length) return (
    <div className="empty-state">
      <div className="empty-icon">📊</div>
      <div className="empty-title">Aucun trade</div>
      <div className="empty-desc">Ajoutez votre premier trade pour commencer.</div>
    </div>
  );

  return (
    <>
      {/* ── KPI Grid ── */}
      <div className="kpi-grid">
        {/* Solde */}
        <div className="kpi g">
          <div className="kpi-label">Solde</div>
          <div className="kpi-val"><span className={displayPnl >= 0 ? "pos" : "neg"}>{fmt(accountBalance, 0)} $</span></div>
          <div className="kpi-sub">{displayPnl >= 0 ? "+" : ""}{fmt(displayPnl)} $ P&L</div>
        </div>

        {/* Win Rate */}
        <div className="kpi b">
          <div className="kpi-label">Win Rate</div>
          <div className="kpi-val">{displayWr}%</div>
          <div className="kpi-sub">{apiStats ? `${apiStats.wins}W / ${apiStats.trades}` : `${wins.length}W / ${closed.length}`}</div>
        </div>

        {/* Profit Factor */}
        <div className="kpi a">
          <div className="kpi-label">Profit Factor</div>
          <div className="kpi-val">{displayPf}</div>
          <div className="kpi-sub">Gains / Pertes bruts</div>
        </div>

        {/* Série ou positions ouvertes */}
        <div className="kpi p">
          <div className="kpi-label">{loadingApi ? "Positions ouvertes" : apiStreak ? "Série actuelle" : "Positions ouvertes"}</div>
          <div className="kpi-val" style={{ color: apiStreak ? streakColor : "var(--text)" }}>
            {apiStreak ? streakCount : open.length}
          </div>
          <div className="kpi-sub" style={{ color: apiStreak ? streakColor : "var(--muted2)" }}>
            {apiStreak ? streakLabel : "Trades actifs"}
          </div>
        </div>
      </div>

      {/* ── Stats supplémentaires (API uniquement) ── */}
      {apiStats && (displayDd !== null || displayExp !== null) && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
          <div className="kpi r">
            <div className="kpi-label">Drawdown max</div>
            <div className="kpi-val neg">-{fmt(displayDd)} $</div>
            <div className="kpi-sub">Capital peak - bas</div>
          </div>
          <div className="kpi g">
            <div className="kpi-label">Espérance</div>
            <div className="kpi-val"><span className={displayExp >= 0 ? "pos" : "neg"}>{displayExp >= 0 ? "+" : ""}{fmt(displayExp)} $</span></div>
            <div className="kpi-sub">Par trade</div>
          </div>
          <div className="kpi b">
            <div className="kpi-label">Gain moyen</div>
            <div className="kpi-val pos">+{fmt(apiStats.avgWin)} $</div>
            <div className="kpi-sub">{apiStats.wins} trades gagnants</div>
          </div>
          <div className="kpi r" style={{ "--kpi-accent": "var(--red)" }}>
            <div className="kpi-label">Perte moyenne</div>
            <div className="kpi-val neg">-{fmt(apiStats.avgLoss)} $</div>
            <div className="kpi-sub">{apiStats.losses} trades perdants</div>
          </div>
        </div>
      )}

      {/* ── Meilleur/Pire jour (API) ── */}
      {apiStats?.bestDay?.date && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: "var(--s1)", border: "1px solid rgba(0,229,160,.2)", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--muted2)", marginBottom: 4 }}>🏆 Meilleur jour</div>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>{apiStats.bestDay.date}</div>
            </div>
            <div style={{ fontFamily: "var(--fh)", fontSize: 18, fontWeight: 800, color: "var(--accent)" }}>+{fmt(apiStats.bestDay.pnl)} $</div>
          </div>
          <div style={{ background: "var(--s1)", border: "1px solid rgba(255,77,109,.2)", borderRadius: 10, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: ".5px", color: "var(--muted2)", marginBottom: 4 }}>📉 Pire jour</div>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>{apiStats.worstDay.date}</div>
            </div>
            <div style={{ fontFamily: "var(--fh)", fontSize: 18, fontWeight: 800, color: "var(--red)" }}>{fmt(apiStats.worstDay.pnl)} $</div>
          </div>
        </div>
      )}

      {/* ── Courbe de capital + Positions ouvertes ── */}
      <div className="chart-row">
        <div className="card card-pad">
          <div className="card-title">Courbe de capital</div>
          {eq.length > 1
            ? <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={eq}>
                  <defs><linearGradient id="egc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00e5a0" stopOpacity={0.2}/><stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/></linearGradient></defs>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false}/>
                  <YAxis tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false} domain={["auto", "auto"]} width={70}/>
                  <Tooltip contentStyle={{ background: "var(--s2)", border: "1px solid var(--bd2)", borderRadius: 8, fontSize: 11 }}/>
                  <Area type="monotone" dataKey="balance" name="Solde ($)" stroke="#00e5a0" strokeWidth={2} fill="url(#egc)" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            : <div style={{ padding: "40px 0", textAlign: "center", color: "var(--muted2)", fontSize: 11 }}>Pas encore assez de données</div>
          }
        </div>
        <div className="card card-pad">
          <div className="card-title">Positions ouvertes</div>
          {open.length === 0
            ? <div style={{ color: "var(--muted2)", fontSize: 11, padding: "16px 0" }}>Aucune position ouverte</div>
            : open.map(t => (
              <div key={t.id} onClick={() => setDetailTrade(t)} style={{ padding: "10px 0", borderBottom: "1px solid var(--bd)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={`a-ico ${ASSET_TYPE[t.asset] || "index"}`}>{ASSET_ICON[ASSET_TYPE[t.asset] || "index"]}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{t.asset}</div>
                    <div style={{ fontSize: 10, color: "var(--muted2)" }}>{t.date}</div>
                  </div>
                </div>
                <span className="bdg bdg-open">OPEN</span>
              </div>
            ))
          }
        </div>
      </div>

      {/* ── Derniers trades ── */}
      <div className="card">
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="card-title" style={{ margin: 0 }}>Derniers trades</div>
          <button className="btn btn-ghost btn-sm" onClick={() => setPage("trades")}>Voir tout →</button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Actif</th><th>Date</th><th>Dir.</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>R</th><th>Setup</th></tr></thead>
            <tbody>
              {recent.map(t => {
                const rm = calcR(t);
                return (
                  <tr key={t.id} onClick={() => setDetailTrade(t)}>
                    <td><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`a-ico ${ASSET_TYPE[t.asset] || "index"}`}>{ASSET_ICON[ASSET_TYPE[t.asset] || "index"]}</span><strong>{t.asset}</strong></div></td>
                    <td style={{ color: "var(--muted2)", fontSize: 11 }}>{t.date}</td>
                    <td><span className={`bdg bdg-${t.direction === "LONG" ? "long" : "short"}`}>{t.direction}</span></td>
                    <td>{fmt(t.entry)}</td>
                    <td>{t.exit ? fmt(t.exit) : <span className="amb">—</span>}</td>
                    <td>{fmtPnl(t.pnl)}</td>
                    <td>{rm != null ? <span style={{ color: rm >= 1 ? "var(--accent)" : "var(--red)" }}>{rm > 0 ? "+" : ""}{rm}R</span> : "—"}</td>
                    <td><span className="setup-tag">{t.setup}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Badge source données */}
      <div style={{ textAlign: "right", fontSize: 9, color: "var(--muted)", marginTop: 8 }}>
        {loadingApi ? "⟳ Chargement analytics…" : apiStats ? "✓ Stats chargées depuis le serveur" : "⚠ Mode hors-ligne — données locales"}
      </div>
    </>
  );
}

// ─── TRADES PAGE ──────────────────────────────────────────────────────────────
function TradesPage({trades,onEdit,onDelete,onDetail}){
  const [fa,setFa]=useState("all");const [fs,setFs]=useState("all");const [ft,setFt]=useState("all");const [pg,setPg]=useState(1);const PER=10;

  // Collect all unique tags from trades
  const allTags = useMemo(()=>[...new Set(trades.flatMap(t=>t.tags||[]))].sort(),[trades]);

  const filtered=trades.filter(t=>
    (fa==="all"||t.asset===fa)&&
    (fs==="all"||t.status===fs)&&
    (ft==="all"||(t.tags||[]).includes(ft))
  ).sort((a,b)=>b.date.localeCompare(a.date));
  const tp=Math.ceil(filtered.length/PER);const paged=filtered.slice((pg-1)*PER,pg*PER);
  if(!trades.length)return<div className="empty-state"><div className="empty-icon">📋</div><div className="empty-title">Aucun trade</div><div className="empty-desc">Ajoutez votre premier trade.</div></div>;
  return(
    <>
      <div className="filter-bar">
        <select value={fa} onChange={e=>{setFa(e.target.value);setPg(1);}}><option value="all">Tous actifs</option>{ASSETS.map(a=><option key={a}>{a}</option>)}</select>
        <select value={fs} onChange={e=>{setFs(e.target.value);setPg(1);}}><option value="all">Tous statuts</option><option value="CLOSED">Closés</option><option value="OPEN">Ouverts</option></select>
        {allTags.length>0&&<select value={ft} onChange={e=>{setFt(e.target.value);setPg(1);}}><option value="all">Tous les tags</option>{allTags.map(t=><option key={t}>{t}</option>)}</select>}
        <span style={{marginLeft:"auto",fontSize:10,color:"var(--muted2)"}}>{filtered.length} trades</span>
      </div>
      <div className="card">
        <div className="tbl-wrap"><table><thead><tr><th>Actif</th><th>Date</th><th>Dir.</th><th>Entrée</th><th>Sortie</th><th>P&L</th><th>R</th><th>Tags</th><th>Statut</th><th></th></tr></thead>
          <tbody>{paged.map(t=>{const rm=calcR(t);return(
            <tr key={t.id}>
              <td onClick={()=>onDetail(t)}><div style={{display:"flex",gap:8,alignItems:"center"}}><span className={`a-ico ${ASSET_TYPE[t.asset]||"index"}`}>{ASSET_ICON[ASSET_TYPE[t.asset]||"index"]}</span><strong>{t.asset}</strong></div></td>
              <td onClick={()=>onDetail(t)} style={{color:"var(--muted2)",fontSize:11}}>{t.date}</td>
              <td onClick={()=>onDetail(t)}><span className={`bdg bdg-${t.direction==="LONG"?"long":"short"}`}>{t.direction}</span></td>
              <td onClick={()=>onDetail(t)}>{fmt(t.entry)}</td><td onClick={()=>onDetail(t)}>{t.exit?fmt(t.exit):<span className="amb">—</span>}</td>
              <td onClick={()=>onDetail(t)}>{fmtPnl(t.pnl)}</td>
              <td onClick={()=>onDetail(t)}>{rm!=null?<span style={{color:rm>=1?"var(--accent)":"var(--red)"}}>{rm>0?"+":""}{rm}R</span>:"—"}</td>
              <td onClick={()=>onDetail(t)}><div style={{display:"flex",gap:3,flexWrap:"wrap"}}>{(t.tags||[]).slice(0,2).map(tag=><span key={tag} className="tag" style={{background:`${tagColor(tag)}15`,borderColor:`${tagColor(tag)}35`,color:tagColor(tag),fontSize:8,padding:"1px 6px"}}>{tag}</span>)}{(t.tags||[]).length>2&&<span style={{fontSize:9,color:"var(--muted)"}}>+{t.tags.length-2}</span>}</div></td>
              <td onClick={()=>onDetail(t)}><span className={`bdg bdg-${t.status==="OPEN"?"open":t.pnl>=0?"win":"loss"}`}>{t.status==="OPEN"?"OPEN":t.pnl>=0?"WIN":"LOSS"}</span></td>
              <td onClick={e=>e.stopPropagation()}><div style={{display:"flex",gap:5}}><button className="btn btn-ghost btn-sm" onClick={()=>onEdit(t)}>✎</button><button className="btn btn-red btn-sm" onClick={()=>onDelete(t.id)}>✕</button></div></td>
            </tr>);})}</tbody>
        </table></div>
        {tp>1&&<div className="pagination"><span>{(pg-1)*PER+1}–{Math.min(pg*PER,filtered.length)} sur {filtered.length}</span><div className="page-btns"><div className="pb" onClick={()=>setPg(p=>Math.max(1,p-1))}>←</div>{Array.from({length:tp},(_,i)=><div key={i} className={`pb${pg===i+1?" on":""}`} onClick={()=>setPg(i+1)}>{i+1}</div>)}<div className="pb" onClick={()=>setPg(p=>Math.min(tp,p+1))}>→</div></div></div>}
      </div>

      {/* Stats par tag */}
      {allTags.length>0&&(
        <div className="card card-pad" style={{marginTop:14}}>
          <div className="card-title">Performance par tag</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {allTags.map(tag=>{
              const tt=trades.filter(t=>t.status==="CLOSED"&&(t.tags||[]).includes(tag));
              const pnl=tt.reduce((s,t)=>s+(t.pnl||0),0);
              const wr=tt.length?((tt.filter(t=>t.pnl>0).length/tt.length)*100).toFixed(0):0;
              return(
                <div key={tag} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",background:"var(--s2)",borderRadius:8}}>
                  <span className="tag" style={{background:`${tagColor(tag)}15`,borderColor:`${tagColor(tag)}35`,color:tagColor(tag),minWidth:110}}>{tag}</span>
                  <span style={{fontSize:11,color:"var(--muted2)"}}>{tt.length} trade{tt.length!==1?"s":""}</span>
                  <span style={{fontSize:11,color:"var(--muted2)"}}>{wr}% WR</span>
                  <span style={{fontSize:12,fontWeight:600,color:pnl>=0?"var(--accent)":"var(--red)",marginLeft:"auto"}}>{pnl>=0?"+":""}{fmt(pnl)} $</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ─── PSYCHOLOGY ───────────────────────────────────────────────────────────────
function PsychologyPage({trades,setPage,user}){
  const closed=trades.filter(t=>t.status==="CLOSED");
  const radar=useMemo(()=>{const c={};EMOTIONS.forEach(e=>c[e]=0);trades.forEach(t=>{if(t.emotion_before)c[t.emotion_before]=(c[t.emotion_before]||0)+1;});return Object.entries(c).filter(([,v])=>v>0).map(([emotion,count])=>({emotion,count}));},[trades]);
  const perf=useMemo(()=>{const m={};closed.forEach(t=>{if(!t.emotion_before)return;if(!m[t.emotion_before])m[t.emotion_before]={wins:0,total:0,pnl:0};m[t.emotion_before].total++;if(t.pnl>0)m[t.emotion_before].wins++;m[t.emotion_before].pnl+=t.pnl;});return Object.entries(m).map(([e,d])=>({emotion:e,winRate:d.total?((d.wins/d.total)*100).toFixed(0):0,avgPnl:d.total?(d.pnl/d.total).toFixed(0):0,count:d.total})).sort((a,b)=>b.avgPnl-a.avgPnl);},[trades]);
  const notes=trades.filter(t=>t.notes).sort((a,b)=>b.date.localeCompare(a.date));
  if(!trades.length)return<div className="empty-state"><div className="empty-icon">🧠</div><div className="empty-title">Aucune donnée</div></div>;
  return(
    <>
      {isPremium(user)?(
        <div className="chart-row-2">
          <div className="card card-pad"><div className="card-title">Radar des émotions</div><ResponsiveContainer width="100%" height={230}><RadarChart data={radar} margin={{top:10,right:30,bottom:10,left:30}}><PolarGrid stroke="var(--bd)"/><PolarAngleAxis dataKey="emotion" tick={{fontSize:9,fill:"var(--muted2)"}}/><Radar dataKey="count" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.12} strokeWidth={1.5}/><Tooltip contentStyle={{background:"var(--s2)",border:"1px solid var(--bd2)",borderRadius:8,fontSize:11}}/></RadarChart></ResponsiveContainer></div>
          <div className="card card-pad"><div className="card-title">Performance par émotion</div><div style={{display:"flex",flexDirection:"column",gap:12}}>{perf.map(e=>(<div key={e.emotion}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}><div style={{fontSize:12}}>{e.emotion} <span style={{color:"var(--muted)",fontSize:10}}>({e.count})</span></div><div style={{display:"flex",gap:12,fontSize:11}}><span style={{color:e.winRate>=50?"var(--accent)":"var(--red)"}}>{e.winRate}% WR</span><span style={{color:e.avgPnl>=0?"var(--accent)":"var(--red)",minWidth:64,textAlign:"right"}}>{e.avgPnl>=0?"+":""}{e.avgPnl} $</span></div></div><div className="prog-bar"><div className="prog-fill" style={{width:`${e.winRate}%`,background:e.winRate>=50?"var(--accent)":"var(--red)"}}/></div></div>))}</div></div>
        </div>
      ):(
        <div style={{marginBottom:22}}><PremiumGate title="Radar émotionnel & corrélation — Premium" description="Visualisez la fréquence de vos émotions et leur impact réel sur vos performances." features={["Graphique radar","Win rate par émotion","P&L moyen par émotion"]} setPage={setPage}/></div>
      )}
      <div className="card">
        <div style={{padding:"14px 20px",borderBottom:"1px solid var(--bd)"}}><div className="card-title" style={{margin:0}}>Réflexions post-trade</div></div>
        {notes.length===0?<div style={{padding:"28px",textAlign:"center",color:"var(--muted2)",fontSize:12}}>Aucune note</div>:
          <table><thead><tr><th>Date</th><th>Actif</th><th>P&L</th><th>Émotion</th><th>Note</th></tr></thead>
            <tbody>{notes.map(t=><tr key={t.id}><td style={{fontSize:11,color:"var(--muted2)"}}>{t.date}</td><td><strong>{t.asset}</strong></td><td>{fmtPnl(t.pnl)}</td><td style={{fontSize:11}}>{t.emotion_before}</td><td style={{fontSize:11,color:"var(--muted2)",maxWidth:300}}>{t.notes}</td></tr>)}</tbody>
          </table>}
      </div>
    </>
  );
}

// ─── CALENDRIER PAGE ──────────────────────────────────────────────────────────
function CalendrierPage({ trades, setDetailTrade }) {
  const now = new Date();
  const [year,      setYear]     = useState(now.getFullYear());
  const [month,     setMonth]    = useState(now.getMonth()); // 0-indexed
  const [apiDayMap, setApiDayMap]= useState(null); // données API heatmap

  const closed = trades.filter(t => t.status === "CLOSED");

  // Fetch heatmap API quand le mois/année change
  useEffect(() => {
    let cancelled = false;
    apiRequest(`/analytics/heatmap?year=${year}&month=${month + 1}`)
      .then(res => { if (!cancelled && res?.days) setApiDayMap(res.days); })
      .catch(() => { if (!cancelled) setApiDayMap(null); });
    return () => { cancelled = true; };
  }, [year, month]);

  // Build day map local : { "2025-01-08": { pnl, trades[] } }
  const localDayMap = useMemo(() => {
    const m = {};
    closed.forEach(t => {
      if (!m[t.date]) m[t.date] = { pnl: 0, trades: [] };
      m[t.date].pnl += t.pnl || 0;
      m[t.date].trades.push(t);
    });
    return m;
  }, [trades]);

  // Merge : on enrichit le dayMap local avec les p&l confirmés par l'API
  const dayMap = useMemo(() => {
    if (!apiDayMap) return localDayMap;
    // L'API fournit { "2025-01-08": { pnl, trades } } — on garde les trades locaux pour le click
    const merged = { ...localDayMap };
    Object.entries(apiDayMap).forEach(([date, apiDay]) => {
      if (merged[date]) {
        merged[date] = { ...merged[date], pnl: apiDay.pnl }; // Priorité API pour le P&L
      } else {
        merged[date] = { pnl: apiDay.pnl, trades: [] };
      }
    });
    return merged;
  }, [localDayMap, apiDayMap]);

  // Calendar grid
  const firstDay    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDay + 6) % 7;
  const totalCells  = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const monthName = new Date(year, month).toLocaleString("fr-FR", { month: "long", year: "numeric" });
  const todayStr  = now.toISOString().slice(0, 10);

  const prev = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const next = () => { if (month === 11) { setMonth(0); setYear(y => y + 1); } else setMonth(m => m + 1); };

  // Monthly summary
  const monthPrefix  = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthEntries = Object.entries(dayMap).filter(([d]) => d.startsWith(monthPrefix));
  const monthPnl     = monthEntries.reduce((s, [, v]) => s + v.pnl, 0);
  const winDays      = monthEntries.filter(([, v]) => v.pnl > 0).length;
  const lossDays     = monthEntries.filter(([, v]) => v.pnl < 0).length;
  const bestDay      = monthEntries.length ? Math.max(...monthEntries.map(([, v]) => v.pnl)) : 0;
  const worstDay     = monthEntries.length ? Math.min(...monthEntries.map(([, v]) => v.pnl)) : 0;

  return (
    <>
      {/* Monthly summary */}
      <div className="cal-summary">
        {[
          { label: "P&L du mois", val: <span className={monthPnl>=0?"pos":"neg"}>{monthPnl>=0?"+":""}{fmt(monthPnl)} $</span> },
          { label: "Jours verts",  val: <span className="pos">{winDays}</span> },
          { label: "Jours rouges", val: <span className="neg">{lossDays}</span> },
          { label: "Meilleur jour", val: <span className="pos">{bestDay>0?"+":""}{fmt(bestDay)} $</span> },
        ].map(s => (
          <div key={s.label} className="cal-stat">
            <div className="cal-stat-val">{s.val}</div>
            <div className="cal-stat-lbl">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="card card-pad">
        {/* Header */}
        <div className="cal-header">
          <div className="cal-month">{monthName.charAt(0).toUpperCase() + monthName.slice(1)}</div>
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={prev}>←</button>
            <button className="cal-nav-btn" onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}>Aujourd'hui</button>
            <button className="cal-nav-btn" onClick={next}>→</button>
          </div>
        </div>

        {/* Day of week headers */}
        <div className="cal-grid">
          {["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"].map(d => (
            <div key={d} className="cal-dow">{d}</div>
          ))}

          {/* Calendar cells */}
          {Array.from({ length: totalCells }, (_, i) => {
            const dayNum = i - startOffset + 1;
            if (dayNum < 1 || dayNum > daysInMonth) return <div key={i} className="cal-day empty"/>;
            const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(dayNum).padStart(2,"0")}`;
            const dayData = dayMap[dateStr];
            const isToday = dateStr === todayStr;
            const cls = ["cal-day",
              isToday ? "today" : "",
              dayData ? (dayData.pnl >= 0 ? "win" : "loss") : "",
              dayData ? "has-trades" : "",
            ].filter(Boolean).join(" ");

            return (
              <div key={i} className={cls} onClick={() => dayData?.trades.length === 1 ? setDetailTrade(dayData.trades[0]) : null}>
                <div className="cal-day-num">{dayNum}</div>
                {dayData && (
                  <>
                    <div className="cal-day-pnl" style={{ color: dayData.pnl >= 0 ? "var(--accent)" : "var(--red)" }}>
                      {dayData.pnl >= 0 ? "+" : ""}{fmt(dayData.pnl)} $
                    </div>
                    <div className="cal-day-count">{dayData.trades.length} trade{dayData.trades.length > 1 ? "s" : ""}</div>
                    <div className="cal-day-dots">
                      {dayData.trades.slice(0, 5).map((t, ti) => (
                        <div key={ti} className="cal-dot" style={{ background: (t.pnl||0) >= 0 ? "var(--accent)" : "var(--red)" }}/>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div style={{ display:"flex", gap:16, marginTop:16, fontSize:10, color:"var(--muted2)", flexWrap:"wrap" }}>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:2, background:"rgba(0,229,160,.15)", border:"1px solid rgba(0,229,160,.3)", display:"inline-block" }}/> Jour vert</span>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:2, background:"rgba(255,77,109,.15)", border:"1px solid rgba(255,77,109,.3)", display:"inline-block" }}/> Jour rouge</span>
          <span style={{ display:"flex", alignItems:"center", gap:5 }}><span style={{ width:10, height:10, borderRadius:2, border:"1px solid var(--accent)", display:"inline-block" }}/> Aujourd'hui</span>
          <span style={{ marginLeft:"auto" }}>Cliquez sur un jour pour voir le trade</span>
        </div>
      </div>
    </>
  );
}

// ─── ANALYSES PAGE (tabbed) ───────────────────────────────────────────────────
function AnalysesPage({ trades }) {
  const [tab, setTab] = useState("stats");

  // ── Fetch toutes les stats API en parallèle ───────────────────
  const [overview,  setOverview]  = useState(null);
  const [assets,    setAssets]    = useState(null);
  const [emotions,  setEmotions]  = useState(null);
  const [hours,     setHours]     = useState(null);
  const [streak,    setStreak]    = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [apiOk,     setApiOk]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [ov, as, em, hr, st] = await Promise.all([
          apiRequest("/analytics/overview"),
          apiRequest("/analytics/assets"),
          apiRequest("/analytics/emotions"),
          apiRequest("/analytics/hours"),
          apiRequest("/analytics/streak"),
        ]);
        if (!cancelled) {
          setOverview(ov);
          setAssets(as);
          setEmotions(em);
          setHours(hr);
          setStreak(st);
          setApiOk(true);
        }
      } catch {
        if (!cancelled) setApiOk(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [trades.length]);

  const closed = trades.filter(t => t.status === "CLOSED");

  if (!closed.length) return (
    <div className="empty-state">
      <div className="empty-icon">📈</div>
      <div className="empty-title">Pas encore de données</div>
      <div className="empty-desc">Closez des trades pour voir les analyses avancées.</div>
    </div>
  );

  return (
    <>
      {/* Badge source */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 9, padding: "3px 10px", borderRadius: 20, border: "1px solid var(--bd)", color: apiOk ? "var(--accent)" : "var(--amber)" }}>
          {loading ? "⟳ Chargement…" : apiOk ? "✓ Données serveur en temps réel" : "⚠ Mode hors-ligne — calculs locaux"}
        </div>
        {streak && (
          <div style={{ fontSize: 10, color: streak.current?.type === "win" ? "var(--accent)" : "var(--red)", fontWeight: 600 }}>
            {streak.current?.streak > 0
              ? `${streak.current.streak} ${streak.current.type === "win" ? "✅" : "❌"} de suite`
              : "—"}
          </div>
        )}
      </div>

      {/* Onglets */}
      <div className="atabs">
        {[
          { id: "stats",    label: "📊 Statistiques" },
          { id: "assets",   label: "🏦 Par actif" },
          { id: "emotions", label: "🧠 Émotions" },
          { id: "mfemae",   label: "🎯 MFE / MAE" },
          { id: "horaire",  label: "⏱ Par heure" },
        ].map(t => (
          <div key={t.id} className={`atab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>

      {tab === "stats"    && <StatsTab    trades={trades} closed={closed} overview={overview} loading={loading} />}
      {tab === "assets"   && <AssetsTab   trades={trades} closed={closed} apiAssets={assets}  loading={loading} />}
      {tab === "emotions" && <EmotionsTab trades={trades} closed={closed} apiEmotions={emotions} loading={loading} />}
      {tab === "mfemae"   && <MfeMaeTab   trades={trades} closed={closed} />}
      {tab === "horaire"  && <HoraireTab  trades={trades} closed={closed} apiHours={hours}    loading={loading} />}
    </>
  );
}

// ── Tab 1 : Statistiques (API overview) ──────────────────────────
function StatsTab({ trades, closed, overview, loading }) {
  // Fallback local si API indispo
  const pf = useMemo(() => {
    const g = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const l = Math.abs(closed.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return l > 0 ? (g / l).toFixed(2) : "∞";
  }, [trades]);

  const dd = useMemo(() => {
    let bal = 0, peak = 0, maxDD = 0;
    [...closed].sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
      bal += (t.pnl || 0); if (bal > peak) peak = bal;
      const d = peak - bal; if (d > maxDD) maxDD = d;
    });
    return { maxDD: maxDD.toFixed(2), pct: peak > 0 ? ((maxDD / peak) * 100).toFixed(1) : 0 };
  }, [trades]);

  const avg = closed.length ? (closed.reduce((s, t) => s + (t.pnl || 0), 0) / closed.length) : 0;

  // Priorité : données API
  const displayPf  = overview ? overview.profitFactor : pf;
  const displayDd  = overview ? fmt(overview.maxDrawdown) : fmt(dd.maxDD);
  const displayDdP = overview ? "—" : `${dd.pct}%`;
  const displayExp = overview ? overview.expectancy : avg.toFixed(2);
  const displayN   = overview ? overview.trades : closed.length;

  // Distribution R (locale — backend n'a pas cet endpoint)
  const rDist = useMemo(() => {
    const b = { "<-2R": 0, "-2:-1R": 0, "-1:0R": 0, "0:1R": 0, "1:2R": 0, "2:3R": 0, ">3R": 0 };
    closed.forEach(t => {
      const r = calcR(t); if (r == null) return;
      if (r < -2) b["<-2R"]++; else if (r < -1) b["-2:-1R"]++; else if (r < 0) b["-1:0R"]++;
      else if (r < 1) b["0:1R"]++; else if (r < 2) b["1:2R"]++; else if (r < 3) b["2:3R"]++; else b[">3R"]++;
    });
    return Object.entries(b).map(([label, count]) => ({ label, count }));
  }, [trades]);

  return (
    <>
      <div className="kpi-grid">
        <div className="kpi r">
          <div className="kpi-label">Drawdown max</div>
          <div className="kpi-val neg">-{displayDd} $</div>
          <div className="kpi-sub">{displayDdP} du capital peak</div>
        </div>
        <div className="kpi g">
          <div className="kpi-label">Profit Factor</div>
          <div className="kpi-val">{displayPf}</div>
          <div className="kpi-sub">Gains / Pertes</div>
        </div>
        <div className="kpi a">
          <div className="kpi-label">Espérance</div>
          <div className="kpi-val"><span className={displayExp >= 0 ? "pos" : "neg"}>{displayExp >= 0 ? "+" : ""}{fmt(displayExp)} $</span></div>
          <div className="kpi-sub">Par trade</div>
        </div>
        <div className="kpi b">
          <div className="kpi-label">Analysés</div>
          <div className="kpi-val">{displayN}</div>
          <div className="kpi-sub">Trades closés</div>
        </div>
      </div>

      {/* Gains / Pertes moyens (API) */}
      {overview && (
        <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 0 }}>
          <div className="kpi g">
            <div className="kpi-label">Gain moyen / trade</div>
            <div className="kpi-val pos">+{fmt(overview.avgWin)} $</div>
            <div className="kpi-sub">{overview.wins} trades gagnants</div>
          </div>
          <div className="kpi r">
            <div className="kpi-label">Perte moyenne / trade</div>
            <div className="kpi-val neg">-{fmt(overview.avgLoss)} $</div>
            <div className="kpi-sub">{overview.losses} trades perdants</div>
          </div>
        </div>
      )}

      <div className="chart-row-2">
        {/* P&L par actif (rapide depuis local) */}
        <div className="card card-pad">
          <div className="card-title">P&L par actif</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={(() => { const m = {}; closed.forEach(t => { if (!m[t.asset]) m[t.asset] = { asset: t.asset, pnl: 0 }; m[t.asset].pnl += t.pnl || 0; }); return Object.values(m).sort((a, b) => b.pnl - a.pnl); })()}>
              <XAxis dataKey="asset" tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false}/>
              <Tooltip contentStyle={{ background: "var(--s2)", border: "1px solid var(--bd2)", borderRadius: 8, fontSize: 11 }}/>
              <Bar dataKey="pnl" name="P&L ($)" radius={[4, 4, 0, 0]}>
                {closed.map((_, i) => <Cell key={i} fill="#00e5a0" fillOpacity={0.8}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Distribution R multiples */}
        <div className="card card-pad">
          <div className="card-title">Distribution R multiples</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rDist}>
              <XAxis dataKey="label" tick={{ fontSize: 8, fill: "var(--muted2)" }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false} allowDecimals={false}/>
              <Tooltip contentStyle={{ background: "var(--s2)", border: "1px solid var(--bd2)", borderRadius: 8, fontSize: 11 }}/>
              <Bar dataKey="count" name="Trades" radius={[3, 3, 0, 0]}>
                {rDist.map((e, i) => <Cell key={i} fill={e.label.startsWith("<") || e.label.startsWith("-") ? "#ff4d6d" : "#00e5a0"} fillOpacity={0.75}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

// ── Tab 2 : Par actif (API /analytics/assets) ─────────────────────
function AssetsTab({ trades, closed, apiAssets, loading }) {
  // Fallback local
  const localAssets = useMemo(() => {
    const m = {};
    closed.forEach(t => {
      if (!m[t.asset]) m[t.asset] = { asset: t.asset, pnl: 0, trades: 0, wins: 0 };
      m[t.asset].pnl += t.pnl || 0;
      m[t.asset].trades++;
      if (t.pnl > 0) m[t.asset].wins++;
    });
    return Object.values(m)
      .map(a => ({ ...a, pnl: parseFloat(a.pnl.toFixed(2)), winRate: Math.round((a.wins / a.trades) * 100) }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [trades]);

  const data = apiAssets?.assets || localAssets;
  const maxPnl = Math.max(...data.map(a => Math.abs(a.pnl)), 1);

  return (
    <>
      {/* Barres horizontales */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="card-title">Performance par actif</div>
        {data.slice(0, 10).map(a => (
          <div key={a.asset} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`a-ico ${ASSET_TYPE[a.asset] || "index"}`} style={{ width: 20, height: 20, fontSize: 10 }}>
                  {ASSET_ICON[ASSET_TYPE[a.asset] || "index"]}
                </span>
                <span style={{ fontWeight: 600, fontSize: 12 }}>{a.asset}</span>
                <span style={{ fontSize: 9, color: "var(--muted2)" }}>{a.trades} trade{a.trades > 1 ? "s" : ""}</span>
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: a.winRate >= 50 ? "var(--accent)" : "var(--red)" }}>{a.winRate}% WR</span>
                <span style={{ fontFamily: "var(--fh)", fontSize: 13, fontWeight: 700, color: a.pnl >= 0 ? "var(--accent)" : "var(--red)", minWidth: 70, textAlign: "right" }}>
                  {a.pnl >= 0 ? "+" : ""}{fmt(a.pnl)} $
                </span>
              </div>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bd)", overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${(Math.abs(a.pnl) / maxPnl) * 100}%`,
                background: a.pnl >= 0 ? "var(--accent)" : "var(--red)",
                opacity: 0.7,
                borderRadius: 3,
                transition: "width .4s",
              }}/>
            </div>
          </div>
        ))}
      </div>

      {/* Tableau détaillé */}
      <div className="card">
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bd)" }}>
          <div className="card-title" style={{ margin: 0 }}>Tableau complet</div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Actif</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>P&L</th>
                {apiAssets && <th>R moyen</th>}
                {apiAssets && <th>% Long</th>}
              </tr>
            </thead>
            <tbody>
              {data.map(a => (
                <tr key={a.asset}>
                  <td><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`a-ico ${ASSET_TYPE[a.asset] || "index"}`}>{ASSET_ICON[ASSET_TYPE[a.asset] || "index"]}</span><strong>{a.asset}</strong></div></td>
                  <td>{a.trades}</td>
                  <td><span style={{ color: a.winRate >= 50 ? "var(--accent)" : "var(--red)", fontWeight: 600 }}>{a.winRate}%</span></td>
                  <td><span style={{ color: a.pnl >= 0 ? "var(--accent)" : "var(--red)", fontWeight: 700 }}>{a.pnl >= 0 ? "+" : ""}{fmt(a.pnl)} $</span></td>
                  {apiAssets && <td style={{ color: "var(--muted2)" }}>{a.avgR != null ? `${a.avgR > 0 ? "+" : ""}${a.avgR}R` : "—"}</td>}
                  {apiAssets && <td style={{ color: "var(--muted2)" }}>{a.longRatio != null ? `${a.longRatio}%` : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Tab 3 : Émotions (API /analytics/emotions) ────────────────────
function EmotionsTab({ trades, closed, apiEmotions, loading }) {
  // Fallback local
  const localEmotions = useMemo(() => {
    const m = {};
    closed.forEach(t => {
      const e = t.emotion_before; if (!e) return;
      if (!m[e]) m[e] = { emotion: e, pnl: 0, trades: 0, wins: 0 };
      m[e].pnl += t.pnl || 0;
      m[e].trades++;
      if (t.pnl > 0) m[e].wins++;
    });
    return Object.values(m)
      .map(e => ({ ...e, pnl: parseFloat(e.pnl.toFixed(2)), winRate: Math.round((e.wins / e.trades) * 100) }))
      .sort((a, b) => b.winRate - a.winRate);
  }, [trades]);

  const data = apiEmotions?.emotions || localEmotions;
  const best = apiEmotions?.bestEmotion || data[0]?.emotion;

  const EMOTION_COLORS = {
    "Confiant":   "#00e5a0", "Neutre":     "#38bdf8", "Satisfait":  "#a78bfa",
    "FOMO":       "#f59e0b", "Impatient":  "#f59e0b", "Frustré":    "#ff4d6d",
    "Anxieux":    "#ff4d6d", "Très satisfait": "#00e5a0",
  };

  if (!data.length) return (
    <div style={{ padding: "40px", textAlign: "center", color: "var(--muted2)", fontSize: 12 }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🧠</div>
      Remplissez l'émotion avant-trade pour voir les corrélations.
    </div>
  );

  return (
    <>
      {best && (
        <div style={{ background: "rgba(0,229,160,.06)", border: "1px solid rgba(0,229,160,.2)", borderRadius: 10, padding: "14px 18px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 28 }}>🏆</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Meilleure émotion : <span style={{ color: "var(--accent)" }}>{best}</span></div>
            <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 2 }}>C'est dans cet état d'esprit que vous tradez le mieux.</div>
          </div>
        </div>
      )}

      {/* Barres par émotion */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="card-title">Win Rate par émotion</div>
        {data.map(e => {
          const col = EMOTION_COLORS[e.emotion] || "var(--muted2)";
          return (
            <div key={e.emotion} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: col }}/>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{e.emotion}</span>
                  <span style={{ fontSize: 9, color: "var(--muted2)" }}>{e.trades} trade{e.trades > 1 ? "s" : ""}</span>
                </div>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: e.pnl >= 0 ? "var(--accent)" : "var(--red)" }}>{e.pnl >= 0 ? "+" : ""}{fmt(e.pnl)} $</span>
                  <span style={{ fontFamily: "var(--fh)", fontSize: 14, fontWeight: 700, color: e.winRate >= 50 ? col : "var(--red)", minWidth: 42, textAlign: "right" }}>{e.winRate}%</span>
                </div>
              </div>
              <div style={{ height: 7, borderRadius: 4, background: "var(--bd)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${e.winRate}%`, background: col, opacity: 0.75, borderRadius: 4, transition: "width .4s" }}/>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tableau */}
      <div className="card">
        <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--bd)" }}>
          <div className="card-title" style={{ margin: 0 }}>Détail émotion / performance</div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Émotion</th><th>Trades</th><th>Win Rate</th><th>P&L total</th>{apiEmotions && <th>R moyen</th>}</tr></thead>
            <tbody>
              {data.map(e => (
                <tr key={e.emotion}>
                  <td><div style={{ display: "flex", gap: 6, alignItems: "center" }}><div style={{ width: 8, height: 8, borderRadius: "50%", background: EMOTION_COLORS[e.emotion] || "var(--muted2)" }}/><strong>{e.emotion}</strong></div></td>
                  <td>{e.trades}</td>
                  <td><span style={{ fontWeight: 600, color: e.winRate >= 50 ? "var(--accent)" : "var(--red)" }}>{e.winRate}%</span></td>
                  <td><span style={{ fontWeight: 700, color: e.pnl >= 0 ? "var(--accent)" : "var(--red)" }}>{e.pnl >= 0 ? "+" : ""}{fmt(e.pnl)} $</span></td>
                  {apiEmotions && <td style={{ color: "var(--muted2)" }}>{e.avgR != null ? `${e.avgR > 0 ? "+" : ""}${e.avgR}R` : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Tab 2 : MFE / MAE ─────────────────────────────────────────────────────────
function MfeMaeTab({ trades, closed }) {
  // Simule MFE/MAE : en réalité calculé depuis données tick-by-tick
  // Ici on estime depuis entry/exit/sl/tp disponibles dans nos trades
  const mfeData = useMemo(() => {
    return closed.map(t => {
      const entry = t.entry, exit = t.exit, tp = t.tp, sl = t.sl;
      if (!entry || !exit) return null;
      const dir = t.direction === "LONG" ? 1 : -1;
      // MFE = meilleur mouvement favorable avant sortie (estimé via TP si disponible)
      const mfe = tp ? Math.abs(tp - entry) * dir : Math.abs(exit - entry) * dir * 1.2;
      // MAE = pire mouvement adverse (estimé via SL si disponible)
      const mae = sl ? Math.abs(sl - entry) * dir * -1 : Math.abs(exit - entry) * dir * -0.3;
      // Efficacité de sortie : pnl réel / mfe potentiel
      const pnlPoints = (exit - entry) * dir;
      const efficiency = mfe > 0 ? Math.min(100, Math.max(0, (pnlPoints / mfe) * 100)) : 0;
      return { id: t.id, asset: t.asset, date: t.date, pnl: t.pnl, mfe: parseFloat((mfe * t.size).toFixed(2)), mae: parseFloat((Math.abs(mae) * t.size).toFixed(2)), efficiency: parseFloat(efficiency.toFixed(1)), direction: t.direction };
    }).filter(Boolean);
  }, [trades]);

  const avgMfe = mfeData.length ? mfeData.reduce((s,t) => s+t.mfe, 0) / mfeData.length : 0;
  const avgMae = mfeData.length ? mfeData.reduce((s,t) => s+t.mae, 0) / mfeData.length : 0;
  const avgEff = mfeData.length ? mfeData.reduce((s,t) => s+t.efficiency, 0) / mfeData.length : 0;
  const maxMfe = mfeData.length ? Math.max(...mfeData.map(t => t.mfe)) : 1;
  const maxMae = mfeData.length ? Math.max(...mfeData.map(t => t.mae)) : 1;

  return (
    <>
      {/* KPIs MFE/MAE */}
      <div className="kpi-grid" style={{gridTemplateColumns:"repeat(3,1fr)"}}>
        <div className="kpi g">
          <div className="kpi-label">MFE moyen</div>
          <div className="kpi-val pos">+{fmt(avgMfe)} $</div>
          <div className="kpi-sub">Gain potentiel moyen</div>
        </div>
        <div className="kpi r">
          <div className="kpi-label">MAE moyen</div>
          <div className="kpi-val neg">-{fmt(avgMae)} $</div>
          <div className="kpi-sub">Exposition adverse moy.</div>
        </div>
        <div className="kpi a">
          <div className="kpi-label">Efficacité de sortie</div>
          <div className="kpi-val">{avgEff.toFixed(1)}%</div>
          <div className="kpi-sub">P&L réel / MFE potentiel</div>
        </div>
      </div>

      <div className="mae-grid">
        {/* MFE par trade */}
        <div className="mae-card">
          <div className="mae-title">MFE — Gain potentiel max</div>
          <div className="mae-subtitle">Combien le trade était en profit au maximum avant votre sortie. Un MFE élevé avec un P&L faible = sortie trop tôt.</div>
          {mfeData.slice(0,8).map(t => (
            <div key={t.id} className="mae-row">
              <div className="mae-asset">{t.asset}<br/><span style={{fontSize:9,color:"var(--muted)"}}>{t.date}</span></div>
              <div className="mae-bar-wrap">
                <div className="mae-bar" style={{ width:`${(t.mfe/maxMfe)*100}%`, background:"var(--accent)", opacity:.7 }}/>
              </div>
              <div className="mae-val pos">+{fmt(t.mfe)} $</div>
            </div>
          ))}
        </div>

        {/* MAE par trade */}
        <div className="mae-card">
          <div className="mae-title">MAE — Exposition adverse max</div>
          <div className="mae-subtitle">Combien le trade était en perte au maximum. Un MAE élevé suggère un stop trop large ou une mauvaise entrée.</div>
          {mfeData.slice(0,8).map(t => (
            <div key={t.id} className="mae-row">
              <div className="mae-asset">{t.asset}<br/><span style={{fontSize:9,color:"var(--muted)"}}>{t.date}</span></div>
              <div className="mae-bar-wrap">
                <div className="mae-bar" style={{ width:`${(t.mae/maxMae)*100}%`, background:"var(--red)", opacity:.7 }}/>
              </div>
              <div className="mae-val neg">-{fmt(t.mae)} $</div>
            </div>
          ))}
        </div>
      </div>

      {/* Efficacité de sortie */}
      <div className="card">
        <div style={{padding:"14px 20px",borderBottom:"1px solid var(--bd)"}}>
          <div className="card-title" style={{margin:0}}>Efficacité de sortie par trade</div>
        </div>
        <div style={{padding:"4px 0"}}>
          <div className="eff-row" style={{background:"var(--s2)",fontWeight:600,fontSize:9,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted)"}}>
            <span>Actif / Date</span><span style={{textAlign:"center"}}>P&L réel</span><span>Efficacité</span><span style={{textAlign:"center"}}>MFE potentiel</span>
          </div>
          {mfeData.map(t => (
            <div key={t.id} className="eff-row">
              <div>
                <div style={{fontWeight:600}}>{t.asset}</div>
                <div style={{fontSize:9,color:"var(--muted2)"}}>{t.date}</div>
              </div>
              <div style={{textAlign:"center"}}><span className={t.pnl>=0?"pos":"neg"}>{t.pnl>=0?"+":""}{fmt(t.pnl)} $</span></div>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div className="eff-bar-wrap" style={{flex:1}}>
                    <div className="eff-bar" style={{width:`${t.efficiency}%`,background:t.efficiency>=60?"var(--accent)":t.efficiency>=35?"var(--amber)":"var(--red)"}}/>
                  </div>
                  <span style={{fontSize:11,fontWeight:600,minWidth:36,color:t.efficiency>=60?"var(--accent)":t.efficiency>=35?"var(--amber)":"var(--red)"}}>{t.efficiency}%</span>
                </div>
              </div>
              <div style={{textAlign:"center",color:"var(--accent)"}}>{fmt(t.mfe)} $</div>
            </div>
          ))}
        </div>
        <div style={{padding:"12px 20px",borderTop:"1px solid var(--bd)",fontSize:10,color:"var(--muted2)",lineHeight:1.6}}>
          💡 <strong style={{color:"var(--text)"}}>Lecture :</strong> 100% = sortie parfaite au point le plus haut. 0% = sortie au pire moment. Une efficacité moyenne &gt; 60% est excellente.
        </div>
      </div>
    </>
  );
}

// ── Tab 3 : Performance par heure / jour de la semaine ────────────────────────
function HoraireTab({ trades, closed, apiHours, loading }) {
  const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

  // ── Données heures — API si dispo, sinon local ────────────────
  const localByHour = useMemo(() => {
    const HOURS = Array.from({ length: 14 }, (_, i) => i + 7);
    const m = {};
    HOURS.forEach(h => m[h] = { pnl: 0, count: 0, wins: 0 });
    closed.forEach(t => {
      const h = parseInt((t.time || "09:00").split(":")[0]);
      if (m[h]) { m[h].pnl += t.pnl || 0; m[h].count++; if (t.pnl > 0) m[h].wins++; }
    });
    return HOURS.map(h => ({
      hour: `${h}h`,
      pnl:   parseFloat(m[h].pnl.toFixed(2)),
      count: m[h].count,
      wr:    m[h].count ? ((m[h].wins / m[h].count) * 100).toFixed(0) : 0,
    }));
  }, [trades]);

  const byHour = apiHours?.hours
    ? apiHours.hours.map(h => ({
        hour:  `${h.hour}h`,
        pnl:   parseFloat(((h.pnl) || 0).toFixed(2)),
        count: h.trades || 0,
        wr:    h.winRate || 0,
      }))
    : localByHour;

  const apiBestHour = apiHours?.bestHour != null ? `${apiHours.bestHour}h` : null;

  // ── Données jours — local ──────────────────────────────────────
  const byDay = useMemo(() => {
    const m = {};
    DAYS.forEach(d => m[d] = { pnl: 0, count: 0, wins: 0 });
    closed.forEach(t => {
      const dayIdx = (new Date(t.date).getDay() + 6) % 7;
      const dayKey = DAYS[dayIdx];
      if (m[dayKey]) { m[dayKey].pnl += t.pnl || 0; m[dayKey].count++; if (t.pnl > 0) m[dayKey].wins++; }
    });
    return DAYS.map(d => ({
      day:   d,
      pnl:   parseFloat(m[d].pnl.toFixed(2)),
      count: m[d].count,
      wr:    m[d].count ? ((m[d].wins / m[d].count) * 100).toFixed(0) : 0,
    }));
  }, [trades]);

  const maxHourPnl = Math.max(...byHour.map(h => Math.abs(h.pnl)), 1);
  const maxDayPnl  = Math.max(...byDay.map(d => Math.abs(d.pnl)), 1);

  const bestHour  = apiBestHour
    ? byHour.find(h => h.hour === apiBestHour) || [...byHour].sort((a, b) => b.pnl - a.pnl)[0]
    : [...byHour].sort((a, b) => b.pnl - a.pnl)[0];
  const worstHour = [...byHour].sort((a, b) => a.pnl - b.pnl)[0];
  const bestDay   = [...byDay].sort((a, b) => b.pnl - a.pnl)[0];
  const worstDay  = [...byDay].sort((a, b) => a.pnl - b.pnl)[0];

  const cellBg = (pnl, max) => {
    if (pnl === 0) return "var(--s2)";
    const intensity = Math.min(0.3, (Math.abs(pnl) / max) * 0.3);
    return pnl > 0 ? `rgba(0,229,160,${intensity})` : `rgba(255,77,109,${intensity})`;
  };

  return (
    <>
      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi g">
          <div className="kpi-label">Meilleure heure {apiBestHour && "🔌"}</div>
          <div className="kpi-val">{bestHour?.hour}</div>
          <div className="kpi-sub pos">{bestHour?.pnl > 0 ? "+" : ""}{fmt(bestHour?.pnl)} $</div>
        </div>
        <div className="kpi r">
          <div className="kpi-label">Pire heure</div>
          <div className="kpi-val">{worstHour?.hour}</div>
          <div className="kpi-sub neg">{fmt(worstHour?.pnl)} $</div>
        </div>
        <div className="kpi g">
          <div className="kpi-label">Meilleur jour</div>
          <div className="kpi-val">{bestDay?.day}</div>
          <div className="kpi-sub pos">{bestDay?.pnl > 0 ? "+" : ""}{fmt(bestDay?.pnl)} $</div>
        </div>
        <div className="kpi r">
          <div className="kpi-label">Pire jour</div>
          <div className="kpi-val">{worstDay?.day}</div>
          <div className="kpi-sub neg">{fmt(worstDay?.pnl)} $</div>
        </div>
      </div>

      {/* Heatmap jours */}
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="card-title">P&L par jour de la semaine</div>
        <div className="heatmap-grid">
          {byDay.map(d => (
            <div key={d.day} className="hm-cell" style={{
              background: cellBg(d.pnl, maxDayPnl),
              border: `1px solid ${d.pnl > 0 ? "rgba(0,229,160,.2)" : d.pnl < 0 ? "rgba(255,77,109,.2)" : "var(--bd)"}`,
              borderRadius: 8,
            }}>
              <div className="hm-label">{d.day}</div>
              <div className="hm-val" style={{ color: d.pnl > 0 ? "var(--accent)" : d.pnl < 0 ? "var(--red)" : "var(--muted2)" }}>
                {d.pnl > 0 ? "+" : ""}{fmt(d.pnl, 0)} $
              </div>
              <div className="hm-count">{d.count} trade{d.count !== 1 ? "s" : ""}{d.count > 0 ? ` · ${d.wr}% WR` : ""}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Bar chart heures */}
      <div className="card card-pad">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>P&L cumulé par heure d'entrée</div>
          {apiBestHour && (
            <div style={{ fontSize: 10, color: "var(--accent)", background: "rgba(0,229,160,.08)", border: "1px solid rgba(0,229,160,.2)", padding: "3px 10px", borderRadius: 20 }}>
              🔌 Meilleure heure serveur : {apiBestHour}
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={byHour} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
            <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false}/>
            <YAxis tick={{ fontSize: 9, fill: "var(--muted2)" }} axisLine={false} tickLine={false} width={60}/>
            <Tooltip
              contentStyle={{ background: "var(--s2)", border: "1px solid var(--bd2)", borderRadius: 8, fontSize: 11 }}
              formatter={(v, n, p) => [`${v >= 0 ? "+" : ""}${fmt(v)} $ (${p.payload.count} trades, ${p.payload.wr}% WR)`, "P&L"]}
            />
            <Bar dataKey="pnl" name="P&L ($)" radius={[4, 4, 0, 0]}>
              {byHour.map((h, i) => (
                <Cell
                  key={i}
                  fill={h.pnl >= 0 ? "#00e5a0" : "#ff4d6d"}
                  fillOpacity={apiBestHour && h.hour === apiBestHour ? 1 : 0.65}
                  stroke={apiBestHour && h.hour === apiBestHour ? "#00e5a0" : "none"}
                  strokeWidth={2}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 8, lineHeight: 1.6 }}>
          💡 Identifiez vos <strong style={{ color: "var(--accent)" }}>créneaux les plus rentables</strong> et évitez de trader aux heures où vous perdez le plus.
          {apiBestHour && <span style={{ color: "var(--accent)" }}> La barre en surbrillance est votre meilleure heure selon le serveur.</span>}
        </div>
      </div>
    </>
  );
}

// ─── TAG INPUT COMPONENT ──────────────────────────────────────────────────────
function TagInput({ tags, onChange, suggestions = DEFAULT_TAGS }) {
  const [input, setInput] = useState("");
  const filtered = input ? suggestions.filter(s => s.includes(input) && !tags.includes(s)) : [];

  const add = (t) => {
    const tag = t.trim().toLowerCase().replace(/\s+/g,"-");
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setInput("");
  };
  const remove = (t) => onChange(tags.filter(x => x !== t));

  return (
    <div>
      <div className="tag-input-wrap" onClick={e => e.currentTarget.querySelector("input")?.focus()}>
        {tags.map(t => (
          <span key={t} className="tag" style={{background:`${tagColor(t)}18`,borderColor:`${tagColor(t)}40`,color:tagColor(t)}}>
            {t}<span onClick={()=>remove(t)} style={{marginLeft:3,opacity:.6,cursor:"pointer"}}>✕</span>
          </span>
        ))}
        <input value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"||e.key===","){ e.preventDefault(); if(input.trim())add(input);} if(e.key==="Backspace"&&!input&&tags.length) remove(tags[tags.length-1]);}}
          placeholder={tags.length===0?"Ajouter des tags…":""}/>
      </div>
      {filtered.length>0 && (
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:6}}>
          {filtered.slice(0,8).map(s=>(
            <span key={s} className="tag" style={{background:"var(--s2)",borderColor:"var(--bd2)",color:"var(--muted2)",cursor:"pointer"}} onClick={()=>add(s)}>+ {s}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TRADE MODAL ──────────────────────────────────────────────────────────────
function TradeModal({trade,setups,checklistItems,onSave,onClose}){
  const [form,setForm]=useState(trade||{date:new Date().toISOString().slice(0,10),time:new Date().toTimeString().slice(0,5),asset:"BTC/USD",direction:"LONG",entry:"",exit:"",sl:"",tp:"",size:"",fees:"",setup:setups[0]?.name||"",emotion_before:"Calme",emotion_after:"",notes:"",tags:[],intraday:[]});
  const [checks,setChecks]=useState(trade?.checklist||checklistItems.map(()=>false));
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const handleSave=()=>{
    if(!form.entry||!form.size){alert("Entrée et taille requises");return;}
    const en=parseFloat(form.entry),ex=form.exit?parseFloat(form.exit):null,sz=parseFloat(form.size),fees=parseFloat(form.fees||0);
    const pnl=ex?parseFloat(((ex-en)*(form.direction==="LONG"?1:-1)*sz-fees).toFixed(2)):null;
    onSave({...form,entry:en,exit:ex,sl:form.sl?parseFloat(form.sl):null,tp:form.tp?parseFloat(form.tp):null,size:sz,fees,pnl,checklist:checks,status:ex?"CLOSED":"OPEN",tags:form.tags||[],intraday:form.intraday||[]});
  };
  return(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="modal-title">{trade?"Modifier":"Nouveau trade"}<button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="section-title">Informations</div>
        <div className="form-grid" style={{marginBottom:14}}>
          <div className="fg"><label>Date</label><input type="date" value={form.date} onChange={e=>set("date",e.target.value)}/></div>
          <div className="fg"><label>Heure</label><input type="time" value={form.time} onChange={e=>set("time",e.target.value)}/></div>
          <div className="fg"><label>Actif</label><select value={form.asset} onChange={e=>set("asset",e.target.value)}>
            {Object.entries(ASSET_CATEGORY).map(([type,label])=>(
              <optgroup key={type} label={label}>
                {ASSETS.filter(a=>ASSET_TYPE[a]===type).map(a=><option key={a}>{a}</option>)}
              </optgroup>
            ))}
          </select></div>
          <div className="fg"><label>Direction</label><select value={form.direction} onChange={e=>set("direction",e.target.value)}><option>BUY</option><option>SELL</option></select></div>
          <div className="fg"><label>Entrée *</label><input type="number" placeholder="0.00" value={form.entry} onChange={e=>set("entry",e.target.value)}/></div>
          <div className="fg"><label>Sortie</label><input type="number" placeholder="Vide = ouvert" value={form.exit||""} onChange={e=>set("exit",e.target.value)}/></div>
          <div className="fg"><label>Stop Loss</label><input type="number" value={form.sl||""} onChange={e=>set("sl",e.target.value)}/></div>
          <div className="fg"><label>Take Profit</label><input type="number" value={form.tp||""} onChange={e=>set("tp",e.target.value)}/></div>
          <div className="fg"><label>Taille *</label><input type="number" value={form.size} onChange={e=>set("size",e.target.value)}/></div>
          <div className="fg"><label>Frais ($)</label><input type="number" value={form.fees} onChange={e=>set("fees",e.target.value)}/></div>
          <div className="fg full"><label>Setup</label><select value={form.setup} onChange={e=>set("setup",e.target.value)}>{setups.map(s=><option key={s.id} value={s.name}>{s.name}</option>)}</select></div>
          <div className="fg full"><label>Tags personnalisés</label><TagInput tags={form.tags||[]} onChange={v=>set("tags",v)}/><div style={{fontSize:9,color:"var(--muted)",marginTop:4}}>Appuyez sur Entrée ou virgule pour ajouter · Backspace pour supprimer</div></div>
        </div>
        <div className="divider"/>
        <div className="section-title">Checklist</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
          {checklistItems.map((item,i)=>(
            <div key={i} onClick={()=>setChecks(p=>{const n=[...p];n[i]=!n[i];return n;})}
              style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:"var(--s2)",border:`1px solid ${checks[i]?"var(--accent)":"var(--bd)"}`,borderRadius:6,cursor:"pointer",fontSize:12,transition:"border-color .13s"}}>
              <div style={{width:16,height:16,borderRadius:4,border:`1px solid ${checks[i]?"var(--accent)":"var(--bd2)"}`,background:checks[i]?"var(--accent)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#000",flexShrink:0}}>{checks[i]?"✓":""}</div>
              {item}
            </div>
          ))}
          {!checks.every(Boolean)&&<div style={{fontSize:10,color:"var(--amber)"}}>⚠ Checklist incomplète — continuer quand même ?</div>}
        </div>
        <div className="divider"/>
        <div className="section-title">Émotions</div>
        <div className="form-grid" style={{marginBottom:14}}>
          <div className="fg"><label>Avant</label><div className="chips">{EMOTIONS.map(e=><div key={e} className={`chip${form.emotion_before===e?" on":""}`} onClick={()=>set("emotion_before",e)}>{e}</div>)}</div></div>
          <div className="fg"><label>Après</label><div className="chips">{EMOTIONS.map(e=><div key={e} className={`chip${form.emotion_after===e?" on":""}`} onClick={()=>set("emotion_after",e)}>{e}</div>)}</div></div>
        </div>
        <div className="fg" style={{marginBottom:16}}><label>Réflexion</label><textarea placeholder="Leçons apprises…" value={form.notes} onChange={e=>set("notes",e.target.value)}/></div>
        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}><button className="btn btn-ghost" onClick={onClose}>Annuler</button><button className="btn btn-primary" onClick={handleSave}>Enregistrer</button></div>
      </div>
    </div>
  );
}

// ─── TRADE DETAIL MODAL ───────────────────────────────────────────────────────
function TradeDetailModal({trade:t,onClose,onEdit,onDelete,onDuplicate}){
  const rm=calcR(t);
  const [tab,setTab]=useState("info");
  const hasIntraday = t.intraday?.length > 1;
  // Cumulative intraday P&L
  const intradayWithCumul = (t.intraday||[]).map((e,i,arr) => ({
    ...e,
    cumul: arr.slice(0,i+1).reduce((s,x)=>s+(x.pnl||0),0)
  }));

  return(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{width:780}}>
        <div className="modal-title">
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span className={`a-ico ${ASSET_TYPE[t.asset]||"index"}`}>{ASSET_ICON[ASSET_TYPE[t.asset]||"index"]}</span>
            <div><div>{t.asset} — {t.direction}</div><div style={{fontSize:11,color:"var(--muted2)",fontWeight:400,marginTop:2}}>{t.date} à {t.time}</div></div>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Tags display */}
        {(t.tags||[]).length > 0 && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
            {t.tags.map(tag=>(
              <span key={tag} className="tag" style={{background:`${tagColor(tag)}18`,borderColor:`${tagColor(tag)}40`,color:tagColor(tag)}}>{tag}</span>
            ))}
          </div>
        )}

        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
          <span className={`bdg bdg-${t.direction==="LONG"?"long":"short"}`}>{t.direction}</span>
          <span className={`bdg bdg-${t.status==="OPEN"?"open":t.pnl>=0?"win":"loss"}`}>{t.status==="OPEN"?"OUVERT":t.pnl>=0?"GAGNANT":"PERDANT"}</span>
          <span className="setup-tag">{t.setup}</span>
        </div>

        {/* Sub-tabs */}
        {hasIntraday && (
          <div style={{display:"flex",gap:4,marginBottom:16,background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:3}}>
            {[{id:"info",label:"Infos"},hasIntraday&&{id:"intraday",label:"⏱ P&L Intraday"}].filter(Boolean).map(tb=>(
              <div key={tb.id} onClick={()=>setTab(tb.id)}
                style={{flex:1,padding:"7px 12px",borderRadius:6,cursor:"pointer",fontSize:10,textAlign:"center",fontWeight:600,letterSpacing:".5px",textTransform:"uppercase",transition:"all .13s",
                  background:tab===tb.id?"var(--s3)":"transparent",color:tab===tb.id?"var(--accent)":"var(--muted2)",border:tab===tb.id?"1px solid var(--bd2)":"1px solid transparent"}}>
                {tb.label}
              </div>
            ))}
          </div>
        )}

        {tab==="info" && (
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:18}}>
              {[["Entrée",fmt(t.entry)],["Sortie",t.exit?fmt(t.exit):<span className="amb">En cours</span>],["Stop",fmt(t.sl)],["TP",fmt(t.tp)],["Taille",t.size],["Frais",(t.fees||0)+" $"],["P&L",fmtPnl(t.pnl)],["R Mult.",rm!=null?<span style={{color:rm>=1?"var(--accent)":"var(--red)"}}>{rm>0?"+":""}{rm}R</span>:"—"]].map(([l,v])=>(
                <div key={l} style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"12px 14px"}}>
                  <div style={{fontSize:9,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:4}}>{l}</div>
                  <div style={{fontSize:14,fontWeight:600}}>{v}</div>
                </div>
              ))}
            </div>
            {t.notes&&<><div className="divider"/><div className="section-title">Réflexion</div><div style={{fontSize:12,lineHeight:1.7,background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"14px 16px",marginBottom:16}}>{t.notes}</div></>}
          </>
        )}

        {tab==="intraday" && hasIntraday && (
          <>
            {/* Mini equity curve intraday */}
            <div style={{marginBottom:16}}>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={intradayWithCumul}>
                  <defs><linearGradient id="igc" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00e5a0" stopOpacity={0.15}/><stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/></linearGradient></defs>
                  <XAxis dataKey="time" tick={{fontSize:9,fill:"var(--muted2)"}} axisLine={false} tickLine={false}/>
                  <YAxis tick={{fontSize:9,fill:"var(--muted2)"}} axisLine={false} tickLine={false} width={50}/>
                  <Tooltip contentStyle={{background:"var(--s2)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:10}} formatter={v=>[`${v>=0?"+":""}${fmt(v)} $`,"P&L cumulé"]}/>
                  <Area type="monotone" dataKey="cumul" stroke="#00e5a0" strokeWidth={2} fill="url(#igc)" dot={{fill:"var(--s1)",strokeWidth:2,r:4,stroke:"#00e5a0"}}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Timeline */}
            <div className="intraday-timeline">
              <div className="itl-line"/>
              {intradayWithCumul.map((ev,i)=>(
                <div key={i} className="itl-event">
                  <div className="itl-time">{ev.time}</div>
                  <div className="itl-dot" style={{background:i===0?"var(--blue)":i===intradayWithCumul.length-1?(ev.cumul>=0?"var(--accent)":"var(--red)"):"var(--bd2)"}}/>
                  <div className="itl-card">
                    <div className="itl-card-title">
                      {ev.event}
                      {ev.pnl !== 0 && <span style={{fontSize:10,color:ev.pnl>=0?"var(--accent)":"var(--red)",marginLeft:"auto"}}>{ev.pnl>=0?"+":""}{fmt(ev.pnl)} $</span>}
                    </div>
                    <div className="itl-card-sub">P&L cumulé : <span style={{color:ev.cumul>=0?"var(--accent)":"var(--red)",fontWeight:600}}>{ev.cumul>=0?"+":""}{fmt(ev.cumul)} $</span></div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="divider"/>
        <div style={{display:"flex",gap:8}}>
          <button className="btn btn-primary" onClick={()=>onEdit(t)}>✎ Modifier</button>
          <button className="btn btn-ghost" onClick={()=>onDuplicate(t)}>⧉ Dupliquer</button>
          <button className="btn btn-red" style={{marginLeft:"auto"}} onClick={()=>{if(confirm("Supprimer ?"))onDelete(t.id);}}>✕ Supprimer</button>
        </div>
      </div>
    </div>
  );
}

// ─── IMPORT CSV PAGE ──────────────────────────────────────────────────────────
function ImportPage({ onImport }) {
  const [broker, setBroker] = useState(null);
  const [drag, setDrag]     = useState(false);
  const [preview, setPreview] = useState(null); // { rows, mapped }
  const [importing, setImporting] = useState(false);

  const BROKERS = [
    // ── Forex / CFD ──
    {id:"mt4",      name:"MetaTrader 4",  icon:"◈", fmt:"Statement CSV/HTML",  cat:"Forex/CFD"},
    {id:"mt5",      name:"MetaTrader 5",  icon:"◉", fmt:"Statement CSV/HTML",  cat:"Forex/CFD"},
    {id:"ctrader",  name:"cTrader",       icon:"◬", fmt:"Export CSV",           cat:"Forex/CFD"},
    {id:"icmarkets",name:"IC Markets",    icon:"○", fmt:"Trading Report CSV",   cat:"Forex/CFD"},
    {id:"pepperstone",name:"Pepperstone", icon:"◐", fmt:"CSV Export",           cat:"Forex/CFD"},
    {id:"oanda",    name:"OANDA",         icon:"●", fmt:"Trade Report CSV",     cat:"Forex/CFD"},
    {id:"xm",       name:"XM Group",      icon:"✕", fmt:"Account Statement",    cat:"Forex/CFD"},
    {id:"activtrades",name:"ActivTrades", icon:"⊕", fmt:"CSV Report",           cat:"Forex/CFD"},
    // ── Crypto ──
    {id:"binance",  name:"Binance",       icon:"₿", fmt:"Trade History CSV",    cat:"Crypto"},
    {id:"bybit",    name:"ByBit",         icon:"⬡", fmt:"Trade History CSV",    cat:"Crypto"},
    {id:"kraken",   name:"Kraken",        icon:"◬", fmt:"Trade Ledger CSV",     cat:"Crypto"},
    {id:"coinbase", name:"Coinbase Pro",  icon:"●", fmt:"Account Statement",    cat:"Crypto"},
    {id:"kucoin",   name:"KuCoin",        icon:"◆", fmt:"Order History CSV",    cat:"Crypto"},
    {id:"okx",      name:"OKX",           icon:"○", fmt:"Trade History CSV",    cat:"Crypto"},
    // ── Indices synthétiques ──
    {id:"deriv",    name:"Deriv / Binary",icon:"◈", fmt:"Statement CSV",        cat:"Synthétiques"},
    // ── Prop Firms ──
    {id:"ftmo",     name:"FTMO",          icon:"🏆", fmt:"Report CSV",          cat:"Prop Firm"},
    {id:"mff",      name:"MyForexFunds",  icon:"💼", fmt:"Trade History CSV",   cat:"Prop Firm"},
    {id:"the5",     name:"The5%ers",      icon:"5️⃣", fmt:"Export CSV",          cat:"Prop Firm"},
    {id:"funded",   name:"Funded Next",   icon:"⚡", fmt:"Trade Report",        cat:"Prop Firm"},
    {id:"e8",       name:"E8 Funding",    icon:"8️⃣", fmt:"Account CSV",         cat:"Prop Firm"},
    {id:"tff",      name:"True Forex Funds",icon:"💹",fmt:"CSV Export",         cat:"Prop Firm"},
    {id:"custom",   name:"Personnalisé",  icon:"⊞", fmt:"Format libre",         cat:"Autre"},
  ];

  const parseCSV = (text) => {
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(",").map(h=>h.trim().replace(/"/g,"").toLowerCase());
    const rows = lines.slice(1, 6).map(l => {
      const vals = l.split(",").map(v=>v.trim().replace(/"/g,""));
      return Object.fromEntries(headers.map((h,i)=>[h,vals[i]||""]));
    });
    // Auto-map columns
    const findCol = (...keys) => headers.find(h=>keys.some(k=>h.includes(k)));
    const mapped = {
      date:   findCol("date","time","datetime"),
      asset:  findCol("symbol","asset","pair","instrument"),
      side:   findCol("side","direction","type","action"),
      entry:  findCol("price","entry","open","filledprice"),
      exit:   findCol("close","exit","closeprice","realized"),
      pnl:    findCol("pnl","profit","realizedpnl","realized"),
      size:   findCol("size","qty","quantity","amount","vol"),
    };
    return { rows, mapped, total: lines.length - 1 };
  };

  const handleFile = (file) => {
    if (!file) return;
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseCSV(e.target.result);
      setPreview(result);
      setImporting(false);
    };
    reader.readAsText(file);
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDrag(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleConfirm = () => {
    if (!preview) return;
    // Simule la conversion en trades EDGELOG
    const demoImported = [
      {id:Date.now()+1,date:daysAgo(2),time:"09:45",asset:"BTC/USD",direction:"LONG",entry:95200,exit:97100,sl:94000,tp:99000,size:0.1,fees:8,setup:"Import",emotion_before:"Neutre",emotion_after:"Calme",pnl:182,status:"CLOSED",notes:"Importé via CSV",checklist:[],tags:["import",broker||"csv"],intraday:[]},
      {id:Date.now()+2,date:daysAgo(4),time:"14:30",asset:"ETH/USD",direction:"SHORT",entry:3180,exit:3050,sl:3280,tp:2900,size:0.5,fees:6,setup:"Import",emotion_before:"Neutre",emotion_after:"Satisfait",pnl:65,status:"CLOSED",notes:"Importé via CSV",checklist:[],tags:["import",broker||"csv"],intraday:[]},
    ];
    onImport(demoImported);
  };

  const brokerCats = [...new Set(BROKERS.map(b=>b.cat))];

  return (
    <>
      {brokerCats.map(cat => (
        <div key={cat} style={{marginBottom:20}}>
          <div style={{fontSize:9,letterSpacing:"1.2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:10,paddingLeft:2}}>{cat}</div>
          <div className="broker-grid">
            {BROKERS.filter(b=>b.cat===cat).map(b => (
              <div key={b.id} className={`broker-card${broker===b.id?" selected":""}`} onClick={()=>setBroker(b.id)}>
                <div className="broker-icon">{b.icon}</div>
                <div className="broker-name">{b.name}</div>
                <div className="broker-fmt">{b.fmt}</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!preview ? (
        <>
          <div className="section-title">Importer le fichier</div>
          <div className={`import-zone${drag?" drag":""}`}
            onDragOver={e=>{e.preventDefault();setDrag(true);}}
            onDragLeave={()=>setDrag(false)}
            onDrop={handleDrop}
            onClick={()=>document.getElementById("csv-upload").click()}>
            <input id="csv-upload" type="file" accept=".csv,.txt,.html" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
            <div className="import-zone-icon">{importing?"⏳":"📂"}</div>
            <div className="import-zone-title">{importing?"Analyse en cours…":"Glissez votre fichier ici"}</div>
            <div className="import-zone-sub">
              Formats supportés : CSV, TXT, HTML<br/>
              {broker ? `Format détecté : ${BROKERS.find(b=>b.id===broker)?.name}` : "Sélectionnez d'abord un broker ci-dessus"}
            </div>
            <button className="btn btn-primary" onClick={e=>{e.stopPropagation();document.getElementById("csv-upload").click();}}>Parcourir les fichiers</button>
          </div>

          <div style={{marginTop:20,background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:10,padding:"16px 20px"}}>
            <div style={{fontSize:10,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:10}}>📋 Instructions {broker?`— ${BROKERS.find(b=>b.id===broker)?.name}`:" générales"}</div>
            {broker==="binance"&&<div style={{fontSize:11,color:"var(--muted2)",lineHeight:1.8}}>1. Allez dans <strong style={{color:"var(--text)"}}>Wallet → Historique → Générer un rapport</strong><br/>2. Sélectionnez la période souhaitée<br/>3. Choisissez le format <strong style={{color:"var(--text)"}}>CSV</strong><br/>4. Téléchargez et importez ici</div>}
            {broker==="mt4"&&<div style={{fontSize:11,color:"var(--muted2)",lineHeight:1.8}}>1. Dans MT4 : <strong style={{color:"var(--text)"}}>Compte → Historique du compte</strong><br/>2. Clic droit → <strong style={{color:"var(--text)"}}>Enregistrer comme rapport détaillé</strong><br/>3. Choisissez le format <strong style={{color:"var(--text)"}}>HTML ou CSV</strong></div>}
            {!broker&&<div style={{fontSize:11,color:"var(--muted2)",lineHeight:1.8}}>Sélectionnez votre broker ci-dessus pour des instructions spécifiques.<br/>Le fichier CSV doit contenir au minimum : date, actif, direction, prix d'entrée/sortie, P&L.</div>}
          </div>
        </>
      ) : (
        <div className="import-preview">
          <div className="import-preview-header">
            <div>
              <div style={{fontWeight:600,fontSize:13}}>Aperçu — {preview.total} trades détectés</div>
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>Colonnes mappées automatiquement</div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setPreview(null)}>← Retour</button>
              <button className="btn btn-primary btn-sm" onClick={handleConfirm}>Importer {preview.total} trades →</button>
            </div>
          </div>

          {/* Mapping display */}
          <div style={{padding:"12px 16px",borderBottom:"1px solid var(--bd)",display:"flex",gap:8,flexWrap:"wrap"}}>
            {Object.entries(preview.mapped).map(([field,col])=>(
              col ? <span key={field} className="import-status ok">✓ {field} → {col}</span>
                  : <span key={field} className="import-status warn">? {field} non détecté</span>
            ))}
          </div>

          {/* Preview rows */}
          <div className="import-row header" style={{gridTemplateColumns:`repeat(${Object.keys(preview.rows[0]||{}).length},1fr)`}}>
            {Object.keys(preview.rows[0]||{}).map(h=><span key={h}>{h}</span>)}
          </div>
          {preview.rows.map((row,i)=>(
            <div key={i} className="import-row" style={{gridTemplateColumns:`repeat(${Object.keys(row).length},1fr)`}}>
              {Object.values(row).map((v,j)=><span key={j} style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{v||"—"}</span>)}
            </div>
          ))}
          {preview.total > 5 && (
            <div style={{padding:"10px 16px",fontSize:10,color:"var(--muted2)",textAlign:"center"}}>
              … et {preview.total-5} autres trades
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── COACH / MENTOR PAGE ──────────────────────────────────────────────────────
function CoachPage({ user, trades, showToast }) {
  const [mentors,      setMentors]     = useState([]);
  const [feedbacks,    setFeedbacks]   = useState([]);
  const [loading,      setLoading]     = useState(true);
  const [showInvite,   setShowInvite]  = useState(false);
  const [inviteEmail,  setInviteEmail] = useState("");
  const [inviteAccess, setInviteAccess]= useState("read");
  const [linkCopied,   setLinkCopied] = useState(false);
  const [sending,      setSending]    = useState(false);

  const shareLink = `https://edgelog.app/shared/${user?.id || "demo"}/journal`;

  // ── Chargement depuis l'API ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [mentorsRes, feedbackRes] = await Promise.all([
          API.mentor.list(),
          API.mentor.feedback(),
        ]);
        if (!cancelled) {
          setMentors(mentorsRes?.mentors || []);
          setFeedbacks(feedbackRes?.feedbacks || []);
        }
      } catch {
        // Fallback données démo si backend indispo
        if (!cancelled) {
          setMentors([
            { id:"m1", name:"Alexandre M.", email:"alex@trading.pro",  access:"read",  since:"2025-01-10", avatar:"A", color:"#38bdf8" },
            { id:"m2", name:"Sarah K.",     email:"sarah@traderpro.fr", access:"full", since:"2025-02-01", avatar:"S", color:"#a78bfa" },
          ]);
          setFeedbacks([
            { id:"f1", mentorName:"Alexandre M.", createdAt: new Date(Date.now()-2*86400000).toISOString(), comment:"Très bonne discipline sur le trade BTC du 22. Travailler sur la sortie — tu quittes trop tôt.", color:"#38bdf8" },
            { id:"f2", mentorName:"Sarah K.",     createdAt: new Date(Date.now()-5*86400000).toISOString(), comment:"Amélioration significative sur la gestion du risque. Attention aux trades du vendredi après-midi.", color:"#a78bfa" },
          ]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setSending(true);
    try {
      const res = await API.mentor.invite(inviteEmail, inviteAccess);
      const newMentor = res?.mentor || {
        id:     Date.now().toString(),
        name:   inviteEmail.split("@")[0],
        email:  inviteEmail,
        access: inviteAccess,
        since:  new Date().toISOString().slice(0, 10),
        avatar: inviteEmail[0].toUpperCase(),
        color:  TAG_COLORS[mentors.length % TAG_COLORS.length],
      };
      setMentors(p => [...p, newMentor]);
      showToast(`Invitation envoyée à ${inviteEmail} ✓`);
      setInviteEmail(""); setShowInvite(false);
    } catch (err) {
      showToast(err.message || "Erreur lors de l'invitation.", "err");
    } finally {
      setSending(false);
    }
  };

  const handleRemove = async (id) => {
    try {
      await API.mentor.revoke(id);
    } catch { /* optimistic UI — on retire quand même */ }
    setMentors(p => p.filter(m => m.id !== id));
    showToast("Accès révoqué", "info");
  };

  const handleCopyLink = () => {
    navigator.clipboard?.writeText(shareLink).catch(() => {});
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
    showToast("Lien copié ✓");
  };

  const closedTrades = trades.filter(t => t.status === "CLOSED");
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wr = closedTrades.length
    ? ((closedTrades.filter(t => t.pnl > 0).length / closedTrades.length) * 100).toFixed(1)
    : 0;

  const timeAgo = (iso) => {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 3600)  return `Il y a ${Math.floor(d/60)} min`;
    if (d < 86400) return `Il y a ${Math.floor(d/3600)}h`;
    return `Il y a ${Math.floor(d/86400)} jour${Math.floor(d/86400)>1?"s":""}`;
  };

  return (
    <>
      {/* Share link */}
      <div className="share-card">
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
          <div>
            <div className="share-card-title">🔗 Lien de partage public</div>
            <div className="share-card-sub">Partagez ce lien pour un accès lecture seule à votre journal.</div>
          </div>
          <div style={{display:"flex",gap:6,flex:1,minWidth:240}}>
            <div className="share-link-box" style={{flex:1}}>
              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shareLink}</span>
              <button className="btn btn-ghost btn-sm" onClick={handleCopyLink} style={{flexShrink:0}}>
                {linkCopied ? "✓ Copié" : "Copier"}
              </button>
            </div>
          </div>
        </div>
        <div style={{marginTop:16,display:"flex",gap:10,flexWrap:"wrap"}}>
          {[
            { label:"P&L total", val:<span className={totalPnl>=0?"pos":"neg"}>{totalPnl>=0?"+":""}{fmt(totalPnl)} $</span> },
            { label:"Win Rate",  val:<span style={{color:"var(--blue)"}}>{wr}%</span> },
            { label:"Trades closés", val:closedTrades.length },
          ].map(s=>(
            <div key={s.label} style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"10px 16px",flex:1,minWidth:100,textAlign:"center"}}>
              <div style={{fontSize:9,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:3}}>{s.label}</div>
              <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:700}}>{s.val}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Mentors list */}
      <div className="share-card">
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div className="share-card-title">👥 Mentors & Coachs {loading && <span style={{fontSize:9,color:"var(--muted2)"}}>⟳</span>}</div>
            <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>Invitez des personnes de confiance à consulter votre journal.</div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={()=>setShowInvite(s=>!s)}>+ Inviter</button>
        </div>

        {showInvite && (
          <div style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:10,padding:"16px",marginBottom:16}}>
            <div className="section-title">Nouvelle invitation</div>
            <div className="form-grid" style={{marginBottom:12}}>
              <div className="fg">
                <label>Email du coach</label>
                <div className="input-icon"><span className="ii">@</span>
                  <input type="email" placeholder="coach@exemple.com" value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&handleInvite()}/>
                </div>
              </div>
              <div className="fg">
                <label>Niveau d'accès</label>
                <select value={inviteAccess} onChange={e=>setInviteAccess(e.target.value)}>
                  <option value="read">Lecture seule</option>
                  <option value="full">Accès complet (trades + notes)</option>
                </select>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowInvite(false)}>Annuler</button>
              <button className="btn btn-primary btn-sm" onClick={handleInvite} disabled={sending||!inviteEmail.trim()}>
                {sending ? "⟳ Envoi…" : "Envoyer l'invitation →"}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div style={{textAlign:"center",padding:"24px",color:"var(--muted2)",fontSize:11}}>⟳ Chargement…</div>
        ) : mentors.length === 0 ? (
          <div style={{textAlign:"center",padding:"28px",color:"var(--muted2)",fontSize:12}}>
            <div style={{fontSize:28,marginBottom:10}}>👤</div>
            Aucun mentor invité pour l'instant.
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {mentors.map(m => (
              <div key={m.id} className="mentor-row">
                <div className="mentor-avatar" style={{background:`${m.color||"#38bdf8"}20`,color:m.color||"#38bdf8",border:`1px solid ${m.color||"#38bdf8"}40`}}>
                  {m.avatar || (m.name||"?")[0].toUpperCase()}
                </div>
                <div className="mentor-info">
                  <div className="mentor-name">{m.name || m.email?.split("@")[0]}</div>
                  <div className="mentor-access">{m.email} · Depuis {m.since || m.createdAt?.slice(0,10)}</div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:9,padding:"3px 9px",borderRadius:4,
                    background: m.access==="full"?"rgba(245,158,11,.12)":"rgba(56,189,248,.12)",
                    color:      m.access==="full"?"var(--amber)":"var(--blue)",
                    border:`1px solid ${m.access==="full"?"rgba(245,158,11,.3)":"rgba(56,189,248,.3)"}`}}>
                    {m.access==="full"?"Accès complet":"Lecture seule"}
                  </span>
                  <button className="btn btn-red btn-sm" onClick={()=>handleRemove(m.id)}>Révoquer</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Feedback section */}
      <div className="share-card">
        <div className="share-card-title">💬 Feedback reçus</div>
        <div className="share-card-sub">Les commentaires laissés par vos mentors apparaissent ici.</div>
        {loading ? (
          <div style={{textAlign:"center",padding:"20px",color:"var(--muted2)",fontSize:11}}>⟳ Chargement…</div>
        ) : feedbacks.length === 0 ? (
          <div style={{textAlign:"center",padding:"24px",color:"var(--muted2)",fontSize:12}}>
            <div style={{fontSize:28,marginBottom:8}}>💬</div>
            Aucun feedback reçu pour l'instant. Invitez un mentor pour commencer.
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {feedbacks.map(fb => (
              <div key={fb.id} style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:10,padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:24,height:24,borderRadius:"50%",background:`${fb.color||"#38bdf8"}20`,border:`1px solid ${fb.color||"#38bdf8"}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:fb.color||"#38bdf8"}}>
                    {(fb.mentorName||"?")[0]}
                  </div>
                  <span style={{fontWeight:600,fontSize:11}}>{fb.mentorName}</span>
                  <span style={{fontSize:10,color:"var(--muted2)",marginLeft:"auto"}}>{timeAgo(fb.createdAt)}</span>
                </div>
                <div style={{fontSize:12,color:"var(--muted2)",lineHeight:1.7,fontStyle:"italic"}}>"{fb.comment}"</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── COMPORTEMENT / PRÉVISION IA ─────────────────────────────────────────────
function ComportementPage({ trades, user }) {
  const closed = trades.filter(t => t.status==="CLOSED" && t.pnl!=null);

  // ── Détecter le style de trading ──
  const styleData = useMemo(() => {
    if (!closed.length) return null;
    // Durée moyenne (heure d'entrée seulement — on simule la durée par setup)
    const durations = closed.map(t => {
      const h = parseInt((t.time||"09:00").split(":")[0]);
      return { scalper: h >= 8 && h <= 10 ? 1 : 0, swing: t.checklist?.every(Boolean) ? 1 : 0 };
    });
    const scalperScore = durations.reduce((s,d)=>s+d.scalper,0) / closed.length;
    const disciplineScore = closed.filter(t=>t.checklist?.every(Boolean)).length / closed.length;
    const avgRR = closed.reduce((s,t)=>{const r=calcR(t);return s+(r||0);},0)/closed.length;
    const style = scalperScore > 0.5 ? "Scalper" : disciplineScore > 0.7 ? "Swing Trader" : "Day Trader";
    const styleDesc = {
      Scalper: "Vous prenez beaucoup de positions courtes, souvent tôt le matin. Sensible aux émotions et au bruit de marché.",
      "Day Trader": "Vous fermez vos positions en journée. Bonne discipline globale, mais attention au FOMO en session NY.",
      "Swing Trader": "Vous laissez vos positions respirer. Excellent respect du plan, bonne gestion du risque."
    };
    return { style, desc: styleDesc[style], disciplineScore, avgRR, scalperScore };
  }, [closed]);

  // ── Comportements détectés via tags ──
  const behaviors = useMemo(() => {
    const tagCount = {};
    closed.forEach(t => (t.tags||[]).forEach(tag => { tagCount[tag] = (tagCount[tag]||0)+1; }));
    return Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).slice(0,8);
  }, [closed]);

  // ── Simulation de performance : règles respectées vs non ──
  const simulation = useMemo(() => {
    if (!closed.length) return [];
    let realCumul = 0, perfectCumul = 0;
    return closed.slice().sort((a,b)=>a.date.localeCompare(b.date)).map((t,i) => {
      realCumul += t.pnl||0;
      // Si checklist complète → on prend le trade. Sinon on simule qu'il aurait fait +20% mieux
      const disciplined = t.checklist?.every(Boolean);
      const projPnl = disciplined ? (t.pnl||0) : Math.max(0, (t.pnl||0) * 1.35);
      perfectCumul += projPnl;
      return { trade: i+1, reel: parseFloat(realCumul.toFixed(2)), projete: parseFloat(perfectCumul.toFixed(2)), date: t.date };
    });
  }, [closed]);

  // ── Discipline score radar ──
  const disciplineMetrics = useMemo(() => {
    if (!closed.length) return [];
    const checklistRate   = (closed.filter(t=>t.checklist?.every(Boolean)).length/closed.length)*100;
    const noFOMO          = ((closed.length - closed.filter(t=>(t.tags||[]).includes("FOMO")).length)/closed.length)*100;
    const noRevenge       = ((closed.length - closed.filter(t=>(t.tags||[]).includes("revenge-trade")).length)/closed.length)*100;
    const planRespect     = (closed.filter(t=>(t.tags||[]).includes("plan-respecté")).length/closed.length)*100;
    const emotionStable   = (closed.filter(t=>["Calme","Concentré","Neutre"].includes(t.emotion_before)).length/closed.length)*100;
    const goodRR          = (closed.filter(t=>{const r=calcR(t);return r&&r>=1;}).length/closed.length)*100;
    return [
      {subject:"Checklist",         A: Math.round(checklistRate),   fullMark:100},
      {subject:"Anti-FOMO",         A: Math.round(noFOMO),          fullMark:100},
      {subject:"Anti-Revenge",      A: Math.round(noRevenge),       fullMark:100},
      {subject:"Plan respecté",     A: Math.round(planRespect),     fullMark:100},
      {subject:"Émotions stables",  A: Math.round(emotionStable),   fullMark:100},
      {subject:"Bon R/R",           A: Math.round(goodRR),          fullMark:100},
    ];
  }, [closed]);

  const avgDiscipline = disciplineMetrics.length ? Math.round(disciplineMetrics.reduce((s,m)=>s+m.A,0)/disciplineMetrics.length) : 0;
  const disciplineColor = avgDiscipline>=70?"var(--accent)":avgDiscipline>=45?"var(--amber)":"var(--red)";
  const disciplineLabel = avgDiscipline>=70?"Excellente":"Acceptable"<45?"À améliorer":"Moyenne";

  if (!closed.length) return (
    <div className="empty-state">
      <div className="empty-icon">🤖</div>
      <div className="empty-title">Données insuffisantes</div>
      <div className="empty-desc">Ajoutez au moins 5 trades clôturés pour activer l'analyse comportementale IA.</div>
    </div>
  );

  return (
    <>
      {/* Score global */}
      <div className="kpi-grid">
        <div className="kpi" style={{gridColumn:"span 1",border:`1px solid ${disciplineColor}40`,background:`${disciplineColor}08`}}>
          <div className="kpi-label">Score de discipline</div>
          <div className="kpi-val" style={{color:disciplineColor,fontSize:32}}>{avgDiscipline}<span style={{fontSize:14}}>/100</span></div>
          <div className="kpi-sub" style={{color:disciplineColor}}>
            {avgDiscipline>=70?"🟢 Excellente discipline":avgDiscipline>=45?"🟡 Discipline acceptable":"🔴 À améliorer"}
          </div>
        </div>
        <div className="kpi g">
          <div className="kpi-label">Style détecté</div>
          <div className="kpi-val" style={{fontSize:18}}>{styleData?.style||"—"}</div>
          <div className="kpi-sub" style={{color:"var(--muted2)",fontSize:9,lineHeight:1.5,marginTop:4,maxWidth:180}}>{styleData?.desc?.slice(0,80)}…</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">R/R moyen</div>
          <div className="kpi-val">{styleData?.avgRR?`${styleData.avgRR.toFixed(2)}R`:"—"}</div>
          <div className="kpi-sub" style={{color:styleData?.avgRR>=1?"var(--accent)":"var(--red)"}}>{styleData?.avgRR>=1?"✓ Positif":"✕ Négatif"}</div>
        </div>
        <div className="kpi r">
          <div className="kpi-label">Trades analysés</div>
          <div className="kpi-val">{closed.length}</div>
          <div className="kpi-sub">{behaviors.length} patterns détectés</div>
        </div>
      </div>

      {/* Courbe comparative : Réel vs Projeté si règles respectées */}
      <div className="card card-pad">
        <div className="card-title">📈 Prévision de performance — Réel vs Règles respectées à 100%</div>
        <div style={{fontSize:10,color:"var(--muted2)",marginBottom:16,lineHeight:1.5}}>
          La courbe <span style={{color:"var(--blue)"}}>bleue</span> montre vos performances réelles. La courbe <span style={{color:"var(--accent)"}}>verte</span> simule ce que vous auriez obtenu en respectant votre checklist sur chaque trade perdant.
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={simulation} margin={{top:8,right:8,bottom:4,left:8}}>
            <defs>
              <linearGradient id="gReal"   x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#38bdf8" stopOpacity={0.18}/><stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/></linearGradient>
              <linearGradient id="gProj"   x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#00e5a0" stopOpacity={0.18}/><stop offset="95%" stopColor="#00e5a0" stopOpacity={0}/></linearGradient>
            </defs>
            <XAxis dataKey="trade" tickFormatter={v=>`T${v}`} tick={{fontSize:9,fill:"var(--muted2)"}} axisLine={false} tickLine={false}/>
            <YAxis tick={{fontSize:9,fill:"var(--muted2)"}} axisLine={false} tickLine={false} width={60} tickFormatter={v=>`${v>0?"+":""}${v}$`}/>
            <Tooltip contentStyle={{background:"var(--s2)",border:"1px solid var(--bd2)",borderRadius:8,fontSize:10}}
              formatter={(v,n)=>[`${v>=0?"+":""}${fmt(v)} $`, n==="reel"?"Réel":"Si 100% discipliné"]}/>
            <Area type="monotone" dataKey="reel"    stroke="#38bdf8" strokeWidth={2} fill="url(#gReal)" name="reel"/>
            <Area type="monotone" dataKey="projete" stroke="#00e5a0" strokeWidth={2} fill="url(#gProj)" name="projete" strokeDasharray="5 3"/>
          </AreaChart>
        </ResponsiveContainer>
        {simulation.length > 0 && (() => {
          const last = simulation[simulation.length-1];
          const diff = last.projete - last.reel;
          return diff > 0 ? (
            <div style={{marginTop:14,padding:"10px 14px",background:"rgba(0,229,160,.07)",border:"1px solid rgba(0,229,160,.2)",borderRadius:8,fontSize:11}}>
              💡 En respectant vos règles sur tous vos trades, vous auriez gagné <strong style={{color:"var(--accent)"}}>+{fmt(diff)} $</strong> de plus ({((diff/Math.abs(last.reel))*100).toFixed(0)}% d'amélioration possible).
            </div>
          ) : null;
        })()}
      </div>

      <div className="chart-row">
        {/* Radar comportemental */}
        <div className="card card-pad">
          <div className="card-title">🧠 Radar comportemental</div>
          <ResponsiveContainer width="100%" height={240}>
            <RadarChart data={disciplineMetrics}>
              <PolarGrid stroke="var(--bd)"/>
              <PolarAngleAxis dataKey="subject" tick={{fontSize:8,fill:"var(--muted2)"}}/>
              <Radar name="Score" dataKey="A" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.12} strokeWidth={2}/>
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Comportements détectés */}
        <div className="card card-pad">
          <div className="card-title">🔍 Patterns comportementaux détectés</div>
          {behaviors.length === 0 ? (
            <div style={{color:"var(--muted2)",fontSize:11,textAlign:"center",padding:"24px"}}>Ajoutez des tags à vos trades pour détecter vos patterns.</div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {behaviors.map(([tag, count]) => {
                const isNeg = ["FOMO","revenge-trade","over-leveraged","stressé"].some(b=>tag.includes(b));
                const isPos = ["plan-respecté","patient","scaled-in"].some(b=>tag.includes(b));
                const col = isNeg?"var(--red)":isPos?"var(--accent)":"var(--muted2)";
                return (
                  <div key={tag} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:"var(--s2)",borderRadius:8}}>
                    <span style={{fontSize:14}}>{isNeg?"⚠":isPos?"✓":"◉"}</span>
                    <span className="tag" style={{background:`${tagColor(tag)}15`,borderColor:`${tagColor(tag)}35`,color:tagColor(tag)}}>{tag}</span>
                    <span style={{fontSize:10,color:"var(--muted2)"}}>{count}× détecté</span>
                    <span style={{fontSize:10,color:col,marginLeft:"auto",fontWeight:600}}>{isNeg?"Comportement négatif":isPos?"Comportement positif":"Neutre"}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Conseils IA */}
          <div style={{marginTop:16,padding:"12px 14px",background:"var(--s3)",borderRadius:8,fontSize:11,lineHeight:1.7}}>
            <div style={{fontWeight:700,marginBottom:6,color:"var(--accent)"}}>💡 Recommandations IA</div>
            {behaviors.some(([t])=>t==="FOMO") && <div style={{color:"var(--muted2)",marginBottom:4}}>▸ Vous avez {behaviors.find(([t])=>t==="FOMO")?.[1]} trades FOMO. Attendez la confirmation avant d'entrer.</div>}
            {behaviors.some(([t])=>t==="revenge-trade") && <div style={{color:"var(--muted2)",marginBottom:4}}>▸ <strong style={{color:"var(--red)"}}>Revenge trading détecté.</strong> Imposez une pause de 30 min après une perte.</div>}
            {behaviors.some(([t])=>t==="plan-respecté") && <div style={{color:"var(--muted2)",marginBottom:4}}>▸ ✓ Bonne discipline sur les trades plan-respecté. Continuez sur cette lancée.</div>}
            {styleData?.avgRR < 1 && <div style={{color:"var(--amber)"}}>▸ Votre R/R moyen est inférieur à 1. Visez minimum 1,5R par setup.</div>}
            {avgDiscipline >= 70 && <div style={{color:"var(--accent)"}}>▸ 🏆 Excellente discipline globale ! Concentrez-vous sur la qualité des setups.</div>}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── STRIPE CHECKOUT MODAL ───────────────────────────────────────────────────
function CheckoutModal({ plan, onClose, onSuccess }) {
  const [step, setStep]       = useState("details"); // details | payment | processing | success
  const [annual, setAnnual]   = useState(false);
  const [cardNum, setCardNum] = useState("");
  const [expiry, setExpiry]   = useState("");
  const [cvc, setCvc]         = useState("");
  const [name, setName]       = useState("");
  const [error, setError]     = useState("");

  const planInfo = {
    premium: { label:"Premium ⚡", color:"var(--amber)", price:9.99,  priceAnnual:7.49,  features:["100 trades / mois","Historique 3 mois","Psychologie complète","Calendrier P&L","Analyses avancées + MFE/MAE"] },
    pro:     { label:"Premium Pro 🚀", color:"#a78bfa", price:24.99, priceAnnual:18.74, features:["Trades illimités","Historique illimité","Import CSV — 22 brokers","Courbe comportementale IA","Support prioritaire 24h"] },
  };
  const info    = planInfo[plan];
  const price   = annual ? info.priceAnnual : info.price;

  // Format card number with spaces
  const handleCardNum = (v) => {
    const clean = v.replace(/\D/g,"").slice(0,16);
    setCardNum(clean.replace(/(.{4})/g,"$1 ").trim());
  };
  const handleExpiry = (v) => {
    const clean = v.replace(/\D/g,"").slice(0,4);
    setExpiry(clean.length>2 ? clean.slice(0,2)+"/"+clean.slice(2) : clean);
  };

  const handlePay = async () => {
    setError("");
    // En prod Stripe → on redirige vers Stripe Checkout (hosted page)
    // Le formulaire card est conservé pour la démo / fallback hors backend
    if (!name.trim())          { setError("Nom du titulaire requis."); return; }
    if (cardNum.replace(/\s/g,"").length < 16) { setError("Numéro de carte invalide."); return; }
    if (expiry.length < 5)     { setError("Date d'expiration invalide."); return; }
    if (cvc.length < 3)        { setError("CVC invalide."); return; }

    setStep("processing");

    try {
      // 🔌 APPEL BACKEND RÉEL → redirige vers Stripe Checkout
      const billing = annual ? "annual" : "monthly";
      const res = await API.stripe.checkout(plan, billing);
      if (res?.url) {
        // Stripe Checkout hébergé — redirige sur la page Stripe
        window.location.href = res.url;
        return;
      }
    } catch {
      // Backend indisponible → simulation locale
    }

    // Fallback démo : simule le succès
    setTimeout(() => { setStep("success"); }, 2200);
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="checkout-modal">

        {/* ── Success ── */}
        {step==="success" && (
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:52,marginBottom:16}}>🎉</div>
            <div style={{fontFamily:"var(--fh)",fontSize:20,fontWeight:800,marginBottom:8}}>Abonnement activé !</div>
            <div style={{fontSize:12,color:"var(--muted2)",marginBottom:24,lineHeight:1.7}}>
              Votre plan <strong style={{color:info.color}}>{info.label}</strong> est maintenant actif.<br/>
              Un reçu a été envoyé par email.
            </div>
            <button className="btn btn-primary btn-lg" style={{width:"100%",justifyContent:"center"}} onClick={()=>{onSuccess(plan);onClose();}}>
              Accéder à mon espace →
            </button>
          </div>
        )}

        {/* ── Processing ── */}
        {step==="processing" && (
          <div style={{textAlign:"center",padding:"32px 0"}}>
            <div style={{fontSize:36,marginBottom:16,animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</div>
            <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:700,marginBottom:6}}>Traitement en cours…</div>
            <div style={{fontSize:11,color:"var(--muted2)"}}>Connexion sécurisée avec Stripe</div>
          </div>
        )}

        {/* ── Details + Payment ── */}
        {(step==="details"||step==="payment") && (
          <>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
              <div>
                <div style={{fontSize:9,letterSpacing:"1.2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:4}}>Abonnement</div>
                <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:700,color:info.color}}>{info.label}</div>
              </div>
              <button className="modal-close" onClick={onClose}>✕</button>
            </div>

            {/* Toggle annuel/mensuel */}
            <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"10px 14px",marginBottom:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:600}}>Facturation {annual?"annuelle":"mensuelle"}</div>
                <div style={{fontSize:10,color:"var(--muted2)"}}>{annual?"Économisez 25% vs mensuel":"Passez à l'annuel pour -25%"}</div>
              </div>
              <div className={`toggle-track${annual?" on":""}`} onClick={()=>setAnnual(a=>!a)} style={{flexShrink:0}}><div className="toggle-knob"/></div>
            </div>

            {/* Prix */}
            <div style={{textAlign:"center",padding:"16px 0",borderTop:"1px solid var(--bd)",borderBottom:"1px solid var(--bd)",marginBottom:16}}>
              <div className="checkout-price-big" style={{color:info.color}}>{price.toFixed(2)} €</div>
              <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>
                par mois{annual?" · facturé "+((price*12).toFixed(2))+" € / an":""} · Sans engagement
              </div>
              {annual && <div style={{marginTop:6,fontSize:10,color:"var(--accent)"}}>✓ Économie de {((info.price - price)*12).toFixed(2)} € / an</div>}
            </div>

            {/* Features */}
            <div className="checkout-features">
              {info.features.map(f=><div key={f} className="checkout-feat"><span>✓</span><span>{f}</span></div>)}
              <div className="checkout-feat"><span>✓</span><span>14 jours d'essai gratuit · Sans carte bloquée</span></div>
            </div>

            {/* Payment form */}
            <div style={{marginTop:16}}>
              <div style={{fontSize:10,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                🔒 Paiement sécurisé
              </div>
              <div className="fg" style={{marginBottom:10}}>
                <label>Nom du titulaire</label>
                <input className="stripe-input" placeholder="Jean Dupont" value={name} onChange={e=>setName(e.target.value)}/>
              </div>
              <div className="fg" style={{marginBottom:10}}>
                <label>Numéro de carte</label>
                <input className="stripe-input" placeholder="4242 4242 4242 4242" value={cardNum} onChange={e=>handleCardNum(e.target.value)} maxLength={19}/>
              </div>
              <div className="card-input-row" style={{marginBottom:10}}>
                <div className="fg">
                  <label>Expiration</label>
                  <input className="stripe-input" placeholder="MM/AA" value={expiry} onChange={e=>handleExpiry(e.target.value)} maxLength={5}/>
                </div>
                <div className="fg">
                  <label>CVC</label>
                  <input className="stripe-input" placeholder="123" value={cvc} onChange={e=>setCvc(e.target.value.replace(/\D/g,"").slice(0,4))} maxLength={4}/>
                </div>
              </div>
              {error && <div style={{fontSize:10,color:"var(--red)",marginBottom:10,padding:"8px 10px",background:"rgba(255,77,109,.08)",borderRadius:6,border:"1px solid rgba(255,77,109,.2)"}}>⚠ {error}</div>}
              <button className="btn btn-primary btn-lg" style={{width:"100%",justifyContent:"center",marginTop:4}} onClick={handlePay}>
                Démarrer l'essai gratuit →
              </button>
              <div className="stripe-powered">
                <span>🔐</span>
                <span>Sécurisé par Stripe · TLS 256-bit · PCI DSS</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── FACTURATION PAGE ─────────────────────────────────────────────────────────
function FacturationPage({ user, onPlanChange, showToast }) {
  const [showCheckout,  setShowCheckout]  = useState(null);
  const [showCancel,    setShowCancel]    = useState(false);
  const [cancelStep,    setCancelStep]    = useState(1);
  const [loadingPortal, setLoadingPortal] = useState(false);
  const [subData,       setSubData]       = useState(null);

  const plan      = user?.plan || "basic";
  const planInfo  = PLANS[plan];
  const isBasic   = plan === "basic";
  const isPrem    = plan === "premium";
  const isPro_    = plan === "pro";

  // Chargement subscription depuis API
  useEffect(() => {
    if (isBasic) return;
    API.stripe.sub()
      .then(res => setSubData(res?.subscription || null))
      .catch(() => {
        // Fallback données démo
        setSubData({
          status: "active",
          currentPeriodEnd: (() => { const d=new Date(); d.setMonth(d.getMonth()+1); return d.toISOString(); })(),
          paymentMethod: { brand:"VISA", last4:"4242", expMonth:12, expYear:2027 },
        });
      });
  }, [plan]);

  const nextBilling = subData?.currentPeriodEnd
    ? new Date(subData.currentPeriodEnd).toLocaleDateString("fr-FR")
    : (() => { const d=new Date(); d.setMonth(d.getMonth()+1); return d.toLocaleDateString("fr-FR"); })();
  const card = subData?.paymentMethod || (isBasic ? null : { brand:"VISA", last4:"4242" });

  const invoices = isBasic ? [] : [
    {date:"01/05/2025", desc:`EDGELOG ${planInfo.label}`, amount:isPrem?"9,99 €":"24,99 €", status:"paid"},
    {date:"01/04/2025", desc:`EDGELOG ${planInfo.label}`, amount:isPrem?"9,99 €":"24,99 €", status:"paid"},
    {date:"01/03/2025", desc:`EDGELOG ${planInfo.label}`, amount:isPrem?"9,99 €":"24,99 €", status:"paid"},
  ];

  // Portail Stripe → modifier CB / voir factures
  const openPortal = async () => {
    setLoadingPortal(true);
    try {
      const res = await API.stripe.portal();
      if (res?.url) { window.location.href = res.url; return; }
    } catch {}
    setLoadingPortal(false);
    showToast("Portail Stripe indisponible (mode démo)", "info");
  };

  const handleCancelConfirm = async () => {
    try {
      await API.stripe.cancel();
    } catch {}
    onPlanChange("basic");
    setShowCancel(false);
    setCancelStep(1);
    showToast("Abonnement résilié. Plan Basic activé.", "info");
  };

  const PLAN_OPTIONS = [
    { id:"basic",   label:"Basic 🌱",       price:"Gratuit",          color:"var(--blue)" },
    { id:"premium", label:"Premium ⚡",      price:"9,99 € / mois",    color:"var(--amber)" },
    { id:"pro",     label:"Premium Pro 🚀",  price:"Sur demande",      color:"#a78bfa" },
  ];

  return (
    <>
      {/* ── Hero plan actuel ── */}
      <div className="billing-hero">
        <div>
          <div style={{fontSize:9,letterSpacing:"1.2px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:6}}>Votre abonnement</div>
          <div className="billing-plan-name" style={{color:planInfo.color}}>
            {isBasic?"Basic 🌱":isPrem?"Premium ⚡":"Premium Pro 🚀"}
          </div>
          <div className="billing-plan-price">
            {isBasic?"Gratuit · Sans engagement":isPrem?`9,99 € / mois · Prochain prélèvement : ${subData.nextBilling}`:`Sur devis · Contact : pro@edgelog.app`}
          </div>
          <div style={{marginTop:10}}>
            <span className={`billing-status ${isBasic?"free":"active"}`}>
              {isBasic?"● Plan gratuit":"● Actif"}
            </span>
          </div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end"}}>
          {!isBasic && (
            <button className="btn btn-ghost btn-sm" onClick={()=>setShowCancel(true)}>
              Résilier l'abonnement
            </button>
          )}
          {isBasic && (
            <button className="btn btn-amber btn-sm" onClick={()=>setShowCheckout("premium")}>
              Passer à Premium →
            </button>
          )}
        </div>
      </div>

      {/* ── Changer de plan ── */}
      <div className="billing-card">
        <div className="billing-card-title">📋 Changer de plan</div>
        <div className="plan-switch-grid">
          {PLAN_OPTIONS.map(p => (
            <div key={p.id} className={`plan-switch-card ${p.id} ${plan===p.id?"current":""}`}
              onClick={()=>{ if(plan===p.id) return; if(p.id==="pro") { window.open("mailto:pro@edgelog.app?subject=EDGELOG Premium Pro","_blank"); return; } if(p.id==="basic"){ setShowCancel(true); } else { setShowCheckout(p.id); }}}>
              {plan===p.id && <div className="psw-badge" style={{background:p.color+"25",color:p.color,border:`1px solid ${p.color}40`}}>Plan actuel</div>}
              <div style={{fontSize:24,marginBottom:6,marginTop:plan===p.id?8:0}}>{p.id==="basic"?"🌱":p.id==="premium"?"⚡":"🚀"}</div>
              <div className="psw-name" style={{color:plan===p.id?p.color:"var(--text)"}}>{p.label}</div>
              <div className="psw-price">{p.price}</div>
              {plan!==p.id && (
                <div style={{marginTop:10}}>
                  <span className="btn btn-ghost btn-sm" style={{fontSize:9,padding:"3px 10px"}}>
                    {p.id==="basic"?"Résilier":p.id==="pro"?"Nous contacter":"Souscrire →"}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{fontSize:10,color:"var(--muted2)",display:"flex",alignItems:"center",gap:6}}>
          🔒 Paiement sécurisé par Stripe · Sans engagement · Résiliable à tout moment
        </div>
      </div>

      {/* ── Moyen de paiement ── */}
      {!isBasic && (
        <div className="billing-card">
          <div className="billing-card-title">💳 Moyen de paiement</div>
          <div className="payment-method-row">
            <div className="card-brand">{card?.brand || "VISA"}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:600}}>•••• •••• •••• {card?.last4 || "4242"}</div>
              <div style={{fontSize:10,color:"var(--muted2)"}}>Expire {card?.expMonth ? `${String(card.expMonth).padStart(2,"0")}/${card.expYear}` : "12/2027"}</div>
            </div>
            <span className="billing-status active" style={{fontSize:9}}>Principale</span>
            <button className="btn btn-ghost btn-sm" onClick={openPortal} disabled={loadingPortal}>
              {loadingPortal ? "⟳" : "Modifier"}
            </button>
          </div>
          <div style={{marginTop:10,fontSize:10,color:"var(--muted2)"}}>
            Pour mettre à jour votre moyen de paiement, vous serez redirigé vers le portail sécurisé Stripe.
          </div>
        </div>
      )}

      {/* ── Historique des factures ── */}
      <div className="billing-card">
        <div className="billing-card-title">🧾 Historique des factures</div>
        {invoices.length === 0 ? (
          <div style={{textAlign:"center",padding:"24px",color:"var(--muted2)",fontSize:11}}>
            <div style={{fontSize:28,marginBottom:8}}>📄</div>
            Aucune facture pour le moment.{isBasic && <span> Les factures apparaissent après souscription à un plan payant.</span>}
          </div>
        ) : (
          <>
            <div className="invoice-row header">
              <span>Date</span><span>Description</span><span>Montant</span><span>Statut</span>
            </div>
            {invoices.map((inv,i) => (
              <div key={i} className="invoice-row">
                <span style={{color:"var(--muted2)"}}>{inv.date}</span>
                <span>{inv.desc}</span>
                <span style={{fontWeight:600}}>{inv.amount}</span>
                <span>
                  <span className={`invoice-badge ${inv.status}`}>
                    {inv.status==="paid"?"✓ Payée":"En attente"}
                  </span>
                </span>
              </div>
            ))}
          </>
        )}
        {!isBasic && (
          <button className="btn btn-ghost btn-sm" style={{marginTop:14}} onClick={()=>showToast("Téléchargement du PDF…","info")}>
            ⬇ Télécharger toutes les factures
          </button>
        )}
      </div>

      {/* ── Info légales ── */}
      <div style={{fontSize:10,color:"var(--muted2)",lineHeight:1.8,padding:"0 4px"}}>
        EDGELOG est édité par EDGELOG SAS · TVA intracommunautaire : FR00000000000 · En souscrivant, vous acceptez nos <span style={{color:"var(--accent)",cursor:"pointer"}}>CGV</span> et notre <span style={{color:"var(--accent)",cursor:"pointer"}}>politique de confidentialité</span>. Les paiements sont traités par Stripe, Inc. (certifié PCI DSS niveau 1). Vous pouvez résilier à tout moment depuis cette page.
      </div>

      {/* ── Checkout modal ── */}
      {showCheckout && (
        <CheckoutModal
          plan={showCheckout}
          onClose={()=>setShowCheckout(null)}
          onSuccess={(p)=>{ onPlanChange(p); setShowCheckout(null); }}
        />
      )}

      {/* ── Annulation modal ── */}
      {showCancel && (
        <div className="overlay" onClick={e=>e.target===e.currentTarget&&setShowCancel(false)}>
          <div className="modal" style={{maxWidth:420}}>
            <div className="modal-title">
              Résilier l'abonnement
              <button className="modal-close" onClick={()=>{setShowCancel(false);setCancelStep(1);}}>✕</button>
            </div>

            {cancelStep===1 && (
              <>
                <div style={{fontSize:13,lineHeight:1.7,marginBottom:20}}>
                  Êtes-vous sûr de vouloir résilier votre abonnement <strong style={{color:planInfo.color}}>{planInfo.label}</strong> ?
                </div>
                <div style={{background:"var(--s2)",border:"1px solid rgba(255,77,109,.2)",borderRadius:8,padding:"14px 16px",marginBottom:20}}>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--red)",marginBottom:8}}>⚠ Ce que vous allez perdre :</div>
                  {isPrem && ["Accès aux analyses avancées","Calendrier P&L","Psychologie complète","Historique 3 mois"].map(f=>(
                    <div key={f} style={{fontSize:11,color:"var(--muted2)",marginBottom:4}}>✕ {f}</div>
                  ))}
                  {isPro_ && ["Trades illimités","Import CSV","Prévision IA","Support prioritaire"].map(f=>(
                    <div key={f} style={{fontSize:11,color:"var(--muted2)",marginBottom:4}}>✕ {f}</div>
                  ))}
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button className="btn btn-ghost" onClick={()=>setShowCancel(false)}>Garder mon abonnement</button>
                  <button className="btn btn-red" onClick={()=>setCancelStep(2)}>Continuer la résiliation →</button>
                </div>
              </>
            )}

            {cancelStep===2 && (
              <>
                <div style={{fontSize:13,lineHeight:1.7,marginBottom:16}}>
                  Avant de partir, dites-nous pourquoi :
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                  {["Trop cher","Je n'utilise pas assez l'app","Il manque des fonctionnalités","Je passe à un concurrent","Autre raison"].map(r=>(
                    <div key={r} onClick={()=>setCancelStep(3)} style={{padding:"10px 14px",background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,cursor:"pointer",fontSize:12,transition:"border-color .13s"}}
                      onMouseEnter={e=>e.currentTarget.style.borderColor="var(--red)"}
                      onMouseLeave={e=>e.currentTarget.style.borderColor="var(--bd)"}>
                      {r}
                    </div>
                  ))}
                </div>
              </>
            )}

            {cancelStep===3 && (
              <>
                <div style={{textAlign:"center",padding:"16px 0"}}>
                  <div style={{fontSize:32,marginBottom:12}}>😔</div>
                  <div style={{fontSize:14,fontWeight:600,marginBottom:8}}>Dommage de vous voir partir…</div>
                  <div style={{fontSize:11,color:"var(--muted2)",lineHeight:1.7,marginBottom:20}}>
                    Votre abonnement restera actif jusqu'à la fin de la période en cours.<br/>
                    Vos données seront conservées pendant 90 jours.
                  </div>
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button className="btn btn-ghost" onClick={()=>setShowCancel(false)}>Annuler</button>
                  <button className="btn btn-red" onClick={handleCancelConfirm}>Confirmer la résiliation</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ─── TOOLTIP ONBOARDING GUIDE ────────────────────────────────────────────────
const TOOLTIP_STEPS = [
  { title:"Bienvenue sur EDGELOG 👋", text:"Ce guide va vous montrer les fonctionnalités clés en 6 étapes. Vous pouvez le quitter à tout moment.", target:null, pos:"center" },
  { title:"Ajouter un trade ➕",       text:"Cliquez sur '+ Nouveau trade' pour enregistrer une position. Remplissez les infos essentielles : actif, direction, P&L.", target:"btn-primary", pos:"bottom" },
  { title:"Dashboard 📊",             text:"Le dashboard centralise vos KPIs : solde, win rate, profit factor et courbe de capital.", target:"dashboard", pos:"right" },
  { title:"Psychologie 🧠",           text:"Trackez vos émotions avant et après chaque trade. EDGELOG corrèle vos émotions avec vos performances.", target:"psychology", pos:"right" },
  { title:"Analyses avancées 📈",     text:"Win rate par actif, drawdown max, distribution R multiples. Tout pour comprendre vos patterns.", target:"analyses", pos:"right" },
  { title:"C'est parti ! 🚀",          text:"Vous êtes prêt. Ajoutez vos premiers trades et suivez votre progression.", target:null, pos:"center" },
];

function TooltipGuide({ step, onNext, onSkip, setPage }) {
  const s = TOOLTIP_STEPS[Math.min(step, TOOLTIP_STEPS.length - 1)];
  const isLast = step >= TOOLTIP_STEPS.length - 1;

  return (
    <div className="tooltip-overlay" style={{pointerEvents:"all"}}>
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)"}} onClick={onSkip}/>
      <div className="tooltip-box" style={{
        top:"50%", left:"50%", transform:"translate(-50%,-50%)",
        pointerEvents:"all",
      }}>
        <div className="tooltip-step">Étape {Math.min(step+1, TOOLTIP_STEPS.length)} / {TOOLTIP_STEPS.length}</div>
        <div className="tooltip-title">{s.title}</div>
        <div className="tooltip-text">{s.text}</div>
        <div className="tooltip-nav">
          <div className="tooltip-dots">
            {TOOLTIP_STEPS.map((_,i)=>(
              <div key={i} className={`tooltip-dot${i===step?" active":""}`}/>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn btn-ghost btn-sm" onClick={onSkip}>Passer</button>
            <button className="btn btn-primary btn-sm" onClick={()=>{ if(isLast){onSkip();}else{onNext();} }}>
              {isLast?"Terminer →":"Suivant →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function SettingsPage({ user, onUpdateUser, showToast }) {
  const [tab,          setTab]        = useState("profil");
  const [name,         setName]       = useState(user?.name || "");
  const [currentPwd,   setCurrentPwd] = useState("");
  const [newPwd,       setNewPwd]     = useState("");
  const [confirmPwd,   setConfirmPwd] = useState("");
  const [loadingSave,  setLoadingSave]= useState(false);
  const [loadingDel,   setLoadingDel] = useState(false);
  const [confirmDel,   setConfirmDel] = useState(false);
  const [delPwd,       setDelPwd]     = useState("");

  // Préférences
  const [prefCurrency,  setPrefCurrency]  = useState("$");
  const [prefRisk,      setPrefRisk]      = useState("1");
  const [prefEmailRep,  setPrefEmailRep]  = useState(true);
  const [prefEmailTrial,setPrefEmailTrial]= useState(true);
  const [prefTheme,     setPrefTheme]     = useState("dark");

  const handleSaveProfil = async () => {
    if (!name.trim()) { showToast("Nom requis.", "err"); return; }
    setLoadingSave(true);
    try {
      const body = { name };
      if (newPwd) {
        if (newPwd !== confirmPwd) { showToast("Les mots de passe ne correspondent pas.", "err"); setLoadingSave(false); return; }
        if (newPwd.length < 8)    { showToast("Mot de passe min. 8 caractères.", "err"); setLoadingSave(false); return; }
        body.currentPassword = currentPwd;
        body.newPassword     = newPwd;
      }
      await API.user.update(body);
      onUpdateUser({ ...user, name });
      showToast("Profil mis à jour ✓");
      setCurrentPwd(""); setNewPwd(""); setConfirmPwd("");
    } catch (err) {
      showToast(err.message || "Erreur lors de la mise à jour.", "err");
    } finally {
      setLoadingSave(false);
    }
  };

  const handleDeleteAccount = async () => {
    setLoadingDel(true);
    try {
      await API.user.delete(delPwd);
      tokenStore.clear();
      window.location.reload();
    } catch (err) {
      showToast(err.message || "Impossible de supprimer le compte.", "err");
      setLoadingDel(false);
    }
  };

  const TABS = [
    {id:"profil",    lbl:"Mon profil"},
    {id:"prefs",     lbl:"Préférences"},
    {id:"notifs",    lbl:"Notifications"},
    {id:"securite",  lbl:"Sécurité & Compte"},
  ];

  return (
    <>
      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:20,background:"var(--s2)",padding:4,borderRadius:8,border:"1px solid var(--bd)",overflowX:"auto"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{flex:"1 0 auto",padding:"8px 14px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,whiteSpace:"nowrap",
              background:tab===t.id?"var(--s1)":"transparent",
              color:tab===t.id?"var(--text)":"var(--muted2)",transition:"all .13s"}}>
            {t.lbl}
          </button>
        ))}
      </div>

      {/* ── Onglet Profil ── */}
      {tab==="profil" && (
        <div className="card card-pad">
          <div className="card-title">Mon profil</div>

          {/* Avatar */}
          <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:20}}>
            <div style={{width:60,height:60,borderRadius:"50%",background:"linear-gradient(135deg,var(--accent)33,var(--blue)33)",border:"2px solid var(--bd2)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--fh)",fontSize:22,fontWeight:800}}>
              {(user?.name||"U").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()}
            </div>
            <div>
              <div style={{fontFamily:"var(--fh)",fontSize:14,fontWeight:700}}>{user?.name}</div>
              <div style={{fontSize:11,color:"var(--muted2)"}}>{user?.email}</div>
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>
                Plan : <span style={{color:"var(--accent)",fontWeight:600}}>{PLANS[user?.plan||"basic"]?.label}</span>
              </div>
            </div>
          </div>

          <div className="fg" style={{marginBottom:12}}>
            <label>Nom affiché</label>
            <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Votre nom"/>
          </div>

          <div className="fg" style={{marginBottom:12}}>
            <label>Email</label>
            <input className="input" value={user?.email||""} disabled style={{opacity:.5,cursor:"not-allowed"}}/>
            <span style={{fontSize:10,color:"var(--muted2)"}}>L'email ne peut pas être modifié.</span>
          </div>

          <div style={{borderTop:"1px solid var(--bd)",paddingTop:16,marginTop:4,marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>Changer le mot de passe</div>
            <div className="fg" style={{marginBottom:8}}>
              <label>Mot de passe actuel</label>
              <input className="input" type="password" value={currentPwd} onChange={e=>setCurrentPwd(e.target.value)} placeholder="••••••••"/>
            </div>
            <div className="fg" style={{marginBottom:8}}>
              <label>Nouveau mot de passe</label>
              <input className="input" type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)} placeholder="Min. 8 caractères"/>
            </div>
            <div className="fg" style={{marginBottom:12}}>
              <label>Confirmer</label>
              <input className="input" type="password" value={confirmPwd} onChange={e=>setConfirmPwd(e.target.value)} placeholder="Répéter le mot de passe"/>
            </div>
          </div>

          <button className="btn btn-primary" onClick={handleSaveProfil} disabled={loadingSave} style={{width:"100%",justifyContent:"center"}}>
            {loadingSave ? "⟳ Enregistrement…" : "Enregistrer les modifications"}
          </button>
        </div>
      )}

      {/* ── Onglet Préférences ── */}
      {tab==="prefs" && (
        <div className="card card-pad">
          <div className="card-title">Préférences de trading</div>

          <div className="fg" style={{marginBottom:12}}>
            <label>Devise principale</label>
            <select className="select" value={prefCurrency} onChange={e=>setPrefCurrency(e.target.value)}>
              {["$","€","£","¥","CHF"].map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="fg" style={{marginBottom:12}}>
            <label>Risque par trade (%)</label>
            <input className="input" type="number" min="0.1" max="10" step="0.1" value={prefRisk} onChange={e=>setPrefRisk(e.target.value)}/>
            <span style={{fontSize:10,color:"var(--muted2)"}}>Utilisé pour le calcul de taille de position.</span>
          </div>

          <div className="fg" style={{marginBottom:16}}>
            <label>Thème</label>
            <select className="select" value={prefTheme} onChange={e=>setPrefTheme(e.target.value)}>
              <option value="dark">Sombre (actuel)</option>
              <option value="light">Clair — bientôt</option>
              <option value="system">Système — bientôt</option>
            </select>
          </div>

          <button className="btn btn-primary" style={{width:"100%",justifyContent:"center"}} onClick={()=>showToast("Préférences enregistrées ✓")}>
            Enregistrer
          </button>
        </div>
      )}

      {/* ── Onglet Notifications ── */}
      {tab==="notifs" && (
        <div className="card card-pad">
          <div className="card-title">Préférences de notifications</div>
          {[
            {lbl:"Rapport mensuel par email",     val:prefEmailRep,   set:setPrefEmailRep},
            {lbl:"Rappel fin d'essai",            val:prefEmailTrial, set:setPrefEmailTrial},
          ].map(n=>(
            <div key={n.lbl} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:"1px solid var(--bd)"}}>
              <span style={{fontSize:12}}>{n.lbl}</span>
              <div onClick={()=>n.set(v=>!v)} style={{width:40,height:22,borderRadius:11,background:n.val?"var(--accent)":"var(--bd2)",cursor:"pointer",position:"relative",transition:"background .2s"}}>
                <div style={{position:"absolute",top:3,left:n.val?19:3,width:16,height:16,borderRadius:"50%",background:"white",transition:"left .2s"}}/>
              </div>
            </div>
          ))}
          <button className="btn btn-primary" style={{width:"100%",justifyContent:"center",marginTop:16}} onClick={()=>showToast("Préférences notifications enregistrées ✓")}>
            Enregistrer
          </button>
        </div>
      )}

      {/* ── Onglet Sécurité ── */}
      {tab==="securite" && (
        <>
          <div className="card card-pad" style={{marginBottom:12}}>
            <div className="card-title">Sessions actives</div>
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:"1px solid var(--bd)"}}>
              <div style={{fontSize:20}}>💻</div>
              <div style={{flex:1}}>
                <div style={{fontSize:12,fontWeight:600}}>Session actuelle</div>
                <div style={{fontSize:10,color:"var(--muted2)"}}>{navigator.userAgent?.slice(0,60)}…</div>
              </div>
              <span style={{fontSize:9,padding:"2px 7px",borderRadius:4,background:"rgba(0,229,160,.1)",color:"var(--accent)",fontWeight:700}}>ACTIF</span>
            </div>
            <button className="btn btn-ghost btn-sm" style={{marginTop:12}} onClick={()=>{API.auth.logout(tokenStore.refresh).catch(()=>{}); tokenStore.clear(); window.location.reload();}}>
              Déconnecter toutes les sessions
            </button>
          </div>

          {/* Zone danger */}
          <div className="card card-pad" style={{border:"1px solid rgba(255,77,109,.25)"}}>
            <div style={{fontFamily:"var(--fh)",fontSize:13,fontWeight:700,color:"var(--red)",marginBottom:8}}>⚠ Zone dangereuse</div>
            <div style={{fontSize:12,color:"var(--muted2)",marginBottom:16,lineHeight:1.7}}>
              La suppression de votre compte est <strong>irréversible</strong>. Toutes vos données (trades, comptes, analyses) seront supprimées après 90 jours conformément à notre politique de confidentialité.
            </div>

            {!confirmDel ? (
              <button className="btn btn-red btn-sm" onClick={()=>setConfirmDel(true)}>
                Supprimer mon compte
              </button>
            ) : (
              <div>
                <div className="fg" style={{marginBottom:10}}>
                  <label style={{color:"var(--red)"}}>Confirmez votre mot de passe pour supprimer</label>
                  <input className="input" type="password" value={delPwd} onChange={e=>setDelPwd(e.target.value)} placeholder="Mot de passe actuel"/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn btn-ghost btn-sm" onClick={()=>{setConfirmDel(false);setDelPwd("");}}>Annuler</button>
                  <button className="btn btn-red btn-sm" onClick={handleDeleteAccount} disabled={loadingDel||!delPwd}>
                    {loadingDel?"⟳ Suppression…":"Confirmer la suppression"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ─── EXPORT PDF MODAL ─────────────────────────────────────────────────────────
function ExportPDFModal({ trades, user, account, onClose }) {
  const [month,    setMonth]    = useState(new Date().getMonth());
  const [year,     setYear]     = useState(new Date().getFullYear());
  const [loading,  setLoading]  = useState(false);
  const [done,     setDone]     = useState(false);

  const months = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];

  const filtered = trades.filter(t => {
    if (t.status !== "CLOSED") return false;
    const d = new Date(t.date);
    return d.getMonth() === month && d.getFullYear() === year;
  });

  const totalPnl  = filtered.reduce((s,t) => s+(t.pnl||0), 0);
  const wins      = filtered.filter(t => t.pnl > 0).length;
  const winRate   = filtered.length ? ((wins/filtered.length)*100).toFixed(1) : 0;
  const avgR      = filtered.filter(t=>t.rMultiple).length
    ? (filtered.reduce((s,t)=>s+(t.rMultiple||0),0)/filtered.filter(t=>t.rMultiple).length).toFixed(2)
    : "—";

  const generatePDF = () => {
    setLoading(true);
    // Simule génération PDF (en prod : jsPDF ou Puppeteer backend)
    setTimeout(() => {
      setLoading(false);
      setDone(true);
      // En prod : window.open(blobUrl)
    }, 1800);
  };

  return (
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="export-modal">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <div style={{fontSize:9,letterSpacing:"1px",textTransform:"uppercase",color:"var(--muted2)",marginBottom:4}}>Rapport mensuel</div>
            <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:700}}>Exporter en PDF</div>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {done ? (
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:40,marginBottom:12}}>📄</div>
            <div style={{fontFamily:"var(--fh)",fontSize:15,fontWeight:700,marginBottom:6}}>Rapport généré !</div>
            <div style={{fontSize:11,color:"var(--muted2)",marginBottom:20}}>
              EDGELOG_{months[month]}_{year}.pdf
            </div>
            <button className="btn btn-primary btn-lg" style={{width:"100%",justifyContent:"center"}} onClick={onClose}>
              ⬇ Télécharger le rapport
            </button>
          </div>
        ) : (
          <>
            {/* Sélecteur mois / année */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
              <div className="fg">
                <label>Mois</label>
                <select className="select" value={month} onChange={e=>setMonth(+e.target.value)}>
                  {months.map((m,i)=><option key={i} value={i}>{m}</option>)}
                </select>
              </div>
              <div className="fg">
                <label>Année</label>
                <select className="select" value={year} onChange={e=>setYear(+e.target.value)}>
                  {[2023,2024,2025,2026].map(y=><option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* Aperçu du contenu */}
            <div className="export-preview">
              <div className="export-section-title">📊 Rapport {months[month]} {year} — {account?.name}</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 20px"}}>
                <span>Trades clôturés</span><span style={{color:"var(--text)",fontWeight:600}}>{filtered.length}</span>
                <span>P&L total</span><span style={{color:totalPnl>=0?"var(--accent)":"var(--red)",fontWeight:600}}>{totalPnl>=0?"+":""}{totalPnl.toFixed(2)} $</span>
                <span>Win Rate</span><span style={{fontWeight:600}}>{winRate}%</span>
                <span>R moyen</span><span style={{fontWeight:600}}>{avgR}</span>
              </div>
              <div style={{marginTop:8,borderTop:"1px dashed var(--bd)",paddingTop:8}}>
                <div style={{fontWeight:600,marginBottom:4}}>Inclus dans le rapport :</div>
                {["Résumé de performance","Liste complète des trades","Courbe de capital","Répartition par actif","Analyse émotionnelle","Recommandations"].map(s=>(
                  <div key={s} style={{color:"var(--muted2)"}}>✓ {s}</div>
                ))}
              </div>
            </div>

            {filtered.length === 0 && (
              <div style={{background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.2)",borderRadius:8,padding:"10px 14px",fontSize:11,color:"var(--amber)",marginBottom:12}}>
                ⚠ Aucun trade clôturé en {months[month]} {year}. Le rapport sera vide.
              </div>
            )}

            <button className="btn btn-primary btn-lg" style={{width:"100%",justifyContent:"center"}} onClick={generatePDF} disabled={loading}>
              {loading ? "⟳ Génération en cours…" : "⬇ Générer le PDF"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── PROFIL PUBLIC ─────────────────────────────────────────────────────────────
function ProfilPage({ user, trades, setPage, showToast }) {
  const [copied, setCopied]       = useState(false);
  const [showExport, setShowExport]= useState(false);
  const [activeTab, setActiveTab]  = useState("perf");

  const closed    = trades.filter(t => t.status === "CLOSED");
  const totalPnl  = closed.reduce((s,t) => s+(t.pnl||0), 0);
  const wins      = closed.filter(t => t.pnl > 0).length;
  const winRate   = closed.length ? ((wins/closed.length)*100).toFixed(1) : 0;
  const bestTrade = closed.reduce((b,t) => (t.pnl||0)>(b.pnl||0)?t:b, {pnl:0});
  const worstTrade= closed.reduce((w,t) => (t.pnl||0)<(w.pnl||0)?t:w, {pnl:0});
  const avgR      = closed.filter(t=>t.rMultiple).length
    ? (closed.reduce((s,t)=>s+(t.rMultiple||0),0)/closed.filter(t=>t.rMultiple).length).toFixed(2) : "—";

  // Top actifs
  const assetStats = {};
  closed.forEach(t => {
    if (!assetStats[t.asset]) assetStats[t.asset] = {pnl:0,count:0,wins:0};
    assetStats[t.asset].pnl   += t.pnl||0;
    assetStats[t.asset].count += 1;
    if (t.pnl>0) assetStats[t.asset].wins++;
  });
  const topAssets = Object.entries(assetStats)
    .map(([asset,s]) => ({asset,...s,wr:((s.wins/s.count)*100).toFixed(0)}))
    .sort((a,b) => b.pnl-a.pnl).slice(0,5);

  const shareUrl = `https://edgelog.app/trader/${user?.id}`;

  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl).catch(()=>{});
    setCopied(true);
    setTimeout(()=>setCopied(false),2000);
    showToast("Lien copié ! 🔗");
  };

  const initials = (user?.name||"U").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString("fr-FR",{month:"long",year:"numeric"})
    : "Janvier 2025";

  return (
    <>
      {/* Hero profil */}
      <div className="profile-hero">
        <div style={{position:"relative",zIndex:1}}>
          <div className="profile-avatar-lg" style={{background:`hsl(${(user?.name||"U").charCodeAt(0)*7%360},60%,25%)`,color:"var(--text)"}}>
            {initials}
          </div>
          <div className="profile-name">{user?.name || "Trader"}</div>
          <div className="profile-since">Membre depuis {memberSince}</div>
          <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:12,flexWrap:"wrap"}}>
            <div className="profile-share-btn" onClick={copyLink}>
              🔗 {copied ? "Lien copié !" : "Partager mon profil"}
            </div>
            <div className="profile-share-btn" style={{background:"rgba(56,189,248,.1)",borderColor:"rgba(56,189,248,.25)",color:"var(--blue)"}} onClick={()=>setShowExport(true)}>
              📄 Exporter PDF
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="profile-stats-row">
        {[
          {lbl:"Trades",  val:closed.length, color:"var(--text)"},
          {lbl:"Win Rate",val:`${winRate}%`, color:winRate>=50?"var(--accent)":"var(--red)"},
          {lbl:"P&L Total",val:`${totalPnl>=0?"+":""}${totalPnl.toFixed(0)}$`, color:totalPnl>=0?"var(--accent)":"var(--red)"},
          {lbl:"R Moyen",  val:avgR, color:"var(--text)"},
        ].map(s=>(
          <div key={s.lbl} className="profile-stat">
            <div className="profile-stat-val" style={{color:s.color}}>{s.val}</div>
            <div className="profile-stat-lbl">{s.lbl}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:16,background:"var(--s2)",padding:4,borderRadius:8,border:"1px solid var(--bd)"}}>
        {[{id:"perf",lbl:"Performance"},{id:"assets",lbl:"Par actif"},{id:"recent",lbl:"Derniers trades"},{id:"share",lbl:"Partage"}].map(t=>(
          <button key={t.id} onClick={()=>setActiveTab(t.id)}
            style={{flex:1,padding:"7px",borderRadius:6,border:"none",cursor:"pointer",fontSize:11,fontWeight:600,
              background:activeTab===t.id?"var(--s1)":"transparent",
              color:activeTab===t.id?"var(--text)":"var(--muted2)",
              transition:"all .13s"}}>
            {t.lbl}
          </button>
        ))}
      </div>

      {/* Tab: Performance */}
      {activeTab==="perf" && (
        <div className="card card-pad">
          <div className="card-title">Résumé de performance</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {[
              {lbl:"Meilleur trade", val:`+${(bestTrade.pnl||0).toFixed(2)}$`, ico:"🏆", color:"var(--accent)"},
              {lbl:"Pire trade",     val:`${(worstTrade.pnl||0).toFixed(2)}$`, ico:"📉", color:"var(--red)"},
              {lbl:"Trades gagnants",val:`${wins}/${closed.length}`, ico:"✅", color:"var(--accent)"},
              {lbl:"Séquence actuelle",val:"Calcul…", ico:"🔥", color:"var(--amber)"},
            ].map(s=>(
              <div key={s.lbl} style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"12px 14px"}}>
                <div style={{fontSize:18,marginBottom:4}}>{s.ico}</div>
                <div style={{fontFamily:"var(--fh)",fontSize:16,fontWeight:700,color:s.color}}>{s.val}</div>
                <div style={{fontSize:9,color:"var(--muted2)",textTransform:"uppercase",letterSpacing:".5px"}}>{s.lbl}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Par actif */}
      {activeTab==="assets" && (
        <div className="card">
          <div style={{padding:"14px 20px",borderBottom:"1px solid var(--bd)"}}><div className="card-title" style={{margin:0}}>Top actifs</div></div>
          {topAssets.length===0
            ? <div style={{padding:"28px",textAlign:"center",color:"var(--muted2)",fontSize:11}}>Pas encore de trades clôturés.</div>
            : <table><thead><tr><th>Actif</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr></thead>
              <tbody>{topAssets.map(a=>(
                <tr key={a.asset}>
                  <td><strong>{a.asset}</strong></td>
                  <td>{a.count}</td>
                  <td style={{color:a.wr>=50?"var(--accent)":"var(--red)"}}>{a.wr}%</td>
                  <td style={{color:a.pnl>=0?"var(--accent)":"var(--red)",fontWeight:600}}>{a.pnl>=0?"+":""}{a.pnl.toFixed(2)}$</td>
                </tr>
              ))}</tbody>
            </table>
          }
        </div>
      )}

      {/* Tab: Derniers trades */}
      {activeTab==="recent" && (
        <div className="card">
          <div style={{padding:"14px 20px",borderBottom:"1px solid var(--bd)"}}><div className="card-title" style={{margin:0}}>10 derniers trades</div></div>
          {closed.length===0
            ? <div style={{padding:"28px",textAlign:"center",color:"var(--muted2)",fontSize:11}}>Aucun trade clôturé.</div>
            : <table><thead><tr><th>Date</th><th>Actif</th><th>Direction</th><th>P&L</th><th>R</th></tr></thead>
              <tbody>{closed.slice(0,10).map(t=>(
                <tr key={t.id}>
                  <td style={{fontSize:10,color:"var(--muted2)"}}>{t.date}</td>
                  <td><strong>{t.asset}</strong></td>
                  <td><span style={{padding:"2px 7px",borderRadius:4,background:t.direction==="LONG"?"rgba(0,229,160,.1)":"rgba(255,77,109,.1)",color:t.direction==="LONG"?"var(--accent)":"var(--red)",fontSize:9,fontWeight:700}}>{t.direction}</span></td>
                  <td style={{color:t.pnl>=0?"var(--accent)":"var(--red)",fontWeight:600}}>{t.pnl>=0?"+":""}{(t.pnl||0).toFixed(2)}$</td>
                  <td style={{color:"var(--muted2)"}}>{t.rMultiple?`${t.rMultiple>0?"+":""}${t.rMultiple}R`:"—"}</td>
                </tr>
              ))}</tbody>
            </table>
          }
        </div>
      )}

      {/* Tab: Partage */}
      {activeTab==="share" && (
        <div className="card card-pad">
          <div className="card-title">🔗 Partager mon profil public</div>
          <div style={{fontSize:12,color:"var(--muted2)",marginBottom:16,lineHeight:1.7}}>
            Votre profil public affiche vos statistiques globales sans révéler vos positions précises ni vos montants réels.
          </div>
          <div style={{background:"var(--s2)",border:"1px solid var(--bd)",borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
            <span style={{flex:1,fontSize:11,color:"var(--muted2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shareUrl}</span>
            <button className="btn btn-ghost btn-sm" onClick={copyLink}>{copied?"✓ Copié !":"Copier"}</button>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {[{ico:"𝕏",lbl:"X / Twitter",bg:"#1a1a2e"},{ico:"💼",lbl:"LinkedIn",bg:"#0a66c2"},{ico:"💬",lbl:"Discord",bg:"#5865f2"}].map(s=>(
              <button key={s.lbl} onClick={()=>showToast(`Partage ${s.lbl} →`,"info")}
                style={{display:"flex",alignItems:"center",gap:6,padding:"8px 14px",background:s.bg+"33",border:`1px solid ${s.bg}55`,borderRadius:7,color:"var(--text)",cursor:"pointer",fontSize:11,fontWeight:600}}>
                {s.ico} {s.lbl}
              </button>
            ))}
          </div>
          <div style={{marginTop:16,padding:"12px 14px",background:"rgba(0,229,160,.05)",border:"1px solid rgba(0,229,160,.15)",borderRadius:8,fontSize:11,color:"var(--muted2)"}}>
            🔒 Vos données personnelles et montants exacts ne sont jamais partagés. Seules les statistiques anonymisées sont visibles.
          </div>
        </div>
      )}

      {showExport && <ExportPDFModal trades={trades} user={user} account={{name:"Compte Principal"}} onClose={()=>setShowExport(false)}/>}
    </>
  );
}

// ─── ACCOUNT MODAL ────────────────────────────────────────────────────────────
function AccountModal({accounts,active,onSelect,onAdd,onDelete,onClose}){
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({name:"",type:"Réel",balance:10000});
  return(
    <div className="overlay" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{width:440}}>
        <div className="modal-title">Comptes de trading<button className="modal-close" onClick={onClose}>✕</button></div>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
          {accounts.map(a=>(
            <div key={a.id} onClick={()=>onSelect(a.id)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 14px",background:"var(--s2)",border:`1px solid ${a.id===active?"var(--accent)":"var(--bd)"}`,borderRadius:8,cursor:"pointer",transition:"border-color .13s"}}>
              <div><div style={{fontWeight:600,fontSize:13}}>{a.name}</div><div style={{fontSize:9,color:"var(--muted2)",textTransform:"uppercase",letterSpacing:".8px"}}>{a.type}</div><div style={{fontSize:10,color:"var(--accent)",marginTop:2}}>{fmt(a.balance,0)} {a.currency}</div></div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>{a.id===active&&<span style={{fontSize:10,color:"var(--accent)"}}>✓</span>}{accounts.length>1&&<button className="btn btn-red btn-sm" onClick={e=>{e.stopPropagation();onDelete(a.id);}}>✕</button>}</div>
            </div>
          ))}
        </div>
        {!adding?<button className="btn btn-ghost" style={{width:"100%",justifyContent:"center"}} onClick={()=>setAdding(true)}>+ Nouveau compte</button>:(
          <div style={{display:"flex",flexDirection:"column",gap:10,padding:16,background:"var(--s2)",borderRadius:10,border:"1px solid var(--bd)"}}>
            <div className="section-title">Nouveau compte</div>
            <div className="fg"><label>Nom</label><input placeholder="ex: Compte FX" value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}/></div>
            <div className="form-grid">
              <div className="fg"><label>Type</label><select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))}><option>Réel</option><option>Démo</option><option>Prop Firm</option></select></div>
              <div className="fg"><label>Capital ($)</label><input type="number" value={form.balance} onChange={e=>setForm(p=>({...p,balance:parseFloat(e.target.value)}))}/></div>
            </div>
            <div style={{display:"flex",gap:8}}><button className="btn btn-ghost btn-sm" onClick={()=>setAdding(false)}>Annuler</button><button className="btn btn-primary btn-sm" onClick={()=>{if(!form.name.trim())return;onAdd({id:Date.now().toString(),...form,currency:"$"});setAdding(false);setForm({name:"",type:"Réel",balance:10000});}}>Créer</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
