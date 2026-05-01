'use strict';

const WS_URL = 'wss://api.p2pquake.net/v2/ws';

const DEFAULT_OPTIONS = {
  enableEarthquake: true,
  enableEew: true,
  minScale: 30,
  autoCloseSeconds: 12,
  notifyScope: 'all',
  enableSound: true,
  regionFilter: '',
  userLocationName: '未設定',
  userLatitude: 35.681236,
  userLongitude: 139.767125,
  muteUntil: 0
};

const MAX_DEDUPE = 160;
const MAX_HISTORY = 50;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let seenKeys = [];
let seenSet = new Set();
let blinkTimer = null;
let badgeClearTimer = null;

init();

function init() {
  chrome.runtime.onInstalled.addListener(async () => {
    const current = await chrome.storage.sync.get(DEFAULT_OPTIONS);
    await chrome.storage.sync.set({ ...DEFAULT_OPTIONS, ...current });
    setActionState('normal');
    connect();
  });

  chrome.runtime.onStartup.addListener(() => {
    setActionState('normal');
    connect();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'TEST_ALERT') {
      sendTestAlert(false).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'TEST_EEW_ALERT') {
      sendTestAlert(true).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === 'RECONNECT_WS') {
      reconnectNow();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  setActionState('normal');
  connect();
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearReconnect();

  try {
    console.log('[P2PQuake] WebSocket接続開始:', WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectAttempt = 0;
      console.log('[P2PQuake] WebSocket接続完了');
    };

    ws.onmessage = async (event) => {
      try {
        await handleMessage(event.data);
      } catch (error) {
        console.error('[P2PQuake] 受信処理エラー:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[P2PQuake] WebSocketエラー:', error);
      tryClose();
    };

    ws.onclose = (event) => {
      console.warn('[P2PQuake] WebSocket切断:', event.code, event.reason || '');
      ws = null;
      scheduleReconnect();
    };
  } catch (error) {
    console.error('[P2PQuake] WebSocket作成失敗:', error);
    scheduleReconnect();
  }
}

function reconnectNow() {
  tryClose();
  ws = null;
  reconnectAttempt = 0;
  connect();
}

function tryClose() {
  try { ws?.close(); } catch (_) {}
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  clearReconnect();
  reconnectAttempt += 1;
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * Math.pow(2, Math.min(reconnectAttempt, 6)) + Math.floor(Math.random() * 600)
  );
  console.log(`[P2PQuake] ${Math.round(delay / 1000)}秒後に再接続します`);
  reconnectTimer = setTimeout(connect, delay);
}

async function handleMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.warn('[P2PQuake] JSON解析失敗:', error);
    return;
  }

  const code = Number(data?.code);
  if (![551, 554, 556].includes(code)) return;

  const options = await getOptions();
  if (isMuted(options)) return;

  if (code === 551) {
    if (!options.enableEarthquake) return;
    const maxScale = normalizeScale(data?.earthquake?.maxScale);
    if (!Number.isFinite(maxScale)) return;
    if (maxScale < options.minScale) return;
    if (!matchesRegionFilter(data, options.regionFilter)) return;

    await notifyOnce(data, buildEarthquakePayload(data, options));
    return;
  }

  if (code === 554 || code === 556) {
    if (!options.enableEew) return;
    if (!matchesRegionFilter(data, options.regionFilter)) return;
    await notifyOnce(data, buildEewPayload(data, options));
  }
}

async function getOptions() {
  const stored = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  return {
    enableEarthquake: stored.enableEarthquake !== false,
    enableEew: stored.enableEew !== false,
    minScale: Number(stored.minScale) === 40 ? 40 : 30,
    autoCloseSeconds: clamp(Number(stored.autoCloseSeconds), 0, 120, DEFAULT_OPTIONS.autoCloseSeconds),
    notifyScope: stored.notifyScope === 'active' ? 'active' : 'all',
    enableSound: stored.enableSound !== false,
    regionFilter: safe(stored.regionFilter),
    userLocationName: safe(stored.userLocationName, '未設定'),
    userLatitude: clampFloat(Number(stored.userLatitude), -90, 90, DEFAULT_OPTIONS.userLatitude),
    userLongitude: clampFloat(Number(stored.userLongitude), -180, 180, DEFAULT_OPTIONS.userLongitude),
    muteUntil: Number(stored.muteUntil || 0)
  };
}

function isMuted(options) {
  return Number(options.muteUntil || 0) > Date.now();
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampFloat(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function notifyOnce(source, payload) {
  const key = makeDedupeKey(source);
  if (seenSet.has(key)) return;

  seenSet.add(key);
  seenKeys.push(key);
  while (seenKeys.length > MAX_DEDUPE) {
    const old = seenKeys.shift();
    if (old) seenSet.delete(old);
  }

  await addHistory(payload);
  await applyActionAlertState(payload);
  await notifyTabs(payload);
}

function makeDedupeKey(data) {
  if (data?._id) return `id:${data._id}`;
  const code = safe(data?.code);
  const time = safe(data?.earthquake?.time || data?.issue?.time || data?.time);
  const hypocenter = safe(data?.earthquake?.hypocenter?.name || data?.hypocenter?.name);
  const maxScale = safe(data?.earthquake?.maxScale || data?.maxScale);
  return `fallback:${code}:${time}:${hypocenter}:${maxScale}`;
}

function buildEarthquakePayload(data, options) {
  const eq = data?.earthquake || {};
  const hypo = eq?.hypocenter || {};
  const maxScale = normalizeScale(eq?.maxScale);
  const lat = toNumber(hypo?.latitude);
  const lon = toNumber(hypo?.longitude);
  const originTime = eq?.time || data?.issue?.time || data?.time;
  const distanceKm = calcDistanceIfPossible(lat, lon, options.userLatitude, options.userLongitude);
  const arrival = calcArrival(distanceKm, originTime);
  const impact = calcImpact(maxScale, hypo?.magnitude, hypo?.depth, distanceKm);

  return {
    type: 'P2PQUAKE_SHOW_ALERT',
    kind: 'earthquake',
    title: '地震情報',
    code: 551,
    severity: severityFromScale(maxScale),
    maxScale,
    maxScaleText: scaleToText(maxScale),
    time: formatTime(originTime),
    hypocenter: safe(hypo?.name, '不明'),
    magnitude: formatMagnitude(hypo?.magnitude),
    depth: formatDepth(hypo?.depth),
    tsunami: formatTsunami(data),
    distanceKm: distanceKm === null ? null : Math.round(distanceKm),
    userLocationName: options.userLocationName,
    pArrivalTime: arrival.pArrivalTime,
    sArrivalTime: arrival.sArrivalTime,
    sArrivalCountdownSeconds: arrival.sArrivalCountdownSeconds,
    impactLabel: impact.label,
    impactScore: impact.score,
    points: extractPoints(data),
    autoCloseSeconds: options.autoCloseSeconds,
    enableSound: options.enableSound,
    receivedAt: new Date().toISOString()
  };
}

function buildEewPayload(data, options) {
  const eq = data?.earthquake || data?.eew || {};
  const hypo = eq?.hypocenter || data?.hypocenter || {};
  const maxScale = normalizeScale(eq?.maxScale || data?.maxScale);
  const lat = toNumber(hypo?.latitude);
  const lon = toNumber(hypo?.longitude);
  const originTime = eq?.time || data?.issue?.time || data?.time;
  const distanceKm = calcDistanceIfPossible(lat, lon, options.userLatitude, options.userLongitude);
  const arrival = calcArrival(distanceKm, originTime);
  const impact = calcImpact(maxScale, hypo?.magnitude || eq?.magnitude, hypo?.depth || eq?.depth, distanceKm);

  return {
    type: 'P2PQUAKE_SHOW_ALERT',
    kind: 'eew',
    title: Number(data?.code) === 556 ? '緊急地震速報（警報）' : '緊急地震速報',
    code: Number(data?.code),
    severity: 'eew',
    maxScale,
    maxScaleText: scaleToText(maxScale),
    time: formatTime(originTime),
    hypocenter: safe(hypo?.name || data?.region, '不明'),
    magnitude: formatMagnitude(hypo?.magnitude || eq?.magnitude),
    depth: formatDepth(hypo?.depth || eq?.depth),
    tsunami: formatTsunami(data),
    distanceKm: distanceKm === null ? null : Math.round(distanceKm),
    userLocationName: options.userLocationName,
    pArrivalTime: arrival.pArrivalTime,
    sArrivalTime: arrival.sArrivalTime,
    sArrivalCountdownSeconds: arrival.sArrivalCountdownSeconds,
    impactLabel: impact.label,
    impactScore: impact.score,
    points: extractPoints(data),
    autoCloseSeconds: Math.max(options.autoCloseSeconds, 20),
    enableSound: options.enableSound,
    receivedAt: new Date().toISOString()
  };
}

async function notifyTabs(payload) {
  const options = await getOptions();
  let tabs = [];
  try {
    if (options.notifyScope === 'active') {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } else {
      tabs = await chrome.tabs.query({});
    }
  } catch (error) {
    console.error('[P2PQuake] タブ取得失敗:', error);
    return;
  }

  await Promise.allSettled(
    tabs
      .filter((tab) => tab?.id && /^https?:\/\//i.test(tab.url || ''))
      .map((tab) => chrome.tabs.sendMessage(tab.id, payload).catch(() => null))
  );
}

async function sendTestAlert(isEew) {
  const options = await getOptions();
  const now = new Date();
  const origin = new Date(now.getTime() - 15000).toISOString();
  const dummy = {
    type: 'P2PQUAKE_SHOW_ALERT',
    kind: isEew ? 'eew' : 'earthquake',
    title: isEew ? '緊急地震速報（テスト）' : '地震情報（テスト）',
    code: isEew ? 556 : 551,
    severity: isEew ? 'eew' : 'warning',
    maxScale: isEew ? 50 : 40,
    maxScaleText: isEew ? '5強' : '4',
    time: formatTime(origin),
    hypocenter: 'テスト震源地',
    magnitude: 'M6.1',
    depth: '30km',
    tsunami: 'なし',
    distanceKm: 120,
    userLocationName: options.userLocationName,
    pArrivalTime: new Date(Date.now() + 5000).toISOString(),
    sArrivalTime: new Date(Date.now() + (isEew ? 25000 : 12000)).toISOString(),
    sArrivalCountdownSeconds: isEew ? 25 : 12,
    impactLabel: isEew ? '高' : '中',
    impactScore: isEew ? 14.8 : 9.4,
    points: [
      { name: 'テスト市', scaleText: isEew ? '5弱' : '4' },
      { name: 'サンプル区', scaleText: '4' },
      { name: 'デモ町', scaleText: '3' }
    ],
    autoCloseSeconds: isEew ? Math.max(options.autoCloseSeconds, 20) : options.autoCloseSeconds,
    enableSound: options.enableSound,
    receivedAt: new Date().toISOString()
  };
  await addHistory(dummy);
  await applyActionAlertState(dummy);
  await notifyTabs(dummy);
}

async function applyActionAlertState(payload) {
  if (payload.kind === 'eew') {
    setBadge('警', '#dc2626');
    startBlink();
    scheduleActionReset(30000);
    return;
  }

  setActionState('quake');
  setBadge('震', '#f97316');
  scheduleActionReset(15000);
}

function scheduleActionReset(ms) {
  if (badgeClearTimer) clearTimeout(badgeClearTimer);
  badgeClearTimer = setTimeout(() => {
    stopBlink();
    clearBadge();
    setActionState('normal');
  }, ms);
}

function iconPaths(state) {
  return {
    16: `icons/icon-${state}-16.png`,
    48: `icons/icon-${state}-48.png`,
    128: `icons/icon-${state}-128.png`
  };
}

function setActionState(state) {
  try {
    chrome.action.setIcon({ path: iconPaths(state) });
  } catch (error) {
    console.warn('[P2PQuake] アイコン設定失敗:', error);
  }
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (error) {
    console.warn('[P2PQuake] バッジ設定失敗:', error);
  }
}

function clearBadge() {
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch (_) {}
}

function startBlink() {
  stopBlink();
  let on = false;
  blinkTimer = setInterval(() => {
    on = !on;
    setActionState(on ? 'eew' : 'blank');
  }, 500);
}

function stopBlink() {
  if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
}

async function addHistory(payload) {
  try {
    const current = await chrome.storage.local.get({ history: [] });
    const item = {
      title: payload.title,
      kind: payload.kind,
      maxScaleText: payload.maxScaleText,
      time: payload.time,
      hypocenter: payload.hypocenter,
      magnitude: payload.magnitude,
      depth: payload.depth,
      tsunami: payload.tsunami,
      distanceKm: payload.distanceKm,
      impactLabel: payload.impactLabel,
      receivedAt: payload.receivedAt
    };
    const history = [item, ...(Array.isArray(current.history) ? current.history : [])].slice(0, MAX_HISTORY);
    await chrome.storage.local.set({ history });
  } catch (error) {
    console.warn('[P2PQuake] 履歴保存失敗:', error);
  }
}

function normalizeScale(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scaleToText(scale) {
  const n = normalizeScale(scale);
  if (n === null || n < 0) return '不明';
  if (n >= 70) return '7';
  if (n >= 60) return '6強';
  if (n >= 55) return '6弱';
  if (n >= 50) return '5強';
  if (n >= 45) return '5弱';
  if (n >= 40) return '4';
  if (n >= 30) return '3';
  if (n >= 20) return '2';
  if (n >= 10) return '1';
  return '不明';
}

function severityFromScale(scale) {
  const n = normalizeScale(scale);
  if (n >= 45) return 'danger';
  if (n >= 40) return 'warning';
  return 'notice';
}

function formatTime(value) {
  if (!value) return '不明';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safe(value, '不明');
  return date.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function formatMagnitude(value) {
  if (value === null || value === undefined || value === -1) return '不明';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '不明';
  return `M${n.toFixed(1)}`;
}

function formatDepth(value) {
  if (value === null || value === undefined || value === -1) return '不明';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '不明';
  if (n === 0) return 'ごく浅い';
  return `${n}km`;
}

function formatTsunami(data) {
  const value = safe(data?.earthquake?.domesticTsunami || data?.earthquake?.tsunami || data?.tsunami);
  if (!value) return '不明';
  const map = {
    None: 'なし',
    Unknown: '不明',
    Checking: '調査中',
    NonEffective: '若干の海面変動',
    Watch: '津波注意報',
    Warning: '津波警報'
  };
  return map[value] || value;
}

function extractPoints(data) {
  const points = data?.points || data?.earthquake?.points || data?.areas || [];
  if (!Array.isArray(points)) return [];
  return points.slice(0, 6).map((p) => ({
    name: safe(p?.addr || p?.name || p?.pref || p?.region || p?.area, '不明'),
    scaleText: scaleToText(p?.scale || p?.maxScale)
  })).filter((p) => p.name !== '不明' || p.scaleText !== '不明');
}

function matchesRegionFilter(data, filter) {
  const f = safe(filter);
  if (!f) return true;
  const keywords = f.split(',').map((x) => x.trim()).filter(Boolean);
  if (keywords.length === 0) return true;
  const text = JSON.stringify({
    hypocenter: data?.earthquake?.hypocenter?.name || data?.hypocenter?.name || '',
    points: data?.points || data?.earthquake?.points || data?.areas || []
  });
  return keywords.some((k) => text.includes(k));
}

function calcDistanceIfPossible(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const r = 6371;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcArrival(distanceKm, originTimeValue) {
  if (!Number.isFinite(distanceKm) || !originTimeValue) {
    return { pArrivalTime: null, sArrivalTime: null, sArrivalCountdownSeconds: null };
  }
  const origin = new Date(originTimeValue);
  if (Number.isNaN(origin.getTime())) {
    return { pArrivalTime: null, sArrivalTime: null, sArrivalCountdownSeconds: null };
  }
  const pMs = (distanceKm / 6.0) * 1000;
  const sMs = (distanceKm / 3.5) * 1000;
  const p = new Date(origin.getTime() + pMs);
  const s = new Date(origin.getTime() + sMs);
  return {
    pArrivalTime: p.toISOString(),
    sArrivalTime: s.toISOString(),
    sArrivalCountdownSeconds: Math.round((s.getTime() - Date.now()) / 1000)
  };
}

function calcImpact(scale, mag, depth, distanceKm) {
  const s = normalizeScale(scale);
  const displayScale = s === null ? 0 : (s >= 45 ? 5 : s / 10);
  const m = Number(mag);
  const d = Number(depth);
  const dist = Number(distanceKm);
  const score = Number((
    displayScale * 2.2 +
    (Number.isFinite(m) ? m * 1.2 : 0) -
    (Number.isFinite(d) ? d / 80 : 0) -
    (Number.isFinite(dist) ? dist / 180 : 0)
  ).toFixed(1));
  const label = score >= 13 ? '高' : score >= 8 ? '中' : '低';
  return { score, label };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safe(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}
