// index.js
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
      forwardingEnabled: true,
      stats: []
    };
    await db.write();
  }

  function getPairBySource(sourceChatId) {
    return db.data.pairs.find(p => p.source === sourceChatId);
  }

  async function resolveChatUsername(chatId) {
    try {
      const chat = await bot.telegram.getChat(chatId);
      return chat.username ? `@${chat.username}` : chat.title;
    } catch (e) {
      return `chat_id: ${chatId}`;
    }
  }

  async function getChatIdFromUsername(username) {
    if (!username.startsWith('@')) username = '@' + username;
    try {
      const chat = await bot.telegram.getChat(username);
      return chat.id;
    } catch (error) {
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
      ],
      [Markup.button.callback('📊 Статистика', 'show_stats')]
    ]));
  });

  bot.action('show_stats', async (ctx) => {
    await ctx.answerCbQuery();
    const now = Date.now();
    const fifteenMinutesAgo = now - 15 * 60 * 1000;
    const recentStats = db.data.stats.filter(stat => stat.time >= fifteenMinutesAgo);

    if (recentStats.length === 0) return ctx.reply('📊 За последние 15 минут пересылок не было.');

    const grouped = {};
    for (const stat of recentStats) {
      const source = await resolveChatUsername(stat.source);
      const target = await resolveChatUsername(stat.target);
      const key = `${source} → ${target}`;
      grouped[key] = (grouped[key] || 0) + 1;
    }

    let replyText = '📊 Статистика за последние 15 минут:\n';
    for (const [key, count] of Object.entries(grouped)) {
      replyText += `• ${key}: ${count} сообщений\n`;
    }

    ctx.reply(replyText);
  });

  bot.action('list_pairs', async (ctx) => {
    await ctx.answerCbQuery();
    const pairs = db.data.pairs;

    if (pairs.length === 0) return ctx.reply('❌ Нет активных связок.');

    for (const pair of pairs) {
      const sourceName = await resolveChatUsername(pair.source);
      const targets = await Promise.all(pair.targets.map(resolveChatUsername));
      await ctx.reply(`🔗 Источник: ${sourceName}\n➡️ Получатели: ${targets.join(', ')}`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`❌ Удалить связку`, `delete_pair_${pair.source}`)]
        ])
      );
    }
  });

  bot.action(/^delete_pair_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const sourceId = parseInt(ctx.match[1]);
    const index = db.data.pairs.findIndex(p => p.source === sourceId);
    if (index !== -1) {
      db.data.pairs.splice(index, 1);
      await db.write();
      ctx.reply(`✅ Связка удалена.`);
    } else {
      ctx.reply('❌ Связка не найдена.');
    }
  });

  bot.command('addchannel', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('❌ Укажите: /addchannel @source @target1 [@target2 ...]');

    const [source, ...targets] = args;
    const sourceId = await getChatIdFromUsername(source);
    const targetIds = [];
    for (const target of targets) {
      const id = await getChatIdFromUsername(target);
      if (id) targetIds.push(id);
      else ctx.reply(`⚠️ Не найден: ${target}`);
    }
    if (!sourceId || targetIds.length === 0) return ctx.reply('❌ Ошибка: исходный или целевые каналы не найдены.');

    let pair = getPairBySource(sourceId);
    if (pair) targetIds.forEach(id => { if (!pair.targets.includes(id)) pair.targets.push(id); });
    else db.data.pairs.push({ source: sourceId, targets: targetIds });

    await db.write();
    ctx.reply(`✅ Связка добавлена.`);
  });

  function cleanText(input) {
    const phoneRegex = /(?:\+?\d{1,3})?[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}/g;
    const addressRegex = /(ул\\.|улица|проспект|пр-т|пер\\.|переулок|г\\.|город|д\\.|дом)[^\n,.!?]*/gi;
    let output = input.replace(phoneRegex, '').replace(addressRegex, '');
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

    const hasFilter = db.data.filters.some(word => text.toLowerCase().includes(word.toLowerCase()));
    const hasProfanity = leoProfanity.check(text);
    if (hasFilter || hasProfanity) return;

    const pair = getPairBySource(chatId);
    if (!pair) return;

    const cleanedText = cleanText(text);
    if (!cleanedText && !msg.photo && !msg.video && !msg.document) return;

    const chatLink = `https://t.me/c/${String(chatId).substring(4)}/${msg.message_id}`;
    const replyMarkup = { inline_keyboard: [[{ text: '‎', url: chatLink }]] };

    for (const target of pair.targets) {
      try {
        db.data.stats.push({ source: chatId, target, time: Date.now() });

        if (msg.photo) {
          const photo = msg.photo[msg.photo.length - 1];
          await bot.telegram.sendPhoto(target, photo.file_id, { caption: cleanedText, parse_mode: 'Markdown', reply_markup: replyMarkup });
        } else if (msg.video) {
          await bot.telegram.sendVideo(target, msg.video.file_id, { caption: cleanedText, parse_mode: 'Markdown', reply_markup: replyMarkup });
        } else if (msg.document) {
          await bot.telegram.sendDocument(target, msg.document.file_id, { caption: cleanedText, parse_mode: 'Markdown', reply_markup: replyMarkup });
        } else {
          await bot.telegram.sendMessage(target, cleanedText, { parse_mode: 'Markdown', reply_markup: replyMarkup });
        }
        await db.write();
      } catch (err) {
        console.error('❌ Ошибка при пересылке:', err.message);
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
