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
- ВСЕГДА начинай ответ со слова "Здравствуйте" + имя ученика. Никогда не используй "Добрый день", "Добрый вечер", "Доброе утро", "Доброго времени" — только "Здравствуйте, [Имя]!"
- ВСЕГДА в начале благодари за отчёт (например "Спасибо за Ваш отчёт!", "Благодарю за подробный отчёт!")
- Не придумывай конкретные упражнения или ссылки — только общие рекомендации
- Не ставь диагнозы
- Если симптом серьёзный — рекомендуй обратиться к специалисту
- Не используй markdown, звёздочки и прочее форматирование — только чистый текст
- Каждое предложение пиши с новой строки`;

// Фильтр: показываем только полезные шаблоны (симптомы, ситуации, советы)
const USEFUL_CATEGORIES = new Set(['medical', 'no_report', 'report_first', 'report_final', 'motivation', 'info']);
const GREETING_PREFIXES  = ['здравствуйте', 'добрый', 'доброго', 'доброе', 'дравствуйте', 'приветствую', 'рада привет'];
// Слишком общие ключевые слова — не считаются конкретной темой
const GENERIC_KEYWORDS   = new Set(['отчет', 'спасибо', 'ответ на отчет', 'здравствуйте', 'привет']);

function isUsefulTemplate(tpl) {
  const nl = tpl.name.toLowerCase();
  if (GREETING_PREFIXES.some(p => nl.indexOf(p) !== -1)) return false;
  if (tpl.category === 'greeting') return false;
  if (USEFUL_CATEGORIES.has(tpl.category)) return true;
  // general — только если есть хотя бы одно НЕ-общее ключевое слово
  if (tpl.category === 'general' && tpl.keywords) {
    return tpl.keywords.some(kw => !GENERIC_KEYWORDS.has(kw.toLowerCase()));
  }
  return false;
}

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
  '.title',                                   // GetCourse: div.answer-content > div.title
  '.user-name', '.student-name', '.author-name', '.comment-author',
  '.answer-author', '.author', '.name',
];

// ── Настройки ──

let settings = {
  apiKey: '', curatorName: 'куратор', templates: [], customPrompt: '',
  togSentiment: true, togBatch: true, togDrafts: true,
};

function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function loadSettings() {
  return new Promise(resolve => {
    if (!isExtensionAlive()) { resolve(settings); return; }
    try {
      chrome.storage.local.get([
        'groqApiKey', 'curatorName', 'templates', 'customPrompt',
        'togSentiment', 'togBatch', 'togDrafts',
      ], result => {
        if (chrome.runtime.lastError) { resolve(settings); return; }
        settings = {
          apiKey:       result.groqApiKey   || '',
          curatorName:  result.curatorName  || 'куратор',
          templates:    result.templates    || [],
          customPrompt: result.customPrompt || '',
          togSentiment: result.togSentiment !== false,
          togBatch:     result.togBatch     !== false,
          togDrafts:    result.togDrafts    !== false,
        };
        resolve(settings);
      });
    } catch { resolve(settings); }
  });
}

try {
  chrome.storage.onChanged.addListener(() => {
    if (!isExtensionAlive()) return;
    loadSettings().then(applyToggles).catch(() => {});
  });
} catch { /* extension reloaded */ }

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

function buildSystemPrompt(length, tone, sentiment, matchedTemplates) {
  const base = settings.customPrompt || DEFAULT_PROMPT;
  const lenCfg = LENGTH_CONFIG[length] || LENGTH_CONFIG.medium;
  const toneStr = TONE_CONFIG[tone] || TONE_CONFIG.warm;
  let sentimentNote = '';
  if (sentiment === 'positive') sentimentNote = '\nУченик настроен позитивно — искренне порадуйся его успехам.';
  if (sentiment === 'negative') sentimentNote = '\nУченик испытывает трудности — прояви особую заботу и поддержку.';

  let examplesBlock = '';
  if (matchedTemplates && matchedTemplates.length > 0) {
    const examples = matchedTemplates
      .map(t => `[Пример: "${t.name}"]\n${t.text.slice(0, 600)}`)
      .join('\n\n---\n\n');
    examplesBlock = `\n\nПРИМЕРЫ ОТВЕТОВ КУРАТОРА — изучи стиль, тон и структуру, пиши похоже:\n\n${examples}\n\n---\nСоблюдай такой же стиль в своём ответе.`;
  }

  return `${base}\n- Длина ответа: ${lenCfg.words}\n- ${toneStr}${sentimentNote}${examplesBlock}`;
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Хеш вместо первых 80 символов — исключает коллизии черновиков у похожих сообщений
function getDraftKey(text) {
  const s = text.trim().replace(/\s+/g, ' ');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return 'ai_draft_' + (h >>> 0).toString(36);
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
  if (!isExtensionAlive()) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    chrome.storage.local.get(['statsWeek'], result => {
      if (chrome.runtime.lastError || !isExtensionAlive()) return;
      const week = result.statsWeek || {};
      week[today] = (week[today] || 0) + 1;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      Object.keys(week).forEach(d => { if (d < cutoffStr) delete week[d]; });
      try { chrome.storage.local.set({ statsWeek: week }); } catch { }
    });
  } catch { }
}

function looksLikeName(text) {
  return /^[А-ЯЁа-яёA-Z][А-ЯЁа-яёA-Za-z\s\-]{1,40}$/.test(text) && text.split(/\s+/).length <= 3;
}

function findName(block) {
  for (const sel of NAME_SELECTORS) {
    const el = block.querySelector(sel);
    if (el) {
      const text = el.textContent.trim();
      if (text) return text.split(/[\s,|—–-]+/).slice(0, 2).join(' ');
    }
  }
  // Запасной вариант: жирный текст похожий на имя (кириллица, 1–3 слова)
  for (const tag of ['strong', 'b', 'a']) {
    for (const el of block.querySelectorAll(tag)) {
      const text = el.textContent.trim();
      if (looksLikeName(text)) return text.split(/\s+/).slice(0, 2).join(' ');
    }
  }
  return '';
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

// Только прямые дочерние элементы каждого уровня — без обхода всего поддерева
function extractAutoContext(textEl, studentMessage) {
  const pieces = new Set();

  const title = document.title.trim();
  if (title) pieces.add(title);

  let parent = textEl.parentElement;
  for (let i = 0; i < 5 && parent && pieces.size < 15; i++) {
    for (const el of parent.children) {
      if (el.classList.contains('ai-block-wrap')) continue;
      const text = el.textContent.trim();
      if (text.length > 3 && text.length < 150 && !studentMessage.includes(text)) {
        pieces.add(text);
      }
      if (pieces.size >= 15) break;
    }
    parent = parent.parentElement;
  }

  const result = [...pieces].join(' | ');
  return result.length > 10 ? result : '';
}

async function generateResponse(studentMessage, studentName, curatorName, length, tone, autoContext, forcedTemplate) {
  if (!settings.apiKey) throw new Error('API ключ не настроен. Откройте настройки расширения.');

  let systemPrompt;
  if (forcedTemplate) {
    systemPrompt = `Ты — куратор онлайн-клиники здоровья "Клиника Картавенко".
Тебе дан готовый шаблон ответа куратора и отчёт ученика. Адаптируй шаблон — не пиши ответ с нуля.

ПРАВИЛА АДАПТАЦИИ:
- Сохраняй структуру, стиль и объём шаблона
- Подставь имя ученика вместо любого другого имени в шаблоне
- Замени подпись на "С уважением, ${curatorName}"
- При необходимости скорректируй 1–2 детали под содержание отчёта
- НЕ придумывай новый текст — используй шаблон как готовую основу
- Не используй markdown и звёздочки — только чистый текст
- Каждое предложение с новой строки`;
  } else {
    const sentiment = detectSentiment(studentMessage);
    const matchedTemplates = typeof findMatchingTemplates === 'function'
      ? findMatchingTemplates(studentMessage, 2) : [];
    systemPrompt = buildSystemPrompt(length, tone, sentiment, matchedTemplates);
  }

  const contextBlock = autoContext
    ? `Контекст страницы (курс, день, задание — используй если релевантно):\n${autoContext}\n\n`
    : '';

  const nameLabel = studentName || 'ученик';
  let userPrompt;
  if (forcedTemplate) {
    userPrompt = `${contextBlock}Имя ученика: ${nameLabel}
Имя куратора для подписи: ${curatorName}

Возьми этот шаблон как основу и адаптируй его под конкретного ученика:
---
${forcedTemplate.text.slice(0, 800)}
---

Отчёт ученика:
${studentMessage}

Адаптируй шаблон: замени имя на "${nameLabel}", замени подпись на "С уважением, ${curatorName}", персонализируй текст под содержание отчёта ученика. Обязательно начни с "Здравствуйте, ${nameLabel}!".`;
  } else {
    userPrompt = `${contextBlock}Имя ученика: ${nameLabel}
Имя куратора для подписи: ${curatorName}

Отчёт/сообщение ученика:
${studentMessage}

Напиши персональный ответ этому ученику. ОБЯЗАТЕЛЬНО начни с обращения по имени "${nameLabel}" и поблагодари за отчёт.`;
  }

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

// Единый глобальный обработчик закрытия дропдаунов — один на всю страницу вместо одного на каждую панель
document.addEventListener('click', e => {
  if (!e.target.closest('.ai-tpl-wrap')) {
    document.querySelectorAll('.ai-tpl-dropdown').forEach(d => { d.style.display = 'none'; });
  }
});

// ── Категории шаблонов ──

const CATEGORY_LABELS = {
  medical:      '🩺 Медицинские',
  motivation:   '💪 Мотивация',
  info:         'ℹ️ Информация',
  report_first: '📋 Первый день',
  report_final: '🏆 Итоговый отчёт',
  no_report:    '📝 Нет отчёта',
  general:      '📌 Разное',
};

function renderTemplateItems(container, templates, onSelect) {
  container.innerHTML = '';
  if (!templates.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-tpl-empty';
    empty.textContent = 'Не найдено';
    container.appendChild(empty);
    return;
  }

  // Группируем по категории
  const order = ['medical', 'motivation', 'info', 'report_first', 'report_final', 'no_report', 'general'];
  const groups = {};
  templates.forEach(tpl => {
    const cat = tpl.category || 'general';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(tpl);
  });

  order.forEach(cat => {
    if (!groups[cat] || !groups[cat].length) return;
    const label = document.createElement('div');
    label.className = 'ai-tpl-group-label';
    label.textContent = CATEGORY_LABELS[cat] || cat;
    container.appendChild(label);

    groups[cat].forEach(tpl => {
      const item = document.createElement('div');
      item.className = 'ai-tpl-item';
      item.textContent = tpl.name;
      item.title = tpl.text.slice(0, 140) + '…';
      item.addEventListener('click', () => onSelect(tpl));
      container.appendChild(item);
    });
  });
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

  // savedDraft не вставляется через innerHTML во избежание XSS — значение задаётся через .value ниже
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
      <div class="ai-pretpl-row">
        <div class="ai-pretpl-pick-wrap">
          <button class="ai-pretpl-pick-btn">Шаблон ▾</button>
          <div class="ai-pretpl-dropdown" style="display:none;"></div>
        </div>
        <span class="ai-pretpl-selected"></span>
        <button class="ai-pretpl-clear" style="display:none;" title="Сбросить">✕</button>
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
      <textarea class="ai-result-text" rows="8" placeholder="Здесь появится ответ..."></textarea>
      <div class="ai-refine-row">
        <span class="ai-refine-label">Правки:</span>
        <button class="ai-refine-btn" data-refine="shorter">Короче</button>
        <button class="ai-refine-btn" data-refine="warmer">Теплее</button>
        <button class="ai-refine-btn" data-refine="rephrase">Перефразировать</button>
      </div>
      <div class="ai-result-actions">
        <button class="ai-regen-btn">Перегенерировать</button>
        <button class="ai-adapt-btn" style="display:none">Адаптировать шаблон</button>
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
  const adaptBtn   = wrap.querySelector('.ai-adapt-btn');
  const wordCount  = wrap.querySelector('.ai-word-count');
  const tplBtn     = wrap.querySelector('.ai-tpl-btn');
  const tplDrop    = wrap.querySelector('.ai-tpl-dropdown');
  const lenBtns    = wrap.querySelectorAll('.ai-len-btn');
  const toneBtns   = wrap.querySelectorAll('.ai-tone-btn');
  const refineBtns = wrap.querySelectorAll('.ai-refine-btn');

  const autoContext = extractAutoContext(textEl, studentMessage);

  // Применяет шаблон в результат с подстановкой имён и очисткой форматирования
  function applyTemplate(tpl) {
    let txt = tpl.text;
    // Нормализуем переносы: \r\n и \r → \n, убираем лишние пустые строки
    txt = txt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const name = findName(block);
    const curator = settings.curatorName || 'куратор';
    txt = txt.replace(/С уважением[,\s]+[^\n]+/g, `С уважением, ${curator}`);
    const hasGreeting = /^(здравствуйте|добрый|доброго)/i.test(txt.trim());
    if (!hasGreeting && name) {
      txt = `Здравствуйте, ${name}!\n\n${txt}`;
    }
    return txt;
  }

  // ── Выбор шаблона до генерации ──
  let selectedTemplate = null;

  const pretplPickBtn  = wrap.querySelector('.ai-pretpl-pick-btn');
  const pretplDrop     = wrap.querySelector('.ai-pretpl-dropdown');
  const pretplClearBtn = wrap.querySelector('.ai-pretpl-clear');
  const pretplSelected = wrap.querySelector('.ai-pretpl-selected');

  function setSelectedTemplate(tpl) {
    selectedTemplate = tpl;
    if (tpl) {
      pretplPickBtn.textContent = 'Шаблон ▾';
      pretplPickBtn.classList.add('ai-pretpl-pick-active');
      pretplSelected.textContent = tpl.name.slice(0, 30) + (tpl.name.length > 30 ? '…' : '');
      pretplSelected.title = tpl.name;
      pretplClearBtn.style.display = 'inline-flex';
      adaptBtn.style.display = '';
    } else {
      pretplPickBtn.textContent = 'Шаблон ▾';
      pretplPickBtn.classList.remove('ai-pretpl-pick-active');
      pretplSelected.textContent = '';
      pretplClearBtn.style.display = 'none';
      adaptBtn.style.display = 'none';
    }
  }

  // Дропдаун — input создаётся один раз
  const pretplSearchInput = document.createElement('input');
  pretplSearchInput.className = 'ai-tpl-search';
  pretplSearchInput.placeholder = 'Поиск шаблона...';
  pretplSearchInput.addEventListener('click', e => e.stopPropagation());

  const pretplSearchWrap = document.createElement('div');
  pretplSearchWrap.className = 'ai-tpl-search-wrap';
  pretplSearchWrap.appendChild(pretplSearchInput);

  const pretplList = document.createElement('div');
  pretplDrop.appendChild(pretplSearchWrap);
  pretplDrop.appendChild(pretplList);

  let preTplCategory = null;
  const CAT_ORDER = ['medical', 'motivation', 'info', 'report_first', 'report_final', 'no_report', 'general'];

  function getUsefulLib() {
    return (typeof TEMPLATES_LIBRARY !== 'undefined' ? TEMPLATES_LIBRARY : []).filter(isUsefulTemplate);
  }

  function renderPreTplList(query) {
    pretplList.innerHTML = '';
    const lib = getUsefulLib();

    if (query && query.trim()) {
      // Поиск — плоский список
      const searched = (typeof searchTemplates === 'function')
        ? searchTemplates(query).filter(isUsefulTemplate)
        : lib.filter(t => t.name.toLowerCase().includes(query.toLowerCase()));
      if (!searched.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-tpl-empty';
        empty.textContent = 'Ничего не найдено';
        pretplList.appendChild(empty);
      } else {
        searched.slice(0, 60).forEach(tpl => {
          const item = document.createElement('div');
          item.className = 'ai-tpl-item';
          if (selectedTemplate?.name === tpl.name) item.classList.add('ai-tpl-item-selected');
          item.textContent = tpl.name;
          item.title = tpl.text.slice(0, 140) + '…';
          item.addEventListener('click', () => {
            const deselect = selectedTemplate?.name === tpl.name;
            setSelectedTemplate(deselect ? null : tpl);
            if (!deselect) {
              const ready = applyTemplate(tpl);
              resultTA.value = ready;
              resultTA.dispatchEvent(new Event('input'));
              panel.style.display = 'block';
              saveDraft(studentMessage, ready);
            }
            pretplDrop.style.display = 'none';
          });
          pretplList.appendChild(item);
        });
      }
      return;
    }

    if (preTplCategory === null) {
      // Главный экран: список категорий
      const counts = {};
      lib.forEach(t => { const c = t.category || 'general'; counts[c] = (counts[c] || 0) + 1; });
      CAT_ORDER.forEach(cat => {
        if (!counts[cat]) return;
        const item = document.createElement('div');
        item.className = 'ai-tpl-item ai-pretpl-cat-item';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = CATEGORY_LABELS[cat] || cat;
        const countSpan = document.createElement('span');
        countSpan.className = 'ai-pretpl-cat-count';
        countSpan.textContent = counts[cat];
        item.appendChild(nameSpan);
        item.appendChild(countSpan);
        item.addEventListener('click', e => { e.stopPropagation(); preTplCategory = cat; renderPreTplList(''); });
        pretplList.appendChild(item);
      });
      return;
    }

    // Список шаблонов выбранной категории
    const back = document.createElement('div');
    back.className = 'ai-pretpl-back-btn';
    back.textContent = '← Назад';
    back.addEventListener('click', e => { e.stopPropagation(); preTplCategory = null; renderPreTplList(''); });
    pretplList.appendChild(back);

    const catLabel = document.createElement('div');
    catLabel.className = 'ai-tpl-group-label';
    catLabel.textContent = CATEGORY_LABELS[preTplCategory] || preTplCategory;
    pretplList.appendChild(catLabel);

    const catTpls = lib.filter(t => (t.category || 'general') === preTplCategory);
    if (!catTpls.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-tpl-empty';
      empty.textContent = 'Нет шаблонов';
      pretplList.appendChild(empty);
    }
    catTpls.forEach(tpl => {
      const item = document.createElement('div');
      item.className = 'ai-tpl-item';
      if (selectedTemplate?.name === tpl.name) item.classList.add('ai-tpl-item-selected');
      item.textContent = tpl.name;
      item.title = tpl.text.slice(0, 140) + '…';
      item.addEventListener('click', () => {
        const deselect = selectedTemplate?.name === tpl.name;
        setSelectedTemplate(deselect ? null : tpl);
        if (!deselect) {
          const ready = applyTemplate(tpl);
          resultTA.value = ready;
          resultTA.dispatchEvent(new Event('input'));
          panel.style.display = 'block';
          saveDraft(studentMessage, ready);
        }
        pretplDrop.style.display = 'none';
      });
      pretplList.appendChild(item);
    });
  }

  pretplSearchInput.addEventListener('input', () => renderPreTplList(pretplSearchInput.value));

  function buildPreTplDropdown() {
    pretplSearchInput.value = '';
    preTplCategory = null;
    renderPreTplList('');
  }

  pretplPickBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (pretplDrop.style.display !== 'none') { pretplDrop.style.display = 'none'; return; }
    buildPreTplDropdown();

    // Позиционируем через fixed — чтобы не обрезался родительскими overflow
    const rect = pretplPickBtn.getBoundingClientRect();
    pretplDrop.style.position = 'fixed';
    pretplDrop.style.right = (window.innerWidth - rect.right) + 'px';
    pretplDrop.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    pretplDrop.style.left = 'auto';
    pretplDrop.style.top = 'auto';
    pretplDrop.style.display = 'block';

    setTimeout(() => pretplSearchInput.focus(), 50);
  });

  pretplClearBtn.addEventListener('click', () => setSelectedTemplate(null));

  // Закрытие дропдауна при клике вне (fixed-позиционирован, поэтому проверяем оба)
  document.addEventListener('click', e => {
    if (!e.target.closest('.ai-pretpl-pick-wrap') && !e.target.closest('.ai-pretpl-dropdown')) {
      pretplDrop.style.display = 'none';
    }
  }, { capture: false });

  if (savedDraft) {
    resultTA.value = savedDraft;
    wordCount.textContent = countWords(savedDraft) + ' сл.';
  }

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

  // Шаблоны — input создаётся один раз, список обновляется отдельно
  const tplSearchInput = document.createElement('input');
  tplSearchInput.className = 'ai-tpl-search';
  tplSearchInput.placeholder = 'Поиск шаблона...';
  tplSearchInput.addEventListener('click', e => e.stopPropagation());

  const tplSearchWrap = document.createElement('div');
  tplSearchWrap.className = 'ai-tpl-search-wrap';
  tplSearchWrap.appendChild(tplSearchInput);

  const tplList = document.createElement('div');
  tplDrop.appendChild(tplSearchWrap);
  tplDrop.appendChild(tplList);

  function renderTplList(query) {
    tplList.innerHTML = '';
    const insertTpl = tpl => {
      resultTA.value = resultTA.value ? resultTA.value + '\n\n' + tpl.text : tpl.text;
      resultTA.dispatchEvent(new Event('input'));
      tplDrop.style.display = 'none';
    };

    // Рекомендуемые (только без поискового запроса)
    const suggestedNames = new Set();
    if (!query && typeof findMatchingTemplates === 'function') {
      const suggested = findMatchingTemplates(studentMessage, 3).filter(isUsefulTemplate);
      if (suggested.length > 0) {
        const sugLabel = document.createElement('div');
        sugLabel.className = 'ai-tpl-group-label';
        sugLabel.textContent = '⭐ Рекомендуемые';
        tplList.appendChild(sugLabel);
        suggested.forEach(tpl => {
          suggestedNames.add(tpl.name);
          const item = document.createElement('div');
          item.className = 'ai-tpl-item ai-tpl-suggested';
          item.textContent = tpl.name;
          item.title = tpl.text.slice(0, 140) + '…';
          item.addEventListener('click', () => insertTpl(tpl));
          tplList.appendChild(item);
        });
      }
    }

    // Ручные шаблоны из настроек
    const manualTemplates = settings.templates || [];
    if (manualTemplates.length > 0) {
      const manLabel = document.createElement('div');
      manLabel.className = 'ai-tpl-group-label';
      manLabel.textContent = '📁 Мои шаблоны';
      tplList.appendChild(manLabel);
      manualTemplates.forEach(tpl => {
        if (query && !tpl.name.toLowerCase().includes(query.toLowerCase()) &&
            !tpl.text.toLowerCase().includes(query.toLowerCase())) return;
        const item = document.createElement('div');
        item.className = 'ai-tpl-item';
        item.textContent = tpl.name;
        item.addEventListener('click', () => insertTpl(tpl));
        tplList.appendChild(item);
      });
    }

    // Библиотека с группировкой по категориям
    const libTemplates = (typeof searchTemplates === 'function')
      ? searchTemplates(query || '')
      : (typeof TEMPLATES_LIBRARY !== 'undefined' ? TEMPLATES_LIBRARY : []);
    const filtered = libTemplates.filter(t => !suggestedNames.has(t.name) && isUsefulTemplate(t));

    if (filtered.length > 0) {
      renderTemplateItems(tplList, filtered.slice(0, 60), insertTpl);
      if (filtered.length > 60) {
        const more = document.createElement('div');
        more.className = 'ai-tpl-empty';
        more.textContent = `Ещё ${filtered.length - 60} — уточните поиск`;
        tplList.appendChild(more);
      }
    } else if (!manualTemplates.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-tpl-empty';
      empty.textContent = 'Ничего не найдено';
      tplList.appendChild(empty);
    }
  }

  tplSearchInput.addEventListener('input', () => renderTplList(tplSearchInput.value));

  function buildTemplateDropdown() {
    tplSearchInput.value = '';
    renderTplList('');
  }

  tplBtn.addEventListener('click', () => {
    if (tplDrop.style.display !== 'none') { tplDrop.style.display = 'none'; return; }
    buildTemplateDropdown();
    tplDrop.style.display = 'block';
    setTimeout(() => tplSearchInput.focus(), 50);
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
        wrap.dataset.length, wrap.dataset.tone, autoContext, selectedTemplate
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

  async function doAdaptTemplate() {
    if (!selectedTemplate) return;
    await loadSettings();
    const tpl = selectedTemplate;
    genBtn.disabled = true;
    wrap.querySelector('.ai-gen-label').textContent = 'Адаптирую...';
    panel.style.display = 'block';
    resultTA.value = 'ИИ адаптирует шаблон...';
    wordCount.textContent = '';
    regenBtn.disabled = true;
    adaptBtn.disabled = true;

    try {
      if (!studentMessage || studentMessage.length < 10) {
        throw new Error('Не удалось найти текст ученика. Попробуйте обновить страницу.');
      }
      const reply = await generateResponse(
        studentMessage, findName(block), settings.curatorName,
        wrap.dataset.length, wrap.dataset.tone, autoContext, tpl
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
      adaptBtn.disabled = false;
    }
  }

  genBtn.addEventListener('click', doGenerate);
  regenBtn.addEventListener('click', () => selectedTemplate ? doAdaptTemplate() : doGenerate());
  adaptBtn.addEventListener('click', doAdaptTemplate);
  wrap.addEventListener('ai-generate', doGenerate);

  closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(resultTA.value).then(() => {
      copyBtn.textContent = 'Скопировано!';
      setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 2000);
    }).catch(() => {
      showToast('Не удалось скопировать — нет доступа к буферу', 'error');
    });
  });

  return wrap;
}

function applyToggles() {
  document.querySelectorAll('.ai-sentiment-badge').forEach(b => {
    b.style.display = settings.togSentiment ? '' : 'none';
  });
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
}

// Debounce — scanPage не вызывается на каждое изменение DOM, а ждёт паузы в 300мс
let scanTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanPage, 300);
});
observer.observe(document.body, { childList: true, subtree: true });

loadSettings().then(() => scanPage());
