// Conservative routing: discussion of media stays with the language model.
// Kept self-contained so browser and server use precisely the same parser.
export function mayNeedMediaClassification(message) {
  const text = String(message || '').trim();
  if (!text || /^(?:what|why|how|explain|tell me)\b/i.test(text)
    || /\b(?:don't|do not|never)\s+(?:create|generate|make|draw)\b/i.test(text)
    || /\b(?:api|endpoint|script|tutorial|function|component)\b/i.test(text)) return false;
  return /\b(?:image|picture|photo|illustration|video|clip|animation|visual art|logo|logotype|wordmark)\b/i.test(text)
    || /^(?:sketch|draw|illustrate|render)\b/i.test(text)
    || /[^\u0000-\u007f]/.test(text);
}

export function mediaChatIntent(message) {
  const text = String(message || '').trim();
  if (!text || /^(?:how|why|what|explain|tell me|show me how)\b/i.test(text) ||
      /\b(?:don't|do not|never)\s+(?:create|generate|make|draw)\b/i.test(text) ||
      /\b(?:code|function|component|api|endpoint|script|tutorial|button|player)\b/i.test(text)) return null;
  // Explicit requests in common languages; Unicode boundaries must not use ASCII \b.
  const international = [
    [/^(?:por favor\s+)?(?:genera|generar|crea|crear|haz|dibuja|quiero).{0,100}?(vídeo|video|imagen|foto|ilustración)/iu, /vídeo|video/iu],
    [/^(?:s'il vous plaît\s+)?(?:génère|générez|crée|créez|dessine|je veux).{0,100}?(vidéo|image|photo|illustration)/iu, /vidéo/iu],
    [/^(?:bitte\s+)?(?:erstelle|generiere|zeichne|ich möchte).{0,100}?(video|bild|foto)/iu, /video/iu],
    [/^(?:proszę\s+)?(?:wygeneruj|stwórz|utwórz|narysuj|chcę).{0,100}?(wideo|film|obraz|zdjęcie|ilustracj)/iu, /wideo|film/iu],
    [/^(?:por favor\s+)?(?:gere|crie|desenhe|quero).{0,100}?(vídeo|video|imagem|foto)/iu, /vídeo|video/iu],
    [/^(?:per favore\s+)?(?:genera|crea|disegna|voglio).{0,100}?(video|immagine|foto)/iu, /video/iu],
    [/^(?:пожалуйста\s+)?(?:создай|сгенерируй|нарисуй|хочу).{0,100}?(видео|изображение|картин|фото)/iu, /видео/iu],
    [/^(?:створи|згенеруй|намалюй).{0,100}?(відео|зображення|картин)/iu, /відео/iu],
    [/^(?:请|請)?(?:生成|创建|創建|制作|製作|画|畫).{0,100}?(视频|視頻|影片|图片|圖片|图像|圖像)/u, /视频|視頻|影片/u],
    [/^(?=.*(?:生成|作成|作って|描いて))(?=.*(?:動画|ビデオ|画像|写真)).+/u, /動画|ビデオ/u],
    [/^(?=.*(?:생성|만들어|그려))(?=.*(?:동영상|비디오|이미지|사진)).+/u, /동영상|비디오/u],
    [/^(?:أنشئ|انشئ|ولّد|ولد|ارسم).{0,100}?(فيديو|صورة)/u, /فيديو/u],
    [/^(?:gumawa|gawan|maggenerate|mag generate|generate|lumikha).{0,100}?(video|larawan|imahe|image|picture)/iu, /video/iu],
    [/^(?:buat|buatkan|hasilkan).{0,100}?(video|gambar|foto)/iu, /video/iu],
    [/^(?:bir\s+)?(?:video|resim|görüntü).{0,100}?(oluştur|üret|çiz)/iu, /video/iu],
    [/^(?=.*(?:बनाओ|बनाइए|बनाएं|जनरेट))(?=.*(?:वीडियो|चित्र|तस्वीर)).+/u, /वीडियो/u]
  ];
  if (/^(?:nie|no|non|nicht|não|не|لا|不要|别|別|huwag)\s*/iu.test(text) || /^(?:jak|dlaczego|co|cómo|como|por qué|comment|pourquoi|wie|warum|как|почему|如何|怎么|怎麼|为什么|為什麼|paano|bakit)\s*/iu.test(text)) return null;
  const translated = international.find(([pattern]) => pattern.test(text));
  const match = text.match(/^(?:(?:please|hey)[,\s]+)?(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:design|create|generate|make|draw|render|produce|give me|show me|i\s+(?:want|need|would like|would love)(?:\s+(?:you|u)\s+to\s+(?:create|generate|make))?)\b[\s\S]{0,100}?\b(video|clip|image|picture|photo|illustration|logo|logotype|wordmark)\b/i);
  if (!match && !translated) return null;
  const kind = (translated ? translated[1].test(text) : /video|clip/i.test(match[1])) ? 'video' : 'image';
  if (kind === 'image') return { kind, prompt: text };
  const durationText = text.replace(/[٠-٩۰-۹０-９]/g, digit => String(digit.charCodeAt(0) - (digit >= '０' ? 0xff10 : digit >= '۰' ? 0x06f0 : 0x0660)));
  const durations = [...durationText.matchAll(/(\d+(?:\.\d+)?)\s*[- ]?\s*(?:(?:seconds?|secs?|s|sekund\w*|segundos?|secondes?|секунд\w*|ثواني|ثانية)(?=$|[^\p{L}])|秒|초)/giu)].map(match => Number(match[1]));
  const numberWords = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
  const words = durationText.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|sixty)\s*[- ]?\s*seconds?\b/i);
  const largeWordDuration = /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:[ -]+(?:one|two|three|four|five|six|seven|eight|nine|ten|and|hundred|thousand))*[ -]+seconds?\b/i.test(durationText);
  const wordSeconds = words ? numberWords.includes(words[1].toLowerCase()) ? numberWords.indexOf(words[1].toLowerCase())+1 : 30 : null;
  const seconds = durations[0] ?? wordSeconds ?? 3;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10 || durations.some(value => !Number.isInteger(value) || value<1 || value>10) || (wordSeconds !== null && wordSeconds>10) || largeWordDuration
      || /(?:\d+|a|one|two|three|four|five|ten|half)\s*[- ]?\s*(?:a\s+)?(?:minutes?|mins?|hours?|minutos?|minuten|минут\w*|دقيقة|دقائق|分|分钟|分鐘|분)(?=$|[^\p{L}])/iu.test(durationText)) {
    return { kind, error: 'Videos are limited to 10 seconds maximum. Please choose a whole-number duration from 1 to 10 seconds.' };
  }
  return { kind, prompt: text, duration_seconds: seconds };
}
