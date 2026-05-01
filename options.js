'use strict';

const DEFAULT_OPTIONS = {
  enableEarthquake: true,
  enableEew: true,
  minScale: 30,
  autoCloseSeconds: 12,
  notifyScope: 'all',
  enableSound: true,
  regionFilter: '',
  userLocationName: '東京駅',
  userLatitude: 35.681236,
  userLongitude: 139.767125,
  muteUntil: 0
};

const el = {
  enableEarthquake: document.getElementById('enableEarthquake'),
  enableEew: document.getElementById('enableEew'),
  enableSound: document.getElementById('enableSound'),
  minScale: document.getElementById('minScale'),
  notifyScope: document.getElementById('notifyScope'),
  autoCloseSeconds: document.getElementById('autoCloseSeconds'),
  regionFilter: document.getElementById('regionFilter'),
  userLocationName: document.getElementById('userLocationName'),
  userLatitude: document.getElementById('userLatitude'),
  userLongitude: document.getElementById('userLongitude'),
  saveButton: document.getElementById('saveButton'),
  testButton: document.getElementById('testButton'),
  testEewButton: document.getElementById('testEewButton'),
  reconnectButton: document.getElementById('reconnectButton'),
  mute10Button: document.getElementById('mute10Button'),
  mute60Button: document.getElementById('mute60Button'),
  unmuteButton: document.getElementById('unmuteButton'),
  reloadHistoryButton: document.getElementById('reloadHistoryButton'),
  clearHistoryButton: document.getElementById('clearHistoryButton'),
  status: document.getElementById('status'),
  history: document.getElementById('history')
};

load();

el.saveButton.addEventListener('click', save);
el.testButton.addEventListener('click', () => sendMessage('TEST_ALERT'));
el.testEewButton.addEventListener('click', () => sendMessage('TEST_EEW_ALERT'));
el.reconnectButton.addEventListener('click', () => sendMessage('RECONNECT_WS'));
el.mute10Button.addEventListener('click', () => muteMinutes(10));
el.mute60Button.addEventListener('click', () => muteMinutes(60));
el.unmuteButton.addEventListener('click', () => muteUntil(0));
el.reloadHistoryButton.addEventListener('click', loadHistory);
el.clearHistoryButton.addEventListener('click', clearHistory);

async function load() {
  try {
    const options = await chrome.storage.sync.get(DEFAULT_OPTIONS);
    el.enableEarthquake.checked = options.enableEarthquake !== false;
    el.enableEew.checked = options.enableEew !== false;
    el.enableSound.checked = options.enableSound !== false;
    el.minScale.value = Number(options.minScale) === 40 ? '40' : '30';
    el.notifyScope.value = options.notifyScope === 'active' ? 'active' : 'all';
    el.autoCloseSeconds.value = String(clamp(Number(options.autoCloseSeconds), 0, 120, DEFAULT_OPTIONS.autoCloseSeconds));
    el.regionFilter.value = String(options.regionFilter || '');
    el.userLocationName.value = String(options.userLocationName || '東京駅');
    el.userLatitude.value = String(Number(options.userLatitude || DEFAULT_OPTIONS.userLatitude));
    el.userLongitude.value = String(Number(options.userLongitude || DEFAULT_OPTIONS.userLongitude));
    showMuteStatus(options.muteUntil || 0);
    await loadHistory();
  } catch (error) {
    console.error(error);
    status('設定の読み込みに失敗しました。', true);
  }
}

async function save() {
  try {
    const options = readOptions();
    await chrome.storage.sync.set(options);
    status('保存しました。');
  } catch (error) {
    console.error(error);
    status('保存に失敗しました。', true);
  }
}

function readOptions() {
  return {
    enableEarthquake: el.enableEarthquake.checked,
    enableEew: el.enableEew.checked,
    enableSound: el.enableSound.checked,
    minScale: Number(el.minScale.value) === 40 ? 40 : 30,
    notifyScope: el.notifyScope.value === 'active' ? 'active' : 'all',
    autoCloseSeconds: clamp(Number(el.autoCloseSeconds.value), 0, 120, DEFAULT_OPTIONS.autoCloseSeconds),
    regionFilter: el.regionFilter.value.trim(),
    userLocationName: el.userLocationName.value.trim() || '未設定',
    userLatitude: clampFloat(Number(el.userLatitude.value), -90, 90, DEFAULT_OPTIONS.userLatitude),
    userLongitude: clampFloat(Number(el.userLongitude.value), -180, 180, DEFAULT_OPTIONS.userLongitude)
  };
}

async function sendMessage(type) {
  try {
    await save();
    const response = await chrome.runtime.sendMessage({ type });
    status(response?.ok ? '実行しました。通常のWebページで表示を確認してください。' : `失敗しました: ${response?.error || '不明なエラー'}`, !response?.ok);
    await loadHistory();
  } catch (error) {
    console.error(error);
    status(`失敗しました: ${error?.message || error}`, true);
  }
}

async function muteMinutes(minutes) {
  await muteUntil(Date.now() + minutes * 60 * 1000);
}

async function muteUntil(value) {
  try {
    await chrome.storage.sync.set({ muteUntil: value });
    showMuteStatus(value);
  } catch (error) {
    status('ミュート設定に失敗しました。', true);
  }
}

function showMuteStatus(value) {
  if (Number(value) > Date.now()) {
    status(`ミュート中: ${new Date(value).toLocaleString('ja-JP')} まで`);
  } else {
    status('ミュートなし');
  }
}

async function loadHistory() {
  const result = await chrome.storage.local.get({ history: [] });
  const history = Array.isArray(result.history) ? result.history : [];
  if (history.length === 0) {
    el.history.innerHTML = '<div class="history-item">履歴はありません。</div>';
    return;
  }
  el.history.innerHTML = history.map((h) => `
    <div class="history-item">
      <strong>${escapeHtml(h.title || '地震情報')}</strong>
      震度${escapeHtml(h.maxScaleText || '不明')} / ${escapeHtml(h.hypocenter || '不明')} / ${escapeHtml(h.time || '不明')}<br>
      ${escapeHtml(h.magnitude || '不明')} / 深さ ${escapeHtml(h.depth || '不明')} / 津波 ${escapeHtml(h.tsunami || '不明')}
      ${h.distanceKm !== null && h.distanceKm !== undefined ? ` / 約${escapeHtml(h.distanceKm)}km` : ''}
      ${h.impactLabel ? ` / 業務影響 ${escapeHtml(h.impactLabel)}` : ''}
    </div>
  `).join('');
}

async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
  await loadHistory();
  status('履歴を削除しました。');
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampFloat(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function status(message, isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
