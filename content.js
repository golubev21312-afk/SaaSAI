const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const DEFAULT_PROMPT = `Ты — опытный куратор онлайн-клиники здоровья "Клиника Картавенко".
Ты помогаешь ученикам, которые проходят восстановительные программы здоровья на основе физических упражнений.

Твоя задача: написать персональный, тёплый и профессиональный ответ на отчёт ученика.

СТИЛЬ ОБЩЕНИЯ:
- Всегда на "Вы", уважительно и тепло
- Структурированный ответ: приветствие с именем → благодарность за отчёт → анализ ситуации → объяснение → рекомендации → поддержка
- Используй медицинские термины понятным языком
- Если ученик жалуется на симптомы — объясни почему это происходит и что делать
- Если ученик доволен — искренне порадуйся и дай рекомендации по продолжению
- Заканчивай подбадривающей фразой
- Подпись: "С уважением, [имя куратора]" — имя куратора будет указано отдельно

ВАЖНО — ОБЯЗАТЕЛЬНО ВСЕГДА:
- ВСЕГДА начинай ответ с обращения по имени ученика (например "Здравствуйте, Анна!")
- ВСЕГДА в начале благодари за отчёт (например "Спасибо за Ваш отчёт!", "Благодарю за подробный отчёт!")
- Не придумывай конкретные упражнения или ссылки — только общие рекомендации
- Не ставь диагнозы
- Если симптом серьёзный — рекомендуй обратиться к специалисту
- Не используй markdown, звёздочки и прочее форматирование — только чистый текст
- Каждое предложение пиши с новой строки`;

const LENGTH_CONFIG = {
  short:    { words: '40–80 слов',   max_tokens: 300 },
  medium:   { words: '100–200 слов', max_tokens: 600 },
  detailed: { words: '250–400 слов', max_tokens: 1000 },
};

const TONE_CONFIG = {
  official: 'Тон: профессиональный и сдержанный. Чёткие рекомендации без лишних эмоций.',
  warm:     'Тон: тёплый и поддерживающий. Акцент на эмпатию, одобрение и заботу.',
  brief:    'Тон: очень краткий. Всего 2–4 предложения: подтверди получение, отметь главное, пожелай успехов.',
};

const REFINE_PROMPTS = {
  shorter:  'Сократи этот ответ куратора примерно вдвое, сохранив главную мысль, тон и подпись. Верни только готовый текст:',
  warmer:   'Сделай этот ответ куратора заметно теплее и эмпатичнее, сохранив смысл и объём. Верни только готовый текст:',
  rephrase: 'Перефразируй этот ответ куратора другими словами, сохранив смысл, объём и подпись. Верни только готовый текст:',
};

const NAME_SELECTORS = [
  '.user-name', '.student-name', '.author-name', '.comment-author',
  '.answer-author', '.author', '.name', 'strong', 'b',
];

// ── Настройки ──

let settings = {
  apiKey: '', curatorName: 'куратор', templates: [], customPrompt: '',
  togSentiment: true, togCollapse: true, togBatch: true, togDrafts: true,
};

function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get([
      'groqApiKey', 'curatorName', 'templates', 'customPrompt',
      'togSentiment', 'togCollapse', 'togBatch', 'togDrafts',
    ], result => {
      settings = {
        apiKey:       result.groqApiKey   || '',
        curatorName:  result.curatorName  || 'куратор',
        templates:    result.templates    || [],
        customPrompt: result.customPrompt || '',
        togSentiment: result.togSentiment !== false,
        togCollapse:  result.togCollapse  !== false,
        togBatch:     result.togBatch     !== false,
        togDrafts:    result.togDrafts    !== false,
      };
      resolve(settings);
    });
  });
}

// Перезагружать настройки при изменении в попапе
chrome.storage.onChanged.addListener(() => { loadSettings().then(applyToggles); });

// ── Утилиты ──

function detectSentiment(text) {
  const lower = text.toLowerCase();
  const pos = ['хорошо', 'лучше', 'улучшил', 'спасибо', 'отлично', 'прекрасно', 'помогло', 'легче', 'легкость', 'ясность', 'радует', 'доволен', 'довольна', 'нравится', 'здорово'];
  const neg = ['боль', 'болит', 'хуже', 'проблема', 'не могу', 'тяжело', 'трудно', 'плохо', 'симптом', 'жалоб', 'беспокоит', 'мешает', 'трудност', 'сложно'];
  const posCount = pos.filter(w => lower.includes(w)).length;
  const negCount = neg.filter(w => lower.includes(w)).length;
  if (posCount > negCount) return 'positive';
  if (negCount > posCount) return 'negative';
  return 'neutral';
}

function buildSystemPrompt(length, tone, sentiment) {
  const base = settings.customPrompt || DEFAULT_PROMPT;
  const lenCfg = LENGTH_CONFIG[length] || LENGTH_CONFIG.medium;
  const toneStr = TONE_CONFIG[tone] || TONE_CONFIG.warm;
  let sentimentNote = '';
  if (sentiment === 'positive') sentimentNote = '\nУченик настроен позитивно — искренне порадуйся его успехам.';
  if (sentiment === 'negative') sentimentNote = '\nУченик испытывает трудности — прояви особую заботу и поддержку.';
  return `${base}\n- Длина ответа: ${lenCfg.words}\n- ${toneStr}${sentimentNote}`;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function getDraftKey(text) {
  return 'ai_draft_' + text.trim().substring(0, 80);
}

function saveDraft(text, reply) {
  if (!settings.togDrafts) return;
  try { sessionStorage.setItem(getDraftKey(text), reply); } catch(e) {}
}

function loadDraft(text) {
  if (!settings.togDrafts) return null;
  try { return sessionStorage.getItem(getDraftKey(text)); } catch(e) { return null; }
}

function incrementStats() {
  const today = new Date().toISOString().slice(0, 10);
  chrome.storage.local.get(['statsWeek'], result => {
    const week = result.statsWeek || {};
    week[today] = (week[today] || 0) + 1;
    // Чистим данные старше 30 дней
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    Object.keys(week).forEach(d => { if (d < cutoffStr) delete week[d]; });
    chrome.storage.local.set({ statsWeek: week });
  });
}

function findName(block) {
  for (const sel of NAME_SELECTORS) {
    const el = block.querySelector(sel);
    if (el && el.textContent.trim()) {
      return el.textContent.trim().split(' ').slice(0, 2).join(' ');
    }
  }
  return '';
}

function findReplyField(block) {
  const inner = block.querySelector('.new-comment-textarea, textarea, [contenteditable="true"]');
  if (inner) return inner;
  let parent = block.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    const found = parent.querySelector('.new-comment-textarea, textarea, [contenteditable="true"]');
    if (found) return found;
    parent = parent.parentElement;
  }
  return null;
}

function insertTextToField(field, text) {
  field.focus();
  if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    field.textContent = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ── Тост-уведомление ──

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `ai-toast ai-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('ai-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('ai-toast-visible');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

// ── API ──

function extractAutoContext(textEl, studentMessage) {
  const pieces = new Set();

  // Заголовок страницы
  const title = document.title.trim();
  if (title) pieces.add(title);

  // Текст из родительских контейнеров (до 5 уровней вверх)
  // Берём только короткие строки — это обычно метаданные (дата, название курса, день)
  let parent = textEl.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    [...parent.querySelectorAll('*')].forEach(el => {
      if (el.children.length > 0) return; // только листовые узлы
      const text = el.textContent.trim();
      if (
        text.length > 3 &&
        text.length < 150 &&
        !studentMessage.includes(text) && // не сам ответ ученика
        !el.closest('.ai-block-wrap')      // не наш UI
      ) {
        pieces.add(text);
      }
    });
    parent = parent.parentElement;
  }

  // Убираем дубли и объединяем
  const result = [...pieces].slice(0, 15).join(' | ');
  return result.length > 10 ? result : '';
}

async function generateResponse(studentMessage, studentName, curatorName, length, tone, autoContext) {
  if (!settings.apiKey) throw new Error('API ключ не настроен. Откройте настройки расширения.');

  const sentiment = detectSentiment(studentMessage);
  const systemPrompt = buildSystemPrompt(length, tone, sentiment);

  const contextBlock = autoContext
    ? `Контекст страницы (курс, день, задание — используй если релевантно):\n${autoContext}\n\n`
    : '';

  const nameLabel = studentName || 'ученик';
  const userPrompt = `${contextBlock}Имя ученика: ${nameLabel}
Имя куратора для подписи: ${curatorName}

Отчёт/сообщение ученика:
${studentMessage}

Напиши персональный ответ этому ученику. ОБЯЗАТЕЛЬНО начни с обращения по имени "${nameLabel}" и поблагодари за отчёт.`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: (LENGTH_CONFIG[length] || LENGTH_CONFIG.medium).max_tokens,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Ошибка API: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

async function refineResponse(currentText, refineType) {
  if (!settings.apiKey) throw new Error('API ключ не настроен.');

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'user', content: `${REFINE_PROMPTS[refineType]}\n\n${currentText}` },
      ],
      temperature: 0.7,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Ошибка API: ${err.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// ── Индикатор настроения ──

function createSentimentBadge(text) {
  const sentiment = detectSentiment(text);
  const badge = document.createElement('span');
  badge.className = `ai-sentiment-badge ai-sentiment-${sentiment}`;
  const labels = { positive: 'Позитивный', negative: 'Жалоба', neutral: 'Нейтральный' };
  badge.textContent = labels[sentiment];
  return badge;
}

// ── Панель ──

function createPanel(textEl) {
  let block = textEl.parentElement;
  for (let i = 0; i < 4 && block; i++) {
    if (findName(block)) break;
    block = block.parentElement;
  }
  if (!block) block = textEl.parentElement;

  const studentMessage = textEl.textContent.trim().substring(0, 3000);
  const savedDraft = loadDraft(studentMessage);

  const wrap = document.createElement('div');
  wrap.className = 'ai-block-wrap';
  wrap.dataset.length = 'short';
  wrap.dataset.tone = 'warm';

  wrap.innerHTML = `
    <div class="ai-controls">
      <div class="ai-length-toggle">
        <button class="ai-len-btn active" data-len="short">Короткий</button>
        <button class="ai-len-btn" data-len="medium">Средний</button>
        <button class="ai-len-btn" data-len="detailed">Подробный</button>
      </div>
      <div class="ai-tone-toggle">
        <button class="ai-tone-btn active" data-tone="warm">Тёплый</button>
        <button class="ai-tone-btn" data-tone="official">Официальный</button>
        <button class="ai-tone-btn" data-tone="brief">Кратко</button>
      </div>
      <button class="ai-gen-btn">
        <span class="ai-gen-label">Составить ответ ИИ</span>
      </button>
    </div>
    <div class="ai-result-panel" style="display:${savedDraft ? 'block' : 'none'};">
      <div class="ai-result-header">
        <span>Готовый ответ</span>
        <div class="ai-header-right">
          <span class="ai-word-count"></span>
          <button class="ai-close-btn" title="Закрыть">✕</button>
        </div>
      </div>
      <textarea class="ai-result-text" rows="8" placeholder="Здесь появится ответ...">${savedDraft || ''}</textarea>
      <div class="ai-refine-row">
        <span class="ai-refine-label">Правки:</span>
        <button class="ai-refine-btn" data-refine="shorter">Короче</button>
        <button class="ai-refine-btn" data-refine="warmer">Теплее</button>
        <button class="ai-refine-btn" data-refine="rephrase">Перефразировать</button>
      </div>
      <div class="ai-result-actions">
        <button class="ai-regen-btn">Перегенерировать</button>
        <div class="ai-tpl-wrap">
          <button class="ai-tpl-btn">Шаблоны ▾</button>
          <div class="ai-tpl-dropdown" style="display:none;"></div>
        </div>
        <button class="ai-copy-btn">Копировать</button>
      </div>
    </div>
  `;

  const genBtn     = wrap.querySelector('.ai-gen-btn');
  const panel      = wrap.querySelector('.ai-result-panel');
  const resultTA   = wrap.querySelector('.ai-result-text');
  const closeBtn   = wrap.querySelector('.ai-close-btn');
  const regenBtn   = wrap.querySelector('.ai-regen-btn');
  const copyBtn    = wrap.querySelector('.ai-copy-btn');
  const wordCount  = wrap.querySelector('.ai-word-count');
  const tplBtn     = wrap.querySelector('.ai-tpl-btn');
  const tplDrop    = wrap.querySelector('.ai-tpl-dropdown');
  const lenBtns    = wrap.querySelectorAll('.ai-len-btn');
  const toneBtns   = wrap.querySelectorAll('.ai-tone-btn');
  const refineBtns = wrap.querySelectorAll('.ai-refine-btn');

  // Контекст собирается автоматически при каждой генерации
  const autoContext = extractAutoContext(textEl, studentMessage);

  if (savedDraft) wordCount.textContent = countWords(savedDraft) + ' сл.';

  lenBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      lenBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      wrap.dataset.length = btn.dataset.len;
    });
  });

  toneBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      toneBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      wrap.dataset.tone = btn.dataset.tone;
    });
  });

  resultTA.addEventListener('input', () => {
    const n = countWords(resultTA.value);
    wordCount.textContent = n ? `${n} сл.` : '';
  });

  // Шаблоны
  tplBtn.addEventListener('click', () => {
    if (tplDrop.style.display !== 'none') { tplDrop.style.display = 'none'; return; }
    tplDrop.innerHTML = '';
    const templates = settings.templates;
    if (!templates.length) {
      tplDrop.innerHTML = '<div class="ai-tpl-empty">Нет шаблонов. Добавьте в настройках.</div>';
    } else {
      templates.forEach(tpl => {
        const item = document.createElement('div');
        item.className = 'ai-tpl-item';
        item.textContent = tpl.name;
        item.addEventListener('click', () => {
          resultTA.value = resultTA.value ? resultTA.value + '\n\n' + tpl.text : tpl.text;
          resultTA.dispatchEvent(new Event('input'));
          tplDrop.style.display = 'none';
        });
        tplDrop.appendChild(item);
      });
    }
    tplDrop.style.display = 'block';
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) tplDrop.style.display = 'none';
  });

  // Быстрые правки
  const refineLabels = { shorter: 'Короче', warmer: 'Теплее', rephrase: 'Перефразировать' };
  refineBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = resultTA.value.trim();
      if (!text || text.startsWith('❌') || text.includes('ИИ читает')) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const refined = await refineResponse(text, btn.dataset.refine);
        resultTA.value = refined;
        resultTA.dispatchEvent(new Event('input'));
        saveDraft(studentMessage, refined);
      } catch(err) {
        showToast('Ошибка: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = refineLabels[btn.dataset.refine];
      }
    });
  });

  // Генерация
  async function doGenerate() {
    await loadSettings();
    genBtn.disabled = true;
    wrap.querySelector('.ai-gen-label').textContent = 'Думаю...';
    panel.style.display = 'block';
    resultTA.value = 'ИИ читает сообщение ученика...';
    wordCount.textContent = '';
    regenBtn.disabled = true;

    try {
      if (!studentMessage || studentMessage.length < 10) {
        throw new Error('Не удалось найти текст ученика. Попробуйте обновить страницу.');
      }

      const reply = await generateResponse(
        studentMessage, findName(block), settings.curatorName,
        wrap.dataset.length, wrap.dataset.tone, autoContext
      );
      resultTA.value = reply;
      resultTA.dispatchEvent(new Event('input'));
      saveDraft(studentMessage, reply);
      incrementStats();
    } catch (err) {
      resultTA.value = `❌ Ошибка: ${err.message}`;
    } finally {
      genBtn.disabled = false;
      wrap.querySelector('.ai-gen-label').textContent = 'Составить ответ ИИ';
      regenBtn.disabled = false;
    }
  }

  genBtn.addEventListener('click', doGenerate);
  regenBtn.addEventListener('click', doGenerate);
  wrap.addEventListener('ai-generate', doGenerate);

  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(resultTA.value).then(() => {
      copyBtn.textContent = 'Скопировано!';
      setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 2000);
    });
  });

  return wrap;
}

// ── Пакетная генерация ──

let batchBtn = null;

async function runBatchGeneration() {
  const wraps = [...document.querySelectorAll('.ai-block-wrap')];
  if (!wraps.length) return;

  batchBtn.disabled = true;

  for (let i = 0; i < wraps.length; i++) {
    batchBtn.textContent = `Генерирую ${i + 1} / ${wraps.length}...`;
    const wrap = wraps[i];
    const genBtn = wrap.querySelector('.ai-gen-btn');

    wrap.dispatchEvent(new CustomEvent('ai-generate'));

    await new Promise(r => setTimeout(r, 300));
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 30000);
      const check = setInterval(() => {
        if (!genBtn.disabled) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 400);
    });

    await new Promise(r => setTimeout(r, 400));
  }

  batchBtn.textContent = 'Сгенерировать все';
  batchBtn.disabled = false;
  showToast(`Готово! Сгенерировано ${wraps.length} ответов`);
}

function applyToggles() {
  if (batchBtn) {
    batchBtn.style.display = settings.togBatch ? 'flex' : 'none';
  }
  document.querySelectorAll('.ai-sentiment-badge').forEach(b => {
    b.style.display = settings.togSentiment ? '' : 'none';
  });
}

function ensureBatchButton() {
  const count = document.querySelectorAll('.answer-text').length;
  if (batchBtn) {
    batchBtn.style.display = (count >= 2 && settings.togBatch) ? 'flex' : 'none';
    return;
  }
  if (count < 2 || !settings.togBatch) return;

  batchBtn = document.createElement('button');
  batchBtn.className = 'ai-batch-btn';
  batchBtn.textContent = 'Сгенерировать все';
  batchBtn.addEventListener('click', runBatchGeneration);
  document.body.appendChild(batchBtn);
}

// ── Горячая клавиша Alt+G ──

document.addEventListener('keydown', e => {
  if (e.altKey && (e.key === 'g' || e.key === 'G' || e.key === 'п' || e.key === 'П')) {
    e.preventDefault();
    const firstBtn = document.querySelector('.ai-gen-btn:not([disabled])');
    if (firstBtn) {
      firstBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstBtn.click();
    }
  }
});

// ── Инициализация ──

function processTextEl(textEl) {
  if (textEl.dataset.aiDone) return;
  textEl.dataset.aiDone = 'true';

  if (settings.togSentiment) {
    const badge = createSentimentBadge(textEl.textContent);
    textEl.insertAdjacentElement('afterend', badge);
    badge.insertAdjacentElement('afterend', createPanel(textEl));
  } else {
    textEl.insertAdjacentElement('afterend', createPanel(textEl));
  }
}

function scanPage() {
  document.querySelectorAll('.answer-text').forEach(el => {
    if (!el.dataset.aiDone) processTextEl(el);
  });
  ensureBatchButton();
}

const observer = new MutationObserver(() => scanPage());
observer.observe(document.body, { childList: true, subtree: true });

loadSettings().then(() => scanPage());
