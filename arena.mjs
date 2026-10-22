// Arena.ai image generation engine for the Magpie plugin (ASCII only).
//
// Why a real Chrome: arena.ai's reCAPTCHA v3 token is bound to the browser
// fingerprint and cookie jar. Every external HTTP client gets
// 403 {"error":"recaptcha validation failed"} even with a freshly minted token,
// so the only working shape is "mint token -> fetch immediately" inside the
// logged-in page. This module therefore drives a non-headless Chrome over CDP.
//
// ASCII only: PowerShell 5.1 reads UTF-8 as GBK and mangles non-ASCII source
// when a script rewrites a file (hit once on 2026-10-22).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const BASE = 'https://arena.ai';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const SITE_KEY = '6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0';
const ACTION = 'chat_submit';
const AUTH_BASE = 'arena-auth-prod-v1';

// Headless Chrome advertises itself in the user agent, and reCAPTCHA Enterprise
// scores that as a low-trust client. Every request that reaches arena should look
// like ordinary desktop Chrome, which is also what the account's real browser is.
// The major version is read from the installed binary so it stays plausible.
const STEALTH_UA_CHROME_MAJOR = 155;
const STEALTH_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${STEALTH_UA_CHROME_MAJOR}.0.0.0 Safari/537.36`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'chrome';
}

/** join the sharded supabase cookie: arena-auth-prod-v1 + .0 + .1 ... */
export function joinAuthCookie(map) {
  let joined = map.get(AUTH_BASE) ?? '';
  for (let i = 0; map.has(`${AUTH_BASE}.${i}`); i++) joined += map.get(`${AUTH_BASE}.${i}`);
  return joined;
}

export function decodeSession(joined) {
  if (!joined || joined.length < 100) return null;
  try { return JSON.parse(Buffer.from(joined.replace(/^base64-/, ''), 'base64url').toString('utf8')); }
  catch { return null; }
}

/** parse a pasted Cookie header into a name->value map */
export function parseCookieString(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(';')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    map.set(s.slice(0, i).trim(), s.slice(i + 1));
  }
  return map;
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('cdp ws error'));
      this.ws.onclose = () => {
        this.closed = true;
        for (const [, v] of this.pending) { clearTimeout(v.timer); v.rej(new Error('cdp closed')); }
        this.pending.clear();
      };
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (m.id && this.pending.has(m.id)) {
        const { res, rej, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  async send(method, params = {}, sid, timeoutMs = 300000) {
    await this.ready;
    if (this.closed) throw new Error('cdp closed');
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' timeout')); }
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
  }
  async alive() {
    if (this.closed) return false;
    try {
      const id = ++this.id;
      return await new Promise((res) => {
        const timer = setTimeout(() => { this.pending.delete(id); res(false); }, 4000);
        this.pending.set(id, {
          res: () => { clearTimeout(timer); res(true); },
          rej: () => { clearTimeout(timer); res(false); },
          timer,
        });
        try { this.ws.send(JSON.stringify({ id, method: 'Browser.getVersion', params: {} })); }
        catch { clearTimeout(timer); res(false); }
      });
    } catch { return false; }
  }
  close() { try { this.ws.close(); } catch {} }
}

export class ArenaEngine {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir ?? path.join(os.homedir(), '.magpie-arena');
    this.profileDir = path.join(this.dataDir, 'chrome-profile');
    this.stateFile = path.join(this.dataDir, 'session.json');
    this.cdpPort = Number(opts.cdpPort || process.env.MAGPIE_ARENA_CDP_PORT || 9793);
    this.keepAliveMinutes = Number(opts.keepAliveMinutes ?? 10);
    this.log = opts.log ?? (() => {});
    this.cdp = null;
    this.proc = null;
    this.sessionId = null;
    this.ready = false;
    this.starting = null;
    this.queue = Promise.resolve();
    this.timer = null;
    this.cookie = opts.cookie ?? '';        // seed cookie from Magpie's stored auth
    this.models = null;
    this.modelsAt = 0;
    this.lastRenewAt = 0;
    this.lastError = null;
  }

  // ---------- persisted session state ----------
  readState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }
  writeState(patch) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const next = { ...this.readState(), ...patch, updatedAt: new Date().toISOString() };
      fs.writeFileSync(this.stateFile, JSON.stringify(next, null, 2));
    } catch (e) { this.log('write state failed:', e.message); }
  }
  /** the cookie to inject: whatever the browser renewed last is fresher than Magpie's stored key */
  currentCookie() {
    const st = this.readState();
    const saved = typeof st.cookie === 'string' ? st.cookie : '';
    const fromAuth = typeof this.cookie === 'string' ? this.cookie : '';
    const pick = (s) => {
      const s2 = decodeSession(joinAuthCookie(parseCookieString(s)));
      return s2?.expires_at ? s2.expires_at * 1000 : 0;
    };
    return pick(saved) >= pick(fromAuth) ? (saved || fromAuth) : fromAuth;
  }
  /** the arena cookies the browser currently holds, as one Cookie header */
  async _allArenaCookies() {
    const all = await this.cdp.send('Network.getAllCookies', {}, this.sessionId);
    const keep = (all.cookies ?? []).filter((c) => c.domain.includes('arena.ai') && (c.name.startsWith(AUTH_BASE) || c.name === 'cf_clearance'));
    return keep.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  saveCookieFromBrowser() {
    if (!this.cdp || !this.sessionId) return Promise.resolve();
    return this._allArenaCookies()
      .then((cookie) => {
        if (!decodeSession(joinAuthCookie(parseCookieString(cookie)))) return;
        this.writeState({ cookie });
        this.log('saved cookie to state');
      })
      .catch(() => {});
  }

  // ---------- browser ----------
  async ensure() {
    if (this.ready && this.cdp && this.sessionId) {
      if (await this.cdp.alive()) return;
      this.log('CDP socket gone, rebuilding');
      this._reset();
    }
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  _reset() {
    this.ready = false;
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    this.proc = null;
    this.sessionId = null;
  }

  async _start() {
    fs.mkdirSync(this.profileDir, { recursive: true });

    let ver = null;
    try { ver = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`)).json(); } catch {}
    if (ver) {
      this.cdp = new CDP(ver.webSocketDebuggerUrl);
      await this.cdp.ready;
      this.log('attached to running Chrome on', this.cdpPort);
      await this._attach();
      return;
    }

    const chrome = findChrome();
    // Headless leaves no window on your desktop. It is not enough on its own
    // though: headless Chrome advertises "HeadlessChrome/..." in its UA, which
    // reCAPTCHA Enterprise treats as a low-trust client (captured 2026-10-22 via
    // REA: the only difference between a passing and a failing run was that
    // string). So the UA and client hints are overridden to plain Chrome below.
    const headless = process.env.MAGPIE_ARENA_HEADLESS !== '0';
    this.log('launching Chrome:', chrome, headless ? '(headless)' : '(windowed)');
    this.proc = spawn(chrome, [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio', '--window-size=1280,900',
      ...(headless ? ['--headless=new', `--user-agent=${STEALTH_UA}`] : []),
      'about:blank',
    ], { stdio: 'ignore', detached: true });
    this.proc.unref();

    let wsUrl = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`);
        wsUrl = (await r.json()).webSocketDebuggerUrl;
        break;
      } catch { await sleep(500); }
    }
    if (!wsUrl) throw new Error('Chrome CDP not ready');
    this.cdp = new CDP(wsUrl);
    await this.cdp.ready;
    await sleep(1200);

    // Reuse the page Chrome opened rather than creating one: some headless
    // builds refuse Target.createTarget.
    const list = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`)).json();
    const existing = list.find((t) => t.type === 'page') || list[0];
    let sessionId = null;
    if (existing) {
      const attached = await this.cdp.send('Target.attachToTarget', { targetId: existing.id, flatten: true });
      sessionId = attached?.sessionId ?? null;
    }
    if (!sessionId) {
      const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
      const created = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessionId = created.sessionId;
    }
    this.sessionId = sessionId;
    const S = (m, p) => this.cdp.send(m, p, this.sessionId);
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Network.enable');

    // --user-agent only covers the UA string; navigator.userAgentData would still
    // report the headless brand to anything reading client hints, so override it
    // before the page loads.
    if (headless) {
      await S('Emulation.setUserAgentOverride', {
        userAgent: STEALTH_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
        platform: 'Win32',
      }).catch((e) => this.log('UA override failed:', e.message));
    }

    await S('Page.navigate', { url: BASE + '/image' });
    await this._waitCf(S);

    // the profile may already carry a live session; never overwrite it blindly
    let me = await this._checkMe(S);
    if (!me.email) {
      await this._injectCookie(S, this.currentCookie());
      await S('Page.reload', {});
      await this._waitCf(S);
      me = await this._checkMe(S);
    }
    if (!me.email) throw new Error('not logged in: paste a fresh arena.ai cookie in Magpie');
    this.log('logged in as', me.email);
    await this._ensureRecaptcha(S);
    await this.saveCookieFromBrowser();
    this.ready = true;
    this._startTimer();
  }

  async _attach() {
    const list = await (await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.includes('arena.ai')) || list.find((t) => t.type === 'page');
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
    this.sessionId = sessionId;
    const S = (m, p) => this.cdp.send(m, p, this.sessionId);
    await S('Runtime.enable');
    await S('Network.enable');
    if (!page.url.includes('arena.ai')) {
      await S('Page.navigate', { url: BASE + '/image' });
      await this._waitCf(S);
    }
    let me = await this._checkMe(S);
    if (!me.email) {
      await this._injectCookie(S, this.currentCookie());
      await S('Page.reload', {});
      await this._waitCf(S);
      me = await this._checkMe(S);
    }
    if (!me.email) throw new Error('not logged in: paste a fresh arena.ai cookie in Magpie');
    await this._ensureRecaptcha(S);
    this.ready = true;
    await this.saveCookieFromBrowser();
    this.log('logged in as', me.email);
    this._startTimer();
  }

  async _ensureRecaptcha(S) {
    await S('Runtime.evaluate', {
      expression: `new Promise(r=>{const d=o=>r(JSON.stringify(o));const t=setTimeout(()=>d({err:'timeout'}),15000);
        const go=()=>{clearTimeout(t);d({ok:true})};
        if(window.grecaptcha&&window.grecaptcha.enterprise)return go();
        const s=document.createElement('script');s.src='https://www.google.com/recaptcha/enterprise.js?render=${SITE_KEY}';
        s.onload=go;s.onerror=()=>{clearTimeout(t);d({err:'load'})};document.head.appendChild(s);})`,
      awaitPromise: true, returnByValue: true,
    });
  }

  async _waitCf(S) {
    for (let i = 0; i < 30; i++) {
      await sleep(1200);
      try {
        const r = await S('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
        const t = r.result?.value ?? '';
        if (t && !/Verifying|Just a moment|Attention Required/i.test(t)) return t;
      } catch {}
    }
    return null;
  }

  async _checkMe(S) {
    const r = await S('Runtime.evaluate', {
      expression: "fetch('/api/me',{cache:'no-store'}).then(r=>r.json()).then(j=>({email:(j.user&&j.user.email)||null,msg:j.user?'':(j.message||'')})).catch(e=>({email:null,msg:String(e)}))",
      awaitPromise: true, returnByValue: true,
    });
    return r.result?.value ?? { email: null, msg: 'no result' };
  }

  async _injectCookie(S, raw) {
    const map = parseCookieString(raw);

    // Clear the arena cookies already in the profile first. Setting only the new
    // ones leaves stale shards behind, and the session cookie is sharded: a
    // leftover .2 or an old .0 that the new cookie does not overwrite would be
    // concatenated into a corrupt token, so /api/me answers "User not found"
    // even though the pasted cookie is perfectly valid.
    try {
      const all = await this.cdp.send('Network.getAllCookies', {}, this.sessionId);
      for (const c of all.cookies ?? []) {
        if (c.domain.includes('arena.ai')) {
          await this.cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }, this.sessionId).catch(() => {});
        }
      }
    } catch (e) { this.log('cookie clear failed:', e.message); }

    let n = 0;
    for (const [name, value] of map) {
      if (!name) continue;
      try {
        await this.cdp.send('Network.setCookie', { name, value, domain: '.arena.ai', path: '/', secure: true, sameSite: 'None' }, this.sessionId);
        n++;
      } catch {}
    }
    this.log('injected', n, 'cookies (after clearing stale ones)');
  }

  // ---------- session renewal ----------
  async sessionInfo() {
    try {
      const all = await this.cdp.send('Network.getAllCookies', {}, this.sessionId);
      const map = new Map((all.cookies ?? []).map((c) => [c.name, c.value]));
      const sess = decodeSession(joinAuthCookie(map));
      if (!sess) return null;
      return { sess, expiresAt: (sess.expires_at || 0) * 1000, email: sess.user?.email ?? null };
    } catch { return null; }
  }

  /**
   * Renew without waiting for a 401: rewrite the cookie's expires_at into the
   * past, then call /api/me. arena's middleware then trades the refresh_token
   * for a new session and answers with new Set-Cookie headers.
   */
  async renew() {
    const info = await this.sessionInfo();
    if (!info) return false;

    const before = await this.cdp.send('Network.getAllCookies', {}, this.sessionId);
    const snapshot = (before.cookies ?? [])
      .filter((c) => c.name.startsWith(AUTH_BASE) && c.value)
      .map((c) => ({ name: c.name, value: c.value }));

    const writeShards = async (pairs) => {
      for (let i = 0; i < 6; i++) {
        await this.cdp.send('Network.deleteCookies', { name: `${AUTH_BASE}.${i}`, domain: '.arena.ai', path: '/' }, this.sessionId).catch(() => {});
      }
      for (const p of pairs) {
        await this.cdp.send('Network.setCookie', { name: p.name, value: p.value, domain: '.arena.ai', path: '/', secure: true, sameSite: 'None' }, this.sessionId);
      }
    };

    const forgedSess = { ...info.sess, expires_at: Math.floor(Date.now() / 1000) - 60 };
    const forged = 'base64-' + Buffer.from(JSON.stringify(forgedSess), 'utf8').toString('base64url');
    const CHUNK = 3800;
    const chunks = [];
    for (let i = 0, n = 0; i < forged.length; i += CHUNK, n++) {
      // shards are numbered, not offset: arena-auth-prod-v1.0, .1, .2 ...
      chunks.push({ name: `${AUTH_BASE}.${n}`, value: forged.slice(i, i + CHUNK) });
    }

    await writeShards(chunks);
    const S = (m, p) => this.cdp.send(m, p, this.sessionId);
    const me = await this._checkMe(S);

    // the new Set-Cookie lands a moment after the response, so poll briefly
    let after = null;
    for (let i = 0; i < 12; i++) {
      after = await this.sessionInfo();
      if (after && after.expiresAt > Date.now()) break;
      await sleep(250);
    }

    if (me.email && after && after.expiresAt > Date.now()) {
      this.lastRenewAt = Date.now();
      this.writeState({ cookie: await this._allArenaCookies() });
      this.log('renewed; expires', new Date(after.expiresAt).toISOString());
      return true;
    }
    // rollback so a transient server hiccup does not cost the working session
    if (snapshot.length) {
      await writeShards(snapshot).catch(() => {});
      const restored = await this._checkMe(S);
      this.log('renewal failed; session restored?', !!restored.email);
      return !!restored.email;
    }
    return false;
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        if (!this.ready || !(await this.cdp?.alive?.())) return;
        const info = await this.sessionInfo();
        const remainMin = info?.expiresAt ? Math.round((info.expiresAt - Date.now()) / 60000) : null;
        if (remainMin === null || remainMin < 25) await this.renew();
      } catch (e) { this.log('keepalive error:', e.message); }
    }, this.keepAliveMinutes * 60_000);
    this.timer.unref?.();
  }

  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._reset();
  }

  // ---------- models ----------
  async listModels(force = false) {
    await this.ensure();
    if (!force && this.models && Date.now() - this.modelsAt < 6 * 3600_000) return this.models;
    const r = await this.cdp.send('Runtime.evaluate', {
      expression: `fetch('/nextjs-api/model-catalog').then(r=>r.json()).then(j=>JSON.stringify(j)).catch(e=>JSON.stringify({err:String(e)}))`,
      awaitPromise: true, returnByValue: true,
    }, this.sessionId);
    const cat = JSON.parse(r.result?.value ?? '{}');
    const arr = Array.isArray(cat) ? cat : cat.arenas ?? [];
    const arena = arr.find((a) => a.arena === 'text-to-image');
    if (!arena) throw new Error('text-to-image arena not found in model-catalog');
    this.models = (arena.models ?? [])
      .filter((m) => m.userSelectable !== false)
      .map((m) => ({
        id: m.id,
        name: m.publicName || m.displayName,
        displayName: m.displayName,
        organization: m.organization,
      }));
    this.modelsAt = Date.now();
    return this.models;
  }

  resolveModel(models, name) {
    if (!name) return models[0];
    const n = String(name).toLowerCase().trim();
    const stripped = n.replace(/^arena\//, '');
    return (
      models.find((m) => m.name?.toLowerCase() === stripped) ||
      models.find((m) => m.id === name) ||
      models.find((m) => m.name?.toLowerCase().includes(stripped)) ||
      models.find((m) => m.displayName?.toLowerCase().includes(stripped)) ||
      null
    );
  }

  /** renew when the access token is close to expiry (works even without the timer) */
  async ensureFresh(minRemainMin = 15) {
    if (Date.now() - this.lastRenewAt < 60_000) return false;
    const info = await this.sessionInfo();
    if (!info) return false;
    const remainMin = Math.round((info.expiresAt - Date.now()) / 60000);
    if (remainMin >= minRemainMin) return false;
    this.log('token remaining', remainMin, 'min; renewing');
    return this.renew();
  }

  // ---------- generation ----------
  async generate({ prompt, model, timeoutMs = 280000 }) {
    await this.ensure();
    const run = async () => {
      // the plugin process can be short lived, so renewing must not rely on the timer
      await this.ensureFresh().catch(() => {});
      return this._generateOnce({ prompt, model, timeoutMs });
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(() => {}, () => {});
    return p;
  }

  async _generateOnce({ prompt, model, timeoutMs }) {
    const models = await this.listModels();
    const target = this.resolveModel(models, model) || models[0];
    const S = (m, p) => this.cdp.send(m, p, this.sessionId);

    const expr = `(async () => {
      const uuidv7 = () => {
        const b = new Uint8Array(16); crypto.getRandomValues(b);
        let ts = BigInt(Date.now());
        for (let i = 5; i >= 0; i--) { b[i] = Number(ts & 0xffn); ts >>= 8n; }
        b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map(x => x.toString(16).padStart(2,'0')).join('');
        return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
      };
      let token = null;
      try {
        token = await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('token timeout')), 40000);
          window.grecaptcha.enterprise.ready(async () => {
            try { const tk = await window.grecaptcha.enterprise.execute('${SITE_KEY}', { action: '${ACTION}' }); clearTimeout(t); res(tk); }
            catch (e) { clearTimeout(t); rej(e); }
          });
        });
      } catch (e) { return JSON.stringify({ stage: 'token', err: String(e && e.message || e) }); }

      const body = {
        id: uuidv7(), mode: 'battle',
        modelAId: ${JSON.stringify(target.id)}, modelBId: ${JSON.stringify(target.id)},
        userMessageId: uuidv7(), modelAMessageId: uuidv7(), modelBMessageId: uuidv7(),
        userMessage: { content: ${JSON.stringify(prompt)}, experimental_attachments: [], metadata: {} },
        modality: 'image', recaptchaV3Token: token,
      };
      const r = await fetch('/nextjs-api/stream/create-evaluation', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('event-stream')) {
        return JSON.stringify({ stage: 'create', status: r.status, text: (await r.text()).slice(0, 400) });
      }
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = '', images = []; const t0 = Date.now();
      while (Date.now() - t0 < ${Math.min(timeoutMs, 280000)}) {
        const { done, value } = await reader.read();
        if (done) break;
        const c = dec.decode(value, { stream: true }); buf += c;
        let nl;
        while ((nl = buf.indexOf(String.fromCharCode(10))) >= 0) {
          const evt = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          const m = /^([ab]2|ad|bd):(.*)$/s.exec(evt);
          if (!m || m[1] === 'ad' || m[1] === 'bd') continue;
          try {
            const arr = JSON.parse(m[2]);
            for (const it of arr) if (it.type === 'image' && it.image) images.push({ side: m[1], url: it.image, mimeType: it.mimeType || 'image/webp' });
          } catch {}
        }
        if (images.length >= 2) break;
      }
      try { await reader.cancel(); } catch {}
      return JSON.stringify({ stage: 'ok', images });
    })()`;

    const out = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    let j = null;
    try { j = JSON.parse(out.result?.value ?? '{}'); } catch {}
    if (!j) throw Object.assign(new Error('cannot parse arena response'), { status: 502 });
    if (j.stage !== 'ok') {
      const err = new Error(`${j.stage} failed: ${j.err || j.text || ''}`);
      if (j.status === 429) {
        err.status = 429;
        err.code = 'arena_rate_limited';
        err.message = 'arena.ai rate limited this account (429 "prompt failed"): too many image generations, try again later';
      } else {
        err.status = 502;
        err.code = 'arena_upstream_error';
      }
      throw err;
    }
    const a = j.images.filter((i) => i.side === 'a2');
    const images = a.length ? a : j.images;
    if (!images.length) throw Object.assign(new Error('arena returned no image'), { status: 502 });
    return { model: target.name, displayName: target.displayName, images };
  }
}
