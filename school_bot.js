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
const ADMIN_PASSWORD = '428642';             // 🔑 Пароль администратора
const SCHEDULE_URL   = 'https://rasp44.ru/rasp.htm';
const DATA_FILE      = path.join(__dirname, 'schedule_data.json');

// ⏰ Время автообновления (24-часовой формат)
const AUTO_UPDATE_TIMES = [
  { hour: 7,  minute: 0 },
  { hour: 14, minute: 0 },
];
// ============================================================

const DAYS_RU = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];

// Иконки предметов
const SUBJECT_ICONS = {
  'матем':      '🔢',
  'алгебр':     '🔢',
  'геометр':    '📐',
  'русск':      '📝',
  'литерат':    '📖',
  'английск':   '🇬🇧',
  'иностран':   '🌍',
  'истори':     '🏛',
  'географи':   '🗺',
  'биологи':    '🌿',
  'хими':       '⚗️',
  'физик':      '⚡',
  'информат':   '💻',
  'технолог':   '🔧',
  'труд':       '🔧',
  'физкульт':   '⚽',
  'физ-ра':     '⚽',
  'физра':      '⚽',
  'изо':        '🎨',
  'рисован':    '🎨',
  'музык':      '🎵',
  'обж':        '🦺',
  'обществ':    '👥',
  'кл. час':    '📋',
  'классн':     '📋',
};

function getIcon(subject) {
  const s = subject.toLowerCase();
  for (const [key, icon] of Object.entries(SUBJECT_ICONS)) {
    if (s.includes(key)) return icon;
  }
  return '📚';
}

// ============================================================
//  💾  Хранилище
// ============================================================
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  return { schedule: null, overrides: {}, lastUpdated: null, admins: [], subscribers: [] };
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2), 'utf8'); }

let db = loadData();
const sessions = {};

// ============================================================
//  🌐  Парсинг сайта
// ============================================================
async function fetchScheduleFromSite() {
  const res  = await axios.get(SCHEDULE_URL, { responseType: 'arraybuffer', timeout: 15000 });
  const html = iconv.decode(Buffer.from(res.data), 'win1251');
  const $    = cheerio.load(html);

  const lessons = {};

  // Перебираем все таблицы — ищем ту, где есть заголовок "5а"
  $('table').each((tIdx, table) => {
    if (Object.keys(lessons).length > 0) return; // уже нашли — стоп

    // Работаем ТОЛЬКО с прямыми дочерними строками этой таблицы (не вложенных таблиц)
    const rows = $(table).children('tbody, thead').children('tr').add($(table).children('tr'));

    let classColIdx  = -1;
    let headerRowIdx = -1;

    // Шаг 1: найти строку-заголовок с "5а"
    rows.each((rIdx, row) => {
      if (classColIdx !== -1) return;
      // Только прямые ячейки этой строки
      const cells = $(row).children('td, th');
      cells.each((cIdx, cell) => {
        const t = $(cell).text().trim().toLowerCase().replace(/\s+/g, '');
        if (t === '5а' || t === '5a') {
          classColIdx  = cIdx;
          headerRowIdx = rIdx;
          console.log(`[Парсер] Нашёл "5а" в таблице #${tIdx}, строке #${rIdx}, колонке #${cIdx}`);
          return false; // break
        }
      });
    });

    if (classColIdx === -1) return; // нет 5А в этой таблице — идём дальше

    // Шаг 2: читаем уроки ТОЛЬКО из строк ЭТОЙ же таблицы после заголовка
    // Как только встречаем строку без времени — останавливаемся (конец блока)
    let lessonCount = 0;

    rows.each((rIdx, row) => {
      if (rIdx <= headerRowIdx) return; // пропускаем заголовок и всё до него

      const cells = $(row).children('td, th');
      if (cells.length === 0) return;

      const time = $(cells.eq(0)).text().trim();

      // Строка с уроком: время в формате "8:00 - 8:30" или "10:30 - 11:10"
      if (!/^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}$/.test(time)) {
        // Если уже нашли хотя бы один урок и наткнулись на нетиповую строку — стоп
        if (lessonCount > 0) return false; // break — выходим из цикла rows
        return; // continue — ещё не начали, пропускаем
      }

      const num     = cells.length > 1 ? $(cells.eq(1)).text().trim() : '?';
      const subject = classColIdx < cells.length
        ? $(cells.eq(classColIdx)).text().trim() : '';
      const room    = (classColIdx + 1) < cells.length
        ? $(cells.eq(classColIdx + 1)).text().trim() : '';

      console.log(`[Парсер] Урок ${num}: "${time}" | "${subject}" | каб. "${room}"`);

      if (num && subject) {
        lessons[num] = { time, subject, room };
        lessonCount++;
      }
    });
  });

  if (!Object.keys(lessons).length) {
    throw new Error('Уроки для 5А не найдены! Проверьте структуру сайта.');
  }

  return lessons;
}

// ============================================================
//  📋  Текст расписания
// ============================================================
function buildScheduleText(forAdmin = false) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const dayStr  = DAYS_RU[now.getDay()];
  const updStr  = db.lastUpdated
    ? `🕐 ${new Date(db.lastUpdated).toLocaleString('ru-RU')}`
    : '🕐 Не обновлялось';

  const lines = [
    `🏫 *Расписание 5А класса*`,
    `📆 ${dateStr} — ${dayStr}`,
    updStr,
    `━━━━━━━━━━━━━━━━━━━`,
  ];

  const base  = db.schedule  || {};
  const over  = db.overrides || {};
  const keys  = [...new Set([...Object.keys(base), ...Object.keys(over)])]
    .sort((a, b) => Number(a) - Number(b));

  if (!keys.length) {
    lines.push('⚠️ Расписание не загружено.');
    return lines.join('\n');
  }

  for (const num of keys) {
    if (num in over) {
      if (over[num] === '') {
        if (forAdmin) lines.push(`❌ ${num}. _(урок удалён)_ ✏️`);
      } else {
        const icon = getIcon(over[num]);
        lines.push(`${icon} *${num}.* ${over[num]}${forAdmin ? ' ✏️' : ''}`);
      }
    } else if (base[num]) {
      const { time, subject, room } = base[num];
      const icon    = getIcon(subject);
      const roomStr = room ? ` 🚪каб. ${room}` : '';
      lines.push(`${icon} *${num}.* ${time} — ${subject}${roomStr}`);
    }
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  if (forAdmin) lines.push('_✏️ — изменено вручную_');

  return lines.join('\n');
}

// ============================================================
//  🔄  Автообновление
// ============================================================
async function updateSchedule(notifyAdmins = false) {
  console.log(`[${new Date().toLocaleString('ru-RU')}] Обновление расписания...`);
  try {
    const lessons  = await fetchScheduleFromSite();
    db.schedule    = lessons;
    db.lastUpdated = new Date().toISOString();
    saveData(db);
    console.log(`✅ Сохранено ${Object.keys(lessons).length} уроков.`);

    const text = buildScheduleText();
    if (notifyAdmins)
      for (const id of db.admins)
        bot.sendMessage(id, `✅ Расписание обновлено!\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {});

    for (const id of db.subscribers)
      bot.sendMessage(id, `🔔 Расписание 5А обновлено!\n\n${text}`, { parse_mode: 'Markdown' }).catch(() => {});

    return true;
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return false;
  }
}

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
  const times = AUTO_UPDATE_TIMES.map(t =>
    `${String(t.hour).padStart(2,'0')}:${String(t.minute).padStart(2,'0')}`).join(' и ');
  console.log(`⏰ Автообновление: ${times}`);
}

// ============================================================
//  ⌨️  Клавиатуры
// ============================================================
const mainKeyboard = () => ({
  reply_markup: {
    keyboard: [['📋 Расписание'], ['🔔 Подписаться', '🔕 Отписаться']],
    resize_keyboard: true,
  },
});

const adminKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ['📋 Расписание',    '🔄 Обновить с сайта'],
      ['✏️ Изменить урок', '🗑 Удалить урок'    ],
      ['↩️ Сбросить правки','👤 Выйти из admin' ],
    ],
    resize_keyboard: true,
  },
});

// ============================================================
//  🤖  Бот
// ============================================================
if (BOT_TOKEN === 'ВАШ_ТОКЕН_ЗДЕСЬ') {
  console.error('❌ Вставьте токен бота в BOT_TOKEN!');
  process.exit(1);
}

const bot     = new TelegramBot(BOT_TOKEN, { polling: true });
const isAdmin = id => db.admins.includes(id);

bot.onText(/\/start/, msg => {
  sessions[msg.chat.id] = null;
  bot.sendMessage(msg.chat.id,
    '👋 Привет\\! Я бот расписания *5А класса* 🏫\n\n' +
    '📋 /rasp — расписание\n' +
    '🔔 /subscribe — подписаться на обновления\n' +
    '🔕 /unsubscribe — отписаться\n' +
    '🔐 /admin — для администратора',
    { parse_mode: 'MarkdownV2', ...mainKeyboard() }
  );
});

bot.onText(/^(\/rasp|📋 Расписание)$/, msg => {
  bot.sendMessage(msg.chat.id, buildScheduleText(isAdmin(msg.chat.id)), { parse_mode: 'Markdown' });
});

bot.onText(/^(\/subscribe|🔔 Подписаться)$/, msg => {
  const id = msg.chat.id;
  if (!db.subscribers.includes(id)) {
    db.subscribers.push(id); saveData(db);
    bot.sendMessage(id, '✅ Подписались! Буду присылать расписание при обновлении 🔔');
  } else {
    bot.sendMessage(id, 'ℹ️ Вы уже подписаны.');
  }
});

bot.onText(/^(\/unsubscribe|🔕 Отписаться)$/, msg => {
  const id = msg.chat.id;
  db.subscribers = db.subscribers.filter(x => x !== id); saveData(db);
  bot.sendMessage(id, '🔕 Вы отписались.');
});

bot.onText(/\/admin/, msg => {
  const id = msg.chat.id;
  if (isAdmin(id)) { bot.sendMessage(id, '✅ Вы уже администратор.', adminKeyboard()); return; }
  sessions[id] = { state: 'awaiting_password' };
  bot.sendMessage(id, '🔐 Введите пароль:', { reply_markup: { force_reply: true } });
});

// Машина состояний
bot.on('message', async msg => {
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

  if (text === '👤 Выйти из admin') {
    db.admins = db.admins.filter(x => x !== id); saveData(db);
    sessions[id] = null;
    bot.sendMessage(id, '👋 Вы вышли.', mainKeyboard());
    return;
  }

  if (text === '🔄 Обновить с сайта') {
    if (!isAdmin(id)) return;
    await bot.sendMessage(id, '⏳ Загружаю...');
    const ok = await updateSchedule(false);
    bot.sendMessage(id,
      ok ? buildScheduleText(true) : '❌ Не удалось загрузить расписание.',
      { parse_mode: 'Markdown', ...adminKeyboard() }
    );
    return;
  }

  // Изменить урок — шаг 1: номер
  if (text === '✏️ Изменить урок') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'edit_num' };
    bot.sendMessage(id,
      buildScheduleText(true) + '\n\n✏️ Введите *номер урока* для изменения:',
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  if (session?.state === 'edit_num') {
    const num = text.replace(/\D/g, '');
    if (!num) { bot.sendMessage(id, '❌ Введите число.'); return; }
    const cur = db.overrides[num] !== undefined
      ? (db.overrides[num] || '(удалён)')
      : db.schedule?.[num]
        ? `${db.schedule[num].time} — ${db.schedule[num].subject} каб.${db.schedule[num].room}`
        : '(нет данных)';
    sessions[id] = { state: 'edit_text', num };
    bot.sendMessage(id,
      `📝 Урок №*${num}*\nСейчас: _${cur}_\n\nВведите новое значение:\n` +
      '`8:00 - 8:30 — Математика (каб. 201)`\n\nИли `-` для удаления.',
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  // Изменить урок — шаг 2: новый текст
  if (session?.state === 'edit_text') {
    const { num } = session; sessions[id] = null;
    db.overrides[num] = text === '-' ? '' : text;
    saveData(db);
    bot.sendMessage(id,
      text === '-' ? `🗑 Урок №${num} удалён.` : `✅ Урок №${num}:\n${num}. ${text}`,
      adminKeyboard()
    );
    return;
  }

  // Удалить урок
  if (text === '🗑 Удалить урок') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'delete_num' };
    bot.sendMessage(id,
      buildScheduleText(true) + '\n\n🗑 Введите *номер урока* для удаления:',
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

  // Сброс правок
  if (text === '↩️ Сбросить правки') {
    if (!isAdmin(id)) return;
    sessions[id] = { state: 'confirm_reset' };
    bot.sendMessage(id, '⚠️ Все ручные изменения удалятся.\nВведите *ДА* для подтверждения:',
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
    );
    return;
  }

  if (session?.state === 'confirm_reset') {
    sessions[id] = null;
    if (text.toLowerCase() === 'да') {
      db.overrides = {}; saveData(db);
      bot.sendMessage(id, '✅ Правки сброшены.', adminKeyboard());
    } else {
      bot.sendMessage(id, '↩️ Отменено.', adminKeyboard());
    }
    return;
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

// ============================================================
//  🚀  Старт
// ============================================================
updateSchedule(false).then(ok => {
  if (!ok) console.warn('⚠️ Расписание не загружено при старте.');
  console.log('🤖 Бот работает! Ctrl+C для остановки.');
});
scheduleAutoUpdate();
