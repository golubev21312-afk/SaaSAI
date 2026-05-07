const KEYS = ['groqApiKey', 'curatorName', 'templates', 'customPrompt',
               'togSentiment', 'togCollapse', 'togBatch', 'togDrafts', 'statsWeek'];

// ── Загрузка ──

chrome.storage.local.get(KEYS, result => {
  if (result.groqApiKey)   document.getElementById('api-key').value = result.groqApiKey;
  if (result.curatorName)  document.getElementById('curator-name').value = result.curatorName;
  if (result.customPrompt) document.getElementById('custom-prompt').value = result.customPrompt;

  // Тумблеры (по умолчанию все включены)
  setToggle('tog-sentiment', result.togSentiment !== false);
  setToggle('tog-collapse',  result.togCollapse  !== false);
  setToggle('tog-batch',     result.togBatch     !== false);
  setToggle('tog-drafts',    result.togDrafts    !== false);

  // Статистика
  const week = result.statsWeek || {};
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('stat-today').textContent = `Сегодня: ${week[today] || 0}`;
  let weekTotal = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    weekTotal += week[d.toISOString().slice(0, 10)] || 0;
  }
  document.getElementById('stat-week').textContent = `Неделя: ${weekTotal}`;

  renderTemplates(result.templates || []);
});

function setToggle(id, val) {
  document.getElementById(id).checked = val;
}

// ── Сохранение настроек ──

document.getElementById('save-btn').addEventListener('click', () => {
  const apiKey      = document.getElementById('api-key').value.trim();
  const curatorName = document.getElementById('curator-name').value.trim();
  const customPrompt = document.getElementById('custom-prompt').value.trim();
  const status      = document.getElementById('status');

  if (!apiKey) {
    status.style.color = '#dc2626';
    status.textContent = 'Введите API ключ';
    return;
  }
  if (!curatorName) {
    status.style.color = '#dc2626';
    status.textContent = 'Введите имя куратора';
    return;
  }

  const togSentiment = document.getElementById('tog-sentiment').checked;
  const togCollapse  = document.getElementById('tog-collapse').checked;
  const togBatch     = document.getElementById('tog-batch').checked;
  const togDrafts    = document.getElementById('tog-drafts').checked;

  chrome.storage.local.set({
    groqApiKey: apiKey, curatorName, customPrompt,
    togSentiment, togCollapse, togBatch, togDrafts,
  }, () => {
    status.style.color = '#16a34a';
    status.textContent = 'Сохранено!';
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
});

// ── Промпт ──

document.getElementById('reset-prompt').addEventListener('click', () => {
  document.getElementById('custom-prompt').value = '';
});

// ── Шаблоны ──

function renderTemplates(templates) {
  const list = document.getElementById('tpl-list');
  list.innerHTML = '';
  if (!templates.length) {
    list.innerHTML = '<div class="tpl-empty">Шаблоны не добавлены</div>';
    return;
  }
  templates.forEach((tpl, i) => {
    const item = document.createElement('div');
    item.className = 'tpl-item';
    item.innerHTML = `
      <div style="overflow:hidden;">
        <div class="tpl-item-name">${tpl.name}</div>
        <div class="tpl-item-text">${tpl.text}</div>
      </div>
      <button class="tpl-del-btn" data-index="${i}" title="Удалить">✕</button>
    `;
    item.querySelector('.tpl-del-btn').addEventListener('click', () => deleteTemplate(i));
    list.appendChild(item);
  });
}

function deleteTemplate(index) {
  chrome.storage.local.get(['templates'], result => {
    const templates = result.templates || [];
    templates.splice(index, 1);
    chrome.storage.local.set({ templates }, () => renderTemplates(templates));
  });
}

document.getElementById('tpl-add-btn').addEventListener('click', () => {
  const name = document.getElementById('tpl-name').value.trim();
  const text = document.getElementById('tpl-text').value.trim();
  if (!name || !text) return;
  chrome.storage.local.get(['templates'], result => {
    const templates = result.templates || [];
    templates.push({ name, text });
    chrome.storage.local.set({ templates }, () => {
      renderTemplates(templates);
      document.getElementById('tpl-name').value = '';
      document.getElementById('tpl-text').value = '';
    });
  });
});
