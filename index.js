import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import * as dotenv from 'dotenv';
import leoProfanity from 'leo-profanity';

dotenv.config();
leoProfanity.loadDictionary('ru');

async function main() {
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

  if (!db.data.admins.includes(855367383)) {
    db.data.admins.push(855367383);
    await db.write();
    console.log('✅ Админ добавлен вручную');
  }

  function getPairBySource(sourceChatId) {
    return db.data.pairs.find(p => p.source === sourceChatId);
  }

  async function getChatIdFromUsername(username) {
    if (!username.startsWith('@')) username = '@' + username;
    try {
      const chat = await bot.telegram.getChat(username);
      return chat.id;
    } catch (error) {
      console.error(`❌ Не удалось получить chat_id для ${username}:`, error.message);
      return null;
    }
  }

  bot.start(async (ctx) => {
    const isAdmin = db.data.admins.includes(ctx.from.id);
    if (!isAdmin) return ctx.reply('❌ У вас нет прав администратора.');

    await ctx.reply('🔧 Панель управления:', Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить канал', 'add_channel')],
      [Markup.button.callback('📋 Мои связки', 'list_pairs')],
      [
        Markup.button.callback('✅ Вкл пересылку', 'enable_forwarding'),
        Markup.button.callback('❌ Выкл пересылку', 'disable_forwarding')
      ]
    ]));
  });

  bot.action('add_channel', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.reply('✏️ Используйте команду:\n`/addchannel @source @target1 [@target2 ...]`', { parse_mode: 'Markdown' });
  });

  bot.action('list_pairs', async (ctx) => {
    await ctx.answerCbQuery();
    const pairs = db.data.pairs || [];

    if (pairs.length === 0) return ctx.reply('❌ Нет активных связок.');

    for (const pair of pairs) {
      let sourceTag = `\`${pair.source}\``;
      try {
        const sourceChat = await bot.telegram.getChat(pair.source);
        sourceTag = sourceChat.username ? `@${sourceChat.username}` : sourceChat.title;
      } catch (e) {}

      const targetsFormatted = await Promise.all(pair.targets.map(async (id) => {
        try {
          const chat = await bot.telegram.getChat(id);
          return chat.username ? `@${chat.username}` : chat.title;
        } catch (e) {
          return `\`${id}\``;
        }
      }));

      await ctx.reply(`🔗 Источник: ${sourceTag}\n➡️ Получатели: ${targetsFormatted.join(', ')}`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`❌ Удалить связку`, `delete_pair_${pair.source}`)]
        ])
      );
    }
  });

  bot.action('enable_forwarding', async (ctx) => {
    await ctx.answerCbQuery('✅ Пересылка включена');
    db.data.forwardingEnabled = true;
    await db.write();
  });

  bot.action('disable_forwarding', async (ctx) => {
    await ctx.answerCbQuery('❌ Пересылка отключена');
    db.data.forwardingEnabled = false;
    await db.write();
  });

  bot.action(/^delete_pair_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const sourceId = parseInt(ctx.match[1]);
    const index = db.data.pairs.findIndex(p => p.source === sourceId);
    if (index !== -1) {
      db.data.pairs.splice(index, 1);
      await db.write();
      ctx.reply(`✅ Связка с источником ${sourceId} удалена.`);
    } else {
      ctx.reply('❌ Связка не найдена.');
    }
  });

  bot.command('addchannel', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
      ctx.reply('❌ Укажите: /addchannel @source @target1 [@target2 ...]');
      return;
    }

    const [source, ...targets] = args;
    const sourceId = await getChatIdFromUsername(source);
    const targetIds = [];

    for (const target of targets) {
      const id = await getChatIdFromUsername(target);
      if (id) {
        targetIds.push(id);
      } else {
        ctx.reply(`⚠️ Не удалось найти: ${target}`);
      }
    }

    if (!sourceId || targetIds.length === 0) {
      ctx.reply('❌ Ошибка: исходный канал или получатели не найдены.');
      return;
    }

    let pair = getPairBySource(sourceId);
    if (pair) {
      targetIds.forEach(id => {
        if (!pair.targets.includes(id)) pair.targets.push(id);
      });
    } else {
      db.data.pairs.push({ source: sourceId, targets: targetIds });
    }

    await db.write();
    ctx.reply(`✅ Связка добавлена: ${source} → ${targets.join(', ')}`);
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

  const messageQueue = [];
  let isProcessing = false;

  async function processQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    const { ctx, msg } = messageQueue.shift();
    await handleForward(ctx, msg);

    setTimeout(() => {
      isProcessing = false;
      processQueue();
    }, 300);
  }

  async function handleForward(ctx, msg) {
    const chatId = ctx.chat.id;
    const text = msg.text || msg.caption || '';
    if (!db.data.forwardingEnabled) return;

    const hasManualFilter = db.data.filters.some(word => text.toLowerCase().includes(word.toLowerCase()));
    const hasProfanity = leoProfanity.check(text);
    if (hasManualFilter || hasProfanity) return;

    const pair = getPairBySource(chatId);
    if (!pair) return;

    const cleanedText = cleanText(text);
    if (!cleanedText && !msg.photo && !msg.video && !msg.document) return;

    const chatLink = `https://t.me/c/${String(chatId).substring(4)}/${msg.message_id}`;
    const replyMarkup = {
      inline_keyboard: [[{ text: '‎', url: chatLink }]]
    };

    for (const targetChatId of pair.targets) {
      try {
        if (msg.photo) {
          const photo = msg.photo[msg.photo.length - 1];
          await bot.telegram.sendPhoto(targetChatId, photo.file_id, {
            caption: cleanedText,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          });
        } else if (msg.video) {
          await bot.telegram.sendVideo(targetChatId, msg.video.file_id, {
            caption: cleanedText,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          });
        } else if (msg.document) {
          await bot.telegram.sendDocument(targetChatId, msg.document.file_id, {
            caption: cleanedText,
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          });
        } else if (msg.text) {
          await bot.telegram.sendMessage(targetChatId, cleanedText, {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          });
        }
      } catch (err) {
        console.error('❌ Ошибка при пересылке:', err.description || err.message);
      }
    }
  }

  bot.on('message', async (ctx) => {
    messageQueue.push({ ctx, msg: ctx.message });
    processQueue();
  });

  bot.on('channel_post', async (ctx) => {
    messageQueue.push({ ctx, msg: ctx.channelPost });
    processQueue();
  });

  bot.launch();
  console.log('🤖 Бот запущен');
}

main();
