'use strict';

const HOST_ID = 'p2pquake-alert-host';
const OVERLAY_ID = 'p2pquake-alert-overlay';

let shadow = null;
let closeTimer = null;
let countdownTimer = null;

chrome.runtime.onMessage.addListener((message) => {
  try {
    if (message?.type === 'P2PQUAKE_SHOW_ALERT') showOverlay(message);
  } catch (error) {
    console.error('[P2PQuake] content error:', error);
  }
});

function showOverlay(data) {
  const root = ensureShadowRoot();
  clearOverlay();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'pq-overlay';

  const severity = safeClass(data?.severity);
  const title = escapeHtml(data?.title || '地震情報');
  const kind = data?.kind === 'eew' ? '緊急地震速報' : 'P2P地震情報';
  const countdown = buildCountdownText(data);

  overlay.innerHTML = `
    <section class="pq-card ${severity}" role="alertdialog" aria-label="${title}">
      <header class="pq-header">
        <div>
          <div class="pq-kind">${escapeHtml(kind)}</div>
          <h1 class="pq-title">${title}</h1>
        </div>
        <button class="pq-close" type="button" aria-label="閉じる">×</button>
      </header>

      <main class="pq-body">
        <div class="pq-scale">
          <span class="pq-scale-label">最大震度</span>
          <span class="pq-scale-value">${escapeHtml(data?.maxScaleText || '不明')}</span>
        </div>

        <div class="pq-countdown ${data?.kind === 'eew' ? 'is-eew' : ''}">
          <span class="pq-countdown-label">${data?.kind === 'eew' ? '主要動到達予測' : '到達予測'}</span>
          <span class="pq-countdown-value" id="pq-countdown-value">${escapeHtml(countdown)}</span>
        </div>

        <dl class="pq-grid">
          <dt>発生時刻</dt><dd>${escapeHtml(data?.time || '不明')}</dd>
          <dt>震源地</dt><dd>${escapeHtml(data?.hypocenter || '不明')}</dd>
          <dt>規模</dt><dd>${escapeHtml(data?.magnitude || '不明')}</dd>
          <dt>深さ</dt><dd>${escapeHtml(data?.depth || '不明')}</dd>
          <dt>津波情報</dt><dd>${escapeHtml(data?.tsunami || '不明')}</dd>
          <dt>対象地点</dt><dd>${escapeHtml(data?.userLocationName || '未設定')}</dd>
          <dt>震源距離</dt><dd>${escapeHtml(data?.distanceKm === null || data?.distanceKm === undefined ? '不明' : `約${data.distanceKm}km`)}</dd>
          <dt>業務影響</dt><dd>${escapeHtml(data?.impactLabel || '不明')} ${data?.impactScore !== undefined ? `（${escapeHtml(data.impactScore)}）` : ''}</dd>
        </dl>

        ${buildPointsHtml(data?.points)}
      </main>

      <footer class="pq-footer">P2P地震情報 WebSocket 受信 / 防災判断は公式情報を優先してください。</footer>
    </section>
  `;

  root.appendChild(overlay);
  overlay.querySelector('.pq-close')?.addEventListener('click', clearOverlay);
  startCountdown(data);
  if (data?.enableSound) playAlertSound(data?.kind);

  const seconds = normalizeSeconds(data?.autoCloseSeconds);
  if (seconds > 0) closeTimer = setTimeout(clearOverlay, seconds * 1000);
}

function ensureShadowRoot() {
  if (shadow) return shadow;

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
  }

  shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  injectStyle(shadow);
  return shadow;
}

function injectStyle(root) {
  if (root.getElementById('pq-style')) return;
  const style = document.createElement('style');
  style.id = 'pq-style';
  style.textContent = `
    :host { all: initial; }

    .pq-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 24px 16px;
      pointer-events: none;
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic", Meiryo, sans-serif;
    }

    .pq-card {
      width: min(760px, calc(100vw - 32px));
      overflow: hidden;
      color: #fff;
      background: rgba(15, 23, 42, 0.98);
      border: 3px solid #facc15;
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(0,0,0,.62);
      pointer-events: auto;
      animation: pq-in 160ms ease-out;
    }

    .pq-card.notice { border-color: #facc15; }
    .pq-card.warning { border-color: #fb923c; }
    .pq-card.danger, .pq-card.eew { border-color: #ef4444; box-shadow: 0 24px 90px rgba(127,29,29,.74); }

    .pq-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 20px;
      background: linear-gradient(135deg, #111827, #020617);
      border-bottom: 1px solid rgba(255,255,255,.16);
    }

    .pq-card.notice .pq-header { background: linear-gradient(135deg, #713f12, #111827); }
    .pq-card.warning .pq-header { background: linear-gradient(135deg, #9a3412, #111827); }
    .pq-card.danger .pq-header, .pq-card.eew .pq-header { background: linear-gradient(135deg, #991b1b, #450a0a); }

    .pq-kind { margin-bottom: 4px; font-size: 13px; font-weight: 800; letter-spacing: .08em; opacity: .9; }
    .pq-title { margin: 0; font-size: 26px; line-height: 1.25; font-weight: 900; }

    .pq-close {
      width: 38px; height: 38px; flex: 0 0 auto;
      border: 1px solid rgba(255,255,255,.55);
      border-radius: 999px;
      color: #fff;
      background: rgba(255,255,255,.12);
      font-size: 24px;
      line-height: 32px;
      cursor: pointer;
    }

    .pq-close:hover { background: rgba(255,255,255,.24); }
    .pq-body { padding: 18px 20px 20px; }

    .pq-scale { display: flex; gap: 14px; align-items: baseline; margin-bottom: 14px; }
    .pq-scale-label { font-size: 15px; font-weight: 800; opacity: .86; }
    .pq-scale-value { font-size: 48px; line-height: 1; font-weight: 1000; color: #fde68a; }
    .pq-card.warning .pq-scale-value { color: #fdba74; }
    .pq-card.danger .pq-scale-value, .pq-card.eew .pq-scale-value { color: #fecaca; }

    .pq-countdown {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      margin: 0 0 16px;
      border-radius: 14px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.16);
    }

    .pq-countdown.is-eew {
      background: rgba(127,29,29,.5);
      border-color: rgba(254,202,202,.6);
      animation: pq-pulse 900ms ease-in-out infinite;
    }

    .pq-countdown-label { font-weight: 800; color: rgba(255,255,255,.78); }
    .pq-countdown-value { font-size: 28px; font-weight: 1000; color: #fff; }

    .pq-grid {
      display: grid;
      grid-template-columns: 128px 1fr;
      gap: 10px 14px;
      margin: 0;
      font-size: 15px;
      line-height: 1.55;
    }

    .pq-grid dt { margin: 0; color: rgba(255,255,255,.72); font-weight: 800; }
    .pq-grid dd { margin: 0; color: #fff; font-weight: 700; overflow-wrap: anywhere; }

    .pq-points {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.12);
    }

    .pq-points-title { font-weight: 900; margin-bottom: 8px; }
    .pq-point-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .pq-point { padding: 6px 9px; border-radius: 999px; background: rgba(255,255,255,.1); font-size: 13px; font-weight: 800; }

    .pq-footer {
      padding: 12px 20px 16px;
      color: rgba(255,255,255,.62);
      font-size: 12px;
      border-top: 1px solid rgba(255,255,255,.12);
    }

    @keyframes pq-in { from { transform: translateY(-14px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes pq-pulse { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }

    @media (max-width: 560px) {
      .pq-overlay { padding: 10px; }
      .pq-title { font-size: 21px; }
      .pq-scale-value { font-size: 40px; }
      .pq-countdown { display: block; }
      .pq-countdown-value { display: block; margin-top: 4px; font-size: 24px; }
      .pq-grid { grid-template-columns: 96px 1fr; font-size: 14px; }
    }
  `;
  root.appendChild(style);
}

function clearOverlay() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const overlay = shadow?.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
}

function buildCountdownText(data) {
  const sec = getRemainingSeconds(data);
  if (sec === null) return '予測不可';
  if (sec > 0) return `あと ${sec} 秒`;
  return '到達済み推定';
}

function getRemainingSeconds(data) {
  if (data?.sArrivalTime) {
    const t = new Date(data.sArrivalTime).getTime();
    if (!Number.isNaN(t)) return Math.round((t - Date.now()) / 1000);
  }
  if (Number.isFinite(Number(data?.sArrivalCountdownSeconds))) return Number(data.sArrivalCountdownSeconds);
  return null;
}

function startCountdown(data) {
  const value = shadow?.getElementById('pq-countdown-value');
  if (!value) return;
  countdownTimer = setInterval(() => {
    value.textContent = buildCountdownText(data);
  }, 1000);
}

function buildPointsHtml(points) {
  if (!Array.isArray(points) || points.length === 0) return '';
  return `
    <div class="pq-points">
      <div class="pq-points-title">主な観測地点</div>
      <div class="pq-point-list">
        ${points.map((p) => `<span class="pq-point">${escapeHtml(p.name || '不明')}：震度${escapeHtml(p.scaleText || '不明')}</span>`).join('')}
      </div>
    </div>
  `;
}

function playAlertSound(kind) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const beep = (freq, start, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration + 0.02);
    };
    if (kind === 'eew') {
      beep(880, 0, 0.15); beep(660, 0.22, 0.15); beep(880, 0.44, 0.2);
    } else {
      beep(640, 0, 0.12); beep(640, 0.22, 0.12);
    }
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch (_) {}
}

function normalizeSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 12;
  return Math.min(120, Math.max(0, Math.floor(n)));
}

function safeClass(value) {
  return ['notice', 'warning', 'danger', 'eew'].includes(value) ? value : 'notice';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
