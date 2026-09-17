/**
 * docker 主进程：Node 侧运行 core runtime；浏览器仅作播放器（Playwright）
 * 凭证：配置的 portal 客户端密钥（mh_ck_）作为存储 token（服务端 key 认证）
 * 管理端：server.js（:3000 容器内，宿主映射 13000）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClientRuntime } from '../../../packages/core/src/index.ts';
import { DockBrowser } from './browser.ts';
import { createStatusServer } from './server.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BASE = process.env.API_BASE || 'https://163music.linyu.qzz.io';
const VERSION = '5.1.0'; // 修复：'5.1' 不是合法 semver，服务端按 semver 解析会 403 client_upgrade_required

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 配置持久化（cookie/key 由管理端写入） */
const cfg = {
  load() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; } },
  save(c: object) { fs.writeFileSync(SESSION_FILE, JSON.stringify(c)); },
};

const state = {
  startedAt: Date.now(),
  helpUsed: 0, helpLimit: 9000,
  recv: 0, recvLimit: 26,
  job: null as { musicName: string; playedMs: number; targetMs: number } | null,
  hbIntervals: [] as number[],
  lastEvent: '',
  logs: [] as Array<{ level: string; ts: number; msg: string }>,
  // 修复：原版从未给 onConfig 赋值，导致管理端"保存"是空操作（见 server.ts 的 /api/config）
  onConfig: null as null | ((c: { cookie?: string; key?: string; clear?: boolean }) => void),
};

const storage = {
  getToken: () => String(cfg.load().clientKey || ''),
  setToken: (t: string) => { const c = cfg.load(); c.clientKey = t; cfg.save(c); },
  clearToken: () => { const c = cfg.load(); delete c.clientKey; cfg.save(c); },
  getExpires: () => 0,
  setExpires: () => {},
};

async function api<T>(method: string, pathName: string, body?: unknown, token = storage.getToken()): Promise<{ status: number; payload: T | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Client-Type': 'docker', 'X-Music-Helper-Version': VERSION };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + pathName, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = res.status === 200 ? await res.json().catch(() => null) : null;
  return { status: res.status, payload };
}

async function main() {
  const cookie = String(cfg.load().neteaseCookie || '');
  const browser = new DockBrowser(DATA_DIR, cookie);
  await browser.launch();
  console.log('[main] 浏览器已就绪');

  const transport = {
    next: async (token: string) => api('POST', '/api/next', {}, token),
    finish: async (token: string, input: unknown) => api('POST', '/api/play/finish', input, token),
    abandon: async (token: string, reason: string, detail: string) => { await api('POST', '/api/play/abandon', { reason, detail }, token); },
    heartbeat: async (token: string, input: unknown) => (await api('POST', '/api/play/heartbeat', input, token)).status === 200,
    refresh: async () => null, // key 凭证不走 session refresh
    me: () => api('GET', '/api/me'),
    sendLog: async (p: unknown) => { await api('POST', '/api/client/log', p); },
  };

  const player = {
    play: (musicId: string, durationMs: number) => browser.play(musicId, durationMs),
    stop: () => browser.stop(),
    onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => {
      setInterval(async () => {
        try { const p = await browser.progress(); if (p.playedMs > 0) cb(p.playedMs, p.playedMs, p.durationMs); } catch { /* 页面繁忙 */ }
      }, 1000);
    },
  };

  const runtime = new ClientRuntime({ adapter: {
    clientType: 'docker', version: VERSION, storage,
    probeNetwork: async () => true, hasPage: false,
  }, transport, player } as never);

  runtime.bus.on('job:current', (j) => { state.job = j ? { musicName: j.musicName, playedMs: 0, targetMs: j.targetMs } : null; });
  runtime.bus.on('job:progress', (p) => { if (state.job) state.job.playedMs = p.playedMs; });
  runtime.bus.on('heartbeat:tick', (t) => { state.hbIntervals.push(t.intervalMs); if (state.hbIntervals.length > 30) state.hbIntervals.shift(); });
  runtime.bus.on('auth:user', (u) => { if (u) { state.helpLimit = 9000; } });
  runtime.bus.on('log:append', (e) => { state.logs.push({ level: e.level, ts: e.ts, msg: e.msg }); if (state.logs.length > 200) state.logs.shift(); state.lastEvent = e.msg; });

  // 修复：实现管理端的配置保存（持久化到 /data/session.json）
  // - key（clientKey）：每次请求都从磁盘读，保存后立即生效
  // - cookie（neteaseCookie）：在 DockBrowser.launch() 时注入，需重启容器才生效
  state.onConfig = (c) => {
    const cur = cfg.load();
    if (c && c.clear) {
      delete cur.neteaseCookie;
      delete cur.clientKey;
      cfg.save(cur);
      state.lastEvent = '配置已清除（重启容器后完全生效）';
      console.log('[main] 配置已清除');
      return;
    }
    if (typeof c?.cookie === 'string' && c.cookie.trim()) cur.neteaseCookie = c.cookie.trim();
    if (typeof c?.key === 'string' && c.key.trim()) cur.clientKey = c.key.trim();
    cfg.save(cur);
    state.lastEvent = '配置已保存：Key 立即生效，Cookie 需重启容器生效';
    console.log('[main] 配置已保存到', SESSION_FILE);
  };

  createStatusServer({ port: Number(process.env.PORT || 3000), state });
  console.log('[main] 管理端 http://0.0.0.0:3000');
  void runtime.start(true);
}

main().catch((e) => { console.error('[main] fatal', e); process.exit(1); });

