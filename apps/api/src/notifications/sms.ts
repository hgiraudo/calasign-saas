// SMS por Twilio (API REST, sin SDK). Se activa con TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM.
// Sin configuración, los SMS van al buzón de desarrollo (ver channels.deliver).

export interface SmsProvider {
  readonly id: string;
  send(to: string, text: string): Promise<{ messageId: string | null }>;
}

class TwilioSmsProvider implements SmsProvider {
  readonly id = "twilio";
  constructor(
    private sid: string,
    private token: string,
    private from: string,
  ) {}
  async send(to: string, text: string) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: this.from, Body: text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${String(body?.message ?? "").slice(0, 200)}`);
    return { messageId: body?.sid ?? null };
  }
}

let provider: SmsProvider | null | undefined;

export function getSmsProvider(): SmsProvider | null {
  if (provider !== undefined) return provider;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM } = process.env;
  provider = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM ? new TwilioSmsProvider(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM) : null;
  return provider;
}
