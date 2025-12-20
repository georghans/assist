import { Telegraf } from "npm:telegraf@4.16.3";
import { google } from "npm:googleapis@132.0.0";

const telegramBotToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
const calendarId = Deno.env.get("GOOGLE_CALENDAR_ID") || "primary";
const serviceAccountEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
const serviceAccountPrivateKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");

if (!telegramBotToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

if (!openAiApiKey) {
  throw new Error("OPENAI_API_KEY is required");
}

if (!serviceAccountEmail || !serviceAccountPrivateKey) {
  throw new Error("Google service account credentials are required");
}

const telegramBot = new Telegraf(telegramBotToken);
const googleAuth = new google.auth.JWT(
  serviceAccountEmail,
  undefined,
  serviceAccountPrivateKey.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar"],
);
const calendar = google.calendar({ version: "v3", auth: googleAuth });

function getSenderName(ctx: any) {
  const { from } = ctx.message ?? {};
  if (from?.first_name) {
    return `${from.first_name}${from.last_name ? ` ${from.last_name}` : ""}`;
  }
  return from?.username ?? "there";
}

async function downloadVoiceFile(ctx: any, fileId: string) {
  const file = await ctx.telegram.getFile(fileId);
  if (!file?.file_path) {
    throw new Error("Voice file path is missing");
  }
  const url = `https://api.telegram.org/file/bot${telegramBotToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download voice message: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return new Blob([arrayBuffer], { type: "audio/ogg" });
}

async function transcribeVoice(voiceBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("model", "whisper-1");
  formData.append("file", voiceBlob, "voice-message.ogg");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription failed: ${errorText}`);
  }

  const data = await response.json();
  return data.text as string;
}

type EventProposal = {
  title: string;
  description?: string;
  start: string;
  end?: string;
  timezone?: string;
};

async function proposeCalendarEvent(transcript: string): Promise<EventProposal> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract Google Calendar event details from user transcripts. Return JSON with title, start, end (ISO 8601), optional description, and timezone. If timing is missing, use the current day at the next full hour in the user's timezone or UTC.",
        },
        {
          role: "user",
          content: transcript,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Event proposal failed: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(content) as EventProposal;
}

function normalizeEventTimes(event: EventProposal): { start: string; end: string; timezone?: string } {
  const tz = event.timezone || "UTC";
  let startDate: Date;

  if (event.start) {
    startDate = new Date(event.start);
  } else {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    startDate = now;
  }

  let endDate: Date;
  if (event.end) {
    endDate = new Date(event.end);
  } else {
    endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + 1);
  }

  return {
    timezone: tz,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

async function createCalendarEvent(proposal: EventProposal) {
  const { start, end, timezone } = normalizeEventTimes(proposal);
  const summary = proposal.title || "Voice note";

  await googleAuth.authorize();
  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description: proposal.description || "Created from Telegram voice message",
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
    },
  });
}

telegramBot.start((ctx) => {
  const senderName = getSenderName(ctx);
  ctx.reply(`Hello ${senderName}! Send me a voice message and I'll add it to your calendar.`);
});

telegramBot.on("voice", async (ctx) => {
  try {
    ctx.telegram.sendChatAction(ctx.message.chat.id, "typing");
    const senderName = getSenderName(ctx);

    const voiceBlob = await downloadVoiceFile(ctx, ctx.message.voice.file_id);
    const transcript = await transcribeVoice(voiceBlob);

    const proposal = await proposeCalendarEvent(transcript);
    await createCalendarEvent(proposal);

    await ctx.reply(
      `Got it, ${senderName}! I transcribed your message as:\n"${transcript}"\nI've added it to your calendar as "${proposal.title}".`,
    );
  } catch (error) {
    console.error(error);
    await ctx.reply(
      "Sorry, I couldn't process that voice message. Please try again or check my configuration.",
    );
  }
});

telegramBot.on("message", (ctx) => {
  if (ctx.message?.voice) return;
  ctx.reply("Send me a voice message describing your event, and I'll schedule it.");
});

telegramBot.launch();

console.log("Telegram calendar assistant is running...");
