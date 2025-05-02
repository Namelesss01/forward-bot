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

if (!db.data) {
  db.data = {
    sourceGroups: [],
    targetGroups: [],
    filters: [],
    forwardingEnabled: true
  };
  await db.write();
}

// Команда: добавить источник
bot.command('add_source', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!db.data.sourceGroups.includes(chatId)) {
    db.data.sourceGroups.push(chatId);
    await db.write();
    ctx.reply('✅ Группа добавлена как источник.');
  } else {
    ctx.reply('ℹ️ Этот источник уже добавлен.');
  }
});

// Команда: добавить получателя
bot.command('add_target', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!db.data.targetGroups.includes(chatId)) {
    db.data.targetGroups.push(chatId);
    await db.write();
    ctx.reply('✅ Группа добавлена как получатель.');
  } else {
    ctx.reply('ℹ️ Эта группа уже добавлена.');
  }
});

// Команда: добавить слово-фильтр
bot.command('add_filter', async (ctx) => {
  const word = ctx.message.text.split(' ')[1];
  if (!word) return ctx.reply('❌ Укажите слово после команды.');
  if (!db.data.filters.includes(word)) {
    db.data.filters.push(word);
    await db.write();
    ctx.reply(`✅ Слово "${word}" добавлено в фильтр.`);
  } else {
    ctx.reply(`ℹ️ Слово "${word}" уже в фильтре.`);
  }
});

// Команда: включить / выключить пересылку
bot.command('toggle_forwarding', async (ctx) => {
  db.data.forwardingEnabled = !db.data.forwardingEnabled;
  await db.write();
  ctx.reply(`Пересылка ${db.data.forwardingEnabled ? 'включена ✅' : 'отключена ⛔️'}`);
});

// Обработка входящих сообщений
bot.on('message', async (ctx) => {
  const chatId = ctx.chat.id;

  if (!db.data.sourceGroups.includes(chatId)) return;
  if (!db.data.forwardingEnabled) return;

  const msg = ctx.message;
  const text = msg.text || msg.caption || '';
  const lowerText = text.toLowerCase();

  // Проверка на фильтр и нецензурные слова
  const hasManualFilter = db.data.filters.some(word => lowerText.includes(word.toLowerCase()));
  const hasProfanity = leoProfanity.check(text);

  if (hasManualFilter || hasProfanity) return;

  // Отправка сообщения в целевые группы
  for (const targetChatId of db.data.targetGroups) {
    try {
      if (msg.text) {
        await bot.telegram.sendMessage(targetChatId, msg.text);
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await bot.telegram.sendPhoto(targetChatId, photo.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.video) {
        await bot.telegram.sendVideo(targetChatId, msg.video.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.document) {
        await bot.telegram.sendDocument(targetChatId, msg.document.file_id, {
          caption: msg.caption || ''
        });
      } else if (msg.audio) {
        await bot.telegram.sendAudio(targetChatId, msg.audio.file_id);
      } else if (msg.voice) {
        await bot.telegram.sendVoice(targetChatId, msg.voice.file_id);
      }
    } catch (err) {
      console.error('Ошибка при пересылке:', err);
    }
  }
});

bot.launch();
console.log('✅ Бот запущен');
