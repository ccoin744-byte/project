const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const fs = require('fs');
const path = require('path');

// ============================================================
//  НАСТРОЙКИ — измените под себя
// ============================================================
const BOT_TOKEN      = '8677571796:AAGO8cPscC3h0uOPHJFeCZnLlinQ5Iyb0YU';   // Токен от @BotFather
const ADMIN_PASSWORD = 'artem428642';             // Пароль администратора
const SCHEDULE_URL   = 'https://rasp44.ru/rasp.htm';
const DATA_FILE      = path.join(__dirname, 'schedule_data.json');

// Время автообновления (24-часовой формат)
const AUTO_UPDATE_TIMES = [
  { hour: 7,  minute: 0 },   // 07:00
  { hour: 14, minute: 0 },   // 14:00
];
// ============================================================

const DAYS_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

// ============================================================
//  Хранилище данных (JSON-файл)
// ============================================================
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return {
    schedule: null,     // Расписание с сайта { "1": {time, subject, room}, ... }
    overrides: {},      // Ручные правки      { "1": "08:00 - 08:30 — Математика (каб. 201)" }
    lastUpdated: null,  // ISO-строка последнего обновления
    admins: [],         // chat_id авторизованных админов
    subscribers: [],    // chat_id подписчиков на авторассылку
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let db = loadData();

// Временные сессии пользователей { chatId: { state, ...data } }
const sessions = {};

// ============================================================
//  Парсинг расписания с сайта
// ============================================================
async function fetchScheduleFromSite() {
  const response = await axios.get(SCHEDULE_URL, {
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  const html = iconv.decode(Buffer.from(response.data), 'win1251');
  const $ = cheerio.load(html);

  let lessons = {};
  let found = false;

  $('table').each((_, table) => {
    if (found) return;

    const rows = $(table).find('tr');
    let col5a = null;
    let headerRowIdx = null;

    rows.each((ri, row) => {
      if (col5a !== null) return;
      $(row).find('td, th').each((ci, cell) => {
        const t = $(cell).text().trim().toLowerCase().replace(/\s/g, '');
        if (t === '5а' || t === '5a') {
          col5a = ci; headerRowIdx = ri; return false;
        }
      });
    });

    if (col5a === null) return;
    found = true;

    rows.each((ri, row) => {
      if (ri <= headerRowIdx) return;
      const cells = $(row).find('td, th');
      if (!cells.length) return;

      const timeVal = $(cells[0]).text().trim();
      if (!timeVal.includes('-') || !timeVal.includes(':')) return;

      const num     = cells.length > 1 ? $(cells[1]).text().trim() : '?';
      const subject = col5a < cells.length     ? $(cells[col5a]).text().trim()     : '';
      const room    = col5a + 1 < cells.length ? $(cells[col5a + 1]).text().trim() : '';

      if (subject && num) lessons[num] = { time: timeVal, subject, room };
    });
  });

  return found ? lessons : null;
}

// ============================================================
//  Формирование текста расписания
// ============================================================
function buildScheduleText(forAdmin = false) {
  const now      = new Date();
  const dateStr  = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dayStr   = DAYS_RU[now.getDay()];
  const updStr   = db.lastUpdated
    ? `🕐 Обновлено: ${new Date(db.lastUpdated).toLocaleString('ru-RU')}`
    : '🕐 Ещё не обновлялось';

  const lines = [`📅 Расписание 5А класса`, `📆 ${dateStr}, ${dayStr}`, updStr, ''];

  const base      = db.schedule   || {};
  const overrides = db.overrides  || {};
  const allKeys   = [...new Set([...Object.keys(base), ...Object.keys(overrides)])]
    .sort((a, b) => Number(a) - Number(b));

  if (!allKeys.length) {
    lines.push('⚠️ Расписание пока не загружено.');
    lines.push('Используйте кнопку «🔄 Обновить с сайта» (только для администратора).');
    return lines.join('\n');
  }

  for (const num of allKeys) {
    if (num in overrides) {
      if (overrides[num] === '') {
        if (forAdmin) lines.push(`${num}. — (урок удалён) ✏️`);
      } else {
        lines.push(`${num}. ${overrides[num]}${forAdmin ? ' ✏️' : ''}`);
      }
    } else if (base[num]) {
      const { time, subject, room } = base[num];
      lines.push(`${num}. ${time} — ${subject}${room ? ` (каб. ${room})` : ''}`);
    }
  }

  if (forAdmin) { lines.push(''); lines.push('✏️ — урок изменён вручную'); }
  return lines.join('\n');
}

// ============================================================
//  Авто-обновление расписания
// ============================================================
async function updateSchedule(notifyAdmins = false) {
  console.log(`[${new Date().toLocaleString('ru-RU')}] Обновление расписания...`);
  try {
    const lessons = await fetchScheduleFromSite();
    if (!lessons) { console.warn('⚠️ 5А не найдена на сайте.'); return false; }

    db.schedule    = lessons;
    db.lastUpdated = new Date().toISOString();
    saveData(db);
    console.log(`✅ Обновлено (${Object.keys(lessons).length} уроков).`);

    const text = buildScheduleText();

    if (notifyAdmins) {
      for (const id of db.admins)
        bot.sendMessage(id, `✅ Расписание автоматически обновлено.\n\n${text}`).catch(() => {});
    }
    for (const id of db.subscribers)
      bot.sendMessage(id, `🔔 Расписание 5А обновлено!\n\n${text}`).catch(() => {});

    return true;
  } catch (err) {
    console.error('❌ Ошибка обновления:', err.message);
    return false;
  }
}

function scheduleAutoUpdate() {
  let lastTriggered = {};
  setInterval(() => {
    const now = new Date();
    const key = `${now.getHours()}:${now.getMinutes()}`;
    for (const t of AUTO_UPDATE_TIMES) {
      const tKey = `${t.hour}:${t.minute}`;
      if (now.getHours() === t.hour && now.getMinutes() === t.minute && lastTriggered[tKey] !== now.toDateString()) {
        lastTriggered[tKey] = now.toDateString();
        updateSchedule(true);
      }
    }
  }, 30 * 1000); // Проверка каждые 30 секунд

  const times = AUTO_UPDATE_TIMES.map(t => `${String(t.hour).padStart(2,'0')}:${String(t.minute).padStart(2,'0')}`).join(', ');
  console.log(`⏰ Автообновление: ${times}`);
}

// ============================================================
//  Клавиатуры
// ============================================================
const mainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['📋 Расписание'],
      ['🔔 Подписаться', '🔕 Отписаться'],
    ],
    resize_keyboard: true,
  },
});

const adminKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['📋 Расписание', '🔄 Обновить с сайта'],
      ['✏️ Изменить урок', '🗑 Удалить урок'],
      ['↩️ Сбросить правки', '👤 Выйти из admin'],
    ],
    resize_keyboard: true,
  },
});

// ============================================================
//  Запуск бота
// ============================================================
if (BOT_TOKEN === 'ВАШ_ТОКЕН_ЗДЕСЬ') {
  console.error('❌ Вставьте токен бота в переменную BOT_TOKEN!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const isAdmin = (id) => db.admins.includes(id);

// ============================================================
//  Команды
// ============================================================
bot.onText(/\/start/, (msg) => {
  sessions[msg.chat.id] = null;
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Я бот расписания *5А класса*.\n\n' +
    '/rasp — расписание\n/subscribe — подписка на обновления\n/admin — для администратора\n/help — помощь',
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'ℹ️ *Команды:*\n\n' +
    '📋 /rasp — расписание 5А\n' +
    '🔔 /subscribe — подписаться на авторассылку\n' +
    '🔕 /unsubscribe — отписаться\n' +
    '🔐 /admin — вход для администратора\n\n' +
    '*Возможности администратора:*\n' +
    '• Принудительное обновление с сайта\n' +
    '• Изменение любого урока вручную\n' +
    '• Удаление урока\n' +
    '• Сброс ручных правок',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^(\/rasp|📋 Расписание)$/, (msg) => {
  bot.sendMessage(msg.chat.id, buildScheduleText(isAdmin(msg.chat.id)));
});

bot.onText(/^(\/subscribe|🔔 Подписаться)$/, (msg) => {
  const id = msg.chat.id;
  if (!db.subscribers.includes(id)) {
    db.subscribers.push(id); saveData(db);
    bot.sendMessage(id, '✅ Вы подписались на автообновления расписания!');
  } else {
    bot.sendMessage(id, 'ℹ️ Вы уже подписаны.');
  }
});

bot.onText(/^(\/unsubscribe|🔕 Отписаться)$/, (msg) => {
  const id = msg.chat.id;
  db.subscribers = db.subscribers.filter(x => x !== id); saveData(db);
  bot.sendMessage(id, '🔕 Вы отписались от обновлений.');
});

bot.onText(/\/admin/, (msg) => {
  const id = msg.chat.id;
  if (isAdmin(id)) { bot.sendMessage(id, '✅ Вы уже в режиме администратора.', adminKeyboard()); return; }
  sessions[id] = { state: 'awaiting_password' };
  bot.sendMessage(id, '🔐 Введите пароль администратора:', { reply_markup: { force_reply: true } });
});

// ============================================================
//  Универсальный обработчик сообщений (машина состояний)
// ============================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const id      = msg.chat.id;
  const text    = msg.text.trim();
  const session = sessions[id];

  // ── Ввод пароля ──────────────────────────────────────────
  if (session?.state === 'awaiting_password') {
    sessions[id] = null;
    if (text === ADMIN_PASSWORD) {
      if (!db.admins.includes(id)) { db.admins.push(id); saveData(db); }
      bot.sendMessage(id, '✅ Добро пожаловать, администратор!', adminKeyboard());
    } else {
      bot.sendMessage(id, '❌ Неверный пароль.', mainKeyboard());
    }
    return;
  }

  // ── Выход из admin ───────────────────────────────────────
  if (text === '👤 Выйти из admin') {
    db.admins = db.admins.filter(x => x !== id); saveData(db);
    sessions[id] = null;
    bot.sendMessage(id, '👋 Вы вышли из режима администратора.', mainKeyboard());
    return;
  }

  // ── Обновить с сайта ─────────────────────────────────────
  if (text === '🔄 Обновить с сайта') {
    if (!isAdmin(id)) return;
    await bot.sendMessage(id, '⏳ Загружаю расписание с сайта...');
    const ok = await updateSchedule(false);
    bot.sendMessage(id, ok ? `✅ Готово!\n\n${buildScheduleText(true)}` : '❌ Не удалось загрузить расписание.', adminKeyboard());
    return;
  }

  // ── Изменить урок: запрос номера ─────────────────────────
  if (text === '✏️ Изменить урок') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'edit_num' };
    bot.sendMessage(id,
      `${buildScheduleText(true)}\n\n✏️ Введите *номер урока* для изменения:`,
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  if (session?.state === 'edit_num') {
    const num = text.replace(/\D/g, '');
    if (!num) { bot.sendMessage(id, '❌ Введите число.'); return; }
    const cur = db.overrides[num] !== undefined
      ? db.overrides[num] || '(урок удалён)'
      : db.schedule?.[num] ? `${db.schedule[num].time} — ${db.schedule[num].subject}${db.schedule[num].room ? ` (каб. ${db.schedule[num].room})` : ''}` : '(пусто)';
    sessions[id] = { state: 'edit_text', num };
    bot.sendMessage(id,
      `📝 Урок №${num}\nСейчас: *${cur}*\n\n` +
      'Введите новое значение.\nПример: `08:00 - 08:30 — Математика (каб. 201)`\n\n' +
      'Или `-` чтобы удалить урок.',
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  if (session?.state === 'edit_text') {
    const { num } = session;
    sessions[id]  = null;
    db.overrides[num] = text === '-' ? '' : text;
    saveData(db);
    const msg2 = text === '-' ? `🗑 Урок №${num} удалён.` : `✅ Урок №${num} изменён:\n${num}. ${text}`;
    bot.sendMessage(id, msg2, adminKeyboard());
    return;
  }

  // ── Удалить урок ─────────────────────────────────────────
  if (text === '🗑 Удалить урок') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'delete_num' };
    bot.sendMessage(id,
      `${buildScheduleText(true)}\n\n🗑 Введите *номер урока* для удаления:`,
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  if (session?.state === 'delete_num') {
    const num = text.replace(/\D/g, '');
    if (!num) { bot.sendMessage(id, '❌ Введите число.'); return; }
    sessions[id] = null;
    db.overrides[num] = ''; saveData(db);
    bot.sendMessage(id, `✅ Урок №${num} удалён.`, adminKeyboard());
    return;
  }

  // ── Сбросить правки ──────────────────────────────────────
  if (text === '↩️ Сбросить правки') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'confirm_reset' };
    bot.sendMessage(id, '⚠️ Все ручные изменения будут удалены.\nВведите *ДА* для подтверждения:', {
      parse_mode: 'Markdown', reply_markup: { force_reply: true },
    });
    return;
  }

  if (session?.state === 'confirm_reset') {
    sessions[id] = null;
    if (text.toLowerCase() === 'да') {
      db.overrides = {}; saveData(db);
      bot.sendMessage(id, '✅ Все ручные правки сброшены.', adminKeyboard());
    } else {
      bot.sendMessage(id, '↩️ Сброс отменён.', adminKeyboard());
    }
    return;
  }
});

// ============================================================
//  Ошибки поллинга
// ============================================================
bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// ============================================================
//  Инициализация
// ============================================================
updateSchedule(false).then(() => {
  console.log('✅ Бот запущен! Нажмите Ctrl+C для остановки.');
});
scheduleAutoUpdate();
