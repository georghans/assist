import {Telegraf} from "npm:telegraf@4.16.3";

const telegramBot = new Telegraf(Deno.env.get("TELEGRAM_BOT_TOKEN")!);

telegramBot.start((ctx) => console.log(ctx));

telegramBot.on("message", async (ctx) => {
  console.log("message", ctx);
  ctx.telegram.sendChatAction(ctx.message.chat.id, "typing");

  const senderName = ctx.message?.from?.first_name
    ? `${ctx.message?.from?.first_name} ${ctx.message?.from?.last_name}`
    : ctx.message?.from?.username || null;

  await ctx.reply(`Hello ${senderName || "there"}! You said: "${ctx.message}"`);
});
