import { describe, expect, it } from 'vitest';
import { transformText } from '../lib/textEditing';

describe('text transforms', () => {
  it('encodes and decodes URI components', () => {
    expect(transformText('Ada Lovelace & Zürich', 'encodeUri')).toBe('Ada%20Lovelace%20%26%20Z%C3%BCrich');
    expect(transformText('Ada%20Lovelace%20%26%20Z%C3%BCrich', 'decodeUri')).toBe('Ada Lovelace & Zürich');
    expect(transformText('100%', 'decodeUri')).toBeNull();
  });

  it('encodes and decodes UTF-8 Base64, including the URL-safe alphabet', () => {
    expect(transformText('Zürich?', 'encodeBase64')).toBe('WsO8cmljaD8=');
    expect(transformText('WsO8cmljaD8=', 'decodeBase64')).toBe('Zürich?');
    expect(transformText('WsO8cmljaD8', 'decodeBase64')).toBe('Zürich?');
    expect(transformText('eyJhbGciOiJIUzI1NiJ9', 'decodeBase64')).toBe('{"alg":"HS256"}');
    expect(transformText('not base64!', 'decodeBase64')).toBeNull();
    expect(transformText('/w==', 'decodeBase64')).toBeNull();
  });
});
