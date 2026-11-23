import express from 'express';
import type { Request, Response } from 'express';
import nodemailer from 'nodemailer';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_NOTIFICATION_EMAIL = 'phytomedia10@gmail.com';
const TELEGRAM_ADMIN_CHAT_ID = '2036611368';
const ALLOWED_EVENT_TYPES = new Set([
  'تسجيل جديد',
  'طلب جديد',
  'تسجيل جديد / طلب جديد',
]);

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 15;
const DEDUP_WINDOW_MS = 30 * 1000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const ipRateLimits = new Map<string, RateLimitEntry>();
const recentNotificationKeys = new Map<string, number>();

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]+/g, ' ').trim().slice(0, maxLen);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 200;
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = ipRateLimits.get(ip);
  if (!current || current.resetAt <= now) {
    ipRateLimits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  current.count += 1;
  return true;
}

function isDuplicateEvent(key: string): boolean {
  const now = Date.now();
  for (const [entryKey, expiresAt] of recentNotificationKeys.entries()) {
    if (expiresAt <= now) {
      recentNotificationKeys.delete(entryKey);
    }
  }
  const existingExpiry = recentNotificationKeys.get(key);
  if (existingExpiry && existingExpiry > now) {
    return true;
  }
  recentNotificationKeys.set(key, now + DEDUP_WINDOW_MS);
  return false;
}

interface NotificationPayload {
  eventType: string;
  roleLabel: string;
  personName: string;
  personEmail: string;
  personPhone: string;
  specialty: string;
  registeredAt: string;
}

async function sendAdminEmailAlert(data: NotificationPayload): Promise<{ sent: boolean; skipped?: boolean; error?: string }> {
  const emailUser = process.env.EMAIL_USER?.trim() || '';
  const emailAppPassword = process.env.EMAIL_APP_PASSWORD?.trim() || '';

  if (!emailUser || !emailAppPassword) {
    console.warn('[AdminEmail] EMAIL_USER or EMAIL_APP_PASSWORD is not configured; email notification skipped.');
    return { sent: false, skipped: true };
  }

  const specialtyDisplay = data.specialty || 'غير محدد (عميل)';
  const subject = `[φ To Media] ${data.eventType} - ${data.personName}`.slice(0, 180);

  const textBody = [
    'إشعار إداري جديد من منصة φ To Media',
    '======================================',
    `نوع الحدث: ${data.eventType} (${data.roleLabel})`,
    `اسم الشخص: ${data.personName}`,
    `الإيميل: ${data.personEmail}`,
    `رقم التليفون: ${data.personPhone}`,
    `التخصص: ${specialtyDisplay}`,
    `وقت التسجيل: ${data.registeredAt}`,
  ].join('\n');

  const htmlBody = `
    <div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #faf7ff; border: 1px solid #e9d5ff; border-radius: 16px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #7C3AED, #EC4899); padding: 20px 24px; color: #ffffff;">
        <h2 style="margin: 0; font-size: 18px;">إشعار إداري تلقائي — φ To Media</h2>
        <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.92;">${escapeHtml(data.eventType)} (${escapeHtml(data.roleLabel)})</p>
      </div>
      <div style="padding: 20px 24px; background-color: #ffffff; color: #1E1B4B;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; font-weight: bold; width: 35%; color: #6B21A8;">نوع الحدث</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff;">${escapeHtml(data.eventType)} — ${escapeHtml(data.roleLabel)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; font-weight: bold; color: #6B21A8;">اسم الشخص</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff;">${escapeHtml(data.personName)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; font-weight: bold; color: #6B21A8;">الإيميل</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; direction: ltr; text-align: right;">${escapeHtml(data.personEmail)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; font-weight: bold; color: #6B21A8;">رقم التليفون</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; direction: ltr; text-align: right;">${escapeHtml(data.personPhone)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff; font-weight: bold; color: #6B21A8;">التخصص</td>
            <td style="padding: 10px 12px; border-bottom: 1px solid #f3e8ff;">${escapeHtml(specialtyDisplay)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; font-weight: bold; color: #6B21A8;">وقت التسجيل</td>
            <td style="padding: 10px 12px;">${escapeHtml(data.registeredAt)}</td>
          </tr>
        </table>
      </div>
    </div>
  `;

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: emailUser,
        pass: emailAppPassword,
      },
    });

    await transporter.sendMail({
      from: `"φ To Media Notifications" <${emailUser}>`,
      to: ADMIN_NOTIFICATION_EMAIL,
      subject,
      text: textBody,
      html: htmlBody,
    });

    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'SMTP delivery failed';
    console.error('[AdminEmail] Failed to send email:', message);
    return { sent: false, error: 'SMTP_DELIVERY_FAILED' };
  }
}

async function sendTelegramRegistrationAlert(data: NotificationPayload): Promise<{ sent: boolean; skipped?: boolean; error?: string }> {
  if (data.eventType !== 'تسجيل جديد' && data.eventType !== 'تسجيل جديد / طلب جديد') {
    return { sent: false, skipped: true };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  if (!botToken) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN is not configured; Telegram registration alert skipped.');
    return { sent: false, skipped: true };
  }

  const text = [
    '🎉 مستخدم جديد سجل في To Media!',
    `الاسم: ${data.personName}`,
    `الدور: ${data.roleLabel}`,
    `الإيميل: ${data.personEmail}`,
    `وقت التسجيل: ${data.registeredAt}`,
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_ADMIN_CHAT_ID,
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      let description = `HTTP ${response.status}`;
      try {
        const errBody = (await response.json()) as { description?: unknown };
        if (typeof errBody?.description === 'string' && errBody.description) {
          description = errBody.description;
        }
      } catch (_) {}
      console.error('[Telegram] Failed to send registration alert:', description);
      return { sent: false, error: 'TELEGRAM_API_ERROR' };
    }

    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Telegram request failed';
    console.error('[Telegram] Error while sending registration alert:', message);
    return { sent: false, error: 'TELEGRAM_NETWORK_ERROR' };
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/notify-admin', async (req: Request, res: Response) => {
    const clientIp = cleanText(req.ip || req.socket.remoteAddress || 'unknown', 64) || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({ ok: false, error: 'Too many notification requests' });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const rawEventType = cleanText(body.eventType, 60);
    const eventType = ALLOWED_EVENT_TYPES.has(rawEventType) ? rawEventType : 'تسجيل جديد';
    const roleLabel = cleanText(body.role, 80) || 'مستخدم';
    const personName = cleanText(body.name, 160);
    const personEmail = cleanText(body.email, 200).toLowerCase();
    const personPhone = cleanText(body.phone, 40) || 'غير مسجل';
    const specialty = cleanText(body.specialty, 180);
    const registeredAt =
      cleanText(body.registeredAt, 100) ||
      new Date().toLocaleString('ar-EG', {
        timeZone: 'Africa/Cairo',
        dateStyle: 'full',
        timeStyle: 'short',
      });

    if (!personName) {
      res.status(400).json({ ok: false, error: 'Missing person name' });
      return;
    }
    if (!isValidEmail(personEmail)) {
      res.status(400).json({ ok: false, error: 'Invalid person email' });
      return;
    }

    const dedupKey = `${eventType}::${personEmail}`;
    if (isDuplicateEvent(dedupKey)) {
      res.status(200).json({ ok: true, deduplicated: true });
      return;
    }

    const payload: NotificationPayload = {
      eventType,
      roleLabel,
      personName,
      personEmail,
      personPhone,
      specialty,
      registeredAt,
    };

    const [emailResult, telegramResult] = await Promise.all([
      sendAdminEmailAlert(payload),
      sendTelegramRegistrationAlert(payload),
    ]);

    res.status(200).json({
      ok: emailResult.sent || telegramResult.sent,
      email: emailResult,
      telegram: telegramResult,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
