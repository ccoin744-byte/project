const TelegramBot = require('node-telegram-bot-api');
const axios      = require('axios');
const cheerio    = require('cheerio');
const iconv      = require('iconv-lite');
const fs         = require('fs');
const path       = require('path');

// ============================================================
//  ⚙️  НАСТРОЙКИ
// ============================================================
const BOT_TOKEN      = '8677571796:AAGO8cPscC3h0uOPHJFeCZnLlinQ5Iyb0YU';   // 👉 Токен от @BotFather
const ADMIN_PASSWORD = 'artem428642';             // 🔑 Пароль администратора
const SCHEDULE_URL   = 'https://rasp44.ru/rasp.htm';
const DATA_FILE      = path.join(__dirname, 'schedule_data.json');

// ⏰ Время автообновления (24-часовой формат)
const AUTO_UPDATE_TIMES = [
  { hour: 7,  minute: 0  },  // 07:00
  { hour: 14, minute: 0  },  // 14:00
];

// 📌 5А — 1-я смена, Пятница (колонка: 2 = предмет, 3 = кабинет)
// Структура строки: [время, номер, 5а_предмет, 5а_каб, 5б_предмет, 5б_каб, ...]
const CLASS_COL   = 2;   // индекс ячейки с предметом для 5А
const ROOM_COL    = 3;   // индекс ячейки с кабинетом для 5А
const TABLE_INDEX = 0;   // 0 = первая таблица на странице (1-я смена Пятница)
// ============================================================

const DAYS_RU = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];

// Иконки предметов
const SUBJECT_ICONS = {
  'математик':  '🔢',
  'алгебра':    '🔢',
  'геометри':   '📐',
  'русский':    '📝',
  'русск':      '📝',
  'литератур':  '📖',
  'английск':   '🇬🇧',
  'иностран':   '🌍',
  'история':    '🏛',
  'географи':   '🌍',
  'биологи':    '🌿',
  'химия':      '⚗️',
  'физика':     '⚡',
  'информатик': '💻',
  'технолог':   '🔧',
  'труд':       '🔧',
  'физкультур': '⚽',
  'физ-ра':     '⚽',
  'физра':      '⚽',
  'изо':        '🎨',
  'рисован':    '🎨',
  'музык':      '🎵',
  'обж':        '🦺',
  'обществ':    '👥',
  'классн':     '📋',
  'кл. час':    '📋',
};

function getSubjectIcon(subject) {
  const lower = subject.toLowerCase();
  for (const [key, icon] of Object.entries(SUBJECT_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '📚';
}

// ============================================================
//  💾 Хранилище данных
// ============================================================
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return {
    schedule:    null,  // { "1": { time, subject, room }, ... }
    overrides:   {},    // { "1": "текст урока" }   '' = удалён
    lastUpdated: null,
    admins:      [],
    subscribers: [],
  };
}

function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

let db = loadData();
const sessions = {};   // временные состояния пользователей

// ============================================================
//  🌐 Парсинг сайта
// ============================================================
async function fetchScheduleFromSite() {
  const res  = await axios.get(SCHEDULE_URL, { responseType: 'arraybuffer', timeout: 15000 });
  const html = iconv.decode(Buffer.from(res.data), 'win1251');
  const $    = cheerio.load(html);
  const tables = $('table');

  const table = $(tables[TABLE_INDEX]);
  if (!table.length) throw new Error(`Таблица с индексом ${TABLE_INDEX} не найдена`);

  const lessons = {};
  let headerPassed = false;

  table.find('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (!cells.length) return;

    const timeVal = $(cells[0]).text().trim();

    // Ждём строку с временем вида "8:00 - 8:30"
    if (!timeVal.match(/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/)) return;

    headerPassed = true;

    const num     = cells.length > 1 ? $(cells[1]).text().trim() : '?';
    const subject = CLASS_COL < cells.length ? $(cells[CLASS_COL]).text().trim() : '';
    const room    = ROOM_COL  < cells.length ? $(cells[ROOM_COL ]).text().trim() : '';

    if (num && subject) {
      lessons[num] = { time: timeVal, subject, room };
    }
  });

  if (!Object.keys(lessons).length) {
    throw new Error('Уроки для 5А не найдены. Проверьте TABLE_INDEX / CLASS_COL в настройках.');
  }

  return lessons;
}

// ============================================================
//  📋 Формирование текста расписания
// ============================================================
function buildScheduleText(forAdmin = false) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dayStr  = DAYS_RU[now.getDay()];
  const updStr  = db.lastUpdated
    ? `🕐 Обновлено: ${new Date(db.lastUpdated).toLocaleString('ru-RU')}`
    : '🕐 Ещё не обновлялось';

  const lines = [
    `🏫 Расписание 5А класса`,
    `📆 ${dateStr} — ${dayStr}`,
    updStr,
    `━━━━━━━━━━━━━━━━━━━━━━`,
  ];

  const base    = db.schedule  || {};
  const over    = db.overrides || {};
  const allKeys = [...new Set([...Object.keys(base), ...Object.keys(over)])]
    .sort((a, b) => Number(a) - Number(b));

  if (!allKeys.length) {
    lines.push('⚠️ Расписание пока не загружено.');
    lines.push('Используйте /update (только для администратора).');
    return lines.join('\n');
  }

  for (const num of allKeys) {
    const edited = forAdmin && num in over;

    if (num in over) {
      if (over[num] === '') {
        if (forAdmin) lines.push(`❌ ${num}. (урок удалён) ✏️`);
      } else {
        const icon = getSubjectIcon(over[num]);
        lines.push(`${icon} ${num}. ${over[num]}${forAdmin ? ' ✏️' : ''}`);
      }
    } else if (base[num]) {
      const { time, subject, room } = base[num];
      const icon    = getSubjectIcon(subject);
      const roomStr = room ? ` 🚪${room}` : '';
      lines.push(`${icon} ${num}. ${time} — ${subject}${roomStr}`);
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━━━`);

  if (forAdmin) lines.push('✏️ — урок изменён вручную');

  return lines.join('\n');
}

// ============================================================
//  🔄 Обновление расписания с сайта
// ============================================================
async function updateSchedule(notifyAdmins = false) {
  const ts = new Date().toLocaleString('ru-RU');
  console.log(`[${ts}] Обновление расписания...`);
  try {
    const lessons   = await fetchScheduleFromSite();
    db.schedule     = lessons;
    db.lastUpdated  = new Date().toISOString();
    saveData(db);
    console.log(`✅ Обновлено: ${Object.keys(lessons).length} уроков.`);
    console.log('Данные:', JSON.stringify(lessons, null, 2));

    const text = buildScheduleText();

    if (notifyAdmins)
      for (const id of db.admins)
        bot.sendMessage(id, `✅ Расписание автоматически обновлено!\n\n${text}`).catch(() => {});

    for (const id of db.subscribers)
      bot.sendMessage(id, `🔔 Расписание 5А обновлено!\n\n${text}`).catch(() => {});

    return true;
  } catch (err) {
    console.error('❌ Ошибка обновления:', err.message);
    return false;
  }
}

// Планировщик (проверка каждые 30 сек)
function scheduleAutoUpdate() {
  const triggered = {};
  setInterval(() => {
    const now = new Date();
    for (const t of AUTO_UPDATE_TIMES) {
      const key = `${t.hour}:${t.minute}:${now.toDateString()}`;
      if (now.getHours() === t.hour && now.getMinutes() === t.minute && !triggered[key]) {
        triggered[key] = true;
        updateSchedule(true);
      }
    }
  }, 30_000);

  const times = AUTO_UPDATE_TIMES
    .map(t => `${String(t.hour).padStart(2,'0')}:${String(t.minute).padStart(2,'0')}`).join(' и ');
  console.log(`⏰ Автообновление: ${times}`);
}

// ============================================================
//  ⌨️  Клавиатуры
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
//  🤖 Бот
// ============================================================
if (BOT_TOKEN === 'ВАШ_ТОКЕН_ЗДЕСЬ') {
  console.error('❌ Вставьте токен бота в переменную BOT_TOKEN!');
  process.exit(1);
}

const bot     = new TelegramBot(BOT_TOKEN, { polling: true });
const isAdmin = (id) => db.admins.includes(id);

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  sessions[msg.chat.id] = null;
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Я бот расписания *5А класса* 🏫\n\n' +
    '📋 /rasp — показать расписание\n' +
    '🔔 /subscribe — подписаться на обновления\n' +
    '🔕 /unsubscribe — отписаться\n' +
    '🔐 /admin — для администратора\n' +
    'ℹ️ /help — помощь',
    { parse_mode: 'Markdown', ...mainKeyboard() }
  );
});

// ── /help ────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    'ℹ️ *Команды бота:*\n\n' +
    '📋 /rasp — расписание 5А\n' +
    '🔔 /subscribe — подписаться на авторассылку\n' +
    '🔕 /unsubscribe — отписаться\n' +
    '🔐 /admin — войти как администратор\n\n' +
    '*Возможности администратора:*\n' +
    '🔄 Обновить расписание с сайта вручную\n' +
    '✏️ Изменить любой урок\n' +
    '🗑 Удалить урок\n' +
    '↩️ Сбросить все ручные правки',
    { parse_mode: 'Markdown' }
  );
});

// ── /rasp ────────────────────────────────────────────────────
bot.onText(/^(\/rasp|📋 Расписание)$/, (msg) => {
  bot.sendMessage(msg.chat.id, buildScheduleText(isAdmin(msg.chat.id)));
});

// ── /subscribe ───────────────────────────────────────────────
bot.onText(/^(\/subscribe|🔔 Подписаться)$/, (msg) => {
  const id = msg.chat.id;
  if (!db.subscribers.includes(id)) {
    db.subscribers.push(id); saveData(db);
    bot.sendMessage(id, '✅ Вы подписались!\nБуду присылать расписание при каждом обновлении 🔔');
  } else {
    bot.sendMessage(id, 'ℹ️ Вы уже подписаны.');
  }
});

// ── /unsubscribe ─────────────────────────────────────────────
bot.onText(/^(\/unsubscribe|🔕 Отписаться)$/, (msg) => {
  const id = msg.chat.id;
  db.subscribers = db.subscribers.filter(x => x !== id); saveData(db);
  bot.sendMessage(id, '🔕 Вы отписались от обновлений.');
});

// ── /admin ───────────────────────────────────────────────────
bot.onText(/\/admin/, (msg) => {
  const id = msg.chat.id;
  if (isAdmin(id)) { bot.sendMessage(id, '✅ Вы уже администратор.', adminKeyboard()); return; }
  sessions[id] = { state: 'awaiting_password' };
  bot.sendMessage(id, '🔐 Введите пароль администратора:', { reply_markup: { force_reply: true } });
});

// ── Машина состояний ─────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const id      = msg.chat.id;
  const text    = msg.text.trim();
  const session = sessions[id];

  // Пароль
  if (session?.state === 'awaiting_password') {
    sessions[id] = null;
    if (text === ADMIN_PASSWORD) {
      if (!db.admins.includes(id)) { db.admins.push(id); saveData(db); }
      bot.sendMessage(id, '✅ Добро пожаловать, администратор! 🔐', adminKeyboard());
    } else {
      bot.sendMessage(id, '❌ Неверный пароль.', mainKeyboard());
    }
    return;
  }

  // Выход из admin
  if (text === '👤 Выйти из admin') {
    db.admins = db.admins.filter(x => x !== id); saveData(db);
    sessions[id] = null;
    bot.sendMessage(id, '👋 Вы вышли из режима администратора.', mainKeyboard());
    return;
  }

  // Обновить с сайта
  if (text === '🔄 Обновить с сайта') {
    if (!isAdmin(id)) return;
    await bot.sendMessage(id, '⏳ Загружаю расписание с сайта...');
    const ok = await updateSchedule(false);
    bot.sendMessage(id,
      ok ? `✅ Расписание обновлено!\n\n${buildScheduleText(true)}` : '❌ Не удалось загрузить расписание.',
      adminKeyboard()
    );
    return;
  }

  // Изменить урок — запрос номера
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
      ? (db.overrides[num] || '(урок удалён)')
      : db.schedule?.[num]
        ? `${db.schedule[num].time} — ${db.schedule[num].subject}${db.schedule[num].room ? ` (каб. ${db.schedule[num].room})` : ''}`
        : '(пусто)';
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
    const { num } = session; sessions[id] = null;
    if (text === '-') {
      db.overrides[num] = '';
      bot.sendMessage(id, `🗑 Урок №${num} удалён.`, adminKeyboard());
    } else {
      db.overrides[num] = text;
      bot.sendMessage(id, `✅ Урок №${num} изменён:\n${num}. ${text}`, adminKeyboard());
    }
    saveData(db);
    return;
  }

  // Удалить урок
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

  // Сбросить правки
  if (text === '↩️ Сбросить правки') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'confirm_reset' };
    bot.sendMessage(id,
      '⚠️ Все ручные изменения будут удалены, расписание вернётся к данным с сайта.\nВведите *ДА* для подтверждения:',
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
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

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// ============================================================
//  🚀 Запуск
// ============================================================
updateSchedule(false).then((ok) => {
  if (ok) console.log('✅ Расписание загружено при старте.');
  else    console.warn('⚠️ Расписание не удалось загрузить при старте. Попробую позже.');
  console.log('🤖 Бот запущен! Нажмите Ctrl+C для остановки.');
});
scheduleAutoUpdate();
