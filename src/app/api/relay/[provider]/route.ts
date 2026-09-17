import { NextRequest, NextResponse } from "next/server";

// ============================================================================
// Yerel sunucu-taraflı API relay — dev / Docker standalone için (aynı desen:
// PROXY_ENDPOINTS.deepl → /api/deepl, nvidia → /api/nvidia).
//
// Tarayıcı provider endpoint'lerine çoğu zaman doğrudan gidemez (CORS), ve
// gömili Cloudflare Worker yalnızca KENDİNİN beyan ettiği adresleri forward
// eder — kullanıcının Custom (OpenAI-compatible) alanına yazdığı adres (kendi
// gateway'i, OpenCode Go, yerel runtime) o kümede değildir. Uygulama bir
// SUNUCU üstünde koştuğunda (npm run dev / Docker) bu relay'in doğal evi
// hazırdır: istek aynı-origin bir route'a gider, route sunucu tarafından
// forward eder, döngüde tarayıcı olmadığı için CORS diye bir kavram yoktur.
// Statik export production'da route handler yoktur — orada gömili relay yine
// Worker'dır (services/shared.ts relayBaseUrl iki hâli de üretir).
//
// Yol şekli Worker sözleşmesini taklit eder: /api/relay/{provider}?endpoint={url}
// provider segmenti yalnızca log'lama içindir; yönlendirmeyi TEK başına
// `endpoint` belirler. Bu route onu olduğu gibi forward eder — bu makineyi bir
// açık proxy YAPMAZ: dev/Docker'da sunucu kullanıcının kendi makinesidir ve
// yalnızca kendi yapılandırdığı adrese gider. Yine de şema kapısı durur
// (http/https dışı reddedilir: javascript:/data:/file: buradan geçemez).
// ============================================================================

// Worker'ın ilettiği başlık kümesinin yerel karşılığı. Host/Connection gibi
// hop-by-hop başlıklar KASTEN iletilmez (fetch bunları kendisi yönetir);
// gövde bayt-bayt aynen taşınır.
const FORWARD_HEADERS = ["authorization", "x-api-key", "anthropic-version", "content-type", "x-opencode-session", "x-opencode-client"] as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  const target = req.nextUrl.searchParams.get("endpoint") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    // 400 = deterministik yapılandırma hatası: client retry.ts bunu NON-retryable
    // sayar (status var, 5xx değil). Boş/eksik endpoint'e 502 vermek üç denemeyi
    // boşuna yaktırırdı.
    return NextResponse.json({ error: `relay: missing or invalid ?endpoint= ("${target.slice(0, 200)}")` }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ error: "relay: endpoint must be http(s)" }, { status: 400 });
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers[name] = value;
  }

  // Ham metin: JSON'u burada parse edip yeniden serialize etmek byte-stable
  // prompt-cache prefix'ini (subtitle-translator#53) bozabilirdi — upstream'e
  // giden gövde, tarayıcının gönderdiği gövdeyle aynı kalmalı.
  const body = await req.text();

  let upstream: Response;
  try {
    upstream = await fetch(parsed, { method: "POST", headers, body, signal: req.signal, redirect: "follow" });
  } catch (error) {
    // İstemci vazgeçti (iptal düğmesi / requestTimeoutSec) — req.signal buraya
    // düşer. Nvidia route'uyla aynı sözleşme: 499 + sessiz log.
    if (req.signal.aborted) {
      return NextResponse.json({ error: "Request aborted by client" }, { status: 499 });
    }
    console.error(`relay(${provider}) upstream fetch failed:`, error);
    return NextResponse.json({ error: `relay: cannot reach ${parsed.origin} — ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
  }

  const text = await upstream.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Non-JSON upstream yanıtı (HTML hata sayfası) tarayıcıya olduğu gibi
    // gitmemeli: client'ın response.json()'ı status'suz SyntaxError atar ve
    // retry bunu "geçici" sanıp bütçeyi yakar. Nvidia route'unun 502 kapısıyla
    // aynı gerekçe.
    console.error(`relay(${provider}) non-JSON response (HTTP ${upstream.status}):`, text.slice(0, 300));
    return NextResponse.json({ error: `Upstream returned a non-JSON response (HTTP ${upstream.status}).`, details: text.slice(0, 300) }, { status: 502 });
  }

  // Upstream status'ünü AYNEN yansıt: client'ın sınıflandırması (401/403 → auth
  // abort cascade, 429 → Retry-After + shared cooldown gate, 5xx → retry)
  // provider'ın gerçek kararına bakmalı; 200'e çevirmek ölü bir key'i canlı
  // gösterirdi.
  return NextResponse.json(data, { status: upstream.status });
}
