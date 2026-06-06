// Decode a hex-encoded UTF-8 string (WiiM returns Title/Artist/Album this way).
// Pure JS so it works in React Native where Node's Buffer is unavailable.
export function decodeHex(hex: string): string {
  if (!hex) {
    return '';
  }
  try {
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    // Decode UTF-8 bytes
    let result = '';
    let i = 0;
    while (i < bytes.length) {
      const byte1 = bytes[i++];
      if (byte1 < 0x80) {
        result += String.fromCharCode(byte1);
      } else if (byte1 >= 0xc0 && byte1 < 0xe0) {
        const byte2 = bytes[i++];
        result += String.fromCharCode(((byte1 & 0x1f) << 6) | (byte2 & 0x3f));
      } else if (byte1 >= 0xe0 && byte1 < 0xf0) {
        const byte2 = bytes[i++];
        const byte3 = bytes[i++];
        result += String.fromCharCode(
          ((byte1 & 0x0f) << 12) | ((byte2 & 0x3f) << 6) | (byte3 & 0x3f),
        );
      } else {
        const byte2 = bytes[i++];
        const byte3 = bytes[i++];
        const byte4 = bytes[i++];
        const codepoint =
          ((byte1 & 0x07) << 18) |
          ((byte2 & 0x3f) << 12) |
          ((byte3 & 0x3f) << 6) |
          (byte4 & 0x3f);
        const offset = codepoint - 0x10000;
        result += String.fromCharCode(
          0xd800 + (offset >> 10),
          0xdc00 + (offset & 0x3ff),
        );
      }
    }
    return decodeHtmlEntities(result);
  } catch (e) {
    return '';
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
