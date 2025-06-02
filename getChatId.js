import 'dotenv/config';
import { Telegraf } from 'telegraf';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on(['message', 'channel_post'], (ctx) => {
  const chat = ctx.chat;
  console.log('===========================');
  console.log(`Название: ${chat.title || chat.username || chat.first_name}`);
  console.log(`Тип: ${chat.type}`);
  console.log(`chat_id: ${chat.id}`);
  console.log('===========================');
  ctx.reply(`✅ chat_id: ${chat.id}`);
});

bot.launch();
console.log('🤖 Бот запущен для получения chat_id');
