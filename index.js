import { Telegraf } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// Обработчик команды /start
bot.start((ctx) => ctx.reply('Бот запущен и работает на webhook 🚀'));

// Настройка Express для приёма webhook'ов
const app = express();
app.use(express.json());

app.use(bot.webhookCallback('/secret-path')); // Уникальный путь для безопасности

// Запуск Express-сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);

  // Устанавливаем webhook
  const domain = process.env.WEBHOOK_DOMAIN;
  const webhookUrl = `${domain}/secret-path`;

  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook установлен: ${webhookUrl}`);
  } catch (err) {
    console.error('❌ Ошибка установки webhook:', err);
  }
});
