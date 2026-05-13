const EXCHANGE_NAMES = {
  binance: 'Binance',
  okx: 'OKX',
  bybit: 'Bybit',
  kucoin: 'KuCoin',
  gateio: 'Gate.io',
  bitget: 'Bitget',
  mexc: 'MEXC',
  htx: 'HTX'
};

let currentData = null;
let mode = 'daily';   // 'daily' | 'weekly'

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function init() {
  const picker = document.getElementById('date-picker');
  const modeBtn = document.getElementById('mode-btn');
  picker.value = getToday();
  picker.addEventListener('change', () => loadDaily(picker.value));
  modeBtn.addEventListener('click', () => {
    if (mode === 'daily') {
      mode = 'weekly';
      modeBtn.textContent = '切回每日';
      modeBtn.dataset.mode = 'weekly';
      document.getElementById('date-label').classList.add('hidden');
      picker.classList.add('hidden');
      loadWeekly();
    } else {
      mode = 'daily';
      modeBtn.textContent = '本周回顾';
      modeBtn.dataset.mode = 'daily';
      document.getElementById('date-label').classList.remove('hidden');
      picker.classList.remove('hidden');
      loadDaily(picker.value);
    }
  });
  loadDaily(getToday());
  initExport();
}

function setUpdateTime(data) {
  const updateTime = document.getElementById('update-time');
  const liveDot = document.getElementById('live-dot');
  if (data.updatedAt) {
    const prefix = mode === 'weekly'
      ? `${data.weekStart} → ${data.weekEnd}　·　`
      : '';
    updateTime.textContent = `${prefix}更新于 ${new Date(data.updatedAt).toLocaleString('zh-CN')}`;
    liveDot.classList.remove('hidden');
  } else {
    updateTime.textContent = '';
    liveDot.classList.add('hidden');
  }
}

async function loadDaily(date) {
  const content = document.getElementById('content');
  const noData = document.getElementById('no-data');
  content.innerHTML = '<div class="loading">正在加载数据</div>';
  noData.classList.add('hidden');

  try {
    const res = await fetch(`data/${date}.json`);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    currentData = data;
    setUpdateTime(data);
    content.innerHTML = '';
    noData.classList.add('hidden');
    renderExchanges(content, data.exchanges);
  } catch (e) {
    content.innerHTML = '';
    noData.classList.remove('hidden');
    currentData = null;
    setUpdateTime({});
  }
}

async function loadWeekly() {
  const content = document.getElementById('content');
  const noData = document.getElementById('no-data');
  content.innerHTML = '<div class="loading">正在加载周回顾</div>';
  noData.classList.add('hidden');

  try {
    const res = await fetch('data/weekly.json');
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    currentData = data;
    setUpdateTime(data);
    content.innerHTML = '';
    noData.classList.add('hidden');
    renderExchanges(content, data.exchanges);
  } catch (e) {
    content.innerHTML = '';
    noData.classList.remove('hidden');
    currentData = null;
    setUpdateTime({});
  }
}

function countListings(data) {
  let total = (data.listings || []).length;
  if (data.alpha) total += data.alpha.length;
  if (data.wallet) total += data.wallet.length;
  return total;
}

function renderExchanges(container, exchanges) {
  for (const [key, data] of Object.entries(exchanges)) {
    const card = document.createElement('div');
    card.className = 'exchange-card';

    const name = EXCHANGE_NAMES[key] || key;
    const count = countListings(data);
    const badge = count > 0 ? `<span class="badge">+${count}</span>` : '';

    let html = `<div class="card-head">
      <h2>${escapeHtml(name)}</h2>
      ${badge}
    </div><div class="card-body">`;

    const period = mode === 'weekly' ? '本周' : '今日';
    const listings = data.listings || [];
    if (listings.length > 0) {
      html += renderTable(listings);
    } else {
      html += `<p class="empty-msg">${period}无新币上线</p>`;
    }

    if (key === 'binance') {
      const alpha = data.alpha || [];
      html += `<div class="sub-section"><div class="sub-title">Binance Alpha</div>`;
      if (alpha.length > 0) {
        html += renderTable(alpha);
      } else {
        html += `<p class="empty-msg">${period}无新增代币</p>`;
      }
      html += `</div>`;

      const wallet = data.wallet || [];
      html += `<div class="sub-section"><div class="sub-title">Binance Wallet</div>`;
      if (wallet.length > 0) {
        html += renderTable(wallet);
      } else {
        html += `<p class="empty-msg">${period}无新代币上线</p>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    card.innerHTML = html;
    container.appendChild(card);
  }
}

function renderTable(items) {
  let html = `<table>
    <thead><tr><th>币种</th><th>类型</th><th>详情</th></tr></thead>
    <tbody>`;
  for (const item of items) {
    const link = item.url ? ` <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="detail-link">（查看公告）</a>` : '';
    const datesPill = (item.dates && item.dates.length > 0)
      ? ` <span class="dates-pill">${item.dates.map(d => d.slice(5)).join(' · ')}</span>`
      : '';
    html += `<tr>
      <td class="token-name">${escapeHtml(item.token)}</td>
      <td class="listing-type">${escapeHtml(item.type)}</td>
      <td class="listing-detail">${escapeHtml(item.detail)}${link}${datesPill}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function initExport() {
  const btn = document.getElementById('export-btn');
  const panel = document.getElementById('export-panel');
  const wrapper = btn.closest('.export-wrapper');

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
  });

  document.addEventListener('mousedown', (e) => {
    if (!wrapper.contains(e.target)) {
      panel.classList.remove('open');
    }
  });

  panel.querySelectorAll('.export-option').forEach(opt => {
    opt.addEventListener('click', () => {
      if (!currentData) return;
      const format = opt.dataset.format;
      if (format === 'pdf') {
        exportPDF(currentData);
      } else if (format === 'copy') {
        navigator.clipboard.writeText(exportText(currentData)).then(() => showToast());
      }
      panel.classList.remove('open');
    });
  });
}

function showToast() {
  const toast = document.getElementById('export-toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}

function exportPDF(data) {
  const printTitle = document.getElementById('print-title');
  const header = mode === 'weekly'
    ? `${data.weekStart} → ${data.weekEnd} 各交易所新币上线周回顾`
    : `${data.date} 各交易所新币上线公告`;
  printTitle.textContent = header;
  window.print();
}

function exportText(data) {
  const header = mode === 'weekly'
    ? `【交易所新币上线 · 周回顾 ${data.weekStart} → ${data.weekEnd}】\n\n`
    : '';
  let out = header;
  for (const [key, exData] of Object.entries(data.exchanges)) {
    const name = EXCHANGE_NAMES[key] || key;
    const listings = exData.listings || [];
    const alpha = key === 'binance' ? (exData.alpha || []) : [];
    const wallet = key === 'binance' ? (exData.wallet || []) : [];
    const all = [...listings, ...alpha, ...wallet];
    if (all.length === 0) continue;
    const label = mode === 'weekly' ? '本周' : '今日';
    out += `${name}：\n${label}${all.length}则上币公告。\n`;
    all.forEach((item, i) => {
      const dateTag = item.dates ? ` [${item.dates.map(d => d.slice(5)).join('/')}]` : '';
      out += `${i + 1}. ${item.detail || item.token + ' ' + item.type}${dateTag}\n`;
    });
    out += '\n';
  }
  return out.trim();
}

init();
