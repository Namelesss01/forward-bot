import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
import leoProfanity from 'leo-profanity';

dotenv.config();
leoProfanity.loadDictionary('ru');

const bot = new Telegraf(process.env.BOT_TOKEN);

const adapter = new JSONFile('./db.json');
const db = new Low(adapter);
await db.read();

if (!db.data) {
  db.data = {
    pairs: [],
    filters: ['цена', 'срочно', 'без посредников', 'торг', 'недорого'],
    admins: [],
    forwardingEnabled: true
  };
  await db.write();
}

function getPairBySource(sourceChatId) {
  return db.data.pairs ? db.data.pairs.find(p => p.source === sourceChatId) : null;
}

bot.command('add_pair', async (ctx) => {
  const [source, ...targets] = ctx.message.text.split(' ').slice(1);
  if (!source || targets.length === 0) return ctx.reply('❌ Укажите: /add_pair <source_chat_id> <target_chat_id_1> <target_chat_id_2> ...');

  const sourceChatId = parseInt(source);
  const targetChatIds = targets.map(id => parseInt(id));

  if (!db.data.pairs) db.data.pairs = [];

  let pair = getPairBySource(sourceChatId);
  if (pair) {
    targetChatIds.forEach(target => {
      if (!pair.targets.includes(target)) pair.targets.push(target);
    });
  } else {
    db.data.pairs.push({ source: sourceChatId, targets: targetChatIds });
  }

  await db.write();
  ctx.reply(`✅ Связка добавлена: ${sourceChatId} → ${targetChatIds.join(', ')}`);
});

bot.command('remove_pair', async (ctx) => {
  const [source, target] = ctx.message.text.split(' ').slice(1);
  if (!source || !target) return ctx.reply('❌ Укажите: /remove_pair <source_chat_id> <target_chat_id>');

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

bot.command('list_pairs', (ctx) => {
  const pairs = db.data.pairs || [];
  const pairsList = pairs.map(pair => `🔗 Источник: ${pair.source}\n➡️ Получатели: ${pair.targets.join(', ')}`).join('\n\n');
  ctx.reply(pairsList || '❌ Нет активных связок.');
});

bot.command('add_admin', async (ctx) => {
  const userId = ctx.from.id;
  if (!db.data.admins.includes(userId)) {
    db.data.admins.push(userId);
    await db.write();
    ctx.reply('✅ Вы добавлены как админ.');
  } else {
    ctx.reply('✅ Вы уже админ.');
  }
});

function cleanText(input) {
  const phoneRegex = /(?:\+?\d{1,3})?[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}/g;
  const addressRegex = /(ул\.|улица|проспект|пр-т|пер\.|переулок|г\.|город|д\.|дом)[^\n,.!?]*/gi;

  let output = input;
  output = output.replace(phoneRegex, '');
  output = output.replace(addressRegex, '');

  db.data.filters.forEach(word => {
    const wordRegex = new RegExp(word, 'gi');
    output = output.replace(wordRegex, '');
  });

  return output.trim();
}

async function handleForward(ctx, msg) {
  const chatId = ctx.chat.id;
  let text = msg.text || msg.caption || '';

  if (!db.data.forwardingEnabled) return;

  const hasManualFilter = db.data.filters.some(word => text.toLowerCase().includes(word.toLowerCase()));
  const hasProfanity = leoProfanity.check(text);
  if (hasManualFilter || hasProfanity) return;

  const pair = getPairBySource(chatId);
  if (!pair) return;

  const cleanedText = cleanText(text);
  let finalText = cleanedText;

  const chatLink = `https://t.me/c/${String(chatId).substring(4)}/${msg.message_id}`;

  for (const targetChatId of pair.targets) {
    try {
      if (msg.text || msg.caption) {
        await bot.telegram.sendMessage(
          targetChatId,
          finalText,
          Markup.inlineKeyboard([
            Markup.button.url('👁‍🗨 Открыть оригинал', `https://t.me/c/${String(chatId).substring(4)}/${msg.message_id}`)
          ])
        );
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        await bot.telegram.sendPhoto(
          targetChatId,
          photo.file_id,
          {
            caption: finalText,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '👁‍🗨 Открыть оригинал', url: chatLink }]
              ]
            }
          }
        );
      } else if (msg.video) {
        await bot.telegram.sendVideo(
          targetChatId,
          msg.video.file_id,
          {
            caption: finalText,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '👁‍🗨 Открыть оригинал', url: chatLink }]
              ]
            }
          }
        );
      } else if (msg.document) {
        await bot.telegram.sendDocument(
          targetChatId,
          msg.document.file_id,
          {
            caption: finalText,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '👁‍🗨 Открыть оригинал', url: chatLink }]
              ]
            }
          }
        );
      }
    } catch (err) {
      console.error('❌ Ошибка при пересылке:', err);
    }
  }
}

bot.on('message', async (ctx) => {
  await handleForward(ctx, ctx.message);
});

bot.on('channel_post', async (ctx) => {
  await handleForward(ctx, ctx.channelPost);
});

bot.launch();
console.log('🤖 Бот запущен');
