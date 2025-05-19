import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
import leoProfanity from 'leo-profanity';

dotenv.config();
leoProfanity.loadDictionary('ru');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Настройка базы данных
const adapter = new JSONFile('./db.json');
const db = new Low(adapter);
await db.read();

// Инициализация базы данных, если она пустая
if (!db.data) {
  db.data = {
    pairs: [],  // Инициализируем массив pairs
    filters: ['цена', 'срочно', 'без посредников', 'торг', 'недорого'],
    admins: [],
    forwardingEnabled: true
  };
  await db.write();
}

// Функция для проверки и получения связки по sourceChatId
function getPairBySource(sourceChatId) {
  return db.data.pairs ? db.data.pairs.find(p => p.source === sourceChatId) : null;
}

// Команда: добавить связку (источник → получатели)
bot.command('add_pair', async (ctx) => {
  const [source, ...targets] = ctx.message.text.split(' ').slice(1);
  if (!source || targets.length === 0) {
    return ctx.reply('❌ Укажите: /add_pair <source_chat_id> <target_chat_id_1> <target_chat_id_2> ...');
  }

  const sourceChatId = parseInt(source);
  const targetChatIds = targets.map(id => parseInt(id));

  // Убедимся, что db.data.pairs существует
  if (!db.data.pairs) {
    db.data.pairs = [];  // Инициализируем если нет
  }

  let pair = getPairBySource(sourceChatId);
  if (pair) {
    // Добавляем новые целевые группы, если они ещё не добавлены
    targetChatIds.forEach(target => {
      if (!pair.targets.includes(target)) {
        pair.targets.push(target);
      }
    });
  } else {
    // Создаем новую связку
    db.data.pairs.push({ source: sourceChatId, targets: targetChatIds });
  }

  await db.write();
  ctx.reply(`✅ Связка добавлена: ${sourceChatId} → ${targetChatIds.join(', ')}`);
});

// Команда: удалить одну связку (источник → получатель)
bot.command('remove_pair', async (ctx) => {
  const [source, target] = ctx.message.text.split(' ').slice(1);
  if (!source || !target) {
    return ctx.reply('❌ Укажите: /remove_pair <source_chat_id> <target_chat_id>');
  }

  const sourceChatId = parseInt(source);
  const targetChatId = parseInt(target);

  const pair = getPairBySource(sourceChatId);
  if (pair) {
    pair.targets = pair.targets.filter(id => id !== targetChatId);
    if (pair.targets.length === 0) {
      db.data.pairs = db.data.pairs.filter(p => p.source !== sourceChatId);
    }
    await db.write();
    ctx.reply(`✅ Связка удалена: ${sourceChatId} → ${targetChatId}`);
  } else {
    ctx.reply('❌ Связка не найдена.');
  }
});

// Команда: список всех связок
bot.command('list_pairs', (ctx) => {
  const pairs = db.data.pairs || [];  // Проверка на существование pairs
  const pairsList = pairs.map(pair => {
    return `🔗 Источник: ${pair.source}\n➡️ Получатели: ${pair.targets.join(', ')}`;
  }).join('\n\n');

  ctx.reply(pairsList || '❌ Нет активных связок.');
});

// Обработка сообщений
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;

  if (!db.data.forwardingEnabled) return;

  const msg = ctx.message;
  let text = msg.text || msg.caption || '';
  const lowerText = text.toLowerCase();

  // Фильтры
  const hasManualFilter = db.data.filters.some(word => lowerText.includes(word.toLowerCase()));
  const hasProfanity = leoProfanity.check(text);
  if (hasManualFilter || hasProfanity) return;

  // Находим связку для этого источника
  const pair = getPairBySource(chatId);
  if (!pair) return;

  // Очистка текста от адресов, телефонов и слов-исключений
  const phoneRegex = /(?:\+?\d{1,3})?[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}/g;
  const addressRegex = /(ул\.|улица|проспект|пр-т|пер\.|переулок|г\.|город|д\.|дом)[^\n,.!?]*/gi;
  const excludedWords = db.data.filters;

  function cleanText(input) {
    let output = input;
    output = output.replace(phoneRegex, '');
    output = output.replace(addressRegex, '');
    excludedWords.forEach(word => {
      const wordRegex = new RegExp(word, 'gi');
      output = output.replace(wordRegex, '');
    });
    return output.trim();
  }

  const cleanedText = cleanText(text);
  if (!cleanedText) return;

  // Пересылаем сообщение в соответствующие целевые группы
  for (const targetChatId of pair.targets) {
    try {
      if (msg.text || msg.caption) {
        await bot.telegram.sendMessage(targetChatId, cleanedText);
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await bot.telegram.sendPhoto(targetChatId, photo.file_id, {
          caption: cleanedText
        });
      } else if (msg.video) {
        await bot.telegram.sendVideo(targetChatId, msg.video.file_id, {
          caption: cleanedText
        });
      } else if (msg.document) {
        await bot.telegram.sendDocument(targetChatId, msg.document.file_id, {
          caption: cleanedText
        });
      } else if (msg.audio) {
        await bot.telegram.sendAudio(targetChatId, msg.audio.file_id);
      } else if (msg.voice) {
        await bot.telegram.sendVoice(targetChatId, msg.voice.file_id);
      }
    } catch (err) {
      console.error('❌ Ошибка при пересылке:', err);
    }
  }
});

bot.launch();
console.log('🤖 Бот запущен');
